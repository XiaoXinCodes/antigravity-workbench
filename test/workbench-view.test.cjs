const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const entry = path.resolve(__dirname, '../out/workbench-view');
const original = Module._load;
const calls = [], warnings = [];
let execute = async (...args) => { calls.push(args); };
Module._load = function(name, parent, main) { if (name === 'vscode') return { commands: { executeCommand: (...args) => execute(...args) }, window: { showWarningMessage(text) { warnings.push(text); } } }; return original.call(this, name, parent, main); };
const { renderWorkbench, WorkbenchView } = require(entry);
Module._load = original;
const state = (extra = {}) => ({ accounts: [], snapshots: [], status: '准备就绪', busy: false, pending: false, recoveryPhase: 'none', warning: null, environment: { available: true, message: '本机工作台 · WSL 工作区' }, ...extra });
const account = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Example', expectedEmail: 'example@example.test', capturedAt: '2026-10-01T00:00:00.000Z', identitySource: 'hub' };
test('unknown scope explains ownership and shows the distinct current Hub without implying missing Linux tools',()=>{
 const processConflicts={phase:'blocked',canContinue:false,limitation:'ownership',current:{id:'current-private-selection',pid:709,parentPid:701,owner:'current',scope:'current-window',parentState:'alive',taskState:'unknown',canEnd:false},processes:[{id:'conflict-selection',pid:710,parentPid:702,owner:'other',scope:'unknown',scopeReason:'ancestor-user-mismatch',parentState:'alive',taskState:'unknown',canEnd:false}]};
 const html=renderWorkbench(state({processConflicts}),'nonce');
 assert.match(html,/本窗口后台：PID 709/);assert.match(html,/额外冲突后台/);assert.match(html,/祖先进程属于不同系统用户/);
 assert.ok(!html.includes('python3'));assert.ok(!html.includes('pidfd'));assert.ok(!html.includes('current-private-selection'));
 assert.match(html,/data-command="live.processEnd" data-id="conflict-selection" disabled/);
});
test('independently verified unknown-window backend offers explicit handling and retains truthful ancestry details',()=>{
 const row={id:'selected-synthetic-710',pid:710,parentPid:702,owner:'other',scope:'unknown',scopeReason:'ancestor-user-mismatch',credentialScopeVerified:true,credentialScopeReason:'verified',parentState:'alive',taskState:'unknown',canEnd:true};
 const html=renderWorkbench(state({processConflicts:{phase:'blocked',canContinue:false,current:{id:'private-current-id',pid:709,owner:'current',scope:'current-window',credentialScopeVerified:true,parentState:'alive',taskState:'unknown',canEnd:false},processes:[row]},processSwitchTarget:'target@example.test'}),'nonce');
 assert.match(html,/后台原窗口归属未确定/);assert.match(html,/祖先进程属于不同系统用户/);
 assert.match(html,/已核验同用户、官方程序及同认证范围/);
 assert.match(html,/data-command="live.processEnd" data-id="selected-synthetic-710" class=/);
 assert.ok(!html.includes('private-current-id'));assert.ok(!html.includes('pidfd'));
 const unverified=renderWorkbench(state({processConflicts:{phase:'blocked',canContinue:false,limitation:'ownership',processes:[{...row,credentialScopeVerified:false,credentialScopeReason:'unsupported-launch-flags'}]}}),'nonce');
 assert.match(unverified,/尚未核实的自定义启动选项/);assert.match(unverified,/antigravity\.serverArgs/);assert.match(unverified,/data-command="live.processEnd" data-id="selected-synthetic-710" disabled/);
});
test('conflict list shows PID, birth, ownership uncertainty and the intended switch without private proof',()=>{
 const processConflicts={phase:'blocked',canContinue:false,processes:[{id:'opaque-selection',pid:710,parentPid:702,startedAt:'2026-10-08T11:00:00Z',owner:'other',parentState:'alive',taskState:'unknown',canEnd:true,credentialScopeVerified:true}]};
 let html=renderWorkbench(state({processConflicts,processSwitchTarget:'target@example.test'}),'nonce');
 assert.match(html,/PID 710/);assert.match(html,/父进程：702/);assert.match(html,/原窗口未知/);assert.match(html,/任务状态未知/);assert.match(html,/target@example.test/);assert.match(html,/data-command="live.processScan"/);assert.match(html,/data-command="live.processEnd" data-id="opaque-selection"/);
 assert.doesNotMatch(html,/commandHash|csrfToken|startTicks|bootId/);
 html=renderWorkbench(state({processConflicts:{...processConflicts,limitation:'platform',processes:[{...processConflicts.processes[0],canEnd:false}]}}),'nonce');assert.match(html,/暂不支持安全结束/);assert.match(html,/data-command="live.processEnd" data-id="opaque-selection" disabled/);
 html=renderWorkbench(state({processConflicts:{phase:'clear',canContinue:true,processes:[]},processSwitchTarget:'target@example.test'}),'nonce');assert.match(html,/data-command="live.processContinue"/);
});
test('conflict actions explain Windows force and unavailable platform dependencies',()=>{
 const processConflicts={phase:'blocked',canContinue:false,processes:[{id:'opaque-selection',pid:710,parentPid:702,startedAt:'2026-10-08T11:00:00Z',owner:'other',parentState:'alive',taskState:'unknown',canEnd:true,credentialScopeVerified:true,endMode:'force'}]};
 let html=renderWorkbench(state({processConflicts}),'nonce');
 assert.match(html,/强制结束此后台/);
 html=renderWorkbench(state({processConflicts,processSwitchTarget:'target@example.test'}),'nonce');assert.match(html,/强制结束此后台并切号/);
 for(const [limitation,explanation] of [['windows-helper',/系统 PowerShell/],['helper',/python3/]]){
  html=renderWorkbench(state({processConflicts:{...processConflicts,limitation,processes:[{...processConflicts.processes[0],canEnd:false}]}}),'nonce');
  assert.match(html,explanation);assert.match(html,/data-command="live.processEnd" data-id="opaque-selection" disabled/);
 }
});
test('capture shares the add toolbar and saved is disabled only for a verified unique host identity',()=>{
 const base={accounts:[{...account,hostCurrent:true}],activeEmail:account.expectedEmail,activeVerifiedAt:new Date().toISOString(),currentLoginSave:'saved'};
 let html=renderWorkbench(state(base),'nonce');assert.match(html,/<div class="account-toolbar"[^>]*>[^]*?data-command="live.login"[^]*?data-command="live.capture" disabled[^]*?已保存[^]*?<\/div>/);
 html=renderWorkbench(state({...base,activeEmail:undefined}),'nonce');assert.match(html,/data-command="live.capture" class=[^>]*>保存当前账号/);
 html=renderWorkbench(state({...base,currentLoginSave:'update'}),'nonce');assert.match(html,/data-command="live.capture" class=[^>]*>更新凭证/);
 html=renderWorkbench(state({...base,accounts:[...base.accounts,{...account,hostCurrent:true,id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}]}),'nonce');assert.match(html,/data-command="live.capture" class=[^>]*>保存当前账号/);
});
test('ordinary workbench omits technical failure history while retaining user recovery actions',()=>{
 const lastFailure={schema:1,at:'2026-10-03T16:00:00.000Z',action:'switch',stage:'reconnect',phase:'installed',code:'OFFICIAL_COMPONENT_RECONNECT_FAILED',token:'synthetic-secret'};
 const html=renderWorkbench(state({lastFailure,pending:true,recoveryPhase:'installed'}),'nonce');
 assert.doesNotMatch(html,/上次账号操作失败|OFFICIAL_COMPONENT_RECONNECT_FAILED|synthetic-secret/);assert.match(html,/data-command="live.verify"/);
});
test('empty workbench has visible login and image actions without warning wall', () => {
 const html = renderWorkbench(state(), 'nonce');
 for (const command of ['live.login', 'live.capture', 'images.open']) assert.match(html, new RegExp(`data-command="${command}"`));
 assert.match(html, /添加你的第一个账号/);
 assert.doesNotMatch(html, /非官方|脱敏|实验性|LOCAL_TRUSTED_DESKTOP_REQUIRED/);
 assert.match(html, /default-src 'none'/);
 assert.match(html, /style-src 'nonce-nonce'/);
});
test('saved accounts expose account-specific actions and escape metadata', () => {
 const html = renderWorkbench(state({ accounts: [{ ...account, label: '<img src=x onerror=bad()>' }] }), 'nonce');
 assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/);
 assert.doesNotMatch(html, /<img src=x/);
 assert.match(html, new RegExp(`data-command="live.switch" data-id="${account.id}"`));
 assert.match(html, /1 个已保存/);
 assert.doesNotMatch(html, /当前已登录|当前账户：Example/);
});
test('pending recovery is actionable and busy actions disabled', () => {
 const html = renderWorkbench(state({ pending: true, recoveryPhase: 'installed', busy: true, status: '正在保存登录' }), 'nonce');
 assert.match(html, /data-command="live.verify" disabled/);
 assert.match(html, /data-command="live.restore" disabled/);
 assert.match(html, /正在保存登录/);
});
test('environment blockers have helpful text and do not hide independent tools', () => {
 const html = renderWorkbench(state({ environment: { available: false, message: '请在本机安装 Antigravity 扩展' } }), 'nonce');
 assert.match(html, /data-command="live.login" disabled/);
 assert.match(html, /请在本机安装 Antigravity 扩展/);
 assert.match(html, /data-command="images.open"/);
});
function fixture(extra = {}) {
 let message, closed;
 const posted = [];
 const webview = { html: '', options: {}, onDidReceiveMessage(fn) { message = fn; return { dispose() {} }; }, async postMessage(value) { posted.push(value); } };
 const view = { webview, onDidDispose(fn) { closed = fn; return { dispose() {} }; } };
 const provider = new WorkbenchView(() => state({ accounts: [account], ...extra }));
 provider.resolveWebviewView(view);
 return { provider, webview, posted, message: value => message(value), close: () => closed() };
}
test('process messages require a current opaque selection and reject arbitrary PID, paths, signals and stale views',async()=>{
 calls.length=0;const processConflicts={phase:'blocked',canContinue:false,processes:[{id:'opaque-selection',pid:710,parentPid:702,owner:'other',parentState:'alive',taskState:'unknown',canEnd:true,credentialScopeVerified:true}]};
 const f=fixture({processConflicts});
 for(const payload of [{command:'live.processEnd',pid:710},{command:'live.processEnd',processId:710},{command:'live.processEnd',processId:'wrong'},{command:'live.processEnd',processId:'opaque-selection',signal:'SIGKILL'},{command:'live.processScan',processId:'opaque-selection'},{command:'live.processEnd',processId:'opaque-selection',path:'/synthetic/agy'}])await f.message(payload);
 assert.equal(calls.length,0);await f.message({command:'live.processEnd',processId:'opaque-selection'});await f.message({command:'live.processScan'});
 assert.deepEqual(calls,[['antigravityAccounts.live.processEnd','opaque-selection'],['antigravityAccounts.live.processScan']]);
 f.provider.dispose();await f.message({command:'live.processEnd',processId:'opaque-selection'});assert.equal(calls.length,2);
});
test('webview routes only known actions and stored account ids', async () => {
 calls.length = 0;
 const f = fixture();
 await f.message({ command: 'workbench.action.terminal.new' });
 await f.message({ command: 'live.switch', accountId: 'not-stored' });
 await f.message({ command: 'images.open', accountId: account.id });
 assert.equal(calls.length, 0);
 await f.message({ command: 'live.switch', accountId: account.id });
 assert.deepEqual(calls, [['antigravityAccounts.live.switch', account.id]]);
 assert.equal(f.webview.options.enableScripts, true);
 assert.deepEqual(f.webview.options.localResourceRoots, []);
 f.provider.dispose();
 await f.message({ command: 'images.open' });
 assert.equal(calls.length, 1);
});
test('duplicate button messages do not launch concurrent flows; dismissal releases UI', async () => {
 calls.length = 0;
 let release;
 execute = (...args) => { calls.push(args); return new Promise(resolve => { release = resolve; }); };
 const f = fixture();
 const first = f.message({ command: 'live.login' });
 await f.message({ command: 'live.login' });
 assert.equal(calls.length, 1);
 release(); await first;
 assert.equal(f.posted.at(-1).type, 'complete');
 execute = async (...args) => { calls.push(args); };
 await f.message({ command: 'images.open' });
 assert.equal(calls.length, 2);
 f.close(); f.provider.refresh(); f.provider.dispose();
});
test('missing official extension disables account operations while retaining independent tools and removal', () => {
 const html = renderWorkbench(state({ accounts: [account], official: { available: false, message: '请先安装 Google Antigravity' } }), 'nonce');
 assert.match(html, /data-command="live.login" disabled/);
 assert.match(html, new RegExp(`data-command="live.switch" data-id="${account.id}" disabled`));
 assert.match(html, new RegExp(`data-command="live.remove" data-id="${account.id}" class`));
 assert.match(html, /data-command="openSettings"/);
 assert.match(html, /data-command="recheck"/);
 assert.match(html, /请先安装 Google Antigravity/);
});
test('pending account recovery blocks new mutations and image tasks but leaves verification and recovery reachable', () => {
 const html = renderWorkbench(state({ pending: true, recoveryPhase: 'installed', accounts: [account], status: '请确认当前登录' }), 'nonce');
 assert.match(html, /data-command="live.login" disabled/);
 assert.match(html, new RegExp(`data-command="live.switch" data-id="${account.id}" disabled`));
 assert.match(html, /data-command="images.open" disabled/);
 assert.match(html, /data-command="live.verify" class/);
 assert.match(html, /data-command="live.restore" class/);
});
test('an in-flight command acknowledges a click from a reloaded webview without running another action', async () => {
 calls.length = 0;
 let release;
 execute = (...args) => { calls.push(args); return new Promise(resolve => { release = resolve; }); };
 const f = fixture();
 const first = f.message({ command: 'live.login' });
 f.provider.refresh();
 await f.message({ command: 'images.open' });
 assert.equal(calls.length, 1);
 assert.equal(f.posted.at(-1).type, 'complete');
 release(); await first;
 execute = async (...args) => { calls.push(args); };
 f.provider.dispose();
});

test('release workbench contains accounts, images and standard settings, no host tool foldout', () => {
 const html=renderWorkbench(state({official:{available:true,message:'synthetic-backend-location'}}),'nonce');
 assert.doesNotMatch(html,/运行环境与文件位置|synthetic-backend-location|id="host-details"|data-command="openHostSettings"|data-command="locations\./);
 assert.match(html,/data-command="openSettings"/);assert.match(html,/<span class="version">版本未知<\/span>/);
 const blocked=renderWorkbench(state({official:{available:false,message:'请安装官方扩展'}}),'nonce');assert.match(blocked,/请安装官方扩展/);assert.match(blocked,/data-command="recheck"/);
});
test('host and account text wrap safely and never become executable markup', () => {
 const text = '<script>alert("example")</script>' + '/a-long-synthetic-home-path'.repeat(12);
 const html = renderWorkbench(state({ accounts: [{ ...account, expectedEmail: 'long-'.repeat(40) + '@example.test' }], environment: { available: true, message: text }, official: { available: false, message: text } }), 'nonce');
 assert.doesNotMatch(html, /<script>alert/);
 assert.match(html, /&lt;script&gt;alert\(&quot;example&quot;\)&lt;\/script&gt;/);
 assert.match(html, /overflow-wrap:anywhere/);
 assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(html, /\.account-copy\{min-width:0\}/);
 assert.match(html, /@media\(max-width:190px\)/);
 assert.match(html, /@media\(max-width:270px\)/);
 assert.match(html, /@media\(max-width:190px\)/);
 assert.doesNotMatch(html, /overflow(?:-y)?:hidden|height:100vh|min-width:120px/);
});
test('legacy and foreign-host cards explain unavailable switching while retaining removal', () => {
 for (const extra of [{ hostCurrent: false }, { hostCurrent: false, hostId: 'other-host-fixture' }]) {
  const html = renderWorkbench(state({ accounts: [{ ...account, ...extra }] }), 'nonce');
  assert.match(html, new RegExp(`data-command="live.switch" data-id="${account.id}" disabled`));
  assert.match(html, new RegExp(`data-command="live.remove" data-id="${account.id}" class`));
  assert.match(html, extra.hostId ? /其他运行位置的登录，请回到原宿主切换/ : /此记录未绑定位置，请在当前宿主重新保存/);
 }
 const current = renderWorkbench(state({ accounts: [{ ...account, hostCurrent: true, hostId: 'current-host-fixture' }] }), 'nonce');
 assert.match(current, new RegExp(`data-command="live.switch" data-id="${account.id}" class`));
 assert.match(current, /已保存在此运行位置/);
 assert.doesNotMatch(current, /其他运行位置的登录|此记录未绑定位置/);
});
test('host setup buttons route through the explicit allowlist and reject injected arguments', async () => {
 calls.length = 0; const f = fixture();
 for (const command of ['openHostSettings', 'openWorkbenchExtension', 'openOfficialExtension', 'recheck']) await f.message({ command });
 assert.deepEqual(calls, ['openHostSettings', 'openWorkbenchExtension', 'openOfficialExtension', 'recheck'].map(command => [`antigravityAccounts.${command}`]));
 await f.message({ command: 'openHostSettings', accountId: account.id });
 await f.message({ command: 'openAnythingElse' });
 assert.equal(calls.length, 4); f.provider.dispose();
});
test('crafted webview messages cannot switch an account marked for another host', async () => {
 calls.length = 0; const f = fixture({ accounts: [{ ...account, hostCurrent: false }] });
 await f.message({ command: 'live.switch', accountId: account.id });
 assert.equal(calls.length, 0); assert.equal(f.posted.at(-1).type, 'complete');
 await f.message({ command: 'live.remove', accountId: account.id });
 assert.deepEqual(calls, [['antigravityAccounts.live.remove', account.id]]); f.provider.dispose();
});
test('WSL exposes OAuth and capture once and never shows irrelevant recovery buttons', () => {
 for (const accounts of [[], [{ ...account, hostCurrent: true }]]) {
  const html = renderWorkbench(state({ storageMode: 'wsl-file', accounts }), 'nonce');
  assert.match(html, /data-command="live.capture" class="secondary"/);
  assert.match(html, /data-command="live.login" class="primary"/);
  assert.equal((html.match(/data-command="live.capture"/g) || []).length, 1);
  assert.doesNotMatch(html, /切换前自动检查存储兼容性|运行环境与文件位置/);
  assert.doesNotMatch(html, /codex/iu);
  assert.doesNotMatch(html, /data-command="live.restore"|data-command="live.verify"/);
 }
});

test('migration actions are visible, native-host scoped and independent of the official extension', () => {
 const html = renderWorkbench(state({ accounts: [{ ...account, hostCurrent: true }], official: { available: false, message: '未安装官方扩展' } }), 'nonce');
 assert.match(html, /data-command="live.export" class/); assert.match(html, /data-command="live.import" class/);
 assert.match(html, /aria-label="账户迁移"/); assert.match(html, /@media\(max-width:270px\)/);
 const foreign = renderWorkbench(state({ accounts: [{ ...account, hostCurrent: false }] }), 'nonce'); assert.match(foreign, /data-command="live.export" disabled/); assert.match(foreign, /data-command="live.import" class/);
 for (const extra of [{ busy: true }, { pending: true }, { environment: { available: false, message: '不可用' } }]) {
  const blocked = renderWorkbench(state({ accounts: [{ ...account, hostCurrent: true }], ...extra }), 'nonce');
  assert.match(blocked, /data-command="live.export" disabled/); assert.match(blocked, /data-command="live.import" disabled/);
 }
});
test('imported cards retain a distinct verification warning regardless of label or claimed identity', () => {
 const html = renderWorkbench(state({ accounts: [{ ...account, label: '已验证账户', identitySource: 'hub', hostCurrent: true, migrationState: 'pending' }] }), 'nonce');
 assert.match(html, /class="account-migration-warning">旧版导入账号尚未核验，可重新导入以查询身份和额度/);
 assert.match(html, new RegExp(`data-command="live.switch" data-id="${account.id}" class`));
 const verified = renderWorkbench(state({ accounts: [{ ...account, migrationState: 'verified', hostCurrent: true }] }), 'nonce'); assert.match(verified, /已在此运行位置核验（导入）/);
});
test('migration webview actions send no account data, passwords, paths or tokens to commands', async () => {
 calls.length = 0; const f = fixture();
 await f.message({ command: 'live.export', password: 'synthetic-password', token: 'synthetic-token', path: '/private/path' });
 await f.message({ command: 'live.import', password: 'synthetic-password', token: 'synthetic-token', path: '/private/path' });
 assert.deepEqual(calls, []);
 await f.message({ command: 'live.export' }); await f.message({ command: 'live.import' }); assert.deepEqual(calls, [['antigravityAccounts.live.export'], ['antigravityAccounts.live.import']]);
 await f.message({ command: 'live.export', accountId: account.id }); await f.message({ command: 'live.import', accountId: account.id }); assert.equal(calls.length, 2); f.provider.dispose();
});

test('a verified imported copy from another host never claims verification at this location', () => {
 const html = renderWorkbench(state({ accounts: [{ ...account, migrationState: 'verified', hostCurrent: false, hostId: 'another-host' }] }), 'nonce');
 assert.match(html, /已在原运行位置核验/); assert.doesNotMatch(html, /已在此运行位置核验（导入）/);
});


test('every saved account has its own quota action and renders values only below that account',()=>{
 const snapshot={source:'server',email:account.expectedEmail,observedAt:'2026-10-01T00:00:00.000Z',buckets:[{label:'Gemini',remaining:0.5,resetAt:null},{label:'Unknown model',remaining:null,resetAt:null}]};
 const html=renderWorkbench(state({accounts:[{...account,quota:{phase:'ready',snapshot}},{...account,id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',expectedEmail:'second@example.test'}]}),'nonce');
 const cards=html.match(/<article class="account">[\s\S]*?<\/article>/g);assert.equal(cards.length,2);
 assert.match(cards[0],/data-command="live.quota" data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/);assert.match(cards[0],/50%/);assert.match(cards[0],/Unknown model/);assert.match(cards[0],/未知/);assert.match(cards[0],/服务端查询/);
 assert.doesNotMatch(cards[1],/50%|Gemini/);assert.match(cards[1],/尚未查询/);assert.doesNotMatch(html,/查看当前账户与配额/);
});
test('quota missing data, loading, failure and mismatched identity remain explicit inline',()=>{
 for(const [phase,message]of [['loading',''],['error','后台超时，请重试'],['mismatch','此账号不是后台返回邮箱，请先切换']]){
  const html=renderWorkbench(state({accounts:[{...account,quota:{phase,message,snapshot:{source:'server',email:account.expectedEmail,observedAt:'2026-10-01T00:00:00.000Z',buckets:[]}}}]}),'nonce');
  assert.match(html,/上次结果/);assert.match(html,/服务端未返回可用额度/);assert.doesNotMatch(html.slice(html.indexOf('<body>')),/100%/);
  if(phase==='loading')assert.match(html,/取消查询/);else assert.ok(html.includes(message));
 }
});
test('OAuth add has one exact visible label in empty, populated, native, WSL and capture-only cases',()=>{
 for(const accounts of [[],[account]])for(const storageMode of ['native-keyring','wsl-file'])for(const captureOnly of [false,true]){
  const html=renderWorkbench(state({accounts,storageMode,...(captureOnly?{loginMutationAvailable:false}: {})}),'nonce');
  const section=html.slice(html.indexOf('<body>'));
  assert.match(section,/data-command="live.login"[^>]*>添加账号<\/button>/);assert.match(section,/title="添加账号（OAuth 登录）"/);
  if(captureOnly){assert.match(section,/data-command="live.login" disabled/);assert.match(section,/配置并解锁系统密钥库/);assert.match(section,/data-command="recheck"/)}
 }
});
test('quota action routing requires stored IDs and rejects duplicate legacy and wrong-host requests', async () => {
 calls.length = 0; const f = fixture();
 await f.message({ command: 'live.quota', accountId: account.id });
 for (const value of [{ command: 'refresh', accountId: account.id }, { command: 'live.quota' }, { command: 'live.quota', accountId: 'unknown' }]) await f.message(value);
 assert.deepEqual(calls, [['antigravityAccounts.live.quota', account.id]]); f.provider.dispose();
 const foreign = fixture({ accounts: [{ ...account, hostCurrent: false }] }); await foreign.message({ command: 'live.quota', accountId: account.id }); assert.equal(calls.length, 1); foreign.provider.dispose();
});
test('an unsaved current identity gets a save hint, never a duplicate quota action or card', () => {
 const html = renderWorkbench(state({ accounts: [account], currentQuota: { phase: 'ready', message: '未保存 <script>', snapshot: { source: 'server', email: '<unknown>@example.test', observedAt: 'bad', buckets: [{ label: 'unrelated model', remaining: 1, resetAt: 'bad' }] } } }), 'nonce');
 assert.match(html, /&lt;unknown&gt;@example.test/); assert.match(html, /尚未保存在这里/);
 assert.equal((html.match(/data-command="live.quota"/g) || []).length, 1);
 assert.equal((html.match(/<article class="account">/g) || []).length, 1);
 assert.doesNotMatch(html.slice(html.indexOf('<body>')), /unrelated model|100%|<unknown>|<script>/);
 const saved = renderWorkbench(state({ accounts: [account], currentQuota: { phase: 'ready', snapshot: { source: 'server', email: account.expectedEmail, observedAt: 'bad', buckets: [] } } }), 'nonce');
 assert.doesNotMatch(saved, /尚未保存在这里/);
});
test('quota model and message strings are escaped and invalid timestamps stay unknown', () => {
 const html = renderWorkbench(state({ accounts: [{ ...account, quota: { phase: 'ready', message: '<script>danger</script>', snapshot: { source: 'server', email: account.expectedEmail, observedAt: 'bad', buckets: [{ label: '<img src=x>', remaining: null, resetAt: 'bad' }] } } }] }), 'nonce');
 assert.match(html, /&lt;img src=x&gt;/); assert.match(html, /&lt;script&gt;/); assert.match(html, /服务端查询<\/span><span title="最后同步时间">同步 未知/);
 assert.doesNotMatch(html, /<img src=x>|<script>danger/);
});

test('server quota units and disabled buckets are rendered without inventing percentages',()=>{
 const html=renderWorkbench(state({accounts:[{...account,quota:{phase:'ready',snapshot:{source:'server',email:account.expectedEmail,observedAt:'2026-10-01T00:00:00.000Z',buckets:[{label:'Credits',remaining:null,remainingAmount:'200',resetAt:null},{label:'Unavailable',remaining:1,disabled:true,resetAt:null}]}}}]}),'nonce');
 assert.match(html,/服务端查询/);assert.match(html,/<b>200<\/b>/);assert.match(html,/不可用/);assert.doesNotMatch(html.slice(html.indexOf('<body>')),/200%|100%|<progress/);
});

test('cancel quota remains reachable while the query command is running',async()=>{
 calls.length=0;let release;execute=(...args)=>{calls.push(args);return args[0]==='antigravityAccounts.live.quota'?new Promise(r=>release=r):Promise.resolve()};const f=fixture();
 const pending=f.message({command:'live.quota',accountId:account.id});await f.message({command:'live.quotaCancel'});assert.deepEqual(calls,[['antigravityAccounts.live.quota',account.id],['antigravityAccounts.live.quotaCancel']]);release();await pending;execute=async(...args)=>{calls.push(args)};f.provider.dispose();
});

test('quota dispatch failures are inline and never become warning notifications',async()=>{
 calls.length=0;warnings.length=0;execute=async()=>{throw Error('transport failure with synthetic secret')};const f=fixture();
 for(const command of ['live.quota','live.quotaCancel']){await f.message({command,...(command==='live.quota'?{accountId:account.id}:{})});assert.deepEqual(warnings,[]);assert.match(f.webview.html,/配额查询|无法取消/);assert.doesNotMatch(f.webview.html,/synthetic secret/);assert.equal(f.posted.at(-1).type,'complete')}
 execute=async(...args)=>{calls.push(args)};f.provider.dispose();
});


test('recovery renders and routes only actions supported by the exact journal phase', async () => {
 for (const phase of ['checking', 'none', 'authorizing', 'prepared', 'installed', 'restored', 'locked', 'unavailable']) {
  const extra = { recoveryPhase: phase, pending: phase !== 'none', status: `恢复阶段 ${phase}` };
  const html = renderWorkbench(state(extra), 'nonce');
  const verify = ['installed', 'restored'].includes(phase), restore = ['authorizing', 'prepared', 'installed', 'restored'].includes(phase);
  assert.equal((html.match(/data-command="live.verify"/g) || []).length, Number(verify), phase);
  assert.equal((html.match(/data-command="live.restore"/g) || []).length, Number(restore), phase);
  assert.doesNotMatch(html, /data-command="live.unlock"|检查操作锁|更多工具/);
  if (phase === 'restored') assert.match(html, /重载后自动检查/);
  if (phase === 'authorizing' || phase === 'prepared') assert.match(html, /继续恢复原登录/);
  calls.length = 0; const f = fixture(extra);
  await f.message({ command: 'live.verify' }); await f.message({ command: 'live.restore' });
  assert.deepEqual(calls, [...(verify ? [['antigravityAccounts.live.verify']] : []), ...(restore ? [['antigravityAccounts.live.restore']] : [])], phase);
  f.provider.dispose();
 }
});
test('homepage has coherent sections, account migration, and no snapshot or duplicate quota tools', async () => {
 const html = renderWorkbench(state({ accounts: [account], snapshots: [{ label: 'Legacy snapshot label', identity: 'legacy@example.test' }] }), 'nonce');
 for (const id of ['accounts-heading', 'images-heading']) assert.match(html, new RegExp(`aria-labelledby="${id}"`));
 assert.match(html, /账号导出与导入/); assert.match(html, /导出账号（加密）/); assert.match(html, /导入账号（加密）/); assert.doesNotMatch(html, /将已保存账号加密为|导入需要导出时设置的密码/);
 for (const text of ['更多工具', '导入快照', '读取快照', '查询当前登录配额', 'Legacy snapshot label', '检查操作锁']) assert.ok(!html.includes(text), text);
 for (const command of ['live.login', 'live.capture', 'live.quota', 'images.open', 'live.import', 'live.export']) assert.equal((html.match(new RegExp(`data-command="${command}"`, 'g')) || []).length, 1, command);
 calls.length = 0; const f = fixture();
 for (const command of ['refresh', 'importSnapshot', 'reloadSnapshots', 'openBridgeGuide', 'live.unlock']) await f.message({ command });
 assert.deepEqual(calls, []); f.provider.dispose();
});
test('legacy commands stay contributed but are hidden from the normal command palette', () => {
 const pkg = require('../package.json');
 for (const command of ['refresh', 'importSnapshot', 'reloadSnapshots', 'openBridgeGuide', 'live.unlock', 'addAccount', 'removeAccount']) {
  const id = `antigravityAccounts.${command}`;
  assert.ok(pkg.contributes.commands.some(entry => entry.command === id), `${id} kept for compatibility`);
  assert.ok(pkg.contributes.menus.commandPalette.some(entry => entry.command === id && entry.when === 'false'), `${id} hidden`);
 }
 assert.ok(!pkg.contributes.menus.commandPalette.some(entry => entry.command === 'antigravityAccounts.live.quota' && entry.when === 'false'));
});
test('wide layout uses available space and narrow layout keeps the version badge', () => {
 const html = renderWorkbench(state(), 'nonce');
 assert.match(html, /main\{width:100%;min-width:0\}/);
 assert.doesNotMatch(html, /max-width:760px|\.version\{display:none/);
});

test('stale verification clicks after recovery changes never dispatch a no-switch command', async () => {
 calls.length = 0; const current = { pending: true, recoveryPhase: 'installed', status: '待确认' }; const f = fixture(current);
 current.recoveryPhase = 'none'; current.pending = false;
 await f.message({ command: 'live.verify' }); await f.message({ command: 'live.restore' });
 assert.deepEqual(calls, []); assert.doesNotMatch(f.webview.html, /data-command="live.verify"|data-command="live.restore"/); f.provider.dispose();
});
test('restored confirmation stays reachable when credential mutations are unavailable', () => {
 const html = renderWorkbench(state({ pending: true, recoveryPhase: 'restored', loginMutationAvailable: false, status: '原登录已恢复' }), 'nonce');
 assert.match(html, /data-command="live.restore" class="secondary">重载后自动检查/);
 assert.match(html, /data-command="live.login" disabled/);
});

test('remove is a direct account button and cached login model metadata is never shown as quota',()=>{
 const html=renderWorkbench(state({accounts:[{...account,quota:{phase:'ready',snapshot:{email:account.expectedEmail,source:'hub-status',observedAt:'2026-10-01',buckets:[{label:'Cached login clutter',remaining:1,resetAt:null}]}}}]}),'nonce');
 assert.match(html,/<div class="account-actions"[^>]*>[^]*?data-command="live.remove"[^]*?>移除<\/button><\/div>/);
 assert.doesNotMatch(html,/管理账号|Cached login clutter|hub 绑定身份|可能缓存/);
 assert.match(html,/尚未查询/);
});
test('independent saved-account quota remains enabled with official extension missing',()=>{
 const html=renderWorkbench(state({accounts:[account],official:{available:false,message:'未安装'}}),'nonce');
 assert.match(html,new RegExp(`data-command="live.quota" data-id="${account.id}" class`));assert.match(html,/data-command="live.switch"[^>]*disabled/);
});

test('current badge comes only from verified active identity on the same host',()=>{
 const saved={...account,hostCurrent:true};const body=extra=>renderWorkbench(state({accounts:[saved],...extra}),'nonce').split('<body>')[1];
 assert.doesNotMatch(body({}),/current-badge/);assert.match(body({}),/当前登录待核验/);
 const verified=body({activeEmail:account.expectedEmail.toUpperCase()});assert.match(verified,/<article class="account active">/);assert.match(verified,/<span class="current-badge">（当前登录）<\/span>/);assert.match(verified,/data-command="live.switch"[^>]*disabled/);
 for(const extra of [{activeEmail:'other@example.test'},{activeEmail:account.expectedEmail,pending:true},{activeEmail:account.expectedEmail,accounts:[{...saved,hostCurrent:false}]},{activeEmail:account.expectedEmail,accounts:[{...account}]}])assert.doesNotMatch(body(extra),/current-badge/);
});
test('independent quota for B never labels B active when official identity is A',()=>{
 const second={...account,id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',hostCurrent:true,expectedEmail:'b@example.test',quota:{phase:'ready',snapshot:{source:'server',email:'b@example.test',observedAt:'2026-10-01',buckets:[]}}};
 const html=renderWorkbench(state({accounts:[{...account,hostCurrent:true},second],activeEmail:account.expectedEmail}),'nonce');
 const cards=html.match(/<article class="account(?: active)?">[\s\S]*?<\/article>/g);assert.match(cards[0],/current-badge/);assert.doesNotMatch(cards[1],/current-badge/);assert.match(cards[1],/服务端查询/);
});
test('compact card has exactly one direct switch, refresh and removal with account-scoped accessible names',()=>{
 const html=renderWorkbench(state({accounts:[{...account,hostCurrent:true}]}),'nonce');const card=html.match(/<article class="account">[\s\S]*?<\/article>/)[0];
 for(const command of ['live.switch','live.quota','live.remove'])assert.equal((card.match(new RegExp(`data-command="${command}"`,'g'))||[]).length,1);
 assert.match(card,/aria-label="刷新 example@example.test 的配额"/);assert.match(card,/>刷新<\/button>/);assert.match(card,/>移除<\/button>/);
 assert.ok(card.indexOf('account-quota')<card.indexOf('account-actions'));assert.match(html,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});
test('quota bars show low, medium and healthy states with explicit values and reset times',()=>{
 const html=renderWorkbench(state({accounts:[{...account,quota:{phase:'ready',snapshot:{source:'server',email:account.expectedEmail,observedAt:'2026-10-01T03:00:00Z',buckets:[{label:'Low',remaining:0.08,resetAt:'2026-10-01T05:00:00Z'},{label:'Medium',remaining:0.3,resetAt:null},{label:'Healthy',remaining:0.88,resetAt:null}]}}}]}),'nonce').split('<body>')[1];
 for(const tone of ['low','medium','healthy'])assert.match(html,new RegExp(`class="quota-row ${tone}"`));
 assert.match(html,/>8%<\/b>/);assert.match(html,/aria-label="Low 剩余 8%"/);assert.match(html,/重置 /);assert.match(html,/最后同步时间/);assert.match(html,/服务端查询/);
});
test('cross-account quota snapshots cannot leak into another account card',()=>{
 const html=renderWorkbench(state({accounts:[{...account,quota:{phase:'ready',snapshot:{source:'server',email:'other@example.test',observedAt:'2026-10-01',buckets:[{label:'Wrong account model',remaining:0.77,resetAt:null}]}}}]}),'nonce').split('<body>')[1];
 assert.doesNotMatch(html,/Wrong account model|77%|<progress/);assert.match(html,/结果邮箱不匹配/);assert.match(html,/data-command="live.quota"/);
});
test('backup and import stay directly available under a clear title without long explanation',()=>{
 const html=renderWorkbench(state({accounts:[{...account,hostCurrent:true}]}),'nonce').split('<body>')[1];
 const tools=html.slice(html.indexOf('class="account-tools"'),html.indexOf('class="current-status'));
 for(const command of ['live.export','live.import'])assert.match(tools,new RegExp(`data-command="${command}"`));
 assert.match(tools,/>导出账号<\/button>/);assert.match(tools,/>导入账号<\/button>/);assert.match(html,/账号导出与导入/);assert.doesNotMatch(html,/<details class="account-transfer"/);
});
test('verified current identity outside saved accounts is visible without marking any card active',()=>{
 const html=renderWorkbench(state({accounts:[{...account,hostCurrent:true}],activeEmail:'unsaved@example.test'}),'nonce').split('<body>')[1];
 assert.match(html,/当前登录：unsaved@example.test（未保存）/);assert.doesNotMatch(html,/current-badge/);assert.match(html,/data-command="live.capture"/);
});
test('refresh and identity verification stages use exactly one inline loading line',()=>{
 for(const message of ['正在安全刷新此账号登录…','正在核验并保存刷新结果…','正在查询此账号配额…']){
  const html=renderWorkbench(state({accounts:[{...account,quota:{phase:'loading',message}}]}),'nonce').split('<body>')[1];
  assert.equal((html.match(/class="quota-message loading-label"/g)||[]).length,1);assert.equal(html.split(message).length-1,1);assert.doesNotMatch(html,/正在查询此账号…/);assert.match(html,/data-command="live.quotaCancel"/);
 }
});
test('current identity verification time is optional and never borrowed from quota sync',()=>{
 const base={accounts:[{...account,hostCurrent:true}],activeEmail:account.expectedEmail};
 assert.doesNotMatch(renderWorkbench(state(base),'nonce').split('<body>')[1],/最近核验/);
 assert.match(renderWorkbench(state({...base,activeVerifiedAt:'2026-10-01T03:00:00Z'}),'nonce').split('<body>')[1],/title="最近核验：/);
});

test('ordinary workbench never renders technical paths or path tools',()=>{
 const locations={host:'WSL',extensionPath:'/home/synthetic/<script>',credentialPath:'/synthetic/token-file',imageOutputPath:'/project/images',canOpenExtension:true};
 const html=renderWorkbench(state({locations}),'nonce');
 assert.doesNotMatch(html,/运行环境与文件位置|\/home\/synthetic|\/synthetic\/token-file|data-command="locations\./);
});
test('location webview commands reject injected paths, URIs and account arguments',async()=>{
 calls.length=0;const f=fixture();
 for(const payload of [{command:'locations.copyExtension',path:'/private'}, {command:'locations.openExtension',uri:{scheme:'https',authority:'bad'}}, {command:'locations.copyCredentials',accountId:account.id},{command:'locations.openExtension',args:['file:///private']}])await f.message(payload);
 assert.equal(calls.length,0);await f.message({command:'locations.copyExtension'});await f.message({command:'locations.openExtension'});assert.deepEqual(calls,[['antigravityAccounts.locations.copyExtension'],['antigravityAccounts.locations.openExtension']]);f.provider.dispose();
});

test('ordinary workbench has no debug controls even when a log path exists',()=>{
 const debug={enabled:true,available:true,directory:'/synthetic/private-log-path',canOpen:true,host:'local',storageUnavailable:true};
 const html=renderWorkbench(state({debug}),'nonce');assert.doesNotMatch(html,/private-log-path|预览 \/ 导出日志|调试模式|data-command="debug\./);
});
test('debug commands reject injected arguments and toggle can interrupt a running command',async()=>{
 calls.length=0;const f=fixture();for(const payload of [{command:'debug.toggle',accountId:account.id},{command:'debug.preview',path:'/secret'},{command:'debug.openDirectory',uri:'https://example.test'}])await f.message(payload);assert.equal(calls.length,0);
 let release;execute=(...args)=>{calls.push(args);return args[0].endsWith('live.login')?new Promise(r=>release=r):Promise.resolve();};const first=f.message({command:'live.login'});await f.message({command:'debug.toggle'});assert.deepEqual(calls,[['antigravityAccounts.live.login'],['antigravityAccounts.debug.toggle']]);release();await first;execute=async(...args)=>calls.push(args);f.provider.dispose();
});
test('help and log preview remain available during a blocked workflow; duplicate help is coalesced',async()=>{
 calls.length=0;let releaseLogin,releaseHelp;
 execute=(...args)=>{calls.push(args);return args[0].endsWith('live.login')?new Promise(r=>releaseLogin=r):args[0].endsWith('openHelp')?new Promise(r=>releaseHelp=r):Promise.resolve();};
 const f=fixture();const login=f.message({command:'live.login',requestId:'a-1'});
 const help=f.message({command:'openHelp',requestId:'a-2'});
 await f.message({command:'openHelp',requestId:'a-3'});
 await f.message({command:'debug.preview',requestId:'a-4'});
 assert.deepEqual(calls,[['antigravityAccounts.live.login'],['antigravityAccounts.openHelp'],['antigravityAccounts.debug.preview']]);
 releaseHelp();await help;releaseLogin();await login;
 assert.ok(f.posted.some(x=>x.type==='complete'&&x.command==='openHelp'&&x.requestId==='a-2'));
 execute=async(...args)=>calls.push(args);f.provider.dispose();
});

test('catalog is visible with logging off and opens its containing details before webview readiness',()=>{
 const debug={enabled:false,storageUnavailable:true,available:false,canOpen:false,host:'wsl',catalogReport:'Synthetic <safe> result'};
 const html=renderWorkbench(state({debug}),'nonce');assert.match(html,/data-command="debug.catalog" class="secondary"/);assert.match(html,/id="catalog-panel"/);assert.match(html,/id="catalog-report".*role="status" aria-live="polite">Synthetic &lt;safe&gt; result/);assert.match(html,/catalogReport.scrollIntoView/);
 const stopping=renderWorkbench(state({debug:{...debug,catalogStopping:true}}),'nonce');assert.match(stopping,/data-command="debug.catalog" disabled/);assert.match(stopping,/上一查询正在停止/);
});
test('catalog reveal uses the registered view focus command and renders retained state on cold resolve',async()=>{
 calls.length=0;let provider,closed,shown=0;const current=state({debug:{enabled:false,available:true,storageUnavailable:false,canOpen:false,host:'wsl',catalogReport:'正在核验当前账号'}});
 const view={webview:{html:'',onDidReceiveMessage:()=>({dispose(){}})},show(){shown++;},onDidDispose(fn){closed=fn;return{dispose(){}};}};
 provider=new WorkbenchView(()=>current);execute=async(...args)=>{calls.push(args);if(args[0]==='antigravityAccounts.accounts.focus')provider.resolveWebviewView(view);};
 await provider.revealCatalog();assert.deepEqual(calls,[['antigravityAccounts.accounts.focus']]);assert.match(view.webview.html,/正在核验当前账号/);assert.match(view.webview.html,/id="catalog-panel"/);
 await provider.revealCatalog();assert.equal(shown,1);assert.equal(calls.length,1);closed();current.debug.catalogReport='完成';provider.refresh();assert.equal(calls.length,1);await provider.revealCatalog();assert.match(view.webview.html,/完成/);provider.dispose();await assert.rejects(provider.revealCatalog(),/CATALOG_VIEW_UNAVAILABLE/);execute=async(...args)=>calls.push(args);
});
test('unresolved view focus is reported instead of a silent background query',async()=>{
 const provider=new WorkbenchView(()=>state());await assert.rejects(provider.revealCatalog(),/CATALOG_VIEW_UNAVAILABLE/);provider.dispose();
});

test('only an explicitly requested diagnostic renders the standalone result surface',()=>{
 const debug={enabled:false,available:true,storageUnavailable:false,host:'local',canOpen:true};
 assert.doesNotMatch(renderWorkbench(state({debug}),'nonce'),/id="catalog-panel"/);
 const shown=renderWorkbench(state({debug:{...debug,catalogReport:'fixture-report'}}),'nonce');assert.match(shown,/id="catalog-panel"/);assert.match(shown,/data-command="debug.dismissCatalog"/);assert.match(shown,/id="catalog-report"/);
});


test('current suffix follows the verified account name once, with safe duplicate matching',()=>{
 const A={...account,hostCurrent:true,label:'同名'},B={...A,id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',expectedEmail:'b@example.test'};
 const body=extra=>renderWorkbench(state({accounts:[A,B],activeEmail:A.expectedEmail,...extra}),'nonce').split('<body>')[1];
 assert.equal((body().match(/（当前登录）/g)||[]).length,1);assert.match(body(),/同名<span class="current-badge">（当前登录）<\/span>/);
 for(const extra of [{activeEmail:undefined},{pending:true},{accounts:[A,{...B,expectedEmail:A.expectedEmail}]},{accounts:[A,{...B,id:A.id}]},{accounts:[{...A,migrationState:'pending'},B]}])assert.doesNotMatch(body(extra),/current-badge/);
 const html=body({activeEmail:B.expectedEmail});const cards=html.match(/<article class="account(?: active)?">[\s\S]*?<\/article>/g);assert.doesNotMatch(cards[0],/current-badge/);assert.match(cards[1],/（当前登录）/);
});

test('last-known login is labeled unverified and never supplies current badge or saved state',()=>{
 const remembered={...account,hostCurrent:true};const html=renderWorkbench(state({accounts:[remembered],lastKnownAccountId:account.id,identityChecking:true}),'nonce');
 assert.match(html,/上次确认的登录：example@example.test（待后台确认）/);assert.doesNotMatch(html,/<span class="current-badge"|<p class="current-status verified"/);assert.match(html,/data-command="live.capture" class=[^>]*>保存当前账号/);
 const foreign=renderWorkbench(state({accounts:[{...remembered,hostCurrent:false}],lastKnownAccountId:account.id}),'nonce');assert.doesNotMatch(foreign,/上次确认的登录/);
 const current=renderWorkbench(state({accounts:[remembered],lastKnownAccountId:account.id,activeEmail:account.expectedEmail}),'nonce');assert.match(current,/<span class="current-badge"/);assert.doesNotMatch(current,/上次确认的登录/);
});
test('view resolution requests readiness once while ordinary repaints stay passive',()=>{
 let ready=0;const provider=new WorkbenchView(()=>state(),()=>{ready++;});const view={webview:{options:{},html:'',onDidReceiveMessage:()=>({dispose(){}})},onDidDispose:()=>({dispose(){}})};
 provider.resolveWebviewView(view);assert.equal(ready,1);provider.refresh();provider.refresh();assert.equal(ready,1);provider.resolveWebviewView(view);assert.equal(ready,2);provider.dispose();
});
