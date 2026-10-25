const { test } = require('node:test');
const assert = require('node:assert/strict');

// Reduced control-flow model of exact official 1.9.0 source, SHA256
// f77a37c4bd66612f4ed26d9e80ce3969af543f853e2cc113ca466e7f8b6aa880.
// Tests the opt-in predicate and cancellation distinction, not real RPC or
// proof of a particular installed manager's configuration history.
function fixture(value, environmentOverride) {
  let resolveStop;
  const state = { value, stopped: false, timer: undefined, starts: 0 };
  const enabled = () => environmentOverride !== '1' && (state.value ?? false) === true;
  const stop = () => { state.stopped = true; state.timer = undefined; };
  const schedule = () => {
    if (!state.stopped && enabled() && !state.timer) {
      state.timer = async () => {
        state.timer = undefined;
        stop();
        await new Promise(resolve => { resolveStop = resolve; });
        state.starts++;
      };
    }
  };
  return { state, enabled, schedule, stop, exit: () => resolveStop() };
}

test('unconfigured 1.9 recovery is disabled, not enabled by version', () => {
  const m = fixture();
  m.schedule();
  assert.equal(m.enabled(), false);
  assert.equal(m.state.timer, undefined);
});
test('only boolean true opts in; explicit disable environment wins', () => {
  for (const value of [false, undefined, null, 'true', 1]) {
    const m = fixture(value); m.schedule(); assert.equal(m.state.timer, undefined);
  }
  const m = fixture(true); m.schedule(); assert.equal(typeof m.state.timer, 'function');
  const disabled = fixture(true, '1'); disabled.schedule(); assert.equal(disabled.state.timer, undefined);
});
test('continuously disabled ready instance does not acquire an automatic restart during stop', () => {
  const m = fixture(false);
  m.schedule(); m.stop(); m.schedule();
  assert.equal(m.state.timer, undefined);
  assert.equal(m.state.starts, 0);
});
test('stop cancels a scheduled but not entered recovery callback', () => {
  const m = fixture(true); m.schedule(); m.stop();
  assert.equal(m.state.timer, undefined);
  assert.equal(m.state.starts, 0);
});
test('changing current configuration to false does not cancel entered restart', async () => {
  const m = fixture(true); m.schedule();
  const entered = m.state.timer();
  m.state.value = false; m.stop();
  assert.equal(m.enabled(), false);
  m.exit(); await entered;
  assert.equal(m.state.starts, 1);
});
