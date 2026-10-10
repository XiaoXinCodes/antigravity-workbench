// Synthetic concurrent logger. Only fixed error/operation names leave this child.
const fs = require('node:fs/promises');
for (const operation of ['open', 'lstat', 'unlink', 'mkdir', 'opendir']) {
  const original = fs[operation];
  fs[operation] = async function (...args) {
    const caller = new Error().stack.match(/DebugLogStore\.(\w+)/)?.[1];
    try { return await original.apply(this, args); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) process.send?.({ operation, rawCode: error.code, method: caller });
      throw error;
    }
  };
}
const { DebugLogStore, sanitizeDebugStorageError } = require('../../out/debug-log-store');
const store = new DebugLogStore(process.env.TEST_STORE, { maxFileBytes: 128 });
let phase = 'start';
(async () => {
  for (let index = 0; index < 25; index++) {
    phase = 'append';
    await store.append(JSON.stringify({ schema: 1, event: 'test', pid: process.pid, index }), () => true);
    phase = 'read'; await store.readLines();
  }
  await store.flush();
})().catch(error => { process.send?.({ code: sanitizeDebugStorageError(error).code, phase }); process.exitCode = 1; });
