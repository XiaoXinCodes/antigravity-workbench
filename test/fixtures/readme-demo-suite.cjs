const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vscode = require('vscode');
const { Cdp, sleep } = require('./cdp.cjs');
exports.run = async fixture => {
  const cdp = await Cdp.connect(Number(process.env.AG_CAPTURE_CDP_PORT));
  const evidence = process.env.AG_CAPTURE_EVIDENCE;
  let ui;
  const frames = [];
  const read = expression => cdp.eval(expression, ui);
  const until = async (fn, label) => {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(40); }
    await fs.writeFile(path.join(evidence, 'timeout-state.json'), JSON.stringify(await read('({text:document.body.innerText,state:typeof latestState!=="undefined"?latestState:null})'), null, 2));
    throw Error('Timeout: ' + label);
  };
  assert.equal(vscode.extensions.getExtension('google.google-antigravity'), undefined);
  const main = await cdp.find('.monaco-workbench');
  if ((await vscode.commands.getCommands(true)).includes('notifications.toggleDoNotDisturbMode')) {
    await vscode.commands.executeCommand('notifications.toggleDoNotDisturbMode');
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1160, height: 840, deviceScaleFactor: 1, mobile: false }, main.session);
  const capture = async (name, duration, chapter) => {
    await vscode.commands.executeCommand('notifications.clearAll');
    await sleep(400);
    await vscode.commands.executeCommand('notifications.clearAll');
    await sleep(100);
    await vscode.commands.executeCommand('notifications.hideToasts');
    await sleep(100);
    const text = await read('document.body.innerText');
    assert.doesNotMatch(text, /Bearer |refresh_token|access_token|csrfToken/i);
    const emails = text.match(/[^\s<>"'@]+@[^\s<>"'@]+\.[A-Za-z]{2,}/g) || [];
    assert.ok(emails.every(email => email.endsWith('@example.test')), JSON.stringify(emails));
    // Capture the real editor part (navigation + production webview); no DOM restyling.
    const clip = await cdp.eval('(()=>{const r=document.querySelector(".part.editor").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()', main);
    const viewport = await cdp.eval('({width:innerWidth,height:innerHeight})', main);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, main.session);
    const bytes = Buffer.from(screenshot.data, 'base64');
    const file = name + '.png';
    await fs.writeFile(path.join(evidence, file), bytes);
    frames.push({ file, duration, chapter, clip, viewport, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  try {
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('antigravityAccounts.workbench.open');
    ui = await cdp.find('body[data-wb-surface="editor"]');
    await until(() => read('document.querySelectorAll(".account").length===4&&synchronized'), 'account cards');
    await read('document.querySelectorAll(".account details").forEach(d=>d.open=d.dataset.key==="group:synthetic-group-a")');
    await capture('01-accounts', 1800, 'accounts');
    await cdp.click(ui, '#quota-search');
    await read('document.querySelector("#quota-search").value="2";document.querySelector("#quota-search").dispatchEvent(new Event("input",{bubbles:true}))');
    await until(() => read('[...document.querySelectorAll(".account")].filter(n=>!n.hidden).length===1'), 'account search');
    await capture('02-search', 1400, 'search');
    await read('document.querySelector("#quota-search").value="";document.querySelector("#quota-search").dispatchEvent(new Event("input",{bubbles:true}))');
    await read('document.querySelector("#quota-compare").selectedIndex=2;document.querySelector("#quota-compare").dispatchEvent(new Event("change"))');
    await until(() => read('document.querySelectorAll(".account").length===4'), 'quota comparison');
    await capture('03-compare', 2000, 'compare');
    const account = fixture.accounts[1];
    await cdp.click(ui, '[data-command="live.quota"][data-id="' + account.id + '"]');
    await until(() => fixture.pending(), 'synthetic refresh');
    await read('document.querySelector(".account-list").scrollIntoView({block:"start"})');
    await capture('04-refreshing', 700, 'refresh');
    fixture.finish('success');
    await until(() => !fixture.pending(), 'refresh done');
    assert.equal(account.quota.snapshot.buckets[0].remaining, .42);
    await read('document.querySelector(".account-list").scrollIntoView({block:"start"})');
    await capture('05-refreshed', 1800, 'refresh');
    await cdp.click(ui, '.wb-navigation [data-wb-nav="images"]');
    ui = await cdp.find('#prompt');
    await until(() => read('document.querySelector("#model").options.length>0&&document.querySelectorAll(".image-result img").length===1'), 'sample image');
    await capture('06-images', 1800, 'images');
    await read('document.querySelector("#account").value=' + JSON.stringify(account.id) + ';document.querySelector("#account").dispatchEvent(new Event("change"))');
    await until(() => read('document.querySelector("#account").value===' + JSON.stringify(account.id) + '&&!latestState.choicesLoading'), 'independent image account');
    await cdp.click(ui, '#queryQuota');
    await until(() => read('document.querySelector("#imageQuotaStatus").textContent.includes("75")'), 'image quota');
    await capture('07-image-account', 1900, 'imageAccount');
    // Click the task's reuse button. It restores saved parameters; the sender remains disabled.
    await cdp.click(ui, '.task > .result-action');
    await until(() => read('document.querySelector("#prompt").value===' + JSON.stringify(fixture.samplePrompt)), 'reused sample prompt');
    await read('window.scrollTo(0,0);document.querySelector(".composer").scrollTop=0');
    await capture('08-reuse', 2300, 'reuse');
    await cdp.click(ui, '.wb-navigation [data-wb-nav="records"]');
    ui = await cdp.find('#period');
    await until(() => read('document.querySelectorAll("#rows article").length===3&&!document.querySelector("#read").disabled'), 'local records');
    await capture('09-records', 2500, 'records');
    assert.equal(fixture.imageRuns(), 0);
    assert.equal(fixture.quotaReads(), 1);
    // Check local Markdown rendering and both embedded assets in a real preview.
    const readme = process.env.AG_DEMO_LANGUAGE === 'en' ? 'README_EN.md' : 'README.md';
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.resolve(__dirname, '../..', readme)));
    ui = await cdp.find('.markdown-body');
    await until(() => read('[...document.querySelectorAll("img")].length===2&&[...document.querySelectorAll("img")].every(img=>img.complete&&img.naturalWidth>0)'), 'README embedded assets');
    const preview = await cdp.send('Page.captureScreenshot', { format: 'png' }, main.session);
    await fs.writeFile(path.join(evidence, 'readme-preview.png'), Buffer.from(preview.data, 'base64'));
    await fs.writeFile(path.join(evidence, 'capture-receipt.json'), JSON.stringify({
      passed: true, sourceCommit: process.env.AG_CAPTURE_COMMIT, vscode: vscode.version,
      language: process.env.AG_DEMO_LANGUAGE, frames, productionUi: true,
      syntheticAccounts: true, syntheticQuota: true, syntheticUsage: true,
      sampleImage: 'media/brand-logo.png', sampleImageTransport: 'inline fixture URI', realCredentials: false, googleRequests: false,
      officialAccountSwitches: false, imageModelRequests: 0, quotaAdapterReads: fixture.quotaReads(),
      readmePreviewAssetsLoaded: true,
    }, null, 2));
  } finally { cdp.close(); }
};
