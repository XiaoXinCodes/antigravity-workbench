import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { rawModel, type ModelObservation, type ObservationStatus } from './model-observation';
import { aggregateGenerationStats, buildLocalGenerationStats, type LocalGenerationStats, type TokenAggregate, type TokenMetric } from './local-generation-stats';

export type GenerationExportFormat = 'json' | 'csv';
export interface GenerationExportReadScope { files: number; skipped: number; limited: boolean }
const METRICS: readonly TokenMetric[] = ['input', 'cacheWrite', 'cacheRead', 'outputText', 'reasoning', 'outputTotal'];
const MAX_BYTES = 8 * 1024 * 1024;
const status = (value: unknown): ObservationStatus => ['provided', 'missing', 'invalid', 'conflict'].includes(value as string) ? value as ObservationStatus : 'invalid';
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const failure = (code: string): Error => Object.assign(new Error(code), { code });
function model(value: ModelObservation): { status: ObservationStatus; values: string[] } {
  const values = value.values.filter(rawModel).slice(0, 2);
  return { status: value.status === 'provided' && (values.length !== 1 || value.invalid || value.conflict || value.truncated) ? 'invalid' : status(value.status), values };
}
function aggregate(value: { recordCount: number; verifiedResponseCount: number; tokens: Record<TokenMetric, TokenAggregate> }): object {
  return { recordCount: count(value.recordCount), verifiedResponseCount: count(value.verifiedResponseCount), tokens: Object.fromEntries(METRICS.map(metric => {
    const token = value.tokens[metric];
    return [metric, { status: ['complete', 'partial', 'missing', 'overflow'].includes(token.status) ? token.status : 'missing',
      ...(count(token.sum) !== undefined ? { sum: token.sum } : {}), knownCount: count(token.knownCount), missingCount: count(token.missingCount),
      invalidCount: count(token.invalidCount), conflictCount: count(token.conflictCount), totalCount: count(token.totalCount) }];
  })) };
}
/** Quote every cell, and neutralize spreadsheet formulas even after leading whitespace/control. */
export function generationExportCsvCell(value: string | number | undefined): string {
  let text = value === undefined ? '' : String(value);
  if (/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/** Host-owned filtered snapshot only. Rebuild an allowlist; never serialize source records. */
export function generationStatsExportContent(snapshot: LocalGenerationStats, format: GenerationExportFormat, readScope?: GenerationExportReadScope): string {
  if (!['json', 'csv'].includes(format) || snapshot.rows.length > 2000) throw failure('LOCAL_EXPORT_CONTENT_INVALID');
  // Recompute from the guarded filtered records. Stale summaries may predate schema verification.
  const guarded = snapshot.rows.map(row => row.usageInterpretation !== 'verified' ? { ...row, usageInterpretation: 'unverified' as const, tokens: {
    input: { status: 'missing' as const, fields: [] }, cacheWrite: { status: 'missing' as const, fields: [] }, cacheRead: { status: 'missing' as const, fields: [] },
    outputText: { status: 'missing' as const, fields: [] }, reasoning: { status: 'missing' as const, fields: [] }, outputTotal: { status: 'missing' as const, fields: [] },
  } } : row);
  const recalculated = buildLocalGenerationStats(guarded, { range: snapshot.range, now: snapshot.now, timeZone: snapshot.timeZone });
  const observedThrough = new Date(snapshot.now).toISOString();
  const sourceCoverage = { kind: readScope ? 'bounded-read' : 'unknown', recordsRead: snapshot.readRecordCount,
    ...(readScope && count(readScope.files) !== undefined ? { filesRead: readScope.files } : {}),
    ...(readScope && count(readScope.skipped) !== undefined ? { skipped: readScope.skipped } : {}),
    ...(readScope && typeof readScope.limited === 'boolean' ? { limited: readScope.limited } : {}), historyComplete: false };
  const sessions = new Map<string, number>();
  const rows = guarded.map((row, index) => {
    const scope = JSON.stringify([row.client, row.session]);
    if (!sessions.has(scope)) sessions.set(scope, sessions.size + 1);
    const time = row.timestamp, timeValue = time?.status === 'provided' && time.fields.length && Number.isSafeInteger(time.value) && Math.abs(time.value!) <= 8.64e15 ? new Date(time.value!).toISOString() : undefined;
    const timeSource = timeValue && time && 'source' in time && (time.source === 'generation' || time.source === 'step-created') ? time.source : undefined;
    const project = row.project;
    // A project label is optional evidence. Raw filesystem paths never become exported labels.
    const label = project?.values.length === 1 ? project.values[0]?.label : undefined;
    const projectValue = project?.status === 'provided' && project.fields.length && typeof label === 'string' && label.length <= 128 && !/[\\/:\p{Cc}\p{Cf}]/u.test(label) && !label.startsWith('~') ? label : undefined;
    return { id: index + 1, session: sessions.get(scope)!, client: ['cli', 'ide', 'selected'].includes(row.client ?? '') ? row.client! : 'selected',
      timestamp: { status: timeValue ? 'provided' as const : time?.status === 'provided' ? 'invalid' as const : status(time?.status ?? 'missing'), ...(timeValue ? { value: timeValue } : {}), ...(timeSource ? { source: timeSource } : {}) },
      project: { status: projectValue ? 'provided' as const : project?.status === 'provided' ? 'invalid' as const : status(project?.status ?? 'missing'), ...(projectValue ? { value: projectValue } : {}) },
      requestedModel: model(row.requested), returnedModel: model(row.returned),
      ...(row.usageInterpretation === 'unverified' || row.usageInterpretation === 'verified' ? { usageStatus: row.usageInterpretation } : {}),
      tokens: Object.fromEntries(METRICS.map(metric => { const token = row.tokens[metric], value = count(token.value); return [metric, {
        status: token.status === 'provided' && value === undefined ? 'invalid' : status(token.status), ...(token.status === 'provided' && value !== undefined ? { value } : {}),
      }]; })) as Record<TokenMetric, { status: ObservationStatus; value?: number }>,
      ...(row.issue === 'schemaUnsupported' || row.issue === 'duplicateConflict' ? { issue: row.issue } : {}) };
  });
  let content: string;
  if (format === 'json') content = JSON.stringify({ schemaVersion: 1, countUnit: 'metadata-records', modelEvidence: 'server-declaration',
    sourceCoverage,
    scope: { range: snapshot.range, timeZone: snapshot.timeZone, startLocalDate: snapshot.startLocalDate ?? null, throughLocalDate: snapshot.throughLocalDate,
      observedThrough, readRecordCount: snapshot.readRecordCount, duplicatesRemoved: snapshot.duplicatesRemoved,
      unknownTimeCount: snapshot.unknownTimeCount, futureTimeCount: snapshot.futureTimeCount },
    summary: aggregate(aggregateGenerationStats(guarded)), trend: recalculated.trend.map(point => ({ day: point.day, ...aggregate(point) })), records: rows }, null, 2) + '\n';
  else {
    const headers = ['row_id', 'session_id', 'client', 'range', 'timezone', 'range_start', 'range_end', 'observed_through', 'read_records', 'read_files', 'read_skipped', 'read_limited', 'read_scope', 'timestamp_status', 'timestamp', 'timestamp_source', 'project_status', 'project', 'requested_model_status', 'requested_models', 'returned_model_status', 'returned_models', ...METRICS.flatMap(metric => [metric + '_status', metric]), 'usage_status', 'issue'];
    const cells = rows.map(row => [row.id, row.session, row.client, snapshot.range, snapshot.timeZone, snapshot.startLocalDate, snapshot.throughLocalDate, observedThrough,
      snapshot.readRecordCount, sourceCoverage.filesRead, sourceCoverage.skipped, sourceCoverage.limited === undefined ? undefined : String(sourceCoverage.limited), sourceCoverage.kind, row.timestamp.status, row.timestamp.value, row.timestamp.source,
      row.project.status, row.project.value, row.requestedModel.status, row.requestedModel.values.join(' | '), row.returnedModel.status, row.returnedModel.values.join(' | '),
      ...METRICS.flatMap(metric => [row.tokens[metric].status, row.tokens[metric].value]), row.usageStatus, row.issue]);
    content = [headers, ...cells].map(line => line.map(generationExportCsvCell).join(',')).join('\r\n') + '\r\n';
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw failure('LOCAL_EXPORT_TOO_LARGE');
  return content;
}

export interface GenerationExportTarget { readonly filename: string; readonly exists: boolean }
interface TargetSnapshot { filename: string; directories: { filename: string; stat: BigIntStats }[]; file?: BigIntStats }
const snapshots = new WeakMap<GenerationExportTarget, TargetSnapshot>();
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const revision = (a: BigIntStats, b: BigIntStats): boolean => same(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function filename(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\p{Cc}\p{Cf}]/u.test(value) || !/\.(?:json|csv)$/iu.test(value) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(path.basename(value))) throw failure('LOCAL_EXPORT_PATH_UNSAFE');
  return value;
}
async function targetStat(value: string): Promise<BigIntStats | undefined> {
  try { const stat = await fs.lstat(value, { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw failure('LOCAL_EXPORT_PATH_UNSAFE'); return stat; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function sanitized(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  return failure(typeof code === 'string' && /^LOCAL_EXPORT_[A-Z_]+$/.test(code) ? code : ['ENOENT', 'ENOTDIR', 'ELOOP', 'EEXIST'].includes(code ?? '') ? 'LOCAL_EXPORT_CHANGED' : 'LOCAL_EXPORT_WRITE_FAILED');
}
/** Read-only, opaque, single-use approval snapshot. It never reads the target content. */
export async function prepareGenerationExport(value: string): Promise<GenerationExportTarget> {
  const local = filename(value), directories: TargetSnapshot['directories'] = [];
  try {
    const parent = path.dirname(local), root = path.parse(parent).root;
    let current = root;
    for (const part of ['', ...parent.slice(root.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('LOCAL_EXPORT_PATH_UNSAFE');
      directories.push({ filename: current, stat });
    }
    const file = await targetStat(local), target = Object.freeze({ filename: local, exists: !!file });
    snapshots.set(target, { filename: local, directories, ...(file ? { file } : {}) });
    return target;
  } catch (error) { throw sanitized(error); }
}
export interface GenerationExportWriteOptions { allowOverwrite?: boolean; signal?: AbortSignal; isCurrent?: () => boolean }
/** Stage privately and sync before commit; the approved original is never truncated. */
export async function writeGenerationExport(target: GenerationExportTarget, content: string, options: GenerationExportWriteOptions = {}): Promise<void> {
  const snapshot = snapshots.get(target); snapshots.delete(target);
  if (!snapshot) throw failure('LOCAL_EXPORT_CONFIRM_REQUIRED');
  if (snapshot.file && options.allowOverwrite !== true) throw failure('LOCAL_EXPORT_CONFIRM_REQUIRED');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw failure('LOCAL_EXPORT_TOO_LARGE');
  const checkCurrent = (): void => { if (options.signal?.aborted || options.isCurrent && !options.isCurrent()) throw failure('LOCAL_EXPORT_CANCELLED'); };
  const verify = async (): Promise<void> => {
    checkCurrent();
    for (const directory of snapshot.directories) { const now = await fs.lstat(directory.filename, { bigint: true }); if (!now.isDirectory() || now.isSymbolicLink() || !same(now, directory.stat)) throw failure('LOCAL_EXPORT_CHANGED'); }
    const now = await targetStat(snapshot.filename);
    if (snapshot.file ? !now || !revision(snapshot.file, now) : now !== undefined) throw failure('LOCAL_EXPORT_CHANGED');
    checkCurrent();
  };
  const temporary = path.join(path.dirname(snapshot.filename), `.agw-stats-${randomBytes(16).toString('hex')}.tmp`);
  let handle: fs.FileHandle | undefined, owned: BigIntStats | undefined;
  try {
    await verify();
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    owned = await handle.stat({ bigint: true });
    if (!owned.isFile() || owned.nlink !== 1n) throw failure('LOCAL_EXPORT_PATH_UNSAFE');
    checkCurrent(); await handle.writeFile(content, 'utf8'); await handle.sync();
    const written = await handle.stat({ bigint: true }), named = await fs.lstat(temporary, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || !revision(written, named) || written.size !== BigInt(Buffer.byteLength(content, 'utf8'))) throw failure('LOCAL_EXPORT_CHANGED');
    await handle.close(); handle = undefined;
    await verify();
    const stage = await fs.lstat(temporary, { bigint: true });
    if (!stage.isFile() || stage.isSymbolicLink() || !revision(written, stage)) throw failure('LOCAL_EXPORT_CHANGED');
    checkCurrent();
    if (snapshot.file) { await fs.rename(temporary, snapshot.filename); owned = undefined; }
    else { await fs.link(temporary, snapshot.filename); }
    // Successful link/rename is the commit point; cleanup errors never turn success into failure.
  } catch (error) { throw sanitized(error); }
  finally {
    await handle?.close().catch(() => undefined);
    if (owned) { try { const current = await fs.lstat(temporary, { bigint: true }); if (current.isFile() && !current.isSymbolicLink() && same(owned, current)) await fs.unlink(temporary); } catch { /* Never remove a replaced file. */ } }
  }
}
