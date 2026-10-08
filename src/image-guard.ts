/* eslint-disable no-control-regex -- Reject non-display control bytes in framework metadata. */
/** Owned CLI PreToolUse hook. No shell, network, credential access or arbitrary file reads. */
import * as fs from 'node:fs';
import * as path from 'node:path';
export interface ImageGuardPolicy { references: string[]; imageName: string; aspectRatio: string; workspace: string }
export const IMAGE_GUARD_REASONS = ['EVENT_SHAPE', 'TOOL_NAME', 'ARGUMENT_SHAPE', 'UNKNOWN_ARGUMENT', 'FRAMEWORK_METADATA', 'ARGUMENT_ALIAS', 'PROMPT', 'IMAGE_NAME', 'ASPECT_RATIO', 'REFERENCE_SHAPE', 'REFERENCE_COUNT', 'REFERENCE_PATH', 'CALL_LIMIT', 'STATE_IO', 'INPUT_LIMIT'] as const;
export type ImageGuardReason = typeof IMAGE_GUARD_REASONS[number];
export const IMAGE_ARGUMENT_FIELDS = ['Prompt', 'ImageName', 'AspectRatio', 'ImagePaths', 'explanation', 'toolSummary', 'toolAction', 'waitForPreviousTools', 'Size', 'Quality', 'Count', 'Width', 'Height', 'Resolution', 'Format'] as const;
const ARGUMENT_TYPES = ['string', 'boolean', 'number', 'null', 'array', 'object', 'other'] as const;
type ArgumentType = typeof ARGUMENT_TYPES[number];
export interface ImageArgumentShape { knownTypes: Partial<Record<typeof IMAGE_ARGUMENT_FIELDS[number], ArgumentType>>; unknownFieldCount: number }
export interface ImageGuardDiagnostic { version: 1; reason: ImageGuardReason; generationAllowed: boolean | 'unknown'; argumentShape?: ImageArgumentShape }
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; } catch { return undefined; }
}
/** Only known key/type pairs and a capped count cross IPC; never unknown names or values. */
export function sanitizeImageArgumentShape(value: unknown): ImageArgumentShape | undefined {
  const known = ownData(value, 'knownTypes'), unknown = ownData(value, 'unknownFieldCount');
  if (!known || typeof known !== 'object' || typeof unknown !== 'number' || !Number.isSafeInteger(unknown) || unknown < 0 || unknown > 1024) return undefined;
  const knownTypes: ImageArgumentShape['knownTypes'] = {};
  for (const field of IMAGE_ARGUMENT_FIELDS) { const type = ownData(known, field); if (typeof type === 'string' && (ARGUMENT_TYPES as readonly string[]).includes(type)) knownTypes[field] = type as ArgumentType; }
  return { knownTypes, unknownFieldCount: unknown };
}
export function imageArgumentShape(input: unknown): ImageArgumentShape | undefined {
  const args = ownData(ownData(input, 'toolCall'), 'args');
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const knownTypes: ImageArgumentShape['knownTypes'] = {};
    for (const field of IMAGE_ARGUMENT_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(args, field); if (!descriptor) continue;
      const value = 'value' in descriptor ? descriptor.value : undefined;
      knownTypes[field] = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'other';
    }
    return {knownTypes, unknownFieldCount: Math.min(1024, Object.keys(args).filter(key => !(IMAGE_ARGUMENT_FIELDS as readonly string[]).includes(key)).length)};
  } catch { return undefined; }
}
export function safeImageName(value: unknown): value is string { return typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(value); }
/** Official 1.2.14 ToSnakeCase: ASCII non-alphanumerics -> _, lowercase, trim _.
 * Admit only a bounded basename alphabet before normalization, never paths/dots. */
export function canonicalImageName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9 _-]+$/u.test(value)) return undefined;
  const name = value.replace(/[^A-Za-z0-9]+/gu, '_').toLowerCase().replace(/^_+|_+$/gu, '');
  return safeImageName(name) ? name : undefined;
}
const METADATA_FIELDS = ['explanation', 'toolSummary', 'toolAction', 'waitForPreviousTools'] as const;
const FIELDS = ['Prompt', 'ImageName', 'AspectRatio', 'ImagePaths', ...METADATA_FIELDS];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Only fixed enum values cross disk/IPC/UI. Never retain input values, paths or unknown field names. */
export function imageGuardDiagnostics(error: unknown): ImageGuardDiagnostic | undefined {
  const value = ownData(error, 'guard'), reason = ownData(value, 'reason'), generationAllowed = ownData(value, 'generationAllowed');
  if (ownData(value, 'version') !== 1 || !(IMAGE_GUARD_REASONS as readonly unknown[]).includes(reason) || (typeof generationAllowed !== 'boolean' && generationAllowed !== 'unknown')) return undefined;
  const argumentShape = sanitizeImageArgumentShape(ownData(value, 'argumentShape'));
  return { version: 1, reason: reason as ImageGuardReason, generationAllowed, ...(argumentShape ? {argumentShape} : {}) };
}
export function guardRejection(input: unknown, policy: ImageGuardPolicy): ImageGuardReason | undefined {
  if (!object(input) || !object(input.toolCall)) return 'EVENT_SHAPE';
  const call = input.toolCall;
  if (call.name !== 'generate_image') return 'TOOL_NAME';
  if (!object(call.args)) return 'ARGUMENT_SHAPE';
  const args = call.args;
  const unexpected = Object.keys(args).filter(k => !FIELDS.includes(k));
  if (unexpected.some(k => FIELDS.some(field => field.toLowerCase() === k.toLowerCase()))) return 'ARGUMENT_ALIAS';
  if (unexpected.length) return 'UNKNOWN_ARGUMENT';
  // Official framework may augment tool schemas with these display/scheduling
  // fields. They do not select images, paths, models, quotas or invocation counts.
  for (const key of METADATA_FIELDS) if (Object.hasOwn(args, key)) {
    const value = args[key];
    if (key === 'waitForPreviousTools' ? typeof value !== 'boolean' : typeof value !== 'string' || Buffer.byteLength(value) > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) return 'FRAMEWORK_METADATA';
  }
  if (typeof args.Prompt !== 'string' || !args.Prompt.trim() || Buffer.byteLength(args.Prompt) > 48_000) return 'PROMPT';
  if (!canonicalImageName(args.ImageName)) return 'IMAGE_NAME';
  // Official Go string decoding maps omitted/null/empty to the same 1:1 default.
  // No whitespace/auto aliases, argument-string parsing or reference normalization.
  if ((args.AspectRatio === '' ? '1:1' : args.AspectRatio ?? '1:1') !== policy.aspectRatio) return 'ASPECT_RATIO';
  const refs = args.ImagePaths ?? [];
  if (!Array.isArray(refs) || refs.some(v => typeof v !== 'string')) return 'REFERENCE_SHAPE';
  if (refs.length !== policy.references.length) return 'REFERENCE_COUNT';
  if (!refs.every((v, i) => v === policy.references[i])) return 'REFERENCE_PATH';
  return undefined;
}
export function guardDecision(input: unknown, policy: ImageGuardPolicy): boolean { return guardRejection(input, policy) === undefined; }

/** Read only the owned, bounded diagnostic; never follow a link or expose raw content. */
function readOwnedJson(workspace: string, name: '.generation-scope-denied' | '.generation-started'): unknown {
  const file = path.join(workspace, name);
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.size > 1024) return undefined;
    const bytes = Buffer.alloc(1025); const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd); const current = fs.lstatSync(file);
    if (count !== opened.size || count > 1024 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev || current.nlink !== 1) return undefined;
    return JSON.parse(bytes.subarray(0, count).toString('utf8')) as unknown;
  } catch { return undefined; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readImageGuardDiagnostic(workspace: string): ImageGuardDiagnostic | undefined {
  const diagnostic = imageGuardDiagnostics({ guard: readOwnedJson(workspace, '.generation-scope-denied') });
  if (!diagnostic || diagnostic.generationAllowed === true) return diagnostic;
  // Concurrent hooks can record a rejection before another hook wins its one
  // exclusive claim. Never tell the UI 'not allowed' after a claim exists.
  if (readImageGuardClaim(workspace)) return { ...diagnostic, generationAllowed: true };
  try { fs.lstatSync(path.join(workspace, '.generation-started')); return { ...diagnostic, generationAllowed: 'unknown' }; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? diagnostic : { ...diagnostic, generationAllowed: 'unknown' }; }
}
export function readImageGuardClaim(workspace: string): { version: 1; imageName: string } | undefined {
  const claim = readOwnedJson(workspace, '.generation-started');
  return object(claim) && claim.version === 1 && safeImageName(claim.imageName) ? { version: 1, imageName: claim.imageName } : undefined;
}
function validPolicy(value: unknown): value is ImageGuardPolicy {
  return object(value) && typeof value.workspace === 'string' && path.isAbsolute(value.workspace) && value.imageName === 'generated_image' &&
    ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes(String(value.aspectRatio)) && Array.isArray(value.references) && value.references.length <= 3 &&
    value.references.every((v, i) => v === path.join(String(value.workspace), `reference-${i + 1}.png`));
}
if (require.main === module) {
  let input = ''; let oversized = false; process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => { if (!oversized) { input += chunk; if (Buffer.byteLength(input) > 256 * 1024) { oversized = true; input = ''; } } });
  process.stdin.on('end', () => {
    let allow = false; let policy: ImageGuardPolicy | undefined;
    let diagnostic: ImageGuardDiagnostic = { version: 1, reason: 'STATE_IO', generationAllowed: 'unknown' };
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')); if (!validPolicy(raw)) throw new Error('invalid policy'); policy = raw;
      const started = path.join(policy.workspace, '.generation-started');
      const previous = readImageGuardDiagnostic(policy.workspace);
      if (previous) diagnostic = previous;
      else if (fs.existsSync(path.join(policy.workspace, '.generation-scope-denied'))) throw new Error('invalid diagnostic');
      else {
        const generationAllowed = fs.existsSync(started);
        let reason: ImageGuardReason | undefined, argumentShape: ImageArgumentShape | undefined;
        if (oversized) reason = 'INPUT_LIMIT';
        else { try { const event: unknown = JSON.parse(input); reason = guardRejection(event, policy); argumentShape = imageArgumentShape(event); } catch { reason = 'EVENT_SHAPE'; } }
        if (!reason && generationAllowed) reason = 'CALL_LIMIT';
        if (!reason) {
          // Exclusive claim retains the one-invocation bound under concurrent hooks.
          try {
            const event = JSON.parse(input) as { toolCall: { args: { ImageName: string } } };
            fs.writeFileSync(started, JSON.stringify({ version: 1, imageName: canonicalImageName(event.toolCall.args.ImageName) }), { flag: 'wx', mode: 0o600 }); allow = true;
          }
          catch (error) { reason = (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'CALL_LIMIT' : 'STATE_IO'; }
        }
        if (reason) diagnostic = { version: 1, reason, generationAllowed: reason === 'STATE_IO' ? 'unknown' : generationAllowed || reason === 'CALL_LIMIT', ...(argumentShape ? {argumentShape} : {}) };
      }
    } catch { /* Fail closed without echoing raw input, policy or errors. */ }
    if (!allow && policy) {
      // Preserve the first rejection so a later model retry cannot hide it.
      try { fs.writeFileSync(path.join(policy.workspace, '.generation-scope-denied'), JSON.stringify(diagnostic), { flag: 'wx', mode: 0o600 }); } catch { /* Rejection remains authoritative. */ }
    }
    process.stdout.write(JSON.stringify({ decision: allow ? 'allow' : 'deny', reason: allow ? 'Approved image request only.' : `IMAGE_REQUEST_SCOPE_DENIED: ${diagnostic.reason}. Stop this task; do not retry tools or change permissions.` }));
  });
}
