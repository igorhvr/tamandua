# US-006: S26 final integration verification — full self-test battery, tier-2 x2 and tier-1 ladder green

S26 story US-006: verify the complete S26 change set end-to-end from the repo
root — full torture-test self-test battery green, bare tier-2 ladder GREEN
twice (24/24 scripted), bare tier-1 GREEN, typecheck/build green, zero tokens,
live daemon untouched, changes only inside torture-test/, attempt-1/-2
evidence unmodified — so the run is ready to land with the campaign-#8 answer
in the landing report.

## What was verified

### 1. Full torture-test self-test battery (repo root)

All pieces run from the repo root, serially, from a clean tree:

| piece | result |
|-------|--------|
| `torture-test/oracles/self-test/run.sh` (2 rounds) | PASS (repeatability, ~132s) |
| `torture-test/self-tests/run.sh` | PASS (122 passed, 0 failed) |
| `torture-test/bin/tt-controller.test.sh` (controller umbrella) | PASS |
| `torture-test/bin/tt-daemon-up.test.sh` | PASS |
| `torture-test/bin/tt-daemon-up-schema.test.sh` | PASS |
| `torture-test/bin/tt-controller-preflight.test.sh` | PASS (incl. S26 suite-state red-arm) |
| `torture-test/bin/tt-oracle-replay.test.mjs` | PASS |
| `torture-test/bin/tt-oracle-replay-invariants.test.mjs` | PASS |
| `torture-test/bin/oracle-context.test.mjs` | PASS |
| `torture-test/bin/oracle-evidence-snapshot.test.mjs` | PASS |
| `torture-test/bin/tt-classification.test.mjs` | PASS |
| `torture-test/bin/tt-report.test.mjs` | PASS |

Full battery exit 0.

### 2. Bare tier gates (zero tokens, never `--include-real`)

`./run-torture-test --tier2` GREEN twice:

- Run 1 (`campaign-20260827T190554027Z-0849e341`): **VERDICT GREEN (exit 0)**,
  `Totals: PASS=24 PRODUCT_FAIL=0 AGENT_FLAKE=0 PROVIDER_FAIL=0
  TEST_INFRA_FAIL=0 INVALID=0 INCONCLUSIVE=0 NOT_RUN=46`, `Tokens observed: 0`.
- Run 2 (`campaign-20260827T200107132Z-88c1967f`): **VERDICT GREEN (exit 0)**,
  identical totals (PASS=24, 0 infra failures, 0 findings, 0 tokens, 46
  pending-real).

`./run-torture-test --tier1` GREEN:

- `campaign-20260827T205635193Z-db7d6493`: **VERDICT GREEN (exit 0)**,
  `Totals: PASS=4 ... NOT_RUN=24`, `Tokens observed: 0` (4 scripted tier1
  cells; 24 pending-real).

### 3. Typecheck / build

`npm run build` (tsc + dist + version injection) exit 0. Build version
`20260827T170149Z_cbe371cb4f...` injected.

### 4. Confinement / evidence / tokens / live daemon

- `git diff --stat b84b20bf..HEAD` touches **only `torture-test/`** (23 files,
  +2511/−59); working tree clean after all runs.
- Attempt-1/-2 evidence (adjudication material) sha256-verified before/after
  every replay and again at the end: **byte-identical** (2413 attempt-2 files,
  125 attempt-1 files; `state.json` hashes unchanged).
- **Zero tokens**: every tier run reports `Tokens observed: 0`; oracle
  self-tests and replay are token-free by construction. No real campaign case
  was re-run (evidence replay only, read-only).
- **Live daemon (33xx) untouched**: ports 3334/3338/3339 stayed up
  throughout; only the main checkout's stale leftover scripted daemon on the
  shared 53xx ports (a T2.1-class leftover from the terminated attempt-2
  campaign's last scripted case, W4.46) was stopped via that checkout's own
  provenance-scoped `daemon-control scripted stop` so the shared scripted
  ports were free for the ladder runs. Contained 43xx/53xx ports were free
  after each ladder (daemon teardown clean).
- Contained real DB `suite_results` empty after the battery (0 rows).

## Integration fixes surfaced by the full battery (this story)

Running the FULL battery in sequence (previous stories ran its pieces in
isolation) exposed two latent test-isolation issues; both fixed inside
torture-test/ only (commit `5ab74867`):

1. **`tt-controller.test.sh` deleted tracked oracle fixture files.** The
   mechanical oracle campaign rewrites `torture-test/oracles/TT-ORACLE-PASS /
   MALFORMED / CONTRADICTORY / NO-PROSE` (byte-identical content) and then
   `rm -f`'d them at cleanup, leaving the working tree dirty (which the
   `self-tests/run.sh` clean-tree guard refuses). Cleanup now snapshots the
   originals before rewriting and **restores** them; scratch fixtures with no
   committed original (e.g. `TT-ORACLE-PROVIDER-RETRY`) are still removed.

2. **`tier1-python-shim-ledger-proof.test.ts` leaked a suite_results row into
   the shared contained real DB.** The shim proof inserts one
   `suite_results` row (via the stand-in control plane, into
   `torture-test/var/home/.tamandua/tamandua.db`) and never removed it. The
   S26 fresh-campaign suite-state gate (`tt-daemon-up ensure-up --fresh`,
   US-004) now correctly refuses a non-empty suite at campaign start, so the
   leftover row made every later fresh real-campaign preflight
   (`tt-controller-preflight.test.sh` AC3-real) fail closed. The test now
   deletes its own row (by unique run id) in the finally block — the S26
   test-isolation doctrine.

## Campaign-#8 immunity answer (US-001, lands in the landing report)

Campaign #8's O10 "immunity" is **not** an oracle-level immunity — the
byte-for-field check FAILED on every case it ran (8/8 `ORACLE_RUNTIME_ERROR`).
The campaign did not drown because of a **classification-precedence mask**:
in all 8 O10-ERROR cases at least one other oracle (O2/O8/O9/O11) returned a
genuine product FAIL, and `classifyAttempt` (`bin/tt-classification.mjs:60-79`)
returns `PRODUCT_FAIL` the moment any valid oracle FAILs — **before** it
inspects oracle TEST_INFRA status. Zero `TEST_INFRA_FAIL` rows were
O10-driven. Tier-2 attempt-2 drowned because there the O10 ERROR was the
**only** failing oracle (18 cases) and classification fell through to
`oracle-infrastructure` → `TEST_INFRA_FAIL`. This reveals **no different
intended design**: the scoped reconciliation (US-002) is the correct fix, and
it matches artifact-vs-scoped-DB byte-for-field on all 8 campaign-#8 O10
ERROR cases.
