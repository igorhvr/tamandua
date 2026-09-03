# R4a: suite batch — S45-S49 (tier-2 adjudication residue) + S51/S52 (guards) + S54-S57 (defects found 2026-09-02)

Suite fix batch (torture-test/ only). Sources: bd memories tier2-campaign-final-state, tier1-suite-defect-backlog,
suite-defects-didn-dres-2026-09-02, triage-decisions-2026-09-01 (item 6: W4.33d/48b split). Launch AFTER S58 lands
(shared contained ports: never run two tier ladders concurrently on this host). One gate per story.

## Items
- S45: W4.29 / W4.33a probe-action `resume` exits 1 (probe-sequence actions must return the daemon-reported status,
  not the CLI's transport exit); `update_contained_install` escape-refusal calibration (W4.33b) — the seam action must
  distinguish "refused because it would escape containment" (expected, PASS) from "failed".
- S46: O9_LEDGER_TREE_UNRESOLVED (W4.09-pi / W4.10-restart / W4.17-b): reconcile O9's tree resolution with the S38
  target-ref pinning (resolve ledger trees against the pinned target ref, not the moving branch).
- S47: O10 refusal-corridor finalize-step model (W4.30 'must have exactly one finalize_merge step'): a refused/rerouted
  finalize legitimately produces >1 finalize attempts; model attempts vs steps.
- S48: O8 marker regex docstring false positive (W4.17-a 'skipped 07-31' hit \bskip(?:ped)?\b): apply markers only to
  test-definition/decorator contexts, never prose/docstrings/comments; keep the seeded-test leg.
- S49: W4.33d / W4.48b split per igorhvr: (a) absorption-assertion cells that pin the product's graceful absorption
  (reroute/PARK absorbs the injected fault — red on regression); (b) directly-constructed-state cells (CLI force-fail
  then resume; move-target-during-hold seam action) that exercise the failure vectors without relying on a race.
- S51: vacuity/explicit-tier fail-closed — explicit `--tierN` enforces the tier's declared capability profile (or
  refuses, exit 2) unless `--allow-partial`; GREEN requires executed == expected-executable under the host profile
  (INCONCLUSIVE + names otherwise); `run-torture-test` refuses when the host profile RESULT is FAIL; the verdict line
  prints executed/expected. On darwin this must make the current 1/35, 4/28, 1/70 'greens' INCONCLUSIVE by name.
- S52: O8 gaps — focus markers (test.only / fit / fdescribe / it.only), same-name test shadowing (duplicate definition
  in a test file), new conftest.py / jest.config* / setupTests* files treated as seeded-test-adjacent (inspect, do not
  auto-allow); keep the additive carve-out otherwise.
- S54: daemon-control `verify_process_tt_owned` must not require the literal 'tamandua' in the cmdline: accept a
  daemon whose script path is `<TT_REPO_ROOT>/dist/server/daemon.js` (or the recorded start identity) regardless of
  the checkout's directory name; launch failures classify as TEST_INFRA_FAIL, never PRODUCT_FAIL.
- S55: contained daemons must run the WORKTREE/checkout dist: launch scripts invoke `$TT_REPO_ROOT/bin/tamandua` by
  absolute path (never PATH lookup), assert dist/version parity between the launching CLI and the daemon's
  /control/health buildVersion, and record which dist ran in the campaign evidence (lifecycle callerArgv already
  shows it — surface it in state.json/report).
- S56: scripted daemon stop must wait for listeners (5334/5338/5339) AND the dashboard/mcp/control-plane children to
  exit before returning; start waits bounded (configurable, default ≥ 30s) for port release; 'ports still in use'
  classifies as infra with the holder pid/cmdline in the reason.
- S57: golden validity includes a fixtures-src content hash in the .hashes ledger; drift ⇒ invalid (rebuilt under
  --rebuild-invalid, fail closed otherwise, naming the drifted fixture).
- S59 (O10 refusal-diagnosis model): O10_REFUSAL_DIAGNOSIS fires on correct strict-ledger refusals on both machines
  (W4.17-b: the red change never landed, FAILURE_CLASS refused_permanent). Two sub-causes, both in the oracle's
  "exact mechanical self-diagnosis" model in oracles/lib/o10.mjs: (1) red-evidence branch (mac): the gate appends its
  remediation sentence after the LOG_TAIL keyline (the last, multi-line key), so the parsed LOG_TAIL value = ledger
  row log_tail + trailing advice and the exact compare fails — terminate LOG_TAIL at the gate's trailing advice (or
  prefix-compare against the row's log_tail); (2) missing-evidence branch (linux): the worker produced no ledger row
  for the declared command (ran plain `pytest`, rows exit 127 then 1), the gate refused citing the NEAREST evidence
  row (WORKSPACE_STATE / NEAREST_EVIDENCE / ACTION keylines, LEDGER_EVIDENCE: red, that row's CMD_HASH/TEST_CMD) while
  the oracle expected the declared command's hash and LEDGER_EVIDENCE: missing — model the gate's two branches
  (evidence red vs missing-with-nearest) and compare each key against the row the gate actually cites (LEDGER_ROW_ID).
  Keep the oracle strict: refusal text must still be gate-generated keylines, never agent prose. Product-side format
  nit (GDIA, not in scope here): the red branch emits prose after LOG_TAIL while the missing branch uses an ACTION
  keyline — report only.
- S60 (O8 formatter-realignment false positive): W4.06-colleague-rebase on the mac scored O8_SEEDED_TEST_CHANGED on
  pool_test.go (+88/-4/4 modified) but the four "modified" lines are gofmt column realignment of a struct's field
  alignment (`git diff -w` shows +84 additive only). O8's additive/modified classification must ignore whitespace-only
  line changes (formatter realignment: gofmt, prettier, black) — classify modified/deleted on a whitespace-insensitive
  compare (and keep the byte-level pin only where a case declares it, e.g. the W4.17 red tests, where a whitespace-only
  change is still reported as informational, never as FAIL). Add a fixture-backed self-test with a gofmt-realigned
  seeded test (additive feature test + realigned struct) expecting O8 PASS with O8_SEEDED_TEST_EXTENDED.
- S61 (probe compensation on case termination): W4.47 on the mac was canceled at its wall cap before its
  `restore_credentials` action fired, leaving the contained `$TT_HOME/.pi` copy invalidated for every later pi cell in
  the campaign. Any probe op with a compensating counterpart (invalidate_credentials → restore_credentials, and any
  future pair) must have its compensation executed by the controller when the case terminates for any reason
  (deadline, cap, infra abort, controller shutdown) if the compensation has not run — recorded in probe-evidence as a
  `compensation` entry with its own exit code. Self-test: cancel a case mid-sequence and assert the backup is consumed.
- S62 (W4.47 trigger and cap calibration): `restore_credentials` armed on `event:step.running` can never fire under an
  instant-fail loop (the product emits no step.running for rounds that exit before claiming), so the cell is
  unpassable as designed. Re-arm the restore on a signal that exists (a daemon-log trigger on the instant-fail
  classification for the run, or a time trigger after the first failed round) and size `caps.wall_min` to cover the
  product's escalation horizon (K=3 then 30/60/120s backoffs to N=10 ≈ 12 min) so the cell can observe either the
  legible escalation or the clean post-restore completion. Keep `expected_fast_failure`. The product-side defect this
  exposed (IFLB: no relaunch after the backoff) is NOT in scope here — the cell must simply be able to observe it.
- MDSH (dsh functional predicate): the W4.dsh-* cells ran on the mac although dsh cannot boot under the contained
  daemon there ("dsh: plugin tree failed t…", while `dsh --profile headless --help` works under the interactive shell
  with the contained HOME), so each idled to its cap as INCONCLUSIVE. tt-harness-auth-probe must include a dsh smoke
  run under the daemon's exact environment (PATH/HOME as the contained daemon sees them) and the roster predicate must
  mark dsh cells NOT_RUN (reason recorded) when it fails; capture the harness's full stderr in the probe evidence
  (the product's log preview truncates it).
- MCHA (darwin chaos/kill guard): `tt-chaos` refuses to signal on darwin — mac campaign #1 cells W4.09-pi, W4.09-hermes,
  W4.10-kill-daemon and W4.48a all ended chaos-invocation-failed with exit 3 "GUARD_MISS: cannot read the process group
  of daemon pid N (no procfs) — group disjointness from the caller cannot be verified, refusing to signal". Correct
  fail-closed behavior, wrong evidence source: use the portable identity arm (`ps -o pgid=` for the process group,
  lsof cwd + command line for ownership — the same darwin evidence tt-process-identity and daemon-control already use)
  so the kill-harness / kill-daemon injections fire on darwin with the same disjointness guarantee. Also audit the
  probe-sequence engine's seam actions for the same procfs dependence. Red-arm on linux via the existing
  simulated-darwin seams (TT_DC_PLATFORM / TT_VERIFY_PLATFORM style); real validation happens on mac campaign #2.
- MVPT (darwin env gate): `tt-verify-environment`'s port-ownership check returns "not TT-owned" on darwin by
  construction (explicit darwin branch, no evidence), so any contained daemon on 43xx/53xx fails the gate with
  "in use by non-TT process" (mac stage-2 attempt-2, 2026-09-02 17:1xZ, pids the main checkout's own provenance
  recorded). Use the same portable evidence daemon-control's ownership check uses (lsof cwd + command line on
  darwin; procfs on linux) and, when a listener is TT-owned by another worktree of the same repo, say so
  ("TT-owned by <worktree path>, run <id>") instead of "non-TT". Red-arm via the TT_VERIFY_PLATFORM seam.
- TFLK (note only, no code): the product test `tests/cli/install-partial-failure.test.ts` hermeticity probe is
  load-sensitive; document in the review-ladder notes that a single red there is re-run before being called a failure.

## Prove (one gate per story; each proof story fits one worker round; never re-run a gate a completed story proved)
- Red-arm self-tests for S45-S48, S51, S52, S54, S56, S57 (each: old behavior red, new behavior green; linux-runnable).
- S49: the new cells validate (tt-tier2-assets) and their scripted variants execute in bare --tier2.
- S55: a self-test proves a worktree whose dist/version differs from the installed checkout runs its OWN daemon.
- Full self-test battery green; bare --tier0 33/33 (S56 collisions must now be gone or classified infra), bare --tier1,
  bare --tier2 (scripted) GREEN with executed/expected printed (S51).

## Constraints
Files ONLY inside torture-test/. No product code. Never touch the live daemon or the operator's real HOME. Kill only
pids you spawned (never by name/pattern). Do not write procfs pid-file paths or GNU-tool names verbatim in new markdown under
torture-test/impl-tasks (the lints scan them) — describe them instead.
