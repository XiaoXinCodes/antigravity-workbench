/** Isolated Python standard-library adapter for Linux pidfds. No shell, credentials,
 * raw argv output, process-name kill, or implicit privilege elevation. A pidfd is
 * held across both termination stages; permission/identity failures stop the flow. */
export const LINUX_PROCESS_HELPER = String.raw`
import datetime, hashlib, json, os, re, select, signal, sys, time

def emit(value):
    print(json.dumps(value), flush=True)

def stat(pid):
    with open('/proc/%d/stat' % pid) as f: raw = f.read(8192)
    fields = raw[raw.rfind(') ') + 2:].split()
    if len(fields) < 20 or not fields[1].isdigit() or not fields[19].isdigit(): raise ValueError()
    return (int(fields[1]), fields[19])

def boot():
    with open('/proc/sys/kernel/random/boot_id') as f: value = f.read(128).strip()
    if not re.fullmatch(r'[0-9a-f-]{36}', value): raise ValueError()
    return value

AUTH_ENV = {'JETSKI_OAUTH_TOKEN', 'JETSKI_TEST_GAIA_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ADC_AUTH'}
CONFIG_ENV = {'ANTIGRAVITY_SERVER_URL', 'AGY_RELEASE_BASE_URL', 'CLOUD_WORKSTATIONS', 'CLOUD_SHELL', 'ANTIGRAVITY_CDE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'}
BUSINESS_PREFIXES = ('AGY_', 'ANTIGRAVITY_', 'JETSKI_', 'GOOGLE_', 'GEMINI_', 'CODEIUM_', 'WINDSURF_', 'CLOUD_')
HOME_FIELDS = {'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'}
OFFICIAL_MARKERS = {'AGY_ENABLE_HUB', 'ANTIGRAVITY_VSCODE_HOST', 'ANTIGRAVITY_AUTH_SUCCESS_APP'}
HUB_FLAGS = {'--hub', '--app_data_dir', '--hub-port', '--csrf_token'}

def supported_argument(arg):
    # Official 1.7.0 adds one argv item per workspace folder, including spaces
    # and '=' in its fsPath. It changes workspace context, not credential HOME.
    if arg.startswith('--add-dir='): return 0 < len(arg[len('--add-dir='):]) <= 32768
    return arg.split('=')[0] in HUB_FLAGS

def launch_environment(pid, expected_home):
    # Bounded launch metadata only. Retain scope paths and relevant key presence;
    # never decode, return or fingerprint authentication override values.
    try:
        with open('/proc/%d/environ' % pid, 'rb') as f: raw = f.read(131073)
        if len(raw) > 131072: return None, '', 'environment-unreadable'
        fields, present = {}, []
        for entry in raw.split(b'\0'):
            if not entry: continue
            if b'=' not in entry: return None, '', 'environment-unreadable'
            key, value = entry.split(b'=', 1)
            name = key.decode('utf-8', errors='strict')
            relevant = name in HOME_FIELDS or name in AUTH_ENV or name in CONFIG_ENV or name.startswith(BUSINESS_PREFIXES)
            if not relevant: continue
            if name in present: return None, '', 'environment-unreadable'
            present.append(name)
            if name in HOME_FIELDS or name in OFFICIAL_MARKERS: fields[name] = value.decode('utf-8', errors='strict')
        proof = json.dumps({'present': sorted(present), 'scope': fields}, sort_keys=True, separators=(',', ':'))
        selected_home = fields.get('HOME')
        if selected_home != expected_home or not selected_home or not selected_home.startswith('/') or len(selected_home) > 4096: return selected_home, proof, 'home-mismatch'
        if 'USERPROFILE' in fields and fields['USERPROFILE'] != expected_home: return selected_home, proof, 'home-mismatch'
        if ('HOMEDRIVE' in fields) != ('HOMEPATH' in fields) or 'HOMEDRIVE' in fields and fields['HOMEDRIVE'] + fields['HOMEPATH'] != expected_home: return selected_home, proof, 'home-mismatch'
        if any(name in AUTH_ENV for name in present): return selected_home, proof, 'auth-environment-override'
        if any(name in fields and fields[name] != '1' for name in ('AGY_ENABLE_HUB', 'ANTIGRAVITY_VSCODE_HOST')) or 'ANTIGRAVITY_AUTH_SUCCESS_APP' in fields and not re.fullmatch(r'[A-Za-z][A-Za-z0-9+.-]{0,127}', fields['ANTIGRAVITY_AUTH_SUCCESS_APP']): return selected_home, proof, 'config-environment-override'
        if any(name not in HOME_FIELDS and name not in OFFICIAL_MARKERS for name in present): return selected_home, proof, 'config-environment-override'
        return selected_home, proof, 'verified'
    except (OSError, UnicodeError): return None, '', 'environment-unreadable'

def scope(parent, birth, owner):
    # An exact advertised capability identifies the current Hub separately.
    # Ancestry describes the window honestly, independently of credential scope.
    # Shared launchers or a different-UID relay never prove the current window.
    # Ending a verified foreign/unknown target still needs explicit host consent.
    if parent == 1: return 'detached', 'parent-init'
    try:
        owner_stat = stat(owner)
        if os.stat('/proc/%d' % owner).st_uid != os.getuid(): return 'unknown', 'owner-user-mismatch'
    except (OSError, ValueError): return 'unknown', 'owner-unreadable'
    chain, visited, child_birth = [], set(), int(birth)
    cursor = parent
    for _ in range(64):
        if cursor < 1: return 'unknown', 'ancestry-unavailable'
        if cursor in visited: return 'unknown', 'ancestry-cycle'
        visited.add(cursor)
        try:
            value = stat(cursor)
            uid = os.stat('/proc/%d' % cursor).st_uid
        except (OSError, ValueError): return 'unknown', 'ancestor-unreadable'
        if int(value[1]) > child_birth: return 'unknown', 'ancestor-replaced'
        if uid != os.getuid(): return 'unknown', 'ancestor-user-mismatch'
        chain.append((cursor, value, uid))
        if cursor == owner:
            for pid, expected, expected_uid in chain:
                if stat(pid) != expected or os.stat('/proc/%d' % pid).st_uid != expected_uid: return 'unknown', 'ancestor-replaced'
            return 'current-window', 'current-host-ancestry'
        if cursor == owner_stat[0]:
            if stat(owner) != owner_stat: return 'unknown', 'ancestor-replaced'
            return 'other-window', 'shared-parent'
        if cursor == 1: return 'other-window', 'different-host-ancestry'
        child_birth, cursor = int(value[1]), value[0]
    return 'unknown', 'ancestry-limit'

def eligible(row):
    return row['kind'] == 'unowned-hub' and row.get('credentialScopeVerified') is True

def match(current, target):
    if any(current[k] != target[k] for k in ('pid', 'parentPid', 'startTicks', 'bootId', 'commandHash', 'scope', 'credentialScopeVerified')) or not eligible(current): raise ValueError()

def inspect(pid, request, boot_id):
    base = '/proc/%d' % pid
    before = stat(pid)
    uid = os.stat(base).st_uid
    executable = os.readlink(base + '/exe')
    image = os.stat(base + '/exe')
    image_identity = (image.st_dev, image.st_ino)
    with open(base + '/cmdline', 'rb') as f: raw = f.read(131073)
    if len(raw) > 131072: raise ValueError()
    args = raw.decode('utf-8', errors='strict').split('\0')
    if args and args[-1] == '': args.pop()
    def value(flag):
        found = [a for a in args if a.split('=')[0] == flag]
        return found[0][len(flag)+1:] if len(found) == 1 and found[0].startswith(flag + '=') else None
    port, csrf = value('--hub-port'), value('--csrf_token')
    identity = uid == os.getuid() and executable == request['executable'] and args and args[0] == request['executable']
    hub_args = args.count('--hub') == 1 and len([a for a in args if a.split('=')[0] == '--hub']) == 1 and value('--app_data_dir') == 'antigravity' and port is not None and re.fullmatch(r'[1-9][0-9]{0,4}', port) and int(port) <= 65535 and csrf is not None and re.fullmatch(r'[A-Za-z0-9_-]{16,128}', csrf)
    process_home, environment_proof, environment_reason = launch_environment(pid, request.get('home')) if identity and hub_args else (None, '', 'environment-unreadable')
    official = identity and hub_args and process_home == request.get('home') and process_home is not None and environment_reason not in ('home-mismatch', 'environment-unreadable')
    credential_reason = 'process-identity-unverified' if not identity else 'hub-argv-unverified' if not hub_args else environment_reason
    if official and credential_reason == 'verified' and any(not supported_argument(arg) for arg in args[1:]): credential_reason = 'unsupported-launch-flags'
    credential_verified = official and credential_reason == 'verified'
    advertised = official and port == str(request.get('port')) and csrf == request.get('csrfToken')
    current = advertised
    ownership, scope_reason = ('current-window', 'api-capability-match') if current else scope(before[0], before[1], request['ownerPid']) if official else ('unknown', 'ancestry-unavailable')
    parent_state = 'unknown'
    try:
        stat(before[0]); parent_state = 'alive'
    except ProcessLookupError: parent_state = 'gone'
    except FileNotFoundError: parent_state = 'gone'
    except (OSError, ValueError): pass
    started = None
    try:
        with open('/proc/stat') as f:
            btime = next(int(line.split()[1]) for line in f if line.startswith('btime '))
        started = datetime.datetime.fromtimestamp(btime + int(before[1]) / os.sysconf('SC_CLK_TCK'), datetime.timezone.utc).isoformat()
    except (OSError, ValueError, StopIteration, OverflowError): pass
    with open(base + '/cmdline', 'rb') as f: after = f.read(131073)
    after_image = os.stat(base + '/exe')
    if before != stat(pid) or uid != os.stat(base).st_uid or executable != os.readlink(base + '/exe') or image_identity != (after_image.st_dev, after_image.st_ino) or raw != after or boot_id != boot() or process_home is not None and launch_environment(pid, request.get('home')) != (process_home, environment_proof, environment_reason): raise ValueError()
    proof_hash = hashlib.sha256(raw + b'\0ENV=' + environment_proof.encode('utf-8') + b'\0PPID=' + str(before[0]).encode() + b'\0IMAGE=' + ('%d:%d' % image_identity).encode()).hexdigest()
    return {'pid': pid, 'parentPid': before[0], 'startTicks': before[1], 'bootId': boot_id, 'commandHash': proof_hash, 'kind': 'current-hub' if current else 'unowned-hub' if official else 'unverified', 'scope': ownership, 'scopeReason': scope_reason, 'credentialScopeVerified': credential_verified, 'credentialScopeReason': credential_reason, 'parentState': parent_state, 'startedAt': started}

def bind(target, request):
    fd = os.pidfd_open(target['pid'], 0)
    try:
        current = inspect(target['pid'], request, boot())
        match(current, target)
        if select.select([fd], [], [], 0)[0]: raise ProcessLookupError()
        return fd
    except BaseException:
        os.close(fd); raise

def wait_exit(fd, seconds):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        ready = select.select([fd, sys.stdin], [], [], min(0.1, max(0, until-time.monotonic())))[0]
        if sys.stdin in ready: raise InterruptedError()
        if fd in ready: return True
    return False

def authorize(stage):
    # The host must freshly validate its extension and Hub generation before
    # each signal. EOF (including host crash) grants no authority.
    if select.select([sys.stdin], [], [], 0)[0]: raise InterruptedError()
    emit({'authorize': stage})
    if sys.stdin.readline(10) != 'continue\n': raise InterruptedError()

def run(request):
    supported = hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
    if request['operation'] == 'probe': return {'supported': supported}
    if request['operation'] == 'scan':
        rows, boot_id = [], boot()
        for name in os.listdir('/proc'):
            if not re.fullmatch(r'[1-9][0-9]*', name): continue
            try:
                with open('/proc/' + name + '/comm') as f:
                    if f.read(128).strip() != 'agy': continue
                row = inspect(int(name), request, boot_id)
                row['canEnd'] = False
                if supported and eligible(row):
                    try:
                        fd = bind(row, request); os.close(fd); row['canEnd'] = True
                    except (OSError, ValueError): pass
                rows.append(row)
            except (FileNotFoundError, ProcessLookupError): continue
        return {'processes': rows, 'supported': supported}
    if request['operation'] != 'end' or not supported: return {'code': 'OFFICIAL_PROCESS_END_UNAVAILABLE'}
    target = request['target']
    fd = bind(target, request)
    try:
        # EOF/cancel from the owning extension prevents either escalation stage.
        authorize('term')
        current = inspect(target['pid'], request, boot())
        match(current, target)
        if select.select([sys.stdin], [], [], 0)[0]: raise InterruptedError()
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        if wait_exit(fd, 4): return {'result': 'exited'}
        # The one modal explicitly authorizes this second stage too. Never replace
        # an expired pidfd, adopt a new birth, or send to a numeric PID here.
        current = inspect(target['pid'], request, boot())
        match(current, target)
        authorize('force')
        current = inspect(target['pid'], request, boot())
        match(current, target)
        if select.select([sys.stdin], [], [], 0)[0]: raise InterruptedError()
        signal.pidfd_send_signal(fd, signal.SIGKILL)
        if not wait_exit(fd, 4): return {'code': 'OFFICIAL_BACKEND_STOP_TIMEOUT'}
        return {'result': 'forced'}
    finally: os.close(fd)

try:
    request = json.loads(sys.stdin.readline(16385))
    emit(run(request))
except (FileNotFoundError, ProcessLookupError): emit({'result': 'gone'})
except InterruptedError: emit({'code': 'OFFICIAL_PROCESS_END_CANCELLED'})
except PermissionError: emit({'code': 'OFFICIAL_PROCESS_END_DENIED'})
except (ValueError, KeyError, TypeError): emit({'code': 'OFFICIAL_PROCESS_SELECTION_STALE'})
except BaseException: emit({'code': 'PROCESS_CHECK_FAILED'})
`;
