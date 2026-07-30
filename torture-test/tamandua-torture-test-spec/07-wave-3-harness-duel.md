# 07 — Wave 3: Harness Duel — fdmw/bfmw under pi and hermes (T+10h → T+34h, soft 20M / hard 26M tokens)

The user-visible heart of tamandua is `feature-dev-merge-worktree` (fdmw)
and `bug-fix-merge-worktree` (bfmw). This wave hammers both, A/B across
harnesses and languages, and probes the run-lifecycle controls production
uses daily (29% of all production runs are cancels). The window is a full
24h spanning W2/W4 (lanes are concurrency-partitioned): concurrency 4–5
(2 pi + 2 hermes lanes + lifecycle probes).

Production calibration (per-family, from the 808-run archive): bfmw p50
35min / 256k tokens; **fdmw p50 138min / p90 519min, p50 793k / p90 2.1M**;
hermes averages ~6.8× pi's spend. The first draft's matrix (hermes on all
five languages for bfmw + three for fdmw) costs ~30M in this wave alone and
cannot fit 16h — this revision trims to the information-bearing cells and
lets Tier-1's measured numbers recalibrate Tier-2.

## A. The matrix

| Cell | Runs | Per-run cap (≈family p95) |
|------|------|---------------------------|
| bfmw × pi × all five languages | 5 (W3.01–05) `T1: python, ts` | 1M |
| bfmw × hermes × {java, ts} | 2 (W3.06–07) `T1: ts` | 4M |
| fdmw × pi × {java, python, ts} | 3 (W3.11–13) `T1: ts` | 2.5M |
| fdmw × hermes | covered by the marathon (W3.17) + storm S2 | 8M |

Task selection exploits the archetype system (02): the bfmw matrix uses
the **red-herring archetype** (symptom points at the wrong module —
investigator depth under retry pressure) plus one **perf-bug cell**
(threshold test invites weakening — O8's checksum guard is the backstop);
fdmw uses the cross-cutting ≥5-file features. One fdmw cell runs the
max-story ambiguous-spec feature on tt-python — it carries the embedded
**wrapper-stability micro-check** (test_cmd byte-identical in context at
EVERY claim across a long loop; `$(sentinel)` canary never executes) at
zero extra cost. **A/B pairs run against separate origin instances of the
same fixture** (`tt-ts-a`/`tt-ts-b`) so harness comparison isn't polluted
by merge ordering. Hermes lanes launch at wave open, all in parallel
(serially they cannot fit any window); their per-case deadline is
`clamp(W1-measured hermes p90 × 3, 2h, 8h)` — W1's hermes calibration is
a deliverable, not trivia — and the controller materializes projected
latest-terminal time at wave open, cutting the hermes set pre-emptively
if the projection exceeds the window (decided at wave open, not
discovered at hour 12). Hermes rounds colliding with the role timeouts is
IN scope: record every worker_timeout + orphan recovery rather than
avoiding them.

**Caps are at family p95, not p50** — a cap breach cancels the run
and files `RUNAWAY`/`ATTRIBUTION_SUSPECT`; note 24% of production fdmw runs
exceeded the first draft's 1.2M cap, which would have flooded triage with
false RUNAWAYs and destroyed the A/B data. Caps protect the ceiling, not
the wave budget — run-count is the budget control (11).

Comparative report at wave end (informative, not gating): per-cell tokens,
wall time, story retries, verify rejection rates, abandonment counts —
with launch order and model/provider ids recorded, and NO parity
conclusion drawn from n=1 pairs (the oracle-grade harness comparison is
the scripted **adapter conformance matrix**: one canonical transcript set
— success, honest retry, malformed output, timeout, mid-stream death,
token-report variants — driven through BOTH adapters via the scripted
runtimes, requiring identical state transitions on every shared dimension
and correct per-adapter token mapping; it runs in W0.2 and re-asserts
here). Systematic hermes-only mechanical failures (lost completions,
attribution gaps, timeout interactions) are PRODUCT_FAILs.

Per-run instrumentation beyond the standard harvest: `steps`-table
snapshot at terminal (retry/reroute/abandon counters per step — the
merger is the historical retry hotspot); STORIES_JSON acceptance counts
(any *silent story collapse* — stories < planned without a rejection — is
S1-class); every `step.worker_lost` event must carry exitCode/signal/
stderrTail forensics; hermes per-round trailer capture rate and
`tokens_spent` deltas; all submit-time `REJECTED:` texts collected
(informed, not generic — O11). Natural-coverage note: the red-herring
cells make honest `STATUS: retry` verify verdicts likely — confirm story
reset (not step-retry burn) when they occur; if none occurs naturally,
W4.14's scripted variant is the deterministic backstop. TSTX cross-run
replay here is observe-and-record only (merges move tips, so
identical-tree encounters aren't guaranteed; assert only zero replays for
changed trees — deterministic replay coverage lives in W0.4/W4.27).

## B. The hermes marathon — W3.17 `T1`

One fdmw (tt-poly; tt-poly-lite in Tier-1; hermes) with a feature
spanning two language subtrees, sized for a long multi-round life. Three
distinct timeout mechanisms are in play and each assertion names its
target (an earlier draft conflated them): (1) the **harness round timeout**
(role-based, wraps a single `runRound` call: coding 90min / verification
60min); (2) the **abandoned-step threshold** (global, ~95min); (3) the
**stale-claim sweep** (per-agent, 1.5× role timeout = 135min for coding).

DC40 — "hermes rounds outlive the worker timeout and churn" — is
unreproduced folklore, and a naturally long run does NOT guarantee any
single round crosses the 90min wall (total duration ≠ round duration). So
the marathon is two parts:

- **W3.17a (natural, advisory):** the marathon as described; record round
  durations; if a round happens to cross the wall, the deterministic
  assertions below apply to it.
- **W3.17b (deterministic, gating):** `tt-chaos` SIGSTOPs the active
  harness process mid-round until wall-clock exceeds the round timeout,
  then SIGCONTs. Assertions: the round is terminated ONCE, attributed, and
  retried with `timeout_retry` context — never double-dispatched into the
  same workdir while the group lives (DC7); recovery attribution names
  mechanism (1), not (2)/(3); no watchdog kill of any live round below the
  wall (O4, recorder provenance); the run completes or fails honestly —
  non-terminal past 2× the abandoned threshold is S1.

## C. Lifecycle probes (dedicated cheap runs, both harnesses) — all `T1`

| ID | Probe | Assertions |
|----|-------|------------|
| W3.18 | **Pause (no drain) mid-implement** (pi fdmw); resume after 10min. | Worker killed; step not stranded `running`; resume re-pends and continues; pause/resume attribution recorded; killed round's tokens measured — pause-kill accounting is a KNOWN open gap: report the loss, assert it is bounded and visible. |
| W3.19 | **Pause --drain during an active story** (hermes **fdmw** — bfmw has no story loop, so "between stories" named a state it cannot have; drain is issued while an implement story is claimed and running). | Drain lets the in-flight story's step complete, then parks WITHOUT dispatching the next story; no `draining_pause` wedge (empty-loop-state fossil); resume dispatches the next story. |
| W3.20 | **Cancel mid-implement** (pi) AND **cancel during finalize_merge** (pi, second run). | Terminal event emitted (production gap — DC35); target ref moved XOR clean rollback/park; worktree per policy; no orphan processes. |
| W3.21 | **`workflow fail --force` on a live run**, then `workflow resume`. | Live worker handled per contract; resume reuses the **same run id and run number** (source: `resumeWorkflow` resets the failed run's steps and flips it back to running — it does NOT create a new run; an earlier draft asserted new-run semantics, which belong only to the rugpull-relaunch path, W4.08); restart happens from the failed step with context intact (incl. `--context` keys); no duplicate side effects if it reaches merge again (O2 idempotence). |
| W3.22 | **Daemon restart under load**: `tamandua restart` with 3 W3 runs mid-flight. | Grace-preserving teardown (token flush survives — DC8); all 3 runs progress within 2 dispatch intervals; no wedge, no double dispatch; status truthful throughout. |
| W3.23 | **`--no-hurry-please-save-tokens-mode` smoke** (pi do-now; stub `pi-token-saver` on PATH that appends an invocation record to a known log file then execs real pi). | MECHANICAL oracle (the flag's fallback is silent, so "run completed" proves nothing): the stub's log file exists and contains ≥1 work-spawn record for this run's rounds; a control run WITHOUT the flag shows zero stub records. Exercises the dormant plumbing end-to-end (do not propose removing the flag). |

## D. Platform-conditional assertions `[darwin]`

No extra runs — on darwin hosts the predicate adds assertions to the
lanes above: **W3.26** = the process recorder runs at 5s granularity
alongside one fdmw pi lane, making it the definitive WDGM
false-positive check (O4 zero-tolerance) on the platform where that
defect class was born; W3.18's pause/resume assertions apply unchanged
but their kill/reparenting semantics run under launchd, which is the
point. (Former W3.24/25/27 — duplicate second-host reruns of matrix cells — are
retired: a single-host campaign on a darwin host runs the whole matrix
there anyway.)

## Wave gate (mechanical outcomes only — 03)

Zero unwaived S0/S1; mechanical PRODUCT_FAIL rate < 20%. Behavioral class
rates (BUGFIX reaches n≈19 here) become meaningful and are reported against
their advisory thresholds; a collapse (<50% BUGFIX) triggers investigation
for a *product-side* prompt/persona regression before the storm. Storm
entry additionally requires W3.18–W3.22 green — the storm replays those
exact operations at 8-run scale.
