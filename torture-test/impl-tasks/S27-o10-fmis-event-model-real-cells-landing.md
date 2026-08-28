# S27 landing report — O10 FMIS event-set model: real-cell calibration without weakening the seal

Story US-007: final integration verification of the S27 change set and this landing report.
S27 (task `S27-o10-fmis-event-model-real-cells.md`) recalibrates O10's FMIS event-set
model for real multi-step workflow cells — one `step.running` per step execution recorded
in the DB evidence (derived mechanically, never a constant), `step.rerouted` reconciled
per step against the DB `terminal_reroute_count` on the legal corridors O11 already
recognizes — while keeping the merge-gate event subset (merge.* + terminal run event) at
EXACT decision-table semantics (the seal) and the scripted FMIS probe cells byte-for-byte
unchanged. This report records: the recalibrated two-regime model, the exact replay PASS
set, every surviving O10 finding with its mechanical justification (US-004), the non-O10
byte-identical proof, the full verification ladder results, and the confinement/token/
evidence/daemon proof.

## Recalibrated two-regime O10 model (US-001/US-002, contract US-005)

The O10 FMIS check (`torture-test/oracles/lib/o10.mjs`) is now regime-aware, keyed on the
projected run's `execution_mode` (any-real wins; missing/unknown -> scripted exact regime
so legacy contexts and existing fixtures are unaffected):

- **SCRIPTED FMIS probe cells**: the exact single-step corridor multiset comparison
  (`expectedEventNames`) is UNCHANGED byte-for-byte — the original seal. Scripted cells
  keep the exact decision-table `O10_REROUTE_COUNT` semantics (reroutes must equal
  expected.reroutes, 0 or 1).
- **REAL cells**:
  1. **Merge-gate seal (never relaxed)**: the decision-table subset — merge.*
     annotations (`merge.gate_overridden`, `merge.landed_without_suite_evidence`,
     `merge.landed_over_red_suite`, `merge.accepted_already_landed`), `merge.landed`,
     and the terminal `run.completed`/`run.failed` — must match EXACTLY. `run.canceled`
     sits on the OBSERVED side, so a canceled terminal where the table says
     completed/failed is an anomaly. Any difference emits `O10_EVENT_SET_MISMATCH`.
  2. **Lifecycle**: every non-finalize `step.running` must name a run steps row
     (stepId AND agentId), with mechanically derived per-step execution counts: 1 per
     non-loop step row, story-iteration count for loop/verify_each steps (from
     `story.started`/`story.done`/`story.verified` events), plus `step.retry`
     re-dispatches (honest-retry re-executions; `steps.retry_count` is a dispatch
     counter, NOT an execution counter), plus reroute-target re-executions (the
     `step.running` following a `step.rerouted`). `steps.type`/`loop_config` are read
     PRAGMA-optionally. `finalize_merge` step.running multiplicity stays the exact 0/1
     `O10_MERGER_INVOCATION_COUNT` bound.
  3. **Reroute reconciliation**: per step, the `step.rerouted` event count must equal
     that step's DB `terminal_reroute_count`; each reroute must lie on a legal corridor
     (shared O11 discipline via `torture-test/oracles/lib/reroute-discipline.mjs` —
     dispatch_renderings reroute rows when present, else the DB-counter fallback, which
     is the universal real-campaign shape). Refusal cells (lands=false) keep the exact
     decision-table bound: exactly one obstructing reroute before refusing (never
     reconciled away).

The two-regime contract is documented in `torture-test/oracles/CONTRACT.md`
(US-005), including the canceled-run doctrine and the W4.17-b / W4.dsh-fdmw / W4.29
audit summary.

## Red-then-green replay proof (US-004/US-006, re-verified in US-007)

Zero-token offline replay of the recalibrated O10 against the tier-2 attempt-2 evidence
`campaign-20260826T225744158Z-4bf26d7f-e648-42f1-8274-0011926de7dd` (read-only; the tool's
own sha256 digest check plus an independently recomputed digest prove the source campaign
byte-identical before/after every replay):

```
pairs: 292  flips: 26  unchanged: 266  invoke_failures: 0
transitions: ERROR->FAIL: 3, ERROR->PASS: 20, FAIL->PASS: 3
source_campaign_unchanged: true
```

US-007 re-ran the S27 pin replay from the repo root
(`node torture-test/bin/tt-oracle-replay --campaign <attempt-2> --workspace-root <tmp>
--verify-s27-invariants --json <out>`): exit 0, `s27: OK` with all six checks green
(s27-o10-reconciliation-heal, s27-flip-scope, s27-calibration-pass-set,
s27-genuine-fail-survivors, s27-w4-29-error-pin, s27-non-o10-byte-identical, zero
violations), the identical 292/26/266/0 delta, 21 O10 PASS / 3 O10 FAIL / 1 O10 ERROR
(W4.29), 2 O9 heals, and the source-campaign digest unchanged (2414 files, sha256 of the
JSON-serialized sorted digest `4be018afe0c1ddc4c6b3ef97da543ec1b4b3f7c52f55826f84c5332821
c8ed6a`).

### Exact O10 PASS set (21 calibration-artifact cases)

| Case | Stored | Replayed | Calibration classes |
|---|---|---|---|
| (20 stored O10 reconciliation-ERRORs) | ERROR | PASS | O10_EVENT_SET_MISMATCH / O10_REROUTE_COUNT (multi-step running + legal corridor reroutes) |
| W4.01-missing-evidence-reroute | FAIL | PASS | O10_EVENT_SET_MISMATCH + O10_REROUTE_COUNT only (both calibration classes) |

The 20 ERROR heals: W4.02-fail-missing-refusal, W4.03-red-adjacent-commit,
W4.04a-mechanical-override, W4.04b-behavioral-bait, W4.05-slow-suite-contention,
W4.06-colleague-rebase, W4.07-conflicting-colleague-commit, W4.13-worktree-deletion,
W4.15-story-flood, W4.16-scope-bait, W4.17-a-red-baseline-land-annotated,
W4.26-unreachable-origin, W4.28-tstx-cross-repo-collision, W4.31-precommit-amend,
W4.32-enospc, W4.33c-deleted-worktree-refusal, W4.39-b-union-dishonest,
W4.45-branch-delete, W4.45-gc-aggressive, W5.storm-capacity-scaled.

Mechanical count: **21 = 20 reconciliation-ERROR heals + 1 stored-FAIL heal (W4.01)**,
exactly matching the S27 author's claim. Composition note (from US-004): W4.18 is NOT in
the set (its EVENT_SET is the merge-gate seal — a genuine missing-concession finding), so
the "23 minus W4.17-b and W4.dsh-fdmw" shorthand is 20 ERROR heals + W4.01 heal, with
W4.18 correctly excluded.

### Surviving O10 findings (genuine — never silently absorbed)

**W4.17-b-red-baseline-refuse — O10 FAIL, 6 findings** (strict missing/green refusal cell
prescribes lands=false, reroutes=1, merger_invocations=0; the run landed instead):

| Finding | Mechanical justification |
|---|---|
| O10_TERMINAL_DISPOSITION | run/DB/finalize all completed but the strict green refusal cell prescribes failed; no refusal happened |
| O10_REF_MOVEMENT | ref moved (before tip != after tip) but a refusal cell prescribes no movement (expected_moved=false) |
| O10_MERGER_INVOCATION_COUNT | observed 1 finalize_merge step.running vs expected 0 on a refusal cell |
| O10_REFUSAL_DIAGNOSIS | strict refusal lacks the exact mechanical self-diagnosis (finalize output is a landing report, no FAILURE_CLASS: refused_permanent / LEDGER_EVIDENCE / exact-key fields) |
| O10_REROUTE_COUNT | refusal doctrine: the strict missing/green refusal cell GENUINELY bounds reroutes (exactly one obstructing reroute before refusing); DB terminal_reroute_count 0 AND event count 0 != decision-table bound 1 — not reconciled away |
| O10_EVENT_SET_MISMATCH (seal) | merge-gate subset expected [run.failed] vs observed [merge.landed, run.completed] — the run landed instead of refusing; lifecycle itself is clean, confirming the mismatch is the seal |

**W4.18-flaky-alternator — O10 FAIL, 1 finding** (default non-strict missing-evidence
concession cell; the run landed WITHOUT the required `merge.landed_without_suite_evidence`
annotation): `O10_EVENT_SET_MISMATCH` (seal) — expected `[merge.landed,
merge.landed_without_suite_evidence, run.completed]` vs observed `[merge.landed,
run.completed]`. Lifecycle is clean (every step 1/1) and reroutes reconcile (0/0) — the
mismatch is purely the missing concession annotation on the seal. Genuine; this is why
W4.18 is NOT in the 21 PASS set.

**W4.dsh-fdmw — O10 FAIL, 9 findings** (controller-cli-stop canceled the run before any
step executed; decision table expected a completed missing-evidence concession landing):

| Finding | Mechanical justification |
|---|---|
| O10_EVENT_SET_MISMATCH (seal) x1 | expected `[merge.landed, merge.landed_without_suite_evidence, run.completed]` vs observed `[run.canceled]` — canceled terminal where the table says completed is an anomaly (run.canceled deliberately on the observed side) |
| O10_EVENT_SET_MISMATCH (lifecycle) x5 | running-count-mismatch on implement/plan/setup/test/verify: each step row derives 1 expected execution, observed 0 — no step ever ran |
| O10_MERGER_INVOCATION_COUNT | expected 1 (concession landing invokes the merger), observed 0 |
| O10_REF_MOVEMENT | expected_moved=true (lands), observed_moved=false |
| O10_TERMINAL_DISPOSITION | expected completed (missing-evidence concession), observed canceled in DB, projection, and finalize status |
| O10_REROUTE_COUNT | heals (0 events == 0 counter per step; a controller-canceled run has no reroute activity) — the only calibration-class finding on this case |

Default doctrine honored: a controller-canceled run is a GENUINE disposition anomaly, NOT
silently absorbed.

**W4.29-strict-gate-retry-finalize — O10 ERROR unchanged** (non-reconciliation
target-ref-identity class): `refs_before.target_ref = refs/heads/main` vs
`refs_after.target_ref = refs/heads/security-audit-2026-08-27` — the recalibrated model
throws `ORACLE_RUNTIME_ERROR("target ref identity changed between snapshots")` at the
ref-identity gate, before any per-run FMIS check, exactly as the S26 pin requires. The
author-listed MERGER_INVOCATION_COUNT / REF_MOVEMENT / TERMINAL_DISPOSITION /
REFUSAL_DIAGNOSIS are NOT yielded (the ERROR short-circuits before the decision-table
loop; the evidence is green anyway — finalize_merge updated_at 2026-08-27 00:52:57 vs the
green exact-key ledger row 13 for the merged tree a37157bd at 00:45:34 <= decision time —
so no decision-table finding would fire). They are not absorbed; they never fire on this
class.

### Non-O10 byte-identical proof

Exactly 2 non-O10 flips, both S26-class O9 replay-row heals:

```
W4.01-missing-evidence-reroute  O9  FAIL -> PASS  before=[O9_REPLAY_ROW_MISSING, O9_REPLAY_ROW_MISSING] after=[]
W4.02-fail-missing-refusal      O9  FAIL -> PASS  before=[O9_REPLAY_ROW_MISSING]                        after=[]
```

All other 265 non-O10 pairs are `same` with before-finding ids identical to after-finding
ids (programmatic scan: 0 mismatches). The S27 replay pin (`--verify-s27-invariants`,
US-006) enforces exactly this contract: S26 classes (O10 reconciliation-ERROR -> true
verdict, O9 replay-row heals) plus the S27 class (O10 stored FAIL -> PASS whose every
stored finding is a calibration class), with red arms for non-calibration FAIL->PASS
flips, non-reconciliation ERROR flips, genuine-finding loss on the survivors, and any
non-O10 change.

## Full zero-token verification ladder (US-007)

All runs from the repo root, serially, from a clean tree. Everything is zero-token by
construction (offline evidence replay, scripted-only gates, no real campaign case re-run).

### 1. Full battery (all PASS, exit 0)

| piece | result | evidence |
|---|---|---|
| `torture-test/oracles/self-test/run.sh` (2 rounds) | PASS | round 1 PASS (67215ms), round 2 PASS (67318ms), repeatability PASS (134568ms total) |
| `torture-test/self-tests/run.sh` | PASS | 122 passed, 0 failed; working tree clean after |
| `torture-test/bin/tt-controller.test.sh` | PASS | all tt-controller manifest and campaign state tests PASSED |
| `torture-test/bin/tt-daemon-up.test.sh` | PASS | 66 passed, 0 failed |
| `torture-test/bin/tt-daemon-up-schema.test.sh` | PASS | 28 passed, 0 failed |
| `torture-test/bin/tt-controller-preflight.test.sh` | PASS | all preflight wiring tests PASSED (incl. S26 fresh-campaign suite-state red-arm) |
| `torture-test/bin/tt-oracle-replay.test.mjs` | PASS | 8/8 pass, 0 fail, 0 skip |
| `torture-test/bin/tt-oracle-replay-invariants.test.mjs` | PASS | 63/63 pass, 0 fail, 0 skip — S27 e2e ran against the real attempt-2 campaign under `--verify-s27-invariants` (TT_S27_CAMPAIGN_DIR + TT_PREVAL_CAMPAIGN_DIR set; digest unchanged) |
| `torture-test/bin/oracle-context.test.mjs` | PASS | node --test green |
| `torture-test/bin/oracle-evidence-snapshot.test.mjs` | PASS | node --test green |
| `torture-test/bin/tt-classification.test.mjs` | PASS | node --test green |
| `torture-test/bin/tt-report.test.mjs` | PASS | node --test green |

### 2. Bare tier gates (zero tokens, never `--include-real`)

`./run-torture-test --tier2` GREEN twice:

- Run 1 (`campaign-20260828T080222387Z-44b2978f-5d48-410c-819a-fe5d9fc70772`): **VERDICT
  GREEN (exit 0)**, `Totals: PASS=24 PRODUCT_FAIL=0 AGENT_FLAKE=0 PROVIDER_FAIL=0
  TEST_INFRA_FAIL=0 INVALID=0 INCONCLUSIVE=0 NOT_RUN=46`, `Tokens observed: 0`,
  FINDINGS (none).
- Run 2 (`campaign-20260828T085707458Z-fc5fa2e5-4123-4fe7-b65b-54b679345cb9`): **VERDICT
  GREEN (exit 0)**, identical totals (PASS=24, 0 infra failures, 0 findings, 0 tokens, 46
  pending-real).

`./run-torture-test --tier1` GREEN:

- `campaign-20260828T095151239Z-ae1a7b76-a1a3-4cf8-b01a-06d7df3f139d`: **VERDICT GREEN
  (exit 0)**, `Totals: PASS=4 ... NOT_RUN=24`, `Tokens observed: 0` (4 scripted tier1
  cells; 24 pending-real).

### 3. Typecheck / build

`npm run build` (tsc + dist + version injection) exit 0. Build version
`20260828T070131Z_0756e25660efb5776e9dd1d4ecf1e67faebf0e40` injected.

### 4. Confinement / evidence / tokens / live daemon

- `git diff --stat` on the run's branch touches ONLY `torture-test/` (8 files,
  +2308/-50 as of US-006; +1 file for this landing report below). Working tree clean
  after all ladder runs (verified: `git status --porcelain` empty).
- Attempt-2 campaign digest byte-identical before/after every replay: 2414 files,
  sha256 of the JSON-serialized sorted digest = `4be018afe0c1ddc4c6b3ef97da543ec1b4
  b3f7c52f55826f84c5332821c8ed6a` (computed independently before the ladder and again
  after the US-007 replay — identical; the tool also reports
  `source_campaign_unchanged: true` on every run).
- Zero tokens: every tier gate reports `Tokens observed: 0`; oracle self-tests,
  self-tests, the replay, and the battery are token-free by construction. No real
  campaign case was re-run (evidence replay only, read-only; bare gates are
  scripted-only + pending-real).
- Live daemon (33xx) untouched: ports 3334/3338/3339 remained up on their original
  PIDs throughout (verified before and after the ladder); no real `~/.tamandua`
  writes, no daemon-control real lifecycle invoked, no `--include-real` anywhere.
- Contained real DB `suite_results` empty after the ladder (the S26 fresh-campaign
  suite-state gate passed in every preflight).

## Commits (S27 branch feature/s27-o10-fmis-event-model)

```
0756e256 feat: US-006 - Add the S27 tt-oracle-replay invariant pin
b8327798 feat: US-005 - Document the two-regime O10 contract in oracles/CONTRACT.md
10ec01e2 feat: US-004 - Audit W4.17-b / W4.dsh-fdmw / W4.29 and determine the exact replay PASS set
feb8e7d0 feat: US-003 - Add O10 real-cell red-arm self-test fixtures
5d90a625 feat: US-002 - Recalibrate O10_REROUTE_COUNT for real cells with shared corridor discipline
0050c7d6 fix: US-001 - derive honest-retry re-executions from step.retry events
9bfb251d feat: US-001 - count honest retry re-dispatches in real-cell lifecycle derivation
636b8884 feat: US-001 - Split O10 event-set validation into scripted-exact and real-cell regimes
```

This landing report is committed as US-007 (`feat: US-007 - Final integration verification
and S27 landing report`) on the same branch.

## Self-test red-arms (US-001/US-002/US-003)

Real-cell fixtures pin the recalibrated model (36 o10 fixtures = 29 scripted + 7 real;
10 scripted-only mutations unchanged):

- `o10-real-multistep-legal-reroute` PASS (6-row/7-running/1-reroute W4.02-shaped stream
  with a legal finalize_merge -> verify reroute, terminal_reroute_count 1, green landing).
- `o10-real-loop-multistep` PASS (feature-dev-merge-worktree-shaped run with a type='loop'
  implement step: N story iterations -> N step.running for implement and N for verify).
- `o10-real-corridor-corroborated` PASS (dispatch_renderings corridor corroboration leg).
- `o10-real-double-landed` FAIL O10_EVENT_SET_MISMATCH (two merge.landed events).
- `o10-real-missing-terminal` FAIL O10_EVENT_SET_MISMATCH (no run.completed terminal).
- `o10-real-unknown-step-running` FAIL O10_EVENT_SET_MISMATCH (step.running names a stepId
  absent from the run's steps rows).
- `o10-real-reroute-count-mismatch` FAIL O10_REROUTE_COUNT (1 step.rerouted event vs
  terminal_reroute_count 0).
- Scripted probe cells keep exact-set semantics: all 29 pre-existing fixture expectations
  byte-identical to the pre-S27 baseline (verified in US-003); the O10 unit tests for the
  seal (double merge.landed, missing terminal, unknown step) stay green unmodified where
  they encode the seal.
