import { type GenerationTokens, type GenerationTimeObservation, type GenerationProjectObservation, type LocalGenerationRecord } from './local-generation-record';
import { mergeModels, rawModel, type ObservationStatus } from './model-observation';

export type { GenerationTimeObservation, GenerationProjectObservation } from './local-generation-record';
export type GenerationStatsTokens = GenerationTokens;
export type StatsGenerationRecord = Omit<LocalGenerationRecord, 'tokens' | 'usageInterpretation'> & { tokens: GenerationStatsTokens; usageInterpretation?: 'verified' | 'unverified' } & { timestamp?: GenerationTimeObservation; project?: GenerationProjectObservation };
export type GenerationStatsRange = 'today' | '7d' | '30d' | 'all';
export interface GenerationStatsOptions { range?: GenerationStatsRange; model?: string; project?: string; now?: number; timeZone?: string }
export type TokenMetric = keyof GenerationStatsTokens;
export interface TokenAggregate {
  status: 'complete' | 'partial' | 'missing' | 'overflow'; sum?: number;
  knownCount: number; missingCount: number; invalidCount: number; conflictCount: number; totalCount: number;
}
export interface GenerationAggregate {
  recordCount: number; verifiedResponseCount: number; tokens: Record<TokenMetric, TokenAggregate>;
}
export interface GenerationTrendPoint extends GenerationAggregate { day: string }
export interface GenerationModelOption { key: string; kind: ObservationStatus; value?: string; recordCount: number }
export interface GenerationProjectOption { key: string; label: string; recordCount: number }
export interface LocalGenerationStats {
  range: GenerationStatsRange; timeZone: string; now: number; startLocalDate?: string; throughLocalDate: string;
  readRecordCount: number; matchedRecordCount: number; duplicatesRemoved: number; unknownTimeCount: number; futureTimeCount: number;
  modelOptions: GenerationModelOption[]; projectOptions: GenerationProjectOption[]; summary: GenerationAggregate;
  rows: StatsGenerationRecord[]; undatedRows: StatsGenerationRecord[]; trend: GenerationTrendPoint[];
}
const METRICS: readonly TokenMetric[] = ['input', 'cacheWrite', 'cacheRead', 'outputText', 'reasoning', 'outputTotal'];
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= -62_135_596_800_000 && value <= 253_402_300_799_999;

/** A conflict belongs to one bucket; its individual declarations never duplicate usage. */
export function generationModelCategory(row: Pick<LocalGenerationRecord, 'returned'>): Omit<GenerationModelOption, 'recordCount'> {
  const model = row.returned;
  if (model.status === 'provided' && model.values.length === 1 && rawModel(model.values[0]) && !model.invalid && !model.conflict && !model.truncated)
    return { key: 'model:' + model.values[0], kind: 'provided', value: model.values[0] };
  const kind = model.status === 'provided' ? 'invalid' : model.status;
  return { key: 'status:' + kind, kind };
}

function mergeEvidence<T extends GenerationTimeObservation>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b ? structuredClone(b) : undefined;
  if (!b) return structuredClone(a);
  const fields = [...new Set([...a.fields, ...b.fields])];
  if (a.status === 'missing' && b.status === 'provided') return { ...structuredClone(b), fields };
  if (b.status === 'missing' && a.status === 'provided') return { ...structuredClone(a), fields };
  if (a.status === b.status && a.value === b.value) {
    const source = a.source === 'generation' || b.source === 'generation' ? 'generation' : a.source ?? b.source;
    return { ...structuredClone(a), fields, ...(source ? { source } : {}) };
  }
  return { status: 'conflict', fields } as T;
}

function mergeProject(a: GenerationProjectObservation | undefined, b: GenerationProjectObservation | undefined): GenerationProjectObservation | undefined {
  if (!a) return b ? structuredClone(b) : undefined;
  if (!b) return structuredClone(a);
  const fields = [...new Set([...a.fields, ...b.fields])];
  const values = [...new Map([...a.values, ...b.values].map(value => [JSON.stringify(value), value])).values()];
  const status = a.status === 'conflict' || b.status === 'conflict' || values.length > 1 ? 'conflict' : a.status === 'invalid' || b.status === 'invalid' ? 'invalid' : values.length ? 'provided' : 'missing';
  return { status, fields, values };
}

/** Only one verified workspace is filterable; labels are safe basenames, keys opaque URI digests. */
export function generationProjectCategory(row: StatsGenerationRecord): Omit<GenerationProjectOption, 'recordCount'> | undefined {
  const project = row.project;
  if (project?.status !== 'provided' || project.values.length !== 1 || !project.fields.length) return undefined;
  const value = project.values[0]!;
  if (!/^[a-f0-9]{64}$/.test(value.key) || !value.label || value.label.length > 80 || value.label.includes('/') || value.label.includes('\\') || [...value.label].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || value.label === '.' || value.label === '..') return undefined;
  return { ...value };
}

/** Scope is explicit even for manually supplied unprefixed keys. Input objects remain untouched. */
export function deduplicateGenerationStatsRows(rows: readonly StatsGenerationRecord[]): StatsGenerationRecord[] {
  const groups = new Map<string, StatsGenerationRecord>();
  for (const row of rows) {
    const scope = JSON.stringify([row.client ?? 'selected', row.session, row.key]);
    const old = groups.get(scope);
    if (!old) { groups.set(scope, structuredClone(row)); continue; }
    const merged = structuredClone(old);
    if (old.usageInterpretation !== 'verified' || row.usageInterpretation !== 'verified') merged.usageInterpretation = 'unverified';
    merged.requested = mergeModels(old.requested, row.requested);
    merged.returned = mergeModels(old.returned, row.returned);
    if (merged.returned.status === 'conflict') merged.issue = 'duplicateConflict';
    for (const metric of METRICS) {
      const a = old.tokens[metric], b = row.tokens[metric], fields = [...new Set([...a.fields, ...b.fields])];
      if (a.status === b.status && a.value === b.value) merged.tokens[metric] = { ...a, fields };
      else { merged.tokens[metric] = { status: 'conflict', fields }; merged.issue = 'duplicateConflict'; }
    }
    const timestamp = mergeEvidence(old.timestamp, row.timestamp), project = mergeProject(old.project, row.project);
    if (timestamp) merged.timestamp = timestamp;
    if (project) merged.project = project;
    groups.set(scope, merged);
  }
  return [...groups.values()];
}

function tokenAggregate(rows: readonly StatsGenerationRecord[], metric: TokenMetric): TokenAggregate {
  let total = 0n, knownCount = 0, missingCount = 0, invalidCount = 0, conflictCount = 0;
  for (const row of rows) {
    // A number with a provided wire value is not evidence for its usage semantics.
    if (row.usageInterpretation !== 'verified') { missingCount++; continue; }
    const token = row.tokens[metric];
    if (token.status === 'provided' && Number.isSafeInteger(token.value) && token.value! >= 0) { total += BigInt(token.value!); knownCount++; }
    else if (token.status === 'missing') missingCount++;
    else if (token.status === 'conflict') conflictCount++;
    else invalidCount++;
  }
  const status = total > BigInt(Number.MAX_SAFE_INTEGER) ? 'overflow' : !knownCount ? 'missing' : knownCount === rows.length ? 'complete' : 'partial';
  return { status, ...(knownCount && status !== 'overflow' ? { sum: Number(total) } : {}), knownCount, missingCount, invalidCount, conflictCount, totalCount: rows.length };
}

export function aggregateGenerationStats(rows: readonly StatsGenerationRecord[]): GenerationAggregate {
  return {
    recordCount: rows.length,
    // parseLocalGeneration only creates this suffix from the bounded usage response identity.
    verifiedResponseCount: rows.filter(row => /:response:[a-f0-9]{64}$/.test(row.key)).length,
    tokens: Object.fromEntries(METRICS.map(metric => [metric, tokenAggregate(rows, metric)])) as Record<TokenMetric, TokenAggregate>,
  };
}

function dayKey(format: Intl.DateTimeFormat, timestamp: number): string {
  const values = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${values.year!.padStart(4, '0')}-${values.month}-${values.day}`;
}
function shiftDay(day: string, amount: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(0); shifted.setUTCFullYear(year!, month! - 1, date! + amount); shifted.setUTCHours(12, 0, 0, 0);
  return `${shifted.getUTCFullYear().toString().padStart(4, '0')}-${(shifted.getUTCMonth() + 1).toString().padStart(2, '0')}-${shifted.getUTCDate().toString().padStart(2, '0')}`;
}

/** Calendar-day ranges use the declared local timezone, including DST. Never infer time from idx/mtime. */
export function buildLocalGenerationStats(input: readonly StatsGenerationRecord[], options: GenerationStatsOptions = {}): LocalGenerationStats {
  const range = options.range ?? 'today', now = options.now ?? Date.now();
  if (!['today', '7d', '30d', 'all'].includes(range) || !validTime(now)) throw Error('LOCAL_STATS_OPTIONS');
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw Error('LOCAL_STATS_TIMEZONE'); }
  const throughLocalDate = dayKey(format, now), days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  const startLocalDate = range === 'all' ? undefined : shiftDay(throughLocalDate, 1 - days);
  const unique = deduplicateGenerationStatsRows(input), models = new Map<string, GenerationModelOption>(), projects = new Map<string, GenerationProjectOption>();
  for (const row of unique) { const category = generationModelCategory(row), existing = models.get(category.key); if (existing) existing.recordCount++; else models.set(category.key, { ...category, recordCount: 1 }); }
  for (const row of unique) { const project = generationProjectCategory(row); if (!project) continue; const existing = projects.get(project.key); if (existing) existing.recordCount++; else projects.set(project.key, { ...project, recordCount: 1 }); }
  const filtered = unique.filter(row => (!options.model || generationModelCategory(row).key === options.model) && (!options.project || generationProjectCategory(row)?.key === options.project));
  const rows: StatsGenerationRecord[] = [], undatedRows: StatsGenerationRecord[] = [], byDay = new Map<string, StatsGenerationRecord[]>();
  let futureTimeCount = 0;
  for (const row of filtered) {
    const time = row.timestamp;
    if (time?.status !== 'provided' || !validTime(time.value) || !time.fields.length) { undatedRows.push(row); if (range === 'all') rows.push(row); continue; }
    if (time.value > now) { futureTimeCount++; continue; }
    const day = dayKey(format, time.value);
    if (startLocalDate && day < startLocalDate) continue;
    rows.push(row); const group = byDay.get(day); if (group) group.push(row); else byDay.set(day, [row]);
  }
  // Deterministic details put newer verified times first; unknown dates stay at the end.
  const sortTime = (row: StatsGenerationRecord): number => row.timestamp?.status === 'provided' && row.timestamp.fields.length && validTime(row.timestamp.value) ? row.timestamp.value : -Infinity;
  rows.sort((a, b) => sortTime(b) - sortTime(a) || a.key.localeCompare(b.key));
  const trendDays: string[] = [];
  if (startLocalDate) for (let offset = 0; offset < days; offset++) trendDays.push(shiftDay(startLocalDate, offset));
  else trendDays.push(...[...byDay.keys()].sort());
  return {
    range, timeZone, now, ...(startLocalDate ? { startLocalDate } : {}), throughLocalDate,
    readRecordCount: unique.length, matchedRecordCount: filtered.length, duplicatesRemoved: input.length - unique.length, unknownTimeCount: undatedRows.length, futureTimeCount,
    modelOptions: [...models.values()].sort((a, b) => a.key.localeCompare(b.key)),
    projectOptions: [...projects.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key)),
    summary: aggregateGenerationStats(rows), rows, undatedRows,
    trend: trendDays.map(day => ({ day, ...aggregateGenerationStats(byDay.get(day) ?? []) })),
  };
}
