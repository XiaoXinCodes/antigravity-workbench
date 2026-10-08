import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export class LiveError extends Error { constructor(readonly code: string) { super(code); } }
export interface TokenSlots { keyring: string | null; file: string | null; keyringState?: 'unobserved' }
export interface Keyring { read(): Promise<string | null>; write(value: string | null): Promise<void> }
export interface Slots { read(scope?: TokenSlots): Promise<TokenSlots>; write(value: TokenSlots, expected: TokenSlots): Promise<void> }
const MAX = 256 * 1024;
export function validateStoredToken(raw: string): void {
  if (!raw || Buffer.byteLength(raw) > MAX) throw new LiveError('TOKEN_SIZE_INVALID');
  let obj: unknown; try { obj = JSON.parse(raw); } catch { throw new LiveError('TOKEN_FORMAT_UNSUPPORTED'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new LiveError('TOKEN_FORMAT_UNSUPPORTED');
  const value = obj as Record<string, unknown>;
  const token = value.token as Record<string, unknown> | undefined;
  if (!token || typeof token !== 'object' || Array.isArray(token) || typeof token.refresh_token !== 'string' || !token.refresh_token || value.wif_provider || value.saved_wif_provider) throw new LiveError('ONLY_PERSONAL_OAUTH_SUPPORTED');
}
export function tokenAccountHint(raw: string): { email?: string; subject?: string; refresh: string } {
  validateStoredToken(raw);
  const token = JSON.parse(raw) as { token: { refresh_token: string }; id_token?: string };
  let claims: Record<string, unknown> = {};
  if (typeof token.id_token === 'string') {
    try { claims = JSON.parse(Buffer.from(token.id_token.split('.')[1] || '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { /* A JWT hint is not verification. */ }
  }
  return { refresh: token.token.refresh_token, ...(typeof claims.email === 'string' ? { email: claims.email.toLowerCase() } : {}), ...(typeof claims.sub === 'string' ? { subject: claims.sub } : {}) };
}
export function assertSlotIdentity(slots: TokenSlots, expectedEmail: string): void {
  const hints = [slots.keyring, slots.file].filter((v): v is string => v !== null).map(tokenAccountHint);
  if (hints.some(h => h.email && h.email !== expectedEmail.toLowerCase())) throw new LiveError('STORED_TOKEN_EMAIL_MISMATCH');
  if (hints.length === 2) {
    const [a, b] = hints;
    if (a!.subject && b!.subject ? a!.subject !== b!.subject : a!.refresh !== b!.refresh) throw new LiveError('KEYRING_FILE_IDENTITY_AMBIGUOUS');
  }
}
export function validateSlotScope(slots: TokenSlots): void {
  if (slots.keyringState !== undefined && slots.keyringState !== 'unobserved' || slots.keyringState === 'unobserved' && slots.keyring !== null) throw new LiveError('OFFICIAL_STORAGE_SCOPE_MISMATCH');
}
export function validateSlots(slots: TokenSlots): void {
  validateSlotScope(slots);
  if (slots.keyring === null && slots.file === null) throw new LiveError('NO_SAVED_OFFICIAL_LOGIN');
  for (const raw of [slots.keyring, slots.file]) if (raw !== null) validateStoredToken(raw);
}
export function equalSlots(a: TokenSlots, b: TokenSlots): boolean { return a.keyring === b.keyring && a.file === b.file && a.keyringState === b.keyringState; }
export interface ProcessResult { code: number | null; stdout: string; stderr: string }
// Secrets use stdin/stdout pipes only. Neither argv, environment, errors nor logs contain them.
export function runPrivate(executable: string, args: string[], input = '', limit = MAX): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', count = 0, failed = false;
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 60_000);
    child.on('error', () => { clearTimeout(timer); reject(new LiveError('NATIVE_HELPER_UNAVAILABLE')); });
    child.stdin.on('error', () => { /* close handles failure without echoing the input */ });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { count += Buffer.byteLength(data); if (count > limit) { failed = true; child.kill('SIGKILL'); } else stdout += data; });
    child.stderr.on('data', (data: string) => { count += Buffer.byteLength(data); if (count > limit) { failed = true; child.kill('SIGKILL'); } else stderr += data; });
    child.on('close', code => { clearTimeout(timer); if (failed) reject(new LiveError('NATIVE_HELPER_TIMEOUT_OR_LIMIT')); else resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
// Independent Win32 interop. CredRead returns UTF-8 bytes, matching go-keyring/wincred.
// This script is constant and contains no account credentials; payload is a single stdin JSON object.
export const WINDOWS_KEYRING_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class AgCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct C { public uint Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist,AttributeCount; public IntPtr Attributes; public string TargetAlias,UserName; }
 [DllImport("advapi32",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Read(string t,uint type,uint flags,out IntPtr p);
 [DllImport("advapi32",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Write(ref C c,uint flags);
 [DllImport("advapi32",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Delete(string t,uint type,uint flags);
 [DllImport("advapi32")] public static extern void CredFree(IntPtr p);
}
'@
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
if($r.action -eq 'read') {
 $p=[IntPtr]::Zero
 if(-not [AgCredential]::Read('gemini:antigravity',1,0,[ref]$p)) { if([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168){[Console]::Out.Write('{"value":null}');exit 0};exit 2 }
 try { $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][AgCredential+C]); if($c.CredentialBlobSize -gt 262144){exit 2};$b=New-Object byte[] $c.CredentialBlobSize;[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$b.Length);[Console]::Out.Write((@{value=[Convert]::ToBase64String($b)} | ConvertTo-Json -Compress)) } finally {[AgCredential]::CredFree($p)}
} elseif($r.action -eq 'write') {
 if($null -eq $r.value) { if(-not [AgCredential]::Delete('gemini:antigravity',1,0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168){exit 2} }
 else { $b=[Convert]::FromBase64String($r.value);if($b.Length -gt 2560){exit 3};$p=[Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
 try {[Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length);$c=New-Object AgCredential+C;$c.Type=1;$c.TargetName='gemini:antigravity';$c.UserName='antigravity';$c.Persist=2;$c.CredentialBlobSize=$b.Length;$c.CredentialBlob=$p;if(-not [AgCredential]::Write([ref]$c,0)){exit 2}}finally{for($i=0;$i -lt $b.Length;$i++){[Runtime.InteropServices.Marshal]::WriteByte($p,$i,0)};[Runtime.InteropServices.Marshal]::FreeHGlobal($p)} }
 [Console]::Out.Write('{}')
} elseif($r.action -eq 'validate') {[Console]::Out.Write('{"ready":true}')} else {exit 2}
} catch { exit 2 }
`;
export class SystemKeyring implements Keyring {
  constructor(private readonly platform: NodeJS.Platform = process.platform, private readonly run = runPrivate) {}
  private async windows(action: 'read' | 'write', value: string | null = null): Promise<string | null> {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await this.run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_KEYRING_SCRIPT, 'utf16le').toString('base64')], JSON.stringify({ action, value: value === null ? null : Buffer.from(value).toString('base64') }));
    if (result.code !== 0) throw new LiveError(result.code === 3 ? 'WINDOWS_KEYRING_SIZE_LIMIT' : 'KEYRING_UNAVAILABLE');
    try { const parsed = JSON.parse(result.stdout) as { value?: string | null }; if (!parsed.value) return null; const bytes = Buffer.from(parsed.value, 'base64'); const raw = bytes.toString('utf8'); if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new LiveError('KEYRING_ENCODING_INVALID'); return raw; } catch { throw new LiveError('KEYRING_RESPONSE_INVALID'); }
  }
  private async linuxItems(): Promise<number> {
    // go-keyring searches the login collection; libsecret lookup/clear are service-wide.
    // Refuse duplicates or another collection before using those operations.
    const r = await this.run('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets', '--method', 'org.freedesktop.Secret.Service.SearchItems', "{'service': 'gemini', 'username': 'antigravity'}"]);
    if (r.code !== 0) throw new LiveError('KEYRING_UNAVAILABLE');
    const paths = [...r.stdout.matchAll(/'(\/org\/freedesktop\/secrets\/[^']+)'/g)].map(match => match[1]!);
    if (paths.length > 1 || paths.some(p => !/^\/org\/freedesktop\/secrets\/collection\/login\/[a-zA-Z0-9_]+$/.test(p))) throw new LiveError('KEYRING_COLLECTION_AMBIGUOUS');
    if (!paths.length && !/^\(\s*(?:@ao\s*)?\[\s*\],\s*(?:@ao\s*)?\[\s*\]\s*\)\s*$/.test(r.stdout)) throw new LiveError('KEYRING_RESPONSE_INVALID');
    return paths.length;
  }
  async read(): Promise<string | null> {
    if (this.platform === 'win32') return this.windows('read');
    if (this.platform === 'darwin') {
      const r = await this.run('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']);
      if (r.code === 44) return null;
      if (r.code !== 0) throw new LiveError('KEYRING_UNAVAILABLE');
      const raw = r.stdout.trim();
      if (raw.startsWith('go-keyring-base64:')) return Buffer.from(raw.slice(18), 'base64').toString('utf8');
      if (raw.startsWith('go-keyring-encoded:')) return Buffer.from(raw.slice(19), 'hex').toString('utf8');
      return raw;
    }
    if (this.platform !== 'linux') throw new LiveError('PLATFORM_UNSUPPORTED');
    if (await this.linuxItems() === 0) return null;
    const r = await this.run('/usr/bin/secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity']);
    if (r.code === 1 && !r.stdout && !r.stderr.trim()) return null;
    if (r.code !== 0) throw new LiveError('KEYRING_UNAVAILABLE');
    return r.stdout;
  }
  async write(value: string | null): Promise<void> {
    if (this.platform === 'win32') { await this.windows('write', value); return; }
    let r: ProcessResult;
    if (this.platform === 'darwin') {
      // Interactive command input is not a shell and receives only a fixed alphabet encoding.
      if (value === null) r = await this.run('/usr/bin/security', ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity']);
      else {
        const encoded = Buffer.from(value).toString('base64');
        if (encoded.length > 3900) throw new LiveError('MACOS_KEYRING_SIZE_LIMIT');
        r = await this.run('/usr/bin/security', ['-i'], `add-generic-password -U -s gemini -a antigravity -w go-keyring-base64:${encoded}\n`);
      }
      if (value === null && r.code === 44) return;
    } else if (this.platform === 'linux') {
      const count = await this.linuxItems(); if (value === null && count === 0) return;
      if (value !== null && Buffer.byteLength(value) >= 8192) throw new LiveError('LINUX_KEYRING_SIZE_LIMIT');
      r = value === null
      ? await this.run('/usr/bin/secret-tool', ['clear', 'service', 'gemini', 'username', 'antigravity'])
      : await this.run('/usr/bin/secret-tool', ['store', '--collection=/org/freedesktop/secrets/collection/login', '--label=Antigravity OAuth', 'service', 'gemini', 'username', 'antigravity'], value);
    } else throw new LiveError('PLATFORM_UNSUPPORTED');
    if (r.code !== 0) throw new LiveError('KEYRING_WRITE_FAILED');
  }
}

export class OfficialTokenSlots implements Slots {
  readonly file: string;
  constructor(private readonly home: string, private readonly keyring: Keyring) { this.file = path.join(home, '.gemini', 'jetski-standalone-oauth-token'); }
  private async checkDirectory(): Promise<void> {
    for (const dir of [this.home, path.join(this.home, '.gemini')]) {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LiveError('OFFICIAL_PATH_UNSAFE');
    }
  }
  private async readFile(): Promise<string | null> {
    await this.checkDirectory();
    let file;
    try { const stat = await fs.lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new LiveError('OFFICIAL_FILE_UNSAFE');
      file = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await file.stat(); if (!opened.isFile() || opened.size > MAX || opened.ino !== stat.ino) throw new LiveError('OFFICIAL_FILE_CHANGED');
      const bytes = await file.readFile(); const raw = bytes.toString('utf8'); const after = await file.stat();
      if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new LiveError('OFFICIAL_FILE_ENCODING_INVALID');
      if (Buffer.byteLength(raw) > MAX || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) throw new LiveError('OFFICIAL_FILE_CHANGED');
      return raw;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e instanceof LiveError ? e : new LiveError('OFFICIAL_FILE_READ_FAILED'); }
    finally { await file?.close(); }
  }
  async read(): Promise<TokenSlots> { return { keyring: await this.keyring.read(), file: await this.readFile() }; }
  async write(value: TokenSlots, expected: TokenSlots): Promise<void> {
    if (value.keyringState !== undefined || expected.keyringState !== undefined) throw new LiveError('OFFICIAL_STORAGE_SCOPE_MISMATCH');
    if (!equalSlots(await this.read(), expected)) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
    if (value.keyring !== expected.keyring) await this.keyring.write(value.keyring);
    if (value.file !== expected.file) {
      if (await this.readFile() !== expected.file) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
      if (value.file === null) await fs.unlink(this.file);
      else {
        const temp = path.join(path.dirname(this.file), `.agm-${randomUUID()}.tmp`);
        try {
          const handle = await fs.open(temp, 'wx', 0o600);
          try { await handle.writeFile(value.file, 'utf8'); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temp, this.file);
        } finally { await fs.unlink(temp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new LiveError('TEMP_CLEANUP_FAILED'); }); }
      }
    }
    if (!equalSlots(await this.read(), value)) throw new LiveError('OFFICIAL_STORAGE_READBACK_FAILED');
  }
}
