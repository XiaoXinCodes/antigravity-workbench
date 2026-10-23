import { debugErrorCode } from './debug-events';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { PrivateState } from './private-state';
import { LiveError } from './live-storage';

interface AutomaticKey { schema: 1; host: string; id: string; key: string }
/** Same-user filesystem protection, NOT an OS keychain. The official WSL
 * credential already uses this boundary. Retain this key with its backup so
 * extension-host crashes and in-memory SecretStorage backends cannot lose it. */
export class AutomaticOfflineKey {
  private readonly state: PrivateState<{ value?: AutomaticKey }>;
  private readonly directory: string;
  constructor(home: string, host: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(host) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new LiveError('OFFLINE_ARGUMENT_INVALID');
    this.directory = path.join(home, '.gemini', 'antigravity-workbench-offline', id, 'automatic-key');
    this.state = new PrivateState(this.directory, value => {
      const data = value as { value?: AutomaticKey };
      if (!data || typeof data !== 'object' || data.value && (data.value.schema !== 1 || data.value.host !== host || data.value.id !== id || !/^[a-f0-9]{64}$/.test(data.value.key))) throw new LiveError('OFFLINE_RECOVERY_INVALID');
      return data;
    }, () => ({}));
    this.host = host; this.id = id;
  }
  private readonly host: string;
  private readonly id: string;
  async read(): Promise<string | undefined> {
    try { await fs.lstat(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const key = (await this.state.read()).value?.key;
    if (!key) throw new LiveError('OFFLINE_AUTOMATIC_KEY_MISSING');
    return key;
  }
  async create(): Promise<string> {
    await this.state.transaction(data => {
      if (data.value) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
      data.value = { schema: 1, host: this.host, id: this.id, key: randomBytes(32).toString('hex') };
    });
    for (let directory = this.directory;; directory = path.dirname(directory)) {
      const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
      if (directory === path.dirname(directory)) break;
    }
    const key = await this.read(); if (!key) throw new LiveError('OFFLINE_RECOVERY_INVALID'); return key;
  }
}

interface AutomaticControlData { cancelled: boolean; status: string; attempt?: string; attemptCancelled?: boolean; attemptStatus?: string }
export class AutomaticOfflineControl {
  private readonly state: PrivateState<AutomaticControlData>;
  constructor(home: string, id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new LiveError('OFFLINE_ARGUMENT_INVALID');
    this.state = new PrivateState<AutomaticControlData>(path.join(home, '.gemini', 'antigravity-workbench-offline', id, 'automatic-control'), value => {
      const data = value as AutomaticControlData;
      if (!data || typeof data.cancelled !== 'boolean' || typeof data.status !== 'string' || !/^[A-Z_]{1,80}$/.test(data.status) || data.attempt !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.attempt)) throw new LiveError('OFFLINE_RECOVERY_INVALID');
      if (data.attempt && (typeof data.attemptCancelled !== 'boolean' || typeof data.attemptStatus !== 'string' || !/^[A-Z_]{1,80}$/.test(data.attemptStatus))) throw new LiveError('OFFLINE_RECOVERY_INVALID');
      return data;
    }, () => ({ cancelled: false, status: 'PREPARED' }));
  }
  async read(): Promise<{ cancelled: boolean; status: string; attempt?: string }> {
    for (let tries = 0;; tries++) {
      try { const data = await this.state.read(); return data.attempt ? { attempt: data.attempt, cancelled: data.attemptCancelled!, status: data.attemptStatus! } : data; }
      catch (error) { if (!(error instanceof Error) || error.message !== 'AUTOMATION_STORAGE_CHANGED' || tries >= 7) throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async reset(): Promise<string> { return this.state.transaction(data => {
    // Permanently cancel pre-epoch helper code. New attempts use separate
    // fields, so an already running old helper cannot revive on reset or erase
    // a new attempt's status with its late CANCELLED publication.
    data.cancelled = true; data.status = 'CANCELLED';
    data.attempt = randomUUID(); data.attemptCancelled = false; data.attemptStatus = 'PREPARED'; return data.attempt;
  }); }
  async cancel(expected?: { attempt: string | undefined }): Promise<void> {
    await this.state.transaction(data => { if (!expected || data.attempt === expected.attempt) { data.cancelled = true; if (data.attempt) data.attemptCancelled = true; } });
  }
  async status(status: string, attempt?: string): Promise<void> {
    const final = ['VERIFIED_TARGET', 'VERIFIED_ORIGINAL', 'KEPT_CURRENT'];
    await this.state.transaction(data => {
      // A helper can release its credential lock before publishing its result.
      // Its late status must not erase the new host's verified completion.
      if (attempt !== undefined && data.attempt !== attempt) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
      const current = data.attempt ? data.attemptStatus! : data.status;
      if (!final.includes(current) || final.includes(status)) { if (data.attempt) data.attemptStatus = status; else data.status = status; }
    });
    if (final.includes(status) && (await this.read()).status !== status) throw new LiveError('OFFLINE_JOURNAL_UNVERIFIED');
  }
}

/** No secrets in argv, environment, logs or inherited terminal. The helper
 * authenticates the private journal plus exact schema-4 marker before ACK. */
export async function launchAutomaticOfflineHelper(entry: string, id: string, host: string, kind: number, remote: string, action: 'install' | 'restore', attempt: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.VSCODE_ESM_ENTRYPOINT; delete env.VSCODE_AMD_ENTRYPOINT;
  let child: ReturnType<typeof spawn>;
  try { child = spawn(process.execPath, [entry, id, host, String(kind), remote, action, attempt], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env }); }
  catch { throw new LiveError('OFFLINE_HELPER_SPAWN_FAILED'); }
  await new Promise<void>((resolve, reject) => {
    let response = '', settled = false;
    const finish = (failure?: string): void => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdout?.destroy(); child.unref();
      if (!failure) resolve(); else reject(new LiveError(failure));
    };
    // Timeout does not imply cancellation or authorize another writer. The
    // durable marker and operation lock remain authoritative after lost ACK.
    const timer = setTimeout(() => finish('OFFLINE_HELPER_ACK_TIMEOUT'), 15_000);
    child.once('error', () => finish('OFFLINE_HELPER_SPAWN_FAILED')); child.once('close', () => finish('OFFLINE_HELPER_EXITED')); // Drain the fixed-code ACK before classifying an early exit.
    child.stdout?.on('data', (bytes: Buffer) => { response += bytes.toString('utf8'); if (response.length > 128) finish('OFFLINE_HELPER_PROTOCOL_INVALID'); else if (response.includes('\n')) {
      if (response === 'READY\n') finish();
      else {
        const match = /^ERROR ([A-Z][A-Z0-9_]{1,100})\n$/.exec(response);
        const code = match && debugErrorCode({ code: match[1] });
        finish(code && code !== 'UNCLASSIFIED_ERROR' ? code : 'OFFLINE_HELPER_PROTOCOL_INVALID');
      }
    } });
  });
}
