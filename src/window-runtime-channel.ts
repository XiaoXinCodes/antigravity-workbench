import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PrivateState } from './private-state';
import { probeProcessIdentity } from './live-lock';
import { WindowSwitchError, type WindowBirth } from './window-switch-protocol';
import { validateWslLaunchPlan, type WslLaunchPlan } from './wsl-window-launcher';

export interface WindowRuntimeMember { window: string; host: WindowBirth; plan: WslLaunchPlan; scope: string }
export type WindowRuntimeResult = 'saved' | 'cancelled' | 'close-returned' | 'failed';
export interface WindowRuntimeRequest {
  nonce: string; window: string; host: WindowBirth; kind: 'save' | 'close';
  state: 'queued' | 'dispatched' | 'acknowledged' | 'cancelled'; nativeDispatched: boolean; result?: WindowRuntimeResult;
}
export interface WindowRuntimeGroup {
  attempt: string; transactionId: string; scope: string; members: WindowRuntimeMember[];
  deadline: number; cancelled: boolean; initiator: WindowBirth; executor?: WindowBirth; requests: WindowRuntimeRequest[];
}
export interface WindowRuntimeIO {
  self(): Promise<WindowBirth>;
  inspect(host: WindowBirth): Promise<'alive' | 'exited' | 'unknown'>;
  now(): number;
}
interface ChannelState { members: WindowRuntimeMember[]; group?: WindowRuntimeGroup; completed: string[] }
function fail(code: string): never { throw new WindowSwitchError(code); }
const token = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
const birth = (h: WindowBirth): string => `${h.pid}:${h.startIdentity}`;
function validBirth(h: WindowBirth): boolean {
  return !!h && Object.keys(h).every(k => ['pid','startIdentity'].includes(k)) && Number.isSafeInteger(h.pid) && h.pid > 0 &&
    typeof h.startIdentity === 'string' && h.startIdentity.length > 0 && h.startIdentity.length < 256 && ![...h.startIdentity].some(c => c.charCodeAt(0) < 32);
}
function member(value: WindowRuntimeMember): WindowRuntimeMember {
  if (!value || Object.keys(value).some(k => !['window','host','plan','scope'].includes(k)) || !token(value.window) || !token(value.scope) || !validBirth(value.host)) fail('WINDOW_CHANNEL_INVALID');
  return { ...value, plan: validateWslLaunchPlan(value.plan) };
}
function unique(rows: WindowRuntimeMember[]): boolean {
  return new Set(rows.map(w => w.window)).size === rows.length && new Set(rows.map(w => birth(w.host))).size === rows.length;
}
function parse(value: unknown): ChannelState {
  const s = value as ChannelState;
  if (!s || Object.keys(s).some(k => !['members','group','completed'].includes(k)) || !Array.isArray(s.members) || s.members.length > 128 ||
    !Array.isArray(s.completed) || s.completed.length > 1024 || s.completed.some(a => !token(a)) || new Set(s.completed).size !== s.completed.length) fail('WINDOW_CHANNEL_INVALID');
  s.members = s.members.map(member); if (!unique(s.members)) fail('WINDOW_CHANNEL_INVALID');
  if (s.group) {
    const g = s.group;
    if (Object.keys(g).some(k => !['attempt','transactionId','scope','members','deadline','cancelled','initiator','executor','requests'].includes(k)) ||
      !token(g.attempt) || !token(g.transactionId) || !token(g.scope) || s.completed.includes(g.attempt) || !Number.isSafeInteger(g.deadline) || typeof g.cancelled !== 'boolean' || !validBirth(g.initiator) ||
      !Array.isArray(g.members) || !g.members.length || g.members.length > 32 || !Array.isArray(g.requests) || g.requests.length > 64 || g.executor !== undefined && !validBirth(g.executor)) fail('WINDOW_CHANNEL_INVALID');
    g.members = g.members.map(member);
    if (!unique(g.members) || !g.members.some(m => birth(m.host) === birth(g.initiator)) || g.members.some(m => m.scope !== g.scope) || new Set(g.requests.map(r => r.nonce)).size !== g.requests.length || new Set(g.requests.map(r => `${r.window}:${r.kind}`)).size !== g.requests.length) fail('WINDOW_CHANNEL_INVALID');
    for (const r of g.requests) {
      if (!r || Object.keys(r).some(k => !['nonce','window','host','kind','state','nativeDispatched','result'].includes(k)) || !token(r.nonce) || !validBirth(r.host) || !['save','close'].includes(r.kind) ||
        typeof r.nativeDispatched !== 'boolean' || r.nativeDispatched && (r.kind !== 'close' || !['dispatched','acknowledged'].includes(r.state)) || !['queued','dispatched','acknowledged','cancelled'].includes(r.state) || !g.members.some(m => m.window === r.window && birth(m.host) === birth(r.host)) ||
        (r.result !== undefined && !['saved','cancelled','close-returned','failed'].includes(r.result)) ||
        (r.state === 'acknowledged') !== (r.result !== undefined) || r.kind === 'save' && r.result === 'close-returned' || r.kind === 'close' && r.result === 'saved' || r.result === 'close-returned' && !r.nativeDispatched) fail('WINDOW_CHANNEL_INVALID');
    }
  }
  return s;
}
const native: WindowRuntimeIO = {
  async self() { const p = await probeProcessIdentity(process.pid); if (p.state !== 'alive') fail('WINDOW_HOST_BINDING_UNVERIFIED'); return { pid: process.pid, startIdentity: p.startIdentity }; },
  async inspect(h) { const p = await probeProcessIdentity(h.pid); return p.state === 'dead' || p.state === 'alive' && p.startIdentity !== h.startIdentity ? 'exited' : p.state === 'alive' ? 'alive' : 'unknown'; },
  now: Date.now,
};
/** Private local-file transport, not a credential API. Each actor claims only
 * requests addressed to its own current process birth. A durable dispatched
 * receipt is written before native execution; never redeliver it after crash.
 * close-returned acknowledges a command, NEVER a closed/vetoed window. */
export class WindowRuntimeChannel {
  readonly directory: string;
  private readonly store: PrivateState<ChannelState>;
  constructor(home: string, private readonly io: WindowRuntimeIO = native) {
    this.directory = path.join(home, '.gemini', 'antigravity-workbench-window-channel');
    this.store = new PrivateState(this.directory, parse, () => ({ members: [], completed: [] }));
  }
  private async snapshot(): Promise<ChannelState> {
    // Another actor may atomically replace state.json while an unlocked reader
    // holds the old inode. Retry only that explicit changed-snapshot signal;
    // every retry reopens and repeats the full ownership/shape checks.
    for (let retry = 0; ; retry++) {
      try { return await this.store.read(); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'AUTOMATION_STORAGE_CHANGED' || retry >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
  }
  async register(binding: WindowRuntimeMember): Promise<void> {
    const m = member(structuredClone(binding)), self = await this.io.self();
    if (birth(self) !== birth(m.host) || await this.io.inspect(m.host) !== 'alive' || birth(await this.io.self()) !== birth(self)) fail('WINDOW_HOST_BINDING_UNVERIFIED');
    await this.store.transaction(s => {
      const old = s.members.find(w => w.window === m.window || birth(w.host) === birth(m.host));
      if (old && isDeepStrictEqual(old, m)) return;
      if (old && (old.window !== m.window || birth(old.host) !== birth(m.host) || s.group?.members.some(w => birth(w.host) === birth(m.host)))) fail('WINDOW_ALREADY_REGISTERED');
      if (old) s.members.splice(s.members.indexOf(old), 1);
      if (s.members.length >= 128) fail('WINDOW_REGISTRY_FULL');
      s.members.push(m);
    });
  }
  async pruneExited(): Promise<void> {
    const rows = (await this.snapshot()).members, dead: WindowRuntimeMember[] = [];
    for (const m of rows) if (await this.io.inspect(m.host) === 'exited') dead.push(m);
    await this.store.transaction(s => { s.members = s.members.filter(m => !dead.some(d => isDeepStrictEqual(d, m))); });
  }
  async roster(census: { complete: boolean; unknown: boolean; hosts: WindowBirth[] }, scope: string): Promise<{ complete: boolean; members: WindowRuntimeMember[] }> {
    if (!token(scope) || !census.complete || census.unknown || !census.hosts.length || census.hosts.some(h => !validBirth(h)) || new Set(census.hosts.map(birth)).size !== census.hosts.length) return { complete: false, members: [] };
    const rows = (await this.snapshot()).members.filter(m => m.scope === scope && census.hosts.some(h => birth(h) === birth(m.host)));
    return rows.length === census.hosts.length ? { complete: true, members: rows } : { complete: false, members: [] };
  }
  async createGroup(attempt: string, transactionId: string, members: WindowRuntimeMember[], deadline = this.io.now() + 300_000): Promise<WindowRuntimeGroup> {
    if (!token(attempt) || !token(transactionId) || !members.length || members.length > 32 || !Number.isSafeInteger(deadline) || deadline <= this.io.now() || deadline - this.io.now() > 300_000) fail('WINDOW_ARGUMENT_INVALID');
    const rows = members.map(m => member(structuredClone(m))), initiator = await this.io.self(); if (!validBirth(initiator) || !rows.some(m => birth(m.host) === birth(initiator)) || await this.io.inspect(initiator) !== 'alive') fail('WINDOW_HOST_BINDING_UNVERIFIED'); if (!unique(rows) || rows.some(m => m.scope !== rows[0]!.scope)) fail('WINDOW_PARTICIPANTS_UNVERIFIED');
    return this.store.transaction(s => {
      if (s.group) {
        if (s.group.attempt === attempt && s.group.transactionId === transactionId && isDeepStrictEqual(s.group.members, rows)) return structuredClone(s.group);
        return fail('WINDOW_ATTEMPT_EXISTS');
      }
      if (s.completed.includes(attempt) || rows.some(m => !s.members.some(r => isDeepStrictEqual(r, m)))) fail('WINDOW_PARTICIPANTS_CHANGED');
      s.group = { attempt, transactionId, scope: rows[0]!.scope, members: rows, deadline, cancelled: false, initiator, requests: [] };
      return structuredClone(s.group);
    });
  }
  async readGroup(attempt?: string): Promise<WindowRuntimeGroup | undefined> {
    const g = (await this.snapshot()).group; return g && (attempt === undefined || attempt === g.attempt) ? g : undefined;
  }
  private active(g: WindowRuntimeGroup | undefined, attempt: string): WindowRuntimeGroup {
    if (!g || g.attempt !== attempt) return fail('WINDOW_ATTEMPT_CHANGED');
    if (g.cancelled || this.io.now() >= g.deadline) return fail(g.cancelled ? 'WINDOW_CANCELLED' : 'WINDOW_TIMEOUT');
    return g;
  }
  async arm(attempt: string, executor: WindowBirth): Promise<void> {
    if (!validBirth(executor) || birth(await this.io.self()) !== birth(executor) || await this.io.inspect(executor) !== 'alive') fail('WINDOW_HANDOFF_UNVERIFIED');
    await this.store.transaction(s => { const g = this.active(s.group, attempt); if (g.members.some(m => !g.requests.some(r => r.window === m.window && r.kind === 'save' && r.result === 'saved'))) fail('WINDOW_ATTEMPT_NOT_ARMED'); if (g.members.some(m => birth(m.host) === birth(executor)) || g.executor && birth(g.executor) !== birth(executor)) fail('WINDOW_HANDOFF_UNVERIFIED'); g.executor = executor; });
  }
  async request(attempt: string, window: string, kind: 'save' | 'close'): Promise<string> {
    if (!['save','close'].includes(kind)) fail('WINDOW_ARGUMENT_INVALID');
    const previous = await this.readGroup(attempt);
    if (kind === 'close' && (!previous?.executor || await this.io.inspect(previous.executor) !== 'alive')) fail('WINDOW_HANDOFF_UNVERIFIED');
    return this.store.transaction(s => {
      const g = this.active(s.group, attempt), m = g.members.find(w => w.window === window); if (!m) return fail('WINDOW_PARTICIPANTS_CHANGED');
      if (kind === 'close' && (!g.executor || !previous?.executor || birth(g.executor) !== birth(previous.executor) || g.members.some(w => !g.requests.some(r => r.window === w.window && r.kind === 'save' && r.result === 'saved')))) fail('WINDOW_ATTEMPT_NOT_ARMED');
      const existing = g.requests.find(r => r.window === window && r.kind === kind); if (existing) return existing.nonce;
      const nonce = randomUUID(); g.requests.push({ nonce, window, host: m.host, kind, state: 'queued', nativeDispatched: false }); return nonce;
    });
  }
  async take(host: WindowBirth): Promise<(WindowRuntimeRequest & { attempt: string; transactionId: string; member: WindowRuntimeMember }) | undefined> {
    if (!validBirth(host) || birth(await this.io.self()) !== birth(host) || await this.io.inspect(host) !== 'alive') fail('WINDOW_HOST_BINDING_UNVERIFIED');
    const previous = await this.readGroup();
    if (!previous || previous.cancelled || this.io.now() >= previous.deadline) return undefined;
    const executorAlive = !!previous.executor && await this.io.inspect(previous.executor) === 'alive';
    return this.store.transaction(s => {
      const g = s.group; if (!g || g.attempt !== previous.attempt || g.cancelled || this.io.now() >= g.deadline) return undefined;
      const m = g.members.find(w => birth(w.host) === birth(host)); if (!m || !s.members.some(r => isDeepStrictEqual(r, m))) return undefined;
      const r = g.requests.find(r => birth(r.host) === birth(host) && r.state === 'queued'); if (!r) return undefined;
      if (r.kind === 'close' && (!executorAlive || !g.executor || !previous.executor || birth(g.executor) !== birth(previous.executor))) return undefined;
      r.state = 'dispatched'; return { ...structuredClone(r), attempt: g.attempt, transactionId: g.transactionId, member: structuredClone(m) };
    });
  }
  /** Recheck immediately before native side effect; cancelled dispatched work
   * stays durable because a concurrent cancellation cannot withdraw Electron. */
  async authorize(attempt: string, nonce: string, host: WindowBirth): Promise<void> {
    if (birth(await this.io.self()) !== birth(host) || await this.io.inspect(host) !== 'alive') fail('WINDOW_HOST_BINDING_UNVERIFIED');
    const g = this.active(await this.readGroup(attempt), attempt), r = g.requests.find(r => r.nonce === nonce && birth(r.host) === birth(host));
    if (!r || r.state !== 'dispatched') fail('WINDOW_REQUEST_CHANGED');
    if (r.kind === 'close' && (!g.executor || await this.io.inspect(g.executor) !== 'alive')) fail('WINDOW_HANDOFF_UNVERIFIED');
  }
  /** Called as the last awaited beforeDispatch hook of native close. Taking
   * a request is not this marker: native save can still cancel beforehand. */
  async markCloseDispatched(attempt: string, nonce: string, host: WindowBirth): Promise<void> {
    await this.authorize(attempt, nonce, host);
    await this.store.transaction(s => {
      const g = this.active(s.group, attempt), r = g.requests.find(q => q.nonce === nonce && birth(q.host) === birth(host));
      if (!r || r.kind !== 'close' || r.state !== 'dispatched' || r.nativeDispatched) fail('WINDOW_REQUEST_CHANGED');
      r.nativeDispatched = true;
    });
  }
  async ack(attempt: string, nonce: string, host: WindowBirth, result: WindowRuntimeResult): Promise<void> {
    if (birth(await this.io.self()) !== birth(host) || await this.io.inspect(host) !== 'alive') fail('WINDOW_HOST_BINDING_UNVERIFIED');
    await this.store.transaction(s => {
      const g = s.group; if (!g || g.attempt !== attempt) fail('WINDOW_ATTEMPT_CHANGED');
      const r = g.requests.find(r => r.nonce === nonce && birth(r.host) === birth(host));
      if (!r || !['saved','cancelled','close-returned','failed'].includes(result) || r.kind === 'save' && result === 'close-returned' || r.kind === 'close' && result === 'saved' || result === 'close-returned' && !r.nativeDispatched) fail('WINDOW_REQUEST_CHANGED');
      if (r.state === 'acknowledged' && r.result === result) return;
      if (r.state !== 'dispatched') fail('WINDOW_REQUEST_CHANGED');
      r.state = 'acknowledged'; r.result = result;
      if (result === 'cancelled' || result === 'failed') { g.cancelled = true; for (const q of g.requests) if (q.state === 'queued') q.state = 'cancelled'; }
    });
  }
  async cancel(attempt: string): Promise<void> {
    await this.store.transaction(s => { if (!s.group || s.group.attempt !== attempt) fail('WINDOW_ATTEMPT_CHANGED'); s.group.cancelled = true; for (const r of s.group.requests) if (r.state === 'queued') r.state = 'cancelled'; });
  }
  /** Probe-only preflight before removing independent reopen materials. */
  async assertFinishable(attempt: string): Promise<void> { await this.finishable(attempt); }
  private async finishable(attempt: string): Promise<WindowRuntimeGroup> {
    const g = await this.readGroup(attempt); if (!g) fail('WINDOW_ATTEMPT_CHANGED');
    for (const r of g.requests) if (r.kind === 'close' && r.nativeDispatched && await this.io.inspect(r.host) !== 'exited') fail('WINDOW_CLOSE_PENDING');
    if (g.requests.some(r => r.state === 'queued' || r.state === 'dispatched' && !r.nativeDispatched && !g.cancelled)) fail('WINDOW_REQUEST_PENDING');
    return g;
  }
  /** Explicit caller settlement only; never TTL cleanup or inferred veto. */
  async finish(attempt: string): Promise<void> {
    const g = await this.finishable(attempt);
    await this.store.transaction(s => { if (!isDeepStrictEqual(s.group, g)) fail('WINDOW_ATTEMPT_CHANGED'); if (s.completed.length >= 1024) fail('WINDOW_CHANNEL_HISTORY_FULL'); s.completed.push(attempt); delete s.group; });
  }
}
