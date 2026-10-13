require('../helpers/offline-only.cjs');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const load = name => require(path.join(root, 'out', name));
exports.activate = context => {
  load('workbench-host').registerWorkbenchHost(context);
  const en = process.env.AG_DEMO_LANGUAGE === 'en';
  const accountId = '00000002-0000-4000-8000-000000000001';
  const taskId = '88888888-8888-4888-8888-888888888888';
  // Existing project-owned artwork, presented as a sample task, never as generated output.
  const file = path.join(context.globalStorageUri.fsPath, 'repository-logo-sample.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(root, 'media/brand-logo.png'), file);
  // srcdoc pages in the isolated host cannot resolve the native resource URL here.
  // Keep production markup; provide only this existing sample through an inline fixture URI.
  const host = load('workbench-host');
  const createPanel = host.createWorkbenchPanel;
  const sampleUri = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  host.createWorkbenchPanel = (...args) => {
    const panel = createPanel(...args);
    const asWebviewUri = panel.webview.asWebviewUri.bind(panel.webview);
    panel.webview.asWebviewUri = uri => uri.fsPath === file ? { toString: () => sampleUri } : asWebviewUri(uri);
    return panel;
  };
  const samplePrompt = en ? 'Repository logo sample — no generation request' : '仓库标志示例 — 未发送生图请求';
  const imageSession = require('../helpers/image-session.cjs').memorySession({ value: {
    schema: 3, draft: { prompt: '', ratio: '1:1', count: 1, size: 'auto', quality: 'auto', followCurrent: true },
    outputDirectory: path.dirname(file), references: [], savedDrafts: [], tasks: [{
      id: taskId, accountId, accountLabel: en ? 'Demo account 2' : '演示账号 2',
      createdAt: new Date().toISOString(), prompt: samplePrompt, promptSummary: samplePrompt,
      modelId: 'synthetic-image-model', ratio: '1:1', count: 1, size: 'auto', quality: 'auto',
      references: [], phase: 'complete', status: en ? 'Sample image from repository' : '来自仓库的示例图片',
      outputDirectory: path.dirname(file), images: [{ file, width: 512, height: 512, bytes: fs.statSync(file).size }],
    }],
  } });
  let quotaReads = 0;
  const fixture = require('./quota-host-extension.cjs').activate(context, { imageSession,
    imageDirect: { selectSavedAccount: () => {}, hasSavedAccountSelection: () => true,
      readImageQuota: async (id, modelId) => {
        quotaReads++;
        return { accountId: id, modelId, endpoint: 'daily', remainingFraction: .75,
          resetAt: null, queriedAt: new Date().toISOString() };
      } },
  });
  for (const [i, a] of fixture.accounts.entries()) {
    a.label = en ? 'Demo account ' + (i + 1) : '演示账号 ' + (i + 1);
    a.quota.snapshot.buckets[0].label = 'Gemini Pro · 5h';
    a.quota.snapshot.buckets[0].resetAt = new Date(Date.now() + 2 * 3600000).toISOString();
    a.quota.snapshot.buckets[1].label = 'Claude Sonnet · 7d';
    a.quota.snapshot.buckets[2].label = en ? 'Demo model · quota unknown' : '演示模型 · 额度未知';
    a.quota.accountFingerprint = load('quota-presentation').accountDisplayFingerprint(a);
  }
  fixture.imageDirect.readChoices = async () => ({
    accounts: fixture.accounts.map((a, i) => ({ ...a, active: i === 0 })),
    models: [{ id: 'synthetic-image-model', label: en ? 'Demo image model' : '演示图片模型' }],
  });
  const { parseLocalGeneration } = load('local-generation-record');
  const { generation } = require('../helpers/generation-fixture.cjs');
  load('request-observation-ui').registerObservationsUi(context, {
    runtime: { home: context.globalStorageUri.fsPath, platform: process.platform },
    discover: async () => ({ rows: [0, 1, 2].map(i => {
      const row = parseLocalGeneration('synthetic', i, generation({ id: 'demo-' + i }));
      row.timestamp = { status: 'provided', value: Date.now() - (i + 1) * 86400000,
        fields: ['synthetic.time'], source: 'step-created' };
      return row;
    }), scope: { host: process.platform, files: 1, rows: 3, skipped: 0, limited: false }, found: true }),
  });
  return { ...fixture, samplePrompt, taskId, quotaReads: () => quotaReads };
};
