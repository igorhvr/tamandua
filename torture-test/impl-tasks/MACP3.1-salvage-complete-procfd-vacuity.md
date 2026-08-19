# MACP3.1: adopt and land the MACP3 branch — /proc portability + vacuity guard (salvage of run-0ba389c8)

MACP3 (run-0ba389c8) force-failed on the abandonment ceiling (8/8) WITHOUT
merging: it was mistakenly launched on the pi harness, whose ~66-minute
internal round cap kept truncating US-010's long final-proof round mid-work
(clean exit, no STATUS, outcome other_output — evidence in tamandua.log,
"Orphaned step recovery" entries, 2026-08-19). The WORK IS DONE AND GOOD
through US-009 on branch:

  feature/macp3-procfd-portability-vacuous-green
  (HEAD f53737f9 "US-009 - Red-then-green proof for the bare vacuity guard")

Your job: land it honestly.

1. Merge branch feature/macp3-procfd-portability-vacuous-green into your
   work branch (it is 10+ commits of reviewed-by-its-own-verifier work:
   portable exclusive-create replacing /proc/self/fd in the oracle
   evidence writer + host-profile path, a /proc sweep of runtime tools
   and test harnesses with guarded/documented sites, an unguarded-/proc
   lint self-test, fail-closed predicate semantics [unevaluable =>
   TEST_INFRA_FAIL, never silent skip], and the bare-verdict vacuity
   guard with red-then-green proof).
2. Rebase/reconcile onto current main (main has moved: KSNT a446deac +
   T2.1 ea8563c9 landed daemon-control/controller/scenario changes).
   Resolve semantically, not just textually: T2.1 changed tt-controller
   provisioning and daemon-control; re-run the relevant self-tests after
   reconciliation.
3. Verify the adopted work on the union honestly — do not assume the
   branch is correct because MACP3's verifier passed it: run the /proc
   lint self-test, the vacuity red-then-green tests, the scope-isolation
   suite, and the tier2-assets guard suite; all green from repo root.
4. Complete the original US-010: MACP3 task doc updated
   (torture-test/impl-tasks/ evidence note), full self-test battery
   `./torture-test/self-tests/run.sh` exit 0 from repo root, and bare
   `./run-torture-test --tier1` GREEN on the merged result — genuinely
   executed scripted cells (the vacuity guard itself must be live), in a
   quiet window (53xx free; if busy, wait — do not weaken the gate).
5. Report: confirm each original MACP3 acceptance item (portability fix,
   /proc sweep completeness, fail-closed predicates, vacuity guard) with
   pointers to the adopted commits + your union re-validation evidence.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. No concurrent torture runs expected; if 53xx ports are
  busy anyway, treat it as a quiet-window wait, not an error to fix.
- Do NOT re-implement from scratch — adopt the branch; write new code
  only where the main-reconciliation or your re-validation finds a
  genuine defect (document any such fix distinctly in your report).
