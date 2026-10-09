const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { LiveError } = require('../out/live-storage');
const { LiveSwitchService, ACCOUNT_PREFIX } = require('../out/live-switch');
const INDEX = 'live-switch.accounts.v1';
const PENDING = 'live-switch.pending.v1';
const password = 'fixture-migration-password';
const token = JSON.stringify({ token: { refresh_token: 'fixture-secret-never-in-ui' } });
const saved = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, label: `Account ${n}`, expectedEmail: `account${n}@example.test`, capturedAt: '2026-10-01T00:00:00.000Z', identitySource: 'hub', hostId: 'this-host', ...extra });
const uri = (extra = {}) => ({ scheme: 'file', authority: '', query: '', fragment: '', fsPath: path.resolve('/synthetic-private/archive.agwenc'), ...extra });
function fixture(options = {}) {
  const commands = new Map(), events = [], messages = [], picks = [], inputs = [], dialogs = [], writes = [], state = new Map();
  const nativeFile = uri({ fsPath: options.filename || uri().fsPath });
  const ui = { trusted: true, inputAnswers: [password, password], name: path.basename(nativeFile.fsPath), folder: [uri({ fsPath: path.dirname(nativeFile.fsPath) })], pickAnswers: [], consent: true, save: nativeFile, open: [nativeFile], exists: false };
  const archive = { schema: 1, createdAt: '2026-10-01T00:00:00.000Z', accounts: [1, 2, 3].map(n => ({ label: `Imported ${n}`, expectedEmail: `account${n}@example.test`, capturedAt: '2026-09-30T00:00:00.000Z', token })) };
  const codec = {
    async readMigrationArchive(filename) { events.push('read-file'); assert.equal(filename, nativeFile.fsPath); return Buffer.from('synthetic ciphertext'); },
    async decryptAccountArchive(bytes, supplied) { events.push('decrypt'); assert.equal(bytes.toString(), 'synthetic ciphertext'); if (supplied !== password) throw new LiveError('MIGRATION_DECRYPT_FAILED'); return archive; },
    async encryptAccountArchive(accounts, supplied) { events.push('encrypt'); assert.equal(supplied, password); assert.ok(accounts.length); return Buffer.from('synthetic ciphertext'); },
    async prepareMigrationExport(filename) { events.push('prepare-file'); return { filename, exists: ui.exists }; },
    async writeMigrationArchive(filename, bytes, target) { events.push('write-file'); assert.equal(target.filename,filename); writes.push({ filename, bytes, target }); }
  };
  const vscode = {
    ProgressLocation: { Notification: 1 }, Uri: { file: filename => uri({ fsPath: filename }) }, UIKind: { Desktop: 1 }, env: { uiKind: 1, remoteName: options.remoteName }, extensions: { getExtension(id) { return id==='google.google-antigravity'?options.official:undefined; } },
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; }, async executeCommand(name) { events.push(name); } },
    workspace: { getConfiguration: () => ({get: () => undefined}), get isTrusted() { return ui.trusted; }, async openTextDocument(value) { messages.push(value.content); return {}; } },
    window: {
      async showWarningMessage(message, options, consent) { messages.push(message); events.push(options?.modal ? 'confirm' : 'warning'); return ui.consent ? consent : undefined; },
      async showInformationMessage(message, options, consent) { messages.push(message); return options?.modal && ui.consent ? consent : undefined; },
      async showQuickPick(choices, options) { picks.push({ choices, options }); events.push('pick'); const answer = ui.pickAnswers.shift(); return typeof answer === 'function' ? answer(choices) : answer === 'cancel' ? undefined : options.canPickMany ? choices : choices[0]; },
      async showSaveDialog(options) { dialogs.push(options); events.push('save-dialog'); return ui.save; },
      async showOpenDialog(options) { dialogs.push(options); events.push('open-dialog'); return options.canSelectFolders ? ui.folder : ui.open; },
      async showInputBox(options) { inputs.push(options); events.push(options.password ? 'password' : 'filename'); return options.password ? ui.inputAnswers.shift() : ui.name; },
      async withProgress(_options, run) { return run({}, { isCancellationRequested: !!options.cancelProgress, onCancellationRequested: () => ({ dispose() {} }) }); },
      async showTextDocument() {},
    }
  };
  const entry = require.resolve('../out/live-ui'), original = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : name === './account-migration' && args[0]?.filename === entry ? codec : original.call(this, name, ...args); };
  let api; try { delete require.cache[entry]; api = require(entry); } finally { Module._load = original; }
  const context = { extension: { extensionKind: options.extensionKind || 1 }, extensionUri: nativeFile, globalStorageUri: { ...nativeFile, toString: () => 'file:///synthetic-private' }, globalState: { get(key, defaultValue) { return state.has(key) ? state.get(key) : defaultValue; }, async update(key, value) { events.push(key === INDEX ? 'index-write' : 'pending-write'); state.set(key, value); } }, secrets: { async delete() { throw Error('must not delete directly'); } }, subscriptions: [] };
  state.set(INDEX, [saved(1), saved(2), saved(3, { hostId: 'other-host' })]);
  let service = {
    async recoverImport() { events.push('recover-import'); }, async journal() { return null; }, hostIsCurrent: account => account.hostId === 'this-host',
    async exportAccounts(ids) { events.push('export'); service.exported = ids; return ids.map(id => { const value = state.get(INDEX).find(account => account.id === id); return { label: value.label, expectedEmail: value.expectedEmail, capturedAt: value.capturedAt, token }; }); },
    async importAccounts(accounts, index, options) { events.push('import'); service.imported = accounts; const imported = accounts.map((account, n) => ({ ...saved(n + 20), label: account.label, expectedEmail: account.expectedEmail, capturedAt: account.capturedAt, identitySource: 'user', migrationState: 'verified', verifiedSubject: 'synthetic-'+n, id: options.replace?.[account.expectedEmail.trim().toLowerCase()] ?? saved(n+20).id })); await index.write(index.read().map(row=>imported.find(item=>item.id===row.id)??row).concat(imported.filter(item=>!index.read().some(row=>row.id===item.id)))); for(const account of imported) options.quota?.(account,{subject:account.verifiedSubject,proof:{email:account.expectedEmail,observedAt:new Date().toISOString(),authValid:true,quotaSource:'server',buckets:[]}}); return imported; },
    async install() { events.push('install'); }, async verify() { events.push('verify'); return { email: 'account1@example.test', observedAt: '2026-10-01T00:00:00.000Z', buckets: [] }; },
    async markImportedVerified() { events.push('mark-verified'); }, async finish() { events.push('finish'); }
  };
  if (options.serviceFactory) service = options.serviceFactory({ context, state, events });
  const locks = { async withOperation(fn) { events.push('lock'); try { return await fn(); } finally { events.push('unlock'); } }, async hasRecovery() { return false; }, async beginRecovery() { events.push('recovery'); }, async clearRecovery() { events.push('clear-recovery'); }, async assertRecovery() {} };
  const lifecycle = async () => { events.push('lifecycle'); return { generation: 'old' }; };
  const controller = api.registerLiveUi(context, { service, locks, lifecycle, ...(options.currentIdentity?{currentIdentity:options.currentIdentity}:{}), ...(options.currentQuota?{currentQuota:options.currentQuota}:{}), importQuota: options.importQuota ?? (async account=>({subject:'synthetic',proof:{email:account.expectedEmail,observedAt:new Date().toISOString(),authValid:true,quotaSource:'server',buckets:[]}})) });
  return { ui, commands, events, messages, picks, inputs, dialogs, writes, state, context, service, locks, codec, controller, api, archive, call: (name, argument) => commands.get(`antigravityAccounts.live.${name}`)(argument) };
}
function noMutation(f) { assert.ok(!f.events.some(event => ['write-file', 'import', 'index-write', 'install', 'lifecycle', 'recovery'].includes(event))); assert.equal(f.writes.length, 0); }
function noSecrets(f) {
  const visible = JSON.stringify({ messages: f.messages, picks: f.picks, inputs: f.inputs, dialogs: f.dialogs, state: [...f.state], inline: f.controller.getState() });
  for (const secret of [token, 'fixture-secret-never-in-ui', password]) assert.ok(!visible.includes(secret), 'secrets must not enter UI, state or diagnostic messages');
  for (const input of f.inputs) { assert.equal(input.ignoreFocusOut, true); if (input.password) { assert.equal(input.password, true); assert.equal(input.value, undefined); } else { assert.equal(input.value, 'antigravity-accounts.agwenc'); } }
}
test('migration commands activate passively and both flows recover under the operation lock', async () => {
  const f = fixture(); assert.deepEqual(f.events, []);
  assert.ok(f.commands.has('antigravityAccounts.live.export')); assert.ok(f.commands.has('antigravityAccounts.live.import'));
  f.ui.open = undefined; await f.call('import'); assert.deepEqual(f.events, ['lock', 'recover-import', 'open-dialog', 'unlock']); noMutation(f);
});
test('export selects multiple current-host accounts only and asks explicit OAuth consent before writing', async () => {
  const f = fixture(); await f.call('export');
  assert.deepEqual(f.service.exported, [saved(1).id, saved(2).id]); assert.equal(f.writes.length, 1);
  assert.equal(f.picks[0].options.canPickMany, true); assert.ok(f.picks[0].choices.every(choice => choice.picked));
  assert.equal(f.picks[0].choices.length, 2); assert.equal(f.inputs.length, 3);
  assert.match(f.messages[0], /完整 OAuth.*加密文件/); assert.match(f.messages[0], /分开传递文件与密码/);
  assert.ok(f.events.indexOf('confirm') < f.events.indexOf('export')); assert.ok(f.events.indexOf('encrypt') < f.events.indexOf('write-file'));
  assert.ok(!f.events.includes('lifecycle')); assert.equal(f.state.get(PENDING), undefined); noSecrets(f);
});
test('export allows a subset and never exports a deselected account', async () => {
  const f = fixture(); f.ui.pickAnswers = [choices => [choices[1]]]; await f.call('export'); assert.deepEqual(f.service.exported, [saved(2).id]); noSecrets(f);
});
test('existing export file gets one bound replacement confirmation and no native save dialog',async()=>{
  const i18n=require('../out/i18n');
  try{for(const language of ['zh-CN','en']){
    i18n.setLanguage(language);const f=fixture();f.ui.exists=true;await f.call('export');
    assert.equal(f.events.filter(x=>x==='confirm').length,1);assert.ok(!f.events.includes('save-dialog'));
    assert.equal(f.dialogs[0].canSelectFolders,true);assert.equal(f.dialogs[0].canSelectFiles,false);
    assert.ok(f.events.indexOf('prepare-file')<f.events.indexOf('confirm'));assert.equal(f.writes[0].target.exists,true);
    assert.ok(f.messages[0].includes(f.writes[0].filename));assert.match(f.messages[0],language==='en'?/Replace this existing file/:/替换以下现有文件/);
    noSecrets(f);
  }}finally{i18n.setLanguage('zh-CN');}
});
test('replacement cancellation at every dialog leaves export files and account state unchanged',async()=>{
  for(const stage of ['file','filename','consent','password','repeat']){
    const f=fixture();f.ui.exists=true;const before=JSON.stringify([...f.state]);
    if(stage==='file')f.ui.folder=undefined;if(stage==='filename')f.ui.name=undefined;if(stage==='consent')f.ui.consent=false;
    if(stage==='password')f.ui.inputAnswers=[];if(stage==='repeat')f.ui.inputAnswers=[password];
    await f.call('export');noMutation(f);assert.equal(JSON.stringify([...f.state]),before);assert.ok(!f.events.includes('export'));noSecrets(f);
  }
});
test('export rejects filename traversal, Windows device names and invalid extensions before credentials',async()=>{
  for(const name of ['../x.agwenc','..\\x.agwenc','C:\\x.agwenc','CON.agwenc','nul.agwenc','LPT1.agwenc','COM¹.agwenc','x.txt','a\0.agwenc','a\u202e.agwenc',' archive.agwenc']){
    const f=fixture();f.ui.name=name;await f.call('export');noMutation(f);assert.ok(!f.events.includes('prepare-file'));assert.ok(!f.events.includes('password'));noSecrets(f);
    assert.match(f.controller.getState().error,/文件名/);
  }
});
test('same-name WSL mount export passes the confirmed target without changing current login',{skip:process.platform!=='linux'},async()=>{
  const f=fixture({extensionKind:2,remoteName:'wsl',filename:'/mnt/c/Synthetic Directory/账户.agwenc'});f.ui.exists=true;
  await f.call('export');assert.equal(f.writes[0].filename,'/mnt/c/Synthetic Directory/账户.agwenc');assert.equal(f.writes[0].target.exists,true);
  assert.ok(!f.events.some(x=>['install','lifecycle','recover-import','index-write'].includes(x)));noSecrets(f);
});
test('repeated export clicks and disposal discard late encryption without writing',async()=>{
  const f=fixture();f.ui.exists=true;let release,entered;
  const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);f.codec.encryptAccountArchive=async()=>{entered();await wait;return Buffer.from('synthetic ciphertext');};
  const first=f.call('export');await started;await f.call('export');assert.equal(f.events.filter(x=>x==='confirm').length,1);
  for(const subscription of f.context.subscriptions)subscription.dispose();release();await first;noMutation(f);noSecrets(f);
});
test('every export dismissal leaves files and storage unchanged', async () => {
  for (const stage of ['selection', 'consent', 'file', 'filename', 'password', 'repeat']) {
    const f = fixture(); if (stage === 'selection') f.ui.pickAnswers = ['cancel']; if (stage === 'consent') f.ui.consent = false;
    if (stage === 'file') f.ui.folder = undefined; if (stage === 'filename') f.ui.name = undefined; if (stage === 'password') f.ui.inputAnswers = []; if (stage === 'repeat') f.ui.inputAnswers = [password];
    await f.call('export'); noMutation(f); assert.ok(!f.events.includes('export')); noSecrets(f);
  }
});
test('export enforces password minimum and repeated confirmation even if input validation is bypassed', async () => {
  for (const answers of [['short', 'short'], [password, 'different-password']]) {
    const f = fixture(); f.ui.inputAnswers = answers; await f.call('export'); noMutation(f); assert.ok(!f.events.includes('export')); noSecrets(f);
  }
  const f = fixture(); await f.call('export'); assert.match(f.inputs[1].validateInput('short'), /12/); assert.equal(f.inputs[1].validateInput(password), null);
});
test('native migration dialogs reject remote, foreign-host, relative and network paths before secret work', async () => {
  for (const invalid of [uri({ scheme: 'vscode-remote' }), uri({ scheme: 'vscode-local' }), uri({ authority: 'other-machine' }), uri({ query: 'secret=not-permitted' }), uri({ fragment: 'fragment' }), uri({ fsPath: 'relative-file' }), uri({ fsPath: '//network/share/archive' }), uri({ fsPath: '/file\0archive' })]) {
    for (const name of ['export', 'import']) {
      const f = fixture(); f.ui.folder = [invalid]; f.ui.open = [invalid]; await f.call(name); noMutation(f); assert.equal(f.inputs.length, 0); assert.ok(!f.events.includes('read-file')); assert.match(f.controller.getState().error, /文件|路径/);
    }
  }
});
test('import preview contains metadata only, defaults to all, and can select a non-conflicting subset', async () => {
  const f = fixture(); f.ui.pickAnswers = [choices => [choices[2]]]; await f.call('import');
  assert.equal(f.picks[0].options.canPickMany, true); assert.equal(f.picks[0].choices.length, 3); assert.ok(f.picks[0].choices.every(choice => choice.picked));
  assert.deepEqual(f.service.imported.map(account => account.expectedEmail), ['account3@example.test']);
  assert.ok(f.messages.some(message => /VS Code SecretStorage.*当前官方登录保持不变/.test(message)));
  assert.ok(f.messages.some(message => /自动查询服务器身份和额度/.test(message))); assert.equal(f.controller.getAccounts().at(-1).migrationState, 'verified');
  assert.equal(f.state.get(PENDING), undefined); assert.ok(!f.events.includes('lifecycle')); assert.ok(!f.events.includes('install')); noSecrets(f);
});
test('import wrong password or corrupt archive never previews or changes any account', async () => {
  const f = fixture(); f.ui.inputAnswers = ['wrong-password']; await f.call('import'); noMutation(f); assert.equal(f.picks.length, 0); assert.match(f.controller.getState().error, /密码错误或文件已损坏/); noSecrets(f);
  const g = fixture(); g.codec.decryptAccountArchive = async () => { throw Error(token); }; await g.call('import'); noMutation(g); assert.equal(g.picks.length, 0); noSecrets(g);
});
test('all import dismissals, including conflict and final consent, leave all saved copies unchanged', async () => {
  for (const stage of ['file', 'password', 'preview', 'conflict', 'consent']) {
    const f = fixture(), before = structuredClone(f.state.get(INDEX));
    if (stage === 'file') f.ui.open = undefined; if (stage === 'password') f.ui.inputAnswers = [];
    if (stage === 'preview') f.ui.pickAnswers = ['cancel']; if (stage === 'conflict') f.ui.pickAnswers = [choices => choices, 'cancel']; if (stage === 'consent') f.ui.consent = false;
    await f.call('import'); noMutation(f); assert.deepEqual(f.state.get(INDEX), before); noSecrets(f);
  }
});
test('conflict matching normalizes email, considers only this host, and safe first choice skips all conflicts', async () => {
  const f = fixture(); f.archive.accounts[0].expectedEmail = ' ACCOUNT1@EXAMPLE.TEST '; const before = structuredClone(f.state.get(INDEX)); await f.call('import');
  assert.equal(f.picks.length, 2); assert.match(f.picks[1].choices[0].label, /跳过.*推荐/);
  assert.deepEqual(f.service.imported.map(account => account.expectedEmail), ['account3@example.test']); assert.deepEqual(f.state.get(INDEX).slice(0, before.length), before); noSecrets(f);
});
test('replace conflicts retain original IDs and create only nonconflicting accounts', async () => {
  const f = fixture(), before = structuredClone(f.state.get(INDEX)); f.ui.pickAnswers = [choices => choices, choices => choices[1]]; await f.call('import');
  assert.equal(f.service.imported.length, 3); assert.equal(f.state.get(INDEX).length, 4); assert.equal(f.state.get(INDEX)[0].id,before[0].id); assert.equal(f.state.get(INDEX)[1].id,before[1].id); assert.deepEqual(f.state.get(INDEX)[2],before[2]);
  const ids = f.state.get(INDEX).map(account => account.id); assert.equal(new Set(ids).size, 4); noSecrets(f);
});
test('skipping all selected conflicts is a clean no-op without final consent', async () => {
  const f = fixture(); f.ui.pickAnswers = [choices => choices.slice(0, 2)]; await f.call('import'); noMutation(f); assert.ok(!f.events.includes('confirm')); assert.match(f.messages.at(-1), /没有导入或修改/);
});
test('migration commands reject arguments and untrusted hosts before file or password interaction', async () => {
  for (const name of ['export', 'import']) {
    const f = fixture(); await f.call(name, { password, path: uri().fsPath, token }); noMutation(f); assert.equal(f.dialogs.length, 0); noSecrets(f);
    const g = fixture(); g.ui.trusted = false; await g.call(name); noMutation(g); assert.ok(!g.events.includes('lock')); assert.equal(g.dialogs.length, 0); assert.equal(g.inputs.length, 0);
  }
});
test('a pending official switch prevents import and export before dialogs', async () => {
  for (const name of ['export', 'import']) { const f = fixture(); f.locks.hasRecovery = async () => true; await f.call(name); noMutation(f); assert.equal(f.dialogs.length, 0); }
});
test('migration repeated commands coalesce while native password dialog is open', async () => {
  const f = fixture(); let release; f.codec.readMigrationArchive = async () => { await new Promise(resolve => { release = resolve; }); return Buffer.from('synthetic ciphertext'); };
  const first = f.call('import'); await new Promise(setImmediate); await f.call('export'); assert.equal(f.dialogs.length, 1); assert.equal(f.controller.getState().busy, true);
  f.ui.inputAnswers = []; release(); await first; assert.equal(f.controller.getState().busy, false); noMutation(f);
});
test('pending imported copy displays uncertainty before the explicit normal switch confirmation', async () => {
  const f = fixture(); f.state.set(INDEX, [saved(1, { label: 'Already verified (user label)', migrationState: 'pending' })]); f.ui.consent = false;
  const before = structuredClone([...f.state]);
  await f.call('switch', saved(1).id); assert.match(f.messages.at(-1), /迁移副本/); assert.match(f.messages.at(-1), /自动核验新身份/); assert.match(f.messages.at(-1), /保留原登录备份/);
  assert.equal(f.events.filter(event => event === 'lifecycle').length, 1);
  assert.ok(f.events.indexOf('lifecycle') < f.events.indexOf('confirm'));
  assert.ok(!f.events.some(event => ['stop', 'install', 'import', 'index-write', 'write-file', 'recovery', 'clear-recovery', 'pending-write'].includes(event)));
  assert.equal(f.writes.length, 0); assert.deepEqual([...f.state], before);
});
test('automatic verification records imported identity and clears backup without a success confirmation', async () => {
  for (const consent of [false,true]) {
    const f = fixture(); await f.controller.refresh(); f.ui.consent=consent;
    f.service.journal = async () => ({ id: 'recovery-id', phase: 'installed' });
    f.service.finishVerified=async(_backend,index)=>{assert.equal(typeof index.write,'function');f.events.push('verify','mark-verified','finish');f.service.journal=async()=>null;return {email:'account1@example.test'}};
    await f.call('verify');assert.ok(f.events.indexOf('mark-verified') > f.events.lastIndexOf('verify'));assert.ok(f.events.indexOf('mark-verified') < f.events.indexOf('finish'));
    assert.equal(f.messages.length,0);assert.equal(f.controller.getState().pending,false);
  }
});

test('real encrypted archive decrypts for preview and wrong password is sanitized without mutation', async () => {
  const migration = require('../out/account-migration');
  const entries = [4, 5].map(n => ({ label: `Synthetic ${n}`, expectedEmail: `account${n}@example.test`, capturedAt: '2026-09-30T00:00:00.000Z', token: JSON.stringify({ token: { refresh_token: `synthetic-refresh-${n}` } }) }));
  const bytes = await migration.encryptAccountArchive(entries, password);
  for (const correct of [false, true]) {
    const f = fixture(); f.codec.readMigrationArchive = async () => bytes; f.codec.decryptAccountArchive = migration.decryptAccountArchive; f.ui.inputAnswers = [correct ? password : 'different-password'];
    await f.call('import');
    if (correct) { assert.equal(f.service.imported.length, 2); assert.equal(f.picks[0].choices.length, 2); }
    else { noMutation(f); assert.equal(f.picks.length, 0); assert.match(f.controller.getState().error, /密码错误或文件已损坏/); }
    assert.doesNotMatch(JSON.stringify({ picks: f.picks, messages: f.messages, state: [...f.state] }), /synthetic-refresh/); noSecrets(f);
  }
});
test('trust revoked during native dialogs prevents the final export or import mutation', async () => {
  const f = fixture(); f.ui.pickAnswers = [choices => { f.ui.trusted = false; return choices; }]; await f.call('export'); noMutation(f); assert.ok(!f.events.includes('export'));
  const g = fixture(); g.ui.pickAnswers = [choices => { g.ui.trusted = false; return [choices[2]]; }]; await g.call('import'); noMutation(g); assert.match(g.controller.getState().error, /信任/);
});
test('recovery failure blocks every later action without exposing error details', async () => {
  const f = fixture(); f.service.recoverImport = async () => { throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }; await f.call('import'); noMutation(f); assert.equal(f.dialogs.length, 0); assert.match(f.controller.getState().error, /关闭其他 VS Code 窗口/);
});

test('WSL workspace-host migration accepts only current-host file URIs and never opens official slots', async t => {
  if (process.platform !== 'linux') { t.skip('WSL extension hosts use Linux; pure host platform matrix is covered elsewhere'); return; }
  const vault = new Map();
  for (const n of [1, 2]) {
    const credential = JSON.stringify({ token: { refresh_token: `wsl-synthetic-refresh-${n}` } });
    vault.set(ACCOUNT_PREFIX + saved(n).id, JSON.stringify({ ...saved(n), slots: { keyring: credential, file: credential } }));
  }
  let officialReads = 0, officialWrites = 0;
  const f = fixture({ extensionKind: 2, remoteName: 'wsl', filename: '/home/synthetic-user/migration.agwenc', serviceFactory({ context, events }) {
    context.secrets = { async get(key) { return vault.get(key); }, async store(key, value) { events.push('secret-store'); vault.set(key, value); }, async delete(key) { events.push('secret-delete'); vault.delete(key); } };
    return new LiveSwitchService(context.secrets, { async read() { officialReads++; throw Error('official keyring/file must remain unopened'); }, async write() { officialWrites++; throw Error('official keyring/file must remain unchanged'); } }, 'this-host');
  } });
  assert.equal(f.controller.getState().environment.available, true);
  assert.match(f.controller.getState().environment.message, /WSL · Linux/);
  await f.call('export');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].filename, '/home/synthetic-user/migration.agwenc');
  assert.match(f.dialogs[0].title, /WSL · Linux/); assert.equal(vault.size, 2);
  f.ui.inputAnswers = [password]; await f.call('import');
  const imported = f.state.get(INDEX).filter(account => account.migrationState === 'verified');
  assert.equal(imported.length, 1); assert.equal(imported[0].expectedEmail, 'account3@example.test'); assert.equal(imported[0].hostId, 'this-host');
  assert.equal(vault.size, 3); assert.equal(officialReads, 0); assert.equal(officialWrites, 0); assert.ok(!f.events.includes('lifecycle')); assert.equal(f.state.get(PENDING), undefined);
  assert.match(f.messages.at(-1), /当前官方登录未改变/); noSecrets(f);
  assert.doesNotMatch(JSON.stringify({ picks: f.picks, messages: f.messages, state: [...f.state] }), /wsl-synthetic-refresh/);
  const before = [...vault];
  for (const wrongHost of [uri({ scheme: 'vscode-remote', authority: 'wsl+untrusted-distro', fsPath: '/home/synthetic-user/migration.agwenc' }), uri({ scheme: 'vscode-local', fsPath: '/desktop-side/migration.agwenc' })]) {
    f.ui.open = [wrongHost]; await f.call('import');
    assert.deepEqual([...vault], before); assert.match(f.controller.getState().error, /文件|路径/); assert.equal(officialReads, 0); assert.equal(officialWrites, 0);
  }
});
test('every current migration core error has a specific safe UI explanation', () => {
  const fs = require('node:fs');
  const sources = ['account-migration.ts', 'account-import.ts', 'live-switch.ts'].map(name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')).join('\n');
  const codes = [...new Set([...sources.matchAll(/['"](MIGRATION_[A-Z_]+)['"]/g)].map(match => match[1]))];
  const f = fixture(), fallback = f.api.liveErrorMessage('MIGRATION_UNRECOGNIZED'); assert.ok(codes.length >= 22);
  for (const code of codes) { const message = f.api.liveErrorMessage(code); assert.notEqual(message, fallback, `${code} needs a specific explanation`); assert.doesNotMatch(message, /MIGRATION_/); assert.match(message, /[\u4e00-\u9fff]/); }
  assert.match(f.api.liveErrorMessage('MIGRATION_TARGET_SIZE_LIMIT'), /存储大小限制.*当前登录尚未改动.*官方登录重新保存/);
  for (const code of ['MIGRATION_EXPORT_FILE_CHANGED']) {
    assert.match(f.api.liveErrorMessage(code), /导出/);
    assert.doesNotMatch(f.api.liveErrorMessage(code), /未导入|读取中|传输完成/);
  }
});

test('export write failures report export-specific bilingual messages without exposing credentials', async () => {
  const i18n = require('../out/i18n');
  try {
    for (const language of ['zh-CN','en']) for (const code of ['MIGRATION_EXPORT_FILE_CHANGED','MIGRATION_FILE_WRITE_FAILED','MIGRATION_EXPORT_CONFIRM_REQUIRED','MIGRATION_EXPORT_BUSY']) {
      i18n.setLanguage(language);
      const f = fixture();
      f.ui.exists=true;
      const before = JSON.stringify([...f.state].filter(([key])=>key===INDEX));
      f.codec.writeMigrationArchive = async () => { throw new LiveError(code); };
      await f.call('export');
      const error = f.controller.getState().error;
      assert.match(error,language==='en'?/Export stopped|export target|export or|original was not replaced/i:/导出已停止|无法保存|导出目标|本次导出已停止/);
      assert.doesNotMatch(error,/未导入|Nothing imported|while reading|传输完成/);
      assert.equal(JSON.stringify([...f.state].filter(([key])=>key===INDEX)),before);
      assert.ok(!f.events.includes('import')&&!f.events.includes('install')&&!f.events.includes('lifecycle'));
      noSecrets(f);
    }
  } finally {i18n.setLanguage('zh-CN');}
});

test('multiple legacy same-email records offer an explicit target, with cancellation preserving all copies',async()=>{
  for(const cancel of [false,true]){
    const f=fixture(),duplicate=saved(8,{expectedEmail:saved(1).expectedEmail,label:'Exact target'});const rows=[saved(1),duplicate,saved(2)];f.state.set(INDEX,rows);
    f.ui.pickAnswers=[choices=>[choices[0]],choices=>choices[1],cancel?'cancel':choices=>choices[1]];await f.call('import');
    assert.equal(f.picks.length,3);assert.match(f.picks[2].options.title,/选择覆盖/);assert.ok(f.picks[2].choices.every(choice=>choice.id));
    if(cancel){noMutation(f);assert.deepEqual(f.state.get(INDEX),rows);}else{assert.deepEqual(f.state.get(INDEX).map(row=>row.id),rows.map(row=>row.id));assert.deepEqual(f.state.get(INDEX)[0],rows[0]);assert.equal(f.state.get(INDEX)[1].label,'Imported 1');}
    assert.ok(f.picks[1].choices.every(choice=>!['copy','keep-both'].includes(choice.policy)));noSecrets(f);
  }
});
test('UI capacity only counts new records so replacing at 50 works',async()=>{
  const f=fixture();f.state.set(INDEX,Array.from({length:50},(_,n)=>saved(n+1)));f.ui.pickAnswers=[choices=>[choices[0]],choices=>choices[1]];await f.call('import');assert.equal(f.service.imported.length,1);assert.equal(f.state.get(INDEX).length,50);assert.equal(f.state.get(INDEX)[0].id,saved(1).id);noSecrets(f);
});
test('export never invokes import/login recovery or repairs saved state',async()=>{
  const f=fixture();f.service.recoverImport=async()=>{throw Error('export must not recover imports');};f.service.recoverLogin=async()=>{throw Error('export must not repair logins');};const rows=structuredClone(f.state.get(INDEX));await f.call('export');assert.deepEqual(f.state.get(INDEX),rows);assert.equal(f.writes.length,1);assert.ok(!f.events.includes('recover-import'));noSecrets(f);
});
function candidateUi(options={}){
  const data=new Map(),official={id:'google.google-antigravity',extensionKind:1,extensionPath:'/synthetic/official',extensionUri:{scheme:'file',authority:'',toString:()=> 'file:///synthetic/official'},packageJSON:{main:'extension.js',version:'fixture'},isActive:true,exports:{port:1234,csrfToken:'synthetic-csrf-capability-value'}};
  const generation=require('../out/live-hub').generation(official.exports);let currentCalls=0,checked=0;
  const currentProof={email:saved(1).expectedEmail,authValid:true,quotaSource:'server',generation,observedAt:new Date().toISOString(),buckets:[{label:'old quota',remaining:.99,resetAt:null}]};
  const f=fixture({...options,official,currentIdentity:async()=>currentProof,currentQuota:async()=>{currentCalls++;return currentProof;},importQuota:async(account,signal)=>{checked++;assert.equal(account.slots.file,token);assert.notEqual(account.slots.file,JSON.parse(data.get(ACCOUNT_PREFIX+saved(1).id)).slots.file);if(options.query)return options.query(account,signal);return {subject:'subject-a',proof:{...currentProof,buckets:[{label:'candidate quota',remaining:.25,resetAt:null}]}};},serviceFactory({context}){
    const old={...saved(1),slots:{file:JSON.stringify({token:{refresh_token:'synthetic-old-grant'}}),keyring:null}};data.set(ACCOUNT_PREFIX+old.id,JSON.stringify(old));context.secrets={get:async key=>data.get(key),store:async(key,raw)=>data.set(key,raw),delete:async key=>data.delete(key)};
    const real=new LiveSwitchService(context.secrets,{read:async()=>{throw Error('official slots must stay untouched');},write:async()=>{throw Error('official slots must stay untouched');}},'this-host');
    // Disable unrelated automatic capture in this fixture; all import/quota methods are real.
    return Object.fromEntries(['journal','hostIsCurrent','recoverImport','importAccounts','account','exportAccounts'].map(name=>[name,real[name].bind(real)]));
  }});
  return {...f,data,checked:()=>checked,currentCalls:()=>currentCalls};
}
test('active same-email import verifies the candidate directly, refreshes only its quota cache and preserves active identity',async()=>{
  const f=candidateUi();await f.controller.refresh();assert.equal(f.controller.getState().activeEmail,saved(1).expectedEmail);await f.call('quota',saved(1).id);assert.equal(f.currentCalls(),1);assert.equal(f.controller.getAccounts()[0].quota.snapshot.buckets[0].remaining,.99);
  f.ui.pickAnswers=[choices=>[choices[0]],choices=>choices[1]];await f.call('import');assert.equal(f.checked(),1);assert.equal(f.currentCalls(),1);assert.equal(f.controller.getAccounts()[0].quota.snapshot.buckets[0].remaining,.25);assert.equal(f.controller.getState().activeEmail,saved(1).expectedEmail);assert.equal(f.state.get(PENDING),undefined);assert.ok(!f.events.includes('lifecycle')&&!f.events.includes('install'));noSecrets(f);
  f.context.subscriptions.forEach(sub=>sub.dispose());
});
test('failed candidate import invalidates old saved quota without changing current official identity',async()=>{
  const f=candidateUi({query:async()=>{throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');}});await f.controller.refresh();await f.call('quota',saved(1).id);const before=f.data.get(ACCOUNT_PREFIX+saved(1).id);
  f.ui.pickAnswers=[choices=>[choices[0]],choices=>choices[1]];await f.call('import');assert.equal(f.data.get(ACCOUNT_PREFIX+saved(1).id),before);assert.equal(f.controller.getAccounts()[0].quota,undefined);assert.equal(f.controller.getState().activeEmail,saved(1).expectedEmail);assert.equal(f.currentCalls(),1);noSecrets(f);f.context.subscriptions.forEach(sub=>sub.dispose());
});
test('dispose during import discards late verification and repeated commands remain coalesced',async()=>{
  let release;const f=candidateUi({query:async()=>new Promise(resolve=>{release=resolve;})});await f.controller.refresh();f.ui.pickAnswers=[choices=>[choices[0]],choices=>choices[1]];const before=f.data.get(ACCOUNT_PREFIX+saved(1).id),work=f.call('import');while(!release)await new Promise(setImmediate);
  await f.call('export');assert.equal(f.dialogs.length,1);f.context.subscriptions.forEach(sub=>sub.dispose());release({subject:'subject-a',proof:{email:saved(1).expectedEmail,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]}});await work;assert.equal(f.data.get(ACCOUNT_PREFIX+saved(1).id),before);assert.equal(f.controller.getAccounts()[0].migrationState,undefined);noSecrets(f);
});
