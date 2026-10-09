import { displayAccount, hideIdentityText, onIdentityPresentationChange, identityAlias, identityHidden } from './identity-presentation';
import { accountDisplayFingerprint } from './quota-presentation';
import { ImageRecommendation } from './image-recommendation';
import type { ImageHistoryObserver } from './quota-history-ui';
import type { AlertSample } from './quota-alerts';
import { locale, localizeLines, localizeMessage, onLanguageChange, t as tr } from './i18n';
import { verifiedCurrentAccountId } from './current-account';
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { checkedDirectory } from './image-files';
import { readDirectRaster } from './direct-image-raster';
import { recoverExistingImage } from './direct-image-output';
import { formatImageFailure, localizeImageFailure } from './direct-image-http-error';
import { RecentImageFailureStore, captureRecentImageFailure, formatRecentImageFailure, type ImageFailureStage } from './recent-image-failure';
import type { DirectImageRequest } from './direct-image-core';
import type { createDirectImageIntegration } from './direct-image-vscode';
import { enterImageOperation } from './image-activity';
import { directImageHtml } from './direct-image-view';
import { IMAGE_LAYOUT_KEY, readImageLayout } from './direct-image-layout';
import { ImageSessionStore, checkSessionImages, sessionWarning, SESSION_MAX_DRAFTS, type ImageSessionStorage, type ImageSession, type ImageTask, type SavedImage, type ImageOrigin, type SavedDraft } from './image-session-store';
import { resultImage, checkedResult, prepareImageOrigin, verifyImageOrigin, imageVersions, inspectVersion, imageActionMessage, type ImageVersion } from './image-iteration';
import { ImageProjectActions } from './image-project-actions';
import { QuotaPreferences } from './quota-preferences';
import { ImageQuotaQuery, imageQuotaErrorText } from './image-quota';

type Direct = ReturnType<typeof createDirectImageIntegration>;
type Choice = Awaited<ReturnType<Direct['readChoices']>>;
const RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
const SIZES = new Set(['auto', '1K', '2K', '4K']);
const QUALITIES = new Set(['auto', 'detail']);
const code = formatImageFailure;

function nativePath(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file' && !uri.authority && path.isAbsolute(uri.fsPath)) return uri.fsPath;
  if (process.platform === 'linux' && vscode.env.remoteName === 'wsl' && uri.scheme === 'vscode-remote' &&
      uri.authority === `wsl+${process.env.WSL_DISTRO_NAME}` && path.posix.isAbsolute(uri.path)) return uri.path;
  return undefined;
}

/** Only handles UI state; account binding, HTTP, image validation and saving live outside the webview. */
export function registerDirectImageUi(context: vscode.ExtensionContext, direct: Direct, outputChanged?: () => void, sessionStorage?: ImageSessionStorage, preferences = new QuotaPreferences(context.globalState), observeQuota?: (sample: AlertSample) => void, history?: ImageHistoryObserver) {
  const storageRoot = context.storageUri?.fsPath ?? context.globalStorageUri?.fsPath;
  const session = sessionStorage ?? new ImageSessionStore(storageRoot ? path.join(storageRoot, context.storageUri ? 'image-session' : 'image-session-no-workspace') : undefined);
  let initialized: Promise<void> | undefined, loaded = false, storageNotice = '', saveTimer: ReturnType<typeof setTimeout> | undefined;
  const recent = new RecentImageFailureStore(context.globalState);
  let panel: vscode.WebviewPanel | undefined;
  let layout = readImageLayout(context.globalState.get(IMAGE_LAYOUT_KEY));
  let layoutSave: Promise<unknown> = Promise.resolve();
  let active: AbortController | undefined;
  let busy = false;
  let cancelRequested = false;
  let choicesRevision = 0, accountBlocked = false, refreshPending = false;
  let accountSnapshot: string | undefined, verifiedEmail: string | undefined, officialEmail: string | undefined;
  let currentIdentityChanged = false;
  let accountStatus = '';
  let selectedSavedId: string | undefined;
  let officialBlocked = false, choicesLoading = false;
  let checkSuspended = false, disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, retryAttempt = 0;
  const retryDelays = [500, 1_500, 3_000, 5_000, 8_000];
  let restoringSaved: { id: string; identity: string } | undefined;
  const savedIdentity = (id: string) => {
    const account = direct.listAccounts?.().find(account => account.id === id);
    return account ? JSON.stringify([account.id, account.expectedEmail, account.hostId, account.capturedAt, account.migrationState]) : '';
  };
  const stopRetry = (reset = false) => { clearTimeout(retryTimer); retryTimer = undefined; if (reset) retryAttempt = 0; };
  const restoreSelection = () => {
    if (!restoringSaved) return;
    if (restoringSaved.id !== selectedSavedId || savedIdentity(restoringSaved.id) !== restoringSaved.identity) {
      restoringSaved = undefined; throw Error('IMAGE_SAVED_SELECTION_REQUIRED');
    }
    direct.selectSavedAccount(restoringSaved.id); restoringSaved = undefined;
  };
  let choicesAbort: AbortController | undefined;
  let loadingSelection: string | undefined, loadingEndpoint: ReturnType<Direct['getEndpoint']> | undefined;
  let choiceEndpoint: ReturnType<Direct['getEndpoint']> | undefined;
  const selectedModels = new Map<string, string>();
  let choices: Choice = { accounts: [], models: [] };
  let status = tr("directImageUi.2ba78f5222");
  let operationHistory = '';
  const images: SavedImage[] = [];
  const tasks: ImageTask[] = [];
  let outputDirectory = '';
  let references: string[] = [];
  let referenceRevision = 0;
  let origin: ImageOrigin | undefined, modelUnavailable = false, actionNotice = '', preserveRestoredModel = false;
  const savedDrafts: SavedDraft[] = [];
  let comparison: { taskId: string; index: number; versions: ImageVersion[]; left: string; right: string; unavailable: Record<string, string> } | undefined;
  let draft = { prompt: '', accountId: '', modelId: '', ratio: '1:1', count: 1, size: 'auto', quality: 'auto', followCurrent: true };
  // These revisions belong to one webview, never to the persisted session.
  let draftRevision = 0, draftEpoch = 0, actionRevision = 0;
  const snapshot = (): ImageSession => ({ schema: 3, draft, outputDirectory, references, tasks, savedDrafts, ...(origin ? { origin } : {}) });
  const persistNow = async (): Promise<boolean> => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    if (!loaded) return false;
    try { await session.save(snapshot()); storageNotice = ''; return true; }
    catch (error) { storageNotice = sessionWarning(error); emit(false); return false; }
  };
  const scheduleSave = () => {
    if (!loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = undefined; void persistNow().then(() => emit(false)); }, 200);
  };
  const initialize = () => initialized ??= (async () => {
    try {
      const restored = await session.load();
      if (restored) {
        draft = restored.draft; preserveRestoredModel = !!draft.modelId; outputDirectory = restored.outputDirectory; references = restored.references;
        origin = restored.origin; savedDrafts.push(...(restored.savedDrafts ?? []));
        if (origin?.legacyUnverified) actionNotice = imageActionMessage(Error('IMAGE_EDIT_SOURCE_UNVERIFIED'));
        tasks.push(...restored.tasks); await checkSessionImages(tasks); images.push(...tasks.flatMap(task => task.images));
        if (!draft.followCurrent && draft.accountId) {
          selectedSavedId = draft.accountId; choices.accounts = direct.listAccounts?.() ?? [];
          try { direct.selectSavedAccount(selectedSavedId); }
          catch (error) {
            accountBlocked = true;
            if (error instanceof Error && error.message === 'IMAGE_ACCOUNT_INITIALIZING') {
              restoringSaved = { id: selectedSavedId, identity: savedIdentity(selectedSavedId) };
              accountStatus = tr("directImageUi.2dd1431159");
            } else { checkSuspended = true; accountStatus = code(error); }
          }
        }
        if (tasks.length) status = tr("directImageUi.8c763dc68c");
      }
      loaded = true;
    } catch (error) { storageNotice = sessionWarning(error); }
  })();
  const privateText = (value: string) => hideIdentityText(value, direct.listAccounts?.() ?? choices.accounts);
  const emit = (save = true, languageOnly = false) => { if (save) scheduleSave(); if (!panel) return;
    const currentId = verifiedCurrentAccountId(choices.accounts, accountSnapshot === undefined ? choices.accounts.find(account => account.active)?.expectedEmail : officialEmail, officialBlocked);
    recommendation.selection(draft.modelId, direct.getEndpoint());
    quota.selection(JSON.stringify([selectedSavedId ?? '@current', draft.accountId, draft.modelId, direct.getEndpoint()]));
    if (vscode.Uri?.file) panel.webview.options = { ...panel.webview.options,
      localResourceRoots: [...new Set([...images.filter(image => !image.unavailable).map(image => path.dirname(image.file)),
        ...references.map(file => path.dirname(file)),
        ...(comparison?.versions.filter(v => [comparison?.left, comparison?.right].includes(v.key) && !comparison?.unavailable[v.key]).map(v => path.dirname(v.file)) ?? [])])].map(directory => vscode.Uri.file(directory)) };
    const compareSide = (key: string) => { const v = comparison?.versions.find(v => v.key === key); return v ? { key, label: localizeMessage(v.label), name: path.basename(v.file), width: v.width, height: v.height,
      unavailable: comparison?.unavailable[key] ? localizeMessage(comparison.unavailable[key]!) : undefined, preview: comparison?.unavailable[key] ? '' : panel?.webview.asWebviewUri?.(vscode.Uri.file(v.file)).toString() ?? '' } : undefined; };
    void panel.webview.postMessage({ type: 'state', languageOnly, busy, draftRevision, draftEpoch, actionRevision, status: privateText(localizeImageFailure(status)), storageNotice: privateText(localizeMessage(storageNotice)), storageBlocked: !!storageNotice, actionNotice: privateText(localizeMessage(actionNotice)), editorTarget: project.state(),
    iteration: origin ? { taskId: origin.taskId, imageIndex: origin.imageIndex, name: path.basename(origin.file), modelUnavailable } : undefined,
    savedDrafts: savedDrafts.map(s => ({ id: s.id, savedAt: s.savedAt, summary: s.draft.prompt.slice(0, 80) || tr("directImageUi.de5f067d27") })),
    comparison: comparison ? { versions: comparison.versions.map(v => ({ key: v.key, label: localizeMessage(v.label) })), left: compareSide(comparison.left), right: compareSide(comparison.right) } : undefined,
    imageFavorites: preferences.getState().imageFavorites,
    recommendation: { ...recommendation.getState(), rows: recommendation.getState().rows.map(row => { const a = (direct.listAccounts?.() ?? choices.accounts).find(a => a.id === row.accountId); return { ...row, fingerprint: undefined, label: a ? displayAccount(a) : '', usable: recommendation.usable(row) }; }) },
    imageQuota: { ...quota.getState(), error: localizeImageFailure(quota.getState().error ?? '') }, accountRetryPending: !!retryTimer, accountStatus: privateText(localizeImageFailure(accountStatus)), accountBlocked: accountBlocked || choicesLoading || modelUnavailable, choicesLoading, canCheckAccount: !!selectedSavedId || !officialBlocked,
    recentDiagnostic: privateText(formatRecentImageFailure(recent.get())), operationHistory: privateText(localizeLines(operationHistory)), choices: {
    accounts: choices.accounts.map(x => ({ id: x.id, label: displayAccount(x) + (x.id === currentId ? tr("directImageUi.d381a6a80a") : ''), active: x.id === currentId, unavailable: x.hostCurrent === false || x.migrationState === 'pending' })), models: choices.models },
    outputDirectory, outputName: outputDirectory ? path.basename(outputDirectory) || outputDirectory : '', references: references.map(x => path.basename(x)), referenceRevision,
    referenceImages: references.map((file, index) => ({ index, name: path.basename(file), source: file === origin?.file,
      preview: panel?.webview.asWebviewUri?.(vscode.Uri.file(file)).toString() ?? '' })),
    images: images.map((x, index) => ({ index, name: path.basename(x.file), width: x.width, height: x.height })),
    tasks: tasks.map(task => ({ ...task, accountLabel: identityHidden() ? identityAlias(task.accountId ?? task.id) : task.accountLabel, status: privateText(localizeImageFailure(task.status)), ...(task.count === 0 && !task.prompt ? { promptSummary: localizeMessage(task.promptSummary) } : {}), prompt: undefined, references: undefined, outputDirectory: undefined,
      origin: task.origin ? { taskId: task.origin.taskId, imageIndex: task.origin.imageIndex, rootTaskId: task.origin.rootTaskId, rootImageIndex: task.origin.rootImageIndex } : undefined,
      images: task.images.map((x, index) => ({ index, name: path.basename(x.file), width: x.width, height: x.height, projectCopy: x.projectCopy ? path.basename(x.projectCopy.file) : undefined,
      unavailable: x.unavailable ? localizeMessage(x.unavailable) : undefined, preview: x.unavailable ? '' : panel?.webview.asWebviewUri?.(vscode.Uri.file(x.file)).toString() ?? '' })) })), draft }); };
  context.subscriptions.push(onLanguageChange(() => {
    if (disposed || !panel) return;
    panel.title = tr("directImageUi.d5e1e00bbd");
    void panel.webview.postMessage({ type: 'language', language: locale() });
    emit(false, true);
  }));
  context.subscriptions.push(onIdentityPresentationChange(() => emit(false, true)));
  const project = new ImageProjectActions(context, () => emit(false));
  const quota = new ImageQuotaQuery(() => emit(false));
  const recommendation = new ImageRecommendation(() => direct.listAccounts?.() ?? choices.accounts, (id, model, signal, endpoint) => direct.readCandidateImageQuota(id, model, signal, endpoint), () => emit(false), row => {
    if (row.snapshot) { void history?.imageObservation(row.snapshot, row.fingerprint).catch(() => undefined); observeQuota?.({ accountId: row.accountId, fingerprint: row.fingerprint, quotaKey: JSON.stringify([row.snapshot.endpoint, row.snapshot.modelId]), modelLabel: row.snapshot.modelId, observedAt: row.snapshot.queriedAt, fraction: row.snapshot.remainingFraction }); }
    else void history?.imageGap(row.accountId, row.fingerprint, recommendation.getState().modelId, recommendation.getState().endpoint).catch(() => undefined);
  });
  const refresh = async (force = false) => {
    if (disposed) return;
    if (busy || !panel || officialBlocked && !selectedSavedId) { refreshPending = true; emit(); return; }
    if (checkSuspended && !force) { emit(); return; }
    const endpoint = direct.getEndpoint();
    if (!force && choicesLoading && !choicesAbort?.signal.aborted && loadingSelection === selectedSavedId && loadingEndpoint === endpoint) return;
    stopRetry();
    choicesAbort?.abort();
    const abort = new AbortController(); choicesAbort = abort;
    const revision = ++choicesRevision, owner = panel, selection = selectedSavedId;
    loadingSelection = selection; loadingEndpoint = endpoint;
    accountStatus = selection ? tr("directImageUi.375312c7f2") : tr("directImageUi.24140bdde7");
    choicesLoading = true; emit();
    let next: Choice;
    let timedOut = false;
    let onAbort: () => void = () => undefined;
    const interrupted = new Promise<Choice>((_resolve, reject) => {
      onAbort = () => reject(new Error(timedOut ? 'IMAGE_ACCOUNT_CHECK_TIMEOUT' : 'IMAGE_ACCOUNT_CHECK_CANCELLED'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    // Bound the whole UI lookup, including queued work and local async storage.
    // Cancellation still lets the existing refresh transaction finish safe persistence.
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 60_000);
    const ownsSelection = () => !disposed && revision === choicesRevision && !busy && panel === owner && selection === selectedSavedId;
    const ownsEndpoint = () => endpoint === direct.getEndpoint();
    try { next = await Promise.race([Promise.resolve().then(() => { restoreSelection(); return direct.readChoices(abort.signal, selection, force); }), interrupted]); }
    catch (error) {
      if (!ownsSelection()) return;
      const message = error instanceof Error ? error.message : '';
      next = { accounts: direct.listAccounts?.() ?? [], models: [], readiness: 'error', accountMessage: timedOut || /^(HUB_RPC_TIMEOUT|ACCOUNT_QUOTA_TIMEOUT)$/.test(message) ? 'IMAGE_ACCOUNT_CHECK_TIMEOUT' : /^IMAGE_[A-Z_]+$/.test(message) ? message : 'IMAGE_SAVED_MODELS_FAILED' };
    } finally {
      clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort);
      if (choicesAbort === abort) choicesAbort = undefined;
    }
    if (!ownsSelection() || abort.signal.aborted && !timedOut) return;
    if (!ownsEndpoint()) next = { accounts: direct.listAccounts?.() ?? [], models: [], readiness: 'error', accountMessage: 'IMAGE_DIRECT_ENDPOINT_CHANGED' };
    choicesLoading = false; refreshPending = false; choices = next; choiceEndpoint = endpoint;
    const currentEmail = choices.accounts.find(x => x.active)?.expectedEmail?.trim().toLowerCase();
    if (currentEmail) verifiedEmail = currentEmail;
    draft.accountId = selection ?? choices.accounts.find(x => x.active)?.id ?? '';
    draft.followCurrent = !selection;
    const remembered = selectedModels.get(selection ?? '@current');
    if (origin || preserveRestoredModel) modelUnavailable = !choices.models.some(x => x.id === draft.modelId);
    else if (next.readiness !== 'error') { modelUnavailable = false;
      if (remembered && choices.models.some(x => x.id === remembered)) draft.modelId = remembered;
      else if (!choices.models.some(x => x.id === draft.modelId)) draft.modelId = choices.models[0]?.id ?? '';
    }
    accountBlocked = next.readiness === 'error' || !choices.models.length || !draft.accountId;
    checkSuspended = accountBlocked;
    const startupTransient = next.accountMessage === 'IMAGE_ACCOUNT_INITIALIZING' || next.accountMessage === 'IMAGE_SAVED_MODELS_TRANSIENT' || !selection && next.accountMessage === 'IMAGE_DIRECT_SUMMARY_MISMATCH';
    if (accountBlocked && startupTransient && retryAttempt < retryDelays.length) {
      checkSuspended = false;
      const delay = retryDelays[retryAttempt++]!;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!disposed && revision === choicesRevision && panel === owner && selectedSavedId === selection && endpoint === direct.getEndpoint()) void refresh();
      }, delay);
      retryTimer.unref?.();
    } else if (!accountBlocked) stopRetry(true);
    accountStatus = next.accountMessage ? code(new Error(next.accountMessage)) : accountBlocked ? code(new Error(selection ? 'IMAGE_SAVED_MODELS_UNAVAILABLE' : 'IMAGE_DIRECT_MODEL_UNVERIFIED')) : selection ? tr("directImageUi.fff0ffca40") : currentIdentityChanged ? tr("directImageUi.f299aacd12") : '';
    if (startupTransient) accountStatus = next.accountMessage === 'IMAGE_SAVED_MODELS_TRANSIENT' ? retryTimer ? tr("directImageUi.607af85f14") : tr("directImageUi.e4256f5f9a") : retryTimer ? tr("directImageUi.4b5e5bb474") : tr("directImageUi.bc7960b9e7");
    if (!selection && !accountBlocked) currentIdentityChanged = false;
    if (origin && modelUnavailable && !accountBlocked) accountStatus = imageActionMessage(Error('IMAGE_EDIT_MODEL_UNAVAILABLE'));
    emit();
  };
  const cancel = () => {
    const waiting = !!retryTimer;
    if (waiting) checkSuspended = true;
    stopRetry();
    recommendation.cancel();
    quota.invalidate(true);
    cancelRequested = true; active?.abort(); choicesAbort?.abort(); ++choicesRevision;
    if ((choicesLoading || waiting) && !busy) {
      choicesLoading = false; accountBlocked = true; checkSuspended = true; choices = { ...choices, models: [] };
      accountStatus = code(new Error('IMAGE_ACCOUNT_CHECK_CANCELLED'));
    } else { choicesLoading = false; status = tr("directImageUi.e9d9e4b8f4"); }
    emit();
  };
  const saveDraft = (message: Record<string, unknown>, notify = true) => {
    if (typeof message.prompt !== 'string' || message.prompt.length > 12_000 ||
        typeof message.accountId !== 'string' || typeof message.modelId !== 'string' ||
        typeof message.ratio !== 'string' || !RATIOS.has(message.ratio) ||
        !Number.isInteger(message.count) || Number(message.count) < 1 || Number(message.count) > 4 ||
        typeof message.size !== 'string' || !SIZES.has(message.size) ||
        typeof message.quality !== 'string' || !QUALITIES.has(message.quality)) return false;
    if (message.draftRevision !== undefined) {
      if (!Number.isSafeInteger(message.draftRevision) || Number(message.draftRevision) < draftRevision) return false;
      draftRevision = Number(message.draftRevision);
    }
    if (message.modelId !== draft.modelId && choices.models.some(model => model.id === message.modelId)) preserveRestoredModel = false;
    draft = { prompt: message.prompt, accountId: selectedSavedId ?? choices.accounts.find(x => x.active)?.id ?? '', modelId: message.modelId, ratio: message.ratio,
      count: Number(message.count), size: message.size, quality: message.quality, followCurrent: !selectedSavedId };
    if (choices.models.some(x => x.id === draft.modelId)) selectedModels.set(selectedSavedId ?? '@current', draft.modelId);
    if (modelUnavailable && choices.models.some(x => x.id === draft.modelId)) { modelUnavailable = false; accountStatus = tr("directImageUi.ab787c1f0a"); }
    scheduleSave(); if (notify) emit(false); return true;
  };
  const keepDraft = (): SavedDraft => ({ id: randomUUID(), savedAt: new Date().toISOString(), draft: { ...draft },
    outputDirectory, references: [...references], ...(origin ? { origin: { ...origin } } : {}) });
  const hasDraft = () => !!draft.prompt || !!draft.modelId || !!outputDirectory || !draft.followCurrent || references.length > 0 || draft.ratio !== '1:1' || draft.count !== 1 || draft.size !== 'auto' || draft.quality !== 'auto';
  const loadDraft = async (next: SavedDraft, restoreId?: string) => {
    if (!loaded || storageNotice) throw Error('IMAGE_SESSION_SAVE_REQUIRED');
    const prior = keepDraft(), priorSaved = [...savedDrafts], priorSelection = selectedSavedId;
    if (restoreId) { const index = savedDrafts.findIndex(item => item.id === restoreId); if (index < 0) throw Error('IMAGE_RESULT_UNAVAILABLE'); savedDrafts.splice(index, 1); }
    if (hasDraft()) {
      if (savedDrafts.length >= SESSION_MAX_DRAFTS) { savedDrafts.splice(0, savedDrafts.length, ...priorSaved); throw Error('IMAGE_DRAFT_LIMIT'); }
      savedDrafts.push(prior);
    }
    draft = { ...next.draft }; outputDirectory = next.outputDirectory; references = [...next.references]; ++referenceRevision; origin = next.origin ? { ...next.origin } : undefined;
    selectedSavedId = draft.followCurrent ? undefined : draft.accountId;
    if (!await persistNow()) {
      draft = prior.draft; outputDirectory = prior.outputDirectory; references = prior.references; origin = prior.origin;
      selectedSavedId = priorSelection; savedDrafts.splice(0, savedDrafts.length, ...priorSaved); throw Error('IMAGE_SESSION_SAVE_REQUIRED');
    }
    // Continuing an image or restoring a saved draft is an explicit replacement,
    // unlike a delayed echo of the user's edits.
    ++draftEpoch; preserveRestoredModel = true;
    choices = { accounts: direct.listAccounts?.() ?? choices.accounts, models: [] }; modelUnavailable = false; accountBlocked = true;
    checkSuspended = false; refreshPending = true;
    try { if (selectedSavedId) direct.selectSavedAccount(selectedSavedId); }
    catch (error) { refreshPending = false; checkSuspended = true; accountStatus = code(error); }
    actionNotice = restoreId ? tr("directImageUi.44186c3546") : tr("directImageUi.71e99e6b08");
  };
  const inspectComparison = async () => {
    if (!comparison) return;
    const current = comparison;
    for (const key of new Set([current.left, current.right])) {
      const version = current.versions.find(v => v.key === key);
      if (!version) throw Error('IMAGE_RESULT_UNAVAILABLE');
      const reason = await inspectVersion(version);
      if (reason) current.unavailable[key] = reason; else delete current.unavailable[key];
    }
  };
  const quotaSelection = () => JSON.stringify([selectedSavedId ?? '@current', draft.accountId, draft.modelId, direct.getEndpoint()]);
  const querySelectedQuota = async (expected?: string) => {
    if (disposed || !panel || busy || choicesLoading || accountBlocked || modelUnavailable || !draft.accountId ||
        !choices.models.some(model => model.id === draft.modelId) || typeof direct.readImageQuota !== 'function') return;
    const key = quotaSelection(), owner = panel;
    if (expected !== undefined && expected !== key) return;
    const boundAccount = (direct.listAccounts?.() ?? choices.accounts).find(a => a.id === draft.accountId);
    const fingerprint = boundAccount ? accountDisplayFingerprint(boundAccount) : undefined;
    const id = draft.accountId, model = draft.modelId, selection = selectedSavedId, endpoint = direct.getEndpoint();
    await quota.query(async signal => {
      const result = await direct.readImageQuota(id, model, signal, selection);
      if (panel !== owner || quotaSelection() !== key || result.accountId !== id || result.modelId !== model || result.endpoint !== endpoint)
        throw Error('IMAGE_SAVED_ACCOUNT_CHANGED');
      const current = (direct.listAccounts?.() ?? choices.accounts).find(a => a.id === id);
      if (fingerprint && current && accountDisplayFingerprint(current) === fingerprint) observeQuota?.({ accountId: id, fingerprint, quotaKey: JSON.stringify([endpoint, model]), modelLabel: model, observedAt: result.queriedAt, fraction: result.remainingFraction });
      if (fingerprint && current && accountDisplayFingerprint(current) === fingerprint) void history?.imageObservation(result, fingerprint).catch(() => undefined);
      return result;
    }, imageQuotaErrorText);
    if (quotaSelection() === key && quota.getState().error && fingerprint) void history?.imageGap(id, fingerprint, model, endpoint).catch(() => undefined);
  };
  const handle = async (value: unknown, owner: vscode.WebviewPanel) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || panel !== owner) return;
    const msg = value as Record<string, unknown>;
    if (Number.isSafeInteger(msg.actionRevision) && Number(msg.actionRevision) >= actionRevision) actionRevision = Number(msg.actionRevision);
    if (msg.type === 'compareAccounts') { if (!busy && saveDraft(msg, false) && draft.modelId && !modelUnavailable && typeof direct.readCandidateImageQuota === 'function') await recommendation.start(draft.modelId, direct.getEndpoint()); return; }
    if (msg.type === 'cancelCompareAccounts') { recommendation.cancel(); emit(false); return; }
    if (msg.type === 'chooseRecommended') {
      if (!saveDraft(msg, false)) return;
      recommendation.selection(draft.modelId, direct.getEndpoint());
      const row = recommendation.choose(msg.accountId);
      if (!row || busy) { actionNotice = tr('recommend.unavailable'); emit(false); return; }
      msg.type = 'selectAccount'; msg.selection = row.accountId;
    }
    if (msg.type === 'queryQuota') { await querySelectedQuota(); return; }
    if (msg.type === 'layout') {
      if (typeof msg.resultsShare !== 'number' || !Number.isFinite(msg.resultsShare) || typeof msg.resultsCollapsed !== 'boolean') return;
      const next = readImageLayout(msg); layout = next;
      layoutSave = layoutSave.then(() => context.globalState.update(IMAGE_LAYOUT_KEY, next)).catch(() => {
        if (panel === owner) void owner.webview.postMessage({ type: 'layoutPersistenceError' });
      });
      return;
    }
    if (msg.type === 'saveRecords') { if (!busy) { await persistNow(); emit(false); } return; }
    if (msg.type === 'closeCompare') { comparison = undefined; emit(false); return; }
    if (msg.type === 'deleteTask') {
      if (busy || typeof msg.taskId !== 'string') return;
      const index = tasks.findIndex(task => task.id === msg.taskId);
      if (index < 0) return;
      const removed = tasks.splice(index, 1)[0]!;
      if (!await persistNow()) tasks.splice(index, 0, removed);
      comparison = undefined;
      images.splice(0, images.length, ...tasks.flatMap(task => task.images));
      emit(false); return;
    }
    if (msg.type === 'history') {
      try { operationHistory = await direct.operationHistory(); } catch { operationHistory = tr("directImageUi.3cccc65c71"); }
      emit(); return;
    }
    if (msg.type === 'selectAccount') {
      if (busy || typeof msg.selection !== 'string') return;
      if (!saveDraft(msg, false)) { emit(false); return; }
      if (msg.selection !== '@current' && !choices.accounts.some(x => x.id === msg.selection && x.hostCurrent !== false && x.migrationState !== 'pending')) { emit(false); return; }
      const selection = msg.selection === '@current' ? undefined : msg.selection;
      if (selection !== selectedSavedId) quota.invalidate();
      if (selection === selectedSavedId && choicesLoading && !choicesAbort?.signal.aborted) return;
      stopRetry(true); restoringSaved = undefined;
      choicesAbort?.abort(); ++choicesRevision;
      selectedSavedId = selection; preserveRestoredModel = false;
      if (origin) { origin = undefined; modelUnavailable = false; actionNotice = tr("directImageUi.69b0f51238"); }
      currentIdentityChanged = false;
      draft.followCurrent = !selectedSavedId; draft.accountId = selectedSavedId ?? choices.accounts.find(x => x.active)?.id ?? '';
      choices = { ...choices, models: [] }; accountBlocked = true; accountStatus = tr("directImageUi.8724656e6b");
      checkSuspended = false;
      try { if (selection) direct.selectSavedAccount(selection); }
      catch (error) { choicesLoading = false; checkSuspended = true; accountStatus = code(error); emit(); return; }
      await refresh(); return;
    }
    if (msg.type === 'checkAccount') {
      if (busy || choicesLoading) return;
      stopRetry(true); checkSuspended = false; await refresh(true); return;
    }
    if (msg.type === 'ready') { await refresh(); return; }
    if (msg.type === 'favoriteModel') {
      if (!busy && typeof msg.modelId === 'string' && choices.models.some(model => model.id === msg.modelId)) {
        try { await preferences.favoriteImage(msg.modelId); actionNotice = ''; } catch { actionNotice = tr('quota.preferencesFailed'); }
        emit(false);
      }
      return;
    }
    if (msg.type === 'draft') { if (!busy) saveDraft(msg); return; }
    if (msg.type === 'cancel') { cancel(); return; }
    if (busy) { emit(); return; }
    if (!['output', 'references', 'removeReference', 'clearReferences', 'recover', 'preview', 'generate', 'reuseTask', 'continueImage', 'restoreDraft', 'deleteDraft', 'detachIteration', 'compareImage', 'compareSelect', 'copyPath', 'copyMarkdown', 'insertMarkdown', 'copyToProject'].includes(String(msg.type))) return;
    if (msg.type === 'removeReference' || msg.type === 'clearReferences') {
      if (msg.revision !== referenceRevision || !references.length || msg.type === 'removeReference' &&
          (!Number.isInteger(msg.index) || Number(msg.index) < 0 || Number(msg.index) >= references.length)) { emit(false); return; }
    }
    if (msg.type === 'generate') quota.invalidate(true);
    busy = true; cancelRequested = false; emit();
    if (choicesLoading) refreshPending = true;
    ++choicesRevision; choicesAbort?.abort(); choicesLoading = false;
    let attempt: { modelId: string; operationId: string; stage: ImageFailureStage } | undefined;
    let task: ImageTask | undefined, taskOpen = true;
    let releaseImage: (() => void) | undefined, completedQuotaSelection: string | undefined;
    const assertActionActive = () => { if (panel !== owner || cancelRequested) throw Error('IMAGE_CANCELLED'); };
    try {
      if (['reuseTask', 'continueImage', 'restoreDraft'].includes(String(msg.type)) && msg.prompt !== undefined && !saveDraft(msg, false)) throw Error('IMAGE_DIRECT_SCOPE_INVALID');
      if (msg.type === 'reuseTask') {
        const original = tasks.find(t => t.id === msg.taskId);
        if (!original || original.count < 1 || !RATIOS.has(original.ratio) || !SIZES.has(original.size) || !QUALITIES.has(original.quality)) throw Error('IMAGE_RESULT_UNAVAILABLE');
        const account = (direct.listAccounts?.() ?? choices.accounts).find(a => a.id === original.accountId && a.hostCurrent !== false && a.migrationState !== 'pending');
        if (!account) throw Error('IMAGE_EDIT_ACCOUNT_REMOVED');
        if (original.accountFingerprint && original.accountFingerprint !== createHash('sha256').update(accountDisplayFingerprint(account)).digest('hex') || !original.accountFingerprint && account.capturedAt && Date.parse(account.capturedAt) > Date.parse(original.createdAt)) throw Error('IMAGE_EDIT_ACCOUNT_REMOVED');
        if (original.endpoint && original.endpoint !== direct.getEndpoint()) throw Error('IMAGE_EDIT_ENDPOINT_CHANGED');
        const missing: string[] = [];
        for (const file of original.references) { try { await readDirectRaster(file, await checkedDirectory(path.dirname(file))); } catch { missing.push(path.basename(file)); } }
        assertActionActive();
        await loadDraft({ id: randomUUID(), savedAt: new Date().toISOString(), draft: { prompt: original.prompt, accountId: account.id, modelId: original.modelId, ratio: original.ratio, count: original.count, size: original.size, quality: original.quality, followCurrent: false }, outputDirectory: original.outputDirectory, references: [...original.references], ...(original.origin ? { origin: { ...original.origin } } : {}) });
        actionNotice = missing.length ? tr('reuse.missing', { p0: missing.join('、') }) : tr('reuse.loaded');
      } else if (msg.type === 'continueImage') {
        const selected = resultImage(tasks, msg.taskId, msg.index);
        const available = (direct.listAccounts?.() ?? choices.accounts).find(a => a.id === selected.task.accountId && a.hostCurrent !== false && a.migrationState !== 'pending');
        if (!available) throw Error(selected.task.accountId ? 'IMAGE_EDIT_ACCOUNT_REMOVED' : 'IMAGE_EDIT_ACCOUNT_MISSING');
        if (selected.task.endpoint && selected.task.endpoint !== direct.getEndpoint()) throw Error('IMAGE_EDIT_ENDPOINT_CHANGED');
        const source = await prepareImageOrigin(selected.task, selected.image, selected.index);
        if (panel !== owner || cancelRequested) return;
        await loadDraft({ id: randomUUID(), savedAt: new Date().toISOString(), draft: {
          prompt: selected.task.prompt, accountId: available.id, modelId: selected.task.modelId, ratio: selected.task.ratio,
          count: selected.task.count, size: selected.task.size, quality: selected.task.quality, followCurrent: false },
          outputDirectory: selected.task.outputDirectory, references: [selected.image.file], origin: source });
      } else if (msg.type === 'restoreDraft') {
        const saved = savedDrafts.find(item => item.id === msg.id);
        if (!saved) throw Error('IMAGE_RESULT_UNAVAILABLE');
        await loadDraft(saved, saved.id);
      } else if (msg.type === 'deleteDraft') {
        const index = savedDrafts.findIndex(item => item.id === msg.id);
        if (index < 0) return;
        const removed = savedDrafts.splice(index, 1)[0]!;
        if (!await persistNow()) savedDrafts.splice(index, 0, removed);
        else actionNotice = tr("directImageUi.dc9e2f2831");
      } else if (msg.type === 'detachIteration') {
        origin = undefined; modelUnavailable = false; refreshPending = true; actionNotice = tr("directImageUi.1f2219996d");
      } else if (msg.type === 'compareImage') {
        const selected = resultImage(tasks, msg.taskId, msg.index), data = imageVersions(tasks, selected.task, selected.index);
        comparison = { taskId: selected.task.id, index: selected.index, ...data, unavailable: {} };
        await inspectComparison();
      } else if (msg.type === 'compareSelect') {
        if (!comparison || !['left', 'right'].includes(String(msg.side)) || !comparison.versions.some(v => v.key === msg.key)) throw Error('IMAGE_RESULT_UNAVAILABLE');
        comparison[msg.side as 'left' | 'right'] = String(msg.key); await inspectComparison();
      } else if (['copyPath', 'copyMarkdown', 'insertMarkdown', 'copyToProject'].includes(String(msg.type))) {
        const selected = resultImage(tasks, msg.taskId, msg.index);
        if (msg.type === 'copyToProject') {
          await checkedResult(selected.task, selected.image);
          const copy = await project.copyIntoProject(selected.image, assertActionActive);
          if (copy) { selected.image.projectCopy = copy;
            actionNotice = await persistNow() ? tr("directImageUi.b3b7965b5e") : tr("directImageUi.b86c3e1c3b"); }
        } else actionNotice = msg.type === 'copyPath' ? await project.copyPath(selected.image, assertActionActive)
          : msg.type === 'copyMarkdown' ? await project.copyMarkdown(selected.image, msg.targetId, assertActionActive) : await project.insertMarkdown(selected.image, msg.targetId, assertActionActive);
      } else if (msg.type === 'output') {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: tr("directImageUi.b3cb8570fe") });
        if (panel !== owner || cancelRequested) return;
        if (picked?.length === 1) {
          const candidate = nativePath(picked[0]!);
          if (!candidate) throw Error('IMAGE_LOCAL_DIRECTORY_REQUIRED');
          const checked = await checkedDirectory(candidate);
          if (panel !== owner || cancelRequested) return;
          outputDirectory = checked; outputChanged?.();
        }
        status = tr("directImageUi.30533023db");
      } else if (msg.type === 'removeReference' || msg.type === 'clearReferences') {
        const previous = { references, origin, modelUnavailable };
        references = msg.type === 'clearReferences' ? [] : references.filter((_file, index) => index !== msg.index);
        ++referenceRevision;
        if (origin && !references.includes(origin.file)) {
          origin = undefined; modelUnavailable = !!draft.modelId && !choices.models.some(model => model.id === draft.modelId);
        }
        if (!await persistNow()) {
          references = previous.references; origin = previous.origin; modelUnavailable = previous.modelUnavailable;
          actionNotice = tr("directImageUi.bc02c251a6");
          status = tr("directImageUi.716999ce44");
        } else {
          actionNotice = references.length ? tr("directImageUi.00c49f6159") : tr("directImageUi.e32082903d");
          status = references.length ? tr("directImageUi.3ea80ce94a", { p0: references.length }) : tr("directImageUi.c4c88d348c");
        }
      } else if (msg.type === 'references') {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: { [tr('common.imagesFilter')]: ['png', 'jpg', 'jpeg'] }, openLabel: tr("directImageUi.aa104c3853") });
        if (panel !== owner || cancelRequested) return;
        if (picked) {
          if (picked.length > 3) throw Error('IMAGE_DIRECT_SCOPE_INVALID');
          const paths = picked.map(nativePath);
          if (paths.some(x => !x)) throw Error('IMAGE_PNG_REQUIRED');
          for (const file of paths) await readDirectRaster(file!, await checkedDirectory(path.dirname(file!)));
          if (panel !== owner || cancelRequested) return;
          const previous = { references, origin, modelUnavailable };
          references = paths as string[]; ++referenceRevision;
          if (origin && !references.includes(origin.file)) { origin = undefined; modelUnavailable = false; actionNotice = tr("directImageUi.afa7e873d4"); }
          if (!await persistNow()) {
            references = previous.references; origin = previous.origin; modelUnavailable = previous.modelUnavailable;
            actionNotice = tr("directImageUi.c7949e70ba");
            status = tr("directImageUi.0a6fc5bc08"); return;
          }
        }
        status = tr("directImageUi.d7ab148b61", { p0: references.length });
      } else if (msg.type === 'recover') {
        if (!outputDirectory) throw Error('IMAGE_LOCAL_DIRECTORY_REQUIRED');
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { PNG: ['png'] }, openLabel: tr("directImageUi.1875b63ca3") });
        if (panel !== owner || cancelRequested) return;
        if (picked?.length === 1) {
          const source = nativePath(picked[0]!);
          if (!source) throw Error('IMAGE_ARTIFACT_PATH_REJECTED');
          const recovered = await recoverExistingImage(source, outputDirectory, os.homedir());
          images.push(recovered);
          tasks.push({ id: randomUUID(), createdAt: new Date().toISOString(), prompt: '', references: [], promptSummary: tr("directImageUi.eb47ec566e"), modelId: '本机 PNG', ratio: '原始', size: '原始', quality: '原始', count: 0,
            phase: 'complete', status: tr("directImageUi.4bf92b4268"), outputDirectory, images: [recovered] });
          status = tr("directImageUi.23ac2a0b77");
        }
      } else if (msg.type === 'preview') {
        const selectedTask = typeof msg.taskId === 'string' ? tasks.find(item => item.id === msg.taskId) : undefined;
        const image = typeof msg.taskId === 'string' ? selectedTask?.images[Number(msg.index)] : images[Number(msg.index)];
        if (!Number.isInteger(msg.index) || !image) throw Error('IMAGE_PATH_OUTSIDE_OUTPUT');
        try { await readDirectRaster(image.file, selectedTask?.outputDirectory ?? outputDirectory); delete image.unavailable; }
        catch (error) { image.unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT' ? tr("directImageUi.190c0bfed3") : tr("directImageUi.4d549987b4"); throw error; }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(image.file));
      } else {
        if (accountBlocked) throw Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
        if (!loaded || storageNotice) throw Error('IMAGE_SESSION_SAVE_REQUIRED');
        if (!saveDraft(msg)) throw Error('IMAGE_DIRECT_SCOPE_INVALID');
        if (modelUnavailable) throw Error('IMAGE_EDIT_MODEL_UNAVAILABLE');
        const account = choices.accounts.find(x => x.id === draft.accountId && (selectedSavedId ? x.id === selectedSavedId : x.active));
        const model = choices.models.find(x => x.id === draft.modelId);
        if (!account || !model) throw Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
        if (!draft.prompt.trim()) throw Error('IMAGE_PROMPT_REQUIRED');
        if (!outputDirectory) throw Error('IMAGE_LOCAL_DIRECTORY_REQUIRED');
        if (origin) { if (origin.accountId !== account.id || !references.includes(origin.file)) throw Error('IMAGE_EDIT_SOURCE_CHANGED'); await verifyImageOrigin(origin); }
        const endpoint = direct.getEndpoint();
        if (choiceEndpoint !== undefined && endpoint !== choiceEndpoint) { refreshPending = true; throw Error('IMAGE_DIRECT_ENDPOINT_CHANGED'); }
        const operationId = randomUUID();
        releaseImage = enterImageOperation(operationId, { cancel });
        const request: DirectImageRequest = { prompt: draft.prompt, accountId: account.id, modelId: model.id,
          aspectRatio: draft.ratio, count: draft.count, size: draft.size as NonNullable<DirectImageRequest['size']>,
          quality: draft.quality as NonNullable<DirectImageRequest['quality']>, outputDirectory, references: [...references], endpoint, accountSource: selectedSavedId ? 'saved' : 'current',
          ...(origin?.sha256 ? { referenceHashes: { [origin.file]: origin.sha256 } } : {}) };
        const summary = request.prompt.trim().replace(/\s+/g, ' ');
        task = { prompt: request.prompt, references: [...references], endpoint, accountSource: selectedSavedId ? 'saved' : 'current', id: operationId, createdAt: new Date().toISOString(), promptSummary: summary.length > 140 ? summary.slice(0, 140) + '…' : summary,
          accountId: account.id, accountFingerprint: createHash('sha256').update(accountDisplayFingerprint(account)).digest('hex'), accountLabel: account.label === account.expectedEmail ? account.label : `${account.label} · ${account.expectedEmail}`, modelId: model.id, ratio: draft.ratio, size: draft.size, quality: draft.quality, count: draft.count,
          phase: 'confirming', status: tr("directImageUi.c7ef6c5df6"), outputDirectory, images: [], ...(origin ? { origin: { ...origin } } : {}) };
        tasks.push(task); emit();
        if (!await persistNow()) throw Error('IMAGE_SESSION_SAVE_REQUIRED');
        if (cancelRequested || panel !== owner) { task.phase = 'cancelled'; task.status = tr("directImageUi.5c3249c289"); return; }
        const generationConsent = tr("directImageUi.a83a7f718e");
        active = new AbortController();
        const consentSignal = active.signal;
        let stopConsent: () => void = () => undefined;
        const cancelledConsent = new Promise<undefined>(resolve => {
          stopConsent = () => resolve(undefined);
          consentSignal.addEventListener('abort', stopConsent, { once: true });
        });
        let answer: string | undefined;
        try { answer = await Promise.race([vscode.window.showWarningMessage(
          tr("directImageUi.53e217910b", { p0: displayAccount(account), p1: model.id, p2: request.count, p3: request.outputDirectory }),
          { modal: true }, generationConsent), cancelledConsent]); }
        finally { consentSignal.removeEventListener('abort', stopConsent); }
        if (answer !== generationConsent || cancelRequested || panel !== owner || (accountBlocked && !selectedSavedId)) { status = tr("directImageUi.5c3249c289"); task.phase = 'cancelled'; task.status = status; return; }
        attempt = { modelId: model.id, operationId, stage: 'preparing' };
        task.phase = 'preparing'; task.status = tr("directImageUi.29a2a153fb"); emit();
        if (!await persistNow()) throw Error('IMAGE_SESSION_SAVE_REQUIRED');
        if (cancelRequested || panel !== owner) { task.phase = 'cancelled'; task.status = tr("directImageUi.5c3249c289"); return; }
        const result = await direct.run(request, active.signal, value => {
          if (!taskOpen) return;
          if (attempt && (value.phase === 'generating' || value.phase === 'validating')) attempt.stage = value.phase;
          if (task) { if (value.phase === 'generating' || value.phase === 'validating') task.phase = value.phase; task.status = value.message; }
          status = value.message; emit();
        }, attempt.operationId);
        images.push(...result.images);
        task.images.push(...result.images);
        task.phase = result.batch.outcome === 'complete' ? 'complete' : result.images.length ? 'partial' : result.batch.outcome === 'cancelled' ? 'cancelled' : 'failed';
        status = result.batch.outcome === 'complete' ? tr("directImageUi.87bc993c01", { p0: result.images.length }) : tr("directImageUi.5129adff5e", { p0: result.images.length, p1: result.batch.error ? code(new Error(result.batch.error)) : result.batch.outcome });
        task.status = status;
        if (result.batch.outcome === 'complete') {
          if (!cancelRequested && !active.signal.aborted && result.images.length) completedQuotaSelection = JSON.stringify([request.accountSource === 'saved' ? request.accountId : '@current', request.accountId, request.modelId, request.endpoint]);
          try { await recent.clear(); } catch { status += tr("directImageUi.f43319f6a2"); }
        } else {
          const partial = Object.assign(new Error(result.batch.error ?? 'IMAGE_CANCELLED'),
            'failure' in result.batch ? result.batch.failure : {});
          try { await recent.save(captureRecentImageFailure(partial, model.id, attempt.stage, attempt.operationId)); }
          catch { status += tr("directImageUi.c6fb9c3d7d"); }
        }
      }
    } catch (error) {
      status = /^(IMAGE_EDIT_|IMAGE_PROJECT_|IMAGE_DRAFT_|IMAGE_RESULT_)/.test(error instanceof Error ? error.message : '') ? imageActionMessage(error) : code(error);
      if (['reuseTask', 'continueImage', 'restoreDraft', 'deleteDraft', 'compareImage', 'compareSelect', 'copyPath', 'copyMarkdown', 'insertMarkdown', 'copyToProject'].includes(String(msg.type))) actionNotice = imageActionMessage(error);
      if (task) { task.phase = cancelRequested || active?.signal.aborted || error instanceof Error && error.message === 'IMAGE_CANCELLED' ? 'cancelled' : 'failed'; task.status = status; }
      if (attempt) {
        try { await recent.save(captureRecentImageFailure(error, attempt.modelId, attempt.stage, attempt.operationId)); }
        catch { status += tr("directImageUi.c6fb9c3d7d"); }
      }
    }
    finally {
      taskOpen = false;
      releaseImage?.(); active = undefined;
      const warning = attempt ? direct.operationRecordWarning?.() : undefined;
      if (warning) status += `；${warning}`;
      await persistNow(); busy = false; emit(false);
      if (refreshPending && (!officialBlocked || selectedSavedId) && panel) await refresh();
      if (panel === owner && completedQuotaSelection) await querySelectedQuota(completedQuotaSelection);
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.images.open', async () => {
    if (panel) { panel.reveal(); return; }
    await initialize();
    const existing = panel as vscode.WebviewPanel | undefined;
    if (existing) { existing.reveal(); return; }
    const nonce = randomBytes(16).toString('base64');
    panel = vscode.window.createWebviewPanel('antigravityDirectImage', tr("directImageUi.d5e1e00bbd"), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    draftRevision = 0; draftEpoch = 0; actionRevision = 0;
    panel.webview.html = directImageHtml(nonce, panel.webview.cspSource, layout);
    const owner = panel;
    context.subscriptions.push(panel.webview.onDidReceiveMessage(value => handle(value, owner)), panel.onDidDispose(() => { if (panel === owner) { stopRetry(); recommendation.cancel(); quota.invalidate(); panel = undefined; void persistNow(); ++choicesRevision; choicesAbort?.abort(); choicesLoading = false; cancelRequested = true; active?.abort(); } }));
    if (!outputDirectory) {
      const first = vscode.workspace.workspaceFolders?.map(x => nativePath(x.uri)).find((x): x is string => !!x);
      if (first) { try { const checked = await checkedDirectory(first); if (panel === owner && !outputDirectory) { outputDirectory = checked; outputChanged?.(); } } catch { /* User may choose a folder. */ } }
    }
    await refresh();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.images.cancel', cancel));
  const flush = async () => { await persistNow(); await session.flush(); await layoutSave; };
  context.subscriptions.push({ dispose: () => { disposed = true; stopRetry(); recommendation.dispose(); quota.invalidate(); choicesAbort?.abort(); active?.abort(); void flush(); } });
  return { flush, getStatus: () => status, getOutputDirectory: () => outputDirectory,
    accountStateChanged(state: { pending: boolean; email: string; accountIds: string[] }) {
      if (disposed) return;
      const email = state.email.trim().toLowerCase();
      // The official callback lists active IDs, not every saved account. Use
      // current local summaries for deletion checks and include them in dedupe.
      const summaries = direct.listAccounts?.();
      const savedIds = summaries?.map(account => account.id) ?? state.accountIds;
      const snapshot = JSON.stringify([state.pending, email, [...state.accountIds].sort(), summaries?.map(account =>
        [account.id, account.expectedEmail, account.hostCurrent, account.hostId, account.capturedAt, account.migrationState]).sort() ?? [...savedIds].sort()]);
      if (snapshot === accountSnapshot) return;
      quota.invalidate();
      accountSnapshot = snapshot;
      const wasOfficialBlocked = officialBlocked;
      officialBlocked = state.pending || !email;
      officialEmail = officialBlocked ? undefined : email;
      if (selectedSavedId) {
        if (restoringSaved) {
          choices.accounts = summaries ?? choices.accounts;
          // Only an interrupted startup selection can resume automatically.
          // The stored account fingerprint still has to match the restored draft.
          if (!busy && panel && !choicesLoading && !checkSuspended) void refresh();
          emit(); return;
        }
        if (!savedIds.includes(selectedSavedId) || !direct.hasSavedAccountSelection(selectedSavedId)) {
          stopRetry(); ++choicesRevision; choicesAbort?.abort(); choicesLoading = false; active?.abort();
          choices = { accounts: summaries ?? choices.accounts.filter(x => savedIds.includes(x.id)), models: [] };
          accountBlocked = true; checkSuspended = true;
          accountStatus = code(new Error(savedIds.includes(selectedSavedId) ? 'IMAGE_SAVED_SELECTION_REQUIRED' : 'IMAGE_SAVED_ACCOUNT_REMOVED'));
        } else {
          choices.accounts = summaries ?? choices.accounts.map(x => ({ ...x, active: x.expectedEmail?.toLowerCase() === email }));
        }
        emit(); return;
      }
      const changed = !!email && !!verifiedEmail && email !== verifiedEmail;
      if (changed) currentIdentityChanged = true;
      if (changed || wasOfficialBlocked && !officialBlocked) checkSuspended = false;
      if (email && !state.pending) verifiedEmail = email;
      if (checkSuspended && !officialBlocked) { choices.accounts = summaries ?? choices.accounts; emit(); return; }
      const blocked = state.pending || !email;
      if (busy) { refreshPending = true; if (blocked) accountBlocked = true; return; }
      accountBlocked = blocked; ++choicesRevision; choicesAbort?.abort(); choicesLoading = false; refreshPending = true;
      choices = { accounts: direct.listAccounts?.() ?? [], models: [] }; draft = { ...draft, accountId: '' };
      // Identity availability and operation results are separate. A transient
      // unknown proof must not announce a switch or erase a saved-image result.
      accountStatus = state.pending ? tr("directImageUi.1924bf8451") : !email ? tr("directImageUi.65e617c2d2") : changed ? tr("directImageUi.1c5b4ac149") : '';
      emit(); if (!blocked && !busy && panel) void refresh();
    } };
}
