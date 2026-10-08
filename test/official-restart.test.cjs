const test = require('node:test');
const assert = require('node:assert/strict');
const { generation } = require('../out/live-hub');
const { canRestartOfficialComponent, restartOfficialComponent, OFFICIAL_RECONNECT, OFFICIAL_FOCUS } = require('../out/official-restart');
const { enterImageOperation, enterAccountChange } = require('../out/image-activity');
const api = { port: 45678, csrfToken: 'offline-restart-fixture' };
function fixture() {
 let current, processes = 0, clock = 0; const commands = [];
 const runtime = { api: () => current, assertCurrent() {}, processCount: async () => processes,
  execute: async command => { commands.push(command); if (command === OFFICIAL_FOCUS) { current = { ...api }; processes = 1; } },
  wait: async ms => { clock += ms; }, now: () => clock, timeoutMs: 400 };
 return { runtime, commands, set: (value, count) => { current = value; processes = count; } };
}
test('capability selection requires both observed official commands without version pinning', () => {
 assert.equal(canRestartOfficialComponent([OFFICIAL_RECONNECT, OFFICIAL_FOCUS]), true);
 assert.equal(canRestartOfficialComponent([OFFICIAL_RECONNECT, 'workbench.action.reloadWindow']), false);
 assert.equal(canRestartOfficialComponent(['antigravity.triggerUpdate', OFFICIAL_FOCUS]), false);
});
test('controlled fixed-port restart changes local generation only after zero-to-one backend transition', async () => {
 const f = fixture(), previous = generation(api);
 const next = await restartOfficialComponent(previous, f.runtime);
 assert.notEqual(next, previous); assert.equal(generation({ ...api }), next);
 assert.deepEqual(f.commands, [OFFICIAL_RECONNECT, OFFICIAL_FOCUS]);
});
test('recovery beginning from an already stopped hub cannot reuse its previous fixed-port epoch', async () => {
 const previous = generation(api), f = fixture();
 const next = await restartOfficialComponent('stopped', f.runtime);
 assert.notEqual(next, previous); assert.equal(generation(api), next);
});
test('two consecutive stops and reconnects retain commands and produce distinct generations', async () => {
 const f=fixture(),first=await restartOfficialComponent(generation(api),f.runtime);
 f.set(undefined,0);
 const second=await restartOfficialComponent(first,f.runtime);
 assert.notEqual(second,first);assert.equal(generation(api),second);
 assert.deepEqual(f.commands,[OFFICIAL_RECONNECT,OFFICIAL_FOCUS,OFFICIAL_RECONNECT,OFFICIAL_FOCUS]);
});
test('second reconnect failure preserves its stage and does not issue focus or window reload', async () => {
 const f=fixture();await restartOfficialComponent(generation(api),f.runtime);f.set(undefined,0);
 f.runtime.execute=async command=>{f.commands.push(command);throw Error('synthetic private command failure');};
 await assert.rejects(restartOfficialComponent('stopped',f.runtime),e=>e.code==='OFFICIAL_COMPONENT_RECONNECT_FAILED'&&!e.message.includes('private'));
 assert.deepEqual(f.commands,[OFFICIAL_RECONNECT,OFFICIAL_FOCUS,OFFICIAL_RECONNECT]);
 const g=fixture();g.runtime.execute=async command=>{g.commands.push(command);if(command===OFFICIAL_FOCUS)throw Error('synthetic private panel failure');};
 await assert.rejects(restartOfficialComponent('stopped',g.runtime),e=>e.code==='OFFICIAL_COMPONENT_FOCUS_FAILED'&&!e.message.includes('private'));
});
test('running, multiple and changing backends are rejected without claiming a new generation', async () => {
 for (const initial of [[api, 1], [undefined, 1]]) {
  const f = fixture(), previous = generation(api); f.set(...initial);
  await assert.rejects(restartOfficialComponent(previous, f.runtime), /OFFICIAL_BACKEND_NOT_STOPPED/);
  assert.deepEqual(f.commands, []); assert.equal(generation(api), previous);
 }
 const f = fixture(), previous = generation(api);
 f.runtime.execute = async () => { f.set(api, 2); };
 await assert.rejects(restartOfficialComponent(previous, f.runtime), /CLOSE_OTHER_AGY_PROCESSES/);
 assert.equal(generation(api), previous);
});
test('restart timeout and changed extension keep pending state and never call window reload', async () => {
 const f = fixture(), previous = generation(api);
 f.runtime.execute = async command => { f.commands.push(command); };
 await assert.rejects(restartOfficialComponent(previous, f.runtime), /OFFICIAL_COMPONENT_RESTART_TIMEOUT/);
 assert.equal(generation(api), previous);
 assert.deepEqual(f.commands, [OFFICIAL_RECONNECT, OFFICIAL_FOCUS]);
 const g = fixture(); let checks = 0;
 g.runtime.assertCurrent = () => { if (++checks > 2) throw Error('HUB_CHANGED_DURING_OPERATION'); };
 await assert.rejects(restartOfficialComponent(previous, g.runtime), /HUB_CHANGED_DURING_OPERATION/);
 assert.equal(generation(api), previous);
});
test('backend starting during the stopped-process query prevents reconnect dispatch', async () => {
 const f=fixture(),previous=generation(api);
 f.runtime.processCount=async()=>{f.set(api,1);return 0;};
 await assert.rejects(restartOfficialComponent('stopped',f.runtime),/OFFICIAL_BACKEND_NOT_STOPPED/);
 assert.deepEqual(f.commands,[]);assert.equal(generation(api),previous);
});
test('a hung official command times out without fabricating a restart or issuing private fallback commands', async () => {
 const f = fixture(), previous = generation(api); f.runtime.timeoutMs = 10;
 let resume;
 f.runtime.execute = command => { f.commands.push(command); return new Promise(resolve => { resume = resolve; }); };
 await assert.rejects(restartOfficialComponent(previous, f.runtime), /OFFICIAL_COMPONENT_RESTART_TIMEOUT/);
 resume(); await new Promise(setImmediate);
 assert.deepEqual(f.commands, [OFFICIAL_RECONNECT]); assert.equal(generation(api), previous);
});
test('account switch cannot stop a pending image confirmation or nested batch; releases are idempotent', () => {
 const first = enterImageOperation('synthetic-op'), nested = enterImageOperation('synthetic-op');
 try { assert.throws(enterAccountChange, /ACCOUNT_SWITCH_IMAGE_RUNNING/); first(); first(); assert.throws(enterAccountChange, /ACCOUNT_SWITCH_IMAGE_RUNNING/); }
 finally { first(); nested(); }
 const release = enterAccountChange();
 try { assert.throws(() => enterImageOperation('next'), /IMAGE_ACCOUNT_RECOVERY_PENDING/); assert.throws(enterAccountChange, /LIVE_OPERATION_IN_PROGRESS/); }
 finally { release(); release(); }
 enterImageOperation('after')();
});
