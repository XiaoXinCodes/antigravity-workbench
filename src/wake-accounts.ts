import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { LiveLocks } from './live-lock';
import { SavedImageAccounts } from './saved-image-account';
import { savedAccountStore } from './saved-account-store';
import { nativeHostStatus } from './native-host';
import { readAccountModelCatalog } from './account-model-catalog';
import { wakeCatalogPayload, wakeModelsFromCatalog, type WakeModelChoice } from './wake-model-catalog';
export { wakeModelsFromCatalog } from './wake-model-catalog';
import { resolveEndpointImageProject } from './direct-image-project-transport';
import { accountDisplayFingerprint } from './quota-presentation';
import type { LiveUiController } from './live-ui';
import type { CloudCodeEndpoint } from './cloudcode-service';
import type { WakeExecution } from './wake-engine';
import { sendWake } from './wake-transport';
import { passiveCurrentEmail } from './passive-current-identity';
export interface WakeAccounts extends WakeExecution { models(accountId: string, endpoint: CloudCodeEndpoint, signal: AbortSignal): Promise<WakeModelChoice[]> }
// Reuse verified credential transactions and locks, with a distinct ordinary
// model parser and per-instance cache. Never use the image generation routine.
export function createWakeAccounts(context: vscode.ExtensionContext, live: LiveUiController): WakeAccounts {
  const locks = new LiveLocks(path.join(os.homedir(), '.gemini'), createHash('sha256').update(context.globalStorageUri.toString()).digest('hex'), { purpose: 'image' });
  const available = () => live.getState().accountStorageReady && !live.getState().pending && nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName).available;
  const accounts = () => live.getAccounts().map(a => ({ ...a, active: a.active === true, hostCurrent: a.hostCurrent === true }));
  let currentEmail: string | undefined;
  const saved = new SavedImageAccounts({ accounts, withOperation: work => locks.withOperation(async () => {
    // Read an already-running official Hub inside the credential lock. Never
    // activate it, start a backend, or trust a stale active flag for grant rotation.
    currentEmail = await passiveCurrentEmail();
    return work();
  }), store: () => savedAccountStore(context, locks, available), project: resolveEndpointImageProject,
    models: readAccountModelCatalog, normalizeCatalog: wakeCatalogPayload, parseModels: wakeModelsFromCatalog, refreshAllowed: a => !a.active && !!currentEmail && currentEmail !== a.expectedEmail.toLowerCase() });
  const fingerprint = (id: string) => { const a = live.getAccounts().find(a => a.id === id); return a && a.hostCurrent === true && a.migrationState !== 'pending' ? accountDisplayFingerprint(a) : undefined; };
  return {
    fingerprint,
    async models(id, endpoint, signal) {
      if (!available()) throw Error('WAKE_ACCOUNT_UNAVAILABLE'); saved.selectForWindow(id);
      try { return await saved.choices(id, signal, endpoint, true); }
      catch (error) { if (error instanceof Error && error.message === 'IMAGE_SAVED_MODELS_UNAVAILABLE') throw Error('WAKE_MODELS_UNAVAILABLE'); throw error; }
    },
    async quota(task, signal) {
      if (!available() || fingerprint(task.accountId) !== task.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED');
      return saved.observeQuota(task.accountId, task.modelId, signal, task.endpoint, async () => {
        if (!available() || fingerprint(task.accountId) !== task.fingerprint || signal.aborted) throw Error('WAKE_ACCOUNT_CHANGED');
      });
    },
    async run(task, signal, beforeSend) {
      if (!available() || fingerprint(task.accountId) !== task.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED');
      saved.selectForWindow(task.accountId);
      // Requery this account before every actual send; a stale catalog is not a membership proof.
      await saved.choices(task.accountId, signal, task.endpoint, true);
      const binding = await saved.bind(task.accountId, task.modelId, signal, task.endpoint, task.schedule.mode === 'quota-recovery');
      return locks.withOperation(async () => {
        if (!available() || fingerprint(task.accountId) !== task.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED');
        return sendWake({ ...binding, endpoint: task.endpoint }, task.outputBudget, signal, async () => {
          await binding.verify(signal); if (!available() || fingerprint(task.accountId) !== task.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED'); await beforeSend();
        });
      });
    },
  };
}
