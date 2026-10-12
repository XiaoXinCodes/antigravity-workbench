/** Raw declarations only. No aliases, catalog joins, model-name inference or network calls. */
export type ObservationStatus = 'provided' | 'missing' | 'invalid' | 'conflict';
export const MODEL_FIELDS = ['model', 'modelVersion', 'response.model', 'response.modelVersion', 'gen_metadata.chatModel.responseModel'] as const;
export type ModelField = typeof MODEL_FIELDS[number];
export interface ModelObservation { status: ObservationStatus; values: string[]; fields: ModelField[]; entries?: { field: ModelField; value?: string; invalid?: true }[]; conflict?: true; invalid?: true; truncated?: true }
export function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d ? d.value : undefined; } catch { return undefined; }
}
export const rawModel = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v);
export const missingModel = (): ModelObservation => ({ status: 'missing', values: [], fields: [], entries: [] });
export function observeModels(samples: readonly { field: ModelField; value: unknown }[], excluded: readonly string[] = []): ModelObservation {
  const out = missingModel();
  for (const sample of samples) {
    if (sample.value === undefined) continue;
    if (!out.fields.includes(sample.field)) out.fields.push(sample.field);
    const valid = rawModel(sample.value) && !excluded.some(text => text && (sample.value === text || text.length >= 8 && (sample.value as string).includes(text)));
    const entry = valid ? { field: sample.field, value: sample.value as string } : { field: sample.field, invalid: true as const };
    if (!out.entries!.some(x => x.field === entry.field && x.value === entry.value && x.invalid === entry.invalid)) { if (out.entries!.length < 10) out.entries!.push(entry); else out.truncated = true; }
    if (!valid) { out.invalid = true; continue; }
    if (!out.values.includes(sample.value as string)) {
      if (out.values.length < 2) out.values.push(sample.value as string); else out.truncated = true;
    }
  }
  out.status = out.values.length > 1 || out.truncated ? 'conflict' : out.invalid ? 'invalid' : out.values.length ? 'provided' : 'missing';
  return out;
}
export function responseModels(value: unknown, excluded: readonly string[] = []): ModelObservation {
  const wrapped = own(value, 'response');
  return observeModels(MODEL_FIELDS.slice(0, 4).map(field => ({ field, value: field.startsWith('response.') ? own(wrapped, field.slice(9)) : own(value, field) })), excluded);
}
export function mergeModels(a: ModelObservation, b: ModelObservation): ModelObservation {
  const values = [...new Set([...a.values, ...b.values])], fields = [...new Set([...a.fields, ...b.fields])];
  const conflict = a.conflict || b.conflict, invalid = a.invalid || b.invalid, overflow = a.truncated || b.truncated || values.length > 2 || (a.entries?.length ?? 0) + (b.entries?.length ?? 0) > 20;
  const entries = [...new Map([...(a.entries ?? []), ...(b.entries ?? [])].map(x => [JSON.stringify(x), x])).values()];
  const truncated = overflow || entries.length > 10;
  return { entries: entries.slice(0, 10), status: values.length > 1 || truncated || conflict ? 'conflict' : invalid ? 'invalid' : values.length ? 'provided' : 'missing', values: values.slice(0, 2), fields,
    ...(conflict ? { conflict: true } : {}), ...(invalid ? { invalid: true } : {}), ...(truncated ? { truncated: true } : {}) };
}
/** Rebuild optional new history metadata. Bad metadata cannot break older task histories. */
function parseModelObservation(value: unknown): ModelObservation {
  const rawValues = own(value, 'values'), rawFields = own(value, 'fields');
  if (!Array.isArray(rawValues) || rawValues.length > 2 || !Array.isArray(rawFields) || rawFields.length > MODEL_FIELDS.length) return {status:'invalid',values:[],fields:[],invalid:true};
  const values=Array.from({length:rawValues.length},(_,i)=>own(rawValues,String(i))), fields=Array.from({length:rawFields.length},(_,i)=>own(rawFields,String(i)));
  if (!values.every(rawModel) || !fields.every((x): x is ModelField => MODEL_FIELDS.includes(x as ModelField))) return { status: 'invalid', values: [], fields: [], invalid: true };
  const source = own(value, 'entries');
  const entries: NonNullable<ModelObservation['entries']> = [];
  if (source !== undefined) {
    if (!Array.isArray(source) || source.length > 10) return { status: 'invalid', values: [], fields: [], invalid: true };
    for (let i=0;i<source.length;i++) { const item=own(source,String(i)), field=own(item,'field'), raw=own(item,'value'), bad=own(item,'invalid');
      if (!MODEL_FIELDS.includes(field as ModelField) || !(rawModel(raw) && bad === undefined || raw === undefined && bad === true)) return {status:'invalid',values:[],fields:[],invalid:true};
      entries.push({field:field as ModelField,...(rawModel(raw)?{value:raw}:{invalid:true as const})});
    }
  }
  const conflict = own(value, 'conflict') === true, invalid = own(value, 'invalid') === true, truncated = own(value, 'truncated') === true;
  if (entries.some(x => !fields.includes(x.field) || x.value !== undefined && !values.includes(x.value) && !truncated || x.invalid && !invalid) || values.length && !fields.length) return {status:'invalid',values:[],fields:[],invalid:true};
  const out = mergeModels(missingModel(), { status: 'missing', values: [...values], fields: [...fields], entries, ...(conflict ? {conflict:true} : {}), ...(invalid ? { invalid: true } : {}), ...(truncated ? { truncated: true } : {}) });
  return own(value, 'status') === out.status ? out : { status: 'invalid', values: [], fields: [], invalid: true };
}

export function readModelObservation(value: unknown): ModelObservation {
  try { return parseModelObservation(value); } catch { return {status: 'invalid',values:[],fields:[],invalid:true}; }
}
