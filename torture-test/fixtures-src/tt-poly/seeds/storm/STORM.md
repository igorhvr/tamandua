# STORM.md — seed/storm Composite Ref (tt-poly, 5-language)

The `seed/storm` ref is a single immutable git ref that layers **every
storm seed simultaneously** onto the green baseline. It serves as the
composite origin for all storm runs (S1–S10 in Round A, B1–B5 in Round B),
ensuring every run in the storm wave starts with the same complete set of
seeded defects, vulnerabilities, and broken tests across all 5 language
subtrees.

## Why a composite ref?

Single-defect seed refs (e.g., `seed/POLY-BUG-P1`) carry ONE defect
each — green base + exactly one change. But the storm fires every
workflow type at once (feature-dev, bug-fix, security-audit, quarantine,
do-review-do-verify, do-now) across all defect classes. No single
single-defect ref can carry the full material. The `seed/storm` ref
solves this by stacking all 41 storm seeds onto baseline in a fixed order,
producing one deterministic commit from which every worktree is cloned.

## Construction

### Starting Point

Green baseline (main branch HEAD): `./run-all-tests` exits 0 with the
STORM-SENTINEL line present in `ts/src/store.ts`.

### Deterministic Application Order

From green baseline, apply seeds in this exact order (sorted by subtree,
then by seed type, then by incrementing number — python first, then ts,
go, rust, java, then cross-language, vulns, broken tests):

#### Phase 1: python/ bug seeds (apply as full-file overlays)

```
 1. POLY-BUG-P1  →  copy python/seeds/POLY-BUG-P1/recurrence.py
                      →  python/src/schedlib/recurrence.py
 2. POLY-BUG-P2  →  copy python/seeds/POLY-BUG-P2/recurrence.py
                      →  python/src/schedlib/recurrence.py
                     copy python/seeds/POLY-BUG-P2/conflict.py
                      →  python/src/schedlib/conflict.py
 3. POLY-BUG-P3  →  copy python/seeds/POLY-BUG-P3/dates.py
                      →  python/src/schedlib/dates.py
 4. POLY-BUG-P4  →  copy python/seeds/POLY-BUG-P4/conflict.py
                      →  python/src/schedlib/conflict.py
```

Order matters: POLY-BUG-P1 and POLY-BUG-P2 both modify `recurrence.py`;
P2 must be applied after P1 (P2's overlay replaces P1's) to produce the
intended two-module failure (recurrence + conflict).

#### Phase 2: ts/ bug seeds (apply as git patches)

```
 5. POLY-BUG-T1  →  git apply -p4 ts/seeds/POLY-BUG-T1.patch
 6. POLY-BUG-T2  →  git apply -p4 ts/seeds/POLY-BUG-T2.patch
 7. POLY-BUG-T3  →  git apply -p4 ts/seeds/POLY-BUG-T3.patch
 8. POLY-BUG-T4  →  git apply -p4 ts/seeds/POLY-BUG-T4.patch
```

All 4 ts/ BUG seeds are dormant in the existing test suite — they modify
source code without changing tests, so no tests expose them without new
regression tests.

#### Phase 3: go/ bug seeds (apply as full-file overlays)

```
 9. POLY-BUG-G1  →  copy go/seeds/POLY-BUG-G1/pool.go → go/pool.go
10. POLY-BUG-G2  →  copy go/seeds/POLY-BUG-G2/pool.go → go/pool.go
                     copy go/seeds/POLY-BUG-G2/worker.go → go/worker.go
11. POLY-BUG-G3  →  copy go/seeds/POLY-BUG-G3/pool.go → go/pool.go
                     copy go/seeds/POLY-BUG-G3/worker.go → go/worker.go
12. POLY-BUG-G4  →  copy go/seeds/POLY-BUG-G4/pool.go → go/pool.go
```

Order matters: G2 and G3 both modify `pool.go` + `worker.go`. They are
applied in incrementing order (G1→G2→G3→G4) so G3's overlay (infinite
loop in drain logic) overwrites G2's overlay, producing the intended
hang symptom. For correctness, each seed is a full-file overlay that
assumes the baseline, not a layered modification.

#### Phase 4: rust/ bug seeds (apply as full-file overlays)

```
13. POLY-BUG-R1  →  copy rust/seeds/POLY-BUG-R1/bucket.rs → rust/src/bucket.rs
14. POLY-BUG-R2  →  copy rust/seeds/POLY-BUG-R2/config.rs → rust/src/config.rs
                     copy rust/seeds/POLY-BUG-R2/bucket.rs → rust/src/bucket.rs
15. POLY-BUG-R3  →  copy rust/seeds/POLY-BUG-R3/bucket.rs → rust/src/bucket.rs
16. POLY-BUG-R4  →  copy rust/seeds/POLY-BUG-R4/bucket.rs → rust/src/bucket.rs
```

Order matters: R3 and R4 both modify `bucket.rs`. Applied in incrementing
order, R4's overlay overwrites R3's.

#### Phase 5: java/ bug seeds (apply as git patches)

```
17. POLY-BUG-J1  →  git apply -p4 java/seeds/POLY-BUG-J1.patch
18. POLY-BUG-J2  →  git apply -p4 java/seeds/POLY-BUG-J2.patch
19. POLY-BUG-J3  →  git apply -p4 java/seeds/POLY-BUG-J3.patch
20. POLY-BUG-J4  →  git apply -p4 java/seeds/POLY-BUG-J4.patch
```

J1 produces 12 round-related failures. J2 produces 3 failures
(CsvParser + LedgerService NPE). J3 produces 15 failures (red herring:
symptom points to LedgerService, root cause is CsvParser column swap).
J4 is dormant (perf threshold on 50k entries).

#### Phase 6: POLY-BUG-A5 cross-language seed (apply full-file overlays)

```
21. POLY-BUG-A5  →  copy python/seeds/POLY-BUG-A5/integrations.py
                      →  python/src/schedlib/integrations.py
                     copy ts/seeds/POLY-BUG-A5/server.ts
                      →  ts/src/server.ts
```

Archetype A5 — cross-language integration bug. Both python/ and ts/ are
modified. Fixing only python/ leaves ts/ red; fixing only ts/ leaves
python/ red. This is union-of-merges bait for the storm.

#### Phase 7: all vulnerabilities (apply to already-layered tree)

```
22. POLY-VULN-P1  →  copy python/seeds/POLY-VULN-P1/integrations.py
                       →  python/src/schedlib/integrations.py
23. POLY-VULN-P2  →  copy python/seeds/POLY-VULN-P2/integrations.py
                       →  python/src/schedlib/integrations.py
24. POLY-VULN-T1  →  (NO seed patch — dormant in baseline; vuln IS baseline)
25. POLY-VULN-T2  →  (NO seed patch — dormant in baseline; vuln IS baseline)
26. POLY-VULN-G1  →  copy go/seeds/POLY-VULN-G1/util_command.go → go/util/command.go
27. POLY-VULN-G2  →  copy go/seeds/POLY-VULN-G2/util_archive.go → go/util/archive.go
28. POLY-VULN-R1  →  copy rust/seeds/POLY-VULN-R1/util_unsafe.rs → rust/src/util_unsafe.rs
29. POLY-VULN-R2  →  copy rust/seeds/POLY-VULN-R2/util_timing.rs → rust/src/util_timing.rs
30. POLY-VULN-J1  →  (NO seed patch — dormant in baseline; vuln IS baseline)
31. POLY-VULN-J2  →  (NO seed patch — dormant in baseline; vuln IS baseline)
```

All vulns are dormant — they exist in code paths never exercised by the
test suite. The `seed/storm` ref includes them so the security-audit run
(S6) has material to find.

#### Phase 8: all broken tests (apply to already-layered tree)

```
32. POLY-BRK-P1  →  copy python/seeds/POLY-BRK-P1/test_broken_p1.py
                      →  python/tests/test_broken_p1.py
33. POLY-BRK-P2  →  copy python/seeds/POLY-BRK-P2/test_broken_p2.py
                      →  python/tests/test_broken_p2.py
34. POLY-BRK-T1  →  git apply -p4 ts/seeds/POLY-BRK-T1.patch
35. POLY-BRK-T2  →  git apply -p4 ts/seeds/POLY-BRK-T2.patch
36. POLY-BRK-G1  →  copy go/seeds/POLY-BRK-G1/pool_test.go → go/pool_test.go
                     copy go/seeds/POLY-BRK-G1/go.mod → go/go.mod
37. POLY-BRK-G2  →  copy go/seeds/POLY-BRK-G2/pool_test.go → go/pool_test.go
                     copy go/seeds/POLY-BRK-G2/go.mod → go/go.mod
38. POLY-BRK-R1  →  copy rust/seeds/POLY-BRK-R1/integration.rs → rust/tests/integration.rs
39. POLY-BRK-R2  →  copy rust/seeds/POLY-BRK-R2/integration.rs → rust/tests/integration.rs
40. POLY-BRK-J1  →  git apply -p4 java/seeds/POLY-BRK-J1.patch
41. POLY-BRK-J2  →  git apply -p4 java/seeds/POLY-BRK-J2.patch
```

Order matters for BRK seeds that share the same file: G2 overwrites G1's
`pool_test.go`, R2 overwrites R1's `integration.rs`.

After all 41 seeds are applied, commit with deterministic git identity:

```
GIT_AUTHOR_NAME="Tamandua Fixture Builder"
GIT_AUTHOR_EMAIL="fixtures@tamandua.tetradactyla.org"
GIT_AUTHOR_DATE="2026-01-01T00:00:00Z"
GIT_COMMITTER_NAME="Tamandua Fixture Builder"
GIT_COMMITTER_EMAIL="fixtures@tamandua.tetradactyla.org"
GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
```

Tag the resulting commit as `seed/storm`.

## Verified Symptoms in seed/storm Checkout

A scratch clone of `seed/storm` should exhibit:

### python/ symptoms

| Symptom | Count | Cause |
|---------|-------|-------|
| POLY-BUG-P1 dormant (green) | — | No test coverage for `_advance` count+until path |
| POLY-BUG-P2 failures | 2 | `test_every_two_years` + `test_contained_equal_bounds` |
| POLY-BUG-P3 failures | 3 | `calendar_helpers` tests (red herring from `dates.py`) |
| POLY-BUG-P4 perf failure | 1 | `find_available_slots()` O(n²) >2s on 10k events |
| POLY-BUG-A5 failures | N | Cross-language dict key rename (`calendar_name` → `name`) |
| POLY-VULN-P1 dormant | — | `yaml.load()` unsafe, never imported by test suite |
| POLY-VULN-P2 dormant | — | `subprocess.run(shell=True)`, never imported |
| POLY-BRK-P1 date mismatches | 2 | 7/31 vs 8/3, 8/1 vs 8/3 |
| POLY-BRK-P2 count mismatches | 3 | Wrong conflict counts (1 vs 2, 0, 0) |
| POLY-FLAKY-P1 alternator | 0 or 1 | Deterministic pass/fail alternator (see SEEDS.md) |

### ts/ symptoms

| Symptom | Count | Cause |
|---------|-------|-------|
| POLY-BUG-T1..T4 dormant (green) | — | All 4 BUG seeds lack test coverage |
| POLY-BUG-A5 failures | N | Cross-language bridge key mismatch |
| POLY-BRK-T1 `getTotal` | 1 | 60 !== 150 |
| POLY-BRK-T2 POST status | 1 | 201 !== 200 |
| POLY-VULN-T1 dormant | — | `innerHTML` XSS, test data never includes HTML tags |
| POLY-VULN-T2 dormant | — | Prototype pollution, test bodies never include `__proto__` |
| Baseline: 59 passed, green | — | All BUG seeds dormant, VULNs dormant |

### go/ symptoms

| Symptom | Count | Cause |
|---------|-------|-------|
| POLY-BUG-G1 dormant (green) | — | No test for exact counter interleaving |
| POLY-BUG-G2 failures | 2 | Error propagation format mismatch across pool/worker |
| POLY-BUG-G3 hang | ∞ | Worker drain missing, `ctx.Done()` exit without draining `taskQueue` |
| POLY-BUG-G4 data race | N | `atomic.Int64` `Load()` vs direct assignment mismatch |
| POLY-VULN-G1 dormant | — | `RunCommandShell` shell injection, never imported |
| POLY-VULN-G2 dormant | — | `ExtractTar` zip-slip, never imported |
| POLY-BRK-G1 off-by-one count | 1 | Expected N-1 results, actual N |
| POLY-BRK-G2 inverted boolean | 1 | `err != nil` when task succeeds |

### rust/ symptoms

| Symptom | Count | Cause |
|---------|-------|-------|
| POLY-BUG-R1 dormant (green) | — | `u32` overflow only on large token values |
| POLY-BUG-R2 failures | 4 | 3 config unit test failures + 1 integration failure |
| POLY-BUG-R3 hang | ∞ | `try_consume()` infinite loop when tokens insufficient |
| POLY-BUG-R4 dormant on small input | — | O(n²) spin loop only triggered at 10k+ requests |
| POLY-VULN-R1 dormant | — | Unsafe pointer arithmetic, never called |
| POLY-VULN-R2 dormant | — | Timing side-channel in `timing_unsafe_compare`, never called |
| POLY-BRK-R1 off-by-one count | 1 | 5,000 → 4,999 mismatch |
| POLY-BRK-R2 inverted boolean | 1 | `try_consume(4)` is `false`, asserts `true` |

### java/ symptoms

| Symptom | Count | Cause |
|---------|-------|-------|
| POLY-BUG-J1 rounding failures | 12 | `setScale(scale - 1)` instead of `setScale(scale)` |
| POLY-BUG-J2 null + NPE failures | 3 | CsvParser returns null for header-only CSV + LedgerService NPE |
| POLY-BUG-J3 red herring failures | 15 | CsvParser column swap (3↔4), 4 CsvParserTest + 11 CliAppTest |
| POLY-BUG-J4 perf failure | 1 | O(n²) `getCategoryTotals()` >500ms on 50k entries |
| POLY-VULN-J1 dormant | — | XXE via DocumentBuilder, never imported |
| POLY-VULN-J2 dormant | — | Path traversal via FileWriter, never imported |
| POLY-BRK-J1 wrong total | 1 | 450.00 vs 475.00 |
| POLY-BRK-J2 wrong category | 1 | "groceries" vs "food" |

## Fix Patch Verification (Individually)

Each fix patch restores green when applied on top of its seed. Verified
cycle for every seed:

### python/ fix patches

| Seed | Fix Patch | Result after fix |
|------|-----------|------------------|
| POLY-BUG-P1 | `python/seeds/POLY-BUG-P1/fix.patch` | `_advance` count+until fixed, green |
| POLY-BUG-P2 | `python/seeds/POLY-BUG-P2/fix.patch` | Both recurrence + conflict fixed, green |
| POLY-BUG-P3 | `python/seeds/POLY-BUG-P3/fix.patch` | `is_weekday()` <=5 → <5, green |
| POLY-BUG-P4 | `python/seeds/POLY-BUG-P4/fix.patch` | O(n log n) sort+single-pass, green |
| POLY-BUG-A5 | `python/seeds/POLY-BUG-A5/fix.patch` | Coordinated dict key revert, both python/ and ts/ green |
| POLY-VULN-P1 | `python/seeds/POLY-VULN-P1/fix.patch` | `yaml.load` → `yaml.safe_load`, green |
| POLY-VULN-P2 | `python/seeds/POLY-VULN-P2/fix.patch` | Removes `shell=True`, `args: list[str]`, green |
| POLY-BRK-P1 | `python/seeds/POLY-BRK-P1/fix.patch` | Corrects expected dates, green |
| POLY-BRK-P2 | `python/seeds/POLY-BRK-P2/fix.patch` | Corrects expected counts, green |
| POLY-FLAKY-P1 | (no fix.patch) | Restore baseline `conftest.py` skip hook |

### ts/ fix patches

| Seed | Fix Patch | Result after fix |
|------|-----------|------------------|
| POLY-BUG-T1 | `ts/seeds/fix/POLY-BUG-T1-fix.patch` | Adds regression test, green |
| POLY-BUG-T2 | `ts/seeds/fix/POLY-BUG-T2-fix.patch` | Adds regression tests, green |
| POLY-BUG-T3 | `ts/seeds/fix/POLY-BUG-T3-fix.patch` | Adds regression tests, green |
| POLY-BUG-T4 | `ts/seeds/fix/POLY-BUG-T4-fix.patch` | Adds regression tests, green |
| POLY-VULN-T1 | `ts/seeds/fix/POLY-VULN-T1-fix.patch` | `innerHTML` → `textContent`, green |
| POLY-VULN-T2 | `ts/seeds/fix/POLY-VULN-T2-fix.patch` | Safe property copy loop, green |
| POLY-BRK-T1 | `ts/seeds/fix/POLY-BRK-T1-fix.patch` | Corrects expected total (60), green |
| POLY-BRK-T2 | `ts/seeds/fix/POLY-BRK-T2-fix.patch` | Corrects expected status (201), green |

### go/ fix patches

| Seed | Fix Patch | Result after fix |
|------|-----------|------------------|
| POLY-BUG-G1 | `go/seeds/POLY-BUG-G1/fix.patch` | Counter increment moved after shutdown check + regression test, green |
| POLY-BUG-G2 | `go/seeds/POLY-BUG-G2/fix.patch` | Error format + worker check aligned, green |
| POLY-BUG-G3 | `go/seeds/POLY-BUG-G3/fix.patch` | Drain-before-exit logic added, `go test -timeout 10s` green |
| POLY-BUG-G4 | `go/seeds/POLY-BUG-G4/fix.patch` | `.Store()` for atomic write, `go test -race` green |
| POLY-VULN-G1 | `go/seeds/POLY-VULN-G1/fix.patch` | Removes `RunCommandShell`, safe args-list-only, green |
| POLY-VULN-G2 | `go/seeds/POLY-VULN-G2/fix.patch` | Path traversal guard added, green |
| POLY-BRK-G1 | `go/seeds/POLY-BRK-G1/fix.patch` | Corrects expected count, green |
| POLY-BRK-G2 | `go/seeds/POLY-BRK-G2/fix.patch` | Corrects inverted boolean, green |

### rust/ fix patches

| Seed | Fix Patch | Result after fix |
|------|-----------|------------------|
| POLY-BUG-R1 | `rust/seeds/POLY-BUG-R1/fix.patch` | u64 intermediate + `.min(u32::MAX)` clamping, green |
| POLY-BUG-R2 | `rust/seeds/POLY-BUG-R2/fix.patch` | Config builders accept args + bucket uses burst_size, green |
| POLY-BUG-R3 | `rust/seeds/POLY-BUG-R3/fix.patch` | Restores `try_consume` returning `false` + regression tests, green |
| POLY-BUG-R4 | `rust/seeds/POLY-BUG-R4/fix.patch` | O(1) `consume_count` increment removed, green |
| POLY-VULN-R1 | `rust/seeds/POLY-VULN-R1/fix.patch` | Replaces unsafe with safe `Vec::get`/`get_mut`, green |
| POLY-VULN-R2 | `rust/seeds/POLY-VULN-R2/fix.patch` | XOR-accumulator constant-time comparison, green |
| POLY-BRK-R1 | `rust/seeds/POLY-BRK-R1/fix.patch` | Corrects expected count (5,000), green |
| POLY-BRK-R2 | `rust/seeds/POLY-BRK-R2/fix.patch` | Corrects inverted boolean, green |

### java/ fix patches

| Seed | Fix Patch | Result after fix |
|------|-----------|------------------|
| POLY-BUG-J1 | `java/seeds/fix/POLY-BUG-J1-fix.patch` | `setScale(scale)` + regression test, green |
| POLY-BUG-J2 | `java/seeds/fix/POLY-BUG-J2-fix.patch` | CsvParser null → empty list + LedgerService NPE guard + 2 regression tests, green |
| POLY-BUG-J3 | `java/seeds/fix/POLY-BUG-J3-fix.patch` | Corrects column indices, green |
| POLY-BUG-J4 | `java/seeds/fix/POLY-BUG-J4-fix.patch` | O(n) HashMap merge, <50ms, green |
| POLY-VULN-J1 | `java/seeds/fix/POLY-VULN-J1-fix.patch` | Secure `DocumentBuilderFactory` config + `XmlImportServiceTest` (5 tests), green |
| POLY-VULN-J2 | `java/seeds/fix/POLY-VULN-J2-fix.patch` | Canonical-path containment check + `ExportServiceTest` (6 tests), green |
| POLY-BRK-J1 | `java/seeds/fix/POLY-BRK-J1-fix.patch` | Corrects expected total (475.00), green |
| POLY-BRK-J2 | `java/seeds/fix/POLY-BRK-J2-fix.patch` | Corrects expected category ("food"), green |

## Storm Sentinel Line

### Location

`ts/src/store.ts`, immediately after the `getByCategory` method (between
`getByCategory` and `getByDateRange`).

### Content

```typescript
// STORM-SENTINEL: 4a7f2e9b1c6d8 — guaranteed-conflict overlap pair for S5/S9
// Both storm runs (S5: bug-fix, S9: feature-dev) target this line with
// mutually incompatible edits. S5 replaces it with a category-normalization
// helper; S9 replaces it with a category-aliasing map. The resulting
// textual conflict forces the rebase→re-test loop and is pre-verified by
// git merge-tree before the storm round.
```

### Role in the S5/S9 Guaranteed Conflict

The storm roster includes an **overlap pair** (S5 and S9) designed to
produce a guaranteed merge conflict:

- **S5** (`storm-bfmw-2`, bug-fix-merge-worktree, hermes): tasked with
  fixing a bug in `ts/src/store.ts`. As part of its fix, S5 replaces the
  `STORM-SENTINEL` comment block with a category-normalization helper
  function (e.g., normalizing "Food & Drinks" → "Food").
- **S9** (`storm-fdmw-4`, feature-dev-merge-worktree, pi): tasked with
  adding a feature to the expense tracker. As part of its feature, S9
  replaces the same `STORM-SENTINEL` comment block with a category-aliasing
  map (e.g., allowing users to define "Groceries" as an alias for "Food").

Both S5 and S9 MUST modify this exact line region: S5 deletes the sentinel
and adds its helper; S9 deletes the sentinel and adds its map. The two
replacements are textually incompatible — the second to merge will
encounter a real conflict that cannot auto-resolve. This forces the
rebase→re-test loop exactly as the storm spec requires.

### Pre-Verification (build-golden.sh responsibility)

`build-golden.sh` should pre-verify the conflict is genuine by:
1. Building the baseline with sentinel (green base commit)
2. Applying S5's edit to a branch, committing
3. Applying S9's edit to another branch off green base, committing
4. Running `git merge-tree` between the two — it MUST report a textual
   conflict on the sentinel region

If merge-tree shows a clean auto-merge, the sentinel and the task
specifications are not in sync — a fixture bug that must be fixed
before the storm round.

### Non-Overlap Guarantee

Every other task area is **disjoint by design**: different subtrees
(`go/`, `java/`, `rust/`), or different stage areas within the same
subtree (`python/` scheduling vs `python/` bug fixes). The S5/S9 pair
is the ONLY expected conflict in the entire 8-run storm roster (Round A).
Any other merge conflict in Round A (fault-free) is an unexpected finding.

## seed/storm vs broken-tests Branch

These are separate constructs:

| Ref/Branch | Purpose | Contents | Test Outcome |
|------------|---------|----------|--------------|
| `main` (green base) | All non-quarantine worktrees | No defects; sentinel present | Green |
| `seed/storm` | Composite storm origin | All 41 seeds layered | Mixed (bugs + vulns + brk) |
| `broken-tests` | Quarantine worktrees | All 10 BRK seeds only | Red (BRK failures) |
| Individual `seed/POLY-*` | Per-defect isolation | One defect each | Per-defect outcome |

S7 (`storm-quar`) uses `--context branch=broken-tests` and lands on
`broken-tests`, NEVER on main. All other storm runs clone from `seed/storm`
and land on `main`.

## Integrity Invariants

1. **Deterministic build:** `build-golden.sh` produces identical `seed/storm`
   commits on consecutive runs — verified by byte-stable hashes.
2. **Baseline green + sentinel present:** `main` branch has no defect
   material, but the sentinel line IS present (it ships with the baseline,
   not as a seed).
3. **Composite correctness:** `seed/storm` checkout shows all 41 seeds'
   documented symptoms simultaneously — every bug visible/dormant, every
   vuln dormant, every brk red.
4. **Fix isolation:** each fix patch restores green individually when
   applied on top of its seed, without affecting other layered seeds.
5. **Conflict pre-verified:** `git merge-tree` between S5 and S9's edits
   shows a real textual conflict on the sentinel region.
6. **Subtrees independent:** each language subtree's seed overlays affect
   only their own files (except POLY-BUG-A5 which spans python/ + ts/ by
   design). Seed ordering within a subtree never depends on seeds from
   other subtrees.
7. **Application order deterministic:** seed/storm hash is stable across
   rebuilds because seeds are applied in a fixed, documented order.
8. **Non-overlap outside S5/S9:** all 8 storm runs' task areas are disjoint
   except for the guaranteed-conflict sentinel pair. Any other merge
   conflict is an unexpected finding that must be investigated.

## Reference Documents

- **Seed catalog:** [`seeds/SEEDS.md`](../SEEDS.md) — full 42-seed listing
  with per-seed details, archetypes, and verification steps across all 5
  subtrees + cross-language A5
- **python/ FIXTURE.md:** [`python/FIXTURE.md`](../../python/FIXTURE.md)
  — python subtree defect catalog (POLY-P*)
- **ts/ FIXTURE.md:** [`ts/FIXTURE.md`](../../ts/FIXTURE.md)
  — ts subtree defect catalog (POLY-T*)
- **go/ FIXTURE.md:** [`go/FIXTURE.md`](../../go/FIXTURE.md)
  — go subtree defect catalog (POLY-G*)
- **rust/ FIXTURE.md:** [`rust/FIXTURE.md`](../../rust/FIXTURE.md)
  — rust subtree defect catalog (POLY-R*)
- **java/ FIXTURE.md:** [`java/FIXTURE.md`](../../java/FIXTURE.md)
  — java subtree defect catalog (POLY-J*)
- **Spec 02:** `torture-test/tamandua-torture-test-spec/02-fixture-projects.md`
  — tt-poly definition and common requirements
- **Spec 09:** `torture-test/tamandua-torture-test-spec/09-wave-5-storm.md`
  — storm wave specification, roster (S1–S10), and success criteria
