import * as os from 'node:os';
import * as path from 'node:path';
import { EnvironmentTokenSlots } from './live-environment';
import { createWslReadGuard } from './live-wsl-proof';
import { validBearerToken } from './account-quota-transport';

export interface CurrentImageToken { token: string; expiresAt?: number; verify(): Promise<void> }
const unavailable = () => new Error('IMAGE_DIRECT_CURRENT_TOKEN_UNAVAILABLE');

/** Read the pinned official WSL Hub's *current* file token without refreshing or writing it. */
export async function readCurrentOfficialWslToken(input: {
  api(): unknown; assertCurrent(): Promise<void>; signal: AbortSignal; now?: () => number;
  home?: string; executable?: string;
}): Promise<CurrentImageToken> {
  if (input.signal.aborted) throw new Error('IMAGE_CANCELLED');
  if (process.platform !== 'linux') throw unavailable();
  const home = input.home ?? os.homedir();
  const executable = input.executable ?? path.join(home, '.gemini', 'bin', 'agy');
  try {
    const slots = new EnvironmentTokenSlots(home);
    if (await slots.mode() !== 'wsl-file') throw unavailable();
    // Read-only scope: the active process, generation and its explicit WSL file
    // route are attested below. The fixed binary hash belongs to the separate
    // credential-mutation contract and may lag an official CLI update.
    const guard = createWslReadGuard(home, executable, input.api);
    await input.assertCurrent();
    if (!await guard()) throw unavailable();
    const snapshot = await slots.read();
    if (snapshot.keyringState !== 'unobserved' || snapshot.keyring !== null || !snapshot.file) throw unavailable();
    const raw = snapshot.file;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw unavailable();
    const value = stored as Record<string, unknown>;
    const nested = value.token;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw unavailable();
    const token = nested as Record<string, unknown>;
    if (!validBearerToken(token.access_token) || typeof token.expiry !== 'string' ||
        !Number.isFinite(Date.parse(token.expiry)) || Date.parse(token.expiry) <= (input.now?.() ?? Date.now()) + 60_000)
      throw unavailable();
    const verify = async () => {
      if (input.signal.aborted) throw new Error('IMAGE_CANCELLED');
      await input.assertCurrent();
      if (!await guard() || (await slots.read()).file !== raw) throw unavailable();
      if (Date.parse(token.expiry as string) <= (input.now?.() ?? Date.now()) + 5_000) throw unavailable();
    };
    await verify();
    return { token: token.access_token, expiresAt: Date.parse(token.expiry), verify };
  } catch {
    if (input.signal.aborted) throw new Error('IMAGE_CANCELLED');
    throw unavailable();
  }
}
