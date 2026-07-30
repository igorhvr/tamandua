# Tamandua Torture-Test Specification

**Status:** DRAFT — designed 2026-07-30 from a fresh audit of the codebase
(main @ `74a750d`), the full 480-commit defect history, and 852 archived
production runs; hardened through multiple adversarial review rounds.
Single-host by design: the campaign runs on whatever machine it is
launched on (01).

**Mission.** Tamandua has ~2,000 users, ~500 of them daily. A regression that
phantom-merges, loses work, wedges runs, or burns tokens silently now has a
blast radius measured in other people's repositories and API bills. This suite
is the release gate: a campaign of predominantly **real, token-spending
workflow runs** designed to make tamandua fail *here*, under adversarial
load, before it fails *there*. The campaign is **single-host**: it runs
entirely on whatever machine it is launched on, adapting to that host's
capability profile (01). Running it in additional environments simply
means running the campaign again there — the operator's choice, outside
this spec.

## Design principles

1. **Real-first.** The worst historical bugs (WDGM watchdog kills, hermes
   zero-token attribution, FMIS gate refusals of legitimate merges) were
   invisible to the scripted/fake tiers because the fakes had pinned the wrong
   contract. Scripted e2e is used here only as a cheap preflight gate (Wave 0)
   and as the storm's zero-token rehearsal harness. Every wave after W0
   spends real tokens through real harness binaries.
2. **Mechanical oracles over agent self-report.** Agents rationalize red
   suites as "pre-existing", fabricate PR URLs, and fix bait bugs out of
   scope. No scenario passes because an agent said `STATUS: done`; scenarios
   pass when SQL/git/filesystem invariants hold (see `03-oracles.md`).
3. **Adversarial by construction.** Every scenario traces to a defect class
   tamandua has actually suffered (see `10-defect-traceability.md`) or to a
   seam the audit identified as fragile.
4. **Escalating waves.** Complexity and concurrency ramp: smoke → full
   catalog → harness duel → fault injection → an 8-simultaneous-run mixed
   storm on a single project. Early waves gate later ones so a broken build
   never burns the storm budget.
5. **Isolated but production-shaped.** Dedicated torture environment (own
   HOME for spawned processes, own ports, state dir, worktree root),
   provisioned like a user install. Isolation is itself verified.
6. **Budgeted, tiered, and honest about cost.** Two execution tiers (below);
   budgets derived from per-family production medians, not global medians;
   hard abort criteria; an outcome taxonomy that keeps provider outages and
   agent flakes out of the product-bug column.
7. **The case manifest is the single source of truth.** Run counts, budgets,
   and the wave map below are *views* of `cases.jsonl`; the controller
   regenerates this table, and a hand-edited number that disagrees with the
   manifest is a spec bug (hand-maintained count tables drifted twice
   during review).

## Execution tiers

Tiers are **host capability profiles**, not machine names (01):

- **Tier-1 (MVP, first execution):** ~40 runs, ~24–30h, ~15M tokens;
  requires only {node ≥22, python3}; fixtures tt-ts + tt-python
  (+ tt-poly-lite). Covers the S0/S1-generating defect classes. Marked
  `T1` in the wave files' scenario tables. Run this FIRST; its measured
  durations and spends calibrate the full campaign's budgets.
- **Tier-2 (full campaign):** everything in this spec — all five
  languages, all 20 non-PR workflows, the full harness matrix, the full
  storm. ~48h, **~50M tokens soft / 65M hard** (honest per-family
  arithmetic; see `11-schedule-budget-abort.md`). Requires all five
  toolchains passing W0.0's build+test probe; a host below that either
  gets provisioned first (P0) or runs at the tier it supports, with
  every descoped lane recorded `NOT_RUN (predicate)`.

## Wave map (Tier-2; regenerate from manifest)

| Wave | Name | Window (T+) | Peak conc. | Real runs (≈) | Token soft/hard |
|------|------|-------------|------------|--------------------------|-----------------|
| W0 | Preflight & environment gates | pre-day + 0–4h | scripted | 2 canaries | 0.5M / 1M |
| W1 | Language smoke | 4–8h | 2 | ~17 (incl. replay relaunches) | 3M / 4M |
| W2 | Full workflow catalog + CLI/authoring surface | 8–20h | 3 | 29 (7 of them ≈zero-token) | 10M / 13M |
| W3 | Harness duel: fdmw/bfmw, pi vs hermes | 10–34h | 4–5 | 21 | 20M / 26M |
| — | Triage block A (post-W2) | 20–22h | — | — | — |
| W4 | Fault injection & adversarial ops | 26–38h | 3 | ~45 scen. (~20 token-bearing; the rest scripted/zero-token) | 6M / 8M |
| — | Triage block B (post-W3/W4 core) | 34–36h | — | — | — |
| W5 | The storm — Round A clean 8+2, Round B chaos ×5 | 38–46h | 8 active + 2 queued | 15 | 12M / 16M |
| W6 | Forensic audit & report | 46–48h | — | 0 | ≈0 |

Total ≈ 110 runs (Tier-2; ~80 token-bearing). These
prose counts are VIEWS: `cases.jsonl` is authored first, counts/budgets are
derived from it mechanically, and the controller refuses to start while
prose totals and manifest disagree (both external reviews caught count
drift in hand-maintained tables — twice). Wave windows overlap by design
(W3 spans 24h; lanes are concurrency-partitioned, not time-partitioned).
Gates auto-open on green mechanical criteria — no human is required awake
at 03:00 (11).

## Document map

| File | Contents |
|------|----------|
| `README.md` | This file — mission, principles, tiers, wave map. |
| `01-environment-and-isolation.md` | Single-host model, capability profiles & predicates, platform facts, P0 provisioning, TT-env design (controller vs spawn env!), credentials, isolation probe. |
| `02-fixture-projects.md` | Language fixtures + `tt-poly`/`tt-poly-lite`; seeded-defect calibration protocol; junk probes; reset & disk budgets. |
| `03-oracles.md` | Oracle battery O1–O17 (tiered; incl. O16 held-out probes, O17 test-inventory), outcome taxonomy incl. INVALID, scenario classes & sample sizes, severity gates, KNOWN-OPEN waivers. |
| `04-wave-0-preflight.md` | Zero-token gates, dress rehearsal, canaries. |
| `05-wave-1-language-smoke.md` | Per-language plumbing validation. |
| `06-wave-2-workflow-coverage.md` | 20 workflows + authoring/CLI/branch-shape scenarios. |
| `07-wave-3-harness-duel.md` | fdmw/bfmw matrix, lifecycle probes, the hermes marathon. |
| `08-wave-4-fault-injection.md` | Gate corridor, moving targets, process violence, contract traps, hermes stream/resolver torture, launch/control-plane hostility, provider/auth faults, composed faults, migration/weird-git/resource lanes, platform-conditional lanes; injection discipline. |
| `09-wave-5-storm.md` | The two-round storm (clean 8+2, then chaos); queue math; simultaneity check; success bands. |
| `10-defect-traceability.md` | Defect catalog DC01–DC50 → scenario matrix; accepted gaps. |
| `11-schedule-budget-abort.md` | Timeline, per-family budget derivation, caps, abort criteria, triage blocks, verdicts & waivers. |
| `12-runner-automation.md` | Controller/oracle/chaos/fixture tooling contract, effort estimates, phasing. |

## Non-goals

- **No multi-machine orchestration.** The suite runs on one host; running
  it in several environments is running it several times, and comparing
  those campaigns is an operator activity over the archived reports.
- The three `*-github-pr` workflows are excluded (external side effects).
- Not a model-quality benchmark; behavioral scenarios use class-level
  statistics (03) and only *mechanical* violations block on one occurrence.
- No production-instance testing; production untouchedness is asserted (O15).
- No Windows; no multi-user surfaces (tamandua is single-user today).
