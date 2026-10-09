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
scenario = case[5:] if case.startswith('scan-') else case
pid, parent, birth = 710, 702, '123456'
if case == 'scan-detached': parent = 1
boot_id = '11111111-1111-4111-8111-111111111111'
args = ['/synthetic/bin/agy', '--hub', '--app_data_dir=antigravity', '--hub-port=32124', '--csrf_token=synthetic-only-capability']
if scenario.startswith('unsupported:'): args.append(scenario.split(':', 1)[1])
launch_scope = {'HOME': '/synthetic-home'}
if scenario.startswith('official170'):
    args += ['--add-dir=/synthetic workspace/project=one', '--add-dir=/different workspace/project two']
    launch_scope.update({'USERPROFILE': '/synthetic-home', 'AGY_ENABLE_HUB': '1', 'ANTIGRAVITY_VSCODE_HOST': '1', 'ANTIGRAVITY_AUTH_SUCCESS_APP': scenario.split(':', 1)[1] if scenario.startswith('official170-scheme:') else 'vscode'})
    if scenario.startswith('official170-invalid-marker:'):
        parts = scenario.split(':', 2); launch_scope[parts[1]] = parts[2]
    if scenario.startswith('official170-extra:'): args.append(scenario.split(':', 1)[1])
    if scenario == 'official170-empty-directory': args.append('--add-dir=')
    if scenario == 'official170-oversized-directory': args.append('--add-dir=' + 'x'*32769)
raw = ('\0'.join(args) + '\0').encode()
environment_proof = json.dumps({'present': sorted(launch_scope), 'scope': launch_scope}, sort_keys=True, separators=(',', ':')).encode()
target = dict(pid=pid, parentPid=parent, startTicks=birth, bootId=boot_id, commandHash=hashlib.sha256(raw + b'\0ENV=' + environment_proof + b'\0PPID=702\0IMAGE=1:55').hexdigest(), kind='unowned-hub', scope='other-window' if case == 'other-window' else 'unknown' if case.startswith('unknown-') else 'current-window', credentialScopeVerified=True, parentState='alive', canEnd=True)
request = dict(operation='scan' if case.startswith('scan') else 'end', executable=args[0], home='/synthetic-home', ownerPid=701, port=32123, csrfToken='synthetic-current-capability', target=target)
if case == 'hash-changed': target['commandHash'] = 'f'*64
if case == 'current-capability-wrong-parent': request['port'], request['csrfToken'] = 32124, 'synthetic-only-capability'
if case == 'scan-current-intermediate': request['port'], request['csrfToken'] = 32124, 'synthetic-only-capability'
if scenario.startswith('current-override:') or scenario == 'current-root-relay': request['port'], request['csrfToken'] = 32124, 'synthetic-only-capability'
if scenario == 'official170-current': request['port'], request['csrfToken'] = 32124, 'synthetic-only-capability'
if scenario == 'official170-root-relay': target['scope'] = 'unknown'
if case == 'unconfirmed-proof': target['credentialScopeVerified'] = False
sent, closed, opened, attempts, clock, reused, acknowledgements = [], [], [], [], [0.0], [False], [0]
def open_fake(filename, mode='r', *a, **kw):
    if filename == '/proc/sys/kernel/random/boot_id': return io.StringIO(boot_id + '\n')
    if filename == '/proc/stat': return io.StringIO('btime 1700000000\n')
    if filename == '/proc/710/comm': return io.StringIO('agy\n')
    if filename == '/proc/710/cmdline':
        value = raw + (b'--hub\0' if case == 'duplicate-flag' else b'')
        return io.BytesIO(value)
    if filename == '/proc/710/environ':
        if scenario == 'home-inaccessible': raise PermissionError()
        value = b'HOME=/synthetic-home\0PRIVATE_FIELD=synthetic-private-value\0'
        for name, content in launch_scope.items():
            if name == 'ANTIGRAVITY_AUTH_SUCCESS_APP' and case == 'official170-marker-removed-before-force' and sent: continue
            if name != 'HOME': value += name.encode() + b'=' + (b'vscode-insiders' if name == 'ANTIGRAVITY_AUTH_SUCCESS_APP' and case == 'official170-marker-changed-before-force' and sent else content.encode()) + b'\0'
        if scenario.startswith('official170'): value += b'HTTP_PROXY=http://synthetic.invalid\0HTTPS_PROXY=http://synthetic.invalid\0NO_PROXY=localhost\0NODE_EXTRA_CA_CERTS=/synthetic/cert.pem\0NODE_USE_SYSTEM_CA=1\0SSL_CERT_FILE=/synthetic/cert.pem\0'
        if scenario == 'different-home' or case == 'home-changed-before-force' and sent: value = b'HOME=/other-home\0'
        if scenario == 'home-missing': value = b'PRIVATE_FIELD=synthetic-private-value\0'
        if scenario == 'home-duplicate': value += b'HOME=/synthetic-home\0'
        if scenario == 'home-oversized': value += b'x'*131073
        if scenario.startswith(('override:', 'current-override:')):
            parts = scenario.split(':', 2)
            name, content = parts[1], parts[2] if len(parts) == 3 else 'empty'
            value += name.encode() + b'=' + (b'' if content == 'empty' else b'synthetic-secret-never-output') + b'\0'
        if scenario == 'profile-mismatch': value += b'USERPROFILE=/other-home\0'
        if scenario == 'drive-missing': value += b'HOMEDRIVE=/synthetic\0'
        if scenario == 'env-standard': value += b'PATH=/synthetic/bin\0TERM=synthetic\0LANG=C\0VSCODE_IPC_HOOK_CLI=/synthetic/ipc\0'
        if case == 'auth-environment-changed-before-force' and sent: value += b'GOOGLE_API_KEY=synthetic-secret-never-output\0'
        return io.BytesIO(value)
    if filename == '/proc/710/stat':
        tick = '999999' if reused[0] else birth
        if case == 'changed-before-force' and sent: tick = '999999'
        return io.StringIO('710 (agy) ' + ' '.join(['S', str(parent)] + ['0']*17 + [tick]))
    if filename == '/proc/702/stat': return io.StringIO('702 (synthetic-launcher) ' + ' '.join(['S', '1' if case in ('other-window', 'scan-other-window') else '701'] + ['0']*17 + ['999999' if case == 'parent-reused' else '100']))
    if filename == '/proc/701/stat':
        if scenario == 'unknown-owner-unreadable': raise PermissionError()
        return io.StringIO('701 (synthetic-host) ' + ' '.join(['S', '1'] + ['0']*17 + ['999999' if case == 'owner-reused-before-force' and sent else '50']))
    if filename == '/proc/1/stat': return io.StringIO('1 (synthetic-init) ' + ' '.join(['S', '0'] + ['0']*17 + ['1']))
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
    exited = sent and (case in ('normal', 'scan', 'other-window', 'unknown-owner-unreadable', 'unknown-root-relay', 'official170', 'official170-root-relay') or case.startswith('official170-scheme:') or sent[-1] == int(signal.SIGKILL)) and case != 'timeout'
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
def stat_fake(path):
    uid = 1001 if case == 'wrong-uid' else 0 if path == '/proc/702' and scenario in ('unknown-root-relay', 'current-root-relay', 'official170-root-relay') else 1000
    return types.SimpleNamespace(st_uid=uid, st_dev=1, st_ino=56 if case == 'image-replaced-before-force' and sent else 55)
with patch('builtins.open', open_fake), patch('os.stat', stat_fake), patch('os.getuid', lambda: 1000), patch('os.readlink', lambda p: request['executable'] if case != 'wrong-executable' else '/other/agy'), patch('os.listdir', lambda p: ['710']), patch('os.sysconf', lambda k: 100), patch('os.pidfd_open', pidfd_fake, create=True), patch('os.close', lambda fd: closed.append(fd)), patch('os.kill', numeric_kill_forbidden), patch('signal.pidfd_send_signal', send_fake, create=True), patch('select.select', select_fake), patch('time.monotonic', now_fake), patch('sys.stdin', stdin):
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
test('helper recognizes indirect current, detached previous Hub, and a live foreign window separately', { skip: !available }, () => {
  let r = run('scan-current-intermediate'), p = r.result.processes[0];
  assert.equal(p.kind, 'current-hub'); assert.equal(p.scope, 'current-window'); assert.equal(p.canEnd, false);
  r = run('scan-detached'); p = r.result.processes[0];
  assert.equal(p.kind, 'unowned-hub'); assert.equal(p.scope, 'detached'); assert.equal(p.canEnd, true);
  r = run('scan-other-window'); p = r.result.processes[0];
  assert.equal(p.kind, 'unowned-hub'); assert.equal(p.scope, 'other-window'); assert.equal(p.canEnd, true); assert.equal(p.credentialScopeVerified, true);
  assert.deepEqual(r.signals, []);
});
test('explicit authorization can end a credential-scope-verified target in another or unknown window', { skip: !available }, () => {
  for (const name of ['other-window', 'unknown-owner-unreadable', 'unknown-root-relay']) {
    const r = run(name); assert.equal(r.result.result, 'exited'); assert.deepEqual(r.signals, [15]);
    assert.deepEqual(r.stages, ['term']); assert.deepEqual(r.opened, [710]);
  }
});
test('different-UID relay preserves unknown scope independently of verified credential scope', { skip: !available }, () => {
  let r = run('scan-unknown-root-relay'), p = r.result.processes[0];
  assert.equal(p.kind, 'unowned-hub'); assert.equal(p.scope, 'unknown'); assert.equal(p.scopeReason, 'ancestor-user-mismatch');
  assert.equal(p.credentialScopeVerified, true); assert.equal(p.credentialScopeReason, 'verified'); assert.equal(p.canEnd, true);
  assert.deepEqual(r.signals, []);
  r = run('scan-current-root-relay'); p = r.result.processes[0];
  assert.equal(p.kind, 'current-hub'); assert.equal(p.scopeReason, 'api-capability-match'); assert.equal(p.canEnd, false);
});
test('official 1.7.0 launch accepts repeated workspace directories and the three known markers', { skip: !available }, () => {
  for (const scheme of ['vscode', 'vscode-insiders', 'code-oss', 'Synthetic+Host.7']) {
    let r = run(`scan-official170-scheme:${scheme}`), p = r.result.processes[0];
    assert.equal(p.kind, 'unowned-hub'); assert.equal(p.credentialScopeVerified, true); assert.equal(p.credentialScopeReason, 'verified'); assert.equal(p.canEnd, true);
    assert.deepEqual(r.signals, []); assert.doesNotMatch(r.output, /synthetic workspace|different workspace|project=one|AGY_ENABLE_HUB|ANTIGRAVITY_AUTH_SUCCESS_APP|NODE_EXTRA_CA_CERTS/);
    r = run(`official170-scheme:${scheme}`); assert.equal(r.result.result, 'exited'); assert.deepEqual(r.signals, [15]); assert.deepEqual(r.stages, ['term']);
  }
  let r = run('scan-official170-root-relay'), p = r.result.processes[0];
  assert.equal(p.scope, 'unknown'); assert.equal(p.scopeReason, 'ancestor-user-mismatch'); assert.equal(p.credentialScopeVerified, true); assert.equal(p.canEnd, true);
  r = run('official170-root-relay'); assert.equal(r.result.result, 'exited'); assert.deepEqual(r.signals, [15]);
  p = run('scan-official170-current').result.processes[0]; assert.equal(p.kind, 'current-hub'); assert.equal(p.credentialScopeVerified, true); assert.equal(p.canEnd, false);
});
test('official markers validate exact known values without weakening other business environment checks', { skip: !available }, () => {
  for (const [key, values] of [['AGY_ENABLE_HUB', ['', '0', 'true', '11']], ['ANTIGRAVITY_VSCODE_HOST', ['', '0', 'true', '11']], ['ANTIGRAVITY_AUTH_SUCCESS_APP', ['', '1vscode', 'vscode://', 'vscode:', 'with space', 'x'.repeat(129)]]]) for (const value of values) {
    let r = run(`scan-official170-invalid-marker:${key}:${value}`), p = r.result.processes[0];
    assert.equal(p.credentialScopeVerified, false); assert.equal(p.credentialScopeReason, 'config-environment-override'); assert.equal(p.canEnd, false); assert.equal(r.output.includes(key), false);
    r = run(`official170-invalid-marker:${key}:${value}`); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, []); assert.deepEqual(r.stages, []);
  }
});
test('official workspace argument contract preserves identity flag uniqueness and denies unsupported serverArgs', { skip: !available }, () => {
  for (const arg of ['--hub', '--app_data_dir=antigravity', '--hub-port=32124', '--csrf_token=synthetic-only-capability']) {
    const r = run(`scan-official170-extra:${arg}`), p = r.result.processes[0]; assert.equal(p.credentialScopeVerified, false); assert.equal(p.credentialScopeReason, 'hub-argv-unverified'); assert.equal(p.canEnd, false);
  }
  for (const scenario of ['official170-empty-directory', 'official170-oversized-directory', 'official170-extra:--add-dir', 'official170-extra:--server_url=synthetic-secret-never-output']) {
    let r = run(`scan-${scenario}`), p = r.result.processes[0]; assert.equal(p.credentialScopeVerified, false); assert.equal(p.credentialScopeReason, 'unsupported-launch-flags'); assert.equal(p.canEnd, false);
    r = run(scenario); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, []); assert.deepEqual(r.stages, []);
  }
});
test('even a valid official marker value or presence change after TERM invalidates the selected fingerprint', { skip: !available }, () => {
  for (const name of ['official170-marker-changed-before-force', 'official170-marker-removed-before-force']) {
    const r = run(name); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, [15]); assert.deepEqual(r.stages, ['term']); assert.deepEqual(r.opened, [710]);
  }
  const vscode = run('scan-official170-scheme:vscode').result.processes[0], insiders = run('scan-official170-scheme:vscode-insiders').result.processes[0];
  assert.notEqual(vscode.commandHash, insiders.commandHash);
});
const overrides = [
  ['JETSKI_OAUTH_TOKEN', 'auth-environment-override'], ['JETSKI_TEST_GAIA_TOKEN', 'auth-environment-override'],
  ['GOOGLE_API_KEY', 'auth-environment-override'], ['GEMINI_API_KEY', 'auth-environment-override'],
  ['GOOGLE_APPLICATION_CREDENTIALS', 'auth-environment-override'], ['AGY_ADC_AUTH', 'auth-environment-override'],
  ['ANTIGRAVITY_SERVER_URL', 'config-environment-override'], ['AGY_RELEASE_BASE_URL', 'config-environment-override'],
  ['CLOUD_WORKSTATIONS', 'config-environment-override'], ['CLOUD_SHELL', 'config-environment-override'], ['ANTIGRAVITY_CDE', 'config-environment-override'],
];
for (const [key, reason] of overrides) for (const content of ['empty', 'value']) test(`${key} ${content} presence denies credential-scope proof and termination`, { skip: !available }, () => {
  let r = run(`scan-override:${key}:${content}`), p = r.result.processes[0];
  assert.equal(p.kind, 'unowned-hub'); assert.equal(p.credentialScopeVerified, false); assert.equal(p.credentialScopeReason, reason); assert.equal(p.canEnd, false);
  assert.equal(r.output.includes(key), false); assert.doesNotMatch(r.output, /synthetic-secret-never-output/); assert.deepEqual(r.signals, []);
  r = run(`override:${key}:${content}`);
  assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, []); assert.deepEqual(r.stages, []);
});
test('configuration roots and unrecognized business environment names remain explicit blockers', { skip: !available }, () => {
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'AGY_UNRECOGNIZED', 'ANTIGRAVITY_UNRECOGNIZED', 'JETSKI_UNRECOGNIZED', 'GOOGLE_UNRECOGNIZED', 'GEMINI_UNRECOGNIZED', 'CODEIUM_UNRECOGNIZED', 'WINDSURF_UNRECOGNIZED', 'CLOUD_UNRECOGNIZED']) {
    const r = run(`scan-override:${key}:empty`), p = r.result.processes[0];
    assert.equal(p.credentialScopeVerified, false, key); assert.equal(p.credentialScopeReason, 'config-environment-override', key); assert.equal(p.canEnd, false, key);
    assert.equal(r.output.includes(key), false); assert.deepEqual(r.signals, []);
  }
});
test('uncontracted launch arguments cannot become consent-eligible and never expose their values', { skip: !available }, () => {
  for (const arg of ['--auth-token=synthetic-secret-never-output', '--server-url=synthetic-secret-never-output', '--config=synthetic-secret-never-output', '--listen-address=synthetic-secret-never-output', '-e', '--', '--HUB', 'synthetic-positional-secret']) {
    let r = run(`scan-unsupported:${arg}`), p = r.result.processes[0];
    assert.equal(p.kind, 'unowned-hub'); assert.equal(p.credentialScopeVerified, false); assert.equal(p.credentialScopeReason, 'unsupported-launch-flags'); assert.equal(p.canEnd, false);
    assert.equal(r.output.includes(arg), false); assert.deepEqual(r.signals, []);
    r = run(`unsupported:${arg}`); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, []); assert.deepEqual(r.stages, []);
  }
});
test('advertised current Hub with an auth override remains factual current and can never be manually ended', { skip: !available }, () => {
  let r = run('scan-current-override:GOOGLE_API_KEY:empty'), p = r.result.processes[0];
  assert.equal(p.kind, 'current-hub'); assert.equal(p.scope, 'current-window'); assert.equal(p.credentialScopeVerified, false); assert.equal(p.canEnd, false);
  r = run('current-override:GOOGLE_API_KEY:empty'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, []);
});
test('home aliases must agree; unreadable environment denies proof while ordinary environment is harmless', { skip: !available }, () => {
  for (const name of ['profile-mismatch', 'drive-missing', 'different-home']) {
    const p = run(`scan-${name}`).result.processes[0]; assert.equal(p.credentialScopeVerified, false); assert.equal(p.credentialScopeReason, 'home-mismatch'); assert.equal(p.canEnd, false);
  }
  let p = run('scan-home-inaccessible').result.processes[0]; assert.equal(p.credentialScopeVerified, false); assert.equal(p.credentialScopeReason, 'environment-unreadable'); assert.equal(p.canEnd, false);
  const normal = run('scan').result.processes[0]; p = run('scan-env-standard').result.processes[0];
  assert.equal(p.credentialScopeVerified, true); assert.equal(p.commandHash, normal.commandHash); assert.equal(p.canEnd, true);
});
test('new auth environment or replaced executable image after TERM prevents forced termination', { skip: !available }, () => {
  for (const name of ['auth-environment-changed-before-force', 'image-replaced-before-force']) {
    const r = run(name); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, [15]); assert.deepEqual(r.stages, ['term']); assert.deepEqual(r.opened, [710]);
  }
});
test('a scan target without credential proof cannot be authorized by forging its old selection fields', { skip: !available }, () => {
  const r = run('unconfirmed-proof'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE'); assert.deepEqual(r.signals, []); assert.deepEqual(r.stages, []);
});
test('reused owner ancestry during the TERM wait cannot authorize escalation', { skip: !available }, () => {
  const r = run('owner-reused-before-force'); assert.equal(r.result.code, 'OFFICIAL_PROCESS_SELECTION_STALE');
  assert.deepEqual(r.signals, [15]); assert.deepEqual(r.stages, ['term']);
});
test('shipped helper scans and verifies a foreign Hub without exposing argv or capability', { skip: !available }, () => {
  const r = run('scan'); assert.equal(r.result.processes[0].kind, 'unowned-hub'); assert.equal(r.result.processes[0].canEnd, true); assert.equal(r.result.processes[0].parentState, 'alive');
  assert.deepEqual(r.signals, []); assert.doesNotMatch(r.output, /synthetic-only-capability|--csrf_token|--hub-port|PRIVATE_FIELD|synthetic-private-value/);
});
test('normal exit uses only TERM on the held pidfd; timeout escalation uses that same pidfd', { skip: !available }, () => {
  let r = run('normal'); assert.equal(r.result.result, 'exited'); assert.deepEqual(r.signals, [15]); assert.deepEqual(r.closed, [200]);
  r = run('force'); assert.equal(r.result.result, 'forced'); assert.deepEqual(r.signals, [15, 9]); assert.deepEqual(r.closed, [200]); assert.deepEqual(r.stages, ['term', 'force']);
});
for (const name of ['reused-at-bind', 'hash-changed', 'duplicate-flag', 'wrong-uid', 'wrong-executable', 'different-home', 'home-inaccessible', 'home-missing', 'home-duplicate', 'home-oversized', 'current-capability-wrong-parent', 'parent-reused']) test(`${name} never sends a signal`, { skip: !available }, () => {
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
