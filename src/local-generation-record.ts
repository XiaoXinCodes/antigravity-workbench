import { createHash } from 'node:crypto';
import { observeModels, missingModel, mergeModels, type ModelObservation, type ObservationStatus } from './model-observation';

export interface TokenObservation { status: ObservationStatus; value?: number; fields: string[] }
export type GenerationTokens = Record<'input' | 'cacheWrite' | 'cacheRead' | 'outputText' | 'reasoning' | 'outputTotal', TokenObservation>;
export interface GenerationTimeObservation { status: ObservationStatus; value?: number; fields: string[]; source?: 'generation' | 'step-created' }
export interface GenerationProjectObservation { status: ObservationStatus; values: { key: string; label: string }[]; fields: string[] }
/** Confirmed descriptor contract; this does not identify a record's producer version. */
export type VerifiedLocalGenerationSchema = 'google-antigravity-1.7.0';
export interface GenerationStepMetadata { index: number; responseKey?: string; timestamp: GenerationTimeObservation; linkageComplete: boolean }
export interface LocalGenerationRecord {
  client?: 'cli' | 'ide' | 'selected'; session: string; index: number; requested: ModelObservation; returned: ModelObservation;
  // 'verified' describes compatibility with the confirmed descriptor, not a
  // producer identity, request model, or proof of the backend model weights.
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
function responseIdentity(usage: WireField[]): { complete: boolean; key?: string } {
  const matches = usage.filter(field => field.number === 11);
  if (!matches.length) return { complete: true };
  const values = new Set<string>(); let bytes: Buffer | undefined;
  for (const field of matches) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value) || field.value.length > 256) return { complete: false };
    try { new TextDecoder('utf-8', { fatal: true }).decode(field.value); }
    catch { return { complete: false }; }
    // Identity is byte-exact. UTF-8 decoding validates only; it must not strip a
    // BOM (or otherwise normalize text) before agreement or hash comparison.
    values.add(field.value.toString('hex'));
    bytes = field.value;
  }
  if (values.size > 1) return { complete: false };
  return bytes?.length ? { complete: true, key: createHash('sha256').update(bytes).digest('hex') } : { complete: true };
}
function timestamp(v: WireField[], number: number, evidence: string, source: NonNullable<GenerationTimeObservation['source']>): GenerationTimeObservation {
  const matches = v.filter(field => field.number === number);
  if (!matches.length) return { status: 'missing', fields: [] };
  const evidenceFields = [evidence]; const times = new Set<bigint>();
  try {
    for (const field of matches) {
      if (field.wire !== 2 || !Buffer.isBuffer(field.value)) throw Error('LOCAL_RECORD_SCHEMA');
      const pieces = fields(field.value), secondsFields = pieces.filter(piece => piece.number === 1), nanosFields = pieces.filter(piece => piece.number === 2);
      const read = (items: WireField[], signed: boolean): bigint[] => {
        if (!items.length) return [0n]; // Standard Timestamp defaults, only when its message is present.
        return items.map(item => {
          if (item.wire !== 0 || typeof item.value !== 'bigint') throw Error('LOCAL_RECORD_SCHEMA');
          return signed ? BigInt.asIntN(64, item.value) : item.value;
        });
      };
      const seconds = read(secondsFields, true), nanos = read(nanosFields, false);
      if (seconds.some(value => value < -62_135_596_800n || value > 253_402_300_799n) || nanos.some(value => value > 999_999_999n)) throw Error('LOCAL_RECORD_SCHEMA');
      if (new Set(seconds).size > 1 || new Set(nanos).size > 1) return { status: 'conflict', fields: evidenceFields, source };
      times.add(seconds[0]! * 1_000_000_000n + nanos[0]!);
    }
    if (times.size !== 1) return { status: 'conflict', fields: evidenceFields, source };
    const instant = [...times][0]!;
    // Floor rather than truncate negative timestamps to keep calendar boundaries correct.
    const millis = instant >= 0 ? instant / 1_000_000n : (instant - 999_999n) / 1_000_000n;
    return { status: 'provided', value: Number(millis), fields: evidenceFields, source };
  } catch { return { status: 'invalid', fields: evidenceFields, source }; }
}
function generationTimestamp(chat: WireField[]): GenerationTimeObservation {
  try { return timestamp(nested(chat, 9), 4, 'gen_metadata.chatModel.chatStartMetadata.createdAt', 'generation'); }
  catch { return { status: 'invalid', fields: ['gen_metadata.chatModel.chatStartMetadata'], source: 'generation' }; }
}
export function parseLocalGeneration(session: string, index: number, bytes: Buffer, source: { schema?: VerifiedLocalGenerationSchema } = {}): LocalGenerationRecord {
  void source; // Retained call compatibility; callers cannot override the confirmed descriptor.
  const row: LocalGenerationRecord = { session, index, requested: missingModel(), returned: missingModel(), tokens: emptyTokens(), key: `${session}:generation:${index}`, usageInterpretation: 'unverified', timestamp: { status: 'missing', fields: [] }, project: { status: 'missing', values: [], fields: [] } };
  try {
    const root = fields(bytes), chat = nested(root, 1);
    if (!chat.length) throw Error('LOCAL_RECORD_SCHEMA');
    row.usageInterpretation = 'verified'; row.usageSchema = 'google-antigravity-1.7.0';
    row.timestamp = generationTimestamp(chat);
    const strings = chat.filter(f => f.number === 19);
    row.returned = observeModels(strings.map(f => {
      let value: unknown = null;
      if (f.wire === 2 && Buffer.isBuffer(f.value)) { try { value = new TextDecoder('utf-8', { fatal: true }).decode(f.value); } catch { /* Invalid text stays invalid. */ } }
      return { field: 'gen_metadata.chatModel.responseModel' as const, value };
    }));
    let usage: WireField[];
    try { usage = nested(chat, 4); } catch {
      row.issue = 'schemaUnsupported';
      row.tokens = Object.fromEntries(Object.keys(row.tokens).map(key => [key, { status: 'invalid', fields: ['gen_metadata.chatModel.#4'] }])) as GenerationTokens;
      return row;
    }
    // Confirmed against the official descriptor and existing gen_metadata records.
    // Official 1.7.0 extension descriptor SHA256:
    // bdae3f9573417e7806db598fdadea9d0db6a2106b589548354d47f26cdd356ea.
    // This confirms the field contract, not a per-record producer identity.
    row.tokens = {
      input: knownToken(usage, 2), cacheWrite: knownToken(usage, 4), cacheRead: knownToken(usage, 5),
      outputText: knownToken(usage, 10), reasoning: knownToken(usage, 9), outputTotal: knownToken(usage, 3),
    };
    const identity = responseIdentity(usage);
    if (identity.key) row.key = `${session}:response:${identity.key}`;
  } catch { row.returned = { status: 'invalid', values: [], fields: [], invalid: true }; row.tokens = emptyTokens(); row.usageInterpretation = 'unverified'; delete row.usageSchema; row.issue = 'schemaUnsupported'; }
  return row;
}

/** Decode only step metadata; no step payload, tool arguments, or conversation text. */
export function parseGenerationStepMetadata(index: number, bytes: Buffer): GenerationStepMetadata {
  const row: GenerationStepMetadata = { index, timestamp: { status: 'missing', fields: [] }, linkageComplete: true };
  try {
    const metadata = fields(bytes);
    row.timestamp = timestamp(metadata, 1, `steps[${index}].metadata.createdAt`, 'step-created');
    try {
      const identity = responseIdentity(nested(metadata, 9)); row.linkageComplete = identity.complete;
      if (identity.key) row.responseKey = identity.key;
    } catch { row.linkageComplete = false; }
  } catch { row.linkageComplete = false; row.timestamp = { status: 'invalid', fields: [`steps[${index}].metadata`], source: 'step-created' }; }
  return row;
}

function filesystemUri(uri: string): URL | undefined {
  try {
    if (/\p{Cc}/u.test(uri)) return undefined;
    const parsed = new URL(uri);
    if (!['file:', 'vscode-remote:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith('/')) return undefined;
    // URL normalizes file:relative to an absolute-looking path. Require an
    // explicitly absolute filesystem path in the declared URI itself.
    if (!/^(?:file|vscode-remote):\//i.test(uri) || /\p{Cc}/u.test(decodeURIComponent(parsed.pathname))) return undefined;
    return parsed;
  } catch { return undefined; }
}
function workspaceLabel(parsed: URL, key: string): string {
  try {
    const components = parsed.pathname.replace(/\/+$/, '').split('/');
    const label = decodeURIComponent(components.at(-1) ?? '');
    if (label && label.length <= 80 && label !== '.' && label !== '..' && !/^[a-z]:$/i.test(label) && !/[/\\\p{C}]/u.test(label)) return label;
  } catch { /* A URI without a safe basename receives an opaque label. */ }
  return 'Workspace ' + key.slice(0, 8);
}

/** Workspaces are declared working directories, never inferred Git/cloud projects. */
export function parseGenerationWorkspaceMetadata(bytes: Buffer): GenerationProjectObservation {
  const evidence = 'trajectory_metadata_blob.workspaces.workspaceFolderAbsoluteUri';
  try {
    const workspaces = fields(bytes).filter(field => field.number === 1);
    if (!workspaces.length) return { status: 'missing', values: [], fields: [] };
    if (workspaces.length > 16) return { status: 'invalid', values: [], fields: [evidence] };
    const values = new Map<string, { key: string; label: string }>(); let invalid = false, uriCount = 0;
    for (const workspace of workspaces) {
      if (workspace.wire !== 2 || !Buffer.isBuffer(workspace.value)) { invalid = true; continue; }
      for (const field of fields(workspace.value).filter(item => item.number === 1)) {
        if (++uriCount > 16) return { status: 'invalid', values: [], fields: [evidence] };
        if (field.wire !== 2 || !Buffer.isBuffer(field.value) || field.value.length > 8192) { invalid = true; continue; }
        let uri: string;
        try { uri = new TextDecoder('utf-8', { fatal: true }).decode(field.value); } catch { invalid = true; continue; }
        if (!uri) continue;
        const parsed = filesystemUri(uri); if (!parsed) { invalid = true; continue; }
        const key = createHash('sha256').update(field.value).digest('hex');
        values.set(key, { key, label: workspaceLabel(parsed, key) });
      }
    }
    return { status: values.size > 1 ? 'conflict' : invalid ? 'invalid' : values.size ? 'provided' : 'missing', values: [...values.values()].slice(0, 2), fields: values.size || invalid ? [evidence] : [] };
  } catch { return { status: 'invalid', values: [], fields: [evidence] }; }
}

/** Caller supplies rows, steps, and workspace metadata from ONE DB snapshot.
 * No global index/cache or filesystem dates participate in this response-ID join. */
export function applyGenerationMetadata(rows: readonly LocalGenerationRecord[], steps: readonly GenerationStepMetadata[], workspace?: GenerationProjectObservation): LocalGenerationRecord[] {
  const linkageComplete = steps.every(step => step.linkageComplete === true);
  const byResponse = new Map<string, GenerationStepMetadata[]>();
  for (const step of steps) if (step.responseKey && /^[a-f0-9]{64}$/.test(step.responseKey)) {
    const group = byResponse.get(step.responseKey); if (group) group.push(step); else byResponse.set(step.responseKey, [step]);
  }
  return rows.map(input => {
    const row = structuredClone(input);
    if (!row.timestamp || row.timestamp.status === 'missing') {
      const identity = /:response:([a-f0-9]{64})$/.exec(row.key)?.[1], matches = identity && linkageComplete ? byResponse.get(identity) ?? [] : [];
      if (matches.length === 1) row.timestamp = structuredClone(matches[0]!.timestamp);
      else if (matches.length > 1) row.timestamp = { status: 'conflict', fields: ['steps.metadata.createdAt'], source: 'step-created' };
      else row.timestamp = { status: 'missing', fields: [] };
    }
    if (workspace) row.project = workspace.values.length > 16 ? { status: 'invalid', values: [], fields: ['trajectory_metadata_blob.workspaces.workspaceFolderAbsoluteUri'] } : structuredClone(workspace);
    return row;
  });
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
      if (old.timestamp.status === 'missing') old.timestamp = { ...structuredClone(row.timestamp), fields: evidenceFields };
      else if (row.timestamp.status === 'missing') old.timestamp.fields = evidenceFields;
      else if (old.timestamp.status !== row.timestamp.status || old.timestamp.value !== row.timestamp.value) {
        const source = old.timestamp.source === row.timestamp.source ? old.timestamp.source : undefined;
        old.issue = 'duplicateConflict'; old.timestamp = { status: 'conflict', fields: evidenceFields, ...(source ? { source } : {}) };
      } else {
        old.timestamp.fields = evidenceFields;
        if (row.timestamp.source === 'generation' || (!old.timestamp.source && row.timestamp.source)) old.timestamp.source = row.timestamp.source;
      }
    } else if (!old.timestamp && row.timestamp) old.timestamp = structuredClone(row.timestamp);
    if (old.project && row.project) {
      const evidenceFields = [...new Set([...old.project.fields, ...row.project.fields])];
      const left = old.project.values.map(value => JSON.stringify(value)).sort(), right = row.project.values.map(value => JSON.stringify(value)).sort();
      if (old.project.status === 'missing') old.project = { ...structuredClone(row.project), fields: evidenceFields };
      else if (row.project.status === 'missing') old.project.fields = evidenceFields;
      else if (old.project.status !== row.project.status || JSON.stringify(left) !== JSON.stringify(right)) {
        old.issue = 'duplicateConflict';
        const values = [...new Map([...old.project.values, ...row.project.values].map(value => [JSON.stringify(value), structuredClone(value)])).values()];
        old.project = { status: 'conflict', values, fields: evidenceFields };
      } else old.project.fields = evidenceFields;
    } else if (!old.project && row.project) old.project = structuredClone(row.project);
  }
  return [...map.values()];
}
