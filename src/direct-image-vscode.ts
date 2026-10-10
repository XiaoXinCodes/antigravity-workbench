import { accountDisplayFingerprint } from './quota-presentation';
import { passiveCurrentEmail } from './passive-current-identity';
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
import { currentImageModels, imageModelsFromCatalog, bindSavedImageAccount, AccountChoice, ImageModelChoice } from './direct-image-binding';
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
type AccountSummary = Pick<AccountChoice, 'id' | 'label' | 'expectedEmail'> & { hostCurrent?: boolean; hostId?: string; migrationState?: string; capturedAt?: string; active?: boolean };
export interface ImageChoices { accounts: AccountChoice[]; models: ImageModelChoice[]; readiness?: 'ready' | 'error'; accountMessage?: string }

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
  let observationCurrentEmail: string | undefined;
  const observedSaved = new SavedImageAccounts({ accounts: summaries, withOperation: work => locks().withOperation(async () => {
    observationCurrentEmail = await passiveCurrentEmail(); return work();
  }), project: resolveEndpointImageProject, models: readSavedImageModels, parseModels: imageModelsFromCatalog,
    store: () => savedAccountStore(context, locks(), () => status().available),
    refreshAllowed: a => !a.active && !!observationCurrentEmail && observationCurrentEmail !== a.expectedEmail.toLowerCase() });
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
  const readHubCatalog = async (signal: AbortSignal) => {
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
    const available = await hubRpc(pinned.api, 'GetAvailableModels', signal);
    await verify(signal);
    return { auth, state, available, email, catalog: object(available) ? available.response : undefined, verify };
  };
  const diagnoseCatalog = async (signal: AbortSignal) => {
    const release = enterImageOperation('catalog-diagnostic');
    try { return await diagnoseImageCatalog({ endpoint: getEndpoint, accounts: summaries, hub: readHubCatalog,
      direct: (id, checkSignal, endpoint, assertCurrent) => saved.diagnoseCatalog(id, checkSignal, endpoint, assertCurrent) }, signal); }
    finally { release(); }
  };
  const readChoices = async (signal: AbortSignal, savedAccountId?: string, force = false): Promise<ImageChoices> => {
    assertAccountsReady();
    if (savedAccountId) {
      saved.forgetMissing();
      const accounts = summaries();
      if (!accounts.some(x => x.id === savedAccountId)) return { accounts, models: [], readiness: 'error', accountMessage: 'IMAGE_SAVED_ACCOUNT_REMOVED' };
      if (!saved.isSelected(savedAccountId)) return { accounts, models: [], readiness: 'error', accountMessage: 'IMAGE_SAVED_SELECTION_REQUIRED' };
      try { return { accounts, models: await saved.choices(savedAccountId, signal, getEndpoint(), force), readiness: 'ready' }; }
      catch (error) {
        if (signal.aborted) throw new Error('IMAGE_CANCELLED');
        let accountMessage = savedImageError(error);
        if (error instanceof LiveError && error.code === 'LIVE_OPERATION_OR_RECOVERY_LOCKED') {
          // Startup identity checks share this lock. A recovery journal remains
          // blocked; an ordinary active operation can be waited out safely.
          let recovery = true;
          try { recovery = await locks().hasRecovery(); } catch { /* Unknown lock state stays blocked. */ }
          accountMessage = recovery ? 'IMAGE_ACCOUNT_RECOVERY_PENDING' : 'IMAGE_ACCOUNT_INITIALIZING';
        }
        return { accounts, models: [], readiness: 'error', accountMessage };
      }
    }
    const snapshot = await readHubCatalog(signal);
    const { auth, state, available, email } = snapshot;
    const accounts = getAccounts();
    if (accounts.filter(x => x.hostCurrent && x.expectedEmail.toLowerCase() === email.toLowerCase()).length !== 1)
      throw new Error('IMAGE_DIRECT_SUMMARY_MISMATCH');
    const models = currentImageModels(auth, state, available, email);
    return { accounts: accounts.map(x => ({ ...x, active: x.hostCurrent === true && x.expectedEmail.toLowerCase() === email.toLowerCase(), hostCurrent: x.hostCurrent === true })), models };
  };
  const bind = async (accountId: string, modelId: string, jobSignal: AbortSignal, allowProjectLookup = true, endpoint?: ImageEndpoint) => {
        const choices = await readChoices(jobSignal);
        const selected = choices.accounts.find(x => x.id === accountId);
        const model = choices.models.find(x => x.id === modelId);
        if (!selected || !model) throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
        const mode = await new EnvironmentTokenSlots(os.homedir()).mode();
        const hostId = await resolveCredentialHostId(context, vscode.env.remoteName, mode);
        const assertCurrent = async () => {
          if (endpoint !== undefined && getEndpoint() !== endpoint) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
          if (context.globalState.get('live-switch.pending.v1', false)) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
          const next = await readChoices(jobSignal);
          if (endpoint !== undefined && getEndpoint() !== endpoint) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
          if (!next.accounts.some(x => x.id === accountId && x.active) || !next.models.some(x => x.id === modelId))
            throw new Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
        };
        return bindSavedImageAccount({ vault: context.secrets, selected, model: model as ImageModelChoice, hostId, signal: jobSignal,
          assertCurrent, freezeAfterBinding: true,
          resolveCurrentToken: signal => readCurrentOfficialWslToken({
            api: () => vscode.extensions.getExtension('google.google-antigravity')?.exports,
            assertCurrent, signal,
          }),
          ...(allowProjectLookup && endpoint !== undefined ? { endpoint, resolveEndpointProject: resolveEndpointImageProject } : {}),
          verifyIdentity: async (token, checkSignal) => parseAccountQuotaIdentity(await requestAccountQuota({ endpoint: 'identity', accessToken: token, signal: checkSignal })) });
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
      const bound = await bind(accountId, modelId, signal, true, endpoint);
      const response = await readSavedImageModels(bound.token, bound.projectId, signal, endpoint);
      await bound.verify(signal);
      if (getEndpoint() !== endpoint) throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      const row = imageQuotaFromCatalog(response, imageModelsFromCatalog(response)).find(item => item.modelId === modelId);
      if (!row) throw Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
      return { ...row, accountId, endpoint, queriedAt: new Date().toISOString() };
    });
  };
  const readCandidateImageQuota = async (id: string, model: string, signal: AbortSignal, endpoint: ImageEndpoint): Promise<ImageQuotaSnapshot> => {
    assertAccountsReady();
    const account = summaries().find(a => a.id === id);
    if (!account || !account.hostCurrent || account.migrationState === 'pending') throw Error('IMAGE_SAVED_ACCOUNT_CHANGED');
    const fingerprint = accountDisplayFingerprint(account);
    const assertCurrent = async () => {
      const current = summaries().find(a => a.id === id);
      if (signal.aborted || !current || accountDisplayFingerprint(current) !== fingerprint || current.active !== account.active) throw Error('IMAGE_SAVED_ACCOUNT_CHANGED');
      if (getEndpoint() !== endpoint) throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
    };
    await assertCurrent();
    const result = account.active ? await readImageQuota(id, model, signal) : await observedSaved.observeQuota(id, model, signal, endpoint, assertCurrent);
    await assertCurrent(); return result;
  };
  const check = async (signal: AbortSignal, allowProjectLookup: boolean, expectedEndpoint?: ImageEndpoint) => {
    const endpoint = allowProjectLookup ? getEndpoint() : undefined;
    if (expectedEndpoint !== undefined && endpoint !== imageEndpoint(expectedEndpoint)) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
    const choices = await readChoices(signal);
    const account = choices.accounts.find(x => x.active), model = choices.models[0];
    if (!account) throw new Error('IMAGE_DIRECT_SUMMARY_MISMATCH');
    if (!model) throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
    await bind(account.id, model.id, signal, allowProjectLookup, endpoint);
    return allowProjectLookup ? 'IMAGE_DIRECT_PROJECT_READY' : 'IMAGE_DIRECT_PREFLIGHT_OK';
  };
  const diagnose = (signal: AbortSignal) => check(signal, false);
  const diagnoseProject = (signal: AbortSignal, expectedEndpoint?: ImageEndpoint) => check(signal, true, expectedEndpoint);
  const run = async (request: DirectImageRequest, signal: AbortSignal, onProgress: (value: { phase: string; message: string }) => void, operationId?: string) => {
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
      const savedBinding = request.accountSource === 'saved' ? await saved.bind(request.accountId, request.modelId, signal, endpoint) : undefined;
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
        try { const response = await sendDirectImage(token, body, sendSignal, undefined, target); record.responses.push({ ...requestId, ...imageOperationResponse(response) }); return response; }
        catch (error) { record.responses.push({ ...requestId, ...imageOperationFailure(error) }); throw error; }
      }, bind: (accountId, modelId, bindSignal) => savedBinding ? Promise.resolve(savedBinding) : bind(accountId, modelId, bindSignal, true, endpoint) });
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
      const error = caught instanceof LiveError && !batchEntered ? new Error(caught.code.startsWith('ACCOUNT_QUOTA_') ? savedImageError(caught) : 'IMAGE_ACCOUNT_OPERATION_BUSY') : caught;
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
  return { readChoices, readImageQuota, readCandidateImageQuota, hasSavedAccountSelection: (id: string) => saved.isSelected(id), selectSavedAccount: (id: string) => { assertAccountsReady(); saved.selectForWindow(id); }, listAccounts: summaries, diagnoseCatalog, diagnose, diagnoseProject, run, getEndpoint,
    operationRecordWarning: () => historyWriteFailed ? tr("directImageVscode.1da2d70877") : '',
    operationHistory: async () => formatImageOperations(await journal.read()) };
}

function savedImageError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (/^IMAGE_[A-Z_]+$/.test(code)) return code;
  if (code === 'ACCOUNT_QUOTA_FORBIDDEN') return 'IMAGE_SAVED_MODELS_FORBIDDEN';
  if (['ACCOUNT_QUOTA_RESPONSE_INVALID', 'ACCOUNT_QUOTA_RESPONSE_TOO_LARGE'].includes(code)) return 'IMAGE_SAVED_MODELS_INVALID';
  if (code === 'ACCOUNT_QUOTA_TIMEOUT') return 'IMAGE_ACCOUNT_CHECK_TIMEOUT';
  if (/REAUTH_REQUIRED|CLIENT_UNVERIFIED|TOKEN_UNSUPPORTED|TOKEN_CONFLICT/.test(code)) return 'IMAGE_SAVED_AUTH_REQUIRED';
  if (/REFRESH_PENDING|REFRESH_OUTCOME_UNKNOWN|SECURE_SAVE_FAILED|REFRESH_SAVE_FAILED/.test(code)) return 'IMAGE_SAVED_AUTH_PENDING';
  if (/REFRESH_CONFLICT|IDENTITY_MISMATCH|IDENTITY_INVALID/.test(code)) return 'IMAGE_SAVED_ACCOUNT_CHANGED';
  return 'IMAGE_SAVED_MODELS_FAILED';
}
