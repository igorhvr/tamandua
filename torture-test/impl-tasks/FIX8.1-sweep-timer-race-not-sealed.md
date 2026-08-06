# EMERGENCY: FIX8 (bac0bee6) did not seal the sweep-timer race — suite now red on main

FIX8 landed with its verifier green, but post-merge verification shows
`src/installer/agent-scheduler.test.ts` is now DETERMINISTICALLY red
on main (3/3 consecutive runs):

- Real operator HOME: 31 pass / 1 fail —
  `✖ does not schedule sweep timer when no jobs were removed`
  (line ~517): `_pendingSweepTimerCount()` is 1 at the assertion at
  line ~523 — a pending sweep timer LEAKED from an earlier test.
- Fresh contained HOME: 30 pass / 2 fail (same + one more).

So the exact race FIX8's own commit message described — a
fire-and-forget `executeDispatchRound` promise from `nudgeScheduledRuns`
resolving AFTER the owning test's teardown and re-populating the
module-level `pendingSweepTimers` map — is still alive; FIX8's
`if (removed.length > 0)` guard narrowed one entry path but the
asynchronous leak across test boundaries remains (and its new test is
the current victim).

## Work

1. Read FIX8's diff (`git show bac0bee6`) and the module
   (`src/installer/agent-scheduler.ts`): map EVERY path that can
   schedule a sweep timer and every async fire-and-forget that can
   outlive a test.
2. Seal it properly. Acceptable shapes (pick what fits the code):
   - Make dispatch rounds trackable: keep a module-level set of
     in-flight round promises; `shutdownAllCrons()` (already the
     afterEach hook) awaits/settles them (or cancels via a generation
     token) before clearing timer state, so nothing revives state
     after teardown.
   - Generation/epoch counter: rounds capture the epoch at spawn;
     scheduleSweepTimer refuses to register when the epoch has moved
     (shutdown bumps it).
   Do NOT fix by having tests sleep, retry, or clear state defensively
   at the START of tests — that hides the leak the gate exists to
   catch. The PRODUCT must not let a completed round mutate state
   after shutdown; tests pin that.
3. Prove it: `node --test src/installer/agent-scheduler.test.ts`
   green 5/5 consecutive runs under the real HOME AND 5/5 under a
   fresh HOME (`HOME=<empty dir>` + GIT_CONFIG_GLOBAL/NOSYSTEM as the
   tier0 W0.1 hook sets). Then full `npm test` green (detached,
   30+ min window).

## Hard constraints

- Product change in src/installer/agent-scheduler.ts (+ its test
  file) only; nothing else outside torture-test/.
- Do not touch torture-test/ cases/hooks.
- Preserve FIX8's legitimate `removed.length > 0` guard semantics.

## Ultimate acceptance

Operator will run `./run-torture-test --tier0` after merge — the
W0.1-build-unit case (contained-HOME build + full unit suite) must
PASS, making the whole gate GREEN.
