// Execute the shipped Python source with every proc, pidfd, signal and clock
// operation mocked. No test inspects or signals any real process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { LINUX_PROCESS_HELPER } = require('../out/official-process-helper');
const available = process.platform !== 'win32' && fs.existsSync('/usr/bin/python3');
const harness = String.raw`
import builtins, hashlib, io, json, os, select, signal, sys, types
from unittest.mock import patch
source, case = json.loads(sys.stdin.read())
pid, parent, birth = 710, 702, '123456'
boot_id = '11111111-1111-4111-8111-111111111111'
args = ['/synthetic/bin/agy', '--hub', '--app_data_dir=antigravity', '--hub-port=32124', '--csrf_token=synthetic-only-capability']
raw = ('\0'.join(args) + '\0').encode()
target = dict(pid=pid, parentPid=parent, startTicks=birth, bootId=boot_id, commandHash=hashlib.sha256(raw + b'\0HOME=/synthetic-home').hexdigest(), kind='unowned-hub', parentState='alive', canEnd=True)
request = dict(operation='scan' if case == 'scan' else 'end', executable=args[0], home='/synthetic-home', ownerPid=701, port=32123, csrfToken='synthetic-current-capability', target=target)
if case == 'hash-changed': target['commandHash'] = 'f'*64
if case == 'current-capability-wrong-parent': request['port'], request['csrfToken'] = 32124, 'synthetic-only-capability'
sent, closed, opened, attempts, clock, reused, acknowledgements = [], [], [], [], [0.0], [False], [0]
def open_fake(filename, mode='r', *a, **kw):
    if filename == '/proc/sys/kernel/random/boot_id': return io.StringIO(boot_id + '\n')
    if filename == '/proc/stat': return io.StringIO('btime 1700000000\n')
    if filename == '/proc/710/comm': return io.StringIO('agy\n')
    if filename == '/proc/710/cmdline':
        value = raw + (b'--hub\0' if case == 'duplicate-flag' else b'')
        return io.BytesIO(value)
    if filename == '/proc/710/environ':
        if case == 'home-inaccessible': raise PermissionError()
        value = b'HOME=/synthetic-home\0PRIVATE_FIELD=synthetic-private-value\0'
        if case == 'different-home' or case == 'home-changed-before-force' and sent: value = b'HOME=/other-home\0'
        if case == 'home-missing': value = b'PRIVATE_FIELD=synthetic-private-value\0'
        if case == 'home-duplicate': value += b'HOME=/synthetic-home\0'
        if case == 'home-oversized': value += b'x'*131073
        return io.BytesIO(value)
    if filename == '/proc/710/stat':
        tick = '999999' if reused[0] else birth
        if case == 'changed-before-force' and sent: tick = '999999'
        return io.StringIO('710 (agy) ' + ' '.join(['S', str(parent)] + ['0']*17 + [tick]))
    if filename == '/proc/702/stat': return io.StringIO('702 (synthetic-host) ' + ' '.join(['S', '1'] + ['0']*17 + ['100']))
    raise AssertionError('unexpected filesystem read')
def pidfd_fake(pid_value, flags):
    assert pid_value == pid and flags == 0
    opened.append(pid_value)
    if case == 'gone': raise ProcessLookupError()
    if case == 'reused-at-bind': reused[0] = True
    return 200
def select_fake(read, write, error, timeout):
    if 200 not in read:
        # Transition after the final /proc inspection, immediately before send.
        if case == 'reused-before-term-signal' and acknowledgements[0] == 1 or case == 'reused-before-force-signal' and acknowledgements[0] == 2: reused[0] = True
        return ([sys.stdin] if case == 'cancel-before' or case == 'cancel-after-ack' and acknowledgements[0] else [], [], [])
    if case == 'cancel-before' and sys.stdin in read: return ([sys.stdin], [], [])
    if case == 'cancel-after-term' and sent and sys.stdin in read: return ([sys.stdin], [], [])
    exited = sent and (case in ('normal', 'scan') or sent[-1] == int(signal.SIGKILL)) and case != 'timeout'
    return ([200] if exited else [], [], [])
def send_fake(fd, sig):
    assert fd == 200
    attempts.append([fd, int(sig)])
    # Kernel pidfd semantics: the held fd still refers to the exited original,
    # even though /proc/<numeric PID> now names its replacement.
    if reused[0]: raise ProcessLookupError()
    if case == 'denied': raise PermissionError()
    sent.append(int(sig))
def numeric_kill_forbidden(*a): raise AssertionError('numeric PID signal is forbidden')
def now_fake(): clock[0] += 1; return clock[0]
class HostInput(io.StringIO):
    def readline(self, size=-1):
        value = super().readline(size)
        if value == 'continue\n': acknowledgements[0] += 1
        return value
stdin = HostInput(json.dumps(request) + '\n' + ('' if case == 'no-authorization' else 'continue\ncontinue\n'))
with patch('builtins.open', open_fake), patch('os.stat', lambda p: types.SimpleNamespace(st_uid=1000 if case != 'wrong-uid' else 1001)), patch('os.getuid', lambda: 1000), patch('os.readlink', lambda p: request['executable'] if case != 'wrong-executable' else '/other/agy'), patch('os.listdir', lambda p: ['710']), patch('os.sysconf', lambda k: 100), patch('os.pidfd_open', pidfd_fake, create=True), patch('os.close', lambda fd: closed.append(fd)), patch('os.kill', numeric_kill_forbidden), patch('signal.pidfd_send_signal', send_fake, create=True), patch('select.select', select_fake), patch('time.monotonic', now_fake), patch('sys.stdin', stdin):
    exec(source, {})
print(json.dumps({'signals': sent, 'closed': closed, 'opened': opened, 'attempts': attempts}))
`;
function run(caseName) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', harness], { input: JSON.stringify([LINUX_PROCESS_HELPER, caseName]), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const values = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const metadata = values.pop(); const stages = values.filter(value => value.authorize).map(value => value.authorize);
  return { result: values.find(value => !value.authorize), stages, ...metadata, output: result.stdout };
}
test('shipped helper scans and verifies a foreign Hub without exposing argv or capability', { skip: !available }, () => {
  const r = run('scan'); assert.equal(r.result.processes[0].kind, 'unowned-hub'); assert.equal(r.result.processes[0].canEnd, true); assert.equal(r.result.processes[0].parentState, 'alive');
  assert.deepEqual(r.signals, []); assert.doesNotMatch(r.output, /synthetic-only-capability|--csrf_token|--hub-port|PRIVATE_FIELD|synthetic-private-value/);
});
test('normal exit uses only TERM on the held pidfd; timeout escalation uses that same pidfd', { skip: !available }, () => {
  let r = run('normal'); assert.equal(r.result.result, 'exited'); assert.deepEqual(r.signals, [15]); assert.deepEqual(r.closed, [200]);
  r = run('force'); assert.equal(r.result.result, 'forced'); assert.deepEqual(r.signals, [15, 9]); assert.deepEqual(r.closed, [200]); assert.deepEqual(r.stages, ['term', 'force']);
});
for (const name of ['reused-at-bind', 'hash-changed', 'duplicate-flag', 'wrong-uid', 'wrong-executable', 'different-home', 'home-inaccessible', 'home-missing', 'home-duplicate', 'home-oversized', 'current-capability-wrong-parent']) test(`${name} never sends a signal`, { skip: !available }, () => {
  const r = run(name); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, []); assert.deepEqual(r.closed, [200]);
});
test('already exited target is benign; permission and timeout are precise failures', { skip: !available }, () => {
  let r = run('gone'); assert.equal(r.result.result, 'gone'); assert.deepEqual(r.signals, []);
  r = run('denied'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_END_DENIED'); assert.deepEqual(r.signals, []);
  r = run('timeout'); assert.equal(r.result.code, 'OFFICIAL_BACKEND_STOP_TIMEOUT'); assert.deepEqual(r.signals, [15, 9]);
});
test('EOF/cancel prevents initial termination or later force; changed identity prevents escalation', { skip: !available }, () => {
  let r = run('cancel-before'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_END_CANCELLED'); assert.deepEqual(r.signals, []);
  r = run('cancel-after-term'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_END_CANCELLED'); assert.deepEqual(r.signals, [15]);
  r = run('changed-before-force'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, [15]);
});

test('missing host authorization sends no signal; changed HOME before force stops escalation', { skip: !available }, () => {
  let r = run('no-authorization'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_END_CANCELLED'); assert.deepEqual(r.signals, []);
  r = run('home-changed-before-force'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, [15]);
});

test('host cancellation after acknowledgement and before signal still prevents termination', { skip: !available }, () => {
  const r = run('cancel-after-ack'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_END_CANCELLED'); assert.deepEqual(r.signals, []);
});

for (const [name, attempts, delivered] of [
  ['reused-before-term-signal', [[200, 15]], []],
  ['reused-before-force-signal', [[200, 15], [200, 9]], [15]],
]) test(`${name} cannot signal the replacement or reopen its PID`, { skip: !available }, () => {
  const r = run(name);
  assert.equal(r.result.result, 'gone');
  assert.deepEqual(r.opened, [710], 'termination binds once, never again for force');
  assert.deepEqual(r.attempts, attempts, 'both stages use the identical fd');
  assert.deepEqual(r.signals, delivered, 'replacement receives no signal');
  assert.deepEqual(r.closed, [200]);
});
