# MTST: `runWorkflow` test teardown races daemon children on darwin (ENOTEMPTY) — flaky serial lane

Authorized scope: igorhvr's mac-torture directive (2026-09-01): "obvious/trivial fixes related to the
differences between mac and linux — you are authorized to fix them yourself via tamandua runs on the mac".
Product test-hygiene fix; run on the mac (pi harness), bring back to linux main afterwards.

## Evidence
- 2026-09-02T00:33Z, mac stage-1 ladder (tree 8cc1ca80), `npm test` serial lane FAILED:
  `✖ runWorkflow (118155.917375ms)` → `Error: ENOTEMPTY, Directory not empty:
  /private/tmp/tamandua-test/tamandua-run-BDxbfx`. Same tree passed 30 min earlier (23:42Z) and on linux
  (94.5 s). Log: ~/mac-torture-logs/v2/NPM_TEST-attempt2-enotempty.log on the mac.
- `src/installer/run.test.ts` `after()` already documents the race: "Retries absorb stragglers still
  writing into the temp home during teardown (ENOTEMPTY otherwise, seen on macOS)" — 250 ms + 15×200 ms
  of `fs.rmSync` retries, which lost this time.
- Root cause (verify): the suite starts a daemon inside the temp HOME; the daemon spawns DETACHED children
  (dashboard-standalone, mcp-standalone, control plane; pid files `dashboard.pid`, `mcp.pid`,
  `control-plane.pid` under `<tempHome>/.tamandua`). Teardown calls `stopDaemon` and waits ONLY for the
  daemon pid; the children keep writing logs/WAL into the temp HOME while `rmSync` is retrying. Darwin's
  slower process teardown makes the 3.25 s window insufficient.

## Fix (product test hygiene, darwin-robust, no behavior change in the product)
1. In the `runWorkflow` suite teardown (and any sibling suites that start a daemon in a temp HOME — grep
   for `stopDaemon({ homeDir` in src/**/*.test.ts and tests/**), stop AND wait for every daemon-family
   process recorded in the temp HOME's pid files (`tamandua.pid`, `mcp.pid`, `control-plane.pid`,
   `dashboard.pid`) before removing the directory — reuse/extend the existing pid-file sweep helper in
   `src/server/daemonctl.ts` (~line 271) rather than duplicating it. Kill ONLY pids read from THOSE pid
   files (never by name/pattern), verify exit with `waitForPidExit`, then `rmSync` with the existing retries.
2. If a straggler is not covered by a pid file (e.g. a worker shim), make the teardown wait bounded and
   report WHICH process kept the directory busy (list remaining entries) so the next failure is
   diagnosable instead of a bare ENOTEMPTY.
3. Keep the suite's wall time from growing: waits are event-driven (pid exit), not fixed sleeps.

## Prove
- `npm test` serial lane green TWICE in a row on this host (darwin) — each run its own story.
- The `runWorkflow` suite duration does not regress materially vs today (~118 s on darwin, ~95 s linux).
- Unit test for the teardown helper: fake pid files + fake processes → all stopped and awaited; a missing
  pid file is skipped; a stale pid (no such process) is skipped; the helper never kills a pid it did not
  read from a pid file under the given HOME.

## Story shape (mandatory — one gate per story; each proof story fits one round)

## Constraints
Product test code only (src/**/*.test.ts, tests/**, and the daemonctl helper if extended); no changes to
torture-test/. Never touch the operator's live daemon (33xx) or real ~/.tamandua. Kill only pids read
from pid files under the test's temp HOME.
