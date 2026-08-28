# US-004: Audit W4.17-b / W4.dsh-fdmw / W4.29 and determine the exact replay PASS set

S27 story US-004: after the US-001/US-002 recalibration (two-regime O10 event-set
model + per-step real-cell reroute reconciliation), replay the recalibrated O10
against the tier-2 attempt-2 evidence
(`campaign-20260826T225744158Z-4bf26d7f-e648-42f1-8274-0011926de7dd` under
`/home/igorhvr/idm/tamandua/torture-test/var/results/`, strictly read-only) and
determine the exact case set whose ONLY O10 findings are the calibration
classes (O10_EVENT_SET_MISMATCH from multi-step running and/or
O10_REROUTE_COUNT from legal corridor reroutes); those cases must replay O10
PASS. Audit per finding, with mechanical justification, the survivors whose
healed O10 carries findings beyond EVENT_SET/REROUTE (W4.17-b, W4.dsh-fdmw)
plus W4.29.

## Replay setup

- Tool: `torture-test/bin/tt-oracle-replay` (zero tokens, offline evidence
  replay; source campaign verified byte-identical by the tool's own sha256
  digest check before/after every replay).
- Campaign: `/home/igorhvr/idm/tamandua/torture-test/var/results/
  campaign-20260826T225744158Z-4bf26d7f-e648-42f1-8274-0011926de7dd`.
- Workspace: `torture-test/var/tt-oracle-replay/` (gitignored), fresh per run.
- Replay output: full delta table (below), machine-readable rows written to
  the replay `--json` path.

## Replay summary

```
pairs: 292  flips: 26  unchanged: 266  invoke_failures: 0
transitions: ERROR->FAIL: 3, ERROR->PASS: 20, FAIL->PASS: 3
source_campaign_unchanged: true
```

- **25 O10 rows** (all O10-evaluated attempt-2 cases).
- **21 O10 PASS** — the calibration-artifact PASS set (20 stored
  reconciliation-ERRORs + W4.01's stored FAIL heal).
- **3 O10 FAIL survivors** with genuine non-calibration findings:
  W4.17-b-red-baseline-refuse (6 findings), W4.18-flaky-alternator (1 finding:
  the merge-gate seal EVENT_SET — missing-concession), W4.dsh-fdmw (9
  findings).
- **1 O10 ERROR unchanged**: W4.29-strict-gate-retry-finalize (non-
  reconciliation target-ref-identity class, per the S26 pin).
- **Non-O10 flips: exactly 2 O9 FAIL -> PASS heals** (W4.01, W4.02 —
  `O9_REPLAY_ROW_MISSING` S26 class). Every other non-O10 row is byte-identical
  (same before/after verdict AND identical finding ids — verified by scanning
  all 266 unchanged rows for any finding-id delta: 0 mismatches).

### Exact PASS set (21)

The S27 author claims 21: "the 23 post-S26 ERROR->FAIL O10 heals minus W4.17-b
and W4.dsh-fdmw; W4.01's stored FAIL also heals". Mechanically:

- 23 stored O10 reconciliation-ERRORs (the S26 heal list). Of those, post-S27:
  - **20 replay O10 PASS**: W4.02-fail-missing-refusal, W4.03-red-adjacent-
    commit, W4.04a-mechanical-override, W4.04b-behavioral-bait,
    W4.05-slow-suite-contention, W4.06-colleague-rebase,
    W4.07-conflicting-colleague-commit, W4.13-worktree-deletion,
    W4.15-story-flood, W4.16-scope-bait, W4.17-a-red-baseline-land-annotated,
    W4.26-unreachable-origin, W4.28-tstx-cross-repo-collision,
    W4.31-precommit-amend, W4.32-enospc, W4.33c-deleted-worktree-refusal,
    W4.39-b-union-dishonest, W4.45-branch-delete, W4.45-gc-aggressive,
    W5.storm-capacity-scaled.
  - **3 stay O10 FAIL** with genuine findings: W4.17-b (6 findings), W4.18
    (merge-gate seal EVENT_SET), W4.dsh-fdmw (9 findings).
- **W4.01-missing-evidence-reroute's stored FAIL also heals to O10 PASS** (its
  only stored O10 findings were O10_EVENT_SET_MISMATCH + O10_REROUTE_COUNT,
  both calibration classes: multi-step running multiplicity + legal corridor
  reroute — see the W4.01 observation in the replay evidence).

Mechanical count: **21 = 20 reconciliation-ERROR heals + 1 stored-FAIL heal
(W4.01)**, matching the author's 21. Discrepancy note: the author's
parenthetical "23 minus W4.17-b and W4.dsh-fdmw" implies 21 ERROR heals and
treats W4.01 as a 22nd; mechanically W4.18 ALSO stays FAIL (its EVENT_SET is
the merge-gate seal, not a calibration class — the missing-evidence concession
annotation is genuinely absent) and W4.01 IS a heal, so the composition is
20 + 1 = 21 with W4.18 correctly excluded. The count is exact; the composition
differs from the author's shorthand by one case in each direction (W4.18 out,
W4.01 in).

## Per-case audit (every O10-evaluated attempt-2 case)

### PASS cases (21) — no surviving O10 findings

For each of the 20 reconciliation-ERROR heals and W4.01, the replayed
`o10-fmis-decision-table.json` observation shows the recalibrated model
satisfied:

- **merge-gate seal**: the decision-table subset (annotations + merge.landed +
  terminal run event) matches EXACTLY (no O10_EVENT_SET_MISMATCH on the seal).
- **lifecycle**: every non-finalize step.running names a run steps row with
  the mechanically derived execution count (1 per single step, story-iteration
  count for loop/verify_each steps, step.retry re-dispatches, reroute-target
  re-executions) — no lifecycle O10_EVENT_SET_MISMATCH.
- **reroute reconciliation**: per step, step.rerouted event count == DB
  terminal_reroute_count (legal on_fail.retry_step corridors; DB-counter
  fallback since real campaign dispatch-renderings artifacts carry zero
  reroute rows) — no O10_REROUTE_COUNT.
- terminal disposition, ref movement, merger-invocation count, refusal
  diagnosis all match the decision table.

Examples (from the replay evidence observations):
- W4.01: expected subset `[merge.landed, run.completed]` == observed; verify
  step expected 2 executions (1 base + 1 reroute-target re-execution) ==
  observed 2; finalize_merge terminal_reroute_count 1 == 1 step.rerouted event
  (legal corridor, fallback regime); merger_invocations 1 == 1.
- W4.17-a (land-annotated): green landing, subset exact, lifecycle 1/1 per
  step, 0/0 reroutes.
- W5.storm-capacity-scaled and the remaining heals show the same conforming
  shape in their observations.

### W4.17-b-red-baseline-refuse — O10 FAIL (6 genuine findings)

Launch: `merge_gate=green`, `fail_missing=null` -> strict missing/green refusal
cell (`expectedCell` -> lands=false, reroutes=1, merger_invocations=0,
annotations=[]). Exact-key evidence missing (ledger has no row for the gate
key's cmd_hash on the attested tree). Observed: run landed (merge.landed +
run.completed), ref moved, merger invoked once, no reroute.

Replayed findings (all yielded by the recalibrated model — none absorbed):

| Finding | Fires? | Mechanical justification |
|---|---|---|
| O10_TERMINAL_DISPOSITION | YES | run/DB/finalize all `completed/done` but the strict green refusal cell prescribes `failed`; no refusal happened. |
| O10_REF_MOVEMENT | YES | ref moved (before tip != after tip) but a refusal cell prescribes no movement (expected_moved=false, observed_moved=true). |
| O10_MERGER_INVOCATION_COUNT | YES | observed 1 finalize_merge step.running vs expected 0 on a refusal cell. |
| O10_REFUSAL_DIAGNOSIS | YES | strict refusal lacks the exact mechanical self-diagnosis (finalize output is a landing report — `STATUS: landed`, no FAILURE_CLASS: refused_permanent / LEDGER_EVIDENCE / exact key fields; missing keys list all 9 required). |
| O10_REROUTE_COUNT | YES (refusal doctrine) | the strict missing/green refusal doctrine GENUINELY bounds reroutes: exactly one obstructing reroute before refusing. finalize_merge DB terminal_reroute_count 0 AND event count 0 != decision-table bound 1 -> refusal-count-mismatch. This is NOT reconciled away (real-cell rule keeps the exact bound on refusal cells). |
| O10_EVENT_SET_MISMATCH (seal) | YES | merge-gate subset expected `[run.failed]` vs observed `[merge.landed, run.completed]` — the run landed instead of refusing; the exact-set seal fires. Lifecycle itself is clean (no anomalies), confirming the mismatch is the seal, not a multiplicity artifact. |

Verdict: **O10 FAIL** — genuine, must NOT be absorbed.

### W4.dsh-fdmw — O10 FAIL (9 genuine findings)

Launch: `merge_gate=null`, `fail_missing=null` -> mode default, non-strict
missing-evidence concession cell (`expectedCell` -> lands=true, reroutes=1,
merger_invocations=1, annotations=[merge.landed_without_suite_evidence]).
Evidence missing (ledger 0 rows). Observed: run canceled via controller stop
(`run.canceled` terminal) before any step executed — no step.running, no
landing, ref unmoved, merger never invoked.

Replayed findings (all yielded by the recalibrated model):

| Finding | Fires? | Mechanical justification |
|---|---|---|
| O10_EVENT_SET_MISMATCH (seal) | YES x1 | merge-gate subset expected `[merge.landed, merge.landed_without_suite_evidence, run.completed]` vs observed `[run.canceled]` — a canceled terminal where the decision table says completed is an anomaly (run.canceled is deliberately on the observed side of the seal). |
| O10_EVENT_SET_MISMATCH (lifecycle) | YES x5 | running-count-mismatch on implement/plan/setup/test/verify: each step row derives 1 expected execution, observed 0 — no step ever ran. |
| O10_MERGER_INVOCATION_COUNT | YES | expected 1 (concession landing invokes the merger), observed 0. |
| O10_REF_MOVEMENT | YES | expected_moved=true (lands), observed_moved=false. |
| O10_TERMINAL_DISPOSITION | YES | expected_status=completed (missing-evidence concession), observed canceled in DB, projection, and finalize status. |
| O10_REROUTE_COUNT | NO (heals) | real-cell per-step reconciliation: 0 step.rerouted events == 0 terminal_reroute_count for every step (a controller-canceled run has no reroute activity). Not a refusal cell, so no exact bound. The decision-table `expected.reroutes=1` is the concession's reroute expectation, not a genuine bound — correctly reconciled. |

Default doctrine honored: a controller-canceled run is a GENUINE disposition
anomaly and is NOT silently absorbed — O10 FAILs with 9 findings. Only the
calibration-class reroute finding heals. Verdict: **O10 FAIL**.

### W4.18-flaky-alternator — O10 FAIL (1 genuine finding)

Launch: `merge_gate=null`, `fail_missing=null` -> default non-strict
missing-evidence concession cell (lands=true, reroutes=1, merger_invocations=1,
annotations=[merge.landed_without_suite_evidence]). Evidence missing for the
exact gate key. Observed: run landed with `merge.landed` + `run.completed` but
WITHOUT the `merge.landed_without_suite_evidence` concession annotation
(observed subset `[merge.landed, run.completed]` vs expected `[merge.landed,
merge.landed_without_suite_evidence, run.completed]`).

- O10_EVENT_SET_MISMATCH (seal): YES — the run landed WITHOUT the required
  concession annotation; the exact-set seal fires. This is NOT a calibration
  class (lifecycle is clean: every step 1/1; the mismatch is purely the missing
  annotation on the seal).
- O10_REROUTE_COUNT: NO — 0/0 reconciles (no reroute activity; not a refusal
  cell).
- All other checks satisfied (completed terminal, ref moved, 1 merger
  invocation).

Verdict: **O10 FAIL** — the missing-concession seal finding is genuine and
survives recalibration (this is why W4.18 is NOT in the 21 PASS set).

### W4.29-strict-gate-retry-finalize — O10 ERROR (unchanged, non-reconciliation)

- `refs_before.target_ref = refs/heads/main` vs `refs_after.target_ref =
  refs/heads/security-audit-2026-08-27` — target-ref identity CHANGED between
  snapshots (dynamic merge target for the security-audit-merge workflow).
- The recalibrated model throws `ORACLE_RUNTIME_ERROR("target ref identity
  changed between snapshots")` at the ref-identity gate, BEFORE any per-run
  FMIS decision-table check — the same non-reconciliation ERROR class the S26
  pin keeps (a stored non-reconciliation ERROR must NOT heal).
- Per-run FMIS evidence check (audited manually from the snapshot): the W4.29
  finalize_merge `updated_at` is `2026-08-27 00:52:57`; the suite ledger holds
  a green (exit 0) exact-key row (id 13) for the attested merged tree
  `a37157bd…` with `created_at 2026-08-27T00:45:34.157Z` <= decision time —
  so had the ref identity been stable, the decision table would be satisfied
  (evidence green -> lands with no annotations) and the per-run checks would
  evaluate the completed/landed/ref-moved/1-invocation run as conforming.
- Author-listed MERGER_INVOCATION_COUNT / REF_MOVEMENT / TERMINAL_DISPOSITION /
  REFUSAL_DIAGNOSIS: **NOT yielded** — the ERROR short-circuits before the
  decision-table loop (and the evidence is green anyway, so no decision-table
  finding would fire). They are not silently absorbed; they never fire on this
  class. W4.29 must replay O10 ERROR per the S26 pin.

## Full replay delta table (proving every non-O10 row byte-identical)

The machine-readable replay rows were written to the tool's `--json` path.
Non-O10 flips (exactly 2, both S26-class O9 heals):

```
W4.01-missing-evidence-reroute  O9  FAIL -> PASS  before=[O9_REPLAY_ROW_MISSING, O9_REPLAY_ROW_MISSING] after=[]
W4.02-fail-missing-refusal      O9  FAIL -> PASS  before=[O9_REPLAY_ROW_MISSING]                        after=[]
```

Every other non-O10 pair (265 rows) is `same` with before-finding ids
identical to after-finding ids (programmatic scan: 0 mismatches). O10 rows:
21 PASS (listed above), 3 FAIL (W4.17-b / W4.18 / W4.dsh-fdmw, finding ids
documented above), 1 ERROR (W4.29, `ORACLE_RUNTIME_ERROR` unchanged). The
tool's digest check reports `source_campaign_unchanged: true`; independently
recomputed campaign digest before/after the audit replays is identical
(2414 files; sha256 of the sorted digest = `4be018afe0c1ddc4c6b3ef97da543ec1b4
b3f7c52f55826f84c5332821c8ed6a`).

## Tests

`torture-test/bin/tt-oracle-replay-invariants.test.mjs` gained the US-004
tests:

- `verifyS27AuditShape` unit pin: accepts the exact post-S27 attempt-2 delta
  shape (21 O10 PASS incl. W4.01 heal, W4.17-b/W4.18/W4.dsh-fdmw FAIL with
  their documented finding ids, W4.29 ERROR unchanged, 2 O9 heals, every
  non-O10 non-O9 row byte-identical) and rejects: an O10 survivor losing a
  genuine finding; an honest non-O10 flip; a W4.01-class stored FAIL that does
  not heal; a reconciliation ERROR that does not heal.
- e2e: `tt-oracle-replay` with the S27 audit pin against the attempt-2
  campaign exits 0 and the JSON rows match the documented assertions (skips
  when the read-only campaign evidence is absent, mirroring the preval pin).

## Notes

- Zero tokens (evidence replay only; no daemon, no model).
- Live daemon / `~/.tamandua` untouched.
- Attempt-2 evidence and snapshots unmodified (digest above).
- Diff confined to `torture-test/`.
