/* eslint-disable no-control-regex -- Persist only bounded public display text. */
import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import { validModelId, type ModelChoice, type ModelUse } from './model-catalog';
import type { CloudCodeEndpoint } from './cloudcode-service';
const KEY = 'model.catalog.display.v1';
type Storage = Pick<vscode.Memento, 'get' | 'update'>;
export interface CatalogDisplay { models: ModelChoice[]; queriedAt: string; source: 'fetchAvailableModels'; selectedId?: string; confirmedIds?: string[] }
const queues = new WeakMap<Storage, Promise<unknown>>();
export function catalogDisplayKey(fingerprint: string, endpoint: CloudCodeEndpoint, usage: ModelUse, identity?: { verifiedSubject?: string; quotaDisplayId?: string }): string {
  return createHash('sha256').update(JSON.stringify([fingerprint, endpoint, usage, identity?.verifiedSubject, identity?.quotaDisplayId])).digest('hex');
}
function read(value: unknown): Record<string, CatalogDisplay> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: Record<string, CatalogDisplay> = {};
  for (const [key, raw] of Object.entries(value).slice(-50)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !raw || typeof raw !== 'object') continue;
    const row = raw as CatalogDisplay;
    if (row.source !== 'fetchAvailableModels' || typeof row.queriedAt !== 'string' || !Number.isFinite(Date.parse(row.queriedAt)) || !Array.isArray(row.models) || row.models.length > 500) continue;
    if (row.models.some(m => !m || !validModelId(m.id) || typeof m.label !== 'string' || m.label.length > 332 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(m.label))) continue;
    entries[key] = { models: row.models.map(m => ({ id: m.id, label: m.label, ...(m.classification === 'unclassified' ? { classification: 'unclassified' as const } : {}) })), queriedAt: row.queriedAt, source: row.source, ...(Array.isArray(row.confirmedIds) ? { confirmedIds: [...new Set(row.confirmedIds.filter(validModelId))].slice(0, 500) } : {}), ...(validModelId(row.selectedId) ? { selectedId: row.selectedId } : {}) };
  }
  return entries;
}
/** Display only. Neither cache presence nor a saved choice authorizes a request. */
export class ModelCatalogDisplay {
  constructor(private readonly storage: Storage) {}
  get(key: string): CatalogDisplay | undefined { return read(this.storage.get(KEY))[key]; }
  private async write(key: string, update: (previous: CatalogDisplay | undefined) => CatalogDisplay | undefined): Promise<void> {
    const next = (queues.get(this.storage) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const entries = read(this.storage.get(KEY)), entry = update(entries[key]);
      if (!entry) return;
      delete entries[key]; await this.storage.update(KEY, read({ ...entries, [key]: entry }));
    });
    queues.set(this.storage, next); await next;
  }
  save(key: string, entry: CatalogDisplay): Promise<void> {
    return this.write(key, previous => ({ ...entry, ...(previous?.confirmedIds ? { confirmedIds: previous.confirmedIds } : {}) }));
  }
  select(key: string, selectedId: string): Promise<void> {
    return this.write(key, previous => previous && ({ ...previous, selectedId }));
  }
  confirm(key: string, id: string, confirmed: boolean): Promise<void> {
    return this.write(key, previous => previous && ({ ...previous, confirmedIds: confirmed ? [...new Set([...(previous.confirmedIds ?? []), id])] : (previous.confirmedIds ?? []).filter(value => value !== id) }));
  }
}
