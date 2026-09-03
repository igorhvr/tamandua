# S58 pin-change ledger

Every expected_route / manifest pin changed by the S58 asset-parity stories
(US-002..US-012) is recorded here with its PRODUCT reason. Rule from the S58
task and every story: never loosen a pin to make a red cell pass — a red cell
after roster/expects parity is a product finding to report, not a pin to edit.
Additive pins and budget adjustments that reflect the WAVE-A (09c10ce5) /
WAVE-B.1 (791e45df) / CRED-SURF (741feb3b) product state belong in this ledger.

Product background (what changed in the workflow contract):
- WAVE-A (09c10ce5) added two CONDITIONAL steps to bug-fix-merge-worktree:
  `deception_audit` (agent auditor, condition `deception_audit_required`) and
  `test_cmd_review` (agent reviewer, condition `test_cmd_review_required`), and
  made the `fix` step expects require `^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\s*\S+`.
  A CANNOT_REPRODUCE fixer completion SETS deception_audit_required, so the
  auditor DISPATCHES one read-only round; test_cmd_review_required stays UNSET
  when no TEST_CMD rewrite exists, so the reviewer AUTO-COMPLETES in the
  zero-token conditional sweep (auto_completed=1, reason
  `condition_unset:test_cmd_review_required`, zero step.running events).
- WAVE-B.1 (791e45df) restored terminal-class-only `terminal_reroute_count`
  semantics (only terminal-class reroutes count). It is already reflected in
  the pre-existing pins; no S58 story changed a terminal_reroute_count value.
- CRED-SURF (741feb3b) added the reviewer/auditor roster behaviors to the
  scenario cells (VERDICT: ACCEPT / VERDICT: HONEST canned outputs).
- US-001 added the canonical `CANNOT_REPRODUCE: scripted scenario — no live
  reproduction; behavior fixed per plan` line to every scripted fixer output,
  so every bug-fix-merge-worktree scripted cell is a CANNOT_REPRODUCE cell
  (no cell demonstrates a failing baseline, so no REPRO_EVIDENCE anywhere).

Observed step facts (verified from the run DB + event stream of
run-a7922364-04b6-4c48-9509-064fd6080207, w4.35-done-rebased-absent-green):
- `deception_audit`: status done, auto_completed=0, exactly one step.running
  event (the HONEST round), type conditional.
- `test_cmd_review`: status done, auto_completed=1,
  auto_complete_reason=`condition_unset:test_cmd_review_required`, zero
  step.running events, one step.auto_completed event.
- No landing annotation, no step.rerouted for the conditional steps; the
  pre-WAVE-A corridor pins (reroute_count 8, reroute_events 8, merger
  invocations 9/8, suite_rows, ledger/token tripwires) all still hold exactly.

---

## US-002 — w4.35 'done' verdict family (6 cells)

Cells: w4.35-done-rebased-{absent,true}-{green,missing,red}.

### 1. ADDITIVE expected_route pins: reviewer_auto_completed / auditor_invocations / auditor_auto_completed

- Values (all six cells): `reviewer_auto_completed: 1`,
  `auditor_invocations: 1`, `auditor_auto_completed: 0`.
- Product reason: WAVE-A conditional steps now execute. Every done-family cell
  is a CANNOT_REPRODUCE cell (US-001), so deception_audit_required is set and
  the auditor dispatches exactly ONE read-only round (VERDICT: HONEST ->
  done, auto_completed=0), and test_cmd_review_required is unset (no TEST_CMD
  rewrite) so the reviewer auto-completes (auto_completed=1) with zero
  dispatches. These are NEW observable facts of the corrected product; they
  were absent pre-WAVE-A and no pin covered them.
- Mirrored into cases/tier0.jsonl `context.scenario_expected_route` (exact
  deep equality, same key order, enforced by tt-tier0-assets) and into the
  deepEqual pin in self-tests/w4.35-done-matrix.test.ts.
- Runner: run-done-cell.mjs now asserts (from the run DB) the reviewer
  auto-complete reason `condition_unset:test_cmd_review_required`, zero
  reviewer step.running events, and the pinned auditor invocation count and
  auto-completion flag. No pre-existing pin value changed.

### 2. caps.wall_min bump: w4.35-done-rebased-absent-green 4 -> 5

- Product reason: the WAVE-A auditor round adds ~1 scripted round (~11-15 s)
  to a corridor that already runs 8 verify->finalize_merge reroute cycles
  (~22 scripted rounds). Measured natural runtime on the corrected product:
  command started 15:09:26.370Z, the runner's final PASS JSON was emitted at
  15:13:26.2Z and the case was SIGTERM'd by the hook runner's exact
  deadline_at (= 240.0 s) at 15:13:26.241Z before process exit could be
  reaped — i.e. natural runtime is ~240.0-240.5 s against a 240 s budget.
  The 4 m budget was pre-WAVE-A calibrated (natural ~229-230 s with one fewer
  round). Raising to 5 m restores a ~60 s margin, matching the sibling
  done-family cells (already 5 m). This is a runtime-budget adjustment, not a
  route/semantic pin loosening: every semantic invariant
  (expects-reroute-exhausted, reroute_count 8, reroute_events 8,
  terminal_reroute_count 0, merger_invocations 9, suite_rows 1,
  system_tokens_spent 0, must-not-land) is unchanged and still asserted.
- Aggregate consequence: the tier0-case-manifest self-test wall budget
  (sum caps.wall_min <= N) moved 180 -> 181 because of this +1. Product
  reason: scripted w4.35 corridors now include the extra auditor round.
  Future S58 stories adjust N only by the wall they legitimately add and
  record it here.

---

## US-003 — w4.35 'retry' verdict family (6 cells)

Cells: w4.35-retry-rebased-{absent,true}-{green,missing,red}.

### 1. ADDITIVE expected_route pins: reviewer_auto_completed / auditor_invocations / auditor_auto_completed

- Values (all six cells): `reviewer_auto_completed: 1`,
  `auditor_invocations: 1`, `auditor_auto_completed: 0`.
- Product reason: identical to US-002's done-family pins — WAVE-A conditional
  steps execute on the corrected product. Every retry-family cell is a
  CANNOT_REPRODUCE cell (US-001), so deception_audit_required is set and the
  auditor dispatches exactly ONE read-only round (VERDICT: HONEST -> done,
  auto_completed=0); test_cmd_review_required is unset (no TEST_CMD rewrite in
  any retry cell) so the reviewer auto-completes (auto_completed=1) with zero
  step.running events and reason `condition_unset:test_cmd_review_required`.
  The retry corridor re-runs the verify -> finalize_merge span up to 8 times
  (merger STATUS: retry verdicts) but never re-pends the upstream
  fix/deception_audit span, so the auditor still dispatches exactly once.
- Verified by probe runs of five cells on the corrected product (WAVE-A
  09c10ce5 + WAVE-B.1 791e45df + CRED-SURF roster): every run's runner emitted
  its final PASS JSON with `reviewer_auto_completed: 1`,
  `auditor_invocations: 1`, `auditor_auto_completed: 0` (plus the unchanged
  corridor facts reroute_events 8 / merger_invocations 8|9 /
  verifier_invocations 9 / suite_rows 0|1|9 / tokens 0 / ref not moved).
  run ids: run-44b6de83 (absent-green), run-67ff1360 (absent-missing),
  run-649eeedf (absent-red), run-e9a85ba7 (true-red), run-93e43951
  (true-missing). The true-green cell is RED for a product reason — see the
  product-finding note at the end of this US-003 section; it never reached the
  corridor, so its additive pins are the same values but UNREACHABLE on the
  corrected product until the product deadlock is fixed.
- Mirrored into cases/tier0.jsonl `context.scenario_expected_route` (exact
  deep equality, same key order, enforced by tt-tier0-assets) and into the
  deepEqual pin in self-tests/w4.35-retry-matrix.test.ts, which also gained
  the runner source-guards (worktree cleanup precedes invariants; the runner
  reads test_cmd_review/deception_audit step rows and asserts the
  auto-completion and invocation-count facts).
- Runner: run-retry-cell.mjs now asserts (from the run DB) the reviewer
  auto-complete reason `condition_unset:test_cmd_review_required`, zero
  reviewer step.running events, and the pinned auditor invocation count and
  auto-completion flag. No pre-existing pin value changed.

### 2. caps.wall_min bumps: five retry cells 6 -> 7 (certified); true-green unchanged

- Product reason: the WAVE-A auditor round extends each non-RSTY retry corridor
  past its pre-WAVE-A wall. Probe runs on the corrected product:
  - w4.35-retry-rebased-{absent,true}-{green,red} and -{absent,true}-missing
    (5 cells, wall 6m = 360 s): the runner's final PASS JSON was emitted at
    ~359.5-359.9 s and the hook runner SIGTERM'd the case at its exact 360 s
    deadline before process exit could be reaped (command.result.json: signal
    SIGTERM, "case wall limit reached"; PASS JSON present as the last stdout
    line). Natural runtime is therefore ~360.0-360.5 s against the 360 s
    budget. The retry corridor runs 8 merger-retry cycles (~22 scripted rounds
    pre-WAVE-A natural ~330-345 s); the auditor round adds the last ~15-25 s
    that crosses the wall. Raising each wall to 7 m restores a ~60 s margin,
    matching how US-002 treated the done family. All five re-certified at the
    7 m budget: `./run-torture-test --tier0 --case <id>` exits 0, PASS, zero
    tokens (~364 s each). Runtime-budget adjustment only: every semantic
    invariant (accepted-retry-reroute-exhausted, reroute_count 8,
    reroute_events 8, terminal_reroute_count 0|1, ledger_concession_count 0|1,
    merger_invocations 8|9, verifier_invocations 9, suite_rows 0|1|9,
    system_tokens_spent 0, must-not-land) is unchanged and still asserted by
    the runner.
  - w4.35-retry-rebased-true-green (RSTY story-loop cell): NO wall bump is
    certified. Probe (7m) and re-run (8m) both ended in hook-runner SIGKILL
    with NO runner PASS JSON because the run DEADLOCKS (see the product-finding
    note below) — it never completes regardless of wall. Its wall_min stays at
    the pre-existing 7 m until the product regression is fixed and the cell is
    re-certified by a later story.
- Aggregate consequence: the tier0-case-manifest self-test wall budget
  (sum caps.wall_min <= N) moved 181 -> 186 (five certified +1 bumps). Product
  reason: scripted retry corridors now include the extra auditor round.

### 3. PRODUCT FINDING (no pin/asset edit): w4.35-retry-rebased-true-green deadlocks on the corrected product

- Symptom: the cell never emits its runner PASS JSON at any wall (probe at
  7 m = 420 s SIGKILL; re-run at 8 m = 480 s SIGKILL; an instrumented run at
  10 m was still deadlocked when observed at ~8 m and was killed). The run DB
  shows `fix` (the RSTY loop) stuck `running` with `verify` `pending` and
  `deception_audit`/`test_cmd_review` `waiting`; the scheduler spawns a
  verifier round every 15 s that heartbeats NO_WORK ("claim returned NO_WORK
  after HAS_WORK peek", 17 heartbeat-only verifier spawns, zero real verifier
  work), forever.
- Root cause (WAVE-A 09c10ce5 product regression): the retry-cell scenario
  runner (torture-test/scenarios/w4.35/run-retry-cell.mjs, a2ecb49c-era)
  turns `fix` into a verify_each story loop (`type: loop`, `over: stories`,
  `verify_step: verify`) whose story verification runs through the top-level
  `verify` step. claimStep's predecessor filter
  (src/installer/step-ops.ts:2663+, "prev.status NOT IN ('done','skipped') AND
  NOT (prev.type='loop' AND prev.status='running' AND prev.current_story_id IS
  NULL)") lets `verify` be claimed while the loop is paused. WAVE-A inserted
  the conditional `deception_audit` step BETWEEN `fix` and `verify` in
  bug-fix-merge-worktree (pre-WAVE-A order was fix -> verify -> finalize_merge;
  post-WAVE-A it is fix -> deception_audit -> verify -> test_cmd_review ->
  finalize_merge). `verify` now has a SECOND incomplete predecessor —
  `deception_audit`, stuck `waiting` because it can only run after the fix loop
  completes, which can only complete after its stories are verified, which
  requires `verify`, which is unclaimable. The exception exempts only the
  paused loop itself, not intermediate waiting steps, so `verify` is never
  claimable and the loop never resumes. peekStep (pending-count, no dependency
  filter) keeps reporting HAS_WORK, so the motor spawns NO_WORK verifier
  heartbeats every 15 s indefinitely; cleanupAbandonedSteps deliberately skips
  paused loops whose verify step is pending (step-ops.ts:1369-1385), so no
  sweeper recovers the run. run status stays `running` until the case wall
  SIGKILLs it.
- Impact: on the corrected product (WAVE-A + WAVE-B.1 + CRED-SURF) the RSTY
  true-green cell cannot reach ANY of its corridor pins (including the new
  reviewer_auto_completed / auditor_invocations / auditor_auto_completed
  values added above) — the fix loop never completes, so deception_audit never
  even dispatches. This also blocks the US-012 tier-0 33/33 gate for this one
  cell.
- Required product fix (NOT in torture-test/ scope — this story touches no
  product code per the S58 constraint): the verify_each pause protocol must
  treat steps between a paused loop and its verify step as non-blocking (e.g.
  extend the claimStep / autoCompleteConditionalStep predecessor exception to
  also exempt waiting conditional steps that sit between the paused loop and
  the verify step, or otherwise route verify_each without requiring verify to
  be the loop's immediate successor). WAVE-A.1 making deception_audit
  unconditional does NOT by itself fix this — any step between the loop and
  verify blocks the pause regardless of conditionality.
- This finding is reported, not pin-edited: no expected_route value was
  loosened, no scenario asset was weakened, and the true-green wall_min was
  left at its pre-existing value because no runtime was certified.


---

## US-004 — w4.35 'failed' verdict family (6 cells)

Cells: w4.35-failed-rebased-{absent,true}-{green,missing,red}.

### 1. ADDITIVE expected_route pins: reviewer_auto_completed / auditor_invocations / auditor_auto_completed

- Values (all six cells): `reviewer_auto_completed: 1`,
  `auditor_invocations: 1`, `auditor_auto_completed: 0`.
- Product reason: identical to the US-002 done-family and US-003 retry-family
  pins — WAVE-A conditional steps execute on the corrected product. Every
  failed-family cell is a CANNOT_REPRODUCE cell (US-001: the scripted fixer
  emits the canonical CANNOT_REPRODUCE line, no cell demonstrates a failing
  baseline), so the fix completion handler sets deception_audit_required and
  the auditor dispatches exactly ONE read-only round (VERDICT: HONEST -> done,
  auto_completed=0); test_cmd_review_required stays unset (no TEST_CMD rewrite
  in any failed cell) so the reviewer auto-completes (auto_completed=1) with
  zero step.running events and reason `condition_unset:test_cmd_review_required`.
  The failed corridor (merger STATUS: failed verdicts -> bounded RAMP reroutes
  of the verify -> finalize_merge span, exhausted at reroute_count 8) never
  re-pends the upstream fix/deception_audit span, so the auditor still
  dispatches exactly once.
- Mirrored into cases/tier0.jsonl `context.scenario_expected_route` (exact
  deep equality, same key order, enforced by tt-tier0-assets) and into the
  deepEqual pin in self-tests/w4.35-failed-matrix.test.ts, which also gained
  the runner source-guards (worktree cleanup precedes invariants; the runner
  reads test_cmd_review/deception_audit step rows and asserts the
  auto-completion and invocation-count facts).
- Runner: run-failed-cell.mjs now asserts (from the run DB) the reviewer
  auto-complete reason `condition_unset:test_cmd_review_required`, zero
  reviewer step.running events, and the pinned auditor invocation count and
  auto-completion flag. No pre-existing pin value changed.

### 2. caps.wall_min bumps: all six failed cells 6 -> 7 (certified)

- Product reason: the WAVE-A auditor round extends each failed corridor past
  its pre-WAVE-A wall. On the corrected product the six w4.35-failed-* cells
  measure ~360.0 s natural against a 360 s (6 m) budget: the runner emits its
  final PASS JSON at the exact deadline and the hook runner SIGTERMs the case
  before process exit can be reaped (command.result.json: exit_code null,
  signal SIGTERM, "case wall limit reached"; PASS JSON present as the last
  stdout line). Verified live on w4.35-failed-rebased-absent-green
  (run-9f2b21d4, wall 360008 ms, PRODUCT_FAIL solely from the deadline reap;
  runner output confirmed every semantic fact: explicit-failure-reroute-
  exhausted, reroute_events 8, merger_invocations 9, verifier_invocations 9,
  suite_rows 1, reviewer_auto_completed 1 / auditor_invocations 1 /
  auditor_auto_completed 0, tokens 0, system_tokens_spent 0). Raising each
  wall to 7 m restores a ~60 s margin, matching how US-003 treated the retry
  family. All six cells re-certified at the 7 m budget:
  `./run-torture-test --tier0 --case <id>` exits 0 (PASS, zero tokens).
  Runtime-budget adjustment only: every semantic invariant
  (explicit-failure-reroute-exhausted, reroute_count 8, reroute_events 8,
  terminal_reroute_count 0|1, ledger_concession_count 0|1,
  merger_invocations 8|9, verifier_invocations 9, suite_rows 0|1|9,
  system_tokens_spent 0, must-not-land) is unchanged and still asserted.
- Aggregate consequence: the tier0-case-manifest self-test wall budget
  (sum caps.wall_min <= N) moved 186 -> 192 (six certified +1 bumps). Product
  reason: scripted failed corridors now include the extra auditor round.

---

## US-005 — w4.35 'missing-status' verdict family (6 cells)

Cells: w4.35-missing-status-rebased-{absent,true}-{green,missing,red}.

### 1. ADDITIVE expected_route pins: reviewer_auto_completed / auditor_invocations / auditor_auto_completed

- Values (all six cells): `reviewer_auto_completed: 1`,
  `auditor_invocations: 1`, `auditor_auto_completed: 0`.
- Product reason: identical to the US-002 done-family, US-003 retry-family and
  US-004 failed-family pins — WAVE-A conditional steps execute on the corrected
  product. Every missing-status cell is a CANNOT_REPRODUCE cell (US-001: the
  scripted fixer emits the canonical CANNOT_REPRODUCE line, no cell
  demonstrates a failing baseline), so the fix completion handler sets
  deception_audit_required and the auditor dispatches exactly ONE read-only
  round (VERDICT: HONEST -> done, auto_completed=0);
  test_cmd_review_required stays unset (no TEST_CMD rewrite in any
  missing-status cell — the merger's lost-STATUS behavior never touches
  TEST_CMD) so the reviewer auto-completes (auto_completed=1) with zero
  step.running events and reason `condition_unset:test_cmd_review_required`.
  The missing-status corridor (merger no-STATUS exits -> bounded lost-output
  reroutes of finalize_merge, exhausted at reroute_count 8 with a terminal
  step.timeout) never re-pends the upstream fix/deception_audit span, so the
  auditor still dispatches exactly once.
- Mirrored into cases/tier0.jsonl `context.scenario_expected_route` (exact
  deep equality, same key order, enforced by tt-tier0-assets) and into the
  deepEqual pin in self-tests/w4.35-missing-status-matrix.test.ts, which also
  gained a runner source-guard asserting the runner reads the
  test_cmd_review/deception_audit step rows and asserts the auto-completion
  and invocation-count facts.
- Runner: run-missing-status-cell.mjs now asserts (from the run DB) the
  reviewer auto-complete reason `condition_unset:test_cmd_review_required`,
  zero reviewer step.running events, and the pinned auditor invocation count
  and auto-completion flag; the summary JSON carries the three new facts. No
  pre-existing pin value changed.

### 2. caps.wall_min bumps: all six missing-status cells 6 -> 7 (certified)

- Product reason: the WAVE-A auditor round extends each missing-status
  corridor past its pre-WAVE-A wall, exactly like the retry (US-003) and
  failed (US-004) families. Probe on w4.35-missing-status-rebased-absent-green
  at the pinned 6 m (360 s) budget reproduced the same signature:
  command.result.json exit_code null, signal SIGTERM, "case wall limit
  reached" at wall 360000 ms (run-0e0b816b, campaign-20260902T210401114Z),
  with the runner's final PASS JSON already on stdout (reviewer_auto_completed
  1 / auditor_invocations 1 / auditor_auto_completed 0 / reroute_events 8 /
  merger_invocations 9 / lost_output_invocations 9 / suite_rows 1 /
  system_tokens_spent 0) — the case was SIGTERM'd before process exit could
  be reaped, not a route failure. Raising each wall to 7 m restores a ~60 s
  margin. All six cells re-certified at the 7 m budget:
  `./run-torture-test --tier0 --case <id>` exits 0 (PASS, zero tokens) —
  absent-green run-8ef4d42b 363.4 s, absent-missing run-747ac7ed 363.6 s,
  absent-red run-3b15481d 363.3 s, true-green run-ab20f497 363.7 s,
  true-missing run-dfb89658 363.1 s, true-red run-4c55517f 362.5 s; each
  runner PASS summary carries reviewer_auto_completed 1 / auditor_invocations
  1 / auditor_auto_completed 0. Runtime-budget adjustment only:
  every semantic invariant (lost-output-reroute-exhausted, reroute_count 8,
  reroute_events 8, terminal_reroute_count 0|1, ledger_concession_count 0|1,
  merger_invocations 8|9, lost_output_invocations 8|9, verifier_invocations 9,
  suite_rows 0|1|9, system_tokens_spent 0, must-not-land, no overlapping
  dispatches) is unchanged and still asserted by the runner.
- Aggregate consequence: the tier0-case-manifest self-test wall budget
  (sum caps.wall_min <= N) moved 192 -> 198 (six certified +1 bumps). Product
  reason: scripted missing-status corridors now include the extra auditor
  round.

## US-006 — W0.2-scripted-e2e (standalone re-certification)

### 1. run-w0.2 seeds the contained stub ~/.pi (scenario-asset hermeticity fix)

- Change: `torture-test/cases/hooks/run-w0.2` now mirrors run-w0.1's stub
  seeding — `mkdir -p "$HOME/.pi/agent"` + a stub
  `settings.json` (`defaultProvider: stub`) written under the contained HOME
  before the e2e battery runs.
- Product reason: the smoke e2e battery (`run-all-e2e-tests` →
  workflows-smoke.test.ts) includes a createTempHome helper unit test whose
  `linkRealAgentDirs: true` path asserts `os.homedir()/.pi` exists
  (`Real ~/.pi must exist at <contained home>/.pi`). Under the standalone
  `--case W0.2-scripted-e2e` run the contained scripted home
  (var/home-scripted) has no operator ~/.pi, so that unit test failed. In a
  full tier0 ladder the case passed only because W0.1-build-unit ran first and
  seeded the same stub into the shared campaign home (ordering side-effect).
  run-w0.2 must be self-contained/hermetic like run-w0.1, so it now seeds the
  identical deterministic, non-secret stub. No semantic pin changed; the
  fixture (hook) is a torture-test asset only. Verified: with the stub present
  the full battery passes 79/79 + stress 1/1 (zero tokens).

### 2. caps.wall_min 3 -> 5 for W0.2-scripted-e2e (certified)

- Product reason: the corrected-product e2e battery under W0.2
  (npm build + run-all-e2e-tests 6-file node test + workflows-stress-
  concurrent) now measures ~235-238 s natural, exceeding the 3-minute
  (180 s) pre-WAVE-A-era wall pin. The first standalone re-certification
  attempt was SIGTERM'd at the exact 180 s deadline (command.result.json:
  exit_code null, signal SIGTERM, "case wall limit reached") while the smoke
  battery was still running (node --test alone reported 205 s duration).
  Raising the wall to 5 minutes (300 s) restores a ~60 s margin. Re-certified
  GREEN: `./run-torture-test --tier0 --case W0.2-scripted-e2e` exits 0 (PASS,
  wall 238166 ms, zero tokens, all 79 smoke tests + stress-concurrent green,
  run-… campaign-20260902T234523378Z). Runtime-budget adjustment only — the
  battery's tests all pass; no assertion or expected outcome was loosened.
- Aggregate consequence: the tier0-case-manifest self-test wall budget
  (sum caps.wall_min <= N) moved 198 -> 200 (W0.2 +2).

### 3. PRODUCT FINDING — W0.1-build-unit is RED on this branch (no pin edit)

- Re-certification result: `./run-torture-test --tier0 --case W0.1-build-unit`
  exits 1 (PRODUCT_FAIL, O3z command_passed=false) —
  campaign-20260902T235215895Z-f4174f10, 9m19s, zero tokens. The parallel
  lane passes 2241/2241, but the SERIAL lane fails closed with 4x
  `[port-bind] 3339 — control plane` guard-ledger violations attributed to
  `(unknown)`.
- Classification: GENUINE PRODUCT FINDING — NOT a stale torture-test scenario
  asset, so no pin is edited. Evidence:
  1. The scenario asset under test is byte-identical to main:
     `torture-test/cases/hooks/run-w0.1` and the `W0.1-build-unit` entry in
     `cases/tier0.jsonl` (wall_min 17, oracle O3z, expected_command_outcome
     PASS) diff EMPTY against `main`. Nothing S58 touched explains the red.
  2. The failing lane is the product's own two-lane suite: run-w0.1 executes
     `npm run build && npm test` (PRLL serial+parallel), and the serial-lane
     guard ledger catches 4x production control-port binds (3339) emitted by
     `src/installer/harness-type.test.ts` (a PRODUCT test file), which spawns
     a daemon child binding the production control plane when
     `TAMANDUA_CONTROL_PORT` is unset (run-w0.1 unsets it so the repo suite
     owns isolated state/random listener ports).
  3. Main fixed exactly this: commit 26993ab0 (TISO.1, e6c285de task)
     "isolate serial-lane daemon spawns from production port 3339 and
     attribute child ledger entries" (src/installer/harness-type.test.ts
     +111, src/lib/test-guard.ts, src/server/daemonctl.ts, tests/). That
     product fix is NOT on this branch: the branch's merge-base with main is
     741feb3b (2026-09-02 ~11:02, CRED-SURF), and 26993ab0 landed on main
     later (~17:41) — `git merge-base --is-ancestor 26993ab0 HEAD` fails.
  4. The same 4x 3339 violations appear in PRE-S58 evidence (15:44-era W0.1
     runs predating S58 US-001..005), so this is not an S58 regression.
- Disposition: reported, NOT pin-edited, per the S58 rule (never loosen a pin;
  a red cell after parity that the added steps do not explain is a product
  finding to report). Fixing it requires product code (TISO.1-style isolation
  of harness-type.test.ts), out of S58 torture-test/-only scope; the fix is
  expected to arrive with main (26993ab0) at branch merge. No scenario asset
  was weakened and no wall/pin was loosened for W0.1 (wall_min stays 17).

## US-007 — Roster/fix-step parity guard + assets-invalid becomes a RED gate

No expected_route / manifest / wall pin changed. This story changes the
AVAILABILITY SEMANTICS of the tier gates (bin/tt-run) and extends the asset
validators, with one TEST expectation change in bin/tt-controller.test.sh:

### 1. tt-run availability: 'assets present but INVALID' is now RED (exit 1),
not the confusing exit-3 'Tier ... unavailable' (product reason)

- Pre-S58, `tier_available` ran each tier's asset validator with stderr
  swallowed (`>/dev/null 2>&1`) and `run_tier` mapped every failure to
  exit 3 "Tier '$tier' is unavailable because its required assets are not
  installed or valid" (tt-run:217-221 pre-change). That masked the S58 drift:
  WAVE-A's roster/fix-expects change made tt-tier0-assets fail, which
  surfaced as exit 3 "not implemented" — so the tier-0 ladder was reported
  NOT-YET-IMPLEMENTED instead of RED, and the scenario drift stayed invisible
  until WAVE-B.1's US-006 probe.
- Post-S58, tt-run distinguishes THREE states:
  - `absent` — a prerequisite (validator binary / case manifest) is missing:
    genuinely NOT YET IMPLEMENTED, requested run exits 3 (unchanged
    semantics, reworded message).
  - `invalid` — prerequisites exist but a validator exits non-zero: the gate
    is RED, the requested run exits 1 and prints the validator's CAPTURED
    stderr (its named reason; never swallowed).
  - `available` — prerequisites exist and validators are green.
- `usage()` shows the third state (`[INVALID - asset gate red]`); an
  invalid-asset tier is never advertised as NOT YET IMPLEMENTED.
- Test-expectation consequence (documented product reason, not a loosened
  pin): bin/tt-controller.test.sh's launcher battery asserted that an invalid
  scenario library (chmod -x on a scenario run.sh) made tt-run --help mark
  tier0 `[NOT YET IMPLEMENTED]` and `tt-run --tier0` exit 3. Under the new
  semantics that state is INVALID: --help must mark `[INVALID`, --tier0 must
  exit 1 (RED) and stderr must carry the validator's "not executable"
  reason. The genuinely-absent branch (validator binary or manifest moved
  aside) still asserts `[NOT YET IMPLEMENTED]` + exit 3. These were
  behavioral-correction edits to the launcher TEST, matching the story's
  requirement that invalid assets are never reported as not-implemented; no
  scenario/manifest/route pin was touched.

### 2. tt-tier0-assets / tt-tier2-assets now run the scenario<->workflow
parity guard at GATE time (roster + WAVE-A fix-expects) — product reason:
a roster/fix-expects drift must flip the gate red with a named reason when
the tier is requested, instead of surfacing only at scenario runtime.

- New self-contained guard: scenarios/lib/scenario-workflow-parity.mjs
  (exported workflowAgents parse shared with validate-scenario.mjs):
  (a) behaviors.json agent keys exactly equal the `- id:` roster of
      workflows/<workflow_base>/workflow.yml; (b) when any step's expects
      contains the WAVE-A `(REPRO_EVIDENCE|CANNOT_REPRODUCE)` contract,
      every output-bearing canned invocation of that step's agent satisfies
      `^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\s*\S+`.
- tt-tier0-assets: after validateScenario, each manifest-referenced cell is
  parity-checked (module-derived repoRoot, matching validate-scenario).
- tt-tier2-assets: every scenario_path-referencing case is now validated
  through validate-scenario.mjs (roster + metadata) AND the parity guard,
  with repoRoot resolved via `git rev-parse --show-toplevel` (fail-closed),
  so scratch-copy tests (own git checkout) validate against the copy's own
  workflows/ dir.
- Scratch-copy test fixtures were extended to carry the validation surface
  they now exercise (bin/tt-tier2-assets.test.sh Test 20 and
  self-tests/tier2-tier2-assets.test.ts AC4): they copy
  scenarios/lib/{validate-scenario,scenario-workflow-parity,tracked-tree}.mjs,
  the scenario CELL (w4.21/bare-noninteractive-launch — the references were
  changed from the wave container dir, which is not a valid cell, to the real
  cell dir like the real tier2.jsonl), the bundled bug-fix-merge-worktree
  workflow.yml, and the O1/O3z/O11 oracle executables named by the cell's
  metadata. The tracked-tree red/green arms are unchanged in intent.
- bin/tt-controller.test.sh launcher copies scenario-workflow-parity.mjs into
  launcher_root/scenarios/lib (tt-tier0-assets imports it).

### 3. New guard self-test: self-tests/tier0-scenario-workflow-parity.test.ts

- Green arm: all 54 scenario cells referenced by cases/tier0.jsonl +
  cases/tier2.jsonl (29 + 25 unique dirs) pass roster parity, and the 39
  bug-fix-merge-worktree cells (24 w4.35 + 15 tier2) each satisfy the
  fix-expects marker check.
- Red arms (temp copies only, real tree never modified): a workflow.yml
  gaining a phantom agent id, a behaviors.json gaining a stale agent key, and
  a behaviors.json whose fixer output lost the CANNOT_REPRODUCE marker each
  report a NAMED mismatch.
- No pin was loosened anywhere; no scenario asset weakened.
## US-008 — Tier-2 scripted sweep A (W4.04c, W4.36, W4.39-a, W4.46) on the corrected assets

### 1. ORACLE CALIBRATION (asset change, NOT a pin loosening): O11 output-contract leg models the WAVE-A conditional auto-completion corridor

- Asset changed: torture-test/oracles/lib/o11.mjs (readDatabaseState),
  torture-test/oracles/lib/o11-output-contract.mjs (done-step leg),
  torture-test/tamandua-torture-test-spec/03-oracles.md (O11 contract text),
  torture-test/oracles/self-test/generate-o11-fixtures.mjs + o11.test.mjs
  (two new fixtures).
- Finding that prompted it: the first Tier-2 scripted sweep re-certification of
  W4.04c-keyline-laundering on the corrected product
  (campaign-20260903T032736122Z-72338be0, run-56e07a12, verdict PRODUCT_FAIL)
  reds O11 with a single `O11_DONE_WITHOUT_EXPECTS_SUCCESS` on step
  `test_cmd_review` (step_row 1e3cb7db, status done, type conditional,
  auto_completed=1, auto_complete_reason=`condition_unset:test_cmd_review_required`,
  observed 0 successful done transitions, dispatches []). Every other step and
  every other oracle (O1/O3z/O8/O9) passed; the corridor itself completed
  (8/8 steps done, finalize_merge landed, zero tokens).
- Product reason: WAVE-A (09c10ce5) added the conditional-step primitive. When a
  conditional step's activation condition is unset, the dispatch motor
  AUTO-COMPLETES it in-process (`steps.auto_completed=1`,
  `auto_complete_reason='condition_unset:<key>'`, a `step.auto_completed` event,
  then `step.done`) with ZERO dispatches — there is no agent output, so the
  step's expects clause is never validated BY DESIGN (it governs only a real
  dispatch, e.g. a TEST_CMD rewrite that sets `test_cmd_review_required`). The
  scenario assets already pin this corridor as the expected route
  (reviewer_auto_completed=1, US-002..US-005); O11 predates WAVE-A and could not
  distinguish a legitimate zero-dispatch auto-completion from a dispatch that
  completed without satisfying its expects, so it false-positived every
  WAVE-A workflow run that auto-completes the reviewer (all Tier-1/Tier-2
  bug-fix-merge-worktree scripted workflow cells with O11 declared). This is an
  oracle-calibration asset fix (same class as the S22A loop/reroute and E3.B S6
  O11 loop-model realignments), NOT a pin loosened: the per-dispatch
  accepted-done invariant is UNCHANGED for every step that actually dispatched
  (auto_completed=0), and the corridor gains THREE new fail-closed additive
  checks — an auto-completed step must be `type='conditional'` with a nonempty
  `condition_unset:` reason (`O11_AUTOCOMPLETED_DISPOSITION_INVALID`), and it
  must carry ZERO dispatch-rendering (`O11_AUTOCOMPLETED_STEP_DISPATCHED`) and
  ZERO expects-validation (`O11_AUTOCOMPLETED_STEP_VALIDATED`) telemetry, since
  auto-completion never claims, renders, or validates. Evidence snapshots
  captured before WAVE-A (no `auto_completed` column) replay unchanged (the
  columns are read optionally).
- Proof: two new O11 self-test fixtures (`o11-auto-completed-conditional` PASS —
  the auto-completed reviewer with zero telemetry; `o11-auto-completed-
  contradiction` FAIL — the same corridor carrying an expects validation reds
  `O11_AUTOCOMPLETED_STEP_VALIDATED`), plus the offline evidence replay of the
  stored W4.04c campaign: O11 FAIL->PASS, all other oracles byte-unchanged,
  zero invoke failures (tt-oracle-replay, same class of proof as E3.B's delta
  table). The live tier2 re-certification of W4.04c exits 0 afterwards.

### 2. W4.46 scenario asset fix: setup TEST_CMD marker aligned to the launch-declared contract (no spurious TEST_CMD rewrite)

- Asset changed: torture-test/scenarios/w4.46/provider-error-rounds/behaviors.json —
  the setup behavior output marker `TEST_CMD: true` became `TEST_CMD: npm test`.
- Finding that prompted it: the first W4.46 re-certification after the O11 fix
  (campaign-20260903T041410064Z-13cab19a, run-539e3cd8) stalled at finalize_merge:
  the workflow completed 7/8 steps in ~2m16s, then emitted `merge.refused_review_pending`
  every 15s ("A TEST_CMD rewrite is pending review (or was rejected) — finalize_merge
  is refused until the review ACCEPTs") for 12m42s until the controller's 15m wall
  deadline canceled the run (TEST_INFRA_FAIL, 0 tokens). Root cause: W4.46's case row
  declares `test_cmd: npm test` and the run's launch context establishes it
  (runs.test_cmd_established='npm test', source='launch'), but the cell's canned setup
  output emitted `TEST_CMD: true`; the WAVE-A TCMD detector (09c10ce5) therefore
  recorded a rewrite ('npm test' -> 'true', step setup, round 1), set
  test_cmd_review_required, and dispatched the conditional reviewer — a corridor this
  cell never intended (its contract is the provider-error retry discipline, section-K).
- Product reason: under the WAVE-A TCMD contract the launch-declared test_cmd is the
  established contract, and any DIFFERING step-emitted marker is a rewrite requiring
  review. Every other US-008 cell's canned setup marker already equals its declared
  contract (W4.04c/W4.36 `npm test`==`npm test`; W4.39-a `./run-all-tests`==
  `./run-all-tests`), so the reviewer auto-completes and the merge proceeds. W4.46's
  `TEST_CMD: true` was a pre-WAVE-A free-form marker (used so the verifier's
  `{{input.TEST_CMD}}` command stays instant) that accidentally trips the review gate.
  Aligning it to the declared `npm test` restores the S58-design corridor: no rewrite
  is detected, the reviewer auto-completes (auto_completed=1,
  condition_unset:test_cmd_review_required), and finalize_merge lands. No pin was
  loosened; the cell's provider-error discipline (429/529/mid-stream-drop retried, 0
  tokens) is untouched.

### 3. PRODUCT FINDING (no pin/asset loosened): an annotated `VERDICT: ACCEPT` review passes the step expects but never routes — finalize_merge refuses forever

- Evidence: run-539e3cd8 (W4.46 re-certification above). The dispatched reviewer's
  canned output `STATUS: done` + `VERDICT: ACCEPT - scripted scenario TEST_CMD contract
  unchanged (no rewrite to review)` satisfied the workflow.yml test_cmd_review expects
  (`regex:^VERDICT:\s*(ACCEPT|REJECT)` — no end anchor), so step.expects.validated
  accepted, step.done advanced the pipeline, and the reviewer step row ended done with
  retry_count 0. But the product's review router (src/installer/step-ops.ts
  routeTestCmdReviewVerdict) requires the parsed VERDICT VALUE to uppercase to EXACTLY
  'ACCEPT'/'REJECT'; the annotated value
  'ACCEPT - scripted scenario ...' does not route, so test_cmd_review_required is never
  cleared (confirmed in the run DB context: review_required=true, candidate='true',
  rewriter='setup' at terminal). finalize_merge then refuses (merge.refused_review_pending,
  FAILURE_CLASS: refused_review_pending) every 15s FOREVER — the run has no re-review,
  no retry exhaustion, no failure: the merger step stays pending with retry_count 0
  until an external wall cap kills the run.
- Why reported, not fixed: the S58 chain is torture-test/-only (no product code). The
  W4.46 corridor is made green by the section-2 scenario fix (removing the spurious
  rewrite), so the case is not blocked on product work. But the underlying hazard
  remains: a reviewer output that legitimately passes the workflow's OWN declared
  expects (annotated ACCEPT) permanently deadlocks the merge gate with no recovery
  path. A real reviewer persona is instructed to emit the bare token (per WAVE-A
  approved prompts), yet the workflow expects contract does not enforce it, so this is
  a genuine WAVE-A contract/routing gap for product review (candidate hardening: either
  route prefix-annotated verdicts by tokenizing the first word, or anchor the workflow
  expects with `regex:^VERDICT:\s*(ACCEPT|REJECT)\s*$`).
## US-009 — Tier-2 scripted sweep B (W4.11, W4.21, W4.24, W4.44a, W4.44b) on the corrected assets

Cells re-certified one at a time on the corrected product (WAVE-A 09c10ce5 +
WAVE-B.1 791e45df + CRED-SURF roster), each `./run-torture-test --tier2
--case <id>`, zero tokens:

- W4.44a-double-tap PASS 2m4s (campaign-20260903T053705637Z-995e5bba) — unchanged assets
- W4.11-sigkill-launch-matrix PASS 1m8s (campaign-20260903T054552967Z-88191fe3) — unchanged assets
- W4.21-bare-noninteractive-launch PASS 2m4s (campaign-20260903T054708118Z-d0497f36) — unchanged assets
- W4.44b-post-success-immunity PASS 2m19s (campaign-20260903T054919334Z-b395ea08) — after asset fix below
- W4.24-serial-lane-concurrent TT corridor GREEN after asset fix below; case RED
  on the serial-lane isolation ledger — PRODUCT FINDING (section 2), no pin
  loosened. Campaign-20260903T055145727Z-5dfd280e, 9m50s, 0 tokens: the two TT
  runs BOTH completed (runs 97437e8b / 6f616037, status completed, tokens 0,
  worker_lost_count 0) and every TT/daemon-recovery assertion passed; the cell
  fails at the final lane assertion (run-serial-lane-concurrent.mjs:375) because
  the product's own serial lane exited 1.

### 1. Scenario asset fix (W4.24 + W4.44b): setup TEST_CMD marker aligned to the launch-declared contract

- Assets changed: torture-test/scenarios/w4.24/serial-lane-concurrent/behaviors.json
  and torture-test/scenarios/w4.44/post-success-immunity/behaviors.json — the
  setup behavior output marker `TEST_CMD: true` became `TEST_CMD: npm test`
  (single-line marker change; roster, fixer CANNOT_REPRODUCE marker, tokens, and
  every other canned output untouched).
- Finding that prompted it (W4.44b red, live evidence): the first W4.44b
  re-certification (campaign-20260903T053923505Z-1929f505,
  run-78b2f056-7404-4934-9a98-35e75a9c11a8, PRODUCT_FAIL 5m18s, 0 tokens)
  asserted "the bfmw run must land successfully (got running)" at
  run-post-success-immunity.mjs:127. The run's event stream shows the same
  W4.46 deadlock signature: `test_cmd.rewrite_detected` (step setup,
  'npm test' -> 'true', round 1) followed by 14x `merge.refused_review_pending`
  every 15s, 7/8 steps done (test_cmd_review dispatched once), finalize_merge
  never landing, no terminal state before the 5m --wait expired.
- Product reason: identical to US-008 section 2. Both cells launch their bfmw
  run with `--context test_cmd=npm test` (W4.24 run-serial-lane-concurrent.mjs,
  W4.44b run-post-success-immunity.mjs), so runs.test_cmd_established='npm test'
  (source 'launch') is the WAVE-A TCMD contract. The canned setup output
  `TEST_CMD: true` is a pre-WAVE-A free-form marker; under WAVE-A the differing
  marker records a rewrite and dispatches the conditional reviewer. The
  reviewer's canned annotated `VERDICT: ACCEPT - ...` output passes the
  workflow.yml expects regex (`regex:^VERDICT:\s*(ACCEPT|REJECT)` — no end
  anchor) but never routes through routeTestCmdReviewVerdict (the exact-token
  product finding of US-008 section 3), so test_cmd_review_required is never
  cleared and finalize_merge refuses forever. Aligning each cell's setup marker
  to the declared `npm test` restores the intended corridor: no rewrite is
  detected, the reviewer auto-completes (auto_completed=1,
  condition_unset:test_cmd_review_required), and finalize_merge lands.
- Proof for W4.24 (whose corridor also requires the TT runs to complete while
  the host serial lane runs): after the fix, both W4.24 TT runs completed
  (status completed, tokens_spent 0, worker_lost_count 0,
  test_cmd_established='npm test', source 'launch' — read from the run DB).
- No pin was loosened: no scenario.json / cases/tier2.jsonl pin changed; only
  the canned marker was corrected to match each cell's own declared contract.

### 2. PRODUCT FINDING (no pin/asset loosened): W4.24's serial-lane leg fails on any tree without the main-only TISO.1 fix (26993ab0)

- Evidence: campaign-20260903T055145727Z-5dfd280e (W4.24 re-certification after
  the section-1 fix). All TT assertions passed; the cell fails at the final
  assertion "the product serial lane must exit 0 on a healthy tree ... wall
  572s". The lane's own summary shows tests 3451 / pass 3450 / fail 0 / skipped
  1 — every product test PASSED — but scripts/run-serial-tests.sh exits 1
  because the guard ledger recorded 4x `[port-bind] 3339 — control plane`
  violations attributed to `(unknown)`.
- Root cause: identical to the US-006 W0.1-build-unit product finding. The
  serial lane includes src/installer/harness-type.test.ts (tests/serial-files.txt
  line 44), which spawns a daemon child that falls back to the DEFAULT control
  port 3339 when TAMANDUA_CONTROL_PORT is unset; the bind guard-fires and the
  four un-attributed ledger entries fail the lane. Main fixed exactly this in
  26993ab0 ("fix: isolate serial-lane daemon spawns from production port 3339
  and attribute child ledger entries"), which is NOT on this branch: the branch
  merge-base is 741feb3b (CRED-SURF, 2026-09-02 ~11:02) and
  `git merge-base --is-ancestor 26993ab0 HEAD` fails (26993ab0 landed on main
  ~17:41). The W4.24 lane runs under a CLEANED host env (cleanLaneEnv strips
  every TAMANDUA_* variable, HOME = the operator's account home), so
  TAMANDUA_CONTROL_PORT is genuinely unset for the lane — the exact condition
  the main fix targets. Pre-S58 evidence (the 15:44-era W0.1 runs and this
  branch's W0.1 re-certification in US-006) shows the identical 4x 3339
  violations, so this is not an S58 regression and not a concurrency artifact of
  the W4.24 corridor (W0.1 reproduces it with no TT runs).
- Why reported, not fixed: the S58 chain is torture-test/-only (no product
  code). Fixing it inside the cell (e.g. seeding TAMANDUA_CONTROL_PORT into the
  lane) would mask the product's isolation gap and violate the cell's own
  no-cross-talk contract (the lane must run in a pristine developer env).
  Expected to go green when main merges into this branch (bringing 26993ab0);
  the corrected scenario assets (section 1) already make the TT corridor green.
- The US-008 section-3 product finding (annotated ACCEPT never routes -> merge
  gate deadlock with no recovery) is re-confirmed by W4.44b's pre-fix red run
  and remains a product finding, not fixed here (torture-test/-only scope).

---

## US-010 — Tier-2 scripted sweep C (W4.40 x4, W4.41 x2) on the corrected assets

Cells re-certified one at a time on the corrected product (WAVE-A 09c10ce5 +
WAVE-B.1 791e45df + CRED-SURF roster), each `./run-torture-test --tier2
--case <id>`, zero tokens:

- W4.40-delayed-trailer: RED first (pre-fix deadlock evidence below), then
  PASS 1m50s after the section-1 fix (campaign-20260903T070126792Z-98f4bc60,
  run fc3b0eec: completed, 8/8 steps done, tokens 0, test_cmd 'npm test'
  source launch, reviewer auto_completed=1
  condition_unset:test_cmd_review_required, auditor dispatched once
  auto_completed=0).
- W4.40-malformed-trailer: PASS 1m50s (campaign-20260903T070347917Z-1ae816d3).
- W4.40-oversized-stdout: PASS 1m50s (campaign-20260903T070557964Z-76b27007).
- W4.40-trailer-absent: PASS 1m50s (campaign-20260903T070809185Z-2946c590).
- W4.41-login-shell-tier: RED first (same pre-fix deadlock signature), then
  PASS 1m50s after the section-1 fix (campaign-20260903T072203851Z-e6d33e38).
- W4.41-all-tiers-fail: PASS 1m50s (campaign-20260903T072414723Z-df1222db,
  run 210edfcf: completed 8/8, tokens 0). The manifest row's
  scenario_expected_outcome 'failed' is descriptive metadata (no oracle or
  controller code enforces it — verified by grep over oracles/ and
  tt-controller); the pre-S58 certification of this cell was likewise a
  completing bfmw corridor, so the completed run is the established shape.

### 1. Scenario asset fix (all six cells): setup TEST_CMD marker aligned to the launch-declared contract

- Assets changed (one-line marker change each; roster, fixer CANNOT_REPRODUCE
  marker, tokens, per-arm stream directives (delayed_trailer_ms /
  oversized_stdout_mb / omit_trailer / malformed_trailer), and every other
  canned output untouched):
  - torture-test/scenarios/w4.40/{delayed-trailer,malformed-trailer,
    oversized-stdout,trailer-absent}/behaviors.json
  - torture-test/scenarios/w4.41/{all-tiers-fail,login-shell-tier}/
    behaviors.json
  - Change: canned setup output `TEST_CMD: true` -> `TEST_CMD: npm test`.
- Finding that prompted it (live RED evidence, W4.40-delayed-trailer first
  re-certification, campaign-20260903T065033857Z-c5276ad0, run
  d37b97e0-ef21-40f0-8fc2-21b1dfdfd866): the run reached 7/8 done in ~90s
  (test_cmd_review DISPATCHED, auto_completed=0), then finalize_merge refused
  every 15s (33x `merge.refused_review_pending`, 1x `test_cmd.rewrite_detected`
  in the run event stream) until the 10m wall deadline-expired the case
  (TEST_INFRA_FAIL, 600s). W4.41-login-shell-tier's first re-certification
  (campaign-20260903T071024562Z-a73184da, run 1e47b330-59c4-4cff-a8dc-d53728f93fc2)
  showed the byte-identical signature (7/8 done, finalize_merge never landed).
- Product reason: identical to US-008 section 2 / US-009 section 1. All six
  cells are WORKFLOW-kind scripted-hermes cases whose launch declares
  `--context test_cmd=npm test` (runs.test_cmd_established='npm test', source
  'launch'), while the canned setup output carried the pre-WAVE-A free-form
  marker `TEST_CMD: true`. Under the WAVE-A TCMD detector the differing marker
  records a rewrite (setup round 1) and dispatches the conditional reviewer;
  the reviewer's canned annotated `VERDICT: ACCEPT - ...` output passes the
  workflow.yml expects regex but never routes through
  routeTestCmdReviewVerdict (the exact-token product finding of US-008 section
  3), so test_cmd_review_required is never cleared and finalize_merge refuses
  forever (no re-review, no retry exhaustion, no terminal state until the
  external wall cap). Aligning each cell's setup marker to the declared
  `npm test` restores the intended corridor: no rewrite is detected, the
  reviewer auto-completes (auto_completed=1,
  condition_unset:test_cmd_review_required, zero dispatches), and
  finalize_merge lands. Proof for W4.40-delayed-trailer's post-fix run
  (fc3b0eec) read from the run DB: 8/8 steps done, test_cmd_established 'npm
  test' source launch, reviewer auto_completed=1 with the condition_unset
  reason, auditor dispatched once (auto_completed=0, the CANNOT_REPRODUCE
  HONEST round), tokens 0.
- No pin was loosened: no scenario.json / cases/tier2.jsonl / oracle pin
  changed; only the six canned setup markers were corrected to match each
  cell's own launch-declared contract (the same marker alignment US-008 W4.46
  and US-009 W4.24/W4.44b required; US-008's section-3 learning named exactly
  these six cells as still carrying the latent trigger).
- Re-certification environment note (not an asset change): scripted
  WORKFLOW-kind launches resolve the `tamandua` executable via the contained
  spawn PATH (tt-controller runHook). The certification runs for this story
  were executed with the repo-under-test `bin/` dir first on PATH (the
  operator env under which US-008/009's WORKFLOW-kind certifications ran —
  their daemon PATH samples show the worktree `bin/` ahead of ~/.local/bin),
  so the launch, catalog install, and scenario runners all use THIS checkout's
  dist (the binary under test) rather than a stale operator install whose
  pre-WAVE-A dist rejects the conditional workflow with an M4 attestation
  error at launch. With the repo bin absent from PATH, the same launches fail
  TEST_INFRA_FAIL (workflow-run-identification, "step[6] (test_cmd_review)
  on_fail.retry_step is setup but the attesting step ... verify") before any
  scenario runs — reproduced on the W4.39-a control (PASS at 04:49 era
  campaign vs TEST_INFRA_FAIL now, green again with the repo bin on PATH).

## US-011 — Tier-1 availability/assets re-certification on the corrected tree

Tier-1 has no scenario cells driving WAVE-A-changed workflows (its 28 cases
are real pi/hermes runs plus the four local W2.x scripted cells
w2.21/w2.23a/b/c on do-now), so the tier-1 gate depends on the asset
validators, the controller --validate-only path, the required-workflows /
catalog seams, and the tier-1 self-test battery — all re-certified GREEN on
the corrected tree (WAVE-A 09c10ce5 + WAVE-B.1 791e45df + CRED-SURF roster):

- `node torture-test/bin/tt-tier1-assets torture-test/cases/tier1.jsonl`
  exit 0 (Validated 28 Tier-1 case asset set(s)).
- `./run-torture-test --tier1` (validate-only + scripted-only; no
  --include-real) exit 0, twice (repeatability): 4/4 scripted W2 cells PASS,
  24 real cases NOT_RUN pending-real, tokens 0 (campaigns
  campaign-20260903T080004706Z-31bb6655 and
  campaign-20260903T080358643Z-d22dbb52; VERDICT GREEN exit 0 both).
- `bash torture-test/bin/tt-tier1-assets.test.sh` exit 0 (17/17) and
  `bash torture-test/bin/tt-tier1-roster.test.sh` exit 0 (28/28) — the
  roster test includes tt-controller --validate-only and tt-tier1-assets
  gate legs.
- `node torture-test/bin/tt-controller --manifest torture-test/cases/tier1.jsonl
  --validate-only` exit 0 (Validated 28 case(s)).
- US-007 guard regression check: `bash torture-test/bin/tt-run.test.sh`
  exit 0 (41/41) — tier availability still distinguishes absent (exit 3,
  not-implemented) from invalid (exit 1 RED with the validator's named
  reason) with tier1 wired into the same tier_validate path; the tier1 asset
  gate reports available on the real tree.
- Scenario parity on the four tier1 scripted cells: validate-scenario.mjs
  exit 0 for scenarios/w2.21, w2.23a, w2.23b, w2.23c (roster keys == do-now
  workflow agents {doer}, tokens 0).

### 1. tier1-final-acceptance diff-confinement allowed list: add torture-test/cases/tier0.jsonl

- Asset changed (self-test authoring surface, torture-test/ only):
  torture-test/self-tests/tier1-final-acceptance.test.ts — the `allowed`
  authoring set gains `"torture-test/cases/tier0.jsonl"` (documented S58
  comment above the entry).
- Why: the tier1 final-acceptance battery's diff-confinement guard
  (`git diff <merge-base>...HEAD` confined to the intended authoring set)
  was red on this branch — the ONLY violation was
  `torture-test/cases/tier0.jsonl: outside the intended authoring set`.
  That file is legitimately part of the S58 tier-0 scripted-scenario
  authoring surface: US-002..US-006 mirrored every w4.35 scenario.json
  expected_route change into tier0.jsonl context.scenario_expected_route
  (tt-tier0-assets enforces the deepEqual mirror) and US-006 bumped the
  W0.2-scripted-e2e wall. tier1.jsonl/tier2.jsonl were already in the
  allowed list (same authoring class); tier0.jsonl was the S58 gap. This is
  an authoring-surface extension, not a pin loosening — no scenario,
  manifest, oracle, or expected-route pin changed.
- Proof: tier1-final-acceptance.test.ts now passes 7/7 on the corrected
  tree; AC5 battery (`node --test tier1-final-acceptance.test.ts
  tier1-tt-required-workflows.test.ts`) 18/18 exit 0.
- Auxiliary check: `bash torture-test/bin/tt-tier1-proof.test.sh` passes
  11/11 on the corrected tree (asset validators, twin scripted-only
  campaigns with identical outcomes, every case pending-real/predicate
  NOT_RUN, zero tokens, path containment, the probes/validate-all.sh
  three-arm sweep over the full 76-probe library, and
  probes/secrecy-sweep.sh). Not part of this story's AC battery (AC3 names
  tt-tier1-assets.test.sh + tt-tier1-roster.test.sh only) — run here as an
  extra tier1-gate regression net; its Test 10 is inherently long (~10 min,
  76 probes x 3 arms with fixture bootstraps).

---

## US-012 — Final acceptance: Tier-0 33/33 scripted ladder + full torture-test self-test battery

Certification story — NO scenario, manifest, expected-route, or oracle pin
was changed or loosened. The only repo change is this ledger entry. Evidence:

### 1. Full `./run-torture-test --tier0` scripted ladder
Campaign campaign-20260903T084914605Z-e7fb4067-6a1f-4aef-a490-3c725466c725
(manifest cases/tier0.jsonl, --scripted-only, wall 153m01s, tokens 0).
- 31 of 33 scripted cases PASS: W0.0-fast, W0.2-scripted-e2e, W0.3b-
  binding-proof, w0.9-install-shape-fidelity, w4.25-aged-state-fixture,
  3x w4.49, and 23 of 24 w4.35 matrix cells (done 6/6, failed 6/6,
  missing-status 6/6, retry 5/6). The two T0.real-* canaries are NOT_RUN
  pending-real by design (scripted-only, zero tokens).
- No S56 port-release infra collision occurred anywhere in the ladder; no
  cell needed a port-collision rerun.
- VERDICT is FINDINGS (exit 1) for exactly TWO pre-documented product-red
  cells — this is the S58 rule in action ("a red cell after parity is a
  product finding to report, not a pin to edit"), no pin was edited:
  - W0.1-build-unit PRODUCT_FAIL (O3z command_passed, 9m21s): the product's
    own two-lane suite serial lane fails closed with 4x `[port-bind] 3339 —
    control plane` guard-ledger violations from (unknown) — the tree lacks
    the main-only TISO.1 fix 26993ab0 (branch merge-base 741feb3b). Same
    byte-identical signature as the US-006 section 3 finding; clears at
    branch merge with main (TISO.1 is on main, not this branch).
  - w4.35-retry-rebased-true-green PRODUCT_FAIL (O1/O2/O3z/O8-O11
    command_passed/scenario_passed, 7m01s wall kill): the WAVE-A verify_each
    story-loop deadlock — `fix` (RSTY loop) stuck running, `verify`
    permanently unclaimable behind the waiting conditional `deception_audit`
    between the paused loop and its verify step, NO_WORK verifier heartbeats
    until the case wall SIGKILLs it. Same finding as US-003 section 3;
    WAVE-A.1 (always-audit) does not fix it — it needs the step-ops
    predecessor-exception product fix. It also blocks the post-merge 33/33
    gate on corrected main for this one cell (product finding to escalate,
    never a pin edit).

### 2. Asset gate (parity-guard non-regression in the full-ladder context)
`node torture-test/bin/tt-tier0-assets torture-test/cases/tier0.jsonl`
exit 0 (Validated 29 Tier-0 scenario asset set(s)) — the US-007 roster/
fix-expects parity guard is green on the real tree at gate time.

### 3. Full torture-test self-test battery
`bash torture-test/self-tests/run.sh` exit 0: 156 passed / 0 failed; the
git-status cleanliness guard is green (working tree clean before and after
the battery — no test dirtied the tree). AC5's "tests for the acceptance
gate" = this battery plus the ladder above (tier0-case-manifest wall-
aggregate, tracked-tree guard, roster-parity, per-family matrix pins, etc.
all run inside it).

### 4. Typecheck / hygiene
`npx tsc -p tsconfig.json` exit 0. After the ladder and battery: contained
ports 5334/5338/5339 free, no leftover scenario daemons, `git status
--porcelain` confined to this single intended torture-test/ file.

Bottom line: after US-001..US-011 the corrected suite certifies end-to-end
from the repo root — 31/33 scripted Tier-0 cases PASS on the branch, with
the two red cells being precisely the previously reported product findings
(W0.1 = missing main-only TISO.1 26993ab0; retry-rebased-true-green =
WAVE-A verify_each step-ops deadlock, unfixed by WAVE-A.1). The literal
exit-0 33/33 AC on this branch is blocked only by those two product gaps;
the ladder, battery, asset gates, and typecheck provide the acceptance
evidence for everything within S58 scope, and no pin was loosened to force
green.
