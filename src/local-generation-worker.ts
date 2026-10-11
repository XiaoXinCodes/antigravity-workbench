import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { replayGenerationWal } from './local-generation-wal';
type Row = unknown[];
const loadModule = createRequire(__filename);
interface Connection { each(sql: string): Iterable<Row>; close(): void }
interface WasmStatement { step(): boolean; get(): Row; free(): void }
interface WasmDatabase { run(sql: string): void; prepare(sql: string): WasmStatement; close(): void }
async function connect(snapshot: string, engine: 'auto' | 'wasm'): Promise<Connection> {
  if (engine !== 'wasm') {
    let SQLite: typeof import('node:sqlite') | undefined;
    try { SQLite = loadModule('node:sqlite') as typeof import('node:sqlite'); } catch { /* Older extension hosts use packaged WASM. */ }
    if (SQLite?.DatabaseSync) {
      const db = new SQLite.DatabaseSync(snapshot, { readOnly: true });
      return { each: function* (sql) { for (const row of db.prepare(sql).iterate()) yield Object.values(row); }, close: () => db.close() };
    }
  }
  const vendor = path.join(__dirname, '..', 'vendor', 'sql.js');
  const init = loadModule(path.join(vendor, 'sql-wasm.js')) as (options: { wasmBinary: Buffer }) => Promise<{ Database: new (bytes: Buffer) => WasmDatabase }>;
  const SQL = await init({ wasmBinary: readFileSync(path.join(vendor, 'sql-wasm.wasm')) });
  let wal: Buffer | undefined;
  try { wal = readFileSync(snapshot + '-wal'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = new SQL.Database(replayGenerationWal(readFileSync(snapshot), wal));
  return { each: function* (sql) { const statement = db.prepare(sql); try { while (statement.step()) yield statement.get(); } finally { statement.free(); } }, close: () => db.close() };
}
async function run() {
  const { snapshot, engine } = workerData as { snapshot: string; engine: 'auto' | 'wasm' };
  const db = await connect(snapshot, engine);
  try {
    for (const sql of ['PRAGMA query_only=ON', 'PRAGMA trusted_schema=OFF', 'PRAGMA temp_store=MEMORY']) Array.from(db.each(sql));
    const schema = [...db.each("SELECT type,sql FROM sqlite_master WHERE name='gen_metadata'")];
    if (schema.length !== 1 || schema[0]![0] !== 'table' || typeof schema[0]![1] !== 'string' || !/^CREATE\s+TABLE\b/i.test(schema[0]![1])) throw Error();
    const columns = [...db.each('PRAGMA table_info(gen_metadata)')].map(row => row[1]);
    if (!columns.includes('idx') || !columns.includes('data')) throw Error();
    const rows: [number, string][] = []; let total = 0, limited = false;
    for (const [idx, data, size] of db.each('SELECT idx, CASE WHEN length(data)<=1048576 THEN data ELSE NULL END, length(data) FROM gen_metadata ORDER BY idx LIMIT 1001')) {
      if (rows.length >= 1000 || total + (typeof size === 'number' ? size : 0) > 2097152) { limited = true; break; }
      if (typeof idx !== 'number' || !Number.isSafeInteger(idx) || idx < 0 || !(data instanceof Uint8Array)) throw Error();
      total += data.length; rows.push([idx, Buffer.from(data).toString('base64')]);
    }
    parentPort!.postMessage({ rows, limited });
  } finally { db.close(); }
}
if (parentPort) void run().catch(() => parentPort!.postMessage({ error: 'LOCAL_DB_UNSUPPORTED' }));
