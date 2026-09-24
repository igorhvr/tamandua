# O12 — DB-integrity oracle (post-batch, torture-only)

O12 implements spec 03 `03-oracles.md` §"O12 — DB invariants (post-batch)" as a
real executable on the tamandua torture oracle harness. It is a **hygiene /
aged-state validation prerequisite**, not a tenth campaign-gating hook.

## Identity and posture

| | |
|---|---|
| Executable | `torture-test/oracles/O12` |
| Evaluator | `torture-test/oracles/lib/o12.mjs` (`evaluateO12`) |
| Spec | `tamandua-torture-test-spec/03-oracles.md` §O12 |
| Gating | **NO** — `GATING_ORACLE_IDS` is untouched (`O1,O2,O3z,O4,O8,O9,O10,O11,O16`) |
| Context/evidence registration | `torture-test/bin/oracle-context.mjs` → `REQUIRED_ORACLE_EVIDENCE.O12 = ['database_snapshot']` (the only additive shared-context change) |
| Required evidence | immutable read-only `database_snapshot` (whole campaign TT DB) |
| Own post-batch input | `o12-reserved-baseline.json` sidecar in the oracle evidence dir (or `TT_O12_BASELINE`) — host-owned, versioned separately, NOT part of the version-1 `mechanical_evidence` key set |
| Scope | every run row in the snapshot (the aged DB), or the explicitly host-admitted subset (see scope contract below) |

**Why a separate sidecar input instead of a new `mechanical_evidence` key?**
`torture-test/oracles/CONTRACT.md` pins the version-1 evidence-key set and
states that *adding a further key requires a contract-version change* — a
broad migration across the nine gating hooks that Storm O12 explicitly
forbids. The reserved-key baseline is consumed only by O12, so it rides next
to the context as a read-only regular file in `TT_ORACLE_EVIDENCE_DIR` under a
fixed, documented name, opened through the same containment checks as all
oracle evidence. Nothing else in the shared loader changes.

## Read-only discipline

- The DB is opened **only** via `openEvidenceDatabase` (`node:sqlite
  DatabaseSync { readOnly: true }`, controller-pinned SHA-256, writable-file
  refusal). `getDb()` / `migrate()` are never used; the snapshot is never
  mutated.
- Evidence writes go through the shared exclusive-create contained writer
  under `TT_ORACLE_EVIDENCE_DIR` — exactly one artifact
  (`o12-db-integrity.json`) per successful invocation.
- A rejected/malformed path is never followed, even for an error report.

## Obligations (legs) and verdict semantics

Per-leg result vocabulary is `PASS | FAIL | NOT_EVALUABLE` plus whole-oracle
`ERROR` for malformed snapshots/inputs (missing core tables/columns, or a
present-but-unusable reserved-key baseline, fail closed — missing required
schema can never produce a vacuous PASS). Overall mapping:
**FAIL dominates NOT_EVALUABLE dominates PASS**, so a concrete product finding
is never hidden behind an unavailable leg, and a missing leg is never relabeled
PASS.

| Leg | Obligation | Notes |
|---|---|---|
| R1 | Structural integrity + orphans | `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and explicit orphan probes for declared AND undeclared dependent columns (`steps.run_id`, `stories.run_id`, `steps.current_story_id→stories.id`, `run_worktrees.run_id`, `story_abandonments.run_id/.story_id`, `suite_results.run_id` with `run-` prefix canonicalization). Every orphan-matrix row is recorded with its own status (`PASS`/`FAIL`/`NOT_EVALUABLE`) and table/column present flags; an absent child/parent table or column leaves that sub-check `NOT_EVALUABLE` — it is never silently skipped, so R1 cannot vacuous-PASS with an unrun probe. Exact supported schema metadata recorded per snapshot `user_version` (see "Supported schema versions"); the declared type/default of every version-added column is judged from `PRAGMA table_info` (a declared-shape mismatch is a finding that makes R1 FAIL); R1 is EVALUABLE for every supported version, and an unsupported `user_version` or a shape this build cannot judge fails closed as a whole-oracle `ERROR` (never R1 `NOT_EVALUABLE`, never PASS). **Exact totals:** `orphan_count` is the full count over every child row, never the capped sample length (7 orphans report 7 even though ≤5 samples are emitted). The `runs.matchlock_policy` **value** sub-check is also owned by R1 (see "matchlock_policy value validation" below): its `policies_checked` / `valid_policies` / `native_runs` / `invalid_policy_count` are exact full totals over every run row of the universe, kept separate from the capped (≤5) sample list. |
| R2 | `run_number` uniqueness | Uniqueness + positive-integer presence judged on **present rows only**. Native allocation is `COALESCE(MAX(run_number),0)+1` (run.ts INSERT subquery): deleting the newest row lets a later run reuse that number. That is **characterization, observed on the REAL creation/deletion APIs** (see behavioral probes below), never a monotonicity failure. |
| R3 | Timestamp shape / instant / ordering | Raw DB values only (never pre-canonicalized context). Per-column shape inventory, native-family mix detection (JS ISO-8601 vs SQLite `datetime('now')` — a TIME finding, recorded not waived), pair format mismatch on created/updated, and instant ordering `created_at ≤ updated_at` with same-second indeterminacy resolved in the row's favor. Syntactic format and instant ordering are separate sub-checks. |
| R4 | Context JSON + reserved keys | Parseability/type of `runs.context` for every row (exact `parse_failure_count`/`type_failure_count`, bounded samples), plus final-state reserved-key integrity against the **host-owned** baseline/probe input under the **complete independently admitted scope** contract below. Exact counters are kept separate from capped samples (`keys_checked`, `runs_compared`, `overwrite_count`, coverage-gap totals). |
| R5 | Serial composite state | Only legal simultaneous executable (pending/running) pair: a `verify_each` stories-loop coordinator parked raw `running` with `current_story_id NULL` and its **declared** verifier (`loop_config` `verify_each`/`verify_step`, same run) pending/running. Ownership is run-scoped. Judged on RAW stored statuses; the DISP display mapping (`verifying`) is honored as presentation only. |
| R6 | Coverage record | Explicit per-obligation coverage/result matrix in every evidence file; every unsupported or missing leg stays visible. |

## Supported schema versions

`lib/o12.mjs` exports `O12_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([9, 10, 11, 12, 13, 14])`
and a per-version schema descriptor (`O12_SCHEMA_DESCRIPTORS`) carrying the
required `runs`/`steps`/`stories` columns, the declared shape (type + default) of
every version-added column, the declared/undeclared FK-orphan matrix, the judged
timestamp columns and the ordering pairs. R1 resolves the descriptor for the
snapshot's `PRAGMA user_version` (through `resolveO12SchemaExpectation`, which
also classifies the dual v12 lineage), so each version is judged against its own
column universe and R1 is EVALUABLE for every supported version. The structural
schema observation records `user_version`, `supported_user_versions`, the
observed `lineage`, its `lineage_discriminators` (which discriminator columns the
store actually carries) and the per-column `column_declarations` checks.

**The union chain (derived read-only from the product's `src/db.ts applySchema`
and `detectSchemaLineage()` in the union port —
`git show refs/remotes/src/union-port:src/db.ts`):**

| Version | Chain step | Columns added | O12 requirement |
|---|---|---|---|
| 9 | base | — | `applySchema` CREATE TABLE set |
| 10 | TIME-STORAGE | **none** | `migrateInstantsToIsoZ()` rewrites naive instants; the v10 universe IS the v9 universe |
| 11 | REROUTE-BUDGET | `steps.target_moved_reroute_count INTEGER DEFAULT 0` | required from v11 on |
| 12 | OUTAGE-ROUNDS | `steps.preclaim_death_count INTEGER NOT NULL DEFAULT 0` | required (main lineage + v13/v14) |
| 13 | MATCHLOCK-UNION-4 | `runs.matchlock_policy TEXT` (nullable) | required from v13 on |
| 14 | LEDGER-DIAG | `suite_results.log_path TEXT` (nullable, **non-core**) | the runs/steps/stories core universe equals v13's; the v13/v14 union columns stay required |

**v10 correction (IMPORTANT).** An earlier O12 build read v10 as the Matchlock
branch's own `SCHEMA_VERSION 9 → 10` bump that added
`runs.matchlock_policy TEXT` (`git show
remotes/origin/integration/matchlock-20260915:src/db.ts`). The union renumbers
that column as the `12 → 13` step, so **v10 adds no column** and a v10 snapshot
**does NOT have to carry `runs.matchlock_policy`** — such a snapshot is R1
EVALUABLE. A v10 store that does carry it (the pre-union Matchlock shape) is
still accepted, because descriptors state REQUIRED columns and extra columns are
never rejected. `steps`, `stories`, the orphan matrix, timestamp columns and
ordering pairs are unchanged across 9 and 10.

**Dual v12 lineage.** Before the union, the main lineage (`11 → 12`) and the
Matchlock lineage (its own numbering) both stamped `PRAGMA user_version = 12`
for DIFFERENT columns, so a v12 stamp is classified by its ACTUAL column shape
exactly like the product's `detectSchemaLineage()`:

| v12 shape | Reported lineage | Judged against |
|---|---|---|
| `steps.preclaim_death_count` present, `runs.matchlock_policy` absent | `main-v12` | the main chain: v11 universe + `preclaim_death_count` |
| `runs.matchlock_policy` present, `steps.preclaim_death_count` absent | `matchlock-v12` | the Matchlock universe: v10 universe + `matchlock_policy` (that line never had `target_moved_reroute_count`) |
| BOTH present | `v12-superset` | the union of both lineages' universes |
| NEITHER present | — | **whole-oracle `ERROR`** naming the missing discriminator columns |

**v13/v14 union requirements.** A v13 or v14 snapshot must carry BOTH
`runs.matchlock_policy` and `steps.preclaim_death_count` (and the v11/v12 chain
columns); a v13/v14 store missing either union column is a **whole-oracle
`ERROR`** (exit 2, zero evidence artifacts) naming the observed version and the
missing column, never NOT_EVALUABLE and never PASS. v14 (LEDGER-DIAG) adds only
the **non-core** `suite_results.log_path TEXT` (nullable) column — the absolute
path of the full suite log — so the v14 runs/steps/stories core universe is
exactly v13's and the column itself is a product fact (this oracle never
requires it, and `src/` is never touched).

**Declared type/default are judged, not assumed.** R1 reads `PRAGMA
table_info` for every version-added column in the selected universe and compares
its declared type and default with the chain's DDL. A mismatch is a judgeable
PRODUCT finding (`O12_SCHEMA_COLUMN_DECLARATION_MISMATCH`, recorded in
`coverage.R1.column_declaration_checks` with
`column_declaration_mismatch_count`) that makes **R1 FAIL** — never a
whole-oracle `ERROR`: the store is usable, its version number just promises a
column shape its DDL does not declare.

**Fail-closed unknown-version rule:** a snapshot whose `user_version` is
anything outside `{9, 10, 11, 12, 13, 14}` (e.g. 8 or 15) is a **whole-oracle
`ERROR`** — exit code 2, **zero evidence artifacts**, and an error message
naming the observed version and the supported set `{9, 10, 11, 12, 13, 14}`. It is
never R1 `NOT_EVALUABLE` and never PASS. The same fail-closed rule covers a
missing required column (a v13/v14 store without either union column, a v12 store
with neither lineage discriminator), so a malformed store can never pass
vacuously.

## `matchlock_policy` value validation (R1 sub-check)

`runs.matchlock_policy` stores the host-owned, immutable Matchlock
execution-isolation policy captured at run-creation admission (MTLK-ADMIT) as a
JSON string, or `NULL` for a **native** (non-Matchlock) run. The column VALUE is
judged as a **sub-check of R1** — no new leg is added, so the R1..R6 leg shape
is unchanged — for every snapshot whose version universe carries the column:
`v13`, and the Matchlock-lineage v12 shapes (`matchlock-v12`, `v12-superset`).

| Situation | O12 judgement |
|---|---|
| `NULL` / absent value | **native run**: VALID, counted in `native_runs`, never an invalid policy |
| complete version-2 record | VALID, counted in `valid_policies` |
| value that is not parseable JSON, or is not a JSON object | finding `O12_SCHEMA_MATCHLOCK_POLICY_INVALID` → **R1 FAIL** (exit 1, evidence still written) |
| missing required key, unknown key, wrong `version`/`backend`/enum value (`harness`, `workPathMode`, `submissionDshHomeSource`, `mountPolicyVersion`, `networkPolicyVersion`), wrong harness submission block, empty/invalid `workMounts`, non-finite/non-positive `resourceLimits`, credential-bearing key | same finding → **R1 FAIL** |
| universe without the column (v9, v10, v11, `main-v12`) | sub-check recorded `NOT_APPLICABLE` with a reason and the count of out-of-universe policy values (`out_of_universe_policy_rows`), **never** a failure and never a silent skip |

The judged key set is derived **read-only** from the union port's
`src/installer/matchlock/policy.ts` (`matchlockPolicyValidationErrors()`,
`MATCHLOCK_POLICY_VERSION`, `EXECUTION_ISOLATION_KEYS`,
`assertNoCredentialValues()`):
`version` 2, `backend` `"matchlock"`, `requestedImage`,
`resolvedImageDigest`, `resolvedImageConfigDigest`, `harness ∈ {pi, hermes,
dsh}` (each harness REQUIRES its own frozen submission block and FORBIDS the
other's: hermes → `hermes {homeDir, cwd, hermesHomeEnv}`; dsh →
`submissionHomeDir`, `submissionCwd`, `submissionDshHomeEnv`,
`submissionDshHomeSource ∈ {env, default}`), `configurationRoot`,
`configurationProfile` (bare file name), `guestConfigurationRoot`,
`workPathMode` `"host-absolute"`, `workingDirectory`, non-empty `workMounts` of
`{hostPath, hostRealPath, guestPath}` with `guestPath === hostPath`,
`originalRepositoryRoot` (null or string), `gitMetadataRoots`,
`mountPolicyVersion` 1, `networkPolicyVersion` 1 and `resourceLimits
{cpus, memoryMB, diskSizeMB}` (finite positive). `imagePath` is legal but never
required. The exported constants are
`O12_MATCHLOCK_POLICY_REQUIRED_KEYS` / `O12_MATCHLOCK_POLICY_OPTIONAL_KEYS` /
`O12_MATCHLOCK_POLICY_HARNESS_KEYS` / `O12_MATCHLOCK_POLICY_HARNESSES` /
`O12_MATCHLOCK_POLICY_CREDENTIAL_KEY_FRAGMENTS` / `O12_MATCHLOCK_POLICY_SAMPLE_CAP`,
the pure judge is `validateO12MatchlockPolicyValue(value)` →
`{ status: 'native' | 'valid' | 'invalid', errors }`, and the structural error
list for a parsed record is `o12MatchlockPolicyErrors(parsed)`.

A malformed policy is **judgeable product data, not an unjudgeable store**: the
sub-check never throws, so a hostile or truncated policy blob can never turn a
snapshot into a whole-oracle `ERROR`. The exact totals
(`policies_checked`, `valid_policies`, `native_runs`, `invalid_policy_count`)
are recorded — together with the bounded (≤5) `invalid_policy_samples` — in
**both** the structural observation (`observations[scope=structural]
.matchlock_policy`) and the R1 coverage record (`coverage.R1.matchlock_policy`,
`coverage.R1.matchlock_policy_invalid_count`). The representative
`O12_SCHEMA_MATCHLOCK_POLICY_INVALID` findings are bounded by the same sample
cap while the counts stay exact.

## Reserved-key scope contract (complete independently admitted scope)

The DEFAULT post-batch scope is **EVERY snapshot run**. A baseline can never
choose its own smaller denominator and label full-state integrity PASS. A
smaller scope is supported **only** as an explicit host admission
(`scope.mode: "explicit"` + `scope.run_ids` in the sidecar) and is **reported
as such** (`scope.snapshot_runs_outside_admitted_scope_count/_samples`) — never
a quiet escape. If a smaller scope is NOT host-admitted, every snapshot run is
in scope and each must carry complete host-captured expectations.

In explicit mode the admitted `scope.run_ids` universe is the **only** legal
run set for the baseline's own coverage: an `expected` or `expected_mutations`
entry naming a run outside `scope.run_ids` is a malformed cross-scope binding →
**ERROR** (it would otherwise be silently ignored — the in-scope loop never
reaches it). In the default all-snapshot mode a baseline may legitimately name
runs that are absent from the final snapshot (e.g. deleted after host capture);
those stale expectations cannot be compared and are **surfaced in the scope
record** (`scope.expected_runs_not_in_snapshot_count/_samples`, exact count +
bounded samples) rather than silently dropped.

For EVERY in-scope run O12 requires host-captured expected presence/absence
for the **ENTIRE** native reserved-key pin (17 keys, statically parity-pinned
against `src/installer/step-ops.ts`). **Values, missing keys and empty strings
are distinct.** "No key supplied" is never proof the key was originally absent,
and original expectations are never derived from the final context. Non-reserved
dictionary keys never count as reserved coverage. Run ids are canonicalized from
bare uuids or `run-<uuid>` aliases; duplicate/ambiguous/cross-scope alias
bindings are `ERROR`.

Semantics: **malformed supplied input → ERROR; unavailable coverage →
NOT_EVALUABLE; demonstrated divergence → FAIL.** FAIL dominates, so an existing
concrete finding survives another run's missing coverage leg. Legitimate
host-managed transitions (including presence changes) are preserved in the
pinned `expected_mutations` ledger; only `source: "host"` entries are accepted.

## Evidence

Single deterministic artifact: `o12-db-integrity.json` (kind
`sqlite-db-integrity`) under the oracle evidence dir, containing
`schema_version: 1`, `overall_result`, the `coverage` matrix (R1–R6), bounded
`observations` (counts/ids/key-names only — never full tasks, prompt bodies,
step output, or context values), and the sorted `finding_ids`.

## Finding IDs

`O12_STRUCT_INTEGRITY_FAILED`, `O12_STRUCT_FOREIGN_KEY_FAILED`,
`O12_STRUCT_ORPHAN`, `O12_RUN_NUMBER_DUPLICATE`, `O12_RUN_NUMBER_NULL`,
`O12_RUN_NUMBER_INVALID`, `O12_TIME_INVALID`, `O12_TIME_MIXED_NATIVE_FORMAT`,
`O12_TIME_PAIR_FORMAT_MISMATCH`, `O12_TIME_ORDER_VIOLATION`,
`O12_CONTEXT_UNPARSEABLE`, `O12_CONTEXT_TYPE_INVALID`,
`O12_RESERVED_KEY_OVERWRITE` (carries `kind`: `value-changed` |
`key-introduced` | `key-removed`), `O12_SERIAL_COMPOSITE_VIOLATION`.

## Reserved-key baseline input (caller API)

- Location: `TT_ORACLE_EVIDENCE_DIR/o12-reserved-baseline.json`, or an
  absolute path in `TT_O12_BASELINE`. Must be a read-only regular
  non-symlink file contained beneath the campaign root; its SHA-256 is
  computed and recorded in the `o12-db-integrity.json` evidence.

### schema_version 2 (current, RECOMMENDED for all producers)

```json
{
  "schema_version": 2,
  "captured_at": "<UTC ISO-8601 Z>",
  "producer": "host",
  "scope": {
    "mode": "all-snapshot-runs" | "explicit",
    "run_ids": ["<bare run uuid>", "..."]      // required only when mode=explicit
  },
  "supported_reserved_keys": ["repo", "...17 keys, must equal the native pin..."],
  "expected": {
    "<bare run uuid | run-<uuid> alias>": {
      "<reserved key>": { "presence": "present", "value": "<string>", "provenance": "host" }
                     | { "presence": "absent", "provenance": "host" }
    }
  },
  "expected_mutations": {
    "<bare run uuid>": {
      "<reserved key>": { "presence": "present", "value": "<string>", "source": "host" }
                     | { "presence": "absent", "source": "host" }
    }
  }
}
```

- `scope.mode: "all-snapshot-runs"` (default) puts EVERY snapshot run in
  scope. `"explicit"` is the only supported smaller scope and must be host
  declared via `run_ids`; snapshot runs outside it are surfaced in the record
  (`snapshot_runs_outside_admitted_scope_count/_samples`). **Explicit-mode
  verdict semantics (permissive, reported-as-such):** the reserved-key verdict
  covers the admitted universe only — an out-of-admission snapshot run is
  reported, never judged against a baseline the host did not admit it to, and
  does not by itself downgrade the leg. The stricter alternative reading
  ("full-state integrity PASS cannot be claimed while any snapshot run sits
  outside the admission") is intentionally NOT adopted because the smaller
  scope is explicit, host-declared and surfaced as such (never a quiet escape);
  this is a root-confirm design choice recorded in the close contract.
- Every scope record carries `scope.full_snapshot_covered` (boolean): it is
  `true` ONLY when the comparison covered the ENTIRE snapshot — every snapshot
  row compared over the complete 17-key pin (exact totals: `runs_compared`
  equals the snapshot row count and `keys_checked` equals 17 × that count),
  with no out-of-admission snapshot run and no admitted-but-absent run in
  explicit mode. It records comparison COVERAGE, not the verdict: a fully
  compared FAIL (demonstrated divergence) is still full coverage, while an
  explicit-subset PASS is `false` — a deliberately host-admitted subset may
  PASS only its clearly labelled scoped result and never claims full-snapshot
  integrity. All-snapshot qualification requires ALL rows × ALL 17 keys.
- `o12.test.mjs` mirrors that predicate EXACTLY on every fixture scope record
  (whole-snapshot × whole-pin exact totals, in-scope equality, and the
  explicit-mode no-ghost condition — a naive mirror computed from
  `runs_compared`/`keys_checked` alone would mis-flag correct lib behavior on
  the pinned corner fixture `o12-close-scope-explicit-ghost-fully-compared`,
  where an explicit admission names an admitted-but-absent run while every
  snapshot row is fully compared: `full_snapshot_covered` stays `false`).
- In explicit mode every run named in `expected` or `expected_mutations` MUST
  be inside `scope.run_ids` — an entry outside the admitted universe is a
  malformed cross-scope binding → `ERROR` (never silently ignored).
- In default `all-snapshot-runs` mode, baseline entries for runs absent from
  the snapshot (deleted after capture) are surfaced in the scope record
  (`expected_runs_not_in_snapshot_count/_samples`) — never silently dropped.
- Every in-scope run's `expected` entry must cover the **entire** pin with
  typed presence/absence (`provenance: "host"` per entry). Present entries pin
  an exact string value (`""` is a legitimate distinct value); absent entries
  pin a host-captured known absence.
- `expected_mutations` records explicit legitimate host-managed transitions
  (value changes and presence changes present↔absent) pinned with the exact
  final state; `source` must be `"host"`.
- A run whose expected entry is missing or partial, or whose stored context
  cannot be parsed, leaves that coverage unavailable → the leg is
  `NOT_EVALUABLE` (unless a demonstrated divergence already FAILs it). An input
  that is malformed (bad JSON/schema/presence/provenance/alias duplicates/
  non-reserved keys in v2 expected/wrong producer/drifted key set/unknown
  scope mode/cross-scope expected-or-mutation bindings outside an explicit
  admission) is `ERROR`.

### schema_version 1 (legacy — presence-only)

```json
{
  "schema_version": 1,
  "captured_at": "<UTC ISO-8601 Z>",
  "producer": "host",
  "supported_reserved_keys": ["repo", "..."],
  "runs": { "<run id>": { "<reserved key>": "<string value>", "..." } },
  "expected_mutations": { "<run id>": { "<key>": { "to": "<value>", "source": "host" } } }
}
```

- v1 enumerating a key asserts it was **present** with that value; it CANNOT
  prove absence (unenumerated keys assert nothing). Scope for v1 is always the
  default (every snapshot run), so **incomplete v1 can never PASS** — the
  legacy-migration rule is: only *complete authoritative* v1 data (every
  in-scope run enumerating the entire pin) may PASS; otherwise
  `NOT_EVALUABLE`. Non-reserved keys in a v1 entry are ignored and counted
  (`non_reserved_keys_ignored`), never counted as reserved coverage.

### Producer / caller instructions (run43 aged-state builder, and storm assembly)

1. **Capture at creation time.** Immediately after each real run is created
   through the product launch API, read the run row's `context`, and for each
   of the 17 reserved keys record typed presence/absence of what **host code
   wrote** — never what you hope an agent will leave alone, and never by
   reading a later snapshot.
2. **Scope admission.** Either admit every run you tracked with
   `scope.mode: "all-snapshot-runs"` and provide complete expectations for all
   of them, or declare the exact tracked subset with
   `scope.mode: "explicit"` + `run_ids`. O12 reports out-of-admission snapshot
   runs; if runs exist that you did not track, prefer `"explicit"` over an
   incomplete all-mode file. Keep `expected`/`expected_mutations` strictly
   inside the admitted `run_ids` in explicit mode (cross-scope entries are
   ERROR), and keep default-mode files aligned to the snapshot: stale expected
   runs for snapshot-absent runs are surfaced, not compared.
3. **Ledger every legitimate later host write.** If host code later rewrites a
   reserved key in-process (e.g. the rewrite detector introducing
   `test_cmd_review_*`, a worktree path backfill, a host removal), append the
   exact transition to `expected_mutations` with `source: "host"`.
4. **Keep the file read-only** (`0o400`), contained beneath the campaign root,
   `producer: "host"`, and `supported_reserved_keys` equal to the native pin.
5. Consumers that only hold legacy incomplete v1 data must migrate to
   complete v2 (or accept `NOT_EVALUABLE`); v1 partial data never yields PASS.

## Calibration / gate

- `torture-test/oracles/self-test/o12.test.mjs` is the focused gate: runs the
  real `O12` executable per fixture against immutable SQLite snapshots,
  asserts the stdout/exit contract, per-leg coverage, findings, exact-counter
  discipline, the complete-scope reserved-key contract (v1 legacy + v2), and
  **zero unintended writes** (snapshot hash + directory immutability), pins
  the reserved-key set against `src/installer/step-ops.ts`, and drives the
  owned behavioral probes.
- `torture-test/oracles/self-test/generate-o12-fixtures.mjs` builds 80
  fixtures (positive + negative per obligation, root-counterexample mirrors,
  malformed-evidence `ERROR` shapes, exact-total controls with 7+ items,
  cross-scope explicit-admission ERROR controls, stale-baseline observability
  controls, the v1/v2 reserved-key scope matrix, the explicit-mode
  ghost-admission corner `o12-close-scope-explicit-ghost-fully-compared`
  pinning `full_snapshot_covered=false` under a whole-snapshot × whole-pin
  comparison that also names an admitted-but-absent run, and the schema 9..14
  matrix): the DEFAULT fixture DDL is the schema-13 union chain, `PRAGMA
  user_version = 13` with `runs.matchlock_policy` present AND
  `steps.target_moved_reroute_count`/`steps.preclaim_death_count` present (the
  explicit v14 shapes additionally carry `suite_results.log_path`).
  Each fixture is built from a per-version/lineage SHAPE
  (`schemaShape` + `SCHEMA_SHAPES`: v9 base, v10 = the v9 universe, v11 = v10 +
  `target_moved_reroute_count`, v12-main = v11 + `preclaim_death_count`,
  v12-matchlock = v10 + `matchlock_policy`, v13 = the union, v14 = v13 + the
  non-core `suite_results.log_path`) and records that
  shape in its `expectation.json` (`schema`), so a stamp that deliberately
  disagrees with its column universe is visible rather than implied. The matrix
  covers a raw **v9** compatibility fixture (`o12-schema-v9-compat`), both v10
  shapes (the union-chained `o12-schema-v10-missing-matchlock-policy` PASS case
  carrying NO `matchlock_policy`, and the pre-union Matchlock-lineage
  `o12-schema-v10-matchlock-policy` PASS case that carries a populated value
  outside the v10 policy universe), `o12-schema-v11`, the three v12 lineages
  (`o12-schema-v12-main`, `o12-schema-v12-matchlock` — which DOES judge a valid
  policy — and the fail-closed `o12-schema-v12-neither-lineage`), the v13 store
  with a NULL/native policy (`o12-schema-v13-native`), a complete valid policy
  (`o12-schema-v13-matchlock-present`), a present-but-malformed policy
  (`o12-schema-v13-matchlock-invalid`, a judgeable FAIL, never an ERROR) and the
  two missing-union-column fail-closed cases (`o12-schema-v13-missing-preclaim`,
  `o12-schema-v13-missing-matchlock-policy`), the v14 LEDGER-DIAG positive
  control (`o12-schema-v14-native`) and its missing-union-column fail-closed
  case (`o12-schema-v14-missing-preclaim`). The unknown-`user_version`
  controls are `o12-schema-version-unsupported-15` (14 is supported now) and
  `o12-schema-version-unsupported` (8, below the base schema); both expect a
  whole-oracle ERROR. The valid policy samples are self-checked at generation
  time against the oracle's own `validateO12MatchlockPolicyValue`, so a fixture
  claiming a valid policy can never silently drift into an invalid one. The
  generator writes a retained `generation-receipt.json` (recording
  `fixture_count`, `default_user_version: 13` and the oracle's own
  `supported_user_versions`) and never removes a prior workspace.
- `o12-run-number-probe.mjs` — **REAL-API** run_number characterization on a
  fresh private state: createA/createB through the product's `runWorkflow`,
  exact owned run-B deletion through `deleteWorkflow`, createC, read-only
  live-row uniqueness/MAX+1 result. A narrowly labeled non-dispatching
  registration TRANSPORT stub (random loopback port) answers the control-plane
  health/register/nudge/terminate calls so no agent/model/run is ever spawned;
  candidate src and stable dist source match is verified. Retained workspace +
  receipt, no disposal.
- `o12-run-number-allocator-calibration.mjs` — retained, explicitly named
  **SQL-replica** allocator replay (self-pinning against
  `src/installer/run.ts`). Calibration only — never a substitute for the
  real-API observation above.
- `o12-reserved-key-probe.mjs` — real step-ops `completeStep` probe (isolated
  private state, `TAMANDUA_TEST_GUARD=1`, stable pinned dist) proving **all
  seventeen** reserved keys (including the four worktree keys
  `worktree_path`/`worktree_origin_repository`/`worktree_origin_ref`/
  `worktree_origin_sha`) survive malicious agent output: one owned run seeds
  every reserved key present (overwrite attempts must preserve values
  byte-for-byte) and a second owned run seeds none (introduction attempts must
  leave the keys absent). Expected/attempted/checked reserved-key sets are
  independently enumerated and asserted equal; exact per-key coverage is
  reported. All seeded/attempted values are freshly owned paths under the
  probe root (never fixed external `/tmp/harness-a`/`/tmp/harness-b` paths),
  candidate/stable-dist source match is verified BEFORE any fixture allocation
  or product import/operation, parent Tamandua run/worker/step authority is
  stripped, and the exact owned DB handle close is positively observed (an
  injected close error makes the probe non-green). Retained workspace +
  receipt, no disposal.
- `o12-run-number-probe.mjs` — **REAL-API** run_number characterization on a
  fresh private state: createA/createB through the product's `runWorkflow`,
  exact owned run-B deletion through `deleteWorkflow`, createC, read-only
  live-row uniqueness/MAX+1 result. A narrowly labeled non-dispatching
  registration TRANSPORT stub (random loopback port) answers the control-plane
  health/register/nudge/terminate calls so no agent/model/run is ever spawned;
  candidate src and stable dist source match is verified BEFORE fixture
  allocation, and parent run/worker/step authority is stripped. The exact
  owned listener and DB handles are closed and their closure POSITIVELY
  observed — injected close error / unknown-close-timeout negatives
  (`O12_PROBE_INJECT_DB_CLOSE_ERROR` / `O12_PROBE_INJECT_LISTENER_CLOSE_TIMEOUT`)
  make the probe non-green. Retained workspace + receipt, no disposal.
- Isolation/closure negatives (`o12.test.mjs`, run before the real native
  probes): a swallowed close error or unknown close timeout can never
  masquerade as a closed receipt — each injected run must exit nonzero and
  report the owned handle's closure as NOT observed.
- Caller-env portability contract (Storm O12-ENV): the gate never spreads its
  own ambient environment into probe children, so the gate result cannot depend
  on whatever authority the gate's own caller happens to inherit (a live
  Tamandua run vs a clean independent caller). Every probe child runs under an
  explicitly constructed allow-list env; the clean-caller probe tests assert
  that the reported removed parent-authority names equal the names actually
  injected (empty removal is the correct, legitimate clean-caller result), and
  a dedicated contaminated-caller fixture injects only clearly fake non-live
  sentinel values (`TAMANDUA_RUN_ID`/`TAMANDUA_WORKER_PID`/`TAMANDUA_WORKER_PGID`/
  `TAMANDUA_WORKER_JOB_ID`/`TAMANDUA_CONTROL_PORT`) and asserts each native
  probe reports removing exactly those injected names while staying green under
  a private effective environment. Live run IDs, worker PIDs/PGIDs, jobs,
  control ports, provider keys and reporting env are never forwarded into
  tests.
- Stable-dist resolution (STORM-SEED-QUALIFY US-010): the "stable pinned
  product build" the probes import and the gate's `source_matches_dist` guard
  compares against is resolved REPO-RELATIVELY — the candidate checkout's own
  built `dist/` (probe default `path.join(REPO_ROOT, 'dist')`, gate child env
  `STABLE_DIST`). It is never the absolute host path `/opt/tamandua/dist`: that
  path only matched when the repo WAS the host's live install, and it makes the
  candidate/stable byte-equality guard refuse every candidate branch on a host
  whose live install is a different product lineage (the O12-ENV pin was
  introduced as a hardcoded absolute path; the gate now resolves it from its own
  location). The guard still verifies the compiled `dist/installer/*.js` carries
  the pinned reserved-key set / allocator statement, so a stale or drifted
  repo build is still refused. An explicit `TAMANDUA_O12_PROBE_DIST` still
  overrides an external pinned build for direct probe invocation. Red-arming
  self-test: "O12 stable dist is the repo-built product dist (host-portable
  pin, not /opt/tamandua)".
- Cleanup discipline: the O12 gate and probes never run recursive filesystem
  disposal; every generated workspace/probe root is retained with a JSON receipt
  (root identity/path/ino) and its path echoed on stderr. Fixture/O12 workspaces
  stay under `torture-test/var`; probe scratch roots are placed outside the
  product guard's real-state prefix when necessary (see next bullet).
- Scratch-directory policy (Storm O12-REPIN US-003): the product TEST
  ISOLATION guard (`src/lib/test-guard.ts` `assertStatePathIsolation`) refuses
  any state path under the REAL user home's `~/.tamandua` while
  `TAMANDUA_TEST_GUARD=1`, using `os.userInfo().homedir` (a private `HOME` does
  not help). A tamandua-run worktree lives at
  `~/.tamandua/worktrees/<repo>/...`, so a probe scratch workspace created
  under `torture-test/var` is real state to the guard and every product
  `getDb()` in a probe child is refused. `o12-scratch.mjs` centralizes the
  decision: `scratchBaseOutsideRealState()` returns `torture-test/var` when it
  is safe and otherwise a fresh retained `oracle-self-test.*` dir under the OS
  temp dir, and `safeProbeTmpdir()` supplies probe children a private TMPDIR
  outside that prefix. The fixture/O12 snapshot machinery is unaffected (it
  opens SQLite read-only via `node:sqlite`, never `getDb()`/`migrate()`), so
  fixture workspaces remain under `torture-test/var`. No `src/` file is edited.
- Retained self-test evidence (Storm O12-REPIN US-003):
  `o12-fixture-matrix.mjs` generates the fixture set and writes a retained
  `o12-fixture-matrix.json` mapping every generated fixture to its expected
  result, observed result, exit code, exit-expectation, immutable snapshot
  SHA-256 and evidence writes, and surfaces the eight O12-CLOSE correction cases
  (the seven named fixtures plus the run-number allocator characterization from
  the real-API + SQL-replica probes). `run-o12-gate-self-tests.mjs` runs each
  O12 self-test entry ALONE, in its own process, under the explicit gate env
  (`TAMANDUA_TEST_GUARD=1`, `TAMANDUA_PI_BINARY`/`TAMANDUA_HERMES_BINARY`/
  `TAMANDUA_DSH_BINARY=/usr/bin/false`, repo-built dist) and retains per-entry
  stdout/stderr logs, `results.tsv`, `o12-gate-self-tests-summary.json` and the
  matrix under `torture-test/var/results/o12-gate-self-tests-*`.
  `o12-gate-report.mjs` holds the pure report shaping/validation;
  `o12-gate-self-tests.test.mjs` unit-tests it and validates the newest retained
  run (`TAMANDUA_O12_GATE_RESULTS` overrides the results dir).
- Seed-snapshot acceptance run (Storm O12-REPIN US-004):
  `o12-seed-snapshot.mjs` is the acceptance runner for the aged-state seed. It
  copies the retained immutable snapshot
  (`db-full-post-2026-09-15T07-22-31-764Z.sqlite`) and the host-owned
  `o12-reserved-baseline.json` sidecar from the READ-ONLY retained seed root
  into a fresh `torture-test/var/results/o12-seed-snapshot-*` directory, keeps
  the copies read-only (`0o444`), builds the shared version-1 invocation context
  (`source: 'aged-state-seed'`, `database_snapshot` reference with the copied
  snapshot's sha256, `TT_O12_BASELINE` → the copied sidecar) and runs the REAL
  working-tree `torture-test/oracles/O12` executable over the copy. It never
  writes into the retained root and re-verifies the source hashes/mtimes after
  the run. The published `seed-snapshot-matrix.json` records the R1–R6 matrix
  with exact counts, the copied-artifact sha256s and the R3 attribution, plus
  the full stdout/stderr and the emitted `o12-db-integrity.json`.
  **Retained-seed matrix (user_version 10):** R1 PASS (`integrity_check` ok,
  0 FK violations, 0 orphans, 0 NOT_EVALUABLE orphan probes — R1 is EVALUABLE
  because this build supports every schema version 9..14, `{9, 10, 11, 12, 13, 14}`),
  R2 PASS (5000 runs, 0 duplicates), R3 FAIL
  (24166 created_at/updated_at cross-writer pairs = 5000 runs + 19166 steps;
  `steps.updated_at` is 19166 SQLite-native + 7360 ISO of 26526), R4 PASS
  (5000 runs, 85000 keys checked, 0 overwrites, 150 host transitions),
  R5 PASS (0 illegal pairs), R6 overall FAIL because only R3 FAILs. The R3 FAIL
  is the **native product TIME defect** (bead `tamandua-6sy.31` / TZPI
  `tamandua-6sy.27`) — NOT seed corruption and NOT a validator defect; R3's
  semantics/label are unchanged. `o12-seed-snapshot.test.mjs` unit-tests the
  pure shaping/validation and the supplementary read-only pair breakdown, then
  drives the real oracle over an owned copy and validates the newest retained
  summary (`TAMANDUA_O12_SEED_ROOT` / `TAMANDUA_O12_SEED_RESULTS` override the
  source/results roots).
- Owned-store acceptance (O12-SCHEMA-13 US-004): the seed campaign is
  regenerated on the current product build (schema 13) while older seeds stay
  stamped 9..12, so the oracle must judge every one of them with R1 EVALUABLE.
  `o12-seed-snapshot.mjs` builds an **owned store per supported version and per
  v12 lineage** (`OWNED_STORE_CASES`: 9, 10, 11, 12-main, 12-matchlock, 13) from
  DDL derived from the oracle's OWN descriptors (`O12_SCHEMA_DESCRIPTORS` /
  `resolveO12SchemaExpectation`): the table/column universes come from
  `coreTables` and each version-added column carries the chain's declared
  type/default from `columnDeclarations`, so no store shape is retyped by hand
  and an oracle descriptor change moves the stores with it. Each store carries a
  complete typed v2 reserved-key baseline (both runs, the entire 17-key pin), a
  valid Matchlock policy on one run where the universe has
  `runs.matchlock_policy` (the other stays native/NULL), and both runs
  `completed`. The REAL executable judges each store; the per-case
  `owned-store-matrix.json`, the emitted `o12-db-integrity.json` and the
  aggregate `owned-store-acceptance-receipt.json` are retained under
  `torture-test/var/results/o12-owned-store-acceptance-*`. Expected: every case
  R1 PASS (EVALUABLE — never NOT_EVALUABLE), R2–R5 PASS, overall PASS, exit 0,
  with the structural observation recording the store's `user_version` and
  lineage. `materializeOwnedSeedSnapshots` writes the flat, read-only owned seed
  snapshots the gate consumes through `TAMANDUA_O12_SEED_SNAPSHOT`
  (`torture-test/var/seed-snapshot-v13.sqlite` and
  `torture-test/var/seed-snapshot-legacy-v12.sqlite`; `torture-test/var` is
  gitignored, so no binary store is ever committed).
- The shared mutation harness battery (`oracles/self-test/run.sh`) runs the O12
  fixtures through `harness.mjs` exactly like the gating oracles.
