# S32-S37: re-run residue — six narrow suite-infra classes from the 13-cell tier-2 re-run

The 2026-08-30 targeted re-run (campaign-20260830T* single-case campaigns,
one per cell, scratchpad rerun13 logs mirror report.txt) recovered 6 of 13
cells (3 PASS, 3 PRODUCT_FAIL now judged by oracles). The remaining 7 are
TEST_INFRA_FAIL in five narrow classes, plus one battery-hermeticity item:

1. **S34 deadline-sweep race (3 cells: W4.10-kill-daemon, W4.37-keyline-
   spoof-repo-content, W4.48a-daemon-kill-mid-park).** `deadline-expired
   (attempt deadline ... expired 0-4s before the independent deadline sweep
   observed it)`. The attempt deadline and the CDSK independent sweep race
   within seconds; a case that was actually progressing gets classified
   TEST_INFRA_FAIL on a sub-5s margin. Fix the ordering/grace contract
   (e.g. the sweep must not void an attempt that reached terminal within a
   documented grace window, or deadlines get a sweep-aware margin); keep
   fail-closed for genuinely hung attempts. Also determine WHY these three
   cells approached their deadlines at all (caps vs honest durations for
   kill/park scenarios — recalibrate the manifests if the cap is simply too
   tight for the post-fix honest path, reasoning documented inline).
   - **US-002 (landed): the grace contract.** `sweepDeadlineExpiredAttempts`
     now defers voiding an expired attempt that reached TERMINAL within the
     documented grace window after its `deadline_at` — new option
     `deadline_grace_ms` (env `TT_CONTROLLER_DEADLINE_GRACE_MS`, default
     `30000`, `0` disables; persisted on the state at campaign creation as
     `options.deadline_grace_ms` and validated on load, exactly like
     `deadline_sweep_interval_ms`). Terminal evidence is (a) an attempt
     already carrying terminal evidence (`terminal_status`/`terminal_at`/
     `terminal_evidence`), or (b) a run whose status is terminal via the
     existing terminal-evidence status leg (`workflow status --json`) while
     still inside the window. Terminal-within-grace attempts are NOT swept —
     the in-flight monitor settles the honest PASS/PRODUCT_FAIL outcome (or
     the resume recovery reattaches and classifies it); a genuinely-hung
     attempt (no terminal evidence within grace) is still swept fail-closed
     with the full `deadline-expired` evidence fields (`deadline_at`,
     `expired_for_seconds`, `run_id`, `observed_at`) and the best-effort
     `workflow stop`. Unprovable evidence (no run id / spawn-env failure /
     status-query failure) is NOT a deferral — the grace skip is a positive
     proof of terminal-within-grace, never a weakening of the sweep. Proof:
     `tier2-s34-deadline-sweep-grace.test.ts` (7 arms: red-arm pins the
     campaign lines + the pre-fix criterion inline and shows it voids the
     terminal-reached shape; green-arm proves the fixed controller does NOT
     void it (PASS, recovery reconciled, no stop); grace-disabled (0) arm
     reproduces the live pre-fix race; hung arm still swept with full
     evidence; outside-grace arm still fail-closed with status provably never
     queried; invalid persisted grace rejects the resume; env wiring persists
     into `state.options`). `tt-controller-deadline-sweep.test.sh`
     AC1-AC5 stay green unchanged.
   - **US-003 (landed): the caps-vs-honest-duration analysis.** Why the three
     cells approached their deadlines, per the rerun evidence (read-only):
     - **W4.37-keyline-spoof-repo-content — RECALIBRATED (wall_min 5 → 10).**
       The do-now unit's honest duration is **> 5m18s** — both samples are
       cap-truncated (campaign-20260830T111549750Z voided 0s after the
       deadline with the `execute` round still running; campaign-
       20260826T225744158Z `runaway-cap-enforced` at 5m17.7s) and the family
       datapoint W4.dsh-do-now completed honestly at 5m21.4s. The 5-min cap
       sat below the honest path (a runaway tripwire firing on honest work —
       the family-p95-not-below-p50 rule's exact failure mode); the 30s grace
       window alone would NOT have sufficed (honest > 5m30s). Recalibrated in
       `cases/tier2.jsonl`; W4.dsh-do-now follows for family consistency
       (dsh rows inherit their pi base's caps).
     - **W4.10-kill-daemon & W4.48a-daemon-kill-mid-park — NO
       RECALIBRATION.** Both expiries were **genuine stalls, not cap
       breaches**: the SIGKILLed contained daemon was never restarted during
       the run (lifecycle-log proof — `daemon.uncleanExit` last heartbeat at
       kill time, no `daemon.start` until the sweep teardown 55 min later),
       so the run could not progress and consumed the 55-m cap as an
       un-recovered hang (W4.10: 3/6 done, 0 active; W4.48a: `finalize_merge`
       claimed at kill, never completed). Honest corridor (pre-kill pipeline
       2m48s / 4m18s + restart + ~2 dispatch-interval recovery) is an order
       of magnitude under the cap; tokens 7.5–11.8% of the 1M cap. The grace
       contract is orthogonal and correctly leaves genuinely hung attempts
       fail-closed; the remediation is the single-run kill-daemon
       operator-restart seam FIRING during the run (scenario/harness side —
       recorded for the landing report), not a caps-table change.
     - Caps-table rows updated in `cases/tier2-traceability.md` (Token Budget
       Notes + the "S34 caps-vs-honest-duration disposition" section) and
       `cases/caps-calibration.md` (tier-2 section); pinned by
       `self-tests/tier2-s34-caps-recalibration.test.ts`.
2. **S33 chaos guard rejects the pi worker (W4.09-pi-kill-harness).**
   `GUARD_MISS: Process <pid> cwd/cmdline does not contain <repo>` — the
   US-006 identity guard verifies target provenance by cwd/cmdline
   substring, but the real pi worker process shape doesn't carry the repo
   path there (kernel-hidden env / wrapper shapes — see the macOS
   portability memory traps). Extend identity verification with an
   evidence chain that works for pi workers (pidfile-provenance / parent
   chain / open-fd evidence) WITHOUT weakening the guard (never kill a
   process that cannot be positively identified as tt-owned).
   - **US-004 (landed): the harness identity evidence chain.** The real pi
     worker's argv is scrubbed to the binary name (`Cmdline: pi` — campaign
     evidence `campaign-20260830T063409637Z-2d03967a-2441-4abf-92a7-
     e852f934580a` process_tree.txt, `pi launched {"pid":2074648,
     "pgid":2074648}` in the daemon log), so the strict belt-and-suspenders
     cwd/cmdline check can never pass for a legitimate kill. `tt-chaos`
     `verifyKillTarget` (harness kind) now falls back — when the strict
     check fails — to a POSITIVE tt-ownership evidence chain built on
     EXPLICIT RECORDED identity only (never a /proc cwd/cmdline sweep):
     (1) `verifyRecordedTarget` MUST pass (alive + recorded
     `--target-start-time` ABA match + ancestry/group disjointness); (2)
     plus at least ONE positive tt-ownership proof: (a) pid equals the
     steps-table `claim_pgid` harness group for the run
     (`resolveFromStepsTable` — the product's own claim record), (b) the
     parent-chain walk (`getProcessParent` ppid walk) reaches an ancestor
     whose cwd/cmdline IS under TT_ROOT (the contained daemon/harness), or
     (c) open-fd evidence: `/proc/<pid>/fd` resolves a descriptor into
     TT_ROOT (linux-only — unreadable degrades to unproven, never to
     proven). A record with NO positive proof still GUARD_MISSes (exit 3)
     with the precise provenance reason annotated with the chain miss;
     kill-daemon daemon-kind (S28 US-006) is unchanged. The fired chaos
     entry now records `verificationDetail` (which leg accepted the
     target). Proof: `tier2-s33-pi-worker-identity.test.ts` (6 arms —
     RED-ARM pins the campaign report + process_tree evidence verbatim and
     reproduces the pre-fix criterion inline; GREEN-ARMS prove each of the
     three chain proofs accepts a pi-shaped process (exit 0, signalled,
     dead); FAIL-CLOSED arm proves a pi-shaped FOREIGN process with no
     chain proof refuses exit 3 with the one-line reason and survives).
     `tt-chaos.test.sh` 298 PASS unchanged (incl. the S28 strict-provenance
     retained test — an outside-cwd process with no chain proof still
     GUARD_MISSes).
3. **S35 O9 oracle infra on detached-HEAD (W4.30-detached-head-origin).**
   The S31 fix lets the case launch and run; O9 now dies ORACLE_TEST_INFRA
   on the detached-HEAD evidence shape. Make O9's row/tree resolution
   consume the detached-HEAD snapshot contract US-009 defined (target_ref
   = commit OID, detached_head: true) end-to-end.
   - **US-005 (landed): O9 consumes the detached-HEAD contract end-to-end.**
     The rerun evidence (campaign-20260830T075716699Z-112d79ce-4460-4168-
     a58c-cdf9ed4f58ef) pins the exact shape: `W4.30-detached-head-origin:
     O9 - ORACLE_TEST_INFRA` / `oracle-infrastructure`, the stored O9
     stdout `{"result":"NOT_EVALUABLE",...}`, and the campaign rejection
     `result must be PASS, FAIL, or ERROR`. Root cause: W4.30's premise is
     a detached-HEAD origin the product REFUSES at launch (the case pins
     the refusal corridor), so the run fails at launch and `suite_
     observations.rows` is EMPTY — pre-fix O9 answered NOT_EVALUABLE on
     any empty-observation shape, which the campaign harness cannot
     classify. Fix in `oracles/lib/o9.mjs`:
     - O9 reads the OPTIONAL refs evidence and consumes the US-009
       detached-HEAD contract (target_ref = commit OID, detached_head:
       true). Row/tree resolution walks the detached HEAD commit's
       reachable trees explicitly (never requires a symbolic target ref)
       and the audit evidence records the contract fields
       (`detached_head`, `target_ref`, `symbolic_target_ref`). The oracle
       only runs read-only git plumbing on an isolated extraction — refs
       are never written or altered.
     - The detached-HEAD launch-refused corridor (empty suite observations
       + detached-head contract + terminal-FAILED attempt + run.failed
       with no suite.* activity) now renders the REAL judgment PASS with
       the corridor + contract fields recorded — the verdict the campaign
       can classify. Every other empty-observation shape keeps the pinned
       NOT_EVALUABLE (o9-empty-observations fixture unchanged).
     Proof: `tier2-s35-o9-detached-head.test.ts` (4 arms — RED-ARM pins
     the campaign report/O9 stdout/evidence + the pre-fix criterion
     inline; GREEN-ARM proves the detached-HEAD green fixture PASSes
     through the real O9 with the contract fields + detached tree
     resolved; FAIL-CLOSED proves the detached-HEAD wrong-tree mutation
     still FAILs O9_LEDGER_TREE_UNRESOLVED; GREEN-ARM proves the
     launch-refused corridor renders PASS never NOT_EVALUABLE; every arm
     proves the fixture's snapshot files byte-identical before/after the
     oracle — symbolic refs unchanged). The oracle self-test battery gains
     3 detached-HEAD fixtures (o9-detached-green PASS /
     o9-detached-wrong-tree FAIL / o9-detached-launch-refused PASS) in
     generate-o9-fixtures.mjs; `bash torture-test/oracles/self-test/run.sh`
     passes. Verified post-fix against the REAL W4.30 campaign evidence
     (copied read-only, never modified): O9 now renders PASS with the
     corridor + contract fields (pre-fix NOT_EVALUABLE).
4. **S36 W4.33d premise still unfired in real runs.** The US-004 typed
   `move-branch` premise fires `event:run.failed` in the scripted corridor
   but the REAL run completed cleanly again (probe `resume` armed on
   `event:run.failed`, never fired). Diagnose from the real campaign
   evidence why the injected failure did not fail the real run (worker
   tolerance? reroute absorbed it?) and redesign the premise so a real
   run genuinely fails then resumes — this cell exists to prove
   resume-after-failure. Do not fake it: if the product genuinely cannot
   be made to fail this way, that is a FINDING for the landing report,
   and the scenario needs a different failure vector.
   - **US-006 (landed): real-run diagnosis — why `event:run.failed` never
     fired.** Evidence (read-only; NEVER modified): the rerun campaign
     `campaign-20260830T085340743Z-cc2c9a15-caea-4803-8d24-62e10e2164a3`
     (report.txt / report.json / state.json, attempt-1 `probe-evidence.json`,
     `chaos_evidence` in state.json, `var/chaos/chaos.log`, and the run's
     OWN event stream
     `var/home/.tamandua/events/578cf681-e4d1-4ea6-8962-fd757c63f9d6.jsonl`):
     - **Probe:** `probe-evidence.json` — action `resume` armed on
       `event:run.failed` for run `run-578cf681-e4d1-4ea6-8962-fd757c63f9d6`,
       `armed_at 2026-08-30T09:02:50.396Z`, never fired,
       `run_terminal_status "completed"`, `waited_ms 543720` → report.txt
       INFRA FAILURES `W4.33d-reroute-exhaustion-resume:
       probe-trigger-unreached (probe action 'resume' armed on
       'event:run.failed' never fired before the run reached
       terminal/deadline (waited 543720ms))` → TEST_INFRA_FAIL.
     - **Chaos (executed, but only 3 moves):** `chaos_evidence` —
       `move-branch`, `ref refs/heads/seed/BUG-T4`, `repeat 60`,
       `interval_s 60`, `wait_timeout_s 4200`, status `completed`, exit 0,
       ran 08:53:46.774 → 09:02:49.760Z. `var/chaos/chaos.log` shows the
       ACTUAL loop: the `step:finalize_merge:running` marker satisfied
       08:59:49, `budget_armed` (60 empty-diff "colleague" commits on the
       target — the TREE never changes), then THREE moves on a fixed 60s
       clock — 08:59:49 `a9419b6a→44284996`, 09:00:49 `44284996→9fe82aff`,
       09:01:49 `9fe82aff→0ad7f97a` — then `stand_down` at 09:02:49 (run
       terminal). The loop's cadence is a FREE-RUNNING clock that starts at
       the FIRST marker; it never re-arms per finalize attempt.
     - **Run's own event stream (64 events):** `step.rerouted ×1`,
       `merge.landed ×1`, `run.completed ×1`; **`run.failed ×0`,
       `merge.target_moved ×0`, `step.reroute_budget_exhausted ×0`**.
       finalize_merge expected-tip corridor:
       * attempt 1 (running 08:59:49.092 → rerouted 09:00:18.646): the
         merger observed the POST-MOVE-1 tip — reroute detail `Rerouted to
         verify (1/8). Consumer failure: STATUS: retry / REBASED: true /
         CONFLICT_NOTES: The merge was not fast-forward-safe: origin target
         refs/heads/seed/BUG-T4 had moved to EXPECT_TIP=44284996243ca65652b71a925a30b3d3625e8ffc
         (chaos: collea…` — 44284996 IS move 1's target → verdict `retry` →
         reroute to verify (1/8);
       * verify re-run (09:00:34 → 09:02:10; `suite.cache_hit` 09:01:08 on
         the unchanged tree) — moves 2 and 3 (09:00:49, 09:01:49) landed
         DURING this gap, where the empty-diff budget makes them inert
         (tree unchanged → cache-hit verify → next finalize merges cleanly
         onto the moved tip);
       * attempt 2 (running 09:02:19.403 → `merge.landed` 09:02:35.748,
         expectedTip=0ad7f97a0eafd782cff6cc1a9e5ea80284ffd233 — move 3's
         target) — landed BEFORE move 4 (due ~09:02:49) → step.done +
         `run.completed` 09:02:40.969Z (`workerLostCount 0`,
         `ceilingExpiryCount 0`); steps_snapshot: all 6 steps done,
         finalize_merge `rerouteCount: 1`.
     - **ROOT CAUSE (injection cadence race — NOT the reroute machinery):**
       the typed move-branch premise never produced persistent mid-window
       target moves. Real timings (finalize window ~16–29s; reroute→verify
       re-run ~96s) vs a 60s free-running cadence mean a move lands inside a
       finalize window only when the window straddles the next tick: exactly
       ONE move (move 1) did (attempt 1 → 1/8 reroute); moves 2–3 fell in
       the verify gap; attempt 2 landed between move 3 and move 4 →
       `run.completed`. The product machinery is NOT the defect — the single
       observed move was correctly absorbed by the designed reroute
       (`retry_on: [target_moved, conflicts]` → verify → retry finalize),
       and the `max_reroutes: 8` budget was never approached
       (`step.reroute_budget_exhausted ×0`; `rerouteCount 1`). No worker
       tolerance consumed anything (`workerLostCount 0`). The premise's
       design assumption — "each move lands in the finalize attempt's
       expected-tip window" — fails at `interval_s 60` against real
       attempt/verify timings; the scripted corridor only passes because its
       transform uses `interval_s 3` with instant scripted verify.
     - **DECISION: REDESIGN (US-007) — per-attempt deterministic moves.
       NOT a FINDING.** The product CAN genuinely fail + resume via this
       vector: the zero-token scripted corridor
       `self-tests/tier2-s29-premise-redesign-corridor.test.ts` proves
       `step.rerouted ×8 → run.failed fires → resume re-activates the same
       run → run.completed` (O16 `run_completes`). The real campaign failed
       only because the injection cadence was mis-tuned for real timings.
       US-007 redesign spec: `tt-chaos move-branch` gains a RE-ARM mode —
       after the initial marker wait, each subsequent
       `step:finalize_merge:running` occurrence (the step transitions
       waiting→pending→running on every reroute cycle —
       `rerouteWithPolicy` resets the consumer to waiting, the pipeline
       re-pends it) triggers the NEXT move, with a short post-marker hold
       (2–5s) so the merger's tip capture precedes the move; `interval_s`
       becomes a minimum-spacing floor, never a free-running cadence. This
       guarantees EVERY finalize attempt observes a moved tip → every
       attempt reroutes → attempt 9 exhausts `max_reroutes: 8` →
       `step.reroute_budget_exhausted` → `run.failed` fires → the resume
       probe fires → the loop's run-terminal stand-down (already mechanized)
       stops the moves → the resumed finalize lands on a stable target →
       the SAME run id completes → O16 `run_completes` PASS. Manifest: the
       W4.33d chaos block adopts the re-arm mode (trigger
       `step:finalize_merge:running`, ref `refs/heads/seed/BUG-T4`,
       `repeat 60` ceiling, `wait_timeout_s 4200`). Documented fallback (NOT
       preferred): `interval_s ≤ 10` with `repeat ≥ 12` — probabilistic but
       P(move-in-window) ≈ 1 per attempt; retains a small phase-race
       residual. The 75-min wall cap is NOT a constraint: the honest
       corridor (base ~9 min + 8 reroute cycles ≈ 1.5–2 min each + resume
       ~2 min) fits comfortably (the rerun wall was 9m10.445s).
     - Pin: `self-tests/tier2-s36-diagnosis.test.ts` (read-only, zero
       tokens) asserts this section exists and cites the campaign id + run
       id + root cause + decision.
   - **US-007 (landed): the re-arm premise redesign — real-run failure
     genuinely reachable (scripted corridor).** The S36 decision implemented:
     - **`bin/tt-chaos` move-branch gains a per-attempt RE-ARM mode
       (`--rearm`, US-007).** With `--rearm` the move loop is NOT a
       free-running clock: the initial marker arms move 1, then each FRESH
       `step:<role>:running` occurrence in the run's OWN append-only event
       stream (one `step.running` event per attempt — `rerouteWithPolicy`
       resets the consumer to waiting and the pipeline re-pends it, so the
       step transitions waiting→pending→running on every reroute cycle)
       triggers the NEXT move after the `--rearm-hold-s` post-marker hold
       (2-5s; the merger's tip capture precedes the move). `interval_s`
       becomes a MINIMUM-SPACING FLOOR (moves never closer together than the
       declared interval), never a cadence. The run-terminal stand-down is
       unchanged; a re-arm wait that times out without the run going terminal
       fails closed (exit 1 `rearm_timeout` — never a silent wait). Re-arm
       validation fails closed BEFORE phaseWait (a non-`step:` marker,
       `repeat <= 1`, or a missing/non-positive `--rearm-hold-s` is an
       immediate error; `--rearm-hold-s` without `--rearm` likewise).
     - **Manifest (`cases/tier2.jsonl` W4.33d):** the chaos block adopts the
       re-arm mode — `trigger: step:finalize_merge:running`, `ref:
       refs/heads/seed/BUG-T4`, `repeat: 60` (ceiling), `wait_timeout_s:
       4200`, **`rearm: true, rearm_hold_s: 3`** (`interval_s: 60` is now the
       minimum-spacing floor). `case.schema.json` chaosBlock gains
       `rearm`/`rearm_hold_s`; `tt-controller` validates them fail-closed
       (move-branch only; `rearm: true` requires `repeat > 1`, a `step:`
       trigger, and a positive `rearm_hold_s`; `rearm_hold_s` without `rearm`
       is a scenario error), passes `--rearm/--rearm-hold-s` to tt-chaos, and
       records `rearm`/`rearm_hold_s` in `chaos_evidence`. W4.48b keeps the
       free-running cadence (its premise is a single target move in the pause
       window). Task text `cases/tasks/tier2/W4.33d-reroute-exhaustion-resume.md`
       documents the re-arm premise.
     - **Corridor proof (zero tokens):** the W4.33d arm of
       `self-tests/tier2-s29-premise-redesign-corridor.test.ts` now runs the
       REDESIGNED premise (`rearm: true, rearm_hold_s: 2` — the scripted
       analogue of the real manifest) against the 53xx scripted daemon and
       proves: the run's OWN event stream shows genuine target-move reroutes
       (`merge.target_moved` + `step.rerouted` >= 8) → `run.failed` FIRES →
       the resume probe armed on `event:run.failed` EXECUTES (exit 0, run
       re-activated to 'running') → the SAME run id completes
       (`run.completed`, O16 `run_completes`), with `chaos_evidence`
       recording `rearm: true, rearm_hold_s: 2` and the invocation journal
       showing zero tokens. New `bin/tt-chaos.test.sh` re-arm unit arms prove
       the loop re-arms on each fresh `step.running` occurrence (move 2 fires
       only after the second occurrence — never on the clock) and the
       fail-closed validation arms (non-`step:` marker / missing hold /
       `repeat 1` / hold-without-rearm). Roster pin
       (`self-tests/tier2-roster-section-a.test.ts`) asserts W4.33d declares
       `rearm: true` + `rearm_hold_s` and W4.48b does not.
5. **S37 O8 checksum reconciliation (W4.48b-pause-rugpull-window).**
   `checksum_terminal bytes do not reconcile with git HEAD for
   src/server.ts` — the rugpull (target moved mid-run) leaves worktree
   bytes vs HEAD divergent at capture time. Determine whether the O8
   terminal-checksum contract must model the moved-target case (capture
   discipline) or whether the scenario's teardown must settle first;
   fail-closed either way.
   - **US-008 (landed): O8 models the moved-target case — authoritative-tree
     evaluation with a distinct category; fail-closed when unexplained.**
     The rerun evidence (campaign-20260830T095821392Z, W4.48b-pause-rugpull-
     window) shows the EXACT terminal shape: the run COMPLETED
     (`run.paused` on `event:merge.target_moved` 10:08:33 → `run.resumed`
     10:18:34 → `merge.landed` 10:20:52 → `run.completed` 10:20:57, O1 PASS),
     merge-branch PARKED the target (`refs/heads/seed/BUG-T2-tamandua-parked-
     20260830T102052Z-5f95859f`, matching the `generateBackupName` contract),
     the parked/landed HEAD tree carries the fix (`src/server.ts` +
     `src/store.ts` differ from baseline), and the captured worktree bytes
     are the STALE baseline (`checksum_terminal.changed_paths: []`) — the
     W4.48b moved-target divergence. DECISION: model it O8-side (option (a)
     in the story — capture discipline is already same-instant: `git_bundle`
     and `checksum_terminal` are captured within the same snapshot
     completion; the divergence is REAL and must be distinguished, never
     hidden by settling the worktree first). `oracles/lib/o8.mjs`:
     - direct reconciliation FIRST, unchanged — a worktree-vs-HEAD
       divergence with NO positive moved-target signature (no `*-tamandua-
       parked-*` ref, no local-vs-origin ref divergence — e.g. a dirty
       worktree) keeps the pre-fix opaque
       `checksum_terminal bytes do not reconcile with git HEAD for <file>`
       `ORACLE_RUNTIME_ERROR` (fail-closed, pinned by the
       `o8-dirty-unexplained-divergence` ERROR arm);
     - positive moved-target evidence is read-only refs INSIDE the isolated
       git snapshot (parked ref and/or local-head-vs-origin tip difference);
       on evidence, O8 rebuilds the terminal inventory from the AUTHORITATIVE
       git-HEAD tree (unchanged captured entries preserved verbatim, untracked
       forbidden baits kept) and re-runs every existing leg
       (boundary/forbidden/seeded-test/marker/transport) against that tree;
     - the distinct `O8_RUGPULL_TREE_DIVERGENCE` category records
       `diverged_paths` + signature + `reconcile_error`: informational
       (non-failing) on a COMPLETED run (PASS if the authoritative tree
       honors the rules — the honest W4.48b characterization), FAILING on an
       UNSETTLED run (`terminal_status !== 'completed'`) — never the opaque
       ERROR, never a silent pass; `o8-boundary-audit.json` records
       `git_tree_reconciled: false` + `tree_reconciliation:
       'moved-target-annotated'` + `rugpull_divergence`.
     - Red-arm/green-arms: `oracles/self-test/generate-o8-fixtures.mjs`
       fixtures `o8-moved-target-rugpull` (W4.48b shape: parked ref + moved
       ref + stale worktree + untracked `operator-notes.local`, completed →
       PASS + annotation), `o8-moved-target-failed-run` (same divergence,
       failed attempt → FAIL with the distinct category) and
       `o8-dirty-unexplained-divergence` (dirty worktree, no signature →
       pre-fix opaque ERROR verbatim); `o8.test.mjs` pins the PRE-FIX
       criterion inline (an embedded replica of the pre-fix reconcile
       produces the exact campaign message on the moved-target fixtures) and
       asserts the post-fix behavior. Contract recorded in
       `oracles/CONTRACT.md` (S37 section) and
       `cases/tier2-traceability.md` (US-008 delta row). Rerun status: needs
       real-campaign rerun.
6. **S32 battery hermeticity.** `tier2-chaos-block-extension.test.ts`
   seeds `var/home/.tamandua/tamandua.db` and fails on a pre-existing
   campaign-populated DB (`NOT NULL constraint failed:
   steps.input_template`). Make the test hermetic (own temp home/DB),
   never dependent on repo-root contained-home state.

## Prove
- S34: red-arm reproducing a sub-5s sweep race voiding a terminal-reached
  attempt -> green (not voided); genuinely-hung attempt still voided.
- S33: scripted red-arm with a pi-shaped process (no repo in cwd/cmdline)
  -> identity chain accepts tt-owned / refuses foreign.
- S35: detached-HEAD evidence fixture through O9 -> PASS shape; symbolic
  refs unchanged.
- S36: documented diagnosis + a scripted corridor where the redesigned
  premise makes the run genuinely fail and resume fires; or the FINDING
  documented with evidence if impossible.
- S37: documented contract decision + red-arm for the chosen design.
- S32: the test passes with a dirty repo-root contained-home DB present.
- Full battery green from repo root (with the S32 fix, on a dirty home);
  bare --tier2 GREEN x2; bare --tier1 GREEN.

## Hard constraints
- Files ONLY inside torture-test/. Zero real tokens (scripted proofs
  only; do NOT re-run the real cells — I re-run after landing). Live
  daemon (33xx) untouched. Do NOT modify campaign evidence/snapshots.
  Preserve fail-closed semantics; never weaken the kill-target identity
  guard or oracle seals.

## Landing report (US-009) — per-cell disposition for the 7 re-run residue cells

Per-cell disposition for the seven tier-2 re-run residue cells (2026-08-30
rerun, campaign-20260830T* single-case campaigns). Every cell was
TEST_INFRA_FAIL against the real campaign evidence; each defect class was
root-caused, scripted-reproduced, and fixed by the mapped story in this run
(US-001..US-008, all zero-token proofs). The user re-runs the real cells
after landing — **every cell's rerun status is `needs real-campaign rerun`**
(no real tokens were spent here).

| Cell | Fixing story | Rerun status |
| --- | --- | --- |
| W4.10-kill-daemon | US-002 + US-003 (S34) | needs real-campaign rerun |
| W4.37-keyline-spoof-repo-content | US-002 + US-003 (S34) | needs real-campaign rerun |
| W4.48a-daemon-kill-mid-park | US-002 + US-003 (S34) | needs real-campaign rerun |
| W4.09-pi-kill-harness | US-004 (S33) | needs real-campaign rerun |
| W4.30-detached-head-origin | US-005 (S35) | needs real-campaign rerun |
| W4.33d-reroute-exhaustion-resume | US-006 + US-007 (S36) | needs real-campaign rerun |
| W4.48b-pause-rugpull-window | US-008 (S37) | needs real-campaign rerun |

### Fixing-story map (what landed)

- **US-001 (S32 battery hermeticity — not a cell, a battery-level fix):**
  `tier2-chaos-block-extension.test.ts` seeds its marker corridor into a
  per-test temp contained home (`TT_CONTROLLER_SPAWN_HOME_OVERRIDE`) and never
  touches the shared `var/home/.tamandua` DB — the battery is hermetic against
  a pre-existing campaign-populated home (the `NOT NULL constraint failed:
  steps.input_template` defect). This makes the AC2 dirty-home gate possible.
- **US-002 (S34 deadline-sweep grace):** the independent deadline sweep never
  voids an attempt that reached TERMINAL within the documented grace window
  (`deadline_grace_ms`, default 30000) after its deadline; genuinely hung
  attempts still fail closed with the full `deadline-expired` evidence.
- **US-003 (S34 caps-vs-honest-duration):** W4.37 (and W4.dsh-do-now) caps
  recalibrated `wall_min 5 → 10` (honest do-now > 5m18s); W4.10/W4.48a are
  genuine stalls (killed daemon never restarted — lifecycle-log proof), no
  recalibration; the kill-daemon operator-restart seam is the recorded
  remediation.
- **US-004 (S33 harness identity chain):** `tt-chaos` kill-harness accepts the
  REAL pi worker (`Cmdline: pi`, no repo path in cwd/cmdline) via a positive
  tt-ownership evidence chain (recorded identity + steps-table claim / parent
  chain / open-fd); every unidentifiable process still GUARD_MISSes (exit 3).
- **US-005 (S35 O9 detached-HEAD):** O9 consumes the detached-HEAD snapshot
  contract (target_ref = commit OID, detached_head: true) end-to-end; the
  launch-refused corridor renders a classifiable PASS, never NOT_EVALUABLE.
- **US-006 + US-007 (S36 W4.33d premise):** the real-run diagnosis (free-running
  60s cadence never re-armed per finalize attempt — the product machinery was
  NOT the defect) plus the REDESIGN: `tt-chaos move-branch --rearm` fires a
  per-attempt move on every fresh `step:finalize_merge:running` occurrence, so
  reroute exhaustion → `run.failed` → resume genuinely happens (scripted
  corridor proof).
- **US-008 (S37 O8 moved-target):** O8 models the rugpull case O8-side — on
  positive moved-target refs evidence (parked ref / local-vs-origin tip
  difference) it rebuilds the terminal inventory from the authoritative git-HEAD
  tree and records the distinct `O8_RUGPULL_TREE_DIVERGENCE` category
  (informational on a COMPLETED run, failing on an UNSETTLED run); unexplained
  divergence keeps the pre-fix opaque ERROR (fail-closed).
- **US-009 (this report):** the landing report + read-only pin
  (`self-tests/tier2-s32-37-landing-report.test.ts`) + the full-battery
  verification below.

### Verification gates (zero tokens, from repo root)

- `bash torture-test/self-tests/run.sh` — full self-test battery GREEN
  **twice consecutively** with a pre-existing dirty `var/home/.tamandua` DB
  present (the US-001 hermeticity gate).
- `bash torture-test/bin/verify-heavy-campaign-tests.test.sh` — the isolated
  heavy corridor tests GREEN, incl. the S29/S36 premise corridor
  (`tier2-s29-premise-redesign-corridor.test.ts`: W4.33d re-arm reroute
  exhaustion → `run.failed` → resume → same run id completes; W4.48b
  free-running pause/rugpull window).
- bare `./run-torture-test --tier2` — GREEN exit 0 **x2** (repeatability
  contract), zero tokens (scripted-only; real cases report pending-real).
- bare `./run-torture-test --tier1` — GREEN exit 0 (no-regression), zero
  tokens.
- The tamandua suite (`npm test` via the tamandua-test shim) — both lanes
  green, proving no repo-level regression from the torture-test changes.
