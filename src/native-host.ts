import { t as tr } from './i18n';
import type * as vscode from 'vscode';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { LiveError } from './live-storage';

export interface NativeHostStatus { available: boolean; message: string; code?: string }
type HostContext = Pick<vscode.ExtensionContext, 'extension' | 'extensionUri' | 'globalStorageUri'>;
export function isLocalFileUri(uri: Pick<vscode.Uri, 'scheme' | 'authority'> | undefined): boolean {
  return uri?.scheme === 'file' && uri.authority === '';
}
export function hostLabel(context: Pick<HostContext, 'extension'>, remoteName?: string, platform: NodeJS.Platform = process.platform): string {
  const system = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
  return context.extension?.extensionKind === 2 && remoteName ? `${remoteName === 'wsl' ? 'WSL' : remoteName} · ${system}` : tr("nativeHost.f88ec7253c", { p0: system });
}
/** remoteName is the window's workspace; extensionKind plus native paths locate this process. */
export function nativeHostStatus(context: HostContext, trusted: boolean, desktop: boolean, remoteName?: string, platform: NodeJS.Platform = process.platform): NativeHostStatus {
  if (!trusted) return { available: false, code: 'WORKSPACE_TRUST_REQUIRED', message: tr("nativeHost.be87b31a86") };
  if (!desktop) return { available: false, code: 'NATIVE_DESKTOP_REQUIRED', message: tr("nativeHost.dbb1e426cf") };
  if (![1, 2].includes(context.extension?.extensionKind) || !isLocalFileUri(context.extensionUri) || !isLocalFileUri(context.globalStorageUri)) {
    return { available: false, code: 'NATIVE_HOST_PATH_REQUIRED', message: tr("nativeHost.baeee23d2a") };
  }
  if (typeof process === 'undefined' || process.release?.name !== 'node' || !['win32', 'darwin', 'linux'].includes(platform)) {
    return { available: false, code: 'NATIVE_RUNTIME_REQUIRED', message: tr("nativeHost.67c2e65972") };
  }
  if (context.extension.extensionKind === 2 && remoteName && (remoteName !== 'wsl' || platform !== 'linux')) {
    return { available: false, code: 'REMOTE_HOST_UNVERIFIED', message: tr("nativeHost.9b3a56e2f7") };
  }
  const label = hostLabel(context, remoteName, platform);
  return { available: true, message: tr("nativeHost.a7830058ff", { p0: label, p1: context.extension.extensionKind === 1 && remoteName ? tr('nativeHost.workspace', { p0: remoteName === 'wsl' ? 'WSL' : remoteName }) : '' }) };
}
export function assertNativeHost(context: HostContext, trusted: boolean, desktop: boolean, remoteName?: string): void {
  const status = nativeHostStatus(context, trusted, desktop, remoteName);
  if (!status.available) throw new LiveError(status.code!);
}
export interface CredentialHostIdentity { platform: NodeJS.Platform; hostname: string; home: string; distroIdentity?: string }
/** Pure fingerprint when explicit identity inputs are supplied; never includes credentials. */
export function credentialHostId(context: HostContext, remoteName?: string, storageMode = 'native-keyring', identity: Partial<CredentialHostIdentity> = {}): string {
  return createHash('sha256').update(JSON.stringify([identity.platform ?? process.platform, identity.hostname ?? os.hostname(), identity.home ?? os.homedir(), context.extension.extensionKind === 2 ? remoteName || 'local' : 'local', storageMode, identity.distroIdentity ?? null])).digest('hex');
}
export interface HostIdentityDependencies {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; hostname?: () => string; homedir?: () => string; readMachineId?: () => Promise<string>;
}
/** Read only the current Linux system identity, never another host's files or credentials. */
export async function resolveCredentialHostId(context: HostContext, remoteName?: string, storageMode = 'native-keyring', dependencies: HostIdentityDependencies = {}): Promise<string> {
  const platform = dependencies.platform ?? process.platform, env = dependencies.env ?? process.env;
  const identity: CredentialHostIdentity = { platform, hostname: (dependencies.hostname ?? os.hostname)(), home: (dependencies.homedir ?? os.homedir)() };
  const wsl = platform === 'linux' && (storageMode === 'wsl-file' || context.extension.extensionKind === 2 && remoteName === 'wsl' || !!env.WSL_DISTRO_NAME || !!env.WSL_INTEROP);
  if (wsl) {
    const rawDistro = env.WSL_DISTRO_NAME;
    const distro = typeof rawDistro === 'string' && rawDistro.length <= 256 && rawDistro.trim() && !Array.from(rawDistro).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? rawDistro.trim() : undefined;
    let machineId: string | undefined;
    try {
      const raw = (await (dependencies.readMachineId ?? (() => fs.readFile('/etc/machine-id', 'utf8')))()).trim().toLowerCase();
      if (/^[a-f0-9]{32}$/u.test(raw) && raw !== '0'.repeat(32)) machineId = raw;
    } catch { /* A named distro remains identifiable without machine-id; otherwise fail closed. */ }
    if (!distro && !machineId) throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
    // WSL distros commonly share Windows hostname and identical HOME strings.
    // Including the distro name separates even cloned images with the same machine-id.
    identity.distroIdentity = JSON.stringify([distro ?? null, machineId ?? null]);
  }
  return credentialHostId(context, remoteName, storageMode, identity);
}
/** In remote windows UI and workspace are different processes; outside them both are local. */
export function sameNativeHost(context: HostContext, extension: Pick<vscode.Extension<unknown>, 'extensionKind' | 'extensionUri'>, remoteName?: string): boolean {
  return isLocalFileUri(extension.extensionUri) && (!remoteName || context.extension.extensionKind === extension.extensionKind);
}
