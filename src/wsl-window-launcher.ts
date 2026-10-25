import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WindowSwitchError } from './window-switch-protocol';

export interface WslLaunchPlan {
  schema: 1;
  executable: string;
  cwd: string;
  cli: string;
  fingerprint: string;
  authority: string;
  workspace: { kind: 'folder' | 'workspace'; uri: string };
  profilePolicy: 'workspace-association';
}
export interface LauncherIO {
  inspect(executable: string): Promise<{ cwd: string; cli: string; fingerprint: string }>;
  run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, probe: boolean): Promise<{ code: number | null; output: string }>;
}
export class WindowLaunchNotDispatched extends WindowSwitchError {}
const failure = (code: string): never => { throw new WindowSwitchError(code); };
const clean = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length < 8192 && ![...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
export function validateWslLaunchPlan(value: unknown): WslLaunchPlan {
  const p = value as WslLaunchPlan;
  try {
    if (!p || p.schema !== 1 || Object.keys(p).some(k => !['schema','executable','cwd','cli','fingerprint','authority','workspace','profilePolicy'].includes(k)) ||
      !clean(p.executable) || !path.posix.isAbsolute(p.executable) || !/\/Code(?: - Insiders)?\.exe$/.test(p.executable) ||
      p.cwd !== path.posix.dirname(p.executable) || ! /^(?:[a-f0-9]{10,40}\/)?resources\/app\/out\/cli\.js$/.test(p.cli) || !/^[a-f0-9]{64}$/.test(p.fingerprint) ||
      p.profilePolicy !== 'workspace-association' || !/^wsl\+[a-zA-Z0-9._-]{1,128}$/.test(p.authority) ||
      !p.workspace || Object.keys(p.workspace).some(k => !['kind','uri'].includes(k)) || !['folder','workspace'].includes(p.workspace.kind) || !clean(p.workspace.uri)) throw 0;
    const uri = new URL(p.workspace.uri);
    if (uri.protocol !== 'vscode-remote:' || uri.host !== p.authority || uri.username || uri.password || uri.search || uri.hash || !uri.pathname.startsWith('/')) throw 0;
    return structuredClone(p);
  } catch { return failure('WINDOW_LAUNCH_PLAN_INVALID'); }
}
/** Parse only an official literal relative CLI operand, never execute the batch. */
export function parseOfficialCliOperand(batch: string): string {
  const paths = new Set<string>();
  for (const line of batch.split(/\r?\n/)) {
    const match = /^\s*@?"%~dp0\.\.\\Code(?: - Insiders)?\.exe"\s+"%~dp0\.\.\\((?:[a-f0-9]{10,40}\\)?resources\\app\\out\\cli\.js)"\s+%\*\s*$/i.exec(line);
    if (match) paths.add(match[1]!.replaceAll('\\', '/'));
  }
  if (paths.size !== 1) return failure('WINDOW_BATCH_LAYOUT_UNSUPPORTED');
  return [...paths][0]!;
}
export const nativeWslLauncherIO: LauncherIO = {
  async inspect(executable) {
    if (!path.posix.isAbsolute(executable) || !/\/Code(?: - Insiders)?\.exe$/.test(executable)) failure('WINDOW_LAUNCHER_UNSUPPORTED');
    const cwd = path.dirname(executable);
    const batchPath = path.join(cwd, 'bin', executable.endsWith('Code - Insiders.exe') ? 'code-insiders.cmd' : 'code.cmd');
    const batchBefore = await fs.lstat(batchPath);
    if (!batchBefore.isFile() || batchBefore.isSymbolicLink() || batchBefore.size > 65536) failure('WINDOW_BATCH_LAYOUT_UNSUPPORTED');
    const batch = await fs.readFile(batchPath);
    const batchAfter = await fs.lstat(batchPath);
    if (batchBefore.ino !== batchAfter.ino || batchBefore.dev !== batchAfter.dev || batchBefore.mtimeMs !== batchAfter.mtimeMs || batchBefore.ctimeMs !== batchAfter.ctimeMs || batchBefore.size !== batchAfter.size) failure('WINDOW_LAUNCHER_CHANGED');
    const cli = parseOfficialCliOperand(batch.toString('utf8'));
    const app = path.dirname(path.dirname(cli));
    for (const relative of ['bin', ...cli.split('/').slice(0,-1).map((_,i,a)=>a.slice(0,i+1).join('/'))]) {
      const st = await fs.lstat(path.join(cwd, relative));
      if (!st.isDirectory() || st.isSymbolicLink()) failure('WINDOW_LAUNCHER_UNVERIFIED');
    }
    // Portable/user-specified layouts are not silently translated to defaults.
    try { await fs.lstat(path.join(cwd, 'data')); return failure('WINDOW_PORTABLE_UNSUPPORTED'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const digest = createHash('sha256'); digest.update(batchPath); digest.update(batch);
    for (const file of [executable, path.join(cwd, cli), path.join(cwd, app, 'product.json')]) {
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 512 * 1024 * 1024) failure('WINDOW_LAUNCHER_UNVERIFIED');
      const bytes = await fs.readFile(file), after = await fs.lstat(file);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) failure('WINDOW_LAUNCHER_CHANGED');
      if (file === executable && bytes.subarray(0, 2).toString() !== 'MZ') failure('WINDOW_LAUNCHER_UNVERIFIED');
      if (file.endsWith('product.json')) {
        const product = JSON.parse(bytes.toString('utf8')) as { applicationName?: string; commit?: string };
        if (cli !== 'resources/app/out/cli.js' && (!/^[a-f0-9]{40}$/.test(product.commit ?? '') || !product.commit!.startsWith(cli.split('/')[0]!))) failure('WINDOW_VERSION_LAYOUT_MISMATCH');
        if (!['code', 'code-insiders'].includes(product.applicationName ?? '')) failure('WINDOW_LAUNCHER_UNSUPPORTED');
      }
      digest.update(file); digest.update(bytes);
    }
    return { cwd, cli, fingerprint: digest.digest('hex') };
  },
  run(executable, args, cwd, env, probe) {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(executable, args, { cwd, env, shell: false, windowsVerbatimArguments: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { reject(new WindowLaunchNotDispatched('WINDOW_LAUNCH_NOT_DISPATCHED')); return; }
      let output = '', settled = false, dispatched = false;
      const finish = (err?: string, code: number | null = null): void => {
        if (settled) return; settled = true; clearTimeout(timer);
        child.stdout?.destroy(); child.unref();
        if (err) reject(!dispatched ? new WindowLaunchNotDispatched(err) : new WindowSwitchError(err)); else resolve({ code, output });
      };
      // A launch timeout is ambiguous, never a reason to retry or roll back.
      // Only the harmless --version probe may terminate its own CLI process.
      const timer = setTimeout(() => { if (probe) child.kill(); finish(probe ? 'WINDOW_LAUNCH_PROBE_TIMEOUT' : 'WINDOW_LAUNCH_ACK_UNKNOWN'); }, 15_000);
      child.once('spawn', () => { dispatched = true; });
      child.once('error', () => finish('WINDOW_LAUNCH_FAILED'));
      child.once('close', code => finish(undefined, code));
      child.stdout?.on('data', (b: Buffer) => { if (probe && output.length < 4096) output += b.toString('utf8').slice(0, 4096 - output.length); });
    });
  },
};
/** Uses the official external WSL CLI route, not a dying remote-host socket.
 * Discovery reads only named fields from THIS process. No shell, cmd.exe,
 * PowerShell, environment dump, profile creation, or credential argument. */
export class WslWindowLauncher {
  constructor(private readonly io: LauncherIO = nativeWslLauncherIO, private readonly environment: NodeJS.ProcessEnv = process.env) {}
  private env(): NodeJS.ProcessEnv {
    const interop = this.environment.WSL_INTEROP;
    if (!clean(interop) || !interop.startsWith('/run/WSL/')) failure('WINDOW_INTEROP_UNAVAILABLE');
    const env: NodeJS.ProcessEnv = { WSL_INTEROP: interop, ELECTRON_RUN_AS_NODE: '1', WSLENV: 'ELECTRON_RUN_AS_NODE/w' };
    // No inherited CLI IPC hook, NODE_OPTIONS, account credentials or arbitrary
    // WSLENV forwarding. Windows supplies its native process environment.
    if (this.environment.PATH) env.PATH = this.environment.PATH;
    return env;
  }
  async discover(workspace: WslLaunchPlan['workspace']): Promise<WslLaunchPlan> {
    const executable = this.environment.VSCODE_CLIENT_COMMAND;
    if (!clean(executable)) return failure('WINDOW_CLIENT_COMMAND_UNAVAILABLE');
    const authority = new URL(workspace.uri).host;
    const image = await this.io.inspect(executable);
    const plan = validateWslLaunchPlan({ schema: 1, executable, ...image, authority, workspace, profilePolicy: 'workspace-association' });
    await this.validate(plan); return plan;
  }
  async validate(raw: WslLaunchPlan): Promise<void> {
    const plan = validateWslLaunchPlan(raw), image = await this.io.inspect(plan.executable);
    if (image.fingerprint !== plan.fingerprint || image.cli !== plan.cli || image.cwd !== plan.cwd) failure('WINDOW_LAUNCHER_CHANGED');
    const result = await this.io.run(plan.executable, [plan.cli, '--version'], plan.cwd, this.env(), true);
    if (result.code !== 0 || !/^\d+\.\d+\.\d+(?:-[^\s]+)?\r?\n[a-f0-9]{40}\r?\n(?:x64|arm64|ia32)\s*$/.test(result.output.trim())) failure('WINDOW_LAUNCHER_UNVERIFIED');
  }
  async launch(raw: WslLaunchPlan): Promise<void> {
    let plan: WslLaunchPlan;
    try { plan = validateWslLaunchPlan(raw); await this.validate(plan); }
    catch { throw new WindowLaunchNotDispatched('WINDOW_LAUNCH_NOT_DISPATCHED'); }
    const args = [plan.cli, '--new-window', plan.workspace.kind === 'folder' ? '--folder-uri' : '--file-uri', plan.workspace.uri];
    const result = await this.io.run(plan.executable, args, plan.cwd, this.env(), false);
    if (result.code !== 0) failure('WINDOW_LAUNCH_ACK_UNKNOWN');
    // This only acknowledges CLI completion, NEVER window registration or login.
  }
}
