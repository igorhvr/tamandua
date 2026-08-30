# Tier-1 Case Traceability Report

**Generated:** 2026-08-07
**Manifest:** `cases/tier1.jsonl`
**Spec:** `torture-test/tamandua-torture-test-spec/`
**Scope:** Waves 1–3 (waves 4–5 are Tier-2 only; wave 0 is pre-campaign)

## Manifest Summary

| Metric | Value |
|--------|-------|
| Total Tier-1 cases | **28** |
| Wave 1 (language smoke) | 10 |
| Wave 2 (workflow coverage) | 6 |
| Wave 3 (harness duel + lifecycle) | 12 |
| Spec-estimated Tier-1 budget | ~40 (README §Execution Tiers) |
| Delta from spec budget | -12 |

### Why 28, not 40?

The spec's ~40 estimate for Tier-1 was approximate and covered the full
three-wave Tier-1 roster including scenarios that, upon detailed review,
were either deliberately limited by the spec's T1 annotations or belong
to waves 4–5 (entirely Tier-2, out of scope for this traceability).

The 28 authored cases cover every scenario the spec explicitly marks
`T1` in waves 1–3. No T1-marked scenario is missing from the manifest.
The remaining ~12–15 budget slots are consumed by wave-4 T1-marked
scenarios (W4.01, W4.02, W4.04–W4.07, W4.09–W4.10, W4.14, W4.16,
W4.25, W4.27–W4.31, W4.35–W4.37, W4.49 — see
`08-wave-4-fault-injection.md`), which are authored separately and not
included in this traceability's scope.

Key factors:
- Wave 1: spec estimates "≈8" Tier-1 cases for the language matrix at
  2 languages (python, ts). We author 10 (adding TSTX cross-run replay
  relaunches at 2 languages, called out as `T1` in the cross-cutting
  checks section of 05).
- Wave 2: only the T1-marked edge/authoring scenarios (6 cases). The
  20-workflow matrix (W2.01–W2.20) is Tier-2 only — those workflows
  require all 5 toolchains and spend ~10M tokens on their own. The
  remaining 5 authoring scenarios (W2.25–W2.29) are not T1-marked.
- Wave 3: the T1 matrix cells (4), marathon (2), and lifecycle probes
  (6) = 12. The remaining matrix cells for java, rust, go, and the
  fdmw-pi-python cell (W3.12) are not T1-marked per spec.

## Case ↔ Spec Reference Map

### Wave 1 — Language Smoke (`05-wave-1-language-smoke.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W1.L1-python | `#W1.L1` | tt-python | pi | do-now | real |
| W1.L1-ts | `#W1.L1` | tt-ts | pi | do-now | real |
| W1.L2-python | `#W1.L2` | tt-python | pi | tt-shim-probe | real |
| W1.L2-ts | `#W1.L2` | tt-ts | pi | tt-shim-probe | real |
| W1.L3-python | `#W1.L3` | tt-python | pi | bug-fix | real |
| W1.L3-ts | `#W1.L3` | tt-ts | pi | bug-fix | real |
| W1.X1-ts | `#W1.X1` | tt-ts café (hostile-path alias) | pi | do-now | real |
| W1.M1-python | `#W1.M1` | tt-python | hermes | do-now | real |
| W1.REPLAY-python | `#W1.REPLAY` | tt-python | pi | tt-shim-probe | real |
| W1.REPLAY-ts | `#W1.REPLAY` | tt-ts | pi | tt-shim-probe | real |

**Wave 1 count:** 10 (spec-estimated ~8; TSTX replay added 2 beyond the
per-language matrix).

### Wave 1 — Replay Pairing (`context.replay_of`, S9 authoring)

The two Wave-1 REPLAY cases are **replay-pair bound** to their paired
probe cases via `context.replay_of`, implementing the spec's cross-cutting
`TSTX cross-run replay` check (`05-wave-1-language-smoke.md`): relaunch
W1.L2 with an **unchanged tree**; the suite must *replay*
(`TAMANDUA-TEST CACHED`, ledger row reuse) rather than re-execute.

| Replay case | `context.replay_of` | Pair |
|-------------|---------------------|------|
| W1.REPLAY-python | `W1.L2-python` | W1.L2-python |
| W1.REPLAY-ts | `W1.L2-ts` | W1.L2-ts |

**The `replay_of` contract** (authoritative for every replay case ever
added to a tier manifest):

1. **Same clone, same tree:** a replay case MUST reuse its pair's work
   clone — same `origin_repo`, same committed tree (`HEAD^{tree}`
   byte-identical). No wipe/re-clone/provision of its own; the pair's
   tree persists unchanged into the replay attempt (TSTX's
   origin-scoped contract: ledger rows are keyed per `origin_repo`,
   and a fresh clone or re-provision would normalize to a different
   origin identity and test nothing — see `08-wave-4-fault-injection.md`
   W4.28's construction note and its 'zero cross-repo replay' gate).
2. **Sequenced after the pair:** a replay case MUST NOT launch before
   its pair reaches terminal (the pair's post-harvest state — clone,
   ledger — is the replay's input).
3. **Cache-HIT assertion:** the replay outcome MUST assert a shim cache
   HIT — the shim observation must show `lookup->cache_hit` (a
   `TAMANDUA-TEST CACHED` replay bound to the pair's origin/tree/cmd
   key), never a silent re-execute (`execute`/`record`). A missing
   observation or a miss is a named finding (`replay-cache-miss`),
   never a PASS.

`replay_of` is **controller-internal wiring**: it must be excluded
from the product `--context` passthrough (like `execution_mode`) and
never be seen by the workflow — the exclusion is enforced by the S9
controller story (US-005). Only the two REPLAY lines carry it today;
it is optional and documented in `case.schema.json`
(`context.replay_of`).

**Controller enforcement (S9, US-005):** the controller implements the
contract mechanically.

- **Same clone, no re-provision:** a replay attempt skips its own
  fixture work-clone provisioning entirely (no wipe/re-clone) and
  launches with `--working-directory-for-harness` bound to the pair's
  clone (`var/fixtures/work/<pair-id>/<fixture>`); the resolved
  provenance (pair id, clone path, pair terminal status) is recorded on
  the attempt (`replay_provenance`).
- **Clone persistence:** a case named as another case's `replay_of`
  keeps its clone at terminalization even on PASS (teardown outcome
  `REPLAY_PAIR_KEEP`, keep_reason `replay-pair-clone-shared`); a replay
  case's own teardown never touches the pair's clone.
- **Sequencing:** a replay whose pair is not terminal waits
  (bounded by the pair's own wall deadline + settle margin; test seam
  `TT_CONTROLLER_REPLAY_PAIR_WAIT_MS`) and, if the pair still has not
  reached terminal, fails closed with the distinct
  `replay-pair-not-terminal` category — never a silent half-launch.
  A missing pair (`replay-pair-missing`), a fixture mismatch
  (`replay-pair-fixture-mismatch`), or a terminal pair whose shared
  clone is gone (`replay-pair-clone-missing`) also fail closed with
  their own distinct categories.
- `replay_of` never appears in the launch argv (`--context` exclusion,
  like `execution_mode`).

**Controller enforcement (S9, US-006):** after terminal harvest (fresh or
resumed), the controller reads the attempt's oracle-evidence snapshot and
mechanically asserts the cache HIT:

- **Hit:** a suite observation for the attempt's own run with a
  cache-hit/replay phase bound to the pair's origin/tree/cmd key (the
  launch-intent gate key captured over the pair's clone + the pair's
  committed `HEAD^{tree}`). The assertion evidence is recorded on the
  attempt (`replay_cache_assertion`) and the verdict is unchanged.
- **Miss:** no such observation (or `execute`/`record` instead) is never a
  silent PASS — the case carries the named `REPLAY_CACHE_MISS` finding with
  the observed phases, and a would-be PASS is classified INCONCLUSIVE with
  reason category `replay-cache-miss`.
- **Fail closed:** a malformed, incomplete, or missing snapshot is
  TEST_INFRA (`replay-snapshot-missing` / `replay-snapshot-incomplete` /
  `replay-snapshot-unreadable`), never PASS.
- A replay attempt's snapshot binds to the PAIR's clone
  (`attempt.fixture_work_clone`) so the gate key is the pair's origin
  identity; the replay's own clone path is never provisioned.
- Test seam: `TT_CONTROLLER_REPLAY_SNAPSHOT_FIXTURE_DIR` (requires
  `TT_CONTROLLER_SELF_TEST=1`) redirects the gate's snapshot read to a
  caller-seeded tree beneath `torture-test/var` for hit/miss/malformed
  fixture tests.

## Case-Authoring Conventions (`context.test_cmd`, S10)

`context.test_cmd` is the EXACT test-suite command for a case. It is
rendered verbatim into the `tt-shim-probe` step input (`TEST_CMD:
{{test_cmd}}`) and wrapped EXACTLY once by the scheduler's TSTX shim
(`tamandua-test`). The conventions below are authoritative for every
case that carries a `test_cmd`:

- **Python fixtures (`tt-python`, `tt-python@master`):** `test_cmd` MUST
  use the explicit `.venv/bin/pytest -q` form. The fixture's committed
  `bootstrap` script creates `.venv` at provisioning (prebootstrapped
  arming), so the explicit path always resolves. NEVER a bare `pytest -q`
  (the shim's spawn env does NOT put `.venv/bin` on PATH — no PATH magic)
  and never `python3 -m pytest` or any other variant. This is the SAME
  convention the tt-poly fixtures already document as their TEST_CMD, and
  it matches E3.A's S1 choice for all python-fixture lines
  (W1.L1/L2/L3/M1-python).
- **TypeScript fixtures (`tt-ts`):** `npm test` (the fixture's package.json
  test script).
- **tt-poly-lite:** `./run-all-tests`.
- **REPLAY lines:** `test_cmd` MUST match the paired probe case's
  `test_cmd` verbatim. The TSTX cache key is
  (origin_repo, tree_hash, cmd_hash); a diverging command makes the
  cross-run cache HIT unreachable. For the python pair that means
  W1.REPLAY-python carries `.venv/bin/pytest -q` exactly like
  W1.L2-python; for the ts pair both lines carry `npm test`.

The convention is mechanically enforced for the E3.D-owned python lines
by `self-tests/tier1-python-shim-convention.test.ts`, and the shim's
ledger-recording path for a direct `.venv/bin/pytest -q` invocation over
a provisioned tt-python clone is proven zero-token by
`self-tests/tier1-python-shim-ledger-proof.test.ts`.

### Wave 2 — Workflow Coverage Edge Cases (`06-wave-2-workflow-coverage.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W2.21-admission | `#W2.21` | none | local | do-now | scripted |
| W2.22-non-main-bfmw | `#W2.22` | tt-python@master | pi | bug-fix-merge-worktree | real |
| W2.23a-expects-regex | `#W2.23a` | none | local | local | scripted |
| W2.23b-retry-step | `#W2.23b` | none | local | local | scripted |
| W2.23c-missing-persona | `#W2.23c` | none | local | local | scripted |
| W2.24-docs-drift | `#W2.24` | tt-ts | pi | local | real |

**W2.21 / W2.23a / W2.23b / W2.23c — HOST-ADAPTATION note (MACP4 US-006):**
the four scripted W2 rows' `requires` predicate was NARROWED from a blanket
`{"platform":"linux","capabilities":["node-sqlite"],"node_min":22}` to
`{"capabilities":["node-sqlite","daemon-scripted"],"node_min":22}` (the
`platform` key dropped). Rationale: the cells' actual dependency is the
scripted-daemon launch corridor, which daemon-control provides on BOTH
platforms — the systemd-user-scope path on linux and the non-systemd
plain-background fallback (nohup) launch path where systemd is unavailable
(macOS). W0.0 computes the `daemon-scripted` Boolean-leaf capability on both
linux and darwin (true iff bash AND nohup AND node resolve via POSIX
`command -v` PATH lookup), and the harness (run-scripted-scenario + the W2
run.mjs cells) is Darwin-portable since MACP4 US-003/US-004. A fully-capable
Darwin host therefore satisfies the narrowed predicate and the four cells
EXECUTE instead of being vacuously gated `NOT_RUN (predicate)` by
`platform: linux`. NO assertion was weakened: the cells still require
node-sqlite + node ≥ 22, the O1/O3z/O11 oracles are unchanged, and on linux
behavior is identical (the cells still run via systemd or the forced
fallback).

**W2.24 local sentinel — launch adapter contract (S11 / US-008):**
W2.24's `workflow: local` is a SENTINEL, not a real workflow id — there is no
`local` workflow in any catalog. The controller's local-sentinel launch
adapter resolves it: the supported shape (workflow `local` + harness `pi`)
resolves to the shipped TT-custom spec `tt-docs-drift`
(`torture-test/workflows/tt-docs-drift/`, the docs/creating-workflows.md
Complete Example extracted verbatim — see the docs-drift fidelity contract in
`self-tests/tier1-tt-docs-drift-spec.test.ts`). The adapter ensures the spec
is installed in the contained TT home (tt-catalog-install /
tt-required-workflows seam; a missing spec fails closed with the distinct
`catalog-missing: tt-docs-drift` reason) and then launches
`workflow run tt-docs-drift --pi-as-harness ...`. Any OTHER sentinel profile
(workflow `local` + a harness other than pi) fails closed with the distinct
`local-sentinel-unsupported` reason. The literal argv `workflow run local` is
never constructed or executed; adapter evidence (sentinel profile, resolved
workflow id, install outcome) is recorded on the attempt as
`attempt.sentinel_adapter`.

**Wave 2 count:** 6 (all T1-marked scenarios in the edge/authoring table;
the 20-workflow matrix W2.01–W2.20 is entirely Tier-2).

### Wave 3 — Harness Duel + Lifecycle Probes (`07-wave-3-harness-duel.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W3.01-bfmw-pi-python | `#W3.01` | tt-python | pi | bug-fix-merge-worktree | real |
| W3.02-bfmw-pi-ts | `#W3.02` | tt-ts | pi | bug-fix-merge-worktree | real |
| W3.03-bfmw-hermes-ts | `#W3.07` | tt-ts | hermes | bug-fix-merge-worktree | real |
| W3.04-fdmw-pi-ts | `#W3.13` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.17a-marathon-natural | `#W3.17a` | tt-poly-lite | hermes | feature-dev-merge-worktree | real |
| W3.17b-marathon-chaos | `#W3.17b` | tt-poly-lite | hermes | feature-dev-merge-worktree | real |
| W3.18-pause-no-drain | `#W3.18` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.19-pause-drain | `#W3.19` | tt-ts | hermes | feature-dev-merge-worktree | real |
| W3.20-cancel | `#W3.20` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.21-fail-force-resume | `#W3.21` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.22-daemon-restart | `#W3.22` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.23-token-saver | `#W3.23` | tt-ts | pi | do-now | real |

**Wave 3 count:** 12 (4 T1 matrix cells + 2 marathon + 6 lifecycle probes).

**Note on naming:** manifest case IDs for wave 3 matrix cells do not
match spec numbering one-to-one. The spec's matrix cells are W3.01–05
(bfmw × pi × 5 langs), W3.06–07 (bfmw × hermes × 2 langs), W3.11–13
(fdmw × pi × 3 langs). Manifest uses compressed numbering (W3.01–W3.04).
The `spec_ref` field is the authoritative cross-reference.

### Wave 3 — Lifecycle Probe Sequences (`probe_sequence`, E3.C)

Campaign #7 (S3/S4) found the five lifecycle cases never ran their probes:
`tt-controller` only did launch→wait→(cap-stop)→snapshot and oracles O16/O4
were declared-but-missing. E3.C adds manifest-declared `probe_sequence`
blocks (schema'd in `case.schema.json`, `$defs/probeGroup`/`probeAction`)
that the controller executes against the CONTAINED TT instance while the
case's run(s) are in flight. Every action records timestamps, exact argv,
CLI exit code, and observed effect into attempt evidence
(`attempt.probe_evidence` + the `probe_evidence` snapshot artifact), judged
by the O16 lifecycle oracle. The five lifecycle cases (W3.18–W3.22) each
carry a sequence implementing spec 07-wave-3-harness-duel.md §C:

| Case | Runs | Probe sequence (per run group, in order) | Spec-07 §C assertions |
|------|------|------------------------------------------|------------------------|
| W3.18-pause-no-drain | 1 | run 1: `pause` @ `step:developer:running` (hold 600s, expect `no_rounds_during_hold`), `resume` @ `now` (expect `run_completes`) | Pause (no drain) mid-implement; resume after 10min; run must complete; no dispatch rounds during the hold |
| W3.19-pause-drain | 1 | run 1: `pause_drain` @ `step:developer:running` (expect `drain_waits_current`, `next_story_parked`), `resume` awaits `paused` status (object trigger `{"status":"paused","timeout_s":120}`; expect `run_completes`) | Drain lets the in-flight story's step complete, then parks WITHOUT dispatching the next story (no `draining_pause` wedge); resume dispatches the next story |
| W3.20-cancel | 2 | run 1: `cancel` @ `step:developer:running` (expect `canceled_terminal_event`); run 2: `cancel` @ `step:finalize_merge:running` (expect `canceled_terminal_event`) | Cancel mid-implement AND cancel during finalize_merge (second run); `run.canceled` terminal event lands (DC35) |
| W3.21-fail-force-resume | 1 | run 1: `fail_force` @ `step:developer:running`, `resume` awaits `run.process_cleanup` (object trigger `{"event":"run.process_cleanup","timeout_s":120}`; expect `same_run_id_resumes`, `run_completes`) | `workflow fail --force` on a live run, then resume; resume reuses the SAME run id and run number (the `resumeWorkflow`-reuses-run-id trap) and completes |
| W3.22-daemon-restart | 3 | runs 1–3 (concurrent): `restart_daemon` @ `step:developer:running` (expect `recovery_within_dispatch_intervals: 2`, `token_flush_preserved`, `run_completes`) | Daemon restart under load with 3 runs mid-flight; all 3 recover within 2 dispatch intervals; token flush survives (DC8); no wedge, no double dispatch |

**Run ordinals declare launch shape.** A group's `run` ordinal indexes the
case's runs in launch order, so W3.20's two sequential runs are groups
`run: 1` and `run: 2`, and W3.22's three concurrent runs are groups
`run: 1..3` (the controller launches one run per declared ordinal). For
W3.22, `restart_daemon` is declared on every run group: the controller
executes the daemon restart ONCE mid-flight via `bin/daemon-control`
(containment-guarded — never bare `tamandua restart`), and each group's
`expect` is the per-run recovery contract O16 judges (that run recovered
within 2 dispatch intervals, token flush preserved, run completes).

**O16 oracle coverage.** W3.18, W3.19, W3.21 already declared O16. W3.20
and W3.22 now declare O16 too (their `canceled_terminal_event` and
restart-recovery expectations are O16 judgment dimensions) — so all five
lifecycle cases are O16-gated once the oracle executable lands (E3.C
US-009).

**Wall caps (E3.D).** Each lifecycle case's `caps.wall_min` is VERIFIED
against the `cases/caps-calibration.md` table — a cap below its probe
sequence duration (hold + run time + margin) would cancel honest runs and
destroy the evidence the case exists to collect (S8). Current values
match the table exactly: W3.18=148, W3.19=180, W3.20=138, W3.21=138,
W3.22=138 (fdmw p50 138min floor + the mandated 10-min pause hold for
W3.18; the W3.17 marathon ceiling 180 for the multi-story hermes lifecycle
W3.19).

**W3.17b chaos block (unchanged).** W3.17b-marathon-chaos keeps its typed
`chaos` block — `{"type":"sigstop_sigcont","target":"harness_process","trigger":"mid_round","hold_seconds":600,"operator":"tt-chaos"}` —
the E3.C controller honors it via `bin/tt-chaos` (US-008, see the Chaos
wiring section below) so the chaos marathon genuinely differs from the
natural one (W3.17b vs W3.17a).

**Probe execution engine (E3.C US-006).** `bin/tt-controller`'s real-case arm
starts a probe task alongside the launch as soon as the run id resolves
(parallel to `monitorWorkflowRun`). For a SINGLE-run `probe_sequence` (run
group 1 — the W3.18/W3.19/W3.21 shapes), each action in order: arms on its
`when` phase marker (polling the CONTAINED steps table / event streams on a
500ms cadence like tt-chaos's phase-wait; `now` fires immediately), executes
the exact CLI verb under the case's spawn env (`pause`/`pause_drain`/
`resume`/`cancel`/`fail_force` → `tamandua workflow …`), honors
`hold_seconds` between the action and the effect observation, and records a
per-action evidence record: op, trigger, `armed_at`/`action_started_at`/
`action_ended_at` UTC timestamps, the exact argv, the CLI exit code, and the
observed effect (contained status query + bounded event-stream excerpt for
the run since the action started). The full sequence persists as
`attempt.probe_evidence` (rewritten after EVERY action so interruption never
loses it) AND as the `probe-evidence.json` artifact in
`<campaign>/evidence/<case>/<attempt>/`, which the oracle-evidence-snapshot
copies under the `probe_evidence` key for O16.

Fail-closed contract (never silently swallowed, campaign #7 S3/S4):
- A probe CLI failure (spawn error / non-zero exit) classifies the attempt
  TEST_INFRA_FAIL with the DISTINCT category `probe-action-failed` naming the
  op + exit code, and the sequence stops at the failed action.
- A trigger that never fires before the run reaches terminal/deadline
  classifies TEST_INFRA_FAIL `probe-trigger-unreached` (naming op + marker +
  observed terminal status).
- Ops the single-run sequencer cannot execute (`restart_daemon` — daemon
  lifecycle, `sigstop_sigcont` — the chaos-block verb) fail closed as
  `probe-action-failed` rather than degrade.
- Multi-run shapes (W3.20 two runs, W3.22 three concurrent runs + contained
  daemon restart) are orchestrated by US-007 (see the next section); the
  single-run sequencer keeps a defensive `attempt.probe_sequence_deferred`
  backstop that the campaign path can no longer reach.
Every action runs under the case's contained spawn env
(`loadSpawnEnvironment` childEnv, `assertContainedSpawnEnv` choke-point) —
the operator's live daemon and `~/.tamandua` are never touched. Pinned by
the stub-`tamandua` fixtures in `bin/tt-controller.test.sh` (in-order
pause/resume argv, evidence on attempt + artifact, trigger-unreached and
probe-action-failed classification).

**Multi-launch probe orchestration (E3.C US-007).** A `probe_sequence` with
two or more run groups DECLARES a multi-launch shape: `executeWorkflowCase`
routes it to `executeMultiRunProbeCase` (the single-launch path handles
exactly one run), and the orchestrator genuinely executes the sequence —
campaign #7's zero-coverage defect is closed for the multi-run cases too:

- **W3.20 shape (sequential):** two launches executed one after another.
  Run 1 launches and its actions fire against the CONTAINED instance (cancel
  mid-implement, asserting the `run.canceled` terminal event lands via the
  bounded event-stream excerpt), the run is harvested, THEN run 2 launches
  and its actions fire (cancel during `finalize_merge`). Each launch reuses
  the launch / run-id-capture / monitor / discovered-run-convergence /
  terminal-harvest mechanics; per-run probe evidence is grouped by run
  ordinal in `attempt.probe_evidence.runs[]`.
- **W3.22 shape (concurrent):** three launches start concurrently (staggered
  per `state.options.stagger_ms`), each monitored through its own proxy
  attempt (the monitors tolerate transient status-read failures — a poll
  landing in the contained daemon's down window must not kill the monitor).
  Once the runs are in flight, `restart_daemon` executes ONCE mid-flight via
  `bin/daemon-control <real|scripted> restart` (kind real for the 43xx CLI /
  scripted for 53xx) — NEVER a bare `tamandua restart` (daemon-control
  applies its own production + containment guards). Each run's recovery is
  observed within `expect.recovery_within_dispatch_intervals` dispatch
  intervals (15s each), recording `recovered_at`, `recovery_waited_ms`,
  `recovery_within_dispatch_intervals`, and the token flush (tokens observed
  before vs after the restart — the DC8 evidence O16 judges). The restart
  record aggregates the per-run recoveries in `evidence.daemon_restarts[]`
  and each run's restart action record carries its own recovery in `effect`.

**Multi-run evidence contract.** `attempt.probe_evidence` for a multi-run
sequence is `{ schema_version, case_id, execution_mode, launch_shape
('sequential' | 'concurrent'), sequence_outcome, started_at, ended_at,
runs: [{ run_ordinal, run_id, run_id_source, launch_hook, actions[],
terminal_status, wait_exit_code, recovery }], daemon_restarts[], failure }`
— rewritten after EVERY probe action / milestone (interruption-safe) and
mirrored to the `probe-evidence.json` artifact so O16 can judge per-run
assertions (canceled terminal event per run, restart recovery per run).
`attempt.multi_run_probe` records `{ launch_shape, run_count, status,
started_at }` and the shared attempt binds to the primary (run 1) id after
the sequence.

**Multi-run fail-closed contract** (never silently swallowed):
- A probe CLI failure (any run's action) classifies TEST_INFRA_FAIL
  `probe-action-failed` naming the op + exit code; a `restart_daemon`
  daemon-control failure is the same category naming `daemon-control`'s
  exit code.
- A restart trigger that never fires before run 1 reaches terminal/deadline
  classifies `probe-trigger-unreached` (op `restart_daemon` + marker).
- A launch that fails to resolve its run id (any run) classifies
  `workflow-run-identification` (or the DEFINITE infra category); a run that
  does not reach a terminal status classifies `multi-run-nonterminal`; a
  terminal-harvest failure classifies `multi-run-harvest-failed`.
- Cap enforcement mid-sequence classifies INCONCLUSIVE `runaway-cap-enforced`
  (like the single-run path).
- A multi-launch attempt interrupted mid-sequence cannot be reattached:
  resume fails closed with the distinct `multi-run-probe-recovery-unsupported`
  reason (rerun the case) — mirroring the token-saver paired-launch guard.
- The semantic validator (US-005) enforces the launch-shape contract at
  validation time: `restart_daemon` requires >= 2 run groups AND every run
  group must declare it (each group's action carries that run's recovery
  contract) — `--validate-only` rejects a violation with a distinct reason.
- Pinned by the stub-`tamandua` fixtures in `bin/tt-controller.test.sh`
  (multi-run-seq: two sequential cancels with per-run `run.canceled` event
  excerpts + in-order argv; multi-run-conc: three concurrent launches +
  stub daemon-control recording exactly one `[real restart]` invocation,
  never a bare restart).

**Chaos wiring (E3.C US-008).** The controller honors a case's manifest
`chaos` block by invoking `bin/tt-chaos` under the case's contained spawn
env while the run is in flight — closing campaign #7's S3/S4 gap where
`tt-chaos` was never invoked and the W3.17b marathon did not differ from
W3.17a:

- **Trigger translation:** the block's `trigger` is a high-level phase name
  translated to the phase-marker grammar tt-chaos arms on
  (`now | step:<role>:<state> | event:<type> | file:<path>`): `mid_round`
  → `step:developer:running` (a dispatch round is in flight when the
  developer role's step is running). A marker-shaped trigger passes through;
  an untranslatable trigger fails closed at validation.
- **Invocation:** per-type action contract — `tt-chaos sigstop_sigcont --run
  <run-id> --when <translated marker> --hold-seconds <hold_seconds>` for the
  W3.17b shape, and (Tier-2 US-003) `tt-chaos kill-harness|kill-daemon --run
  <run-id> --when <translated marker> [--signal <SIG>]` for the kill actions
  (default SIGKILL) and `tt-chaos delete-tstx-row --run <run-id> --when
  <translated marker> --tree <hash>` for the TSTX-row deletion — spawned with
  the case's childEnv (`assertContainedSpawnEnv`
  choke-point; `TT_CONTROLLER_TT_CHAOS_PATH` overrides the binary for
  hermetic tests, mirroring `TT_CONTROLLER_DAEMON_CONTROL_PATH`). The runner
  starts alongside the monitor/probe as soon as the run id resolves and is
  awaited after the launch; the invocation is bounded by the case's remaining
  wall budget (a wedged operator cannot hang the controller past the deadline).
- **Evidence:** `attempt.chaos_evidence` carries the full start/stop record —
  schema_version, run_id, operator, injection_type, target, trigger,
  trigger_marker, hold_seconds, declared_signal (kill actions), tree
  (delete-tstx-row), `started_at`/`ended_at` UTC timestamps, the
  exact argv, exit code, signal, error, and `status`/`failure`. The operator's
  `var/chaos/chaos.log` is copied into the immutable oracle snapshot under the
  `chaos_log` evidence key (US-003) — O4's REQUIRED_ORACLE_EVIDENCE — so O4
  can distinguish a watchdog-killed worker from a chaos-killed one.
- **Fail-closed contract** (never silently swallowed):
  - A chaos invocation failure (non-zero exit / spawn error / timeout)
    classifies TEST_INFRA_FAIL with the DISTINCT category
    `chaos-invocation-failed` naming the operator + exit code.
  - A semantically-invalid chaos block (untranslatable trigger, local-case
    chaos, chaos combined with a multi-run probe_sequence — the injection has
    no run ordinal) is persisted TEST_INFRA_FAIL `chaos-block-invalid` by the
    execute-path `chaosGuard` BEFORE any launch, and `--validate-only` reports
    it as a case-id-named reason.
  - A `chaos: null` case (W3.17a) NEVER spawns tt-chaos — zero spawns pinned
    by a trap stub in `bin/tt-controller.test.sh`.
- Pinned by the stub-`tt-chaos` fixtures in `bin/tt-controller.test.sh`
  (manifest-derived argv + start/stop evidence, chaos.log captured into the
  oracle snapshot under `chaos_log` with an O4 self-test-oracle PASS proving
  the gating context validation, `chaos-invocation-failed` classification on
  a stub exit 3, zero spawns for `chaos: null`, and the
  `chaos-block-invalid` guard before launch).

**O16 lifecycle probe-evidence oracle (E3.C US-009).** `oracles/O16` is the
executable lifecycle oracle that judges the sequencer's `probe_evidence`
against `run_events` + `database_snapshot` (required evidence per US-003),
so W3.18-W3.22 (and any W3.0x cell declaring O16) get a mechanical lifecycle
verdict instead of `ORACLE_MISSING`:

- **Pause held (W3.18):** a `pause` action must carry a hold window; no
  dispatch event (`dispatch.render.validated` / `step.running` /
  `step.started`) may fire for the run inside `[hold_started_at,
  hold_ended_at]` — `O16_ROUND_DURING_HOLD` otherwise.
- **Pause --drain (W3.19):** between the drain's `action_ended_at` and the
  next action's start, the in-flight story step may complete (`step.done`
  allowed) but no dispatch event may fire (next story parked) —
  `O16_DRAIN_DISPATCHED_NEXT_STORY` otherwise; the no-wedge guarantee is the
  resume/completion check (`O16_RESUME_RUN_NOT_COMPLETED` when the run row is
  not `completed` after resume).
- **Cancel (W3.20):** every `cancel` action must land a `run.canceled`
  terminal event with `ts >= action_started_at` (CNEV) —
  `O16_CANCEL_TERMINAL_EVENT_MISSING` otherwise.
- **Fail --force resume (W3.21):** after `fail_force` → `resume`, the terminal
  database must show the SAME run row `completed`; a completed run under a
  DIFFERENT id is the resumeWorkflow-reuses-run-id trap —
  `O16_RESUME_NEW_RUN_ID`.
- **Restart recovery (W3.22):** every `restart_daemon` recovery observation
  must report `recovered`, `recovery_within_dispatch_intervals`, and
  `token_flush_preserved` all true (DC8) — `O16_RESTART_RECOVERY_EXCEEDED` /
  `O16_RESTART_RECOVERY_MISSING` otherwise.
- A probe sequence with no lifecycle op is `NOT_EVALUABLE` (nothing to judge);
  malformed probe evidence is an oracle `ERROR` (fail-closed). The
  interpretation is documented in `oracles/CONTRACT.md` (incl. the note that
  spec 03's separate 'held-out acceptance probes' O16 definition is out of
  scope for E3.C). Mutation fixtures live in
  `oracles/self-test/generate-o16-fixtures.mjs` + `o16.test.mjs` (clean
  evidence PASSes; each violation FAILs with its finding id), exercised by
  `oracles/self-test/run.sh` and `bin/tt-controller.test.sh`.

**O4 claim & dispatch hygiene oracle (E3.C US-010).** `oracles/O4` is the
executable sweep-hygiene oracle implementing spec 03's O4 — the W3.0x
manifests that declare O4 (all T1 matrix cells, both marathons, and the five
lifecycle cases) stop producing `ORACLE_MISSING` and the sweep-level hygiene
assertions become mechanical. Its three required evidence legs are
`database_snapshot` (steps/stories/story_abandonments/runs), `run_events`
(corroboration), and `chaos_log` (the bundle of tt-chaos structured entries +
the process recorder's 5s samples — the snapshot appends `var/recorder/
samples-*.jsonl` to the captured chaos log under a `# recorder-samples`
marker). The six judgment dimensions, each with its violation finding:

- **Dead claim_pgid** — every `running` step with `claim_pgid > 0` is probed
  with `kill(-pgid, 0)` exactly like the product's liveness watchdog; a dead
  pgid whose claim is older than one sweep interval (15s dispatch tick) is
  `O4_DEAD_CLAIM_PGID` (the sweep should have requeued it).
- **Dangling claim after NO_WORK** — a step released by a `no_work_release`
  abandonment must not still be claimed at snapshot time
  (`O4_DANGLING_CLAIM_AFTER_NO_WORK`); a re-claim with `claim_updated_at`
  AFTER the release is legitimate.
- **retry_count <= max_retries** — non-terminal steps/stories only
  (`O4_RETRY_BUDGET_EXCEEDED`); a *failed* row may carry
  `max_retries+1` because the product fails at the exhaustion point.
- **Reroute counters within budget** — `reroute_count > 2` (the source
  default `max_reroutes`) is `O4_REROUTE_BUDGET_EXCEEDED`;
  `terminal_reroute_count` is deliberately not judged (designed independent
  terminal allowance).
- **Abandonment boundary matches source** — `ABANDON_STORY_MAX = 8` (a story
  fails on the 9th; only failed stories may carry `> 8`) and
  `MAX_ABANDON_RESETS = 5` for single steps — a non-failed row beyond its
  boundary is `O4_ABANDON_BUDGET_EXCEEDED`.
- **Watchdog false-positive check** — zero `[liveness-detected]` recoveries
  (`story_abandonments.reason = 'liveness_detected'`) for workers provably
  alive (>= 2 consecutive recorder samples of the run's worker within 120s
  before the recovery), cross-referenced with the chaos log: a
  `kill-harness`/`fired` entry explains the loss; kill-and-PID-reuse inside
  one window is INCONCLUSIVE → `NOT_EVALUABLE` (scope `watchdog-pid-reuse`);
  a provably-alive worker with no chaos kill is `O4_WATCHDOG_FALSE_POSITIVE`.

The interpretation (incl. the **Tier-1 scope decision: O4 is IMPLEMENTED, not
removed** — spec 03 lists it in the in-campaign gating set) is documented in
`oracles/CONTRACT.md`. Mutation fixtures live in
`oracles/self-test/generate-o4-fixtures.mjs` + `o4.test.mjs` (clean state
PASSes — including a *live* claim_pgid probed via a detached sleep — and each
hygiene violation FAILs with its finding id; chaos-explained and pid-reuse
fixtures cover the watchdog cross-reference), exercised by
`oracles/self-test/run.sh` and `bin/tt-controller.test.sh`.

**Zero-token scripted proof battery (E3.C US-011).** `self-tests/
tier1-scripted-probe-battery.test.ts` (a HEAVY_CAMPAIGN_TEST, registered
lock-step in `self-tests/run.sh`, `bin/verify-heavy-campaign-tests.test.sh`,
and `self-tests/e2e-golden-integrity.test.ts`) proves the ENTIRE E3.C
machinery end-to-end against the 53xx scripted daemon with ZERO real tokens.
It builds scripted manifest copies under gitignored `var/`
(tier1-zero-real-launch-infra copy-transform): W3.17b + W3.18–W3.22 become
`harness: scripted-pi/scripted-hermes` with `context.execution_mode
'scripted'` and SHORTENED holds (600s → 5s) so the battery stays fast; the
`probe_sequence` + `chaos` blocks are KEPT. W3.19's drain is ADAPTED to a
plain single (non-loop) step: the as-declared `pause_drain @
step:developer:running -> resume @ now` cannot complete against the current
product — `workflow pause --drain` on the verify_each implement loop never
finalizes (the loop step stays 'running' awaiting the parked verify step, so
`finalizeDrainingPause` is never reached and the run stays status 'running'),
and `workflow resume` refuses a 'running' (draining) run ("only paused or
failed runs can be resumed"). `finalizeDrainingPause` runs only on the
plain-single-step success path (and on run completion / retry / failure) —
the verify_each verify step also bypasses it (its success routes through
`handleVerifyEachCompletion` → `advancePipeline`'s 'advanced' branch, which
never calls it). The scripted copy drains the TEST step instead (`pause_drain
@ step:tester:running`, `resume @ event:run.paused` — the drain-FINALIZATION
event, since a step-status marker races the finalize: the step flips 'done' a
few ms before the run flips 'paused', and resume on a still-'running' run is
refused): the drain genuinely parks the in-flight tester, finalizes the run
to 'paused', and the resume is accepted — a documented product-limitation
adaptation, not a weakening. **W3.21's fail_force->resume is the FIXED
corridor (product commit 3f880b1a, "Stop force-fail teardown from emitting
spurious run.completed")**: `workflow fail --force` CANCELS every
waiting/pending/running step (`forceFailRun`), and `resumeWorkflow` now
REPAIRS the all-canceled pipeline (resets from the first non-done step,
advances only when waiting work exists, and re-registers with the daemon) —
the resume SUCCEEDS with the SAME run id and the run re-activates from the
interrupted step. The launch hook (`workflow run --wait`) returns at the
FIRST terminal state (run.failed after the force-fail), so the controller's
harvest sees the resumed run still 'running' and leaves the case 'attached'
(no terminal report, no O16 verdict) — the documented US-004
resume-leaves-case-attached shape. The scripted battery asserts the FIXED
corridor at the EVIDENCE level (probe_evidence for both actions — fail_force
ok, resume ok:true exit 0 with the same run id — plus the run's own event
stream re-activation after the resume), exactly like the W4.33d corridor;
the resumeWorkflow-reuses-run-id semantics are additionally pinned by O16's
mutation fixtures (o16-green-resume / o16-resume-new-run-id).
Each case is driven through `tt-controller` against the scripted daemon with
a full-pipeline behaviors file (planner emits STORIES_JSON, setup creates a
per-worktree unique feature branch, the developer writes+commits a marker
with a long sleep so probe markers fire mid-round, the tester reports
TESTED_TREE, the merger runs the real `tamandua merge-branch` plumbing), and
asserted per case: probe actions executed (probe_evidence present), O16
verdict emitted on the scripted fixture (PASS for W3.18–W3.20 and W3.22,
NOT_EVALUABLE for the chaos-only W3.17b; W3.21's attached case emits no O16
verdict — the resume re-activates the run after the launch hook returned, so
the case stays attached with no terminal report, per the fixed corridor
above), zero tokens observed. The battery
also fixed three REAL product-facing bugs the scripted proof exposed:
`fail_force`'s probe argv was missing `--reason` (the CLI requires it — the
probe would have exited 1 on a real instance); `tt-chaos`'s phase-marker
polling queried the runs table by a `run_id` column + `run-` prefixed id the
product DB does not have (the marker could never fire against a real
contained instance — it now probes both run-id spellings and both `id`/
`run_id` column names, and `event:` markers read the event-stream files since
the product has no events table); and `tt-chaos`'s harness-provenance check
required `torture-test/var` in the process cmdline, which no real harness
process has (the work prompt carries the run id but no var path — it now
accepts cwd-under-var + cmdline-carries-run-id, the same provenance the
finder enforces). `self-tests/tier1-oracle-hygiene.test.ts` pins the
declared-oracle hygiene invariant: every oracle id declared in ANY
`cases/*.jsonl` resolves to an executable regular non-symlink file under
`torture-test/oracles/` — no declared-but-missing oracle may ever remain
(campaign #7's O16/O4 defect class).

### Wave 3 — Token-saver Paired Launch (`context.token_saver_control`, S12 controller)

W3.23-token-saver (spec 07-wave-3 §W3.23) is the token-saver lifecycle
probe. It is executed by the controller as **TWO do-now launches** against
the SAME provisioned clone — the paired-launch adapter (E3.D US-010):

- **Run A (flagged):** the managed `pi-token-saver` stub
  (bin/tt-token-saver-stub, US-009) is installed into
  `torture-test/var/adapters-bin` (the dir `tt-daemon-up ensure-up`
  prepends to the contained daemon PATH) and
  `--no-hurry-please-save-tokens-mode` is appended to the launch argv.
  The product scheduler then prefers the stub for every work spawn of the
  no-hurry run; each invocation appends one JSON record to the attempt's
  evidence log before exec'ing the real pi.
- **Run B (control):** the stub is removed first, and the run launches
  WITHOUT the flag. A healthy control produces zero new stub records.

The stub exists on the contained daemon's PATH **only during the flagged
launch window**; the controller verifies the canonical stub target's
presence/absence after each install/remove and fails closed
(`token-saver-stub-install-failed` / `token-saver-stub-remove-failed` /
`token-saver-stub-missing-after-install` / `token-saver-stub-present-after-remove`)
if the window invariant does not hold.

**Evidence contract:** `attempt.token_saver` carries per run the exact
launch argv, the resolved run id, the token-ledger observations attributed
to that run, and the stub-record count observed in that run's window (the
attempt-level token ledger still aggregates both runs for the per-case
token cap — W3.23's caps are sized for two launches). The contract is
mechanical: **zero stub records on the flagged run OR any stub records on
the control run yields the distinct `token-saver-contract` case finding
and the case is INCONCLUSIVE — never a silent PASS.** A satisfied contract
classifies the pair by the run terminal statuses + oracles exactly like a
single run.

**Wiring rules:** `token_saver_control` is controller-internal wiring — it
is excluded from the product `--context` passthrough (like `execution_mode`
and `replay_of`), and `--no-hurry-please-save-tokens-mode` is appended
ONLY for the flagged launch of a token-saver case. A scripted case carrying
the signal fails closed with `token-saver-scripted-unsupported`; an
interrupted paired attempt fails closed on recovery with
`token-saver-recovery-unsupported` (rerun the case to re-drive both
launches). The zero-token dry-run hook (`TT_DRY_RUN_REAL_LAUNCH`) records
BOTH argvs with `launch_role` `flagged`/`control` and never installs or
removes the stub.

---

## Excluded Scenarios — Complete Enumeration (Waves 1–3)

The following tables enumerate **every spec-defined scenario in waves 1–3**
that is not in the tier1.jsonl manifest. Each exclusion has an explicit,
documented reason. Zero scenarios are silently dropped.

### Wave 1 Exclusions (13 scenarios)

The wave-1 spec defines scenarios across 5 languages {java, rust, python,
go, ts}. Tier-1 is restricted to the {python, ts} toolchain profile;
java, rust, and go require toolchains outside the Tier-1 capability
profile.

#### Per-Language Matrix Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W1.L1 java | `#W1.L1` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| W1.L1 rust | `#W1.L1` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| W1.L1 go | `#W1.L1` | Tier-2: requires Go toolchain (not in Tier-1 profile) |
| W1.L2 java | `#W1.L2` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| W1.L2 rust | `#W1.L2` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| W1.L2 go | `#W1.L2` | Tier-2: requires Go toolchain (not in Tier-1 profile) |
| W1.L3 java | `#W1.L3` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| W1.L3 rust | `#W1.L3` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| W1.L3 go | `#W1.L3` | Tier-2: requires Go toolchain (not in Tier-1 profile) |
| W1.X1 java | `#W1.X1` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec defines only java (Tier-2) and ts (Tier-1) for X1. |

#### Cross-Cutting Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| TSTX replay java | `#W1 cross-cutting` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| TSTX replay rust | `#W1 cross-cutting` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| TSTX replay go | `#W1 cross-cutting` | Tier-2: requires Go toolchain (not in Tier-1 profile) |

**Wave 1 excluded count:** 13 scenarios across 3 toolchain-excluded
languages (java, rust, go). Zero scenarios with python or ts toolchains
are excluded from wave 1.

### Wave 2 Exclusions (25 scenarios)

#### Workflow Catalog Matrix (20 scenarios)

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W2.01 (do-now, tt-go, pi) | `#W2.01` | Tier-2 only: all 20 workflow matrix cells (W2.01–W2.20) are not marked `T1` in the spec. The full catalog requires all 5 toolchains (java, rust, go, python, ts) and spends ~10M tokens independently — exceeding Tier-1's ~15M soft budget. Only the T1-marked edge/authoring scenarios (W2.21–W2.24) are in Tier-1. |
| W2.02 (just-do-it, tt-java, pi) | `#W2.02` | Tier-2 only (see W2.01 rationale) |
| W2.03 (do-review-do-verify, tt-rust, pi) | `#W2.03` | Tier-2 only (see W2.01 rationale) |
| W2.04 (frontend-test, tt-ts, pi) | `#W2.04` | Tier-2 only (see W2.01 rationale) |
| W2.05 (bug-fix, tt-python, pi) | `#W2.05` | Tier-2 only (see W2.01 rationale) |
| W2.06 (bug-fix-worktree, tt-java, pi) | `#W2.06` | Tier-2 only (see W2.01 rationale) |
| W2.07 (bug-fix-merge, tt-go, pi) | `#W2.07` | Tier-2 only (see W2.01 rationale) |
| W2.08 (bug-fix-merge-worktree, tt-rust, pi) | `#W2.08` | Tier-2 only (see W2.01 rationale) |
| W2.09 (feature-dev, tt-ts, pi) | `#W2.09` | Tier-2 only (see W2.01 rationale) |
| W2.10 (feature-dev-worktree, tt-python, pi) | `#W2.10` | Tier-2 only (see W2.01 rationale) |
| W2.11 (feature-dev-merge, tt-java, pi) | `#W2.11` | Tier-2 only (see W2.01 rationale) |
| W2.12 (feature-dev-merge-worktree, tt-go, pi) | `#W2.12` | Tier-2 only (see W2.01 rationale) |
| W2.13 (quarantine-broken-tests, tt-java, pi) | `#W2.13` | Tier-2 only (see W2.01 rationale) |
| W2.14 (quarantine-broken-tests-merge, tt-python, pi) | `#W2.14` | Tier-2 only (see W2.01 rationale) |
| W2.15 (quarantine-broken-tests-merge-worktree, tt-ts, pi) | `#W2.15` | Tier-2 only (see W2.01 rationale) |
| W2.16 (security-audit, tt-go, pi) | `#W2.16` | Tier-2 only (see W2.01 rationale) |
| W2.17 (security-audit-worktree, tt-java, pi) | `#W2.17` | Tier-2 only (see W2.01 rationale) |
| W2.18 (security-audit-merge, tt-ts, hermes) | `#W2.18` | Tier-2 only (see W2.01 rationale) |
| W2.19 (security-audit-merge-worktree, tt-rust, pi) | `#W2.19` | Tier-2 only (see W2.01 rationale) |
| W2.20 (skills-normalize-audit, skills dir, pi) | `#W2.20` | Tier-2 only (see W2.01 rationale) |

#### Non-T1 Edge/Authoring Scenarios (5 scenarios)

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W2.25 (reserved-key behavior pinning) | `#W2.25` | Tier-2 only: not marked `T1` in spec. Covers 5-toolchain surface; ≈0 tokens but exercises launch-level context key behaviors (DC47). |
| W2.26 (webhook notifications) | `#W2.26` | Tier-2 only: not marked `T1` in spec. ≈0 tokens; tests webhook notification delivery, an infrequently-used feature (DC50). |
| W2.27 (MCP smoke) | `#W2.27` | Tier-2 only: not marked `T1` in spec. ≈0 tokens; exercises the MCP server entry point which the workflow matrix never touches. |
| W2.28 (fresh-install & auto-start) | `#W2.28` | Tier-2 only: not marked `T1` in spec. Infra provisioning test (disposable fake-HOME, get-ready, auto-start path). Not a workflow scenario per se. |
| W2.29 (AutoResearch bounded session) | `#W2.29` | Tier-2 only: not marked `T1` in spec. Exercises the AutoResearch experimental subsystem (small: 2 experiments). |

**Wave 2 excluded count:** 25 scenarios (20 workflow matrix + 5 non-T1
edge/authoring). All 6 T1-marked wave-2 scenarios are present in the
manifest.

### Wave 3 Exclusions (7 scenarios)

#### Harness Duel Matrix Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W3.03 (bfmw × pi × java) | `#W3.03` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec marks `T1: python, ts` for bfmw × pi row. |
| W3.04 (bfmw × pi × rust) | `#W3.04` | Tier-2: requires Rust toolchain (not in Tier-1 profile). |
| W3.05 (bfmw × pi × go) | `#W3.05` | Tier-2: requires Go toolchain (not in Tier-1 profile). |
| W3.06 (bfmw × hermes × java) | `#W3.06` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec marks `T1: ts` for bfmw × hermes row. |
| W3.11 (fdmw × pi × java) | `#W3.11` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec marks `T1: ts` for fdmw × pi row. |
| W3.12 (fdmw × pi × python) | `#W3.12` | **Tier-2 by spec design.** The spec marks `T1: ts` only for the fdmw × pi row (W3.11–13). Although tt-python is in Tier-1's capability profile, the spec author deliberately limited fdmw × pi coverage to ts for Tier-1. Rationale: fdmw runs are expensive (2.5M token caps each), and the fdmw × pi surface is already covered by W3.04-fdmw-pi-ts (manifest) and the marathon (W3.17a/b, tt-poly-lite, hermes). Adding W3.12 would add ~2.5M to the Tier-1 budget without proportional marginal coverage — bfmw-python is already exercised in W3.01. This cell is correctly excluded and belongs in Tier-2. |

#### Platform-Conditional Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W3.26 (WDGM false-positive check, darwin) | `#W3.26` | **Darwin-only** (platform-conditional). On linux hosts, this scenario is automatically excluded by the controller's predicate system (`requires.platform`). The process recorder runs at 5s granularity alongside one fdmw pi lane on darwin hosts only; it is the definitive WDGM false-positive check on the platform where that defect class was born. |

**Wave 3 excluded count:** 7 scenarios (5 toolchain-excluded matrix
cells + 1 spec-deliberate fdmw-python exclusion + 1 darwin-only).
All spec T1-marked wave-3 scenarios are present in the manifest.

---

## Waves 4–5 — Entirely Tier-2

Waves 4 (fault injection) and 5 (the storm) are **entirely Tier-2** —
none of their scenarios are included in Tier-1. These waves are designed
for the full 5-toolchain profile and a ~50M token campaign budget.

### Wave 4 T1-Marked Scenarios

The wave-4 spec (`08-wave-4-fault-injection.md`) marks many scenarios
with `T1` annotations, but these are authored separately and would
consume the remaining ~12 budget slots in the spec's ~40 estimate. They
are not in the current tier1.jsonl manifest and are out of scope for this
traceability. Key wave-4 T1-marked scenarios include:

- **Gate corridor (real tokens):** W4.01 (missing evidence → reroute),
  W4.02 (fail_missing=1 refusal), W4.04 (gate-override probe: mechanical/
  behavioral/key-laundering), W4.05 (slow-suite legitimacy under
  contention), W4.29 (strict gate on retrying finalize)
- **Process violence (real tokens):** W4.09 (kill -9 harness),
  W4.10 (kill -9 daemon)
- **Moving targets (real tokens):** W4.06 (colleague rebase),
  W4.07 (colleague conflict)
- **Scripted/zero-token:** W4.25 (upgrade/downgrade/re-upgrade),
  W4.27 (shim exit-code matrix), W4.28 (TSTX cross-repo collision),
  W4.30 (detached-HEAD origin), W4.31 (tree-rewriting pre-commit hook),
  W4.35 (verdict cross-product 24-cell matrix), W4.36 (broken-work
  concession), W4.37 (KEY-line spoof from repo content), W4.49
  (update-transaction failure points)
- **Behavioral:** W4.14 (tt-chaos custom workflow — lost output +
  ambiguous verdicts), W4.16 (scope bait)

See `08-wave-4-fault-injection.md` for the complete list.

### Wave 5

The storm (8-simultaneous-run mixed chaos) is Tier-2 by design — it
requires the full toolchain profile and a $12–16M token budget.

---

## Platform-Conditional Exclusions

All `[darwin]`-only assertions (e.g., `/private/var` realpath checks,
launchd-specific probes, WDGM false-positive check in W3.26, and the
W2.20 additional path assertions under `/private/var`) are automatically
excluded on non-darwin hosts by the controller's predicate system
(`requires.platform`). No manual exclusion needed — they become
`NOT_RUN(predicate)` on linux hosts. The darwin-specific predicate
additions are documented in each wave's "Platform-conditional"
sections.

---

## Token Budget Verification

Per spec §11, Tier-1 soft cap is 15M tokens across ~40 runs. Our 28
cases (all real runs or zero-token scripted):

| Wave | Real Cases | Token Cap (sum of per-case caps) |
|------|-----------|----------------------------------|
| Wave 1 | 10 | ~2.6M |
| Wave 2 | 2 real (W2.22, W2.24) + 4 zero-token | ~1.2M |
| Wave 3 | 12 | ~35.7M |

**Cabinet-level concern:** The Wave-3 marathon cases alone (W3.17a,
W3.17b) carry 8M caps each (16M total), and the 4 bfmw/fdmw cases add
another ~8.5M. The lifecycle probes add ~5.5M. Combined with W1+W2, the
sum-of-caps is ~39.5M, which exceeds the 15M soft budget.

**Mitigation:** Caps are per-case ceilings, not expected spends. The
spec's 15M estimate is the *expected* spend, not the cap sum. The
controller's hard abort at 15M (per spec §11) will cut the campaign if
actual spend exceeds the budget. Real production medians (bfmw p50 ~256k,
fdmw p50 ~793k) suggest typical Tier-1 spend will be well under the cap
sum. The 15M abort is the real budget control.

---

## Seed-Ref Field (`seed`)

Real-case fixture provisioning reproduces each case's **exact starting tree**
by checking the working clone out onto an immutable **seed ref** — the
fixture's green base plus exactly one seeded defect (spec
`02-fixture-projects.md` §Green-base + seed-ref discipline). Semantics:

- **Schema:** `seed` is an **optional, nullable** string in `case.schema.json`.
  Absent or `null` ⇒ provision the working clone from the fixture's green
  **baseline** (the default for do-now / feature-dev cases).
- **Ref name, not a `refs/...` prefix:** the field holds a ref **name** such
  as `BUG-P1` (a seed ref `seed/BUG-P1`), `seed/storm` (a composite seed ref),
  or `broken-tests` (a direct branch). The provisioning stage resolves it onto
  the working clone and ensures a real current branch (merge workflows need a
  real branch as merge target, not a detached HEAD).
- **Migration:** an existing bare-name ref `BUG-P1` is resolved as
  `seed/BUG-P1`; a value already containing `/` (e.g. `seed/storm`,
  `broken-tests`) is used as-is. The exact resolution rules live with the
  provisioning adapter (E2.3) and spec `12-runner-automation.md`.
- **Validation:** a non-null `seed` must match the ref-name regex
  `^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$` (alphanumerics, `.`, `_`, `/`,
  `-`; may not begin with a digit-symbol or end in `/` or `.`). Malformed ref
  names (bad characters, wrong shape) are **rejected fail-closed** by
  `tt-controller --manifest ... --validate-only` before any launch, so a bad
  seed can never silently fall back to the wrong starting tree.

| Manifest | `seed` present | Validated |
|----------|----------------|-----------|
| tier1.jsonl (current) | no | ✅ |
| any manifest | yes (valid ref name / null) | ✅ |
| any manifest | yes (malformed ref name) | ❌ rejected |

---

## Golden Bare Bootstrap (`tt-golden-bootstrap`)

Real-case provisioning (E2.3) clones working copies from
`var/fixtures/golden/<fixture>.git`. The pipelined torture-test never built
those golden bares — they were previously produced only by manual
`build-golden.sh` runs. `bin/tt-golden-bootstrap.mjs` is the single,
**fail-closed** bootstrap for a golden bare, and is both an importable module
(consumed by the controller's real-case launch path) and a CLI.

- **Absent golden** ⇒ runs `fixtures-src/<fixture>/build-golden.sh` (deterministic,
  byte-stable hashes) to create the bare, then verifies the result against its
  just-recorded hash ledger. A failed build or a bad result is reported, never
  a silent half-launch.
- **Present golden** ⇒ verifies it is a **valid bare git repo** whose every ref
  matches its recorded hash ledger exactly, including the fixture's baseline
  branch (`main`, or `master` for `tt-python@master`) pointing at the recorded
  green baseline. Re-running is an idempotent **no-op** (never rewrites a valid
  golden).
- **Fail-closed:** a missing or malformed golden yields a **precise TEST_INFRA
  reason** (e.g. `golden-not-bare-repo`, `golden-ref-mismatch`,
  `golden-hash-file-missing`, `golden-baseline-branch-missing`) with the exact
  ref/hash that diverged. A healthy host must never hit these.

**Zero-token proof (US-002):** the golden *greenness* is established at build
time by `build-golden.sh` (which runs the baseline suite and refuses to finish
on a red tree); the bootstrap's present-golden gate verifies byte-for-byte
against the same recorded hashes — it does not re-run the suite (zero tokens).

Usage:

```
tt-golden-bootstrap --fixture <name> [--golden-dir <dir>] [--force] [--json]
tt-golden-bootstrap --help
```

Exit codes: `0` golden OK; `1` fail-closed TEST_INFRA defect; `2` usage error.

---

## Fixture Work-Clone Provisioning (`tt-fixture-provision`)

E2.3's root gap: the controller's real-case launch path passed
`var/fixtures/work/<case-id>/<fixture>` to the harness as
`--worktree-origin-repository` / `--working-directory-for-harness`, but NOTHING
created that working clone — the first genuine real launch went terminal
`TEST_INFRA_FAIL` with `ENOENT` (an argv-recording stub proof never lstats the
path, so it could not catch this). `bin/tt-fixture-provision.mjs` is the
standalone, **fail-closed** adapter that provisions a pristine working clone. It
is both an importable module (consumed by the controller's real-case launch path
in US-004) and a CLI.

Given a verified golden bare (via `tt-golden-bootstrap`), a case's work dir, and
seed-or-baseline, it:

- **(a)** creates a **fresh clone** of `var/fixtures/golden/<fixture>.git` into
  `var/fixtures/work/<case-id>/<fixture>`, wiping any previous clone first (a
  re-provision is always **clean** — an attempt N+1 / rugpull replacement never
  inherits a dirtied clone);
- **(b)** checks out the case's **seed ref** (`seed/<ID>` per the manifest `seed`
  field) **or** the green **baseline** onto a real current **named branch** —
  never detached HEAD, so merge workflows have a real merge target. Seed refs
  that live on tags get a fresh named branch (`seed-<ID>`) created at that
  commit; seed refs that live on branches checkout that branch directly;
  baseline cases stay on the fixture's baseline branch (`main`, or `master` for
  `tt-python@master`).
- **(c)** applies per-fixture working-state / junk preparation per spec 02:
  plants the inert `operator-notes.local` (present + untracked + byte-identical
  to the fixture source), and for the tt-python do-now path pre-bootstraps the
  `.venv` (runs `./bootstrap`), seeds the deterministic `__pycache__/` junk
  marker (seeded/deterministic junk — byte-identical to the fixtures-src
  reference), and regenerates `.pytest_cache/` as untracked files.
  `--arming prebootstrapped` is the
do-now default; `--arming raw` defers bootstrap/junk to a full-chain
workflow's own setup step.

A provision failure yields a **precise TEST_INFRA reason** (fail-closed):
`unknown-fixture`, `seed-unknown`, `git-clone-failed`, `git-checkout-seed-failed`,
`clone-detached-head`, `golden-not-bare-repo`, `operator-notes-tracked`,
`fixture-operator-notes-unverifiable`,
`fixture-bootstrap-failed`, `fixture-junk-tracked`, and the golden-bootstrap
family. On a healthy host these are never reached.

**Controller wiring (US-004):** the controller's real-case launch path
(`executeWorkflowCase`) runs `provisionWorkClone` as a **mandatory stage BEFORE**
the workflow launch builds `workflowRunArgs` (and before the zero-token
dry-run argv capture), so the path handed to `--worktree-origin-repository` /
`--working-directory-for-harness` always exists and always equals the
provisioned clone path exactly. It runs on **every** attempt — `provisionWorkClone`
wipes any prior clone first, so an attempt N+1 (retry/rugpull replacement) is a
**clean re-provision** and never inherits a dirtied clone. A provision failure
persists `TEST_INFRA_FAIL` with the precise adapter category/reason (fail-closed)
and short-circuits before the launch.

The runtime teardown policy (keep failed-case clones for evidence, prune
passed-case clones after oracle harvest) is declared in US-005 / spec 11–12.

Usage:

```
tt-fixture-provision --fixture <name> --case-id <id> [--seed <id>] [--arming prebootstrapped|raw] \
                     [--golden-dir <dir>] [--work-dir <dir>] [--force] [--json]
tt-fixture-provision --help
```

Exit codes: `0` provisioned OK; `1` fail-closed TEST_INFRA defect; `2` usage
error.

---

## Working-Clone Teardown Policy (`tt-teardown`)

Spec 11 (schedule/budget/abort) and spec 12 (runner automation) are **silent**
on whether a terminal case's provisioned working clone
(`var/fixtures/work/<case-id>/<fixture>`) should be retained as evidence or
pruned after terminalization. US-005 adopts and **declares** an explicit policy
(module `tt-teardown.mjs`, constant `DECLARED_TEARDOWN_POLICY`):

| Terminal outcome | Action | Rationale |
|---|---|---|
| `PASS` | **PRUNE** the work clone (after oracle harvest) | A harvested PASS clone carries only deterministic arming junk and no failure forensics; retaining it would accumulate `<case-count>` full clones under `var/fixtures/work/` for zero evidentiary value. |
| every other outcome (`PRODUCT_FAIL`, `AGENT_FLAKE`, `PROVIDER_FAIL`, `TEST_INFRA_FAIL`, `INVALID`, `INCONCLUSIVE`, `NOT_RUN`) | **KEEP** the work clone | A FAILED case's working tree is ITSELF the evidence of its terminal failure state (spec 11's evidence-capture-before-destruction: never destroy evidence that could explain a failure). Re-provisioning reconstructs the starting tree, not the failure state. |

Every teardown decision is **recorded** (case id, terminal outcome, kept/pruned
action, work clone path, UTC timestamp) as `<case>.teardown` in
`results/state.json` **and** surfaced in the campaign report (the `RUN TEARDOWN
(US-005)` section of `report.txt` plus the `teardown_decisions` ledger in
`report.json`; each report row also carries the case's `teardown` record).

Teardown runs at terminalization from the controller's single
`markTerminal` choke point, **after** oracles have already harvested their
evidence (oracle snapshot/collection completes before `markTerminal`). It only
ever touches a clone a case actually provisioned (a provisioned path recorded on
an attempt) — cases that never provisioned (NOT_RUN / pending-real /
predicate-excluded, or a provision-failure) are left completely untouched (no
record, no filesystem action). Provider-retry scheduling returns before
`markTerminal`, so teardown only runs on the final, genuinely-terminal outcome.

The adapter is a standalone importable module AND a thin CLI
(`tt-teardown --case-id <id> --outcome <outcome> [--work-clone-path <path>]`);
it is idempotent (pruning an already-missing clone is a no-op) and its record
reflects physical reality via `existed` / `pruned` / `kept`.

Usage:

```
tt-teardown --case-id <id> --outcome <outcome> [--work-clone-path <path>] [--json]
tt-teardown --help
```

Exit codes: `0` policy applied (decision recorded); `2` usage error / caller bug.

---

## Validation Status

- ✅ `tt-controller --manifest cases/tier1.jsonl --validate-only` exits 0
- ✅ Replay pairing (S9): W1.REPLAY-python declares `context.replay_of`
  `W1.L2-python` and W1.REPLAY-ts declares `W1.L2-ts`; both pair ids
  resolve to existing manifest cases; only the two REPLAY lines carry
  `replay_of`; the contract (same origin/tree, sequenced after pair,
  cache-HIT assertion) is documented in the Wave-1 Replay Pairing
  section above and in `case.schema.json` `context.replay_of`
- ✅ Replay provisioning + sequencing (S9, US-005): controller wired —
  replay attempts reuse the pair's clone (no own provisioning),
  pair clones are kept at terminalization (`REPLAY_PAIR_KEEP`),
  non-terminal/missing/mismatched pairs fail closed with distinct
  categories (`replay-pair-not-terminal` / `replay-pair-clone-missing` /
  `replay-pair-missing` / `replay-pair-fixture-mismatch`), and
  `replay_of` is excluded from the product `--context` passthrough
  (pinned by `tier1-replay-provisioning-sequencing.test.ts`)
- ✅ `tt-tier1-assets cases/tier1.jsonl` exits 0
- ✅ All 28 cases schema-valid
- ✅ All task files exist and are non-empty
- ✅ All probe_id references resolve to existing probes
- ✅ All spec_ref fields reference the correct wave document
- ✅ Zero T1-marked scenarios missing from manifest (waves 1–3)
- ✅ Every excluded scenario has explicit case id → spec section → reason
- ✅ `seed` field is optional/nullable and validated per ref-name regex (see Seed-Ref Field)
- ✅ `tt-golden-bootstrap --fixture tt-python` builds/verifies the golden bare
  (see Golden Bare Bootstrap); re-runs are idempotent no-ops; malformed goldens
  fail-closed with a precise TEST_INFRA reason
- ✅ `tt-fixture-provision --fixture tt-python --case-id <id>` provisions a
  clean work clone at `var/fixtures/work/<id>/tt-python` on a non-detached named
  branch (seed or baseline), with operator junk + bootstrapped venv + regenerated
  junk (see Fixture Work-Clone Provisioning); unknown fixtures/seeds fail-closed
- ✅ Controller real-case launch (US-004) provisions the work clone as a
  mandatory stage before building `workflowRunArgs`; the recorded launch argv
  fixture path equals the provisioned clone path exactly; a provision failure
  persists `TEST_INFRA_FAIL` with the precise adapter category (fail-closed);
  per-attempt re-provision is always clean (see Fixture Work-Clone Provisioning)
- ✅ Terminal-case teardown (US-005) applies the DECLARED policy
  (`tt-teardown`): PASS prunes the harvested clone, every failure outcome keeps
  it as evidence; every decision is recorded to `results/state.json` (`<case>.teardown`)
  and surfaced in the campaign report; cases that never provision a clone are
  untouched (see Working-Clone Teardown Policy)
- ✅ `tt-controller --case <id>` (US-006) selects exactly ONE manifest case id
  for focused reruns (validate-only, new campaign, and resume paths). An
  unknown id fails fast (exit 2) with a message listing the available ids; it
  combines with `--scripted-only` and with the default include-real (all)
  execution selection; `--help` documents the flag. Wired through `tt-run`
  as `run-torture-test --tier0/--tier1 [--include-real] --case <id>`.
- ✅ The `TT_DRY_RUN_REAL_LAUNCH` hook (US-007) records the captured launch
  argv WITH the E2.3-proof: it lstats the provisioned work clone at
  argv-capture time and embeds `work_clone { path, existed, is_directory,
  size, lstat_error }` in the argv record, so a zero-token dry run proves the
  clone physically existed before launch (closing the original stub's blind
  spot — a stub that never lstats the path cannot surface the ENOENT).
- ✅ `tier1-fixture-probe.test.ts` (US-007) asserts end-to-end that a real
  case's dry-run launch record proves the provisioned clone existed at
  argv-capture time and that the argv fixture path equals the clone path.
- ✅ Built-in golden hash-ledger fix (US-007, infra): the tt-poly / tt-poly-lite
  `build-golden.sh` scripts wrote `#baseline=<sha>` (commented-out) instead of
  `baseline=<sha>`, which `tt-golden-bootstrap.parseHashFile` could not read —
  it surfaced as `golden-hash-file-malformed` ("no baseline or no seed/ref
  entries") for the W3.17a/b `tt-poly-lite` real cases. Both scripts now emit
  the uncommented `baseline=` line; the tt-poly-lite golden was deterministically
  rebuilt (all refs byte-identical) and the include-real scripted tier1 proof
  is GREEN again.
- ✅ **REAL single-case integration proof (US-008, token-bearing)** — one
  W1.L1-python case executed end-to-end via
  `tt-controller --manifest cases/tier1.jsonl --case W1.L1-python` (pi harness,
  do-now on tt-python, caps tokens 200000 / wall_min 5). Authoritative campaign:
  `campaign-20260808T102346890Z-...` — TOKENS observed 19507 (>0),
  `TEST_INFRA_FAIL=0`, NO `scheduler-execution-failed`, NO `ENOENT lstat` in any
  evidence file; the work clone was provisioned before launch and the real pi
  workflow ran to completion and committed valid work; O3z & O11 PASS (token
  attribution reconciled); evidence dirs complete for all configured oracles
  (O1, O3z, O8, O11). Validated by `self-tests/tier1-real-case-proof.test.ts`.
  The real run also exposed & fixed (all within torture-test/) latent
  oracle/harness-infra defects only a REAL armed clone exercises — see the
  US-008 record in the run progress log (async token settle, O8 tracked-tree +
  rebase + mode-semantics reconciliation, DB-schema + workflow-catalog
  prerequisites, O11 telemetry calibration).
- ✅ US-008 residual (honest, by design): O8_SEEDED_TEST_CHANGED fires because
  the W1.L1 do-now task extends the pre-seeded `tests/test_dates.py` (pinned by
  the O8 self-test). The run is otherwise clean (PRODUCT_FAIL exit 1 with a
  single named finding) — a documented fixture/oracle design tension, not an
  E2.3 or tamandua defect.
- ✅ US-009: bare `./run-torture-test --tier1` (zero-token pending-real
  semantics) executed twice consecutively on a clean, quiescent host — BOTH
  exited GREEN (verdict GREEN, exit 0, tokens_observed 0), every real Tier-1
  case `pending-real`, every scripted case `PASS`. Repeatability is pinned by
  `self-tests/tier1-repeatability.test.ts`. Hygiene sweep post-run: git tree
  clean, `var/` gitignored, scripted daemon STOPPED, TT ports free, no leaked
  controller/recorder/daemon/hook/scenario processes. The US-008 tamandua
  observations are recorded as collected findings (no product fix) in
  `impl-tasks/E2.3-fixture-work-clone-provisioning.md` §Findings.
- ✅ Token-saver paired-launch adapter (S12, US-010): W3.23 executes as two
  do-now launches (flagged with the managed stub + `--no-hurry-please-save-tokens-mode`,
  control without either); `attempt.token_saver` carries both runs' argv, run
  ids, per-run token-ledger observations, and stub-record counts; the
  `token-saver-contract` finding fires on a flagged-zero or control-stray stub
  record pattern (never a silent PASS); `token_saver_control` never reaches the
  product `--context` argv and the flag never reaches a non-token-saver case;
  scripted carriers fail closed (`token-saver-scripted-unsupported`) and
  interrupted pairs fail closed on recovery (`token-saver-recovery-unsupported`);
  the dry-run hook records both argvs (`launch_role` flagged/control). Pinned by
  `self-tests/tier1-token-saver-launch-adapter.test.ts` (see the Wave 3 section
  above).
- ✅ Python shim PATH convention (S10, US-011): every python-fixture
  `context.test_cmd` uses the explicit `.venv/bin/pytest -q` form (no PATH
  magic — documented in the Case-Authoring Conventions section above).
  W1.REPLAY-python now carries `.venv/bin/pytest -q` (matching its pair
  W1.L2-python, so the replay cmd key stays reachable); the ts pair keeps
  `npm test` on both lines. Pinned by
  `self-tests/tier1-python-shim-convention.test.ts` (convention + bare-pytest
  rejection + manifest validation) and
  `self-tests/tier1-python-shim-ledger-proof.test.ts` (zero-token proof: a
  provisioned tt-python clone runs `.venv/bin/pytest -q` through the product
  `tamandua-test` shim, which records a `suite_results` ledger row with
  exit_code 0 under the contained TT state — no pi, no daemon, no tokens).
