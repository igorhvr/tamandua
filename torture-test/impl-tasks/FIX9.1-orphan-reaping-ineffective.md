# EMERGENCY: FIX9's orphan detector works, its reaping does not — shim.test.ts red on main

FIX9 (f12f9411) added ownership-scoped teardown for the dead-owner
test orphans. Post-merge verification (rebuilt dist, 3 consecutive
runs of `node --test src/suite/shim.test.ts`): the new teardown
ASSERTION fires every run —

  ✖ identifies a real shim claim so a waiter can reclaim it after SIGKILL
  AssertionError: dead-owner orphan(s) survived teardown: <12 pids>

Two distinct facts in that pid list:
1. FRESH pairs (e.g. 4936/4937, born during verification run 1, still
   alive during run 3): the teardown's kill path does NOT actually
   reap the orphan pair it just detected in this environment — the
   detector sees them, the reaper misses them. Suspect the same
   pgid/session asymmetry class C2.2 fixed for the oracle harness
   (kill targeted at a pgid that differs under a plain shell vs the
   managed-worktree environment where the run's verifier saw green).
2. STALE pairs from executions predating the fix (high pids) also
   appear in the assertion, so any historical leak permanently reds
   the suite until hand-cleaned.

## Work

1. Diagnose why the kill path misses: compare the pgid/pid the
   teardown targets vs the actual orphan's pgid/session in a plain
   shell (the orphan is `/bin/sh -c .../dead-owner-suite.sh` with a
   child `/bin/sh` — reparented to init, possibly its own pgid via
   setsid or shell job control differences). Fix the reap to kill the
   ACTUAL process group / tree (C2.2's process-start-identity +
   TERM-to-KILL pattern is the reference, commit d0f4eb13).
2. Scope the assertion to THIS test execution's own spawns (track
   pids/base-dirs created by the test; assert those are gone).
   Pre-existing strays from other runs must NOT red the suite — but
   DO have the teardown best-effort reap any stray matching the
   dead-owner signature older than the test start, logging what it
   killed (so historical leaks self-heal instead of accumulating).
3. Prove: 3 consecutive `node --test src/suite/shim.test.ts` runs
   green with `pgrep -f dead-owner` EMPTY after each (show output);
   ALSO run once from a fresh contained HOME (tier0 W0.1-style env)
   green + empty sweep. Full `npm test` green detached (30+ min
   window), one final empty sweep.

## Hard constraints

- Product test files (src/suite/*) and their helpers only; nothing in
  torture-test/; do not weaken the real-SIGKILL scenario or the
  reclaim assertions.
- Keep the honest orphan detector — fixing the reaper is the point,
  not silencing the alarm.
