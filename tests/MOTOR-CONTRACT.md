# The Motor Contract

**The "motor"** is the machinery that drives workflow progress: the agent
scheduler (`src/installer/agent-scheduler.ts`), harness invocation
(`runPi`/`runHermes`), and the step-ops pipeline advance (`step-ops.ts`).

The motor is **deterministic dispatch**: per-(runId, agentId) in-memory
jobs whose rounds (`executeDispatchRound`) decide "is there work?" with an
in-process `peekStep` SQL COUNT and spawn a `pi --print --mode json` (or
hermes) harness ONLY when a pending step exists. Checking for work never
invokes a model, so idle runs spend **zero** tokens. The 15-second tick
(`DISPATCH_INTERVAL_MS`) is a fallback sweep (it also drives stale-claim
recovery); step completions, retries, and run starts nudge the daemon
(`/control/nudge`) for immediate dispatch, so step-to-step latency is
near zero.

This replaced the model-driven polling motor (removed 2026-07-02), where
every poll tick spawned a full model invocation whose prompt told the model
to run `step peek` and reply `HEARTBEAT_OK` when idle — measured at ~30%
token overhead on real runs (see the historical baselines at the bottom).

## Contract invariants (any motor must satisfy these)

### Key-enforcement contract (single source of truth)

- **K1** The linter (`tests/workflow-contract-lint.test.ts`) and `MISS`
  (Missing Input Step Selector, in `src/installer/step-ops.ts`) share one
  contract module as the single source of truth for key enforcement rules:
  `src/installer/workflow-contract.ts`.  This module exports
  `AUTO_CONTEXT_KEYS` (runtime-provided keys), `HARNESS_SEEDED_CONTEXT_KEYS`
  (keys seeded at run creation), `CALLER_PROVIDED` (keys supplied by the
  caller at launch), `parseExpectedKeys` (keys mentioned in a step's
  `Reply with:` template), and `parseEnforcedKeys` (keys pinned in a
  step's `expects` string via `regex:^KEY:` patterns — the enforcement
  tier).  A key that is only *mentioned* (in Reply-with) without being
  *enforced* (in expects) is a lint failure; this single-tier enforcement
  model replaces a historical two-tier structure where the linter and MISS
  could disagree, causing the "verified" incident (two runs killed by
  producer-retry exhaustion on a key the linter said was covered).

### Lifecycle & pipeline

- **C1** Steps advance `waiting → pending → running → done|failed`; pipeline
  advancement marks the next reachable step(s) `pending` when a step
  completes.
- **C2** Steps execute in the order and dependency structure declared by the
  workflow spec; a run completes exactly when all steps are `done`.
- **C3** Agent output is classified by exact STATUS markers
  (`STATUS: done`, `STATUS: failed`/`error`). Output matching the step's
  `expects` completes it; anything else takes a failure/retry path.
- **C4** `KEY: value` lines in step output are captured into run context and
  resolve `{{placeholders}}` in later step inputs (e.g. `{{branch}}`,
  `{{original_branch}}` seeding for worktrees).
- **C21 (VBUD — story-scoped verify budget)** Each story in a `verify_each`
  loop receives a fresh verify-step retry budget: `handleVerifyEachCompletion`
  (`src/installer/step-ops.ts`) resets the shared verify step's `retry_count`
  to `0` on every completion — both the done and retry paths. This prevents
  infrastructure failures on one story (daemon restart, expects flap, verifier
  timeout) from burning verify retry quota that later stories never earned.
  Story-level `retry_count` continues to track per-story judgment budget
  independently — only the shared step's counter is scoped. Pinned by
  `tests/step-ops.test.ts` (VBUD tests).

### Dispatch

- **C0-binary** Work spawns resolve the harness binary PER INVOCATION:
  per-harness env override (`TAMANDUA_PI_BINARY` / `TAMANDUA_HERMES_BINARY`,
  the config/test seam) → `<harness>-token-saver` from PATH when the run
  is no-hurry (`--no-hurry-please-save-tokens-mode`) → plain harness binary
  from PATH. Installing the wrapper mid-run takes effect on the next round.
  Pinned by `tests/pi-token-saver.test.ts` and `tests/hermes-token-saver.test.ts`.
- **C5** Each pending step is executed exactly once at a time: concurrent
  dispatch attempts (timer tick + nudge, two claimants) must not double-run a
  step (in-flight guards, claim atomicity), and duplicate completions
  (at-least-once delivery) must be no-ops. Late completions after a
  stale-claim sweep ARE accepted — the work was done. Pinned by
  `tests/step-ops-dispatch-races.test.ts`.
- **C6** Idle agents (no pending step) cause no state changes.
- **C7** `nudge` (control plane) triggers immediate dispatch consideration
  for all scheduled agents of running runs. `completeStep`/`failStep`-retry
  and run start/resume fire best-effort nudges; the fallback tick covers a
  missed nudge.

### Deterministic-motor guarantees

- **N1** Idle dispatch invokes **no model**: an idle run accrues **zero**
  `system_tokens_spent`. The ledger (`tamandua_stats.system_tokens_spent`)
  is kept as a tripwire — nothing writes to it; a growing value means
  model-driven dispatch was reintroduced.
- **N2** Harness (model) invocations per run == executed work rounds — the
  scripted-agent invocation journal records zero heartbeat invocations.
- **N3** Work-token attribution (C14/C15) still holds — work still costs.

Pinned by `tests/deterministic-motor-acceptance.test.ts` (in-process
dispatch rounds with an instrumented fake pi) and by the scripted e2e
baseline assertions.

### Failure & recovery

- **C8** `step fail` → retry until `max_retries` → reroute per `on_fail.retry_step` or fail the run.
- **C9** Lost steps are recovered: an agent that claims a step and exits
  without reporting (no STATUS output, crash, non-zero exit, timeout kill)
  leaves a `running` step that must be requeued and retried — not stuck
  forever.
- **C10** **Expects-must-accept-all-reply-variants invariant:** every STATUS
  variant (`STATUS: done`, `STATUS: retry`, `STATUS: failed`) that a step's
  `Reply with:` section instructs an agent to emit MUST satisfy that step's
  `expects` field — no step may instruct an agent to produce a reply that
  `validateExpects` rejects.  This invariant is statically enforced by a
  linter rule in `tests/workflow-contract-lint.test.ts` ("US-005:
  expects-must-accept-all-reply-variants invariant"), which calls
  `parseStatusVariants()` and `checkExpectsAcceptsVariant()` from
  `src/installer/workflow-contract.ts` to extract every STATUS variant from
  every bundled workflow step's `Reply with:` block and verify acceptance
  against the step's `expects` via literal `STATUS:` substring match,
  `regex:^STATUS:` pattern, or `regex:STATUS:` pattern.

  **verify_each (honest retry path):** loop steps declaring
  `verify_each: true` use a regex expects (e.g.
  `regex:^STATUS:\s*(done|retry)\s*$`) that accepts both `STATUS: done` and
  `STATUS: retry`.  A verifier's honest `STATUS: retry` reply with `ISSUES:`
  feedback now passes `validateExpects`, flows through
  `completeStepInternal` into `handleVerifyEachCompletion`'s
  `status === "retry"` branch, resets the last done story to `pending` with
  `retry_count` incremented, sets `verify_feedback` in run context from the
  `ISSUES` block, and re-pends the loop step — the capitulation pressure
  that previously caused verifiers to emit false `STATUS: done` on
  incomplete work (to avoid the "Output missing expects string" coaching
  feedback) is eliminated.  Story-retry exhaustion (`max_retries` reached)
  still fails the run.  Pinned by `tests/step-ops.test.ts` (US-002 unit
  tests) and the graph simulation retry scenario (US-003).

  **Non-verify_each verdict steps:** expects accepts only the primary
  verdict (typically `STATUS: done`).  Legacy steps that once offered
  `STATUS: retry` or `STATUS: failed` in their instructions were cleaned up
  (US-004) so the invariant holds universally — those steps' `Reply with:`
  now only offer the single verdict their expects accepts.  An actual
  expects mismatch (malformed agent output) still triggers `on_fail` wiring
  (`retry_step`, `max_retries`, `on_exhausted`).
- **C22** **Retry-verdict routing invariant:** an expects-accepted
  `STATUS: retry` verdict must NEVER silently complete a step. Every step
  type (single, loop, verify_each) whose expects accepts `STATUS: retry`
  must route through retry/on_fail semantics: retry with `retry_feedback`
  until `max_retries`, then reroute per `on_fail.retry_step` or fail the
  run.  The `verify_each` path (`handleVerifyEachCompletion`) already
  handles this via story-level retry/reset.  For all other steps,
  `completeStepInternal` now has a guard after the `verify_each` branch
  that inspects the parsed `STATUS` key and applies retry/routing
  uniformly.

  **Rationale — CATP incident (run f7ed5ab7, 2026-07-06 ~02:54):** the
  merge-family workflow's `finalize_merge` step uses an expects regex that
  accepts both `STATUS: done` and `STATUS: retry`
  (`regex:^STATUS:\s*(done|retry)\s*$`).  The merger replied with honest
  `STATUS: retry / REBASED: true` to trigger rebase-loopback — but
  `completeStepInternal` only consulted the STATUS verdict for
  `verify_each` loop steps.  The output passed expects, the step was
  silently marked `done`, the run phantom-completed, and four verified
  story commits were stranded on the branch with zero merge.  **Fix:**
  `completeStepInternal` now checks `parsed["status"]?.toLowerCase() === "retry"`
  for non-verify_each steps before falling through to the mark-done path.
  Pinned by `tests/step-ops.test.ts` (RETRY VERDICT ROUTING suite).
- **C8-rugpull** Rugpull relaunch applies **only** to `finalize_merge` step
  failures in merge workflows (`*-merge`, `*-merge-worktree`) where the base
  branch tip moved since the run started. Mid-pipeline step retry exhaustion,
  expects validation exhaustion, and worker death permanently fail the run by
  design UNLESS the workflow declares `on_fail.retry_step` (see C19).
  Permanently failed runs are retryable via `tamandua workflow resume` with
  fix-then-restart semantics.

  **Merge-base diff neutralization (C8-rugpull gate integrity):** Verifier
  steps now diff against the merge-base via three-dot
  `git diff main...{{branch}}`, not main's current tip. This neutralizes
  pre-merge base movement: when a sibling run merges to main mid-flight, a
  two-dot `main..{{branch}}` diff would make every not-yet-merged branch
  appear to "remove" the sibling's changes, causing verifiers to reject
  honest work as unclaimed modifications and burn retry budgets
  deterministically (the branch didn't change, so re-verifying against an
  unchanged diff produces the same false positive). Three-dot semantics —
  "what did this branch change since it forked" — are immune to main
  moving, so sibling merges no longer cause ghost removals. The rugpull
  detector's narrow `finalize_merge`-only gate (C8-rugpull) therefore
  stays correct: verifier false positives from base skew are eliminated,
  and rugpull remains the sole owner of true merge-time conflicts (base
  branch tip moved during the run, detected at merge time). For worktree
  runs, this alignment is exact: worktrees are cut from main's tip at
  launch, so the merge-base equals the `base_branch_sha` recorded in run
  context. This idiom is enforced by a linter rule in
  `tests/workflow-contract-lint.test.ts` (via `hasTwoDotBaseComparison()`
  in `src/installer/workflow-contract.ts`) and documented in
  `docs/creating-workflows.md` ("Verifier Diff Idiom — Merge-Base
  Comparison"). Merger/pr steps intentionally use two-dot for actual
  rebase/merge preparation — the exemption is honored by the linter rule.

  **RETR-rugpull interaction (rebase-loopback):** When a `finalize_merge`
  step declares `on_fail.retry_step` (for rebase-loopback — the merger
  rebases, returns `STATUS: retry`, and hands off to a tester/verifier for
  post-rebase re-validation), the C22 retry-verdict guard catches the
  `STATUS: retry` reply first: the step's local `max_retries` budget is
  consumed on repeated `STATUS: retry` replies (each stores the full
  verdict + REBASED/CONFLICT_NOTES as `retry_feedback`).  Only after
  `max_retries` exhaustion does the guard fall through to C19 RETR routing:
  the `on_fail.retry_step` target is re-pended, consuming the per-step
  `max_reroutes` budget.  If the reroute budget also exhausts after
  repeated rebase→test→merge cycles fail to converge, the run falls
  through to normal merge-step failure.  At that point, `detectRugpull`
  (`src/installer/rugpull.ts`) still owns true merge-conflict recovery — it
  sees a failed `finalize_merge` with a moved base-branch tip and triggers
  relaunch.  The three mechanisms coexist without conflict: C22 retry
  verdict (local `max_retries`), C19 RETR `retry_step` (per-step
  `max_reroutes`), and C8-rugpull (last-resort, genuine merge conflicts).
  Rugpull is never bypassed — a merge failure that exhausts both budgets
  ends the same way any other merge failure does.
- **C19 (RETR — declarative cross-step retry routing)** When a step declares
  `on_fail.retry_step` and exhausts its local retries, the run does NOT
  immediately fail. Instead the run reroutes to the named upstream producer
  step (lower `step_index` in the same workflow) with a bounded reroute
  budget (`on_fail.max_reroutes`, default 2). The producer is re-pended
  (status `pending`, `retry_count` unchanged) with retry feedback in its
  output; the failing consumer is reset to `waiting` with `retry_count=0`
  and `reroute_count` incremented; intermediate `done` steps between
  producer and consumer are untouched — `advancePipeline` naturally
  re-pends the consumer after the producer completes. When the consumer's
  `reroute_count` reaches `max_reroutes`, the budget is exhausted and the
  run falls through to normal failure semantics (including rugpull detection
  on merge-step failures). The reroute budget is separate from `retry_count`:
  the producer's `retry_count` stays unchanged; the consumer's `retry_count`
  resets to 0 on each reroute; `reroute_count` is the dedicated boundedness
  counter. Each reroute emits a `step.rerouted` event; budget exhaustion
  emits `step.reroute_budget_exhausted`. RETR does NOT fire for loop-step
  story-level exhaustion (`verify_each` territory) or for expects-accepted
  `STATUS: retry` verdicts (C22 handles verdict retries first).  For `finalize_merge`,
  RETR fires when `on_fail.retry_step` is declared (rebase-loopback);
  rugpull takes over as the terminal fallback after reroute budget
  exhaustion (see C8-rugpull RETR-rugpull interaction note).

  **Loop-step story reset:** When the reroute target is a loop-over-stories
  step (`type='loop'`, `loop_config.over='stories'`), stories cited in the
  consumer's failure text are reset to `pending` so the developer actually
  redoes the rejected work. Story IDs are parsed from the failure text via
  the `/US-\d+/g` regex. Each matching `done` story is reset (`status =
  'pending'`, `retry_count` incremented, `updated_at` refreshed). If no
  story IDs are found, the fallback heuristic resets the most recently
  updated `done` story (mirroring `handleVerifyEachCompletion`'s
  `lastDoneStory` pattern). Story IDs not present in the database are
  silently ignored (logged as a warning). Only `done` stories are
  eligible — `pending` and `running` stories are untouched. The consumer's
  failure text is written into `runs.context` as `verify_feedback` and
  `retry_feedback` so the developer's next claim renders the reason for
  rework. Story `retry_count` is bounded by the story's `max_retries`: if
  the increment would exhaust the budget, the story transitions to
  `failed` with a `story.failed` event (the step does NOT fail —
  `checkLoopContinuation` handles failed stories independently).

  **Claim fencing:** Reroutes deliberately invalidate the producer's
  claim so stale completions from before the reroute cannot silently
  re-complete the re-pended step with old output. On reroute, the
  producer's `claim_job_id`, `claim_pid`, and `claim_pgid` are cleared
  and `claim_invalidated_by` is set to `'reroute'`. A fresh claim clears
  `claim_invalidated_by` to `NULL`. The `completeStepInternal` guard
  rejects completions for steps where `status='pending'` and
  `claim_invalidated_by='reroute'` (returning `{ status: 'blocked' }`),
  while sweeper-reset steps (`recoverOrphanedStepsForAgent`,
  `cleanupAbandonedSteps`) do NOT set `claim_invalidated_by`, so C5
  late-work acceptance is preserved — the guard checks
  `claim_invalidated_by`, not `claim_job_id`.

  **No-op bounce detection (C19a):** As a defense-in-depth layer, if a
  rerouted producer completes without any new agent work round having
  run since the reroute, a `step.reroute_noop` event is emitted and the
  completion does not silently consume the reroute budget. This is
  detected in two layers: (1) In `completeStepInternal`, when a stale
  completion arrives with `claim_invalidated_by='reroute'` and
  `claim_updated_at IS NULL` (the `UPDATE` on reroute clears it),
  `step.reroute_noop` is emitted before the completion is blocked.
  (2) In `claimStep`'s loop-step auto-complete path (no pending or
  failed stories → mark done), which never goes through
  `completeStepInternal`: if the step was rerouted (captured as
  `wasRerouted` from `claim_invalidated_by === 'reroute'` before the
  claim UPDATE clears it), `step.reroute_noop` is emitted. The reroute
  budget is NOT additionally consumed (already incremented on the
  consumer). These events make silent bounces observable in the event
  log rather than wasting reroute budget invisibly.
- **C20 (SJSN — story-ingestion structural validation)** A STORIES_JSON
  payload that parses but does not faithfully represent the planner's story
  list must be REJECTED with an informed retry, never silently accepted.
  Specifically: JSON.parse collapses duplicate keys (last-one-wins), so a
  planner that omits `},{` separators between stories produces ONE fused
  object that passes every per-story field check while silently discarding
  all but the final story (run 9672c8dd lost 6 of 7 stories this way and
  burned 560k tokens on the survivor, a verification-only story).
  `parseAndInsertStories` compares unescaped `"id"` key occurrences in the
  raw JSON text against the parsed story count and throws on mismatch;
  validation is two-phase (all stories checked before any insert) so a
  rejection never leaves partial stories for a retry to duplicate.

  Beyond the heuristic: `detectDuplicateKeys(text)` is the definitive
  duplicate-key authority — a character-by-character scanner that walks the
  raw text tracking object depth and reports ANY duplicate key within the
  same object (including non-id keys like `title` that the id-count
  heuristic is blind to). The heuristic remains a fast path; the scanner
  catches fused objects that happen to repeat only non-id keys, and its
  error messages name the duplicated key plus the story index and line
  positions so retry feedback is immediately actionable. The doctor's
  STATE group surfaces recent STORIES_JSON validation rejections (count,
  run IDs, error categories) from `step.retry` events, making fused-JSON
  regressions visible without log spelunking.

  Any STORIES_JSON validation failure inside `completeStep` re-pends the
  producing step with the reason as retry feedback, bounded by
  `max_retries`, then fails the run on exhaustion — it must NOT propagate
  as a thrown error (which would crash the completing CLI and leave the
  step to the blind abandon sweep). Pinned by
  `tests/stories-json-validation.test.ts`.
- **C22 (WLST — worker-loss story retry decoupling)** Worker-loss/timeout
  recoveries for stories use a separate `abandoned_count` budget
  (`ABANDON_STORY_MAX = 8` in `src/installer/step-ops.ts`), not
  `retry_count`. Both `recoverOrphanedStepsForAgent` (orphan sweep) and
  `cleanupAbandonedSteps` (stale-claim sweeper) increment
  `stories.abandoned_count` instead of `stories.retry_count` for
  loop-step story-level recoveries. Honest-verdict rejections
  (`STATUS: retry` in `handleVerifyEachCompletion`) and agent-initiated
  `step fail` calls continue to use `retry_count` — infrastructure failures
  and judgment budget are fully decoupled. Pinned by
  `tests/dead-worker-recovery.test.ts` (WLST story-level tests) and
  `tests/step-ops.test.ts` (WLST orphan-recovery exhaustion test).

### Control plane & scheduling lifecycle

- **C11** Pause stops dispatch for the run (draining in-flight work); resume
  restarts it; terminate tears down scheduling and kills in-flight harness
  processes.
- **C12** Run-scoped scheduling is torn down when the run reaches a terminal
  state (no leaked timers dispatching for completed runs). Teardown triggered
  by *natural completion* gives in-flight harness processes a grace window
  (`HARNESS_TEARDOWN_GRACE_MS`) to flush output and exit on their own;
  user-initiated terminate/pause/cancel of an active run kills immediately.
- **C13** Scheduling state is reconstructable from the DB (daemon restart
  reconciles jobs from `runs.scheduling_status`).
- **C18** Steps claimed by DEAD workers are requeued promptly: the daemon
  reconciler sweeps `running` steps whose `claim_pid` no longer exists
  (first tick ~1 s after startup, then every cycle) and nudges the affected
  runs. A daemon crash/reboot/kill therefore un-wedges interrupted runs in
  seconds — not the 1.5×timeout age threshold (up to 45 min), and never
  "forever" when no dispatch was running. Survivor guard: if the step's
  claim_pgid (the harness process group, self-detected by `step claim`) is
  still ALIVE, the step is left alone — an ungracefully killed daemon does
  not kill its detached harness children, and requeuing would put two
  agents in one workdir; the survivor's late completion is accepted (C5).
  Pinned by `tests/dead-worker-recovery.test.ts` and the scripted e2e
  daemon-SIGKILL test. Relatedly, `stopDaemon`/`stopMcp`/`stopControlPlane`
  refuse to signal the daemon named by TAMANDUA_WORKER_PID — an agent can
  no longer stop the very daemon scheduling it
  (`src/server/daemonctl-self-stop-guard.test.ts`).
- **C23 (WDOG — per-tick PGID liveness watchdog)** Every dispatch round
  tick (`executeDispatchRound`) runs a PGID-based liveness check
  (`checkRunningWorkersLiveness` in `src/installer/step-ops.ts`) BEFORE the
  stale-claim sweeper, providing minutes-to-seconds recovery for steps
  claimed by workers whose process group has died.

  **How it works:** For every step in `status='running'` with a `claim_pgid`
  set, the watchdog probes `process.kill(-pgid, 0)` — works on both Linux
  and macOS (no `/proc` dependency).  ESRCH means the process group is dead;
  EPERM means it exists but belongs to another user (treated as alive).
  Steps WITHOUT a `claim_pgid` (legacy/manual claims) are SKIPPED — they
  fall back to the existing timeout × 1.5 sweeper (C18).

  **Grace period:** Claims younger than `LIVENESS_GRACE_PERIOD_MS` (30 s)
  are skipped to avoid racing a round that just finished and is
  mid-report.  Claims with a NULL `claim_updated_at` are also skipped
  conservatively (cannot determine freshness).

  **Recovery:** Dead-PGID claims are recovered via
  `recoverOrphanedStepsForAgent` with `detailPrefix: "liveness-detected"`,
  so dashboards/logs can distinguish liveness-triggered recovery from
  timeout-based sweeper recovery and CLMR round-completion release.
  Story-level recovery uses the `abandoned_count` budget (C22/WLST
  semantics), not `retry_count`.  After recovery, affected runIds are
  nudged for immediate dispatch.

  **Safety:** The watchdog NEVER kills processes — it only releases
  claims of already-dead workers.  PID reuse is safe: if a pgid happens
  to be reused (alive again), the claim is left untouched; a dead
  detection on a reused-then-again-dead pgid causes at worst a delayed
  recovery (falls back to the timeout sweeper), never a false kill.

  **Relationship to other recovery paths:**
  - **Stale-claim sweeper (C18):** Blunt timeout × 1.5 (up to 45 min)
    for steps with stale claims — covers legacy/ownerless claims and
    serves as the safety net when liveness detection misses.
  - **CLMR (round-completion immediate release):** Fires when a dispatch
    round's work round tracker sees the round END with outcome `no_work`
    — fast but only triggers when the round tracker is aware of the
    round.
  - **WDOG (this clause):** Covers the gap — a worker that dies WITHOUT
    the round tracker noticing (daemon restart orphans, kill -9, machine
    sleep, harness crash mid-round) is detected within one tick (~15 s)
    via process-group liveness, recovering the step in seconds.

  **Zero tokens:** The check is pure process/DB inspection — no model
  calls, no extra polling loops (piggybacks on the existing dispatch
  tick).  Idle rounds produce no log noise.

  Pinned by `tests/dead-worker-recovery.test.ts` (C23 PGID liveness
  watchdog tests covering dead-pgid recovery, live-pgid untouched,
  ownerless skipped, grace period respected, event detail prefix,
  and story-level abandon accounting).

### Post-grace process cleanup sweep

When a run reaches a terminal state, in-flight harness processes are given a
grace window (`HARNESS_TEARDOWN_GRACE_MS`, 10 s) to flush output and exit
(C12). After the grace window expires, a **post-grace process cleanup
sweep** (`sweepRunProcesses` in `src/installer/run-cleanup.ts`) kills any
surviving orphan processes associated with the run.

**Architecture:**

- **Daemon-resident scheduling:** `removeRunCrons` in
  `src/installer/agent-scheduler.ts` schedules a one-shot, unref-ed timer at
  `HARNESS_TEARDOWN_GRACE_MS + 2 s` for every run whose crons are torn down.
  When the timer fires, `sweepRunProcesses` is called with the daemon PID
  excluded and NO `excludePgids` — after the grace window, any remaining
  harness process group was not cleaned up by the leak guard (C12) and IS a
  leak. The 2 s buffer gives the leak guard's immediate kill time to
  complete before the sweep runs.
- **Deduplication:** At most one pending timer per run (module-level
  `Map<runId, Timeout>` in agent-scheduler.ts). Duplicate `removeRunCrons`
  calls (e.g., control-plane terminate + natural completion race) do not
  create duplicate sweeps.
- **Daemon-resident by design:** The sweep timer is scheduled inside the
  daemon, not in the short-lived CLI process (`scheduleRunCronTeardown` in
  `step-ops.ts` no longer schedules a sweep — the CLI-side hook was removed
  in US-003; its unref-ed timer never fired in short-lived CLI processes
  anyway). The daemon is the natural long-lived home for the post-grace
  sweep.
- **Complementary pre-removal sweep:** The worktree-manager
  pre-removal sweep (`src/installer/worktree-manager.ts`, line ~354) runs
  `sweepRunProcesses` WITH `excludePgids` at worktree removal time, and
  remains unchanged. This sweep handles cleanup during worktree garbage
  collection, not during teardown.

**Accepted-miss risks:**

- **Daemon restart before sweep timer fires:** If the daemon is stopped or
  crashes between scheduling the timer and its firing, the sweep is lost.
  The pending sweep timers are in-memory only — they are not persisted.
- **Late-detaching stragglers:** A process that detaches from the harness
  process group after the sweep has already run (e.g., a deeply nested
  child subprocess that survives parent exit and re-parents to init) will
  not be caught by the one-shot sweep.

**Accountability layer — doctor check:** The `runProcessLeakChecks` function
in `src/doctor.ts` (STATE category, report-only, NEVER kills) scans for
processes belonging to runs in terminal status and reports them as warnings
with PID, evidence string, and run ID. This is the accountability layer for
accepted-miss risks: it surfaces leaked processes that escaped the sweep so
a human can clean them up. Remedy text: `Manual cleanup: kill <pid>`.

### Token accounting

- **C14** Model usage from *work* is attributed to `runs.tokens_spent`
  (via `message_end.usage` + run/step IDs from tool outputs, falling back to
  the dispatch job's own runId), emitting `run.tokens.updated` events with
  `tokenDelta`/`tokensSpent`.
- **C15** Terminal run events (`run.completed`/`run.failed`) carry
  `tokensSpent`. Caveat (inherent to the event ordering): the FINAL round's
  usage is parsed only after the harness exits, i.e. after the terminal
  event fired — so the event's `tokensSpent` can under-report by the final
  round (a single-step run reports 0). `runs.tokens_spent` in the DB is the
  eventually-correct total; tests must wait for it (`waitForRunWorkTokens`
  in e2e-helpers) rather than race it.

### Workspace

- **C16** Worktree runs execute in a managed detached worktree
  (`git worktree add --detach`, shared refs with the origin repository);
  branches created in the worktree are mergeable from the origin.
- **C17** The harness process runs with cwd = the run's
  `workingDirectoryForHarness` and inherits the daemon environment
  (state dir, DB path, control port).

## Where the contract is enforced

| Tier | Command | Motor coverage |
|------|---------|----------------|
| Scripted-agent e2e (**primary net**) | `./run-all-scripted-e2e-tests` | Real daemon → dispatch scheduler → harness spawn → stream parse → step-ops → pipeline advance → worktree/merge, driven by a deterministic fake pi. Zero tokens, ~1 min. Covers C1–C9, C12, C14–C17 and asserts N1/N2 (0 heartbeats, 0 system tokens). |
| Deterministic-motor acceptance | part of `npm test` (`tests/deterministic-motor-acceptance.test.ts`) | N1–N3 via in-process `executeDispatchRound` with an instrumented fake pi. |
| Smoke e2e | `./run-all-smoke-e2e-tests` | State machine + pipeline wiring via manual `step claim`/`complete`. Bypasses the motor. C1–C4. |
| Workflow graph simulation | part of `npm test` (`tests/workflow-graph-simulation.test.ts`) | Every bundled workflow simulated to completion in-process through pure step-ops (happy path, mid-run retry, retry exhaustion). Pins C1–C4, C8 independent of any motor. ~3 seconds for the whole catalog. |
| Unit/integration | `npm test` | step-ops invariants, recovery, control plane, DB, CLI, work-prompt shape, harness routing, work-round token attribution, persona injection. `npm test` pins `TAMANDUA_PI_BINARY=/usr/bin/false` so no unit test can ever reach a real model. |
| Real canary | `./run-real-e2e-canary` | ONE do-now run with a live model + token-accounting audit (C14/C15) and real-model baseline print (`systemTokens` must be 0). Small token spend. Run at motor milestones before the full real suite. |
| Real e2e | `./run-all-real-e2e-tests` | Full pipeline with live models, with token audits and on-timeout diagnostics. Final acceptance gate only: real tokens, minutes-to-tens-of-minutes per workflow. |

## Baselines

Deterministic motor (scripted e2e, zero-token, printed every run):
`bug-fix-merge-worktree = 6 work rounds, 0 heartbeat rounds, 666 work
tokens attributed to the run, 0 system tokens.`

Historical — the model-driven polling motor this replaced (real-model
campaign, 2026-07-03, all tiers green):

| Run | Work tokens | System tokens (idle polls) | Wall time |
|---|---|---|---|
| do-now canary | ~3,300 | ~0 (nudge-driven, finished before idle polls) | ~14 s |
| bug-fix-merge-worktree (real e2e) | 45,869 | 19,286 | 7.9 min |
| feature-dev-merge-worktree (real e2e) | 51,207 | ~23,105 (counter cumulative: 42,391) | 7.7 min |

Idle polling added ~30% token overhead on top of real work and scaled with
wall time, not with work.

Deterministic motor — real-model baselines (post-rewrite acceptance
campaign, 2026-07-02, all tiers green):

| Run | Work tokens | System tokens | Wall time |
|---|---|---|---|
| do-now canary | 3,052 | **0** | ~15 s |
| bug-fix-merge-worktree (real e2e) | 42,251 | **0** (was 19,286) | 3.5 min (was 7.9) |
| feature-dev-merge-worktree (real e2e) | 39,679 | **0** (was ~23,105) | 3.3 min (was 7.7) |

The idle-poll overhead is zero by construction (N1), and wall time roughly
halved: nudge-driven dispatch removed the poll-interval dead time between
steps, so runs now spend their time on model work, not waiting.

## Quirks the motor test campaigns exposed — all fixed

2026-07-02 (found by the scripted tier before the rewrite):

- `completeStep` had no duplicate-completion guard: a completion arriving
  for a step already `done` (agent CLI retry, orphan-recovery reclaim race)
  re-merged context, re-inserted STORIES_JSON stories, and re-advanced the
  pipeline. Rarely hit under the slow polling motor; the fast deterministic
  dispatcher would hit it. FIXED: terminal-status steps return
  `{ status: "blocked" }`; running/pending steps still complete normally.
  Regression: `tests/step-ops-dispatch-races.test.ts`.
- Prompts instructed `node "<cli>" ...` while `resolveTamanduaCli()` returns
  the `bin/tamandua` **shell** script; `node bin/tamandua` throws a
  SyntaxError. Live LLM agents had been silently working around the error
  every round — a deterministic agent cannot. FIXED: prompts invoke the CLI
  launcher directly.
- Run completion rugpulled the in-flight harness process group the moment
  the final `step complete` landed. Real pi emits its final assistant
  message (with token usage) AFTER the completing tool call, so the final
  round's usage was systematically lost. FIXED: completion-triggered
  teardown schedules the kill after `HARNESS_TEARDOWN_GRACE_MS` (leak guard
  only); user-initiated terminate/pause of active runs still kills
  immediately. Regression: "final-round token usage survives completion
  teardown" in workflows-scripted.test.ts.

2026-07-02 (exposed by the faster dispatch during the rewrite):

- `getDb()` rotated its cached handle every 5 s by closing it in place,
  killing the handle out from under synchronous callers that captured it
  earlier in the same call chain. FIXED: the close is deferred one tick.
- Concurrent writers (daemon dispatch + CLI completions + migrations) hit
  instant "database is locked" errors. FIXED: `PRAGMA busy_timeout = 5000`.
- Unit tests that start daemons could reach a REAL model: the old motor's
  minutes-long first poll had masked it; instant dispatch exposed it.
  FIXED: `npm test` pins `TAMANDUA_PI_BINARY=/usr/bin/false` (passes through
  `cleanChildEnv`), and the one deliberately-real-pi unit test is opt-in
  via `TAMANDUA_REAL_PI_TESTS=1`.

### Report-format contract (MPRT)

The work prompt's REPORT section defers to each step's own `Reply with:`
format; the generic `STATUS/CHANGES/TESTS` shape is a fallback used only
when the task specifies no reply format. History (both dev machines, both
motors): the old always-generic example trained agents to answer
`STATUS/CHANGES/TESTS` regardless of the step's key contract, starving
downstream template keys (`branch`, `verified`, …) in 10–90% of runs —
first silently (`[missing: key]` rendered into prompts), then fatally once
claim-time key enforcement landed. Pinned by tests/work-prompt.test.ts.
