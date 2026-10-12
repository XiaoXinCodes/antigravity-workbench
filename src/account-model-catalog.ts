import { createHash } from 'node:crypto';
import { parseModelCatalog, modelCatalogPayload } from './model-catalog';
import { catalogError } from './model-catalog-error';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { LiveError } from './live-storage';
import { validImageProject } from './direct-image-project';
import { cloudCodeHost, type CloudCodeEndpoint } from './cloudcode-service';
const HTTP_USER_AGENT = 'Antigravity-Workbench/0.1.15';

const PATH = '/v1internal:fetchAvailableModels';
const RESPONSE_LIMIT = 2 * 1024 * 1024;
type RequestHttps = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ReturnType<typeof https.request>;

/** One target-account catalog lookup using the verified project and bearer from the same transaction. Never refresh, retry, redirect, save or print credentials/project. */
export async function readAccountModelCatalog(token: string, project: string, signal: AbortSignal, endpoint: CloudCodeEndpoint, requestHttps: RequestHttps = https.request): Promise<unknown> {
  if (!validImageProject(project)) throw catalogError('IMAGE_SAVED_MODELS_INVALID', 'binding', 'binding');
  const BODY = JSON.stringify({ project });
  const host = cloudCodeHost(endpoint);
  if (signal.aborted) throw new Error('IMAGE_CANCELLED');
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  return new Promise((resolve, reject) => {
    let done = false, count = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) reject(error); else resolve(value);
    };
    const req = requestHttps({ protocol: 'https:', hostname: host, port: 443, path: PATH, method: 'POST',
      agent: false, rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(BODY), 'User-Agent': HTTP_USER_AGENT } }, response => {
      if (response.statusCode !== 200) { response.destroy(); finish(response.statusCode === 401 ? Object.assign(new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED'), { catalogStage: 'transport', catalogFailure: 'http', httpStatus: 401 }) : catalogError(response.statusCode === 403 ? 'IMAGE_SAVED_MODELS_FORBIDDEN' : response.statusCode === 429 ? 'IMAGE_DIRECT_RATE_LIMITED' : [500, 502, 503, 504].includes(response.statusCode ?? 0) ? 'IMAGE_SAVED_MODELS_TRANSIENT' : 'IMAGE_SAVED_MODELS_FAILED', 'transport', 'http', response.statusCode)); return; }
      if (typeof response.headers['content-type'] !== 'string' ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'])) {
        response.destroy(); finish(catalogError('IMAGE_SAVED_MODELS_INVALID', 'parse', 'parse', 200)); return;
      }
      response.on('data', (chunk: Buffer) => {
        if (done) return;
        count += chunk.length;
        if (count > RESPONSE_LIMIT) { req.destroy(); finish(catalogError('IMAGE_SAVED_MODELS_INVALID', 'parse', 'parse', 200)); }
        else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        let parsed: unknown;
        try { const bytes = Buffer.concat(chunks), text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error(); parsed = JSON.parse(text); }
        catch { finish(catalogError('IMAGE_SAVED_MODELS_INVALID', 'parse', 'parse', 200)); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { finish(catalogError('IMAGE_SAVED_MODELS_INVALID', 'parse', 'parse', 200)); return; }
        finish(undefined, parsed);
      });
      response.on('aborted', () => finish(catalogError('IMAGE_SAVED_MODELS_TRANSIENT', 'transport', 'network')));
      response.on('error', () => finish(catalogError('IMAGE_SAVED_MODELS_TRANSIENT', 'transport', 'network')));
    });
    const abort = () => { finish(new Error('IMAGE_CANCELLED')); req.destroy(); };
    const timer = setTimeout(() => { finish(catalogError('IMAGE_SAVED_MODELS_TRANSIENT', 'transport', 'timeout')); req.destroy(); }, 15_000);
    req.on('error', (error: NodeJS.ErrnoException) => finish(catalogError(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(error.code ?? '') ? 'IMAGE_SAVED_MODELS_TRANSIENT' : 'IMAGE_SAVED_MODELS_FAILED', 'transport', /^(ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(error.code ?? '') ? 'tls' : error.code === 'ETIMEDOUT' ? 'timeout' : 'network')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    req.end(BODY);
  });
}

/** One public directory per verified account/credential/project/endpoint scope.
 * Bearers and projects never enter persistence, and this cache never authorizes a send. */
export interface SharedCatalogSnapshot { catalog: import('./model-catalog').ModelCatalog; queriedAt: string; cacheHit: boolean }
type CatalogStorage = Pick<import('vscode').Memento, 'get' | 'update'>;
interface StoredDirectory { payload: unknown; queriedAt: string }
interface DirectoryFlight { abort: AbortController; verify: () => Promise<void>; promise: Promise<SharedCatalogSnapshot>; users: number }
const DIRECTORY_KEY = 'model.catalog.directory.v1';
const directoryServices = new WeakMap<CatalogStorage, SharedAccountModelCatalog>();
export function sharedAccountModelCatalog(storage: CatalogStorage, secrets?: Pick<import('vscode').SecretStorage, 'onDidChange'>, subscriptions?: { dispose(): unknown }[]): SharedAccountModelCatalog {
  let service = directoryServices.get(storage);
  if (!service) { service = new SharedAccountModelCatalog(storage); directoryServices.set(storage, service); }
  service.watchCredentials(secrets, subscriptions); return service;
}
export function accountCatalogScope(account: { id: string; expectedEmail: string; hostId?: string; capturedAt?: string; verifiedSubject?: string; quotaDisplayId?: string }, endpoint: CloudCodeEndpoint, revision: string, token: string, project: string): string {
  return createHash('sha256').update(account.id).digest('hex') + ':' + createHash('sha256').update(JSON.stringify([account.id, account.expectedEmail.toLowerCase(), account.hostId, account.capturedAt, account.verifiedSubject, account.quotaDisplayId, endpoint, revision, createHash('sha256').update(token).digest('hex'), project])).digest('hex');
}
export class SharedAccountModelCatalog {
  private readonly entries = new Map<string, StoredDirectory>();
  private readonly flights = new Map<string, DirectoryFlight>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly invalidated = new Set<string>();
  private readonly watched = new WeakSet<object>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<(accountId: string) => void>();
  revision(accountId: string): number { return this.revisions.get(accountId) ?? 0; }
  onDidInvalidateAccount(listener: (accountId: string) => void): { dispose(): void } { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  watchCredentials(secrets?: Pick<import('vscode').SecretStorage, 'onDidChange'>, subscriptions?: { dispose(): unknown }[]): void {
    if (!secrets || typeof secrets.onDidChange !== 'function' || this.watched.has(secrets)) return;
    this.watched.add(secrets);
    const subscription = secrets.onDidChange(event => {
      const match = /^live-switch\.account\.v1\.([A-Za-z0-9-]{1,128})$/.exec(event.key); if (!match) return;
      const id = match[1]!, family = createHash('sha256').update(id).digest('hex') + ':';
      this.restore(); for (const key of new Set([...this.entries.keys(), ...this.flights.keys()])) if (key.startsWith(family)) this.invalidate(key);
      this.revisions.set(id, this.revision(id) + 1); for (const listener of [...this.listeners]) listener(id);
    });
    subscriptions?.push({ dispose: () => { subscription.dispose(); this.watched.delete(secrets); } });
  }
  constructor(private readonly storage?: CatalogStorage, private readonly now: () => number = Date.now) {}
  private restore(): void {
    const stored = this.storage?.get<unknown>(DIRECTORY_KEY);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    for (const [key, value] of Object.entries(stored).slice(-50)) {
      if (this.invalidated.has(key) || !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key) || !value || typeof value !== 'object') continue;
      const entry = value as StoredDirectory; if (typeof entry.queriedAt !== 'string' || entry.queriedAt.length > 64) continue; const time = Date.parse(entry.queriedAt);
      if (!Number.isFinite(time) || time > this.now()) continue;
      let payload; try { payload = modelCatalogPayload(parseModelCatalog(entry.payload)); } catch { continue; }
      const clean = { payload, queriedAt: entry.queriedAt };
      if (time > Date.parse(this.entries.get(key)?.queriedAt ?? '')) this.entries.set(key, clean);
      else if (!this.entries.has(key)) this.entries.set(key, clean);
    }
    while (this.entries.size > 50) this.entries.delete(this.entries.keys().next().value!);
  }
  invalidate(key: string): void { this.entries.delete(key); this.invalidated.add(key); const flight = this.flights.get(key); this.flights.delete(key); flight?.abort.abort(); }
  peek(key: string): (SharedCatalogSnapshot & { stale: boolean }) | undefined {
    this.restore(); const entry = this.entries.get(key); if (!entry) return;
    return { catalog: parseModelCatalog(entry.payload), queriedAt: entry.queriedAt, cacheHit: true, stale: this.now() - Date.parse(entry.queriedAt) >= 5 * 60_000 };
  }
  async read(key: string, signal: AbortSignal, fetch: (signal: AbortSignal) => Promise<import('./model-catalog').ModelCatalog>, force = false, verify: () => Promise<void> = async () => undefined): Promise<SharedCatalogSnapshot> {
    if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key)) throw Error('MODEL_CATALOG_SCOPE_INVALID');
    if (signal.aborted) throw Error('IMAGE_CANCELLED');
    const cached = this.peek(key);
    if (!force && cached && !cached.stale) { await verify(); if (signal.aborted) throw Error('IMAGE_CANCELLED'); return cached; }
    let flight = this.flights.get(key);
    if (!flight) {
      const abort = new AbortController();
      const created: DirectoryFlight = { abort, verify, users: 0, promise: Promise.resolve(undefined as unknown as SharedCatalogSnapshot) };
      this.flights.set(key, created);
      created.promise = Promise.resolve().then(async () => {
        if (abort.signal.aborted) throw Error('IMAGE_CANCELLED');
        const catalog = await fetch(abort.signal);
        if (abort.signal.aborted || this.flights.get(key) !== created) throw Error('IMAGE_CANCELLED');
        await verify();
        if (abort.signal.aborted || this.flights.get(key) !== created) throw Error('IMAGE_CANCELLED');
        const queriedAt = new Date(this.now()).toISOString(), payload = modelCatalogPayload(catalog);
        const snapshot = { catalog: parseModelCatalog(payload), queriedAt, cacheHit: false };
        this.invalidated.delete(key); this.entries.delete(key); this.entries.set(key, { payload, queriedAt });
        while (this.entries.size > 50) this.entries.delete(this.entries.keys().next().value!);
        this.writes = this.writes.catch(() => undefined).then(async () => { await this.storage?.update(DIRECTORY_KEY, Object.fromEntries(this.entries)); });
        void this.writes.catch(() => undefined);
        return snapshot;
      }).finally(() => { if (this.flights.get(key) === created) this.flights.delete(key); });
      flight = created;
    }
    const shared = flight; shared.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, snapshot?: SharedCatalogSnapshot) => {
        if (done) return; done = true; signal.removeEventListener('abort', cancel); shared.users--;
        if (!shared.users && this.flights.get(key) === shared) { this.flights.delete(key); shared.abort.abort(); }
        if (error) reject(error); else resolve(snapshot!);
      };
      const cancel = () => finish(Error('IMAGE_CANCELLED'));
      signal.addEventListener('abort', cancel, { once: true });
      shared.promise.then(async snapshot => { if (verify !== shared.verify) await verify(); if (signal.aborted) throw Error('IMAGE_CANCELLED'); finish(undefined, snapshot); }).catch(error => finish(error));
      if (signal.aborted) cancel();
    });
  }
}
