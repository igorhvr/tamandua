# FFRC: force-fail teardown emits spurious run.completed and blocks resume (authorized product fix)

Evidence: campaign #8 attempt-3, W3.21-fail-force-resume
(torture-test/var/results/campaign-20260822T073029892Z-48c0215b-.../
evidence/W3.21-fail-force-resume/, contained events file for its run, and
the contained tamandua.log). Timeline within ~300ms:

  14:39:25.184Z run.force_failed   (aliveWorkerCount:1 — a worker still in flight)
  14:39:25.391Z run.completed      <- SPURIOUS: the run did not complete
  14:39:25.290Z resume invoked -> CLI reads DB status 'failed', takes the
                documented resume-failed path (resumeWorkflow,
                src/installer/run.ts:545), resets run to running, asks the
                daemon to register
  14:39:25.478Z run.failed "Resume registration failed: Run is terminal:
                completed"  <- daemon's terminal-state cache poisoned by
                the spurious event; CLI surfaces an UNCAUGHT THROW, exit 1

1. Force-fail teardown must emit ONLY its truthful terminal event
   (run.force_failed / run.failed per existing vocabulary) — never
   run.completed. Find why the completion path fires (likely the normal
   step/run completion handler running during teardown of the surviving
   worker round) and gate it.
2. The daemon's terminal-state cache must stay consistent with the DB
   terminal status for the run at all times during teardown.
3. Resume registration during an active teardown/drain window must not
   throw: either wait for teardown quiescence (bounded) or return a
   precise, retriable error ("run teardown in progress, retry") that the
   CLI renders cleanly (no stack trace, meaningful exit code).
4. Regression test replaying the W3.21 shape: force-fail a run with an
   in-flight worker, immediately resume; assert no run.completed is
   emitted, the cache/DB agree, and resume either succeeds after
   teardown or fails with the retriable error — never the terminal:
   completed contradiction. Event-vocabulary test pinning that
   run.completed only ever follows genuine completion.

## Hard constraints
- Product code only (src/, tests/, docs/MOTOR-CONTRACT.md if the
  teardown/resume contract changes). No torture-test/ changes.
- Do not restart or reconfigure the live daemon (33xx).
- A concurrent product run (RSPN) owns the round-scheduler launch path
  (agent-scheduler and round-classification code) — your surface is the
  force-fail teardown, terminal events/cache, and resume registration;
  coordinate file ownership by staying off the scheduler loop.
