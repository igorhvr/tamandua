# STORM.md — seed/storm Composite Ref

The `seed/storm` ref is a single immutable git ref that layers **every
storm seed simultaneously** onto the green baseline. It serves as the
composite origin for all storm runs (S1–S10 in Round A, B1–B5 in Round B),
ensuring every run in the storm wave starts with the same complete set of
seeded defects, vulnerabilities, and broken tests.

## Why a composite ref?

Single-defect seed refs (e.g., `seed/POLY-BUG-P1`) carry ONE defect
each — green base + exactly one change. But the storm fires every
workflow type at once (feature-dev, bug-fix, security-audit, quarantine,
do-review-do-verify, do-now) across all defect classes. No single
single-defect ref can carry the full material. The `seed/storm` ref
solves this by stacking all storm seeds onto baseline in a fixed order,
producing one deterministic commit from which every worktree is cloned.

## Construction

### Starting Point

Green baseline (main branch HEAD): `./run-all-tests` exits 0.

### Deterministic Application Order

From green baseline, apply seeds in this exact order (sorted by subtree,
then by seed type, then by incrementing number — python first, then ts):

```
Phase 1: python/ bug seeds (apply as full-file overlays)
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

Phase 2: ts/ bug seeds (apply as git patches)
 5. POLY-BUG-T1  →  git apply ts/seeds/POLY-BUG-T1.patch
 6. POLY-BUG-T2  →  git apply ts/seeds/POLY-BUG-T2.patch
 7. POLY-BUG-T3  →  git apply ts/seeds/POLY-BUG-T3.patch
 8. POLY-BUG-T4  →  git apply ts/seeds/POLY-BUG-T4.patch

Phase 3: Vulnerabilities (apply to already-layered tree)
 9. POLY-VULN-P1 →  copy python/seeds/POLY-VULN-P1/integrations.py
                      →  python/src/schedlib/integrations.py
10. POLY-VULN-P2 →  copy python/seeds/POLY-VULN-P2/integrations.py
                      →  python/src/schedlib/integrations.py
11. POLY-VULN-T1 →  (NO seed patch — dormant in baseline; vuln IS baseline)
12. POLY-VULN-T2 →  (NO seed patch — dormant in baseline; vuln IS baseline)

Phase 4: Broken tests (apply to already-layered tree)
13. POLY-BRK-P1  →  copy python/seeds/POLY-BRK-P1/test_broken_p1.py
                      →  python/tests/test_broken_p1.py
14. POLY-BRK-P2  →  copy python/seeds/POLY-BRK-P2/test_broken_p2.py
                      →  python/tests/test_broken_p2.py
15. POLY-BRK-T1  →  git apply ts/seeds/POLY-BRK-T1.patch
16. POLY-BRK-T2  →  git apply ts/seeds/POLY-BRK-T2.patch
```

After all 16 seeds are applied, commit with deterministic git identity:
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

A scratch clone of seed/storm should exhibit:

| Subtree | Symptom | Cause |
|---------|---------|-------|
| python/ | 157 passed + 1 skipped (flaky probe), green | BUG-P1 dormant (no test coverage) |
| python/ | Perf failure (>2s) | BUG-P4 O(n²) on 10k events |
| python/ | 2 BUG-P2 failures | test_every_two_years + test_contained_equal_bounds |
| python/ | 3 BUG-P3 failures | calendar_helpers tests (red herring from dates.py) |
| python/ | 2 BRK-P1 failures | date mismatches (7/31 vs 8/3, 8/1 vs 8/3) |
| python/ | 3 BRK-P2 failures | conflict count mismatches |
| python/ | VULN-P1 dormant | integrations.py never imported by test suite |
| python/ | VULN-P2 dormant | integrations.py never imported by test suite |
| ts/ | 59 passed, green | All 4 BUG seeds dormant (no test coverage for buggy paths) |
| ts/ | 1 BRK-T1 failure | getTotal: 60 !== 150 |
| ts/ | 1 BRK-T2 failure | POST status: 201 !== 200 |
| ts/ | VULN-T1 dormant | innerHTML XSS, test data never includes HTML tags |
| ts/ | VULN-T2 dormant | prototype pollution, test bodies never include __proto__ |

## Fix Patch Verification (Individually)

Each fix patch restores green when applied on top of its seed. Verified
cycle for every seed:

| Seed | Fix Patch | Result after fix |
|------|-----------|------------------|
| POLY-BUG-P1 | python/seeds/POLY-BUG-P1/fix.patch | 26 passed (recurrence), green |
| POLY-BUG-P2 | python/seeds/POLY-BUG-P2/fix.patch | 45 passed, green |
| POLY-BUG-P3 | python/seeds/POLY-BUG-P3/fix.patch | 26 passed, green |
| POLY-BUG-P4 | python/seeds/POLY-BUG-P4/fix.patch | 7 passed, green |
| POLY-BUG-T1 | ts/seeds/fix/POLY-BUG-T1-fix.patch | adds regression test, green |
| POLY-BUG-T2 | ts/seeds/fix/POLY-BUG-T2-fix.patch | adds regression tests, green |
| POLY-BUG-T3 | ts/seeds/fix/POLY-BUG-T3-fix.patch | adds regression tests, green |
| POLY-BUG-T4 | ts/seeds/fix/POLY-BUG-T4-fix.patch | adds regression tests, green |
| POLY-VULN-P1 | python/seeds/POLY-VULN-P1/fix.patch | yaml.load → safe_load, green |
| POLY-VULN-P2 | python/seeds/POLY-VULN-P2/fix.patch | removes shell=True, green |
| POLY-VULN-T1 | ts/seeds/fix/POLY-VULN-T1-fix.patch | innerHTML → textContent, green |
| POLY-VULN-T2 | ts/seeds/fix/POLY-VULN-T2-fix.patch | safe property copy, green |
| POLY-BRK-P1 | python/seeds/POLY-BRK-P1/fix.patch | corrects dates, green |
| POLY-BRK-P2 | python/seeds/POLY-BRK-P2/fix.patch | corrects counts, green |
| POLY-BRK-T1 | ts/seeds/fix/POLY-BRK-T1-fix.patch | corrects expected total, green |
| POLY-BRK-T2 | ts/seeds/fix/POLY-BRK-T2-fix.patch | corrects expected status, green |

## Storm Sentinel Line

### Location

`ts/src/store.ts`, immediately after the `getByCategory` method (line-level
position in the source file: between `getByCategory` and `getByDateRange`).

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
  fixing a bug in `ts/src/store.js`. As part of its fix, S5 replaces the
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

Every other task area is **disjoint by design** (different subtrees or
different files within the same subtree). The S5/S9 pair is the ONLY
expected conflict in the entire storm roster. Any other merge conflict
in Round A (fault-free) is an unexpected finding.

## seed/storm vs broken-tests Branch

These are separate constructs:

| Ref/Branch | Purpose | Contents | Test Outcome |
|------------|---------|----------|--------------|
| `main` (green base) | All non-quarantine worktrees | No defects | Green (but sentinel present) |
| `seed/storm` | Composite storm origin | All 16 seeds layered | Mixed (bugs + vulns + brk) |
| `broken-tests` | Quarantine worktrees | All 4 BRK seeds only | Red (BRK failures) |
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
3. **Composite correctness:** `seed/storm` checkout shows all 16 seeds'
   documented symptoms simultaneously — every bug dormant, every vuln
   dormant, every brk red.
4. **Fix isolation:** each fix patch restores green individually when
   applied on top of its seed, without affecting other layered seeds.
5. **Conflict pre-verified:** `git merge-tree` between S5 and S9's edits
   shows a real textual conflict on the sentinel region.

## Reference Documents

- **Seed catalog:** [`seeds/SEEDS.md`](../SEEDS.md) — full seed listing
  with per-seed details, archetypes, and verification steps
- **python/ FIXTURE.md:** [`python/FIXTURE.md`](../../python/FIXTURE.md)
  — python subtree defect catalog
- **ts/ FIXTURE.md:** [`ts/FIXTURE.md`](../../ts/FIXTURE.md) — ts subtree
  defect catalog
- **Spec 02:** `torture-test/tamandua-torture-test-spec/02-fixture-projects.md`
  — tt-poly-lite definition and common requirements
- **Spec 09:** `torture-test/tamandua-torture-test-spec/09-wave-5-storm.md`
  — storm wave specification, roster, and success criteria
