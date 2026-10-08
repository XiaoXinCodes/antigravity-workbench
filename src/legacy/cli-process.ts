/* eslint-disable no-control-regex -- Reject control characters in executable paths. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

export interface ExecutableOptions {
  excludedRoots?: string[];
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}
interface Context {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
  excluded: string[];
  visited: Set<string>;
}
const MAX_PATH_ENTRIES = 128;
const MAX_CANDIDATES = 2048;
const SCRIPT_EXTENSION = /\.(cmd|bat|ps1)$/iu;
const CONTROL = /[\x00-\x1f\x7f]/u;

function cleanAbsolute(value: string | undefined): string | undefined {
  if (!value || value.length > 8192 || CONTROL.test(value)) return undefined;
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return path.isAbsolute(unquoted) ? path.normalize(unquoted) : undefined;
}
function foreignPath(ctx: Context, value: string): boolean {
  // Reject Windows drive/UNC syntax in a POSIX extension host, even when a
  // Windows drive is disguised as an absolute POSIX /C:/... path.
  return ctx.platform !== 'win32' && (/^\/?[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value));
}
function envValue(ctx: Context, name: string): string | undefined {
  if (ctx.platform !== 'win32') return ctx.env[name];
  return Object.entries(ctx.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
function inside(ctx: Context, root: string, file: string): boolean {
  const relative = path.relative(ctx.platform === 'win32' ? root.toLowerCase() : root,
    ctx.platform === 'win32' ? file.toLowerCase() : file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function excluded(ctx: Context, candidate: string): boolean { return ctx.excluded.some(root => inside(ctx, root, candidate)); }
async function context(options: ExecutableOptions): Promise<Context> {
  const ctx: Context = { platform: options.platform ?? process.platform, arch: options.arch ?? process.arch,
    env: options.env ?? process.env, home: options.home ?? os.homedir(), excluded: [], visited: new Set() };
  for (const root of options.excludedRoots ?? []) {
    const absolute = cleanAbsolute(root);
    if (!absolute) continue;
    ctx.excluded.push(absolute);
    try { ctx.excluded.push(await fs.realpath(absolute)); } catch { /* Retain the lexical exclusion if the directory disappeared. */ }
  }
  return ctx;
}
async function safeRealpath(ctx: Context, candidate: string): Promise<string | undefined> {
  if (foreignPath(ctx, candidate)) return undefined;
  const absolute = cleanAbsolute(candidate);
  if (!absolute || excluded(ctx, absolute)) return undefined;
  try { const real = await fs.realpath(absolute); return foreignPath(ctx, real) || excluded(ctx, real) ? undefined : real; }
  catch { return undefined; }
}

// These headers only establish OS/CPU compatibility, not publisher authenticity.
// Discovery never executes a candidate, a package manager, or a shell/profile.
function nativeHeader(bytes: Buffer, ctx: Context): boolean {
  if (!['x64', 'arm64'].includes(ctx.arch) || bytes.length < 64) return false;
  if (ctx.platform === 'linux') {
    return bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1 &&
      bytes.readUInt16LE(18) === (ctx.arch === 'x64' ? 62 : 183);
  }
  if (ctx.platform === 'win32') {
    if (bytes.toString('ascii', 0, 2) !== 'MZ') return false;
    const offset = bytes.readUInt32LE(0x3c);
    return offset >= 64 && offset + 6 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0' &&
      bytes.readUInt16LE(offset + 4) === (ctx.arch === 'x64' ? 0x8664 : 0xaa64);
  }
  if (ctx.platform === 'darwin') {
    const cpu = ctx.arch === 'x64' ? 0x01000007 : 0x0100000c;
    if (bytes.readUInt32LE(0) === 0xfeedfacf) return bytes.readUInt32LE(4) === cpu;
    const magic = bytes.readUInt32BE(0);
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
    const count = bytes.readUInt32BE(4), size = magic === 0xcafebabf ? 32 : 20;
    if (count > 32 || 8 + count * size > bytes.length) return false;
    for (let i = 0; i < count; i++) if (bytes.readUInt32BE(8 + i * size) === cpu) return true;
  }
  return false;
}
async function executableCandidate(ctx: Context, candidate: string, allowPosixWrapper = false): Promise<string | undefined> {
  if (ctx.visited.size >= MAX_CANDIDATES) return undefined;
  const key = `${allowPosixWrapper}:${candidate}`;
  if (ctx.visited.has(key)) return undefined;
  ctx.visited.add(key);
  if (SCRIPT_EXTENSION.test(candidate) || (ctx.platform !== 'win32' && /\.(exe|com)$/iu.test(candidate))) return undefined;
  const real = await safeRealpath(ctx, candidate);
  if (!real || SCRIPT_EXTENSION.test(real) || (ctx.platform === 'win32' ? !/\.exe$/iu.test(real) : /\.(exe|com)$/iu.test(real))) return undefined;
  try {
    const before = await fs.stat(real);
    if (!before.isFile()) return undefined;
    await fs.access(real, constants.X_OK);
    const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) return undefined;
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (nativeHeader(bytes, ctx)) return real;
      if (allowPosixWrapper && ctx.platform !== 'win32' && bytes.toString('ascii', 0, 2) === '#!') return real;
    } finally { await handle.close(); }
  } catch { /* Missing, inaccessible, changed, or incompatible executable: try the next bounded candidate. */ }
  return undefined;
}
function pathDirectories(ctx: Context): string[] {
  return [...new Set((envValue(ctx, 'PATH') ?? '').split(ctx.platform === 'win32' ? ';' : ':')
    .slice(0, MAX_PATH_ENTRIES).flatMap(value => { const dir = cleanAbsolute(value); return dir ? [dir] : []; }))];
}

/** Resolve an explicitly selected native CLI for legacy regression fixtures. */
export async function resolveExecutable(input: string, options: ExecutableOptions = {}): Promise<string> {
  if (!input || input.length > 8192 || CONTROL.test(input) || SCRIPT_EXTENSION.test(input)) throw new Error('NATIVE_CLI_EXECUTABLE_REQUIRED');
  const ctx = await context(options);
  if (foreignPath(ctx, input) || ctx.platform !== 'win32' && /\.(exe|com)$/iu.test(input)) throw new Error('NATIVE_CLI_EXECUTABLE_REQUIRED');
  const candidates = path.isAbsolute(input) ? [input] : /^[a-zA-Z0-9._-]+$/u.test(input) ? pathDirectories(ctx).flatMap(directory =>
    ctx.platform === 'win32' && !/\.exe$/iu.test(input) ? [path.join(directory, `${input}.exe`)] : [path.join(directory, input)]) : [];
  for (const candidate of candidates) {
    const executable = await executableCandidate(ctx, candidate, true);
    if (executable) return executable;
  }
  throw new Error('CLI_NOT_FOUND');
}

export function cliEnvironment(): NodeJS.ProcessEnv {
  const keys = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TERM']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.has(key.toUpperCase())));
}

export async function terminateProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
      const timeout = setTimeout(() => { killer.kill(); resolve(); }, 3000);
      killer.on('error', () => { clearTimeout(timeout); child.kill(); resolve(); }); killer.on('close', () => { clearTimeout(timeout); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await new Promise(resolve => setTimeout(resolve, 400));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
}

export function redact(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu, '[REDACTED]')
    .replace(/(?:["']?authorization["']?\s*[=:]\s*["']?)(?:Bearer|Basic)\s+[^\s"',;]+/giu, 'Authorization: [REDACTED]')
    .replace(/((?:["']?)(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(?:["']?)\s*[=:]\s*["']?)([^\s"',;]+)/giu, '$1[REDACTED]');
}
