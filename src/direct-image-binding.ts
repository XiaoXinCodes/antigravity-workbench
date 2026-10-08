/* eslint-disable no-control-regex -- Email and model identifiers must reject controls. */
import { createHash } from 'node:crypto';
import type { BoundImageAccount } from './direct-image-core';
import { imageEndpoint, imageModelEnum, type ImageEndpoint } from './direct-image-protocol';
import { savedProject, validImageProject } from './direct-image-project';
import { validateSlots, assertSlotIdentity, type TokenSlots } from './live-storage';
import { validBearerToken } from './account-quota-transport';

type RecordValue = Record<string, unknown>;
const object = (x: unknown): x is RecordValue => !!x && typeof x === 'object' && !Array.isArray(x);
const EMAIL = /^[^\s@\x00-\x1f<>]+@[^\s@\x00-\x1f<>]+$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface AccountChoice { id: string; label: string; expectedEmail: string; active: boolean; hostCurrent: boolean; migrationState?: string; hostId?: string; capturedAt?: string }
export interface ImageModelChoice { id: string; label: string; modelEnum?: string }
export interface VaultReader { get(key: string): PromiseLike<string | undefined> }
// Unforgeable in-process membership proof. The binding also rechecks the current
// account/catalog and endpoint before resolving a project and freezing the request.
const currentModelProof = new WeakMap<ImageModelChoice, string>();
const IMAGE_MODEL_NAMES: Readonly<Record<string, string>> = {
  'gemini-nano-banana-2.1': 'Nano Banana 2.1',
  'gemini-3.1-flash-lite-image': 'Nano Banana 2 Lite',
  'gemini-3.1-flash-image': 'Nano Banana 2',
  'gemini-3-pro-image': 'Nano Banana Pro',
  'gemini-2.5-flash-image': 'Nano Banana',
};

/** The official current account's image-generation list, not the separate agent/chat model list. */
export function currentImageModels(authResponse: unknown, statusResponse: unknown, availableResponse: unknown, email: string): ImageModelChoice[] {
  if (!object(authResponse) || !object(authResponse.authResult) || authResponse.authResult.hasValidAuth !== true ||
      !object(statusResponse) || !object(statusResponse.userStatus)) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  const user = statusResponse.userStatus;
  if (typeof user.email !== 'string' || !EMAIL.test(user.email) || user.email.toLowerCase() !== email.toLowerCase())
    throw new Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
  const models = imageModelsFromCatalog(object(availableResponse) ? availableResponse.response : undefined);
  for (const model of models) currentModelProof.set(model, email.toLowerCase());
  return models;
}

/** A catalog returned for the bearer verified by the saved-account transaction. */
export function imageModelsFromCatalog(data: unknown): ImageModelChoice[] {
  const rows = object(data) ? data.imageGenerationModelIds : undefined;
  const records = object(data) ? data.models : undefined;
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
  const models: ImageModelChoice[] = [];
  if (!object(records)) throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
  for (const item of rows) {
    if (typeof item !== 'string' || !MODEL.test(item) || !Object.hasOwn(records, item) ||
        !object(records[item]) || records[item].disabled !== undefined && records[item].disabled !== false) throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
    if (models.some(m => m.id === item)) throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
    const name = IMAGE_MODEL_NAMES[item];
    const modelEnum = imageModelEnum(records[item].model);
    models.push(Object.freeze({ id: item, label: name ? `${name}（${item}）` : item, ...(modelEnum ? { modelEnum } : {}) }));
  }
  return models;
}

/** Read the already saved, host-bound account; never initiate refresh, login or a storage write. */
export async function bindSavedImageAccount(input: {
  vault: VaultReader; selected: AccountChoice; hostId: string; model: ImageModelChoice;
  assertCurrent(): Promise<void>; verifyIdentity(accessToken: string, signal: AbortSignal): Promise<{ email: string }>;
  resolveProject?(accessToken: string, signal: AbortSignal): Promise<string>;
  endpoint?: ImageEndpoint;
  resolveEndpointProject?(accessToken: string, signal: AbortSignal, endpoint: ImageEndpoint): Promise<{ projectId: string; endpoint: ImageEndpoint }>;
  resolveCurrentToken?(signal: AbortSignal): Promise<{ token: string; expiresAt?: number; verify(): Promise<void> }>;
  signal: AbortSignal; now?: () => number; freezeAfterBinding?: boolean;
}): Promise<BoundImageAccount> {
  const { vault, selected, hostId, model, signal } = input;
  const endpoint = input.endpoint === undefined ? undefined : imageEndpoint(input.endpoint);
  if (endpoint !== undefined && !input.resolveEndpointProject) throw new Error('IMAGE_DIRECT_PROJECT_ENDPOINT_MISMATCH');
  if (signal.aborted) throw new Error('IMAGE_CANCELLED');
  if (!ID.test(selected.id) || !selected.active || !EMAIL.test(selected.expectedEmail))
    throw new Error('IMAGE_DIRECT_SUMMARY_MISMATCH');
  if (!selected.hostCurrent) throw new Error('IMAGE_DIRECT_HOST_MISMATCH');
  if (selected.migrationState === 'pending') throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
  if (!MODEL.test(model.id) || currentModelProof.get(model) !== selected.expectedEmail.toLowerCase())
    throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
  await input.assertCurrent();
  const key = `live-switch.account.v1.${selected.id}`;
  const pending = [`live-switch.quota-pending.v1.${selected.id}`, `live-switch.quota-refresh.v1.${selected.id}`, 'live-switch.recovery.v1',
    `live-switch.recovery.v1.host.${createHash('sha256').update(hostId).digest('hex')}`];
  const read = async (name: string) => {
    try { return await vault.get(name); }
    catch { throw new Error('IMAGE_DIRECT_VAULT_READ_FAILED'); }
  };
  for (const name of pending) if (await read(name)) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
  const raw = await read(key);
  if (!raw) throw new Error('IMAGE_DIRECT_SECRET_MISSING');
  if (raw.length > 512 * 1024) throw new Error('IMAGE_DIRECT_SECRET_INVALID');
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { throw new Error('IMAGE_DIRECT_SECRET_INVALID'); }
  if (!object(stored) || stored.id !== selected.id ||
      typeof stored.expectedEmail !== 'string' || stored.expectedEmail.toLowerCase() !== selected.expectedEmail.toLowerCase())
    throw new Error('IMAGE_DIRECT_SECRET_INVALID');
  if (stored.hostId !== hostId) throw new Error('IMAGE_DIRECT_HOST_MISMATCH');
  if (stored.migrationState === 'pending') throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
  if (!object(stored.slots)) throw new Error('IMAGE_DIRECT_SECRET_INVALID');
  const slots = stored.slots;
  try { validateSlots(slots as unknown as TokenSlots); assertSlotIdentity(slots as unknown as TokenSlots, selected.expectedEmail); }
  catch { throw new Error('IMAGE_DIRECT_SECRET_INVALID'); }
  const values = [slots.keyring, slots.file].filter((v): v is string => typeof v === 'string');
  if (!values.length) throw new Error('IMAGE_DIRECT_SECRET_INVALID');
  const parsed: RecordValue[] = [];
  try { for (const value of values) { const item: unknown = JSON.parse(value); if (!object(item)) throw Error(); parsed.push(item); } }
  catch { throw new Error('IMAGE_DIRECT_SECRET_INVALID'); }
  const project = savedProject(parsed.map(item => item.project_id));
  if (project.kind === 'invalid' || project.kind === 'conflict')
    throw new Error(`IMAGE_DIRECT_PROJECT_${project.kind.toUpperCase()}`);
  if (endpoint === undefined && project.kind === 'missing' && !input.resolveProject) throw new Error('IMAGE_DIRECT_PROJECT_MISSING');
  const rows = parsed.map(item => object(item.token) ? item.token : {});
  const now = input.now?.() ?? Date.now();
  const active = rows.filter(row => validBearerToken(row.access_token) && typeof row.expiry === 'string' &&
    Number.isFinite(Date.parse(row.expiry)) && Date.parse(row.expiry) > now + 60_000)
    .sort((a, b) => Date.parse(b.expiry as string) - Date.parse(a.expiry as string))[0];
  const current = active ? undefined : await input.resolveCurrentToken?.(signal);
  if (!active && !current) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  const token = active && typeof active.access_token === 'string' ? active.access_token : current!.token;
  if (!validBearerToken(token)) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  const revision = createHash('sha256').update(raw).digest('hex');
  let frozen = false;
  const assertCurrent = async () => {
    if (signal.aborted) throw new Error('IMAGE_CANCELLED');
    if (!frozen) await input.assertCurrent();
    if (await read(key) !== raw || createHash('sha256').update(raw).digest('hex') !== revision) throw new Error('IMAGE_DIRECT_ACCOUNT_CHANGED');
    for (const name of pending) if (await read(name)) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
    if (active) {
      if (Date.parse(active.expiry as string) <= (input.now?.() ?? Date.now()) + 5_000) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
    } else if (!frozen) await current!.verify();
    else if (current!.expiresAt === undefined || current!.expiresAt <= (input.now?.() ?? Date.now()) + 5_000) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  };
  await assertCurrent();
  let identity: { email: string };
  try { identity = await input.verifyIdentity(token, signal); }
  catch {
    if (signal.aborted) throw new Error('IMAGE_CANCELLED');
    throw new Error('IMAGE_DIRECT_IDENTITY_CHECK_FAILED');
  }
  if (!identity || typeof identity.email !== 'string' || identity.email.toLowerCase() !== selected.expectedEmail.toLowerCase())
    throw new Error('IMAGE_DIRECT_IDENTITY_MISMATCH');
  await assertCurrent();
  let projectId: string;
  if (endpoint !== undefined) {
    // Saved project fields have no endpoint provenance. Resolve once with the
    // same verified bearer; never write back, guess a fallback, or cross environments.
    let resolved: { projectId: string; endpoint: ImageEndpoint };
    try { resolved = await input.resolveEndpointProject!(token, signal, endpoint); }
    catch (error) {
      if (signal.aborted) throw new Error('IMAGE_CANCELLED');
      throw new Error(error instanceof Error && error.message === 'IMAGE_DIRECT_PROJECT_LOOKUP_INVALID' ?
        'IMAGE_DIRECT_PROJECT_LOOKUP_INVALID' : 'IMAGE_DIRECT_PROJECT_LOOKUP_FAILED');
    }
    if (resolved.endpoint !== endpoint) throw new Error('IMAGE_DIRECT_PROJECT_ENDPOINT_MISMATCH');
    if (!validImageProject(resolved.projectId)) throw new Error('IMAGE_DIRECT_PROJECT_LOOKUP_INVALID');
    projectId = resolved.projectId;
  } else if (project.kind === 'saved') projectId = project.value;
  else {
    try { projectId = await input.resolveProject!(token, signal); }
    catch (error) {
      if (signal.aborted) throw new Error('IMAGE_CANCELLED');
      throw new Error(error instanceof Error && error.message === 'IMAGE_DIRECT_PROJECT_LOOKUP_INVALID' ?
        'IMAGE_DIRECT_PROJECT_LOOKUP_INVALID' : 'IMAGE_DIRECT_PROJECT_LOOKUP_FAILED');
    }
    if (!validImageProject(projectId)) throw new Error('IMAGE_DIRECT_PROJECT_LOOKUP_INVALID');
  }
  await assertCurrent();
  frozen = input.freezeAfterBinding === true;
  return { token, projectId, modelId: model.id, accountId: selected.id,
    ...(endpoint !== undefined ? { endpoint } : {}), ...(model.modelEnum ? { modelEnum: model.modelEnum } : {}),
    projectSource: endpoint === undefined && project.kind === 'saved' ? 'saved-token' : 'loadCodeAssist', verify: async requestSignal => { if (requestSignal.aborted) throw new Error('IMAGE_CANCELLED'); await assertCurrent(); } };
}
