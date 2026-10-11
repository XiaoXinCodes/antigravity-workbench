import { createHash } from 'node:crypto';
import { observeModels, missingModel, mergeModels, type ModelObservation, type ObservationStatus } from './model-observation';

export interface TokenObservation { status: ObservationStatus; value?: number; fields: string[] }
export type GenerationTokens = Record<'input' | 'cacheWrite' | 'cacheRead' | 'outputText' | 'reasoning' | 'outputTotal', TokenObservation>;
export interface GenerationTimeObservation { status: ObservationStatus; value?: number; fields: string[] }
export interface GenerationProjectObservation { status: ObservationStatus; values: { key: string; label: string }[]; fields: string[] }
/** Internal producer contract, supplied only after the actual source is verified.
 * Matching numeric wire shapes or a user-selected filename never establish it. */
export type VerifiedLocalGenerationSchema = 'google-antigravity-1.7.0';
export interface LocalGenerationRecord {
  client?: 'cli' | 'ide' | 'selected'; session: string; index: number; requested: ModelObservation; returned: ModelObservation;
  // No current unversioned local DB reader can emit 'verified'.
  tokens: GenerationTokens; key: string; usageInterpretation?: 'unverified' | 'verified';
  usageSchema?: VerifiedLocalGenerationSchema;
  timestamp?: GenerationTimeObservation; project?: GenerationProjectObservation; issue?: 'schemaUnsupported' | 'duplicateConflict';
}
const absent = (): TokenObservation => ({ status: 'missing', fields: [] });
const emptyTokens = (): GenerationTokens => ({ input: absent(), cacheWrite: absent(), cacheRead: absent(), outputText: absent(), reasoning: absent(), outputTotal: absent() });
interface WireField { number: number; wire: number; value?: bigint | Buffer }
/** Independent bounded protobuf wire reader. Only metadata fields are decoded. */
function fields(bytes: Buffer): WireField[] {
  if (bytes.length > 1024 * 1024) throw Error('LOCAL_RECORD_LIMIT');
  let offset = 0; const out: WireField[] = [];
  const varint = (): bigint => {
    let value = 0n;
    for (let i = 0; i < 10 && offset < bytes.length; i++) {
      const byte = bytes[offset++]!;
      if (i === 9 && byte > 1) throw Error('LOCAL_RECORD_SCHEMA');
      value |= BigInt(byte & 127) << BigInt(7 * i);
      if (byte < 128) return value;
    }
    throw Error('LOCAL_RECORD_SCHEMA');
  };
  while (offset < bytes.length) {
    if (out.length >= 4096) throw Error('LOCAL_RECORD_LIMIT');
    const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!number || number > 536870911) throw Error('LOCAL_RECORD_SCHEMA');
    if (wire === 0) out.push({ number, wire, value: varint() });
    else if (wire === 2) {
      const size = varint(); if (size > BigInt(bytes.length - offset)) throw Error('LOCAL_RECORD_SCHEMA');
      const end = offset + Number(size); out.push({ number, wire, value: bytes.subarray(offset, end) }); offset = end;
    } else if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; out.push({ number, wire }); }
    else throw Error('LOCAL_RECORD_SCHEMA');
    if (offset > bytes.length) throw Error('LOCAL_RECORD_SCHEMA');
  }
  return out;
}
function nested(v: WireField[], n: number): WireField[] {
  const matches = v.filter(f => f.number === n);
  if (!matches.length) return [];
  if (matches.length !== 1 || matches[0]!.wire !== 2 || !Buffer.isBuffer(matches[0]!.value)) throw Error('LOCAL_RECORD_SCHEMA');
  return fields(matches[0]!.value);
}
function knownToken(v: WireField[], n: number): TokenObservation {
  const matches = v.filter(field => field.number === n), evidenceFields = [`gen_metadata.chatModel.usage.#${n}`];
  if (!matches.length) return absent();
  const values: number[] = [];
  for (const field of matches) {
    if (field.wire !== 0 || typeof field.value !== 'bigint' || field.value > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'invalid', fields: evidenceFields };
    values.push(Number(field.value));
  }
  return new Set(values).size > 1 ? { status: 'conflict', fields: evidenceFields } : { status: 'provided', value: values[0]!, fields: evidenceFields };
}
export function parseLocalGeneration(session: string, index: number, bytes: Buffer, source: { schema?: VerifiedLocalGenerationSchema } = {}): LocalGenerationRecord {
  const verified = source.schema === 'google-antigravity-1.7.0';
  const row: LocalGenerationRecord = { session, index, requested: missingModel(), returned: missingModel(), tokens: emptyTokens(), key: `${session}:generation:${index}`, usageInterpretation: verified ? 'verified' : 'unverified', ...(verified ? { usageSchema: source.schema! } : {}), timestamp: { status: 'missing', fields: [] }, project: { status: 'missing', values: [], fields: [] } };
  try {
    const root = fields(bytes), chat = nested(root, 1);
    if (!chat.length) throw Error('LOCAL_RECORD_SCHEMA');
    const strings = chat.filter(f => f.number === 19);
    row.returned = observeModels(strings.map(f => {
      let value: unknown = null;
      if (f.wire === 2 && Buffer.isBuffer(f.value)) { try { value = new TextDecoder('utf-8', { fatal: true }).decode(f.value); } catch { /* Invalid text stays invalid. */ } }
      return { field: 'gen_metadata.chatModel.responseModel' as const, value };
    }));
    let usage: WireField[];
    try { usage = nested(chat, 4); } catch {
      row.issue = 'schemaUnsupported';
      if (verified) row.tokens = Object.fromEntries(Object.keys(row.tokens).map(key => [key, { status: 'invalid', fields: ['gen_metadata.chatModel.#4'] }])) as GenerationTokens;
      return row;
    }
    // Unversioned local metadata cannot distinguish the earlier community interpretation
    // from the publicly extracted descriptor: the numeric wire shapes overlap. Never
    // label or sum these raw numbers without an independently verified schema source.
    // The same limit applies to dates and workspace evidence; idx/mtime are not dates.
    // Official 1.7.0 extension descriptor SHA256:
    // bdae3f9573417e7806db598fdadea9d0db6a2106b589548354d47f26cdd356ea.
    // This is an explicit source contract, never an automatic shape/version guess.
    if (verified) row.tokens = {
      input: knownToken(usage, 2), cacheWrite: knownToken(usage, 4), cacheRead: knownToken(usage, 5),
      outputText: knownToken(usage, 10), reasoning: knownToken(usage, 9), outputTotal: knownToken(usage, 3),
    };
    const identities = usage.filter(f => f.number === 11);
    if (identities.length === 1 && identities[0]!.wire === 2 && Buffer.isBuffer(identities[0]!.value) && identities[0]!.value.length > 0 && identities[0]!.value.length <= 256)
      row.key = `${session}:response:${createHash('sha256').update(identities[0]!.value).digest('hex')}`;
  } catch { row.returned = { status: 'invalid', values: [], fields: [], invalid: true }; row.tokens = emptyTokens(); row.issue = 'schemaUnsupported'; }
  return row;
}
/** Same-response duplicates do not add a second usage row; disagreements remain explicit. */
export function mergeLocalRecords(rows: readonly LocalGenerationRecord[]): LocalGenerationRecord[] {
  const map = new Map<string, LocalGenerationRecord>();
  for (const row of rows) {
    const old = map.get(row.key);
    if (!old) { map.set(row.key, structuredClone(row)); continue; }
    if (JSON.stringify(old.returned) !== JSON.stringify(row.returned)) {
      old.issue = 'duplicateConflict';
      old.returned = { ...mergeModels(old.returned, row.returned), status: 'conflict', conflict: true };
    }
    if (old.usageInterpretation !== 'verified' || row.usageInterpretation !== 'verified') {
      // An unverified duplicate never inherits another record's producer contract,
      // including when its raw numbers happen to match the verified observation.
      old.usageInterpretation = 'unverified'; delete old.usageSchema; old.tokens = emptyTokens();
    } else if (JSON.stringify(old.tokens) !== JSON.stringify(row.tokens)) {
      old.issue = 'duplicateConflict';
      for (const key of Object.keys(old.tokens) as (keyof GenerationTokens)[]) if (JSON.stringify(old.tokens[key]) !== JSON.stringify(row.tokens[key])) old.tokens[key] = { status: 'conflict', fields: [...new Set([...old.tokens[key].fields, ...row.tokens[key].fields])] };
    }
    if (old.timestamp && row.timestamp) {
      const evidenceFields = [...new Set([...old.timestamp.fields, ...row.timestamp.fields])];
      if (old.timestamp.status !== row.timestamp.status || old.timestamp.value !== row.timestamp.value) {
        old.issue = 'duplicateConflict'; old.timestamp = { status: 'conflict', fields: evidenceFields };
      } else old.timestamp.fields = evidenceFields;
    } else if (!old.timestamp && row.timestamp) old.timestamp = structuredClone(row.timestamp);
    if (old.project && row.project) {
      const evidenceFields = [...new Set([...old.project.fields, ...row.project.fields])];
      const left = old.project.values.map(value => JSON.stringify(value)).sort(), right = row.project.values.map(value => JSON.stringify(value)).sort();
      if (old.project.status !== row.project.status || JSON.stringify(left) !== JSON.stringify(right)) {
        old.issue = 'duplicateConflict';
        const values = [...new Map([...old.project.values, ...row.project.values].map(value => [JSON.stringify(value), structuredClone(value)])).values()];
        old.project = { status: 'conflict', values, fields: evidenceFields };
      } else old.project.fields = evidenceFields;
    } else if (!old.project && row.project) old.project = structuredClone(row.project);
  }
  return [...map.values()];
}
