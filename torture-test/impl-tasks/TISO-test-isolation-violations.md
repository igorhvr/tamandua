# TISO: tamandua's own test suite leaks to the operator's real ~/.tamandua — make violations fail tests, fix the sites

Authorized by igorhvr 2026-09-02 ("authorize TISO as you recommended"). Product test-hygiene run.
ZERO runtime-behavior change for real tamandua runs is a hard requirement (see Constraints).

## Evidence (linux `npm test` on a5b233b9, 2026-09-01; darwin shows the same class)
`npm test` prints 77 `TEST ISOLATION VIOLATION` lines: tests that never point HOME / TAMANDUA_STATE_DIR /
TAMANDUA_DB_PATH at a per-test temp directory make the product resolve the operator's REAL state —
47× `~/.tamandua/tamandua.db` (db open), 17× `~/.tamandua/tamandua.log` (logger), 2× events
(`~/.tamandua/events/zombie-run-001.jsonl`), ~3 are the guard's own self-tests provoking it on purpose.
Heaviest suites: dashboard version status API (8), kanban poll toggle HTML (5), dashboard pause/resume UI (4),
dashboard cancel UI (4), token counters UI (3), relaunch UI (3), hurry status icons UI (3),
daemon-lifecycle surfacing (3), recordLifecycleEvent (2), kanban-data bounded events handler (2),
suite stats and flaky keys (2), run relaunch API (2), plus a long tail.
Today `src/lib/test-guard.ts` THROWS (TAMANDUA_TEST_GUARD=1 / NODE_TEST_CONTEXT) and the callers
(logger, events, db, ...) catch and SKIP the write, so the operator's state is protected — but the tests
pass without exercising those writes (coverage blind spots), and the class stays invisible.

## Fix
1. Harness-side enforcement (NOT a production-path change): when — and only when — `testGuardActive()`,
   the guard appends each violation (kind, path, `what`, and the originating test file/suite if derivable
   from the stack) to a ledger whose location the `npm test` runner provides via an env var (per-run temp
   file, passed through cleanChildEnv to spawned daemons like TAMANDUA_TEST_GUARD is). The PRLL runner
   (serial and parallel lanes) FAILS the lane when the ledger is non-empty and prints the entries grouped
   by test file. The guard's own self-tests assert on the thrown error and must not leave ledger entries
   (they may use an explicit "expected violation" marker the runner honors).
2. Fix every violating site: point each suite at a per-test temp HOME + TAMANDUA_STATE_DIR + TAMANDUA_DB_PATH
   (reuse the existing helpers/patterns — e.g. the `env.homeDir` fixture used in status.test.ts and
   `tamanduaTempDir`), restore env in after(), and where a test previously "passed" only because the write
   was skipped, make it assert the write actually happened in the temp state (that is the coverage the class
   was hiding).
3. Keep the guard's semantics for real runs untouched: `testGuardActive()` false ⇒ every guard entry point
   returns immediately as today. Add a unit test proving that with TAMANDUA_TEST_GUARD unset and
   NODE_TEST_CONTEXT unset, none of the guard functions throws, logs, or writes anything (no ledger file).
   Do not add new imports of the guard into production modules; do not change any caller's catch behavior
   outside `if (testGuardActive())`.

## Prove
- Red-arm: a deliberately violating throwaway test makes the lane FAIL with the attribution line; remove it
  and the lane is green. Both lanes.
- Full `npm test` green with an EMPTY ledger (0 violations) on this host.
- Unit test for the no-op-when-inactive property (above).
- Count check in the landing note: violations before (77) vs after (0).

## Story shape (mandatory — one gate per story; each proof story fits one worker round)

## Constraints
Product test code + the test runner + the guard's ledger branch only. No behavior change for real runs
(guard inactive ⇒ no-op, byte-identical paths). Never touch the operator's live daemon (33xx) or real
~/.tamandua from tests — that is the whole point. Kill only pids you spawned (never by name/pattern).
