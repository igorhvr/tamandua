# WAVE-B.1.1: bounded salvage-landing of the completed WAVE-B.1 branch (terminal_reroute_count semantics)

WAVE-B.1 (run-7aedbb05, worktree 899-7aedbb05, branch `feature/rcnt-terminal-class-reroute`, tip 95ac54e3) completed its product work
(US-001..US-005: terminal-class-only `terminal_reroute_count`; `terminal`/`rerouteMode` on `step.rerouted`;
RCNT tests rewritten; W4.10-restart corridor classified + regression; full `npm test` green on the branch) and
then FAILED only its acceptance story US-006 (bare tier-0 33/33) for a reason outside its authorization: after
WAVE-A landed (09c10ce5) `tt-tier0-assets` rejects every w4.35 scenario's 6-agent behaviors.json ("expected auditor,
fixer, investigator, merger, reviewer, setup, triager, verifier") so tier-0 reports "unavailable" (exit 3). That is
a torture-suite asset-parity defect (S58, separate suite run), not a product defect. The regression WAVE-B.1 fixes
was DEMONSTRATED by a clean tier-0 A/B on 2026-09-02 (pre-WAVE-B tree: w4.35 cells PASS; WAVE-B tree: 15 cells
"terminal reroute count expected 0, actual 8").

## Task (bounded — run each gate EXACTLY ONCE; no re-planning)
1. Adopt branch `feature/rcnt-terminal-class-reroute` at 95ac54e3: fetch it into this run's worktree and rebase/merge it onto current main
   (main has moved: MJAV/MTST merges, task files). Resolve conflicts, if any, in favor of the branch's product
   semantics; do NOT reimplement.
2. Run the full `npm test` ONCE on the adopted tree; it must be green (both lanes).
3. Verify by reading (no new tests): `rerouteWithPolicy` increments `terminal_reroute_count` ONLY for terminal-class
   reroutes; `step.rerouted` carries `terminal` + `rerouteMode`; `reroute_count` still counts all reroutes.
4. Landing note in the merge commit message: tier-0 acceptance deferred to S58 (asset parity) with the A/B evidence
   cited above; tier-0 33/33 on main remains a certification gate before any push.
5. Merge (finalize) — that is the whole task.

## Story shape (mandatory): ONE gate per story; each proof story fits one worker round; never re-run a passed gate.

## Constraints
Product code only (src/, tests/, docs/); do not touch torture-test/. Kill only pids you spawned.
