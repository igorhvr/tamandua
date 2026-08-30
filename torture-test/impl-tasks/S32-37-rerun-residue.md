# S32-S37: re-run residue — six narrow suite-infra classes from the 13-cell tier-2 re-run

The 2026-08-30 targeted re-run (campaign-20260830T* single-case campaigns,
one per cell, scratchpad rerun13 logs mirror report.txt) recovered 6 of 13
cells (3 PASS, 3 PRODUCT_FAIL now judged by oracles). The remaining 7 are
TEST_INFRA_FAIL in five narrow classes, plus one battery-hermeticity item:

1. **S34 deadline-sweep race (3 cells: W4.10-kill-daemon, W4.37-keyline-
   spoof-repo-content, W4.48a-daemon-kill-mid-park).** `deadline-expired
   (attempt deadline ... expired 0-4s before the independent deadline sweep
   observed it)`. The attempt deadline and the CDSK independent sweep race
   within seconds; a case that was actually progressing gets classified
   TEST_INFRA_FAIL on a sub-5s margin. Fix the ordering/grace contract
   (e.g. the sweep must not void an attempt that reached terminal within a
   documented grace window, or deadlines get a sweep-aware margin); keep
   fail-closed for genuinely hung attempts. Also determine WHY these three
   cells approached their deadlines at all (caps vs honest durations for
   kill/park scenarios — recalibrate the manifests if the cap is simply too
   tight for the post-fix honest path, reasoning documented inline).
2. **S33 chaos guard rejects the pi worker (W4.09-pi-kill-harness).**
   `GUARD_MISS: Process <pid> cwd/cmdline does not contain <repo>` — the
   US-006 identity guard verifies target provenance by cwd/cmdline
   substring, but the real pi worker process shape doesn't carry the repo
   path there (kernel-hidden env / wrapper shapes — see the macOS
   portability memory traps). Extend identity verification with an
   evidence chain that works for pi workers (pidfile-provenance / parent
   chain / open-fd evidence) WITHOUT weakening the guard (never kill a
   process that cannot be positively identified as tt-owned).
3. **S35 O9 oracle infra on detached-HEAD (W4.30-detached-head-origin).**
   The S31 fix lets the case launch and run; O9 now dies ORACLE_TEST_INFRA
   on the detached-HEAD evidence shape. Make O9's row/tree resolution
   consume the detached-HEAD snapshot contract US-009 defined (target_ref
   = commit OID, detached_head: true) end-to-end.
4. **S36 W4.33d premise still unfired in real runs.** The US-004 typed
   `move-branch` premise fires `event:run.failed` in the scripted corridor
   but the REAL run completed cleanly again (probe `resume` armed on
   `event:run.failed`, never fired). Diagnose from the real campaign
   evidence why the injected failure did not fail the real run (worker
   tolerance? reroute absorbed it?) and redesign the premise so a real
   run genuinely fails then resumes — this cell exists to prove
   resume-after-failure. Do not fake it: if the product genuinely cannot
   be made to fail this way, that is a FINDING for the landing report,
   and the scenario needs a different failure vector.
5. **S37 O8 checksum reconciliation (W4.48b-pause-rugpull-window).**
   `checksum_terminal bytes do not reconcile with git HEAD for
   src/server.ts` — the rugpull (target moved mid-run) leaves worktree
   bytes vs HEAD divergent at capture time. Determine whether the O8
   terminal-checksum contract must model the moved-target case (capture
   discipline) or whether the scenario's teardown must settle first;
   fail-closed either way.
6. **S32 battery hermeticity.** `tier2-chaos-block-extension.test.ts`
   seeds `var/home/.tamandua/tamandua.db` and fails on a pre-existing
   campaign-populated DB (`NOT NULL constraint failed:
   steps.input_template`). Make the test hermetic (own temp home/DB),
   never dependent on repo-root contained-home state.

## Prove
- S34: red-arm reproducing a sub-5s sweep race voiding a terminal-reached
  attempt -> green (not voided); genuinely-hung attempt still voided.
- S33: scripted red-arm with a pi-shaped process (no repo in cwd/cmdline)
  -> identity chain accepts tt-owned / refuses foreign.
- S35: detached-HEAD evidence fixture through O9 -> PASS shape; symbolic
  refs unchanged.
- S36: documented diagnosis + a scripted corridor where the redesigned
  premise makes the run genuinely fail and resume fires; or the FINDING
  documented with evidence if impossible.
- S37: documented contract decision + red-arm for the chosen design.
- S32: the test passes with a dirty repo-root contained-home DB present.
- Full battery green from repo root (with the S32 fix, on a dirty home);
  bare --tier2 GREEN x2; bare --tier1 GREEN.

## Hard constraints
- Files ONLY inside torture-test/. Zero real tokens (scripted proofs
  only; do NOT re-run the real cells — I re-run after landing). Live
  daemon (33xx) untouched. Do NOT modify campaign evidence/snapshots.
  Preserve fail-closed semantics; never weaken the kill-target identity
  guard or oracle seals.
