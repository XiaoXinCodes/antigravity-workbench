import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants, type Stats, type BigIntStats } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { normalizeLabel } from './core';
import { LiveError, assertSlotIdentity, tokenAccountHint, validateSlots, type TokenSlots } from './live-storage';

export interface MigrationAccount { label: string; expectedEmail: string; capturedAt: string; token: string }
export interface MigrationPayload { schema: 1; createdAt: string; accounts: MigrationAccount[] }

// Schema 1 deliberately has one bounded KDF profile. Never run parameters supplied
// by an archive before checking them, or an import could exhaust the extension host.
const FORMAT = 'antigravity-account-migration';
const CIPHER = 'aes-256-gcm';
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 } as const;
const MAX_MEMORY = 64 * 1024 * 1024;
const MAX_TOKEN = 256 * 1024;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_ARCHIVE = 24 * 1024 * 1024;
const MAX_ACCOUNTS = 50;
const MAX_PASSWORD = 1024;
type RecordValue = Record<string, unknown>;
interface ArchiveMetadata {
  format: typeof FORMAT;
  schema: 1;
  cipher: typeof CIPHER;
  kdf: typeof KDF & { salt: string };
  nonce: string;
}
interface ArchiveEnvelope extends ArchiveMetadata { ciphertext: string; tag: string }
interface ParsedArchive { metadata: ArchiveMetadata; salt: Buffer; nonce: Buffer; ciphertext: Buffer; tag: Buffer }

function exactRecord(value: unknown, keys: string[]): value is RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}
function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= max && !/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(value);
}
function validLabel(value: unknown): value is string {
  try { return normalizeLabel(value) === value; } catch { return false; }
}
function validEmail(value: unknown): value is string {
  return validText(value, 320) && value.length <= 260 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value);
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/** Pick one portable StoredToken, never exporting machine paths or native slots. */
export function portableToken(slots: TokenSlots, expectedEmail: string): string {
  const nativeSlots = exactRecord(slots, ['keyring', 'file']);
  const observedFileSlots = exactRecord(slots, ['keyring', 'file', 'keyringState']) && slots.keyringState === 'unobserved' && slots.keyring === null;
  if (!validEmail(expectedEmail) || !nativeSlots && !observedFileSlots ||
      [slots.keyring, slots.file].some(value => value !== null && typeof value !== 'string')) throw new LiveError('MIGRATION_TOKEN_INVALID');
  try {
    validateSlots(slots);
    assertSlotIdentity(slots, expectedEmail);
  } catch { throw new LiveError('MIGRATION_TOKEN_INVALID'); }
  // JWT claims are unsigned hints here, so a matching subject is not sufficient
  // evidence to choose between different refresh credentials.
  if (slots.keyring !== null && slots.file !== null && tokenAccountHint(slots.keyring).refresh !== tokenAccountHint(slots.file).refresh) {
    throw new LiveError('MIGRATION_TOKEN_CONFLICT');
  }
  return slots.keyring ?? slots.file!;
}

export function validateMigrationAccounts(value: unknown): MigrationAccount[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ACCOUNTS) throw new LiveError('MIGRATION_ACCOUNTS_INVALID');
  const emails = new Set<string>(), refreshTokens = new Set<string>();
  return Array.from(value, account => {
    if (!exactRecord(account, ['label', 'expectedEmail', 'capturedAt', 'token']) ||
        !validLabel(account.label) || !validEmail(account.expectedEmail) || !validDate(account.capturedAt) ||
        typeof account.token !== 'string' || !account.token || Buffer.byteLength(account.token, 'utf8') > MAX_TOKEN) {
      throw new LiveError('MIGRATION_ACCOUNT_INVALID');
    }
    const expectedEmail = account.expectedEmail.toLowerCase();
    if (!validEmail(expectedEmail)) throw new LiveError('MIGRATION_ACCOUNT_INVALID');
    const token = portableToken({ keyring: null, file: account.token }, expectedEmail);
    const refresh = tokenAccountHint(token).refresh;
    if (emails.has(expectedEmail) || refreshTokens.has(refresh)) throw new LiveError('MIGRATION_DUPLICATE_ACCOUNT');
    emails.add(expectedEmail); refreshTokens.add(refresh);
    return { label: account.label, expectedEmail, capturedAt: account.capturedAt, token };
  });
}

function passwordBytes(password: string, exporting: boolean): Buffer {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD ||
      exporting && Array.from(password).length < 12) throw new LiveError('MIGRATION_PASSWORD_INVALID');
  return Buffer.from(password, 'utf8');
}
function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}
function metadata(salt: string, nonce: string): ArchiveMetadata {
  return { format: FORMAT, schema: 1, cipher: CIPHER, kdf: { ...KDF, salt }, nonce };
}
function utf8(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new LiveError('MIGRATION_ARCHIVE_INVALID');
  return raw;
}
function base64(value: unknown, min: number, max: number): Buffer {
  if (typeof value !== 'string' || value.length < 4 * Math.ceil(min / 3) || value.length > 4 * Math.ceil(max / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new LiveError('MIGRATION_ARCHIVE_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64') !== value) throw new LiveError('MIGRATION_ARCHIVE_INVALID');
  return bytes;
}
function parseArchive(bytes: Uint8Array): ParsedArchive {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new LiveError('MIGRATION_ARCHIVE_INVALID');
  if (bytes.byteLength > MAX_ARCHIVE) throw new LiveError('MIGRATION_ARCHIVE_TOO_LARGE');
  let envelope: unknown;
  try {
    const raw = utf8(bytes).trim();
    envelope = JSON.parse(raw) as unknown;
    // Schema 1 uses the exporter's canonical JSON spelling (surrounding whitespace
    // is harmless). This also rejects duplicate/escaped keys that JSON.parse would
    // silently discard, preventing ignored plaintext from being smuggled into files.
    if (JSON.stringify(envelope) !== raw) throw 0;
  } catch { throw new LiveError('MIGRATION_ARCHIVE_INVALID'); }
  if (!exactRecord(envelope, ['format', 'schema', 'cipher', 'kdf', 'nonce', 'ciphertext', 'tag']) ||
      envelope.format !== FORMAT || envelope.schema !== 1 || envelope.cipher !== CIPHER ||
      !exactRecord(envelope.kdf, ['name', 'N', 'r', 'p', 'salt']) ||
      envelope.kdf.name !== KDF.name || envelope.kdf.N !== KDF.N || envelope.kdf.r !== KDF.r || envelope.kdf.p !== KDF.p) {
    throw new LiveError('MIGRATION_ARCHIVE_INVALID');
  }
  const salt = base64(envelope.kdf.salt, 32, 32), nonce = base64(envelope.nonce, 12, 12);
  return { metadata: metadata(salt.toString('base64'), nonce.toString('base64')), salt, nonce,
    ciphertext: base64(envelope.ciphertext, 1, MAX_PAYLOAD), tag: base64(envelope.tag, 16, 16) };
}

export async function encryptAccountArchive(accounts: MigrationAccount[], password: string): Promise<Buffer> {
  const secret = passwordBytes(password, true);
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const payload: MigrationPayload = { schema: 1, createdAt: new Date().toISOString(), accounts: validateMigrationAccounts(accounts) };
    plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    if (plaintext.length > MAX_PAYLOAD) throw new LiveError('MIGRATION_ARCHIVE_TOO_LARGE');
    const salt = randomBytes(32), nonce = randomBytes(12);
    const header = metadata(salt.toString('base64'), nonce.toString('base64'));
    key = await deriveKey(secret, salt);
    const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: ArchiveEnvelope = { ...header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (bytes.length > MAX_ARCHIVE) throw new LiveError('MIGRATION_ARCHIVE_TOO_LARGE');
    return bytes;
  } catch (error) { throw error instanceof LiveError ? error : new LiveError('MIGRATION_ENCRYPT_FAILED'); }
  finally { secret.fill(0); key?.fill(0); plaintext?.fill(0); }
}

export async function decryptAccountArchive(bytes: Uint8Array, password: string): Promise<MigrationPayload> {
  const archive = parseArchive(bytes), secret = passwordBytes(password, false);
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    try {
      key = await deriveKey(secret, archive.salt);
      const decipher = createDecipheriv(CIPHER, key, archive.nonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(JSON.stringify(archive.metadata), 'utf8'));
      decipher.setAuthTag(archive.tag);
      // Authentication completes before any decrypted content is returned or parsed.
      const pending = decipher.update(archive.ciphertext);
      try { plaintext = Buffer.concat([pending, decipher.final()]); } finally { pending.fill(0); }
    } catch { throw new LiveError('MIGRATION_DECRYPT_FAILED'); }
    try {
      const raw = utf8(plaintext).trim();
      const payload: unknown = JSON.parse(raw);
      if (JSON.stringify(payload) !== raw) throw 0;
      if (!exactRecord(payload, ['schema', 'createdAt', 'accounts']) || payload.schema !== 1 || !validDate(payload.createdAt)) throw 0;
      return { schema: 1, createdAt: payload.createdAt, accounts: validateMigrationAccounts(payload.accounts) };
    } catch { throw new LiveError('MIGRATION_PAYLOAD_INVALID'); }
  } finally { secret.fill(0); key?.fill(0); plaintext?.fill(0); }
}

function localFilename(filename: string): string {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0') ||
      /^(?:\\\\|\/\/)/u.test(filename) || /^\/[a-zA-Z]:/u.test(filename)) throw new LiveError('MIGRATION_PATH_UNSAFE');
  return path.normalize(filename);
}
type DirectorySnapshot = { name: string; stat: BigIntStats }[];
async function checkDirectories(filename: string): Promise<DirectorySnapshot> {
  const directories: string[] = [];
  let name = path.dirname(filename);
  while (true) {
    directories.unshift(name);
    const parent = path.dirname(name);
    if (parent === name) break;
    name = parent;
  }
  const snapshots: DirectorySnapshot = [];
  for (const directory of directories) {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LiveError('MIGRATION_PATH_UNSAFE');
    snapshots.push({ name: directory, stat });
  }
  return snapshots;
}
function sameFile(a: Stats | BigIntStats, b: Stats | BigIntStats): boolean { return a.ino === b.ino && a.dev === b.dev; }
async function verifyDirectories(before: DirectorySnapshot, code = 'MIGRATION_FILE_CHANGED'): Promise<void> {
  for (const { name, stat } of before) {
    let current: BigIntStats;
    try { current = await fs.lstat(name, { bigint: true }); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new LiveError(code); throw error; }
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(stat, current)) throw new LiveError(code);
  }
}

/** Read at most the advertised, bounded size, even if a file grows while open. */
export async function readMigrationArchive(filename: string): Promise<Buffer> {
  const local = localFilename(filename);
  let handle: fs.FileHandle | undefined;
  try {
    const directories = await checkDirectories(local), before = await fs.lstat(local);
    if (!before.isFile() || before.isSymbolicLink()) throw new LiveError('MIGRATION_PATH_UNSAFE');
    if (before.size > MAX_ARCHIVE) throw new LiveError('MIGRATION_ARCHIVE_TOO_LARGE');
    handle = await fs.open(local, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new LiveError('MIGRATION_FILE_CHANGED');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    const after = await handle.stat(), current = await fs.lstat(local);
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        !current.isFile() || current.isSymbolicLink() || !sameFile(opened, current)) throw new LiveError('MIGRATION_FILE_CHANGED');
    await verifyDirectories(directories);
    const archive = bytes.subarray(0, count);
    parseArchive(archive);
    return archive;
  } catch (error) { throw error instanceof LiveError ? error : new LiveError('MIGRATION_FILE_READ_FAILED'); }
  finally { await handle?.close().catch(() => undefined); }
}

/** Exclusive creation and descriptor readback also protect replacement staging. */
async function createMigrationArchive(filename: string, data: Uint8Array): Promise<BigIntStats> {
  const local = localFilename(filename);
  // Own the bytes across awaits, so a caller cannot swap in plaintext after validation.
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_ARCHIVE) throw new LiveError('MIGRATION_ARCHIVE_TOO_LARGE');
  const bytes = Buffer.from(data);
  parseArchive(bytes);
  let handle: fs.FileHandle | undefined, created: BigIntStats | undefined;
  let complete = false;
  try {
    const directories = await checkDirectories(local);
    try {
      const existing = await fs.lstat(local);
      throw new LiveError(existing.isSymbolicLink() || !existing.isFile() ? 'MIGRATION_PATH_UNSAFE' : 'MIGRATION_FILE_EXISTS');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Request a private creation default where supported, without imposing a
    // mode or filesystem policy on this password-encrypted portable artifact.
    handle = await fs.open(local, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    created = await handle.stat({ bigint: true });
    if (!created.isFile()) throw new LiveError('MIGRATION_PATH_UNSAFE');
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true }), current = await fs.lstat(local, { bigint: true });
    if (!written.isFile() || !sameFile(created, written) || !sameFile(created, current) || !current.isFile() || current.isSymbolicLink() ||
        written.size !== BigInt(bytes.length) || current.size !== BigInt(bytes.length)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    // Verify the exact ciphertext through the owned descriptor, never by
    // opening a path that another process may have replaced. Bound the read
    // even if the file grows, and detect same-length content corruption.
    const readback = Buffer.alloc(bytes.length + 1);
    let count = 0;
    while (count < readback.length) {
      const result = await handle.read(readback, count, readback.length - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (count !== bytes.length || !readback.subarray(0, count).equals(bytes)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    await verifyDirectories(directories, 'MIGRATION_EXPORT_FILE_CHANGED');
    // Content and directory checks await filesystem work.
    // Recheck the owned file afterwards; never accept a replacement during them.
    const completed = await handle.stat({ bigint: true }), final = await fs.lstat(local, { bigint: true });
    if (!completed.isFile() || !sameFile(created, completed) || !final.isFile() || final.isSymbolicLink() || !sameFile(created, final) ||
        completed.size !== BigInt(bytes.length) || final.size !== BigInt(bytes.length) || !exportRevision(written, completed) || !exportRevision(completed, final)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    await handle.close(); handle = undefined;
    complete = true;
    return completed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LiveError('MIGRATION_FILE_EXISTS');
    throw error instanceof LiveError ? error : new LiveError('MIGRATION_FILE_WRITE_FAILED');
  } finally {
    await handle?.close().catch(() => undefined);
    if (!complete && created) {
      // Do not unlink a replacement file installed by another process.
      try { const current = await fs.lstat(local, { bigint: true }); if (current.isFile() && sameFile(created, current)) await fs.unlink(local); } catch { /* Only encrypted partial output could remain. */ }
    }
  }
}

interface ExportFileSnapshot { stat: BigIntStats; digest: string }
interface ExportSnapshot { filename: string; directories: DirectorySnapshot; file: ExportFileSnapshot | undefined }
/** An opaque, single-use snapshot. Selection and confirmation never write files. */
export interface MigrationExportTarget { readonly filename: string; readonly exists: boolean }
const exportSnapshots = new WeakMap<MigrationExportTarget, ExportSnapshot>();
const exportRevision = (a: BigIntStats, b: BigIntStats): boolean => sameFile(a, b) &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;

async function exportFileSnapshot(filename: string): Promise<ExportFileSnapshot | undefined> {
  let before: BigIntStats;
  try { before = await fs.lstat(filename, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new LiveError('MIGRATION_PATH_UNSAFE');
  if (before.size > BigInt(MAX_ARCHIVE)) throw new LiveError('MIGRATION_ARCHIVE_TOO_LARGE');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !exportRevision(before, opened)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    while (count <= Number(opened.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(opened.size) + 1 - count), count);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead)); count += bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(filename, { bigint: true });
    if (count !== Number(opened.size) || !exportRevision(opened, after) || !current.isFile() || current.isSymbolicLink() || !exportRevision(opened, current)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    return { stat: after, digest: digest.digest('hex') };
  } finally { await handle.close(); }
}

export async function prepareMigrationExport(filename: string): Promise<MigrationExportTarget> {
  const local = localFilename(filename);
  try {
    const directories = await checkDirectories(local), file = await exportFileSnapshot(local);
    await verifyDirectories(directories, 'MIGRATION_EXPORT_FILE_CHANGED');
    const target = Object.freeze({ filename: local, exists: file !== undefined });
    exportSnapshots.set(target, { filename: local, directories, file });
    return target;
  } catch (error) {
    if (error instanceof LiveError) throw error;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    throw new LiveError('MIGRATION_FILE_WRITE_FAILED');
  }
}

async function removeExportFile(filename: string, owned: BigIntStats | undefined): Promise<void> {
  if (!owned) return;
  try {
    const current = await fs.lstat(filename, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink() && sameFile(owned, current)) await fs.unlink(filename);
  } catch { /* Keep uncertain ciphertext/claims; never delete another owner's file. */ }
}

/** No approval means exclusive creation. Replacement requires the confirmed snapshot.
 * All bytes are staged, synced and verified before one same-directory rename.
 * Never unlink/truncate the old target, or fall back when atomic rename is denied.
 */
export async function writeMigrationArchive(filename: string, data: Uint8Array, target?: MigrationExportTarget): Promise<void> {
  const local = localFilename(filename);
  if (!target) { await createMigrationArchive(local, data); return; }
  const snapshot = exportSnapshots.get(target);
  exportSnapshots.delete(target);
  if (!snapshot || snapshot.filename !== local) throw new LiveError('MIGRATION_EXPORT_CONFIRM_REQUIRED');
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_ARCHIVE) throw new LiveError('MIGRATION_ARCHIVE_TOO_LARGE');
  const bytes = Buffer.from(data); parseArchive(bytes);
  let lock: fs.FileHandle | undefined, lockStat: BigIntStats | undefined, staged: BigIntStats | undefined;
  const key = createHash('sha256').update(path.basename(local).toLowerCase()).digest('hex');
  const claim = path.join(path.dirname(local), `.agwenc-export-${key}.lock`);
  const temporary = path.join(path.dirname(local), `.agwenc-export-${key}-${randomBytes(16).toString('hex')}.tmp`);
  try {
    await verifyDirectories(snapshot.directories, 'MIGRATION_EXPORT_FILE_CHANGED');
    try { lock = await fs.open(claim, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LiveError('MIGRATION_EXPORT_BUSY'); throw error; }
    lockStat = await lock.stat({ bigint: true });
    const assertTarget = async (): Promise<void> => {
      await verifyDirectories(snapshot.directories, 'MIGRATION_EXPORT_FILE_CHANGED');
      const current = await exportFileSnapshot(local);
      if (snapshot.file ? !current || !exportRevision(snapshot.file.stat, current.stat) || snapshot.file.digest !== current.digest : current !== undefined) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
      const held = await lock!.stat({ bigint: true }), named = await fs.lstat(claim, { bigint: true });
      if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(lockStat!, held) || !sameFile(lockStat!, named)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    };
    await assertTarget();
    if (!snapshot.file) {
      // O_EXCL also guards against noncooperating creation after the last check.
      await createMigrationArchive(local, bytes); return;
    }
    try { staged = await createMigrationArchive(temporary, bytes); }
    catch (error) { if (error instanceof LiveError && error.code === 'MIGRATION_FILE_EXISTS') throw new LiveError('MIGRATION_EXPORT_BUSY'); throw error; }
    const stage = await exportFileSnapshot(temporary);
    if (!stage || !exportRevision(staged, stage.stat) || stage.digest !== createHash('sha256').update(bytes).digest('hex')) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    await assertTarget();
    const currentStage = await fs.lstat(temporary, { bigint: true });
    if (!currentStage.isFile() || currentStage.isSymbolicLink() || !exportRevision(staged, currentStage)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    await verifyDirectories(snapshot.directories, 'MIGRATION_EXPORT_FILE_CHANGED');
    const currentTarget = await fs.lstat(local, { bigint: true });
    if (!currentTarget.isFile() || currentTarget.isSymbolicLink() || !exportRevision(snapshot.file.stat, currentTarget)) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    await fs.rename(temporary, local);
    // Rename is the commit point. No fallible validation follows a successful commit.
    staged = undefined;
  } catch (error) {
    if (error instanceof LiveError) throw error;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new LiveError('MIGRATION_EXPORT_FILE_CHANGED');
    throw new LiveError('MIGRATION_FILE_WRITE_FAILED');
  }
  finally {
    await lock?.close().catch(() => undefined);
    await removeExportFile(temporary, staged);
    await removeExportFile(claim, lockStat);
  }
}
