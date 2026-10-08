import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { generation, hasOfficialHubApi } from './live-hub';
import { inspectWslProcesses } from './official-process';
import { LiveError, runPrivate } from './live-storage';
import { LINUX_PROCESS_HELPER } from './official-process-helper';
import { WINDOWS_PROCESS_BOOTSTRAP, WINDOWS_PROCESS_HELPER } from './official-process-windows';

export interface ProcessConflict {
  id: string; pid: number; parentPid?: number; startedAt?: string;
  owner: 'current' | 'other' | 'detached' | 'unknown';
  parentState: 'alive' | 'gone' | 'unknown'; taskState: 'unknown'; canEnd: boolean;
  endMode?: 'force';
}
export interface ProcessConflictState {
  phase: 'blocked' | 'clear'; processes: ProcessConflict[];
  limitation?: 'platform' | 'helper' | 'windows-helper'; canContinue: boolean;
}
interface Target {
  pid: number; parentPid: number; startTicks?: string; bootId?: string; commandHash?: string; platform?: 'win32';
  kind: 'current-hub' | 'unowned-hub' | 'unverified';
  parentState: 'alive' | 'gone' | 'unknown'; startedAt?: string; canEnd: boolean;
}
type HelperRequest = Record<string, unknown>;
export interface ProcessRecoveryRuntime {
  platform?: NodeJS.Platform; executable?: string; ownerPid?: number;
  api(): unknown; assertCurrent(): void;
  helper?(request: HelperRequest, signal?: AbortSignal, authorize?: () => void): Promise<unknown>;
  nativeRun?: typeof runPrivate;
  inspect?: typeof inspectWslProcesses;
}
/** The only subprocess we may cancel here is the helper we created. Target
 * signals happen exclusively through its validated, held pidfd. */
export function runProcessHelper(request: HelperRequest, signal?: AbortSignal, authorize?: () => void): Promise<unknown> {
  return runHelper('/usr/bin/python3', ['-I', '-c', LINUX_PROCESS_HELPER], request, signal, authorize);
}
export function windowsPowerShell(): string {
  const system = process.arch === 'ia32' && process.env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32';
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
export function runWindowsProcessHelper(request: HelperRequest, signal?: AbortSignal, authorize?: () => void): Promise<unknown> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) if (process.env[name]) env[name] = process.env[name];
  return runHelper(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PROCESS_BOOTSTRAP, 'utf16le').toString('base64')], request, signal, authorize, { stages: ['force'], prefix: `${Buffer.from(WINDOWS_PROCESS_HELPER).toString('base64')}\n`, env, timeout: 20_000 });
}
function runHelper(executable: string, args: string[], request: HelperRequest, signal?: AbortSignal, authorize?: () => void, options: { stages?: string[]; prefix?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new LiveError('OFFICIAL_PROCESS_END_CANCELLED'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? {}, windowsHide: true });
    let output = '', totalBytes = 0, settled = false, result: unknown, resultSeen = false, stage = 0;
    const finish = (error?: LiveError, value?: unknown): void => {
      if (settled) return; settled = true; clearTimeout(timer); clearInterval(watchdog); signal?.removeEventListener('abort', abort);
      child.stdin.destroy(); if (child.exitCode === null) child.kill();
      if (error) reject(error); else resolve(value);
    };
    const abort = (): void => finish(new LiveError('OFFICIAL_PROCESS_END_CANCELLED'));
    const timer = setTimeout(() => finish(new LiveError('OFFICIAL_BACKEND_STOP_TIMEOUT')), options.timeout ?? 12_000);
    const check = (): boolean => {
      try { authorize?.(); return true; }
      catch (error) { finish(error instanceof LiveError ? error : new LiveError('PROCESS_CHECK_FAILED')); return false; }
    };
    // Stop our own helper when the host becomes stale during the exit wait.
    const watchdog = setInterval(() => { if (!settled && authorize) check(); }, 50);
    child.stdout.on('data', (bytes: Buffer) => {
      if (settled) return;
      totalBytes += bytes.length; output += bytes.toString('utf8');
      if (totalBytes > 256 * 1024) { finish(new LiveError('PROCESS_CHECK_FAILED')); return; }
      let newline: number;
      while (!settled && (newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const message = object(JSON.parse(line));
          if ('authorize' in message) {
            if (request.operation !== 'end' || !authorize || resultSeen || Object.keys(message).length !== 1 || message.authorize !== (options.stages ?? ['term', 'force'])[stage]) throw new LiveError('PROCESS_CHECK_FAILED');
            if (!check()) return;
            ++stage; child.stdin.write('continue\n');
          } else {
            if (resultSeen) throw new LiveError('PROCESS_CHECK_FAILED');
            resultSeen = true; result = message;
            // PowerShell's command pipeline waits for redirected stdin EOF even
            // after our script returns. Only a final result ends this channel;
            // authorization frames must keep it open for cancellation checks.
            child.stdin.end();
          }
        } catch (error) { finish(error instanceof LiveError ? error : new LiveError('PROCESS_CHECK_FAILED')); }
      }
    });
    child.stderr.resume(); // Never return helper exceptions or private process arguments.
    child.stdin.on('error', () => { /* close/error handlers own the fixed result */ });
    child.on('error', () => finish(new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE')));
    child.on('close', code => {
      if (signal?.aborted) { abort(); return; }
      if (code !== 0) { finish(new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE')); return; }
      if (!resultSeen || output.length) { finish(new LiveError('PROCESS_CHECK_FAILED')); return; }
      if (check()) finish(undefined, result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    // Keep stdin open: EOF is cancellation, including an extension-host crash.
    child.stdin.write(`${options.prefix ?? ''}${JSON.stringify(request)}\n`);
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiveError('PROCESS_CHECK_FAILED');
  return value as Record<string, unknown>;
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
function target(value: unknown, platform: NodeJS.Platform): Target {
  const row = object(value);
  if (!integer(row.pid) || typeof row.parentPid !== 'number' || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 ||
    !['current-hub', 'unowned-hub', 'unverified'].includes(String(row.kind)) || !['alive', 'gone', 'unknown'].includes(String(row.parentState)) || typeof row.canEnd !== 'boolean') throw new LiveError('PROCESS_CHECK_FAILED');
  if (row.kind !== 'unverified' && (typeof row.startTicks !== 'string' || !/^\d{1,30}$/.test(row.startTicks) || typeof row.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.commandHash) || (platform === 'win32' ? row.platform !== 'win32' || row.bootId !== undefined : typeof row.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.bootId)))) throw new LiveError('PROCESS_CHECK_FAILED');
  return { pid: row.pid, parentPid: row.parentPid,
    ...(typeof row.startTicks === 'string' ? { startTicks: row.startTicks } : {}), ...(typeof row.bootId === 'string' ? { bootId: row.bootId } : {}), ...(typeof row.commandHash === 'string' ? { commandHash: row.commandHash } : {}), ...(platform === 'win32' ? { platform: 'win32' } : {}),
    kind: row.kind as Target['kind'], parentState: row.parentState as Target['parentState'], canEnd: row.canEnd && row.kind === 'unowned-hub', ...(iso(row.startedAt) ? { startedAt: row.startedAt } : {}) };
}
/** Selection IDs and complete process proof live only in the host. No UI message
 * can choose a PID, command, path or signal. Every scan invalidates old IDs. */
export class OfficialProcessRecovery {
  private readonly targets = new Map<string, Target>();
  private selectedGeneration: string | undefined;
  private revision = 0;
  private ending = false;
  private readonly platform: NodeJS.Platform;
  private readonly executable: string;
  constructor(private readonly runtime: ProcessRecoveryRuntime) {
    this.platform = runtime.platform ?? process.platform;
    this.executable = runtime.executable ?? path.join(os.homedir(), '.gemini', 'bin', this.platform === 'win32' ? 'agy.exe' : 'agy');
  }
  private request(operation: string): HelperRequest {
    const api = this.runtime.api();
    return { operation, executable: this.executable, home: os.homedir(), ownerPid: this.runtime.ownerPid ?? process.pid, ...(hasOfficialHubApi(api) ? { port: api.port, csrfToken: api.csrfToken } : {}) };
  }
  private currentGeneration(): string { const api = this.runtime.api(); return hasOfficialHubApi(api) ? generation(api) : 'stopped'; }
  private helper(): NonNullable<ProcessRecoveryRuntime['helper']> { return this.runtime.helper ?? (this.platform === 'win32' ? runWindowsProcessHelper : runProcessHelper); }
  invalidate(): void { ++this.revision; this.targets.clear(); this.selectedGeneration = undefined; }
  async scan(): Promise<ProcessConflictState> {
    if (this.ending) throw new LiveError('OFFICIAL_PROCESS_SELECTION_STALE');
    this.invalidate(); this.runtime.assertCurrent();
    const revision = this.revision;
    const before = this.currentGeneration();
    let rows: Target[] = [], fallback: ProcessConflict[] = [], limitation: ProcessConflictState['limitation'], inspected = true;
    if (this.platform === 'linux' || this.platform === 'win32') {
      try {
        const value = object(await this.helper()(this.request('scan')));
        if (value.code === 'OFFICIAL_PROCESS_END_UNAVAILABLE') throw new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE');
        if (!Array.isArray(value.processes) || value.processes.length > 1024) throw new LiveError('PROCESS_CHECK_FAILED');
        rows = value.processes.map(row => target(row, this.platform));
        if (value.supported !== true || rows.some(row => row.kind !== 'current-hub' && !row.canEnd)) limitation = this.platform === 'win32' ? 'windows-helper' : 'helper';
        if (value.supported !== true) rows = rows.map(row => ({ ...row, canEnd: false }));
      } catch (error) {
        if (!(error instanceof LiveError) || error.code !== 'OFFICIAL_PROCESS_END_UNAVAILABLE') throw error;
        if (this.platform === 'win32') {
          limitation = 'windows-helper';
          try { fallback = await this.nativeSnapshot(); } catch { inspected = false; }
        }
        else {
          const api = this.runtime.api();
          limitation = 'helper';
          try {
            const value = await (this.runtime.inspect ?? inspectWslProcesses)(this.executable, hasOfficialHubApi(api) ? api : undefined, this.runtime.ownerPid ?? process.pid);
            fallback = value.processes.map(row => ({ id: randomUUID(), pid: row.pid, parentPid: row.parentPid,
              owner: row.kind === 'current-hub' ? 'current' : row.kind === 'unowned-hub' ? 'other' : 'unknown', parentState: 'unknown', taskState: 'unknown', canEnd: false }));
          } catch { inspected = false; }
        }
      }
    } else {
      fallback = await this.nativeSnapshot(); limitation = 'platform';
    }
    this.runtime.assertCurrent();
    if (revision !== this.revision) throw new LiveError('OFFICIAL_PROCESS_SELECTION_STALE');
    if (before !== this.currentGeneration()) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
    if (new Set(rows.map(row => row.pid)).size !== rows.length || rows.filter(row => row.kind === 'current-hub').length > 1) throw new LiveError('PROCESS_CHECK_FAILED');
    const processes: ProcessConflict[] = rows.length ? rows.map(row => {
      const id = randomUUID(); if (row.canEnd) this.targets.set(id, row);
      return { id, pid: row.pid, parentPid: row.parentPid, ...(row.startedAt ? { startedAt: row.startedAt } : {}),
        owner: row.kind === 'current-hub' ? 'current' : row.kind === 'unverified' ? 'unknown' : row.parentPid === 1 ? 'detached' : 'other',
        parentState: row.parentState, taskState: 'unknown', canEnd: row.canEnd, ...(this.platform === 'win32' && row.canEnd ? { endMode: 'force' as const } : {}) };
    }) : fallback;
    this.selectedGeneration = before;
    const verifiedPlatform = this.platform === 'linux' || this.platform === 'win32';
    const conflicts = verifiedPlatform ? processes.filter(row => row.owner !== 'current') : processes.length > (before === 'stopped' ? 0 : 1) ? processes : [];
    const ready = inspected && !conflicts.length && (!verifiedPlatform || (before === 'stopped' ? processes.length === 0 : processes.some(row => row.owner === 'current')));
    return { phase: ready ? 'clear' : 'blocked', processes: conflicts, canContinue: ready, ...(limitation ? { limitation } : {}) };
  }
  async end(id: unknown, signal: AbortSignal): Promise<'exited' | 'forced' | 'gone'> {
    const selected = typeof id === 'string' ? this.targets.get(id) : undefined;
    if (!selected || signal.aborted || this.ending) throw new LiveError('OFFICIAL_PROCESS_SELECTION_STALE');
    this.targets.clear(); this.runtime.assertCurrent();
    const expected = this.selectedGeneration, revision = this.revision;
    if (expected !== this.currentGeneration()) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
    this.ending = true;
    try {
      const authorize = (): void => {
        this.runtime.assertCurrent();
        if (signal.aborted) throw new LiveError('OFFICIAL_PROCESS_END_CANCELLED');
        if (revision !== this.revision) throw new LiveError('OFFICIAL_PROCESS_SELECTION_STALE');
        if (expected !== this.currentGeneration()) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      };
      const result = object(await this.helper()({ ...this.request('end'), target: selected }, signal, authorize));
      authorize();
      const codes = ['OFFICIAL_PROCESS_END_UNAVAILABLE', 'OFFICIAL_PROCESS_SELECTION_STALE', 'OFFICIAL_PROCESS_END_CANCELLED', 'OFFICIAL_PROCESS_END_DENIED', 'OFFICIAL_BACKEND_STOP_TIMEOUT', 'PROCESS_CHECK_FAILED'];
      if (typeof result.code === 'string' && codes.includes(result.code)) throw new LiveError(result.code);
      if (!['exited', 'forced', 'gone'].includes(String(result.result))) throw new LiveError('PROCESS_CHECK_FAILED');
      return result.result as 'exited' | 'forced' | 'gone';
    } finally { this.ending = false; }
  }
  private async nativeSnapshot(): Promise<ProcessConflict[]> {
    const run = this.runtime.nativeRun ?? runPrivate;
    let values: { pid: number; parentPid?: number; startedAt?: string }[];
    if (this.platform === 'win32') {
      const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress";
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], '', 256 * 1024);
      if (result.code !== 0) throw new LiveError('PROCESS_CHECK_FAILED');
      const parsed: unknown = JSON.parse(result.stdout); const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      values = list.map(value => { const row = object(value); if (!integer(row.pid)) throw new LiveError('PROCESS_CHECK_FAILED'); return { pid: row.pid, ...(integer(row.parentPid) ? { parentPid: row.parentPid } : {}), ...(iso(row.startedAt) ? { startedAt: row.startedAt } : {}) }; });
    } else if (this.platform === 'darwin') {
      const result = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], '', 256 * 1024);
      if (result.code !== 0) throw new LiveError('PROCESS_CHECK_FAILED');
      values = [];
      for (const line of result.stdout.split('\n')) {
        if (!/(?:^|[ /])agy$/.test(line.trim())) continue;
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
        if (!match || !integer(Number(match[1]))) throw new LiveError('PROCESS_CHECK_FAILED');
        // ps dates can be localized; unknown is preferable to a fabricated time.
        const start = Date.parse(match[3]!);
        values.push({ pid: Number(match[1]), ...(integer(Number(match[2])) ? { parentPid: Number(match[2]) } : {}), ...(Number.isFinite(start) ? { startedAt: new Date(start).toISOString() } : {}) });
      }
    } else throw new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE');
    if (values.length > 1024 || new Set(values.map(row => row.pid)).size !== values.length) throw new LiveError('PROCESS_CHECK_FAILED');
    return values.map(row => ({ ...row, id: randomUUID(), owner: 'unknown', parentState: 'unknown', taskState: 'unknown', canEnd: false }));
  }
}

