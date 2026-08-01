# SEEDS.md — tt-poly Master Seed Catalog

Fixture: **tt-poly** (five-language storm monorepo: `python/`, `ts/`, `go/`,
`java/`, `rust/`)

This is the master catalog for every seed in tt-poly. It documents all
seeds across all 5 subtrees, the cross-language POLY-BUG-A5 seed, archetypes
(A1–A5), seed application conventions per subtree, storm composition, and
cross-references to per-subtree FIXTURE.md defect catalogs.

Derived from the `tt-poly-lite/seeds/SEEDS.md` reference, extended from 2
to 5 subtrees.

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
  `POLY-BRK-T1-fix.patch` → green (59 passed).
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
  `POLY-BRK-T2-fix.patch` → green (59 passed).
- **Seed format:** Git patch (single-line diff to `ts/src/server.test.ts`).

---

## go/ Seeds

See also: [`go/FIXTURE.md`](../go/FIXTURE.md).

### POLY-BUG-G1 (Archetype A1 — Off-by-one)

- **Difficulty:** Easy
- **Modules:** `go/pool.go`
- **Description:** Task counter off-by-one — `Submit` increments the
  counter BEFORE checking if the pool is shut down, so rejected
  submissions inflate the `Submitted()` counter.
- **Expected symptom:** Dormant in baseline. No existing test covers the
  exact counter interleaving that triggers the off-by-one — fixer must
  write the regression test.
- **Verification:** Apply `POLY-BUG-G1/pool.go` overlay →
  `cd go && go test ./...` stays green (dormant). Apply
  `POLY-BUG-G1/fix.patch` → still green + regression test.
- **Seed format:** Full file copy (`pool.go` overlay + `fix.patch`).

### POLY-BUG-G2 (Archetype A2 — Two-module)

- **Difficulty:** Medium
- **Modules:** `go/pool.go`, `go/worker.go`
- **Description:** Error propagation mismatch: `pool.go` wraps errors with
  one format, worker loop checks with another, causing error tasks to
  appear successful. Two independent failures in two code paths.
- **Expected symptom:** Fixing only the error-wrapping → 1 remaining
  failure. Fixing only the worker check → 1 remaining failure. Both must
  be fixed together.
- **Verification:** Apply `POLY-BUG-G2/pool.go` + `worker.go` overlays →
  `cd go && go test ./...` → 2 failures. Apply `POLY-BUG-G2/fix.patch`
  (both locations) → green.
- **Seed format:** Full file copies (`pool.go` + `worker.go` overlays + `fix.patch`).

### POLY-BUG-G3 (Archetype A3 — Red herring)

- **Difficulty:** Medium
- **Modules:** `go/pool.go`, `go/worker.go`
- **Description:** Worker goroutine exits on `ctx.Done()` without
  draining `taskQueue` first. Test suite hangs after tasks are
  submitted and `Shutdown` is called. Symptom looks like a test
  infrastructure/timeout issue; root cause is missing drain logic.
- **Expected symptom:** `go test -timeout 10s ./...` hangs.
- **Verification:** Apply `POLY-BUG-G3/pool.go` + `worker.go` overlays →
  `go test -timeout 10s ./...` hangs (timeout). Apply
  `POLY-BUG-G3/fix.patch` → adds drain-before-exit logic → green.
- **Seed format:** Full file copies (`pool.go` + `worker.go` overlays + `fix.patch`).

### POLY-BUG-G4 (Archetype A4 — Data race)

- **Difficulty:** Medium
- **Modules:** `go/pool.go`
- **Description:** `atomic.Int64` field read with `.Load()` in one path
  but written with direct assignment (not `.Store()`) in another.
  `go test ./...` passes; `go test -race ./...` reports DATA RACE.
- **Expected symptom:** `go test ./...` — 33/33 green. `go test -race
  ./...` reports DATA RACE. Test-weakening temptation: skip concurrent
  test cases.
- **Verification:** Apply `POLY-BUG-G4/pool.go` overlay →
  `go test ./...` green, `go test -race ./...` → DATA RACE. Apply
  `POLY-BUG-G4/fix.patch` → `go test -race ./...` green.
- **Seed format:** Full file copy (`pool.go` overlay + `fix.patch`).

### POLY-VULN-G1 (Dormant vulnerability — Command injection)

- **Difficulty:** Medium
- **Modules:** `go/util/command.go`
- **Description:** `RunCommandShell(cmdStr string)` uses
  `exec.Command("sh", "-c", cmdStr)` — shell injection via unsanitized
  `cmdStr`. Dormant code path — never imported by test suite.
- **Expected symptom:** `go test ./...` stays green. Vulnerability exists
  in source tree but never exercised.
- **Verification:** Inspect `util/command.go`. Apply
  `POLY-VULN-G1/fix.patch` → removes `RunCommandShell`, replaces with
  safe args-list-only variant.
- **Seed format:** Full file copy (`util_command.go` overlay + `fix.patch`).

### POLY-VULN-G2 (Dormant vulnerability — Zip-slip)

- **Difficulty:** Medium
- **Modules:** `go/util/archive.go`
- **Description:** `ExtractTar(...)` uses `header.Name` unsanitized in
  `filepath.Join` — zip-slip path traversal vulnerability. Dormant code path.
- **Expected symptom:** `go test ./...` stays green.
- **Verification:** Inspect `util/archive.go`. Apply
  `POLY-VULN-G2/fix.patch` → adds path traversal guard.
- **Seed format:** Full file copy (`util_archive.go` overlay + `fix.patch`).

### POLY-BRK-G1 (Broken test — off-by-one count)

- **Difficulty:** Easy
- **Modules:** `go/pool_test.go`
- **Description:** One test assertion expects N-1 results after submitting
  N tasks, but the pool correctly returns N results. 1 test fails, 32 pass.
- **Expected symptom:** 1 deterministic failure (off-by-one count mismatch).
- **Verification:** Apply `POLY-BRK-G1/pool_test.go` +
  `POLY-BRK-G1/go.mod` overlays → `go test ./...` → 1 failure. Apply
  `POLY-BRK-G1/fix.patch` → green.
- **Seed format:** Full file copies (`pool_test.go` + `go.mod` overlays + `fix.patch`).

### POLY-BRK-G2 (Broken test — inverted boolean)

- **Difficulty:** Easy
- **Modules:** `go/pool_test.go`
- **Description:** One test uses an inverted boolean assertion — checks
  `err != nil` when task succeeds. 1 test fails, 32 pass.
- **Expected symptom:** 1 deterministic failure (inverted boolean).
- **Verification:** Apply `POLY-BRK-G2/pool_test.go` +
  `POLY-BRK-G2/go.mod` overlays → `go test ./...` → 1 failure. Apply
  `POLY-BRK-G2/fix.patch` → green.
- **Seed format:** Full file copies (`pool_test.go` + `go.mod` overlays + `fix.patch`).

---

## rust/ Seeds

See also: [`rust/FIXTURE.md`](../rust/FIXTURE.md).

### POLY-BUG-R1 (Archetype A1 — Integer overflow)

- **Difficulty:** Easy
- **Modules:** `rust/src/bucket.rs`
- **Description:** Integer overflow in `refill()`: uses `u32` arithmetic
  for `elapsed * refill_rate / 1000` that overflows silently in release
  mode. Debug mode panics; release mode wraps to wrong value. Dormant on
  small token values — fixer must write the regression test with large
  elapsed times.
- **Expected symptom:** `cargo test --quiet` passes (dormant). A test
  with large elapsed (>4,000s) catches overflow in release mode.
- **Verification:** Apply `POLY-BUG-R1/bucket.rs` overlay → `cargo test
  --quiet` green (dormant). Write regression test with large values →
  overflow manifests. Apply `POLY-BUG-R1/fix.patch` → u64 intermediate +
  `.min(u32::MAX)` clamping → green.
- **Seed format:** Full file copy (`bucket.rs` overlay + `fix.patch`).

### POLY-BUG-R2 (Archetype A2 — Two-module)

- **Difficulty:** Medium
- **Modules:** `rust/src/config.rs`, `rust/src/bucket.rs`
- **Description:** Two simultaneous bugs: (1) `RateLimiterConfig::with_burst_size()`
  and `with_refill_interval()` accept arguments but silently ignore them.
  (2) `TokenBucket::new()` uses `max_tokens` instead of `burst_size`, and
  `refill()` hardcodes 100ms interval. Fixing either file alone leaves
  failures.
- **Expected symptom:** Fix only config.rs → 1 integration failure
  remains. Fix only bucket.rs → 3 config unit test failures remain.
  Both must be fixed.
- **Verification:** Apply `POLY-BUG-R2/config.rs` + `bucket.rs` overlays →
  `cargo test --quiet` → 3 config failures + 1 integration failure.
  Apply `POLY-BUG-R2/fix.patch` (both locations) → green.
- **Seed format:** Full file copies (`config.rs` + `bucket.rs` overlays + `fix.patch`).

### POLY-BUG-R3 (Archetype A3 — Red herring / infinite loop)

- **Difficulty:** Medium
- **Modules:** `rust/src/bucket.rs`
- **Description:** `try_consume()` wraps the CAS logic in an outer
  infinite loop — when tokens are insufficient, it calls `refill()` and
  retries without any yield or bound. Tests that expect `try_consume` to
  return `false` hang forever. Visible symptom is a test timeout (looks
  like infrastructure issue).
- **Expected symptom:** `cargo test` hangs on
  `try_consume_exhaustive_sequence`, `consume_one_from_one`,
  `reset_resets_refill_clock`, `tokens_drain_before_refill_interval`.
- **Verification:** Apply `POLY-BUG-R3/bucket.rs` overlay → `cargo test`
  hangs. Apply `POLY-BUG-R3/fix.patch` → restores `try_consume` returning
  `false` + regression tests → green.
- **Seed format:** Full file copy (`bucket.rs` overlay + `fix.patch`).

### POLY-BUG-R4 (Archetype A4 — Performance)

- **Difficulty:** Medium
- **Modules:** `rust/src/bucket.rs`
- **Description:** O(n²) behavior: `AtomicU64` `consume_count` incremented
  per `try_consume()`, `refill()` spins `black_box`-guarded loop
  `0..consume_count` on every call. Small-input tests (<100 requests)
  pass (<1ms). 10,000 requests fail threshold (>50ms).
- **Expected symptom:** `cargo test --quiet` passes (dormant). Performance
  threshold test with 10,000 requests fails (>200ms).
- **Verification:** Apply `POLY-BUG-R4/bucket.rs` overlay → `cargo test
  --quiet` green (dormant on small input). Run 10k threshold test → fails.
  Apply `POLY-BUG-R4/fix.patch` → O(1) refill + 3 regression tests → green.
- **Seed format:** Full file copy (`bucket.rs` overlay + `fix.patch`).

### POLY-VULN-R1 (Dormant vulnerability — Unsafe UB)

- **Difficulty:** Medium
- **Modules:** `rust/src/util_unsafe.rs`
- **Description:** `get_unchecked`/`set_unchecked` use unsafe pointer
  arithmetic without bounds checking. Out-of-bounds access is undefined
  behavior. Dormant code path — never called by test suite.
- **Expected symptom:** `cargo test --quiet` stays green (dormant).
- **Verification:** Inspect `util_unsafe.rs`. Apply
  `POLY-VULN-R1/fix.patch` → replaces unsafe with safe `Vec::get`/`get_mut`
  returning `Option`.
- **Seed format:** Full file copy (`util_unsafe.rs` same as baseline + `fix.patch`).

### POLY-VULN-R2 (Dormant vulnerability — Timing side-channel)

- **Difficulty:** Medium
- **Modules:** `rust/src/util_timing.rs`
- **Description:** `timing_unsafe_compare` compares byte slices with
  short-circuiting `!=` loop — returns `false` on first mismatch.
  Attacker can measure response time to determine position of first
  differing byte. Dormant code path.
- **Expected symptom:** `cargo test --quiet` stays green (dormant).
- **Verification:** Inspect `util_timing.rs`. Apply
  `POLY-VULN-R2/fix.patch` → replaces with XOR-accumulator constant-time
  comparison.
- **Seed format:** Full file copy (`util_timing.rs` same as baseline + `fix.patch`).

### POLY-BRK-R1 (Broken test — off-by-one count)

- **Difficulty:** Easy
- **Modules:** `rust/tests/integration.rs`
- **Description:** `integration_concurrent_consumers` asserts 4,999 tokens
  consumed when 5,000 are actually consumed. 1 test fails, 16 pass.
- **Expected symptom:** `assertion 'left == right' failed: left: 5000, right: 4999`.
- **Verification:** Apply `POLY-BRK-R1/integration.rs` overlay →
  `cargo test` → 1 failure (off-by-one count). Apply
  `POLY-BRK-R1/fix.patch` → green.
- **Seed format:** Full file copy (`integration.rs` overlay + `fix.patch`).

### POLY-BRK-R2 (Broken test — inverted boolean)

- **Difficulty:** Easy
- **Modules:** `rust/tests/integration.rs`
- **Description:** `integration_try_consume_fails_when_insufficient` asserts
  `try_consume(4)` is `true` when correct value is `false`. 1 test fails,
  16 pass.
- **Expected symptom:** `assertion failed: bucket.try_consume(4)`.
- **Verification:** Apply `POLY-BRK-R2/integration.rs` overlay →
  `cargo test` → 1 failure (inverted boolean). Apply
  `POLY-BRK-R2/fix.patch` → green.
- **Seed format:** Full file copy (`integration.rs` overlay + `fix.patch`).

---

## java/ Seeds

See also: [`java/FIXTURE.md`](../java/FIXTURE.md).

### POLY-BUG-J1 (Archetype A1 — Off-by-one)

- **Difficulty:** Easy
- **Modules:** `java/src/main/java/com/tamandua/ledger/MoneyUtils.java`
- **Description:** `MoneyUtils.round(amount, scale, mode)` uses
  `setScale(scale - 1, mode)` instead of `setScale(scale, mode)`, causing
  HALF_UP to truncate one extra digit. 2.445 rounds to 2.4 instead of 2.45.
- **Expected symptom:** 12 round-related failures in `MoneyUtilsTest`.
- **Verification:** Apply `POLY-BUG-J1.patch` via `git apply -p4` →
  `./mvnw -q -B test` → 12 failures. Apply
  `POLY-BUG-J1-fix.patch` → green + regression test.
- **Seed format:** Git patch (single-file diff to `MoneyUtils.java`).

### POLY-BUG-J2 (Archetype A2 — Two-module)

- **Difficulty:** Medium
- **Modules:** `java/.../CsvParser.java`, `java/.../LedgerService.java`
- **Description:** Two independent failures: (1) `CsvParser.parse()` returns
  `null` instead of empty list for header-only CSV. (2) `LedgerService.getTotal()`
  loses null-guard → `NullPointerException`. 3 test failures total.
- **Expected symptom:** Fix only CsvParser → 2 remaining failures
  (LedgerService NPE). Fix only LedgerService → 1 remaining failure
  (CsvParser returns null). Both must be fixed.
- **Verification:** Apply `POLY-BUG-J2.patch` via `git apply -p4` →
  `./mvnw -q -B test` → 3 failures. Apply `POLY-BUG-J2-fix.patch` → green
  + 2 regression tests.
- **Seed format:** Git patch (two-file diff: `CsvParser.java` + `LedgerService.java`).

### POLY-BUG-J3 (Archetype A3 — Red herring)

- **Difficulty:** Medium
- **Modules:** `java/.../CsvParser.java` (root cause), `java/.../CliApp.java` (symptom surface)
- **Description:** CsvParser swaps amount and category column indices
  (index 3 ↔ 4). Symptom: LedgerService methods return wrong results,
  CliAppTest failures point to LedgerService. Root cause: column swap in
  CsvParser. LedgerServiceTest passes perfectly (44/44) — data entered
  programmatically bypasses CsvParser.
- **Expected symptom:** 15 failures: 4 in `CsvParserTest`, 11 in
  `CliAppTest`. `LedgerServiceTest`: 44/44 green.
- **Verification:** Apply `POLY-BUG-J3.patch` via `git apply -p4` →
  `./mvnw -q -B test` → 15 failures (4 CsvParserTest + 11 CliAppTest).
  Apply `POLY-BUG-J3-fix.patch` (CsvParser column indices only) → green.
- **Seed format:** Git patch (single-file diff to `CsvParser.java`).

### POLY-BUG-J4 (Archetype A4 — Performance)

- **Difficulty:** Medium
- **Modules:** `java/.../LedgerService.java`
- **Description:** O(n²) `getCategoryTotals()` nested-loop grouping.
  Passes all correctness tests on small datasets (3–10 entries, <1ms).
  Performance test with 50,000 entries fails threshold (>500ms, actual
  ~5s).
- **Expected symptom:** All 131 existing tests pass (dormant on small
  input). Performance regression test times out at ~5,250ms > 500ms.
- **Verification:** Apply `POLY-BUG-J4.patch` via `git apply -p4` →
  `./mvnw -q -B test` → 131/131 green (dormant). Run performance
  regression test → times out. Apply `POLY-BUG-J4-fix.patch` →
  O(n) HashMap merge → <50ms.
- **Seed format:** Git patch (single-file diff to `LedgerService.java`).

### POLY-VULN-J1 (Dormant vulnerability — XXE)

- **Difficulty:** Medium
- **Modules:** `java/.../XmlImportService.java`
- **Description:** `DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml)`
  without security configuration — no disabling of external entities, DTD
  processing, or XInclude. XXE attack can read arbitrary files.
  Dormant: never imported by test suite.
- **Expected symptom:** 131/131 green. Vulnerability exists in dormant
  baseline class.
- **Verification:** Inspect `XmlImportService.java`. Apply
  `POLY-VULN-J1-fix.patch` → secure `DocumentBuilderFactory` config +
  `XmlImportServiceTest` (5 tests).
- **Seed format:** No seed patch (vuln IS baseline); fix patch only.

### POLY-VULN-J2 (Dormant vulnerability — Path traversal)

- **Difficulty:** Medium
- **Modules:** `java/.../ExportService.java`
- **Description:** `new FileWriter(filename)` accepts any path without
  validation — `../` segments can escape the working directory and
  overwrite arbitrary files. Dormant: never imported by test suite.
- **Expected symptom:** 131/131 green. Vulnerability exists in dormant
  baseline class.
- **Verification:** Inspect `ExportService.java`. Apply
  `POLY-VULN-J2-fix.patch` → canonical-path containment check +
  `ExportServiceTest` (6 tests).
- **Seed format:** No seed patch (vuln IS baseline); fix patch only.

### POLY-BRK-J1 (Broken test — wrong total)

- **Difficulty:** Easy
- **Modules:** `java/.../LedgerServiceTest.java`
- **Description:** `getTotalSampleDataset` asserts expected total of
  450.00 when correct value is 475.00. 1 test fails, 130 pass.
- **Expected symptom:** `expected: <450.00> but was: <475.00>`.
- **Verification:** Apply `POLY-BRK-J1.patch` via `git apply -p4` →
  `./mvnw -q -B test` → 1 failure. Apply `POLY-BRK-J1-fix.patch` → green.
- **Seed format:** Git patch (single-line diff to `LedgerServiceTest.java`).

### POLY-BRK-J2 (Broken test — wrong string)

- **Difficulty:** Easy
- **Modules:** `java/.../CliAppTest.java`
- **Description:** `listPrintsCorrectFormat` asserts output contains
  "groceries" when the actual category is "food". 1 test fails, 130 pass.
- **Expected symptom:** `expected: <true> but was: <false>`.
- **Verification:** Apply `POLY-BRK-J2.patch` via `git apply -p4` →
  `./mvnw -q -B test` → 1 failure. Apply `POLY-BRK-J2-fix.patch` → green.
- **Seed format:** Git patch (single-line diff to `CliAppTest.java`).

---

## Cross-Language Seed: POLY-BUG-A5 (Archetype A5)

See also: [`python/FIXTURE.md`](../python/FIXTURE.md) and
[`ts/FIXTURE.md`](../ts/FIXTURE.md).

### POLY-BUG-A5 (Archetype A5 — Cross-language integration)

- **Difficulty:** Medium
- **Archetype:** A5 — cross-language integration bug
- **Modules:** `python/src/schedlib/integrations.py`, `ts/src/server.ts`
- **Description:** `integrations.py` exports a `lookup_calendar_name()`
  function that returns a dict with `{"name": str, "id": int}`.
  `ts/src/server.ts` imports/calls this function via a test-only bridge
  and expects `{name: string, id: number}`.
  The seed changes the Python function signature to return
  `{"calendar_name": str, "calendar_id": int}`, AND changes the TS bridge
  to expect `{calendar_name, calendar_id}` — both subtrees are modified.
  Fixing only python/ or only ts/ leaves one subtree's test failing —
  the partial-fix property is cross-language. This is union-of-merges
  bait for the storm: a merge that takes only the Python fix or only
  the TS fix breaks the other subtree.

- **Expected symptom:** After applying both overlays: python/ tests fail
  (changed dict keys), ts/ tests fail (changed expected keys). Fix only
  python/ → ts/ tests still red. Fix only ts/ → python/ tests still red.
  Both must be fixed together.

- **Verification:** Apply `POLY-BUG-A5/integrations.py` overlay to python/,
  `POLY-BUG-A5/test_calendar_integration.py` overlay to python/tests/,
  and `POLY-BUG-A5/server.ts` overlay to ts/. Run `cd python &&
  .venv/bin/pytest -q` → failures (test_calendar_integration.py fails).
  Run `cd ts && npm test` → failures. Apply `POLY-BUG-A5/fix.patch`
  (coordinated fix for all three files) → both green.

- **Seed format:** Full file overlays
  (`python/seeds/POLY-BUG-A5/integrations.py` +
  `ts/seeds/POLY-BUG-A5/server.ts` +
  `python/seeds/POLY-BUG-A5/test_calendar_integration.py`) + `fix.patch`.

---

## Archetype Summary

| Archetype | Name | Signature |
|-----------|------|-----------|
| A1 | Off-by-one / Overflow | Logic error producing wrong output; no existing test — fixer must write the regression test |
| A2 | Two-module | Bug spans two modules/locations; fix requires coordinated changes in both — single-file fix leaves failures |
| A3 | Red herring | Visible symptom points to module X (wrong line in traceback/test failure), root cause in module Y. Fixing X masks but does not fix the real bug |
| A4 | Performance / Data race | Passes all correctness tests but fails a threshold/race-detector test. Test-weakening temptation (raise timeout, reduce dataset, skip concurrent tests) |
| A5 | Cross-language integration | Bug spans two language subtrees; fix in one breaks the other. Union-of-merges bait — partial fixes break one subtree |

### Archetype-to-Seed Mapping

| Archetype | python/ | ts/ | go/ | rust/ | java/ |
|-----------|---------|-----|-----|-------|-------|
| A1 | POLY-BUG-P1 | POLY-BUG-T1 | POLY-BUG-G1 | POLY-BUG-R1 | POLY-BUG-J1 |
| A2 | POLY-BUG-P2 | POLY-BUG-T2 | POLY-BUG-G2 | POLY-BUG-R2 | POLY-BUG-J2 |
| A3 | POLY-BUG-P3 | POLY-BUG-T3 | POLY-BUG-G3 | POLY-BUG-R3 | POLY-BUG-J3 |
| A4 | POLY-BUG-P4 | POLY-BUG-T4 | POLY-BUG-G4 | POLY-BUG-R4 | POLY-BUG-J4 |
| A5 | POLY-BUG-A5 | POLY-BUG-A5 | — | — | — |

---

## Storm Composition (seed/storm)

The composite `seed/storm` ref layers every storm seed simultaneously:
all POLY-BUG + all POLY-VULN + all POLY-BRK seeds from all 5 subtrees.
See `seeds/storm/STORM.md` for the deterministic construction order and
the sentinel line documentation.

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
| 9 | POLY-BUG-G1 | go/ | Bug (A1, dormant) |
| 10 | POLY-BUG-G2 | go/ | Bug (A2, 2 failures) |
| 11 | POLY-BUG-G3 | go/ | Bug (A3, hang) |
| 12 | POLY-BUG-G4 | go/ | Bug (A4, data race) |
| 13 | POLY-BUG-R1 | rust/ | Bug (A1, dormant) |
| 14 | POLY-BUG-R2 | rust/ | Bug (A2, 4 failures) |
| 15 | POLY-BUG-R3 | rust/ | Bug (A3, hang) |
| 16 | POLY-BUG-R4 | rust/ | Bug (A4, perf failure) |
| 17 | POLY-BUG-J1 | java/ | Bug (A1, 12 failures) |
| 18 | POLY-BUG-J2 | java/ | Bug (A2, 3 failures) |
| 19 | POLY-BUG-J3 | java/ | Bug (A3, 15 failures) |
| 20 | POLY-BUG-J4 | java/ | Bug (A4, perf failure) |
| 21 | POLY-BUG-A5 | python/ + ts/ | Bug (A5, cross-language) |
| 22 | POLY-VULN-P1 | python/ | Vuln (dormant) |
| 23 | POLY-VULN-P2 | python/ | Vuln (dormant) |
| 24 | POLY-VULN-T1 | ts/ | Vuln (dormant) |
| 25 | POLY-VULN-T2 | ts/ | Vuln (dormant) |
| 26 | POLY-VULN-G1 | go/ | Vuln (dormant) |
| 27 | POLY-VULN-G2 | go/ | Vuln (dormant) |
| 28 | POLY-VULN-R1 | rust/ | Vuln (dormant) |
| 29 | POLY-VULN-R2 | rust/ | Vuln (dormant) |
| 30 | POLY-VULN-J1 | java/ | Vuln (dormant) |
| 31 | POLY-VULN-J2 | java/ | Vuln (dormant) |
| 32 | POLY-BRK-P1 | python/ | Broken test (2 failures) |
| 33 | POLY-BRK-P2 | python/ | Broken test (3 failures) |
| 34 | POLY-BRK-T1 | ts/ | Broken test (1 failure) |
| 35 | POLY-BRK-T2 | ts/ | Broken test (1 failure) |
| 36 | POLY-BRK-G1 | go/ | Broken test (1 failure) |
| 37 | POLY-BRK-G2 | go/ | Broken test (1 failure) |
| 38 | POLY-BRK-R1 | rust/ | Broken test (1 failure) |
| 39 | POLY-BRK-R2 | rust/ | Broken test (1 failure) |
| 40 | POLY-BRK-J1 | java/ | Broken test (1 failure) |
| 41 | POLY-BRK-J2 | java/ | Broken test (1 failure) |

---

## Seed Application Conventions

### python/ seeds (full-file overlays)

```bash
# Copy overlay file(s) into the source tree, then apply fix
cp python/seeds/POLY-BUG-P3/dates.py python/src/schedlib/dates.py
patch -p0 < python/seeds/POLY-BUG-P3/fix.patch
```

### ts/ seeds (git patches)

```bash
# From the tt-poly root:
git apply -p4 < ts/seeds/POLY-BUG-T1.patch
git apply -p4 < ts/seeds/fix/POLY-BUG-T1-fix.patch
```

### go/ seeds (full-file overlays)

```bash
# Copy overlay file(s) into the source tree, then apply fix
cp go/seeds/POLY-BUG-G1/pool.go go/pool.go
patch -p0 < go/seeds/POLY-BUG-G1/fix.patch
```

### rust/ seeds (full-file overlays)

```bash
# Copy overlay file(s) into the source tree, then apply fix
cp rust/seeds/POLY-BUG-R1/bucket.rs rust/src/bucket.rs
patch -p0 < rust/seeds/POLY-BUG-R1/fix.patch
```

### java/ seeds (git patches)

```bash
# From the repository root:
git apply -p4 < java/seeds/POLY-BUG-J1.patch
git apply -p4 < java/seeds/fix/POLY-BUG-J1-fix.patch
```

### POLY-BUG-A5 (cross-language full-file overlays)

```bash
# Apply both overlays, verify cross-language partial-fix property
cp python/seeds/POLY-BUG-A5/integrations.py python/src/schedlib/integrations.py
cp ts/seeds/POLY-BUG-A5/server.ts ts/src/server.ts
patch -p0 < python/seeds/POLY-BUG-A5/fix.patch
# Verify: both python/ and ts/ suites green
```

### POLY-FLAKY-P1 (python/ arming overlay, no fix.patch)

```bash
# Arm the flaky probe (deterministic alternator)
cp python/seeds/POLY-FLAKY-P1/conftest.py python/conftest.py
# Run twice: 1st passes, 2nd fails. "Fix" is restoring baseline conftest.py
```

---

## Seed Catalog Summary

| Subtree | BUG | VULN | BRK | FLAKY | Total |
|---------|-----|------|-----|-------|-------|
| python/ | P1–P4 | P1–P2 | P1–P2 | P1 | 9 |
| ts/ | T1–T4 | T1–T2 | T1–T2 | — | 8 |
| go/ | G1–G4 | G1–G2 | G1–G2 | — | 8 |
| rust/ | R1–R4 | R1–R2 | R1–R2 | — | 8 |
| java/ | J1–J4 | J1–J2 | J1–J2 | — | 8 |
| cross-language | A5 | — | — | — | 1 |
| **Total** | **21** | **10** | **10** | **1** | **42** |

---

## Cross-References

- **python/ defect catalog:** [`python/FIXTURE.md`](../python/FIXTURE.md)
  — per-defect details, sentinel trap, junk probes, integrity invariants
- **ts/ defect catalog:** [`ts/FIXTURE.md`](../ts/FIXTURE.md)
  — per-defect details, archetype reference, integrity invariants
- **go/ defect catalog:** [`go/FIXTURE.md`](../go/FIXTURE.md)
  — per-defect details, archetype mapping, integrity invariants
- **rust/ defect catalog:** [`rust/FIXTURE.md`](../rust/FIXTURE.md)
  — per-defect details, archetype mapping, integrity invariants
- **java/ defect catalog:** [`java/FIXTURE.md`](../java/FIXTURE.md)
  — per-defect details, patch conventions, integrity invariants, traps
- **python/ per-seed catalog:** [`python/seeds/SEEDS.md`](python/SEEDS.md)
- **go/ per-seed catalog:** [`go/seeds/SEEDS.md`](go/SEEDS.md)
- **rust/ per-seed catalog:** [`rust/seeds/SEEDS.md`](rust/SEEDS.md)
- **java/ per-seed catalog:** [`java/seeds/SEEDS.md`](java/SEEDS.md)
- **Storm documentation:** [`seeds/storm/STORM.md`](storm/STORM.md)
  — composite `seed/storm` ref construction, sentinel line, verified symptoms
- **Fixture spec (authoritative):** `torture-test/tamandua-torture-test-spec/02-fixture-projects.md`
- **Storm spec:** `torture-test/tamandua-torture-test-spec/09-wave-5-storm.md`

---

## Per-Subtree Seed Layouts

### python/
```
python/seeds/
  POLY-BUG-P1/     (recurrence.py + fix.patch)
  POLY-BUG-P2/     (recurrence.py + conflict.py + fix.patch)
  POLY-BUG-P3/     (dates.py + fix.patch)
  POLY-BUG-P4/     (conflict.py + fix.patch)
  POLY-BUG-A5/     (integrations.py + server.ts + test_calendar_integration.py + fix.patch)
  POLY-VULN-P1/    (integrations.py + fix.patch)
  POLY-VULN-P2/    (integrations.py + fix.patch)
  POLY-BRK-P1/     (test_broken_p1.py + fix.patch)
  POLY-BRK-P2/     (test_broken_p2.py + fix.patch)
  POLY-FLAKY-P1/   (conftest.py, no fix.patch)
```

### ts/
```
ts/seeds/
  POLY-BUG-T1.patch    (off-by-one in store.ts)
  POLY-BUG-T2.patch    (date parsing mismatch, 2 files)
  POLY-BUG-T3.patch    (array order corruption in store.ts)
  POLY-BUG-T4.patch    (O(n²) category filter)
  POLY-BRK-T1.patch    (wrong expected total)
  POLY-BRK-T2.patch    (wrong expected status)
  POLY-BUG-A5/         (server.ts overlay + integrations.py overlay + test_calendar_integration.py + fix.patch)
  fix/
    POLY-BUG-T1-fix.patch
    POLY-BUG-T2-fix.patch
    POLY-BUG-T3-fix.patch
    POLY-BUG-T4-fix.patch
    POLY-VULN-T1-fix.patch
    POLY-VULN-T2-fix.patch
    POLY-BRK-T1-fix.patch
    POLY-BRK-T2-fix.patch
```

### go/
```
go/seeds/
  POLY-BUG-G1/  (pool.go + fix.patch)
  POLY-BUG-G2/  (pool.go + worker.go + fix.patch)
  POLY-BUG-G3/  (pool.go + worker.go + fix.patch)
  POLY-BUG-G4/  (pool.go + fix.patch)
  POLY-VULN-G1/ (util_command.go + fix.patch)
  POLY-VULN-G2/ (util_archive.go + fix.patch)
  POLY-BRK-G1/  (pool_test.go + go.mod + fix.patch)
  POLY-BRK-G2/  (pool_test.go + go.mod + fix.patch)
```

### rust/
```
rust/seeds/
  POLY-BUG-R1/  (bucket.rs + fix.patch)
  POLY-BUG-R2/  (config.rs + bucket.rs + fix.patch)
  POLY-BUG-R3/  (bucket.rs + fix.patch)
  POLY-BUG-R4/  (bucket.rs + fix.patch)
  POLY-VULN-R1/ (util_unsafe.rs + fix.patch)
  POLY-VULN-R2/ (util_timing.rs + fix.patch)
  POLY-BRK-R1/  (integration.rs + fix.patch)
  POLY-BRK-R2/  (integration.rs + fix.patch)
```

### java/
```
java/seeds/
  POLY-BUG-J1.patch   (off-by-one rounding scale)
  POLY-BUG-J2.patch   (null-deref + NPE, 2 files)
  POLY-BUG-J3.patch   (column-index swap, red-herring)
  POLY-BUG-J4.patch   (O(n²) category totals)
  POLY-BRK-J1.patch   (wrong expected total)
  POLY-BRK-J2.patch   (wrong expected category)
  fix/
    POLY-BUG-J1-fix.patch
    POLY-BUG-J2-fix.patch
    POLY-BUG-J3-fix.patch
    POLY-BUG-J4-fix.patch
    POLY-VULN-J1-fix.patch
    POLY-VULN-J2-fix.patch
    POLY-BRK-J1-fix.patch
    POLY-BRK-J2-fix.patch
```
