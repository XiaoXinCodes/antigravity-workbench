import { LiveError } from './live-storage';
import { catalogPayload, catalogChoices, type ModelChoice } from './model-catalog';
export type WakeModelChoice = ModelChoice;
export function wakeCatalogPayload(value: unknown): Record<string, unknown> {
  try { return catalogPayload(value); } catch { throw new LiveError('WAKE_MODEL_CATALOG_INVALID'); }
}
export function wakeModelsFromCatalog(value: unknown): WakeModelChoice[] {
  try { return catalogChoices(value, 'conversation'); } catch { throw new LiveError('WAKE_MODEL_CATALOG_INVALID'); }
}
