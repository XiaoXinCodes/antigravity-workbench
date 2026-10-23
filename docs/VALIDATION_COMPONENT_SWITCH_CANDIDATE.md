# Component switch candidate — 2026-10-22

This document supersedes the implementation-status sections of the earlier hub/offline investigation notes. It is a candidate for separately authorized real-platform acceptance, not a release or a claim of real-account validation. Base: `080f2cc11f6f43ff928c1f8025d5cfc670be4447`, branch `investigate/hub-process-verification`.

## Delivered normal flow

For the finite reviewed Linux/WSL file-only route: choose account → one interruption confirmation → prepare all discovered related hosts → each participant stops its own official instance → confirm OS process exit and empty Hub census → guarded credential replacement → restart only the verifier → fresh server identity → finalize → restore peers. No recovery password, external terminal, manual window closure, or whole-window reload is requested on this route.

The exact installed official 1.8.0 entrypoint SHA256 must be `09de6ab0d4431872ad6a6293e33315a15359a1b7fe2b6af7c0cb14294afc8ec9`. The already-loaded internal `deactivate` export is used, not a public pause API, not a modified or newly evaluated official extension. Restart uses the registered reconnect/focus commands and observed own process readiness; their return value does not prove readiness. Version/hash/capability mismatch blocks before credential replacement. Official 1.9.0 automatic-recovery semantics are not admitted by this adapter.

Normal switching requires ready participants. Native census includes hubless extension hosts; registration is not discovery. An old, unregistered, unsupported, or unprovable participant blocks preparation. Recovery can reconstruct a missing local verifier after explicit consent; other already-stopped participants remain stopped until the journal is resolved. The separate current-backend restart/recover commands never perform an account switch.

## Safety and recovery

- Existing shared operation mutex, encrypted journal and original backup remain in force. Actor requests bind transaction ID, exact operation owner/nonce and process birth. Cross-profile participants can read-verify that shared lock; they cannot acquire/remove another profile's lock.
- Actual stop settlement and old PID/birth exit are separate checks. IPC timeout preserves the original request; retry joins it. An empty scan cannot convert an unknown restart into stopped write admission.
- File mutation rechecks operation ownership, all participants stopped and census immediately before rename/unlink, then rechecks the expected old bytes. This reduces observed-race exposure; it is not an OS-level prohibition on future starts.
- User constraint: no new/reconnected windows or official configuration changes during the confirmed transaction. The protocol does not technically enforce that constraint and does not claim an absolute global start fence.
- Verification failure never becomes success. Rollback only replaces the exact original or selected stored credentials. Unknown token refresh/external login is not overwritten. Explicit “keep current login” requires fresh identity, preserves the original encrypted journal in a retained archive, and writes no credential slots.
- Partial stop failure and failed restoration remain retryable. Successful credential commit followed by peer restoration failure offers **Restore backends**, without switching again. Pending restoration is derived from durable mailbox records after UI recreation.
- Replacement coordinator can acquire the mutex after the previous process birth has exited, rejoin surviving actors, and recover the transaction. No lease timeout automatically resumes peers.
- Legacy schema4/offline transactions keep their original recovery handling; they are neither silently deleted nor migrated over. The old offline UI is absent from the normal component-switch path.

## Reproduced intermittent failure

Atomic replacement of mailbox state between `open` and the first descriptor `stat` can leave the old descriptor with `nlink=0`. The old `PrivateState` implementation classified this as unsafe storage. A replacement after the first stat could instead produce a changed-snapshot error. Either failure could be surfaced as restoration failure during three-host takeover.

The deterministic regression replaces that exact opened file before its first stat. It fails against main's actual `private-state.ts` and passes after the fix. Unlinked snapshots are discarded and reopened with bounded retry; hard links, wrong ownership/mode and invalid schemas remain rejected. This explains the isolated test failure; it does not establish the user's original screenshot had this cause.

## Verification and limits

- Full Node/TypeScript/lint/model checks: 1,961 tests, 1,957 passed, four Windows-only skips, zero failures. See `checks.txt` in the evidence bundle.
- Python checks: 47 passed (license 8, release safety 34, package/docs 5). Release-safety operations are mocked.
- Isolated VS Code 1.141.0 under Xvfb: activation/commands/refresh/help/locale smoke passed. Independent review: 118/118 key tests passed; no remaining high-priority issue identified in the reviewed finite route.
- Real isolated Node processes: three-host IPC, child stop/exit, replacement coordinator after SIGKILL, changed host birth, surviving stopped participants, different profiles, and restoration passed. All credentials and child processes are synthetic.
- UI/transaction tests cover normal one-confirmation flow, cancellation, duplicate clicks, unsupported contracts, partial stop, resume failures before/after commit, late starts, fresh RPC failure, rollback, unknown credential rotation, retained backup, recovery button routing and UI recreation.
- No actual official plugin was invoked for these regressions. Official 1.8/1.9 lifecycle findings are static-source evidence; fresh RPC outcomes in transaction tests are mocks. Windows native, real Windows-client/WSL-server multi-window behavior and real-account switching remain untested here.
- Process-crash recovery is covered; power-cut durability of the entire directory ancestry and the platform SecretStorage implementation is not claimed. Same-UID hostile code and arbitrary official starts during the user-constrained interval are outside the cooperative protocol.

No install, real-account operation, user-process termination, push, PR, merge or publication was performed. Old trial-v3/WIP artifacts are superseded and are not the candidate to test.
