# SEEDS.md — tt-python Seed Catalog

Fixture: **tt-python** (schedlib — scheduling & date utility library)
Language: Python ≥ 3.9 | Test runner: pytest | ~900 LOC

This document catalogs every seed in the tt-python torture fixture. Each
seed is a self-contained directory under `seeds/` containing the overlay
files (full copies of source with the defect/vulnerability/arming applied)
and a `fix.patch` that reverses the change. Seeds are applied on top of the
green baseline to create immutable `seed/<ID>` refs in the golden bare repo.

Cross-reference: see `FIXTURE.md` at the fixture root for the seeded content
plan and archetype mapping.

---

## Defect Seeds (BUG-P1..P4)

### BUG-P1

| Field | Value |
|---|---|
| **Stable ID** | `BUG-P1` |
| **Archetype** | A1 — logic off-by-one with observable wrong output |
| **Difficulty** | easy |
| **Module(s)** | `src/schedlib/recurrence.py` |
| **Expected Symptom** | `RecurrenceRule.occurrences()` produces one fewer occurrence than requested when both `count` and `until` are set. A rule like `weekly(count=52, until=<end-of-year>)` yields 51 events instead of 52. |
| **Verify** | Check out `seed/BUG-P1` from the golden bare repo. Run `python3 -m pytest -q -k "test_count_and_until"` — no existing test covers this combination (fixer must WRITE the regression test). Apply `seeds/BUG-P1/fix.patch` with `patch -p0` to restore green. |

**Seed layout:** `seeds/BUG-P1/recurrence.py` (full overlay), `seeds/BUG-P1/fix.patch`

**Bug mechanism:** `max_count_val = max(0, count - 1)` decrements the count
before iteration, causing off-by-one when both count and until limits coexist.
No existing test exercises the count+until combination — baseline stays green.
The fixer must write a regression test and remove the two buggy lines.

---

### BUG-P2

| Field | Value |
|---|---|
| **Stable ID** | `BUG-P2` |
| **Archetype** | A2 — two-module bug requiring a coordinated 2-file fix |
| **Difficulty** | medium |
| **Module(s)** | `src/schedlib/recurrence.py` + `src/schedlib/conflict.py` |
| **Expected Symptom** | Two independent failures: (1) `yearly(interval=2)` produces annual (5 results) instead of biennial (3 results) — `_advance()` ignores `self.interval` for YEARLY; (2) `conflict_severity()` CONTAINED check uses strict `<`/`>` instead of `<=`/`>=`, so events with identical start/end bounds fall through to HARD. |
| **Verify** | Check out `seed/BUG-P2`. Run the full suite — 2 failures. Fix only `recurrence.py` → 1 remaining failure (`test_contained_equal_bounds`). Fix only `conflict.py` → 1 remaining failure (`test_every_two_years`). Apply `seeds/BUG-P2/fix.patch` (both files) → green. |

**Seed layout:** `seeds/BUG-P2/recurrence.py`, `seeds/BUG-P2/conflict.py`, `seeds/BUG-P2/fix.patch`

**Partial-fix property:** Either single-file fix leaves one test failure —
both modules must be corrected. This forces agents to diagnose both symptoms
rather than stopping after the first fix works.

---

### BUG-P3

| Field | Value |
|---|---|
| **Stable ID** | `BUG-P3` |
| **Archetype** | A3 — red-herring (symptom points at module X, root cause in Y) |
| **Difficulty** | medium |
| **Module(s)** | `src/schedlib/dates.py` (Y — root cause), `src/schedlib/calendar_helpers.py` (X — symptom) |
| **Expected Symptom** | Test failures in `test_calendar_helpers.py`: `is_business_day()` returns True for Saturdays; `next_business_day()` and `previous_business_day()` return wrong results around weekends. Tracebacks point to `calendar_helpers.py` as the failing module, but the actual bug is `is_weekday()` in `dates.py` treating Saturday (`weekday() == 5`) as a weekday via `<= 5` instead of `< 5`. |
| **Verify** | Check out `seed/BUG-P3`. 4 test failures — 3 trace through `calendar_helpers.py` functions, only 1 directly tests `is_weekday` in `dates.py`. Fixing the symptom in `calendar_helpers.py` (patching `is_business_day`) papers over the bug; the correct fix is in `dates.py` alone. Apply `seeds/BUG-P3/fix.patch` (modifies only `dates.py`) → green. |

**Seed layout:** `seeds/BUG-P3/dates.py`, `seeds/BUG-P3/fix.patch`

**Red-herring mechanism:** `is_weekday()` is a utility consumed by
`calendar_helpers.py`'s business-day functions. The failing assertions name
calendar helper functions, and the stack traces show `calendar_helpers.py`
as the immediate call site — a natural first place to look. The root cause
lives one module deeper in `dates.py`.

---

### BUG-P4

| Field | Value |
|---|---|
| **Stable ID** | `BUG-P4` |
| **Archetype** | A4 — performance bug with a threshold test that fails on large input |
| **Difficulty** | medium |
| **Module(s)** | `src/schedlib/conflict.py` |
| **Expected Symptom** | `test_available_slots_threshold` (10,000 tightly-packed events, must complete under 2.0 seconds) takes ~2.8s and fails. All 6 correctness tests on small inputs pass identically to the efficient version — the bug only surfaces at scale. |
| **Verify** | Check out `seed/BUG-P4`. Run `python3 -m pytest -q tests/test_performance.py` — threshold test fails (~2.8s > 2.0s). The 6 correctness tests pass. Apply `seeds/BUG-P4/fix.patch` → all 7 tests pass in ~0.06s. |

**Seed layout:** `seeds/BUG-P4/conflict.py`, `seeds/BUG-P4/fix.patch`

**Bug mechanism:** `find_available_slots()` uses an O(n²) nested-loop merge
(`while changed` scanning all pairs) instead of the correct O(n log n)
sort+single-pass `_coalesce_intervals()` merge. Output on small inputs is
bit-identical — correctness tests cannot catch it. The fixer must recognize
the algorithmic inefficiency rather than weakening the threshold.

**Test-weakening temptation:** Raising the time limit or reducing the event
count masks the regression without fixing the root cause.

---

## Vulnerability Seeds (VULN-P1..P2)

### VULN-P1

| Field | Value |
|---|---|
| **Stable ID** | `VULN-P1` |
| **Archetype** | N/A (vulnerability seed — dormant code path) |
| **Difficulty** | medium |
| **Module(s)** | `src/schedlib/integrations.py` |
| **Expected Symptom** | `import_schedule_from_yaml()` uses unsafe `yaml.load(fh, Loader=yaml.Loader)` for deserialization, allowing arbitrary code execution from crafted YAML input. The code path is dormant — `integrations.py` is never imported by the library or test suite, so the baseline stays green. The vulnerability is discoverable via static analysis or code review. |
| **Verify** | Check out `seed/VULN-P1`. Baseline suite: 157/157 green (dormant code not exercised). Inspect `integrations.py` line `yaml.load(fh, Loader=yaml.Loader)` — this is the vulnerable call. Apply `seeds/VULN-P1/fix.patch` → replaces with `yaml.safe_load(fh)`. |

**Seed layout:** `seeds/VULN-P1/integrations.py`, `seeds/VULN-P1/fix.patch`

**Fix:** Replace `yaml.load(fh, Loader=yaml.Loader)` with `yaml.safe_load(fh)`.
The `yaml` module is not a stdlib dependency — it is imported only inside the
dormant function body, so the module is never loaded at import time and
baseline tests never trip over the missing import.

---

### VULN-P2

| Field | Value |
|---|---|
| **Stable ID** | `VULN-P2` |
| **Archetype** | N/A (vulnerability seed — dormant code path) |
| **Difficulty** | medium |
| **Module(s)** | `src/schedlib/integrations.py` |
| **Expected Symptom** | `run_external_calendar_sync()` and `run_external_calendar_sync_with_timeout()` use `subprocess.run(command, shell=True)` with a string command parameter, allowing shell injection via unsanitized input. The code paths are dormant — never called by the test suite. |
| **Verify** | Check out `seed/VULN-P2`. Baseline suite: 157/157 green. Inspect `integrations.py` — both functions accept `command: str` and pass it to `subprocess.run(..., shell=True)`. Apply `seeds/VULN-P2/fix.patch` → changes signatures to `args: list[str]` and removes `shell=True`. |

**Seed layout:** `seeds/VULN-P2/integrations.py`, `seeds/VULN-P2/fix.patch`

**Fix:** Change function signatures from `command: str` to `args: list[str]`,
remove `shell=True` (defaults to `shell=False`), converting the injection-prone
string command into a safe argument list.

---

## Broken Test Seeds (BRK-P1..P2)

These seeds live on the `broken-tests` branch (NOT on main/green-base).
They contain genuinely failing test assertions for quarantine workflows.

### BRK-P1

| Field | Value |
|---|---|
| **Stable ID** | `BRK-P1` |
| **Archetype** | N/A (broken test — quarantine seed) |
| **Difficulty** | easy |
| **Module(s)** | `tests/test_broken_p1.py` |
| **Expected Symptom** | Two assertions in `add_business_days()` tests use wrong expected dates — confuses calendar days with business days. Failure message: `assert datetime.date(2026, 8, 3) == datetime.date(2026, 7, 31)` — a clear 3-day gap driven by weekend offset. |
| **Verify** | Check out the `broken-tests` branch. Run `python3 -m pytest -q tests/test_broken_p1.py` — 2 failures with date mismatch messages. Apply `seeds/BRK-P1/fix.patch` → both tests pass. |

**Seed layout:** `seeds/BRK-P1/test_broken_p1.py`, `seeds/BRK-P1/fix.patch`

**Failure pattern:** Date value mismatch — the expected values use the
wrong dates because the author treated business day offsets as calendar
day offsets.

---

### BRK-P2

| Field | Value |
|---|---|
| **Stable ID** | `BRK-P2` |
| **Archetype** | N/A (broken test — quarantine seed) |
| **Difficulty** | easy |
| **Module(s)** | `tests/test_broken_p2.py` |
| **Expected Symptom** | Three assertions in `find_conflicts()` tests use wrong expected conflict counts. Failure messages: e.g. `assert 2 == 1` (expected 1, actual 2) and `assert 0 == 1` (expected 1, actual 0). All three failures are integer mismatch pattern. |
| **Verify** | Check out the `broken-tests` branch. Run `python3 -m pytest -q tests/test_broken_p2.py` — 3 failures with integer mismatch messages. Apply `seeds/BRK-P2/fix.patch` → all tests pass. |

**Seed layout:** `seeds/BRK-P2/test_broken_p2.py`, `seeds/BRK-P2/fix.patch`

**Failure pattern:** Integer count mismatch — the expected conflict counts
are wrong in all three test cases. Unlike BRK-P1 (date mismatches), this
seed exercises integer comparison failures for quarantine variety.

---

## Flaky Probe Seed (FLAKY-P1)

### FLAKY-P1

| Field | Value |
|---|---|
| **Stable ID** | `FLAKY-P1` |
| **Archetype** | N/A (flaky probe — deterministic alternator) |
| **Difficulty** | medium |
| **Module(s)** | `tests/test_flaky_probe.py` (test), `seeds/FLAKY-P1/conftest.py` (arming overlay) |
| **Expected Symptom** | When armed (arming conftest overlay applied in W4.18 scenario): a counter file (`.flaky_counter`) makes the test fail on every 2nd execution — 1st run passes, 2nd run fails with `"Flaky alternator: intentional failure on invocation #2"`, 3rd run passes again. When not armed: the `@pytest.mark.flaky_probe` marker causes `pytest_collection_modifyitems` hook in conftest.py to skip the test — baseline stays green. |
| **Verify** | **Baseline (default):** `python3 -m pytest -q` — "1 skipped" (157 passed, 1 skipped). **Armed (FLAKY-P1 overlay applied):** copy `seeds/FLAKY-P1/conftest.py` over the baseline conftest.py, then run `python3 -m pytest -q tests/test_flaky_probe.py` three times — observe pass/fail/pass pattern. |

**Seed layout:** `seeds/FLAKY-P1/conftest.py` (armed conftest — removes the
`pytest_collection_modifyitems` default-skip hook)

**Arming mechanism:** The baseline `conftest.py` registers a
`pytest_collection_modifyitems` hook that skips any test with
`@pytest.mark.flaky_probe`. The arming overlay (`seeds/FLAKY-P1/conftest.py`)
removes that hook, allowing the alternator to run. No pytest.ini changes
needed.

**Deterministic alternator:** Uses a counter file (`.flaky_counter` at
project root) rather than in-process state so the pass/fail pattern is
observable across separate `pytest` invocations. The counter is read,
incremented, and written back on each test run.

---

## Sentinel Trap

| Field | Value |
|---|---|
| **Stable ID** | `SENTINEL-TRAP` |
| **Archetype** | N/A (shell-quoting trap) |
| **Difficulty** | N/A (infrastructure trap) |
| **Location** | `$(sentinel)/canary.py` |
| **Expected Symptom** | The directory name `$(sentinel)` (literal dollar-sign + parentheses in filesystem name) is shell-quoting torture. Unquoted interpolation of the repo path would execute the directory name as a command substitution. The canary file inside raises `ImportError` if accidentally imported. |
| **Verify** | `ls "$(dirname "$(pwd)")/tt-python/\$(sentinel)/canary.py"` — the canary file exists. The directory is committed to the repo (not in `.gitignore`). Running `python3 -c "import canary"` from inside the directory would raise `ImportError`. The sentinel is never executed in normal operation — any appearance in logs or test output means something executed the directory name. |

**Mechanism:** Git stores `$(sentinel)` as a literal filename — shell
expansion only happens when the path is interpolated unquoted. This traps
agents and tooling that use unquoted path interpolation or eval-style
command construction.

---

## Seed Layout Summary

```
seeds/
├── SEEDS.md                  ← this file
├── BUG-P1/
│   ├── recurrence.py         overlay (buggy)
│   └── fix.patch             known-good fix
├── BUG-P2/
│   ├── recurrence.py         overlay (buggy — yearly _advance)
│   ├── conflict.py           overlay (buggy — CONTAINED boundary)
│   └── fix.patch             known-good coordinated fix (both files)
├── BUG-P3/
│   ├── dates.py              overlay (buggy — is_weekday off-by-one)
│   └── fix.patch             known-good fix (dates.py only)
├── BUG-P4/
│   ├── conflict.py           overlay (buggy — O(n²) merge)
│   └── fix.patch             known-good fix (restore O(n log n))
├── VULN-P1/
│   ├── integrations.py       overlay (yaml.load)
│   └── fix.patch             safe_load replacement
├── VULN-P2/
│   ├── integrations.py       overlay (shell=True)
│   └── fix.patch             list[str] + remove shell=True
├── BRK-P1/
│   ├── test_broken_p1.py     overlay (date mismatch)
│   └── fix.patch             correct expected dates
├── BRK-P2/
│   ├── test_broken_p2.py     overlay (integer mismatch)
│   └── fix.patch             correct expected counts
└── FLAKY-P1/
    └── conftest.py           armed conftest (removes default-skip hook)
```

## Archetype Reference

| Archetype | Name | Test Strategy |
|---|---|---|
| A1 | Logic off-by-one | Fixer must WRITE the regression test — no existing test covers the bug |
| A2 | Two-module coordinated bug | Single-file fix leaves at least one failure — coordinated fix required |
| A3 | Red-herring | Symptom tracebacks point to module X; root cause in module Y |
| A4 | Performance bug | Correctness tests pass; only threshold test on large input catches it |
| A5 | Cross-language integration | tt-poly only — fix in one subtree breaks another |

(Note: A5 is not used in the tt-python fixture; it is exclusive to the
tt-poly storm monorepo.)

## Cross-Reference with FIXTURE.md

All seed IDs, archetypes, symptoms, and difficulty tags in this document
match the entries in `FIXTURE.md` at the fixture root. `FIXTURE.md` provides
the seeded content plan (what is seeded and why); this document provides
the operational catalog (how to verify each seed and what to expect).
