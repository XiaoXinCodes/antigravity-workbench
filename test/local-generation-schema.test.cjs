const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseLocalGeneration, mergeLocalRecords, parseGenerationStepMetadata, parseGenerationWorkspaceMetadata, applyGenerationMetadata } = require(path.resolve(process.env.AG_SCHEMA_TEST_OUT || path.join(__dirname, '../out'), 'local-generation-record.js'));

function varint(value) {
  value = BigInt.asUintN(64, BigInt(value)); const bytes = [];
  do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
const number = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field, value) => { value = Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]); };
function generation(usage = Buffer.alloc(0), extraChat = Buffer.alloc(0), extraRoot = Buffer.alloc(0)) {
  return Buffer.concat([message(1, Buffer.concat([message(19, 'synthetic-returned-model'), message(4, usage), extraChat])), extraRoot]);
}
const time = (seconds, nanos = 0) => Buffer.concat([number(1, seconds), number(2, nanos)]);
const direct = wire => message(9, message(4, wire));
const step = (index, id = 'synthetic-id', wire = time(1_800_000_000, 123_000_000)) => parseGenerationStepMetadata(index, Buffer.concat([message(1, wire), message(9, message(11, id))]));
const record = (id = 'synthetic-id', extraChat = Buffer.alloc(0)) => parseLocalGeneration('synthetic-session', 5, generation(message(11, id), extraChat));
const workspace = (...uris) => parseGenerationWorkspaceMetadata(Buffer.concat(uris.map(uri => message(1, message(1, uri)))));
const metrics = ['input', 'cacheWrite', 'cacheRead', 'outputText', 'reasoning', 'outputTotal'];
function assertUnknown(row) {
  assert.equal(row.usageInterpretation, 'unverified'); assert.equal(row.usageSchema, undefined);
  assert.deepEqual(Object.keys(row.tokens).sort(), [...metrics].sort());
  for (const token of Object.values(row.tokens)) assert.deepEqual(token, { status: 'missing', fields: [] });
}

// Fields are confirmed against the official Google Antigravity 1.7.0
// extension.js, Win/WSL SHA256:
// bdae3f9573417e7806db598fdadea9d0db6a2106b589548354d47f26cdd356ea.
// root.chat_model #1 -> ChatModelMetadata.usage #4; response_model #19 string.
// ModelUsageStats: #1 enum model, #2 input, #3 output, #4 cache_write,
// #5 cache_read, #9 thinking_output, #10 response_output. This confirms the
// descriptor field contract, not a per-record producer identity/version.
test('default descriptor contract reads six distinct usage fields and never counts model enum', () => {
  const wire = Buffer.concat([number(1, 999), number(2, 7), number(3, 99), number(4, 12), number(5, 20), number(9, 4), number(10, 5)]);
  const row = parseLocalGeneration('synthetic-session', 0, generation(wire));
  assert.equal(row.usageInterpretation, 'verified'); assert.equal(row.usageSchema, 'google-antigravity-1.7.0');
  for (const [metric, field, value] of [['input', 2, 7], ['cacheWrite', 4, 12], ['cacheRead', 5, 20], ['reasoning', 9, 4], ['outputText', 10, 5], ['outputTotal', 3, 99]])
    assert.deepEqual(row.tokens[metric], { status: 'provided', value, fields: ['gen_metadata.chatModel.usage.#' + field] });
  assert.equal(row.returned.values[0], 'synthetic-returned-model'); assert.equal(row.requested.status, 'missing');
  // Do not infer that input excludes cache or output equals text+thinking.
  assert.equal(row.tokens.input.value, 7); assert.equal(row.tokens.outputTotal.value, 99);
});

test('omitted fields stay missing and output is never derived from text and thinking', () => {
  const row = parseLocalGeneration('synthetic-session', 0, generation(Buffer.concat([number(1, 3), number(9, 4), number(10, 5)])));
  for (const metric of ['input', 'cacheWrite', 'cacheRead', 'outputTotal']) assert.deepEqual(row.tokens[metric], { status: 'missing', fields: [] });
  assert.equal(row.tokens.reasoning.value, 4); assert.equal(row.tokens.outputText.value, 5);
});

test('explicit input and cache zeros stay provided while omissions stay missing', () => {
  const row = parseLocalGeneration('synthetic-session', 0, generation(Buffer.concat([number(2, 0), number(4, 0), number(5, 0)])));
  for (const metric of ['input', 'cacheRead', 'cacheWrite']) { assert.equal(row.tokens[metric].status, 'provided'); assert.equal(row.tokens[metric].value, 0); }
  assert.deepEqual(row.tokens.outputTotal, { status: 'missing', fields: [] });
});

test('duplicate scalar agreement, conflict, wrong wire and uint64 overflow remain distinct', () => {
  const wire = Buffer.concat([number(2, 7), number(2, 7), number(3, 9), number(3, 10), message(4, 'not-a-number'), number(5, BigInt(Number.MAX_SAFE_INTEGER) + 1n), number(9, 2n ** 64n - 1n)]);
  const row = parseLocalGeneration('synthetic-session', 0, generation(wire));
  assert.equal(row.tokens.input.status, 'provided'); assert.equal(row.tokens.input.value, 7);
  assert.deepEqual(row.tokens.outputTotal, { status: 'conflict', fields: ['gen_metadata.chatModel.usage.#3'] });
  assert.equal(row.tokens.cacheWrite.status, 'invalid'); assert.equal(row.tokens.cacheRead.status, 'invalid');
  assert.equal(row.tokens.reasoning.status, 'invalid'); assert.equal(row.tokens.outputText.status, 'missing');
  const safe = parseLocalGeneration('synthetic-session', 0, generation(number(2, Number.MAX_SAFE_INTEGER)));
  assert.equal(safe.tokens.input.value, Number.MAX_SAFE_INTEGER);
});

test('malformed usage retains independent returned-model and direct-date evidence', () => {
  const row = parseLocalGeneration('synthetic-session', 0, generation(Buffer.from([15]), direct(time(100))));
  assert.equal(row.issue, 'schemaUnsupported'); assert.equal(row.returned.status, 'provided'); assert.equal(row.timestamp.value, 100000);
  for (const token of Object.values(row.tokens)) assert.deepEqual(token, { status: 'invalid', fields: ['gen_metadata.chatModel.#4'] });
});

test('legacy optional source arguments neither gate nor override the confirmed field contract', () => {
  const wire = generation(Buffer.concat([number(2, 7), number(3, 9)])); const baseline = parseLocalGeneration('synthetic-session', 0, wire);
  for (const source of [{}, { schema: 'unknown' }, { schema: 'google-antigravity-1.7.0' }, { producerVerified: true }])
    assert.deepEqual(parseLocalGeneration('synthetic-session', 0, wire, source), baseline);
});

test('response identity is opaque, bounded, and ambiguous identity never merges by response', () => {
  const a = record(), b = parseLocalGeneration('synthetic-session', 6, generation(message(11, 'synthetic-id')));
  assert.equal(a.key, b.key); assert.equal(mergeLocalRecords([a, b]).length, 1); assert.ok(!JSON.stringify(a).includes('synthetic-id'));
  for (const identity of [message(11, ''), message(11, Buffer.alloc(257, 97)), number(11, 1), Buffer.concat([message(11, 'one'), message(11, 'two')])])
    assert.equal(parseLocalGeneration('synthetic-session', 1, generation(identity)).key, 'synthetic-session:generation:1');
});

test('malformed metadata stays bounded without inventing token or date evidence', () => {
  for (const wire of [Buffer.from([10, 255]), Buffer.from([15]), Buffer.alloc(1024 * 1024 + 1)]) {
    const row = parseLocalGeneration('synthetic-session', 0, wire); assertUnknown(row);
    assert.equal(row.issue, 'schemaUnsupported'); assert.equal(row.returned.status, 'invalid'); assert.equal(row.timestamp.status, 'missing');
  }
});

test('duplicate returned model and token disagreements retain conflict without modifying inputs', () => {
  const wire = Buffer.concat([number(2, 7), message(11, 'synthetic-id')]);
  const a = parseLocalGeneration('synthetic-session', 1, generation(wire));
  const b = parseLocalGeneration('synthetic-session', 2, generation(Buffer.concat([number(2, 8), message(11, 'synthetic-id')]), message(19, 'another-model')));
  const before = JSON.stringify([a, b]), merged = mergeLocalRecords([a, b]);
  assert.equal(merged.length, 1); assert.equal(merged[0].issue, 'duplicateConflict'); assert.equal(merged[0].returned.status, 'conflict');
  assert.equal(merged[0].tokens.input.status, 'conflict'); assert.equal(merged[0].tokens.input.value, undefined); assert.equal(JSON.stringify([a, b]), before);
});

test('an explicitly unsupported duplicate cannot inherit compatible token interpretation', () => {
  const known = parseLocalGeneration('synthetic-session', 0, generation(Buffer.concat([number(2, 7), message(11, 'synthetic-id')])));
  const unsupported = structuredClone(known); unsupported.usageInterpretation = 'unverified';
  for (const rows of [[known, unsupported], [unsupported, known]]) assertUnknown(mergeLocalRecords(rows)[0]);
});

test('absent direct timestamp is missing and a present empty Timestamp uses protobuf epoch defaults', () => {
  assert.deepEqual(record().timestamp, { status: 'missing', fields: [] });
  const empty = record('synthetic-id', direct(Buffer.alloc(0)));
  assert.equal(empty.timestamp.status, 'provided'); assert.equal(empty.timestamp.value, 0); assert.equal(empty.timestamp.source, 'generation');
  assert.equal(empty.timestamp.fields[0], 'gen_metadata.chatModel.chatStartMetadata.createdAt');
});

test('context metadata, packed step indices and generation index never become dates', () => {
  const row = parseLocalGeneration('synthetic-session', 999, generation(Buffer.alloc(0), message(9, message(10, time(1_800_000_000))), Buffer.concat([number(2, 1), message(2, Buffer.concat([varint(2), varint(3)]))])));
  assert.deepEqual(row.timestamp, { status: 'missing', fields: [] }); assert.equal(row.index, 999);
});

test('Timestamp preserves nanosecond conversion, negative instants and standard endpoint bounds', () => {
  for (const [seconds, nanos, expected] of [[1_800_000_000, 123_456_789, 1_800_000_000_123], [-1, 999_999_999, -1], [-62_135_596_800, 0, -62_135_596_800_000], [253_402_300_799, 999_999_999, 253_402_300_799_999]]) {
    const parsed = record('synthetic-id', direct(time(seconds, nanos))).timestamp;
    assert.equal(parsed.status, 'provided'); assert.equal(parsed.value, expected); assert.equal(parsed.source, 'generation');
  }
});

test('invalid Timestamp wire, seconds bounds and nanos never receive usable dates', () => {
  for (const wire of [time(-62_135_596_801), time(253_402_300_800), time(100, 1_000_000_000), time(100, -1), message(1, 'wrong-seconds'), message(2, 'wrong-nanos')]) {
    const parsed = record('synthetic-id', direct(wire)).timestamp; assert.equal(parsed.status, 'invalid'); assert.equal(parsed.value, undefined);
  }
  assert.equal(record('synthetic-id', number(9, 1)).timestamp.status, 'invalid');
});

test('different Timestamp declarations conflict even when they round to the same millisecond', () => {
  const dates = message(9, Buffer.concat([message(4, time(100, 1)), message(4, time(100, 2))]));
  assert.equal(record('synthetic-id', dates).timestamp.status, 'conflict');
  const duplicateSeconds = direct(Buffer.concat([number(1, 100), number(1, 101)]));
  assert.equal(record('synthetic-id', duplicateSeconds).timestamp.status, 'conflict');
  const repeated = direct(Buffer.concat([number(1, 100), number(1, 100)]));
  assert.equal(record('synthetic-id', repeated).timestamp.value, 100000);
});

test('step metadata decodes only explicit creation time and opaque response identity', () => {
  const parsed = step(12); assert.equal(parsed.index, 12); assert.equal(parsed.timestamp.value, 1_800_000_000_123);
  assert.equal(parsed.timestamp.source, 'step-created'); assert.equal(parsed.responseKey, createHash('sha256').update('synthetic-id').digest('hex'));
  assert.ok(!JSON.stringify(parsed).includes('synthetic-id'));
  assert.equal(parseGenerationStepMetadata(12, message(1, time(100))).responseKey, undefined);
  assert.equal(parseGenerationStepMetadata(12, Buffer.from([15])).timestamp.status, 'invalid');
});

test('one matching step supplies a clearly attributed creation time without mutating input', () => {
  const rows = [record()], steps = [step(12)], before = JSON.stringify([rows, steps]);
  const applied = applyGenerationMetadata(rows, steps);
  assert.equal(applied[0].timestamp.value, 1_800_000_000_123); assert.equal(applied[0].timestamp.source, 'step-created');
  assert.equal(JSON.stringify([rows, steps]), before);
});

test('no response match stays missing and multiple matching steps conflict even at equal times', () => {
  assert.equal(applyGenerationMetadata([record()], [step(5, 'other-id')])[0].timestamp.status, 'missing');
  assert.equal(applyGenerationMetadata([record()], [step(12), step(13)])[0].timestamp.status, 'conflict');
  assert.equal(applyGenerationMetadata([record()], [step(12), step(12)])[0].timestamp.status, 'conflict');
  assert.equal(applyGenerationMetadata([record()], [step(12)])[0].timestamp.status, 'provided');
  // A separate DB invocation has no cached response evidence from the first.
  assert.equal(applyGenerationMetadata([record()], [])[0].timestamp.status, 'missing');
});

test('generation dates take precedence and invalid/conflicting direct evidence is never hidden by steps', () => {
  const directRow = record('synthetic-id', direct(time(200)));
  assert.equal(applyGenerationMetadata([directRow], [step(12)])[0].timestamp.value, 200000);
  assert.equal(applyGenerationMetadata([directRow], [step(12)])[0].timestamp.source, 'generation');
  for (const row of [record('synthetic-id', direct(time(200, 1_000_000_000))), record('synthetic-id', message(9, Buffer.concat([message(4, time(100)), message(4, time(200))])))]) {
    const before = JSON.stringify(row.timestamp); assert.equal(JSON.stringify(applyGenerationMetadata([row], [step(12)])[0].timestamp), before);
  }
});

test('a unique matching step with no creation time stays missing rather than manufacturing epoch', () => {
  const metadata = parseGenerationStepMetadata(12, message(9, message(11, 'synthetic-id')));
  assert.equal(applyGenerationMetadata([record()], [metadata])[0].timestamp.status, 'missing');
});

test('workspace uses a safe decoded basename and opaque URI digest without exposing a private path', () => {
  const uri = 'file:///C:/Users/synthetic-private/home/My%20workspace'; const parsed = workspace(uri);
  assert.equal(parsed.status, 'provided'); assert.equal(parsed.values[0].label, 'My workspace');
  assert.equal(parsed.values[0].key, createHash('sha256').update(uri).digest('hex'));
  assert.ok(!JSON.stringify(parsed).includes('synthetic-private')); assert.ok(!JSON.stringify(parsed).includes('file:///'));
});

test('workspace root and unsafe or long basenames receive anonymous labels', () => {
  for (const uri of ['file:///', 'file:///C:/', 'file:///home/%2Fprivate', 'file:///home/%5Cprivate', 'file:///home/' + 'a'.repeat(81), 'file:///home/%E2%80%AEprivate']) {
    const parsed = workspace(uri); assert.equal(parsed.status, 'provided'); assert.match(parsed.values[0].label, /^Workspace [a-f0-9]{8}$/);
  }
});

test('multiple distinct workspace URIs remain a conflict and repeated same URI stays one workspace', () => {
  const first = 'file:///one/project', second = 'file:///two/project';
  const multiple = workspace(first, second); assert.equal(multiple.status, 'conflict'); assert.equal(multiple.values.length, 2);
  assert.notEqual(multiple.values[0].key, multiple.values[1].key); assert.equal(multiple.values[0].label, 'project');
  const repeated = workspace(first, first); assert.equal(repeated.status, 'provided'); assert.equal(repeated.values.length, 1);
});

test('missing, invalid wire and invalid UTF-8 workspace metadata retain explicit states', () => {
  assert.deepEqual(workspace(), { status: 'missing', values: [], fields: [] }); assert.equal(workspace('').status, 'missing');
  for (const wire of [number(1, 1), message(1, number(1, 1)), message(1, message(1, Buffer.from([255]))), Buffer.from([15]), Buffer.alloc(1024 * 1024 + 1)])
    assert.equal(parseGenerationWorkspaceMetadata(wire).status, 'invalid');
});

test('applying workspace metadata clones evidence and never invents Git or cloud ownership', () => {
  const evidence = workspace('file:///one/project', 'file:///two/project'), rows = [record()], before = JSON.stringify([rows, evidence]);
  const applied = applyGenerationMetadata(rows, [], evidence); assert.equal(applied[0].project.status, 'conflict');
  applied[0].project.values[0].label = 'changed'; assert.equal(JSON.stringify([rows, evidence]), before);
  assert.ok(!JSON.stringify(evidence).includes('file:///')); assert.equal(evidence.gitRoot, undefined); assert.equal(evidence.cloudProject, undefined);
});

test('duplicate date evidence preserves fields, enriches missing data and prefers generation attribution on agreement', () => {
  const a = record(), b = record(); a.timestamp = { status: 'provided', value: 1000, fields: ['synthetic.step'], source: 'step-created' };
  b.timestamp = { status: 'provided', value: 1000, fields: ['synthetic.generation'], source: 'generation' };
  for (const rows of [[a, b], [b, a]]) {
    const merged = mergeLocalRecords(rows)[0]; assert.equal(merged.timestamp.source, 'generation'); assert.equal(merged.timestamp.value, 1000); assert.equal(merged.timestamp.fields.length, 2);
  }
  assert.equal(mergeLocalRecords([record(), a])[0].timestamp.value, 1000);
  b.timestamp.value = 2000; const conflict = mergeLocalRecords([a, b])[0]; assert.equal(conflict.timestamp.status, 'conflict'); assert.equal(conflict.timestamp.value, undefined);
});

test('duplicate workspace provenance merges while distinct directories stay a conflict', () => {
  const a = record(), b = record(); a.project = workspace('file:///one/project'); b.project = structuredClone(a.project); b.project.fields = ['synthetic.alternate.workspace'];
  assert.equal(mergeLocalRecords([record(), a])[0].project.status, 'provided');
  const merged = mergeLocalRecords([a, b])[0]; assert.equal(merged.project.status, 'provided'); assert.equal(merged.project.fields.length, 2);
  b.project = workspace('file:///two/project'); const conflict = mergeLocalRecords([a, b])[0]; assert.equal(conflict.project.status, 'conflict'); assert.equal(conflict.project.values.length, 2);
});

test('step linkage completeness distinguishes legal absent identity from malformed or conflicting identity', () => {
  for (const wire of [Buffer.alloc(0), message(1, time(100)), message(9, Buffer.alloc(0)), message(9, message(11, ''))])
    assert.equal(parseGenerationStepMetadata(12, wire).linkageComplete, true);
  for (const wire of [Buffer.from([15]), number(9, 1), message(9, Buffer.from([15])), message(9, number(11, 1)), message(9, message(11, Buffer.from([255]))), message(9, message(11, Buffer.alloc(257, 97))), message(9, Buffer.concat([message(11, 'one'), message(11, 'two')])), Buffer.concat([message(9, message(11, 'one')), message(9, message(11, 'one'))])]) {
    const parsed = parseGenerationStepMetadata(12, wire);
    assert.equal(parsed.linkageComplete, false); assert.equal(parsed.responseKey, undefined);
  }
  const sameIdentity = parseGenerationStepMetadata(12, message(9, Buffer.concat([message(11, 'same'), message(11, 'same')])));
  assert.equal(sameIdentity.linkageComplete, true); assert.equal(sameIdentity.responseKey, createHash('sha256').update('same').digest('hex'));
});

test('a single unreadable step disables all fallback joins without hiding a direct generation date', () => {
  for (const wire of [Buffer.from([15]), number(9, 1), message(9, number(11, 1)), message(9, message(11, Buffer.from([255])))]) {
    const steps = [step(1), parseGenerationStepMetadata(2, wire)];
    assert.equal(applyGenerationMetadata([record()], steps)[0].timestamp.status, 'missing');
    const directRow = record('synthetic-id', direct(time(100)));
    assert.deepEqual(applyGenerationMetadata([directRow], steps)[0].timestamp, directRow.timestamp);
  }
});

test('only absolute filesystem workspace URIs without credentials, queries or fragments are accepted', () => {
  const remote = workspace('vscode-remote://wsl+Synthetic/home/workspace'); assert.equal(remote.status, 'provided'); assert.equal(remote.values[0].label, 'workspace');
  const unc = workspace('file://synthetic-host/shared/workspace'); assert.equal(unc.status, 'provided'); assert.equal(unc.values[0].label, 'workspace');
  for (const uri of ['not-a-uri', 'data:text/plain,synthetic-private-payload', 'https://synthetic.example.test/workspace', 'file:relative', 'vscode-remote:relative', 'vscode-remote://user:synthetic-private-password@host/workspace', 'file:///home/project?secret=synthetic-private-value', 'file:///home/project#synthetic-private-value', 'file:///home/%00project', 'file:///home/' + String.fromCharCode(1)]) {
    const parsed = workspace(uri); assert.equal(parsed.status, 'invalid'); assert.deepEqual(parsed.values, []);
    assert.ok(!JSON.stringify(parsed).includes('synthetic-private'));
  }
});

test('workspace and URI count limits prevent a large metadata fanout into generation records', () => {
  const payload = Buffer.concat(Array.from({ length: 4096 }, (_, index) => message(1, message(1, 'file:///workspace-' + index))));
  const oversized = parseGenerationWorkspaceMetadata(payload); assert.equal(oversized.status, 'invalid'); assert.deepEqual(oversized.values, []);
  const rows = Array(1000).fill(record()); const applied = applyGenerationMetadata(rows, [], oversized);
  assert.equal(applied.length, 1000); assert.equal(applied[999].project.values.length, 0); assert.ok(Buffer.byteLength(JSON.stringify(applied)) < 2 * 1024 * 1024);
  const tooManyUris = parseGenerationWorkspaceMetadata(message(1, Buffer.concat(Array.from({ length: 17 }, (_, index) => message(1, 'file:///workspace-' + index)))));
  assert.equal(tooManyUris.status, 'invalid'); assert.deepEqual(tooManyUris.values, []);
  const manyLegal = workspace(...Array.from({ length: 16 }, (_, index) => 'file:///workspace-' + index));
  assert.equal(manyLegal.status, 'conflict'); assert.equal(manyLegal.values.length, 2);
});

test('many ambiguous matching steps retain one fixed provenance field per generation record', () => {
  const steps = Array.from({ length: 2000 }, (_, index) => step(index)); const rows = Array(1000).fill(record());
  const applied = applyGenerationMetadata(rows, steps);
  assert.equal(applied.length, 1000); assert.equal(applied[999].timestamp.status, 'conflict');
  assert.deepEqual(applied[999].timestamp.fields, ['steps.metadata.createdAt']); assert.ok(Buffer.byteLength(JSON.stringify(applied)) < 2 * 1024 * 1024);
});

test('a BOM-prefixed response identity never agrees with different unprefixed bytes', () => {
  const plain = Buffer.from('synthetic-id'), prefixed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  for (const identities of [[plain, prefixed], [prefixed, plain]]) {
    const wire = message(9, Buffer.concat(identities.map(value => message(11, value))));
    const metadata = parseGenerationStepMetadata(2, wire);
    assert.equal(metadata.linkageComplete, false); assert.equal(metadata.responseKey, undefined);
    assert.equal(applyGenerationMetadata([record()], [step(1), metadata])[0].timestamp.status, 'missing');
    assert.equal(parseLocalGeneration('synthetic-session', 5, generation(Buffer.concat(identities.map(value => message(11, value))))).key, 'synthetic-session:generation:5');
  }
  const identical = parseGenerationStepMetadata(2, message(9, Buffer.concat([message(11, prefixed), message(11, prefixed)])));
  assert.equal(identical.linkageComplete, true); assert.equal(identical.responseKey, createHash('sha256').update(prefixed).digest('hex'));
});
