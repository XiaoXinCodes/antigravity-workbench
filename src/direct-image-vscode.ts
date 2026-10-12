import { responseModels, missingModel, type ModelObservation } from './model-observation';
import { catalogError, catalogParseError, catalogErrorCode, catalogFailureDetails, type CatalogFailure } from './model-catalog-error';
import { parseModelCatalog, imageCatalogIssue, assertModelUse } from './model-catalog';
import { accountDisplayFingerprint } from './quota-presentation';
import { savedAccountStore } from './saved-account-store';
import { t as tr } from './i18n';
import { diagnoseImageCatalog } from './image-catalog-diagnostic';
import { imageQuotaFromCatalog, type ImageQuotaSnapshot } from './image-quota';
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { hasOfficialHubApi, hubRpc, generation } from './live-hub';
import { nativeHostStatus, resolveCredentialHostId } from './native-host';
import { EnvironmentTokenSlots } from './live-environment';
import { requestAccountQuota } from './account-quota-transport';
import { parseAccountQuotaIdentity } from './account-quota';
import { beginDebugOperation, debugErrorCode, debugErrorData, debugFailureOutcome } from './debug-events';
import { pinOfficialExtension, matchesOfficialExtension } from './official-extension-identity';
import { imageModelsFromCatalog, bindCurrentAccountAccess, AccountChoice, ImageModelChoice } from './direct-image-binding';
import { generateDirectImageBatch, DirectImageRequest } from './direct-image-core';
import { sendDirectImage } from './direct-image-transport';
import { resolveEndpointImageProject } from './direct-image-project-transport';
import { readCurrentOfficialWslToken } from './direct-image-current-token';
import { imageEndpoint, validImageRequestId, type ImageEndpoint } from './direct-image-protocol';
import { LiveLocks } from './live-lock';
import { LiveError } from './live-storage';
import { SavedImageAccounts } from './saved-image-account';
import { readSavedImageModels } from './saved-image-models';
import { enterImageOperation } from './image-activity';
import { ImageOperationJournal, imageOperationStart, imageOperationResponse, imageOperationFailure, formatImageOperations } from './image-operation-record';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type AccountSummary = Pick<AccountChoice, 'id' | 'label' | 'expectedEmail'> & { hostCurrent?: boolean; hostId?: string; migrationState?: string; capturedAt?: string; quotaDisplayId?: string; verifiedSubject?: string; active?: boolean };
export interface ImageChoices { accounts: AccountChoice[]; models: ImageModelChoice[]; readiness?: 'ready' | 'error'; accountMessage?: string; failure?: CatalogFailure; catalogCacheHit?: boolean; catalog?: { source: 'fetchAvailableModels'; queriedAt: string } }

/** New independent image route, reachable only through the existing image confirmation. */
export function createDirectImageIntegration(context: vscode.ExtensionContext, getAccounts: () => AccountSummary[], runtime: {
  accountsReady?: () => boolean;
  locks?: Pick<LiveLocks, 'withOperation' | 'hasRecovery'>; journal?: Pick<ImageOperationJournal, 'write' | 'read' | 'dispose'>;
} = {}) {
  const journal = runtime.journal ?? new ImageOperationJournal(context.globalStorageUri?.fsPath ? path.join(context.globalStorageUri.fsPath, 'image-operations') : undefined);
  context.subscriptions?.push({ dispose: () => journal.dispose() });
  let accountLocks = runtime.locks;
  let historyWriteFailed = false;
  const locks = () => accountLocks ??= new LiveLocks(path.join(os.homedir(), '.gemini'), createHash('sha256').update(context.globalStorageUri.toString()).digest('hex'), { purpose: 'image' });
  // Only a global application setting can select one of the two compiled hosts.
  const getEndpoint = () => imageEndpoint(vscode.workspace.getConfiguration('antigravityAccounts.images').inspect<string>('endpoint')?.globalValue);
  const status = () => nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
  const summaries = (): AccountChoice[] => getAccounts().map(x => ({ ...x, active: x.active === true, hostCurrent: x.hostCurrent === true }));
  const saved = new SavedImageAccounts({ accounts: summaries, withOperation: work => locks().withOperation(work),
    project: resolveEndpointImageProject, models: readSavedImageModels, parseModels: imageModelsFromCatalog,
    store: () => savedAccountStore(context, locks(), () => status().available),
  });
  const assertAccountsReady = () => { if (runtime.accountsReady?.() === false) throw Error('IMAGE_ACCOUNT_INITIALIZING'); };
  const session = () => {
    assertAccountsReady();
    if (context.globalState?.get('live-switch.pending.v1', false)) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
    if (!status().available) throw new Error('IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED');
    const ext = vscode.extensions.getExtension('google.google-antigravity');
    if (!ext) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
    if (!ext.isActive || !hasOfficialHubApi(ext.exports)) throw new Error('IMAGE_ACCOUNT_INITIALIZING');
    const descriptor = pinOfficialExtension(ext);
    const api = { port: ext.exports.port, csrfToken: ext.exports.csrfToken };
    const pinnedGeneration = generation(api);
    const current = () => {
      const next = vscode.extensions.getExtension('google.google-antigravity');
      if (!status().available || !next?.isActive || !matchesOfficialExtension(descriptor, next) ||
          !hasOfficialHubApi(next.exports) || next.exports.port !== api.port || next.exports.csrfToken !== api.csrfToken || generation(next.exports) !== pinnedGeneration)
        throw new Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
    };
    return { api, current };
  };
  const readHubCatalog = async (signal: AbortSignal, includeCatalog = true) => {
    const pinned = session(), endpoint = getEndpoint();
    const auth = await hubRpc(pinned.api, 'GetAuthStatus', signal);
    const state = await hubRpc(pinned.api, 'GetUserStatus', signal);
    if (!object(auth) || !object(auth.authResult) || auth.authResult.hasValidAuth !== true || !object(state) || !object(state.userStatus) ||
        typeof state.userStatus.email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(state.userStatus.email)) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
    const email = state.userStatus.email;
    const verify = async (checkSignal: AbortSignal) => {
      pinned.current();
      if (getEndpoint() !== endpoint) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      const nextAuth = await hubRpc(pinned.api, 'GetAuthStatus', checkSignal);
      const next = await hubRpc(pinned.api, 'GetUserStatus', checkSignal);
      pinned.current();
      if (checkSignal.aborted) throw new Error('IMAGE_CANCELLED');
      if (getEndpoint() !== endpoint) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      if (!object(nextAuth) || !object(nextAuth.authResult) || nextAuth.authResult.hasValidAuth !== true) throw new Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
      if (!object(next) || !object(next.userStatus) || typeof next.userStatus.email !== 'string' || next.userStatus.email.toLowerCase() !== email.toLowerCase()) throw new Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
    };
    const available = includeCatalog ? await hubRpc(pinned.api, 'GetAvailableModels', signal) : undefined;
    await verify(signal);
    return { auth, state, available, email, hubGeneration: generation(pinned.api), catalog: object(available) ? available.response : undefined, verify };
  };
  const currentAccess = async (signal: AbortSignal, allowProjectLookup = true, endpoint = getEndpoint()) => {
    const snapshot = await readHubCatalog(signal, false);
    const matches = summaries().filter(a => a.hostCurrent && a.expectedEmail.toLowerCase() === snapshot.email.toLowerCase());
    if (matches.length !== 1) throw Error('IMAGE_DIRECT_SUMMARY_MISMATCH');
    const selected = { ...matches[0]!, active: true }, fingerprint = accountDisplayFingerprint(selected);
    const assertCurrent = async () => {
      if (getEndpoint() !== endpoint) throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      if (context.globalState.get('live-switch.pending.v1', false)) throw Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
      const current = summaries().find(a => a.id === selected.id);
      if (!current || accountDisplayFingerprint(current) !== fingerprint) throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
      await snapshot.verify(signal);
    };
    const mode = await new EnvironmentTokenSlots(os.homedir()).mode();
    const hostId = await resolveCredentialHostId(context, vscode.env.remoteName, mode);
    const access = await bindCurrentAccountAccess({ vault: context.secrets, selected, hostId, signal, assertCurrent, freezeAfterBinding: true,
      resolveCurrentToken: checkSignal => readCurrentOfficialWslToken({ api: () => vscode.extensions.getExtension('google.google-antigravity')?.exports, assertCurrent, signal: checkSignal }),
      ...(allowProjectLookup ? { endpoint, resolveEndpointProject: resolveEndpointImageProject } : {}),
      verifyIdentity: async (token, checkSignal) => parseAccountQuotaIdentity(await requestAccountQuota({ endpoint: 'identity', accessToken: token, signal: checkSignal })) });
    return { access, selected, assertCurrent, hubGeneration: snapshot.hubGeneration };
  };
  // Public directory data only. Rebind identity/project and verify the exact secret
  // revision before reuse; display persistence is never authorization evidence.
  let currentCatalog: { key: string; catalog: ReturnType<typeof parseModelCatalog>; models: ImageModelChoice[]; queriedAt: string; expiresAt: number } | undefined;
  const currentDirectory = async (signal: AbortSignal, endpoint = getEndpoint(), force = true) => {
    if (force) currentCatalog = undefined;
    const binding = await currentAccess(signal, true, endpoint);
    const key = createHash('sha256').update(JSON.stringify([endpoint, accountDisplayFingerprint(binding.selected), binding.selected.verifiedSubject,
      binding.selected.quotaDisplayId, binding.hubGeneration, binding.access.credentialRevision, binding.access.token, binding.access.projectId])).digest('hex');
    if (force || currentCatalog?.key !== key || currentCatalog.expiresAt <= Date.now()) currentCatalog = undefined;
    if (currentCatalog) {
      await binding.access.verify(signal); await binding.assertCurrent();
      return { ...binding, ...currentCatalog, models: currentCatalog.models.map(row => ({ ...row })), cacheHit: true };
    }
    const raw = await readSavedImageModels(binding.access.token, binding.access.projectId, signal, endpoint);
    if (JSON.stringify(raw).includes(binding.access.token)) throw catalogError('IMAGE_SAVED_MODELS_INVALID', 'parse', 'parse', 200);
    let catalog;
    try { catalog = parseModelCatalog(raw); } catch (error) { throw catalogParseError(error); }
    await binding.access.verify(signal); await binding.assertCurrent();
    const entry = { key, catalog, models: imageModelsFromCatalog(catalog), queriedAt: new Date().toISOString(),
      expiresAt: Math.min(Date.now() + 5 * 60_000, binding.access.credentialExpiresAt - 30_000) };
    currentCatalog = entry;
    return { ...binding, ...entry, models: entry.models.map(row => ({ ...row })), cacheHit: false };
  };
  const diagnoseCatalog = async (signal: AbortSignal) => {
    const release = enterImageOperation('catalog-diagnostic');
    try { return await diagnoseImageCatalog({ endpoint: getEndpoint, accounts: summaries, hub: readHubCatalog,
      direct: (id, checkSignal, endpoint, assertCurrent) => saved.diagnoseCatalog(id, checkSignal, endpoint, assertCurrent) }, signal); }
    finally { release(); }
  };
  const readChoicesWork = async (signal: AbortSignal, savedAccountId?: string, force = false): Promise<ImageChoices> => {
    assertAccountsReady();
    if (savedAccountId) {
      saved.forgetMissing();
      const accounts = summaries();
      if (!accounts.some(x => x.id === savedAccountId)) return { accounts, models: [], readiness: 'error', accountMessage: 'IMAGE_SAVED_ACCOUNT_REMOVED' };
      if (!saved.isSelected(savedAccountId)) return { accounts, models: [], readiness: 'error', accountMessage: 'IMAGE_SAVED_SELECTION_REQUIRED' };
      const endpoint = getEndpoint();
      const directory = await saved.directory(savedAccountId, signal, endpoint, force);
      if (getEndpoint() !== endpoint) throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      return { accounts, models: directory.models, catalogCacheHit: directory.cacheHit,
        catalog: { source: directory.source, queriedAt: directory.queriedAt }, readiness: 'ready', ...(directory.imageIssue ? { accountMessage: directory.imageIssue } : {}) };
    }
    const directory = await locks().withOperation(() => currentDirectory(signal, getEndpoint(), force));
    const imageIssue = imageCatalogIssue(directory.catalog);
    return { accounts: summaries().map(a => ({ ...a, active: a.id === directory.selected.id })), models: directory.models, catalogCacheHit: directory.cacheHit,
      catalog: { source: 'fetchAvailableModels', queriedAt: directory.queriedAt }, readiness: 'ready', ...(imageIssue ? { accountMessage: imageIssue } : {}) };
  };
  const readChoices = async (signal: AbortSignal, savedAccountId?: string, force = false): Promise<ImageChoices> => {
    const endpoint = getEndpoint(), diagnostic = beginDebugOperation('image.catalog');
    diagnostic.event('preparing', { imageEndpoint: endpoint, catalogUse: savedAccountId ? 'saved' : 'current' });
    try {
      const result = await readChoicesWork(signal, savedAccountId, force);
      if (getEndpoint() !== endpoint) throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      diagnostic.end(result.readiness === 'error' ? 'failed' : 'completed', { imageEndpoint: endpoint,
        ...(result.accountMessage ? { code: result.accountMessage } : {}), ...(result.catalogCacheHit === undefined ? {} : { catalogCacheHit: result.catalogCacheHit }), ...(result.readiness === 'error' ? result.failure ?? { catalogStage: 'binding', catalogFailure: 'binding' } : {}) });
      return result;
    } catch (error) {
      const failure = catalogFailureDetails(error);
      let accountMessage = catalogErrorCode(error);
      if (error instanceof LiveError && error.code === 'LIVE_OPERATION_OR_RECOVERY_LOCKED') {
        let recovery = true; try { recovery = await locks().hasRecovery(); } catch { /* Stay blocked. */ }
        accountMessage = recovery ? 'IMAGE_ACCOUNT_RECOVERY_PENDING' : 'IMAGE_ACCOUNT_INITIALIZING';
      }
      diagnostic.end(signal.aborted ? 'cancelled' : 'failed', { code: accountMessage, imageEndpoint: endpoint, ...failure });
      if (signal.aborted) throw Error('IMAGE_CANCELLED');
      return { accounts: summaries(), models: [], readiness: 'error', accountMessage, failure };
    }
  };
  const bind = async (accountId: string, modelId: string, signal: AbortSignal, confirmedUse = false, endpoint = getEndpoint()) => {
    const directory = await currentDirectory(signal, endpoint);
    if (directory.selected.id !== accountId) throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
    const model = directory.models.find(row => row.id === modelId);
    if (!model) throw Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
    assertModelUse(model, confirmedUse, 'IMAGE_MODEL_USAGE_REQUIRED');
    return { ...directory.access, modelId, modelSource: 'saved-account' as const,
      ...(model.modelEnum ? { modelEnum: model.modelEnum } : {}), ...(model.imageInput === undefined ? {} : { imageInput: model.imageInput }) };
  };
  const readImageQuota = async (accountId: string, modelId: string, signal: AbortSignal, savedAccountId?: string): Promise<ImageQuotaSnapshot> => {
    const endpoint = getEndpoint();
    if (savedAccountId) {
      if (savedAccountId !== accountId) throw Error('IMAGE_SAVED_ACCOUNT_CHANGED');
      const result = await saved.quota(accountId, modelId, signal, endpoint);
      if (getEndpoint() !== endpoint) throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      return result;
    }
    return locks().withOperation(async () => {
      if (await locks().hasRecovery()) throw Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
      const directory = await currentDirectory(signal, endpoint);
      if (directory.selected.id !== accountId) throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
      const row = imageQuotaFromCatalog(directory.catalog, directory.models).find(item => item.modelId === modelId);
      if (!row) throw Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
      return { ...row, accountId, endpoint, queriedAt: new Date().toISOString() };
    });
  };
  const check = async (signal: AbortSignal, allowProjectLookup: boolean, expectedEndpoint?: ImageEndpoint) => {
    const endpoint = allowProjectLookup ? getEndpoint() : undefined;
    if (expectedEndpoint !== undefined && endpoint !== imageEndpoint(expectedEndpoint)) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
    await currentAccess(signal, allowProjectLookup, endpoint);
    return allowProjectLookup ? 'IMAGE_DIRECT_PROJECT_READY' : 'IMAGE_DIRECT_PREFLIGHT_OK';
  };
  const diagnose = (signal: AbortSignal) => check(signal, false);
  const diagnoseProject = (signal: AbortSignal, expectedEndpoint?: ImageEndpoint) => check(signal, true, expectedEndpoint);
  const run = async (request: DirectImageRequest, signal: AbortSignal, onProgress: (value: { phase: string; message: string; responseModel?: ModelObservation }) => void, operationId?: string) => {
    request = { ...request, references: [...request.references] };
    const record = imageOperationStart(request, operationId);
    const diagnostic = beginDebugOperation('image.generate', record.operationId);
    diagnostic.event('preparing', {requestedCount: request.count ?? 1});
    let releaseImage: (() => void) | undefined;
    let sentEndpoint: ImageEndpoint | undefined;
    let batchEntered = false;
    let recorded = await journal.write(record);
    try {
      releaseImage = enterImageOperation(record.operationId);
      const endpoint = getEndpoint();
      record.endpoint = endpoint;
      if (request.endpoint !== undefined && imageEndpoint(request.endpoint) !== endpoint) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      if (request.accountSource === 'saved') await saved.choices(request.accountId, signal, endpoint, true);
      const savedBinding = request.accountSource === 'saved' ? await saved.bind(request.accountId, request.modelId, signal, endpoint, false, request.confirmedModelUse === true) : undefined;
      if (getEndpoint() !== endpoint) throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      const result = await locks().withOperation(async () => {
        batchEntered = true;
        if (context.globalState.get('live-switch.pending.v1', false) || await locks().hasRecovery()) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
        return generateDirectImageBatch(request, signal, { onProgress: value => {
        if (value.phase === 'generating' || value.phase === 'validating') record.stage = value.phase;
        if (value.phase === 'generating' || value.phase === 'validating') diagnostic.event(value.phase);
        onProgress(value);
      }, send: async (token, body, sendSignal, target) => {
        record.attempted++;
        sentEndpoint = imageEndpoint(target);
        diagnostic.event('generating', { imageEndpoint: sentEndpoint });
        const requestId = object(body) && validImageRequestId(body.requestId) ? { requestId: body.requestId } : {};
        let response: unknown;
        try { response = await sendDirectImage(token, body, sendSignal, undefined, target); }
        catch (error) { record.responses.push({ ...requestId, ...imageOperationFailure(error) }); onProgress({ phase: 'response', message: '', responseModel: missingModel() }); throw error; }
        record.responses.push({ ...requestId, ...imageOperationResponse(response) });
        const excluded = [token, request.prompt];
        if (object(body) && typeof body.project === 'string') excluded.push(body.project);
        onProgress({ phase: 'response', message: '', responseModel: responseModels(response, excluded) }); return response;
      }, bind: (accountId, modelId, bindSignal) => savedBinding ? Promise.resolve(savedBinding) : bind(accountId, modelId, bindSignal, request.confirmedModelUse === true, endpoint) });
      });
      record.outcome = result.batch.outcome; record.completed = result.batch.completed;
      record.artifacts = result.images.length;
      record.png = result.images.filter(x => x.file.endsWith('.png')).length;
      record.jpeg = result.images.filter(x => /\.jpe?g$/i.test(x.file)).length;
      if (result.batch.error) record.code = debugErrorCode(new Error(result.batch.error));
      diagnostic.end(result.batch.outcome === 'complete' ? 'completed' : result.batch.outcome === 'cancelled' ? 'cancelled' : 'partial',
        {requestedCount: result.batch.requested, completedCount: result.batch.completed, ...(sentEndpoint ? {imageEndpoint: sentEndpoint} : {}), ...(result.batch.error ? {code: result.batch.error} : {})});
      return result;
    } catch (caught) {
      const error = caught instanceof LiveError && !batchEntered ? new Error(caught.code.startsWith('ACCOUNT_QUOTA_') ? catalogErrorCode(caught) : 'IMAGE_ACCOUNT_OPERATION_BUSY') : caught;
      record.outcome = signal.aborted ? 'cancelled' : 'failed'; record.code = debugErrorCode(error);
      // An HTTP 200 may still fail during parsing/validation. Enrich only its own
      // last response; never attach a prior operation's error to this request.
      if (record.responses.length) Object.assign(record.responses[record.responses.length - 1]!, imageOperationFailure(error));
      diagnostic.end(debugFailureOutcome(debugErrorCode(error)), { ...debugErrorData(error), ...(sentEndpoint ? {imageEndpoint: sentEndpoint} : {}) }); throw error;
    } finally {
      record.endedAt = new Date().toISOString();
      recorded = await journal.write(record) && recorded;
      historyWriteFailed = !recorded;
      releaseImage?.();
      if (!recorded) diagnostic.event('status', { code: 'IMAGE_OPERATION_HISTORY_UNAVAILABLE' });
    }
  };
  return { readChoices, readImageQuota, hasSavedAccountSelection: (id: string) => saved.isSelected(id), selectSavedAccount: (id: string) => { assertAccountsReady(); saved.selectForWindow(id); }, listAccounts: summaries, diagnoseCatalog, diagnose, diagnoseProject, run, getEndpoint,
    operationRecordWarning: () => historyWriteFailed ? tr("directImageVscode.1da2d70877") : '',
    operationHistory: async () => formatImageOperations(await journal.read()) };
}
