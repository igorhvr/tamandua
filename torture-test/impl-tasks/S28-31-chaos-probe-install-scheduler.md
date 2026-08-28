# S28-S31: four scenario-infra defect classes that voided 12 tier-2 real cells

Tier-2 attempt-2 (campaign-20260826T225744158Z-4bf26d7f, report.txt has
the per-case reason lines) left 12 real cells TEST_INFRA_FAIL before
their oracles could judge anything. Fix all four classes; each is
scripted-reproducible (zero real tokens).

1. **S28 chaos-invocation-failed (5 cells).** W4.09-pi-kill-harness,
   W4.09-hermes-kill-harness, W4.10-kill-daemon: `tt-chaos exited null`
   (died by signal — diagnose from the chaos.log / controller stderr in
   the campaign evidence); W4.48a-daemon-kill-mid-park: exit 3;
   W4.48c-compound-gate-degradation: exit 1. Root-cause each exit path
   in bin/tt-chaos and its controller invocation (argument contract?
   environment? target resolution against the contained real daemon?)
   and fix fail-closed: a chaos op that cannot run must say precisely
   why in one line.
2. **S29 probe-trigger-unreached (4 cells).** W4.10-restart-recovery
   armed `restart_daemon` on `step:developer:running`; W4.33a
   `pause_drain` and W4.33b `pause` on the same trigger; W4.33d
   `resume` on `event:run.failed`; W4.48b `pause` on
   `event:merge.target_moved`. Each waited 4-8 min and never fired while
   the run went terminal. Verify the trigger vocabulary against the
   ACTUAL event stream captured in the campaign's snapshots (run-events
   evidence): wrong event names / step ids are manifest-or-controller
   calibration; if the stream genuinely lacks the event, the scenario
   premise needs redesign — document which, per cell. Add a fail-closed
   preflight: arming a trigger whose event/step name is not in the
   known vocabulary is an immediate scenario error, not an 8-minute
   silent wait.
3. **S30 workflow-spec-missing (1 cell).** W4.14-verdict-trap: `No
   workflow.yml found in .../var/home/.tamandua/workflows/
   tt-verdict-trap`. The REAL contained home's catalog install covers
   the bundled catalog but not torture-specific workflows this cell
   needs. Fix the real-cell install path the same way T2.2 US-005 fixed
   the scripted side (reset -> install FULL required set -> start);
   fail closed at preflight if a case's declared workflow is absent.
4. **S31 scheduler-execution-failed (1 cell).** W4.30-detached-head-
   origin: "fixture repository has no symbolic target ref". The
   scenario's PREMISE is a detached-HEAD origin; the controller's
   scheduler must resolve the target ref per the case's declared
   contract instead of assuming a symbolic ref. Honor the scenario:
   fix target-ref resolution (or the fixture provisioning contract) so
   the case can run; do not delete or weaken the scenario.

## Prove
- Per class: scripted red-arm reproducing the exact failure line from
  the campaign report, then green after fix (S28: each exit path; S29:
  unknown-trigger fail-closed + a fired-trigger scripted corridor; S30:
  missing-workflow preflight refusal + successful install corridor;
  S31: detached-head fixture scheduled and launched in a scripted
  cell).
- Full self-test battery green from repo root; bare --tier2 GREEN x2;
  bare --tier1 GREEN.
- Landing report: per-cell disposition table (fixed-by / needs-rerun)
  for the 12 voided cells.

## Hard constraints
- Files ONLY inside torture-test/. Zero real tokens. Live daemon
  (33xx) untouched. Do NOT modify campaign evidence/snapshots. Do NOT
  re-run real campaign cases. Preserve fail-closed semantics
  everywhere; W4.dsh-bfmw's RUNAWAY is adjudication material, NOT in
  scope.
