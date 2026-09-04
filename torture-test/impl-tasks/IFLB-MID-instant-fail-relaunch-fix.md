# IFLB-mid: make the instant-fail backoff actually relaunch, and double the K/N defaults

## Context

RSPN (0070b044, 2026-08-24) classifies worker rounds whose harness exits almost immediately without claiming a step
as "instant fails". After K consecutive instant fails (default 3) the per-job dispatch is backed off (30 s, 60 s,
120 s, capped); after N (default 10) the run is force-failed with a `run.instant_fail_loop` event and a precise
reason. Confirmed defect (code + reproduction on the linux contained daemon at debug level, 2026-09-03 16:21Z): in
`src/installer/agent-scheduler.ts` `executeDispatchRound` marks the job in flight (`tryMarkJobInFlight`, ~line 1345)
BEFORE evaluating the backoff guard (~line 1353), and that guard's early `return` precedes the `try/finally` whose
`finally` (~line 1970) is the only place the in-flight mark is released. The first 15 s tick inside the backoff window
therefore leaks the mark; every later tick is skipped as "previous round still in flight"; no relaunch ever happens,
N is unreachable, and the run idles with a pending step until an external cancel. Observed timeline: three instant
fails at t, t+15 s, t+30 s; backoff; one tick skipped `instant_fail_backoff`; twelve consecutive ticks skipped
`previous_round_in_flight`; never another `Work round start`. The existing tests (agent-scheduler.test.ts ~1018-1154)
only assert the backoff engages and never tick again.

Decision (igorhvr, 2026-09-03): option A — fix the relaunch and keep the RSPN policy shape, but DOUBLE the default
thresholds: K 3 → 6, N 10 → 20. No probe-on-loop, no identical-stderr short-circuit, no new event types in this task.

## Stories

### US-001 — Fix the leaked in-flight mark
- Evaluate the instant-fail backoff guard BEFORE `tryMarkJobInFlight` (the guard only reads `instantFailStreaks`), or
  release the mark on that early return — whichever keeps the race-safety comment above the in-flight guard true.
  Audit `executeDispatchRound` for any other `return` between the in-flight mark and the round `try` and treat any
  such path the same way (there must be none left).
- Regression unit test: drive a job through K consecutive instant-fail rounds with a fake harness, then a tick inside
  the backoff window (assert the skip reason is `instant_fail_backoff` AND the in-flight set does not contain the
  job afterwards), then advance time past `nextAllowedDispatchAt` and tick: a harness spawn MUST happen. Use the
  scheduler's existing test seams (fake harness binaries, `_instantFailStreakFor`, fake timers or a shortened
  dispatch interval) — no production code paths added for the test.

### US-002 — Escalation reachable through real ticks
- Test: from K onward, keep failing through the widening backoffs (advance fake time past each `nextAllowedDispatchAt`)
  until the N-th consecutive instant fail: assert `run.instant_fail_loop` is emitted once, the run is force-failed
  with the RSPN reason (harness name, consecutive count, command preview), and dispatch stops for that run.
- Test: a successful (non-instant) round between failures resets the streak (existing semantics, now asserted through
  the same real-tick driver).

### US-003 — Double the defaults
- `src/installer/instant-fail.ts`: `DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD` 3 → 6, `DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD`
  10 → 20. Env overrides (`TAMANDUA_INSTANT_FAIL_BACKOFF_K`, `TAMANDUA_INSTANT_FAIL_ESCALATION_N`,
  `TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS`) unchanged. Update every test and doc that pins 3/10 (search the repo).
- Docs (README instant-fail/RSPN section, AGENTS.md if it mentions the thresholds): explain K and N in one paragraph
  each (consecutive instant-fail rounds; K starts the backoff, N force-fails the run), the new defaults, the resulting
  horizon with defaults (about 27 minutes: six rounds at the 15 s tick, then 30 s, 60 s and 120 s backoffs up to the
  20th round), and replace the "IFLB-mid known-open" note added by the launch-probe change with the fixed behavior.

### US-004 — Fast e2e for the mid-run case
- A run launched with a shim harness that answers the launch probe correctly and then exits 1 instantly on every
  work round (so the run passes the launch probe and only breaks mid-run), with low thresholds via env (for example
  K=2, N=4, base 1 s): the run must fail within about one minute with `run.instant_fail_loop` and the RSPN reason,
  zero steps completed, and the daemon log must show relaunches after the backoff (no `previous_round_in_flight`
  skips after a backoff-window tick). Run it in the fast e2e lane; keep it hermetic (temp HOME, isolated ports).

### US-005 — Acceptance
- `npm test` green on both lanes with an empty test-guard ledger.
- Tier-0 scripted ladder parity on the finished tree: same result as main f2dafe9e (every cell PASS except the
  documented `w4.35-retry-rebased-true-green` VEDL deadlock); S56 port collisions are infra. Report, do not pin-edit.

## Boundaries
- Do not change the launch-time harness probe semantics (harness-probe.ts) beyond its docs cross-reference.
- No new event types, no identical-stderr short-circuit, no probe-on-loop (explicitly declined for this task).
- No torture-test/ changes.

Test command: npm test
