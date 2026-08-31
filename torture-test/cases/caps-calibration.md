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

## Tier-2 S34 cap recalibration (S34 — the three deadline cells, US-003)

Scope note: this file's primary table (above) is the **tier-1** S8b
calibration and is pinned by `self-tests/tier1-cap-calibration.test.ts`
(tier-1 rows only — a tier-2 row must never be added to that table). The
tier-2 S34 recalibration lives in this section and in
`cases/tier2-traceability.md` (Token Budget Note rows + the
"S34 caps-vs-honest-duration disposition" section), pinned by
`self-tests/tier2-s34-caps-recalibration.test.ts`.

The 2026-08-30 rerun's deadline-sweep race (S34, fixed by US-002's grace
contract) exposed one genuinely-too-tight cap and two genuine stalls:

- **W4.37-keyline-spoof-repo-content (do-now, wall 5 → 10).** The do-now
  unit's honest duration for this cell is **> 5m18s** — both samples are
  cap-truncated (campaign-20260830T111549750Z voided 0s after the deadline
  with the `execute` round still running; campaign-20260826T225744158Z
  `runaway-cap-enforced` at 5m17.7s), and the family's own W4.dsh-do-now
  completed honestly at 5m21.4s. The old 5-min wall cap sat BELOW the honest
  duration — a runaway tripwire firing on honest work, exactly what the
  family-p95-not-below-p50 rule forbids. The 30s grace window alone would
  not have saved it (honest duration > 5m30s).
- **W4.dsh-do-now (do-now, wall 5 → 10, family consistency).** The dsh lane
  policy ("same per-family caps as their pi base rows") means the dsh row
  inherits its base W4.37's cap; its own honest duration (5m21.4s,
  campaign-20260826T225744158Z) already exceeded the old cap.
- **W4.10-kill-daemon and W4.48a-daemon-kill-mid-park (bfmw, wall 55 —
  UNCHANGED).** Both rerun expiries were genuine stalls, not cap breaches:
  the SIGKILLed contained daemon was never restarted during the run
  (lifecycle-log proof: `daemon.uncleanExit` last heartbeat at kill time, no
  `daemon.start` until the sweep teardown 55 min later), so the run could not
  progress and the 55-min cap was consumed by an un-recovered hang. The
  honest corridor (pre-kill pipeline 2m48s / 4m18s + restart + ~2
  dispatch-interval recovery) is an order of magnitude under the cap. The
  grace contract correctly leaves genuinely hung attempts fail-closed; the
  remediation is the single-run kill-daemon operator-restart seam firing
  during the run (scenario/harness side — recorded for the S32-37 landing
  report), not a caps change.

### Tier-2 (S34) changed caps

| Tier-2 Case | Field | Old | New | Decision |
|-------------|-------|-----|-----|----------|
| W4.37-keyline-spoof-repo-content | caps.wall_min | 5 | 10 | recalibrated — honest duration > 5m18s (cap-truncated samples: campaign-20260830T111549750Z, campaign-20260826T225744158Z; W4.dsh-do-now 5m21s honest) |
| W4.dsh-do-now | caps.wall_min | 5 | 10 | recalibrated (family consistency) — inherits base W4.37's cap; own honest duration 5m21.4s |
| W4.10-kill-daemon | caps.wall_min | 55 | 55 | unchanged — genuine stall (daemon never restarted during the run, campaign-20260830T065151712Z) |
| W4.48a-daemon-kill-mid-park | caps.wall_min | 55 | 55 | unchanged — genuine stall (daemon never restarted during the run, campaign-20260830T090310754Z) |
