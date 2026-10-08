import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hasOfficialHubApi, type OfficialApi } from './live-hub';
import { LiveError } from './live-storage';

export interface OfficialProcessIdentity { pid: number; startTicks: string }
interface WslProcess extends OfficialProcessIdentity {
  parentPid: number;
  kind: 'current-hub' | 'unowned-hub' | 'unverified';
  // A listening socket, parent exit or low CPU is not evidence that tasks ended.
  taskState: 'unknown';
}
export interface WslProcessSnapshot { processes: WslProcess[]; current?: WslProcess }
const failed = (): LiveError => new LiveError('PROCESS_CHECK_FAILED');
function processStat(raw: string): { parentPid: number; startTicks: string; state: string } {
  const end = raw.lastIndexOf(') ');
  if (!/^[1-9][0-9]* \(/.test(raw) || end < 3) throw failed();
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(fields[0] ?? '') || !/^(0|[1-9][0-9]*)$/.test(fields[1] ?? '') || !/^[0-9]+$/.test(fields[19] ?? '')) throw failed();
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid)) throw failed();
  return { parentPid, startTicks: fields[19]!, state: fields[0]! };
}
function single(args: string[], flag: string, value: string): boolean {
  return args.filter(arg => arg.split('=')[0] === flag).length === 1 && args.includes(`${flag}=${value}`);
}
function flagValue(args: string[], flag: string): string | undefined {
  const values = args.filter(arg => arg.split('=')[0] === flag);
  return values.length === 1 && values[0]!.startsWith(`${flag}=`) ? values[0]!.slice(flag.length + 1) : undefined;
}
/** WSL native process proof only. Never exports argv, CSRF, logs or task content.
 * Keep every live agy as a mutation blocker unless it is this exact owned Hub.
 * No idle RPC is guessed, and no orphan/foreign process is terminated here. */
export async function inspectWslProcesses(executable: string, api?: OfficialApi, ownerPid = process.pid, procRoot = '/proc'): Promise<WslProcessSnapshot> {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || typeof process.getuid !== 'function') throw failed();
  const processes: WslProcess[] = [];
  try {
    for (const name of await fs.readdir(procRoot)) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      const pid = Number(name), base = path.join(procRoot, name);
      if (!Number.isSafeInteger(pid)) throw failed();
      try {
        if ((await fs.readFile(path.join(base, 'comm'), 'utf8')).trim() !== 'agy') continue;
        const before = processStat(await fs.readFile(path.join(base, 'stat'), 'utf8'));
        const uid = (await fs.stat(base)).uid, realExecutable = await fs.readlink(path.join(base, 'exe'));
        const bytes = await fs.readFile(path.join(base, 'cmdline'));
        if (bytes.length > 128 * 1024) throw failed();
        const args = bytes.toString('utf8').split('\0');
        const after = processStat(await fs.readFile(path.join(base, 'stat'), 'utf8'));
        if (before.startTicks !== after.startTicks || before.parentPid !== after.parentPid || uid !== (await fs.stat(base)).uid || realExecutable !== await fs.readlink(path.join(base, 'exe')) || !bytes.equals(await fs.readFile(path.join(base, 'cmdline')))) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        const advertised = { port: Number(flagValue(args, '--hub-port')), csrfToken: flagValue(args, '--csrf_token') };
        const officialHub = uid === process.getuid() && realExecutable === executable && args.filter(arg => arg.split('=')[0] === '--hub').length === 1 && args.includes('--hub') &&
          single(args, '--app_data_dir', 'antigravity') && hasOfficialHubApi(advertised) && single(args, '--hub-port', String(advertised.port));
        const matches = officialHub && hasOfficialHubApi(api) && single(args, '--hub-port', String(api.port)) && single(args, '--csrf_token', api.csrfToken);
        const kind = matches && after.parentPid === ownerPid ? 'current-hub' : officialHub ? 'unowned-hub' : 'unverified';
        processes.push({ pid, parentPid: after.parentPid, startTicks: after.startTicks, kind, taskState: 'unknown' });
      } catch (error) {
        // An exit while enumerating is benign; inaccessible/changed proof is not.
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  } catch (error) { if (error instanceof LiveError) throw error; throw failed(); }
  const current = processes.filter(item => item.kind === 'current-hub');
  if (current.length > 1) throw new LiveError('OFFICIAL_HUB_PROCESS_UNVERIFIED');
  return { processes, ...(current[0] ? { current: current[0] } : {}) };
}
export function sameOfficialProcess(a: OfficialProcessIdentity, b: OfficialProcessIdentity): boolean {
  return a.pid === b.pid && a.startTicks === b.startTicks;
}
export function assertWslProcessExclusivity(snapshot: WslProcessSnapshot, running: boolean): void {
  if (snapshot.processes.some(item => item.kind === 'unowned-hub')) throw new LiveError('OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN');
  if (snapshot.processes.some(item => item.kind === 'unverified')) throw new LiveError('OFFICIAL_PROCESS_OWNERSHIP_UNVERIFIED');
  if (running && !snapshot.current) throw new LiveError('OFFICIAL_HUB_PROCESS_UNVERIFIED');
}
interface StopRuntime {
  assertCurrent(): void; stopped(): Promise<boolean>;
  wait?(ms: number): Promise<void>; now?(): number; timeoutMs?: number;
}
/** The official stop hook may return before its child closes. Observe completion
 * twice under a deadline; never kill by name, fabricate idle, or restart on timeout. */
export async function waitForOfficialBackendStop(runtime: StopRuntime): Promise<void> {
  const timeout = runtime.timeoutMs ?? 10_000, now = runtime.now ?? Date.now;
  const wait = runtime.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const until = now() + timeout;
  let expired = false, timer: NodeJS.Timeout | undefined;
  const poll = async (): Promise<void> => {
    let stable = false;
    do {
      runtime.assertCurrent();
      const stopped = await runtime.stopped();
      runtime.assertCurrent();
      if (expired || now() >= until) break;
      if (stopped && stable) return;
      stable = stopped;
      await wait(100);
    } while (!expired && now() < until);
    throw new LiveError('OFFICIAL_BACKEND_STOP_TIMEOUT');
  };
  try {
    await Promise.race([poll(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new LiveError('OFFICIAL_BACKEND_STOP_TIMEOUT')); }, timeout);
    })]);
  } finally { expired = true; clearTimeout(timer); }
}
