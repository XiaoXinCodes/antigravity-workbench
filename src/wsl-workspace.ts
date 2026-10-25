import * as path from 'node:path';
import { WindowSwitchError } from './window-switch-protocol';
const hasControl = (value: string): boolean => [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Remote extension hosts expose file: URIs. Bind the same path to THIS
 * process's named WSL distro; remoteName alone is never an authority proof.
 * This names the workspace, not the VS Code profile or launching process. */
export function bindWslWorkspace(
  workspace: { kind: 'folder' | 'workspace'; uri: string },
  remoteName: string | null,
  distro: string | undefined,
  expectedAuthority?: string,
): { kind: 'folder' | 'workspace'; uri: string } {
  try {
    if (remoteName !== 'wsl' || !distro || !/^[a-zA-Z0-9._-]{1,128}$/.test(distro)) throw 0;
    const authority = `wsl+${distro.toLowerCase()}`;
    if (expectedAuthority !== undefined && expectedAuthority !== authority) throw 0;
    const uri = new URL(workspace.uri);
    if (uri.username || uri.password || uri.search || uri.hash || hasControl(workspace.uri)) throw 0;
    if (uri.protocol === 'file:' ? !!uri.host : uri.protocol !== 'vscode-remote:' || uri.host !== authority) throw 0;
    // Reject path normalization/encoded separators before URL can hide them.
    const raw = workspace.uri.slice(workspace.uri.indexOf('://') + 3);
    const rawPath = raw.slice(raw.indexOf('/'));
    if (/%2f|%5c/i.test(rawPath) || rawPath.split('/').some(p => ['.', '..'].includes(decodeURIComponent(p)))) throw 0;
    const pathname = decodeURIComponent(uri.pathname);
    if (!pathname.startsWith('/') || pathname === '/' || pathname.includes('\\') || hasControl(pathname) || path.posix.normalize(pathname) !== pathname) throw 0;
    const canonical = new URL(`vscode-remote://${authority}/`);
    canonical.pathname = pathname.split('/').map(p => encodeURIComponent(p)).join('/');
    return { kind: workspace.kind, uri: canonical.toString() };
  } catch { throw new WindowSwitchError('WINDOW_WORKSPACE_BINDING_UNVERIFIED'); }
}
