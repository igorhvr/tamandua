# Tier-0 gate catch: sweep-timer test red under a fresh HOME

First finding by the operational Tier-0 push gate (2 consecutive
campaigns, deterministic): case `W0.1-build-unit` fails because ONE
product unit test is red — but ONLY under a contained/fresh HOME.

## Reproduction (verified 2026-08-05)

- `node --test src/installer/agent-scheduler.test.ts` with the
  operator's real HOME: 31/31 green.
- Same command with `HOME=<fresh empty dir>` (plus
  GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM set, as the tier0 W0.1 hook
  does): `✖ schedules a sweep timer when removeRunCrons is called`
  (src/installer/agent-scheduler.test.ts:434) — the FIRST assertion
  `assert.equal(_pendingSweepTimerCount(), 0)` right after
  `setupAgentCrons(...)` fails with `1 !== 0`. A sweep timer is
  already pending before removeRunCrons runs, only in the fresh-HOME
  environment.

## Work

1. Diagnose the real mechanism: what schedules a pending sweep timer
   during `setupAgentCrons` (or leaks one from an earlier test in the
   file) when HOME is fresh but not when ~/.tamandua state exists.
   Follow the code (agents.json read/write, cron registration/removal
   paths, module-level timer state); do not guess.
2. Fix properly:
   - If it is TEST hygiene (shared module state across tests,
     missing before/afterEach reset of pending sweep timers), make the
     suite hermetic so it passes in ANY HOME.
   - If it is a PRODUCT behavior difference keyed on ambient state
     (setup scheduling a sweep as a side effect on fresh state), fix
     or document the product path and adjust the test to pin the
     CORRECT behavior in both environments.
3. Prove it: `node --test src/installer/agent-scheduler.test.ts`
   green under BOTH the real HOME and a fresh HOME (show both).
   Full `npm test` green (15-25+ min; never a timeout under 30 min;
   run detached and poll).

## Context for the fix

The tier0 hook environment that exposes this:
`torture-test/cases/hooks/run-w0.1` (contained HOME + stub pi
settings + isolated git config, then `npm run build && npm test`).
Do not modify the hook or any torture-test case to mask the failure —
the gate did its job; the product test (or product path) is what
gets fixed. Files outside torture-test/ are allowed ONLY for this
product fix (src/installer/agent-scheduler* and directly related).

## Ultimate acceptance

After your fix merges, the operator will run
`./run-torture-test --tier0` — it must go GREEN (33 scripted PASS,
2 NOT_RUN real cases). Your own proof: the two node --test runs above
plus the case hook `bash torture-test/cases/hooks/run-w0.1` exiting 0
in a contained HOME (you may reuse the controller's contained-home
pattern for this proof).
