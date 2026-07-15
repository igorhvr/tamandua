# Tamandua Cross-Version Update Protocol

This document specifies the cross-version update protocol for Tamandua. It serves
as the single contract for all protocol runs (PROT, TOPO, RECV, ROLL). The
protocol is designed so the update machinery in the new version can orchestrate
a safe handover from the currently-running old version.

## 1. Legacy Interception Point

The legacy updater (`0258feeceeb2ab3934b71463039e6e282700f05a`) pulls candidate
source and immediately executes the candidate `build-and-install`. Interception
is therefore the **first line** of the newly-pulled `build-and-install`.
Everything before that line runs under the old updater. Every instruction after
that line runs under the candidate's control.

Only source HEAD movement is unavoidable on active-work refusal; the candidate
code itself handles refusal by reading protocol state early in `build-and-install`.

## 2. Owner Model

| Role             | Owner                                            |
|------------------|--------------------------------------------------|
| Legacy owner     | The **old Node.js updater process**, passed from build shell as `$PPID` |
| Current owner    | `process.pid` of the updater                     |
| Coordinator      | Is **never** an owner                            |
| Build shell      | Is **never** an owner                            |

The coordinator validates ancestry: the claimed updater PID must be a genuine
ancestor of the coordinator process. The coordinator's own PID is never an
acceptable owner.

## 3. Protocol Gate

A transient singleton row (the "gate") lives in the Tamandua database. It is
protocol state, not application schema. It carries forward-compatible fields:

| Field                     | Type      | Description                                         |
|---------------------------|-----------|-----------------------------------------------------|
| `id`                      | INTEGER   | Singleton key, always `1`                           |
| `token`                   | TEXT      | Random capability token (crypto.randomUUID)         |
| `mode`                    | TEXT      | `legacy` or `current` (schema constrained)          |
| `phase`                   | TEXT      | Current phase (see §4, schema constrained)          |
| `owner_pid`               | INTEGER   | PID of the updater process                          |
| `owner_identity`          | TEXT      | Serialized immutable process identity               |
| `guardian_pid`            | INTEGER   | PID of guardian process (nullable)                  |
| `guardian_identity`       | TEXT      | Immutable identity of guardian (nullable)           |
| `topology`                | TEXT      | Original topology JSON (validated on insert)        |
| `artifacts`               | TEXT      | Expected artifacts JSON (validated on insert)       |
| `readiness`               | TEXT      | Readiness JSON (validated on insert)                |
| `failure_reason`          | TEXT      | Durable failure reason (bounded)                    |
| `failure_details`         | TEXT      | Durable failure details (bounded)                   |
| `created_at`              | TEXT      | ISO 8601 timestamp                                  |
| `updated_at`              | TEXT      | ISO 8601 timestamp                                  |

Schema-level constraints enforce valid `mode` and `phase` values.

## 4. Phase Transition Graph

The **legal edges** in PROT scope are exactly:

```
ACQUIRED -> GUARDIAN_RECORDED
ACQUIRED -> FAILED
GUARDIAN_RECORDED -> FAILED
```

- `FAILED` is **terminal** and remains admission-blocking.
- No self-transition is legal.
- No backward transition is legal.
- No token-only transition is legal.
- Reading the current phase then CAS is illegal — the caller must supply its
  own expected phase explicitly.

Every mutating write (phase CAS, guardian record, failure write) uses **one**
`BEGIN IMMEDIATE` transaction plus an SQL predicate over:
- Singleton `id = 1`
- The token (must match)
- Caller-supplied expected phase (must match)
- Expected owner PID (must match)
- Exact serialized immutable owner identity (must match)

A zero-row change is a refusal; state is left unchanged.

## 5. Token Capability Model

A random token (`crypto.randomUUID()`) is generated during acquisition and
scopes all mutating operations. The token is returned to the caller on
successful acquisition. All subsequent mutating calls (CAS, guardian record,
failure) must present the matching token or the operation changes zero rows.

## 6. Immutable Process Identity

### Linux

- `/proc/sys/kernel/random/boot_id` (raw kernel value)
- `/proc/<pid>/stat` field 22 (`starttime` in clock ticks)

Both values are concatenated and serialized. Raw kernel values are preferred;
do not use `Date.now()`, elapsed time, or PID-only liveness.

### macOS

- `ps -o lstart= -p <pid>` (real process start time data — not elapsed)

Argument-vector process APIs (`child_process.spawn` with `['ps', '-o', 'lstart=', '-p', String(pid)]`)
only; never use interpolated shell commands.

## 7. Guardian Identity

A guardian is an optional detached process that monitors the legacy updater.
Guardian identity uses the same immutable identity format as the owner.
Guardian PID must be a canonical positive PID; guardian identity must be
captured live. Recording a guardian may only transition `ACQUIRED -> GUARDIAN_RECORDED`.

## 8. Topology, Artifacts, and Readiness

- **Topology JSON**: maps old service endpoints to their new counterparts
  (legacy unified `tamandua.pid` → current motor + independent dashboard).
- **Artifacts JSON**: expected build artifacts and their paths.
- **Readiness JSON**: predicates that must be satisfied for release.

All three fields must parse as valid JSON and are bounded on insert.
They are stored as opaque strings; the coordinator validates structure but
interprets semantics only in later runs (TOPO, RECV).

## 9. Failure Diagnostics

Failure reason and details are durable, token-scoped, and bounded. They
preserve forensic data for debugging without leaking unbounded data.
On any refusal (running/paused work, existing gate, ancestor validation
failure), the coordinator returns nonzero without mutating state.

## 10. Takeover Predicates

Takeover (moving from the old updater controlling the DB to the new version
being live) is predicate-complete:
- All readiness predicates must pass.
- The old owner must no longer be running (validated via identity, not just PID).
- Successful release is atomic.

A dead process is evidence, never authorization. No public token-only release
is permitted.

## 11. Atomic Validated Release

Successful release validates all predicates synchronously within
`runUpdate()` and completes atomically. It does not circularly wait for a
guardian.

In legacy mode, completion uses a detached handshaken guardian that waits for
the old updater identity to disappear from the process table.

## 12. ROLL Boundary

The ROLL run implements rollback behavior. It is deferred to a later run.
In PROT scope, no rollback machinery is present.

## 13. Legacy Tamandua.pid Mapping

The legacy `tamandua.pid` file contains the PID for a unified process that
serves dashboard + motor/control. In the current architecture these are
separate (motor/control daemon + independent dashboard). The topology JSON
captures this mapping. Cold startup starts nothing.

Legacy real paths are positional control-only and MCP-only;
there is no dashboard-standalone entrypoint in the legacy version.

## 14. --force Semantics

`--force` is **never** admission authority. It cannot bypass the protocol gate,
active work refusal, or identity validation.

On failed legacy no-change recovery, `--force` may be the documented way to
re-enter the candidate `build-and-install` path, but running/paused work still
refuses. The `--force` flag is not consulted by the coordinator's acquisition
path.

## 15. Dormant State (PROT)

In the PROT run, the protocol module exists but is **not wired** into any
production callers. Normal Tamandua behavior is unchanged. The protocol
becomes active in subsequent TOPO and RECV runs.

## 16. Coordinator Interface

The coordinator exposes these internal machine-oriented operations:

| Operation           | Description                                     |
|---------------------|-------------------------------------------------|
| `acquire`           | Claim the singleton gate for an update          |
| `inspect`           | Read current gate state (null-safe)             |
| `phase-cas`         | Strict CAS phase transition                     |
| `record-guardian-cas` | Record guardian identity (ACQUIRED→GUARDIAN_RECORDED only) |
| `fail`              | Token-scoped failure (ACQUIRED/GUARDIAN_RECORDED→FAILED) |

Release, clear, drop, and takeover are **not** exposed in PROT scope.

Emitted JSON on stdout is bounded. Diagnostics on stderr. Meaningful nonzero
exit codes on failure.

## 17. Blocking Triggers

Two production triggers fire on the `runs` table whenever the singleton gate
row exists:

1. **INSERT blocker**: `RAISE(ABORT, 'update in progress')` on any `runs` INSERT.
2. **UPDATE blocker**: `RAISE(ABORT, 'update in progress')` on status transition
   into `running` for existing non-running runs.

These triggers are the only coupling between protocol state and application
tables. They enforce that no new work can be created or started while an
update is in progress, including during `FAILED` state.

## 18. Implementation Structure

- `scripts/update-protocol.mjs`: Single ESM module containing all mutating
  DDL, gate, phase, and failure operations. Node built-ins only.
- `scripts/update-coordinator.mjs`: Thin CLI exposing machine-oriented
  operations with bounded JSON stdout and diagnostics on stderr.
- `docs/upgrade-protocol.md`: This file — the protocol design record.
- `tests/update-protocol.test.ts`: Adversarial focused tests.

All protocol operations that mutate the database live in a single module.
There is no duplicate TypeScript state machine and no copied DDL elsewhere.
