import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { LiveLocks } from './live-lock';
import { SavedImageAccounts } from './saved-image-account';
import { savedAccountStore } from './saved-account-store';
import { nativeHostStatus } from './native-host';
import { readSavedImageModels } from './saved-image-models';
import { resolveEndpointImageProject } from './direct-image-project-transport';
import { accountDisplayFingerprint } from './quota-presentation';
import type { LiveUiController } from './live-ui';
import type { ImageEndpoint } from './direct-image-protocol';
import type { ImageModelChoice } from './direct-image-binding';
import type { WakeExecution } from './wake-engine';
import { sendWake } from './wake-transport';
import { generation, hasOfficialHubApi, hubRpc } from './live-hub';
import { matchesOfficialExtension, pinOfficialExtension } from './official-extension-identity';
/** Callable IDs come from this account's models map, never quota bucket labels.
 * Explicit image-only IDs are excluded; unfamiliar text IDs remain visible. */
export function wakeModelsFromCatalog(value: unknown): ImageModelChoice[] {
  const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  const catalog = object(value), records = object(catalog?.models), imageIds = catalog?.imageGenerationModelIds;
  if (!records || Object.keys(records).length > 500 || imageIds !== undefined && !Array.isArray(imageIds)) throw Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
  return Object.entries(records).flatMap(([id, record]) => {
    const row = object(record);
    if (!row || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(id) || Array.isArray(imageIds) && imageIds.includes(id) || row.disabled !== undefined && row.disabled !== false) return [];
    const name = typeof row.displayName === 'string' && row.displayName.length <= 200 ? row.displayName : id;
    return [{ id, label: name === id ? id : `${name} (${id})` }];
  });
}
export interface WakeAccounts extends WakeExecution { models(accountId: string, endpoint: ImageEndpoint, signal: AbortSignal): Promise<ImageModelChoice[]> }
export function createWakeAccounts(context: vscode.ExtensionContext, live: LiveUiController): WakeAccounts {
  const locks = new LiveLocks(path.join(os.homedir(), '.gemini'), createHash('sha256').update(context.globalStorageUri.toString()).digest('hex'), { purpose: 'image' });
  const available = () => live.getState().accountStorageReady && !live.getState().pending && nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName).available;
  const accounts = () => live.getAccounts().map(a => ({ ...a, active: a.active === true, hostCurrent: a.hostCurrent === true }));
  let currentEmail: string | undefined;
  const saved = new SavedImageAccounts({ accounts, withOperation: work => locks.withOperation(async () => {
    // Read an already-running official Hub inside the credential lock. Never
    // activate it, start a backend, or trust a stale active flag for grant rotation.
    currentEmail = undefined;
    try {
      const ext = vscode.extensions.getExtension('google.google-antigravity');
      if (ext?.isActive && hasOfficialHubApi(ext.exports)) {
        const descriptor = pinOfficialExtension(ext), api = { port: ext.exports.port, csrfToken: ext.exports.csrfToken }, pinned = generation(api), abort = new AbortController();
        const auth = await hubRpc(api, 'GetAuthStatus', abort.signal) as { authResult?: { hasValidAuth?: unknown } };
        const identity = await hubRpc(api, 'GetUserStatus', abort.signal) as { userStatus?: { email?: unknown } };
        const next = vscode.extensions.getExtension('google.google-antigravity'), email = identity?.userStatus?.email;
        if (auth?.authResult?.hasValidAuth === true && typeof email === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(email) && next?.isActive && matchesOfficialExtension(descriptor, next) && hasOfficialHubApi(next.exports) && generation(next.exports) === pinned) currentEmail = email.toLowerCase();
      }
    } catch { /* Without fresh current identity, all saved grant refreshes stay disabled. */ }
    return work();
  }), store: () => savedAccountStore(context, locks, available), project: resolveEndpointImageProject,
    models: readSavedImageModels, parseModels: wakeModelsFromCatalog, refreshAllowed: a => !a.active && !!currentEmail && currentEmail !== a.expectedEmail.toLowerCase() });
  const fingerprint = (id: string) => { const a = live.getAccounts().find(a => a.id === id); return a && a.hostCurrent === true && a.migrationState !== 'pending' ? accountDisplayFingerprint(a) : undefined; };
  return {
    fingerprint,
    async models(id, endpoint, signal) { if (!available()) throw Error('WAKE_ACCOUNT_UNAVAILABLE'); saved.selectForWindow(id); return saved.choices(id, signal, endpoint, true); },
    async run(task, signal, beforeSend) {
      if (!available() || fingerprint(task.accountId) !== task.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED');
      saved.selectForWindow(task.accountId);
      // Requery this account before every actual send; a stale catalog is not a membership proof.
      await saved.choices(task.accountId, signal, task.endpoint, true);
      const binding = await saved.bind(task.accountId, task.modelId, signal, task.endpoint);
      return locks.withOperation(async () => {
        if (!available() || fingerprint(task.accountId) !== task.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED');
        return sendWake({ ...binding, endpoint: task.endpoint }, task.outputBudget, signal, async () => {
          await binding.verify(signal); if (!available() || fingerprint(task.accountId) !== task.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED'); await beforeSend();
        });
      });
    },
  };
}
