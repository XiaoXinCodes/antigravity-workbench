/** Offline replay of an immutable private copy, never a live source connection.
 * SQLite WAL format/checksum/reader algorithm: https://sqlite.org/fileformat2.html
 * Invalid frame tails (including old generations) end recovery; only complete
 * committed transactions are applied. An invalid WAL header fails closed.
 */
const LIMIT = 32 * 1024 * 1024;
const unsupported = () => Error('LOCAL_DB_UNSUPPORTED');
function pageSize(db: Buffer): number {
  if (db.length < 100 || db.toString('hex', 0, 16) !== '53514c69746520666f726d6174203300') throw unsupported();
  const raw = db.readUInt16BE(16), size = raw === 1 ? 65536 : raw;
  if (size < 512 || size > 65536 || (size & (size - 1)) || db.length > LIMIT || db.length % size || ![1, 2].includes(db[18]!) || ![1, 2].includes(db[19]!)) throw unsupported();
  return size;
}
export function replayGenerationWal(db: Buffer, wal?: Buffer): Buffer {
  const size = pageSize(db);
  const physicalPages = db.length / size, declaredPages = db.readUInt32BE(28);
  // SQLite trusts header size only when the version-valid number matches the
  // change counter; trailing physical pages must not silently repair that size.
  let last = 32, pages = declaredPages && db.readUInt32BE(24) === db.readUInt32BE(92) ? declaredPages : physicalPages;
  if (wal?.length) {
    if (wal.length < 32 || wal.length > LIMIT) throw unsupported();
    const magic = wal.readUInt32BE(0);
    if (![0x377f0682, 0x377f0683].includes(magic) || wal.readUInt32BE(4) !== 3007000 || wal.readUInt32BE(8) !== size || db[18] !== 2 || db[19] !== 2) throw unsupported();
    let a = 0, b = 0;
    const checksum = (start: number, end: number) => {
      for (let i = start; i < end; i += 8) {
        a = (a + (magic === 0x377f0682 ? wal.readUInt32LE(i) : wal.readUInt32BE(i)) + b) >>> 0;
        b = (b + (magic === 0x377f0682 ? wal.readUInt32LE(i + 4) : wal.readUInt32BE(i + 4)) + a) >>> 0;
      }
    };
    checksum(0, 24);
    if (a !== wal.readUInt32BE(24) || b !== wal.readUInt32BE(28)) throw unsupported();
    for (let i = 32; i + 24 + size <= wal.length; i += 24 + size) {
      if (wal.readUInt32BE(i + 8) !== wal.readUInt32BE(16) || wal.readUInt32BE(i + 12) !== wal.readUInt32BE(20)) break;
      checksum(i, i + 8); checksum(i + 24, i + 24 + size);
      if (a !== wal.readUInt32BE(i + 16) || b !== wal.readUInt32BE(i + 20)) break;
      const page = wal.readUInt32BE(i), committed = wal.readUInt32BE(i + 4);
      if (!page || page * size > LIMIT || committed * size > LIMIT) throw unsupported();
      if (committed) { last = i + 24 + size; pages = committed; }
    }
  }
  if (pages * size > LIMIT || last === 32 && pages > physicalPages) throw unsupported();
  const out = Buffer.alloc(pages * size);
  db.copy(out, 0, 0, Math.min(db.length, out.length));
  if (wal) for (let i = 32; i < last; i += 24 + size) {
    const page = wal.readUInt32BE(i);
    if (page <= pages) wal.copy(out, (page - 1) * size, i + 24, i + 24 + size);
  }
  // sql.js is an in-memory rollback-mode database. The committed replay is now
  // self-contained; these bytes are changed only in the worker's private buffer.
  pageSize(out); out[18] = out[19] = 1;
  if (last > 32) { out.writeUInt32BE(pages, 28); out.writeUInt32BE(out.readUInt32BE(24), 92); }
  return out;
}
