# O7 — Event-log integrity oracle (post-batch) — STORM-O7 implementation

Status: implemented and exercised through the real rotation-loss gate (this
host, native-dsh run `run-09c9685d-e7e7-4fc7-a6d5-41d6dae8c0ea`, branch
`feature/torture-storm-o7-20260909`). Refinement round 2 (reviewer feedback)
added the leg1 delete-after-terminal overlay exemption and its calibration,
de-duplicated leg4 HUSH counts across physical per-run/global copies, and
added a gate preflight for dist dependency resolution. **Close correction
round (STORM-O7-CLOSE, after `completed933` failed independent root
acceptance)** reworked leg2 around native claim/ATTEMPT epochs (a prior claim
never authorizes a retry completion; dispatch `stepRowId`/`claimId` identity
is validated; the native `step.done` + `step.expects.validated` accepted pair
is one completion; duplicates in one epoch fail), made leg3 per-run copy
correspondence TWO-WAY against each run's global-train slice (with declared
partial-capture coverage), removed all fixture deletion/preclean code, made
the gate lifecycle positively own/close every exact child and journal
receipts LIVE at operation time, and added injected-failure lifecycle
negatives plus an owned-port release check. All five coordinator root
corruptions now FAIL/exit1; the real 3-rotation daemon gate PASSes. See the
published contracts at
`/home/igorhvr/idm/tamandua/torture-test/var/review-logs/matchlock-forward.c8aAbTBI/`
(`storm-o7-contract.json` updated, `storm-o7-close-contract.json` added) for
the exact gate evidence (rotation counts/bytes/hashes, exits, teardown).
**Lifecycle round (STORM-O7-LIFECYCLE, after `completed935`)** corrected the
gate's close semantics: process EXIT is no longer conflated with stdio CLOSE —
`ownedSpawn` retains the positive close observation from spawn time (before any
outcome/readiness logic) and `stopChild` awaits that SAME close promise for
already-exited children, never re-signals an exited process, and reports
never-arriving/unknown close as an explicit bounded cleanup failure (never a
fabricated closed receipt). The main gate after-hook no longer discards
`closeAllOwned` results: cleanup failures are surfaced (retained
`cleanup-report.json` + stderr) while a primary body failure stays the reported
failure, and every owned child/server is registered the instant it is created
(including in the lifecycle/env negatives). Listener release is verified on
EVERY actually-opened owned endpoint record (control/dashboard/MCP observed
occupied while the daemon runs), not just the control port. Child envs are now
constructed from an explicit allowlist (`composeChildEnv`: public toolchain
PATH/LANG/USER + explicit private test-owned values) instead of a
`...process.env` spread with a five-key strip — provider credentials, host
harness homes and live suite/broker/reporting/admin authority never reach test
children, with deterministic leakage/refusal sentinel tests before the gate.
The retention incident from `completed935` (two aborted root-probe dirs removed
under a purported reviewer-sanctioned cleanup) is recorded accurately in the
new `storm-o7-lifecycle-contract.json`; recovery is not established and no
further removal is performed.

## Scope and ownership

- Torture-only code, committed under `torture-test/oracles/` and
  `torture-test/impl-tasks/`. No native product source is edited.
- New files owned by this work item:
  - `torture-test/oracles/O7` — executable (v1 output/exit semantics).
  - `torture-test/oracles/lib/o7.mjs` — evaluation engine + CLI main.
  - `torture-test/oracles/lib/o7-sidecar.mjs` — versioned HOST-OWNED sidecar
    schema + loader (schema_version 1) + pinned native rotation constants.
  - `torture-test/oracles/lib/o7-train.mjs` — read-only event-train parsing
    (byte-exact, line-identity, global-train assembly, subsequence checks).
  - `torture-test/oracles/self-test/o7-fixtures.mjs` — owned calibration
    fixture builder.
  - `torture-test/oracles/self-test/o7.test.mjs` — calibration self-test
    (all obligations, positive AND negative controls).
  - `torture-test/oracles/self-test/o7-gate.test.mjs` — the REAL rotation-loss
    gate (>= 3 real 20 MiB rotations on a private daemon + frozen scripted
    harness; full known-event-train reconstruction).
  - additive one-line registration of `o7.test.mjs` in
    `torture-test/bin/tt-controller.test.sh` (existing registrations
    preserved).
- The nine campaign-gating oracle ids and the version-1 mechanical-evidence
  key set are UNCHANGED (`bin/oracle-context.mjs` untouched). O7 is a
  post-batch oracle, not a tenth campaign gate.

## What O7 checks (spec 03 "O7 — Event-log integrity", pinned to CURRENT source)

O7 consumes a separate, explicitly versioned host-owned sidecar — it does NOT
grow the version-1 `mechanical_evidence.references` key set. Every verdict is
derived mechanically; agent prose is never an input. Output/exit semantics
match the oracle contract exactly: one JSON object on stdout
(`contract_version`, `oracle_id`, `result`, `started_at`, `finished_at`,
`findings`, `evidence`); `PASS`/`FAIL`/`ERROR`/`NOT_EVALUABLE` -> exit
0/1/2/3. Missing required evidence is `ERROR` or `NOT_EVALUABLE` — never
`PASS`. Evidence DB snapshots are opened read-only (`node:sqlite`
`{readOnly:true}`); `getDb()`/`migrate()` are never used.

Five obligations:

1. **leg1 terminal-event binding.** Every scoped terminal run must carry the
   matching real native terminal event. Terminal vocabulary is the CURRENT
   `RUN_LIFECYCLE_EVENTS` terminal records: `run.completed`, `run.failed`,
   `run.canceled`, `run.deleted`, `run.force_failed` — pinned from
   `src/installer/events.ts` (run `run.force_failed` + `run.deleted` are
   terminal; an obsolete three-event guess is a bug). DB status binding
   (`completed`->`run.completed`; `failed`->`run.failed`|`run.force_failed`;
   `canceled`->`run.canceled`; deleted run (row gone) -> `run.deleted` via the
   host deleted-run receipt), chronology (terminal event at/after the DB
   terminal transition, `run.started` before terminal, no duplicate terminal
   without a resume marker), and **snapshot-boundary vs demonstrated-missing**
   distinction: a terminal DB transition at/before `events_captured_at` with
   no terminal event is a demonstrated missing event (finding); a transition
   AFTER the events capture is boundary incompleteness -> `NOT_EVALUABLE`,
   never `PASS`.
   **Delete-after-terminal overlay (expected PASS):** the native
   `deleteWorkflow` flow appends `run.deleted` AFTER an already terminal run —
   its lifecycle terminal record (`run.completed`/`run.failed`/
   `run.canceled`/`run.force_failed`) stays in the append-only per-run stream
   while the DB row is removed. The pair {lifecycle terminal, `run.deleted`}
   is therefore the normal cleanup overlay, NOT a duplicate terminal, and
   passes leg1 when (a) a host deleted-run receipt covers the run
   (receipt/event identity) and (b) the `run.deleted` ts is at/after the
   lifecycle terminal it overlays (chronology). The exemption is reported as
   an informational `O7_DELETION_OVERLAY` note. A receipt-less `run.deleted`
   (DB row present, no host receipt) or a deletion whose ts precedes the
   lifecycle terminal remains a finding (`O7_DUPLICATE_TERMINAL_EVENT` /
   `O7_TERMINAL_CHRONOLOGY`).
2. **leg2 claim/attempt-before-completion.** No step completion event before
   a claim of the SAME attempt epoch, matched per run/step ROW and by STREAM
   ORDER (not timestamps — timestamps alone are insufficient inside one clock
   tick). Claim markers are the native claim-path emitters (`step.running`,
   `dispatch.render.validated` with `dispatched:true`) and DB claim evidence
   (`claim_job_id` / `claim_updated_at` on the step row). Attempt epochs are
   separated by the native reset markers `step.retry` / `step.repended` /
   `step.released` / `step.rerouted` / `step.respawned`: after a reset a
   completion REQUIRES a fresh claim (`O7_COMPLETION_WITHOUT_CLAIM` — a prior
   claim never authorizes a retry completion). Two completion units in one
   epoch fail `O7_DUPLICATE_COMPLETION`. The native `step.complete` flow emits
   `step.done` then `step.expects.validated(outcome=accepted)` from the SAME
   call — that pair is coalesced into ONE completion unit. The ONLY no-claim
   path is the native conditional auto-completion: BOTH the DB side
   (`steps.auto_completed=1`, `auto_complete_reason='condition_unset:*'`,
   `type='conditional'`) AND the event side (`step.auto_completed` preceding
   the `step.done`), with the event reason bound to the row reason
   (`O7_ROW_IDENTITY` on contradiction). A single-side auto-completion marker
   is `O7_AUTOCOMPLETE_SINGLE_SIDE`. Row/job identity is validated:
   `dispatch.render.validated` `stepRowId` must be a step row of the run and
   consistent with its `stepId` (`O7_ROW_IDENTITY`), and the row's FINAL
   claim job id must be matched by the final epoch's identity-carrying claim
   events (`O7_CLAIM_IDENTITY`); native data that cannot prove a claim is
   honest `NOT_EVALUABLE`, never invented from final terminal rows. Positive
   calibration covers retry/new-claim, loop/story, conditional and realistic
   native examples; negatives cover cross-run/row/attempt cases.
3. **leg3 attribution.** Empty-runId events and the hidden `events/.jsonl`
   stream are findings unless they match host-predeclared manual-operation
   ledger entries (event identity/type/order). Malformed / truncated JSONL in
   ANY captured stream, cross-stream attribution mismatches (event runId vs
   stream identity), orphan run streams and byte-identical duplicate lines are
   findings. **Per-run <-> global copy correspondence is verified BOTH ways**
   against each run's slice of the global train: an extra known-run event in
   the global train, a missing member, or a reordered/duplicated member across
   rotation segment boundaries fails `O7_COPY_MISMATCH`. A host-declared
   PARTIAL per-run capture (`sidecar.per_run_capture`, see schema) is
   verified only over its declared prefix and recorded as bounded coverage
   (`O7_PARTIAL_PER_RUN_COVERAGE`) — never silently treated as a full PASS.
4. **leg4 HUSH noise.** `run.nudged` / `agent.nudged` / `agent.nudge.skipped`
   absent under normal debug-off operation (recorded launch intent), with the
   debug control recorded separately. Real emitter filtering is verified with
   fresh private debug-off / debug-on probe streams captured through real
   `emitEvent` calls in their own private state dirs. HUSH counts are LOGICAL:
   the native emitter writes each event to both the global train and the
   per-run copy, so leg4 de-duplicates physical copies by raw line sha256 —
   `hush`/`hush_total` count distinct raw events, never double-counted
   per-run+global copies (a byte-identical repeat within one file is already a
   leg3 `O7_DUPLICATE_LINE` finding).
5. **leg5 rotation bounds + train preservation.** Global stream bounds pinned
   to the native constants `20*1024*1024` bytes and 3 archives: a file may
   exceed the cap only by its last full event; generation file consistency
   (`all.jsonl.generation` integer; archives = 1..min(gen,3)); live-file
   absence immediately after rotation accounted and annotated, never a
   finding; per-run files have NO native rotation (different retention —
   scoped correctly). Reconstruction of the complete known train: for a
   `rotation-gate` capture the expected train is rebuilt from host-journaled
   receipts (recorded LIVE at operation time, each with observed_ts/event_ts)
   + declared volume plan (membership + ORDER + count, `O7_VOLUME_REORDER`)
   — never copied from the final stream under test; missing / duplicate /
   reordered / archive-injected members fail the gate. Receipted lifecycle
   order (launch then claim/complete pairs as observed) must appear as an
   ordered subsequence of each run's captured stream.

## Sidecar schema (schema_version 1)

`sidecar.json` (host-owned, written after capture; members SHA-256-pinned and
byte-exact): `capture` (kind `batch`|`rotation-gate`, producer, captured_at /
events_captured_at / db_captured_at, state_dir_identity, generation_at_capture,
debug_events_env + launch_intent), `product` (source_commit / source_tree /
dist_events_sha256), `scope_runs`, `members[]` (role/path/sha256/size; roles
db-snapshot, global-live, global-archive:N, per-run, empty-run, generation,
receipts, volume-plan, probe-debug-off/on), optional `deleted_runs`,
`manual_ledger`, `synthetic_streams`, and `per_run_capture` — an object keyed
by run id ('' allowed) declaring a BOUNDED/PARTIAL per-run capture as
`{ kind: "partial", declared_prefix_lines: N }`. All member paths are portable
relative paths beneath the sidecar directory; symlinks, escapes, hash/size
mismatches and a writable DB snapshot make O7 report `ERROR` (never followed,
never silently accepted). A fourth archive (`all.jsonl.4`) cannot be
represented in the schema — O7 fails closed on any attempt.

## CLI contract

```
oracles/O7 --sidecar <absolute-sidecar.json> --evidence-dir <absolute-owned-dir>
```

Read-only. Writes exactly one report artifact
`o7-event-integrity.json` (exclusive-create) into `--evidence-dir` and prints
the version-1 response JSON on stdout. Exit codes 0/1/2/3.

## Calibration matrix (o7.test.mjs)

Every row below is a FRESH OWNED calibration copy; original evidence is never
mutated. Green = PASS, red = FAIL unless noted.

- leg1: completed/failed/canceled/force_failed/deleted positives; missing
  terminal (demonstrated), status mismatch, duplicate terminal, boundary ->
  NOT_EVALUABLE; **delete-after-terminal overlay (terminal then run.deleted
  with covering receipt) PASS — reported as O7_DELETION_OVERLAY**;
  receipt-less deletion FAIL; deletion-overlay chronology violation FAIL.
- leg2 (close round): realistic native positive (running + dispatched
  validation with stepRowId/claimId + done + accepted validation);
  **coordinator root negatives all FAIL**: completion after retry without a
  new claim (`O7_COMPLETION_WITHOUT_CLAIM`), foreign dispatch stepRowId
  (`O7_ROW_IDENTITY`), foreign dispatch claimId vs DB job
  (`O7_CLAIM_IDENTITY`), two `step.done` at different timestamps
  (`O7_DUPLICATE_COMPLETION`); claim-less done / claim-after-done /
  claim-less failed / cross-run / cross-row negatives; native auto-complete
  positive; single-side auto-complete (DB-only, event-only) negatives;
  auto reason/row contradiction (`O7_ROW_IDENTITY`); retry corridor with a
  NEW claim + per-attempt dispatches positive; loop/story positive.
- leg3 (close round): empty-runId unledgered red; host ledger-exempt
  (identity/type/order) green; ledger type mismatch red; wrong-stream
  attribution red; orphan stream red; **per-run/global copy mismatch BOTH
  ways red — global-extra known-run event, global duplicate member across
  segment boundaries, reordered member**; declared-partial per-run capture
  prefix-match green (with `O7_PARTIAL_PER_RUN_COVERAGE` note) / prefix
  mismatch red / capture-exceeds-declared-bound red; malformed line red;
  truncated final line red.
- leg4: debug-off noise red; debug-off clean green; debug-on control green
  (logical counts de-duplicated across physical per-run/global copies);
  real-emitter probe pair green; polluted debug-off probe red.
- leg5: rotation structure positive; generation mismatch red; oversize red;
  gate reconstruction positive; injected archive segment red; lost segment
  (missing volume member) red.
- evidence integrity: tampered hash / path escape / symlink substitution /
  writable DB / fourth-archive capture all `ERROR`.
- gate lifecycle negatives (o7-gate.test.mjs, run before the real gate):
  stopChild escalates a SIGTERM-ignoring child to SIGKILL and waits for the
  real close; stopChild propagates a spawn failure (never a fake closed
  receipt); a readiness failure is rejected while the exact child is still
  reaped; port release is verified on the exact owned port records after
  close.

## The real rotation-loss gate (o7-gate.test.mjs)

Run: `node --test torture-test/oracles/self-test/o7-gate.test.mjs`
(ONE torture self-test file at a time; requires `npm run build` first — the
gate preflight asserts the dist tree exists AND that its runtime dependency
`yaml` resolves from `dist/installer`, so a missing `node_modules` fails
immediately with an actionable message instead of a mid-gate
`ERR_MODULE_NOT_FOUND`).
It drives an ACTUAL private daemon + deterministic scheduler with the frozen
scripted harness (`torture-test/scripted-runtimes/bin/scripted-pi`, probe
enabled/answered, `TAMANDUA_PI_BINARY` explicit, fail-closed if missing) over
a tiny SYNTHETIC two-step workflow `o7-gate-wf` (never the real W5 roster).
Four deterministic completed runs (R1..R4) execute through REAL
claim/complete APIs; between runs a declared volume hook (fresh private
process importing the real `dist/installer/events.js`) appends bounded
`o7.gate.volume` trains (unique seq, declared in the volume plan) until the
live global file crosses the native 20 MiB cap — exactly THREE rotations, with
each retained archive containing real lifecycle records and the final live
file carrying the R4 tail.

Close-round gate design (as corrected by the lifecycle round): EVERY child
(daemon, launchers) is owned by exact handle from the moment it is spawned —
cleanup is registered before readiness, teardown waits for the REAL stdio
close event (the spawn-time-retained observation; process EXIT is never read
as close) and escalates SIGKILL on the same exact handle only, and spawn/
readiness failures propagate (never a fake "closed" receipt). The main gate
after-hook runs `closeAllOwned` and SURFACES every cleanup failure (a retained
`cleanup-report.json` under the fixture root plus stderr), preserving a primary
body failure as the reported failure; children/servers in the lifecycle/env
negatives are registered at creation so a failed assertion never strands them.
Listener release is verified on EVERY actually-opened owned endpoint record
(control/dashboard/MCP observed occupied while the daemon runs). Child envs
are built from the explicit `composeChildEnv` allowlist (public toolchain
PATH/LANG/USER + explicit private test-owned values); provider credentials,
host harness homes and live suite/broker/reporting/admin authority never reach
test children (deterministic leakage/refusal sentinels run before the gate).
Receipts are journaled LIVE while each run executes by watching its own
per-run event file (run.started -> launch, step.running -> claim, step.done ->
complete, each with observed_ts + native event_ts); declared transitions
(linear two-step, single attempt per run) are written before the run finishes
and final-state DB rows are recorded separately, labeled. Evidence capture
happens with the daemon stopped (every opened owned listener verified
released): byte-exact event streams (+`.generation`), read-only DB snapshot,
the live receipts journal + declared transitions + volume plan, and the two
HUSH probe streams. The O7 oracle must PASS over the capture; the gate also
independently asserts rotation generations/sizes, per-run/global
correspondence, plan-vs-train volume counts (incl. order), live-receipt
count/order vs the declared transitions, zero tokens, and an empty
guard-violation ledger. All fixture/evidence dirs are RETAINED. No model
credentials/provider call and no native fallback to a real harness anywhere.

## Boundaries and handoff

- O7 is a POST-BATCH oracle. It is intentionally NOT one of the nine campaign
  gates and is not declared in any `cases/*.jsonl` manifest; the oracle
  declared-set allowlist (`tier1-oracle-hygiene.test.ts`) is untouched.
- Batch usage (storm assembly / O12 / aged-state): capture the full
  `events/` directory of the state under audit plus the read-only DB snapshot
  and write a `batch` sidecar. Legs 1-5 structural checks apply; the
  receipts/volume-plan reconstruction is rotation-gate-only. Per-run captures
  must be FULL (a plain file copy of the append-only per-run stream at
  quiescence is full); a host that can only provide a BOUNDED prefix MUST
  declare it in `per_run_capture` — an undeclared partial capture fails leg3,
  never silently PASSes. Batch audits of
  cleanup MUST list every deleted run in `deleted_runs` receipts: a run whose
  terminal record (`run.completed`/`run.failed`/`run.canceled`/
  `run.force_failed`) is followed by `run.deleted` in its per-run stream is
  expected PASS (delete-after-terminal overlay) only with a covering receipt;
  the same stream without a receipt is a duplicate-terminal FAIL.
- Manual operations: a genuinely runless native manual merge (TATR) is
  exempt ONLY through a host-predeclared `manual_ledger` entry with matching
  event identity/type/order. Guests choosing empty runIds, retroactive
  waivers, unknown empty-runId events or a blanket "manual merge might
  happen" exception are findings.
- The oracle reads CURRENT native vocabulary from the pinned product SHA and
  fails closed if the evidence cannot be evaluated; findings are preserved as
  real findings (a checker that exposes a genuine product defect while
  proving detection is an honest result — it can never claim an actual
  product test passed when the gate proves otherwise).
