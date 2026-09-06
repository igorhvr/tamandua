# RJSO: invocation-owned recorder emission-test cleanup

## Authority and scope

Beads tamandua-0j7.4.2.1, parent tamandua-0j7.4.2 (RJSON).
Igor authorized autonomous torture-suite corrections through Tamandua runs.
Use Linux dsh feature-dev-merge-worktree, native isolation enabled. This is
ONE bounded suite story, not a product TSCP/RCOB/TZPI/TIME fix and not a new
general process manager. Product runs 914/915 are not prerequisites.

Change only torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts,
one focused recording-only regression file, and narrowly necessary SUITE
test helpers/documentation. Do not change product src/, tests/, workflows,
personas, dependencies, host configuration, or recorder discovery/escaping
and emitted-data semantics. Do not borrow unlanded product-run changes.

The merged portable JSON escaping helper already passed independent checks
on Linux and actual Mac Bash 3.2. Preserve it; no escaping rewrite is needed.
The remaining issue concerns process ownership in the new emission test.

## Actual finding, not a historical kill claim

Source SHA256 of the reviewed emission test:
9006d442f0dfa2ada838316cd9f9887dc8a71f7accaa1c66b452408c0031e637.
Retained coordinator evidence:
/home/igorhvr/idm/tamandua/torture-test/var/review-logs/recorder-acceptance.7pn8r6/recording-proof.mjs
/home/igorhvr/idm/tamandua/torture-test/var/review-logs/recorder-acceptance.7pn8r6/recording-evidence.json

At 2026-09-06T15:26:40.195Z the ACTUAL stopOwnedChild and recorder-finally
code was extracted and evaluated with ALL process/filesystem/wait operations
replaced by recording bindings. It selected unrelated synthetic recorder
identities and permitted escalation using liveness without fresh birth
identity. No real signal, removal, or host scan happened inside that proof.
This is unsafe decision evidence, not an observed historical PID-reuse kill.

stopOwnedChild currently keeps PID/argv but no captured start identity;
fixed markers recur across invocations. It checks command text once before
TERM and liveness only before KILL. The recorder finally block re-reads a
pidfile and accepts any command containing tt-recorder. That is not proof
that the target is the process this invocation started. Inspect normal stop,
startup-error and finally paths too; a guarded finally must not leave an
unguarded normal stop or failed-start cleanup as a bypass.

## US-001 — exact invocation ownership with one recording gate

Keep actual owned process handles and launch-time identity evidence for
every persistence child and fixture recorder. Bind recorder identity to this
invocation's exact fresh fixture and launch; a mutable pidfile, generic name,
shared marker, liveness, or prefix match alone is insufficient. Before EACH
signal, including escalation, revalidate current identity. Unknown, changed,
stale, foreign, and invalid evidence must refuse the signal. Account for
startup failure and processes that exit before identity capture; do not
blindly trust an old PID merely because a child handle once contained it.

Keep a viable positive path for genuinely owned survivors. Do not merely
disable cleanup or replace behavior assertions with static checks. Keep the
change test-local. If a safe normal recorder start/stop path requires broader
runtime redesign, report that boundary instead of silently expanding scope.
A small fixture-local adapter may expose the existing code to ownership
bindings; no host PATH shim, dotfile, permission-profile or product change.

ONE designated in-run gate: a focused recording-only regression executing
the ACTUAL current test cleanup/ownership code with unconditional recorded
process, filesystem, wait and signal dependencies. Do not test a duplicated
expected predicate. Cover owned-positive cleanup, other invocation with the
same names, exact path boundaries, stale/changed/unreadable identity,
identity lost between TERM and KILL, stale/foreign pidfile, startup failure,
and normal-stop/error/finally decision paths. Include proof that attempts to
escape the recording boundary fail before any real operation.

Commit before validation. Record source/tree/function hashes, case outcomes,
actual command exit and complete retained output. Report limits honestly;
recorded successful cleanup is not proof a real child was collected.

## Independent execution boundary

Do NOT run the full existing emission test, a torture battery, actual
recorder process collection, or a real child/signal experiment in this run
before the coordinator independently accepts the committed recording proof.
Spawning an isolated interpreter for the recording-only gate is allowed;
the tested cleanup operations must remain entirely recorded.

After that proof, the coordinator owns real Linux emission acceptance and
actual Mac applicable checks. Preserve every existing exact JSONL, multiline
cwd/argv, PID/parent/group, DB size and absent-WAL assertion. Keep the output
file/start/stop coverage; no new skips, weaker parsing, changed test walls,
or silently removed coverage. Existing Linux-only discovery skips on Mac
must be reported as NOT RUN, not Mac emission success. Portable escaping
still executes on both hosts. Keep fresh fixture scope and owned-survivor
cleanup. Preserve evidence whenever cleanup ownership is uncertain.

## Operational rules

- Normal isolated build/npm is required, separate from the one focused gate.
  Keep TEST_CMD exactly npm test. Full npm requires at least 30 minutes plus
  time queued behind other gates; do not kill a legitimate lock holder.
- Full npm, MCP/get-ready and fast e2e use the existing shared flock:
  /home/igorhvr/idm/tamandua/torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/linux-npm.lock
  Wrap the normal tamandua-test command; never recreate/unlink the lock.
  Commit first, freeze the tree while queued/running, retain full output and
  capture the actual tested command's exit, not a tail/tee/echo status.
- Live step reporting uses /home/igorhvr/idm/tamandua/bin/tamandua. Worktree
  binaries operate only on private test HOME/state/DB with random ports and
  guards enabled. Keep native isolation on; do not bypass signal denials.
- Use existing TAMANDUA_HERMES_BINARY=/usr/bin/false for isolated npm only.
  HTPN and NHFG remain separate product decisions. Inspect all negative TAP
  records as well as exit status; do not claim a failed hook passed.
- No ad-hoc deletion, fixed-path pre-cleaning, broad/name/pattern kills,
  worktree removal/pruning, git discard/reset, or evidence destruction.
  Allocate fresh owned scratch and retain it. Only the exact securely-created
  transport report after accepted submission may follow normal persona cleanup.
- No live build/install/restart, remote sync/push, paid real e2e, campaigns,
  credentials or host git/hook/config changes. Preserve progress history.
- Current live verifier requires standalone STATUS: done or STATUS: retry
  with simple VERIFIED: / ISSUES: fields. No annotated STATUS or hyphenated
  keys. Use normal claimed-step protocol; no manual DB/retry-budget repairs.

Local merge is implementation only. The Beads issue stays open until the
independent negative proof and unchanged positive behavior are accepted.
