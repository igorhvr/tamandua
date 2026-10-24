# BINDPROOF-PARSE US-003 — W0.3b end-to-end and gate evidence

Recorded 2026-10-24T00:47Z on host `kaladin` from branch
`fix/w0.3b-binding-proof-fail-closed` based on
`bb3307091576f6a5c48e8704522ada5d71aa5f42`.

This story is verification-only: no product/workflow sources changed. The
suite-side fix under test was delivered by US-001 (real run rc/timeout capture)
and US-002 (runId-first merged-JSON parser + fail-closed validation).

Delivered code revision for the fix: `0183d584e16e42babb909c7117ec34f878c1e96c`
(tree `ac755a9c88d26b9606a7c0247ab8bc47fe95b5ec`). The commit carrying this
evidence note is a documentation-only child of that revision.

## Environment / prerequisites

- `dist/cli/cli.js` present; `dist/version` =
  `20261024T000114Z_0183d584e16e42babb909c7117ec34f878c1e96c`
  (daemon/CLI dist parity verified by daemon-control during the run).
- `node_modules/` present; no reinstall/build was needed. No product source was
  edited to make the case run.

## Controller attempt (blocked by host profile, not by product)

Command:

```sh
./run-torture-test --tier0 --case W0.3b-binding-proof
```

Result: exit code **2** (`TEST_INFRA_FAIL`), campaign
`campaign-20261024T004507826Z-78da2650-03b0-40cf-b95f-eb2b623f021b`,
evidence `torture-test/var/results/campaign-20261024T004507826Z-78da2650-03b0-40cf-b95f-eb2b623f021b/report.txt`.

Exact refusal:

```
W0.3b-binding-proof: host-profile-missing
cannot load required host profile .../torture-test/var/w0/host-profile.json:
ENOENT: no such file or directory
VERDICT: INFRA_FAILURE (exit 2)
```

The controller pass is therefore **not** claimed. The manifest's exact direct
command was used for real case evidence instead.

## Actual W0.3b case (direct manifest command)

Command (the manifest's `command.executable`/`cwd`):

```sh
cd torture-test && scripted-runtimes/binding-proof.sh
```

Result: exit code **0**. Real PASS lines (12 total):

- daemon-control resolved
- TAMANDUA_PI_BINARY = scripted-pi
- TAMANDUA_HERMES_BINARY = scripted-hermes
- tamandua CLI resolved
- node resolved
- behaviors file created
- scripted daemon RUNNING
- do-now-proof workflow copy created
- Run completed successfully (status: completed)
- Zero real tokens spent: 0
- Run output contains expected runs array (run count: 1)
- No real pi/hermes invocations detected (scripted refs: 10)

Run under test: `run-f59d7b18-31e2-47b2-a6e3-50ee9839d0a2`, status
`completed`, `tokensSpent: 0`, `runs` length 1, `timedOut: false`. The merged
`--wait --json` line began with `{"runId":...`, which is the shape the base
script's stale `grep -E '^\{"runs":'` could not parse.

Daemon lifecycle: started PID 2153083 in scope
`tamandua-tt-scripted-fcae3936`; the script's cleanup stopped the
identity-verified PID and released ports 5334/5338/5339. Verified after exit:
PID absent, no listeners on those ports. No pattern-kill was used. The
operator home was only read.

## Static gates (all on the delivered revision)

| Command | Result | Counts |
| --- | --- | --- |
| `node --test torture-test/self-tests/scripted-runtime-binding-proof.test.ts` | rc 0 | 34 tests / 34 pass / 0 fail / 0 skipped |
| `node --test torture-test/self-tests/tier0-case-manifest.test.ts` | rc 0 | 5 tests / 5 pass / 0 fail / 0 skipped |
| `node --test torture-test/self-tests/tier0-bash32-compat-lint.test.ts` | rc 0 | 11 tests / 11 pass / 0 fail / 0 skipped |
| `node --test torture-test/self-tests/tier0-gnu-portability-lint.test.ts` | rc 0 | 18 tests / 18 pass / 0 fail / 0 skipped |
| `node torture-test/bin/tt-controller --manifest torture-test/cases/tier0.jsonl --validate-only` | rc 0 | `Validated 35 case(s)` |
| `bash -n torture-test/scripted-runtimes/binding-proof.sh` | rc 0 | — |
| `node --check torture-test/self-tests/scripted-runtime-binding-proof.test.ts` | rc 0 | — |

The binding-proof self-test includes the red arm proving base `bb330709` fails
the runId-first fixture and swallows run rc 7, plus fail-closed negatives
(truncated JSON, no complete JSON object, no/empty runs, missing/string
`tokensSpent`, failed/canceled status, nonzero rc, `timedOut:true`, wait-loop
timeout wording) that all assert exit code 1.
