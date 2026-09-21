# Matchlock invocation cleanup: phase policy, error serialization and the stopped-VM reaper

Campaign: **MTLK-CLEANUP** (bead `tamandua-6sy.33.10.42`, DECIDED A by Igor
2026-09-18). This document is the in-repo copy of the phase policy recorded in
the out-of-repo campaign contract
(`/home/kaladin/matchlock-work/matchlock-cleanup-contract.json`, `phasePolicy`)
and the full design doc (`/home/kaladin/tamandua-matchlock-design.md`, §10).

## Incident (vaimetal #44, 2026-09-18T21:29:28Z)

The developer's story-4 round (VM `vm-394274ee`, ~41 min) **completed** and the
verifier had already claimed the next step when the pi runner's `close` of that
VM failed. The RPC client rejects pending requests with a **plain JSON-RPC error
body** `{code, message}` (`rpc-client.ts` `pending.reject(obj.error)`); the
pre-fix runner rendered it with `err instanceof Error ? err.message : String(err)`,
so the daemon log recorded the cause as `vm close/dispose: [object Object]`. The
failure was classified as an invocation infrastructure failure and the run was
force-failed, canceling every step including the live verifier.

Forensics (read-only) showed the close error was a `{code:-32000 ErrCodeVMFailed}`
`(*Sandbox).Close` aggregate; the exact message was lost to the `[object Object]`
rendering. matchlock's `handleClose` had run `(*Sandbox).Close`, which
**unregistered the row** (`status='stopped'`, `pid=0`) and removed the disks
*before* returning the aggregate error. The VM was therefore genuinely stopped
and the completed round was thrown away for nothing. The stopped row and the VM
state dir were left behind, together with five stopped VMs from 20:30.

## Error serialization

Every error on the Matchlock invocation path is rendered by
`serializeMatchlockError(err, ctx, opts?)` (`src/installer/matchlock/runner-error.ts`).
The output is ONE byte-bounded single line carrying the message, name, code, the
first stack frames, the VM id, the phase (`create` / `probe` / `exec` / `close` /
`dispose` / `broker-close` / `suite-store-close` / `vm-evidence-removal`) and the
controller stderr tail. It accepts an `Error`, a plain RPC body
`{code, message, stderrTail?}`, a string and any other value (bounded JSON;
circular -> `[unserializable matchlock error]`). It can never produce the literal
`[object Object]`. `describeMatchlockError` keeps its pinned public output.

## Phase policy (source of truth)

A failure in `create`, `probe` or `exec` before/during the round is an
infrastructure failure of the round. A `close`/`dispose` failure **after the
harness process has exited** is NOT: the round's result (stdout, STATUS,
evidence) is kept and processed normally, the failure is logged at WARN with the
serialized detail, and the VM is handed to the reaper.

| Phase | When | Fatal? | On failure |
| --- | --- | --- | --- |
| `create` | before the harness runs | **yes** | typed `MatchlockRunnerError` (`matchlock_cleanup_failed`); scheduler force-fails the run |
| `probe` | launch-time harness probe | **yes** | typed runner/infra failure; scheduler force-fails |
| `exec` | during the harness round | **yes** | typed runner/infra failure; scheduler force-fails |
| `close` | **after** the harness process has exited | **no** | WARN with `serializeMatchlockError` (vmId/runId/invocationId/phase); write a US-003 orphan record; keep the round result (output/exitCode/stderrTail/evidence) with `cleanupConfirmed=false` and a bounded `vmCleanupFailure`; the reaper disposes the VM on its next pass and the run's completion cleanup retries it |
| `close` | before the harness exits | **yes** | typed `MatchlockRunnerError` (`matchlock_cleanup_failed`) |
| `dispose` | after the harness exits | **no** | same as post-harness `close` (WARN + orphan record + round kept) |
| `dispose` | before the harness exits / cancel-abort | **yes** | typed runner/infra failure |
| `close` | server response names an already-stopped / already-closed VM | **no** | recognized benign body -> CONFIRMED close (`isClosed=true`, late-create cleanup confirmed); no cleanup error |

The pi runner (`pi-invocation-runner.ts`) and the Hermes runner
(`hermes-invocation-runner.ts`) both implement this policy. The scheduler's
force-fail classification (`matchlock_cleanup_failed` ->
`matchlock_invocation_infra_failed`) is unchanged; the round that used to be
discarded is now returned.

## Orphan handoff and the reaper

When the non-fatal post-harness `close`/`dispose` failure is seen, the runner
writes a bounded, atomic per-run record (`src/installer/matchlock/vm-orphans.ts`)
under `<runRoot>/<bareRunId>/matchlock/orphans.json` carrying vmId,
matchlockHome, runId, invocationId, agentId/round, kind, phase, the serialized
error and an ISO timestamp.

`reapStoppedMatchlockVms` (`src/installer/matchlock/vm-reaper.ts`) runs ONE
bounded pass:

1. Read `<matchlockHome>/.matchlock/state.db` **read-only** and select the
   `vms` rows with `status='stopped'`. A corrupt, absent or locked DB is a
   bounded diagnostic, never a throw.
2. In run-scoped mode only the run's recorded orphan VM ids are eligible; an
   unrelated stopped row is reported `skipped-unowned` and never touched.
3. Skip any candidate whose recorded pid is a live `matchlock`/`firecracker`
   process — the process check, never `matchlock list` status (stale,
   observation 7). A pid of 0 is never alive.
4. Capture the VM's `config.json` + `logs/` evidence first, then remove it by
   **exact id** (`matchlock rm <vmId>`, `HOME` forced). It never uses
   `prune`/`gc` and never selects by name or glob, and it clears the orphan
   record after a confirmed removal.

`reapOrphanedMatchlockVms` is the operator / run-teardown entry point: operator
mode takes an explicit `matchlockHome` (+ optional `vmIds`); run-teardown mode
derives the effective HOME(s) from the run's orphan records. The scheduler calls
it from `removeRunCrons` and the sweep timer; the pi/Hermes runners also
best-effort retry ONE pass for the exact handed-off VM.

## No-privs operator note (vaimetal, 2026-09-19)

Inside a sandbox with `NoNewPrivs: 1` the file capabilities of
`/usr/local/bin/matchlock` (`cap_net_admin,cap_net_raw=ep`) are not granted, so a
real `matchlock rm` fails with
`reconcile nftables rule: netlink receive: operation not permitted` and leaves
the stopped row behind. `/opt/matchlock/AGENTS.md` documents the sanctioned
workaround: call `state.Manager` `Remove(id)` directly, which bypasses the
nftables reconciler and performs the same state row delete plus exact VM-dir
removal. Production (a privileged host) needs no such workaround: the reaper's
exact-id `matchlock rm` path is correct there. US-010 used the documented
workaround for the six leftover stopped VMs (`vm-394274ee` and the five 20:30
VMs) under `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`; the
attempted `matchlock rm` exit code (1, netlink EPERM) and the bypass outcome are
recorded in the contract's `reaperEvidence`. A VM with a live firecracker
process is never touched.
