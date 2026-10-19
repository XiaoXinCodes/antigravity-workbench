// Production image webview with synthetic failures only. No account or service calls.
require('../test/helpers/offline-only.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Cdp } = require('../test/fixtures/cdp.cjs');
const { setLanguage } = require('../out/i18n');
const { directImageHtml } = require('../out/direct-image-view');
const { imageHttpFailure, formatImageUserFailure } = require('../out/direct-image-http-error');
const { captureRecentImageFailure, formatRecentImageFailure } = require('../out/recent-image-failure');

async function run() {
  const directory = path.resolve('.test-results/diagnostics');
  await fs.mkdir(directory, { recursive: true });
  const profile = await fs.mkdtemp(path.join(directory, 'chromium-'));
  const pages = new Map();
  const id = '11111111-1111-4111-8111-111111111111';
  for (const language of ['zh-CN', 'en']) {
    setLanguage(language);
    for (const [name, reason] of [['verification', 'VALIDATION_REQUIRED'], ['permission', 'PERMISSION_DENIED'], ['unknown', undefined], ['waits', 'QUOTA_EXHAUSTED']]) {
      const details = reason ? [{ reason }] : [];
      if (name === 'waits') {
        details[0].metadata = { quotaResetDelay: '58h24m53s' };
        details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' });
      }
      const error = imageHttpFailure(name === 'waits' ? 429 : 403, { error: { details } }, name === 'waits' ? '3' : undefined);
      const text = formatImageUserFailure(error);
      const state = { type: 'state', busy: false, status: text, accountStatus: '', canCheckAccount: true, references: [], tasks: [],
        imageQuota: { loading: false, stale: false, error: text },
        recentDiagnostic: formatRecentImageFailure(captureRecentImageFailure(error, 'synthetic-image-model', 'generating', id)),
        choices: { accounts: [{ id, label: 'Synthetic account', active: true }], models: [{ id: 'synthetic-image-model', label: 'Synthetic model' }] },
        draft: { prompt: 'Synthetic fixture only', accountId: id, modelId: 'synthetic-image-model', ratio: '1:1', count: 1, size: 'auto', quality: 'auto' }, outputDirectory: '' };
      const inertApi = `const fixtureState=${JSON.stringify(state).replace(/</g, '\\u003c')};window.__messages=[];const api={getState:()=>({}),setState:()=>{},postMessage:m=>{window.__messages.push(m);if(m.type==='ready')queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:fixtureState}))) }},`;
      let html = directImageHtml('synthetic-diagnostics').replace('const api=acquireVsCodeApi(),', inertApi);
      html = html.replace('<style nonce="synthetic-diagnostics">', '<style nonce="synthetic-diagnostics">:root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#e9e9ed;--vscode-editor-background:#202125;--vscode-sideBar-background:#202125;--vscode-descriptionForeground:#b7b9c3;--vscode-input-foreground:#e9e9ed;--vscode-input-background:#292c32;--vscode-panel-border:#45464d;--vscode-widget-border:#45464d;--vscode-button-background:#5679d9;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#292c32;--vscode-button-secondaryForeground:#e9e9ed;}');
      pages.set(`/${language}-${name}`, html);
    }
  }
  const server = http.createServer((req, res) => { const html = pages.get(req.url); res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html || 'Not found'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const browser = spawn(process.env.CHROME_BIN || '/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise(resolve => browser.once('exit', resolve));
  let cdp;
  const results = [];
  try {
    cdp = await Cdp.connect(port);
    for (const page of pages.keys()) for (const width of [440, 1000]) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}${page}` }, sessionId);
      const context = await cdp.find('#imageQuotaError');
      const metrics = await cdp.eval(`(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));const status=document.querySelector('#status'),quota=document.querySelector('#imageQuotaError');return {status:status.textContent,quota:quota.textContent,debugClosed:!document.querySelector('#imageDebug').open,debugHidden:!document.querySelector('#recentDiagnostic').checkVisibility(),width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,messages:window.__messages};})()`, context);
      assert.ok(metrics.status && metrics.quota);
      assert.doesNotMatch(metrics.status + metrics.quota, /IMAGE_|RetryInfo|Retry-After|reason [A-Z_]|https?:/);
      assert.equal(metrics.debugClosed, true); assert.equal(metrics.debugHidden, true);
      assert.equal(metrics.width, width); assert.ok(metrics.scroll <= metrics.client);
      assert.deepEqual(metrics.messages, [{ type: 'ready' }]);
      if (page.endsWith('waits')) { assert.match(metrics.status, /210293/); assert.match(metrics.status, /90/); assert.match(metrics.status, /3/); }
      const file = page.slice(1) + '-' + width + '.png';
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await fs.writeFile(path.join(directory, file), Buffer.from(shot.data, 'base64'));
      results.push({ page, width, file, ...metrics, passed: true });
      await cdp.send('Target.closeTarget', { targetId });
    }
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(`Diagnostic UI: ${results.length} production webview checks passed (synthetic data, Chromium).`);
  } finally {
    cdp?.close(); browser.kill(); await exited;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true }); setLanguage('zh-CN');
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
