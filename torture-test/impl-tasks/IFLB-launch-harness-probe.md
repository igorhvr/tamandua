# IFLB: launch-time harness probe — fail a run fast and legibly when its harness cannot work

## Context

Mac torture campaign #1 (2026-09-03) exposed five runs whose harness could not work from the start: pi exiting in
~300 ms with "No API key found for the selected model" after the scenario invalidated the copied credentials
(W4.47), and dsh exiting in 100–500 ms with a boot error under the contained daemon (four W4.dsh-* cells). In every
case the scheduler classified three consecutive instant-fail rounds, logged "Instant-fail loop detected — backing
off relaunch" (RSPN, K=3) and then never launched another round; the run stayed `running` with its first step
`pending`, no event carried the harness error, and only the torture controller's wall cap ended the run (10 to 138
minutes later). The RSPN escalation at N=10 (`run.instant_fail_loop` + force-fail) was never reached.

Decision (igorhvr, 2026-09-03): add a launch-time harness probe that exercises a real tool call and fails the run
immediately and legibly when it does not pass. Spending one tiny model turn per run on this is accepted. The
mid-run behavior of RSPN (backoff after the third instant failure with no relaunch, "IFLB-mid") is explicitly
LEFT AS IS by this task — documented as known-open, not changed here.

## Stories

### US-001 — Probe primitive (product)
- At a run's FIRST dispatch, before the first real round of its first step, spawn the run's harness (pi / hermes /
  dsh — whichever the run was launched with) with a probe prompt whose first line is the stable marker
  `TAMANDUA_HARNESS_PROBE: skill-path` followed by: "Run the exact command `<launcher> skill-path` and reply with
  the PATH and nothing else." `<launcher>` is the same absolute CLI launcher path the step prompts already use
  (see src/installer/paths.ts), never a bare `tamandua` that depends on the agent shell's PATH.
- The daemon computes the expected value by executing the same command itself (child process, same environment
  the harness receives). The probe passes when the harness's final message, after trimming whitespace and stripping
  code fences/backticks, contains the expected path as a whole line or token. Anything else fails.
- Bounded wall: default 180 s, overridable with `TAMANDUA_HARNESS_PROBE_WALL_MS`; exceeding it is a failure.
- Exactly ONE probe per run (not per step or agent); persist the result on the run (e.g. `harness_probe` status +
  timestamp) so a daemon restart does not re-probe a run that already passed.
- The probe's tokens are attributed to the run through the existing per-round attribution path and appear in
  `workflow status`; no double counting.

### US-002 — Failure and success surfacing (product)
- On failure, fail the run immediately through the existing force-fail path with a mechanical keyline block (one
  key per line, no prose after the last multi-line key — see the GDIA note on refusal blocks):
  `FAILURE_CLASS: harness_unavailable`, `HARNESS: <pi|hermes|dsh>`, `PROBE_CMD: ...`, `EXPECTED: ...`,
  `OBSERVED: <final message, at most 400 chars>`, `EXIT_CODE`, `SIGNAL`, `DURATION_MS`, and last
  `STDERR_TAIL: <at most 2000 chars>`. Emit `run.harness_probe_failed` with the same fields. No workflow step is
  claimed or started; `workflow run --wait` and `workflow status` show the reason verbatim.
- On success emit `run.harness_probe_ok` (harness, duration, tokens) and proceed to normal dispatch.

### US-003 — Operator switch and docs (product)
- `TAMANDUA_HARNESS_PROBE=0` disables the probe (documented escape hatch; default on).
- Operator docs: what the probe does, its cost (one tiny model turn per run), the keyline block, the switch, and a
  note in the RSPN/instant-fail section that a harness breaking MID-run is still handled by the existing backoff
  whose relaunch behavior is known-open (IFLB-mid) and unchanged by this change.

### US-004 — Scripted harness support (torture-test)
- The torture-test scripted tiers drive fake harnesses from `behaviors.json` canned invocations
  (torture-test/scenarios/lib, scenario-workflow-parity.mjs). Teach the scripted harness runner to recognize the
  probe marker line, execute the command for real and reply with the path, WITHOUT consuming a canned invocation
  index, so existing behaviors.json files and the parity self-test need no change. Add a self-test for the
  recognition and the no-index-consumption rule.
- Re-run `./run-torture-test --tier0` on the finished tree: expect the same result as at main 0b7277c0 — every cell
  PASS except `w4.35-retry-rebased-true-green` (VEDL product deadlock, documented, unchanged here); S56 port
  collisions are infra. Any other red is a regression to fix in this task.

### US-005 — Tests (product)
- Unit tests: probe pass; wrong output; non-zero exit; wall exceeded; disabled by the switch; once-per-run
  persistence across a simulated restart; keyline block shape (every key present, STDERR_TAIL last).
- Fast e2e: a run launched with a harness PATH shim that exits 1 fails within seconds with
  `FAILURE_CLASS: harness_unavailable`, zero steps started, `run.harness_probe_failed` present; a run with a working
  shim proceeds and `run.harness_probe_ok` precedes the first `step.running`.
- Existing instant-fail (RSPN) tests unchanged and green.

## Boundaries
- Do NOT change RSPN backoff/escalation logic (IFLB-mid is deliberately left as is).
- No changes to torture-test oracles, cases or pins beyond US-004's scripted-harness support and self-test.
- `npm test` green (both lanes, empty test-guard ledger); tier-0 as specified in US-004.
- No new runtime dependencies.

Test command: npm test
