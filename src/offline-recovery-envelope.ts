import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { LiveError } from './live-storage';
import { validateOfflineJournal, type OfflineJournal } from './offline-switch';

// Same bounded KDF strength as the account migration archive; separate format
// and AAD prevent an account archive from being treated as an offline journal.
const FORMAT = 'antigravity-offline-recovery';
const MAX = 2 * 1024 * 1024;
const MAX_ENVELOPE = 3 * 1024 * 1024;
interface Header { format: typeof FORMAT; version: 1; salt: string; nonce: string }
interface Envelope extends Header { ciphertext: string; tag: string }
const invalid = (): LiveError => new LiveError('OFFLINE_RECOVERY_ENVELOPE_INVALID');
function secretBytes(password: string, creating: boolean): Buffer {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024 ||
      creating && Array.from(password).length < 12) throw new LiveError('OFFLINE_RECOVERY_PASSWORD_INVALID');
  return Buffer.from(password);
}
function derive(secret: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(new LiveError('OFFLINE_RECOVERY_CRYPTO_UNAVAILABLE')); else resolve(key);
    });
  });
}
function b64(value: unknown, minimum: number, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maximum / 3)) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}
function parse(bytes: Uint8Array): { header: Header; salt: Buffer; nonce: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_ENVELOPE) throw invalid();
  let value: Envelope;
  try {
    const raw = Buffer.from(bytes).toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) throw 0;
    value = JSON.parse(raw) as Envelope;
    if (!value || Array.isArray(value) || JSON.stringify(value) !== raw ||
      Object.keys(value).sort().join(',') !== 'ciphertext,format,nonce,salt,tag,version' ||
      value.format !== FORMAT || value.version !== 1) throw 0;
  } catch { throw invalid(); }
  const salt = b64(value.salt, 32, 32), nonce = b64(value.nonce, 12, 12);
  return { header: { format: FORMAT, version: 1, salt: value.salt, nonce: value.nonce }, salt, nonce,
    tag: b64(value.tag, 16, 16), ciphertext: b64(value.ciphertext, 1, MAX) };
}
export async function encryptOfflineRecovery(record: OfflineJournal, password: string): Promise<Buffer> {
  const copy = structuredClone(record);
  validateOfflineJournal(copy, copy.hostId);
  const secret = secretBytes(password, true);
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    plaintext = Buffer.from(JSON.stringify(copy));
    if (plaintext.length > MAX) throw invalid();
    const salt = randomBytes(32), nonce = randomBytes(12);
    const header: Header = { format: FORMAT, version: 1, salt: salt.toString('base64'), nonce: nonce.toString('base64') };
    key = await derive(secret, salt);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ ...header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
  } finally { secret.fill(0); key?.fill(0); plaintext?.fill(0); }
}
export async function decryptOfflineRecovery(bytes: Uint8Array, password: string, expectedHostId: string, expectedTransactionId: string): Promise<OfflineJournal> {
  const parsed = parse(bytes), secret = secretBytes(password, false);
  let key: Buffer | undefined, pending: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    try {
      key = await derive(secret, parsed.salt);
      const decipher = createDecipheriv('aes-256-gcm', key, parsed.nonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(JSON.stringify(parsed.header))); decipher.setAuthTag(parsed.tag);
      pending = decipher.update(parsed.ciphertext);
      plaintext = Buffer.concat([pending, decipher.final()]);
    } catch { throw new LiveError('OFFLINE_RECOVERY_DECRYPT_FAILED'); }
    let record: OfflineJournal;
    try {
      const raw = plaintext.toString('utf8');
      if (!Buffer.from(raw).equals(plaintext)) throw 0;
      record = JSON.parse(raw) as OfflineJournal;
      if (JSON.stringify(record) !== raw || record.id !== expectedTransactionId) throw 0;
      validateOfflineJournal(record, expectedHostId);
    } catch { throw new LiveError('OFFLINE_RECOVERY_INVALID'); }
    return record;
  } finally { secret.fill(0); key?.fill(0); pending?.fill(0); plaintext?.fill(0); }
}
