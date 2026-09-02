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
