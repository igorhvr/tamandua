# CNEV: cancelled runs must emit a terminal event

Operator-authorized product fix (igorhvr, 2026-08-13; finding CNEV from
Tier-1 campaign #7 — reproduced on every cancelled run).

Today `tamandua workflow stop` (cancelRun in src/installer/status.ts,
~lines 307-330) flips the DB run to `canceled`, cancels pending steps,
tears down crons, and a final `run.tokens.updated` can still flush
afterward — but NO terminal event is ever emitted. `run.canceled` does
not exist in the product event vocabulary (src/installer/events.ts —
run.started/run.completed/run.failed; run.deleted and run.force_failed
have emitters). The DB and the event stream permanently disagree about
cancelled runs: event consumers (dashboard, waiters, oracles, tooling)
see a stream that just stops, indistinguishable from a hang. Campaign
evidence: runs 776c4957, 89305ce2, f80e9c4d — each DB=canceled, event
file ends on run.tokens.updated, zero terminal events; `workflow wait`
exited 3.

## Work

1. Add `run.canceled` to the event vocabulary and emit it on EVERY path
   that transitions a run to canceled status (workflow stop / cancelRun,
   and any other call sites that set status='canceled' — enumerate them;
   pause-related and delete/force-fail paths keep their existing
   semantics). Payload parity with run.completed/run.failed (runId,
   workflowId, timestamps, plus a `reason` field carrying the stop
   source when available, e.g. "cli-stop").
2. Ordering: the terminal event must be the LAST event of the run in
   the common path — emit after the cancel bookkeeping so a
   straggling token flush does not trail it; if a late async token
   update can still land after (the TATR race is explicitly OUT of
   scope to fix here), document the ordering caveat where the event
   contract is documented (MOTOR-CONTRACT.md and/or events docs).
3. Audit consumers that pattern-match terminal events
   (run.completed|run.failed) — dashboard, wait paths, cleanup/cron
   teardown, anything switch-casing event types — so run.canceled is
   handled (at minimum: treated as terminal, never crashes, never
   treated as unknown-noise). `workflow wait` on a cancelled run must
   terminate promptly with a documented, distinct exit code — keep the
   current code if it is intentional, but make it contract (document +
   test), not accident.
4. Tests: unit coverage for the emitter on each cancel path (including
   cancel-during-running-step and cancel of a not-yet-started run);
   an events-vocabulary/contract test; extend the existing scripted e2e
   lane with a cancel scenario asserting the event appears in the run's
   event file as the terminal record. Full `npm test` green + fast
   scripted e2e lane green.

## Hard constraints

- Product scope ONLY (src/, docs, tests/). Do NOT touch torture-test/
  — three concurrent runs (E3.A/B/D) own that tree.
- Do not change completed/failed/deleted/force_failed semantics; do not
  attempt the TATR token-attribution fixes (separate finding, operator
  has not authorized it).
- Never touch the operator's live daemon; standard workflow-run rules.
