# FIXTURE.md — tt-go Seeded Content

Fixture: **tt-go** (ttgo — concurrent worker-pool package)
Language: Go ≥ 1.21 | Test runner: go test | ~1,600 LOC

## Project Overview

A concurrent worker-pool package implementing a fixed-size goroutine pool
with task submission, result collection, graceful shutdown with queue
drain, panic recovery, and atomic counter observability. Built for the
tamandua torture-test suite — zero external dependencies beyond the Go
standard library.

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
  `TEST_CMD` (it is used only for `BUG-G4` acceptance verification).

## TEST_CMD

```
go test ./...
```

On a clean clone of the fixture, the full suite runs and exits 0.

### Baseline Test Counts

- `pool_test.go`: 33 passing, 0 failing (before any seed patches)

Test list:
- `TestNewPoolDefaults` — zero/negative value default handling
- `TestSubmitAndCollectResult` — happy path submit→collect→verify value
- `TestSubmitAndCollectError` — task returning error produces Result.Err
- `TestSubmitAfterShutdown` — Submit after Shutdown returns ErrPoolShutdown
- `TestShutdownWaitsForWorkers` — Shutdown blocks until workers drain
- `TestAtomicCounters` — Running/Completed counters track correctly
- `TestResultsIncludeTiming` — Duration, StartTime, EndTime fields populated
- `TestMultipleResults` — N tasks produce exactly N Results
- `TestShutdownDrainsQueue` — queued tasks complete after Shutdown
- `TestConcurrentSubmit` — concurrent Submit from multiple goroutines
- `TestSubmitToFullQueueSucceedsAfterDrain` — queue fill + drain
- `TestResultsChannelClosedAfterShutdown` — Results channel closes after wg
- `TestPanicRecoveryProducesError` — string panic → PanicError
- `TestPanicRecoveryPersistsTiming` — timing preserved on panic
- `TestWorkersContinueAfterPanic` — pool continues after one panic
- `TestPanicWithErrorValue` — panic with error type
- `TestPanicWithIntValue` — panic with non-string/non-error
- `TestConcurrentPanicRecovery` — alternating panic/normal under concurrency
- `TestMultipleWorkersConcurrency` — atomic counter time-window verification
- `TestWorkersDoNotExceedMaxCount` — at most maxWorkers run simultaneously
- `TestTaskWithSleepDoesNotHang` — sleep task completes (timeout guard)
- `TestZeroMaxWorkersDefaultsToSingleWorker` — maxWorkers=0 → 1
- `TestLargeTaskCount` — 100-task stress test with 4 workers
- `TestTableDrivenSubmitResults` — table-driven: int/string/nil/bool/error
- `TestTableDrivenTaskErrors` — table-driven: sentinel/fmt/empty errors
- `TestPoolWithSingleWorker` — FIFO sequential order with one worker
- `TestResultsArriveUnordered` — out-of-order result delivery
- `TestConcurrentSubmitAndShutdownRace` — concurrent Submit vs Shutdown
- `TestSubmitMultipleBeforeShutdown` — batch submit, then Shutdown
- `TestMaxQueueCapacity` — queue fill to capacity, verify all processed
- `TestMultipleSequentialPoolCycles` — 3 cycles, state isolation
- `TestTaskWithImmediateReturn` — zero-latency timing verification
- `TestSubmitAfterContextDone` — context cancel → ErrPoolShutdown

## Seeded Defects (BUG-G1..G4)

| ID | Archetype | Difficulty | Module(s) | Symptom / Description |
|----|-----------|------------|-----------|----------------------|
| `BUG-G1` | A1 — off-by-one logic | easy | `pool.go` | Task counter off-by-one in `Submit` — consecutive submits with queue near capacity miscount. Observable wrong output (wrong counter value); NO existing failing test — fixer must WRITE the regression test. |
| `BUG-G2` | A2 — two-module bug | medium | `pool.go`, `worker.go` | Error propagation mismatch: `pool.go` wraps errors with one format, `worker.go` checks with another, causing error tasks to appear successful. Two independent but simultaneous bugs spanning two modules — fixing either file alone leaves one test failure; both must be fixed. |
| `BUG-G3` | A3 — red-herring (goroutine leak) | medium | `worker.go` | Worker does not exit on idle timeout — goroutine leak causes test suite to hang after 1000+ tasks. Symptom is test timeout (looks like infrastructure); root cause is missing drain-before-exit in worker loop. Fixing the drain logic is the real fix — surface-level timeout increases mask the regression. |
| `BUG-G4` | A4 — data race | medium | `pool.go` | Unsynchronized access to a shared field in `WorkerPool`. `go test ./...` passes because the race only manifests probabilistically under high concurrency. `go test -race ./...` detects the DATA RACE. Test-weakening temptation: removing concurrent test cases silences the race detector. |

Each bug lives on an immutable `seed/BUG-G*` ref in the golden bare repo
(green base + exactly one defect). A bug-fix scenario instantiates from
that seed ref. Every bug ships with a **known-good fix patch** at
`seeds/BUG-G*/fix.patch`.

### Bug Mechanisms

**BUG-G1 (A1 off-by-one):** `Submit()` increments the task counter
incorrectly — uses pre-increment in one code path and post-increment in
another, causing counter to be off by one under concurrent submission.
The bug is dormant — no existing test triggers the exact interleaving
that exposes the off-by-one. The fixer must write a regression test that
exercises the counter path under concurrent Submit and asserts the exact
expected count.

**BUG-G2 (A2 two-module):** `pool.go`'s `Shutdown` wraps errors with
`fmt.Errorf("pool shutdown: %w", err)`, but `worker.go`'s shutdown check
uses `errors.Is(err, ErrPoolShutdown)` instead of the correct
`errors.Is(err, context.Canceled)`. Error-wrapped shutdown signals are
not detected, so tasks submitted just before shutdown appear to complete
successfully but their results are dropped. Fixing only the wrapper or
only the check is insufficient — both must change together.

**BUG-G3 (A3 goroutine leak):** The worker goroutine's `select` loop
exits immediately when `ctx.Done()` fires without draining the task
queue first. With 1000 tasks queued and Shutdown called, the cancel
propagates, workers exit, and remaining tasks are never processed —
`Shutdown` hangs waiting for the result queue to drain (deadlock). The
symptom looks like a test infrastructure timeout, but the root cause is
the missing non-blocking drain in the worker loop. Fix: worker should
drain `taskQueue` before exiting on `ctx.Done()`.

**BUG-G4 (A4 data race):** A field on `WorkerPool` is read with
`atomic.Int64.Load()` in one code path but written with direct
assignment (not `.Store()`) in another under concurrent access. `go test ./...`
passes — the race only manifests probabilistically. `go test -race ./...`
detects the DATA RACE. The fix replaces the direct assignment with
`atomic.Int64.Store()`. The fix patch includes a regression test that
runs with `-race` and verifies no race is reported.

## Seeded Features (FEAT-G1..G3)

Feature backlog for feature-dev workflow scenarios. Each feature has a
stable ID, description, and clear acceptance boundaries.

| ID | Flavor | Description | Acceptance Boundaries |
|----|--------|-------------|-----------------------|
| `FEAT-G1` | Backend | **Configurable pool size via environment variable** — read `TTGO_MAX_WORKERS` env var in `NewPool` to override the `maxWorkers` parameter. If the env var is unset or not a valid integer, fall back to the parameter value. | Env var takes precedence over the parameter. Invalid values (letters, negative numbers, empty string) silently fall back to the parameter. The `maxWorkers` parameter still works as before (backward compatibility). Tests must cover: env set, env unset, env invalid, env zero. Go's `os.Getenv` and `strconv.Atoi` usage. No external dependencies. |
| `FEAT-G2` | Backend | **Task priority and ordering** — add a `Priority int` field to `Task`. Workers consume from task queue in priority order (highest first, then FIFO within same priority). Default priority is 0. Negative priorities allowed. | Priority field defaults to 0 when unset. Two tasks with same priority are dequeued in FIFO order. Three tasks with different priorities (10, 5, 1) are dequeued as 10, 5, 1. Existing tests must still pass — the Priority field is additive. The task queue implementation must support priority ordering without external dependencies (use `container/heap` from stdlib). Test helpers must verify ordering deterministically (single worker). |
| `FEAT-G3` | Backend | **Task retry with backoff** — add `MaxRetries int` and `Backoff time.Duration` fields to `Task`. When a task returns an error, the worker retries it up to `MaxRetries` times with exponential backoff (Backoff × 2^retry). On final failure, the Result contains the last error. Panicked tasks are NOT retried (panic recovery produces a result immediately). | Default MaxRetries is 0 (no retries). Backoff default is 100ms. Retry count is per-task, not global. Exponential backoff: 100ms → 200ms → 400ms → ... . On success after retry, the Result contains the value from the successful attempt (not the error). Panic recovery bypasses retry — a panicked task produces one Result with a PanicError, no retries. Concurrent tasks retry independently. Existing tests must still pass. |

## Seeded Vulnerabilities (VULN-G1..G2)

Dormant code paths living in a `util/` subpackage. The util package is
present in the module but never imported by `pool.go`, `worker.go`,
`task.go`, or `pool_test.go` — baseline stays green. Vulnerability seeds
enable security-audit scenario classes.

| ID | Vulnerability | Difficulty | Module | Description |
|----|--------------|------------|--------|-------------|
| `VULN-G1` | Command injection | medium | `util/command.go` | `RunCommandShell(cmdStr string)` uses `exec.Command("sh", "-c", cmdStr)` — shell injection via unsanitized `cmdStr`. A second, safe function `RunCommand(name string, args ...string)` uses `exec.Command` with args list, demonstrating the contrast. Dormant: never called by the test suite. |
| `VULN-G2` | Zip-slip (path traversal) | medium | `util/archive.go` | `ExtractTar(r io.Reader, dest string)` reads tar entries and writes them to `dest`. `header.Name` is used directly in `filepath.Join(dest, header.Name)` without validation, allowing path traversal via entries named `../../etc/passwd`. Dormant: never called by the test suite. |

Both vulnerabilities exist in the green baseline — the code is committed
and compiles (`go build ./...` passes including `util/`), but no test
exercises the vulnerable code paths. Their seed refs point to the baseline
commit (the vulns ARE the baseline, same as tt-ts VULN-T1/T2 pattern).
Fix patches replace the unsafe implementations with safe alternatives.

## Broken Tests (BRK-G1..G2)

Genuinely failing assertions for quarantine workflows. Live on the
`broken-tests` branch (NOT on main/green-base). Each broken test
corrupts exactly one test function in `pool_test.go` — the rest of the
suite remains green.

| ID | Difficulty | Failure Pattern |
|----|------------|-----------------|
| `BRK-G1` | easy | **Off-by-one expected count** — a test asserting the count of Results after submitting N tasks and calling `Shutdown` expects N-1 instead of N. Deterministic failure (1 fail, 32 pass). Failure message: "expected N results, got N-1" (assertion expects wrong count). The fix.patch corrects the expected count from N-1 to N. |
| `BRK-G2` | easy | **Inverted boolean assertion** — a test verifying error behavior checks `err != nil` when `err` IS nil (the submitted task succeeds). Deterministic failure (1 fail, 32 pass). Failure message: "expected error but got nil" (inverted condition). The fix.patch corrects the assertion to `err == nil`. |

## Seed References

- `seed/BUG-G1` through `seed/BUG-G4` — one commit per bug, each is
  green baseline + exactly one defect applied (overlay copy).
- `seed/VULN-G1` and `seed/VULN-G2` — these refs point to the baseline
  commit (the vulnerable code lives in the baseline). Fix patches remove
  the vulnerable code paths.
- `broken-tests` branch — contains BRK-G1 and BRK-G2 commits. Separate
  from main/green-base.
- Fix patches live in `seeds/<ID>/fix.patch` — each restores green when
  applied on top of its seed.

## Seed Layout

```
seeds/
  BUG-G1/
    pool.go         # buggy overlay (off-by-one counter)
    fix.patch       # corrects the counter + adds regression test
  BUG-G2/
    pool.go         # buggy overlay (error wrapping)
    worker.go       # buggy overlay (wrong error check)
    fix.patch       # coordinated fix for both files
  BUG-G3/
    worker.go       # buggy overlay (missing drain → goroutine leak)
    fix.patch       # adds drain-before-exit logic
  BUG-G4/
    pool.go         # buggy overlay (direct assignment instead of Store)
    fix.patch       # atomic.Store + regression test with -race
  VULN-G1/
    util_command.go # same as baseline (dormant vuln IS the baseline)
    fix.patch       # removes RunCommandShell, replaces with safe variant
  VULN-G2/
    util_archive.go # same as baseline (dormant vuln IS the baseline)
    fix.patch       # adds path traversal guard
  BRK-G1/
    pool_test.go    # one test with wrong expected count
    fix.patch       # corrects the expected value
  BRK-G2/
    pool_test.go    # one test with inverted boolean assertion
    fix.patch       # corrects the assertion condition
  SEEDS.md          # per-seed catalog with archetype, symptom, verify instructions
```

## Archetype Reference

| Archetype | Name | Signature |
|-----------|------|-----------|
| A1 | Off-by-one | Logic error producing wrong output; no existing test catches it — fixer must write the regression test. Easy to fix once diagnosed; the challenge is detecting it. |
| A2 | Two-module | Bug spans two modules; fix requires coordinated changes in both files, not a single-line patch. Fixing either file alone leaves the other broken — partial fixes are insufficient. |
| A3 | Red-herring | Visible symptom points to module X (e.g., test timeout), but root cause is in module Y (e.g., worker drain logic). Fixing the symptom (increasing timeout) masks but does not fix the real bug. |
| A4 | Data race / performance | Passes all correctness tests but fails with the race detector (`-race`) or a performance threshold. The race is probabilistic — `go test ./...` is green; `go test -race ./...` detects it. Test-weakening (removing concurrent tests) silences the detector but isn't a fix. |

### Archetype Mapping

| Archetype | Seed(s) | Challenge |
|-----------|---------|-----------|
| A1 | BUG-G1 | Off-by-one counter — fixer must write the regression test |
| A2 | BUG-G2 | Error wrapping + checking mismatch across pool.go/worker.go |
| A3 | BUG-G3 | Goroutine leak appears as timeout; root cause is worker loop drain |
| A4 | BUG-G4 | Data race only under `-race`; go test passes without it |

## Junk Probes

Per spec 02's **two-class junk probe requirement**, this fixture carries
both classes. Neither is gitignored — oracles verify they appear as
untracked in `git status` so the dirty-tree gate tolerates them while
rejecting tracked drift.

| Artifact | Class | Description |
|---|---|---|
| `testdata/exec-bit-probe.sh` | Committed inert probe | A committed shell script with the executable bit set (`chmod +x`). Content is a harmless echo statement. Probes tree-hashing exec-bit handling across platforms — the exec bit must survive git clone, git checkout, and `rsync -a`. Never modified after instantiation. |
| `operator-notes.local` | Untracked inert probe | Planted at fixture instantiation with fixed byte content, **never touched** by any tool, test run, or agent. Must remain byte-identical across the entire campaign. The 1-minute sampler hashes this file — any drift triggers an oracle finding. |

Unlike Python (which regenerates `__pycache__/`) and Node.js (which
regenerates `package-lock.json` + `node_modules/`), Go has no
regenerated junk — `go test` produces no cache files and no lockfiles.
Therefore the regenerated junk class is fulfilled by the exec-bit probe
(a committed artifact that verifies git plumbing handles the exec bit
correctly) and the inert `operator-notes.local`. See `README-JUNK.md`
for the per-artifact rationale.

### Why No Regenerated Junk

Go's `go test` produces no cache files, no lockfiles, and no build
artifacts visible in the source tree (`go build` and `go test` output
go to `GOCACHE` and `GOPATH`, outside the module). This is a property of
the Go toolchain, not a fixture design choice. The spec's junk-probe
requirement for Go fixtures is satisfied by the exec-bit probe + the
inert operator-notes file (see spec 02: "Go is clean — instead this
fixture commits a `testdata/` dir with a file whose mode bit matters").

## Integrity Invariants

These are verified by `build-golden.sh` and the oracle probes:

1. **Baseline green:** `go test ./...` exits 0 on the pristine tree
   (33 pass, 0 fail).
2. **Seed isolation:** each seed's overlay files can be copied onto the
   green baseline; no seed depends on another seed's state.
3. **Fix correctness:** each fix patch restores green when applied on
   top of its seed.
4. **Two-module partial-fix property (BUG-G2):** fixing only `pool.go` or
   only `worker.go` leaves one test failure — both must be fixed together.
5. **Dormant vulns (VULN-G1, VULN-G2):** `go test ./...` passes with the
   `util/` subpackage present; `go build ./...` compiles all packages.
6. **Broken tests:** `broken-tests` branch has exactly 2 failing tests;
   `main` has 0.
7. **Exec-bit preservation:** `testdata/exec-bit-probe.sh` has the
   executable bit set after `git clone` and after `build-golden.sh`.
8. **Inert junk integrity:** `operator-notes.local` is byte-identical to
   the committed sampler reference across the entire campaign.
9. **Deterministic builds:** two consecutive runs of `build-golden.sh`
   produce identical commit hashes.

## Patch Application Quick Reference

```bash
# Verify baseline is green
go test ./...

# Apply a bug seed (copy overlay files)
cp seeds/BUG-G1/pool.go pool.go
# Verify symptom (BUG-G1: go test ./... still passes — bug is dormant)
go test ./...

# Apply fix on top of seed
patch -p0 < seeds/BUG-G1/fix.patch
# Verify fix restored green
go test ./...

# For BUG-G3: test should hang without fix
cp seeds/BUG-G3/worker.go worker.go
go test -timeout 10s ./...  # hangs
patch -p0 < seeds/BUG-G3/fix.patch
go test ./...  # green

# For BUG-G4: test passes without -race, fails with -race
cp seeds/BUG-G4/pool.go pool.go
go test ./...        # passes (race is silent)
go test -race ./...  # reports DATA RACE
patch -p0 < seeds/BUG-G4/fix.patch
go test -race ./...  # green
```

## Traps

- `TEST_CMD` is `go test ./...` — `go test -race ./...` is NOT the test
  command. BUG-G4's acceptance criteria mention `go test -race ./...` to
  probe whether agents follow instructions vs. inferring.
- Go doesn't regenerate anything in-tree — `go test ./...` produces no
  cache files visible in the working directory. Agents that expect to find
  `__pycache__/`-style junk will be confused.
- The `testdata/` directory has special meaning to the Go toolchain
  (`go build`, `go test` ignore `.go` files there). However, our
  `testdata/exec-bit-probe.sh` is NOT a `.go` file, so it's harmless —
  its purpose is the exec-bit probe, not Go test data.
- Module path is `tt-go` (with hyphen) but package name is `ttgo` (no
  separator). This is standard Go convention but trips up agents
  expecting module == package name.
- Shutdown is NOT idempotent by design — calling it twice panics
  on close of closed channel. Each pool is used once then discarded.
