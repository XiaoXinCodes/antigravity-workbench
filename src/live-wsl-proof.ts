import { fileRouteFailureReason, type FileRouteFailureReason } from './file-route-failure';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { LiveError } from './live-storage';
import { generation, hasOfficialHubApi, type OfficialApi } from './live-hub';

export interface WslHubProcess { pid: number; startTicks: string }
export type WslFileGuard = (allowStopped: boolean) => Promise<boolean>;
export const wslFileRouteError = (reason: FileRouteFailureReason = 'host-mismatch'): LiveError => Object.assign(new LiveError('WSL_FILE_ROUTE_UNVERIFIED'), { fileRouteFailureReason: reason });
const error = wslFileRouteError;
const owned = (uid: number): boolean => typeof process.getuid === 'function' && uid === process.getuid();
const prefix = '^I[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6} +[0-9]+ ';
/** The numeric glog column is a goroutine ID, NOT the OS PID. */
export function explainWslFileRoute(log: string, pid: number, port: number): FileRouteFailureReason | undefined {
  const lines = log.split('\n'); lines.pop(); // An incomplete last line cannot attest anything.
  const starts = lines.filter(line => new RegExp(`${prefix}server\\.go:[0-9]+\\] Starting language server process with pid [0-9]+$`).test(line));
  const ports = lines.filter(line => new RegExp(`${prefix}server\\.go:[0-9]+\\] Language server listening on random port at [0-9]+ for HTTP$`).test(line));
  const routes = lines.filter(line => new RegExp(`${prefix}composite_token_storage\\.go:[0-9]+\\] Using file-based token storage because .+$`).test(line));
  if (starts.length > 1 || ports.length > 1 || routes.length > 1) return 'marker-ambiguity';
  if (!starts.length) return 'pid-marker-missing';
  if (!starts[0]!.endsWith(` pid ${pid}`)) return 'pid-marker-mismatch';
  if (!ports.length) return 'port-marker-missing';
  if (!ports[0]!.endsWith(` at ${port} for HTTP`)) return 'port-marker-mismatch';
  if (!routes.length) return 'filemode-marker-missing';
  if (!routes[0]!.endsWith('because WSL environment detected')) return 'filemode-marker-mismatch';
  if (!(lines.indexOf(starts[0]!) < lines.indexOf(ports[0]!) && lines.indexOf(ports[0]!) < lines.indexOf(routes[0]!))) return 'marker-order';
  return undefined;
}
export function parseWslFileRoute(log: string, pid: number, port: number): boolean {
  return explainWslFileRoute(log, pid, port) === undefined;
}
export async function readWslProcess(executable: string, api: OfficialApi, procRoot = '/proc'): Promise<WslHubProcess> {
  const pids: string[] = [];
  for (const pid of await fs.readdir(procRoot)) {
    if (!/^[1-9][0-9]*$/.test(pid)) continue;
    try { if ((await fs.readFile(`${procRoot}/${pid}/comm`, 'utf8')).trim() === 'agy') pids.push(pid); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ESRCH') throw error(); }
  }
  if (pids.length !== 1) throw error();
  const pid = pids[0]!, base = `${procRoot}/${pid}`;
  if (!owned((await fs.stat(base)).uid)) throw error();
  if (await fs.readlink(`${base}/exe`) !== executable) throw error();
  const bytes = await fs.readFile(`${base}/cmdline`);
  if (bytes.length > 128 * 1024) throw error();
  const args = bytes.toString('utf8').split('\0');
  for (const expected of ['--hub', `--hub-port=${api.port}`, `--csrf_token=${api.csrfToken}`, '--app_data_dir=antigravity']) {
    if (args.filter(arg => arg === expected).length !== 1 || args.filter(arg => arg.split('=')[0] === expected.split('=')[0]).length !== 1) throw error();
  }
  const stat = await fs.readFile(`${base}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (!/^[0-9]+$/.test(fields[19] || '')) throw error();
  return { pid: Number(pid), startTicks: fields[19]! };
}

/** Read-only proof selects this extension host's exact Hub capability. Other
 * windows/CLI processes still prohibit credential mutation, but cannot make a
 * different PID stand in for this Hub. Never return argv or the capability. */
export async function readPinnedWslProcess(executable: string, api: OfficialApi, ownerPid = process.pid, procRoot = '/proc'): Promise<WslHubProcess> {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw error();
  const matches: WslHubProcess[] = [];
  for (const name of await fs.readdir(procRoot)) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const base = path.join(procRoot, name);
    try {
      if ((await fs.readFile(path.join(base, 'comm'), 'utf8')).trim() !== 'agy') continue;
      const bytes = await fs.readFile(path.join(base, 'cmdline'));
      if (bytes.length > 128 * 1024) throw error();
      const args = bytes.toString('utf8').split('\0');
      const expected = ['--hub', `--hub-port=${api.port}`, `--csrf_token=${api.csrfToken}`, '--app_data_dir=antigravity'];
      if (!expected.every(value => args.includes(value))) continue;
      if (!expected.every(value => args.filter(arg => arg.split('=')[0] === value.split('=')[0]).length === 1)) throw error();
      if (!owned((await fs.stat(base)).uid) || await fs.readlink(path.join(base, 'exe')) !== executable) throw error();
      const stat = await fs.readFile(path.join(base, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      if (fields[1] !== String(ownerPid) || !/^[0-9]+$/.test(fields[19] || '')) throw error();
      matches.push({ pid: Number(name), startTicks: fields[19]! });
    } catch (caught) {
      if (!['ENOENT', 'ESRCH'].includes((caught as NodeJS.ErrnoException).code ?? '')) throw error();
    }
  }
  if (matches.length !== 1) throw error();
  return matches[0]!;
}
export async function readWslStartup(home: string, process: WslHubProcess, procRoot = '/proc'): Promise<string> {
  let stage: FileRouteFailureReason = 'directory-permissions';
  try {
    const directory = path.join(home, '.gemini', 'antigravity', 'log');
    for (const dir of [home, path.join(home, '.gemini'), path.join(home, '.gemini', 'antigravity'), directory]) {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat.uid) || stat.mode & 0o022) throw error(stage);
    }
    stage = 'open-log-count';
    const descriptors: { fd: string; file: string }[] = [];
    for (const fd of await fs.readdir(`${procRoot}/${process.pid}/fd`)) {
      const descriptor = `${procRoot}/${process.pid}/fd/${fd}`;
      let file: string; try { file = await fs.readlink(descriptor); } catch { continue; }
      if (path.dirname(file) === directory && /^cli-[0-9]{8}_[0-9]{6}\.log$/.test(path.basename(file)) && !descriptors.some(item => item.file === file)) descriptors.push({ fd: descriptor, file });
    }
    if (descriptors.length !== 1) throw error(stage);
    stage = 'log-file-metadata';
    const { fd, file: filename } = descriptors[0]!, link = await fs.lstat(filename), descriptor = await fs.stat(fd);
    if (!link.isFile() || link.isSymbolicLink() || !owned(link.uid) || link.mode & 0o022) throw error(stage);
    stage = 'inode-mismatch';
    if (link.dev !== descriptor.dev || link.ino !== descriptor.ino) throw error(stage);
    stage = 'log-file-metadata';
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (before.ino !== link.ino || before.dev !== link.dev) throw error('inode-mismatch');
      if (!owned(before.uid)) throw error('log-file-metadata');
      stage = 'read-stability';
      if (before.size < 1) throw error(stage);
      const buffer = Buffer.alloc(Math.min(before.size, 128 * 1024));
      const read = await file.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== buffer.length) throw error(stage);
      const check = Buffer.alloc(buffer.length);
      if ((await file.read(check, 0, check.length, 0)).bytesRead !== check.length || !buffer.equals(check)) throw error(stage);
      const after = await file.stat(), current = await fs.lstat(filename), openDescriptor = await fs.stat(fd);
      if (after.size < before.size || !owned(after.uid) || !owned(current.uid) || after.mode & 0o022 || current.mode & 0o022 || current.isSymbolicLink()) throw error(stage);
      if ([current, openDescriptor].some(stat => stat.ino !== before.ino || stat.dev !== before.dev)) throw error('inode-mismatch');
      return buffer.toString('utf8');
    } finally { await file.close(); }
  } catch (caught) { throw error(fileRouteFailureReason(caught) ?? stage); }
}

export interface WslProofDependencies {
  process?: (executable: string, api: OfficialApi) => Promise<WslHubProcess>;
  startup?: (home: string, process: WslHubProcess) => Promise<string>;
}

/** Read access only. The caller must also pin file bytes and freshly verify the
 * token's account identity. This never authorizes a write or a stopped Hub. */
export type WslReadGuard = (() => Promise<boolean>) & { fileRouteFailureReason?: FileRouteFailureReason };
export function createWslReadGuard(home: string, executable: string, api: () => unknown, dependencies: WslProofDependencies = {}): WslReadGuard {
  const initial = api();
  const expectedGeneration = hasOfficialHubApi(initial) ? generation(initial) : undefined;
  let pinned: WslHubProcess | undefined;
  const guard: WslReadGuard = async () => {
    delete guard.fileRouteFailureReason;
    try {
      const current = api();
      if (!hasOfficialHubApi(current) || generation(current) !== expectedGeneration) throw error();
      const inspect = dependencies.process ?? readPinnedWslProcess;
      const before = await inspect(executable, current);
      if (pinned && (before.pid !== pinned.pid || before.startTicks !== pinned.startTicks)) throw error();
      const reason = explainWslFileRoute(await (dependencies.startup ?? readWslStartup)(home, before), before.pid, current.port);
      if (reason) { guard.fileRouteFailureReason = reason; return false; }
      const after = await inspect(executable, current), latest = api();
      if (after.pid !== before.pid || after.startTicks !== before.startTicks || !hasOfficialHubApi(latest) || generation(latest) !== expectedGeneration) throw error();
      pinned = before;
      return true;
    } catch (caught) { guard.fileRouteFailureReason = fileRouteFailureReason(caught) ?? 'host-mismatch'; throw error(guard.fileRouteFailureReason); }
  };
  return guard;
}
/** Never logs/returns argv, CSRF or log content. Proof is rechecked around every file operation. */
export function createWslFileGuard(home: string, executable: string, api: () => unknown, count: () => Promise<number>, dependencies: WslProofDependencies = {}): WslFileGuard {
  const initial = api();
  const expectedGeneration = hasOfficialHubApi(initial) ? generation(initial) : undefined;
  let pinned: WslHubProcess | undefined;
  return async allowStopped => {
    try {
      const current = api();
      if (!hasOfficialHubApi(current)) {
        // An explicitly file-scoped recovery may proceed only with no live backend.
        return allowStopped && await count() === 0 && !hasOfficialHubApi(api()) && await count() === 0 && !hasOfficialHubApi(api());
      }
      if (generation(current) !== expectedGeneration || await count() !== 1) throw error();
      const inspect = dependencies.process ?? readWslProcess;
      const before = await inspect(executable, current);
      if (pinned && (before.pid !== pinned.pid || before.startTicks !== pinned.startTicks)) throw error();
      if (!parseWslFileRoute(await (dependencies.startup ?? readWslStartup)(home, before), before.pid, current.port)) return false;
      const after = await inspect(executable, current), processCount = await count(), latest = api();
      if (after.pid !== before.pid || after.startTicks !== before.startTicks || !hasOfficialHubApi(latest) || generation(latest) !== expectedGeneration || processCount !== 1) throw error();
      pinned = before;
      return true;
    } catch (caught) { throw error(fileRouteFailureReason(caught)); }
  };
}
