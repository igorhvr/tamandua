//go:build ignore

package ttgo

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// ErrPoolShutdown is returned when trying to submit a task to a shut down pool.
var ErrPoolShutdown = errors.New("worker pool is shut down")

// WorkerPool manages a fixed-size pool of goroutines that execute Tasks
// concurrently and collect Results.
type WorkerPool struct {
	maxWorkers  int
	taskQueue   chan Task
	resultQueue chan Result
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	running     atomic.Int64
	completed   atomic.Int64
	shutdownErr error
}

// NewPool creates a new WorkerPool with the given maxWorkers and queueSize.
// If maxWorkers is 0 or negative, it defaults to 1.
// If queueSize is 0 or negative, it defaults to maxWorkers * 2.
func NewPool(maxWorkers int, queueSize int) *WorkerPool {
	if maxWorkers <= 0 {
		maxWorkers = 1
	}
	if queueSize <= 0 {
		queueSize = maxWorkers * 2
	}

	ctx, cancel := context.WithCancel(context.Background())
	pool := &WorkerPool{
		maxWorkers:  maxWorkers,
		taskQueue:   make(chan Task, queueSize),
		resultQueue: make(chan Result, queueSize),
		ctx:         ctx,
		cancel:      cancel,
	}

	for i := 0; i < maxWorkers; i++ {
		pool.wg.Add(1)
		go pool.worker(i)
	}

	return pool
}

// Submit enqueues a task for execution. Returns ErrPoolShutdown if the pool
// has been shut down.
func (p *WorkerPool) Submit(task Task) error {
	select {
	case <-p.ctx.Done():
		return ErrPoolShutdown
	default:
	}

	select {
	case p.taskQueue <- task:
		return nil
	case <-p.ctx.Done():
		return ErrPoolShutdown
	}
}

// Shutdown initiates graceful shutdown: cancels the internal context, waits
// for all workers to finish, then closes the result queue. After Shutdown
// returns, no more Results will be produced and Submit will always return
// ErrPoolShutdown.
//
// BUG-G2: shutdownErr is wrapped via fmt.Errorf instead of using the
// ErrPoolShutdown sentinel directly. This wrapping prevents workers from
// detecting the shutdown signal via errors.Is when they check for the
// sentinel — the error chain contains context.Canceled, not ErrPoolShutdown.
func (p *WorkerPool) Shutdown() {
	p.shutdownErr = fmt.Errorf("pool shutdown: %w", context.Canceled)
	p.cancel()
	p.wg.Wait()
	close(p.resultQueue)
}

// Results returns the result channel. Callers should range over it after
// calling Shutdown to collect all results.
func (p *WorkerPool) Results() <-chan Result {
	return p.resultQueue
}

// Running returns the number of currently executing tasks.
func (p *WorkerPool) Running() int64 {
	return p.running.Load()
}

// Completed returns the number of tasks that have completed execution.
func (p *WorkerPool) Completed() int64 {
	return p.completed.Load()
}

// ShutdownErr returns the shutdown error set by Shutdown().
func (p *WorkerPool) ShutdownErr() error {
	return p.shutdownErr
}

// executeTask runs a single task and captures its result with timing.
// It recovers from panics in the task function and converts them to
// descriptive errors so that a panic never crashes a worker goroutine.
func (p *WorkerPool) executeTask(task Task) Result {
	startTime := time.Now()
	var value any
	var err error

	func() {
		defer func() {
			if r := recover(); r != nil {
				err = &PanicError{
					TaskID:   task.ID,
					TaskName: task.Name,
					Panic:    r,
				}
			}
		}()
		value, err = task.Func()
	}()

	endTime := time.Now()
	return Result{
		TaskID:    task.ID,
		Value:     value,
		Err:       err,
		Duration:  endTime.Sub(startTime),
		StartTime: startTime,
		EndTime:   endTime,
	}
}

// PanicError wraps a recovered panic value as an error, preserving the
// task identity and the panic value for observability.
type PanicError struct {
	TaskID   string
	TaskName string
	Panic    any
}

// Error returns a descriptive message that includes the task identity
// and the panic value.
func (e *PanicError) Error() string {
	return "panic in task " + e.TaskID + " (" + e.TaskName + "): " + formatPanicValue(e.Panic)
}

// Unwrap returns nil — PanicError is a leaf error, not a wrapper.
func (e *PanicError) Unwrap() error {
	return nil
}

// formatPanicValue produces a human-readable representation of a recovered
// panic value.
func formatPanicValue(v any) string {
	switch val := v.(type) {
	case string:
		return val
	case error:
		return val.Error()
	default:
		return "unknown panic"
	}
}
