# Tier-1 cap calibration (S8b)

Recalibration of tier1 wall caps (and the two token caps the probe
sequences structurally force) from campaign #7 review item S8
(`tier1-suite-defect-backlog`, campaign-20260813T123604986Z).

## The rule

**Caps are at family p95, never below the family p50.** A cap breach
cancels the run and files `RUNAWAY`/`ATTRIBUTION_SUSPECT` triage, so a cap
set below the honest duration of its case's probe sequence cancels honest
runs and destroys the very evidence the case exists to collect. Caps
protect the ceiling, not the wave budget — run-count is the budget control
(11-schedule-budget-abort.md: "Per-run caps sit at family p95 ... the cap
is a runaway-loop tripwire, NOT a budget device"; 07-wave-3-harness-duel.md:
"Caps are at family p95, not p50 — a cap breach cancels the run ... Caps
protect the ceiling, not the wave budget").

Family wall numbers used as floors (07-wave-3-harness-duel.md
§Production calibration, 808-run archive): **bfmw p50 35min**;
**fdmw p50 138min / p90 519min**. Lifecycle cases are sized to their
probe sequences: launch count × the family unit plus any mandated
hold components (e.g. the 10-min pause in W3.18), with the family p50
as the floor for any case whose sequence includes a full family
lifecycle (W3.20's run 2 must reach `finalize_merge`; W3.21 resumes the
same run id to completion).

## Changed caps

| Case | Field | Old | New | Justification |
|------|-------|-----|-----|---------------|
| W1.L3-python | caps.wall_min | 10 | 20 | Bug-fix-family pi floor >= 20 prescribed by S8 (campaign-20260813T123604986Z observed 10-min caps cancelling honest bug-fix runs); 05-wave-1-language-smoke.md §W1.L3 runs the full triage->fix->verify chain. |
| W1.L3-ts | caps.wall_min | 10 | 20 | Same as W1.L3-python: S8 bug-fix pi floor (campaign-20260813T123604986Z); 05-wave-1-language-smoke.md §W1.L3. |
| W2.22-non-main-bfmw | caps.wall_min | 20 | 35 | bfmw family p50 35min (07-wave-3-harness-duel.md §Production calibration); family caps never below p50. |
| W2.24-docs-drift | caps.wall_min | 5 | 15 | 3-step plan/setup/implement workflow (06-wave-2-workflow-coverage.md §W2.24) = 3 x the do-now unit 5min (W1.L1 tier1 cell). |
| W2.24-docs-drift | caps.tokens | 200000 | 600000 | 3 agent rounds x the do-now per-run ceiling 200k (05-wave-1-language-smoke.md §W1.L1 tier1 cell); per-case spend accumulates across the plan/setup/implement rounds (06-wave-2-workflow-coverage.md §W2.24). |
| W3.01-bfmw-pi-python | caps.wall_min | 20 | 35 | bfmw family p50 35min (07-wave-3-harness-duel.md §Production calibration); family caps never below p50. |
| W3.02-bfmw-pi-ts | caps.wall_min | 20 | 35 | bfmw family p50 35min (07-wave-3-harness-duel.md §Production calibration); family caps never below p50. |
| W3.04-fdmw-pi-ts | caps.wall_min | 30 | 138 | fdmw family p50 138min (07-wave-3-harness-duel.md §Production calibration); S8 prescribes >= 138 or marathon re-classification. Re-classification was NOT chosen: it would require a class-field change outside this story's caps-only scope, so the wall cap sits at the p50 floor (the family p90 is 519min — the ceiling is bounded by the 20M W3 window and the campaign abort in 11-schedule-budget-abort.md). |
| W3.18-pause-no-drain | caps.wall_min | 20 | 148 | fdmw p50 138min + the probe's mandated 10-min pause hold (07-wave-3-harness-duel.md §C W3.18: "resume after 10min"); the pause consumes wall while the run is parked. |
| W3.19-pause-drain | caps.wall_min | 20 | 180 | Hermes fdmw, 2-3 stories with drain park/resume (07-wave-3-harness-duel.md §C W3.19); the only spec hermes-fdmw wall reference is the W3.17 marathon ceiling wall_min 180 (07 §B / tier1.jsonl), which is the honest cap for a multi-story hermes fdmw lifecycle. |
| W3.20-cancel | caps.wall_min | 20 | 138 | Two sequential fdmw pi runs; run 2 cancels during finalize_merge, which requires reaching a full lifecycle (07-wave-3-harness-duel.md §C W3.20) -> fdmw p50 138min floor. |
| W3.21-fail-force-resume | caps.wall_min | 20 | 138 | Same run id fails mid-cycle and resumes to completion (07-wave-3-harness-duel.md §C W3.21) -> one full fdmw lifecycle, p50 138min floor. |
| W3.22-daemon-restart | caps.wall_min | 20 | 138 | Three concurrent fdmw pi runs must each reach terminal across a restart (07-wave-3-harness-duel.md §C W3.22) -> fdmw p50 138min floor. |
| W3.23-token-saver | caps.wall_min | 5 | 10 | Two do-now launches (flagged + control, 07-wave-3-harness-duel.md §C W3.23) = 2 x the do-now unit 5min (W1.L1 tier1 cell). |
| W3.23-token-saver | caps.tokens | 200000 | 400000 | Two do-now launches accumulate against the per-case token ledger (11-schedule-budget-abort.md: observed-spend threshold is per case) = 2 x the do-now unit 200k (W1.L1 tier1 cell). |

## Classification statement (W3.04)

W3.04-fdmw-pi-ts remains `class: verification`. It is NOT re-classified
marathon-length: the >= 138 wall cap path was taken (marathon-length
classification would have required editing the `class` field, outside the
caps-only scope of this change). Its token cap (2.5M = pi fdmw family p95,
11-schedule-budget-abort.md) was already family-correct and is unchanged.

## Scope discipline

Only `caps` values on the lines named above were edited in
`cases/tier1.jsonl`; every changed value has one row in this table.
All other fields and lines are owned by concurrent E3 stories and were
left untouched.
