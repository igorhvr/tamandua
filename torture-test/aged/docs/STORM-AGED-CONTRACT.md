# STORM-AGED contract — callable APIs, inputs and snapshot outputs

Target audience: run39 (tt-storm engine/roster), run41 (O12), run40 (hygiene),
and the storm assembly.  This documents the exact surface the aged-state
generator publishes so the storm can later integrate, validate, and arm.

## 1. Command surface (`torture-test/bin/tt-storm-aged`)

| Command | Effect |
|---|---|
| `--help`, `--version` | inert (never starts a daemon/model/campaign) |
| `inspect <root>` | read-only manifest glance |
| `allocate [--kind full\|pilot] [--root ROOT] [--recipe FILE] [--run-id ID] [--base DIR]` | allocate an owned seed root and pin the executed generator identity (HEAD + working-tree cleanliness) BEFORE any effect; runs NO phase |
| `preflight [--root ROOT]` | recording-only effect-adapter safety gate (`PASS/REFUSE/INVALID`; zero effects) |
| `preflight-evidence <root>` | persist PASS + negative-trial gate receipts (zero-effects fingerprints, CLI exit codes 0/3) under `<root>/evidence/preflight` |
| `pilot [--root ROOT] [--plan FILE]` | allocate + seed a small real-API pilot corpus (all dispositions) |
| `full --origin <repo> [--recipe FILE]` | full 5000-run / ≥500000-logical-event / 200-worktree seed on a supplied owned/pinned tt-poly origin |
| `resume <root>` | idempotent continue (cumulative receipts; never duplicates runs) |
| `census <root>` | read-only census receipt + immutable snapshots + O12 sidecar |
| `validate <root>` | seed-validation routing matrix + real O12 run |
| `volume <root> --count N` | volume-only synthetic events through real `emitEvent` |

Environment: `TAMANDUA_CLI` (default `/opt/tamandua/bin/tamandua`),
`TAMANDUA_PRODUCT_DIST` (default `/opt/tamandua/dist` — the stable product
dist pin shared with the O12 contract), `TT_POLY_ORIGIN` (full-mode origin).

## 2. Module APIs (for programmatic integration)

All under `torture-test/aged/`.  Each mutating phase runs in a private
subprocess with a containment env (`env.buildPhaseEnv`), so integrations
should call the CLI, not import phase functions directly.

Key exported functions:
- `manifest.allocateSeedRoot / loadManifest / assertRootIdentity /
  phaseReceipt / journal / saveManifest`
- `env.buildPhaseEnv / spawnPhase / writeDaemonSecret / reserveRandomPort`
- `product.resolveProductDist`
- `transport.NonDispatchingTransportServer` (registration-transport double)
  and `transport.RealControlFacade` (real product pause/resume handlers)
- `catalog.installCatalogViaRealCli` (real `workflow install --all` into the
  private state) and `catalog.listBundledIds`
- `fixture.ensureOrigin` (pilot tiny origin / full supplied-origin handshake)
- `seedlib.createRunThroughRealApi` (REAL `runWorkflow`), `...driveLinearRunToCompletion`,
  `...cancelRunViaRealStop` (REAL `stopWorkflow`), `...failRunViaRealForceFail`
  (REAL `forceFailRun`), `...failRunViaStepExhaustion` (REAL `failStep` budget
  exhaustion — awaited, re-claim between retries, REAL retry_count
  progression asserted), `...recordReservedBaseline`
- `plan.buildPlan / pilotEntries / fullEntries` (pure, importable plan
  builders) and `plan.WORKTREE_WORKFLOWS / NON_WORKTREE_TWIN`
- `census.runDbCensus / eventStreamCensus / worktreeCensus / gitRefCensus`
- `snapshot.createImmutableDbSnapshot / snapshotEventStreams /
  computeReservedMutations / simulateReservedFromOps /
  writeReservedBaselineSidecar` (complete typed v2 host baseline sidecar,
  written read-only 0o400, plus host-mutation ledger derived from RECORDED
  native step operations — see §4; a prior sidecar is archived to
  `o12-reserved-baseline.pre-<ts>.json` before a corrected one is written)
- `preflight.preflightGate / runPreflightEvidenceBattery`
- `validate.buildValidationMatrix / runO12Validation / materializePinnedOracle /
  computeO12OracleContentHash / listPriorO12Runs`

## 3. Data shape produced (real APIs)

- Run rows: created by REAL `runWorkflow` (run_number = MAX+1 allocator,
  status running → terminalized via REAL functions).
- Steps: created by `runWorkflow`; walked via REAL `claimStep/completeStep`
  with seed-fixture outputs that pass the REAL `validateExpects`; advanced by
  the REAL `advancePipeline` (run.completed emitted by the product).
- Terminal shapes: completed (real claim/complete/advance), canceled (real
  `stopWorkflow`), failed (real `forceFailRun`, or the real `failStep`
  retry-budget exhaustion driver → genuine `run.failed`), paused (REAL
  control-server pause handler — NONTERMINAL, resume-safe, stays paused when a
  real storm daemon later opens the state).  No accidentally runnable
  leftovers/claims on terminal runs.  Dispositions in a plan are INTENT; the
  seed receipts record each run's actual terminalization (a run whose
  exhaustion driver is interrupted falls back to a genuine `forceFailRun`, and
  the receipt + `disposition_counts` reconcile it — never relabeled as a clean
  exhaustion).
- Managed worktrees: REAL `createRunWorktree` inside `runWorkflow`
  (run_worktrees rows + directories + git worktree list, cleanup_policy
  `keep`).
- Events: emitted by the real product emitter into per-run streams and
  `all.jsonl` (rotation ≤ 20 MB + 3 archives observed, never double-counted).
  Volume-only records use the synthetic NON-lifecycle event name
  `aged.volume.seed` with unique per-run sequences; lifecycle vs volume totals
  are disclosed separately.
- Context reserved keys: never written by agent output; every run's ENTIRE
  reserved-key pin is captured at creation with complete typed
  presence/absence (provenance `host`) in the host-owned baseline
  `evidence/o12-reserved-baseline.jsonl` → aggregated v2 sidecar
  `evidence/o12-reserved-baseline.json` (producer `host`, schema_version 2,
  complete independently admitted scope, read-only 0o400).  Legitimate later
  host transitions (real product writes caused by the driver's RECORDED
  step completions, e.g. TEST_CMD establishment → `test_cmd_raw`) are ledged
  with their exact final state in `expected_mutations` (source `host`), derived
  from the recorded native step operations and verified against the final
  snapshot — never granted from a bare final-context diff.  Originals are never
  reconstructed from final context.

## 4. Validation routing semantics

| Oracle | Seed routing |
|---|---|
| O1 terminal-state integrity | custom seed-slice aligned to the REAL O1 oracle contract (torture-test/oracles/lib/o1.mjs): nonterminal steps are corruption only on COMPLETED runs; waiting/pending steps left on FAILED/CANCELED runs are native leftover shapes (zero claim evidence) and are reported as observation counts, never as corruption.  Paused runs must carry `scheduling_status=paused`; a completed run retaining a running/pending/waiting step is a real violation.  `execution_kind: custom-seed-slice`, full per-run campaign oracle legs NOT_RUN. |
| O2/O8/O9/O10/O11/O16 | NOT_RUN (per-run campaign oracles judge REAL agent work; a zero-token synthetic corpus has none) |
| O3z | NOT_RUN/NOT_EVALUABLE — real-run token-tripwire oracle (oracles/lib/o3z.mjs) requires controller-run projections and system-token before/after snapshots of a real campaign; a synthetic zero-token corpus has none, so the doer never substitutes a mini-SQL check under the O3z id.  Corpus-level zero-token receipts are attached as evidence on the row, clearly NOT an O3z execution. |
| O4 claim hygiene | custom seed-slice aligned to the REAL O4 oracle: dangling-claim evidence = steps on terminal runs that are still `running` or carry claim_pid/claim_pgid/claim_job_id; unclaimed waiting steps are never dangling claims.  `execution_kind: custom-seed-slice`, full O4 recorder/chaos legs NOT_RUN. |
| O5 process/port | NOT_EVALUABLE at seed level (campaign recorder owned elsewhere) |
| O6 worktree bookkeeping | custom structural seed-slice (rows ↔ dirs ↔ git worktree list) — NOT the full O6 oracle execution (implementation/acceptance separate) |
| O7 event-log integrity | custom structural seed-slice (terminal events per run stream; HUSH nudge events absent; rotation cap) — NOT the full O7 oracle execution (implementation/acceptance separate) |
| O12 DB invariants | real pinned O12 executable under the content-addressed pin `O12_PINNED_CONTENT_SHA256 = d50275466dcb…` (the accepted schema-9..13 build; supports `user_version {9, 10, 11, 12, 13}` — v12 in both its main and matchlock lineages, v13 with `runs.matchlock_policy` — and fails closed on unknown versions; acceptance evidence under `torture-test/var/results/o12-owned-store-acceptance-*` / `o12-schema13-us0*`) over the immutable snapshot + complete typed read-only host baseline sidecar (v2).  The pin is the SHA-256 of the O12 oracle CONTENT set (`torture-test/oracles/{O12,lib/o12.mjs,O12-CONTRACT.md,self-test/*}`), so a merge-worktree squash — which rewrites commit hashes but not the oracle bytes — cannot invalidate it.  The provenance commit `7fe9f258…` (the run's base HEAD, never a pre-squash story commit) is recorded as provenance only, never resolved or compared as the pin.  Prior-pin runs under `eb953ca52e53…` (run45 close head, schema-9-only, NOT_ROOT_ACCEPTED) and the superseded pins `62699fa25aec…`/`e8f912398b46…` are preserved and labeled provisional.  `execution_kind: real-oracle-execution`. |

Every matrix row carries `execution_kind` (`custom-seed-slice` | `real-oracle-execution` |
`not-executed`) and a `full_oracle_status` so partial bespoke checks are never
mistaken for full oracle execution.

Reserved-key host-mutation ledger: allowed transitions are derived from the
independently RECORDED planned native API operations — the completed step
outputs the driver submitted through real completeStep (immutable steps table,
pipeline order) and the product's known TEST_CMD normalization semantics
(first marker establishes `context.test_cmd_raw`) — then verified against the
final snapshot.  A final-context difference NOT explained by a recorded
operation is never blessed (it remains an O12 overwrite).  The sidecar records
the derivation method + coverage (verified/unverified per run/key).

Source identity: the executed generator identity (HEAD + working-tree
cleanliness `porcelain_sha256`) is recorded at allocation, BEFORE any effect;
resume reuses the recorded pin and never re-pins a moved/foreign root.

Missing oracles/evidence are `NOT_RUN` / `NOT_EVALUABLE` — never qualification.
Only a fully valid seed can arm the real storm.

## 5. Plan-intent realism

Completed intent is only planned for genuinely linearly-completable families
(`seedlib.LINEAR_COMPLETABLE`).  `quarantine-broken-tests` is deliberately NOT
in that set: its setup step template requires a `branch` context key, and the
seed's non-worktree synthetic runs never carry `branch` (direct-mode
runWorkflow seeds original_branch/base_branch_sha only), so native template
validation fails and a non-worktree quarantine run can never genuinely
complete.  Plan builders route quarantine completed-intent draws through
dispositionFallback so plan intent matches an achievable disposition.

## 5. Ownership

Owned by STORM-AGED: `torture-test/aged/**`, `torture-test/bin/tt-storm-aged`,
and the seed roots under `torture-test/var/results/storm-aged.*` (gitignored
evidence) plus the published `/root/matchlock-work/storm-aged-contract.json`.
Not owned/edited: run39 `tt-storm*`, run41 O12 files (imported read-only at the
content pin), run40 R4/SOGI/S57 files, and all native `src/` product code.

## 6. REAL campaign adoption path and arming (STORM-REAL)

STORM-REAL prepares a campaign against an AGED corpus (beads
`tamandua-6sy.6.6` STORM-REAL / `tamandua-6sy.6` STORM).  The owned, frozen
seed root this generator produces is installed into the campaign's PRIVATE
state root by the arming phases in `torture-test/bin/tt-storm` (`arm
aged-state`, `arm seed-validation`), after which the private product daemon
opens the adopted DB/events.  Adoption is LAUNCH-FREE: it never starts a
daemon, harness or model, never changes the campaign's `mode`/`qualification`
(the campaign stays `prepared` and unqualified), and never writes to the
READ-ONLY seed root.  The seed root's owned identity (`assertRootIdentity`),
the immutable DB snapshot's pinned sha256 and every copied event stream's
pinned sha256 are verified BEFORE any campaign write, so a foreign, replaced or
drifted root refuses with no partial install.

### 6.1 Adoption path — seed sources and campaign destinations

`AGED_STATE_ADOPTION_PATH` (`torture-test/bin/tt-storm-arm.mjs`) is the ONE
source/destination table; `tt-storm arm aged-state` records it verbatim in the
`arming/aged-state.json` receipt.  The seed side is read-only evidence; the
campaign side is the already-admitted private exec context.

| Step | Seed source (read-only evidence) | Campaign destination | Mode |
|---|---|---|---|
| db | manifest.snapshot.db.file (immutable VACUUM INTO snapshot, sha256-pinned) | campaign state.exec_identity.db_path (the campaign TAMANDUA_DB_PATH) | replaces the freshly-prepared empty product-schema DB; made writable (0644) for the real daemon |
| events | manifest.snapshot.events.dir (byte-exact event-stream copies, per-file sha256-pinned) | campaign state.exec_identity.state_root/events/ | byte-exact copy of every event stream (per-run streams + all.jsonl and archives) |
| run_worktrees | the adopted DB run_worktrees rows | the campaign DB | adopted with the DB copy; row count recorded in the arming receipt |

After adoption the campaign's `exec_identity.ownership.db` receipt is re-pinned
to the INSTALLED file's real dev/ino (a stale prepare-time ino would be refused
`TT_NOT_OWNED` by every later mode) and the replaced DB's `-wal`/`-shm`
sidecars are dropped so no foreign WAL is recovered.

### 6.2 REAL arm commands

The exact REAL-profile arming commands for a prepared campaign
(`<campaign-dir>` is the `tt-storm prepare --profile REAL ...` output,
`<owned-seed-root>` the qualified `torture-test/var/results/storm-aged.*` seed
root, `<recorded-matrix.json>` an optional recorded routing matrix):

```
tt-storm prepare --profile REAL --spend-cap-tokens <n> [--spend-cap-scope paid|total] [--scale full|lite] ...
tt-storm arm aged-state --campaign <campaign-dir> --seed-root <owned-seed-root>
tt-storm arm seed-validation --campaign <campaign-dir>
tt-storm arm seed-validation --campaign <campaign-dir> --seed-validation-matrix <recorded-matrix.json>
```

`arm aged-state` exits 3 on a refused seed root (`TT_SEED_ROOT_REFUSED` /
`TT_SEED_SNAPSHOT_INVALID` / `TT_ARM_STATE_NOT_PREPARED`) and 4 without a
`--seed-root`.  `arm seed-validation` requires a prior `arm aged-state`
receipt, verifies the installed DB sha256 still equals the adopted snapshot,
runs the seed tooling's routing matrix + O12 over the installed state (or
replays `--seed-validation-matrix` offline), records
`arming/seed-validation.json`, and exits 3 when the gate blocks / 0 when armed /
4 for usage.  Both phases are launch-free and leave the campaign prepared and
unqualified.

### 6.3 Spec clarification — seed-validation arming rule (Igor 2026-09-23)

Igor's 2026-09-23 authorization fixed the seed-validation gate semantics.  The
rule is recorded verbatim (single shared constant `SEED_VALIDATION_ARMING_RULE`
in `torture-test/bin/tt-storm-seed-validation.mjs`; emitted in the arming
output, persisted in `arming/seed-validation.json`, and quoted here as a SPEC
CLARIFICATION attributed to Igor 2026-09-23):

Seed-validation arming rule (Igor 2026-09-23, verbatim): the gate blocks ONLY on FAIL rows of seed-integrity class (referential breakage, orphaned rows, unreadable events); NOT_RUN/NOT_EVALUABLE rows are carried into the campaign; policy-class product findings (e.g. O12 timestamp legs) are recorded with counts and do not block.

Classification: `O1`/`O4`/`O6`/`O7` FAIL and the `O12` structural legs
`R1`/`R2`/`R4`/`R5` FAIL are seed-integrity (BLOCKING).  An `O12` row whose
ONLY failing leg is `R3` (timestamp-uniformity) is policy-class: it is recorded
with counts and does not block.  `NOT_RUN`/`NOT_EVALUABLE`/`ERROR` rows are
carried into the campaign and are never treated as failures; an unknown-oracle
FAIL is fail-closed seed-integrity.  This clarification fixes the GATE
interpretation only — it does not reword any earlier pin in this contract.
