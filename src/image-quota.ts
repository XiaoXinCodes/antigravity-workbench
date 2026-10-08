import { t as tr } from './i18n';
import type { ImageEndpoint } from './direct-image-protocol';
import type { ImageModelChoice } from './direct-image-binding';

export interface ImageQuotaRow { modelId: string; remainingFraction: number | null; resetAt: string | null }
export interface ImageQuotaSnapshot extends ImageQuotaRow { accountId: string; endpoint: ImageEndpoint; queriedAt: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function imageQuotaErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (/^(IMAGE_ACCOUNT_CHECK_TIMEOUT|ACCOUNT_QUOTA_TIMEOUT)$/.test(code)) return tr("imageQuota.d0f855d334");
  if (/FORBIDDEN|ACCESS_DENIED/.test(code)) return tr("imageQuota.0536dcd4c6");
  if (/AUTH_REQUIRED|AUTH_EXPIRED|REAUTH_REQUIRED/.test(code)) return tr("imageQuota.fa8806af0e");
  if (/ACCOUNT_CHANGED|ACCOUNT_REMOVED|ENDPOINT_CHANGED|MODEL_UNVERIFIED/.test(code)) return tr("imageQuota.a5985a2084");
  if (/RATE_LIMITED/.test(code)) return tr("imageQuota.d5a6407f33");
  if (/RECOVERY_PENDING|AUTH_PENDING|OPERATION_BUSY/.test(code)) return tr("imageQuota.9e8832bf58");
  return tr("imageQuota.e0ad55969a");
}

/** Only the selected image directory member's own server fields. No grouping,
 * cross-model overrides, credits conversion, or inference about pool sharing. */
export function imageQuotaFromCatalog(value: unknown, models: ImageModelChoice[]): ImageQuotaRow[] {
  if (!object(value) || !object(value.models)) throw Error('IMAGE_SAVED_MODELS_INVALID');
  const records = value.models;
  return models.map(model => {
    const record = Object.hasOwn(records, model.id) ? records[model.id] : undefined;
    const quota = object(record) && object(record.quotaInfo) ? record.quotaInfo : {};
    const fraction = quota.remainingFraction, reset = quota.resetTime;
    return { modelId: model.id,
      remainingFraction: typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null,
      resetAt: typeof reset === 'string' && reset.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(reset) && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null };
  });
}

export function imageQuotaPercent(fraction: number, nearFull = tr("imageQuota.bafbf5e6f8")): string {
  // A sub-full fraction must never round up to a claim of full quota.
  return fraction < 1 && Math.round(fraction * 10_000) === 10_000 ? nearFull : (fraction * 100).toFixed(2) + '%';
}

export interface ImageQuotaState { loading: boolean; stale: boolean; snapshot?: ImageQuotaSnapshot; error?: string | undefined }
/** One window's in-memory quota. A selection change retires pending requests;
 * explicit refresh keeps any previous same-selection reading visibly stale. */
export class ImageQuotaQuery {
  private key = '';
  private revision = 0;
  private abort: AbortController | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private state: ImageQuotaState = { loading: false, stale: false };
  constructor(private readonly changed: () => void) {}
  selection(key: string): void {
    if (key === this.key) return;
    this.invalidate(); this.key = key; this.state = { loading: false, stale: false };
  }
  invalidate(keepReading = false): void {
    clearTimeout(this.expiry); this.expiry = undefined;
    ++this.revision; this.abort?.abort(); this.abort = undefined;
    this.state = keepReading ? { ...this.state, loading: false, stale: !!this.state.snapshot, error: undefined } : { loading: false, stale: false };
  }
  getState(): ImageQuotaState { return { ...this.state, ...(this.state.snapshot ? { snapshot: { ...this.state.snapshot } } : {}) }; }
  async query(read: (signal: AbortSignal) => Promise<ImageQuotaSnapshot>, errorText: (error: unknown) => string): Promise<void> {
    if (this.state.loading) return;
    clearTimeout(this.expiry); this.expiry = undefined;
    const revision = ++this.revision, abort = new AbortController(); this.abort = abort;
    this.state = { ...this.state, loading: true, stale: !!this.state.snapshot, error: undefined }; this.changed();
    let listener: () => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      listener = () => reject(Error('IMAGE_ACCOUNT_CHECK_TIMEOUT'));
      abort.signal.addEventListener('abort', listener, { once: true });
    });
    const timer = setTimeout(() => abort.abort(), 60_000);
    try {
      const snapshot = await Promise.race([Promise.resolve().then(() => read(abort.signal)), interrupted]);
      if (revision === this.revision && !abort.signal.aborted) {
        this.state = { loading: false, stale: false, snapshot };
        this.expiry = setTimeout(() => {
          this.expiry = undefined;
          if (revision === this.revision) { this.state = { ...this.state, stale: true }; this.changed(); }
        }, 60_000);
        this.expiry.unref?.();
      }
    } catch (error) {
      if (revision === this.revision) this.state = { ...this.state, loading: false, error: errorText(error) };
    } finally {
      clearTimeout(timer); abort.signal.removeEventListener('abort', listener);
      if (this.abort === abort) this.abort = undefined;
      if (revision === this.revision) this.changed();
    }
  }
}
