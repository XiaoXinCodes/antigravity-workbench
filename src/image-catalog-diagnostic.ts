import { parseModelCatalog, imageCatalogIssue, validModelId } from './model-catalog';
import { t as tr } from './i18n';
import type { AccountChoice } from './direct-image-binding';
import { imageEndpointHost, type ImageEndpoint } from './direct-image-protocol';

const safeId = (value: unknown): value is string => typeof value === 'string' && validModelId(value) && !/^(?:ya29\.|1\/\/|gh[pousr]_|bearer|token|secret)/i.test(value);
export interface CatalogSummary {
  status: 'queried' | 'invalid';
  imageListIssue?: string;
  imageModels: { id: string; disabled: boolean | 'unspecified' }[];
  allModels: { id: string; listed: boolean; disabled: boolean | 'unspecified' }[];
}
/** Projection only: no arbitrary keys, labels, error text, project or identity values leave this module. */
export function summarizeImageCatalog(value: unknown): CatalogSummary {
  const invalid: CatalogSummary = { status: 'invalid', imageModels: [], allModels: [] };
  try {
    const catalog = parseModelCatalog(value);
    if (catalog.models.some(row => row.disabled === 'invalid') || catalog.imageIds.some(id => !safeId(id))) return invalid;
    const rows = catalog.models.filter(row => safeId(row.id)).map(row => ({ id: row.id, listed: row.image, disabled: row.disabled as boolean | 'unspecified' }));
    const issue = imageCatalogIssue(catalog);
    return { status: 'queried', ...(issue ? { imageListIssue: issue } : {}), imageModels: rows.filter(row => row.listed).map(({ id, disabled }) => ({ id, disabled })), allModels: rows };
  } catch (error) { return error instanceof Error && error.message === 'MODEL_CATALOG_IMAGE_LIST_INVALID' ? { ...invalid, imageListIssue: 'IMAGE_CATALOG_LIST_INVALID' } : invalid; }
}
export interface CatalogDiagnosticDependencies {
  endpoint(): ImageEndpoint;
  accounts(): AccountChoice[];
  hub(signal: AbortSignal): Promise<{ email: string; catalog: unknown; verify(signal: AbortSignal): Promise<void> }>;
  direct(id: string, signal: AbortSignal, endpoint: ImageEndpoint, assertCurrent: () => Promise<void>): Promise<CatalogSummary>;
  now?(): Date;
}
const declaration = (disabled: boolean | 'unspecified') => disabled === true ? tr("imageCatalogDiagnostic.c282a1dc85") : disabled === false ? tr("imageCatalogDiagnostic.e50db0604e") : tr("imageCatalogDiagnostic.12687fedf4");
function sourceLines(label: string, endpoint: string, summary: CatalogSummary | undefined, failure: string, observedAt: string): string[] {
  const lines = [`${label} · ${endpoint}`, tr("imageCatalogDiagnostic.7ec3a233e2", { p0: observedAt }), tr("imageCatalogDiagnostic.d2448497a2", { p0: summary?.status === 'queried' ? tr("imageCatalogDiagnostic.54a3c7bc15") : summary ? tr("imageCatalogDiagnostic.23bb3a4098") : failure })];
  if (summary?.imageListIssue) lines.push(summary.imageListIssue);
  if (summary?.status !== 'queried') return lines;
  lines.push(tr("imageCatalogDiagnostic.ad2aeadc51"), ...(summary.imageModels.length ? summary.imageModels.map(m => `  ${m.id} · ${declaration(m.disabled)}`) : [tr("imageCatalogDiagnostic.909aff071c")]));
  lines.push(tr("imageCatalogDiagnostic.5587c66677"), ...(summary.allModels.length ? summary.allModels.map(m => `  ${m.id} · ${m.listed ? tr("imageCatalogDiagnostic.c27ef48917") : tr("imageCatalogDiagnostic.541ef70700")} · ${declaration(m.disabled)}`) : [tr("imageCatalogDiagnostic.22db2dc2bf")]));
  return lines;
}
/** Explicit one-shot lookup. A failed or changed current identity never authorizes another saved account. */
export async function diagnoseImageCatalog(deps: CatalogDiagnosticDependencies, signal: AbortSignal): Promise<string> {
  const endpoint = deps.endpoint();
  let hub: CatalogSummary | undefined, direct: CatalogSummary | undefined;
  let hubFailure = tr("imageCatalogDiagnostic.139806c3c3"), directFailure = tr("imageCatalogDiagnostic.1a4e732a6f");
  let hubTime = tr("imageCatalogDiagnostic.139806c3c3"), directTime = tr("imageCatalogDiagnostic.139806c3c3");
  let comparison = tr("imageCatalogDiagnostic.ce60ae203d");
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  try {
    const snapshot = await deps.hub(signal);
    const assertCurrent = async () => {
      if (signal.aborted) throw new Error('IMAGE_CANCELLED');
      if (deps.endpoint() !== endpoint) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
      await snapshot.verify(signal);
    };
    await assertCurrent(); hub = summarizeImageCatalog(snapshot.catalog); hubTime = now();
    const matches = deps.accounts().filter(a => a.hostCurrent && a.migrationState !== 'pending' && a.expectedEmail.toLowerCase() === snapshot.email.toLowerCase());
    if (matches.length !== 1) directFailure = tr("imageCatalogDiagnostic.11d564f729");
    else {
      const match = matches[0]!, identity = JSON.stringify([match.id, match.expectedEmail, match.hostId, match.capturedAt]);
      const verifyMatch = async () => {
        await assertCurrent();
        const rows = deps.accounts().filter(a => a.id === match.id && a.hostCurrent && a.migrationState !== 'pending');
        if (rows.length !== 1 || JSON.stringify([rows[0]!.id, rows[0]!.expectedEmail, rows[0]!.hostId, rows[0]!.capturedAt]) !== identity) throw new Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
      };
      directFailure = tr("imageCatalogDiagnostic.8ee9ba9b59");
      direct = await deps.direct(match.id, signal, endpoint, verifyMatch); directTime = now();
      await verifyMatch();
      if (hub.status === 'queried' && direct.status === 'queried') {
        const h = hub.imageModels, d = direct.imageModels;
        const onlyHub = h.filter(x => !d.some(y => y.id === x.id)).map(x => x.id);
        const onlyDirect = d.filter(x => !h.some(y => y.id === x.id)).map(x => x.id);
        const flags = h.filter(x => d.some(y => y.id === x.id && y.disabled !== x.disabled)).map(x => x.id);
        comparison = [tr("imageCatalogDiagnostic.b1e691c28a"), tr("imageCatalogDiagnostic.608d0e0fdc", { p0: onlyHub.join('、') || tr("imageCatalogDiagnostic.484d556139") }), tr("imageCatalogDiagnostic.fb6e22946a", { p0: onlyDirect.join('、') || tr("imageCatalogDiagnostic.484d556139") }), tr("imageCatalogDiagnostic.2e06974abc", { p0: flags.join('、') || tr("imageCatalogDiagnostic.484d556139") })].join('\n');
      }
    }
  } catch (error) {
    const changed = error instanceof Error && ['IMAGE_DIRECT_ACCOUNT_CHANGED', 'IMAGE_DIRECT_ENDPOINT_CHANGED', 'IMAGE_SAVED_ACCOUNT_CHANGED', 'IMAGE_SAVED_ACCOUNT_REMOVED', 'IMAGE_CANCELLED'].includes(error.message);
    if (changed) { hub = undefined; direct = undefined; hubFailure = tr("imageCatalogDiagnostic.38e0d1e737"); directFailure = tr("imageCatalogDiagnostic.7b58679f30"); }
    else if (!hub) hubFailure = tr("imageCatalogDiagnostic.09178a4726");
    else if (error instanceof Error && error.message === 'IMAGE_CATALOG_LIST_INVALID') directFailure = 'IMAGE_CATALOG_LIST_INVALID';
    comparison = tr("imageCatalogDiagnostic.0106577830");
  }
  return [tr("imageCatalogDiagnostic.982a28516e"), tr("imageCatalogDiagnostic.95edefc608"),
    ...sourceLines(tr("imageCatalogDiagnostic.bc01ee841f"), tr("imageCatalogDiagnostic.df130cd472"), hub, hubFailure, hubTime), '',
    ...sourceLines(tr("imageCatalogDiagnostic.3726048fa4"), imageEndpointHost(endpoint), direct, directFailure, directTime), '', comparison,
    tr("imageCatalogDiagnostic.b667c7c69c")].join('\n');
}
