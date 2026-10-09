import * as vscode from 'vscode';
import { generation, hasOfficialHubApi, hubRpc } from './live-hub';
import { matchesOfficialExtension, pinOfficialExtension } from './official-extension-identity';
/** Read an already-running Hub only. Unknown identity never permits grant rotation. */
export async function passiveCurrentEmail(): Promise<string | undefined> {
  try {
    const ext = vscode.extensions.getExtension('google.google-antigravity');
    if (!ext?.isActive || !hasOfficialHubApi(ext.exports)) return;
    const descriptor = pinOfficialExtension(ext), api = { port: ext.exports.port, csrfToken: ext.exports.csrfToken }, pinned = generation(api), abort = new AbortController();
    const auth = await hubRpc(api, 'GetAuthStatus', abort.signal) as { authResult?: { hasValidAuth?: unknown } };
    const identity = await hubRpc(api, 'GetUserStatus', abort.signal) as { userStatus?: { email?: unknown } };
    const next = vscode.extensions.getExtension('google.google-antigravity'), email = identity?.userStatus?.email;
    if (auth?.authResult?.hasValidAuth === true && typeof email === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(email) && next?.isActive && matchesOfficialExtension(descriptor, next) && hasOfficialHubApi(next.exports) && generation(next.exports) === pinned) return email.toLowerCase();
  } catch { /* Fail closed; never start or activate the official backend. */ }
  return;
}
