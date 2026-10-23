# Official 1.9 automatic offline candidate

2026-10-22; uncommitted repair on main baseline `080f2cc11f6f43ff928c1f8025d5cfc670be4447`. Same extension identity/version 0.1.17; no new release, installation or real-account execution.

## Scope and execution

The exact official 1.9.0 entrypoint SHA256 is `f77a37c4bd66612f4ed26d9e80ce3969af543f853e2cc113ca466e7f8b6aa880`. Existing exact 1.8 component cooperation remains. The 1.9 WSL file route prepares a schema-4 journal after fresh authenticated server identity, process-bound storage proof and stable original bytes. User confirmation explicitly requires closing related windows on each switch. This is not merely an installation reload.

An automatic random key is persisted, read back and directory-synced before journal/fence publication. It lives in a private 0700 directory/0600 file; backups remain encrypted with that key. This protects against other OS users, not the same UID; no independent OS-vault guarantee is claimed. No password, copied command, external terminal, official setting change or host termination is required/performed by Workbench.

After releasing the initiating operation lock, UI launches a detached Node helper with non-secret identifiers only. It strips extension-host entrypoint environment markers, validates host binding, acquires the shared lock, authenticates the journal and schema-4 fence, then acknowledges readiness. READY means prepared, not switched. Helper waits for known host/Hub births to exit, rejects new instances, and rechecks complete census plus credential CAS before each mutation. The five-minute bound covers waiting for closure; it does not kill an in-flight writer. Cancellation is a private persistent flag, not a signal to a PID.

On reopening, key-backed installed/restored transactions are freshly verified automatically. Wrong identity, unauthenticated RPC, unknown credentials or unavailable Hub keep protection. Recovery offers retry, guarded restore, or explicit retain-current without overwriting credentials or deleting backups. Old password-based schema-4 transactions retain their previous path.

## Evidence and limits

- Original 1.9 lifecycle source establishes that stop does not fence an already entered recovery restart. This adapter waits for host death instead of interpreting a timeout or cleared export as a barrier.
- Production helper/session/key/lock/file code is exercised by detached synthetic processes. The initiating process actually exits. Census is deliberately restricted to fixture processes and injected births; this is not native WSL discovery acceptance or official RPC acceptance.
- Tests cover new-instance refusal, cancellation, durable keys, missing/corrupt/wrong-bound keys, private permissions, lock handoff, uncertain helper launch, retained backup, legacy recovery, normal 1.9 dispatch, automatic fresh verification and unknown/rotated credentials.
- A closed-loop regression exposed order-sensitive journal comparison. Deep strict equality now compares all fields/values without depending on property insertion order; process birth keys are explicit PID/start identity pairs. The initial failing run is retained with validation logs.
- The first full run exposed a fixture-only configuration mock failure plus an unbounded test wait. Version dispatch now leaves 1.8 resolution unchanged, and that wait has a bounded assertion. Tests were rerun rather than counting the interrupted run as passed.
- Native Windows/macOS mutation adapters, real Windows-client/WSL shutdown persistence, actual official fresh RPC and real account switching are not exercised. Early reopening can abort; users must refrain from opening/reconnecting related clients during the transaction. This is an operational constraint, not a guarantee that all future launches are prevented.

Final check totals, artifact identity and independent review are recorded in the delivery report accompanying the candidate.
