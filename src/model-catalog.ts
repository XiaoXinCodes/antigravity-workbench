/* eslint-disable no-control-regex -- Catalog text must not contain controls. */
/** The only interpreter of fetchAvailableModels / GetAvailableModels data.
 * A display label, input modality or quota identity never determines output role. */
export type ModelUse = 'image' | 'conversation';
export interface ModelChoice {
  id: string; label: string; modelEnum?: string;
  classification?: 'unclassified'; imageInput?: boolean;
}
export interface CatalogModel {
  id: string; displayName: string; disabled: boolean | 'unspecified' | 'invalid';
  image: boolean; agent: boolean; modelEnum?: string; imageInput?: boolean;
  remainingFraction: number | null; resetAt: string | null;
}
export interface ModelCatalog {
  models: readonly CatalogModel[]; imageIds: readonly string[]; agentIds: readonly string[];
  imageListDeclared: boolean; agentListDeclared: boolean;
}
const parsed = new WeakSet<object>();
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const validModelId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(value);
export const modelEnum = (value: unknown): string | undefined => typeof value === 'string' && /^MODEL_[A-Z0-9_]{1,80}$/.test(value) ? value : undefined;
const invalid = (): never => { throw Error('MODEL_CATALOG_INVALID'); };
export function catalogPayload(value: unknown): Record<string, unknown> {
  const root = object(value), wrapped = object(root?.response);
  if (root?.models !== undefined && wrapped?.models !== undefined) invalid();
  const payload = wrapped ?? root;
  if (!payload || !object(payload.models)) invalid();
  return payload!;
}
function ids(value: unknown, optional = false): string[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || !value.every(validModelId)) return invalid();
  return value;
}
export function parseModelCatalog(value: unknown): ModelCatalog {
  if (object(value) && parsed.has(value as object)) return value as ModelCatalog;
  const payload = catalogPayload(value), records = object(payload.models)!;
  if (Object.keys(records).length > 500) invalid();
  let imageIds: string[];
  try { imageIds = ids(payload.imageGenerationModelIds, true); if (new Set(imageIds).size !== imageIds.length) invalid(); }
  catch { throw Error('MODEL_CATALOG_IMAGE_LIST_INVALID'); }
  const agentIds: string[] = [];
  if (payload.agentModelSorts !== undefined) {
    if (!Array.isArray(payload.agentModelSorts) || payload.agentModelSorts.length > 100) invalid();
    for (const sort of payload.agentModelSorts as unknown[]) {
      const row = object(sort); if (!row) invalid();
      const groups = row!.groups === undefined ? [] : row!.groups;
      if (!Array.isArray(groups) || groups.length > 100) invalid();
      for (const group of groups as unknown[]) {
        const entry = object(group); if (!entry) invalid();
        agentIds.push(...ids(entry!.modelIds, true));
        if (agentIds.length > 5000) invalid();
      }
    }
  }
  const images = new Set(imageIds), agents = new Set(agentIds);
  // Malformed listed image records cannot turn into unclassified conversation choices.
  if (imageIds.some(id => !Object.hasOwn(records, id) || !object(records[id]))) throw Error('MODEL_CATALOG_IMAGE_LIST_INVALID');
  const models = Object.entries(records).flatMap(([id, value]): CatalogModel[] => {
    const row = object(value); if (!validModelId(id) || !row) return [];
    const displayName = typeof row.displayName === 'string' && row.displayName.length > 0 && row.displayName.length <= 200 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(row.displayName) ? row.displayName : id;
    const quota = object(row.quotaInfo), fraction = quota?.remainingFraction, reset = quota?.resetTime;
    const enumeration = modelEnum(row.model);
    return [{ id, displayName, disabled: row.disabled === undefined ? 'unspecified' : typeof row.disabled === 'boolean' ? row.disabled : 'invalid',
      image: images.has(id), agent: agents.has(id), ...(enumeration ? { modelEnum: enumeration } : {}),
      ...(typeof row.supportsImages === 'boolean' ? { imageInput: row.supportsImages } : {}),
      remainingFraction: typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null,
      resetAt: typeof reset === 'string' && reset.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(reset) && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null }];
  });
  const result: ModelCatalog = Object.freeze({ models: Object.freeze(models.map(row => Object.freeze(row))), imageIds: Object.freeze([...imageIds]), agentIds: Object.freeze([...agents]), imageListDeclared: payload.imageGenerationModelIds !== undefined, agentListDeclared: payload.agentModelSorts !== undefined });
  parsed.add(result); return result;
}
export function catalogChoices(value: unknown, usage: ModelUse): ModelChoice[] {
  const catalog = parseModelCatalog(value), records = new Map(catalog.models.map(row => [row.id, row]));
  const order = usage === 'image' ? catalog.imageIds : catalog.agentIds;
  return [...new Set([...order, ...records.keys()])].flatMap(id => {
    const row = records.get(id);
    if (!row || row.disabled === true || row.disabled === 'invalid' || (usage === 'conversation' ? row.image : !row.image)) return [];
    return [Object.freeze({ id, label: row.displayName === id ? id : `${row.displayName} (${id})`,
      ...(!row.image && !row.agent ? { classification: 'unclassified' as const } : {}),
      ...(row.modelEnum ? { modelEnum: row.modelEnum } : {}), ...(row.imageInput === undefined ? {} : { imageInput: row.imageInput }) })];
  });
}
/** Explicit image members only. Missing metadata does not establish denial. */
export function imageCatalogIssue(value: unknown): string | undefined {
  const catalog = parseModelCatalog(value);
  if (!catalog.imageListDeclared) return 'IMAGE_CATALOG_LIST_MISSING';
  if (!catalog.imageIds.length) return 'IMAGE_CATALOG_LIST_EMPTY';
  if (!catalogChoices(catalog, 'image').length) return 'IMAGE_CATALOG_LIST_UNAVAILABLE';
  return undefined;
}
/** Confirmation belongs to one selected ID/account/endpoint, never a vendor table. */
export function assertModelUse(model: ModelChoice | undefined, confirmed: boolean, code: string): asserts model is ModelChoice {
  if (!model || model.classification === 'unclassified' && !confirmed) throw Error(code);
}
