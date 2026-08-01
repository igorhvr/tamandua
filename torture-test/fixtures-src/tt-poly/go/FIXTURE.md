# FIXTURE.md — tt-poly go/ Subtree Seeded Content

Fixture: **tt-poly/go/** (ttgo — concurrent worker-pool package for the tt-poly five-language storm monorepo)
Language: Go ≥ 1.21 | Test runner: go test | ~1,600 LOC

## Project Overview

A concurrent worker-pool package implementing a fixed-size goroutine pool
with task submission, result collection, graceful shutdown with queue
drain, panic recovery, and atomic counter observability. Built for the
tamandua torture-test suite — zero external dependencies beyond the Go
standard library.

Ported from `torture-test/fixtures-src/tt-go/` for the tt-poly
five-language storm monorepo.

The package exposes a `WorkerPool` type with a producer/consumer API:
submit `Task` values to a buffered channel, workers execute concurrently,
and `Result` values flow to a result channel. Shutdown drains all queued
tasks before closing the result channel. Panic recovery ensures a single
panicking task never crashes a worker goroutine — the panic is captured
as a `PanicError` in the result.

### Design Intent

- **Go-stdlib-only:** no module downloads at test time. The fixture
  builds and tests with `go test ./...` offline — pure stdlib dependency
  graph.
- **Green baseline:** 33 passing tests before any seed defects are
  applied. Every seed lives on its own immutable ref; applying a seed and
  its fix must restore green.
- **Concurrency is testable:** every goroutine path (submit, worker,
  shutdown drain, panic recovery, result delivery) is covered by
  table-driven tests with explicit concurrency assertions.

## Component Map

| File | Contents | LOC |
|------|----------|-----|
| `task.go` | `Task` struct (ID, Name, Func, Timeout) and `Result` struct (TaskID, Value, Err, Duration, StartTime, EndTime) | ~30 |
| `pool.go` | `WorkerPool` struct, `NewPool`, `Submit`, `Shutdown`, `Results`, `Running`, `Completed`, worker goroutine loop, `executeTask` with panic recovery, `PanicError` type, `formatPanicValue` helper | ~200 |
| `pool_test.go` | 33 test functions — table-driven, isolated per-test pool creation, covering defaults, happy path, error propagation, shutdown semantics, concurrency, panic recovery, timing, queue capacity, sequential cycles, stress | ~1,330 |

## Build & Test Toolchain

- **Go toolchain:** `go build ./...` compiles the package; `go vet ./...`
  runs the static analyzer.
- **Test runner:** `go test ./...` — all tests use the standard `testing`
  package with `t.Run` subtests for table-driven isolation. No external
  assertion libraries, no test frameworks.
- **Race detector:** `go test -race ./...` is deliberately NOT part of
  `TEST_CMD` (it is used only for `POLY-BUG-G4` acceptance verification).

## TEST_CMD

```
go test ./...
```

On a clean clone of the fixture, the full suite runs and exits 0.

### Baseline Test Counts

- `pool_test.go`: 33 passing, 0 failing (before any seed patches)

## Seeded Defects (POLY-BUG-G1..G4)

| ID | Archetype | Difficulty | Module(s) | Symptom / Description |
|----|-----------|------------|-----------|----------------------|
| `POLY-BUG-G1` | A1 — off-by-one logic | easy | `pool.go` | Task counter off-by-one in `Submit` — consecutive submits with queue near capacity miscount. Observable wrong output (wrong counter value); NO existing failing test — fixer must WRITE the regression test. |
| `POLY-BUG-G2` | A2 — two-module bug | medium | `pool.go`, worker loop | Error propagation mismatch: `pool.go` wraps errors with one format, worker loop checks with another, causing error tasks to appear successful. Two independent but simultaneous bugs — fixing either alone leaves one test failure; both must be fixed. |
| `POLY-BUG-G3` | A3 — red-herring (goroutine leak) | medium | worker loop | Worker does not exit on idle timeout — goroutine leak causes test suite to hang after 1000+ tasks. Symptom is test timeout (looks like infrastructure); root cause is missing drain-before-exit in worker loop. Fixing the drain logic is the real fix — surface-level timeout increases mask the regression. |
| `POLY-BUG-G4` | A4 — data race | medium | `pool.go` | Unsynchronized access to a shared field in `WorkerPool`. `go test ./...` passes because the race only manifests probabilistically under high concurrency. `go test -race ./...` detects the DATA RACE. Test-weakening temptation: removing concurrent test cases silences the race detector. |

Each bug lives on an immutable `seed/POLY-BUG-G*` ref in the golden bare repo
(green base + exactly one defect). A bug-fix scenario instantiates from
that seed ref. Every bug ships with a **known-good fix patch** at
`seeds/POLY-BUG-G*/fix.patch`.

### Bug Mechanisms

**POLY-BUG-G1 (A1 off-by-one):** `Submit()` increments the task counter
incorrectly — increments counter BEFORE checking if the pool is shut down,
causing rejected submissions to inflate the counter.

**POLY-BUG-G2 (A2 two-module):** `pool.go`'s `Shutdown` wraps errors with
`fmt.Errorf("pool shutdown: %w", err)`, but the worker goroutine's shutdown
check uses `errors.Is(err, ErrPoolShutdown)` instead of the correct
`errors.Is(err, context.Canceled)`. Both locations must be fixed together.

**POLY-BUG-G3 (A3 goroutine leak):** The worker goroutine's `select` loop
exits immediately when `ctx.Done()` fires without draining the task queue
first. Symptom looks like test timeout; root cause is missing non-blocking
drain in the worker loop.

**POLY-BUG-G4 (A4 data race):** A field on `WorkerPool` is read with
`atomic.Int64.Load()` in one code path but written with direct assignment
(not `.Store()`) in another under concurrent access. `go test ./...`
passes — the race only manifests probabilistically.

## Seeded Features (POLY-FEAT-G1..G3)

Feature backlog for feature-dev workflow scenarios. Each feature has a
stable ID, description, and clear acceptance boundaries. These features are
**documentation only** — no seed patches exist for features. This backlog
matches the `torture-test/fixtures-src/tt-go/` feature backlog.

| ID | Flavor | Description | Acceptance Boundaries |
|----|--------|-------------|-----------------------|
| `POLY-FEAT-G1` | Backend | **Configurable pool size via environment variable** — read `TTGO_MAX_WORKERS` env var in `NewPool` to override the `maxWorkers` parameter. If the env var is unset or not a valid integer, fall back to the parameter value. | Env var takes precedence over the parameter. Invalid values (letters, negative numbers, empty string) silently fall back to the parameter. Existing tests must still pass. |
| `POLY-FEAT-G2` | Backend | **Task priority and ordering** — add a `Priority int` field to `Task`. Workers consume from task queue in priority order (highest first, then FIFO within same priority). | Priority field defaults to 0. Two tasks with same priority are dequeued in FIFO order. Three tasks with different priorities are dequeued highest-first. |
| `POLY-FEAT-G3` | Backend | **Task retry with backoff** — add `MaxRetries int` and `Backoff time.Duration` fields to `Task`. On error, retry up to MaxRetries with exponential backoff. Panicked tasks are NOT retried. | Default MaxRetries is 0. Exponential backoff: 100ms → 200ms → 400ms → ... . Existing tests must still pass. |

## Seeded Vulnerabilities (POLY-VULN-G1..G2)

Dormant code paths living in a `util/` subpackage. The util package is
present in the module but never imported by `pool.go`, `pool_test.go`,
`task.go` — baseline stays green. Vulnerability seeds
enable security-audit scenario classes.

| ID | Vulnerability | Difficulty | Module | Description |
|----|--------------|------------|--------|-------------|
| `POLY-VULN-G1` | Command injection | medium | `util/command.go` | `RunCommandShell(cmdStr string)` uses `exec.Command("sh", "-c", cmdStr)` — shell injection via unsanitized `cmdStr`. A second, safe function `RunCommand(name string, args ...string)` uses `exec.Command` with args list, demonstrating the contrast. Dormant: never called by the test suite. |
| `POLY-VULN-G2` | Zip-slip (path traversal) | medium | `util/archive.go` | `ExtractTar(r io.Reader, dest string)` reads tar entries and writes them to `dest`. `header.Name` is used directly in `filepath.Join(dest, header.Name)` without validation, allowing path traversal via entries named `../../etc/passwd`. Dormant: never called by the test suite. |

Both vulnerabilities exist in the green baseline — the code is committed
and compiles (`go build ./...` passes including `util/`), but no test
exercises the vulnerable code paths. Their seed refs point to the baseline
commit (the vulns ARE the baseline). Fix patches replace the unsafe
implementations with safe alternatives.

## Broken Tests (POLY-BRK-G1..G2)

Genuinely failing assertions for quarantine workflows. Live on the
`broken-tests` branch (NOT on main/green-base). Each broken test
corrupts exactly one test function in `pool_test.go` — the rest of the
suite remains green.

| ID | Difficulty | Failure Pattern |
|----|------------|-----------------|
| `POLY-BRK-G1` | easy | **Off-by-one expected count** — a test asserting the count of Results after submitting N tasks and calling `Shutdown` expects N-1 instead of N. Deterministic failure (1 fail, 32 pass). |
| `POLY-BRK-G2` | easy | **Inverted boolean assertion** — a test verifying error behavior checks `err != nil` when `err` IS nil (the submitted task succeeds). Deterministic failure (1 fail, 32 pass). |

## Seed Layout

```
seeds/
  POLY-BUG-G1/
    pool.go         # buggy overlay (off-by-one counter)
    fix.patch       # corrects the counter + adds regression test
  POLY-BUG-G2/
    pool.go         # buggy overlay (error wrapping)
    worker.go       # buggy overlay (wrong error check)
    fix.patch       # coordinated fix for both files
  POLY-BUG-G3/
    pool.go         # buggy overlay (worker loop without drain)
    worker.go       # buggy overlay (missing drain → goroutine leak)
    fix.patch       # adds drain-before-exit logic
  POLY-BUG-G4/
    pool.go         # buggy overlay (direct assignment instead of Store)
    fix.patch       # atomic.Store + regression test with -race
  POLY-VULN-G1/
    util_command.go # same as baseline (dormant vuln IS the baseline)
    fix.patch       # removes RunCommandShell, replaces with safe variant
  POLY-VULN-G2/
    util_archive.go # same as baseline (dormant vuln IS the baseline)
    fix.patch       # adds path traversal guard
  POLY-BRK-G1/
    pool_test.go    # one test with wrong expected count
    go.mod          # (same as baseline)
    fix.patch       # corrects the expected value
  POLY-BRK-G2/
    pool_test.go    # one test with inverted boolean assertion
    go.mod          # (same as baseline)
    fix.patch       # corrects the assertion condition
  SEEDS.md          # per-seed catalog with archetype, symptom, verify instructions
```

## Archetype Reference

| Archetype | Name | Signature |
|-----------|------|-----------|
| A1 | Off-by-one | Logic error producing wrong output; no existing test catches it — fixer must write the regression test |
| A2 | Two-module | Bug spans two code locations; fix requires coordinated changes in both, not a single-line patch |
| A3 | Red-herring | Visible symptom points to infrastructure (test timeout), root cause is in worker drain logic |
| A4 | Data race | Passes all correctness tests but fails with the race detector (`-race`) |
| A5 | Cross-language | Bug spans two language subtrees (python/ + ts/); fix in one breaks the other — union-of-merges bait for the storm |

### Archetype Mapping

| Archetype | Seed(s) | Challenge |
|-----------|---------|-----------|
| A1 | POLY-BUG-G1 | Off-by-one counter — fixer must write the regression test |
| A2 | POLY-BUG-G2 | Error wrapping + checking mismatch across pool.go |
| A3 | POLY-BUG-G3 | Goroutine leak appears as timeout; root cause is worker loop drain |
| A4 | POLY-BUG-G4 | Data race only under `-race`; go test passes without it |
| A5 | POLY-BUG-A5 | Cross-language: python + ts integration bug (documented in python/ and ts/ FIXTURE.md) |

## Cross-Language Integration Bug (POLY-BUG-A5)

A5 archetype — spans the python/ and ts/ subtrees. The fix in one subtree
breaks the other subtree's test — union-of-merges bait for the storm.
See `python/FIXTURE.md` and `ts/FIXTURE.md` for full details.

| ID | Archetype | Difficulty | Modules | Symptom / Description |
|----|-----------|------------|---------|-----------------------|
| `POLY-BUG-A5` | A5 — cross-language integration | medium | `python/src/schedlib/integrations.py`, `ts/src/server.ts` | Two-subtree coordinated change: Python returns changed dict keys, TS expects changed keys. Fixing only one subtree leaves the other red. The go/ subtree is not directly affected but the storm's composite `seed/storm` ref includes A5 along with all go/ seeds — verifying fix coordination across the full storm is part of the go/ integrity invariants. |

## Junk Probes

Per spec 02's **two-class junk probe requirement**, this subtree carries
both classes. Neither is gitignored.

| Artifact | Class | Description |
|---|---|---|
| `testdata/exec-bit-probe.sh` | Committed inert probe | A committed shell script with the executable bit set (`chmod +x`). Content is a harmless echo statement. Probes tree-hashing exec-bit handling across platforms. |
| `operator-notes.local` | Untracked inert probe | Planted at fixture instantiation with fixed byte content, **never touched** by any tool, agent, or test runner. |

Go produces no regenerated junk in-tree (`go test` outputs to `GOCACHE`
outside the module).

## Integrity Invariants

1. **Baseline green:** `go test ./...` exits 0 on the pristine tree
   (33 pass, 0 fail).
2. **Seed isolation:** each seed's overlay files can be copied onto the
   green baseline; no seed depends on another seed's state.
3. **Fix correctness:** each fix patch restores green when applied on
   top of its seed.
4. **Two-module partial-fix property (POLY-BUG-G2):** fixing only one
   location leaves one test failure — both must be fixed together.
5. **Dormant vulns (POLY-VULN-G1, POLY-VULN-G2):** `go test ./...` passes
   with the `util/` subpackage present; `go build ./...` compiles all
   packages.
6. **Broken tests:** `broken-tests` branch has exactly 2 failing tests;
   `main` has 0.
7. **Exec-bit preservation:** `testdata/exec-bit-probe.sh` has the
   executable bit set.
8. **Cross-language coordination:** `seed/storm` composite ref includes POLY-BUG-A5; fix coordination must span both python/ and ts/ subtrees along with go/ seeds

## Patch Application Quick Reference

```bash
# Verify baseline is green
go test ./...

# Apply a bug seed (copy overlay files)
cp go/seeds/POLY-BUG-G1/pool.go go/pool.go
# Verify symptom (POLY-BUG-G1: go test ./... still passes — bug is dormant)
go test ./...

# Apply fix on top of seed
patch -p0 < go/seeds/POLY-BUG-G1/fix.patch
# Verify fix restored green
go test ./...

# For POLY-BUG-G3: test should hang without fix
cp go/seeds/POLY-BUG-G3/pool.go go/pool.go
cp go/seeds/POLY-BUG-G3/worker.go go/worker.go
go test -timeout 10s ./...  # hangs
patch -p0 < go/seeds/POLY-BUG-G3/fix.patch
go test ./...  # green

# For POLY-BUG-G4: test passes without -race, fails with -race
cp go/seeds/POLY-BUG-G4/pool.go go/pool.go
go test ./...        # passes (race is silent)
go test -race ./...  # reports DATA RACE
patch -p0 < go/seeds/POLY-BUG-G4/fix.patch
go test -race ./...  # green
```

## Traps

- `TEST_CMD` is `go test ./...` — `go test -race ./...` is NOT the test
  command.
- Go doesn't regenerate anything in-tree — `go test ./...` produces no
  cache files visible in the working directory.
- The `testdata/` directory has special meaning to the Go toolchain.
- Module path is `tt-go` (with hyphen) but package name is `ttgo` (no
  separator).
