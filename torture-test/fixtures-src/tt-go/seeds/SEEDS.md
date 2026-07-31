# SEEDS.md — tt-go Seed Catalog

Fixture: **tt-go** (ttgo — concurrent worker-pool package)
Language: Go ≥ 1.21 | Test runner: go test | ~1,550 LOC (source + tests)

This document catalogs every seed in the tt-go torture fixture. Each
seed is a self-contained directory under `seeds/` containing the overlay
files (full copies of source with the defect/vulnerability applied) and
a `fix.patch` that reverses the change. Seeds are applied on top of the
green baseline to create immutable `seed/<ID>` refs in the golden bare
repo.

Cross-reference: see `FIXTURE.md` at the fixture root for the seeded
content plan and archetype mapping.

---

## Defect Seeds (BUG-G1..G4)

### BUG-G1

| Field | Value |
|---|---|
| **Stable ID** | `BUG-G1` |
| **Archetype** | A1 — logic off-by-one with observable wrong output |
| **Difficulty** | easy |
| **Module(s)** | `pool.go` |
| **Expected Symptom** | Task counter off-by-one — consecutive `Submit` calls with queue near capacity produce a counter value that is off by one. The `Completed()` or `Running()` atomic counter reads an incorrect count under concurrent submission. |
| **Verify** | Check out `seed/BUG-G1` from the golden bare repo. Run `go test ./...` — no existing test covers the exact counter interleaving that triggers the off-by-one (fixer must WRITE the regression test). Apply `seeds/BUG-G1/fix.patch` with `patch -p0` to restore correct counter behavior. |

**Seed layout:** `seeds/BUG-G1/pool.go` (full overlay), `seeds/BUG-G1/fix.patch`

**Bug mechanism:** `Submit()` increments the task counter incorrectly —
uses pre-increment in one code path and post-increment in another, causing
the counter to be off by one under concurrent submission. The bug is
dormant — no existing test triggers the exact interleaving that exposes
the off-by-one. The fixer must write a regression test that exercises the
counter path under concurrent Submit and asserts the exact expected count.

---

### BUG-G2

| Field | Value |
|---|---|
| **Stable ID** | `BUG-G2` |
| **Archetype** | A2 — two-module bug requiring a coordinated 2-file fix |
| **Difficulty** | medium |
| **Module(s)** | `pool.go` + `worker.go` (in `pool.go` — the worker loop is in the same package) |
| **Expected Symptom** | Error propagation mismatch: `pool.go`'s `Shutdown` wraps errors with `fmt.Errorf("pool shutdown: %w", err)`, but the worker goroutine's shutdown check uses `errors.Is(err, ErrPoolShutdown)` instead of `errors.Is(err, context.Canceled)`. Error-wrapped shutdown signals are not detected, so tasks submitted just before shutdown appear to complete successfully but their results are silently dropped (the worker thinks the pool is still running). Two independent failures in two code paths across the same package. |
| **Verify** | Check out `seed/BUG-G2`. Run the full suite — tests that Submit tasks and call Shutdown show missing results (fewer Results collected than tasks submitted). Fix only the error-wrapping in `pool.go` → 1 remaining failure (worker check still wrong). Fix only the worker check → 1 remaining failure (error format still wrong). Apply `seeds/BUG-G2/fix.patch` (both locations) → green. |

**Seed layout:** `seeds/BUG-G2/pool.go`, `seeds/BUG-G2/worker.go` (both as `pool.go` — the worker loop is part of `pool.go`), `seeds/BUG-G2/fix.patch`

**Partial-fix property:** Either single-location fix leaves one test
failure — both the error-wrapping format and the error check must be
corrected together. This forces agents to diagnose both locations rather
than stopping after the first fix works.

---

### BUG-G3

| Field | Value |
|---|---|
| **Stable ID** | `BUG-G3` |
| **Archetype** | A3 — red-herring (symptom points at test infrastructure, root cause in worker loop) |
| **Difficulty** | medium |
| **Module(s)** | `pool.go` (worker goroutine loop) |
| **Expected Symptom** | Test suite hangs after 1000+ tasks are submitted and `Shutdown` is called. The visible symptom is a `go test -timeout 10s ./...` timeout — it looks like a test infrastructure or harness issue. The root cause is the worker goroutine's `select` loop exiting immediately when `ctx.Done()` fires without draining `taskQueue` first. With 1000 tasks queued, the cancel propagates, workers exit, and remaining tasks are never processed — `Shutdown` deadlocks waiting for `resultQueue` to drain. |
| **Verify** | Check out `seed/BUG-G3`. Run `go test -timeout 10s ./...` — the test suite hangs (timeout). The hang manifests as a test timeout, not a test failure with a clear assertion message. Apply `seeds/BUG-G3/fix.patch` → adds non-blocking drain-before-exit logic to the worker loop. Run `go test ./...` — green, no hang. |

**Seed layout:** `seeds/BUG-G3/worker.go` (full overlay of `pool.go` with the buggy worker loop), `seeds/BUG-G3/fix.patch`

**Red-herring mechanism:** The test timeout looks like an infrastructure
issue — the test harness itself appears to hang. The natural first
response is to increase the timeout or reduce the task count. But the
root cause is in the worker goroutine's drain logic: it exits on
`ctx.Done()` without draining the task queue. Fixing the drain logic is
the real fix; surface-level timeout increases mask the regression.

**Test-weakening temptation:** Agents may try to fix the "hanging test"
by reducing the number of tasks submitted or increasing the
`go test -timeout` value. Neither addresses the goroutine leak.

---

### BUG-G4

| Field | Value |
|---|---|
| **Stable ID** | `BUG-G4` |
| **Archetype** | A4 — data race (probabilistic, only detectable with race detector) |
| **Difficulty** | medium |
| **Module(s)** | `pool.go` |
| **Expected Symptom** | `go test ./...` passes — all 33 tests green. `go test -race ./...` reports DATA RACE on an `atomic.Int64` field. The race only manifests probabilistically under high concurrency; the standard test suite without `-race` never catches it. |
| **Verify** | Check out `seed/BUG-G4`. Run `go test ./...` — 33/33 green (race is silent without `-race`). Run `go test -race ./...` — reports DATA RACE. Apply `seeds/BUG-G4/fix.patch` → `go test -race ./...` green (no race detected). |

**Seed layout:** `seeds/BUG-G4/pool.go` (full overlay), `seeds/BUG-G4/fix.patch`

**Bug mechanism:** An `atomic.Int64` field on `WorkerPool` is read with
`.Load()` in one code path but written with direct assignment (not
`.Store()`) in another, under concurrent access. `go test ./...` passes
because the race only manifests probabilistically. The fix replaces the
direct assignment with `atomic.Int64.Store()`. The fix patch includes a
regression test that runs with `-race` and verifies no race is reported.

**Test-weakening temptation:** Removing concurrent test cases silences
the race detector but masks the data race rather than fixing it.

---

## Vulnerability Seeds (VULN-G1..G2)

### VULN-G1

| Field | Value |
|---|---|
| **Stable ID** | `VULN-G1` |
| **Archetype** | N/A (vulnerability seed — dormant code path) |
| **Difficulty** | medium |
| **Module(s)** | `util/command.go` |
| **Expected Symptom** | `RunCommandShell(cmdStr string) (string, error)` uses `exec.Command("sh", "-c", cmdStr)` — shell injection via unsanitized `cmdStr`. A second, safe function `RunCommand(name string, args ...string)` uses `exec.Command` with args list, demonstrating the contrast. The code path is dormant — `util/command.go` is never imported by the `ttgo` package or test suite, so the baseline stays green. The vulnerability is discoverable via static analysis or code review. |
| **Verify** | Check out `seed/VULN-G1`. Baseline suite: `go test ./...` — 33/33 green (dormant code not exercised). Inspect `util/command.go` — `RunCommandShell` passes `cmdStr` directly to `exec.Command("sh", "-c", cmdStr)`. Apply `seeds/VULN-G1/fix.patch` → removes `RunCommandShell`, replaces with `RunCommandSafe` that uses `exec.Command` with args list only, documents the injection risk. |

**Seed layout:** `seeds/VULN-G1/util_command.go` (same as baseline — the vulnerable code IS the baseline), `seeds/VULN-G1/fix.patch`

**Fix:** Remove `RunCommandShell`. Replace with `RunCommandSafe(name string, args ...string)` that delegates to `exec.Command(name, args...)` — args-list-only, no shell. The `RunCommand` function is preserved as-is (already safe with args list).

---

### VULN-G2

| Field | Value |
|---|---|
| **Stable ID** | `VULN-G2` |
| **Archetype** | N/A (vulnerability seed — dormant code path) |
| **Difficulty** | medium |
| **Module(s)** | `util/archive.go` |
| **Expected Symptom** | `ExtractTar(r io.Reader, dest string) error` reads tar entries and writes them to `dest` using `filepath.Join(dest, header.Name)` without validating that the resulting path stays within `dest`. A tar entry named `../../etc/passwd` would traverse outside the destination directory — a zip-slip / path traversal vulnerability. The code path is dormant — `util/archive.go` is never imported by the core package or test suite. |
| **Verify** | Check out `seed/VULN-G2`. Baseline suite: `go test ./...` — 33/33 green. Inspect `util/archive.go` — `header.Name` is used unsanitized in `filepath.Join`. Apply `seeds/VULN-G2/fix.patch` → adds path traversal guard (resolves the joined path and verifies it has `dest` as a prefix, rejects entries that escape). |

**Seed layout:** `seeds/VULN-G2/util_archive.go` (same as baseline — the vulnerable code IS the baseline), `seeds/VULN-G2/fix.patch`

**Fix:** Before writing each tar entry, resolve the joined path with
`filepath.Abs(filepath.Join(dest, header.Name))` and verify it has `dest`
as a prefix via `strings.HasPrefix`. Reject entries (`return error`) that
attempt to escape the destination directory.

---

## Broken Test Seeds (BRK-G1..G2)

These seeds live on the `broken-tests` branch (NOT on main/green-base).
They contain genuinely failing test assertions for quarantine workflows.
Each broken test corrupts exactly one test function in `pool_test.go` —
the rest of the suite remains green.

### BRK-G1

| Field | Value |
|---|---|
| **Stable ID** | `BRK-G1` |
| **Archetype** | N/A (broken test — quarantine seed) |
| **Difficulty** | easy |
| **Module(s)** | `pool_test.go` |
| **Expected Symptom** | One test assertion expects N-1 results after submitting N tasks and calling `Shutdown`, but the pool correctly returns N results. Failure message: e.g. `expected 9 results, got 10` — the assertion expects the wrong count (off by one). Exactly 1 test fails, 32 pass. |
| **Verify** | Check out the `broken-tests` branch. Run `go test ./...` — 1 failure with off-by-one count mismatch message, 32 tests pass. Apply `seeds/BRK-G1/fix.patch` → `go test ./...` green (33/33). |

**Seed layout:** `seeds/BRK-G1/pool_test.go` (full overlay with one corrupted test), `seeds/BRK-G1/fix.patch`

**Failure pattern:** Integer count mismatch — the expected result count
is off by one. The rest of the test function is correct; only the
hardcoded expected value is wrong.

---

### BRK-G2

| Field | Value |
|---|---|
| **Stable ID** | `BRK-G2` |
| **Archetype** | N/A (broken test — quarantine seed) |
| **Difficulty** | easy |
| **Module(s)** | `pool_test.go` |
| **Expected Symptom** | One test assertion uses an inverted boolean condition — it checks `err != nil` when the submitted task succeeds (returns nil error), so `err` IS nil. The assertion fails with: `expected error but got nil` (or vice versa: expects nil but got an error from a task that actually fails). Exactly 1 test fails, 32 pass. |
| **Verify** | Check out the `broken-tests` branch. Run `go test ./...` — 1 failure with inverted boolean assertion message, 32 tests pass. Apply `seeds/BRK-G2/fix.patch` → `go test ./...` green (33/33). |

**Seed layout:** `seeds/BRK-G2/pool_test.go` (full overlay with one corrupted test), `seeds/BRK-G2/fix.patch`

**Failure pattern:** Boolean/condition inversion — the assertion checks
for an error when none should exist (or expects no error when one exists).
The rest of the test function is correct; only the condition polarity is
wrong.

---

## Seed Layout Summary

```
seeds/
├── SEEDS.md                  ← this file
├── BUG-G1/
│   ├── pool.go               overlay (buggy — off-by-one counter)
│   └── fix.patch             known-good fix + regression test
├── BUG-G2/
│   ├── pool.go               overlay (buggy — error wrapping + worker check)
│   ├── worker.go             overlay (buggy — wrong error check in worker loop)
│   └── fix.patch             known-good coordinated fix (both locations)
├── BUG-G3/
│   ├── worker.go             overlay (buggy — missing drain → goroutine leak)
│   └── fix.patch             known-good fix (drain-before-exit logic)
├── BUG-G4/
│   ├── pool.go               overlay (buggy — direct assignment instead of .Store())
│   └── fix.patch             known-good fix (atomic.Store + regression test with -race)
├── VULN-G1/
│   ├── util_command.go       overlay (same as baseline — dormant vuln)
│   └── fix.patch             remove RunCommandShell → safe variant
├── VULN-G2/
│   ├── util_archive.go       overlay (same as baseline — dormant vuln)
│   └── fix.patch             add path traversal guard
├── BRK-G1/
│   ├── pool_test.go          overlay (one test with wrong expected count)
│   └── fix.patch             correct expected value
└── BRK-G2/
    ├── pool_test.go          overlay (one test with inverted boolean assertion)
    └── fix.patch             correct assertion condition
```

## Archetype Reference

| Archetype | Name | Signature |
|-----------|------|-----------|
| A1 | Off-by-one | Logic error producing wrong output; no existing test catches it — fixer must write the regression test. Easy to fix once diagnosed; the challenge is detecting it. |
| A2 | Two-module | Bug spans two code locations; fix requires coordinated changes in both, not a single-line patch. Fixing either location alone leaves the other broken — partial fixes are insufficient. |
| A3 | Red-herring | Visible symptom points to infrastructure (test timeout), but root cause is in the worker drain logic. Fixing the symptom (increasing timeout) masks but does not fix the real bug. |
| A4 | Data race | Passes all correctness tests but fails with the race detector (`-race`). The race is probabilistic — `go test ./...` is green; `go test -race ./...` detects it. Test-weakening silences the detector but isn't a fix. |

### Archetype Mapping

| Archetype | Seed(s) | Challenge |
|-----------|---------|-----------|
| A1 | BUG-G1 | Off-by-one counter — fixer must write the regression test |
| A2 | BUG-G2 | Error wrapping + checking mismatch across pool.go |
| A3 | BUG-G3 | Goroutine leak appears as timeout; root cause is worker loop drain |
| A4 | BUG-G4 | Data race only under `-race`; go test passes without it |

## Cross-Reference with FIXTURE.md

All seed IDs, archetypes, symptoms, and difficulty tags in this document
match the entries in `FIXTURE.md` at the fixture root. `FIXTURE.md` provides
the seeded content plan (what is seeded and why); this document provides
the operational catalog (how to verify each seed and what to expect).
