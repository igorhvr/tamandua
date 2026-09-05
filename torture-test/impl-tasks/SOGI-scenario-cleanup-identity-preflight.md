# SOGI: bounded scenario-cleanup identity preflight

## Authority and launch boundary

Beads `tamandua-6sy.5.1` is the durable task and acceptance record. This is
an authorized SUITE correction, not a product decision or an extra R4a story.
Use a normal Linux dsh `feature-dev-merge-worktree` run when the coordinator
explicitly launches it. Preparing this task does not launch that run or resume
RISO, RJSON, or STORM-I, which remain separately held for safety.

This preflight may precede full R4a scenario acceptance; do not wait for R4b
to finish in a way that creates a circular dependency. R4b's signed task
records the prerequisite, but does not duplicate this implementation. The
coordinator will select a clean source pin and verify integration prerequisites
before launch. Do not infer authority to operate a live campaign from this file.

## Actual finding and evidence boundary

`stop_owned_command` in `torture-test/scenarios/lib/run-scripted-scenario`
accepts an empty current start identity as permission to signal the saved
process group. The actual function was extracted and run with recording
substitutes for identity reads, kill, wait, and sleep. Same-identity cleanup
and changed-identity refusal are correct controls; unreadable identity still
permits TERM and KILL. The result was reproduced on Linux and actual macOS
system Bash 3.2. No real process query or signal ran inside those probes.

Retained source/driver/results are under the origin checkout's
`torture-test/var/review-logs/scenario-group-identity-E2Ihak/`, including
`unknown-identity-{driver.txt,evidence.jsonl}` and
`mac-unknown-identity-{driver.txt,evidence.jsonl}`. Reviewed source SHA256:
`75f8f0884916b35b07fa45f0a7c6941f48dc14ab1fbb2cdf97b9c1d5a1a3c569`;
actual extracted-function SHA256:
`44ac75eb0893096ea1fc1ba5ecaa3d83dcc076616c988e12c55f4a1af79c258d`.
Read the source at the actual launch pin; these hashes identify the evidence,
not an instruction to hardcode a historical revision into the implementation.

The outer harness waits for a Node wrapper whose detached child has already
exited before the wrapper exits. Do not assume the original group leader is
still an unreaped direct child that pins the group identity at cleanup time.
This is a demonstrated unsafe signal decision under unknown identity, NOT a
demonstrated historical unrelated kill or an exercised real PID-reuse incident.

## Scope and operating rules

- Changes belong to the existing suite-owned scenario harness/launcher and
  focused regression coverage under `torture-test/`, with supporting suite
  documentation only where needed. No product files, dependencies, personas,
  harness/model permission profiles, command shims, or KHYG workaround.
- Preserve cleanup of genuinely owned survivors, command exit/status behavior,
  interrupted/unreleased command handling, and macOS Bash 3.2 compatibility.
  Simply abandoning cleanup or weakening assertions is not a fix.
- Before every group signal, including a later escalation, require current
  evidence that authorizes that exact target. Unknown or changed identity is
  not ownership. Keep a viable way to clean owned survivors after fast exits;
  a stale saved group ID alone cannot supply that proof.
- No real child/group experiment, live daemon lifecycle operation, fault
  campaign, original w4.35 fossil modification, or paid e2e in this run.
  The coordinator must first independently review committed recording proof.
- Do not source the entire unreviewed scenario runner or exercise a dangerous
  branch against host processes. The designated gate must run actual decision
  code with recording bindings, not a copied expected predicate. Ensure the
  recording path cannot escape into real signal/process/filesystem operations.
- Allocate fresh owned diagnostic locations and retain them. No fixed scratch
  overwrites, ad-hoc scratch removal, broad deletion, worktree removal/pruning,
  reset/checkout discard, or pattern/name-based signals. Removing only the exact
  securely-created transport report AFTER accepted submission remains the
  normal persona protocol; it does not authorize deleting diagnostic evidence.
- Normal isolated build/npm validation still applies. Use the coordinator's
  exact current shared lock from Beads/progress; commit before the gate, keep
  the tree unchanged while queued/running, retain distinct attempt logs, and
  capture the tested command's actual exit rather than a tail/tee/echo status.
- No origin push, live build/install/restart, remote sync, or git/hook/config
  changes. Preserve user work and all canonical progress history.

## US-001: identity-safe owned cleanup with one recording-only gate

Correct the suite's cleanup decision and any necessary existing launcher
bookkeeping so unknown/reused identity never authorizes a group signal while
owned-survivor cleanup remains achievable. Keep the implementation bounded;
do not introduce a new supervisor, general host process manager, or product
policy to solve this suite-local lifecycle problem.

The focused regression must exercise the actual helper/launcher decision
code with recorded operations. Cover known-owned positive cleanup; unreadable
and changed identity refusal; identity loss between TERM and KILL; early
command exit with owned descendants; and interruption/unreleased-command
branches. A skipped signal under uncertainty must not be presented as proof
that survivors were actually cleaned. Assert both the negative decision and
the viable positive path in the simulated lifecycle.

Designated gate: ONE focused recording-only regression file. Record exact
command, source/tree and function hashes, real exit, case outcomes, and retained
output. Ordinary build/npm is separate normal validation, not an extra torture
ladder. No regular battery, heavy/controller/oracle ladder, or actual scenario
execution in this preflight run. Verifiers use the same focused gate and
explicit source-backed findings; they do not widen it into a broad battery.

## Independent acceptance still owed

After the implementation is committed, the coordinator independently repeats
and reviews the recording proof before allowing actual child/group tests.
The existing assertions in
`torture-test/self-tests/scripted-scenario-harness.test.ts` for success/failure
survivors, fast exit, portable leader/status, and interrupt behavior remain
required on Linux AND actual macOS. Do not remove, weaken, skip, or replace
those assertions with static checks. Full combined scenario acceptance and
the untouched w4.35 route remain later coordinator-owned gates.

Report the exact committed scope, focused proof, normal validation, and every
still-unexecuted gate honestly. Local merge is an implementation milestone,
not acceptance or release permission. This Beads issue remains open until
both negative safety proof and positive actual-child compatibility are reviewed.
