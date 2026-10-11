const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseLocalGeneration, mergeLocalRecords } = require(path.resolve(process.env.AG_SCHEMA_TEST_OUT || path.join(__dirname, '../out'), 'local-generation-record.js'));

function varint(value) {
  value = BigInt(value); const bytes = [];
  do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
const number = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field, value) => { value = Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]); };
function generation(usage, extraChat = Buffer.alloc(0), extraRoot = Buffer.alloc(0)) {
  return Buffer.concat([message(1, Buffer.concat([message(19, 'synthetic-returned-model'), message(4, usage), extraChat])), extraRoot]);
}
const metrics = ['input', 'cacheWrite', 'cacheRead', 'outputText', 'reasoning', 'outputTotal'];
function assertUnknown(row) {
  assert.equal(row.usageInterpretation, 'unverified');
  assert.equal(row.usageSchema, undefined);
  assert.deepEqual(Object.keys(row.tokens).sort(), [...metrics].sort());
  for (const token of Object.values(row.tokens)) assert.deepEqual(token, { status: 'missing', fields: [] });
  assert.deepEqual(row.timestamp, { status: 'missing', fields: [] });
  assert.deepEqual(row.project, { status: 'missing', values: [], fields: [] });
}

// Synthetic fixture fields reproduce the descriptor directly verified in the
// official Google Antigravity 1.7.0 extension.js (Win and WSL matching SHA256:
// bdae3f9573417e7806db598fdadea9d0db6a2106b589548354d47f26cdd356ea):
// root.chat_model #1 -> ChatModelMetadata.usage #4; response_model #19 string.
// ModelUsageStats: #1 enum model, #2 input, #3 output, #4 cache_write,
// #5 cache_read, #9 thinking_output, #10 response_output. The producer contract
// is explicit here; these synthetic bytes never identify a historical DB.
const officialSource = { schema: 'google-antigravity-1.7.0' };

test('explicit official source contract reads six distinct usage fields without counting the model enum', () => {
  const wire = Buffer.concat([number(1, 999), number(2, 7), number(3, 99), number(4, 12), number(5, 20), number(9, 4), number(10, 5)]);
  const row = parseLocalGeneration('synthetic-session', 0, generation(wire), officialSource);
  assert.equal(row.usageInterpretation, 'verified'); assert.equal(row.usageSchema, officialSource.schema);
  for (const [metric, field, value] of [['input', 2, 7], ['cacheWrite', 4, 12], ['cacheRead', 5, 20], ['reasoning', 9, 4], ['outputText', 10, 5], ['outputTotal', 3, 99]])
    assert.deepEqual(row.tokens[metric], { status: 'provided', value, fields: [`gen_metadata.chatModel.usage.#${field}`] });
  assert.equal(row.returned.values[0], 'synthetic-returned-model');
  // No descriptor guarantee says input excludes cache, or output equals the
  // text+thinking sum. Preserve all reported fields rather than invent a total.
  assert.equal(row.tokens.input.value, 7); assert.equal(row.tokens.outputTotal.value, 99);
  assert.deepEqual(row.timestamp, { status: 'missing', fields: [] });
  assert.deepEqual(row.project, { status: 'missing', values: [], fields: [] });
  assertUnknown(parseLocalGeneration('synthetic-session', 0, generation(wire)));
});

test('explicit source keeps omitted fields missing and does not derive total output', () => {
  const row = parseLocalGeneration('synthetic-session', 0, generation(Buffer.concat([number(1, 3), number(9, 4), number(10, 5)])), officialSource);
  for (const metric of ['input', 'cacheWrite', 'cacheRead', 'outputTotal']) assert.deepEqual(row.tokens[metric], { status: 'missing', fields: [] });
  assert.equal(row.tokens.reasoning.value, 4); assert.equal(row.tokens.outputText.value, 5);
});

test('explicitly reported zero stays provided while an omitted token is missing', () => {
  const row = parseLocalGeneration('synthetic-session', 0, generation(number(2, 0)), officialSource);
  assert.deepEqual(row.tokens.input, { status: 'provided', value: 0, fields: ['gen_metadata.chatModel.usage.#2'] });
  assert.deepEqual(row.tokens.outputTotal, { status: 'missing', fields: [] });
});

test('explicit source distinguishes duplicate scalar agreement, conflict, wrong wire and overflow', () => {
  const wire = Buffer.concat([number(2, 7), number(2, 7), number(3, 9), number(3, 10), message(4, 'not-a-number'), number(5, BigInt(Number.MAX_SAFE_INTEGER) + 1n), number(9, 2n ** 64n - 1n)]);
  const row = parseLocalGeneration('synthetic-session', 0, generation(wire), officialSource);
  assert.equal(row.tokens.input.status, 'provided'); assert.equal(row.tokens.input.value, 7);
  assert.deepEqual(row.tokens.outputTotal, { status: 'conflict', fields: ['gen_metadata.chatModel.usage.#3'] });
  assert.deepEqual(row.tokens.cacheWrite, { status: 'invalid', fields: ['gen_metadata.chatModel.usage.#4'] });
  assert.deepEqual(row.tokens.cacheRead, { status: 'invalid', fields: ['gen_metadata.chatModel.usage.#5'] });
  assert.equal(row.tokens.reasoning.status, 'invalid'); assert.equal(row.tokens.outputText.status, 'missing');
  assert.equal(row.returned.status, 'provided');
});

test('malformed known usage preserves the returned model but marks token fields invalid', () => {
  const row = parseLocalGeneration('synthetic-session', 0, generation(Buffer.from([15])), officialSource);
  assert.equal(row.issue, 'schemaUnsupported'); assert.equal(row.returned.status, 'provided');
  for (const token of Object.values(row.tokens)) assert.deepEqual(token, { status: 'invalid', fields: ['gen_metadata.chatModel.#4'] });
});

test('an unrecognized source contract never promotes historical usage', () => {
  const wire = Buffer.concat([number(2, 7), number(3, 9)]);
  for (const source of [{}, { schema: 'unknown' }, { schema: 'google-antigravity-1.7' }, { producerVerified: true }])
    assertUnknown(parseLocalGeneration('synthetic-session', 0, generation(wire), source));
});

test('unverified duplicate usage dominates matching numbers in either input order', () => {
  const wire = Buffer.concat([number(2, 7), number(3, 9), message(11, 'synthetic-id')]);
  const known = parseLocalGeneration('synthetic-session', 0, generation(wire), officialSource);
  const unverified = structuredClone(known); unverified.usageInterpretation = 'unverified';
  // Intentionally retain both the numeric values and stale schema tag: neither
  // matching numbers nor an attached tag may override the missing trust gate.
  for (const records of [[known, unverified], [unverified, known]]) {
    const before = JSON.stringify(records), merged = mergeLocalRecords(records);
    assert.equal(merged.length, 1); assertUnknown(merged[0]);
    assert.equal(merged[0].returned.status, 'provided'); assert.equal(JSON.stringify(records), before);
  }
  const absent = structuredClone(known); delete absent.usageInterpretation;
  assertUnknown(mergeLocalRecords([known, absent])[0]);
});

test('unversioned usage never labels the enum or swaps reasoning and response output', () => {
  // These same bytes fit both the old community numeric interpretation and the
  // extracted ModelUsageStats descriptor; wire shape cannot identify provenance.
  const wire = Buffer.concat([number(1, 3), number(2, 7), number(3, 9), number(4, 12), number(5, 20), number(9, 4), number(10, 5), message(11, 'synthetic-response-id')]);
  const oldInterpretation = parseLocalGeneration('synthetic-session', 1, generation(wire));
  const extractedInterpretation = parseLocalGeneration('synthetic-session', 2, generation(wire));
  assertUnknown(oldInterpretation); assertUnknown(extractedInterpretation);
  assert.equal(oldInterpretation.returned.values[0], 'synthetic-returned-model');
  assert.equal(oldInterpretation.requested.status, 'missing');
  assert.equal(oldInterpretation.key, extractedInterpretation.key);
  assert.equal(mergeLocalRecords([oldInterpretation, extractedInterpretation]).length, 1);
  assert.ok(!JSON.stringify(oldInterpretation).includes('synthetic-response-id'));
});

test('zero, huge values and inconsistent totals do not become trusted usage', () => {
  for (const wire of [Buffer.alloc(0), Buffer.concat(metrics.map((_, index) => number(index + 1, 0))), Buffer.concat([number(1, 2n ** 64n - 1n), number(2, 1), number(3, 100), number(9, 2), number(10, 3)])]) {
    const row = parseLocalGeneration('synthetic-session', 0, generation(wire)); assertUnknown(row);
    assert.equal(row.returned.status, 'provided');
  }
});

test('unsupported usage retains the independently read returned model declaration', () => {
  const row = parseLocalGeneration('synthetic-session', 0, generation(Buffer.from([15])));
  assertUnknown(row); assert.equal(row.issue, 'schemaUnsupported');
  assert.equal(row.returned.values[0], 'synthetic-returned-model');
});

test('timestamp shaped messages and explicit step indices are not guessed into dates', () => {
  const timestamp = Buffer.concat([number(1, 1_800_000_000), number(2, 123_000_000)]);
  const row = parseLocalGeneration('synthetic-session', 100, generation(Buffer.alloc(0), message(9, message(4, timestamp)), Buffer.concat([number(2, 1), message(2, Buffer.concat([varint(2), varint(3)]))])));
  assertUnknown(row); assert.equal(row.index, 100); assert.equal(row.returned.status, 'provided');
});

test('bounded response identity remains opaque, while ambiguous identities do not merge', () => {
  for (const identity of [message(11, ''), message(11, Buffer.alloc(257, 97)), number(11, 1), Buffer.concat([message(11, 'one'), message(11, 'two')])]) {
    const a = parseLocalGeneration('synthetic-session', 1, generation(identity));
    const b = parseLocalGeneration('synthetic-session', 2, generation(identity));
    assert.equal(a.key, 'synthetic-session:generation:1'); assert.equal(mergeLocalRecords([a, b]).length, 2);
  }
});

test('same response with differing model declarations stays a conflict without invented tokens', () => {
  const wire = message(11, 'synthetic-id');
  const a = parseLocalGeneration('synthetic-session', 1, generation(wire));
  const b = parseLocalGeneration('synthetic-session', 2, generation(wire, message(19, 'another-model')));
  const before = JSON.stringify([a, b]); const merged = mergeLocalRecords([a, b]);
  assert.equal(merged.length, 1); assert.equal(merged[0].issue, 'duplicateConflict');
  assert.equal(merged[0].returned.status, 'conflict'); assertUnknown(merged[0]);
  assert.equal(JSON.stringify([a, b]), before);
});

test('malformed metadata remains bounded and supplies no token, date or workspace evidence', () => {
  for (const wire of [Buffer.from([10, 255]), Buffer.from([15]), Buffer.alloc(1024 * 1024 + 1)]) {
    const row = parseLocalGeneration('synthetic-session', 0, wire);
    assertUnknown(row); assert.equal(row.issue, 'schemaUnsupported'); assert.equal(row.returned.status, 'invalid');
  }
});

test('duplicate date and workspace evidence merges provenance while disagreements remain explicit', () => {
  const a = parseLocalGeneration('synthetic-session', 1, generation(message(11, 'synthetic-id')));
  a.timestamp = { status: 'provided', value: 1000, fields: ['synthetic.time.a'] };
  a.project = { status: 'provided', values: [{ key: 'a'.repeat(64), label: 'workspace' }], fields: ['synthetic.workspace.a'] };
  const b = structuredClone(a); b.timestamp.fields = ['synthetic.time.b']; b.project.fields = ['synthetic.workspace.b'];
  const matched = mergeLocalRecords([a, b])[0];
  assert.equal(matched.timestamp.status, 'provided'); assert.deepEqual(matched.timestamp.fields, ['synthetic.time.a', 'synthetic.time.b']);
  assert.equal(matched.project.status, 'provided'); assert.deepEqual(matched.project.fields, ['synthetic.workspace.a', 'synthetic.workspace.b']);
  b.timestamp.value = 2000; b.project.values[0] = { key: 'b'.repeat(64), label: 'other' };
  const conflict = mergeLocalRecords([a, b])[0];
  assert.equal(conflict.timestamp.status, 'conflict'); assert.equal(conflict.timestamp.value, undefined);
  assert.equal(conflict.project.status, 'conflict'); assert.equal(conflict.project.values.length, 2);
  assert.equal(conflict.issue, 'duplicateConflict'); assert.equal(a.timestamp.value, 1000);
});
