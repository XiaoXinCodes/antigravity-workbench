// Reuse the isolated VS Code screenshot workflow; never load the user's profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const language = process.env.AG_DEMO_LANGUAGE === 'en' ? 'en' : 'zh-CN';
  const evidence = path.join(repo, '.test-results', 'readme-demo', language);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-readme-demo-'));
  const extension = path.join(profile, 'synthetic-extension');
  await fs.mkdir(extension);
  await fs.rm(evidence, { recursive: true, force: true });
  await fs.mkdir(evidence, { recursive: true });
  await fs.mkdir(path.join(profile, 'User'));
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
    'workbench.colorTheme': 'Light Modern', 'window.zoomLevel': 0.5,
    'window.title': 'Antigravity Workbench · Demo data',
    'antigravityAccounts.language': language,
  }));
  const port = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({
    name: 'readme-demo', publisher: 'synthetic', version: '0.0.1',
    engines: { vscode: '^1.95.0' }, main: './main.cjs', activationEvents: ['onStartupFinished'],
    contributes: { configuration: require('../package.json').contributes.configuration,
      viewsContainers: { activitybar: [{ id: 'demo', title: 'Demo data', icon: './workbench.svg' }] },
      views: { demo: [{ id: 'antigravityAccounts.accounts', name: 'Demo data', type: 'webview' }] } },
  }));
  await fs.copyFile(path.join(repo, 'media/workbench.svg'), path.join(extension, 'workbench.svg'));
  await fs.writeFile(path.join(extension, 'main.cjs'), `const vscode=require('vscode'),fs=require('node:fs/promises');
exports.activate=context=>{const api=require(${JSON.stringify(path.join(repo, 'test/fixtures/readme-demo-extension.cjs'))}).activate(context);
setTimeout(async()=>{try{await require(${JSON.stringify(path.join(repo, 'test/fixtures/readme-demo-suite.cjs'))}).run(api)}catch(error){await fs.writeFile(${JSON.stringify(path.join(evidence, 'failure.json'))},JSON.stringify({message:error.message,stack:error.stack}));console.error(error)}finally{await vscode.commands.executeCommand('workbench.action.quit')}},500);return api};`);
  try {
    const executable = process.env.AG_VSCODE_EXECUTABLE || await require('@vscode/test-electron').downloadAndUnzipVSCode(process.env.AG_VSCODE_TEST_VERSION || 'stable');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--no-sandbox', '--disable-gpu', '--disable-extensions',
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry',
        `--extensionDevelopmentPath=${extension}`, `--remote-debugging-port=${port}`,
        '--user-data-dir', profile, '--extensions-dir', path.join(profile, 'extensions')], {
        stdio: 'inherit', env: { ...process.env, HOME: profile, USERPROFILE: profile,
          AG_DEMO_LANGUAGE: language, AG_CAPTURE_CDP_PORT: String(port),
          AG_CAPTURE_EVIDENCE: evidence, AG_CAPTURE_COMMIT: commit },
      });
      const timeout = setTimeout(() => { child.kill(); reject(Error('Demo capture exceeded 120 seconds')); }, 120000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(Error('Demo host failed')); });
    });
    const receipt = JSON.parse(await fs.readFile(path.join(evidence, 'capture-receipt.json'), 'utf8').catch(async () => {
      throw Error(await fs.readFile(path.join(evidence, 'failure.json'), 'utf8').catch(() => 'No demo receipt'));
    }));
    if (!receipt.passed) throw Error('Demo capture failed');
    console.log(JSON.stringify(receipt));
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
