# S38-S44: final tier-2 suite batch — adjudication-sourced defects + the operator-seam class

Sources: four-lane adjudication of campaign-20260826T225744158Z (lane reports
summarized in bd memory tier2-adjudication-final) + the S32-37 landing's
US-003 finding. All scripted-provable, zero real tokens. Each item names its
evidence.

1. **S38 snapshot target-ref pinning.** W4.29's O2/O10 ORACLE_RUNTIME_ERRORs:
   refs-before recorded `target_ref: refs/heads/main` but refs-after and
   target-reflog keyed off the checked-out HEAD (`security-audit-2026-08-27`)
   because the worker left its branch checked out. Pin the target ref at
   before-capture and thread it through after/reflog captures
   (oracle-evidence-snapshot.mjs). Red-arm: work-branch-checked-out shape
   reproduces the divergence pre-fix, reconciles post-fix.
2. **S39 W4.29 chaos arming gap.** The delete-tstx-row corridor NEVER fired
   in W4.29's window (chaos.log last firings 23:02/23:19 for W4.01/W4.02
   trees) — the case's premise (evidence made missing under strict gate) was
   never armed, so the case tested nothing. Root-cause the controller arming
   (why the trigger tree/window missed) and fix so the corridor provably
   fires; unfired mandatory chaos must fail closed as TEST_INFRA (loud),
   never silently produce a vacuous verdict.
3. **S40 per-case boundary_files.** All 70 tier2 cases declare the identical
   boundary `fixtures-src/<fixture>/src`. Author per-case boundaries matching
   each task surface (security-audit needs public/; conftest-seeded scenarios
   need their seeded paths; keep them TIGHT — the point is catching genuine
   creep, so widen only where the task mandates it). Update tier2.jsonl +
   traceability; O8 semantics unchanged.
4. **S41 probe-sequence evidence graph.** W4.10-restart-recovery: the probe's
   second run (run-2621299f) is absent from the captured graph
   (workflow-status.json steps_snapshot null, tokens_observed 0,
   discovered_runs []), voiding O1/O2/O11 with mechanical artifacts while the
   product provably retained everything. Register probe-sequence sibling runs
   in the root/discovered graph and capture the root terminal snapshot for
   concurrent shapes; O2's one-transition ref-attribution model must accept
   the two-landing shape when both landings are attributed runs.
5. **S42 W4.17 arming hook.** The task/traceability promise a reset-hook
   arming overlay planting 2 pre-existing red tests; no such hook exists
   (cases/hooks/ has only W4.26/28/30/31) — both W4.17 arms are vacuous.
   Implement the arming hook; un-armed premise must fail closed as
   TEST_INFRA (a scenario whose mandated seed/arm is absent must refuse to
   produce a verdict).
6. **S43 O1 floor calibration + wave reporter.** (a) Refusal/fast-honest
   cells (W4.37, W4.38, W4.47 and any cell whose correct behavior is early
   termination) get `expected_fast_failure: true` or per-cell floors —
   production-median floors statistically flag ~half of honest runs
   (W4.08-control 13%-under with green content oracles). (b) Fix the wave
   reporter dedupe: the do-now family finding was stamped on two reporter
   cases (one not even do-now) — report exactly once from the true final
   wave case. (c) bfmw classification disagreement: state.json TIF
   (chaos-invocation-failed) vs report.txt RUNAWAY for the same run —
   one authoritative precedence, documented.
7. **S44 operator-seam execution class.** Four cells' premises include
   mid-run operator actions that no machinery performs, yielding vacuous or
   stalled runs: W4.10-kill-daemon + W4.48a (restart the killed contained
   daemon during the run — the S32-37 US-003 stall diagnosis), W4.33a
   (daemon restart during the pause hold), W4.33b (`update --force` during
   the hold), W4.47 (invalidate + restore $TT_HOME/.pi credentials around a
   relaunch). Wire these as first-class probe/chaos actions in the
   controller (restart_contained_daemon, update_contained_install,
   invalidate_credentials/restore_credentials) with per-action evidence
   records, fail-closed if the action cannot be performed. Containment
   absolutes: contained daemons/homes only; NEVER the operator's live
   daemon (33xx) or real ~/.pi / ~/.dsh.

## Prove
- Per item: scripted red-arm reproducing the campaign-evidence failure line
  or vacuity, then green post-fix. S44: scripted corridors where each new
  action provably fires and records evidence (contained-scripted daemons).
- Full battery green x2 from repo root with a dirty var/home DB present;
  bare --tier2 GREEN x2; bare --tier1 GREEN.
- Landing report: per-cell rerun map (which of W4.09-pi, W4.10-kill,
  W4.10-restart, W4.17-a, W4.17-b, W4.29, W4.30, W4.33a, W4.33b, W4.33d,
  W4.37, W4.47, W4.48a, W4.48b are now honestly re-runnable).

## Hard constraints
- Files ONLY inside torture-test/. Zero real tokens; do NOT re-run real
  campaign cases. Live daemon (33xx) and real operator credentials
  untouched — S44 actions operate exclusively on contained homes/daemons.
- Do NOT modify campaign evidence/snapshots. Preserve fail-closed
  semantics and oracle seals. TCMD/BRUN/RVOC/RCNT are PRODUCT findings
  awaiting igorhvr's triage — do NOT touch product code.
