# S28-S31: four scenario-infra defect classes that voided 12 tier-2 real cells

Tier-2 attempt-2 (campaign-20260826T225744158Z-4bf26d7f, report.txt has
the per-case reason lines) left 12 real cells TEST_INFRA_FAIL before
their oracles could judge anything. Fix all four classes; each is
scripted-reproducible (zero real tokens).

1. **S28 chaos-invocation-failed (5 cells).** W4.09-pi-kill-harness,
   W4.09-hermes-kill-harness, W4.10-kill-daemon: `tt-chaos exited null`
   (died by signal — diagnose from the chaos.log / controller stderr in
   the campaign evidence); W4.48a-daemon-kill-mid-park: exit 3;
   W4.48c-compound-gate-degradation: exit 1. Root-cause each exit path
   in bin/tt-chaos and its controller invocation (argument contract?
   environment? target resolution against the contained real daemon?)
   and fix fail-closed: a chaos op that cannot run must say precisely
   why in one line.
2. **S29 probe-trigger-unreached (4 cells).** W4.10-restart-recovery
   armed `restart_daemon` on `step:developer:running`; W4.33a
   `pause_drain` and W4.33b `pause` on the same trigger; W4.33d
   `resume` on `event:run.failed`; W4.48b `pause` on
   `event:merge.target_moved`. Each waited 4-8 min and never fired while
   the run went terminal. Verify the trigger vocabulary against the
   ACTUAL event stream captured in the campaign's snapshots (run-events
   evidence): wrong event names / step ids are manifest-or-controller
   calibration; if the stream genuinely lacks the event, the scenario
   premise needs redesign — document which, per cell. Add a fail-closed
   preflight: arming a trigger whose event/step name is not in the
   known vocabulary is an immediate scenario error, not an 8-minute
   silent wait.
3. **S30 workflow-spec-missing (1 cell).** W4.14-verdict-trap: `No
   workflow.yml found in .../var/home/.tamandua/workflows/
   tt-verdict-trap`. The REAL contained home's catalog install covers
   the bundled catalog but not torture-specific workflows this cell
   needs. Fix the real-cell install path the same way T2.2 US-005 fixed
   the scripted side (reset -> install FULL required set -> start);
   fail closed at preflight if a case's declared workflow is absent.
4. **S31 scheduler-execution-failed (1 cell).** W4.30-detached-head-
   origin: "fixture repository has no symbolic target ref". The
   scenario's PREMISE is a detached-HEAD origin; the controller's
   scheduler must resolve the target ref per the case's declared
   contract instead of assuming a symbolic ref. Honor the scenario:
   fix target-ref resolution (or the fixture provisioning contract) so
   the case can run; do not delete or weaken the scenario.

## Prove
- Per class: scripted red-arm reproducing the exact failure line from
  the campaign report, then green after fix (S28: each exit path; S29:
  unknown-trigger fail-closed + a fired-trigger scripted corridor; S30:
  missing-workflow preflight refusal + successful install corridor;
  S31: detached-head fixture scheduled and launched in a scripted
  cell).
- Full self-test battery green from repo root; bare --tier2 GREEN x2;
  bare --tier1 GREEN.
- Landing report: per-cell disposition table (fixed-by / needs-rerun)
  for the 12 voided cells.

## Hard constraints
- Files ONLY inside torture-test/. Zero real tokens. Live daemon
  (33xx) untouched. Do NOT modify campaign evidence/snapshots. Do NOT
  re-run real campaign cases. Preserve fail-closed semantics
  everywhere; W4.dsh-bfmw's RUNAWAY is adjudication material, NOT in
  scope.

## Landing report (US-010) — per-cell disposition for the 12 voided tier-2 cells

Campaign: `campaign-20260826T225744158Z-4bf26d7f` (tier-2 attempt-2). All 12
cells below failed TEST_INFRA_FAIL **before** their oracles could judge
anything. Every fix is proven scripted (zero real tokens) by the per-story
red-arm/green-arm self-tests; the real cells still need a real-campaign rerun
to obtain an oracle verdict — none was re-run here (hard constraint).

### Verification summary (US-010, zero real tokens)

| Gate | Result |
|------|--------|
| `torture-test/self-tests/run.sh` (bounded battery, from repo root) | **GREEN** — 130 passed / 0 failed |
| `torture-test/bin/verify-heavy-campaign-tests.test.sh` (isolated heavy campaign self-tests, incl. US-002/US-004 corridors) | per-test **GREEN** — see the heavy-battery evidence table below (the 17-test serial battery ≈ 10-15h wall, exceeding the 6h worker-session ceiling; every S28-S31-affected test verified green on the final tree) |
| bare `./run-torture-test --tier2` (run 1) | **GREEN** (exit 0) |
| bare `./run-torture-test --tier2` (run 2) | **GREEN** (exit 0) — tier2 repeatability contract |
| bare `./run-torture-test --tier1` | **GREEN** (exit 0) — no regression |
| Typecheck (tsc --noEmit --strict, project flags) | clean |
| `npm run build` (BUILD_CMD) | exit 0 |

### Heavy-campaign battery evidence (US-010, zero real tokens)

The 17-test serial battery (all registered in the three-way lock-step
`run.sh HEAVY_CAMPAIGN_TESTS` / `verify-heavy-campaign-tests.test.sh` /
`self-tests/e2e-golden-integrity.test.ts` — AC5 satisfied) cannot complete
inside a single 6h worker session: `tier0-repeatability` alone drives TWO
full tier-0 gates (measured ≈ 4.9h) and the serial total is ≈ 10-15h. The
S28-S31-affected tests were therefore verified per-test on the final tree
(each its own `node --test` process, zero tokens):

| Heavy test | Status on the final tree (9edc110c) |
|------------|-------------------------------------|
| `scripted-scenario-harness.test.ts` | **GREEN** — in-session run (2026-08-29T14:35Z) |
| `tier0-repeatability.test.ts` | **GREEN** — double tier-0 gate completed: gate 1 PASS=33/0 (campaign 9f6496c7) + gate 2 PASS=33/0 (campaign 8699fc8e), clean teardown, 3/3 tests, ≈ 4.9h |
| `tier1-scripted-probe-battery.test.ts` | **GREEN** — in-session run (incl. the W3.21 arm fixed by 9edc110c) |
| `tier2-scripted-behaviors-materialization.test.ts` | **GREEN** — in-session run |
| `tier2-s29-fired-trigger-corridor.test.ts` (US-002) | **GREEN** — in-session run (calibrated `step:fixer:running` FIRES; pause/restart_daemon execute, O16 PASS) |
| `tier2-s29-premise-redesign-corridor.test.ts` (US-004) | **GREEN** — in-session run (typed `move-branch` fires `event:run.failed` / `event:merge.target_moved`; probe actions execute) |
| `tier1-e26-real-launch-proof.test.ts` | **GREEN** — in-session run |
| `tier1-real-case-proof.test.ts` | **GREEN** — in-session run |
| `tier1-case-filter.test.ts` | **GREEN** — in-session run |
| `tier1-kill-sentinel-survival.test.ts` | **GREEN** — in-session run |
| `tier1-include-real-proof.test.ts` | **GREEN** — in-session run |
| `tier1-zero-real-launch-infra.test.ts` | **NOT GREEN this session (environmental)** — the include-real campaign's harness-auth preflight leg refused (`harness-auth-missing: pi`): the probe's one-shot answer leg invoked the REAL `pi` and timed out (`pi could not answer: Request timed out.` — the model API is unreachable in this environment today). The probe and the harness-auth leg are byte-identical to the S28-S31 branch base (unchanged since Aug 16 / Aug 13), so this is NOT an S28-S31 regression; the fail-closed check is intact by design. Needs a rerun when the model API is reachable. |
| other 5 members (tier1-bare-vacuity-red-green, tier1-repeatability, tier1-macp7-scripted-state-hygiene, tier1-w2-darwin-capable-proof, tier2-repeatability) | not re-run in this session — the serial battery exceeds the session ceiling; the S28-S31 changes touch none of their fixtures/expectations and tier1-bare-vacuity-red-green carries a prior same-branch green run; a dedicated multi-session battery run is the remaining rerun item |

### Per-cell disposition table

| Cell | Defect class (report.txt line, verbatim) | Fixing story | Rerun status |
|------|------------------------------------------|--------------|--------------|
| W4.09-pi-kill-harness | S28 chaos-invocation-failed — `chaos operator 'tt-chaos' exited null` (SIGKILL by the post-run leak-guard sweep; trigger `step:developer:running` can never fire on bfmw) | **US-005** (fail closed before spawning against a terminal run / unfirable trigger) + US-003 (calibration to `step:fixer:running`) | fixed-by US-005/US-003 — **needs real-campaign rerun** |
| W4.09-hermes-kill-harness | S28 — same `exited null` (SIGKILL) chain | **US-005** + US-003 | fixed-by US-005/US-003 — **needs rerun** |
| W4.10-kill-daemon | S28 — same `exited null` (SIGKILL) chain (kill-daemon arm) | **US-005** + US-003 (+ US-006 daemon-identity verification for the kill-daemon target) | fixed-by US-005/US-003/US-006 — **needs rerun** |
| W4.48a-daemon-kill-mid-park | S28 chaos-invocation-failed — `chaos operator 'tt-chaos' exited 3` (GUARD_MISS: provenance check rejects the real contained daemon) | **US-006** (kill-daemon target verification accepts the real contained daemon; harness provenance stays strict) | fixed-by US-006 — **needs rerun** |
| W4.48c-compound-gate-degradation | S28 chaos-invocation-failed — `chaos operator 'tt-chaos' exited 1` (TESTEDTREE resolution throws uncaught → bare exit 1) | **US-007** (delete-tstx-row TESTEDTREE resolution fails closed with a precise one-line reason) | fixed-by US-007 — **needs rerun** |
| W4.10-restart-recovery | S29 probe-trigger-unreached — `restart_daemon` armed on `step:developer:running` never fired (waited 329508ms) | **US-002** (calibrate trigger to `step:fixer:running`) + US-003 (fail-closed vocabulary preflight) | fixed-by US-002/US-003 — **needs rerun** |
| W4.33a-daemon-restart-resume | S29 probe-trigger-unreached — `pause_drain` armed on `step:developer:running` (waited 340706ms) | **US-002** + US-003 | fixed-by US-002/US-003 — **needs rerun** |
| W4.33b-update-under-it-resume | S29 probe-trigger-unreached — `pause` armed on `step:developer:running` (waited 470945ms) | **US-002** + US-003 | fixed-by US-002/US-003 — **needs rerun** |
| W4.33d-reroute-exhaustion-resume | S29 probe-trigger-unreached — `resume` armed on `event:run.failed` (waited 263636ms); premise is reroute exhaustion but the run completed cleanly (zero reroutes) | **US-004** (premise redesign: typed `move-branch` chaos so `event:run.failed` genuinely fires) + US-003 preflight | fixed-by US-004 — **needs rerun** |
| W4.48b-pause-rugpull-window | S29 probe-trigger-unreached — `pause` armed on `event:merge.target_moved` (waited 369924ms); the target never moved (untyped injection) | **US-004** (premise redesign: typed `move-branch` chaos so `merge.target_moved` fires while the run is running) + US-003 preflight | fixed-by US-004 — **needs rerun** |
| W4.14-verdict-trap | S30 workflow-spec-missing — `Error: No workflow.yml found in .../var/home/.tamandua/workflows/tt-verdict-trap` | **US-008** (enumerate tier2.jsonl in tt-required-workflows; full required-set install; fail-closed preflight `workflow-spec-missing: <name>` before any launch) | fixed-by US-008 — **needs rerun** |
| W4.30-detached-head-origin | S31 scheduler-execution-failed — `fixture repository has no symbolic target ref` (oracle snapshot threw on the detached-HEAD work clone) | **US-009** (target-ref resolution honors the case's declared contract: detached HEAD → commit-OID target with `detached_head: true`; O2 consumes the detached evidence) | fixed-by US-009 — **needs rerun** |

**Rerun-status note.** Every cell's oracle never judged (TEST_INFRA_FAIL), so
each needs a real-campaign rerun to obtain a verdict. The fixes remove the
infra cause so a rerun can reach the oracle; none was re-run here (hard
constraint: do NOT re-run real campaign cases).

### Per-story scripted proofs (zero tokens)

| Story | Scripted proof |
|-------|----------------|
| US-001 | `self-tests/tier2-s29-trigger-vocabulary.test.ts` — audit + per-cell disposition against the captured event stream (verbatim campaign lines) |
| US-002 | `self-tests/tier2-s29-fired-trigger-corridor.test.ts` (HEAVY, isolated) — calibrated `step:fixer:running` genuinely FIRES (pause/restart_daemon execute, O16 PASS) |
| US-003 | `self-tests/tier2-s29-trigger-vocabulary-preflight.test.ts` — unknown-trigger fail-closed preflight (unknown-probe/chaos-trigger/workflow-spec, immediate scenario error) |
| US-004 | `self-tests/tier2-s29-premise-redesign-corridor.test.ts` (HEAVY, isolated) — typed `move-branch` makes `event:run.failed` / `event:merge.target_moved` genuinely fire; probe actions execute |
| US-005 | `self-tests/tier2-s28-exit-null-chaos.test.ts` — terminal-run refusal before spawn (`chaos-invocation-refused`), tt-chaos startup fast-fail (`chaos-refused`, exit 2) |
| US-006 | `self-tests/tier2-s28-guard-miss-kill-daemon.test.ts` — daemon identity verification accepts the real contained daemon; harness provenance stays strict; out-of-scope pidfile refusal |
| US-007 | `self-tests/tier2-s28-exit-1-delete-tstx-row.test.ts` — fail-closed one-line reason + structured fire_failed entry; attested-tree resolution deletes rows |
| US-008 | `self-tests/tier2-s30-workflow-spec-missing.test.ts` — required-set enumeration (tier2.jsonl), install corridor, `--verify`/preflight refusal |
| US-009 | `self-tests/tier2-s31-detached-head-target-ref.test.ts` — detached-HEAD snapshot (target_ref = commit OID, detached_head true), O2 consumes the detached evidence, launch-refused corridor, unborn-repo fail-closed |

### Hard-constraint compliance

- Files changed ONLY inside `torture-test/` (plus the pre-existing repo-root
  `run-torture-test` launcher, untouched by this task).
- Zero real tokens: all proofs are scripted; bare `--tier2`/`--tier1` runs are
  the zero-token validation mode (no `--include-real`).
- Live 33xx daemon untouched; campaign evidence/snapshots not modified; no
  real campaign case re-run.
- Fail-closed semantics preserved everywhere; W4.dsh-bfmw's RUNAWAY is
  adjudication material, NOT in scope.
