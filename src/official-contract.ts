import type * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { LiveError } from './live-storage';

const MAX_ENTRYPOINT = 32 * 1024 * 1024;

/** Optional diagnostic label only. No release number establishes compatibility. */
export function diagnosticBackendVersion(output: string): string | undefined {
  if (output.length > 8192) return undefined;
  const versions = output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g) || [];
  return versions.length === 1 && versions[0]!.length <= 128 ? versions[0] : undefined;
}
type InstalledExtension = Pick<vscode.Extension<unknown>, 'extensionPath' | 'packageJSON'>;

export function officialEntryPath(extension: InstalledExtension): string {
  const entry: unknown = extension.packageJSON?.main;
  if (typeof entry !== 'string' || !entry || entry.length > 4096 || entry.includes('\0') || path.isAbsolute(entry)) throw new LiveError('OFFICIAL_ENTRY_UNAVAILABLE');
  const main = path.resolve(extension.extensionPath, entry);
  const relative = path.relative(extension.extensionPath, main);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new LiveError('OFFICIAL_ENTRY_UNAVAILABLE');
  return main;
}

/** Bounds the installed entrypoint. Live API, lifecycle and storage are checked separately. */
export async function assertOfficialEntrypoint(extension: InstalledExtension): Promise<void> {
  try {
    const root = await fs.realpath(extension.extensionPath), main = await fs.realpath(officialEntryPath(extension));
    const relative = path.relative(root, main);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new LiveError('OFFICIAL_ENTRY_UNAVAILABLE');
    const file = await fs.open(main, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > MAX_ENTRYPOINT) throw new LiveError('OFFICIAL_ENTRY_UNAVAILABLE');
      const current = await fs.stat(main);
      if (current.size !== before.size || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new LiveError('OFFICIAL_ENTRY_UNAVAILABLE');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof LiveError) throw error;
    throw new LiveError('OFFICIAL_ENTRY_UNAVAILABLE');
  }
}
