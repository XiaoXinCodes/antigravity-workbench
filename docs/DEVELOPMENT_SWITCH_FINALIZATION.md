# Retryable verified account-switch completion

## Baseline and evidence

Checked remote `main` and `v0.1.16` on 2026-10-20: both resolve to
`2d8993638f08f813b7481c1a89cb93b4ba3691b7`. Work is isolated on
`fix/retryable-switch-finalization`. No repository/environment AGENTS.md or
.agents/skills were present. CONTRIBUTING.md, README, docs index and CI were read.

The supplied machine observations establish a live recovery-marker owner and a
successful account switch reported by the user. They do **not** establish why the
first cleanup was interrupted. An absent Windows database key is not authoritative
about SecretStorage API contents, pending writes, host-scoped keys or memory.

An independent export of the baseline was compiled and tested with synthetic
accounts and a real temporary LiveLocks directory. After successful
`finishVerified`, interrupting before `clearRecovery` leaves no journal but an
active recovery marker. `reconcileRecovery(null)` returns
`LOCK_PROCESS_STILL_ALIVE`. This deterministically reproduces the protocol gap;
it does not identify the original machine's trigger. The regression suite also
exercises this old call ordering while asserting that the new orphan diagnostic
preserves the marker.

## Protocol

The operation mutex covers verification and every completion mutation. After
fresh Hub/storage verification, saved credential refresh and index promotion:

1. Capture the recovery marker's exact owner bytes, directory inode/device,
   transaction id and nonce under the held operation lock.
2. Write and confirm an encrypted completion receipt at the existing host-bound
   recovery key plus `.completion`. The receipt contains schema, transaction id,
   host binding, original journal key, SHA-256 of the exact verified journal and
   the marker snapshot. It contains no credential body, account email or Hub proof.
3. Resolve any pending storage mutation, compare the journal hash and marker,
   delete and confirm the journal.
4. Clear only the exact receipt-bound marker through the existing exclusive
   `.release`, snapshot checks and directory-retirement implementation.
5. Delete and confirm the receipt. Marker absence is idempotent after retirement.

The receipt is the durable commit point. After it is dispatched, UI lease expiry,
view disposal and old callbacks cannot cancel cleanup or trigger rollback. A
failure cannot rewrite the receipt-bound verified journal into another revision.
Before this point all existing verification guards still apply. A replacement
journal or marker causes a conservative stop; a receipt cannot finish a different
transaction, even if a marker reused the transaction id with a new nonce/inode.
The original legacy journal key is recorded and used without moving its backup.

Refresh/startup and explicit Verify resume completion inside the operation lock
before ordinary reconciliation. RecoveryStore `settle` resolves ambiguous prior
mutations through fresh confirmed reads, without issuing another mutation or
trusting a cached absent value. Mutation promises are awaited, never raced with
UI timers. A rejected delete which already committed converges on retry. A
never-settling mutation continues holding the mutex.

The completed-but-not-cleaned state has a separate `cleanup` UI phase and a
localized **Retry cleanup** action. Other account mutations remain blocked.
Automatic cleanup retries are bounded to five attempts; explicit retry and focus
refresh remain available afterwards. The obsolete global pending boolean is only
a display cache: its write failure cannot undo authoritative completed cleanup.
The switch/login error paths do not restore or invoke legacy cleanup after commit.

## Legacy safety and limits

No receipt means no new authority to delete a live marker. An orphan with an
identified live owner is reported as `RECOVERY_COMPLETION_UNKNOWN`, rather than
claiming another window is signing in. Foreign profiles, unknown process identity,
legacy live PIDs, changed records and active operation locks still fail closed.
Dead-owner/PID-reuse checks retain the existing boot/start identity rules. A crash
between beginRecovery and the first journal write is likewise unknown, not a
successful transaction. There is no age-based deletion and no reload workaround.

Unresolvable storage ambiguity, indefinite backend promises, persistent permission
errors, replaced/corrupt records and legacy live orphans without completion evidence
cannot safely be promised automatic recovery. The implementation retains evidence
and guards; it does not infer success from two absent reads, elapsed time, a cached
identity or the user's acknowledgement. SecretStorage provides neither cross-process
CAS nor an fsync guarantee; the operation mutex and marker remain mandatory.

## Validation

New regression coverage in live-switch, live-ui and workbench-view includes:

- Journal deletion invalidates a verification lease; disposal during deletion.
- Clear failure, explicit/duplicate retry, focus refresh, reconstructed service.
- Receipt store, journal delete and receipt delete reject after committing.
- Every one of the 13 SecretStorage read boundaries after the receipt commit
  fails once; a new vault object/service resumes without in-memory acknowledgements.
- Awaiting a delayed delete retains the operation mutex against another window.
- Clear reports failure after marker retirement; a live release claim blocks
  cleanup until its test-owned injected claim is removed.
- Changed journal, same-id replacement marker, multi-window/profile exclusion,
  host isolation, same-host legacy key and marker-before-journal crash.
- Switch catch never rolls back a committed target or bypasses receipt cleanup;
  legacy pending-cache failure cannot reinstate permanent pending.
- Actual production webview renders cleanup in both languages with retry enabled,
  switching disabled and restore absent, using synthetic state only.

The existing complete suite retains PID reuse, unknown probe, active transaction,
claim-race, revision/late-read, legacy recovery and host-scope coverage. New tests
use only synthetic credentials, isolated directories and offline adapters.

Final command results and local artifact hashes are recorded with the candidate
commit in the task report. Linux x64 / Node 22.23.3 and isolated VS Code 1.141.0
are the executed platform. Windows/macOS and the user's WSL2 + Windows VS Code
1.142.0 / Workbench 0.1.15 / official extension 1.8.0 combination are not real-machine
validated here. Synthetic platform/probe tests are not a substitute for that matrix.
No real credentials/API, user installation, push, PR, merge or release was performed.
The separate Webview Service Worker issue is outside this change.
