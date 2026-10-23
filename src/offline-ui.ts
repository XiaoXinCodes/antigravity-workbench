import type { OFFLINE_PREPARE_STAGES } from './last-account-failure';
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { AutomaticOfflineKey, AutomaticOfflineControl, launchAutomaticOfflineHelper } from './offline-automatic';
import { classifyOfflineSettlement, isNewOfflineHost } from './offline-settlement';
import { randomUUID } from 'node:crypto';
import { t as tr } from './i18n';
import { displayEmail } from './identity-presentation';
import { LiveError, assertSlotIdentity, equalSlots } from './live-storage';
import { EnvironmentTokenSlots, resolveOfficialStorageMode } from './live-environment';
import { LiveLocks, probeProcessIdentity } from './live-lock';
import { assertNativeHost, resolveCredentialHostId } from './native-host';
import { createWslReadGuard, wslFileRouteError } from './live-wsl-proof';
import { assertOfficialWriteContract } from './official-contract';
import { OfflineRecoveryStore } from './offline-recovery-store';
import { inspectOfflineLinuxProcesses } from './offline-process-census';
import { validateOfflineJournal, type OfflineJournal } from './offline-switch';
import { sameStorageIdentity, type HubProof, type LiveAccount } from './live-switch';
import type { OfficialApi } from './live-hub';

export interface OfflineUiDependencies {
  stage?(stage: typeof OFFLINE_PREPARE_STAGES[number]): void;
  owner: string;
  accounts(): { id: string; label: string }[];
  account(id: string): Promise<LiveAccount>;
  official(): vscode.Extension<OfficialApi>;
  proof(): Promise<HubProof>;
  changed(): void;
}
const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
export function registerOfflineUi(context: vscode.ExtensionContext, dependencies: OfflineUiDependencies): { prepareAutomatic(argument?: unknown): Promise<boolean>; getStatus(): string | undefined } {
  let busy = false;
  const pointerKey = 'automatic-offline.last.v1';
  let visibleCode: string | undefined;
  const statusText = (): string | undefined => {
    if (!visibleCode) return undefined;
    const keys = { WAITING_FOR_CLOSE: 'offline.visibleWaiting', PREPARED: 'offline.visibleWaiting', REJOINING: 'offline.visibleJoining', VERIFYING: 'offline.visibleVerifying', VERIFIED_TARGET: 'offline.visibleTarget', VERIFIED_ORIGINAL: 'offline.visibleOriginal', KEPT_CURRENT: 'offline.keptCurrent' } as const;
    return Object.hasOwn(keys, visibleCode) ? tr(keys[visibleCode as keyof typeof keys]) : tr('offline.visibleAttention', { code: visibleCode });
  };
  const showStatus = (code: string): void => { if (visibleCode !== code) { visibleCode = code; dependencies.changed(); } };
  const remember = async (host: string, id: string): Promise<void> => { await context.globalState.update(pointerKey, { host, id }); };
  const locks = new LiveLocks(path.join(os.homedir(), '.gemini'), dependencies.owner);
  const binding = async (): Promise<string> => {
    assertNativeHost(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
    if (process.platform !== 'linux' || !process.getuid || await resolveOfficialStorageMode() !== 'wsl-file') throw new LiveError('OFFLINE_PLATFORM_UNSUPPORTED');
    return resolveCredentialHostId(context, vscode.env.remoteName, 'wsl-file');
  };
  const password = (): Thenable<string | undefined> => vscode.window.showInputBox({ title: tr('offline.password'), password: true, ignoreFocusOut: true,
    validateInput: value => value.length < 12 || Buffer.byteLength(value) > 1024 || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? tr('offline.passwordLength') : undefined });
  const store = (secret: string, host: string, id: string): OfflineRecoveryStore => new OfflineRecoveryStore(path.join(os.homedir(), '.gemini', 'antigravity-workbench-offline', id), secret, host, id);
  const instructions = async (host: string, id: string): Promise<void> => {
    const command = [process.execPath, path.join(context.extensionPath, 'out', 'offline-cli.js'), id, host, String(context.extension.extensionKind), vscode.env.remoteName ?? 'local', 'install'].map(quote).join(' ');
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: `${tr('offline.instructions')}\n\n\`\`\`sh\n${command}\n\`\`\`\n\n${tr('offline.restoreInstructions')}\n` });
    await vscode.window.showTextDocument(document);
  };
  const automaticKey = async (host: string, id: string): Promise<string | undefined> => {
    const key = await new AutomaticOfflineKey(os.homedir(), host, id).read();
    if (!key) {
      try { await fs.lstat(path.join(os.homedir(), '.gemini', 'antigravity-workbench-offline', id, 'automatic-control')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      throw new LiveError('OFFLINE_AUTOMATIC_KEY_MISSING');
    }
    return key;
  };
  const recoverySecret = async (host: string): Promise<string | undefined> => {
    const marker = await locks.inspectRecovery();
    if (marker.owner?.schema !== 4 || marker.owner.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
    return await automaticKey(host, marker.owner.id) ?? await password();
  };
  const launch = async (host: string, id: string, action: 'install' | 'restore', attempt: string): Promise<void> => {
    await launchAutomaticOfflineHelper(path.join(context.extensionPath, 'out', 'offline-automatic-helper.js'), id, host, context.extension.extensionKind, vscode.env.remoteName ?? 'local', action, attempt);
    await remember(host, id); showStatus('WAITING_FOR_CLOSE');
    void vscode.window.showInformationMessage(tr('offline.autoReady'));
  };
  let joiningAttempt: { id: string; attempt: string | undefined } | undefined;
  const runs = new Map<string, (argument?: unknown) => Promise<void>>();
  const register = (name: string, run: (argument?: unknown) => Promise<void>): void => {
    runs.set(name, run);
    context.subscriptions.push(vscode.commands.registerCommand(`antigravityAccounts.live.${name}`, async (argument?: unknown) => {
      if (busy) { void vscode.window.showWarningMessage(tr('offline.busy')); return; }
      busy = true;
      try { if (name !== 'offlinePrepare' && argument !== undefined) throw new LiveError('OFFLINE_ARGUMENT_INVALID'); await run(argument); }
      catch (error) {
        const code = error instanceof LiveError ? error.code : 'OFFLINE_OPERATION_FAILED';
        void vscode.window.showErrorMessage(tr('offline.failed', { code }));
      } finally { busy = false; dependencies.changed(); }
    }));
  };
  const prepare = async (argument?: unknown, automatic = false): Promise<boolean> => {
    dependencies.stage?.('route');
    const host = await binding();
    dependencies.stage?.('args');
    const accounts = dependencies.accounts();
    if (argument !== undefined && (typeof argument !== 'string' || !accounts.some(a => a.id === argument))) throw new LiveError('OFFLINE_ARGUMENT_INVALID');
    const selected = argument === undefined ? await vscode.window.showQuickPick(accounts, { title: tr('offline.select') }) : accounts.find(a => a.id === argument);
    if (!selected) return false;
    dependencies.stage?.('confirm');
    const consent = tr('offline.prepare');
    if (await vscode.window.showWarningMessage(tr(automatic ? 'offline.autoWarning' : 'offline.warning'), { modal: true }, consent) !== consent) return false;
    let secret: string | undefined;
    if (!automatic) {
    secret = await password(); if (secret === undefined) return false;
    const repeated = await vscode.window.showInputBox({ title: tr('offline.repeatPassword'), password: true, ignoreFocusOut: true });
    if (repeated === undefined) return false;
    if (secret !== repeated) throw new LiveError('OFFLINE_PASSWORD_MISMATCH');
    }
    let id: string | undefined, attempt: string | undefined;
    dependencies.stage?.('lock');
    await locks.withOperation(async () => {
      if (await locks.hasRecovery()) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
      dependencies.stage?.('contract');
      const official = dependencies.official(); await assertOfficialWriteContract(official);
      dependencies.stage?.('scope');
      const guard = createWslReadGuard(os.homedir(), path.join(os.homedir(), '.gemini', 'bin', 'agy'), () => dependencies.official().exports);
      if (!await guard()) throw wslFileRouteError(guard.fileRouteFailureReason);
      const before = await dependencies.proof(), slots = new EnvironmentTokenSlots(os.homedir()), backup = await slots.read();
      if (!before.authValid || before.quotaSource !== 'server') throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
      assertSlotIdentity(backup, before.email);
      const target = await dependencies.account(selected.id);
      dependencies.stage?.('census');
      const self = await probeProcessIdentity(process.pid);
      if (self.state !== 'alive') throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
      const knownHosts = [{ pid: process.pid, startIdentity: self.startIdentity }];
      const census = await inspectOfflineLinuxProcesses({ uid: process.getuid!(), home: os.homedir(), knownHosts, scope: 'file-only' });
      if (!census.complete || census.unknown) throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
      dependencies.stage?.('scope');
      const after = await dependencies.proof();
      if (!after.authValid || after.quotaSource !== 'server' || after.email !== before.email || after.generation !== before.generation || !await guard() || !equalSlots(await slots.read(), backup)) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      const record: OfflineJournal = { schema: 1, hostId: host, id: randomUUID(), phase: 'prepared', backup, target: target.slots, expectedEmail: target.expectedEmail,
        execution: { owner: dependencies.owner, extensionKind: context.extension.extensionKind, ...(vscode.env.remoteName ? { remoteName: vscode.env.remoteName } : {}), knownHosts, initialHosts: census.hosts, participants: [...census.hosts, ...census.hubs] } };
      record.originalEmail = before.email;
      validateOfflineJournal(record, host);
      if (backup.keyringState !== 'unobserved' || target.slots.keyringState !== 'unobserved') throw new LiveError('OFFLINE_SCOPE_UNVERIFIED');
      dependencies.stage?.('prepare');
      if (automatic) { secret = await new AutomaticOfflineKey(os.homedir(), host, record.id).create(); attempt = await new AutomaticOfflineControl(os.homedir(), record.id).reset(); }
      await store(secret!, host, record.id).save(record, undefined);
      await locks.beginOfflineRecovery(record.id); id = record.id;
    });
    dependencies.stage?.('helper');
    if (automatic) await launch(host, id!, 'install', attempt!); else await instructions(host, id!);
    return true;
  };
  register('offlinePrepare', async argument => { await prepare(argument); });
  register('offlineContinue', async () => {
    const host = await binding(), marker = await locks.inspectRecovery();
    if (marker.owner?.schema !== 4 || marker.owner.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
    const key = await automaticKey(host, marker.owner.id);
    if (!key) { await instructions(host, marker.owner.id); return; }
    const state = await new AutomaticOfflineControl(os.homedir(), marker.owner.id).read();
    const choices = ['offlineComplete', 'offlineAutomaticRetry', 'offlineAutomaticRestore', 'offlineAutomaticCancel', 'offlineKeepCurrent'] as const;
    const labels = ['offline.finish', 'offline.autoRetry', 'offline.autoRestore', 'offline.autoCancel', 'offline.keepCurrent'] as const;
    const selected = await vscode.window.showQuickPick(choices.map((action, i) => ({ label: tr(labels[i]!), action })), { title: tr('offline.autoStatus', { code: state.status }) });
    if (selected) await runs.get(selected.action)!();
  });
  register('offlineKeepCurrent', async () => {
    const host = await binding(), secret = await recoverySecret(host); if (secret === undefined) return;
    const settled = await locks.withOperation(async () => {
      const marker = await locks.inspectRecovery();
      if (marker.owner?.schema !== 4 || marker.owner.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
      const id = marker.owner.id;
      await locks.assertOfflineRecovery(id);
      const journal = store(secret, host, id), record = await journal.read();
      if (!record || record.id !== id || record.hostId !== host || record.execution?.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_INVALID');
      const official = dependencies.official(); await assertOfficialWriteContract(official);
      const guard = createWslReadGuard(os.homedir(), path.join(os.homedir(), '.gemini', 'bin', 'agy'), () => dependencies.official().exports);
      if (!await guard()) throw wslFileRouteError(guard.fileRouteFailureReason);
      const slots = new EnvironmentTokenSlots(os.homedir()), before = await slots.read();
      if (before.keyringState !== 'unobserved') throw new LiveError('OFFLINE_SCOPE_UNVERIFIED');
      const proof = await dependencies.proof();
      if (!proof.authValid || proof.quotaSource !== 'server') throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
      assertSlotIdentity(before, proof.email);
      if (!equalSlots(before, await slots.read()) || !await guard()) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      const consent = tr('offline.keepCurrent');
      if (await vscode.window.showWarningMessage(tr('offline.keepWarning', { account: displayEmail(proof.email) }), { modal: true }, consent) !== consent) return false;
      const verify = async (): Promise<void> => {
        await locks.assertOfflineRecovery(id);
        const fresh = await dependencies.proof(), after = await slots.read();
        assertSlotIdentity(after, fresh.email);
        if (!fresh.authValid || fresh.quotaSource !== 'server' || fresh.email !== proof.email || fresh.generation !== proof.generation || !equalSlots(before, after) || !await guard()) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      };
      await verify();
      // Keep both encrypted original and target snapshots. No credential write
      // occurs here; the exact marker is cleared only after fresh identity proof.
      if (record.phase !== 'kept-current' || record.keptEmail !== proof.email) await journal.save({ ...record, phase: 'kept-current', keptEmail: proof.email }, record);
      await verify();
      if (await automaticKey(host, id)) { await new AutomaticOfflineControl(os.homedir(), id).status('KEPT_CURRENT'); await remember(host, id); await verify(); }
      await locks.clearOfflineRecovery(id);
      showStatus('KEPT_CURRENT');
      return true;
    });
    if (settled) void vscode.window.showInformationMessage(tr('offline.keptCurrent'));
  });
  register('offlineComplete', async () => {
    const host = await binding(), secret = await recoverySecret(host); if (secret === undefined) return;
    await locks.withOperation(async () => {
      const marker = await locks.inspectRecovery();
      if (marker.owner?.schema !== 4 || marker.owner.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
      await locks.assertOfflineRecovery(marker.owner.id);
      const journal = store(secret, host, marker.owner.id), record = await journal.read();
      const automatic = !!await automaticKey(host, marker.owner.id);
      if (joiningAttempt && (joiningAttempt.id !== marker.owner.id || (await new AutomaticOfflineControl(os.homedir(), marker.owner.id).read()).attempt !== joiningAttempt.attempt)) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
      if (!record || record.execution?.owner !== dependencies.owner || !['installed', 'verified', 'restored', 'restored-verified', ...(automatic ? ['prepared'] : [])].includes(record.phase)) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
      const official = dependencies.official(); await assertOfficialWriteContract(official);
      const guard = createWslReadGuard(os.homedir(), path.join(os.homedir(), '.gemini', 'bin', 'agy'), () => dependencies.official().exports);
      if (!await guard()) throw wslFileRouteError(guard.fileRouteFailureReason);
      const slots = new EnvironmentTokenSlots(os.homedir()), before = await slots.read();
      const restored = automatic ? classifyOfflineSettlement(record, before) === 'original' : ['restored', 'restored-verified'].includes(record.phase);
      const expectedEmail = restored ? record.originalEmail : record.expectedEmail, expected = restored ? record.backup : record.target;
      if (!expectedEmail) throw new LiveError('OFFLINE_RECOVERY_INVALID');
      if (!sameStorageIdentity(before, expected)) throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
      assertSlotIdentity(before, expectedEmail);
      const proof = await dependencies.proof();
      if (!proof.authValid || proof.quotaSource !== 'server' || proof.email.toLowerCase() !== expectedEmail.toLowerCase() || !sameStorageIdentity(await slots.read(), expected) || !await guard()) throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
      const verifiedPhase = restored ? 'restored-verified' : 'verified';
      if (record.phase !== verifiedPhase) await journal.save({ ...record, phase: verifiedPhase }, record);
      const fresh = await dependencies.proof();
      const after = await slots.read(); assertSlotIdentity(after, expectedEmail);
      if (!fresh.authValid || fresh.quotaSource !== 'server' || fresh.generation !== proof.generation || fresh.email !== proof.email || !sameStorageIdentity(after, expected) || !sameStorageIdentity(before, after) || !await guard()) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      if (automatic) {
        const code = restored ? 'VERIFIED_ORIGINAL' : 'VERIFIED_TARGET';
        await new AutomaticOfflineControl(os.homedir(), record.id).status(code); await remember(host, record.id);
        await locks.assertOfflineRecovery(record.id);
        if (!sameStorageIdentity(await slots.read(), expected) || !await guard()) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        await locks.clearOfflineRecovery(record.id); showStatus(code);
      } else await locks.clearOfflineRecovery(record.id);
    });
    void vscode.window.showInformationMessage(statusText() ?? tr('offline.complete'));
  });
  register('offlineAutomaticCancel', async () => {
    const host = await binding(), marker = await locks.inspectRecovery();
    if (marker.owner?.schema !== 4 || marker.owner.owner !== dependencies.owner || !await automaticKey(host, marker.owner.id)) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
    await new AutomaticOfflineControl(os.homedir(), marker.owner.id).cancel();
    void vscode.window.showInformationMessage(tr('offline.autoCancelled'));
  });
  const retry = async (restore: boolean): Promise<void> => {
    const host = await binding();
    const consent = tr('offline.prepare');
    if (await vscode.window.showWarningMessage(tr('offline.autoWarning'), { modal: true }, consent) !== consent) return;
    let id: string | undefined, attempt: string | undefined;
    dependencies.stage?.('lock');
    await locks.withOperation(async () => {
      const marker = await locks.inspectRecovery();
      if (marker.owner?.schema !== 4 || marker.owner.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
      id = marker.owner.id; await locks.assertOfflineRecovery(id);
      const key = await automaticKey(host, id); if (!key) throw new LiveError('OFFLINE_AUTOMATIC_KEY_MISSING');
      const journal = store(key, host, id), record = await journal.read();
      if (!record?.execution || record.execution.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_INVALID');
      await assertOfficialWriteContract(dependencies.official());
      {
        if (!restore && (record.phase !== 'prepared' || !equalSlots(await new EnvironmentTokenSlots(os.homedir()).read(), record.backup))) throw new LiveError('OFFLINE_STORAGE_CHANGED');
        const self = await probeProcessIdentity(process.pid); if (self.state !== 'alive') throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
        const knownHosts = [{ pid: process.pid, startIdentity: self.startIdentity }];
        const census = await inspectOfflineLinuxProcesses({ uid: process.getuid!(), home: os.homedir(), knownHosts, scope: 'file-only' });
        if (!census.complete || census.unknown) throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
        await journal.save({ ...record, execution: { ...record.execution, knownHosts, initialHosts: census.hosts, participants: [...census.hosts, ...census.hubs] } }, record);
      }
      attempt = await new AutomaticOfflineControl(os.homedir(), id).reset();
    });
    await launch(host, id!, restore ? 'restore' : 'install', attempt!);
  };
  register('offlineAutomaticRetry', () => retry(false));
  register('offlineAutomaticRestore', () => retry(true));
  // Reopening is an explicit join, not a guessed delay. A new host asks the
  // helper to stop waiting, then the shared operation lock joins any real write.
  const poll = async (): Promise<void> => {
    const marker = await locks.inspectRecovery();
    if (marker.owner?.schema !== 4 || marker.owner.owner !== dependencies.owner) {
      const pointer = context.globalState.get<{ host: string; id: string }>(pointerKey);
      if (marker.state === 'absent' && pointer) {
        const key = await automaticKey(pointer.host, pointer.id); if (!key) return;
        const record = await store(key, pointer.host, pointer.id).read();
        const result = await new AutomaticOfflineControl(os.homedir(), pointer.id).read();
        if (record?.execution?.owner === dependencies.owner && ['verified', 'restored-verified', 'kept-current'].includes(record.phase) && ['VERIFIED_TARGET', 'VERIFIED_ORIGINAL', 'KEPT_CURRENT'].includes(result.status)) showStatus(result.status);
      }
      return;
    }
    const host = await binding(), id = marker.owner.id, key = await automaticKey(host, id); if (!key) return;
    await remember(host, id);
    const control = new AutomaticOfflineControl(os.homedir(), id), state = await control.read();
    const record = await store(key, host, id).read(); if (!record?.execution || record.execution.owner !== dependencies.owner) throw new LiveError('OFFLINE_RECOVERY_INVALID');
    const self = await probeProcessIdentity(process.pid); if (self.state !== 'alive') throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
    let reopened = isNewOfflineHost(record, { pid: process.pid, startIdentity: self.startIdentity });
    if (reopened === undefined) {
      // Legacy automatic record: only an observed initiating-host death can
      // justify cancelling its wait. Existing peers are never guessed new.
      const previous = await Promise.all(record.execution.knownHosts.map(p => probeProcessIdentity(p.pid).then(actual => actual.state === 'dead' || actual.state === 'alive' && actual.startIdentity !== p.startIdentity)));
      reopened = previous.every(Boolean);
    }
    if (reopened || state.cancelled) { await control.cancel({ attempt: state.attempt }); showStatus('REJOINING'); }
    else if (record.phase === 'prepared' && ['PREPARED', 'WAITING_FOR_CLOSE'].includes(state.status)) { showStatus('WAITING_FOR_CLOSE'); return; }
    else showStatus('VERIFYING');
    // offlineComplete re-reads marker/owner/journal under the operation lock,
    // classifies exact credential identity, and performs two fresh RPC proofs.
    joiningAttempt = { id, attempt: state.attempt };
    try { await runs.get('offlineComplete')!(); dependencies.changed(); } finally { joiningAttempt = undefined; }
  };
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void poll().catch(error => {
      const code = error instanceof LiveError ? error.code : 'OFFLINE_OPERATION_FAILED';
      showStatus(['LIVE_OPERATION_OR_RECOVERY_LOCKED', 'LOCK_RECORD_REQUIRES_MANUAL_CHECK'].includes(code) ? 'REJOINING' : code);
    }).finally(() => { busy = false; });
  }, 2000);
  timer.unref(); context.subscriptions.push({ dispose: () => clearInterval(timer) });
  return { getStatus: statusText, prepareAutomatic: async argument => {
    if (busy) throw new LiveError('OFFLINE_OPERATION_BUSY');
    busy = true;
    try { return await prepare(argument, true); } finally { busy = false; dependencies.changed(); }
  } };
}
