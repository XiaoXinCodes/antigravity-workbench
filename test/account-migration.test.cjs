const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  encryptAccountArchive, decryptAccountArchive, validateMigrationAccounts,
  portableToken, readMigrationArchive, writeMigrationArchive,
} = require('../out/account-migration');
const { LiveError } = require('../out/live-storage');

const PASSWORD = 'synthetic archive password only';
const DATE = '2026-10-01T00:00:00.000Z';
function token(name, email, subject = name) {
  return JSON.stringify({ token: { access_token: 'synthetic-access-' + name, refresh_token: 'synthetic-refresh-' + name, token_type: 'Bearer' },
    auth_method: 'oauth', ...(email ? { id_token: 'fixture.' + Buffer.from(JSON.stringify({ email, sub: subject })).toString('base64url') + '.unsigned' } : {}) });
}
function account(name = 'a') { return { label: 'Synthetic private label ' + name, expectedEmail: name + '@example.test', capturedAt: DATE, token: token(name) }; }
const accounts = [account('a'), account('b')];
let example;
function archive() { return example ??= encryptAccountArchive(accounts, PASSWORD); }
async function altered(change) { const envelope = JSON.parse((await archive()).toString()); change(envelope); return Buffer.from(JSON.stringify(envelope)); }
function failure(code) { return error => error instanceof LiveError && error.code === code && error.message === code; }
async function privateDirectory() { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agm-migration-')); }

// An independent fixture writer authenticates intentionally invalid plaintext, to
// ensure importer validation is tested beyond failures of GCM authentication.
function sealPayload(payload, raw = false) {
  const salt = crypto.randomBytes(32), nonce = crypto.randomBytes(12);
  const header = { format: 'antigravity-account-migration', schema: 1, cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64') }, nonce: nonce.toString('base64') };
  const key = crypto.scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(raw ? payload : JSON.stringify(payload)), cipher.final()]);
  key.fill(0);
  return Buffer.from(JSON.stringify({ ...header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
}

test('encrypted multi-account archive roundtrips portable token strings without plaintext account metadata', async () => {
  const bytes = await archive(), payload = await decryptAccountArchive(bytes, PASSWORD);
  assert.equal(payload.schema, 1);
  assert.ok(Number.isFinite(Date.parse(payload.createdAt)));
  assert.deepEqual(payload.accounts, accounts);
  const text = bytes.toString('utf8');
  for (const value of [...accounts.flatMap(a => [a.label, a.expectedEmail, a.token, a.capturedAt]), 'synthetic-refresh', 'synthetic-access', 'hostId', 'journal', 'keyring']) assert.ok(!text.includes(value));
  const envelope = JSON.parse(text);
  assert.deepEqual(Object.keys(envelope), ['format', 'schema', 'cipher', 'kdf', 'nonce', 'ciphertext', 'tag']);
  assert.equal(envelope.kdf.N, 32768); assert.equal(envelope.kdf.r, 8); assert.equal(envelope.kdf.p, 1);
});

test('every export uses independent cryptographic salt, nonce and ciphertext', async () => {
  const first = JSON.parse((await archive()).toString()), second = JSON.parse((await encryptAccountArchive(accounts, PASSWORD)).toString());
  for (const key of ['nonce', 'ciphertext', 'tag']) assert.notEqual(first[key], second[key]);
  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.deepEqual((await decryptAccountArchive(Buffer.from(JSON.stringify(second)), PASSWORD)).accounts, accounts);
});

test('export password validation counts characters and bounds encoded bytes', async () => {
  for (const password of ['', 'short', '12345678901', '😀😀😀', 'x'.repeat(1025), '字'.repeat(342), null]) {
    await assert.rejects(encryptAccountArchive(accounts, password), failure('MIGRATION_PASSWORD_INVALID'));
  }
  const password = '字'.repeat(12);
  assert.deepEqual((await decryptAccountArchive(await encryptAccountArchive(accounts, password), password)).accounts, accounts);
});

test('wrong passwords and authenticated-data, ciphertext, tag mutations have one safe decryption error', async () => {
  for (const password of ['wrong', 'another long synthetic password']) await assert.rejects(decryptAccountArchive(await archive(), password), failure('MIGRATION_DECRYPT_FAILED'));
  for (const field of ['nonce', 'ciphertext', 'tag', 'salt']) {
    const bytes = await altered(envelope => {
      const holder = field === 'salt' ? envelope.kdf : envelope;
      const original = Buffer.from(holder[field], 'base64'); original[0] ^= 1; holder[field] = original.toString('base64');
    });
    await assert.rejects(decryptAccountArchive(bytes, PASSWORD), failure('MIGRATION_DECRYPT_FAILED'));
  }
});

test('envelope parser rejects schema, unknown fields, invalid UTF-8, algorithms and unbounded KDF parameters', async () => {
  for (const bytes of [Buffer.from(''), Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.from([0xff])]) {
    await assert.rejects(decryptAccountArchive(bytes, PASSWORD), failure('MIGRATION_ARCHIVE_INVALID'));
  }
  const mutations = [e => { e.schema = 2; }, e => { e.schema = '1'; }, e => { e.format = 'other'; }, e => { e.cipher = 'aes-128-cbc'; },
    e => { e.kdf.name = 'pbkdf2'; }, e => { e.kdf.N = 1073741824; }, e => { e.kdf.N = 16384; }, e => { e.kdf.r = 999999999; },
    e => { e.kdf.p = 999999999; }, e => { e.kdf.maxmem = 999999999; }, e => { e.kdf = null; },
    e => { e.label = 'must not be plaintext'; }, e => { e.hostId = 'local'; }, e => { e.path = '/home/example'; }, e => { delete e.nonce; }];
  for (const change of mutations) await assert.rejects(decryptAccountArchive(await altered(change), PASSWORD), failure('MIGRATION_ARCHIVE_INVALID'));
});

test('base64 is canonical, bounded and exact-sized before key derivation', async () => {
  for (const change of [e => { e.nonce = '!'.repeat(16); }, e => { e.nonce += '\n'; }, e => { e.nonce = Buffer.alloc(13).toString('base64'); },
    e => { e.kdf.salt = Buffer.alloc(16).toString('base64'); }, e => { e.kdf.salt = e.kdf.salt.slice(0, -1); },
    e => { e.tag = Buffer.alloc(15).toString('base64'); }, e => { e.tag = 'AB' + '='.repeat(22); }, e => { e.ciphertext = ''; },
    e => { e.ciphertext = 'AA=A'; }, e => { e.ciphertext = 'AB=='; }, e => { e.ciphertext = Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'); }]) {
    await assert.rejects(decryptAccountArchive(await altered(change), PASSWORD), failure('MIGRATION_ARCHIVE_INVALID'));
  }
  await assert.rejects(decryptAccountArchive(Buffer.alloc(24 * 1024 * 1024 + 1), PASSWORD), failure('MIGRATION_ARCHIVE_TOO_LARGE'));
});

test('schema 1 canonical JSON rejects duplicate and escaped keys instead of retaining ignored plaintext', async () => {
  const text = (await archive()).toString('utf8');
  for (const raw of [text.replace('"schema":1', '"schema":0,"schema":1'),
    text.replace('"schema":1', '"\\u0073chema":0,"schema":1'), text.replace('"schema":1', '"\\u0073chema":1'),
    text.replace('"ciphertext":', '"ciphertext":"synthetic plaintext that must never be written","ciphertext":'),
    JSON.stringify(JSON.parse(text), null, 2)]) {
    await assert.rejects(decryptAccountArchive(Buffer.from(raw), PASSWORD), failure('MIGRATION_ARCHIVE_INVALID'));
  }
  assert.deepEqual((await decryptAccountArchive(Buffer.from('\n ' + text + '\r\n'), PASSWORD)).accounts, accounts);
  const raw = JSON.stringify({ schema: 1, createdAt: DATE, accounts }).replace('"schema":1', '"schema":0,"schema":1');
  await assert.rejects(decryptAccountArchive(sealPayload(raw, true), PASSWORD), failure('MIGRATION_PAYLOAD_INVALID'));
});

test('accounts are whitelisted, bounded, normalized and validated independently of encryption', () => {
  assert.equal(validateMigrationAccounts([{ ...account(), expectedEmail: 'A@EXAMPLE.TEST' }])[0].expectedEmail, 'a@example.test');
  for (const value of [null, {}, [], Array(51).fill(account())]) assert.throws(() => validateMigrationAccounts(value), failure('MIGRATION_ACCOUNTS_INVALID'));
  assert.throws(() => validateMigrationAccounts(Array(1)), failure('MIGRATION_ACCOUNT_INVALID'));
  for (const value of [{ ...account(), label: '' }, { ...account(), label: 'x'.repeat(257) }, { ...account(), label: 'unsafe\nlabel' },
    { ...account(), expectedEmail: 'invalid' }, { ...account(), capturedAt: 'yesterday' }, { ...account(), capturedAt: '2026-02-31T00:00:00.000Z' },
    { ...account(), token: null }, { ...account(), token: 'x'.repeat(256 * 1024 + 1) },
    ...['hostId', 'slots', 'path', 'journal', 'id', 'identitySource', 'backup'].map(key => ({ ...account(), [key]: 'forbidden' }))]) {
    assert.throws(() => validateMigrationAccounts([value]), failure('MIGRATION_ACCOUNT_INVALID'));
  }
  for (const value of ['{}', 'not json', JSON.stringify({ token: { refresh_token: 'synthetic' }, wif_provider: 'enterprise' }),
    token('a', 'other@example.test')]) assert.throws(() => validateMigrationAccounts([{ ...account(), token: value }]), failure('MIGRATION_TOKEN_INVALID'));
  assert.throws(() => validateMigrationAccounts([account(), { ...account('b'), expectedEmail: 'A@EXAMPLE.TEST' }]), failure('MIGRATION_DUPLICATE_ACCOUNT'));
  assert.throws(() => validateMigrationAccounts([account(), { ...account('b'), token: account().token }]), failure('MIGRATION_DUPLICATE_ACCOUNT'));
  assert.equal(validateMigrationAccounts(Array.from({ length: 50 }, (_, i) => account(String(i)))).length, 50);
});

test('authenticated payloads still reject extra host, path, recovery fields and invalid schema', async () => {
  const valid = { schema: 1, createdAt: DATE, accounts };
  const variants = [null, { ...valid, schema: 2 }, { ...valid, createdAt: 'invalid' },
    ...['hostId', 'path', 'journal', 'backup', 'sourcePlatform'].map(key => ({ ...valid, [key]: 'must not import' })),
    ...['hostId', 'path', 'journal', 'slots'].map(key => ({ ...valid, accounts: [{ ...account(), [key]: 'must not import' }] })),
    { ...valid, accounts: [] }, { ...valid, accounts: [{ ...account(), token: '{}' }] }];
  for (const payload of variants) await assert.rejects(decryptAccountArchive(sealPayload(payload), PASSWORD), failure('MIGRATION_PAYLOAD_INVALID'));
});

test('metadata boundaries match saved-login labels and reject control or bidi spoofing', () => {
  for (const label of ['a'.repeat(80), '字'.repeat(80)]) assert.equal(validateMigrationAccounts([{ ...account(), label }])[0].label, label);
  for (const label of ['a'.repeat(81), '字'.repeat(81), '\u0085label', '\u202elabel', '\u2066label', 'label\u2028line', ' label ']) {
    assert.throws(() => validateMigrationAccounts([{ ...account(), label }]), failure('MIGRATION_ACCOUNT_INVALID'));
  }
  const suffix = '@example.test';
  for (const expectedEmail of ['a'.repeat(260 - suffix.length) + suffix, '字'.repeat(102) + 'a' + suffix]) {
    assert.equal(validateMigrationAccounts([{ ...account(), expectedEmail }])[0].expectedEmail, expectedEmail);
  }
  for (const expectedEmail of ['a'.repeat(261 - suffix.length) + suffix, '字'.repeat(103) + suffix, 'a\u202e' + suffix,
    'a\u0085' + suffix, 'a\u2066' + suffix, '<a>' + suffix, 'a@<example.test>']) {
    assert.throws(() => validateMigrationAccounts([{ ...account(), expectedEmail }]), failure('MIGRATION_ACCOUNT_INVALID'));
  }
});

test('portableToken prioritizes a coherent keyring, falls back to file and rejects ambiguity conservatively', () => {
  const keyring = token('a', 'a@example.test'), file = JSON.stringify({ ...JSON.parse(keyring), harmless_format_difference: true });
  assert.equal(portableToken({ keyring, file }, 'a@example.test'), keyring);
  assert.equal(portableToken({ keyring: null, file }, 'a@example.test'), file);
  assert.equal(portableToken({ keyring, file: null }, 'A@EXAMPLE.TEST'), keyring);
  assert.throws(() => portableToken({ keyring: null, file: null }, 'a@example.test'), failure('MIGRATION_TOKEN_INVALID'));
  assert.throws(() => portableToken({ keyring, file: token('b', 'b@example.test') }, 'a@example.test'), failure('MIGRATION_TOKEN_INVALID'));
  // A shared unsigned subject hint cannot make different refresh tokens trustworthy.
  assert.throws(() => portableToken({ keyring, file: token('rotated', 'a@example.test', 'a') }, 'a@example.test'), failure('MIGRATION_TOKEN_CONFLICT'));
  assert.throws(() => portableToken({ keyring: token('a'), file: token('b') }, 'a@example.test'), failure('MIGRATION_TOKEN_INVALID'));
  assert.throws(() => portableToken({ keyring, file: null, path: '/unexpected' }, 'a@example.test'), failure('MIGRATION_TOKEN_INVALID'));
});

test('file helpers write encrypted mode-0600 output, read it back and never overwrite', async () => {
  const directory = await privateDirectory(), filename = path.join(directory, 'accounts.agm');
  try {
    const bytes = await archive(); await writeMigrationArchive(filename, bytes);
    assert.deepEqual(await readMigrationArchive(filename), bytes);
    if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    await assert.rejects(writeMigrationArchive(filename, bytes), failure('MIGRATION_FILE_EXISTS'));
    assert.deepEqual(await fs.readFile(filename), bytes);
    assert.deepEqual((await decryptAccountArchive(await readMigrationArchive(filename), PASSWORD)).accounts, accounts);
    await assert.rejects(writeMigrationArchive(path.join(directory, 'plaintext'), Buffer.from(JSON.stringify(accounts))), failure('MIGRATION_ARCHIVE_INVALID'));
    await assert.rejects(fs.stat(path.join(directory, 'plaintext')), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('concurrent exports to one path are exclusive and preserve one complete encrypted archive', async () => {
  const directory = await privateDirectory(), filename = path.join(directory, 'exclusive.agm');
  try {
    const bytes = await archive(), results = await Promise.allSettled([writeMigrationArchive(filename, bytes), writeMigrationArchive(filename, bytes)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.some(r => r.status === 'rejected' && r.reason.code === 'MIGRATION_FILE_EXISTS'));
    assert.deepEqual(await readMigrationArchive(filename), bytes);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('file helper owns a copy of the validated bytes before asynchronous filesystem work', async () => {
  const directory = await privateDirectory(), filename = path.join(directory, 'immutable.agm');
  try {
    const original = await archive(), mutable = Buffer.from(original), result = writeMigrationArchive(filename, mutable);
    mutable.fill(0x78); await result;
    assert.deepEqual(await readMigrationArchive(filename), original);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// Real encrypted files with synthetic filesystem metadata. No user archives,
// credential stores, mount settings or production permission checks are changed.
async function exportFilesystemFixture(t, options = {}) {
  const directory = await privateDirectory(), filename = path.join(directory, 'portable.agwenc');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = await archive(), realOpen = fs.open.bind(fs), realReadFile = fs.readFile.bind(fs), realLstat = fs.lstat.bind(fs), realChmod = fs.chmod.bind(fs);
  // Export must not inspect mount policy or modify inherited permissions.
  t.mock.method(fs, 'readFile', async (name, ...args) => {
    assert.notEqual(name, '/proc/self/mountinfo');
    return realReadFile(name, ...args);
  });
  t.mock.method(fs, 'chmod', async () => { throw Error('export must not change permissions'); });
  let descriptorStats = 0, directoryStats = 0;
  t.mock.method(fs, 'lstat', async (name, ...args) => {
    if (name === directory && ++directoryStats === 2 && options.beforeDirectoryCheck) await options.beforeDirectoryCheck(filename);
    const stat = await realLstat(name, ...args);
    // Windows inode values may exceed Number's integer precision; +1 can be unchanged.
    if (name === directory && options.directoryChange && directoryStats === 2) stat.ino = stat.ino === 0 ? 1 : 0;
    return stat;
  });
  t.mock.method(fs, 'open', async (name, ...args) => {
    if (name === filename && options.accessDenied) throw Object.assign(new Error('synthetic system denied access'), {code:'EACCES'});
    const handle = await realOpen(name, ...args);
    if (name !== filename) return handle;
    const realStat = handle.stat.bind(handle), realWriteFile = handle.writeFile.bind(handle), realSync = handle.sync.bind(handle), realRead = handle.read.bind(handle);
    handle.chmod = async () => { throw Error('export must not change permissions'); };
    handle.stat = async (...args) => {
      const stat = await realStat(...args);
      descriptorStats++;
      const mode = descriptorStats >= 3 ? options.finalMode ?? options.mode : options.mode;
      if (descriptorStats >= 2 && mode !== undefined) stat.mode = typeof stat.mode === 'bigint' ? (stat.mode & ~0o777n) | BigInt(mode) : (stat.mode & ~0o777) | mode;
      return stat;
    };
    handle.writeFile = async data => {
      if (options.partial || options.abortWrite) {
        await handle.write(data.subarray(0, Math.floor(data.length / 2)));
        if (options.abortWrite) throw Object.assign(new Error('synthetic cancelled'), {code:'ABORT_ERR'});
      } else await realWriteFile(data);
    };
    handle.sync = async () => {
      await realSync();
      if (options.actualMode !== undefined) await realChmod(filename, options.actualMode);
      if (options.corrupt) await handle.write(Buffer.from('X'), 0, 1, 0);
      if (options.afterSync) await options.afterSync(filename);
    };
    handle.read = async (...args) => {
      if (options.beforeRead) { const callback = options.beforeRead; options.beforeRead = undefined; await callback(filename); }
      return realRead(...args);
    };
    return handle;
  });
  return {directory, filename, bytes, realReadFile, realLstat};
}

test('Linux encrypted export accepts actual broad permissions without mount probing or permission changes', {skip:process.platform!=='linux'}, async t => {
  for (const mode of [0o644,0o666,0o777]) await t.test(mode.toString(8), async st => {
    const f = await exportFilesystemFixture(st, {actualMode:mode});
    await writeMigrationArchive(f.filename, f.bytes);
    assert.equal((await f.realLstat(f.filename)).mode & 0o777, mode);
    const written = await f.realReadFile(f.filename);
    assert.deepEqual(written, f.bytes);
    assert.deepEqual((await decryptAccountArchive(written,PASSWORD)).accounts,accounts);
    assert.doesNotMatch(written.toString(), /synthetic-refresh-|a@example\.test|Synthetic private label/);
    await assert.rejects(writeMigrationArchive(f.filename,f.bytes),failure('MIGRATION_FILE_EXISTS'));
  });
});

test('encrypted export accepts broad and changing modes for Linux, Windows and macOS platform values', async t => {
  for (const platform of ['linux','win32','darwin']) await t.test(platform, async st => {
    const f = await exportFilesystemFixture(st,{mode:0o666,finalMode:0o777});
    const descriptor = Object.getOwnPropertyDescriptor(process,'platform');
    Object.defineProperty(process,'platform',{...descriptor,value:platform});
    try { await writeMigrationArchive(f.filename,f.bytes); assert.deepEqual(await f.realReadFile(f.filename),f.bytes); }
    finally { Object.defineProperty(process,'platform',descriptor); }
  });
});

test('encrypted export respects operating-system access denial without changing permissions or retrying', async t => {
  const f = await exportFilesystemFixture(t,{accessDenied:true});
  await assert.rejects(writeMigrationArchive(f.filename,f.bytes),failure('MIGRATION_FILE_WRITE_FAILED'));
  assert.equal(fs.open.mock.calls.length,1);
  assert.equal(fs.chmod.mock.calls.length,0);
  assert.deepEqual(await fs.readdir(f.directory),[]);
});

test('encrypted export detects incomplete writes, cancellation and parent directory changes, cleaning owned partial files', async t => {
  for (const [name,options,code] of [['partial',{partial:true},'MIGRATION_EXPORT_FILE_CHANGED'],['same-length corruption',{corrupt:true},'MIGRATION_EXPORT_FILE_CHANGED'],['cancelled',{abortWrite:true},'MIGRATION_FILE_WRITE_FAILED'],['directory',{directoryChange:true},'MIGRATION_EXPORT_FILE_CHANGED']]) await t.test(name,async st=>{
    const f=await exportFilesystemFixture(st,options);
    await assert.rejects(writeMigrationArchive(f.filename,f.bytes),failure(code));
    await assert.rejects(f.realLstat(f.filename),{code:'ENOENT'});
  });
});

test('encrypted export never deletes a replacement installed during writing, readback or directory verification', async t => {
  for(const phase of ['write','readback','directory']) await t.test(phase,async st=>{
    const replacement=Buffer.from('synthetic unrelated replacement');
    const replace=async filename=>{await fs.rename(filename,filename+'.owned');await fs.writeFile(filename,replacement);};
    const f=await exportFilesystemFixture(st,phase==='write'?{afterSync:replace}:phase==='readback'?{beforeRead:replace}:{beforeDirectoryCheck:replace});
    await assert.rejects(writeMigrationArchive(f.filename,f.bytes),failure('MIGRATION_EXPORT_FILE_CHANGED'));
    assert.deepEqual(await f.realReadFile(f.filename),replacement);
    assert.deepEqual(await f.realReadFile(f.filename+'.owned'),f.bytes);
  });
});

test('encrypted export rejects a symlink installed after writing without removing its target', {skip:process.platform==='win32'}, async t=>{
  const replacement=Buffer.from('synthetic unrelated target');
  const f=await exportFilesystemFixture(t,{afterSync:async filename=>{
    await fs.rename(filename,filename+'.owned');
    await fs.writeFile(filename+'.target',replacement);
    await fs.symlink(filename+'.target',filename);
  }});
  await assert.rejects(writeMigrationArchive(f.filename,f.bytes),failure('MIGRATION_EXPORT_FILE_CHANGED'));
  assert.equal((await f.realLstat(f.filename)).isSymbolicLink(),true);
  assert.deepEqual(await f.realReadFile(f.filename+'.target'),replacement);
  assert.deepEqual(await f.realReadFile(f.filename+'.owned'),f.bytes);
});

test('file helpers reject relative, remote, directory, missing and oversized inputs with safe errors', async () => {
  const directory = await privateDirectory(), filename = path.join(directory, 'oversized.agm');
  try {
    const bytes = await archive();
    for (const name of ['relative.agm', 'file:///tmp/accounts.agm', '//server/share/accounts.agm', '\\\\server\\share\\accounts.agm', directory + '\0secret']) {
      await assert.rejects(readMigrationArchive(name), failure('MIGRATION_PATH_UNSAFE'));
      await assert.rejects(writeMigrationArchive(name, bytes), failure('MIGRATION_PATH_UNSAFE'));
    }
    await assert.rejects(readMigrationArchive(directory), failure('MIGRATION_PATH_UNSAFE'));
    await assert.rejects(writeMigrationArchive(directory, bytes), failure('MIGRATION_PATH_UNSAFE'));
    await assert.rejects(readMigrationArchive(path.join(directory, 'missing')), failure('MIGRATION_FILE_READ_FAILED'));
    const handle = await fs.open(filename, 'wx', 0o600); await handle.truncate(24 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(readMigrationArchive(filename), failure('MIGRATION_ARCHIVE_TOO_LARGE'));
    await assert.rejects(writeMigrationArchive(path.join(directory, 'new'), Buffer.alloc(24 * 1024 * 1024 + 1)), failure('MIGRATION_ARCHIVE_TOO_LARGE'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('file helpers refuse target and ancestor symlinks, including dangling links', { skip: process.platform === 'win32' }, async () => {
  const directory = await privateDirectory(), real = path.join(directory, 'real'), alias = path.join(directory, 'alias');
  try {
    await fs.mkdir(real); await fs.symlink(real, alias);
    const bytes = await archive(), target = path.join(real, 'archive.agm');
    await writeMigrationArchive(target, bytes);
    const link = path.join(directory, 'link.agm'); await fs.symlink(target, link);
    const dangling = path.join(directory, 'dangling.agm'); await fs.symlink(path.join(real, 'absent'), dangling);
    for (const filename of [link, dangling, path.join(alias, 'archive.agm')]) {
      await assert.rejects(readMigrationArchive(filename), failure('MIGRATION_PATH_UNSAFE'));
      await assert.rejects(writeMigrationArchive(filename, bytes), failure('MIGRATION_PATH_UNSAFE'));
    }
    await assert.rejects(writeMigrationArchive(path.join(alias, 'new.agm'), bytes), failure('MIGRATION_PATH_UNSAFE'));
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.deepEqual(await fs.readdir(real), ['archive.agm']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('portable token accepts only the exact unobserved file scope and never accesses malformed getters', () => {
  const raw=token('wsl','wsl@example.test'),scope={keyring:null,file:raw,keyringState:'unobserved'};
  assert.equal(portableToken(scope,'wsl@example.test'),raw);
  const getter={keyring:null,file:raw};Object.defineProperty(getter,'keyringState',{enumerable:true,get(){throw Error('must not read getter')}});
  const symbol={...scope,[Symbol('extra')]:'not-allowed'};
  for(const slots of [{...scope,keyring:raw},{...scope,keyringState:'native'},{...scope,keyringState:'unknown'},{...scope,keyringState:undefined},{...scope,extra:true},{...scope,file:null},getter,symbol]) assert.throws(()=>portableToken(slots,'wsl@example.test'),failure('MIGRATION_TOKEN_INVALID'));
  assert.throws(()=>portableToken(scope,'different@example.test'),failure('MIGRATION_TOKEN_INVALID'));
});

test('WSL capture exports a scope-free encrypted archive that imports, switches and restores on native and WSL targets', async t => {
  const {createOfficialTokenSlots}=require('../out/live-environment'),{LiveSwitchService}=require('../out/live-switch');
  const root=await privateDirectory();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  async function makeHome(name){const home=path.join(root,name);await fs.mkdir(path.join(home,'.gemini'),{recursive:true,mode:0o700});return home;}
  const vault=()=>{const data=new Map();return{get:async key=>data.get(key),store:async(key,value)=>{data.set(key,value)},delete:async key=>{data.delete(key)}};};
  const noKeyring=()=>{throw Error('file-scoped WSL must never access a native keyring')},email='wsl@example.test',raw=token('wsl',email),sourceHome=await makeHome('source');
  await fs.writeFile(path.join(sourceHome,'.gemini','jetski-standalone-oauth-token'),raw,{mode:0o600});
  const sourceSlots=await createOfficialTokenSlots(sourceHome,'linux',{WSL_DISTRO_NAME:'synthetic'},{createKeyring:noKeyring});
  const source=new LiveSwitchService(vault(),sourceSlots,'synthetic-source-host');
  const saved=await source.capture({label:'WSL account',expectedEmail:email,identitySource:'hub'});
  assert.equal((await source.account(saved.id)).slots.keyringState,'unobserved');
  const exported=await source.exportAccounts([saved.id]);
  assert.deepEqual(Object.keys(exported[0]).sort(),['capturedAt','expectedEmail','label','token']);assert.equal(exported[0].token,raw);
  const encrypted=await encryptAccountArchive(exported,PASSWORD),decrypted=await decryptAccountArchive(encrypted,PASSWORD);
  assert.deepEqual(decrypted.accounts,exported);assert.doesNotMatch(JSON.stringify(decrypted),/keyringState|unobserved|synthetic-source-host/);
  for(const targetMode of ['native','file']) {
    const targetHome=await makeHome(targetMode);let native=token('original-native'),writes=0,index=[];
    const targetSlots=await createOfficialTokenSlots(targetHome,'linux',targetMode==='file'?{WSL_DISTRO_NAME:'synthetic'}:{},{readKernelRelease:async()=> '6.8-generic',fileOnlyGuard:async()=>true,createKeyring:targetMode==='file'?noKeyring:()=>({read:async()=>native,write:async value=>{writes++;native=value}})},'mutation');
    const original=await targetSlots.read(),target=new LiveSwitchService(vault(),targetSlots,`synthetic-${targetMode}-host`);
    const targetIndex={read:()=>index,write:async value=>{index=value}};
    const imported=await target.importAccounts(decrypted.accounts,targetIndex,{query:async account=>({subject:'synthetic-subject',proof:{email:account.expectedEmail,authValid:true,quotaSource:'server',generation:'synthetic',observedAt:new Date().toISOString(),buckets:[]}})});assert.equal(writes,0);assert.deepEqual(await targetSlots.read(),original);
    let reloads=0;const lifecycle={generation:'old',stop:async()=>{},reload:async()=>{lifecycle.generation='new-'+(++reloads)},proof:async()=>({authValid:true,generation:lifecycle.generation,email:(await targetSlots.read()).keyring===raw||(await targetSlots.read()).file===raw?email:'original@example.test',quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]}),signedOutProof:async()=>({generation:lifecycle.generation,authValid:false})};
    await target.install(imported[0].id,lifecycle);
    assert.deepEqual(await targetSlots.read(),targetMode==='file'?{keyring:null,file:raw,keyringState:'unobserved'}:{keyring:raw,file:raw});
    assert.deepEqual((await target.journal()).backup,original);await target.markImportedVerified(lifecycle,targetIndex);assert.equal(index[0].migrationState,'verified');
    await target.restore(lifecycle);assert.deepEqual(await targetSlots.read(),original);await target.finish();
    if(targetMode==='native')assert.equal(writes,2);else assert.equal(writes,0);
  }
});
