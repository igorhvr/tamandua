# US-003: O9 (and O2/O3z) reconciliation scoping audit + shared scope contract

S26 story US-003: audit O9's suite-ledger reconciliation
(`torture-test/oracles/lib/o9.mjs`) and its row-resolution paths
(`readDatabaseLedger`, `readCaseBundleOrigins`, `isCurrentAttemptRow`, the
`O9_REPLAY_ROW_MISSING` path) for the same full-table/foreign-row class that
broke O10 (US-002), align the uncovered gaps so foreign-origin/stale rows are
annotated/skipped per S13 doctrine and never produce reconciliation errors or
false `O9_REPLAY_ROW_MISSING` findings; audit O2 (`o2.mjs`) and O3z (`o3z.mjs`)
to confirm or align their reconciliations; document the shared scope contract in
`torture-test/oracles/CONTRACT.md`.

**Audit conclusion (one paragraph):** O9's byte-for-field reconciliation was
already correctly scoped on BOTH sides (artifact and DB rows are filtered by the
case bundle origins ∪ current-attempt run set before the comparison, so
foreign/stale DB rows can never cause the reconciliation `ORACLE_RUNTIME_ERROR`),
and O2's reconciliation is likewise scoped by `caseBundle` on both sides
(`o2.mjs:411-416`), and O3z reads only `runs` + `tamandua_stats` (never
`suite_results`) — so only one gap existed: **the replay row-resolution path.**
A replay observation whose `ledger_row_id` cannot be found in the in-scope
ledger fired `O9_REPLAY_ROW_MISSING` unconditionally, including when the named
row was foreign/stale to the case (reused `var/fixtures/work/<case>/<fixture>`
origin paths across campaigns/attempts) or when the snapshotter could not
attribute the cache hit at all (`ledger_row_id: null` — the attempt-1 W4.01/W4.02
shape). The fix classifies every unresolved replay row: foreign/stale rows and
unresolved cache hits are annotated (`skipped_replay_row_ids` +
`skipped_replay_row_reasons`) and skipped per S13 doctrine, while a row id that
exists **nowhere** — neither in the artifact nor in the database snapshot — still
fires `O9_REPLAY_ROW_MISSING` (fail-closed invariant). Replaying attempt-1 and
attempt-2 evidence with the fixed oracle: W4.02 attempt-1 flips FAIL→PASS and
W4.01/W4.02 attempt-2 flip FAIL→PASS, with the unresolved cache hits annotated
and no `O9_REPLAY_ROW_MISSING`; W4.01 attempt-1 keeps only its (unrelated)
single-flight findings.

---

## 1. O9 audit — what was already scoped, what was not

### 1.1 Reconciliation is symmetric (artifact side vs DB side)

`evaluateO9` (o9.mjs) derives the case bundle exactly like the snapshotter and
O10: `readCaseBundleOrigins` = `{ launch_intent.gate_key.origin_repo } ∪
{ event.originRepo for every run_events row }`. On the **artifact side** the
ledger rows are partitioned into:

- `skippedForeign` — origin outside the bundle (foreign, S13),
- `skippedStale` — in-bundle but not a current-attempt row (stale, S21),
- `inScopeLedger` — the reconciliation set.

On the **DB side**, `readDatabaseLedger` applies the same two filters
(`bundleOrigins.has(origin_repo)` AND `isCurrentAttemptRow`) before the
byte-for-field comparison (`JSON.stringify(inScopeLedger) !==
JSON.stringify(databaseLedger)` → `ORACLE_RUNTIME_ERROR`). So foreign/stale DB
rows were **already** excluded from the comparison and could never throw — the
O10-style full-table defect did not exist in O9's reconciliation. The audit
**verified the two sides are exactly symmetric** (same bundle-origin filter, same
current-attempt filter, same `suiteRowShape` normalization, deterministic `id`
ordering).

### 1.2 The gap: the replay row-resolution path

`rowsById` is built from `inScopeLedger` only. Every replay observation
(`ledger_row_id` named by the shim's cache hit) was resolved through it, and an
undefined result fired `O9_REPLAY_ROW_MISSING` unconditionally. Three classes of
**false** findings resulted (verified on attempt-1/-2 evidence, see §3):

1. **Foreign/stale rows in the DB or artifact** — a replay names a row whose
   origin is outside the case bundle (sibling case or reused cross-campaign
   fixture path) or whose run id belongs to a prior attempt. The row exists, but
   it is not part of the case's scoped evidence (S13/S21 doctrine) — the finding
   was false.
2. **Unresolved cache hits (`ledger_row_id: null`)** — the snapshotter could not
   attribute the shim's green cache hit to any row in the scoped artifact (the
   row was re-recorded/deleted by shim row hygiene before the snapshot, or was
   foreign/stale). The shim mechanically observed the cache hit (`TAMANDUA-TEST
   CACHED` marker, exit 0), so the replay is a mechanical fact; only the
   attribution is missing. `O9_REPLAY_ROW_MISSING` was false here too.
3. **Genuinely absent row id** — a positive id that exists in neither the
   artifact nor the database snapshot. Mechanically unreachable through the
   snapshotter (it only emits ids resolved from scoped artifact rows), kept as a
   fail-closed defensive invariant.

### 1.3 The fix (o9.mjs)

- `readDatabaseLedger` now returns `{ all, scoped }`: the full normalized
  `suite_results` projection plus the scope-filtered projection. The
  reconciliation still compares the scoped projections byte-for-field.
- DB-side foreign/stale rows are now annotated in the evidence exactly like the
  artifact-side skips: `skipped_db_foreign_rows`/`skipped_db_foreign_row_ids`
  and `skipped_db_stale_rows`/`skipped_db_stale_row_ids` (additive fields; the
  existing artifact-side fields are unchanged).
- New `classifyUnresolvedReplayRow` resolves a replay whose `ledger_row_id` is
  missing from the in-scope ledger: artifact row in `skippedForeign` →
  `foreign-origin`; artifact row in `skippedStale` → `stale-attempt`; DB row
  (by id) → `foreign-origin`/`stale-attempt` by origin; `null` →
  `unresolved-cache-hit`; anything else → `null` (genuine missing → keep
  `O9_REPLAY_ROW_MISSING`). Skipped replays are annotated as
  `skipped_replay_rows` (count), `skipped_replay_row_ids`,
  `skipped_replay_row_reasons`.
- The marker/tree checks that do not depend on the resolved row (cache marker,
  unchanged committed tree with exit zero) still run for every replay, including
  skipped ones.

## 2. O2 and O3z audit — confirmed, no changes needed

### 2.1 O2 (o2.mjs:411-416)

```js
const suiteRows = readSuiteLedger(...).filter((row) => caseBundle.has(row.origin_repo));
const bundleDatabaseSuiteRows = databaseEvidence.suiteRows.filter((row) => caseBundle.has(row.origin_repo));
if (!sameSuiteRows(bundleDatabaseSuiteRows, suiteRows)) throw new OracleRuntimeError(...);
```

`caseBundle` = `{ launch_intent.gate_key.origin_repo } ∪ { event origin from
every run_events row }` — the shared case-bundle scope. **Both sides** are
filtered by `caseBundle` before the byte-for-field comparison, so sibling-case
rows cannot contaminate O2 either. **Conclusion: confirmed scoped — no change.**

### 2.2 O3z (o3z.mjs)

`readDatabase` reads only `runs` (`id`, `status`, `tokens_spent`) and
`tamandua_stats` (`system_tokens_spent`); `readSystemSnapshot` reads the
`system_tokens_before`/`system_tokens_after` artifacts. **O3z never reads
`suite_results`** — there is no suite-ledger reconciliation to scope.
**Conclusion: confirmed — no change.**

## 3. Evidence replay (zero tokens, read-only)

Both campaign trees were verified untouched after replay (temp evidence dirs
created inside `evidence/` were removed; no files added or changed).

| Case | Campaign | Before (stored verdict) | After (fixed O9) |
|---|---|---|---|
| W4.01-missing-evidence-reroute | attempt-1 (campaign-20260826T115835332Z) | FAIL (incl. `O9_REPLAY_ROW_MISSING`) | FAIL — `O9_REPLAY_ROW_MISSING` healed, annotated `skipped_replay_row_ids: [null]` reason `unresolved-cache-hit`; single-flight findings remain (separate class) |
| W4.02-fail-missing-refusal | attempt-1 | FAIL (`O9_REPLAY_ROW_MISSING`) | **PASS** — annotated `skipped_replay_rows: 1 [null] ["unresolved-cache-hit"]` |
| W4.01-missing-evidence-reroute | attempt-2 (campaign-20260826T225744158Z) | FAIL (2× `O9_REPLAY_ROW_MISSING`) | **PASS** — 2 unresolved cache hits annotated |
| W4.02-fail-missing-refusal | attempt-2 | FAIL (`O9_REPLAY_ROW_MISSING`) | **PASS** — 1 unresolved cache hit annotated |

### 3.1 Mechanical root cause on W4.01/W4.02 (attempt-1)

The `suite.cache_hit` events (run-events `all.jsonl:2633` / `all.jsonl:2704`)
name `ledgerRowId 106` — a green row the shim replayed. On W4.02 the fix step
recorded row 106 at 12:21:01 (green, tree `70a5eb99`, 228ms); the verify step
replayed it at 12:22:30 (cache hit, `savedDurationMs 228`); a later verify
re-execution re-recorded row 106 (created_at 12:33:01, 193ms). At snapshot time
the scoped artifact's only row for that exact key carries `created_at >
replay.ts` and a different `duration_ms`, so the snapshotter's prior-row
resolution (`oracle-evidence-snapshot.mjs` `projectSuiteObservations`) yields no
candidate → `ledger_row_id: null` (an unresolved cache hit). On W4.01 the same
shape occurs (`cache_hit` at 12:03:26 for tree `f7097301` naming row 106, which
shim row hygiene later deleted and re-recorded over row 105). The rows exist at
event time; they are re-recorded/deleted before the snapshot, so the case's
scoped artifact cannot attribute the replay. The cache hit itself is mechanical
(marker `TAMANDUA-TEST CACHED`, exit 0) — the honest verdict is an annotated
attribution gap, not a product violation.

## 4. Self-tests added (torture-test/oracles/self-test)

- `generate-o9-fixtures.mjs` + `o9.test.mjs`:
  - `o9-foreign-db-rows` (PASS) — a DB-only foreign-origin row (absent from the
    artifact) is ignored by the scoped reconciliation and annotated
    (`skipped_db_foreign_row_ids [2]`), zero findings.
  - `o9-in-scope-mismatch` (ERROR) — a scoped byte-for-field tamper (DB row
    exit_code flipped) fails closed with the exact
    `suite_ledger does not reconcile exactly with read-only suite_results for
    case-bundle origins` message.
  - `o9-unresolved-cache-hit` (PASS) — a replay naming no attributable prior row
    (`ledger_row_id: null`, marker present) is annotated
    (`skipped_replay_row_ids [null]`, reason `unresolved-cache-hit`) and never
    fires `O9_REPLAY_ROW_MISSING`.
  - `o9-missing-replay-row` (FAIL) redesigned — the replay now names a positive
    id (999) that exists nowhere (neither artifact nor DB) so the fail-closed
    `O9_REPLAY_ROW_MISSING` invariant stays pinned.
- `oracles/self-test/run.sh` already handles ERROR-expectation fixtures for the
  generic oracle loop (US-002), so `o9-in-scope-mismatch` runs in the battery.

## 5. Contract

`torture-test/oracles/CONTRACT.md` now documents the shared case-bundle
suite-scope contract (scope derivation, foreign/stale row doctrine,
in-scope byte-for-field fail-closed reconciliation) and the S26 replay
row-resolution rules (foreign/stale/unresolved cache hits annotated and skipped;
`O9_REPLAY_ROW_MISSING` reserved for row ids absent from both the case scope and
the database snapshot).
