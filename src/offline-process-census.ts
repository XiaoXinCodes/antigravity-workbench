import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LiveError } from './live-storage';
import type { OfflineCensus, OfflineProcess } from './offline-switch';

interface Row { uid: number; startTicks: string; parentPid: number; comm: string; args: string[]; environment: Record<string, string>; unrelated?: boolean }
interface FileScope { directory: string; file: string | null }
interface CensusIO { pids(): Promise<number[]>; boot(): Promise<string>; read(pid: number): Promise<Row>; canonicalHome(home: string): Promise<string>; credentialScope(home: string): Promise<FileScope> }
export interface OfflineLinuxCensusOptions {
  uid: number; home: string; knownHosts: readonly OfflineProcess[];
  scope: 'file-only' | 'native-keyring'; io?: CensusIO;
}
const gone = (error: unknown): boolean => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
const failure = (): LiveError => new LiveError('OFFLINE_CENSUS_UNVERIFIED');
const entrypoints = new Set(['vs/workbench/api/node/extensionHostProcess', 'vs/workbench/api/node/extensionHostProcess.js']);
function stat(raw: string): { startTicks: string; parentPid: number } {
  const end = raw.lastIndexOf(') '), fields = raw.slice(end + 2).trim().split(/\s+/);
  if (end < 3 || !/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[1] ?? '')) throw failure();
  return { startTicks: fields[19]!, parentPid: Number(fields[1]) };
}
function selectedEnvironment(bytes: Buffer): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const row of bytes.toString('utf8').split('\0')) {
    const i = row.indexOf('='); if (i < 0) continue;
    const name = row.slice(0, i);
    const relevant = name === 'HOME' || name === 'VSCODE_ESM_ENTRYPOINT' || name === 'VSCODE_AMD_ENTRYPOINT' || /^(?:AGY_|ANTIGRAVITY_|JETSKI_|GOOGLE_|GEMINI_|CODEIUM_|WINDSURF_|CLOUD_|XDG_|APPDATA$|LOCALAPPDATA$)/.test(name);
    if (!relevant) continue;
    if (Object.hasOwn(result, name)) throw failure();
    // Override values may be credentials. Retain only presence, never values.
    result[name] = name === 'HOME' || name.startsWith('VSCODE_') ? row.slice(i + 1) : 'present';
  }
  return result;
}
// Actual kernel executable identity, not argv or comm, authorizes this narrow
// exclusion. Unreadable or user-writable images are never silently skipped.
async function trustedSystemImage(base: string, files: typeof fs): Promise<string | undefined> {
  try {
    const link = await files.readlink(path.join(base, 'exe'));
    if (!['/usr/lib/systemd/systemd', '/lib/systemd/systemd'].includes(link)) return undefined;
    const executable = await files.realpath(link);
    if (!['/usr/lib/systemd/systemd', '/lib/systemd/systemd'].includes(executable)) return undefined;
    const image = await files.stat(path.join(base, 'exe')), trusted = await files.lstat(executable);
    if (!image.isFile() || !trusted.isFile() || trusted.isSymbolicLink() || image.uid !== 0 || trusted.uid !== 0 ||
        (image.mode & 0o022) || (trusted.mode & 0o022) || image.dev !== trusted.dev || image.ino !== trusted.ino || image.ctimeMs !== trusted.ctimeMs) return undefined;
    for (let directory = path.dirname(executable); ; directory = path.dirname(directory)) {
      const info = await files.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) return undefined;
      if (directory === path.dirname(directory)) break;
    }
    return `${executable}:${image.dev}:${image.ino}:${image.ctimeMs}:${image.size}`;
  } catch { return undefined; }
}
// This is a cross-checked service role, not executable-image attestation.
// Active malicious same-UID programs can already modify the credential store;
// defending arbitrary forged argv/cgroups is outside the offline census boundary.
async function systemServiceRole(pid: number, uid: number, files: typeof fs, rejected: (reason: string) => void = () => {}): Promise<string | undefined> {
  const reject = (reason: string): undefined => { rejected(reason); return undefined; };
  try {
    const metadata = async (id: number) => {
      const base = `/proc/${id}`;
      const owner = (await files.stat(base)).uid;
      const birth = stat(await files.readFile(path.join(base, 'stat'), 'utf8'));
      const comm = (await files.readFile(path.join(base, 'comm'), 'utf8')).trim();
      const argv = (await files.readFile(path.join(base, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
      const raw = await files.readFile(path.join(base, 'cgroup'), 'utf8');
      if (raw.length > 128 * 1024 || argv.join('').length > 128 * 1024) throw failure();
      const groups = raw.trim().split('\n').filter(line => line.startsWith('0::') || /^[^:]+:[^:]*\bname=systemd(?:,|:)/.test(line))
        .map(line => line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1));
      if (!groups.length || groups.some(group => group !== groups[0])) throw failure();
      return { id, owner, ...birth, comm, argv, group: groups[0] };
    };
    const child = await metadata(pid);
    if (child.owner !== uid) return reject('OWNER_MISMATCH');
    const manager = child.comm === '(sd-pam)' ? await metadata(child.parentPid) : child;
    const expectedGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/init.scope`;
    if (manager.owner !== uid || manager.comm !== 'systemd' || manager.parentPid !== 1 || manager.group !== expectedGroup ||
        manager.argv.length !== 2 || manager.argv[1] !== '--user' || !['/usr/lib/systemd/systemd', '/lib/systemd/systemd'].includes(manager.argv[0]!)) return reject('MANAGER_ROLE_MISMATCH');
    if (child !== manager && (child.argv.length !== 1 || child.argv[0] !== '(sd-pam)' || child.group !== manager.group)) return reject('PAM_ROLE_MISMATCH');
    const init = await metadata(1);
    if (init.owner !== 0 || init.comm !== 'systemd') return reject('INIT_ROLE_MISMATCH');
    const executable = await files.realpath(manager.argv[0]!);
    if (!['/usr/lib/systemd/systemd', '/lib/systemd/systemd'].includes(executable)) return reject('INSTALLATION_UNVERIFIED');
    const image = await files.lstat(executable);
    if (!image.isFile() || image.isSymbolicLink() || image.uid !== 0 || (image.mode & 0o022)) return reject('INSTALLATION_UNVERIFIED');
    for (let dir = path.dirname(executable); ; dir = path.dirname(dir)) {
      const info = await files.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) return reject('INSTALLATION_UNVERIFIED');
      if (dir === path.dirname(dir)) break;
    }
    return JSON.stringify({ child, manager, init, executable, dev: image.dev, ino: image.ino, ctime: image.ctimeMs });
  } catch {
    // A missing parent/install path is NOT evidence that the child exited.
    // Fall back to the ordinary environment read, retaining its fail-closed rule.
    return reject('ROLE_METADATA_UNAVAILABLE');
  }
}
/** Read-only operator diagnostic: fixed categories only, no proc values or secrets. */
export async function inspectOfflineSystemServiceRole(pid: number, uid: number): Promise<{ matches: boolean; reason: string }> {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(uid) || uid < 0) throw failure();
  let reason = 'ROLE_MATCH';
  const first = await systemServiceRole(pid, uid, fs, value => { reason = value; });
  const second = first ? await systemServiceRole(pid, uid, fs, value => { reason = value; }) : undefined;
  return { matches: Boolean(first && first === second), reason: first && second && first !== second ? 'ROLE_CHANGED' : reason };
}
export async function readOfflineLinuxProcess(pid: number, uid: number, knownHost: boolean, files: typeof fs = fs): Promise<Row> {
  const base = `/proc/${pid}`, owner = (await files.stat(base)).uid;
  if (owner !== uid) return { uid: owner, startTicks: '0', parentPid: 0, comm: '', args: [], environment: {} };
  const before = stat(await files.readFile(path.join(base, 'stat'), 'utf8'));
  const bounded = async (name: string): Promise<Buffer> => {
    const handle = await files.open(path.join(base, name), 'r');
    try {
      const bytes = Buffer.alloc(128 * 1024 + 1); let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total === bytes.length) throw failure();
      return bytes.subarray(0, total);
    }
    finally { await handle.close(); }
  };
  const args = await bounded('cmdline'), comm = (await files.readFile(path.join(base, 'comm'), 'utf8')).trim();
  const argumentsList = args.toString('utf8').split('\0').filter(Boolean);
  // Names only select a proof attempt. They never authorize exclusion.
  const image = !knownHost && ['systemd', '(sd-pam)'].includes(comm) && !argumentsList.includes('--type=extensionHost')
    ? await trustedSystemImage(base, files) : undefined;
  const role = !image && !knownHost && ['systemd', '(sd-pam)'].includes(comm) && !argumentsList.includes('--type=extensionHost')
    ? await systemServiceRole(pid, uid, files) : undefined;
  const env = image || role ? undefined : await bounded('environ');
  const after = stat(await files.readFile(path.join(base, 'stat'), 'utf8'));
  if (JSON.stringify(before) !== JSON.stringify(after) || owner !== (await files.stat(base)).uid ||
      !args.equals(await bounded('cmdline')) || comm !== (await files.readFile(path.join(base, 'comm'), 'utf8')).trim() ||
      (env && !env.equals(await bounded('environ'))) || (image && image !== await trustedSystemImage(base, files)) ||
      (role && role !== await systemServiceRole(pid, uid, files))) throw failure();
  return { uid: owner, ...after, args: argumentsList, environment: env ? selectedEnvironment(env) : {}, comm, ...(image || role ? { unrelated: true } : {}) };
}
function nativeIO(uid: number, knownHosts: readonly OfflineProcess[]): CensusIO {
  return {
    pids: async () => (await fs.readdir('/proc')).filter(v => /^[1-9][0-9]*$/.test(v)).map(Number),
    boot: async () => (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    canonicalHome: home => fs.realpath(home),
    credentialScope: async home => {
      const directory = path.join(home, '.gemini'), dir = await fs.stat(directory, { bigint: true });
      if (!dir.isDirectory()) throw failure();
      let file: string | null = null;
      try {
        const token = await fs.stat(path.join(directory, 'jetski-standalone-oauth-token'), { bigint: true });
        if (!token.isFile()) throw failure();
        file = `${token.dev}:${token.ino}`;
      } catch (error) { if (!gone(error)) throw error; }
      return { directory: `${dir.dev}:${dir.ino}`, file };
    },
    read: pid => readOfflineLinuxProcess(pid, uid, knownHosts.some(host => host.pid === pid)),
  };
}
/** Read-only closure census for a user-confirmed offline operation. No killing,
 * no capability output, no account reads. Covers normal Linux/WSL host launch
 * markers plus directly probed known births. It does not enforce no-new-window.
 * Native keyring scope spans same-user HOME values; file-only scope requires a
 * separately verified offline file route before this adapter may be used. */
export async function inspectOfflineLinuxProcesses(options: OfflineLinuxCensusOptions): Promise<OfflineCensus> {
  const result: OfflineCensus = { complete: true, unknown: false, hosts: [], hubs: [] };
  if (!Number.isSafeInteger(options.uid) || options.uid < 0 || !path.isAbsolute(options.home) ||
      !['file-only', 'native-keyring'].includes(options.scope) || !options.io && process.platform !== 'linux') throw failure();
  const io = options.io ?? nativeIO(options.uid, options.knownHosts);
  try {
    const boot = await io.boot();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)) throw failure();
    const home = await io.canonicalHome(options.home);
    const scope = options.scope === 'file-only' ? await io.credentialScope(home) : undefined;
    const pids = new Set([...await io.pids(), ...options.knownHosts.map(v => v.pid)]);
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid < 1) throw failure();
      let row: Row;
      try { row = await io.read(pid); }
      catch (error) { if (!gone(error)) { result.complete = false; result.unknown = true; } continue; }
      try {
        if (row.uid !== options.uid) continue;
        const identity = { pid, startIdentity: `linux:${boot}:${row.startTicks}` };
        const known = options.knownHosts.some(v => v.pid === pid && v.startIdentity === identity.startIdentity);
        if (row.unrelated && !known) continue;
        const host = known || row.args.includes('--type=extensionHost') ||
          entrypoints.has(row.environment.VSCODE_ESM_ENTRYPOINT ?? '') || entrypoints.has(row.environment.VSCODE_AMD_ENTRYPOINT ?? '');
        const hub = row.comm === 'agy' || row.comm === 'agy.exe';
        if (!host && !hub) continue;
        if (known) { result.hosts.push(identity); continue; }
        // Config/auth overrides prevent claiming a distinct credential scope.
        const overrides = Object.keys(row.environment).some(name => name !== 'HOME' && !name.startsWith('VSCODE_') &&
          !['AGY_ENABLE_HUB', 'ANTIGRAVITY_VSCODE_HOST', 'ANTIGRAVITY_AUTH_SUCCESS_APP'].includes(name));
        // Overrides disable scope exclusion: include this host regardless of
        // HOME, rather than making an otherwise identifiable host unknowable.
        if (options.scope === 'file-only' && !overrides) {
          const rowHome = row.environment.HOME;
          if (!rowHome || !path.isAbsolute(rowHome)) { result.unknown = true; continue; }
          const actualHome = await io.canonicalHome(rowHome);
          if (actualHome !== home) {
            const other = await io.credentialScope(actualHome);
            // Different HOME paths can share .gemini via symlinks/bind mounts,
            // or the token via a hard link. Only positively distinct identities
            // permit exclusion from a file-only transaction.
            if (other.directory !== scope!.directory) {
              if (other.file !== null && scope!.file !== null && other.file !== scope!.file) continue;
              // null may represent a dangling symlink whose target will appear
              // during our write. Missing file identity cannot prove disjointness.
              if (other.file === null || scope!.file === null) result.unknown = true;
            }
          }
        }
        if (host) result.hosts.push(identity);
        if (hub) result.hubs.push(identity);
      } catch { result.complete = false; result.unknown = true; }
    }
    if (await io.boot() !== boot) throw failure();
  } catch { result.complete = false; result.unknown = true; }
  return result;
}
