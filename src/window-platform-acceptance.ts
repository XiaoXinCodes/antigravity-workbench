import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { PrivateState } from './private-state';
import { type LauncherIO } from './wsl-window-launcher';
import { bindWslWorkspace } from './wsl-workspace';

interface LegacyAcceptance { schema: 1; test: 'isolated-windows-wsl-v1'; fingerprint: string; authority: string; executable: string }
export interface WindowAcceptanceManifest extends Omit<LegacyAcceptance, 'schema'> {
  schema: 2; clientCommit: string; profilePolicy: 'workspace-association';
  evidenceId: string; evidenceSha256: string; claim: 'window-only'; attestation: 'operator-confirmed';
}
export type WindowPlatformAcceptance = LegacyAcceptance | WindowAcceptanceManifest;
const invalid = (): never => { throw Error('WINDOW_ACCEPTANCE_INVALID'); };
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function parse(value: unknown, legacy: boolean): WindowPlatformAcceptance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const p = value as WindowPlatformAcceptance;
  const keys = ['schema','test','fingerprint','authority','executable'];
  if (p.schema === 2) keys.push('clientCommit','profilePolicy','evidenceId','evidenceSha256','claim','attestation');
  else if (!legacy || p.schema !== 1) return invalid();
  if (Object.keys(p).length !== keys.length || Object.keys(p).some(k => !keys.includes(k)) ||
      p.test !== 'isolated-windows-wsl-v1' || !hash(p.fingerprint) || typeof p.authority !== 'string' || !/^wsl\+[a-z0-9._-]{1,128}$/.test(p.authority) ||
      typeof p.executable !== 'string' || p.executable.length > 4096 || [...p.executable].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || !path.posix.isAbsolute(p.executable) ||
      path.posix.normalize(p.executable) !== p.executable || !/\/Code(?: - Insiders)?\.exe$/.test(p.executable)) return invalid();
  if (p.schema === 2 && (!/^[a-f0-9]{40}$/.test(p.clientCommit) || p.profilePolicy !== 'workspace-association' ||
      typeof p.evidenceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.evidenceId) || !hash(p.evidenceSha256) ||
      p.claim !== 'window-only' || p.attestation !== 'operator-confirmed')) return invalid();
  return structuredClone(p);
}
export function validateWindowAcceptanceManifest(value: unknown): WindowAcceptanceManifest { return parse(value, false) as WindowAcceptanceManifest; }
const directory = (home: string): string => path.join(home, '.gemini', 'antigravity-workbench-window-platform');
export async function readWindowPlatformAcceptance(home: string): Promise<WindowPlatformAcceptance> {
  await fs.lstat(directory(home)); // Reading a missing proof must not create one.
  return new PrivateState(directory(home), v => parse(v, true), invalid).read();
}
/** Bounded regular-file reads; no symlink final component, FIFO, URL or shell. */
export async function readAcceptanceJson(file: string, limit = 16384): Promise<unknown> {
  const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await h.stat();
    if (!before.isFile() || before.size > limit) return invalid();
    const b = Buffer.alloc(limit + 1); let n = 0;
    while (n < b.length) { const r = await h.read(b, n, b.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
    const after = await h.stat();
    if (n !== before.size || n > limit || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return invalid();
    return JSON.parse(b.subarray(0, n).toString('utf8')) as unknown;
  } finally { await h.close(); }
}
export interface AcceptanceImportIO {
  inspect: LauncherIO['inspect'];
  readJson(file: string, limit: number): Promise<unknown>;
  confirm(manifest: WindowAcceptanceManifest): Promise<boolean>;
}
/** Evidence ID/hash are operator attestations, NOT cryptographic proof that a
 * window test ran. Import grants no credential/storage/real-login attestation. */
export async function importWindowPlatformAcceptance(
  home: string, value: unknown, runtime: { platform: string; remoteName: string | null; distro: string | undefined; workspace: { kind: 'folder' | 'workspace'; uri: string }; executable?: string },
  io: AcceptanceImportIO,
): Promise<boolean> {
  const manifest = validateWindowAcceptanceManifest(value);
  if (runtime.platform !== 'linux' || runtime.executable && runtime.executable !== manifest.executable) return invalid();
  bindWslWorkspace(runtime.workspace, runtime.remoteName, runtime.distro, manifest.authority);
  const check = async (): Promise<void> => {
    const image = await io.inspect(manifest.executable);
    if (image.fingerprint !== manifest.fingerprint || image.cwd !== path.dirname(manifest.executable) || !/^(?:[a-f0-9]{10,40}\/)?resources\/app\/out\/cli\.js$/.test(image.cli)) return invalid();
    const product = await io.readJson(path.join(image.cwd, path.dirname(path.dirname(image.cli)), 'product.json'), 262144) as { commit?: string };
    if (!product || product.commit !== manifest.clientCommit) return invalid();
    const after = await io.inspect(manifest.executable);
    if (after.fingerprint !== image.fingerprint || after.cli !== image.cli || after.cwd !== image.cwd) return invalid();
  };
  await check();
  if (!await io.confirm(manifest)) return false;
  await check(); // A human confirmation may remain open across a client update.
  await new PrivateState<WindowPlatformAcceptance>(directory(home), v => parse(v, true), () => structuredClone(manifest)).transaction(p => {
    for (const key of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[key];
    Object.assign(p, manifest);
  });
  return true;
}
