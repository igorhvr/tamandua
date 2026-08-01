# SEEDS.md — tt-poly go/ Seed Catalog

Fixture: **tt-poly/go/** (ttgo — concurrent worker-pool package for tt-poly five-language storm monorepo)
Language: Go ≥ 1.21 | Test runner: go test | ~1,550 LOC (source + tests)

This document catalogs every seed in the tt-poly go/ subtree. Each
seed is a self-contained directory under `seeds/` containing the overlay
files (full copies of source with the defect/vulnerability applied) and
a `fix.patch` that reverses the change. Seeds are applied on top of the
green baseline to create immutable `seed/<ID>` refs in the golden bare
repo.

Cross-reference: see `FIXTURE.md` at the subtree root for the seeded
content plan and archetype mapping.

---

## Defect Seeds (POLY-BUG-G1..G4)

### POLY-BUG-G1

| Field | Value |
|---|---|
| **Stable ID** | `POLY-BUG-G1` |
| **Archetype** | A1 — logic off-by-one with observable wrong output |
| **Difficulty** | easy |
| **Module(s)** | `pool.go` |
| **Expected Symptom** | Task counter off-by-one — `Submit` increments the counter BEFORE checking if the pool is shut down, so rejected submissions inflate the `Submitted()` counter. |
| **Verify** | Check out `seed/POLY-BUG-G1` from the golden bare repo. Run `go test ./...` — no existing test covers the exact counter interleaving that triggers the off-by-one (fixer must WRITE the regression test). Apply `seeds/POLY-BUG-G1/fix.patch` with `patch -p0` to restore correct counter behavior. |

**Seed layout:** `seeds/POLY-BUG-G1/pool.go` (full overlay), `seeds/POLY-BUG-G1/fix.patch`

---

### POLY-BUG-G2

| Field | Value |
|---|---|
| **Stable ID** | `POLY-BUG-G2` |
| **Archetype** | A2 — two-module bug requiring a coordinated 2-file fix |
| **Difficulty** | medium |
| **Module(s)** | `pool.go` (error wrapping + worker loop) |
| **Expected Symptom** | Error propagation mismatch: `pool.go` wraps errors with one format, worker loop checks with another, causing error tasks to appear successful. Two independent failures in two code paths. |
| **Verify** | Check out `seed/POLY-BUG-G2`. Fix only the error-wrapping → 1 remaining failure. Fix only the worker check → 1 remaining failure. Apply `seeds/POLY-BUG-G2/fix.patch` (both locations) → green. |

**Seed layout:** `seeds/POLY-BUG-G2/pool.go`, `seeds/POLY-BUG-G2/worker.go`, `seeds/POLY-BUG-G2/fix.patch`

**Partial-fix property:** Either single-location fix leaves one test failure.

---

### POLY-BUG-G3

| Field | Value |
|---|---|
| **Stable ID** | `POLY-BUG-G3` |
| **Archetype** | A3 — red-herring (symptom points at test infrastructure, root cause in worker loop) |
| **Difficulty** | medium |
| **Module(s)** | `pool.go` (worker goroutine loop) |
| **Expected Symptom** | Test suite hangs after tasks are submitted and `Shutdown` is called. Worker exits on `ctx.Done()` without draining `taskQueue` first. |
| **Verify** | Check out `seed/POLY-BUG-G3`. Run `go test -timeout 10s ./...` — hangs (timeout). Apply `seeds/POLY-BUG-G3/fix.patch` → adds drain-before-exit logic. `go test ./...` green. |

**Seed layout:** `seeds/POLY-BUG-G3/pool.go`, `seeds/POLY-BUG-G3/worker.go`, `seeds/POLY-BUG-G3/fix.patch`

---

### POLY-BUG-G4

| Field | Value |
|---|---|
| **Stable ID** | `POLY-BUG-G4` |
| **Archetype** | A4 — data race (probabilistic, only detectable with race detector) |
| **Difficulty** | medium |
| **Module(s)** | `pool.go` |
| **Expected Symptom** | `go test ./...` passes — all 33 tests green. `go test -race ./...` reports DATA RACE on an `atomic.Int64` field. |
| **Verify** | Check out `seed/POLY-BUG-G4`. Run `go test ./...` — 33/33 green. Run `go test -race ./...` — reports DATA RACE. Apply `seeds/POLY-BUG-G4/fix.patch` → `go test -race ./...` green. |

**Seed layout:** `seeds/POLY-BUG-G4/pool.go` (full overlay), `seeds/POLY-BUG-G4/fix.patch`

---

## Vulnerability Seeds (POLY-VULN-G1..G2)

### POLY-VULN-G1

| Field | Value |
|---|---|
| **Stable ID** | `POLY-VULN-G1` |
| **Difficulty** | medium |
| **Module(s)** | `util/command.go` |
| **Expected Symptom** | `RunCommandShell(cmdStr string)` uses `exec.Command("sh", "-c", cmdStr)` — shell injection via unsanitized `cmdStr`. Dormant code path — never imported by test suite. |
| **Verify** | Inspect `util/command.go`. Apply `seeds/POLY-VULN-G1/fix.patch` → removes `RunCommandShell`, replaces with safe args-list-only variant. |

**Seed layout:** `seeds/POLY-VULN-G1/util_command.go`, `seeds/POLY-VULN-G1/fix.patch`

---

### POLY-VULN-G2

| Field | Value |
|---|---|
| **Stable ID** | `POLY-VULN-G2` |
| **Difficulty** | medium |
| **Module(s)** | `util/archive.go` |
| **Expected Symptom** | `ExtractTar(...)` uses `header.Name` unsanitized in `filepath.Join` — zip-slip path traversal vulnerability. Dormant code path. |
| **Verify** | Inspect `util/archive.go`. Apply `seeds/POLY-VULN-G2/fix.patch` → adds path traversal guard. |

**Seed layout:** `seeds/POLY-VULN-G2/util_archive.go`, `seeds/POLY-VULN-G2/fix.patch`

---

## Broken Test Seeds (POLY-BRK-G1..G2)

### POLY-BRK-G1

| Field | Value |
|---|---|
| **Stable ID** | `POLY-BRK-G1` |
| **Difficulty** | easy |
| **Module(s)** | `pool_test.go` |
| **Expected Symptom** | One test assertion expects N-1 results after submitting N tasks, but the pool correctly returns N results. 1 test fails, 32 pass. |
| **Verify** | Apply seed overlay. Run `go test ./...` — 1 failure with off-by-one count mismatch. Apply `seeds/POLY-BRK-G1/fix.patch` → green. |

**Seed layout:** `seeds/POLY-BRK-G1/pool_test.go`, `seeds/POLY-BRK-G1/go.mod`, `seeds/POLY-BRK-G1/fix.patch`

---

### POLY-BRK-G2

| Field | Value |
|---|---|
| **Stable ID** | `POLY-BRK-G2` |
| **Difficulty** | easy |
| **Module(s)** | `pool_test.go` |
| **Expected Symptom** | One test uses an inverted boolean assertion — checks `err != nil` when task succeeds. 1 test fails, 32 pass. |
| **Verify** | Apply seed overlay. Run `go test ./...` — 1 failure with inverted boolean error. Apply `seeds/POLY-BRK-G2/fix.patch` → green. |

**Seed layout:** `seeds/POLY-BRK-G2/pool_test.go`, `seeds/POLY-BRK-G2/go.mod`, `seeds/POLY-BRK-G2/fix.patch`

---

## Seed Layout Summary

```
seeds/
├── SEEDS.md                  ← this file
├── POLY-BUG-G1/
│   ├── pool.go               overlay (buggy — off-by-one counter)
│   └── fix.patch             known-good fix + regression test
├── POLY-BUG-G2/
│   ├── pool.go               overlay (buggy — error wrapping)
│   ├── worker.go             overlay (buggy — wrong error check)
│   └── fix.patch             known-good coordinated fix (both locations)
├── POLY-BUG-G3/
│   ├── pool.go               overlay (buggy — worker loop without drain)
│   ├── worker.go             overlay (buggy — missing drain)
│   └── fix.patch             known-good fix (drain-before-exit logic)
├── POLY-BUG-G4/
│   ├── pool.go               overlay (buggy — direct assignment instead of .Store())
│   └── fix.patch             known-good fix (atomic.Store + regression test with -race)
├── POLY-VULN-G1/
│   ├── util_command.go       overlay (same as baseline — dormant vuln)
│   └── fix.patch             remove RunCommandShell → safe variant
├── POLY-VULN-G2/
│   ├── util_archive.go       overlay (same as baseline — dormant vuln)
│   └── fix.patch             add path traversal guard
├── POLY-BRK-G1/
│   ├── pool_test.go          overlay (one test with wrong expected count)
│   ├── go.mod                (same as baseline)
│   └── fix.patch             correct expected value
└── POLY-BRK-G2/
    ├── pool_test.go          overlay (one test with inverted boolean assertion)
    ├── go.mod                (same as baseline)
    └── fix.patch             correct assertion condition
```

## Archetype Reference

| Archetype | Name | Signature |
|-----------|------|-----------|
| A1 | Off-by-one | Logic error producing wrong output; no existing test catches it — fixer must write the regression test |
| A2 | Two-module | Bug spans two code locations; fix requires coordinated changes in both, not a single-line patch |
| A3 | Red-herring | Visible symptom points to infrastructure (test timeout), root cause is in worker drain logic |
| A4 | Data race | Passes all correctness tests but fails with the race detector (`-race`) |

### Archetype Mapping

| Archetype | Seed(s) | Challenge |
|-----------|---------|-----------|
| A1 | POLY-BUG-G1 | Off-by-one counter — fixer must write the regression test |
| A2 | POLY-BUG-G2 | Error wrapping + checking mismatch across pool.go |
| A3 | POLY-BUG-G3 | Goroutine leak appears as timeout; root cause is worker loop drain |
| A4 | POLY-BUG-G4 | Data race only under `-race`; go test passes without it |
