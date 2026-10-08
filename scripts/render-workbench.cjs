// Render the production workbench and retained legacy image regression fixtures.
// The legacy image fixtures do not represent the current direct-image panel.
// This is layout evidence only, never authentication or native-storage verification.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const http = require('node:http');
const { version: extensionVersion } = require('../package.json');
const original = Module._load;
Module._load = function(name, parent, main) { if (name === 'vscode') return {}; return original.call(this, name, parent, main); };
const { renderWorkbench } = require('../out/workbench-view');
const { imageHtml, imageErrorMessage } = require('../out/legacy/image-ui');
Module._load = original;
const directory = path.resolve('.test-results');
fs.mkdirSync(directory, { recursive: true });
const base = {
  version: extensionVersion,
  accounts: [], snapshots: [], status: '准备就绪', busy: false, pending: false, recoveryPhase: 'none', warning: null,
  environment: { available: true, message: 'Workbench：WSL · Linux；使用该宿主的 HOME、凭据与 CLI' },
  official: { available: true, message: 'Google Antigravity：WSL · Linux，后台已启动' },
  storageMode: 'wsl-file',
};
const native = { ...base, storageMode: 'native-keyring', environment: { available: true, message: 'Workbench：本机 Windows；使用该宿主的 HOME、凭据与 CLI' }, official: { available: true, message: 'Google Antigravity：本机 Windows，后台已启动' } };
const account = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: '工作账户', expectedEmail: 'synthetic.work@example.test', capturedAt: '2026-10-01T00:00:00.000Z', identitySource: 'hub', hostId: 'synthetic-current-host', hostCurrent: true };
const longAccount = { ...account, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', label: '长邮箱与名称布局检查', expectedEmail: 'long-synthetic-account-'.repeat(6) + '@example.test' };
const states = {
  empty: base,
  'native-empty': native,
  saved: { ...base, accounts: [account, longAccount] },
  quota: { ...base, accounts: [{ ...account, quota: { phase: 'ready', snapshot: { source: 'server', email: account.expectedEmail, observedAt: '2026-10-01T03:00:00.000Z', buckets: [{ label: 'Gemini 模型（合成）', remaining: 0.75, resetAt: '2026-10-01T07:14:19.000Z' }, { label: 'Claude 模型（合成）', remaining: 1, resetAt: '2026-10-01T07:14:19.000Z' }] } } }, { ...longAccount, quota: { phase: 'mismatch', message: '此账号访问令牌已过期，请重新授权并保存' } }] },
  'capture-only': { ...base, loginMutationAvailable: false, loginMutationReason: 'WSL Secret Service 暂不可读取，请打开当前发行版密钥库后重新检查', accounts: [account] },
  imported: { ...base, accounts: [{ ...account, migrationState: 'pending', identitySource: 'user' }, { ...longAccount, migrationState: 'verified' }] },
  legacy: { ...base, accounts: [{ ...account, hostId: undefined, hostCurrent: false }, { ...longAccount, hostId: 'synthetic-other-host', hostCurrent: false }] },
  'host-mismatch': { ...base, accounts: [account], official: { available: false, message: 'Google Antigravity 与 Workbench 执行位置不同。请将两个扩展安装到当前登录所在的 Windows 或 WSL，再重载。' } },
  pending: { ...native, accounts: [account], pending: true, recoveryPhase: 'installed', status: '正在自动核验切换后的登录；未通过时保留恢复入口。' },
  authorizing: { ...native, accounts: [account], pending: true, recoveryPhase: 'authorizing', status: '上次浏览器授权未完成，请继续恢复原登录' },
  prepared: { ...native, accounts: [account], pending: true, recoveryPhase: 'prepared', status: '安装未完成，原登录备份仍保留' },
  restored: { ...native, accounts: [account], pending: true, recoveryPhase: 'restored', status: '原凭据已恢复，正在自动核验原登录' },
  locked: { ...native, accounts: [account], pending: true, recoveryPhase: 'locked', status: '另一个登录操作仍在进行，工作台将自动重新检查' },
  unavailable: { ...native, accounts: [account], pending: true, recoveryPhase: 'unavailable', status: '暂时无法读取恢复状态，请重新检查' },
  loading: { ...base, accounts: [{ ...account, quota: { phase: 'loading', message: '正在查询配额' } }] },
  busy: { ...base, accounts: [account], busy: true, status: '正在核验新登录并安全保存，请稍候。' },
  'long-path': { ...base, accounts: [longAccount], environment: { available: true, message: 'Workbench：WSL · Linux；HOME：/home/synthetic-user/' + 'very-long-synthetic-directory/'.repeat(10) } },
};
// Focused visual evidence for the compact account cards: current identity is a
// synthetic independently verified field, never inferred from these quota fixtures.
const quotaAccount = { ...account, quota: { phase: 'ready', snapshot: { source: 'server', email: account.expectedEmail, observedAt: '2026-10-01T03:00:00.000Z', buckets: [
  { label: 'Gemini Pro · 5 小时（合成）', remaining: 0.88, resetAt: '2026-10-01T04:18:00.000Z' },
  { label: 'Claude · 每周（合成）', remaining: 0.12, resetAt: '2026-10-05T01:00:00.000Z' },
] } } };
states.cards = { ...base, activeEmail: account.expectedEmail, activeVerifiedAt: '2026-10-01T03:00:00.000Z', accounts: [quotaAccount, { ...longAccount, label: '备用账户', expectedEmail: 'synthetic.backup@example.test', quota: { phase: 'error', message: '授权已被撤销，请重新登录后刷新' } }] };
states['cards-light'] = states.cards;
states['cards-loading'] = { ...states.cards, busy: true, status: '正在查询此账号配额', accounts: [{ ...quotaAccount, quota: { ...quotaAccount.quota, phase: 'loading' } }, states.cards.accounts[1]] };
states['quota-units'] = { ...base, accounts: [{ ...account, quota: { phase: 'ready', snapshot: { source: 'server', email: account.expectedEmail, observedAt: '2026-10-01T03:00:00.000Z', buckets: [{label:'已用完',remaining:0,resetAt:null},{label:'积分',remaining:null,remainingAmount:'200',resetAt:null},{label:'未提供额度',remaining:null,resetAt:null},{label:'暂停使用',remaining:1,disabled:true,resetAt:null}] } } }] };
states['locations-wsl'] = { ...base, locations: { host: 'WSL · Linux', extensionPath: '/home/synthetic/.vscode-server/extensions/xiaoxincodes.antigravity-account-manager-0.15.3', credentialPath: '/home/synthetic/.gemini/jetski-standalone-oauth-token', imageOutputPath: '/home/synthetic/project/generated-images', canOpenExtension: false } };
states['locations-local'] = { ...native, locations: { host: '本机 Windows', extensionPath: 'C:\\\\Users\\\\synthetic\\\\.vscode\\\\extensions\\\\xiaoxincodes.antigravity-account-manager-0.15.3', credentialPath: 'C:\\\\Users\\\\synthetic\\\\.gemini\\\\jetski-standalone-oauth-token', canOpenExtension: true } };
const outputs = {};
for (const [name, state] of Object.entries(states)) {
  const output = path.join(directory, `workbench-${name}.html`);
  let html = renderWorkbench(state, 'visual-review').replace('const api=acquireVsCodeApi();', 'window.__fixture={messages:[]};const api={getState:()=>JSON.parse(sessionStorage.getItem("fixtureState")||"null"),setState:state=>sessionStorage.setItem("fixtureState",JSON.stringify(state)),postMessage:message=>window.__fixture.messages.push(message)};').replace('<main>', '<main><p class="subtitle">合成数据 · UI 验证，非真实账户或余额</p>');
  if (name.startsWith('locations-')) html = html.replace('const expanded=previous.expanded||{};', 'const expanded={...(previous.expanded||{}),"host-details":true};');
  if (name === 'cards-light') html = html.replace('<style nonce="visual-review">', '<style nonce="visual-review">:root{color-scheme:light;--vscode-sideBar-background:#f5f6f8;--vscode-editor-background:#ffffff;--vscode-foreground:#253043;--vscode-descriptionForeground:#647087;--vscode-widget-border:#dce2eb;--vscode-button-background:#3869bf;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#edf1f7;--vscode-button-secondaryHoverBackground:#e2e9f4;--vscode-textLink-foreground:#365f9f;--vscode-badge-background:#e5edf8;--vscode-badge-foreground:#365f9f;--vscode-charts-green:#278469;--vscode-charts-red:#c34f52;--vscode-charts-yellow:#946b21;--vscode-focusBorder:#6892d4;}');
  fs.writeFileSync(output, html); outputs[name] = output;
}
const imageState = { type: 'state', busy: false, cancellable: false, references: [], images: [], resultWarning: '', status: '合成界面演示，未调用 Google 或生成图片', outputDirectory: '/home/synthetic/project', draft: {prompt:'一只在窗边晒太阳的橘猫，柔和水彩风格',aspectRatio:'1:1',executable:'agy',count:1,size:'auto',quality:'auto'} };
const imageOutput = path.join(directory, 'workbench-image-default.html');
let imageFixture = imageHtml().replace('const api=acquireVsCodeApi();', 'window.__imageFixture={messages:[]};const api={postMessage:message=>window.__imageFixture.messages.push(message)};');
imageFixture = imageFixture.replace('<body>', '<body><p class="muted">合成数据 · UI 验证，未发起真实图片调用</p>').replace(/<style nonce="[^"]+">/, match => match + ':root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#e9e9ed;--vscode-editor-background:#202125;--vscode-descriptionForeground:#a7a9b3;--vscode-input-foreground:#e9e9ed;--vscode-input-background:#292c32;--vscode-panel-border:#34363d;--vscode-button-background:#5679d9;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#292c32;--vscode-button-secondaryForeground:#e9e9ed;}').replace('updateControls();api.postMessage({type:\'ready\'});', `updateControls();window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(imageState)}}));`);
fs.writeFileSync(imageOutput, imageFixture); outputs['image-default'] = imageOutput;
for (const [name, guard] of [['image-guard-name', {version:1,reason:'IMAGE_NAME',generationAllowed:false}], ['image-guard-repeat', {version:1,reason:'CALL_LIMIT',generationAllowed:true}]]) {
  const state = {...imageState,errorCode:'IMAGE_REQUEST_SCOPE_DENIED',retryable:true,status:imageErrorMessage(Object.assign(new Error('IMAGE_REQUEST_SCOPE_DENIED'),{guard}))};
  const output = path.join(directory,`workbench-${name}.html`);
  fs.writeFileSync(output,imageFixture.replace(JSON.stringify(imageState),JSON.stringify(state))); outputs[name] = output;
}

// CSS-pixel sizes cover sidebar widths, a wide pane, short windows, and the
// reflow equivalent of a 320px sidebar viewed at 200% browser zoom.
const reviews = [
  { state: 'locations-wsl', width: 320, height: 1800, name: 'workbench-locations-wsl-320' },
  { state: 'locations-local', width: 410, height: 1700, name: 'workbench-locations-local-410' },
  { state: 'locations-wsl', width: 160, height: 1800, name: 'workbench-locations-wsl-160' },
  ...[410, 320, 240, 160].map(width => ({ state: 'cards', width, height: width < 240 ? 640 : 900, name: `workbench-cards-${width}` })),
  { state: 'cards-light', width: 320, height: 900, name: 'workbench-cards-light-320' },
  { state: 'cards-loading', width: 240, height: 740, name: 'workbench-cards-loading-240' },
  { state: 'quota-units', width: 160, height: 640, name: 'workbench-quota-units-160' },
  { state: 'saved', width: 1440, height: 900, name: 'workbench-saved-1440' },
  ...['authorizing', 'prepared', 'restored', 'locked', 'unavailable', 'loading'].map(state => ({ state, width: 320, height: 640, name: `workbench-${state}-320` })),
  { state: 'quota', width: 410, height: 1100, name: 'workbench-quota-410' },
  { state: 'quota', width: 240, height: 740, name: 'workbench-quota-240' },
  { state: 'capture-only', width: 240, height: 740, name: 'workbench-oauth-capture-240' },
  { state: 'image-guard-name', width: 900, height: 1300, name: 'workbench-image-guard-name-900' },
  { state: 'image-guard-repeat', width: 320, height: 1700, name: 'workbench-image-guard-repeat-320' },
  { state: 'image-default', width: 900, height: 1000, name: 'workbench-image-default-900' },
  { state: 'image-default', width: 320, height: 640, name: 'workbench-image-default-320' },
  { state: 'empty', width: 410, height: 760, name: 'workbench-empty' },
  { state: 'native-empty', width: 410, height: 760, name: 'workbench-native-empty-410' },
  { state: 'empty', width: 240, height: 640, name: 'workbench-empty-240' },
  { state: 'imported', width: 240, height: 640, name: 'workbench-imported-240' },
  { state: 'imported', width: 410, height: 760, name: 'workbench-imported-410' },
  { state: 'saved', width: 320, height: 640, name: 'workbench-saved-320' },
  { state: 'legacy', width: 410, height: 760, name: 'workbench-legacy-410' },
  { state: 'host-mismatch', width: 900, height: 600, name: 'workbench-host-mismatch-900' },
  { state: 'pending', width: 240, height: 260, name: 'workbench-pending-short' },
  { state: 'long-path', width: 160, height: 320, name: 'workbench-zoom-200pct', note: '320px sidebar at 200% zoom: 160 CSS-pixel reflow equivalent' },
  { state: 'saved', width: 900, height: 600, name: 'workbench-saved-900' },
  { state: 'busy', width: 320, height: 480, name: 'workbench-busy-320' },
].map(review => ({ ...review, html: outputs[review.state], screenshot: path.join(directory, `${review.name}.png`) }));
fs.writeFileSync(path.join(directory, 'workbench-review.json'), JSON.stringify({ synthetic: true, cases: reviews }, null, 2) + '\n');
console.log(`Workbench layout fixtures: ${Object.keys(states).length} synthetic states; ${reviews.length} viewport checks in .test-results/workbench-review.json`);
// Use the DevTools pipe only for these generated, inert fixture pages. Device
// emulation avoids desktop Chrome's minimum-window-width clamp at 240/160px.
async function inspectLayouts(cases, screenshots) {
  const executable = process.env.CHROME_BIN || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(file => fs.existsSync(file));
  if (!executable) throw new Error('Set CHROME_BIN to a supported local Chromium executable for layout checks');
  const profile = fs.mkdtempSync(path.join(directory, 'chrome-profile-'));
  const browser = cp.spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: profile, XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache') } });
  let sequence = 0, buffered = '', errors = '';
  const pending = new Map(), listeners = new Set(), loadedDocuments = new Set();
  browser.stderr.setEncoding('utf8'); browser.stderr.on('data', chunk => { errors = (errors + chunk).slice(-16000); });
  const exited = new Promise(resolve => browser.once('close', resolve));
  const failAll = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    for (const listener of listeners) { clearTimeout(listener.timer); listener.reject(error); }
    listeners.clear();
  };
  browser.on('error', failAll);
  browser.on('close', code => failAll(new Error(`Chromium exited (${code}): ${errors}`)));
  browser.stdio[3].on('error', error => failAll(new Error(`${error.message}: ${errors}`)));
  browser.stdio[4].setEncoding('utf8');
  browser.stdio[4].on('data', chunk => {
    buffered += chunk;
    for (let end; (end = buffered.indexOf('\0')) !== -1;) {
      const raw = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!raw) continue;
      let message; try { message = JSON.parse(raw); } catch { failAll(new Error('Invalid DevTools response')); continue; }
      if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') loadedDocuments.add(`${message.sessionId}:${message.params.loaderId}`);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
      } else {
        for (const listener of [...listeners]) if (message.method === listener.method && message.sessionId === listener.sessionId && listener.matches(message.params)) {
          listeners.delete(listener); clearTimeout(listener.timer); listener.resolve(message.params);
        }
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}; ${errors}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const event = (method, sessionId, matches) => new Promise((resolve, reject) => {
    const listener = { method, sessionId, matches, resolve, reject };
    listener.timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`DevTools event timeout: ${method}`)); }, 15000);
    listeners.add(listener);
  });
  const results = [];
  // Serve only the generated inert fixtures. Managed Chromium can prohibit file
  // navigation, and HTTP gives each fixture a normal sessionStorage origin.
  const fixtures = new Map(cases.map(review => [`/${path.basename(review.html)}`, fs.readFileSync(review.html)]));
  const server = http.createServer((request, response) => {
    const html = request.method === 'GET' && fixtures.get(request.url);
    response.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html || 'Not found');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const review of cases) {
      const fixtureUrl = `${origin}/${path.basename(review.html)}`;
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Page.enable', {}, sessionId);
      await send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width: review.width, height: review.height, deviceScaleFactor: 1, mobile: false }, sessionId);
      const navigation = await send('Page.navigate', { url: fixtureUrl }, sessionId);
      if (navigation.errorText || !navigation.loaderId) throw new Error(`Fixture navigation failed: ${navigation.errorText || 'missing document loader'}`);
      if (!loadedDocuments.has(`${sessionId}:${navigation.loaderId}`)) await event('Page.lifecycleEvent', sessionId, params => params.name === 'load' && params.loaderId === navigation.loaderId);
      const evaluation = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
        if (location.href !== ${JSON.stringify(fixtureUrl)} || !window.${review.state.startsWith('image-') ? '__imageFixture' : '__fixture'}) throw new Error('Expected fixture document and script did not load');
        await document.fonts.ready;
        const details = [...document.querySelectorAll('details')];
        const initiallyOpen = details.map(detail => detail.open);
        for (const detail of details) detail.open = true;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const root = document.documentElement;
        const failures = [];
        const buttons = [...document.querySelectorAll('button')].filter(button => button.getClientRects().length);
        for (const button of buttons) {
          button.scrollIntoView({block:'center',inline:'nearest'});
          const rect = button.getBoundingClientRect();
          if (rect.left < -1 || rect.right > root.clientWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) failures.push({command:button.dataset.command,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom});
        }
        const rows = [...document.querySelectorAll('.account,.account-title,.quota-model,.quota-list progress,.account-tools,.location-block,.location-row code,.location-actions')];
        for(const row of rows) {const rect=row.getBoundingClientRect();if(rect.left < -1 || rect.right > root.clientWidth+1) failures.push({element:row.className,left:rect.left,right:rect.right});}
        const expandedScrollWidth = root.scrollWidth;
        details.forEach((detail,index) => { detail.open = initiallyOpen[index]; });
        scrollTo(0,0);
        await new Promise(resolve => requestAnimationFrame(resolve));
        const main = document.querySelector('main'), bodyStyle = getComputedStyle(document.body);
        const fullWidth = !main || Math.abs(main.getBoundingClientRect().width - (root.clientWidth - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight))) < 2;
        const version = document.querySelector('.version');
        const versionVisible = !main || !!version && !!version.getClientRects().length && version.textContent === ${JSON.stringify(extensionVersion)};
        return {fullWidth,versionVisible,innerWidth,clientWidth:root.clientWidth,scrollWidth:root.scrollWidth,expandedScrollWidth,innerHeight,scrollHeight:root.scrollHeight,verticalScrollRequired:root.scrollHeight>innerHeight,checkedButtons:buttons.length,unreachableButtons:failures};
      })()` }, sessionId);
      if (evaluation.exceptionDetails) throw new Error(`Layout evaluation failed: ${JSON.stringify(evaluation.exceptionDetails)}`);
      const metrics = evaluation.result.value;
      const passed = metrics.checkedButtons > 0 && metrics.innerWidth === review.width && metrics.innerHeight === review.height && metrics.clientWidth <= review.width && metrics.clientWidth >= review.width - 20 && metrics.scrollWidth <= metrics.clientWidth && metrics.expandedScrollWidth <= metrics.clientWidth && metrics.unreachableButtons.length === 0 && metrics.fullWidth && metrics.versionVisible;
      const result = { name: review.name, requestedWidth: review.width, requestedHeight: review.height, ...metrics, passed };
      results.push(result);
      fs.writeFileSync(path.join(directory, 'workbench-layout-results.json'), JSON.stringify(results, null, 2) + '\n');
      if (screenshots) {
        const captured = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
        const png = Buffer.from(captured.data, 'base64');
        if (png.length < 1000) throw new Error('UI screenshot unexpectedly empty');
        fs.writeFileSync(review.screenshot, png);
        if (process.env.AG_UI_LOG_SCREENSHOT === '1' && ['workbench-cards-410', 'workbench-cards-light-320', 'workbench-cards-160', 'workbench-image-default-900', 'workbench-oauth-capture-240', 'workbench-image-guard-name-900', 'workbench-image-guard-repeat-320'].includes(review.name)) {
          console.log(`WORKBENCH_SCREENSHOT_BEGIN:${JSON.stringify({ name: review.name, filename: path.basename(review.screenshot), width: review.width, height: review.height })}`);
          for (let at = 0; at < captured.data.length; at += 2000) console.log(`WORKBENCH_PNG:${captured.data.slice(at, at + 2000)}`);
          console.log(`WORKBENCH_SCREENSHOT_END:${review.name}`);
        }
      }
      if (review.state.startsWith('image-')) {
        const imageClicks = await send('Runtime.evaluate', { returnByValue:true, expression:`(() => {
          const messages=window.__imageFixture.messages,failures=[];
          const generate=document.getElementById('generate'),retry=document.getElementById('retry'),cancel=document.getElementById('cancel');
          const button=retry.hidden?generate:retry;
          button.click();button.click();
          const requests=messages.filter(message=>message.type==='generate');
          if(requests.length!==1||requests[0].aspectRatio!=='1:1'||requests[0].count!==1)failures.push('image request or repeat-click mismatch');
          if(!generate.disabled)failures.push('generate stays enabled during request');
          cancel.click();
          if(messages.filter(message=>message.type==='cancel').length!==1)failures.push('image cancel missing');
          return {synthetic:true,imageFlow:true,failures,passed:failures.length===0};
        })()` },sessionId);
        if(imageClicks.exceptionDetails)throw new Error('Image click-flow script failed: '+JSON.stringify(imageClicks.exceptionDetails));
        result.clickFlow=imageClicks.result.value;result.passed=result.passed&&result.clickFlow.passed;
        console.log('WORKBENCH_CLICKS:'+JSON.stringify({name:review.name,...result.clickFlow}));
      } else {
        const clickFlow = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
          const messages = window.__fixture.messages, failures = [];
          const complete = (items = messages) => items.forEach(message => window.dispatchEvent(new MessageEvent('message', {data:{type:'complete',command:message.command,requestId:message.requestId}})));
          const independent = new Set(['live.quotaCancel','debug.toggle','debug.preview','debug.exportPreview','debug.copyDirectory','debug.openDirectory','openHelp','openOfficialExtension','openWorkbenchExtension','openHostSettings','locations.copyExtension','locations.copyCredentials','locations.copyImageOutput','locations.openExtension','openSettings']);
          const requestIds = new Set();
          const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
          const details = [...document.querySelectorAll('details')];
          for (const detail of details) detail.open = true;
          await new Promise(resolve => setTimeout(resolve, 0));
          const buttons = [...document.querySelectorAll('button[data-command]')];
          let checkedEnabled = 0, checkedDisabled = 0;
          for (const button of buttons) {
            complete(); const start = messages.length;
            button.click();
            if (button.disabled) {
              checkedDisabled++;
              if (messages.length !== start) failures.push('Disabled button dispatched: ' + button.dataset.command);
              continue;
            }
            checkedEnabled++;
            const request = messages.at(-1);
            const expected = {command:button.dataset.command,requestId:request?.requestId,...(button.dataset.id?{accountId:button.dataset.id}:{})};
            if (messages.length !== start+1 || !same(messages.at(-1),expected)) failures.push('Wrong click payload: ' + button.dataset.command);
            if (typeof request?.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.requestId) || requestIds.has(request.requestId)) failures.push('Missing or reused request ID: ' + button.dataset.command);
            requestIds.add(request?.requestId);
            if (document.body.classList.contains('waiting') === independent.has(button.dataset.command)) failures.push('Wrong waiting state: ' + button.dataset.command);
            complete([{command:button.dataset.command,requestId:'stale-request'}]);
            button.click();
            if (messages.length !== start+1) failures.push('Stale completion released repeated click: ' + button.dataset.command);
            complete();
            if (document.body.classList.contains('waiting')) failures.push('Dismissal left waiting state: ' + button.dataset.command);
            button.click();
            if (messages.length !== start+2) failures.push('Action unavailable after dismissal: ' + button.dataset.command);
            if (messages.at(-1)?.requestId === request?.requestId) failures.push('Next action reused request ID: ' + button.dataset.command);
            complete();
          }
          const cards = [...document.querySelectorAll('article.account')];
          for (const card of cards) {
            if (card.querySelectorAll('[data-command="live.quota"],[data-command="live.quotaCancel"]').length !== 1) failures.push('Quota entry is not unique per account');
          }
          if (document.querySelectorAll('[data-command="live.quota"]').length > cards.length) failures.push('Duplicate global quota entry');
          for (const command of ['refresh','importSnapshot','reloadSnapshots','openBridgeGuide','live.unlock']) if (document.querySelector('[data-command="'+command+'"]')) failures.push('Legacy tool exposed: '+command);
          const phase = document.querySelector('[data-recovery-phase]')?.dataset.recoveryPhase || 'none';
          const verifyCount = document.querySelectorAll('[data-command="live.verify"]').length;
          const restoreCount = document.querySelectorAll('[data-command="live.restore"]').length;
          if (verifyCount !== Number(['installed','restored'].includes(phase))) failures.push('Wrong verify action for '+phase);
          if (restoreCount !== Number(['authorizing','prepared','installed','restored'].includes(phase))) failures.push('Wrong restore action for '+phase);
          const cancel = document.querySelector('[data-command="live.quotaCancel"]');
          if (cancel) {
            complete(); const start=messages.length;
            const another=buttons.find(button=>!button.disabled && button!==cancel && !independent.has(button.dataset.command));
            if(another)another.click();
            cancel.click();
            if(messages.length!==start+(another?2:1)||messages.at(-1).command!=='live.quotaCancel')failures.push('Cancel unavailable during another pending action');
            complete([messages.at(-1)]);
            if(another&&!document.body.classList.contains('waiting'))failures.push('Cancel completion released another action');
            complete();
          }
          const persisted = JSON.parse(sessionStorage.getItem('fixtureState') || '{}');
          for (const detail of details) if (detail.hasAttribute('data-persist') && persisted.expanded?.[detail.id] !== true) failures.push('Expanded detail was not persisted: '+detail.id);
          return {synthetic:true,checkedEnabled,checkedDisabled,accountCards:cards.length,phase,failures,passed:failures.length===0};
        })()` }, sessionId);
        if (clickFlow.exceptionDetails) throw new Error('Click-flow script failed: '+JSON.stringify(clickFlow.exceptionDetails));
        result.clickFlow = clickFlow.result.value;
        result.passed = result.passed && result.clickFlow.passed;
        console.log('WORKBENCH_CLICKS:' + JSON.stringify({name:review.name,...result.clickFlow}));
      }
      await send('Target.closeTarget', { targetId });
      console.log(`WORKBENCH_LAYOUT:${JSON.stringify(result)}`);
    }
    fs.writeFileSync(path.join(directory, 'workbench-layout-results.json'), JSON.stringify(results, null, 2) + '\n');
    if (results.some(result => !result.passed)) throw new Error('Workbench layout checks failed; inspect workbench-layout-results.json');
  } finally {
    // Retire fixture tabs before waiting for their HTTP connections to close.
    browser.kill('SIGTERM');
    const kill = setTimeout(() => browser.kill('SIGKILL'), 2000);
    await exited; clearTimeout(kill);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const all = process.argv.includes('--all-screenshots'), screenshot = process.argv.includes('--screenshot');
if (all || screenshot || process.argv.includes('--measure')) inspectLayouts(screenshot && !all ? reviews.slice(0, 1) : reviews, all || screenshot).catch(error => { console.error(error.message); process.exitCode = 1; });
