# WAVE-B.1: restore `terminal_reroute_count` semantics (terminal-class only) broken by RCNT; fix W4.10 corridor under the original contract

Product fix, within the RCNT authorization (igorhvr 2026-09-01: "reroute counter/event consistency"); this
corrects the semantics WAVE-B (12c53f59, US-003 RCNT) landed. Found 2026-09-02 by the first heavy-corridor
run on merged main (tier-0 push gate RED: 18 PRODUCT_FAIL). Not yet pushed or installed anywhere.

## What broke
- `src/installer/step-ops.ts` `rerouteWithPolicy` now increments `terminal_reroute_count` for EVERY
  `rerouteStepSync` caller ("consumer retry-exhaustion corridor", `countsAsTerminal=true`), i.e. for every
  reroute that emits `step.rerouted`.
- But `terminal_reroute_count` is a GATE CONTROL with a narrower meaning: it counts TERMINAL-CLASS reroutes
  only and drives the one-shot terminal allowance — `step-ops.ts:3776`
  `(consumerStep.terminal_reroute_count ?? 0) < 1 || hasIndependentGateAllowance`, and the exhaustion checks at
  `:4003` / `:4154` (`rerouteMode === "terminal" && terminal_reroute_count >= 1`). Inflating it on ordinary
  expects-reroutes means a consumer loses its one terminal allowance after its FIRST ordinary reroute: runs can
  now fail earlier than before. `reroute_count` (and the `step.rerouted` event stream) already count ALL reroutes.
- The Tier-0 push-gate scenarios pin the original contract: e.g.
  `torture-test/scenarios/w4.35/w4.35-done-rebased-true-green/scenario.json` expected_route =
  `{terminal_route: expects-reroute-exhausted, reroute_count: 8, reroute_events: 8, terminal_reroute_count: 0,
  merger_invocations: 9, must-not-land}`. On main they now fail `scenario_passed` (18 cells: the done-rebased /
  missing-status / retry reroute-exhaustion families); the failed-rebased family still passes.
- The WAVE-B task text was the root cause: it told the worker "assert event count == terminal_reroute_count" —
  an over-broad invariant. The landed tests (`tests/step-ops.test.ts`, RCNT block) encode that wrong invariant.

## Fix
1. `terminal_reroute_count` increments ONLY for terminal-CLASS reroutes (the pre-WAVE-B rule: `rerouteMode ===
   "terminal"`, i.e. failure-class terminal decisions such as FAILURE_CLASS terminal / ledger-gate terminal
   refusals). Remove the `countsAsTerminal`-for-every-caller behavior. `reroute_count` keeps counting all
   reroutes. The one-shot terminal allowance semantics return to what the gate code and the Tier-0 pins expect.
2. Event/counter consistency, done right: `step.rerouted` gains a `terminal: boolean` field (and `rerouteMode`),
   so consumers reconcile `terminal_reroute_count == count(step.rerouted where terminal=true)` and
   `reroute_count == count(step.rerouted)`. Update `logs-tail-format` / docs accordingly.
3. The ORIGINAL W4.10-restart observation ("finalize rerouted once, merger ran twice, terminal_reroute_count
   stayed 0"): re-examine that corridor (checkout-refresh / PARK finalize reroute after daemon restart). If that
   reroute is terminal-class, it must increment the counter (fix the missed increment there specifically); if it
   is an ordinary reroute, the event's `terminal:false` field makes the observation consistent by definition.
   Write down which it is in the landing note.
4. Rewrite the RCNT regression tests to the corrected invariants (both counters vs the flagged events); add a
   test that an ordinary expects-reroute does NOT consume the one-shot terminal allowance; add a test for the
   W4.10 corridor under the corrected rule.

## Prove (one gate per story; each proof story fits one worker round)
- `npm test` green (full suite).
- Bare Tier-0 gate GREEN on this tree: `./run-torture-test --tier0` → 33/33 PASS (all w4.35 families incl.
  done-rebased-*, missing-status-*, retry-*), matching the pinned expected routes. This is the acceptance
  criterion that WAVE-B lacked.
- Bare `--tier1` GREEN (no regression).

## Constraints
Product code only; do NOT edit torture-test/ scenarios or pins to make them pass — the pins are the contract.
Preserve all fail-closed semantics and thresholds. Kill only pids you spawned.
