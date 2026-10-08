const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const { Writable } = require('node:stream');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-vscode-test-'));
  const diagnostics = path.resolve(__dirname, '../.test-results');
  await fs.mkdir(diagnostics, { recursive: true });
  const log = path.join(diagnostics, 'extension-host.log');
  await fs.writeFile(log, `Isolated smoke runner: ${process.platform}/${process.arch}\n`);
  const output = new Writable({ write(chunk, _encoding, done) {
    process.stdout.write(chunk);
    try { fsSync.appendFileSync(log, chunk); done(); } catch (error) { done(error); }
  } });
  const copyLogs = () => fs.cp(path.join(profile, 'logs'), path.join(diagnostics, 'vscode-logs'), { recursive: true, force: true }).catch(() => undefined);
  const logTimer = setInterval(() => { void copyLogs(); }, 15000);
  logTimer.unref();
  try {
    await runTests({
      version: process.env.AG_VSCODE_TEST_VERSION || 'stable',
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../test/host-suite.cjs'),
      // On macOS retain the OS home for Electron bootstrap; user-data and extensions remain isolated.
      extensionTestsEnv: process.platform === 'darwin' ? {} : { HOME: profile, USERPROFILE: profile },
      stdout: output,
      stderr: output,
      launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry', '--user-data-dir', profile, '--extensions-dir', path.join(profile, 'extensions')],
    });
  } finally {
    clearInterval(logTimer);
    await copyLogs();
    // Windows may retain extension-host log handles briefly after Electron exits.
    // Retry bounded cleanup rather than treating a successful smoke as a failure.
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
