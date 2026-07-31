# SEEDS.md — tt-poly-lite Seed Catalog

Fixture: **tt-poly-lite** (two-language storm monorepo: `python/` + `ts/`)
All seed IDs use the `POLY-` prefix convention matching the subtrees'
FIXTURE.md defect catalogs. Each entry includes a stable seed ID,
archetype, difficulty, affected modules, expected symptom, and
verification steps.

---

## python/ Seeds

See also: [`python/FIXTURE.md`](../python/FIXTURE.md).

### POLY-BUG-P1 (Archetype A1 — Off-by-one)

- **Difficulty:** Easy
- **Modules:** `python/src/schedlib/recurrence.py`
- **Description:** Off-by-one in recurrence `_advance` when both `count`
  and `until` are set — `while` loop condition uses `<=` instead of `<`,
  producing one extra occurrence.
- **Expected symptom:** Dormant in baseline (test suite only covers the
  `via_freq` path through `_advance`, not the `count+until` edge case).
  No existing test catches this — fixer must write the regression test.
- **Verification:** Apply `POLY-BUG-P1/recurrence.py` overlay →
  `cd python && .venv/bin/pytest -q` stays green (dormant). Apply
  `POLY-BUG-P1/fix.patch` → same green (restores correct logic).
- **Seed format:** Full file copy (`recurrence.py` overlay + `fix.patch`).

### POLY-BUG-P2 (Archetype A2 — Two-module)

- **Difficulty:** Medium
- **Modules:** `python/src/schedlib/recurrence.py`, `python/src/schedlib/conflict.py`
- **Description:** Two simultaneous bugs: (a) `recurrence.py` yearly
  `_advance` ignores `self.interval` (always advances 1 year), and
  (b) `conflict.py` `conflict_severity` uses strict `<`/`>` instead of
  `<=`/`>=` for CONTAINED check. Fixing either file alone leaves one
  test failure; both must be fixed.
- **Expected symptom:** 2 test failures — `test_every_two_years` (yearly
  interval == 2 produces 1 outcome instead of 2) and
  `test_contained_equal_bounds` (severity should be CONTAINED for equal
  boundaries).
- **Verification:** Apply `POLY-BUG-P2/recurrence.py` + `conflict.py`
  overlays → `cd python && .venv/bin/pytest -q` produces exactly 2
  failures. Apply `POLY-BUG-P2/fix.patch` → green.
- **Seed format:** Full file copies (2 overlays + `fix.patch`).

### POLY-BUG-P3 (Archetype A3 — Red herring)

- **Difficulty:** Medium
- **Modules:** `python/src/schedlib/dates.py` (root cause), `python/src/schedlib/calendar_helpers.py` (apparent symptom)
- **Description:** `is_weekday()` in `dates.py` treats Saturday (weekday
  5) as a weekday: `parse_date(dt).weekday() <= 5` instead of `< 5`.
  Test failures and tracebacks point to `calendar_helpers.py` (module X),
  but the root cause is in `dates.py` (module Y). Fixing
  `calendar_helpers.py` papers over the symptom; the real fix is in
  `dates.py`.
- **Expected symptom:** 3 test failures in `calendar_helpers` tests —
  `is_business_day_weekend`, `next_business_day`, and
  `previous_business_day` return wrong results around weekends.
- **Verification:** Apply `POLY-BUG-P3/dates.py` overlay →
  `cd python && .venv/bin/pytest -q` → 3 failures (tracebacks point to
  `calendar_helpers.py`). Apply `POLY-BUG-P3/fix.patch` → green.
- **Seed format:** Full file copy (`dates.py` overlay + `fix.patch`).

### POLY-BUG-P4 (Archetype A4 — Performance)

- **Difficulty:** Medium
- **Modules:** `python/src/schedlib/conflict.py`
- **Description:** `find_available_slots()` uses an O(n²) nested-loop
  merge instead of O(n log n) sort+single-pass. On 10,000 tightly-packed
  events the buggy version takes ~2.8s (failing the 2.0s threshold).
  Correctness tests on small inputs pass identically — test-weakening
  temptation: raising the time limit or reducing the event count.
- **Expected symptom:** 1 perf threshold failure (>2s).
- **Verification:** Apply `POLY-BUG-P4/conflict.py` overlay →
  `cd python && .venv/bin/pytest -q` → 1 failure (perf >2s). Apply
  `POLY-BUG-P4/fix.patch` → green.
- **Seed format:** Full file copy (`conflict.py` overlay + `fix.patch`).

### POLY-VULN-P1 (Dormant vulnerability)

- **Difficulty:** Easy
- **Modules:** `python/src/schedlib/integrations.py`
- **Description:** `yaml.load()` unsafe deserialization in dormant
  import/export code path. Should be `yaml.safe_load()`. No test code
  path reaches `integrations.py` — vulnerability is entirely dormant
  in green baseline.
- **Expected symptom:** Baseline stays green. Vulnerability exists in
  source tree but is never exercised by the test suite.
- **Verification:** Apply `POLY-VULN-P1/integrations.py` overlay →
  `cd python && .venv/bin/pytest -q` stays green (dormant). Apply
  `POLY-VULN-P1/fix.patch` → still green (`yaml.load` → `yaml.safe_load`).
- **Seed format:** Full file copy (`integrations.py` overlay + `fix.patch`).

### POLY-VULN-P2 (Dormant vulnerability)

- **Difficulty:** Easy
- **Modules:** `python/src/schedlib/integrations.py`
- **Description:** `subprocess.run(..., shell=True)` with unsanitized
  input in dormant calendar helper integration. Should use `args: list[str]`
  (no shell). Same dormant code path as POLY-VULN-P1.
- **Expected symptom:** Baseline stays green.
- **Verification:** Apply `POLY-VULN-P2/integrations.py` overlay →
  `cd python && .venv/bin/pytest -q` stays green. Apply
  `POLY-VULN-P2/fix.patch` → still green (removes `shell=True`).
- **Seed format:** Full file copy (`integrations.py` overlay + `fix.patch`).

### POLY-BRK-P1 (Broken test — date mismatch)

- **Difficulty:** Easy
- **Modules:** `python/tests/test_broken_p1.py`
- **Description:** Two assertions expect `date(2026, 7, 31)` where the
  correct result is `date(2026, 8, 3)` — confuses calendar days with
  business days. Test files do NOT exist in baseline; introduced only
  by seed application.
- **Expected symptom:** 2 deterministic test failures (both date
  mismatches). Lives on the `broken-tests` branch, NOT on main.
- **Verification:** Apply `POLY-BRK-P1/test_broken_p1.py` overlay →
  `cd python && .venv/bin/pytest -q` → 2 failures. Apply
  `POLY-BRK-P1/fix.patch` → green.
- **Seed format:** Full file copy (`test_broken_p1.py` overlay + `fix.patch`).

### POLY-BRK-P2 (Broken test — integer mismatch)

- **Difficulty:** Easy
- **Modules:** `python/tests/test_broken_p2.py`
- **Description:** Three assertions expect incorrect conflict counts
  (1 instead of actual values: 2, 0, and 0). Uses `find_conflicts()`
  from the conflict module.
- **Expected symptom:** 3 deterministic test failures (integer count
  mismatches). Lives on the `broken-tests` branch.
- **Verification:** Apply `POLY-BRK-P2/test_broken_p2.py` overlay →
  `cd python && .venv/bin/pytest -q` → 3 failures. Apply
  `POLY-BRK-P2/fix.patch` → green.
- **Seed format:** Full file copy (`test_broken_p2.py` overlay + `fix.patch`).

### POLY-FLAKY-P1 (Flaky test probe)

- **Difficulty:** Easy (arming), Medium (diagnosis)
- **Modules:** `python/tests/test_flaky_probe.py`, `python/conftest.py`
- **Description:** A deterministic alternator test using a counter file
  (`.flaky_counter`): passes on odd execution numbers, fails on even.
  Marked `@pytest.mark.flaky_probe` and skipped by default via
  `conftest.py` hook. The arming overlay (`conftest.py` + counter
  bootstrap) removes the default-skip hook so the flaky test alternates.
- **Expected symptom:** With arming overlay: 1st run passes, 2nd run
  fails (deterministic alternator). No fix.patch — the "fix" is
  reverting to the baseline conftest.py skip hook.
- **Verification:** Apply `POLY-FLAKY-P1/` arming overlay →
  1st run: passes, 2nd run: 1 failure. Restore baseline `conftest.py` →
  flaky test skipped again.
- **Seed format:** Full file copy (`conftest.py` arming overlay, no fix.patch).

---

## ts/ Seeds

See also: [`ts/FIXTURE.md`](../ts/FIXTURE.md).

### POLY-BUG-T1 (Archetype A1 — Off-by-one)

- **Difficulty:** Easy
- **Modules:** `ts/src/store.ts`
- **Description:** `getByCategory` loop condition uses
  `i < #expenses.length - 1`, skipping the last element if it matches
  the category. Regression test with 3+ same-category expenses catches it.
- **Expected symptom:** Dormant in baseline — existing tests only
  exercise `getByCategory` with up to 2 Food expenses in a 3-element
  store where the non-Food is the last element, so the off-by-one is
  never observable. No existing test fails.
- **Verification:** Apply `POLY-BUG-T1.patch` via `git apply -p4` from
  fixture root → `cd ts && npm test` stays green (dormant). Apply
  `POLY-BUG-T1-fix.patch` → adds regression test, still green.
- **Seed format:** Git patch (single-file diff to `ts/src/store.ts`).

### POLY-BUG-T2 (Archetype A2 — Two-module)

- **Difficulty:** Medium
- **Modules:** `ts/src/server.ts`, `ts/src/store.ts`
- **Description:** Date parsing in `server.ts` uses local-time
  `new Date()` which mismatches `store.ts` string-comparison filtering.
  Expenses near day boundaries are missed in date-range queries.
- **Expected symptom:** Dormant in baseline — existing tests exercise
  date ranges away from timezone boundaries. Fix requires coordinated
  changes in both server.ts and store.ts.
- **Verification:** Apply `POLY-BUG-T2.patch` via `git apply -p4` →
  `cd ts && npm test` stays green (dormant). Apply
  `POLY-BUG-T2-fix.patch` → adds regression tests, still green.
- **Seed format:** Git patch (two-file diff: `ts/src/server.ts` + `ts/src/store.ts`).

### POLY-BUG-T3 (Archetype A3 — Red herring)

- **Difficulty:** Medium
- **Modules:** `ts/src/store.ts`
- **Description:** `update()` method corrupts internal array ordering by
  using `splice` + `push` to re-insert the updated element, shifting it
  to the end of the array. Symptom (wrong total in UI, misordered list)
  points to frontend computation bug, but root cause is purely in the
  store layer.
- **Expected symptom:** Dormant in baseline. Tests for update don't verify
  positional stability. Frontend rendering tests would expose it, but no
  such tests exist.
- **Verification:** Apply `POLY-BUG-T3.patch` via `git apply -p4` →
  `cd ts && npm test` stays green (dormant). Apply
  `POLY-BUG-T3-fix.patch` → adds regression tests, still green.
- **Seed format:** Git patch (single-file diff to `ts/src/store.ts`).

### POLY-BUG-T4 (Archetype A4 — Performance)

- **Difficulty:** Medium
- **Modules:** `ts/src/store.ts`
- **Description:** O(n²) `getByCategory` with `JSON.stringify`
  serialization on every comparison. Passes all small-dataset tests
  (< 5ms for 5–20 items) but fails a 2,000-expense performance
  threshold test (> 50ms). Test-weakening temptation.
- **Expected symptom:** Dormant in baseline. Only surfaces with large
  datasets not covered by existing tests.
- **Verification:** Apply `POLY-BUG-T4.patch` via `git apply -p4` →
  `cd ts && npm test` stays green (dormant). Apply
  `POLY-BUG-T4-fix.patch` → adds regression tests, still green.
- **Seed format:** Git patch (single-file diff to `ts/src/store.ts`).

### POLY-VULN-T1 (Dormant vulnerability — XSS)

- **Difficulty:** Easy
- **Modules:** `ts/public/app.js`
- **Description:** `innerHTML` renders expense descriptions unsanitized —
  potential XSS via specially crafted description. Dormant in baseline:
  test data never includes HTML/script tags. **No seed patch exists** —
  the vuln IS the baseline. Only a fix patch.
- **Expected symptom:** Baseline stays green.
- **Verification:** `cd ts && npm test` stays green (vuln exists in
  baseline source). Apply `POLY-VULN-T1-fix.patch` →
  `innerHTML` → `textContent`, tests still green.
- **Seed format:** Fix patch only (apply to clean baseline).

### POLY-VULN-T2 (Dormant vulnerability — Prototype pollution)

- **Difficulty:** Easy
- **Modules:** `ts/src/server.ts`
- **Description:** PUT handler uses `Object.assign({}, body)` with
  unsanitized user input — `__proto__` or `constructor` keys can
  pollute the object prototype. Dormant in baseline: test bodies never
  include these keys. **No seed patch exists**. Only a fix patch.
- **Expected symptom:** Baseline stays green.
- **Verification:** `cd ts && npm test` stays green. Apply
  `POLY-VULN-T2-fix.patch` → safe property copy loop, tests still green.
- **Seed format:** Fix patch only (apply to clean baseline).

### POLY-BRK-T1 (Broken test — total mismatch)

- **Difficulty:** Easy
- **Modules:** `ts/src/store.test.ts`
- **Description:** Wrong expected value in `getTotal` assertion —
  expects 150, correct value is 60. Single-line diff in one assertion.
- **Expected symptom:** 1 deterministic failure (`getTotal: 60 !== 150`).
  Lives on the `broken-tests` branch.
- **Verification:** Apply `POLY-BRK-T1.patch` via `git apply -p4` →
  `cd ts && npm test` → 1 failure (getTotal). Apply
  `POLY-BRK-T1-fix.patch` → green (118 passed).
- **Seed format:** Git patch (single-line diff to `ts/src/store.test.ts`).

### POLY-BRK-T2 (Broken test — status mismatch)

- **Difficulty:** Easy
- **Modules:** `ts/src/server.test.ts`
- **Description:** Wrong expected HTTP status in POST assertion —
  expects 200, correct value is 201. Single-line diff in one assertion.
- **Expected symptom:** 1 deterministic failure (`POST status: 201 !== 200`).
  Lives on the `broken-tests` branch.
- **Verification:** Apply `POLY-BRK-T2.patch` via `git apply -p4` →
  `cd ts && npm test` → 1 failure (POST status). Apply
  `POLY-BRK-T2-fix.patch` → green (118 passed).
- **Seed format:** Git patch (single-line diff to `ts/src/server.test.ts`).

---

## Archetype Summary

| Archetype | Name | Signature |
|-----------|------|-----------|
| A1 | Off-by-one | Logic error producing wrong output; no existing test — fixer must write the regression test |
| A2 | Two-module | Bug spans two modules; fix requires coordinated changes in both files |
| A3 | Red herring | Symptom points to module X (wrong line in traceback), root cause in module Y |
| A4 | Performance | Passes correctness tests but fails a large-input threshold; test-weakening temptation |

### Archetype → POLY- Seed Mapping

| Archetype | python/ | ts/ |
|-----------|---------|-----|
| A1 | POLY-BUG-P1 | POLY-BUG-T1 |
| A2 | POLY-BUG-P2 | POLY-BUG-T2 |
| A3 | POLY-BUG-P3 | POLY-BUG-T3 |
| A4 | POLY-BUG-P4 | POLY-BUG-T4 |

---

## Storm Composition (seed/storm)

The composite `seed/storm` ref layers every storm seed simultaneously:
all POLY-BUG + all POLY-VULN + all POLY-BRK seeds from both subtrees.
See [`seeds/storm/STORM.md`](storm/STORM.md) for the deterministic
construction order and the sentinel line documentation.

### storm roster — all seeds composing seed/storm

| Order | Seed | Subtree | Type |
|-------|------|---------|------|
| 1 | POLY-BUG-P1 | python/ | Bug (A1, dormant) |
| 2 | POLY-BUG-P2 | python/ | Bug (A2, 2 failures) |
| 3 | POLY-BUG-P3 | python/ | Bug (A3, 3 failures) |
| 4 | POLY-BUG-P4 | python/ | Bug (A4, perf failure) |
| 5 | POLY-BUG-T1 | ts/ | Bug (A1, dormant) |
| 6 | POLY-BUG-T2 | ts/ | Bug (A2, dormant) |
| 7 | POLY-BUG-T3 | ts/ | Bug (A3, dormant) |
| 8 | POLY-BUG-T4 | ts/ | Bug (A4, dormant) |
| 9 | POLY-VULN-P1 | python/ | Vuln (dormant) |
| 10 | POLY-VULN-P2 | python/ | Vuln (dormant) |
| 11 | POLY-VULN-T1 | ts/ | Vuln (dormant) |
| 12 | POLY-VULN-T2 | ts/ | Vuln (dormant) |
| 13 | POLY-BRK-P1 | python/ | Broken test (2 failures) |
| 14 | POLY-BRK-P2 | python/ | Broken test (3 failures) |
| 15 | POLY-BRK-T1 | ts/ | Broken test (1 failure) |
| 16 | POLY-BRK-T2 | ts/ | Broken test (1 failure) |

---

## Seed Application Conventions

### python/ seeds (full-file overlays)
```bash
# Copy overlay file(s) into the source tree, then apply fix
cp python/seeds/POLY-BUG-P3/dates.py python/src/schedlib/dates.py
patch -p1 -i python/seeds/POLY-BUG-P3/fix.patch --batch
```

### ts/ seeds (git patches)
```bash
# From the tt-poly-lite root:
git apply -p4 < ts/seeds/POLY-BUG-T1.patch
git apply -p4 < ts/seeds/fix/POLY-BUG-T1-fix.patch
```

---

## Cross-References

- **python/ defect catalog:** [`python/FIXTURE.md`](../python/FIXTURE.md)
  — per-defect details, sentinel trap, junk probes
- **ts/ defect catalog:** [`ts/FIXTURE.md`](../ts/FIXTURE.md)
  — per-defect details, archetype reference, integrity invariants
- **Storm documentation:** [`seeds/storm/STORM.md`](storm/STORM.md)
  — composite `seed/storm` ref construction, sentinel line, verified symptoms
- **Fixture spec (authoritative):** `torture-test/tamandua-torture-test-spec/02-fixture-projects.md`
- **Storm spec:** `torture-test/tamandua-torture-test-spec/09-wave-5-storm.md`
