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

def home(pid):
    # Read only a bounded launch environment in memory, retaining HOME alone.
    # Unknown/different credential scope is never eligible for termination.
    try:
        with open('/proc/%d/environ' % pid, 'rb') as f: raw = f.read(131073)
        if len(raw) > 131072: return None
        values = [v[5:] for v in raw.split(b'\0') if v.startswith(b'HOME=')]
        return values[0].decode('utf-8', errors='strict') if len(values) == 1 else None
    except (OSError, UnicodeError): return None

def inspect(pid, request, boot_id):
    base = '/proc/%d' % pid
    before = stat(pid)
    uid = os.stat(base).st_uid
    executable = os.readlink(base + '/exe')
    with open(base + '/cmdline', 'rb') as f: raw = f.read(131073)
    if len(raw) > 131072: raise ValueError()
    args = raw.decode('utf-8', errors='strict').split('\0')
    def value(flag):
        found = [a for a in args if a.split('=')[0] == flag]
        return found[0][len(flag)+1:] if len(found) == 1 and found[0].startswith(flag + '=') else None
    port, csrf = value('--hub-port'), value('--csrf_token')
    official = uid == os.getuid() and executable == request['executable'] and args.count('--hub') == 1 and len([a for a in args if a.split('=')[0] == '--hub']) == 1 and value('--app_data_dir') == 'antigravity' and port is not None and re.fullmatch(r'[1-9][0-9]{0,4}', port) and int(port) <= 65535 and csrf is not None and re.fullmatch(r'[A-Za-z0-9_-]{16,128}', csrf)
    process_home = home(pid) if official else None
    official = official and process_home == request.get('home') and process_home is not None
    advertised = official and port == str(request.get('port')) and csrf == request.get('csrfToken')
    current = advertised and before[0] == request['ownerPid']
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
    if before != stat(pid) or uid != os.stat(base).st_uid or executable != os.readlink(base + '/exe') or raw != after or boot_id != boot() or process_home is not None and home(pid) != process_home: raise ValueError()
    proof_hash = hashlib.sha256(raw + b'\0HOME=' + (process_home or '').encode('utf-8')).hexdigest()
    return {'pid': pid, 'parentPid': before[0], 'startTicks': before[1], 'bootId': boot_id, 'commandHash': proof_hash, 'kind': 'current-hub' if current else 'unowned-hub' if official and not advertised else 'unverified', 'parentState': parent_state, 'startedAt': started}

def bind(target, request):
    fd = os.pidfd_open(target['pid'], 0)
    try:
        current = inspect(target['pid'], request, boot())
        if any(current[k] != target[k] for k in ('pid', 'startTicks', 'bootId', 'commandHash')) or current['kind'] != 'unowned-hub': raise ValueError()
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
                if supported and row['kind'] == 'unowned-hub':
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
        if any(current[k] != target[k] for k in ('pid', 'startTicks', 'bootId', 'commandHash')) or current['kind'] != 'unowned-hub': raise ValueError()
        if select.select([sys.stdin], [], [], 0)[0]: raise InterruptedError()
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        if wait_exit(fd, 4): return {'result': 'exited'}
        # The one modal explicitly authorizes this second stage too. Never replace
        # an expired pidfd, adopt a new birth, or send to a numeric PID here.
        current = inspect(target['pid'], request, boot())
        if any(current[k] != target[k] for k in ('pid', 'startTicks', 'bootId', 'commandHash')) or current['kind'] != 'unowned-hub': raise ValueError()
        authorize('force')
        current = inspect(target['pid'], request, boot())
        if any(current[k] != target[k] for k in ('pid', 'startTicks', 'bootId', 'commandHash')) or current['kind'] != 'unowned-hub': raise ValueError()
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
