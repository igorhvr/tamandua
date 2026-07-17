# Tamandua Cross-Version Update Protocol

This document is the design record for the cross-version update protocol. It
serves as the single contract for all protocol runs (PROT, TOPO, RECV, ROLL).

## Reading This Document — Implemented vs. Target Design

**Implemented today:** A dormant Node-built-in protocol foundation and thin
internal CLI, dynamically tested but **not invoked** by the normal
updater/build/install/service lifecycle. Present-tense statements describe
implemented behaviour.

**Deferred target design:** Production interception, topology/service
handover, guardian spawning/handshake, readiness/takeover/release, recovery,
and rollback. Sections describing these use **future/target language**
(e.g., "will", "intended") — they do not describe current production
behaviour. PROT, TOPO, RECV, and ROLL are scope/design labels; no such runs
are scheduled or guaranteed.

## 1. Legacy Interception Point

The legacy updater (`0258feeceeb2ab3934b71463039e6e282700f05a`) pulls candidate
source and immediately runs `build-and-install`.

**Target design:** Interception at the first line of `build-and-install` so
the candidate's update coordinator can refuse an active-update deployment
early. This interception is **not wired** today — `build-and-install` does
not yet call the coordinator, and the dormant foundation does not currently
make production updates safe. Source HEAD movement as the only mutation on
active-work refusal is a target guarantee for later integration, not a
current production claim.

## 2. Owner Model

`acquire(mode, updaterPid, ...)` requires an explicit `updaterPid` — a
canonical positive safe-integer PID that must be a genuine ancestor of the
coordinator process. The coordinator's own PID is explicitly rejected. The
coordinator captures the updater's live immutable process identity. This
ancestry-based validation rule applies identically to both `legacy` and
`current` modes; neither mode automatically makes `process.pid` the owner.

**Target design — intended wiring for future callers:**

| Role             | Intended owner                                               |
|------------------|--------------------------------------------------------------|
| Legacy owner     | The old Node.js updater process, passed from build shell as `$PPID` |
| Current owner    | `process.pid` of the updater (when it calls the coordinator directly) |
| Coordinator      | Is **never** an owner                                        |
| Build shell      | Is **never** an owner                                        |

The table describes how future callers are expected to supply `updaterPid`,
not current automatic assignment.

## 3. Protocol Gate

A singleton row (the "gate") lives in the Tamandua database. It is protocol state, not application schema.
The row is intended to be transient only in the deferred final design; no release/clear operation exists,
and an acquired row—including `FAILED`—remains permanently blocking, never removed by any protocol operation.

It carries forward-compatible fields:

| Field                     | Type      | Description                                         |
|---------------------------|-----------|-----------------------------------------------------|
| `id`                      | INTEGER   | Singleton key, always `1`                           |
| `token`                   | TEXT      | Random capability token (256-bit `crypto.randomBytes(32)`, canonical unpadded base64url, 43 characters) |
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

`topology`, `artifacts`, and `readiness` must parse as valid JSON and are
bounded at 4096 UTF-8 bytes each. They are stored exactly and are
semantically opaque to the protocol foundation.

Schema-level constraints enforce valid `mode` and `phase` values.

### Acquisition Contract

Acquisition resolves from nonblank `TAMANDUA_DB_PATH` or `HOME/.tamandua/tamandua.db`; absent DB or one missing `runs` is cold-initialized via
real `dist/db.js`. The caller's canonical positive safe-integer updater PID, genuine ancestry, and live owner identity are validated before
acquisition. After cold init, `BEGIN IMMEDIATE` is the first acquisition predicate; reserved artifacts are inspected under that writer lock. An
existing exact canonical table+trigger set refuses as already acquired; any partial, corrupt, wrong-type, wrong-table, wrong-DDL, or
case-conflicting reserved set refuses fail-closed without repair or adoption. With no reserved set, the canonical table and triggers are
created, validated by read-back, any `running` or `paused` run is refused, and the singleton `ACQUIRED` row is inserted. Post-`BEGIN IMMEDIATE`
failures roll back all protocol DDL/data; the DB closes in `finally`. Success returns `{ token, phase, mode, ownerPid, ownerIdentity }`.

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
- There is no generic `casPhase` module export and no `phase-cas` CLI
  operation. Phase transitions are performed only through `recordGuardian()`
  and `fail()`.

Every post-acquisition mutating write uses **one** `BEGIN IMMEDIATE`
transaction plus a SQL UPDATE predicate over:
- Singleton `id = 1`
- The token (must match)
- Caller-supplied expected phase (must match)
- Expected owner PID (must match)
- Exact serialized immutable owner identity (must match)

A zero-row change is a generic refusal with no phase/authority disclosure;
state is left unchanged.

Acquisition generates its own token via `crypto.randomBytes(32)` and is not
authorized by a preexisting token.

## 5. Token Capability Model

A random 256-bit token is generated via
`crypto.randomBytes(32).toString("base64url")` during acquisition — 43
characters of canonical unpadded base64url. The token scopes all
post-acquisition mutating operations and is returned on successful
acquisition. All subsequent mutating calls must present the matching token
or change zero rows. The token is stored in the database but never disclosed
through `inspect()` (see §16).

## 6. Immutable Process Identity

Identities are canonical bounded JSON objects, not concatenated text.

### Linux

`{"boot_id":"<uuid>","start_ticks":"<decimal>"}` — `boot_id` from
`/proc/sys/kernel/random/boot_id`, `start_ticks` from `/proc/<pid>/stat`
field 22 (starttime in clock ticks).

### macOS

`{"lstart":"<ps output>"}` — captured via `spawnSync("ps", ["-o", "lstart=",
"-p", String(pid)])` under C locale (`LC_ALL=C`, `LANG=C`). Argument-vector
API only — never an interpolated shell command.

## 7. Guardian Identity

### Implemented: Record-Guardian CAS

`recordGuardian()` receives a caller-managed live PID and expected canonical
identity, captures the guardian's identity live after `BEGIN IMMEDIATE`, and
requires exact equality before writing. It transitions
`ACQUIRED -> GUARDIAN_RECORDED` only, with a full authority predicate over
token, expected phase, expected owner PID, and exact serialized owner
identity. A zero-row change is a generic refusal; state is left unchanged.

`recordGuardian()` opens the DB in no-create read/write mode; absent DB, absent gate
table, or SQL predicate failure returns `{ changed: false }` without creating a DB file.

### Deferred Target

The module does **not** spawn, detach, handshake with, or monitor a guardian
— these are deferred target lifecycle behaviours.

## 8. Stored Metadata (Topology, Artifacts, Readiness)

### Implemented

`topology`, `artifacts`, and `readiness` must parse as valid JSON, are
bounded at 4096 UTF-8 bytes each, stored exactly, and semantically opaque.
Cold startup starts nothing.

### Deferred Target Semantics

Interpretation belongs to deferred, unscheduled design scopes; topology maps old→new
service endpoints, artifacts lists expected build outputs, readiness defines
release predicates. Legacy real paths are positional control-only and
MCP-only. None of this is implemented, scheduled, or guaranteed.

## 9. Failure Diagnostics

`fail()` persists reason (nonempty string, ≤256 UTF-8 bytes) and details
(string, ≤4096 UTF-8 bytes) atomically with the `FAILED` phase transition.
Both are durable, token-scoped, and bounded.

`fail()` opens the DB in no-create read/write mode; absent DB, absent gate
table, or SQL predicate failure returns `{ changed: false }` without creating a DB file.

## 10. Takeover and Release (Target Design)

Takeover and release are deferred integration concerns. The dormant
foundation does **not** contain an atomic release
operation, or any release/clear/drop/takeover machinery. There is currently
no production update orchestrator, no readiness evaluation, no service
stop/start or topology handover. A dead process is intended to be evidence,
never authorization.

In the target design, legacy-mode completion would use a detached handshaken
guardian waiting for the old updater identity to disappear from the process
table.

## 11. ROLL Boundary

Rollback and recovery are **not implemented**. A future ROLL scope would
have to define and prove rollback behaviour; no such run is scheduled or
guaranteed. In PROT scope, no rollback machinery is present.

## 12. --force Semantics

`--force` is **never** admission authority. It cannot bypass the protocol
gate, active work refusal, or identity validation. The `--force` flag is
**not consulted** by the coordinator's acquisition path.

**Target design:** `--force` may become the documented way to re-enter the
candidate `build-and-install` path on legacy no-change recovery, but
running/paused work would still refuse.

## 13. Dormant State

The protocol module exists but is **not wired** into any production callers.
Normal Tamandua behaviour is unchanged. There is currently no production
caller, no service stop/start or topology handover, no guardian
spawn/handshake, no release/clear/drop/takeover operation, no production update orchestrator,
and no rollback/recovery machinery. TOPO and RECV are deferred design
discussions, not scheduled or guaranteed runs.

## 14. Coordinator Interface

The coordinator exposes exactly four internal machine-oriented commands:

| Command               | Signature                                                                                                          |
|-----------------------|--------------------------------------------------------------------------------------------------------------------|
| `acquire`             | `acquire <mode> <updaterPid> <topology> <artifacts> <readiness>`                                                   |
| `inspect`             | `inspect`                                                                                                          |
| `record-guardian-cas` | `record-guardian-cas <token> <expectedPhase> <expectedOwnerPid> <expectedOwnerIdentity> <guardianPid> <expectedGuardianIdentity>` |
| `fail`                | `fail <token> <expectedPhase> <expectedOwnerPid> <expectedOwnerIdentity> <reason> <details>`                       |

Release, clear, drop, takeover, and `phase-cas` are **not** exposed.

**CLI bounds:** Exact-arity checked before any argument validation. PID
arguments use canonical ASCII-decimal parsing. External string arguments are
bounded at 4096 UTF-8 bytes. Success JSON on stdout is bounded at 65536 bytes
(including newline); `inspect` wraps as `{"gate": ...}`. Diagnostics on
stderr are bounded at 4096 UTF-8 bytes with code-point-aware truncation.
Nonzero exit codes on failure. Refused guardian and fail CAS commands use
generic diagnostics and nonzero status without disclosing which authority
predicate failed.

## 15. Blocking Triggers

Two triggers fire on the `runs` table when the singleton gate row exists:

1. **INSERT blocker**: `RAISE(ABORT, 'update in progress')` on any `runs` INSERT.
2. **UPDATE blocker**: `RAISE(ABORT, 'update in progress')` on status transition
   into `running` for existing non-running runs.

Both triggers remain active in `FAILED` state. They enforce that no new
work can be created or started while an update gate exists. These triggers
are the only coupling between protocol state and application tables.

## 16. Implementation and Inspection

- `scripts/update-protocol.mjs`: Single ESM module — all mutating DDL, gate,
  phase, failure, and identity operations. Node built-ins only.
- `scripts/update-coordinator.mjs`: Thin CLI — machine-oriented operations
  with bounded JSON stdout and diagnostics on stderr.
- `docs/upgrade-protocol.md`: This file — the protocol design record.
- `tests/update-protocol.test.ts`: Adversarial focused tests.

`inspect()` is read-only and null-safe, returning an explicit 14-field view
(non-token columns) or `null`. The token is never disclosed through inspect.
`isGateActive()` is a module helper (not a CLI command) returning `true` when
the singleton row exists, including `FAILED` state.

All protocol operations that mutate the database live in a single module —
there is no duplicate TypeScript state machine and no copied DDL elsewhere.
