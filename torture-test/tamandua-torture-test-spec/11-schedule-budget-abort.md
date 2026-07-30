# 11 — Schedule, Budget, Abort Criteria

## Execution order across campaigns

**Tier-1 first, always.** The MVP tier (~40 runs, ~24–30h, ~15M tokens; the
`T1`-marked scenarios) runs as its own campaign before any Tier-2 attempt.
Tier-1's measured durations and spends replace the production-derived
estimates below for Tier-2 planning — the numbers in this file are honest
*priors*, not measurements.

## 48-hour timeline (Tier-2; T+0 = campaign start, preceded by the W0 dress-rehearsal day)

```
         0    4    8    12   16   20   24   28   32   36   40   44   48
         [W0 ][ W1 ][----W2-----][TrA]
                    [------------W3 (24h window)-----------]
                                        [------W4------][TrB]
                                                       [----W5----][W6]
```

- **Triage blocks are scheduled, not aspirational:** TrA (T+20–22h) and TrB
  (T+34–36h, overlapping W4's tail) are reserved for S0/S1 bundle reads and
  post-triage re-runs. In-campaign human attention is budgeted at S0/S1
  bundles ONLY; S2 bundles queue for post-campaign review. (At ~102 runs
  and a 15% non-PASS rate, unscheduled triage would silently consume
  9–17 person-hours the first draft never accounted for.)
- **Gates auto-open:** a wave gate opens automatically when its mechanical
  criteria are green and no unwaived S0/S1 is outstanding — no human
  approval required at 03:00. Humans review asynchronously and may
  retroactively quarantine a lane. Only S0 pages a human and blocks.
- **Staffing:** either one supervisor across two 24h days with the sleep
  boundary at the TrA gate (campaign pauses new launches, in-flight runs
  finish into a harvest-only window), or two people on 12h shifts. Name the
  humans in `results/manifest.json` before T+0. The controller is assumed
  to be the buggiest component in its first campaign — W0.8's crash/resume
  drill exists for that reason, and 3+ TEST_INFRA_FAILs in one wave trigger
  a tooling stand-down (03).
- **Wave accounting for long runs:** in-flight runs launched inside a
  wave's window continue under THAT wave's token cap and concurrency
  allocation until terminal; new launches for the wave stop at
  window-close. The controller tracks per-wave in-flight counts separately
  from the active wave's roster (without this rule, a marathon launched at
  T+32h is unaccountable at T+35h).
- Slack: ~4h explicit (TrA/TrB double as slack when triage is light) +
  shed list. `SHED-OK` (sheddable without harming the release verdict):
  W4 groups E-partial (W4.19, W4.34), W4.24, W3 comparative extras
  (W3.02/03 rust/go pi cells), post-P0 language breadth. The storm is never
  shed; storm-prerequisite scenarios are never shed.
- **Descope ladder per wave (pre-declared, not improvised):** each wave's
  manifest carries an ordered drop list (wave's `SHED-OK` members first,
  then designated `T2-only` cells). At **75% of a wave's wall window
  elapsed with <75% of its roster terminal**, the controller auto-descopes
  down the ladder — it stops launching from the bottom of the list and
  logs each drop to `gates.jsonl`. Descoping is a recorded schedule fact,
  never a silent one: the final report lists every dropped scenario as
  NOT_RUN with the ladder step that dropped it. Improvised 3am descope
  decisions pick the wrong victims; the ladder was chosen rested.
- **In-wave reserve:** ~25% of each wave's wall window is reserved for
  triage, oracle sweeps, and harvest — a wave whose launches occupy its
  full window has no time to notice what happened in it. The window
  figures in the timeline above already assume this; controllers schedule
  launches against 75% of the window.
- **Destructive-injection staffing rule:** daemon-kill, DB-mutation, and
  mass-chaos scenarios (W4 §C, W4.48, the storm's Round B) execute only
  while an operator is within their first **16h of continuous duty**, and
  only from the **pre-authorized action list** in the manifest (exact
  commands, exact targets). An exhausted operator improvising a `kill -9`
  target is how a torture campaign destroys its own evidence — or worse,
  production state. Anything not on the list waits for the next duty
  window.

## Token budget (Tier-2; per-family derivation)

Priors (808-run archive): do-now ≈ 80k avg; bug-fix/bfmw p50 ≈ 256k,
p95 ≈ 1M; fdmw p50 ≈ 793k, p90 ≈ 2.1M; hermes ≈ 6.8× pi per family;
security/quarantine merge families 300–800k.

| Wave | Soft | Hard (wave aborts) | Basis |
|------|------|--------------------| ------|
| W0 | 0.5M | 1M | 2 canaries + margin |
| W1 | 3M | 4M | 5 bug-fix chains ≈ 1.3M + 15 small ≈ 1.2M + replays |
| W2 | 10M | 13M | 4 feature-family ≈ 3.2M + hermes sec-merge ≈ 2M + 15 mixed ≈ 4M |
| W3 | 20M | 26M | hermes bfmw 2×2M + marathon ≈ 5M + fdmw pi 3×0.8M + bfmw pi 5×0.3M + lifecycle ≈ 3M + slow-host/retry headroom ≈ 3M |
| W4 | 6M | 8M | ~20 token-bearing small runs |
| W5 | 12M | 16M | Round A: 3 hermes (fdmw+bfmw+drdv) ≈ 7M + 5 pi ≈ 3M; Round B reduced roster ≈ 2M |
| **Campaign** | **~50M** | **65M hard abort** | |

Calibration: ~25% of total production dogfooding spend to date, for one
release-gating campaign protecting 500 daily users. The first draft's
30M/40M numbers were derived from the global run median (dominated by
352 tiny do-now runs) and would have self-aborted mid-W3; per-family
arithmetic is the only honest basis. Tier-1 costs ~15M and is the
affordability rung.

**Per-run caps sit at family p95** (pi bfmw 1M / pi fdmw 2.5M / hermes
bfmw 4M / hermes fdmw+marathon 8M / storm runs +25%): the cap is a
runaway-loop tripwire, NOT a budget device — a canceled run has already
spent to its cap, so **run-count is the budget control** and the shed list
is the pressure valve. These are **observed-spend thresholds**, not true
limits: `runs.tokens_spent` updates only when a round completes, so a
single oversized in-flight round is invisible to the 5-min poll and its
spend may exceed the threshold before detection (worst case ≈ one round's
spend; budget reserves headroom for it). Cap breach → `workflow stop` +
`RUNAWAY` triage. Wall-clock caps likewise: `--wait --timeout` only stops
the controller's WAITING (exit 2) — it does not stop the run — so
`wall_min` enforcement is the controller issuing `workflow stop` and
waiting for terminal cleanup; **fixture reset is prohibited while any
associated run is live**.

## Evidence capture before destruction

Every kill/delete/mutate injection is preceded by the capture protocol
(automated in `tt-chaos`, not operator memory): snapshot the target run's
DB rows (run, steps, events tail), the target process tree
(pid/pgid/cmdline/cwd), relevant worktree `git status` + HEAD, and the
daemon log tail into the scenario's forensics directory — THEN fire. A
destructive injection whose pre-state wasn't captured produces an
unattributable failure; the case is INVALID and the injection is not
retried until the capture path is fixed. (The protocol costs seconds; the
alternative cost is a 4-hour storm whose one interesting wreck can't be
diagnosed.)

## Abort & degradation criteria

- **Hard abort (campaign):** any unwaived S0; campaign spend > 65M; the
  campaign blocked > 4h on TEST_INFRA_FAIL.
- **Wave abort:** wave hard cap; or mechanical PRODUCT_FAIL rate > 50%
  (build too broken to keep spending — stop, fix, restart at W0 with a new
  `TT_COMMIT`).
- **Lane quarantine:** a harness×language cell failing twice mechanically
  is pulled from later waves and filed; campaign continues.
- **Provider outage playbook:** ≥3 PROVIDER_FAILs in 30min → pause launches
  30min, resume with 2× stagger; outage > 2h → shift schedule and shed
  `SHED-OK`; never reclassify provider errors as product failures.
- **Restart semantics:** aborted campaigns restart at W0; W1–W2 scenarios
  that passed may fast-forward IF `TT_COMMIT` is unchanged. Any new
  `TT_COMMIT` = full restart (the suite certifies a commit, not a vibe).

## Exit criteria — three independent outcomes (W6)

The campaign is judged on three axes, reported separately (collapsing
them is how "we ran a lot of tests" masquerades as "the product is
sound"):

1. **Execution validity** — did the suite itself run honestly? W0 gates
   passed; oracle self-tests + calibration pack green; INVALID +
   TEST_INFRA_FAIL rate under 10%; manipulation checks (simultaneity,
   injection phase-provenance, oracle mutation self-tests) clean. If this
   axis fails, the other two are unreportable — the campaign result is
   "the suite needs work", full stop.
2. **Suite sensitivity** — did the suite demonstrate it can detect?
   KNOWN-OPEN reproductions confirmed (each pre-registered seam actually
   reproduced); the known-negative dress-rehearsal case (12) caught; O16
   held-out probes exercised. A campaign whose tripwires never fired on
   the seams KNOWN to exist proves nothing by staying green.
3. **Product findings** — the actual verdict below.

**Zero product findings with axes 1 and 2 green is a legitimate,
publishable success** — the release verdict the campaign exists to
produce — and simultaneously the trigger for the calibration-tightening
loop (harder variants next campaign). Zero findings with axis 1 or 2 red
is not a success; it is an unread instrument.

## Verdicts (W6)

`CERTIFIED` / `CERTIFIED-WITH-FINDINGS` / `REJECTED`, where:

- KNOWN-OPEN reproductions (pre-registered against bd issues — currently
  W4.04a, W4.20/HARN, W4.29/H1, the get-ready port bug) **do not affect
  the verdict**; they confirm the register. Without this rule the campaign
  is unfalsifiably REJECTED until every pre-known seam is fixed (03).
- Any NEW unwaived S1 → REJECTED. S2-only findings →
  CERTIFIED-WITH-FINDINGS.

## Artifact retention & the final report (W6, T+46–48h)

W6 executes: full oracle battery (gating + post-batch); O15 production
untouchedness; worktree GC verification + actual prune; process-leak
final sweep; DB + events archived; fixtures torn down to goldens. (The
archived report is deliberately self-contained so campaigns run on
different hosts can be compared by the operator afterwards — that
comparison is outside the suite.)

Report contents (controller-generated, human-reviewed):
1. Verdict + findings list with severities and waiver status.
2. Scorecard: scenarios by wave × outcome class; class-level behavioral
   rates vs advisory thresholds; pi-vs-hermes comparative table.
3. Every PRODUCT_FAIL with forensics path + proposed bd issue title
   (findings become `bd create` entries — the suite's output is issues).
4. Spend & wall-time per wave/harness/language vs budget; measured
   per-family medians (the calibration handoff to the next campaign).
5. Calibration proposals: scenarios that were 100%-green with no
   near-misses get harder variants; a green-storm tightening proposal if
   W5 produced zero findings.
