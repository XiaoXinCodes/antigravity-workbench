'use strict';
// Offline validation only. Stop the actual vsce publishing path before credentials or network access.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const markdown = require('markdown-it');
const cheerio = require('cheerio');
const { readVSIXPackage, readZip } = require('@vscode/vsce/out/zip');
const { ReadmeProcessor, ChangelogProcessor } = require('@vscode/vsce/out/package');
const store = require('@vscode/vsce/out/store');
const { publish } = require('@vscode/vsce/out/publish');

async function verify(file) {
  const { manifest } = await readVSIXPackage(file);
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.publisher, 'xiaoxincodes');
  assert.equal(manifest.name, 'antigravity-account-manager');
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.license, 'MIT');
  const docs = await readZip(file, name => name.endsWith('.md'));
  for (const [name, data] of docs) {
    const $ = cheerio.load(markdown({ html: true }).render(data.toString('utf8')));
    $('a[href], img[src]').each((_, element) => {
      const image = element.tagName === 'img';
      const url = $(element).attr(image ? 'src' : 'href');
      assert.ok(url && (url.startsWith('https://') || (!image && (url.startsWith('#') || url.startsWith('mailto:')))), `Unresolved documentation URL in ${name}`);
    });
  }
  for (const [name, Processor] of [['extension/readme.md', ReadmeProcessor], ['extension/changelog.md', ChangelogProcessor]]) {
    assert.ok(docs.has(name), `Missing ${name}`);
    const processor = new Processor(manifest, { rewriteRelativeLinks: true });
    await processor.onFile({ path: name, contents: docs.get(name) });
    assert.equal(processor.filesProcessed, 1);
  }
  const original = store.getPublisher;
  const stop = new Error('AGW_OFFLINE_VALIDATION_COMPLETE');
  let reachedCredentialBoundary = false;
  store.getPublisher = async () => { reachedCredentialBoundary = true; throw stop; };
  try {
    await assert.rejects(publish({ packagePath: [file] }), error => error === stop);
    assert.ok(reachedCredentialBoundary, 'vsce did not finish its offline publishing checks');
  } finally { store.getPublisher = original; }
  return { marketplace_offline_validation: 'passed', publisher: manifest.publisher, name: manifest.name, version: manifest.version, documentation_files: docs.size, credential_or_network_request: false };
}

if (require.main === module) verify(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verify };
