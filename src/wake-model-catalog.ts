import { LiveError } from './live-storage';
export interface WakeModelChoice { id: string; label: string }
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(value);
/** Keep the server's agent choices and exact callable map keys. Image input
 * support, MIME types, names, quota buckets and model constants are not roles. */
export function wakeCatalogPayload(value: unknown): Record<string, unknown> {
  const outer = object(value), wrapped = object(outer?.response);
  if (outer?.models !== undefined && wrapped?.models !== undefined) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
  const catalog = wrapped ?? outer;
  if (!catalog || !object(catalog.models)) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
  return catalog;
}
export function wakeModelsFromCatalog(value: unknown): WakeModelChoice[] {
  const catalog = wakeCatalogPayload(value), records = object(catalog.models);
  if (!catalog || !records || Object.keys(records).length > 500) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
  const images = catalog.imageGenerationModelIds;
  if (images !== undefined && (!Array.isArray(images) || images.length > 500 || !images.every(validId))) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
  const imageIds = new Set(Array.isArray(images) ? images : []);
  const sorts = catalog.agentModelSorts;
  let ids: string[];
  if (sorts !== undefined) {
    if (!Array.isArray(sorts) || sorts.length > 100) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
    ids = [];
    for (const sort of sorts) {
      if (!object(sort)) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
      const groups = object(sort)?.groups === undefined ? [] : object(sort)?.groups;
      if (!Array.isArray(groups) || groups.length > 100) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
      for (const group of groups) {
        if (!object(group)) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
        const members = object(group)?.modelIds === undefined ? [] : object(group)?.modelIds;
        if (!Array.isArray(members) || members.length > 500 || !members.every(validId)) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
        ids.push(...members);
        if (ids.length > 5000) throw new LiveError('WAKE_MODEL_CATALOG_INVALID');
      }
    }
  } else if (images !== undefined) ids = Object.keys(records);
  else throw new LiveError('WAKE_MODEL_TYPES_UNAVAILABLE');
  return [...new Set(ids)].flatMap(id => {
    if (!validId(id) || imageIds.has(id) || !Object.hasOwn(records, id)) return [];
    const row = object(records[id]);
    if (!row || row.disabled !== undefined && row.disabled !== false) return [];
    const name = typeof row.displayName === 'string' && row.displayName.length <= 200 ? row.displayName : id;
    return [{ id, label: name === id ? id : `${name} (${id})` }];
  });
}
