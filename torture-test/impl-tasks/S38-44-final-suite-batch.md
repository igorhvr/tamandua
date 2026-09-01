# S38-S44: final tier-2 suite batch — adjudication-sourced defects + the operator-seam class

Sources: four-lane adjudication of campaign-20260826T225744158Z (lane reports
summarized in bd memory tier2-adjudication-final) + the S32-37 landing's
US-003 finding. All scripted-provable, zero real tokens. Each item names its
evidence.

1. **S38 snapshot target-ref pinning.** W4.29's O2/O10 ORACLE_RUNTIME_ERRORs:
   refs-before recorded `target_ref: refs/heads/main` but refs-after and
   target-reflog keyed off the checked-out HEAD (`security-audit-2026-08-27`)
   because the worker left its branch checked out. Pin the target ref at
   before-capture and thread it through after/reflog captures
   (oracle-evidence-snapshot.mjs). Red-arm: work-branch-checked-out shape
   reproduces the divergence pre-fix, reconciles post-fix.
2. **S39 W4.29 chaos arming gap.** The delete-tstx-row corridor NEVER fired
   in W4.29's window (chaos.log last firings 23:02/23:19 for W4.01/W4.02
   trees) — the case's premise (evidence made missing under strict gate) was
   never armed, so the case tested nothing. Root-cause the controller arming
   (why the trigger tree/window missed) and fix so the corridor provably
   fires; unfired mandatory chaos must fail closed as TEST_INFRA (loud),
   never silently produce a vacuous verdict.
3. **S40 per-case boundary_files.** All 70 tier2 cases declare the identical
   boundary `fixtures-src/<fixture>/src`. Author per-case boundaries matching
   each task surface (security-audit needs public/; conftest-seeded scenarios
   need their seeded paths; keep them TIGHT — the point is catching genuine
   creep, so widen only where the task mandates it). Update tier2.jsonl +
   traceability; O8 semantics unchanged.
4. **S41 probe-sequence evidence graph.** W4.10-restart-recovery: the probe's
   second run (run-2621299f) is absent from the captured graph
   (workflow-status.json steps_snapshot null, tokens_observed 0,
   discovered_runs []), voiding O1/O2/O11 with mechanical artifacts while the
   product provably retained everything. Register probe-sequence sibling runs
   in the root/discovered graph and capture the root terminal snapshot for
   concurrent shapes; O2's one-transition ref-attribution model must accept
   the two-landing shape when both landings are attributed runs.
5. **S42 W4.17 arming hook.** The task/traceability promise a reset-hook
   arming overlay planting 2 pre-existing red tests; no such hook exists
   (cases/hooks/ has only W4.26/28/30/31) — both W4.17 arms are vacuous.
   Implement the arming hook; un-armed premise must fail closed as
   TEST_INFRA (a scenario whose mandated seed/arm is absent must refuse to
   produce a verdict).
6. **S43 O1 floor calibration + wave reporter.** (a) Refusal/fast-honest
   cells (W4.37, W4.38, W4.47 and any cell whose correct behavior is early
   termination) get `expected_fast_failure: true` or per-cell floors —
   production-median floors statistically flag ~half of honest runs
   (W4.08-control 13%-under with green content oracles). (b) Fix the wave
   reporter dedupe: the do-now family finding was stamped on two reporter
   cases (one not even do-now) — report exactly once from the true final
   wave case. (c) bfmw classification disagreement: state.json TIF
   (chaos-invocation-failed) vs report.txt RUNAWAY for the same run —
   one authoritative precedence, documented.
7. **S44 operator-seam execution class.** Four cells' premises include
   mid-run operator actions that no machinery performs, yielding vacuous or
   stalled runs: W4.10-kill-daemon + W4.48a (restart the killed contained
   daemon during the run — the S32-37 US-003 stall diagnosis), W4.33a
   (daemon restart during the pause hold), W4.33b (`update --force` during
   the hold), W4.47 (invalidate + restore $TT_HOME/.pi credentials around a
   relaunch). Wire these as first-class probe/chaos actions in the
   controller (restart_contained_daemon, update_contained_install,
   invalidate_credentials/restore_credentials) with per-action evidence
   records, fail-closed if the action cannot be performed. Containment
   absolutes: contained daemons/homes only; NEVER the operator's live
   daemon (33xx) or real ~/.pi / ~/.dsh.

## Prove
- Per item: scripted red-arm reproducing the campaign-evidence failure line
  or vacuity, then green post-fix. S44: scripted corridors where each new
  action provably fires and records evidence (contained-scripted daemons).
- Full battery green x2 from repo root with a dirty var/home DB present;
  bare --tier2 GREEN x2; bare --tier1 GREEN.
- Landing report: per-cell rerun map (which of W4.09-pi, W4.10-kill,
  W4.10-restart, W4.17-a, W4.17-b, W4.29, W4.30, W4.33a, W4.33b, W4.33d,
  W4.37, W4.47, W4.48a, W4.48b are now honestly re-runnable).

## Hard constraints
- Files ONLY inside torture-test/. Zero real tokens; do NOT re-run real
  campaign cases. Live daemon (33xx) and real operator credentials
  untouched — S44 actions operate exclusively on contained homes/daemons.
- Do NOT modify campaign evidence/snapshots. Preserve fail-closed
  semantics and oracle seals. TCMD/BRUN/RVOC/RCNT are PRODUCT findings
  awaiting igorhvr's triage — do NOT touch product code.

---

## Landing report (US-011) — S38-S44 per-cell rerun map + full zero-token verification

Source: campaign-20260826T225744158Z (four-lane adjudication, lane reports in
bd memory tier2-adjudication-final) + the S32-37 landing's US-003 finding.
Every fix landed in this run (run-b3895a6b, US-001..US-010) with a scripted
red-arm reproducing the campaign-evidence failure line or vacuity and a green
post-fix — all zero tokens. Files changed ONLY inside torture-test/; campaign
evidence/snapshots untouched; fail-closed semantics and oracle seals
preserved; TCMD/BRUN/RVOC/RCNT product findings left for igorhvr's triage.
Containment absolutes held throughout: S44 actions operated exclusively on
contained homes/daemons — never the operator's live daemon (33xx) or real
`~/.pi` / `~/.dsh`.

### Per-cell rerun map (14 cells)

A cell is marked **re-runnable (US-xxx)** when this batch fixed a
campaign-observed defect of that cell (or the machinery the cell's premise
depends on) with a scripted/zero-token proof — a next real campaign run
exercises the corrected machinery. A cell marked **needs real-campaign
rerun** was NOT addressed by this batch (its defect class was fixed in the
S32-37 batch and is awaiting its real rerun, or it was untouched): zero real
tokens were spent here, so no real rerun happened for those cells.

| Cell | Fixing story | Rerun status |
| --- | --- | --- |
| W4.09-pi-kill-harness | US-004 (S33, S32-37 batch) — untouched by S38-44 | needs real-campaign rerun |
| W4.10-kill-daemon | US-009 + US-010 (S44a/S44b) | re-runnable (corridor-proven) |
| W4.10-restart-recovery | US-004 (S41) | re-runnable (scripted red/green) |
| W4.17-a-red-baseline-land-annotated | US-001 + US-005 (S40/S42) | re-runnable (scripted red/green) |
| W4.17-b-red-baseline-refuse | US-001 + US-005 (S40/S42) | re-runnable (scripted red/green) |
| W4.29-strict-gate-retry-finalize | US-001 + US-002 + US-003 (S40/S38/S39) | re-runnable (scripted red/green) |
| W4.30-detached-head-origin | US-005 (S35, S32-37 batch); US-002 (S38) re-verified no-regression | needs real-campaign rerun |
| W4.33a-daemon-restart-resume | US-009 + US-010 (S44a/S44b) | re-runnable (corridor-proven) |
| W4.33b-update-under-it-resume | US-009 + US-010 (S44a/S44b) | re-runnable (corridor-proven) |
| W4.33d-reroute-exhaustion-resume | US-006 + US-007 (S36, S32-37 batch) | needs real-campaign rerun |
| W4.37-keyline-spoof-repo-content | US-006 (S43a) | re-runnable (scripted red/green) |
| W4.47-auth-expiry-copy | US-006 + US-009 + US-010 (S43a/S44a/S44b) | re-runnable (corridor-proven) |
| W4.48a-daemon-kill-mid-park | US-009 + US-010 (S44a/S44b) | re-runnable (corridor-proven) |
| W4.48b-pause-rugpull-window | US-008 (S37, S32-37 batch) | needs real-campaign rerun |

### Fixing-story map (what landed, US-001..US-010)

- **US-001 (S40 per-case boundary_files):** all 70 tier2 rows now declare a
  TIGHT per-case boundary matching the task surface (W4.29 widened to
  `fixtures-src/tt-ts/public` + `src` — the security-audit fix spans
  VULN-T1 in public/app.js and VULN-T2 in src/server.ts; W4.17-a/b widened
  to `src` + `conftest.py` + `tests` — the tt-python pytest surface; the
  red-herring rows W4.03/W4.33a keep `src` ONLY so O8 catches an agent that
  chases the public/app.js bait; W4.05/W4.39-b tightened to `tt-poly/ts`
  — W4.39-a-union-honest (the SCRIPTED arm) keeps the whole
  `fixtures-src/tt-poly` fixture, because its corridor's honest change
  surface is the scratch-fixture ROOT (the canned fixer lands a root-level
  `value.txt`); the US-011 bare `--tier2` gate caught the initial
  over-tightening and it was reverted, see the S40 traceability section).
  O8 semantics unchanged.
- **US-002 (S38 snapshot target-ref pinning):** the oracle evidence snapshot
  resolves the fixture's target identity ONCE at before-capture
  (`pinned_target_ref`) and threads it through refs_after + target_reflog —
  W4.29's O2/O10 ORACLE_RUNTIME_ERRORs (`refs_before.target_ref =
  refs/heads/main` vs `refs_after.target_ref = refs/heads/security-audit-
  2026-08-27`) are gone. Detached-HEAD fixtures (W4.30) keep their S31
  contract (no regression — green-arm).
- **US-003 (S39 fail-closed chaos arming):** W4.29's delete-tstx-row corridor
  is now DECLARED (chaos block + pause_drain/resume probe_sequence mirroring
  W4.01/W4.02 — the campaign's chaos.log shows firings only for the
  W4.01/W4.02 trees at 23:02/23:19, never for W4.29's run-9b0bff8a), and the
  controller fails closed as TEST_INFRA_FAIL `chaos-not-fired` when a
  mandatory typed-chaos case reaches terminal without fired evidence — the
  W4.29 vacuous PRODUCT_FAIL (chaos_evidence null) can never silently recur.
- **US-004 (S41 probe-sequence evidence graph):** the W4.10-restart-recovery
  probe's second run (run-2621299f) is now registered in the root/discovered
  workflow-status graph with per-run terminal snapshots (the campaign graph
  carried `steps_snapshot null, tokens_observed 0, discovered_runs []`),
  and O2 accepts the two-landing shape when both landings are attributed
  runs — O1/O2/O11 no longer void with mechanical artifacts.
- **US-005 (S42 W4.17 arming hook):** the promised red-baseline reset hook
  (`cases/hooks/reset-w4.17-red-baseline.sh`) now exists — it plants exactly
  2 documented pre-existing red tests into the tt-python work clones,
  PROVES them red (pytest `2 failed`), and records the arming manifest;
  both W4.17 rows declare `reset` + `arming: {mandatory: true, type:
  red-baseline, count: 2}`; the controller fails closed as TEST_INFRA_FAIL
  `arm-absent` when a mandated arming is missing — the pre-fix vacuity (no
  hook in cases/hooks/, only W4.26/28/30/31) cannot recur.
- **US-006 (S43a O1 floor calibration):** the fast-honest cells (W4.37,
  W4.38-hostile-task-real, W4.47, W4.dsh-do-now) declare
  `expected_fast_failure: true`; W4.08-control (the honest full-run control)
  declares the per-cell `production_duration_floor_ms: 480000` — O1 no
  longer statistically flags honest early-termination runs (the campaign's
  W4.08-control 13%-under / 522s-vs-600000ms flag) while un-flagged
  too-fast runs still FAIL.
- **US-007 (S43b wave reporter dedupe):** the O1 wave-family reporter is
  resolved from the campaign-wide `o1_wave.wave_cases` (true final wave case
  in manifest order) — the do-now family finding (run_count 4, fast_run_count
  2, fast_rate 0.5) is stamped exactly once instead of on BOTH W4.dsh-do-now
  and W4.dsh-fdmw (the latter not even do-now).
- **US-008 (S43c bfmw classification precedence):** TEST_INFRA_FAIL infra
  classifications take precedence over RUNAWAY cap findings on the same
  case, enforced in BOTH surfaces via `bin/tt-subsumption.mjs` — the
  campaign disagreement (state.json `TEST_INFRA_FAIL chaos-invocation-
  failed` vs report.txt `W4.dsh-bfmw: RUNAWAY - RUNAWAY` for run-c8f9df30)
  is gone: the RUNAWAY renders in SUBSUMED FINDINGS, never FINDINGS.
- **US-009 (S44a operator-seam controller actions):** the four mid-run
  operator actions the W4.10-kill/W4.48a/W4.33a/W4.33b/W4.47 premises depend
  on are first-class probe ops with per-action evidence records and
  fail-closed categories: `restart_contained_daemon` (daemon-control
  provenance-gated restart), `update_contained_install` (contained
  `tamandua update --force`, escape-refused for an uncontained binary),
  `invalidate_credentials`/`restore_credentials` (contained `.pi` auth.json
  replace/byte-identical-restore, symlink/escape refused). Containment
  absolutes enforced before any spawn.
- **US-010 (S44b operator-seam cell wiring + scripted corridors):** the five
  cells' manifests/task texts wired to the actions (W4.10/W4.48a:
  kill-daemon chaos + `restart_contained_daemon` on the same trigger;
  W4.33a: restart during the pause hold; W4.33b: update during the hold;
  W4.47: invalidate at launch + restore at the relaunch's `event:step.running`)
  with a corridor-found machinery fix (async daemon-restart — the blocking
  spawnSync froze the event loop, starved the chaos poll, and the late
  SIGKILL killed the freshly-restarted daemon, re-stalling the run). The
  HEAVY scripted corridor (`self-tests/tier2-s44-operator-seam-corridors
  .test.ts`) proves each action provably fires at its declared trigger with
  evidence and the contained run recovers.

### Campaign evidence cited (campaign-20260826T225744158Z, run-b3895a6b)

The red-arms pin these lines verbatim (each reproduced history-independently
in its story's self-test):

- `refs_before.target_ref = refs/heads/main` vs `refs_after.target_ref =
  refs/heads/security-audit-2026-08-27 — target-ref identity CHANGED between
  snapshots` (S38, W4.29 O2/O10 ORACLE_RUNTIME_ERROR).
- chaos.log: delete-tstx-row `outcome: fired` entries ONLY for the
  W4.01/W4.02 run ids (23:02:39 / 23:19:32), none for W4.29's run-9b0bff8a;
  state.json W4.29 `chaos_evidence: null` with `outcome: PRODUCT_FAIL`
  (oracle-failed O8/O2) — the vacuous verdict (S39).
- W4.10-restart-recovery workflow-status.json: `steps_snapshot null,
  tokens_observed 0, discovered_runs []` — the probe's second run
  run-2621299f absent from the graph, voiding O1/O2/O11 (S41).
- cases/hooks/ pre-S42 contents: only reset-w4.26 / reset-w4.28 /
  reset-w4.30 / reset-w4.31 — no W4.17 arming hook; both W4.17 arms vacuous
  (S42).
- W4.08-control: 522s honest run, 13% under the 600000ms production floor,
  green content oracles — the O1 duration-floor statistical flag (S43a).
- `W4.dsh-do-now: O1 - more than 20% ...` and `W4.dsh-fdmw: O1 - more than
  20% ...` — the SAME do-now family finding (run_count 4, fast_run_count 2,
  fast_rate 0.5) stamped on a non-do-now cell (S43b).
- state.json `TEST_INFRA_FAIL chaos-invocation-failed` vs report.txt
  `- W4.dsh-bfmw: RUNAWAY - RUNAWAY` for the same run run-c8f9df30 —
  two-surface disagreement (S43c).
- The S44 machinery-delta vacuity: W4.10-kill/W4.48a/W4.33a/W4.33b/W4.47
  premises named mid-run operator actions no machinery performed (the
  S32-37 US-003 stall diagnosis — lifecycle-log proof of no daemon.start
  until sweep teardown).

### Verification gates (zero tokens, from repo root)

- `bash torture-test/self-tests/run.sh` — full self-test battery GREEN
  **twice consecutively** with a pre-existing dirty `var/home/.tamandua` DB
  present (the US-001 hermeticity gate), clean git tree each run.
- `bash torture-test/bin/verify-heavy-campaign-tests.test.sh` — the isolated
  heavy corridor tests GREEN, incl. the S44b operator-seam corridors
  (`tier2-s44-operator-seam-corridors.test.ts`: all five cells' actions
  provably fire at their declared triggers + the contained runs recover) and
  the S29 premise corridors (W4.33d reroute-exhaustion, W4.48b rugpull
  window).
- bare `./run-torture-test --tier2` — GREEN exit 0 **x2** (repeatability
  contract), zero tokens (scripted-only; real cases report pending-real).
- bare `./run-torture-test --tier1` — GREEN exit 0 (no-regression), zero
  tokens.
- `bash torture-test/oracles/self-test/run.sh` — oracle self-test battery
  GREEN (repeatability x2).
- The tamandua suite (`npm test` via the tamandua-test shim) — both lanes
  green, proving no repo-level regression from the torture-test changes.

### Salvage note (S38-44.1, run-9e4cb14c)

Landing-salvage for the completed S38-44 batch. Run run-b3895a6b completed
all substantive work — US-001..US-011 implemented and verifier-accepted,
landing report committed on `feature/s38-44-torture-suite-batch` — but was
cancelled by the operator after two 6-hour round ceilings spent re-running
the full verification gate set from scratch each round (an unfinishable
loop, not a defect in the work). This run (run-9e4cb14c) ADOPTED the
completed batch (US-001..US-011 from run-b3895a6b, commits
02d18535..8e8f8d7e) with NO re-implementation — no story was re-done, no
upstream file was rewritten. The bounded gate set was then re-verified
EXACTLY ONCE (zero tokens):

- Full self-test battery green once from the repo root with a pre-existing
  dirty `var/home/.tamandua` DB present (the S32 hermeticity tolerance):
  `bash torture-test/self-tests/run.sh` → 147 passed, 0 failed, clean git
  tree (US-002).
- Bare `./run-torture-test --tier2` GREEN x2 (repeatability contract), zero
  tokens: campaign-20260901T065921032Z-fba3100d-20da-4aec-bcfa-dabb809ccdfd
  and campaign-20260901T075434360Z-7cbb117f-e842-4018-8c36-337c6ff32964 —
  both VERDICT GREEN (exit 0), 24 scripted PASS, all failure classes 0, real
  cells pending-real NOT_RUN (US-003).
- Bare `./run-torture-test --tier1` GREEN x1 (no-regression), zero tokens:
  campaign-20260901T085426885Z-6689fed3-2ed2-405f-bfcb-104648596878 —
  VERDICT GREEN (exit 0), 4 scripted PASS, all failure classes 0, real cells
  pending-real NOT_RUN (US-004).

Gates NOT re-run here — the heavy corridor tests
(`bash torture-test/bin/verify-heavy-campaign-tests.test.sh`) and the oracle
self-test battery (`bash torture-test/oracles/self-test/run.sh`) — are cited
from run-b3895a6b's recorded artifacts: campaign-20260831T232424488Z (bare
tier2 GREEN 24/24), campaign-20260901T001925277Z (bare tier2 GREEN 24/24)
and campaign-20260901T011719592Z (33-PASS ladder).
