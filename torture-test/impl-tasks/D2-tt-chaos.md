# Implement `torture-test/bin/tt-chaos` (fault-injection operator)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/12-runner-automation.md`
  (§tt-chaos — target guards, phase_wait, evidence-capture integration)
- `torture-test/tamandua-torture-test-spec/08-wave-4-fault-injection.md`
  (§Injection discipline — event-triggered arming, exclusive windows,
  INVALID on wrong-phase fire; and the scenario tables that name the
  injection primitives needed)
- `torture-test/tamandua-torture-test-spec/11-schedule-budget-abort.md`
  (§Evidence capture before destruction — the mandatory pre-fire
  snapshot protocol)
- Existing conventions: `torture-test/bin/*` tools, `torture-test/env/*`.

## Deliverables

1. `torture-test/bin/tt-chaos` (node, no build step, no new deps) —
   executes one injection action per invocation:
   `tt-chaos <action> --run <run-id> [action args] --when <phase-marker> [--timeout <s>]`
   Actions (the primitives the W3/W4/W5 scenario tables need):
   - `kill-harness` (SIGKILL/SIGTERM/SIGSTOP/SIGCONT the run's active
     harness process), `kill-daemon` (the TT daemon — via provenance,
     never the production one), `colleague-commit --repo <fixture-clone>
     --file <f> [--line <sentinel>]` (plain git from a second clone),
     `pause|resume|cancel|stop` (via the tamandua CLI under the TT spawn
     env), `delete-tstx-row --tree <hash>` (sqlite against the TT DB),
     `write-context --key k --value v` (the W4.04a mechanical arm),
     `dirty-tree --repo <path>` (the PARK bait), `move-branch --repo
     <bare> --ref <r>` (rugpull pressure).
   - **phase_wait**: `--when` takes a marker expression polled from the
     TT DB / events (step-state transitions like `step:<role>:running`,
     event rows like `event:merge.parked`, or `file:<path>` appearance).
     A bare `--when now` is allowed but logged as timed-not-triggered.
     Timeout without the marker => exit with TRIGGER_NEVER_MATERIALIZED
     (the scenario becomes NOT_RUN, never a blind fire).
   - **Target guards**: immediately before firing, re-verify the target
     (run id exists and is non-terminal where relevant; pid provenance
     via cwd/cmdline under torture-test/var; repo path under
     torture-test/var). Guard miss => abort with GUARD_MISS, exit
     nonzero, fire nothing.
   - **Evidence capture before destruction**: for destructive actions,
     automatically snapshot per spec 11 (run+steps+events tail from the
     TT DB, target process tree, worktree git status + HEAD, daemon log
     tail) into `torture-test/var/chaos/<ts>-<action>/` BEFORE firing.
   - Every invocation appends a structured line (ts, action, target
     evidence, phase marker satisfied, outcome) to
     `torture-test/var/chaos/chaos.log`.
2. `torture-test/bin/tt-chaos.test.sh` — self-test with NO tamandua
   daemon: exercise phase_wait on a `file:` marker; GUARD_MISS on a
   decoy process outside torture-test/var; TRIGGER_NEVER_MATERIALIZED on
   a marker that never appears; colleague-commit + dirty-tree +
   move-branch against a throwaway fixture repo under var/ with the
   pre-fire snapshot verified present; chaos.log entries valid JSON.

## Hard constraints

- Files ONLY inside `torture-test/`; state ONLY under `torture-test/var/`.
- ABSOLUTE refusal to signal/mutate anything tied to production (real
  ~/.tamandua, ports 33xx, processes without torture-test/var
  provenance) — by construction, checked before every fire.
- DB access read-only EXCEPT the explicitly-named mutating actions
  (delete-tstx-row, write-context), which target only the TT DB under
  torture-test/var and refuse any other path.

## Acceptance

- Self-test passes twice consecutively; chaos.log parses; a GUARD_MISS
  and a TRIGGER_NEVER_MATERIALIZED case each leave zero side effects.
