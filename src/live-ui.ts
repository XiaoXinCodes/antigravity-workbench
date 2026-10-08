import { localizeMessage, t as tr } from './i18n';
import { verifiedCurrentAccountId } from './current-account';
import { beginDebugOperation, debugErrorCode, debugErrorData, debugFailureOutcome, type DebugOperation, type DebugSpan } from './debug-events';
import { LAST_ACCOUNT_FAILURE, readLastAccountFailure, type LastAccountFailure, type AccountFailureStage } from './last-account-failure';
/* eslint-disable no-control-regex -- Deliberately reject terminal/control characters in identity and quota fields. */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { realpathSync, constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { LiveLocks } from './live-lock';
import { querySavedAccountQuota, type SavedAccountQuotaOptions } from './account-quota';
import { createConsumerRefreshProvider } from './account-quota-client';
import { acceptanceEvents, acceptanceReport, type AcceptanceAction } from './acceptance-report';
import { createRequire } from 'node:module';
import { LiveError, tokenAccountHint, runPrivate, equalSlots, type TokenSlots } from './live-storage';
import { createWslFileGuard, type WslFileGuard } from './live-wsl-proof';
import { EnvironmentTokenSlots, resolveOfficialStorageMode, assertWslBackendExecutable } from './live-environment';
import { LiveSwitchService, type HubProof, type Lifecycle, type SavedLogin, type LiveAccount } from './live-switch';
import { generation, hasOfficialHubApi, queryHub, queryFreshQuota, queryFreshIdentity, querySignedOutHub, loginWithOfficialHub, type OfficialApi } from './live-hub';
import { normalizeLabel } from './core';
import { encryptAccountArchive, decryptAccountArchive, readMigrationArchive, writeMigrationArchive } from './account-migration';
import { assertOfficialEntrypoint, diagnosticBackendVersion, officialEntryPath } from './official-contract';
import { assertNativeHost, resolveCredentialHostId, hostLabel, sameNativeHost, nativeHostStatus, type NativeHostStatus } from './native-host';
import { matchesOfficialExtension, pinOfficialExtension } from './official-extension-identity';
import { canRestartOfficialComponent, restartOfficialComponent } from './official-restart';
import { enterAccountChange } from './image-activity';
import { RecoveryVerification, type VerificationClock, type VerificationLease } from './recovery-verification';
import { inspectWslProcesses, assertWslProcessExclusivity, sameOfficialProcess, waitForOfficialBackendStop, type OfficialProcessIdentity } from './official-process';

const INDEX = 'live-switch.accounts.v1', PENDING = 'live-switch.pending.v1';
const OFFICIAL_ID = 'google.google-antigravity';
const localRequire = createRequire(__filename);
export function loadedDeactivator(filename: string, cache: NodeJS.Dict<NodeModule> = localRequire.cache): (() => Promise<void>) | null {
  // Never load/re-evaluate another extension. Only use the module already loaded by this host.
  const canonical = (value: string): string => {
    let resolved: string;
    try { resolved = realpathSync.native(value); } catch { resolved = path.resolve(value); }
    // VS Code URIs normalize a Windows drive letter to lower case; Node's cache may not.
    return path.normalize(resolved).replace(/^[A-Z]:/, drive => drive.toLowerCase());
  };
  const target = canonical(filename);
  const candidates = Object.entries(cache).filter(([key, module]) => module?.loaded && canonical(key) === target);
  if (candidates.length !== 1) return null;
  const module = candidates[0]![1]!;
  if (typeof module.exports?.deactivate !== 'function') return null;
  return () => Promise.resolve(module.exports.deactivate());
}
async function processCount(): Promise<number> {
  if (process.platform === 'win32') {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
    const r = await runPrivate(executable, ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq agy.exe'], '', 256 * 1024);
    if (r.code !== 0) throw new LiveError('PROCESS_CHECK_FAILED');
    return r.stdout.split(/\r?\n/).filter(line => /^"agy\.exe",/i.test(line)).length;
  }
  const r = await runPrivate('/bin/ps', ['-A', '-o', 'comm='], '', 256 * 1024);
  if (r.code !== 0) throw new LiveError('PROCESS_CHECK_FAILED');
  return r.stdout.split('\n').filter(line => /(?:^|\/)agy$/.test(line.trim())).length;
}
export interface OfficialReadOnlyHub { generation: string; proof(signal?: AbortSignal): Promise<HubProof>; quota(expectedEmail?: string, signal?: AbortSignal): Promise<HubProof>; freshProof?(signal?: AbortSignal): Promise<HubProof> }
interface LoginLifecycle extends Lifecycle, OfficialReadOnlyHub { backendVersion?: string; fileOnlyGuard?: WslFileGuard; login(signal: AbortSignal): Promise<void> }
function officialExtensionForHost(context: vscode.ExtensionContext): vscode.Extension<OfficialApi> {
  assertNativeHost(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
  const overridden = ['ANTIGRAVITY_SERVER_URL', 'AGY_RELEASE_BASE_URL', 'JETSKI_OAUTH_TOKEN', 'JETSKI_TEST_GAIA_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ADC_AUTH', 'CLOUD_WORKSTATIONS', 'CLOUD_SHELL', 'ANTIGRAVITY_CDE'].some(name => !!process.env[name]);
  const config = vscode.workspace.getConfiguration('antigravity');
  if (overridden || config.get('serverUrl') || config.get('releaseBaseUrl') || !['', 'production'].includes(config.get<string>('channel') || '') || (config.get<unknown[]>('serverArgs') || []).length || vscode.extensions.getExtension('google.cloud-developer-environments-auth')) throw new LiveError('OVERRIDE_OR_REMOTE_AUTH_UNSUPPORTED');
  const extension = vscode.extensions.getExtension<OfficialApi>(OFFICIAL_ID);
  if (!extension) throw new LiveError('OFFICIAL_EXTENSION_MISSING');
  if (!sameNativeHost(context, extension, vscode.env.remoteName)) throw new LiveError('OFFICIAL_HOST_MISMATCH');
  return extension;
}
/** Read-only RPC compatibility is established by the live capability and validated responses.
 * Never require credential-storage fingerprints, a version string or a stop hook here.
 * This resolver does not activate the extension, launch agy, or read saved credentials.
 */
export async function resolveOfficialReadOnlyHub(context: vscode.ExtensionContext): Promise<OfficialReadOnlyHub> {
  const extension = officialExtensionForHost(context);
  if (!extension.isActive) throw new LiveError('OPEN_OFFICIAL_ANTIGRAVITY_FIRST');
  const api = extension.exports;
  if (api?.port === undefined) throw new LiveError('OFFICIAL_HUB_NOT_READY');
  if (!hasOfficialHubApi(api)) throw new LiveError('OFFICIAL_HUB_API_UNAVAILABLE');
  const pinned = { port: api.port, csrfToken: api.csrfToken }, initialGeneration = generation(pinned);
  const assertCurrent = (): void => {
    if (!extension.isActive || !hasOfficialHubApi(extension.exports) || generation(extension.exports) !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_QUERY');
  };
  // Unrelated agy sessions cannot change this exact port/CSRF capability. Global
  // process-count exclusion belongs to credential mutation, never quota reads.
  assertCurrent();
  return {
    generation: initialGeneration,
    async proof() {
      assertCurrent();
      const proof = await queryHub(pinned);
      assertCurrent();
      if (proof.generation !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_QUERY');
      return proof;
    },
    async freshProof(signal) {
      assertCurrent();
      const proof = await queryFreshIdentity(pinned, signal);
      assertCurrent();
      if (proof.generation !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_QUERY');
      return proof;
    },
    async quota(expectedEmail, signal) {
      assertCurrent();
      const proof = await queryFreshQuota(pinned, expectedEmail, signal);
      assertCurrent();
      if (proof.generation !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_QUERY');
      return proof;
    },
  };
}
export async function resolveOfficialLifecycle(context: vscode.ExtensionContext, requireRunning = true, startForLogin = false): Promise<LoginLifecycle> {
  const extension = officialExtensionForHost(context);
  const main = officialEntryPath(extension);
  await assertOfficialEntrypoint(extension);
  if (!extension.isActive && startForLogin) await extension.activate();
  if (!extension.isActive) throw new LiveError('OPEN_OFFICIAL_ANTIGRAVITY_FIRST');
  const executable = path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  try {
    if (!(await fs.stat(executable)).isFile()) throw new LiveError('OFFICIAL_BACKEND_UNAVAILABLE');
    await fs.access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    if (await resolveOfficialStorageMode() === 'wsl-file') await assertWslBackendExecutable(executable);
  } catch (error) { if (error instanceof LiveError) throw error; throw new LiveError('OFFICIAL_BACKEND_UNAVAILABLE'); }
  let backendVersion: string | undefined;
  try {
    const version = await runPrivate(executable, ['--version'], '', 8192);
    if (version.code === 0) backendVersion = diagnosticBackendVersion(`${version.stdout} ${version.stderr}`);
  } catch { /* A diagnostic version probe cannot disable otherwise compatible operations. */ }
  const stop = loadedDeactivator(main);
  if (!stop) throw new LiveError('OFFICIAL_LIFECYCLE_NOT_LOADED');
  const api = extension.exports;
  const port = api?.port;
  if (requireRunning && port === undefined) throw new LiveError('OFFICIAL_HUB_NOT_READY');
  if ((requireRunning || port !== undefined) && !hasOfficialHubApi(api)) throw new LiveError('OFFICIAL_HUB_API_UNAVAILABLE');
  const initialGeneration = port ? generation(api) : 'stopped';
  let expectedGeneration = initialGeneration;
  const pinnedExtension = pinOfficialExtension(extension);
  const componentRestart = canRestartOfficialComponent(typeof vscode.commands.getCommands === 'function' ? await vscode.commands.getCommands(true) : []);
  const assertSameExtension = () => {
    if (!extension.isActive || !matchesOfficialExtension(pinnedExtension, officialExtensionForHost(context))) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
  };
  const currentGeneration = (): string => hasOfficialHubApi(extension.exports) ? generation(extension.exports) : 'stopped';
  const wsl = await resolveOfficialStorageMode() === 'wsl-file';
  const initialProcesses = wsl ? await inspectWslProcesses(executable, hasOfficialHubApi(api) ? api : undefined) : undefined;
  if (initialProcesses) assertWslProcessExclusivity(initialProcesses, port !== undefined);
  let pinnedProcess: OfficialProcessIdentity | undefined = initialProcesses?.current;
  const scopedCount = async (capability = extension.exports): Promise<number> => {
    if (!wsl) return processCount();
    const snapshot = await inspectWslProcesses(executable, hasOfficialHubApi(capability) ? capability : undefined);
    assertWslProcessExclusivity(snapshot, false);
    return snapshot.processes.length;
  };
  const count = initialProcesses ? initialProcesses.processes.length : await processCount();
  if (count !== (port ? 1 : 0)) throw new LiveError('CLOSE_OTHER_AGY_PROCESSES');
  if (currentGeneration() !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
  const fileGuard = wsl ? createWslFileGuard(os.homedir(), executable, () => extension.exports, scopedCount) : undefined;
  let fileScopeUsed = false;
  if (currentGeneration() !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
  return {
    ...(backendVersion ? { backendVersion } : {}),
    ...(fileGuard ? { fileOnlyGuard: async (allowStopped: boolean) => { const result = await fileGuard(allowStopped); fileScopeUsed ||= result; return result; } } : {}),
    get generation() { return expectedGeneration; },
    restartMode: componentRestart ? 'component' : 'unavailable',
    async stop() {
      // Cancellation/recovery can follow an already completed stop. Never stop a newer hub.
      if (!extension.exports?.port && await scopedCount() === 0 && !extension.exports?.port) return;
      if (currentGeneration() !== expectedGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      assertSameExtension();
      if (wsl) {
        const snapshot = await inspectWslProcesses(executable, extension.exports);
        assertWslProcessExclusivity(snapshot, true);
        if (pinnedProcess && !sameOfficialProcess(pinnedProcess, snapshot.current!)) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        pinnedProcess = snapshot.current;
      } else if (await processCount() !== 1) throw new LiveError('CLOSE_OTHER_AGY_PROCESSES');
      if (currentGeneration() !== expectedGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      const stoppedApi = { port: extension.exports.port, csrfToken: extension.exports.csrfToken };
      await stop();
      await waitForOfficialBackendStop({
        assertCurrent: () => {
          assertSameExtension();
          if (hasOfficialHubApi(extension.exports) && generation(extension.exports) !== expectedGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        },
        stopped: async () => {
          let remaining: number;
          if (wsl) {
            const snapshot = await inspectWslProcesses(executable, stoppedApi);
            assertWslProcessExclusivity(snapshot, false);
            if (snapshot.current && (!pinnedProcess || !sameOfficialProcess(pinnedProcess, snapshot.current))) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
            remaining = snapshot.processes.length;
          } else remaining = await processCount();
          return remaining === 0 && extension.exports?.port === undefined;
        },
      });
    },
    async reload() {
      if (!componentRestart) throw new LiveError('OFFICIAL_COMPONENT_RESTART_UNAVAILABLE');
      expectedGeneration = await restartOfficialComponent(expectedGeneration, {
        api: () => extension.exports, assertCurrent: assertSameExtension, processCount: scopedCount,
        execute: command => vscode.commands.executeCommand(command),
      });
      if (wsl) {
        const snapshot = await inspectWslProcesses(executable, extension.exports);
        assertSameExtension();
        if (currentGeneration() !== expectedGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        assertWslProcessExclusivity(snapshot, true);
        pinnedProcess = snapshot.current;
      }
    },
    async login(signal) {
      if (generation(extension.exports) !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      if (fileScopeUsed && !await fileGuard?.(false)) throw new LiveError('WSL_FILE_ROUTE_UNVERIFIED');
      if (currentGeneration() !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      await loginWithOfficialHub(extension.exports, signal);
      if (generation(extension.exports) !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
    },
    async proof(signal) {
      const before = generation(extension.exports), proof = await queryFreshIdentity(extension.exports, signal);
      if (generation(extension.exports) !== before || proof.generation !== before) throw new LiveError('HUB_CHANGED_DURING_QUERY');
      return proof;
    },
    async signedOutProof(signal) {
      const before = generation(extension.exports), proof = await querySignedOutHub(extension.exports, signal);
      if (generation(extension.exports) !== before || proof.generation !== before) throw new LiveError('HUB_CHANGED_DURING_QUERY');
      return proof;
    },
    async quota(expectedEmail, signal) {
      const before = generation(extension.exports), proof = await queryFreshQuota(extension.exports, expectedEmail, signal);
      if (generation(extension.exports) !== before || proof.generation !== before) throw new LiveError('HUB_CHANGED_DURING_QUERY');
      return proof;
    },
  };
}
export function liveErrorMessage(code: string, environment?: NativeHostStatus): string {
  if (environment && !environment.available && environment.code === code) return environment.message;
  const messages: Record<string, string> = {
    RECOVERY_VERIFICATION_TIMEOUT: tr("liveUi.3ae0ac698e"),
    RECOVERY_VERIFICATION_STALE: tr("liveUi.903f7dde0d"),
    ACCOUNT_SWITCH_IMAGE_RUNNING: tr("liveUi.4606818832"),
    OFFICIAL_COMPONENT_RESTART_UNAVAILABLE: tr("liveUi.c7a406f264"),
    OFFICIAL_COMPONENT_RESTART_TIMEOUT: tr("liveUi.7ddf57d64d"),
    OFFICIAL_COMPONENT_RECONNECT_FAILED: tr("liveUi.a1281b7bcc"),
    OFFICIAL_COMPONENT_FOCUS_FAILED: tr("liveUi.b4212cfb8f"),
    RECOVERY_SAVE_NOT_VERIFIED: tr("liveUi.cd7a8bfd92"),
    SWITCH_FAILED_ORIGINAL_RESTORED: tr("liveUi.ca428909d1"),
    ACCOUNT_QUOTA_ACCOUNT_CHANGED: tr("liveUi.41234a01e2"),
    ACCOUNT_QUOTA_REAUTH_REQUIRED: tr("liveUi.10a94e887b"),
    ACCOUNT_QUOTA_FORBIDDEN: tr("liveUi.ac56c1cd95"),
    ACCOUNT_QUOTA_RATE_LIMITED: tr("liveUi.6e87c4c045"),
    ACCOUNT_QUOTA_IDENTITY_MISMATCH: tr("liveUi.e294a9a22d"),
    ACCOUNT_QUOTA_IDENTITY_INVALID: tr("liveUi.2bf6e7bd6d"),
    ACCOUNT_QUOTA_TOKEN_UNSUPPORTED: tr("liveUi.610743f1c8"),
    ACCOUNT_QUOTA_TOKEN_CONFLICT: tr("liveUi.c0d949eb1a"),
    ACCOUNT_QUOTA_TIMEOUT: tr("liveUi.9d65ac84e8"),
    ACCOUNT_QUOTA_REQUEST_FAILED: tr("liveUi.8ab2159f15"),
    ACCOUNT_QUOTA_RESPONSE_INVALID: tr("liveUi.4cdaec4eb0"),
    ACCOUNT_QUOTA_EMPTY: tr("liveUi.0f57115f04"),
    ACCOUNT_QUOTA_REDIRECT_BLOCKED: tr("liveUi.fabdbca02c"),
    ACCOUNT_QUOTA_RESPONSE_TOO_LARGE: tr("liveUi.16292fecba"),
    SECURE_REMOVE_NOT_VERIFIED: tr("liveUi.290b7f09ef"),
    ACCOUNT_QUOTA_REFRESH_PENDING: tr("liveUi.7c3eb9f77b"),
    ACCOUNT_QUOTA_SECURE_SAVE_FAILED: tr("liveUi.34b351d9a3"),
    ACCOUNT_QUOTA_REFRESH_CONFLICT: tr("liveUi.03a88ccc06"),
    ACCOUNT_QUOTA_REFRESH_RECOVERY_INVALID: tr("liveUi.491cdfcecc"),
    ACCOUNT_QUOTA_REFRESH_SAVE_FAILED: tr("liveUi.71a4d2af2b"),
    ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN: tr("liveUi.694f88172e"),
    ACCOUNT_QUOTA_CLIENT_UNVERIFIED: tr("liveUi.43c7a4ea64"),
    ORIGINAL_SESSION_UNVERIFIED: tr("liveUi.fbbd40e244"),
    VERIFICATION_STORAGE_MISMATCH: tr("liveUi.62e11f80a2"),
    VERIFICATION_RETRY_REQUIRED: tr("liveUi.f928443610"),
    RECOVERY_IDENTITY_UNAVAILABLE: tr("liveUi.a0a5de3932"),
    HUB_SIGNED_OUT_NOT_VERIFIED: tr("liveUi.864bba4263"),
    HUB_FRESH_IDENTITY_REQUIRED: tr("liveUi.8b63deb627"),
    RECOVERY_STORAGE_NOT_VERIFIED: tr("liveUi.27e62ffdde"),
    OFFICIAL_EXTENSION_MISSING: tr("liveUi.9cfb3b2502"),
    OFFICIAL_HOST_MISMATCH: tr("liveUi.ac619a8ec0"),
    OFFICIAL_BACKEND_UNAVAILABLE: tr("liveUi.ed5e70a71e"),
    OFFICIAL_WSL_EXECUTABLE_INVALID: tr("liveUi.bd5c8a231d"),
    OFFICIAL_STORAGE_MODE_CHANGED: tr("liveUi.1de885cc6e"),
    OFFICIAL_STORAGE_MODE_MISMATCH: tr("liveUi.150346dbcf"),
    OFFICIAL_ENTRY_UNAVAILABLE: tr("liveUi.194846bd15"),
    OFFICIAL_LIFECYCLE_NOT_LOADED: tr("liveUi.97eb81eb23"),
    OPEN_OFFICIAL_ANTIGRAVITY_FIRST: tr("liveUi.5d02b3a4cc"),
    OFFICIAL_HUB_NOT_READY: tr("liveUi.a832201dec"),
    OFFICIAL_HUB_API_UNAVAILABLE: tr("liveUi.7570ca6121"),
    OVERRIDE_OR_REMOTE_AUTH_UNSUPPORTED: tr("liveUi.63bdd7b18a"),
    CLOSE_OTHER_AGY_PROCESSES: tr("liveUi.3d351cd7df"),
    OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN: tr("officialProcess.unownedHub"),
    OFFICIAL_PROCESS_OWNERSHIP_UNVERIFIED: tr("officialProcess.unverifiedOwner"),
    OFFICIAL_HUB_PROCESS_UNVERIFIED: tr("officialProcess.missingCurrentHub"),
    OFFICIAL_BACKEND_STOP_TIMEOUT: tr("officialProcess.stopTimeout"),
    CLOSE_ALL_AGY_PROCESSES: tr("liveUi.a2212b3cf0"),
    PROCESS_CHECK_FAILED: tr("liveUi.48b983ce10"),
    OFFICIAL_BACKEND_NOT_STOPPED: tr("liveUi.117b4a7721"),
    SAVED_ACCOUNT_LIMIT: tr("liveUi.8cfc34264f"),
    ACCOUNT_ID_INVALID: tr("liveUi.2fb2db27b6"),
    NO_SWITCH_TO_VERIFY: tr("liveUi.b4c35032a1"),
    NO_RECOVERY_BACKUP: tr("liveUi.ddc9213016"),
    NO_SAVED_OFFICIAL_LOGIN: tr("liveUi.ad210a343b"),
    NO_LOGIN_TO_CAPTURE: tr("liveUi.e5d68a3984"),
    LOGIN_TOKEN_NOT_UPDATED: tr("liveUi.da89b6f034"),
    LOGIN_CANCELLED: tr("liveUi.fb604b9c16"),
    LOGIN_TIMEOUT: tr("liveUi.ada5c85fff"),
    LOGIN_NOT_AUTHENTICATED: tr("liveUi.4d8f87ea06"),
    HUB_AUTH_INVALID: tr("liveUi.b4cd405568"),
    TOKEN_FORMAT_UNSUPPORTED: tr("liveUi.60aa7b484e"),
    HUB_EMAIL_MISSING: tr("liveUi.ec3e4b3149"),
    HUB_QUOTA_ACCOUNT_MISMATCH: tr("liveUi.7948d814e1"),
    QUOTA_QUERY_CANCELLED: tr("liveUi.18b0d552f8"),
    HUB_QUOTA_EMPTY: tr("liveUi.621b45a226"),
    HUB_QUOTA_RESPONSE_INVALID: tr("liveUi.3cfea91e13"),
    HUB_RPC_FAILED: tr("liveUi.246308d209"),
    HUB_RPC_TIMEOUT: tr("liveUi.5b0314f211"),
    HUB_RESPONSE_INVALID: tr("liveUi.73dc6540c9"),
    HUB_RESPONSE_TOO_LARGE: tr("liveUi.0cef4a6492"),
    WSL_FILE_IDENTITY_UNVERIFIED: tr("liveUi.7069cf7262"),
    KEYRING_UNAVAILABLE: tr("liveUi.03675acbcf"),
    WSL_FILE_ROUTE_UNVERIFIED: tr("liveUi.eb9dc18bec"),
    OFFICIAL_STORAGE_SCOPE_MISMATCH: tr("liveUi.eff085d753"),
    HOST_IDENTITY_UNAVAILABLE: tr("liveUi.7ebefbc188"),
    RECOVERY_RESTORE_NOT_VERIFIED: tr("liveUi.0d38852106"),
    RECOVERY_RECORD_CONFLICT: tr("liveUi.f96716826c"),
    OFFICIAL_STORAGE_CAPTURE_ONLY: tr("liveUi.1698f17d5f"),
    CAPTURE_CREDENTIAL_CHANGED: tr("liveUi.ca42084bf4"),
    CAPTURE_ACCOUNT_AMBIGUOUS: tr("liveUi.d485929f5e"),
    CAPTURE_CREDENTIAL_RECOVERY_REQUIRED: tr("liveUi.81932567f8"),
    CAPTURE_RECORD_CONFLICT: tr("liveUi.80ca01d8de"),
    HOST_ACCOUNT_UNBOUND: tr("liveUi.8fffbb67e6"),
    HOST_ACCOUNT_MISMATCH: tr("liveUi.7bdd5e0c1b"),
    HOST_RECOVERY_UNBOUND: tr("liveUi.e00fc661db"),
    HOST_RECOVERY_MISMATCH: tr("liveUi.ee6d061ce4"),
    NATIVE_HELPER_TIMEOUT_OR_LIMIT: tr("liveUi.25585cf124"),
    NATIVE_HELPER_UNAVAILABLE: tr("liveUi.d8c9168f35"),
    ONLY_PERSONAL_OAUTH_SUPPORTED: tr("liveUi.4c5b211f18"),
    SECURE_LOGIN_MISSING: tr("liveUi.5944a072cd"),
    SECURE_LOGIN_INVALID: tr("liveUi.250c3ebb33"),
    MIGRATION_PASSWORD_INVALID: tr("liveUi.633c426c02"),
    MIGRATION_PASSWORD_MISMATCH: tr("liveUi.74a6504036"),
    MIGRATION_DECRYPT_FAILED: tr("liveUi.5ff74c7864"),
    MIGRATION_FILE_URI_INVALID: tr("liveUi.2ee1b2633c"),
    MIGRATION_ARGUMENTS_UNSUPPORTED: tr("liveUi.61761e3bc9"),
    MIGRATION_ARCHIVE_INVALID: tr("liveUi.ce1e952d6e"),
    MIGRATION_ACCOUNTS_INVALID: tr("liveUi.99f47a778a"),
    MIGRATION_ACCOUNT_INVALID: tr("liveUi.6fe9d957a5"),
    MIGRATION_PAYLOAD_INVALID: tr("liveUi.f079419d0f"),
    MIGRATION_TOKEN_INVALID: tr("liveUi.23d8e20d10"),
    MIGRATION_ENCRYPT_FAILED: tr("liveUi.1c095a3f14"),
    MIGRATION_FILE_EXISTS: tr("liveUi.dc7163f5f7"),
    MIGRATION_RECOVERY_REQUIRED: tr("liveUi.a92aaf108f"),
    MIGRATION_ACCOUNT_SELECTION_INVALID: tr("liveUi.6eac881168"),
    MIGRATION_TARGET_SIZE_LIMIT: tr("liveUi.d7730e63bf"),
    MIGRATION_RECOVERY_INVALID: tr("liveUi.90fd73fbf6"),
    MIGRATION_ROLLBACK_REQUIRED: tr("liveUi.1aed0f848c"),
    MIGRATION_INDEX_CHANGED: tr("liveUi.231981ec3f"),
    MIGRATION_IMPORT_FAILED: tr("liveUi.b48e1462eb"),
    MIGRATION_FILE_READ_FAILED: tr("liveUi.142875b26c"),
    MIGRATION_FILE_WRITE_FAILED: tr("liveUi.485852d80d"),
    MIGRATION_PATH_UNSAFE: tr("liveUi.0c311f5ec7"),
    MIGRATION_ARCHIVE_TOO_LARGE: tr("liveUi.9ddd2f7c0f"),
    MIGRATION_FILE_CHANGED: tr("liveUi.2277a87341"),
    MIGRATION_EXPORT_FILE_CHANGED: tr("liveUi.exportFileChanged"),
    MIGRATION_DUPLICATE_ACCOUNT: tr("liveUi.bd9b09b0b8"),
    MIGRATION_TOKEN_CONFLICT: tr("liveUi.9ef77d2bca"),
  };
  if (messages[code]) return messages[code]!;
  if (/^MIGRATION_/.test(code)) return tr("liveUi.a057120c2a");
  if (/LIVE_OPERATION_OR_RECOVERY_LOCKED|LOCK_PROCESS_STILL_ALIVE/.test(code)) return tr("liveUi.da7f3eb9c8");
  if (/RECOVERY_PENDING/.test(code)) return tr("liveUi.4fc2237fa9");
  if (/RECOVERY_REQUIRED|RECOVERY_.*FAILED|RECOVERY_RECORD_INVALID/.test(code)) return tr("liveUi.67d095880d");
  if (/RESTORED_RELOAD_REQUIRED/.test(code)) return tr("liveUi.9f4ad3c3d0");
  if (/LOCK_/.test(code)) return tr("liveUi.ddc180552d");
  if (/HUB_CHANGED|HUB_IDENTITY_NOT_VERIFIED|LOGIN_HUB_NOT_VERIFIED|CAPTURE_EMAIL_MISMATCH|STORED_TOKEN_EMAIL_MISMATCH|IDENTITY_AMBIGUOUS/.test(code)) return tr("liveUi.1b1806a920");
  if (/TOKEN_|KEYRING_|OFFICIAL_FILE_|OFFICIAL_PATH_|OFFICIAL_STORAGE_|EXTERNAL_CHANGE/.test(code)) return tr("liveUi.33657eb582");
  return tr("liveUi.843741a2bb");
}
/** Passive metadata/API inspection only: never activates, hashes entrypoints, starts a process or opens a credential store. */
export function officialAvailability(context: vscode.ExtensionContext): NativeHostStatus {
  try {
    const extension = vscode.extensions.getExtension<OfficialApi>(OFFICIAL_ID);
    if (!extension) return { available: false, code: 'OFFICIAL_EXTENSION_MISSING', message: liveErrorMessage('OFFICIAL_EXTENSION_MISSING') };
    if (!sameNativeHost(context, extension, vscode.env.remoteName)) return { available: false, code: 'OFFICIAL_HOST_MISMATCH', message: tr("liveUi.f26fb5d18c", { p0: hostLabel(context, vscode.env.remoteName) }) };
    officialEntryPath(extension);
    if (extension.isActive) {
      if (!loadedDeactivator(officialEntryPath(extension))) return { available: false, code: 'OFFICIAL_LIFECYCLE_NOT_LOADED', message: liveErrorMessage('OFFICIAL_LIFECYCLE_NOT_LOADED') };
      if (extension.exports?.port !== undefined && !hasOfficialHubApi(extension.exports)) return { available: false, code: 'OFFICIAL_HUB_API_UNAVAILABLE', message: liveErrorMessage('OFFICIAL_HUB_API_UNAVAILABLE') };
    }
    return { available: true, message: extension.isActive && hasOfficialHubApi(extension.exports) ? tr("liveUi.89c2c32335", { p0: hostLabel(context, vscode.env.remoteName) }) : tr("liveUi.db476d236f", { p0: hostLabel(context, vscode.env.remoteName) }) };
  } catch (error) {
    const code = error instanceof LiveError ? error.code : 'OFFICIAL_ENTRY_UNAVAILABLE';
    return { available: false, code, message: liveErrorMessage(code) };
  }
}
function accountArgument(argument: unknown, accounts: SavedLogin[]): SavedLogin | undefined {
  if (argument === undefined) return undefined;
  if (typeof argument !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(argument)) throw new LiveError('ACCOUNT_ID_INVALID');
  const account = accounts.find(item => item.id === argument);
  if (!account) throw new LiveError('ACCOUNT_ID_INVALID');
  return account;
}
function validIndex(value: unknown): SavedLogin[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is SavedLogin => !!a && typeof a === 'object' && /^[a-f0-9-]{36}$/.test(a.id) && typeof a.label === 'string' && typeof a.expectedEmail === 'string' && typeof a.capturedAt === 'string').slice(0, 50);
}
/** Native dialogs are the only migration path source. Never reinterpret another URI host.
 * VS Code's workspace-host RPC transforms its own remote dialog URIs to file://.
 * Desktop-side paths arrive as vscode-local in a remote host and must stay rejected.
 */
function migrationFilePath(uri: vscode.Uri): string {
  if (uri.scheme !== 'file' || uri.authority !== '' || uri.query || uri.fragment || typeof uri.fsPath !== 'string' || !path.isAbsolute(uri.fsPath) || uri.fsPath.includes('\0') || /^[/\\]{2}/.test(uri.fsPath)) throw new LiveError('MIGRATION_FILE_URI_INVALID');
  return uri.fsPath;
}
function migrationPasswordError(value: string): string | null {
  return Array.from(value).length >= 12 && Buffer.byteLength(value, 'utf8') <= 1024 ? null : tr("liveUi.7376751be7");
}
type LifecycleResolver = (requireRunning?: boolean, startForLogin?: boolean) => Promise<LoginLifecycle>;
export interface LiveUiDependencies { service?: LiveSwitchService; locks?: LiveLocks; lifecycle?: LifecycleResolver; processCount?: typeof processCount; changed?: () => void; savedQuota?: (account: LiveAccount, signal?: AbortSignal, options?: SavedAccountQuotaOptions) => Promise<HubProof>; currentQuota?: (expectedEmail: string, signal?: AbortSignal) => Promise<HubProof>; currentIdentity?: (signal?: AbortSignal) => Promise<HubProof | undefined>; verificationClock?: VerificationClock }
/** Quota stays in memory and is attached only to the returned identity on this host. */
export interface LiveQuotaSnapshot { email: string; observedAt: string; source: 'server' | 'hub-status'; buckets: HubProof['buckets'] }
export interface LiveQuotaState { phase: 'loading' | 'ready' | 'error' | 'mismatch'; snapshot?: LiveQuotaSnapshot; message?: string }
export type LiveAccountView = SavedLogin & { hostCurrent?: boolean; quota?: LiveQuotaState; active?: boolean; activeVerifiedAt?: string };
export type LiveRecoveryPhase = 'checking' | 'none' | 'authorizing' | 'prepared' | 'installed' | 'restored' | 'locked' | 'unavailable';
export interface LiveUiState { recoveryPhase: LiveRecoveryPhase; status: string; busy: boolean; pending: boolean; identityChecking?: boolean; identityVerifiedDuringRecovery?: boolean; currentLoginSave?: 'saved' | 'update'; error?: string; lastFailure?: LastAccountFailure; environment: NativeHostStatus; official: NativeHostStatus; storageMode?: string; accountStorageReady: boolean; currentQuota?: LiveQuotaState; activeEmail?: string; activeVerifiedAt?: string }
export interface LiveUiController { getStatus(): string; getAccounts(): LiveAccountView[]; getState(): LiveUiState; refresh(): Promise<void> }
export function registerLiveUi(context: vscode.ExtensionContext, dependencies: LiveUiDependencies = {}): LiveUiController {
  let fileOnlyGuard: WslFileGuard | undefined;
  const resolveLifecycle = async (running = true, login = false): Promise<LoginLifecycle> => {
    const backend = await (dependencies.lifecycle ? dependencies.lifecycle(running, login) : resolveOfficialLifecycle(context, running, login));
    fileOnlyGuard = backend.fileOnlyGuard;
    return backend;
  };
  let service = dependencies.service, captureService = dependencies.service;
  let storageMode: string | undefined, setupError: unknown;
  const slots = new EnvironmentTokenSlots(os.homedir());
  const mutationSlots = new EnvironmentTokenSlots(os.homedir(), process.platform, process.env, { fileOnlyGuard: allowStopped => fileOnlyGuard?.(allowStopped) ?? Promise.resolve(false) }, 'mutation');
  // Kernel/environment inspection only; no credential file or keyring is read on activation.
  const serviceReady = service ? Promise.resolve() : slots.mode().then(async mode => {
    storageMode = mode;
    const binding = await resolveCredentialHostId(context, vscode.env.remoteName, mode);
    captureService = new LiveSwitchService(context.secrets, slots, binding);
    service = new LiveSwitchService(context.secrets, mutationSlots, binding);
    dependencies.changed?.();
  }).catch(error => { setupError = error; dependencies.changed?.(); });
  const environmentStatus = (): NativeHostStatus => {
    const current = nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
    if (!current.available || !setupError) return current;
    const code = setupError instanceof LiveError ? setupError.code : 'HOST_IDENTITY_UNAVAILABLE';
    return { available: false, code, message: liveErrorMessage(code) };
  };
  const locks = dependencies.locks || new LiveLocks(path.join(os.homedir(), '.gemini'), createHash('sha256').update(context.globalStorageUri.toString()).digest('hex'));
  let reloadRequested = false;
  let requestedRestartBackend: Lifecycle | undefined;
  const deferred = (backend: Lifecycle): Lifecycle => {
    if (backend.restartMode === 'unavailable') throw new LiveError('OFFICIAL_COMPONENT_RESTART_UNAVAILABLE');
    return backend.restartMode === 'component' ? backend : { ...backend, reload: async () => { reloadRequested = true; requestedRestartBackend = backend; } };
  };
  let busy = false, status = context.globalState.get(PENDING, false) ? tr("liveUi.dd4ea9f875") : tr("liveUi.d47369e8f6");
  let recoveryPhase: LiveRecoveryPhase = 'checking';
  let pending = context.globalState.get(PENDING, false);
  let errorMessage: string | undefined;
  let debugSpan: DebugSpan | undefined;
  let lastFailure = readLastAccountFailure(context.globalState.get(LAST_ACCOUNT_FAILURE));
  let operationFailure: LastAccountFailure | undefined;
  let operationStage: AccountFailureStage = 'command';
  let operationAction = '';
  const rememberFailure = async (error: unknown, recovery = false): Promise<void> => {
    if (disposed) return;
    if (operationFailure && !recovery) return;
    let phase: unknown = 'unavailable';
    try { phase = (await service?.journal())?.phase ?? 'none'; } catch { /* Preserve the original error if journal inspection fails. */ }
    if (disposed) return;
    const record = readLastAccountFailure(operationFailure && recovery ? { ...operationFailure, recoveryCode: debugErrorCode(error) } :
      { schema: 1, at: new Date().toISOString(), action: operationAction, stage: operationStage, phase, code: debugErrorCode(error) });
    if (!record) return;
    lastFailure = operationFailure = record;
    try { await context.globalState.update(LAST_ACCOUNT_FAILURE, record); } catch { /* Diagnostics must not alter recovery outcome. */ }
  };
  const recordAcceptance = async (action: AcceptanceAction): Promise<void> => {
    debugSpan?.event('status', {acceptance: action});
    try { await context.globalState.update('live-switch.acceptance.v1', [...acceptanceEvents(context.globalState.get('live-switch.acceptance.v1', [])), { action, at: new Date().toISOString() }].slice(-100)); } catch { /* Diagnostic failure never changes credential transaction outcome. */ }
  };
  const quotas = new Map<string, LiveQuotaState>();
  let currentQuota: LiveQuotaState | undefined;
  let activeEmail: string | undefined, activeVerifiedAt: string | undefined, activeGeneration: string | undefined;
  let identityVerifiedDuringRecovery = false;
  let disposed = false;
  const verification = new RecoveryVerification(dependencies.verificationClock, lease => {
    if (disposed || verificationLease !== lease) return;
    errorMessage = liveErrorMessage('RECOVERY_VERIFICATION_TIMEOUT'); status = errorMessage; dependencies.changed?.();
  });
  let verificationLease: VerificationLease | undefined;
  let verificationSuspended = false;
  let identityTimer: NodeJS.Timeout | undefined;
  let identityAbort: AbortController | undefined;
  let identityDeadline = Date.now() + 90_000;
  let identityAttempts = 0;
  let officialActivationStarted = false, officialActivationPending = false;
  let identityStatus: string | undefined;
  let identityChecking = false;
  let loginAbort: AbortController | undefined;
  let identityNeedsRefresh = false;
  const removedIdentityKey = (): string => `live-switch.removed-current.v1.${captureService?.credentialHostIdentity?.() ?? 'legacy'}`;
  const removedIdentity = (): string | undefined => {
    const value = context.globalState.get<string>(removedIdentityKey());
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
  };
  const identityHash = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  let quotaAbort: AbortController | undefined;
  context.subscriptions.push({ dispose: () => { disposed = true; verification.dispose(); clearTimeout(identityTimer); identityAbort?.abort(); loginAbort?.abort(); quotaAbort?.abort(); } });
  const items = (): SavedLogin[] => validIndex(context.globalState.get(INDEX, []));
  const index = { read: items, write: async (accounts: SavedLogin[]): Promise<void> => { await context.globalState.update(INDEX, accounts); } };
  const recoveryDescription = (): string => {
    if (recoveryPhase === 'installed') return tr("liveUi.5702f40e1c");
    if (recoveryPhase === 'restored') return tr("liveUi.63111612b1");
    if (recoveryPhase === 'authorizing') return tr("liveUi.65e0cdf585");
    if (recoveryPhase === 'prepared') return tr("liveUi.0d81fd2a48");
    if (recoveryPhase === 'locked') return tr("liveUi.8bd7685208");
    if (recoveryPhase === 'unavailable') return errorMessage || tr("liveUi.453801e37a");
    if (recoveryPhase === 'checking') return tr("liveUi.dd4ea9f875");
    return tr("liveUi.7bf1826dfa");
  };
  // The journal, rather than the old global boolean, determines which recovery
  // action is valid. Startup only inspects encrypted recovery metadata and lock
  // ownership. The separate readiness path may activate the official extension.
  const refreshRecovery = async (describe = false, diagnostic?: DebugSpan, expected?: VerificationLease): Promise<void> => {
    try {
      const journal = await service!.journal();
      if (expected) {
        verification.assertReady(expected);
        if (journal?.id !== expected.id || journal.phase !== expected.phase) throw new LiveError('RECOVERY_VERIFICATION_STALE');
      }
      if (journal && (journal.phase === 'installed' || journal.phase === 'restored')) verificationLease = verification.bind(journal.id, journal.phase);
      else { verification.clear(); verificationLease = undefined; }
      if (recoveryPhase === 'unavailable') errorMessage = undefined;
      recoveryPhase = journal?.phase ?? (await locks.hasRecovery() ? 'locked' : 'none');
      const wasPending = pending;
      pending = recoveryPhase !== 'none';
      if (context.globalState.get(PENDING, false) !== pending) await context.globalState.update(PENDING, pending);
      if (describe && (pending || wasPending)) status = recoveryDescription();
    } catch (error) {
      if (expected && error instanceof LiveError && ['RECOVERY_VERIFICATION_STALE', 'RECOVERY_VERIFICATION_TIMEOUT'].includes(error.code)) throw error;
      diagnostic?.end('failed', debugErrorData(error));
      // Unknown, corrupt, legacy, or other-host backups must remain blocked and intact.
      recoveryPhase = 'unavailable'; pending = true;
      const code = error instanceof LiveError ? error.code : 'RECOVERY_RECORD_INVALID';
      errorMessage = liveErrorMessage(code); status = errorMessage;
    }
  };
  async function reconcileLogin(expected?: VerificationLease, renew = false, resumeStopped = false): Promise<boolean> {
    if (expected) verification.assertReady(expected);
    const journal = await service!.journal();
    if (!journal || !['installed', 'restored'].includes(journal.phase)) return false;
    if (expected && (expected.id !== journal.id || expected.phase !== journal.phase)) throw new LiveError('RECOVERY_VERIFICATION_STALE');
    const lease = expected ?? verification.bind(journal.id, journal.phase as VerificationLease['phase'], renew);
    verificationLease = lease; verification.assertReady(lease);
    recoveryPhase = journal.phase as LiveRecoveryPhase; pending = true;
    await locks.assertRecovery(journal.id);
    verification.assertReady(lease);
    status = journal.phase === 'installed' ? tr("liveUi.5180a824a3") : tr("liveUi.b706eda2df");
    dependencies.changed?.();
    let backend = await resolveLifecycle(!resumeStopped, true);
    if (resumeStopped && backend.generation === 'stopped') {
      operationStage = 'resume';
      await service!.resumeStoppedVerification(backend, { id: journal.id, phase: journal.phase, assertCurrent: () => verification.assertReady(lease) });
      verification.assertReady(lease);
      // The file route proof belongs to the newly started generation.
      backend = await resolveLifecycle(true, true);
    }
    operationStage = 'verify';
    verification.assertReady(lease);
    const guarded: Lifecycle = { ...backend, get generation() { return backend.generation; },
      proof: () => verification.proof(lease, signal => backend.proof(signal)),
      ...(backend.signedOutProof ? { signedOutProof: () => verification.proof(lease, signal => backend.signedOutProof!(signal)) } : {}) };
    const proof = await service!.finishVerified(guarded, index, { id: journal.id, phase: journal.phase, assertCurrent: () => verification.assertScope(lease) });
    operationStage = 'cleanup';
    verification.assertScope(lease);
    await locks.clearRecovery(journal.id);
    verification.assertScope(lease);
    await context.globalState.update(PENDING, false);
    verification.assertScope(lease);
    pending = false; recoveryPhase = 'none'; errorMessage = undefined;
    activeEmail = proof?.email; activeVerifiedAt = proof?.observedAt; activeGeneration = proof?.generation;
    status = journal.phase === 'installed' ? tr("liveUi.a1b61d14e0", { p0: proof?.email ?? journal.target.expectedEmail }) : proof ? tr("liveUi.097966e84e", { p0: proof.email }) : tr("liveUi.a47ce4fffc");
    await recordAcceptance(journal.phase === 'installed' ? 'switch-verified' : journal.operation === 'login' ? 'oauth-original-restored' : 'restore-verified');
    verification.clear(); verificationLease = undefined;
    return true;
  }
  function scheduleVerification(): void {
    if (disposed || verificationSuspended || !verificationLease || !['installed', 'restored'].includes(recoveryPhase)) return;
    const lease = verificationLease;
    verification.schedule(lease, () => { void refresh(lease); });
  }
  function discardVerification(lease: VerificationLease): void {
    if (!verification.matches(lease)) return;
    verification.clear(); verificationLease = undefined;
    errorMessage = liveErrorMessage('RECOVERY_VERIFICATION_STALE'); status = errorMessage;
  }
  let currentLoginSave: 'saved' | 'update' | undefined;
  let currentLoginSaveFingerprint: string | undefined;
  const currentSaveProjection = (): 'saved' | 'update' | undefined => {
    if (!activeEmail || !activeVerifiedAt || Date.now() - Date.parse(activeVerifiedAt) >= 60_000 || pending || identityChecking || !currentLoginSaveFingerprint) return undefined;
    const accounts = items().map(account => ({ ...account, hostCurrent: service?.hostIsCurrent?.(account) === true }));
    const id = verifiedCurrentAccountId(accounts, activeEmail, pending);
    return JSON.stringify(accounts.find(account => account.id === id)) === currentLoginSaveFingerprint ? currentLoginSave : undefined;
  };
  const refreshCurrentLoginSave = async (): Promise<void> => {
    currentLoginSave = undefined; currentLoginSaveFingerprint = undefined;
    if (!activeEmail || !activeVerifiedAt || pending || identityChecking || !service?.savedLoginUsable) return;
    const email = activeEmail, verifiedAt = activeVerifiedAt, hostGeneration = activeGeneration;
    const accounts = items().map(account => ({ ...account, hostCurrent: service!.hostIsCurrent(account) }));
    const id = verifiedCurrentAccountId(accounts, email, pending);
    const account = accounts.find(item => item.id === id);
    if (!account) return;
    const fingerprint = JSON.stringify(account);
    let usable: boolean;
    try { usable = await service.savedLoginUsable(account); } catch { return; }
    if (disposed || email !== activeEmail || verifiedAt !== activeVerifiedAt || hostGeneration !== activeGeneration || pending || identityChecking || JSON.stringify(items().map(item => ({ ...item, hostCurrent: service!.hostIsCurrent(item) })).find(item => item.id === id)) !== fingerprint) return;
    currentLoginSave = usable ? 'saved' : 'update'; currentLoginSaveFingerprint = fingerprint;
  };
  const clearActiveIdentity = (): void => { currentLoginSave = undefined; activeEmail = undefined; activeVerifiedAt = undefined; activeGeneration = undefined; identityChecking = false; identityVerifiedDuringRecovery = false; };
  function scheduleIdentity(): boolean {
    if (disposed || !['none', 'locked'].includes(recoveryPhase) || identityAttempts >= 12 || Date.now() >= identityDeadline) return false;
    if (identityTimer) return true;
    const delay = Math.min(1000 * 2 ** Math.min(identityAttempts, 3), 8000, identityDeadline - Date.now());
    identityTimer = setTimeout(() => {
      identityTimer = undefined;
      if (Date.now() >= identityDeadline) {
        if (recoveryPhase === 'locked') status = tr("liveUi.35522745b6");
        else identityStatus = tr("liveUi.c1194c835c");
        if (!disposed) dependencies.changed?.();
      } else if (busy) scheduleIdentity();
      else void refresh();
    }, delay);
    identityTimer.unref?.();
    return true;
  }
  // Activation itself cannot be cancelled; its late result must never publish an identity.
  const waitForIdentity = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new LiveError('QUOTA_QUERY_CANCELLED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
  async function refreshIdentity(diagnostic: DebugSpan): Promise<void> {
    if (busy || disposed) { diagnostic.end('cancelled'); return; }
    clearTimeout(identityTimer); identityTimer = undefined;
    const controller = new AbortController();
    identityAbort = controller;
    let timedOut = false;
    const remaining = identityDeadline - Date.now();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(20_000, remaining > 0 ? remaining : 20_000));
    timeout.unref?.();
    identityAttempts++;
    try {
      const official = officialExtensionForHost(context);
      const pinned = pinOfficialExtension(official);
      if (official.isActive) officialActivationStarted = true;
      if (!official.isActive) {
        clearActiveIdentity();
        if (!officialActivationStarted) {
          officialActivationPending = true;
          identityStatus = tr("liveUi.cdda6cbf77");
          dependencies.changed?.();
          const activation = locks.withOperation(async () => {
            if (disposed || busy || controller.signal.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
            if (await service!.journal() || await locks.hasRecovery()) throw new LiveError('RECOVERY_PENDING');
            if (disposed || busy || controller.signal.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
            if (!matchesOfficialExtension(pinned, officialExtensionForHost(context))) throw new LiveError('HUB_CHANGED_DURING_QUERY');
            officialActivationStarted = true;
            await official.activate();
          }).finally(() => {
            officialActivationPending = false;
            if (!disposed && !busy && Date.now() < identityDeadline && identityAttempts < 12) {
              clearTimeout(identityTimer);
              identityTimer = setTimeout(() => { identityTimer = undefined; if (!disposed && !busy && Date.now() < identityDeadline) void refresh(); }, Math.min(1000, identityDeadline - Date.now()));
              identityTimer.unref?.();
            }
          });
          await waitForIdentity(activation, controller.signal);
        }
        if (!official.isActive) throw new LiveError('OPEN_OFFICIAL_ANTIGRAVITY_FIRST');
      }
      if (official.exports?.port === undefined) throw new LiveError('OFFICIAL_HUB_NOT_READY');
      if (!hasOfficialHubApi(official.exports)) throw new LiveError('OFFICIAL_HUB_API_UNAVAILABLE');
      const currentGeneration = generation(official.exports);
      if (!identityNeedsRefresh && activeVerifiedAt && activeGeneration === currentGeneration && Date.now() - Date.parse(activeVerifiedAt) < 60_000) {
        identityStatus = undefined; clearTimeout(identityTimer); identityTimer = undefined; return;
      }
      // A routine same-backend recheck is not a sign-out. Retain the last
      // verified card while the fresh proof is pending, visibly marked checking.
      // A different backend has no current proof and must invalidate the badge.
      if (activeGeneration !== currentGeneration) clearActiveIdentity();
      identityChecking = true;
      identityStatus = tr("liveUi.596d756b21");
      dependencies.changed?.(); diagnostic.event('verifying');
      const proof = await waitForIdentity(dependencies.currentIdentity ? dependencies.currentIdentity(controller.signal) : resolveOfficialReadOnlyHub(context).then(backend => backend.freshProof!(controller.signal)), controller.signal);
      if (disposed || busy || controller.signal.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
      if (!proof?.authValid || proof.quotaSource !== 'server' || !proof.email || !Number.isFinite(Date.parse(proof.observedAt))) throw new LiveError('HUB_FRESH_IDENTITY_REQUIRED');
      if (!matchesOfficialExtension(pinned, officialExtensionForHost(context)) || !official.isActive || !hasOfficialHubApi(official.exports) || proof.generation !== currentGeneration || generation(official.exports) !== currentGeneration) throw new LiveError('HUB_CHANGED_DURING_QUERY');
      activeEmail = proof.email; activeVerifiedAt = proof.observedAt; activeGeneration = proof.generation;
      identityVerifiedDuringRecovery = pending;
      identityNeedsRefresh = false;
      identityStatus = undefined; clearTimeout(identityTimer); identityTimer = undefined;
      // A verified official login is authoritative independently of whether its
      // local encrypted copy can be saved. Copying never stops or rewrites agy.
      dependencies.changed?.();
      if (captureService?.captureCurrent) {
        try {
          const removed = removedIdentity();
          if (removed === identityHash(proof.email)) return;
          if (removed) await context.globalState.update(removedIdentityKey(), undefined);
          await locks.withOperation(async () => {
            const journal = await service!.journal();
            if (journal && (journal.operation !== 'login' || journal.loginMode !== 'save-only')) return;
            const verify = async (): Promise<void> => {
              if (disposed || busy || controller.signal.aborted || !matchesOfficialExtension(pinned, officialExtensionForHost(context)) || generation(official.exports) !== currentGeneration) throw new LiveError('HUB_CHANGED_DURING_QUERY');
              const current = await waitForIdentity(dependencies.currentIdentity ? dependencies.currentIdentity(controller.signal) : resolveOfficialReadOnlyHub(context).then(backend => backend.proof()), controller.signal);
              if (!current?.authValid || current.email.toLowerCase() !== proof.email.toLowerCase() || current.generation !== proof.generation) throw new LiveError('CAPTURE_HUB_CHANGED');
              if (disposed || busy || controller.signal.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
            };
            await captureService!.captureCurrent({ label: normalizeLabel(proof.email.slice(0, 80)), expectedEmail: proof.email.toLowerCase(), identitySource: 'hub' }, index, verify, true, journal ?? undefined, true);
          });
          if (!disposed && !busy && !controller.signal.aborted) await refreshCurrentLoginSave();
        } catch (error) {
          diagnostic.event('status', debugErrorData(error));
          if (!disposed && !busy && !controller.signal.aborted) identityStatus = tr("liveUi.officialSaveFailed", { p0: liveErrorMessage(error instanceof LiveError ? error.code : 'LOCAL_OPERATION_FAILED') });
        }
      }
    } catch (error) {
      clearActiveIdentity();
      const code = timedOut ? 'HUB_RPC_TIMEOUT' : error instanceof LiveError ? error.code : 'HUB_RPC_FAILED';
      diagnostic.end(code === 'QUOTA_QUERY_CANCELLED' ? 'cancelled' : code === 'HUB_RPC_TIMEOUT' ? 'timed_out' : 'blocked', { code });
      if (!disposed && !busy) {
        const retryable = ['OPEN_OFFICIAL_ANTIGRAVITY_FIRST', 'OFFICIAL_HUB_NOT_READY', 'OFFICIAL_HUB_API_UNAVAILABLE', 'HUB_RPC_FAILED', 'HUB_RPC_TIMEOUT', 'HUB_AUTH_INVALID', 'HUB_EMAIL_MISSING', 'HUB_FRESH_IDENTITY_REQUIRED', 'HUB_CHANGED_DURING_QUERY'].includes(code);
        const retrying = retryable && scheduleIdentity();
        identityStatus = retrying ? tr("liveUi.01c78ee2cf", { p0: liveErrorMessage(code) }) : tr("liveUi.b663503578", { p0: liveErrorMessage(code) });
      }
    } finally {
      identityChecking = false;
      clearTimeout(timeout);
      if (identityAbort === controller) identityAbort = undefined;
    }
  }
  let recoveryRefresh: Promise<void> | undefined;
  const refresh = (expected?: VerificationLease): Promise<void> => {
    if (expected) { try { verification.assertReady(expected); } catch { return Promise.resolve(); } }
    if (busy || disposed) return Promise.resolve();
    if (recoveryRefresh) return recoveryRefresh;
    const diagnostic = beginDebugOperation('account.refresh');
    recoveryRefresh = (async () => {
      await serviceReady;
      if (expected) { try { verification.assertReady(expected); } catch { return; } }
      if (disposed) { diagnostic.end('cancelled'); return; }
      const host = nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
      if (setupError || !host.available) {
        clearActiveIdentity(); identityStatus = undefined; clearTimeout(identityTimer); identityTimer = undefined;
        diagnostic.end('blocked', debugErrorData(setupError ?? new Error(host.code))); return;
      }
      try {
        if (typeof locks.reconcileRecovery === 'function') {
          const journal = await service!.journal();
          if (expected) { verification.assertReady(expected); if (journal?.id !== expected.id || journal.phase !== expected.phase) throw new LiveError('RECOVERY_VERIFICATION_STALE'); }
          const marker = await locks.inspectRecovery();
          const operation = await locks.inspectOperation();
          // An idle new installation never creates HOME directories or acquires a
          // lock just to draw the UI. Active/uncertain owners are never overridden.
          if (operation.state === 'active') {
            // An image owns the same mutex but has no credential transaction.
            // Keep the known identity and do not invent a recovery marker or
            // block the image panel after a normal focus-driven account refresh.
            if (operation.owner?.purpose === 'image' && !journal && marker.state === 'absent') {
              diagnostic.end('blocked', { code: 'IMAGE_ACCOUNT_OPERATION_BUSY' }); return;
            }
            clearActiveIdentity(); identityStatus = undefined;
            recoveryPhase = 'locked'; pending = true; identityAttempts++;
            status = scheduleIdentity() ? recoveryDescription() : tr("liveUi.35522745b6");
            diagnostic.end('blocked', {code: 'LOCK_PROCESS_STILL_ALIVE'}); return;
          }
          if (operation.state === 'uncertain') throw new LiveError(operation.reason || 'LOCK_PROCESS_STATUS_UNKNOWN');
          if (journal || marker.state !== 'absent' || operation.state === 'stale') {
            await locks.withOperation(async () => {
              const current = await service!.journal();
              if (expected) { verification.assertReady(expected); if (current?.id !== expected.id || current.phase !== expected.phase) throw new LiveError('RECOVERY_VERIFICATION_STALE'); }
              await locks.reconcileRecovery(current?.id ?? null);
              await service!.recoverLogin?.(index);
            });
          }
        }
        await refreshRecovery(true, diagnostic, expected);
        if (!verificationSuspended && ['installed', 'restored'].includes(recoveryPhase)) {
          const attempted = verificationLease;
          try { await locks.withOperation(() => reconcileLogin(attempted)); }
          catch (error) {
            if (attempted) {
              if (!verification.matches(attempted)) return;
              const current = await service!.journal();
              if (current?.id !== attempted.id || current.phase !== attempted.phase) { discardVerification(attempted); return; }
            }
            diagnostic.end('failed', debugErrorData(error));
            const code = error instanceof LiveError ? error.code : 'HUB_IDENTITY_NOT_VERIFIED';
            errorMessage = liveErrorMessage(code);
            status = tr("liveUi.254260d5f2", { p0: errorMessage });
            // Retry only this already-authorized recovery, never a new login or switch.
            scheduleVerification();
            // A pending recovery cannot make its old identity authoritative over
            // a separately verified official login. This path never writes agy.
            await refreshIdentity(diagnostic);
          }
        } else if (recoveryPhase === 'none') {
          await refreshIdentity(diagnostic);
          await refreshCurrentLoginSave();
        } else if (['authorizing', 'prepared', 'restored'].includes(recoveryPhase)) {
          await refreshIdentity(diagnostic);
        } else {
          clearActiveIdentity(); identityStatus = undefined; clearTimeout(identityTimer); identityTimer = undefined;
        }
      } catch (error) {
        if (expected && error instanceof LiveError && error.code === 'RECOVERY_VERIFICATION_STALE') { discardVerification(expected); return; }
        if (expected && (!verification.matches(expected) || error instanceof LiveError && ['RECOVERY_VERIFICATION_STALE', 'RECOVERY_VERIFICATION_TIMEOUT'].includes(error.code))) return;
        diagnostic.end('failed', debugErrorData(error));
        recoveryPhase = 'unavailable'; pending = true;
        errorMessage = liveErrorMessage(error instanceof LiveError ? error.code : 'RECOVERY_RECORD_INVALID'); status = errorMessage;
      }
    })().finally(() => { diagnostic.end('completed'); recoveryRefresh = undefined; if (!disposed) dependencies.changed?.(); });
    return recoveryRefresh;
  };
  const recoveryReady = refresh();
  if (context.secrets.onDidChange) context.subscriptions.push(context.secrets.onDidChange(event => {
    if (!event.key.startsWith('live-switch.account.v1.') && !event.key.startsWith('live-switch.quota-')) return;
    currentLoginSave = undefined; dependencies.changed?.();
    if (!busy && !disposed) void refresh();
  }));
  const requestOfficialRefresh = (): void => {
    if (disposed) return;
    identityNeedsRefresh = true; identityAttempts = 0; identityDeadline = Date.now() + 90_000;
    if (!busy) void refresh();
  };
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState(state => { if (state.focused) requestOfficialRefresh(); }));
  let probeRunning = false;
  const officialProbe = setInterval(() => {
    if (disposed || busy || recoveryRefresh || probeRunning || !nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName).available) return;
    probeRunning = true;
    // Only the existing loopback Hub is probed; no saved credentials, OAuth or
    // remote quota query is started to detect a candidate login change.
    void resolveOfficialReadOnlyHub(context).then(backend => backend.proof()).then(proof => {
      if (!disposed && !busy && (proof.email.toLowerCase() !== activeEmail?.toLowerCase() || proof.generation !== activeGeneration || !proof.authValid)) requestOfficialRefresh();
    }).catch(error => {
      if (error instanceof LiveError && ['HUB_AUTH_INVALID', 'HUB_EMAIL_MISSING', 'HUB_CHANGED_DURING_QUERY', 'OFFICIAL_HUB_NOT_READY', 'OFFICIAL_HUB_API_UNAVAILABLE'].includes(error.code) && !disposed && !busy) requestOfficialRefresh();
    }).finally(() => { probeRunning = false; });
  }, 5000);
  officialProbe.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(officialProbe) });

  async function finishRequestedRestart(): Promise<void> {
    if (disposed) { reloadRequested = false; requestedRestartBackend = undefined; return; }
    if (reloadRequested) {
        reloadRequested = false;
        try {
          const backend = requestedRestartBackend ?? await resolveLifecycle(false);
          requestedRestartBackend = undefined;
          if (backend.restartMode === 'component') await locks.withOperation(async () => {
            await backend.stop(); await backend.reload(); await reconcileLogin();
          });
          else if (backend.restartMode === 'unavailable') throw new LiveError('OFFICIAL_COMPONENT_RESTART_UNAVAILABLE');
          else await vscode.commands.executeCommand('workbench.action.reloadWindow'); // Legacy injected adapter only; native resolver never selects this.
        } catch (error) {
          const code = error instanceof LiveError ? error.code : 'OFFICIAL_COMPONENT_RESTART_TIMEOUT';
          errorMessage = liveErrorMessage(code); status = errorMessage; dependencies.changed?.();
        }
      }
  }
  const register = (name: string, fn: (argument?: unknown) => Promise<boolean | void>, unlocked = false): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`antigravityAccounts.live.${name}`, async (argument?: unknown) => {
      if (busy || disposed) return; busy = true; identityAbort?.abort(); identityStatus = undefined; errorMessage = undefined; if (['login', 'switch', 'restore'].includes(name)) identityVerifiedDuringRecovery = false; dependencies.changed?.();
      operationAction = name; operationStage = 'command'; operationFailure = undefined;
      const diagnostic = ['login', 'capture', 'switch', 'verify', 'quota', 'restore', 'remove', 'export', 'import'].includes(name) ? beginDebugOperation(`account.${name}` as DebugOperation) : undefined;
      debugSpan = diagnostic; diagnostic?.event('preparing');
      let completed = false;
      let releaseAccountChange: (() => void) | undefined;
      try {
        if (['switch', 'login', 'restore'].includes(name)) releaseAccountChange = enterAccountChange();
        assertNativeHost(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
        await recoveryReady; await recoveryRefresh; if (disposed) return; if (setupError) throw setupError;
        if (officialActivationPending) throw new LiveError('OFFICIAL_HUB_NOT_READY');
        if (unlocked) { try { completed = await fn(argument) === true; } finally { if (!disposed) await refreshRecovery(false, diagnostic); } } else await locks.withOperation(async () => {
          // Finish or roll back a crashed import before another credential operation.
          if (name !== 'quota') {
            const journal = await service!.journal();
            await locks.reconcileRecovery?.(journal?.id ?? null);
            await service!.recoverImport?.(index);
            await service!.recoverLogin?.(index);
          }
          try { completed = await fn(argument) === true; }
          finally { if (name !== 'quota' && !disposed) await refreshRecovery(false, diagnostic); }
        }); diagnostic?.end(completed ? 'completed' : 'cancelled'); }
      catch (e) {
        await rememberFailure(e);
        const debugData = debugErrorData(e); diagnostic?.end(debugFailureOutcome(debugData.code), debugData);
        const code = e instanceof LiveError ? e.code : 'LOCAL_OPERATION_FAILED';
        errorMessage = liveErrorMessage(code, nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName));
        const retainedFailure = readLastAccountFailure(operationFailure);
        if (retainedFailure) errorMessage += `（${retainedFailure.code}）`;
        if (name === 'quota') {
          // Read-only queries report locally, never as modal/toast/editor notifications.
          // Invalid/unbound caller-supplied ids must not redirect errors to a different card.
          const target = typeof argument === 'string' ? items().find(account => account.id === argument) : undefined;
          if (target && activeEmail?.toLowerCase() === target.expectedEmail.toLowerCase() && ['ACCOUNT_QUOTA_IDENTITY_MISMATCH', 'HUB_QUOTA_ACCOUNT_MISMATCH', 'HUB_AUTH_INVALID', 'HUB_CHANGED_DURING_QUERY'].includes(code)) { activeEmail = undefined; activeVerifiedAt = undefined; activeGeneration = undefined; }
          const previous = target ? quotas.get(target.id) : currentQuota;
          const result: LiveQuotaState = { phase: 'error', message: errorMessage, ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}) };
          if (!disposed) { if (target) quotas.set(target.id, result); else currentQuota = result; }
          errorMessage = undefined;
          await recordAcceptance('quota-failed');
        } else {
          status = errorMessage;
          // Operation failures stay inline with their recovery action; no duplicate popup.
        }
      } finally {
      await finishRequestedRestart();
      scheduleVerification();
      releaseAccountChange?.(); diagnostic?.end('cancelled'); if (debugSpan === diagnostic) debugSpan = undefined; if (name === 'quota') quotaAbort = undefined; busy = false; if (!disposed) { await refreshCurrentLoginSave(); if (!activeEmail) scheduleIdentity(); dependencies.changed?.(); }
      }
    }));
  };
  register('export', async argument => {
    if (argument !== undefined) throw new LiveError('MIGRATION_ARGUMENTS_UNSUPPORTED');
    if (await service!.journal() || await locks.hasRecovery()) throw new LiveError('RECOVERY_PENDING');
    const available = items().filter(account => service!.hostIsCurrent(account));
    if (!available.length) { void vscode.window.showInformationMessage(tr("liveUi.ebe15d73de")); return; }
    const choices = available.map(account => ({ label: account.label, description: account.expectedEmail, detail: tr("liveUi.656efe0acc", { p0: account.capturedAt, p1: account.migrationState === 'pending' ? tr("liveUi.c3f2260607") : '' }), picked: true, id: account.id }));
    const selected = await vscode.window.showQuickPick(choices, { title: tr("liveUi.ea24112b94"), placeHolder: tr("liveUi.c8047ed0e8"), canPickMany: true, ignoreFocusOut: true });
    if (!selected?.length) return;
    const ids = [...new Set(selected.map(item => item.id))];
    if (ids.some(id => !available.some(account => account.id === id))) throw new LiveError('ACCOUNT_ID_INVALID');
    const consent = tr("liveUi.cf7a6b1088");
    if (await vscode.window.showWarningMessage(tr("liveUi.4d84e77bf4", { p0: ids.length }), { modal: true }, consent) !== consent) return;
    const destination = await vscode.window.showSaveDialog({ title: tr("liveUi.1bee1cdafe", { p0: hostLabel(context, vscode.env.remoteName) }), defaultUri: vscode.Uri.file(path.join(os.homedir(), 'antigravity-accounts.agwenc')), filters: { [tr("liveUi.3a1f17615e")]: ['agwenc'] }, saveLabel: tr("liveUi.d195c2e977") });
    if (!destination) return;
    const filename = migrationFilePath(destination);
    const password = await vscode.window.showInputBox({ title: tr("liveUi.c583de5d3c"), prompt: tr("liveUi.bc0c53d7e9"), password: true, ignoreFocusOut: true, validateInput: migrationPasswordError });
    if (password === undefined) return;
    if (migrationPasswordError(password)) throw new LiveError('MIGRATION_PASSWORD_INVALID');
    const repeated = await vscode.window.showInputBox({ title: tr("liveUi.1d8d388f8b"), prompt: tr("liveUi.cf409f8c7c"), password: true, ignoreFocusOut: true, validateInput: value => value === password ? null : tr("liveUi.64eff9d196") });
    if (repeated === undefined) return;
    if (repeated !== password) throw new LiveError('MIGRATION_PASSWORD_MISMATCH');
    assertNativeHost(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
    const accounts = await service!.exportAccounts(ids);
    const encrypted = await encryptAccountArchive(accounts, password);
    assertNativeHost(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
    await writeMigrationArchive(filename, encrypted);
    status = tr("liveUi.de5d922641", { p0: accounts.length });
    void vscode.window.showInformationMessage(status);
    return true;
  });
  register('import', async argument => {
    if (argument !== undefined) throw new LiveError('MIGRATION_ARGUMENTS_UNSUPPORTED');
    if (await service!.journal() || await locks.hasRecovery()) throw new LiveError('RECOVERY_PENDING');
    const sources = await vscode.window.showOpenDialog({ title: tr("liveUi.1ef6ad1be2", { p0: hostLabel(context, vscode.env.remoteName) }), defaultUri: vscode.Uri.file(os.homedir()), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { [tr("liveUi.3a1f17615e")]: ['agwenc'] }, openLabel: tr("liveUi.c38115ef67") });
    if (!sources?.length) return;
    if (sources.length !== 1) throw new LiveError('MIGRATION_FILE_URI_INVALID');
    const encrypted = await readMigrationArchive(migrationFilePath(sources[0]!));
    const password = await vscode.window.showInputBox({ title: tr("liveUi.1ff1b99c67"), prompt: tr("liveUi.920a8fe835"), password: true, ignoreFocusOut: true });
    if (password === undefined) return;
    const archive = await decryptAccountArchive(encrypted, password);
    // Keep token-bearing objects out of all VS Code UI items and webview messages.
    const choices = archive.accounts.map((account, position) => ({ label: account.label, description: account.expectedEmail, detail: tr("liveUi.d3e78920c7", { p0: account.capturedAt }), picked: true, position }));
    const selected = await vscode.window.showQuickPick(choices, { title: tr("liveUi.c3b6545057", { p0: archive.accounts.length }), placeHolder: tr("liveUi.57f165c49b"), canPickMany: true, ignoreFocusOut: true });
    if (!selected?.length) return;
    const positions = [...new Set(selected.map(item => item.position))];
    if (positions.some(position => !Number.isInteger(position) || position < 0 || position >= archive.accounts.length)) throw new LiveError('MIGRATION_ARCHIVE_INVALID');
    let accounts = positions.map(position => archive.accounts[position]!);
    const currentEmails = new Set(items().filter(account => service!.hostIsCurrent(account)).map(account => account.expectedEmail.trim().toLowerCase()));
    const conflictCount = accounts.filter(account => currentEmails.has(account.expectedEmail.trim().toLowerCase())).length;
    if (conflictCount) {
      const resolution = await vscode.window.showQuickPick([{ label: tr("liveUi.08e57d9e36"), description: tr("liveUi.aa62025fd7"), policy: 'skip' }, { label: tr("liveUi.8d05233cdb"), description: tr("liveUi.e70c56d75f"), policy: 'copy' }], { title: tr("liveUi.416aa9a482", { p0: conflictCount }), placeHolder: tr("liveUi.c57ab9795f"), ignoreFocusOut: true });
      if (!resolution) return;
      if (resolution.policy === 'skip') accounts = accounts.filter(account => !currentEmails.has(account.expectedEmail.trim().toLowerCase()));
      else if (resolution.policy !== 'copy') throw new LiveError('MIGRATION_ARCHIVE_INVALID');
    }
    if (!accounts.length) { void vscode.window.showInformationMessage(tr("liveUi.70b1915749")); return; }
    if (items().length + accounts.length > 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
    const consent = tr("liveUi.2b8bbc024d", { p0: accounts.length });
    if (await vscode.window.showWarningMessage(tr("liveUi.e5cb5a521a", { p0: hostLabel(context, vscode.env.remoteName), p1: accounts.length }), { modal: true }, consent) !== consent) return;
    assertNativeHost(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName);
    const imported = await service!.importAccounts(accounts, index);
    status = tr("liveUi.3aa3e74b6e", { p0: imported.length });
    void vscode.window.showInformationMessage(status);
    return true;
  });
  register('login', async () => {
    if (items().length >= 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
    if (await service!.journal() || await locks.hasRecovery()) throw new LiveError('RECOVERY_PENDING');
    const consent = tr("liveUi.b3b97798fc");
    if (await vscode.window.showWarningMessage(tr("liveUi.f3effd4a3f", { p0: hostLabel(context, vscode.env.remoteName) }), { modal: true }, consent) !== consent) return;
    const backend = await resolveLifecycle(true, true), transactionId = randomUUID();
    if (backend.restartMode === 'unavailable') throw new LiveError('OFFICIAL_COMPONENT_RESTART_UNAVAILABLE');
    await locks.beginRecovery(transactionId);
    let prepared = false, account: SavedLogin | undefined;
    try {
      await context.globalState.update(PENDING, true);
      await service!.prepareLogin(backend, transactionId); prepared = true; activeEmail = undefined; activeVerifiedAt = undefined; activeGeneration = undefined;
      loginAbort = new AbortController();
      const abort = loginAbort;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr("liveUi.15afa50070"), cancellable: true }, async (_progress, token) => {
        const cancel = token.onCancellationRequested(() => abort.abort());
        try {
          if (token.isCancellationRequested) abort.abort();
          status = tr("liveUi.3473d3c082"); dependencies.changed?.();
          debugSpan?.event('running');
          await backend.login(abort.signal);
          if (abort.signal.aborted) throw new LiveError('LOGIN_CANCELLED');
        } finally { cancel.dispose(); }
      });
      // Login's validated result ends the browser notification. Server proof and
      // durable storage remain required, but their progress belongs to the panel.
      const assertLoginCurrent = async (): Promise<void> => {
        if (abort.signal.aborted || disposed) throw new LiveError('LOGIN_CANCELLED');
        const journal = await service!.journal();
        if (journal?.id !== transactionId || journal.operation !== 'login' || journal.phase !== 'authorizing') throw new LiveError('RECOVERY_CHANGED');
      };
      await assertLoginCurrent();
      status = tr("liveUi.aa3daf4de6"); dependencies.changed?.();
      debugSpan?.event('verifying');
      const proof = await backend.proof(abort.signal);
      if (!proof.authValid || proof.generation !== backend.generation) throw new LiveError('LOGIN_HUB_NOT_VERIFIED');
      await assertLoginCurrent();
      debugSpan?.event('saving');
      account = await service!.captureLogin({ label: proof.email, expectedEmail: proof.email, identitySource: 'hub' }, transactionId);
      await assertLoginCurrent();
      await context.globalState.update(INDEX, [...items(), account]);
      status = tr("liveUi.loginSavedChecking"); dependencies.changed?.();
      debugSpan?.event('verifying');
      const fresh = await backend.proof(abort.signal);
      if (!fresh.authValid || fresh.email !== proof.email || fresh.generation !== proof.generation) throw new LiveError('LOGIN_HUB_CHANGED');
      await assertLoginCurrent();
      await recordAcceptance('account-saved');
      if (abort.signal.aborted) throw new LiveError('LOGIN_CANCELLED');
      if (!account) throw new LiveError('LOGIN_ACCOUNT_NOT_SAVED');
      const saved = account;
      loginAbort = undefined;
      // Close the cancellable browser step before beginning atomic storage installation.
      status = tr("liveUi.8e349f6760"); dependencies.changed?.();
      debugSpan?.event('recovering');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr("liveUi.8e349f6760"), cancellable: false }, async () => {
        await service!.completeLogin(saved.id, deferred(backend));
        status = tr("liveUi.f922756e77", { p0: saved.expectedEmail });
        if (backend.restartMode === 'component') await reconcileLogin();
      });
      return true;
    } catch (error) {
      debugSpan?.event('recovering', debugErrorData(error));
      if (prepared) {
        // A replaced recovery record belongs to another transaction. Do not
        // restore or clear it on behalf of this late login result.
        if (error instanceof LiveError && error.code === 'RECOVERY_CHANGED' || (await service!.journal())?.id !== transactionId) throw new LiveError('RECOVERY_CHANGED');
        // Disconnecting a Login RPC alone does not prove that the official browser callback
        // stopped. Stop the whole official backend before touching either credential slot.
        if (error instanceof LiveError && error.code === 'NATIVE_HELPER_TIMEOUT_OR_LIMIT') {
          throw new LiveError('LOGIN_STORAGE_TIMEOUT_RECOVERY_REQUIRED');
        }
        reloadRequested = false;
        try {
          // An independent official login owns its changed slots. Only a proven
          // snapshot from this add operation authorizes automatic restoration.
          await service!.restoreLogin(transactionId, backend, { reload: false });
        }
        catch { throw new LiveError('LOGIN_FAILED_RECOVERY_REQUIRED'); }
        const reason = error instanceof LiveError ? error.code : 'LOGIN_OPERATION_FAILED';
        const debugData = debugErrorData(error); debugSpan?.end(debugFailureOutcome(debugData.code), debugData);
        status = tr("liveUi.9949291c78", { p0: reason === 'LOGIN_CANCELLED' ? tr("liveUi.ec872a787c") : tr("liveUi.32fe0d02a6"), p1: account ? tr("liveUi.8b1273fc79") : '' });
        if (disposed) return;
        await refreshRecovery(); if (disposed) return; dependencies.changed?.();
        // The initial add-account consent covers restoration and one reload.
        // A completed local restore is not called a verified session yet.
        reloadRequested = true;
        requestedRestartBackend = backend.restartMode === undefined ? backend : undefined;
      } else if (!await service!.journal()) {
        await context.globalState.update(PENDING, false); await locks.clearRecovery(transactionId);
        throw error;
      } else throw error;
    } finally { loginAbort = undefined; }
  });
  register('capture', async () => {
    const captureSource = storageMode === 'wsl-file' ? tr("liveUi.8355266387") : tr("liveUi.a12605a629");
    if (currentSaveProjection() === 'saved' && activeEmail && captureService?.captureCurrent) {
      const backend = await resolveLifecycle();
      const email = activeEmail.toLowerCase(), pinnedGeneration = activeGeneration;
      await captureService.captureCurrent({ label: normalizeLabel(email.slice(0, 80)), expectedEmail: email, identitySource: 'hub' }, index, async () => {
        const fresh = await backend.proof();
        if (!fresh.authValid || fresh.email.toLowerCase() !== email || fresh.generation !== pinnedGeneration) throw new LiveError('CAPTURE_HUB_CHANGED');
      }, false);
      status = tr("liveUi.6a962d4f15"); return true;
    }
    const captureConsent = tr("liveUi.462628ea4c");
    if (await vscode.window.showWarningMessage(tr("liveUi.0f9cad9846", { p0: hostLabel(context, vscode.env.remoteName), p1: captureSource }), { modal: true }, captureConsent) !== captureConsent) return;
    const backend = await resolveLifecycle();
    if (await service!.journal()) throw new LiveError('RECOVERY_PENDING');
    let proof: HubProof | undefined;
    try { proof = await backend.proof(); } catch (error) { if (storageMode === 'wsl-file') throw error; /* Native legacy capture may use an explicitly unverified label. */ }
    const claimed = proof?.email ?? await vscode.window.showInputBox({ title: tr("liveUi.642fdbcb7e"), prompt: tr("liveUi.0eaf50578d"), validateInput: value => /^[^\s@\x00-\x1f<>]{1,128}@[^\s@\x00-\x1f<>]{1,128}$/.test(value) ? null : tr("liveUi.59c9ed95eb") });
    if (!claimed) return;
    const label = claimed.slice(0, 80);
    if (await locks.hasRecovery()) throw new LiveError('RECOVERY_PENDING');
    if (proof) { const fresh = await backend.proof(); if (fresh.email !== proof.email || fresh.generation !== proof.generation) throw new LiveError('CAPTURE_HUB_CHANGED'); }
    {
      if (storageMode === 'wsl-file') {
        const current = await slots.read();
        if (!proof || !current.file || tokenAccountHint(current.file).email !== proof.email) throw new LiveError('WSL_FILE_IDENTITY_UNVERIFIED');
      }
      if (proof && captureService?.captureCurrent) {
        const pinned = proof;
        const result = await captureService.captureCurrent({ label: normalizeLabel(label), expectedEmail: claimed.toLowerCase(), identitySource: 'hub' }, index, async () => {
          const fresh = await backend.proof();
          if (!fresh.authValid || fresh.email.toLowerCase() !== pinned.email.toLowerCase() || fresh.generation !== pinned.generation) throw new LiveError('CAPTURE_HUB_CHANGED');
        });
        activeEmail = pinned.email; activeVerifiedAt = pinned.observedAt; activeGeneration = pinned.generation;
        status = result.saved ? tr("liveUi.6a962d4f15") : tr("liveUi.8543b01d40", { p0: result.account.label });
        return true;
      }
      if (items().length >= 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
      const account = await captureService!.capture({ label: normalizeLabel(label), expectedEmail: claimed.toLowerCase(), identitySource: proof ? 'hub' : 'user' });
      try {
        if (proof) { const fresh = await backend.proof(); if (fresh.email !== proof.email || fresh.generation !== proof.generation) throw new LiveError('CAPTURE_HUB_CHANGED'); }
        await context.globalState.update(INDEX, [...items(), account]);
      } catch (error) { await context.secrets.delete(`live-switch.account.v1.${account.id}`); throw error; }
      status = tr("liveUi.8543b01d40", { p0: account.label });
      return true;
    }
  });
  const switchAccount = async (argument: unknown, alreadyConfirmed = false): Promise<boolean | void> => {
    const direct = accountArgument(argument, items());
    const selected = direct ? { account: direct } : await vscode.window.showQuickPick(items().map(account => ({ label: account.label, description: account.expectedEmail, detail: tr("liveUi.3e646493ab", { p0: account.capturedAt, p1: account.migrationState === 'pending' ? tr("liveUi.8f858aa51c") : account.identitySource === 'hub' ? tr("liveUi.ca7dd652b2") : tr("liveUi.905e17f65c") }), account })), { title: tr("liveUi.13e45587a6") });
    if (!selected) { if (!items().length) void vscode.window.showInformationMessage(tr("liveUi.2fdb70d003")); return; }
    const switchConsent = tr("liveUi.e0351ba254");
    if (!alreadyConfirmed && await vscode.window.showWarningMessage(tr("liveUi.9dc41427e9", { p0: selected.account.expectedEmail, p1: selected.account.migrationState === 'pending' ? tr("liveUi.61d34541c9") : '' }), { modal: true }, switchConsent) !== switchConsent) return;
    const backend = await resolveLifecycle();
    if (backend.restartMode === 'unavailable') throw new LiveError('OFFICIAL_COMPONENT_RESTART_UNAVAILABLE');
    const transactionId = randomUUID();
    await locks.beginRecovery(transactionId);
    try {
      await context.globalState.update(PENDING, true);
      status = tr("liveUi.552c9a900e"); activeEmail = undefined; activeVerifiedAt = undefined; activeGeneration = undefined;
      await service!.install(selected.account.id, deferred(backend), transactionId, stage => { operationStage = stage; });
      if (backend.restartMode === 'component') return await reconcileLogin();
      return true;
    } catch (e) {
      await rememberFailure(e);
      if (disposed || e instanceof LiveError && e.code === 'RECOVERY_VERIFICATION_STALE') throw e;
      // A conflicting record is evidence of another state, not a failed target
      // that this transaction may roll back. Keep it byte-for-byte intact.
      if (e instanceof LiveError && ['RECOVERY_CHANGED', 'RECOVERY_PENDING', 'RECOVERY_RECORD_CONFLICT', 'RECOVERY_RECORD_INVALID'].includes(e.code)) throw e;
      if (backend.restartMode === 'component' && operationStage === 'journal-installed' &&
          e instanceof LiveError && e.code === 'RECOVERY_SAVE_NOT_VERIFIED' && typeof service!.resumeUnconfirmedInstall === 'function') {
        try {
          const stopped = await resolveLifecycle(false);
          if (await service!.resumeUnconfirmedInstall(stopped, transactionId, async () => {
            if (disposed) throw new LiveError('RECOVERY_VERIFICATION_STALE');
            await locks.assertRecovery(transactionId);
          })) {
            // The backend can be usable while metadata is still unconfirmed.
            // Do not let focus/timer callbacks turn this into success or cleanup.
            verificationSuspended = true; verification.clear(); verificationLease = undefined;
            throw e;
          }
        } catch (recoveryError) {
          if (recoveryError !== e) await rememberFailure(recoveryError, true);
          throw e;
        }
      }
      const journal = await service!.journal();
      if (journal && journal.id !== transactionId) throw new LiveError('RECOVERY_CHANGED');
      // The vault can commit installed and still fail its immediate readback.
      // Before the first reconnect dispatch only, the same confirmed operation
      // may finish that exact installed target through the protected resume path.
      // No journal rewrite, credential overwrite, command retry or timer retry.
      if (backend.restartMode === 'component' && operationStage === 'journal-installed' &&
          e instanceof LiveError && e.code === 'RECOVERY_SAVE_NOT_VERIFIED' &&
          journal?.phase === 'installed' && journal.target.id === selected.account.id &&
          journal.verification?.state === 'pending' && journal.verification.attempts === 0) {
        try { return await reconcileLogin(undefined, false, true); }
        catch (recoveryError) { await rememberFailure(recoveryError, true); throw new LiveError('SWITCH_FAILED_RECOVERY_REQUIRED'); }
      }
      if (!journal) {
        // Failure after a clean stop but before a durable journal never wrote a
        // credential. Bring that original session back without a window reload.
        if (backend.restartMode === 'component') {
          const current = await resolveLifecycle(false);
          if (current.generation === 'stopped') await current.reload();
        }
        await context.globalState.update(PENDING, false); await locks.clearRecovery(transactionId);
      }
      else if (backend.restartMode === 'component' && journal.phase === 'restored') {
        const current = await resolveLifecycle(false);
        if (current.generation === 'stopped') await current.reload();
        await reconcileLogin();
        throw new LiveError('SWITCH_FAILED_ORIGINAL_RESTORED');
      }
      else if (backend.restartMode === 'component' && journal.phase === 'installed') {
        // Roll back only through the transaction's guarded storage comparison and
        // a ready, pinned backend. A startup still in flight is not safe to overwrite.
        try {
          const current = await resolveLifecycle(true);
          if (current.restartMode !== 'component') throw new LiveError('OFFICIAL_COMPONENT_RESTART_UNAVAILABLE');
          status = tr("liveUi.57b7d2f4fa"); dependencies.changed?.();
          await service!.restore(current, { guardInstalled: true });
          await reconcileLogin();
        } catch (recoveryError) { await rememberFailure(recoveryError, true); throw new LiveError('SWITCH_FAILED_RECOVERY_REQUIRED'); }
        throw new LiveError('SWITCH_FAILED_ORIGINAL_RESTORED');
      }
      throw e;
    }
  };
  register('switch', argument => switchAccount(argument));
  function recordProof(proof: HubProof): SavedLogin[] {
    if (proof.quotaSource !== 'server') return [];
    const snapshot: LiveQuotaSnapshot = { email: proof.email, observedAt: proof.observedAt, source: proof.quotaSource === 'server' ? 'server' : 'hub-status', buckets: proof.buckets.map(bucket => ({ ...bucket })) };
    const matching = items().filter(account => (!service!.hostIsCurrent || service!.hostIsCurrent(account)) && account.expectedEmail.trim().toLowerCase() === proof.email.trim().toLowerCase());
    for (const account of matching) quotas.set(account.id, { phase: 'ready', snapshot });
    currentQuota = matching.length ? undefined : { phase: 'ready', snapshot, message: tr("liveUi.aa9c92f9f7") };
    return matching;
  }
  register('verify', async () => { verificationSuspended = false; return await reconcileLogin(undefined, true, true); });
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.live.quotaCancel', () => quotaAbort?.abort()));
  register('quota', async argument => {
    const target = accountArgument(argument, items());
    if (target && service!.hostIsCurrent && !service!.hostIsCurrent(target)) throw new LiveError(target.hostId ? 'HOST_ACCOUNT_MISMATCH' : 'HOST_ACCOUNT_UNBOUND');
    const previous = target ? quotas.get(target.id) : currentQuota;
    const loading: LiveQuotaState = { phase: 'loading', ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}) };
    if (target) quotas.set(target.id, loading); else currentQuota = loading;
    dependencies.changed?.();
    quotaAbort = new AbortController();
    const abort = quotaAbort;
    let proof: HubProof;
    if (target && activeEmail?.toLowerCase() === target.expectedEmail.toLowerCase()) {
      // A known active account uses its own official session, avoiding concurrent
      // refresh-token rotation against the same grant from a second client.
      const backend = dependencies.currentQuota ? undefined : await resolveOfficialReadOnlyHub(context);
      proof = await (dependencies.currentQuota ? dependencies.currentQuota(target.expectedEmail, abort.signal) : backend!.quota(target.expectedEmail, abort.signal));
      if (!proof.authValid || proof.quotaSource !== 'server' || proof.email.toLowerCase() !== target.expectedEmail.toLowerCase() || backend && proof.generation !== backend.generation) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');
      activeEmail = proof.email; activeVerifiedAt = proof.observedAt; activeGeneration = proof.generation;
    } else if (target) {
      // The explicit Refresh action requests this account's query. Loading,
      // results and errors stay on its card without another confirmation.
      if (abort.signal.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
      const saved = await service!.account(target.id);
      if (saved.expectedEmail.toLowerCase() !== target.expectedEmail.toLowerCase()) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');
      let committed = saved;
      let pendingSlots: TokenSlots | undefined;
      const options: SavedAccountQuotaOptions = {
        refresh: {
          provider: createConsumerRefreshProvider(path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy')),
          loadPending: async expected => { pendingSlots = await service!.pendingQuotaRefresh(target.id, expected); return pendingSlots; },
          stage: async (expected, next) => { await service!.stageQuotaRefresh(target.id, expected, next, pendingSlots); pendingSlots = next; },
          commit: async (expected, next) => { committed = await service!.commitQuotaRefresh(target.id, expected, next); pendingSlots = undefined; },
        },
        phase: phase => {
          if (disposed) return;
          loading.message = phase === 'refreshing' ? tr("liveUi.3902f9e3d5") : phase === 'saving' ? tr("liveUi.a7f79e9176") : tr("liveUi.3e89495d05");
          dependencies.changed?.();
        },
      };
      proof = await (dependencies.savedQuota ?? querySavedAccountQuota)(saved, abort.signal, options);
      const latest = await service!.account(target.id);
      if (!items().some(item => item.id === target.id && item.expectedEmail === target.expectedEmail) || latest.hostId !== committed.hostId || latest.expectedEmail !== committed.expectedEmail || !equalSlots(latest.slots, committed.slots)) throw new LiveError('ACCOUNT_QUOTA_ACCOUNT_CHANGED');
      if (!proof.authValid || proof.quotaSource !== 'server' || proof.email.toLowerCase() !== target.expectedEmail.toLowerCase()) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');
    } else {
      // Legacy current-account command remains read-only and does not load saved tokens.
      const backend = dependencies.lifecycle ? await dependencies.lifecycle() : await resolveOfficialReadOnlyHub(context);
      proof = await backend.quota(undefined, abort.signal);
      if (!proof.authValid || proof.generation !== backend.generation || proof.quotaSource !== 'server') throw new LiveError('HUB_CHANGED_DURING_QUERY');
    }
    if (abort.signal.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
    if (disposed) return;
    if (target && !items().some(item => item.id === target.id && item.expectedEmail === target.expectedEmail)) throw new LiveError('ACCOUNT_QUOTA_ACCOUNT_CHANGED');
    if (target) {
      // Isolate even duplicate same-email copies; never repaint a different saved account.
      quotas.set(target.id, { phase: 'ready', snapshot: { email: proof.email, observedAt: proof.observedAt, source: 'server', buckets: proof.buckets.map(bucket => ({ ...bucket })) } });
    } else recordProof(proof);
    await recordAcceptance('quota-ready');
    return true;
  });
  register('restore', async () => {
    verificationSuspended = false;
    const j = await service!.journal();
    if (!j) { await refreshRecovery(); status = recoveryDescription(); void vscode.window.showInformationMessage(status); return; }
    await locks.assertRecovery(j.id);
    const fileOnly = j.backup?.keyringState === 'unobserved';
    if (j.phase === 'restored') {
      try { return await reconcileLogin(undefined, true); } catch (error) { debugSpan?.end('failed', debugErrorData(error)); reloadRequested = true; }
      return false;
    }
    const restoreConsent = tr("liveUi.3417cfe630");
    if (await vscode.window.showWarningMessage(tr("liveUi.ccb82e51cc", { p0: fileOnly ? tr("liveUi.5ad013a479") : tr("liveUi.33f439cf93") }), { modal: true }, restoreConsent) !== restoreConsent) return;
    activeEmail = undefined; activeVerifiedAt = undefined; activeGeneration = undefined;
    const backend = await resolveLifecycle(false);
    await service!.restore(deferred(backend));
    if (backend.restartMode === 'component') return await reconcileLogin();
    return true;
  });
  register('remove', async (argument) => {
    if (await service!.journal() || await locks.hasRecovery()) throw new LiveError('RECOVERY_PENDING');
    const direct = accountArgument(argument, items());
    const selected = direct ? { account: direct } : await vscode.window.showQuickPick(items().map(account => ({ label: account.label, description: account.expectedEmail, account })), { title: tr("liveUi.20cf7b3241") });
    if (!selected) return;
    const removeConsent = tr("liveUi.49283708f3");
    if (await vscode.window.showWarningMessage(tr("liveUi.a1d08d0d5f", { p0: selected.account.expectedEmail }), { modal: true }, removeConsent) !== removeConsent) return;
    const officialPresent = !!vscode.extensions.getExtension(OFFICIAL_ID);
    const current = officialPresent ? await (dependencies.currentIdentity ? dependencies.currentIdentity() : resolveOfficialReadOnlyHub(context).then(backend => backend.freshProof!())) : undefined;
    if (officialPresent && (!current?.authValid || current.quotaSource !== 'server' || !current.email || !Number.isFinite(Date.parse(current.observedAt)))) throw new LiveError('HUB_FRESH_IDENTITY_REQUIRED');
    const removingCurrent = !!current && service!.hostIsCurrent(selected.account) && current.email.toLowerCase() === selected.account.expectedEmail.toLowerCase();
    if (removingCurrent) {
      let replacement: SavedLogin | undefined;
      for (const item of items()) {
        if (item.id === selected.account.id || item.expectedEmail.toLowerCase() === current.email.toLowerCase() || !service!.hostIsCurrent(item) || item.migrationState === 'pending') continue;
        if (await service!.savedLoginUsable(item)) { replacement = item; break; }
      }
      if (replacement) {
        const release = enterAccountChange();
        try {
          if (await switchAccount(replacement.id, true) !== true || pending || activeEmail?.toLowerCase() !== replacement.expectedEmail.toLowerCase()) throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
        } finally { release(); }
      }
      // An explicit removal is not undone by the observer while this same
      // official identity remains logged in. A later identity change clears it.
      await context.globalState.update(removedIdentityKey(), replacement ? undefined : identityHash(selected.account.expectedEmail));
    }
    const secretKeys = [`live-switch.account.v1.${selected.account.id}`, `live-switch.quota-refresh.v1.${selected.account.id}`, `live-switch.quota-pending.v1.${selected.account.id}`];
    for (const key of secretKeys) await context.secrets.delete(key);
    for (const key of secretKeys) if (await context.secrets.get(key) !== undefined) throw new LiveError('SECURE_REMOVE_NOT_VERIFIED');
    await context.globalState.update(INDEX, items().filter(a => a.id !== selected.account.id));
    quotas.delete(selected.account.id);
    await context.globalState.update(`live-switch.quota-consent.v2.${selected.account.id}`, undefined);
    status = tr("liveUi.1902788fe6", { p0: selected.account.label });
    await recordAcceptance('account-removed');
    return true;
  });
  register('acceptance', async () => {
    const uri = await vscode.window.showSaveDialog({ title: tr("liveUi.86e0de1769"), defaultUri: vscode.Uri.file(path.join(os.homedir(), 'antigravity-acceptance.json')), filters: { JSON: ['json'] } });
    if (!uri) return;
    const filename = migrationFilePath(uri);
    // New file only: never overwrite an unrelated result or follow a link.
    await fs.writeFile(filename, acceptanceReport(context.globalState.get('live-switch.acceptance.v1', []), items().length, process.platform, context.extension?.packageJSON?.version), { flag: 'wx', mode: 0o600 });
    status = tr("liveUi.67fe612fc5");
  });
  // Legacy command aliases the same safe automatic reconciliation used on startup.
  // There is no user-facing override for active, foreign or uncertain ownership.
  register('unlock', async () => {
    await locks.withOperation(async () => {
      const journal = await service!.journal();
      await locks.reconcileRecovery?.(journal?.id ?? null);
      await refreshRecovery(true);
    });
  }, true);
  return { refresh, getStatus: () => localizeMessage(status), getAccounts: () => {
    const accounts = items().map(account => ({ ...account, ...(service?.hostIsCurrent ? { hostCurrent: service.hostIsCurrent(account) } : {}) }));
    const currentId = verifiedCurrentAccountId(accounts, activeEmail, pending && !identityVerifiedDuringRecovery);
    return accounts.map(account => ({ ...account, ...(account.id === currentId ? { active: true, ...(activeVerifiedAt ? { activeVerifiedAt } : {}) } : {}), ...(quotas.has(account.id) ? { quota: quotas.get(account.id)! } : {}) }));
  }, getState: () => ({ accountStorageReady: !!service || !!setupError, identityChecking, identityVerifiedDuringRecovery, ...(currentSaveProjection() ? { currentLoginSave: currentSaveProjection()! } : {}), status: !busy && recoveryPhase === 'none' && identityStatus ? localizeMessage(identityStatus) : localizeMessage(status), busy, pending, recoveryPhase, ...(errorMessage ? { error: localizeMessage(errorMessage) } : {}), ...(lastFailure ? { lastFailure } : {}), environment: environmentStatus(), official: officialAvailability(context), ...(storageMode ? { storageMode } : {}), ...(currentQuota ? { currentQuota } : {}), ...(activeEmail ? { activeEmail, ...(activeVerifiedAt ? { activeVerifiedAt } : {}) } : {}) }) };
}
