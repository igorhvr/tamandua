# RJSO — invocation-owned recorder emission-test cleanup: retained evidence

Beads tamandua-0j7.4.2.1 (parent tamandua-0j7.4.2, RJSON). Run
`72aa9f8a-7a7a-4cb0-bafa-3fed96b66b9b` (workflow `feature-dev-merge-worktree`,
worktree `/home/igorhvr/.tamandua/worktrees/tamandua-73d5fbc9/917-72aa9f8a`).
Branch `feature/rjso-recorder-emission-ownership`.

This pack documents the committed recording proof for the one bounded
correction: the emission-test cleanup/ownership code is made invocation-exact,
and one focused recording-only gate runs the ACTUAL extracted code under
recorded process/filesystem/wait/signal bindings — zero real signals, spawns,
waits, removals, or live-pid reads. Per the run's coordinator plan boundary,
full logs and machine evidence are retained in a gitignored
`torture-test/var/review-logs/` directory and referenced here by exact path +
sha256; this tracked directory is the concise explanatory note plus small
retained outputs (no full logs or large dumps are committed).

## Tested source files (commit `6fa9c58d`, US-003 — the code tree under test)

| File | SHA256 |
|---|---|
| `torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts` | `76fa7730355f2e61a661bb13b80eab78b37d88e8e16706fab66371be801d5b05` |
| `torture-test/self-tests/tier1-rjson-ownership-recording-gate.test.ts` | `d7ca751d68bc9467396ec23027cff91f301d9e59f1cecaa36b46edc198f4b8b3` |

Tested source tree: `5005feb535211df9f562fa8c3c1c137c844f5ac8`
(`git rev-parse HEAD^{tree}` at validation time = the US-003 commit tree, i.e.
the tree whose npm test passed in the run ledger — see ledger rows below). The
US-004 evidence commit adds only this documentation directory on top of that
tree (no code change).

## Extracted decision code — function/block sha256 (from the gate's JSON evidence)

The gate AST-extracts these targets from the live emission-test source and
structurally pins them (extraction fails loudly if a target is missing or
moved). The hashes below are the `extracted.*` values in the gate's
`RJSON-OWNERSHIP-GATE-EVIDENCE` JSON (retained run 1 evidence: path below).

| Target (child ownership, US-002) | functionSha256 |
|---|---|
| `spawnOwnedChild` | `ecc73f4f8b06b9a9bde3a7bff0b8b00d32bab938524af21b302306a8d38d3ff6` |
| `currentChildVerdict` | `79367f8307a334a6a9d4bf34f62b9960b667c244e3335f5ea8ac6cfd59614192` |
| `readChildIdentity` | `e7f26e2eebced358e6bc7f7e1ffe05db3d820c5b6f23e33b917a52acab6985b8` |
| `refuseChildSignal` | `5a2ade199be4ff05ed502257468a91988aea69a642e221ac5f03d96bab76f021` |
| `stopOwnedChild` | `ea04d35f8318e8e4252ac03996faaea5f867868c141aed453cd82c377d7bbe1c` |

| Target (recorder ownership, US-003) | functionSha256 |
|---|---|
| `recorderPidfilePath` | `3db5847a3ce36e412b3af13b07b316139145ec4cc0bc4136ea0f91b9b4e74b6b` |
| `readRecorderPidfile` | `9dbda598ea672750ea770e653a5d92b5bb5ff5156babaef2324af95761bd1c22` |
| `currentRecorderVerdict` | `f016eb2b2d203de749eb1fae5781e16b1586e6a4a68ee77c50d99d0af04e7779` |
| `refuseRecorderSignal` | `3b12fc864f7befc7eac420e35ed34c84e323a88a2979bd22880781fe23706173` |
| `assertRecorderStopProceeds` | `ccaa697c92f627b0afc7fae3f38868087c4105e0f2e83868686a8a98c66bdbc7` |
| `stopOwnedRecorder` | `ac6f439354adf79f4fc506b149154c4e60408ee7cf5c97d638e726a5b09bb4ba` |
| `captureRecorderIdentity` | `16f174c1e2aa63458b62ac660ef35f7ce85a6dffa08f367179a0d83d21465643` |
| recorder-finally block (`recorderFinally`) | blockSha256 `39d0adc3f0e98f1aa025643f66346bdec27aca16abd50ed30ed07f8d7a237c73` |

## Commands and exit codes

Working directory for every command: the worktree repo root. Exit codes are
the tested command's own exit (captured directly, not a tail/tee/echo status).
Host: Linux (bash 5.3.9, node v24.18.0), native isolation (landlock) enabled,
test isolation guard enabled.

```
$ git status --porcelain            (clean before validation)        exit: 0
$ node --test torture-test/self-tests/tier1-rjson-ownership-recording-gate.test.ts   (gate run 1)  exit: 0  (5 tests, 5 pass)
$ node --test torture-test/self-tests/tier1-rjson-ownership-recording-gate.test.ts   (gate run 2)  exit: 0  (5 tests, 5 pass)
$ npm run check-test-syntax                                                  exit: 0  (265 test files parsed)
$ npm run build                                                              exit: 0  (tsc + build + native helper)
$ npx tsc --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --strict --types node --erasableSyntaxOnly torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts torture-test/self-tests/tier1-rjson-ownership-recording-gate.test.ts   exit: 0
```

Full run logs: see the gitignored retained directory referenced below
(`gate-run1.log`, `gate-run2.log`, `check-test-syntax.log`, `npm-build.log`,
`tsc-standalone.log`). Small copies of the syntax/build/tsc outputs are kept
in this directory (committed, `.txt` because the repo ignores `*.log`) as
retained outputs: `check-test-syntax.txt`, `npm-build.txt`,
`tsc-standalone.txt`.

### Integration `npm test` (TEST_CMD)

TEST_CMD for this run stays exactly `npm test`, executed through the
`tamandua-test` content-addressed ledger shim under the shared coordinator
flock (`torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/linux-npm.lock`).
The run ledger already records a green full-suite run for the exact tested
code tree `5005feb53521…` (suite_results row 1528: `npm test` exit 0,
step `verify`, ~620 s) — legitimate same-tree ledger evidence for this proof.
The US-004 evidence commit changes only this documentation directory, so the
pipeline's next `npm test` gate on the new tree is a fresh execution of the
same suite (no cached replay is claimed as a fresh run).

## Case outcomes (44 scenarios, recording-only)

- Targets exercised: `stopOwnedChild` × 10, `spawnOwnedChild` × 4,
  `recorderFinally` × 9, `recorderStop` × 15, `recorderNormalStop` × 6.
- Decision-path tags: normal-stop 9, startup-error 6, finally 14, plus 15
  child/recorder-stop scenarios without a path tag.
- 7 owned-positive signal deliveries (TERM and, where the survivor keeps its
  identity, KILL — each KILL preceded by a fresh identity revalidation);
  25 refusals with evidence preserved (verdicts foreign/unreadable at
  TERM/KILL phase); every refusal issues zero real signals and preserves
  evidence (finally refusals stop before the fixture `rm`).
- Escape proof: 8 probes (unscripted fs/signal/liveness/ps/spawn/raw-kill ops
  and a live-pid-style host path read) all raised before any real operation;
  the sandbox exposes no node globals.
- Per-case outcome table: `case-outcomes-table.txt` (committed below);
  full recorded-op detail for every scenario is in the retained evidence JSON
  (path below).
- Evidence is deterministic across consecutive runs: the two retained gate
  logs are byte-identical except the `utc` field.

## Retained full evidence (gitignored — exact paths, with sha256)

All full logs and the machine evidence are retained (fresh timestamped dir,
never overwritten) at:

```
torture-test/var/review-logs/rjso-us004-final-20260906T210914Z-run-72aa9f8a/
```

| File | SHA256 |
|---|---|
| `gate-run1.log` | `8ef13bbbd0dc9784aa0dc20c22aa8072a30bd935b1c1a407f9390319df35540e` |
| `gate-run2.log` | `5db6d5cccdc2504dab129e4a8b963e9e3c6bc07877db3d7ae5f916e831948a20` |
| `gate-postcommit.log` | `60ede2a42051fad40505e0e5875a9ea1cc330282d7e454a54d1451216e817957` |
| `gate-evidence-run1.json` | `ffebd7b4beea2ec39225d13c787980200d01642b5ce41eb4b6c276b89db3bcf8` |
| `case-outcomes-table.txt` | `4c13d2ec9ff2ae8407ccacf3ecd180fe1e68be77acd45f02d6d3d961debcd9f5` |
| `check-test-syntax.log` | `ed41cc44d90769c558adb6a6477be3949e2175d81ac4912beb85871c5d896938` |
| `npm-build.log` | `aeb0334d144d35841c5ac8cf333ba10e84ff949bbb0abdf7d19cdd32398ccf6b` |
| `tsc-standalone.log` | `17b271b273286f3f06b8ca009385ec8ac047ec15669076f914aa6de145300504` |
| `command-exit-ledger.txt` | `bad78feb5a72138121d0c84daeba05655f1f8fc2958b10e35cc75b4abca70afe` |

## Honest limits

- Recorded-only proof: a recorded successful cleanup is NOT proof a real
  child/recorder was collected on this host. Real Linux emission acceptance
  and actual Mac applicable checks are coordinator-owned and were NOT run
  in-run (they come after this committed recording proof is independently
  accepted).
- The full emission test file (`tier1-rjson-recorder-emission-isolation.test.ts`)
  and `self-tests/run.sh` were NOT executed in-run (independent-execution
  boundary).
- Existing Linux-only discovery skips on Mac are NOT RUN — never reported as
  Mac emission success; the portable escaping cases still execute on both
  hosts (no Mac host was executed here).
- `torture-test/bin/tt-recorder` is untouched: its own `stop` subcommand,
  discovery/escaping, and emitted-data semantics are byte-identical and out of
  scope. The emission test guards the decision to invoke the stop subcommand
  (normal-stop pre-check `assertRecorderStopProceeds`) and performs its own
  guarded direct stop in the finally; the subcommand's internal TERM/KILL
  window remains the recorder's own (unchanged) semantics — a recorded
  boundary, not proof of collection.
- All 44 scenarios + 8 escape probes ran on the ACTUAL AST-extracted
  emission-test code under recording bindings; no duplicated expected
  predicate was tested instead of the real code.

## Scope of the run's change

Changed (tracked) by this run, against the run base `c3da3501`:

- `torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts`
  (ownership/cleanup helpers + call sites only; every existing emission
  assertion — exact JSONL, multiline cwd/argv, PID/parent/group, DB size,
  absent-WAL, output-file/start/stop — unchanged)
- `torture-test/self-tests/tier1-rjson-ownership-recording-gate.test.ts`
  (the one recording-only gate)
- this evidence documentation directory

No product `src/`, `tests/`, workflows, personas, dependencies, host
configuration, or `torture-test/bin/tt-recorder` change was made.
