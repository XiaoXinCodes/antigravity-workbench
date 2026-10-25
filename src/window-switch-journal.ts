import { isDeepStrictEqual } from 'node:util';
import { PrivateState } from './private-state';
import { WindowSwitchError, type WindowSwitchRecord } from './window-switch-protocol';

const invalid = (): never => { throw new WindowSwitchError('WINDOW_JOURNAL_INVALID'); };
const fields = (o: object, names: string[]): void => { if (Object.keys(o).some(k => !names.includes(k))) invalid(); };
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
/** A separate journal; never interprets or migrates existing schema-4 account
 * recovery records. Stores launch references and URIs, never account material. */
export function validateWindowSwitchRecord(value: unknown): WindowSwitchRecord {
  try {
    const r = value as WindowSwitchRecord;
    if (!r || typeof r !== 'object') invalid();
    fields(r, ['schema', 'id', 'attempt', 'scope', 'phase', 'windows', 'closeRequested', 'reopened', 'deadline', 'executor', 'outcome', 'reason']);
    if (r.schema !== 1 || ![r.id, r.attempt, r.scope].every(v => text(v) && /^[a-zA-Z0-9-]{1,128}$/.test(v)) ||
        !['preparing', 'armed', 'closing', 'switching', 'reopening', 'verifying', 'verified', 'cancelled', 'recovery-required'].includes(r.phase) ||
        !Number.isFinite(r.deadline) || !Array.isArray(r.windows) || !r.windows.length || r.windows.length > 32) invalid();
    for (const w of r.windows) {
      fields(w, ['window', 'host', 'scope', 'launcher', 'profile', 'authority', 'workspace']);
      fields(w.host, ['pid', 'startIdentity']); fields(w.workspace, ['kind', 'uri']);
      if (w.scope !== r.scope || ![w.window, w.host.startIdentity, w.launcher, w.profile, w.authority, w.workspace.uri].every(text) ||
          !Number.isSafeInteger(w.host.pid) || w.host.pid < 1 || !['folder', 'workspace'].includes(w.workspace.kind)) invalid();
      const uri = new URL(w.workspace.uri);
      if (!['file:', 'vscode-remote:'].includes(uri.protocol) || uri.username || uri.password || uri.search || uri.hash ||
          uri.protocol === 'vscode-remote:' && uri.host !== w.authority) invalid();
    }
    const ids = r.windows.map(w => w.window);
    if (new Set(ids).size !== ids.length || new Set(r.windows.map(w => `${w.host.pid}:${w.host.startIdentity}`)).size !== ids.length) invalid();
    for (const list of [r.closeRequested, r.reopened]) if (!Array.isArray(list) || new Set(list).size !== list.length || list.some(id => !ids.includes(id))) invalid();
    if (r.reopened.some(id => !r.closeRequested.includes(id))) invalid();
    if (r.executor) {
      fields(r.executor, ['pid', 'startIdentity']);
      if (!Number.isSafeInteger(r.executor.pid) || r.executor.pid < 1 || !text(r.executor.startIdentity)) invalid();
    } else if (['armed', 'closing', 'switching'].includes(r.phase)) invalid();
    if (r.outcome !== undefined && !['original', 'target', 'unknown'].includes(r.outcome)) invalid();
    if (r.reason !== undefined && !/^[A-Z_]{1,80}$/.test(r.reason)) invalid();
    if (r.phase === 'verified' && r.outcome !== 'target') invalid();
    return structuredClone(r);
  } catch { return invalid(); }
}
export class WindowSwitchJournal {
  private readonly state: PrivateState<{ record?: WindowSwitchRecord }>;
  constructor(directory: string) {
    this.state = new PrivateState(directory, value => {
      if (!value || typeof value !== 'object') invalid();
      fields(value as object, ['record']);
      const r = (value as { record?: unknown }).record;
      return r === undefined ? {} : { record: validateWindowSwitchRecord(r) };
    }, () => ({}));
  }
  async read(): Promise<WindowSwitchRecord | undefined> { return (await this.state.read()).record; }
  async save(next: WindowSwitchRecord, expected: WindowSwitchRecord | undefined): Promise<void> {
    const validated = validateWindowSwitchRecord(next);
    await this.state.transaction(state => {
      if (!isDeepStrictEqual(state.record, expected)) throw new WindowSwitchError('WINDOW_JOURNAL_CHANGED');
      if (expected && (expected.id !== next.id || expected.attempt !== next.attempt || expected.scope !== next.scope ||
          !isDeepStrictEqual(expected.windows, next.windows))) throw new WindowSwitchError('WINDOW_JOURNAL_CHANGED');
      state.record = validated;
    });
    if (!isDeepStrictEqual(await this.read(), validated)) throw new WindowSwitchError('WINDOW_JOURNAL_CHANGED');
  }
}
