# ttgo — Concurrent Worker Pool

A Go package implementing a fixed-size goroutine pool with task submission,
result collection, graceful shutdown with queue drain, panic recovery, and
atomic counter observability.

Built for the tamandua torture-test suite — zero external dependencies
beyond the Go standard library.

## Setup

Requires **Go >= 1.21**.

```bash
go test ./...
```

## Module Overview

- **`task.go`** — `Task` and `Result` types (task identity, execution
  function, timing metadata).
- **`pool.go`** — `WorkerPool` struct, constructor (`NewPool`), task
  submission (`Submit`), graceful shutdown (`Shutdown`), result collection
  channel (`Results`), atomic running/completed counters (`Running`,
  `Completed`), worker goroutine loop with panic recovery, and the
  `PanicError` type.

### Key Behaviors

- **Fixed-size worker pool** — at most `maxWorkers` goroutines execute
  tasks concurrently.
- **Graceful shutdown** — `Shutdown()` drains all queued tasks before
  closing the result channel; subsequent `Submit` calls return
  `ErrPoolShutdown`.
- **Panic recovery** — a single panicking task never crashes a worker;
  the panic is captured as a `PanicError` in the `Result`.
- **Default handling** — `maxWorkers <= 0` defaults to 1;
  `queueSize <= 0` defaults to `maxWorkers * 2`.
