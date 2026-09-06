# VSRP + DRVP: authorized narrow verifier and drain corrections

## Authority and scope, 2026-09-06 UTC

Igor explicitly approved option A for VSRP (tamandua-6sy.28) and DRVP
(tamandua-6sy.26). Implement through this Linux dsh worktree workflow.
The two fixes share step-ops.ts, so use one bounded run. This is NOT authority
for RCOB cleanup changes, a general lifecycle reconciler, new retry policy,
schema changes, timezone changes, or an output-format redesign.

Read the actual source and Beads records. Historical observations below are
evidence, not instructions to operate on those runs or PIDs.

## US-001 — Independent strict single-line verifier verdict

Actual incident: the KHYG verifier at 2026-09-06 02:25 UTC emitted a valid
standalone STATUS: retry followed by VERIFIED-OK: and ISSUES (explanation):
headings. The generic multiline key parser appended those unrecognized headings
to status. The expects regex accepted the standalone retry marker, but
handleVerifyEachCompletion treated anything other than exact retry as approval.
US-004 remained done with retry count zero and US-005 was dispatched despite
four real findings. The original report is retained at:
/home/igorhvr/idm/tamandua/torture-test/var/review-logs/native-signal-probes.DHNQbp/verifier-verdict-VSxS3j/raw-output.txt
Adjacent result.json and actual-compiled-parser.js document a faithful pure
parser reproduction. READ these files; never mutate that evidence or live DB.

Treat verifier STATUS as an independent single-line control field. Validation
and routing must agree on an unambiguous done or retry. Missing, invalid, or
conflicting verdicts must reject completion through existing bounded handling,
never silently approve a story. Preserve findings and ordinary multiline report
fields, valid done progression, valid retry semantics and current retry budgets.
Keep the correction scoped to verifier verdict handling, not generic report keys
or unrelated status contracts. No broad parser rewrite.

Designated gate: focused verifier verdict regression file(s) including the exact
retained report, valid done/retry with unusual following headings, missing,
invalid and conflicting verdicts, and unchanged multiline fields. Include an
actual isolated scripted workflow regression proving retry/no false story.verified
or next-story advance; a pure parser test alone is insufficient. Fixtures must
exercise the built product, not a reimplementation of the desired predicate.

## US-002 — Finish the observed final-verifier drain path

Actual R4a incident on 2026-09-05: drain requested 07:00:55Z, final story verified
07:01:37Z, finishing harness exited 07:01:43Z, but at 07:05Z the run was still
running/draining_pause with zero running steps and a downstream test step pending.
No new work was dispatched. Successful final verify-each completion returns via
checkLoopContinuation/advancePipeline without the missing finalization call.
Recording-only actual routing evidence is retained under:
/home/igorhvr/idm/tamandua/torture-test/var/review-logs/drain-verify-pause.wdEWpm/

Narrowly repair that successful final-verify + downstream-pending-step path using
existing lifecycle mechanisms. Preserve finishing-worker output-flush grace,
no-new-dispatch behavior, idempotent state/event finalization, and the existing
resume-cancels-drain semantics. Never overwrite completed/failed/canceled terminal
outcomes with paused. Do not naively add an unconditional finalizer after any
terminal transition. Igor explicitly approved this path knowing that existing
pause finalization schedules the unchanged RCOB sweep. That disclosure does NOT
authorize changing or broadening cleanup selection, manual kills, or live DB edits.

Designated gate: focused isolated scripted drain regression through the actual
scheduler/harness/step pipeline. Assert run and scheduling status paused,
run.paused emission, retained final verification report, no downstream launch,
finishing-output grace and normal resume. Include non-draining, still-in-flight,
resume-cancels-drain and terminal-state controls. Do not replace actual lifecycle
proof with only a callback spy.

## US-003 — Combined fast motor gate

On the committed combined worktree run ./run-all-e2e-tests, smoke and scripted
only, under the shared lock below. This is the one designated gate for this
story, not a repeated torture ladder. No paid canary/full real e2e here.
Normal workflow npm validation still applies separately.

## Operational boundaries for every worker

- Use this run's worktree for all source, builds and isolated test binaries.
  Step claim/complete/fail must use the scheduling installation's launcher:
  /home/igorhvr/idm/tamandua/bin/tamandua. Do not build/install/update/restart
  the origin/live installation, change catalog or host dotfiles, run campaigns,
  access other runs, or push a remote. Local workflow merge only.
- Keep native signal isolation enabled. It does not protect files. No broad
  kill/name/pattern commands, ad-hoc recursive removal, fixed-path pre-cleaning,
  forced worktree deletion/pruning, or reset/checkout discard. Retain evidence.
  Existing test cleanup is permitted only for exact invocation-owned fixtures.
- Tests use isolated HOME/state/database, random ports and isolation guards.
  Never repair a test by disabling the guard, skipping an assertion or weakening
  a deadline. Classify spawn-capable tests in tests/serial-files.txt as required.
- Full npm, focused MCP/get-ready and fast e2e gates acquire this SAME flock
  around the normal tamandua-test gate; never unlink/recreate this lock:
  /home/igorhvr/idm/tamandua/torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/linux-npm.lock
- Commit before ledger gates, keep the tree unchanged during queue/execution,
  retain distinct logs and capture actual command exit and all negative TAP
  records, not just a final summary. Zero unexpected isolation violations.
  Allow at least 30 minutes command budget for full npm, without shortening
  assertions. The established TEST_CMD field remains exactly npm test.
- Existing fake PI/DSH test environment isolation is not permission to launch
  real Hermes. Until separately approved HTPN is fixed, pass the existing
  TAMANDUA_HERMES_BINARY=/usr/bin/false workaround to test gates. Do not alter
  product runtime or TEST_CMD for that unrelated issue.
- For this currently unpatched scheduling runtime, report a literal standalone
  STATUS: done/retry followed by ordinary ISSUES: / VERIFIED: keys. Never use
  VERIFIED-OK: or annotated ISSUES headings as a workaround for a failing result.
  Do not falsify a verdict, mutate live rows/counters, or erase failed attempts.
- Update relevant docs only if needed for these approved semantics. No other
  product findings are authorized. Coordinator owns independent both-host
  acceptance and installation/release decisions; merge is not certification.

Test command: npm test
