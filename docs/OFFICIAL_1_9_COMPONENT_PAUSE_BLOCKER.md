# Official 1.9.0: component pause boundary

Update: this component-only limitation remains valid. The later candidate uses an explicitly confirmed WSL window-close transaction instead; see [current validation](VALIDATION_AUTOMATIC_OFFLINE_1_9.md). It does not claim a new official pause API or disable automatic recovery.

2026-10-22. Exact installed-source hash supplied by the parent and matched to the previously reviewed static evidence: `f77a37c4bd66612f4ed26d9e80ce3969af543f853e2cc113ca466e7f8b6aa880`. This is a blocker report, not a compatible VSIX or an installation recommendation. Existing 1.8 candidate bytes were not changed.

## What prevents the requested adapter

The current component-only adapter can call the already loaded `deactivate` export and observe the dynamic port, fresh Hub identity and OS process births. Official 1.9 exports no manager instance, recovery promise, pause token, or drain acknowledgement. Its manager and `recoveryInFlight`/`startingPromise` fields are in an unexported closure.

Exact-source sequence:

1. A recovery callback enters `runRecovery`, then `restart`, then awaits its `stop`.
2. That stop clears `serverProcess`, `serverUrl` and `port` before waiting for the old process exit/timer.
3. A second `deactivate` calls another stop. With no current process reference it can return immediately; its cancelling the pending recovery timer does not cancel the already running callback.
4. The old stop settles and the first restart unconditionally calls start. The second stop's `stopGeneration` does not fence this path.

A ready replacement can also exist while an older restart is waiting. Therefore readiness at preparation does not by itself reveal all older restart continuations. The old same-delay 5000ms implementation-order reasoning is NOT admitted as the observable barrier required by this request.

Heartbeat is different: stop increments heartbeatGeneration, invalidating probe continuations; the missed-heartbeat hang path also checks stopGeneration after its await. These checks do not extend to `restart` or `runRecovery`.

Configuration is not a drain acknowledgement. `isAutoRecoverEnabled` reads the environment override and last-start configuration/workspace configuration; no real setting was read or modified in this task, and the implementation must not assume recovery is disabled. Even observing false now does not cancel a recovery that entered restart earlier. Source defaults are not evidence of the user's actual configuration.

## Minimum sufficient component API

The missing operation is an awaitable, instance-bound pause lease that synchronously prevents new starts, cancels timers/heartbeat, joins existing restart/start work, and confirms child exit; release explicitly permits restart. It must survive the asynchronous continuations above. Merely exposing a stop command, or only a current recoveryInFlight flag without a start gate, is insufficient.

We cannot create that capability by wrapping the existing exported deactivate function. Accessing/replacing closure internals via debugger inspection, rewriting the official bundle, or patching global timers/process spawning would be a materially different and more invasive architecture. None was implemented or silently introduced.

## Deterministic evidence

`test/official-1.9-pause-boundary.test.cjs`: seven bounded tests, no real timers, processes, accounts or official module execution. These are explicitly source-derived sequencing models, not RPC tests:

- second deactivate + empty port/process while older recovery can still start;
- a ready replacement does not reveal that older restart;
- observed autoRecover=false does not cancel already-entered restart;
- cleared timer versus already-running callback;
- heartbeat-generation fencing versus unfenced restart;
- in-flight pre-spawn startingPromise after a no-process stop;
- indistinguishable public stopped observations and denial of credential write.

Together with existing cooperative-pause counterexamples and local lifecycle regressions: 23/23 passed. Independent reviewer reread the complete 1.9 recovery/heartbeat and lifecycle/export evidence and confirmed the missing capability. No product compatibility guard was relaxed. Full product checks and a new VSIX were not run/built because a usable 1.9 mechanism has not been established.

Static evidence: Library `libfile_f7277e362f1881918a9ba0d12df76046` (all 38 lines), and `libfile_9d4247a68614819191b479457ee11217` (1.9 section lines 67–127). No official package was executed.

## Automatic fallback choices, with their actual limits

1. **Immediate safe behavior:** fail before stopping/writing, leave the current environment intact, optionally open the official login UI. This does not switch to a stored account and is not claimed as the requested repair.
2. **Automatic close/switch/reopen:** one interruption confirmation, native save/cancel handling, launch a detached coordinator via private IPC, automatically request closure of only the confirmed windows, prove their relevant host and Hub births exited, run the existing guarded transaction, then reopen the recorded workspaces and perform fresh verification. No password or external terminal is inherently required: original encrypted recovery remains in SecretStorage; a short-lived helper can receive needed material over private IPC, never argv/logs. However this route is NOT yet validated: it needs a proven exact Windows-client/WSL-server close/reopen transport, independently persistent SecretStorage across those restarts (the cloud smoke environment previously fell back to memory), and reliable failure/reopen handling. These are concrete acceptance requirements, not an implemented fallback. Do not use the old password/terminal trial as a substitute.
3. **Official pause support:** an official supported instance pause lease described above permits retaining the present component-only UX and existing coordinator. No such capability appears in the supplied exact 1.9 contract.

The fallback does not need to prevent arbitrary future windows: the accepted user constraint remains no new/reconnected windows during the operation. It does need to distinguish a confirmed closed host from one automatically recreated by the existing editor/server supervision. A reload command that immediately starts a replacement does not provide stop→write→start ordering.

No new 1.9 candidate is available. Do not install the 1.8 candidate on this 1.9 environment or downgrade the official extension. No real account, window, process, configuration, installation or publication was touched.
