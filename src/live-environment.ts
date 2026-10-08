import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { WslFileGuard } from './live-wsl-proof';
import { LiveError, OfficialTokenSlots, SystemKeyring, validateSlotScope, type Keyring, type Slots, type TokenSlots } from './live-storage';

export type OfficialStorageMode = 'wsl-file' | 'native-keyring';
export type OfficialStorageAccess = 'capture' | 'mutation';
type KernelReleaseReader = () => Promise<string>;
const readKernelRelease: KernelReleaseReader = () => fs.readFile('/proc/sys/kernel/osrelease', 'utf8');

/** Host preference only; actual WSL storage access also requires live route proof. */
export async function resolveOfficialStorageMode(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  readRelease: KernelReleaseReader = readKernelRelease,
): Promise<OfficialStorageMode> {
  if (platform !== 'linux') return 'native-keyring';
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return 'wsl-file';
  try {
    const release = (await readRelease()).toLowerCase();
    if (release.includes('microsoft') || release.includes('wsl')) return 'wsl-file';
  } catch { /* The official detector also returns false when this file cannot be read. */ }
  return 'native-keyring';
}

/** Validate the executable container, not its release fingerprint or storage contract.
 * The live process/startup proof and credential schema guard actual file access. */
export async function assertWslBackendExecutable(executable: string): Promise<void> {
  const limit = 512 * 1024 * 1024;
  try {
    const link = await fs.lstat(executable);
    if (!link.isFile() || link.isSymbolicLink() || link.size < 52 || link.size > limit) throw new LiveError('OFFICIAL_WSL_EXECUTABLE_INVALID');
    const file = await fs.open(executable, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.ino !== link.ino || before.dev !== link.dev || before.size !== link.size || before.mtimeMs !== link.mtimeMs || before.ctimeMs !== link.ctimeMs) throw new LiveError('OFFICIAL_WSL_EXECUTABLE_INVALID');
      const header = Buffer.alloc(Math.min(64, before.size));
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || ![1, 2].includes(header[4]!) || ![1, 2].includes(header[5]!) || header[6] !== 1) throw new LiveError('OFFICIAL_WSL_EXECUTABLE_INVALID');
      const u16 = (offset: number): number => header[5] === 1 ? header.readUInt16LE(offset) : header.readUInt16BE(offset);
      const headerSize = header[4] === 1 ? 52 : 64;
      if (before.size < headerSize || ![2, 3].includes(u16(16)) || u16(18) === 0 || u16(header[4] === 1 ? 40 : 52) !== headerSize) throw new LiveError('OFFICIAL_WSL_EXECUTABLE_INVALID');
      const after = await file.stat(), current = await fs.lstat(executable);
      if (after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !current.isFile() || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new LiveError('OFFICIAL_WSL_EXECUTABLE_INVALID');
    } finally { await file.close(); }
  } catch { throw new LiveError('OFFICIAL_WSL_EXECUTABLE_INVALID'); }
}

export interface EnvironmentStorageDependencies {
  readKernelRelease?: KernelReleaseReader;
  createKeyring?: (platform: NodeJS.Platform) => Keyring;
  fileOnlyGuard?: WslFileGuard;
}
export interface EnvironmentSlots extends Slots { readonly storageMode: OfficialStorageMode }

// null means deliberately bypassed in this mode. It never claims the OS keyring
// is empty, and no operation may clear or overwrite an inaccessible keyring.
const bypassedKeyring: Keyring = {
  async read() { return null; },
  async write(value) { if (value !== null) throw new LiveError('OFFICIAL_STORAGE_MODE_MISMATCH'); },
};

export async function createOfficialTokenSlots(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: EnvironmentStorageDependencies = {},
  access: OfficialStorageAccess = 'capture',
): Promise<EnvironmentSlots> {
  const mode = (): Promise<OfficialStorageMode> => resolveOfficialStorageMode(platform, env, dependencies.readKernelRelease);
  const storageMode = await mode();
  // A WSL label is only a preference; a bound live-hub proof selects file scope.
  // Native snapshots remain available for old full-slot recovery journals.
  let native: OfficialTokenSlots | undefined;
  const nativeSlots = (): OfficialTokenSlots => native ??= new OfficialTokenSlots(home, dependencies.createKeyring?.(platform) ?? new SystemKeyring(platform));
  const fileSlots = new OfficialTokenSlots(home, bypassedKeyring);
  const checkMode = async (): Promise<void> => {
    if (await mode() !== storageMode) throw new LiveError('OFFICIAL_STORAGE_MODE_CHANGED');
  };
  const fileScope = async (scope?: TokenSlots): Promise<boolean> => {
    if (scope) validateSlotScope(scope);
    if (storageMode !== 'wsl-file') {
      if (scope?.keyringState) throw new LiveError('OFFICIAL_STORAGE_SCOPE_MISMATCH');
      return false;
    }
    if (access === 'capture') return true;
    if (scope && !scope.keyringState) return false; // Never downgrade a real keyring backup.
    try {
      if (await dependencies.fileOnlyGuard?.(scope?.keyringState === 'unobserved')) return true;
    } catch (e) { if (scope?.keyringState) throw e; }
    if (scope?.keyringState) throw new LiveError('WSL_FILE_ROUTE_UNVERIFIED');
    return false;
  };
  return {
    storageMode,
    async read(scope?: TokenSlots) {
      await checkMode();
      const onlyFile = await fileScope(scope);
      let value: TokenSlots;
      try { value = onlyFile ? { ...await fileSlots.read(), keyringState: 'unobserved' as const } : await nativeSlots().read(); }
      catch (e) {
        if (storageMode === 'wsl-file' && access === 'mutation' && !scope && dependencies.fileOnlyGuard && e instanceof LiveError && ['KEYRING_UNAVAILABLE', 'NATIVE_HELPER_UNAVAILABLE'].includes(e.code)) throw new LiveError('WSL_FILE_ROUTE_UNVERIFIED');
        throw e;
      }
      await checkMode();
      if (onlyFile && access === 'mutation' && !await fileScope(value)) throw new LiveError('WSL_FILE_ROUTE_UNVERIFIED');
      return value;
    },
    async write(value: TokenSlots, expected: TokenSlots) {
      await checkMode(); validateSlotScope(value); validateSlotScope(expected);
      if (access === 'capture' && storageMode === 'wsl-file') {
        if (value.keyring !== null || expected.keyring !== null) throw new LiveError('OFFICIAL_STORAGE_MODE_MISMATCH');
        throw new LiveError('OFFICIAL_STORAGE_CAPTURE_ONLY');
      }
      if (value.keyringState !== expected.keyringState) throw new LiveError('OFFICIAL_STORAGE_SCOPE_MISMATCH');
      const onlyFile = await fileScope(expected);
      if (onlyFile) {
        await fileSlots.write({ keyring: null, file: value.file }, { keyring: null, file: expected.file });
        if (!await fileScope(expected)) throw new LiveError('WSL_FILE_ROUTE_UNVERIFIED');
      } else await nativeSlots().write(value, expected);
      await checkMode();
    },
  };
}

/** Activation is passive. The first mode/read/write request pins this host's mode. */
export class EnvironmentTokenSlots implements Slots {
  private resolved: Promise<EnvironmentSlots> | undefined;
  constructor(
    private readonly home: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly dependencies: EnvironmentStorageDependencies = {},
    private readonly access: OfficialStorageAccess = 'capture',
  ) {}
  private resolve(): Promise<EnvironmentSlots> {
    return this.resolved ??= createOfficialTokenSlots(this.home, this.platform, this.env, this.dependencies, this.access);
  }
  async mode(): Promise<OfficialStorageMode> { return (await this.resolve()).storageMode; }
  async read(scope?: TokenSlots): Promise<TokenSlots> { return (await this.resolve()).read(scope); }
  async write(value: TokenSlots, expected: TokenSlots): Promise<void> { await (await this.resolve()).write(value, expected); }
}
