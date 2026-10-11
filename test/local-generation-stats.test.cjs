const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { responseModels } = require('../out/model-observation');
const { buildLocalGenerationStats, aggregateGenerationStats, deduplicateGenerationStatsRows, generationModelCategory } = require('../out/local-generation-stats');
const now = Date.parse('2026-10-11T12:00:00Z');
function row(id = 'one', at) {
  const values = { input: 10, cacheRead: 20, cacheWrite: 30, outputText: 5, reasoning: 4, outputTotal: 9 };
  const record = { session: 'synthetic-session', index: 1, usageInterpretation: 'verified', key: 'synthetic-session:response:' + createHash('sha256').update(id).digest('hex'), requested: responseModels({}), returned: responseModels({model:'synthetic-return-a'}), tokens: Object.fromEntries(Object.entries(values).map(([metric, value]) => [metric, { status: 'provided', value, fields: ['synthetic.'+metric] }])) }; 
  if (at !== undefined) record.timestamp = { status: 'provided', value: Date.parse(at), fields: ['synthetic.verifiedTime'] };
  return record;
}
const options = { range: 'all', now, timeZone: 'UTC' };

test('counts metadata records separately from verified response identity, without treating indices as requests', () => {
  const response = row('response'), indexed = row('indexed'); indexed.key = 'synthetic-session:generation:9';
  const result = buildLocalGenerationStats([response, indexed], options);
  assert.equal(result.summary.recordCount, 2); assert.equal(result.summary.verifiedResponseCount, 1);
  assert.equal(result.unknownTimeCount, 2); assert.deepEqual(result.trend, []);
  assert.equal(result.summary.tokens.input.sum, 20); assert.equal(result.summary.tokens.cacheRead.sum, 40); assert.equal(result.summary.tokens.cacheWrite.sum, 60);
  assert.equal('recordedTotal' in result.summary.tokens, false);
  assert.equal(result.summary.tokens.outputTotal.sum, 18);
  // Do not add text/reasoning again to the reported output total.
  assert.equal(result.summary.tokens.outputText.sum, 10); assert.equal(result.summary.tokens.reasoning.sum, 8);
});

test('unknown times are visible but never allocated to calendar ranges or trends, including forged mtime/index', () => {
  const unknown = { ...row(), index: now, mtimeMs: now }, known = row('known', '2026-10-11T00:00:00Z');
  const result = buildLocalGenerationStats([unknown, known], { ...options, range: 'today' });
  assert.equal(result.readRecordCount, 2); assert.equal(result.summary.recordCount, 1);
  assert.equal(result.unknownTimeCount, 1); assert.equal(result.undatedRows[0].key, unknown.key);
  assert.equal(result.trend.length, 1); assert.equal(result.trend[0].recordCount, 1);
  assert.equal(buildLocalGenerationStats([unknown], { ...options, range: '30d' }).summary.tokens.input.sum, undefined);
});

test('time needs provided status, bounded integer epoch milliseconds and an identified verified source', () => {
  const times = [undefined, { status: 'missing', value: now, fields: ['source'] }, { status: 'conflict', fields: ['source'] },
    { status: 'provided', value: NaN, fields: ['source'] }, { status: 'provided', value: now + .5, fields: ['source'] },
    { status: 'provided', value: 8.64e15, fields: ['source'] }, { status: 'provided', value: now, fields: [] }];
  const records = times.map((timestamp, i) => ({ ...row(String(i)), timestamp }));
  const result = buildLocalGenerationStats(records, { ...options, range: 'today' });
  assert.equal(result.unknownTimeCount, records.length); assert.equal(result.summary.recordCount, 0);
});

test('calendar boundaries include local midnight and exclude previous days and future records', () => {
  const records = [row('before', '2026-10-10T15:59:59.999Z'), row('midnight', '2026-10-10T16:00:00Z'), row('now', '2026-10-11T12:00:00Z'), row('future', '2026-10-11T12:00:00.001Z')];
  const result = buildLocalGenerationStats(records, { now, timeZone: 'Asia/Shanghai', range: 'today' });
  assert.equal(result.startLocalDate, '2026-10-11'); assert.equal(result.throughLocalDate, '2026-10-11');
  assert.deepEqual(new Set(result.rows.map(r => r.key)), new Set(records.slice(1, 3).map(r => r.key)));
  assert.equal(result.futureTimeCount, 1); assert.equal(result.trend[0].recordCount, 2);
});

test('seven and thirty days are inclusive calendar windows with empty daily points', () => {
  const records = [row('before', '2026-10-04T23:59:59.999Z'), row('first', '2026-10-05T00:00:00Z'), row('today', '2026-10-11T12:00:00Z')];
  const seven = buildLocalGenerationStats(records, { ...options, range: '7d' });
  assert.equal(seven.startLocalDate, '2026-10-05'); assert.equal(seven.summary.recordCount, 2);
  assert.equal(seven.trend.length, 7); assert.equal(seven.trend[1].recordCount, 0);
  assert.equal(seven.trend[1].tokens.outputTotal.sum, undefined);
  const thirty = buildLocalGenerationStats(records, { ...options, range: '30d' });
  assert.equal(thirty.startLocalDate, '2026-09-12'); assert.equal(thirty.trend.length, 30); assert.equal(thirty.summary.recordCount, 3);
});

test('spring DST uses a 23-hour local day rather than subtracting fixed hours', () => {
  const records = [row('before', '2026-03-08T04:59:59.999Z'), row('first', '2026-03-08T05:00:00Z'), row('late', '2026-03-09T03:59:59.999Z'), row('next', '2026-03-09T04:00:00Z')];
  const result = buildLocalGenerationStats(records, { range: 'today', now: Date.parse('2026-03-09T03:59:59.999Z'), timeZone: 'America/New_York' });
  assert.equal(result.startLocalDate, '2026-03-08'); assert.equal(result.summary.recordCount, 2); assert.equal(result.futureTimeCount, 1);
});

test('fall DST keeps both repeated hours in the same 25-hour local day', () => {
  const records = [row('start', '2026-11-01T04:00:00Z'), row('repeatA', '2026-11-01T05:30:00Z'), row('repeatB', '2026-11-01T06:30:00Z'), row('end', '2026-11-02T04:59:59.999Z'), row('before', '2026-11-01T03:59:59.999Z')];
  const result = buildLocalGenerationStats(records, { range: 'today', now: Date.parse('2026-11-02T04:59:59.999Z'), timeZone: 'America/New_York' });
  assert.equal(result.summary.recordCount, 4); assert.equal(result.trend[0].recordCount, 4);
});

test('safe totals retain zero, do not fill missing fields, and expose coverage and partial totals', () => {
  const complete = row('complete'), missing = row('missing'), zero = row('zero');
  missing.tokens.cacheRead = { status: 'missing', fields: [] }; zero.tokens.cacheRead = { status: 'provided', value: 0, fields: ['source'] };
  const tokens = aggregateGenerationStats([complete, missing, zero]).tokens;
  assert.deepEqual(tokens.cacheRead, { status: 'partial', sum: 20, knownCount: 2, missingCount: 1, invalidCount: 0, conflictCount: 0, totalCount: 3 });
  assert.equal(tokens.cacheWrite.status, 'complete'); assert.equal(tokens.cacheWrite.sum, 90);
  assert.equal(aggregateGenerationStats([zero]).tokens.cacheRead.sum, 0);
  assert.equal(aggregateGenerationStats([missing]).tokens.cacheRead.sum, undefined);
});

test('invalid/conflicting/unsafe tokens remain uncovered and never poison other independent metrics', () => {
  const invalid = row('invalid'), conflict = row('conflict'), negative = row('negative'), unsafe = row('unsafe');
  invalid.tokens.input = { status: 'invalid', fields: ['source'] };
  conflict.tokens.input = { status: 'conflict', fields: ['source'] };
  negative.tokens.input.value = -1; unsafe.tokens.input.value = Number.MAX_SAFE_INTEGER + 1;
  const tokens = aggregateGenerationStats([invalid, conflict, negative, unsafe]).tokens;
  assert.equal(tokens.input.sum, undefined); assert.equal(tokens.input.invalidCount, 3); assert.equal(tokens.input.conflictCount, 1);
  assert.equal(tokens.outputTotal.sum, 36); assert.equal(tokens.cacheRead.sum, 80);
});

test('integer aggregate overflow withhold sums explicitly, without rounding', () => {
  const a = row('a'), b = row('b'); a.tokens.input.value = Number.MAX_SAFE_INTEGER; b.tokens.input.value = 1;
  const result = aggregateGenerationStats([a, b]);
  assert.equal(result.tokens.input.status, 'overflow'); assert.equal(result.tokens.input.sum, undefined); assert.equal(result.tokens.input.knownCount, 2);
  assert.equal(aggregateGenerationStats([a]).tokens.input.sum, Number.MAX_SAFE_INTEGER);
  assert.equal(aggregateGenerationStats([a]).tokens.cacheRead.sum, 20);
});

test('duplicate response identity deduplicates within client/session only and never mutates source evidence', () => {
  const a = row(), duplicate = { ...structuredClone(a), index: 8 }, otherClient = { ...structuredClone(a), client: 'ide' }, otherSession = { ...structuredClone(a), session: 'other-session' };
  const records = [a, duplicate, otherClient, otherSession], before = JSON.stringify(records);
  const result = buildLocalGenerationStats(records, options);
  assert.equal(result.readRecordCount, 3); assert.equal(result.duplicatesRemoved, 1); assert.equal(result.summary.recordCount, 3);
  assert.equal(result.summary.tokens.input.sum, 30); assert.equal(JSON.stringify(records), before);
});

test('duplicates with conflicting evidence lose conflicting usage instead of last-wins or duplicate addition', () => {
  const a = row(), b = structuredClone(a); b.tokens.outputTotal.value = 99; b.returned = responseModels({ model: 'synthetic-other' });
  const result = buildLocalGenerationStats([a, b], options);
  assert.equal(result.summary.recordCount, 1); assert.equal(result.summary.tokens.outputTotal.conflictCount, 1);
  assert.equal(result.summary.tokens.input.sum, 10); assert.equal(result.summary.tokens.cacheRead.sum, 20);
  assert.equal(result.rows[0].issue, 'duplicateConflict'); assert.equal(generationModelCategory(result.rows[0]).key, 'status:conflict');
});

test('duplicate time/project evidence merges provenance, but disagreement becomes undated/unassigned', () => {
  const a = row('a', '2026-10-11T10:00:00Z'), b = structuredClone(a);
  a.project = { status: 'provided', values: [{key: 'a'.repeat(64), label: 'synthetic-project-a'}], fields: ['sourceA'] };
  b.project = { status: 'provided', values: [{key: 'b'.repeat(64), label: 'synthetic-project-b'}], fields: ['sourceB'] };
  b.timestamp.value += 1;
  const merged = deduplicateGenerationStatsRows([a, b])[0];
  assert.deepEqual(merged.project, { status: 'conflict', fields: ['sourceA', 'sourceB'], values: [...a.project.values, ...b.project.values] }); assert.equal(merged.timestamp.status, 'conflict');
  assert.equal(buildLocalGenerationStats([a, b], { ...options, range: 'today' }).unknownTimeCount, 1);
});

test('an absent duplicate time can gain verified evidence, and missing does not replace provided', () => {
  const a = row(), b = row('one', '2026-10-11T10:00:00Z');
  for (const records of [[a, b], [b, a], [{ ...a, timestamp: { status: 'missing', fields: [] } }, b]]) {
    assert.equal(buildLocalGenerationStats(records, { ...options, range: 'today' }).summary.recordCount, 1);
  }
});

test('multi-declaration model conflicts use one bucket and cannot be included by either individual model filter', () => {
  const a = row('a'), conflict = row('conflict'), missing = row('missing'), invalid = row('invalid');
  conflict.returned = responseModels({ model: 'synthetic-return-a', response: { model: 'synthetic-other' } });
  missing.returned = responseModels({}); invalid.returned = responseModels({ model: null });
  const records = [a, conflict, missing, invalid], result = buildLocalGenerationStats(records, options);
  assert.equal(result.modelOptions.reduce((n, m) => n + m.recordCount, 0), 4);
  assert.equal(buildLocalGenerationStats(records, { ...options, model: 'model:synthetic-return-a' }).summary.recordCount, 1);
  assert.equal(buildLocalGenerationStats(records, { ...options, model: 'model:synthetic-other' }).summary.recordCount, 0);
  assert.equal(buildLocalGenerationStats(records, { ...options, model: 'status:conflict' }).summary.recordCount, 1);
  assert.equal(buildLocalGenerationStats(records, { ...options, model: 'status:missing' }).unknownTimeCount, 1);
});

test('provided model must contain exactly one valid declaration with no invalid/truncated/conflict flags', () => {
  for (const returned of [{ status: 'provided', values: ['valid-a', 'valid-b'], fields: [] }, { status: 'provided', values: ['invalid value'], fields: [] }, { status: 'provided', values: ['valid-a'], fields: [], truncated: true }]) {
    assert.equal(generationModelCategory({ ...row(), returned }).key, 'status:invalid');
  }
});

test('all-time trends are sparse observed days only and deterministic details sort latest time then key', () => {
  const a = row('a', '2026-09-01T00:00:00Z'), b = row('b', '2026-10-11T11:00:00Z'), unknown = row('unknown');
  const result = buildLocalGenerationStats([a, unknown, b], options);
  assert.deepEqual(result.trend.map(t => t.day), ['2026-09-01', '2026-10-11']);
  assert.deepEqual(result.rows.map(r => r.key), [b.key, a.key, unknown.key]);
  assert.equal(result.trend.reduce((n, t) => n + t.recordCount, 0), 2); assert.equal(result.summary.recordCount, 3);
});

test('bad range, clock and timezone fail explicitly, while empty reads preserve no-data rather than zero', () => {
  for (const invalid of [{ range: 'bad' }, { now: NaN }, { now: Number.MAX_SAFE_INTEGER }, { timeZone: 'synthetic/invalid' }]) assert.throws(() => buildLocalGenerationStats([], invalid), /LOCAL_STATS_/);
  const empty = buildLocalGenerationStats([], options);
  assert.equal(empty.summary.recordCount, 0); assert.equal(empty.summary.tokens.outputTotal.sum, undefined); assert.deepEqual(empty.modelOptions, []);
});

test('unidentified usage schemas keep every metric missing with coverage, never an inferred zero', () => {
  const unknown = row();
  for (const metric of Object.keys(unknown.tokens)) unknown.tokens[metric] = { status: 'missing', fields: ['synthetic.unverifiedSchema'] };
  const result = buildLocalGenerationStats([unknown], options);
  assert.equal(result.summary.recordCount, 1);
  for (const metric of Object.values(result.summary.tokens)) {
    assert.equal(metric.status, 'missing'); assert.equal(metric.sum, undefined); assert.equal(metric.knownCount, 0); assert.equal(metric.missingCount, 1);
  }
});

test('workspace filter uses verified singleton opaque identity, never aliases equal basenames or chooses a first workspace', () => {
  const a = row('a'), b = row('b'), multi = row('multi'), missing = row('missing');
  a.project = { status: 'provided', values: [{ key: 'a'.repeat(64), label: 'same-name' }], fields: ['synthetic.workspace'] };
  b.project = { status: 'provided', values: [{ key: 'b'.repeat(64), label: 'same-name' }], fields: ['synthetic.workspace'] };
  multi.project = { status: 'conflict', values: [...a.project.values, ...b.project.values], fields: ['synthetic.workspace'] };
  const result = buildLocalGenerationStats([a, b, multi, missing], { ...options, project: a.project.values[0].key });
  assert.equal(result.projectOptions.length, 2); assert.equal(result.summary.recordCount, 1); assert.equal(result.rows[0].key, a.key);
  assert.equal(result.projectOptions.reduce((sum, option) => sum + option.recordCount, 0), 2);
  assert.equal(buildLocalGenerationStats([multi], { ...options, project: a.project.values[0].key }).summary.recordCount, 0);
});

test('unverified workspace observations and raw URI/path labels do not become project options', () => {
  for (const project of [{ status: 'provided', values: [{ key: 'a'.repeat(64), label: '/private/path' }], fields: ['source'] },
    { status: 'provided', values: [{ key: 'file:///private/path', label: 'project' }], fields: ['source'] },
    { status: 'provided', values: [{ key: 'a'.repeat(64), label: 'project' }], fields: [] },
    { status: 'missing', values: [{ key: 'a'.repeat(64), label: 'project' }], fields: ['source'] }]) {
    assert.deepEqual(buildLocalGenerationStats([{ ...row(), project }], options).projectOptions, []);
  }
});

test('same-token duplicate provenance merges without falsely invalidating its subtotal', () => {
  const a = row(), b = structuredClone(a); b.tokens.input.fields = ['synthetic.alternateEvidence'];
  const result = buildLocalGenerationStats([a, b], options);
  assert.equal(result.summary.tokens.input.status, 'complete'); assert.equal(result.summary.tokens.input.sum, 10);
  assert.deepEqual(result.rows[0].tokens.input.fields, ['synthetic.input', 'synthetic.alternateEvidence']);
});

test('unverified usage ignores even provided legacy numbers without hiding model or record identity', () => {
  const unverified = { ...row('unverified'), usageInterpretation: 'unverified' }, verified = { ...row('verified'), usageInterpretation: 'verified' };
  const result = buildLocalGenerationStats([unverified, verified], options);
  assert.equal(result.summary.recordCount, 2); assert.equal(result.modelOptions[0].recordCount, 2);
  for (const [key, value] of Object.entries(result.summary.tokens)) {
    assert.equal(value.status, 'partial'); assert.equal(value.knownCount, 1); assert.equal(value.missingCount, 1); assert.equal(value.sum, verified.tokens[key].value);
  }
  const unknown = buildLocalGenerationStats([unverified], options);
  for (const metric of Object.values(unknown.summary.tokens)) { assert.equal(metric.status, 'missing'); assert.equal(metric.sum, undefined); assert.equal(metric.missingCount, 1); }
  assert.equal(unknown.rows[0].returned.values[0], 'synthetic-return-a');
});

test('duplicate unverified usage cannot be promoted by a sibling row or input order', () => {
  const known = { ...row(), usageInterpretation: 'verified' }, unknown = { ...structuredClone(known), usageInterpretation: 'unverified' };
  for (const records of [[known, unknown], [unknown, known]]) {
    const result = buildLocalGenerationStats(records, options);
    assert.equal(result.summary.recordCount, 1); assert.equal(result.summary.tokens.input.sum, undefined); assert.equal(result.summary.tokens.input.missingCount, 1);
    assert.equal(result.rows[0].usageInterpretation, 'unverified');
  }
});

test('missing or unknown interpretation markers are uncovered even when every token is provided', () => {
  for (const marker of [undefined, null, '', 'trusted', 'VERIFIED', false, 1, {}]) {
    const unknown = { ...row(), usageInterpretation: marker };
    if (marker === undefined) delete unknown.usageInterpretation;
    const result = buildLocalGenerationStats([unknown], options);
    assert.equal(result.summary.recordCount, 1); assert.equal(result.modelOptions[0].recordCount, 1);
    for (const metric of Object.values(result.summary.tokens)) { assert.equal(metric.status, 'missing'); assert.equal(metric.sum, undefined); assert.equal(metric.missingCount, 1); }
  }
});

test('duplicate missing or unknown markers never gain trust from a verified sibling in either order', () => {
  for (const marker of [undefined, 'unknown', null]) {
    const verified = row(), unknown = { ...structuredClone(verified), usageInterpretation: marker };
    if (marker === undefined) delete unknown.usageInterpretation;
    for (const records of [[verified, unknown], [unknown, verified]]) {
      const result = buildLocalGenerationStats(records, options);
      assert.equal(result.summary.recordCount, 1); assert.equal(result.duplicatesRemoved, 1);
      assert.equal(result.rows[0].usageInterpretation, 'unverified');
      for (const metric of Object.values(result.summary.tokens)) { assert.equal(metric.sum, undefined); assert.equal(metric.missingCount, 1); }
    }
  }
});
