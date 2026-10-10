import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnvironmentTokenSlots } from './live-environment';
import { resolveCredentialHostId } from './native-host';
import { LiveSwitchService, ACCOUNT_PREFIX, QUOTA_PENDING_PREFIX, QUOTA_REFRESH_PREFIX } from './live-switch';
import type { TokenSlots } from './live-storage';
import type { LiveLocks } from './live-lock';
import { createConsumerRefreshProvider } from './account-quota-client';
import { imageAccountRevision, type SavedImageStore } from './saved-image-account';
/** Existing saved-account rotation adapter. Official storage remains forbidden. */
export async function savedAccountStore(context: vscode.ExtensionContext, locks: Pick<LiveLocks, 'hasRecovery'>, available: () => boolean): Promise<SavedImageStore> {
      if (!available()) throw new Error('IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED');
      if (context.globalState.get('live-switch.pending.v1', false) || await locks.hasRecovery()) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
      const mode = await new EnvironmentTokenSlots(os.homedir()).mode();
      const hostId = await resolveCredentialHostId(context, vscode.env.remoteName, mode);
      const service = new LiveSwitchService(context.secrets, {
        read: async () => { throw new Error('IMAGE_SAVED_OFFICIAL_STORAGE_FORBIDDEN'); },
        write: async () => { throw new Error('IMAGE_SAVED_OFFICIAL_STORAGE_FORBIDDEN'); },
      }, hostId);
      return {
        load: async id => {
          const account = await service.account(id);
          const raw = await context.secrets.get(ACCOUNT_PREFIX + id);
          if (!raw || JSON.stringify(JSON.parse(raw)) !== JSON.stringify(account)) throw new Error('IMAGE_SAVED_ACCOUNT_CHANGED');
          return { account, revision: imageAccountRevision(raw) };
        },
        verify: async (id, revision, allowPending) => {
          const raw = await context.secrets.get(ACCOUNT_PREFIX + id);
          if (!raw || imageAccountRevision(raw) !== revision) throw new Error('IMAGE_SAVED_ACCOUNT_CHANGED');
          if (!allowPending && (await context.secrets.get(QUOTA_PENDING_PREFIX + id) || await context.secrets.get(QUOTA_REFRESH_PREFIX + id))) throw new Error('IMAGE_SAVED_AUTH_PENDING');
        },
        refresh: (id, assertPresent) => {
          let pending: TokenSlots | undefined;
          return {
            provider: createConsumerRefreshProvider(path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy')),
            loadPending: async expected => { assertPresent(); pending = await service.pendingQuotaRefresh(id, expected); return pending; },
            stage: async (expected, next) => { assertPresent(); await service.stageQuotaRefresh(id, expected, next, pending); pending = next; },
            commit: async (expected, next) => { assertPresent(); await service.commitQuotaRefresh(id, expected, next); pending = undefined; },
          };
        },
      };
}
