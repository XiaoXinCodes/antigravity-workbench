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

1. Under the existing `.release` claim, atomically replace the recovery marker
   with schema 3 containing a completion binding: transaction id, host fingerprint,
   original journal key and SHA-256 of the exact verified journal. This filesystem
   fence is the commit point. It contains no credentials, account email or Hub proof.
2. Persist an encrypted `.completion` receipt containing that binding and exact
   marker snapshot (owner bytes, inode/device, nonce), initially `deleted=false`.
   If this write fails or a process restarts before it, reconstruct from the fence.
3. Validate exact journal/hash and marker identity. Await explicit journal deletion
   fulfillment, then confirm reads; absent reads alone cannot certify a rejected
   deletion. Under the fence, rejected mutations can be retried idempotently.
4. Persist `deleted=true`; retire only the exact receipt-bound marker using the
   exclusive `.release` and directory-retirement protocol. Delete the receipt last.
   An absent marker is idempotent only with the confirmed deletion receipt.

After filesystem commit, UI lease expiry, disposal and old callbacks cannot cancel
cleanup or cause rollback/journal rewrites. Before it, all verification guards apply.
Schema 3 fences ordinary restore, clear and abandoned-lock recovery even for dead or
PID-reused owners. Both v0.1.15 (`7dc4c29b46bad9af71e79f8c59540c5cf8955123`)
and baseline v0.1.16 strictly reject this unknown schema; the operation lock stays
schema 2 to retain mixed-version mutual exclusion.

Refresh/startup and explicit Verify resume inside the operation mutex. Pending
receipt mutations are a read-only cleanup signal, so failed storage confirmation
cannot block entry to the retry path. Exact confirmed string writes need no second
write; missing reads after a rejected delete never count as fulfilled. Indefinitely
pending mutations continue holding the mutex. Finished claim/operation releases
retain exact in-process ownership evidence for retry after transient I/O errors;
this does not authorize removing any arbitrary live-owner lock.

The completed-but-not-cleaned state has a separate `cleanup` UI phase and a
localized **Retry cleanup** action. Other account mutations remain blocked.
Automatic cleanup retries are bounded to five attempts; explicit retry and focus
refresh remain available afterwards. The obsolete global pending boolean is only
a display cache: its write failure cannot undo authoritative completed cleanup.
The switch/login error paths do not restore or invoke legacy cleanup after commit.

## Legacy safety and limits

Without a receipt or schema-3 completion binding there is no new authority to delete a live marker. An orphan with an
identified live owner is reported as `RECOVERY_COMPLETION_UNKNOWN`, rather than
claiming another window is signing in. Foreign profiles, unknown process identity,
legacy live PIDs, changed records and active operation locks still fail closed.
Dead-owner/PID-reuse checks retain the existing boot/start identity rules. A crash
between beginRecovery and the first journal write is likewise unknown, not a
successful transaction. There is no age-based deletion and no reload workaround.

For a host-bound service, an absent legacy shared journal key is not blindly deleted: older clients on a different credential host are outside the local fence. This ambiguity is preserved for diagnosis.

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
- Every one of the 14 SecretStorage read boundaries after the receipt commit
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

## Backend disclosure and project association

Other backend rows default to a persisted native details disclosure; blocking status
and rescan remain visible. Per-row PID, parent and birth metadata are secondary
native details; batch termination is a secondary action and retains existing host
confirmation/opaque-selection guards. Normal other-window backends are not labelled
as anomalies. A failed rescan disables stale selection rows.

Linux/WSL association uses only explicit official Hub `--add-dir=` launch arguments,
with the existing executable/UID/argv readback checks. Only bounded, sanitized
basenames reach the UI; no full path, cwd guess, log contents or window-title claim.
These are launch associations, potentially different from later workspace changes.
Windows/macOS or missing/unsafe evidence displays unidentified; association does not
participate in process termination authorization. No real machine processes were
inspected or terminated for this implementation.
