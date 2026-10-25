# Practical component switch candidate

This supersedes the whole-version rejection and startup-history observation
experiments for the normal component path. It is not a claim of a race-free
official pause API. No official source or runtime is patched.

## Normal path

Select an account, confirm task interruption once, and do not concurrently log
in elsewhere or manually restart the backend. Workbench reads current effective
`antigravity.autoRecover` in the same extension host. The reviewed desktop start callers do not pass configOverride; a future implementation may differ.
Compatibility now checks the loaded deactivate hook, restart commands, Hub API,
current configuration and exact process identity rather than a release number or
whole-bundle source hash. Hook presence is a capability check, not a semantic
guarantee that a future implementation has identical stop/recovery behavior. Boolean true enables
recovery unless the host's single ANTIGRAVITY_DISABLE_AUTO_RECOVER field is '1'.
The candidate reads that one field; it does not change configuration/environment,
require startup observation, or change extension activation order.

The existing credential-operation lock, target validation and original-session
proof remain. The calling window stops its loaded official component, waits for
the exact old process birth to exit, and checks current exports and processes
again. A late replacement is adopted only if the exact exported capability
identifies it and it is directly owned by this host. At most three stop calls
are allowed across that lifecycle, including pre-write rechecks. Unknown or
foreign replacements fail before a guessed stop. Polling observes exit; elapsed
time is not accepted as proof of quiescence.

Original credentials are backed up and read back before target write. Existing
write-time comparisons and readback remain. Reconnect/focus are followed by
fresh official identity verification, with pinned process-birth checks before
and after the identity query. A process appearing or a write returning is not
success. Later identity changes and fixed authentication errors immediately
clear the green current-login state while fresh verification runs.

If admission fails before a credential write was dispatched, an unchanged
original needs no credential rollback: retain/mark recovery metadata, restart
the component and fresh-verify the original. If current credentials differ,
retain the prepared backup and do not overwrite them. Attempted/partial writes
continue through the existing guarded recovery logic.

## Multiple Hubs and impact

Normal multi-Hub switching now uses each related host's Workbench component
actor. Before any stop, every selected exact Hub/parent birth must have a usable
stop/reconnect/fresh-verification channel. Missing participants fail before
interruption; unrelated empty hosts need not register. This is not proof that
an empty host has no in-flight future startup.

All selected components stop and their exact process births must exit before
one credential transaction writes. All participants then reconnect and provide
fresh identity proofs bound to their own new process births. Peer identity is
compared using a per-attempt challenge digest, not plaintext account/token IPC.
A peer failure retains the installed target, original backup and journal; retry
verification does not write again or automatically roll back. Historical actor
obligations remain recoverable. Single-Hub switching does not require peers.

Only official components are stopped. No extension host, VS Code client,
profile, sync state or VS Code login is changed. Task interruption is real;
active Workbench image operations refuse preparation and final stop.
The coordinator must prove its actual file storage route; peers never write
credential slots. A peer using a different store can fail fresh verification,
and is not falsely reported synchronized or overwritten in that store.

Historical offline journals remain readable/recoverable. They are not deleted
to enable the normal path. Normal switch no longer calls prepareAutomatic or
requires the full-window automation capability.

## Accepted residual race and supported operating constraint

An already entered recovery can resume after the final empty-process check,
even if the current setting is false. A late Hub can read old credentials before
the target write and later write old/rotated credentials back. Finite scans and
three stop attempts reduce observable interference; they cannot prevent this
interleaving. Deterministic tests retain that counterexample deliberately.

Write/readback, birth revalidation and fresh identity reject detected failure;
periodic identity probes revoke stale success subsequently. An unobserved
third-party credential write between the final compare and filesystem rename
can still be overwritten: these are not OS atomic compare-and-swap operations.
Backup preserves the known original/target, not a never-observed third value;
such a competing login may require reauthentication. Do not claim zero races,
zero loss under arbitrary concurrent login, or that one successful probe proves
permanent identity stability.

## Source and validation scope

Official 1.9 extension.js SHA256:
f77a37c4bd66612f4ed26d9e80ce3969af543f853e2cc113ca466e7f8b6aa880.
Parent-provided exact source confirms stop cancels pending recovery timers and
heartbeat, but entered runRecovery -> restart -> start is not cancelled.

Open-source comparison did not reveal a portable hot-switch API:
Manager at 9f8e4f24d61b33fa80b8078d104c942752a5fa0b warns that live agy can
retain/write old credentials; its IDE/Standalone restart routes are different.
Cockpit at 58d51e3074def47513cb1de6338f76e95b3a638e uses custom host OAuth
setters or delegates to Tools. Those APIs and profile/device mutations were
not copied into Workbench.

Tests use synthetic accounts, injected official RPC/process snapshots, and
isolated test children. Real official RPC and native Windows/WSL switching are
not validated by these tests. Installation and any actual account-switch trial
require separate authorization; the build does not install itself.

## Verification dispatch correction

File-only storage does not identify a coordinated transaction. Verify/Restore
now select historical cooperative recovery only for durable actor records bound
to that exact journal ID; unrelated actor obligations or unreadable state refuse.
Ordinary practical verification uses the existing fresh identity/finalizer and
never restores the original credentials merely because verification failed.
An active recovery owned by another host birth cannot be finalized/restored by
this window, even under the same profile. WSL polling still does not automatically
submit pending account verification. Historical no-journal peer restoration is
preserved. The legacy receipt string 1.8.0 denotes the existing IPC protocol,
not a required extension package version.
