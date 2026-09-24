# STORM-W5 orchestrator machinery slice (tamandua-6sy.6.2)

Status: **IMPLEMENTED (machinery) / NOT-YET-QUALIFIED (real launch)**.

This slice implements the W5 storm orchestration machinery that the manifest
row `W5.storm-capacity-scaled` pins as its acceptance contract (see
`cases/tasks/tier2/W5.storm-capacity-scaled.md` and spec
`tamandua-torture-test-spec/09-wave-5-storm.md` + `12-runner-automation.md`).
It does NOT claim the real campaign or the real single-daemon scripted
rehearsal — those are explicitly the next acceptance gate and remain
not-yet-qualified in every artifact produced here.

## What is real (committed code, exercised)

- **`bin/tt-storm`** — durable storm-specific orchestration entrypoint with
  explicit `help` / `plan` / `prepare` / `run` / `resume` / `report` /
  `arm <phase>` modes. Integrated with the controller/manifest path: it
  lives beside `tt-controller`, reads the same catalog/manifest vocabulary,
  and follows the controller's run-id evidence conventions. Real launches
  are REFUSED until the campaign carries the qualification marker (the
  rehearsal + coordinator acceptance gate). It OWNS the orchestrator's
  fixture identity (origin/colleague repos, colleague-commit files, seed
  ref, task-file root) and the read-path pounding config, recorded at
  prepare and reused at run/resume.
- **`bin/tt-storm-roster.mjs`** — timer-count derivation from CURRENT actual
  workflow registrations (COUNT(DISTINCT agent_id) per workflow, declared vs
  step-owned cross-checked) with source path + sha256 provenance. Current
  catalog derives fdmw=7 / bfmw=8 / security-audit-mw=8 / quarantine-mw=4 /
  drdv=3 / do-now=1 → **active cap 52**, queued demand S9=7 / S10=1. The
  historical "44" of spec 09 is stale for the current catalog; nothing is
  hardcoded. Round A roster carries per-run task area + run context; the
  Round A cadence arithmetic is exact: S8's slot is 7×90s = 630s, S9 fires
  at 660s and S10 at 690s (S8+30/+60 — "immediately after S8's
  registration"), never 8×90+30=750 (a 120s gap that would weaken the
  pre-completion queue probe).
- **`bin/tt-storm-shared.mjs`** — adapters (fs, clock, proc, db, git), recorder
  (ops.jsonl), run-id evidence extraction from BOTH launch streams, refusal
  helpers, snapshot-based admission decision, REAL read-path pounding
  transport adapters (httpGet via fetch; mcpTool reports the MCP transport
  as first-class not-wired until the rehearsal gate wires the daemon's
  streamable-HTTP client).
- **`bin/tt-storm-engine.mjs`** — Round A (S1..S8 90s stagger, S9/S10 30s
  after S8 registration, daemon admission-response observation, 15s queue
  pump, S10 10-min drain bound, 15s simultaneity sampler with UNKNOWN
  honesty, terminal harvest, children discovery), Round B (B1..B5 launches +
  the 11-phase chaos schedule with phase_wait evidence gating; missed phase
  evidence ⇒ MISSED recorded and never dispatched), resume/reattach (never
  relaunches a recorded launch), cleanup ledger with failure propagation,
  forensic report with first-class red/missing/inconclusive/NOT_RUN states.
  Round A/B launches, phase waits AND observation loops all advance time
  pound-aware: read-path pounding (dashboard HTTP + 2 MCP probes every 30s
  with no-5xx/latency-bound assertions) is a REAL engine cadence through the
  injected transport adapters, and is recorded first-class NOT_RUN when no
  pounding config is owned (never a fabricated fired).
- **`self-tests/tier2-storm-orchestrator-recording-gate.test.ts`** — the ONE
  designated in-run gate: recording-only full-choreography/containment/
  durability conformance with injected fs/process/CLI/clock/API adapters and
  synthetic records; observes the ACTUAL planned argv/API calls. **G1..G18
  (18 cases) passing, twice consecutively** (both raw runs in
  `torture-test/var/review-logs/recording-gate-evidence-run.txt`). Zero real
  chaos/process-control/filesystem-destructive execution; simulated schedule
  timing is clearly labeled.

## Reviewer-driven corrections (2026-09-09 refinement round)

- **Operator argv conformance (I1):** colleague-commit argv is built from
  orchestrator-owned fixture identity and carries the real tt-chaos
  contract's `--repo`/`--file`; dirty-tree carries `--repo <owned repo>`,
  never `''`. A phase whose action needs a repo/file the campaign does not
  own is recorded **NOT_RUN** (first-class) and is never dispatched —
  `buildChaosArgv` refuses before effects (G14).
- **Read-path pounding (I2):** the no-op default branch is gone. Pounding is
  a real cadence (30s) driven through `ctx.proc.httpGet`/`ctx.proc.mcpTool`
  adapters with latency/no-5xx assertions; when no config/transport exists
  pounding and the B-pounding phase are first-class NOT_RUN (G15/G18).
- **B5 relaunch (I3):** `stop_delete_relaunch` performs stop → delete →
  relaunch of an identical do-now (fresh launch, run id captured from both
  streams, observed to terminal) (G1).
- **S9/S10 cadence (I4):** offsets corrected to S8-slot+30/+60 = 660s/690s
  (G1).
- **Simultaneity honesty (I5):** the all-8 window requires every active-roster
  run to be present with a recorded id and claimed; a launch_failed run (no
  id) makes the 8-run window unobservable and the verdict names it (G16).
- **Launch provenance (I6):** S7 quarantine context (`branch=broken-tests`),
  task areas, seed ref and origin/colleague repos are owned by the plan and
  surface in the default launch argv (G1).
- **Fail-closed Round A (I8):** a runless/unknown Round A launch aborts the
  round (documented); resume then re-run continues the remaining planned
  roster, keeps the failed run launch_failed/first-class, never relaunches
  it (G17).
- **Resume UX (I9):** `tt-storm resume` re-attaches and tells the operator
  that `run --round <A|B>` follows to continue the round.

## Interim contention-slice corrections preserved (not duplicated)

`tt-storm-*` imports from `tt-contention-slice-shared.mjs` rather than
re-implementing: run-id normalization (`normalizedRunId` /
`normalizedStoredRunId`), the 15s cadence cap (`sampleDelayMs`), the
terminal/active status vocabularies, and the UNKNOWN/missing-identity
representation. Roster/timer numbers are derived with provenance exactly as
STORM-I established; the interim four-case slice itself is untouched.

## Exactly what remains (never silently skipped)

1. **Real single-daemon scripted rehearsal** (next acceptance gate; P3/P4 of
   spec 12). Recipe (after coordinator approval):
   `tt-storm rehearse --campaign <dir> --round A|B --approval-file
   /root/matchlock-work/storm-real-safety-approval.json` (the approval pins
   the tested boundary/gate hashes; there is no generic --allow-unqualified
   bypass). The real rehearsal also wires the REAL pounding transport
   (contained daemon dashboard URL + MCP streamable-HTTP client) and the REAL
   fixture repos/files (`--origin-repo --colleague-repo --cc1-file --cc2-file
   --park-repo`).
2. **Real campaign** on vaivm after coordinator safety acceptance.
3. **Aged-state seeding at production scale** (5k runs / 500k events / 200
   worktree rows) via REAL createRun/step-ops + legitimate worktree APIs —
   NOT implemented in this slice (a generator plus a real-API execution at
   that scale is a separate coherent change). Its seed-validation gate
   requires it AND O12.
4. **O12 / O5 / O6 / O7 executables** do not exist in the tree (spec-only;
   `tier1-oracle-hygiene` pins the declared set to the nine gating ids).
   Seed validation must report them NOT_RUN until implemented — never
   silently skipped.
5. **Single-flight prelude** (N=4 identical-tree, exactly 1 execution + 3
   waiter replays, dead-owner reclaim) executes only against the contained
   daemon + `tamandua-test` shim in the rehearsal gate; `arm` records
   pending.
6. **Round B real operator dispatch** (tt-chaos / tamandua / daemon-control)
   runs only against a real contained daemon; the recording gate drives the
   same dispatch code with recording adapters.
7. **Task-file content provisioning**: the engine OWNS the per-run task-file
   path/identity (`--task-file-root`/`<run>.task.md`) and records it in the
   launch intent, but does not CREATE task content — task files are
   provisioned from the fixture's `seed/storm` task library in the real
   rehearsal/fixture step. This is recorded, not silently assumed.

Full interface + recipe + evidence detail: the git-ignored contract at
`torture-test/var/review-logs/storm-orchestrator-contract.json` (source SHA,
changed files, supported paths, recipes, remaining gates, raw test
evidence).

---

# STORM-REAL stage (tamandua-6sy.6.6) — real adapters + boundary/approval gates

Status: **REAL-ADAPTERS + BOUNDARY IMPLEMENTED (in-process calibrated) /
REAL REHEARSAL EXECUTION NOT-YET-AUTHORIZED** (pending the coordinator safety
approval at `/root/matchlock-work/storm-real-safety-approval.json`).

## What this stage adds (committed, exercised in-process)

- **`bin/tt-storm-real.mjs` (new standalone real adapters)** — every real
  effect of the orchestrator runs through one admitted immutable PRIVATE exec
  context (`buildPrivateExecContext`): private HOME/STATE/DB/TMP under the
  contained var root, absolute binaries, parent TAMANDUA_RUN_ID/worker/step
  authority stripped, `TAMANDUA_TEST_GUARD=1`, dev/ino ownership evidence.
  No operator fallback. `makeRealProc` rewrites argv[0] to the absolute
  binaries and spawns with the private env. `runOwnedCleanup` +
  `makeCampaignCleanupHandlers` implement the owned-resource inventory with
  positive shutdown evidence (absent/failed/unsettled required cleanup can
  never mean PASS; files/worktrees/state retained). `probePhaseMarkerReal`
  decides every phase marker from mechanical DB evidence. `makeRealMcpTool`
  is the real streamable-HTTP MCP transport seam (first-class not-wired when
  the endpoint is absent). `verifyCoordinatorApproval` refuses any approval
  that does not pin the tested boundary/gate hashes.
- **`bin/tt-storm-shared.mjs`** — REAL_CLOCK sleeps are independent/ref'd
  (no shared-timer replacement, no premature exit); `spawnCapture` is
  byte-preserving and resolves only at real close/reap even after a
  timeout/abort; `REAL_DB`/`parseRunKey` canonicalize run ids at the adapter
  boundary (public `run-<uuid>` <-> stored bare uuid; malformed/step-scope
  keys refused before SQL); REAL_PROC.mcpTool delegates to the real transport.
- **`bin/tt-storm-engine.mjs`** — `probePhaseMarker` default is a REAL
  mechanical DB probe (no more unconditional false); `stormReportFull` awaits
  `ctx.opts.runOwnedCleanup` when supplied (real CLI), keeping the recording
  gate's legacy sync cleanup semantics when absent.
- **`bin/tt-storm` (CLI)** — every real mode builds the private exec context
  and asserts mode containment BEFORE state writes; `run` has NO
  `--allow-unqualified` reason-string bypass; real launch requires the
  coordinator approval via `approve` or the `rehearse` entrypoint (which also
  pins the tested boundary/gate file hashes — changed gate code => fresh
  coordinator review, never automatic approval reuse).
- **`self-tests/tier2-storm-real-calibration.test.ts`** — ONE in-process
  calibration FILE (no daemon/harness spawn, no filesystem disposal, no real
  chaos): REAL sqlite canonicalization, exec-context containment negatives,
  real-proc env binding, clock overlap, spawnCapture byte/reap semantics,
  mcpTool refusal, DB-evidence phase predicates, cleanup inventory semantics.
  9/9 passing (twice consecutively; recording gate G1..G18 remains 18/18).

## What remains (never silently skipped)

The real single-daemon SCRIPTED_REHEARSAL (fresh owned origin/clones/state,
one contained daemon, Round A/B with the real transports/operators, N=4
single-flight prelude, S7 quarantine, admission/freeSlots evidence via real
native interfaces, exact cleanup evidence) executes ONLY after the
coordinator writes `/root/matchlock-work/storm-real-safety-approval.json`
matching the tested boundary/gate hashes in
`/root/matchlock-work/storm-real-safety-contract.json`. Until then this stage
reports PENDING_ROOT_SAFETY and never claims the rehearsal obligation
accomplished.
