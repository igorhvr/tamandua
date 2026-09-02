# YSE + PAUS: resume re-queues failed loop stories; plain resume cancels a pending drain with a warning

Authorized by igorhvr 2026-09-02 (YSE: "Authorize, bundled with PAUS semantics"; drain rule decided 2026-08-24).
Product run. bd issue tamandua-yse.

## Problem 1 — YSE (tamandua-yse, P2, open since 2026-08-02)
A loop run (verify_each stories) that failed because one story exhausted its verification retries cannot be
resumed usefully: `tamandua workflow resume` continues the remaining PENDING stories (all verified), but the
story left in FAILED state is never reset or re-planned, so when the pending ones run out the loop
terminal-fails again with `Loop has failed stories and no pending stories` — run #826 (2026-08-02) died this
way at 10.7M tokens with 15/16 stories done and the failed story's gap partially addressed by later stories.
Since then every failed loop run has been hand-salvaged (cancel, adopt branch, bounded task) instead of resumed.

## Problem 2 — PAUS resume-during-drain (decided 2026-08-24)
When a run has a pending drain (pause --drain in progress) and the operator issues a plain resume, the resume
must CANCEL the pending drain and proceed, printing a warning that a drain was in progress and is being
cancelled. (Bundled here because both live in the resume path.)

## Fix
1. Resume of a failed loop run: every story in FAILED state is reset to PENDING with a fresh verification
   retry budget (the story's failure history stays in the event stream / notes, e.g. `story.reset_for_resume`
   event {story, prior_failures}); the loop then picks it up normally. Stories already DONE stay done. If the
   run has a planner re-plan corridor, keep it available but the default is reset-to-pending (simplest,
   deterministic).
2. Resume with a pending drain: cancel the drain (clear the pending-drain marker atomically with the status
   flip), emit a `run.drain_cancelled_by_resume` event, and print the operator warning on the CLI.
3. `tamandua workflow status` shows reset stories distinctly (e.g. "pending (reset on resume, 1 prior failure)").

## Prove (one gate per story; each proof story fits one worker round)
- Regression from the run #826 timeline: loop run with one FAILED story + N pending → resume → the failed
  story is re-queued and the run completes; without the fix it terminal-fails with the exact message above.
- Drain regression: paused-with-pending-drain run → plain resume → drain cancelled, warning printed, run proceeds;
  events assert the cancel.
- No behavior change for resume of runs without failed stories / without pending drain (existing tests green).
- Full `npm test` green.

## Constraints
Product code only (src/, tests/, docs/). Preserve fail-closed semantics everywhere else. Kill only pids you
spawned — never by name or pattern. Do not touch torture-test/.
