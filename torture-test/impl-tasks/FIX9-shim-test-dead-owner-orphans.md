# Fix the recurring dead-owner-suite.sh orphan leak in product shim tests

Every execution of the product suite's shim dead-owner tests leaks an
orphaned shell loop that survives forever and must be hand-killed.
bd bug (P2) tracks it; occurrences: 2026-08-02 (x2), 2026-08-04 (x3),
2026-08-05 (x2 during tier0 acceptance), 2026-08-06 (x1 during the
GREEN tier0 run). Signature:

  /bin/sh -c /tmp/tamandua-test/tamandua-shim-base-XXXXXX/dead-owner-reclaim/dead-owner-suite.sh
    \_ /bin/sh <same script>
  (reparented to init; loops indefinitely)

Source: the dead-owner reclaim scenario in the product tests —
`src/suite/shim.test.ts` and/or `src/suite/suite-claim-liveness.test.ts`
(grep for dead-owner-reclaim / dead-owner-suite) — SIGKILLs the shim
owner as intended, but the detached suite script the owner was running
keeps looping and nothing owns its cleanup.

C2.2 (commit d0f4eb13) already solved this exact class for the ORACLE
self-test harness: track the actual detached suite process group,
validate fixture ownership, TERM-to-KILL escalation in teardown even
when a test fails. Port that ownership-scoped teardown pattern to the
product shim tests.

## Acceptance (verify before reporting done)

1. Run each affected test file 3x consecutively; after EACH run,
   `pgrep -f "dead-owner"` (excluding the pgrep itself) is EMPTY —
   show the sweeps in your report.
2. The tests still prove what they proved: the dead-owner reclaim
   path must still use a REAL SIGKILLed owner (do not soften the
   scenario to avoid the orphan).
3. Full `npm test` green (detached, 30+ min window), followed by one
   more empty pgrep sweep.
4. Close-loop: note the bd P2 issue id for the operator to close
   after independent verification.

## Hard constraints

- Product files only (src/suite/* tests and any helper they own);
  nothing under torture-test/; no changes to the shim's production
  dead-owner reclaim logic unless the diagnosis PROVES the leak is
  production-side (justify with evidence if so).
