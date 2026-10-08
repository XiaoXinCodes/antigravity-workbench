import type { Extension } from 'vscode';

/** A value snapshot: VS Code returns a new Extension wrapper on every lookup. */
export interface OfficialExtensionIdentity {
  readonly id: string;
  readonly uri: string;
  readonly path: string;
  readonly kind: number;
  readonly version: string;
  readonly main: string;
}

export function pinOfficialExtension(extension: Extension<unknown>): OfficialExtensionIdentity {
  return Object.freeze({
    id: extension.id.toLowerCase(),
    uri: extension.extensionUri.toString(),
    path: extension.extensionPath,
    kind: extension.extensionKind,
    version: String(extension.packageJSON.version ?? ''),
    main: String(extension.packageJSON.main ?? ''),
  });
}

/** Host validation and hub generation checks remain at the caller, around awaits. */
export function matchesOfficialExtension(expected: OfficialExtensionIdentity, current: Extension<unknown>): boolean {
  const value = pinOfficialExtension(current);
  return value.id === expected.id && value.uri === expected.uri && value.path === expected.path
    && value.kind === expected.kind && value.version === expected.version && value.main === expected.main;
}
