import { createHash } from 'node:crypto';
import { observeModels, missingModel, mergeModels, type ModelObservation, type ObservationStatus } from './model-observation';

export interface TokenObservation { status: ObservationStatus; value?: number; fields: string[] }
export type GenerationTokens = Record<'inputUncached' | 'cacheRead' | 'outputText' | 'reasoning' | 'outputTotal', TokenObservation>;
export interface LocalGenerationRecord {
  client?: 'cli' | 'ide' | 'selected'; session: string; index: number; requested: ModelObservation; returned: ModelObservation;
  tokens: GenerationTokens; key: string; issue?: 'schemaUnsupported' | 'duplicateConflict';
}
const absent = (): TokenObservation => ({ status: 'missing', fields: [] });
const emptyTokens = (): GenerationTokens => ({ inputUncached: absent(), cacheRead: absent(), outputText: absent(), reasoning: absent(), outputTotal: absent() });
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
function token(v: WireField[], n: number): TokenObservation {
  const matches = v.filter(f => f.number === n), path = `gen_metadata.chatModel.usage.#${n}`;
  if (!matches.length) return absent();
  const values: number[] = [];
  for (const match of matches) {
    if (match.wire !== 0 || typeof match.value !== 'bigint' || match.value > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'invalid', fields: [path] };
    values.push(Number(match.value));
  }
  return new Set(values).size > 1 ? { status: 'conflict', fields: [path] } : { status: 'provided', value: values[0]!, fields: [path] };
}
function sum(a: TokenObservation, b: TokenObservation): TokenObservation {
  const paths = [...a.fields, ...b.fields];
  if (a.status !== 'provided' || b.status !== 'provided') return { status: a.status === 'invalid' || b.status === 'invalid' ? 'invalid' : a.status === 'conflict' || b.status === 'conflict' ? 'conflict' : 'missing', fields: paths };
  const value = a.value! + b.value!;
  return Number.isSafeInteger(value) ? { status: 'provided', value, fields: paths } : { status: 'invalid', fields: paths };
}
export function parseLocalGeneration(session: string, index: number, bytes: Buffer): LocalGenerationRecord {
  const row: LocalGenerationRecord = { session, index, requested: missingModel(), returned: missingModel(), tokens: emptyTokens(), key: `${session}:generation:${index}` };
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
    try { usage = nested(chat, 4); } catch { row.issue = 'schemaUnsupported'; row.tokens = Object.fromEntries(Object.keys(row.tokens).map(key => [key, {status:'invalid',fields:['gen_metadata.chatModel.#4']}])) as GenerationTokens; return row; }
    row.tokens = { inputUncached: sum(token(usage, 1), token(usage, 2)), cacheRead: token(usage, 5), outputText: token(usage, 9), reasoning: token(usage, 10), outputTotal: token(usage, 3) };
    const combined = sum(row.tokens.outputText, row.tokens.reasoning);
    if (row.tokens.outputTotal.status === 'missing') row.tokens.outputTotal = combined;
    else if (row.tokens.outputTotal.status === 'provided' && combined.status === 'provided' && row.tokens.outputTotal.value !== combined.value)
      row.tokens.outputTotal = { status: 'conflict', fields: [...row.tokens.outputTotal.fields, ...combined.fields] };
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
    if (JSON.stringify(old.returned) !== JSON.stringify(row.returned) || JSON.stringify(old.tokens) !== JSON.stringify(row.tokens)) {
      old.issue = 'duplicateConflict';
      if (JSON.stringify(old.returned) !== JSON.stringify(row.returned)) old.returned = { ...mergeModels(old.returned, row.returned), status: 'conflict', conflict: true };
      for (const key of Object.keys(old.tokens) as (keyof GenerationTokens)[]) if (JSON.stringify(old.tokens[key]) !== JSON.stringify(row.tokens[key])) old.tokens[key] = { status: 'conflict', fields: [...new Set([...old.tokens[key].fields, ...row.tokens[key].fields])] };
    }
  }
  return [...map.values()];
}
