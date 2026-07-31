package ttgo

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewPoolDefaults(t *testing.T) {
	t.Run("zero values get defaults", func(t *testing.T) {
		p := NewPool(0, 0)
		if p.maxWorkers != 1 {
			t.Errorf("expected maxWorkers=1, got %d", p.maxWorkers)
		}
		if cap(p.taskQueue) != 2 {
			t.Errorf("expected taskQueue cap=2, got %d", cap(p.taskQueue))
		}
		p.Shutdown()
	})

	t.Run("negative values get defaults", func(t *testing.T) {
		p := NewPool(-5, -10)
		if p.maxWorkers != 1 {
			t.Errorf("expected maxWorkers=1, got %d", p.maxWorkers)
		}
		if cap(p.taskQueue) != 2 {
			t.Errorf("expected taskQueue cap=2, got %d", cap(p.taskQueue))
		}
		p.Shutdown()
	})

	t.Run("configured values are respected", func(t *testing.T) {
		p := NewPool(3, 10)
		if p.maxWorkers != 3 {
			t.Errorf("expected maxWorkers=3, got %d", p.maxWorkers)
		}
		if cap(p.taskQueue) != 10 {
			t.Errorf("expected taskQueue cap=10, got %d", cap(p.taskQueue))
		}
		p.Shutdown()
	})

	t.Run("zero queue defaults to maxWorkers*2", func(t *testing.T) {
		p := NewPool(4, 0)
		if cap(p.taskQueue) != 8 {
			t.Errorf("expected taskQueue cap=8, got %d", cap(p.taskQueue))
		}
		p.Shutdown()
	})
}

func TestSubmitAndCollectResult(t *testing.T) {
	p := NewPool(1, 1)

	task := Task{
		ID:   "task-1",
		Name: "simple",
		Func: func() (any, error) {
			return "hello", nil
		},
	}

	err := p.Submit(task)
	if err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.TaskID != "task-1" {
		t.Errorf("expected TaskID=task-1, got %s", r.TaskID)
	}
	if r.Value != "hello" {
		t.Errorf("expected Value=hello, got %v", r.Value)
	}
	// BROKEN: inverted assertion — expects error when err IS nil
	if r.Err == nil {
		t.Errorf("expected error but got nil")
	}
}

func TestSubmitAndCollectError(t *testing.T) {
	p := NewPool(1, 1)

	expectedErr := errors.New("task failed")
	task := Task{
		ID:   "task-err",
		Name: "failing",
		Func: func() (any, error) {
			return nil, expectedErr
		},
	}

	err := p.Submit(task)
	if err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.TaskID != "task-err" {
		t.Errorf("expected TaskID=task-err, got %s", r.TaskID)
	}
	if r.Err == nil {
		t.Error("expected non-nil error in result")
	}
	if r.Err != expectedErr {
		t.Errorf("expected error %v, got %v", expectedErr, r.Err)
	}
}

func TestSubmitAfterShutdown(t *testing.T) {
	p := NewPool(1, 1)
	p.Shutdown()

	task := Task{
		ID:   "task-late",
		Name: "too late",
		Func: func() (any, error) {
			return nil, nil
		},
	}

	err := p.Submit(task)
	if err != ErrPoolShutdown {
		t.Errorf("expected ErrPoolShutdown, got %v", err)
	}
}

func TestShutdownWaitsForWorkers(t *testing.T) {
	p := NewPool(2, 10)

	n := 5
	for i := 0; i < n; i++ {
		id := i
		task := Task{
			ID:   string(rune('a' + id)),
			Name: "task",
			Func: func() (any, error) {
				time.Sleep(10 * time.Millisecond)
				return id, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != n {
		t.Errorf("expected %d results, got %d", n, len(results))
	}
}

func TestAtomicCounters(t *testing.T) {
	p := NewPool(2, 10)

	n := 10
	for i := 0; i < n; i++ {
		id := i
		task := Task{
			ID:   string(rune('a' + id)),
			Name: "counter task",
			Func: func() (any, error) {
				time.Sleep(5 * time.Millisecond)
				return nil, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()

	// All tasks should be completed, none running
	if r := p.Running(); r != 0 {
		t.Errorf("expected 0 running tasks, got %d", r)
	}
	if c := p.Completed(); c != int64(n) {
		t.Errorf("expected %d completed tasks, got %d", n, c)
	}
}

func TestResultsIncludeTiming(t *testing.T) {
	p := NewPool(1, 1)

	task := Task{
		ID:   "task-timing",
		Name: "timing test",
		Func: func() (any, error) {
			time.Sleep(20 * time.Millisecond)
			return "done", nil
		},
	}

	if err := p.Submit(task); err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.StartTime.IsZero() {
		t.Error("StartTime should not be zero")
	}
	if r.EndTime.IsZero() {
		t.Error("EndTime should not be zero")
	}
	if r.Duration <= 0 {
		t.Errorf("Duration should be positive, got %v", r.Duration)
	}
	if !r.EndTime.After(r.StartTime) {
		t.Error("EndTime should be after StartTime")
	}
}

func TestMultipleResults(t *testing.T) {
	p := NewPool(3, 10)

	n := 8
	for i := 0; i < n; i++ {
		id := i
		task := Task{
			ID:   string(rune('a' + id)),
			Name: "multi task",
			Func: func() (any, error) {
				return id, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != n {
		t.Errorf("expected %d results, got %d", n, len(results))
	}
}

func TestShutdownDrainsQueue(t *testing.T) {
	p := NewPool(1, 10)

	n := 5
	for i := 0; i < n; i++ {
		id := i
		task := Task{
			ID:   string(rune('a' + id)),
			Name: "drain test",
			Func: func() (any, error) {
				return id, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	// Submit, then shutdown — workers should drain the queue
	p.Shutdown()

	results := collectResults(p)
	if len(results) != n {
		t.Errorf("expected %d results after drain, got %d", n, len(results))
	}
}

func TestConcurrentSubmit(t *testing.T) {
	p := NewPool(4, 50)
	n := 20

	done := make(chan struct{})
	for i := 0; i < n; i++ {
		go func(id int) {
			task := Task{
				ID:   string(rune('a' + id)),
				Name: "concurrent",
				Func: func() (any, error) {
					time.Sleep(1 * time.Millisecond)
					return id, nil
				},
			}
			if err := p.Submit(task); err != nil {
				t.Errorf("concurrent Submit #%d returned error: %v", id, err)
			}
			done <- struct{}{}
		}(i)
	}

	for i := 0; i < n; i++ {
		<-done
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != n {
		t.Errorf("expected %d results, got %d", n, len(results))
	}
}

func TestSubmitToFullQueueSucceedsAfterDrain(t *testing.T) {
	// Queue size 1, submit 2 tasks — worker picks up first task immediately
	// so the queue buffer frees. Both tasks complete.
	p := NewPool(1, 1)

	// Read results concurrently to avoid buffer deadlock
	resultsCh := make(chan []Result, 1)
	go func() {
		resultsCh <- collectResults(p)
	}()

	// Helper channel to control execution
	blockCh := make(chan struct{})

	task1 := Task{
		ID:   "blocker",
		Name: "blocker",
		Func: func() (any, error) {
			<-blockCh // block until we say so
			return "first", nil
		},
	}

	if err := p.Submit(task1); err != nil {
		t.Fatalf("Submit task1 returned error: %v", err)
	}

	// task1 is now being processed (blocked on blockCh). Queue buffer is free.
	// Submit task2 — it goes into the queue buffer.
	task2 := Task{
		ID:   "waiter",
		Name: "waiter",
		Func: func() (any, error) {
			return "second", nil
		},
	}
	if err := p.Submit(task2); err != nil {
		t.Fatalf("Submit task2 returned error: %v", err)
	}

	// Unblock task1 so both complete
	close(blockCh)

	p.Shutdown()
	results := <-resultsCh
	if len(results) != 2 {
		t.Errorf("expected 2 results, got %d", len(results))
	}
}

func TestResultsChannelClosedAfterShutdown(t *testing.T) {
	p := NewPool(1, 1)

	task := Task{
		ID:   "close-test",
		Name: "test",
		Func: func() (any, error) {
			return "ok", nil
		},
	}
	_ = p.Submit(task)
	p.Shutdown()

	// Collect results — channel should close after all results are sent
	results := collectResults(p)
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}

	// Verify channel is actually closed
	_, ok := <-p.Results()
	if ok {
		t.Error("results channel should be closed after Shutdown")
	}
}

func TestPanicRecoveryProducesError(t *testing.T) {
	p := NewPool(1, 1)

	task := Task{
		ID:   "task-panic",
		Name: "panic task",
		Func: func() (any, error) {
			panic("something went wrong")
		},
	}

	if err := p.Submit(task); err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.TaskID != "task-panic" {
		t.Errorf("expected TaskID=task-panic, got %s", r.TaskID)
	}
	if r.Err == nil {
		t.Error("expected non-nil error for panicked task")
	}
	if r.Value != nil {
		t.Errorf("expected nil Value for panicked task, got %v", r.Value)
	}

	// Verify the error is a PanicError with descriptive message
	panicErr, ok := r.Err.(*PanicError)
	if !ok {
		t.Fatalf("expected *PanicError, got %T: %v", r.Err, r.Err)
	}
	if panicErr.TaskID != "task-panic" {
		t.Errorf("expected PanicError.TaskID=task-panic, got %s", panicErr.TaskID)
	}
	if panicErr.Panic != "something went wrong" {
		t.Errorf("expected PanicError.Panic='something went wrong', got %v", panicErr.Panic)
	}
	errMsg := panicErr.Error()
	if errMsg == "" {
		t.Error("expected non-empty error message")
	}
}

func TestPanicRecoveryPersistsTiming(t *testing.T) {
	p := NewPool(1, 1)

	task := Task{
		ID:   "task-panic-timing",
		Name: "panic with timing",
		Func: func() (any, error) {
			time.Sleep(10 * time.Millisecond)
			panic("boom")
		},
	}

	if err := p.Submit(task); err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.StartTime.IsZero() {
		t.Error("StartTime should not be zero for panicked task")
	}
	if r.EndTime.IsZero() {
		t.Error("EndTime should not be zero for panicked task")
	}
	if r.Duration <= 0 {
		t.Errorf("Duration should be positive for panicked task, got %v", r.Duration)
	}
	if r.Err == nil {
		t.Error("expected non-nil error for panicked task")
	}
}

func TestWorkersContinueAfterPanic(t *testing.T) {
	p := NewPool(2, 10)

	n := 5
	for i := 0; i < n; i++ {
		id := i
		var task Task
		if id == 2 {
			// Task index 2 panics
			task = Task{
				ID:   "panic-" + string(rune('a'+id)),
				Name: "the panicker",
				Func: func() (any, error) {
					panic("intentional panic")
				},
			}
		} else {
			task = Task{
				ID:   "ok-" + string(rune('a'+id)),
				Name: "normal task",
				Func: func() (any, error) {
					time.Sleep(5 * time.Millisecond)
					return id, nil
				},
			}
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != n {
		t.Errorf("expected %d results, got %d (workers may have crashed)", n, len(results))
	}

	var panicCount, normalCount int
	for _, r := range results {
		if r.Err != nil {
			panicCount++
			if _, ok := r.Err.(*PanicError); !ok {
				t.Errorf("expected PanicError for failed result, got %T: %v", r.Err, r.Err)
			}
		} else {
			normalCount++
		}
	}

	if panicCount != 1 {
		t.Errorf("expected 1 panicked result, got %d", panicCount)
	}
	if normalCount != n-1 {
		t.Errorf("expected %d normal results, got %d", n-1, normalCount)
	}

	// Verify no worker goroutines are still running
	if r := p.Running(); r != 0 {
		t.Errorf("expected 0 running tasks after shutdown, got %d", r)
	}
}

func TestPanicWithErrorValue(t *testing.T) {
	p := NewPool(1, 1)

	errSentinel := errors.New("sentinel panic error")
	task := Task{
		ID:   "task-panic-err",
		Name: "panic with error",
		Func: func() (any, error) {
			panic(errSentinel)
		},
	}

	if err := p.Submit(task); err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.Err == nil {
		t.Error("expected non-nil error for panicked task")
	}
	panicErr, ok := r.Err.(*PanicError)
	if !ok {
		t.Fatalf("expected *PanicError, got %T", r.Err)
	}
	if panicErr.Panic != errSentinel {
		t.Errorf("expected PanicError.Panic=sentinel, got %v", panicErr.Panic)
	}
	errMsg := panicErr.Error()
	if errMsg == "" {
		t.Error("expected non-empty error message")
	}
}

func TestPanicWithIntValue(t *testing.T) {
	p := NewPool(1, 1)

	task := Task{
		ID:   "task-panic-int",
		Name: "panic with int",
		Func: func() (any, error) {
			panic(42)
		},
	}

	if err := p.Submit(task); err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()

	results := collectResults(p)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.Err == nil {
		t.Error("expected non-nil error for panicked task")
	}
	panicErr, ok := r.Err.(*PanicError)
	if !ok {
		t.Fatalf("expected *PanicError, got %T", r.Err)
	}
	if panicErr.Panic != 42 {
		t.Errorf("expected PanicError.Panic=42, got %v", panicErr.Panic)
	}
	// Error message should include "unknown panic" for non-string/non-error values
	errMsg := panicErr.Error()
	if errMsg == "" {
		t.Error("expected non-empty error message for int panic")
	}
}

func TestConcurrentPanicRecovery(t *testing.T) {
	p := NewPool(4, 20)

	n := 10
	for i := 0; i < n; i++ {
		id := i
		var task Task
		if id%2 == 0 {
			task = Task{
				ID:   "panic-" + string(rune('a'+id)),
				Name: "panicker",
				Func: func() (any, error) {
					panic("panic " + string(rune('a'+id)))
				},
			}
		} else {
			task = Task{
				ID:   "ok-" + string(rune('a'+id)),
				Name: "normal",
				Func: func() (any, error) {
					time.Sleep(1 * time.Millisecond)
					return id, nil
				},
			}
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != n {
		t.Fatalf("expected %d results, got %d", n, len(results))
	}

	var panicCount int
	for _, r := range results {
		if r.Err != nil {
			if _, ok := r.Err.(*PanicError); !ok {
				t.Errorf("expected PanicError, got %T: %v", r.Err, r.Err)
			}
			panicCount++
		}
	}

	expectedPanics := n / 2
	if panicCount != expectedPanics {
		t.Errorf("expected %d panicked results, got %d", expectedPanics, panicCount)
	}
}

func TestMultipleWorkersConcurrency(t *testing.T) {
	// Verify that tasks actually run concurrently by tracking overlapping
	// execution windows with atomic counters. We submit N tasks with
	// maxWorkers=M and verify that at least 2 tasks ran at the same time.
	t.Run("at least two tasks run concurrently", func(t *testing.T) {
		p := NewPool(3, 10)
		var concurrent atomic.Int64
		var maxConcurrent atomic.Int64

		n := 9
		for i := 0; i < n; i++ {
			task := Task{
				ID:   string(rune('a' + i)),
				Name: "concurrent",
				Func: func() (any, error) {
					c := concurrent.Add(1)
					for {
						old := maxConcurrent.Load()
						if c <= old || maxConcurrent.CompareAndSwap(old, c) {
							break
						}
					}
					time.Sleep(20 * time.Millisecond)
					concurrent.Add(-1)
					return nil, nil
				},
			}
			if err := p.Submit(task); err != nil {
				t.Fatalf("Submit returned error: %v", err)
			}
		}

		p.Shutdown()
		results := collectResults(p)
		if len(results) != n {
			t.Errorf("expected %d results, got %d", n, len(results))
		}
		if max := maxConcurrent.Load(); max < 2 {
			t.Errorf("expected at least 2 concurrent tasks, got %d", max)
		}
	})
}

func TestWorkersDoNotExceedMaxCount(t *testing.T) {
	// Verify at most maxWorkers run simultaneously, even with many tasks.
	p := NewPool(2, 20)
	var concurrent atomic.Int64
	var maxConcurrent atomic.Int64

	n := 8
	for i := 0; i < n; i++ {
		task := Task{
			ID:   string(rune('a' + i)),
			Name: "bounded",
			Func: func() (any, error) {
				c := concurrent.Add(1)
				for {
					old := maxConcurrent.Load()
					if c <= old || maxConcurrent.CompareAndSwap(old, c) {
						break
					}
				}
				time.Sleep(15 * time.Millisecond)
				concurrent.Add(-1)
				return nil, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit returned error: %v", err)
		}
	}

	p.Shutdown()
	results := collectResults(p)
	if len(results) != n {
		t.Errorf("expected %d results, got %d", n, len(results))
	}
	if max := maxConcurrent.Load(); max > 2 {
		t.Errorf("expected at most 2 concurrent tasks, got %d", max)
	}
}

func TestTaskWithSleepDoesNotHang(t *testing.T) {
	// A task that sleeps for a bit completes normally and doesn't deadlock.
	p := NewPool(1, 1)

	done := make(chan struct{})
	go func() {
		defer close(done)
		results := collectResults(p)
		if len(results) != 1 {
			t.Errorf("expected 1 result, got %d", len(results))
		}
	}()

	task := Task{
		ID:   "sleepy",
		Name: "sleeper",
		Func: func() (any, error) {
			time.Sleep(100 * time.Millisecond)
			return "woke up", nil
		},
	}
	if err := p.Submit(task); err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}
	p.Shutdown()

	select {
	case <-done:
		// Success — pool completed normally
	case <-time.After(2 * time.Second):
		t.Fatal("pool hung — Shutdown did not complete within timeout")
	}
}

func TestZeroMaxWorkersDefaultsToSingleWorker(t *testing.T) {
	// maxWorkers=0 should default to 1, not reject submissions
	p := NewPool(0, 5)

	if p.maxWorkers != 1 {
		t.Fatalf("expected maxWorkers to default to 1, got %d", p.maxWorkers)
	}

	task := Task{
		ID:   "task-zero",
		Name: "zero workers",
		Func: func() (any, error) {
			return "works", nil
		},
	}

	err := p.Submit(task)
	if err != nil {
		t.Fatalf("Submit should succeed with default maxWorkers, got: %v", err)
	}

	p.Shutdown()
	results := collectResults(p)
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}
	if results[0].Value != "works" {
		t.Errorf("expected Value='works', got %v", results[0].Value)
	}
}

func TestLargeTaskCount(t *testing.T) {
	// Stress test: 100 tasks with 4 workers, all must complete.
	p := NewPool(4, 200)

	n := 100
	for i := 0; i < n; i++ {
		id := i
		task := Task{
			ID:   string(rune('a' + (id % 26))),
			Name: "stress",
			Func: func() (any, error) {
				return id, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != n {
		t.Errorf("expected %d results, got %d", n, len(results))
	}
	if c := p.Completed(); c != int64(n) {
		t.Errorf("expected %d completed, got %d", n, c)
	}
}

func TestTableDrivenSubmitResults(t *testing.T) {
	type testCase struct {
		name        string
		taskFunc    func() (any, error)
		wantValue   any
		wantErrNil  bool
	}

	tests := []testCase{
		{
			name:       "int result",
			taskFunc:   func() (any, error) { return 42, nil },
			wantValue:  42,
			wantErrNil: true,
		},
		{
			name:       "string result",
			taskFunc:   func() (any, error) { return "hello world", nil },
			wantValue:  "hello world",
			wantErrNil: true,
		},
		{
			name:       "nil result",
			taskFunc:   func() (any, error) { return nil, nil },
			wantValue:  nil,
			wantErrNil: true,
		},
		{
			name:       "bool result",
			taskFunc:   func() (any, error) { return true, nil },
			wantValue:  true,
			wantErrNil: true,
		},
		{
			name:       "error result",
			taskFunc:   func() (any, error) { return nil, errors.New("boom") },
			wantValue:  nil,
			wantErrNil: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := NewPool(1, 1)
			task := Task{
				ID:   "table-" + tc.name,
				Name: tc.name,
				Func: tc.taskFunc,
			}
			if err := p.Submit(task); err != nil {
				t.Fatalf("Submit returned error: %v", err)
			}
			p.Shutdown()

			results := collectResults(p)
			if len(results) != 1 {
				t.Fatalf("expected 1 result, got %d", len(results))
			}

			r := results[0]
			if tc.wantValue != nil && r.Value != tc.wantValue {
				t.Errorf("expected Value=%v, got %v", tc.wantValue, r.Value)
			}
			if tc.wantValue == nil && r.Value != nil {
				t.Errorf("expected nil Value, got %v", r.Value)
			}
			if tc.wantErrNil && r.Err != nil {
				t.Errorf("expected nil error, got %v", r.Err)
			}
			if !tc.wantErrNil && r.Err == nil {
				t.Error("expected non-nil error")
			}
		})
	}
}

func TestTableDrivenTaskErrors(t *testing.T) {
	type testCase struct {
		name     string
		taskFunc func() (any, error)
		wantErr  error
	}

	tests := []testCase{
		{
			name:     "sentinel error",
			taskFunc: func() (any, error) { return nil, errors.New("sentinel") },
			wantErr:  errors.New("sentinel"),
		},
		{
			name:     "fmt error",
			taskFunc: func() (any, error) { return nil, errors.New("wrapped: boom") },
			wantErr:  errors.New("wrapped: boom"),
		},
		{
			name:     "empty error message",
			taskFunc: func() (any, error) { return nil, errors.New("") },
			wantErr:  errors.New(""),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := NewPool(1, 1)
			task := Task{
				ID:   "err-" + tc.name,
				Name: tc.name,
				Func: tc.taskFunc,
			}
			if err := p.Submit(task); err != nil {
				t.Fatalf("Submit returned error: %v", err)
			}
			p.Shutdown()

			results := collectResults(p)
			if len(results) != 1 {
				t.Fatalf("expected 1 result, got %d", len(results))
			}

			r := results[0]
			if r.Err == nil {
				t.Fatal("expected non-nil error")
			}
			if r.Err.Error() != tc.wantErr.Error() {
				t.Errorf("expected error %q, got %q", tc.wantErr.Error(), r.Err.Error())
			}
		})
	}
}

func TestPoolWithSingleWorker(t *testing.T) {
	// Single worker processes tasks sequentially; all must complete.
	p := NewPool(1, 10)

	order := make(chan int, 5)
	for i := 0; i < 5; i++ {
		id := i
		task := Task{
			ID:   string(rune('a' + id)),
			Name: "single",
			Func: func() (any, error) {
				time.Sleep(5 * time.Millisecond)
				order <- id
				return id, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != 5 {
		t.Errorf("expected 5 results, got %d", len(results))
	}

	close(order)
	var orderVals []int
	for o := range order {
		orderVals = append(orderVals, o)
	}
	// With single worker, tasks should complete in FIFO order
	for i := 0; i < len(orderVals); i++ {
		if orderVals[i] != i {
			t.Errorf("expected task order[%d]=%d, got %d", i, i, orderVals[i])
		}
	}
}

func TestResultsArriveUnordered(t *testing.T) {
	// With multiple workers, results may arrive out of submission order.
	p := NewPool(3, 10)

	// Longer tasks get submitted first, shorter later — shorter finish faster
	for i := 0; i < 3; i++ {
		id := i
		sleepTime := time.Duration(3-i) * 20 * time.Millisecond // 60ms, 40ms, 20ms
		task := Task{
			ID:   string(rune('a' + id)),
			Name: "unordered",
			Func: func() (any, error) {
				time.Sleep(sleepTime)
				return id, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != 3 {
		t.Errorf("expected 3 results, got %d", len(results))
	}
	// All 3 results should be present (order doesn't matter)
	seen := make(map[int]bool)
	for _, r := range results {
		id, ok := r.Value.(int)
		if !ok {
			t.Errorf("expected int Value, got %T", r.Value)
			continue
		}
		seen[id] = true
	}
	if len(seen) != 3 {
		t.Errorf("expected 3 unique result IDs, got %d", len(seen))
	}
}

func TestConcurrentSubmitAndShutdownRace(t *testing.T) {
	// Submit tasks concurrently while another goroutine calls Shutdown.
	// No hangs, all submitted tasks produce results, late submits get error.
	p := NewPool(4, 100)

	var submitted atomic.Int64
	var rejected atomic.Int64

	const n = 50
	var wg sync.WaitGroup

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			task := Task{
				ID:   string(rune('a' + (id % 26))),
				Name: "race",
				Func: func() (any, error) {
					time.Sleep(1 * time.Millisecond)
					return id, nil
				},
			}
			err := p.Submit(task)
			if err == ErrPoolShutdown {
				rejected.Add(1)
			} else if err == nil {
				submitted.Add(1)
			} else {
				t.Errorf("unexpected Submit error: %v", err)
			}
		}(i)
	}

	// Allow some tasks to submit, then shutdown
	time.Sleep(5 * time.Millisecond)
	p.Shutdown()
	wg.Wait()

	results := collectResults(p)

	// Total submitted + rejected should equal n
	total := submitted.Load() + rejected.Load()
	if total != n {
		t.Errorf("expected submitted(%d) + rejected(%d) = %d, got %d", submitted.Load(), rejected.Load(), n, total)
	}

	// Results count should match submitted count
	if int64(len(results)) != submitted.Load() {
		t.Errorf("expected %d results, got %d", submitted.Load(), len(results))
	}
}

func TestSubmitMultipleBeforeShutdown(t *testing.T) {
	// Submit many tasks all at once, then shutdown — all complete.
	p := NewPool(2, 50)

	n := 25
	for i := 0; i < n; i++ {
		id := i
		task := Task{
			ID:   string(rune('a' + (id % 26))),
			Name: "batch",
			Func: func() (any, error) {
				return id * 2, nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit #%d returned error: %v", id, err)
		}
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != n {
		t.Errorf("expected %d results, got %d", n, len(results))
	}

	// All results should have their correct doubled values
	valueSet := make(map[int]bool)
	for _, r := range results {
		v, ok := r.Value.(int)
		if !ok {
			t.Errorf("expected int Value, got %T", r.Value)
			continue
		}
		if v%2 != 0 {
			t.Errorf("expected even result, got %d", v)
		}
		valueSet[v] = true
	}
	if len(valueSet) != n {
		t.Errorf("expected %d unique results, got %d", n, len(valueSet))
	}
}

func TestMaxQueueCapacity(t *testing.T) {
	// Fill queue to capacity with blocking tasks, verify all processed.
	qSize := 5
	p := NewPool(2, qSize)

	// Read results concurrently
	resultsCh := make(chan []Result, 1)
	go func() {
		resultsCh <- collectResults(p)
	}()

	// Block all workers on a channel
	blockCh := make(chan struct{})

	// Submit maxWorkers tasks to block workers
	for i := 0; i < 2; i++ {
		task := Task{
			ID:   "block-" + string(rune('a'+i)),
			Name: "blocker",
			Func: func() (any, error) {
				<-blockCh
				return "blocker done", nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit blocker returned error: %v", err)
		}
	}

	// Fill the queue buffer (maxWorkers * 2 = 4 additional tasks for default)
	// Actually qSize is 5, so: 2 workers busy + 5 in queue = 7 total capacity
	for i := 0; i < qSize; i++ {
		task := Task{
			ID:   "queued-" + string(rune('a'+i)),
			Name: "queued",
			Func: func() (any, error) {
				return "queued ok", nil
			},
		}
		if err := p.Submit(task); err != nil {
			t.Fatalf("Submit queued #%d returned error: %v", i, err)
		}
	}

	// Unblock workers — all queued tasks should process
	close(blockCh)
	p.Shutdown()

	results := <-resultsCh
	// 2 blockers + 5 queued = 7 total
	if len(results) != 7 {
		t.Errorf("expected 7 results, got %d", len(results))
	}
}

func TestMultipleSequentialPoolCycles(t *testing.T) {
	// Create, use, and shut down a pool. Then create another and do it again.
	// Verifies pools are independent and don't leak state.

	for cycle := 0; cycle < 3; cycle++ {
		p := NewPool(2, 5)

		n := 3
		for i := 0; i < n; i++ {
			id := i
			task := Task{
				ID:   string(rune('a' + id)),
				Name: "cycle",
				Func: func() (any, error) {
					return id, nil
				},
			}
			if err := p.Submit(task); err != nil {
				t.Fatalf("Cycle %d Submit #%d returned error: %v", cycle, id, err)
			}
		}

		p.Shutdown()
		results := collectResults(p)

		if len(results) != n {
			t.Errorf("Cycle %d: expected %d results, got %d", cycle, n, len(results))
		}
	}
}

func TestTaskWithImmediateReturn(t *testing.T) {
	// Task that returns immediately (no sleep) produces correct result.
	p := NewPool(1, 1)

	task := Task{
		ID:   "instant",
		Name: "no delay",
		Func: func() (any, error) {
			return "instant", nil
		},
	}

	if err := p.Submit(task); err != nil {
		t.Fatalf("Submit returned error: %v", err)
	}

	p.Shutdown()
	results := collectResults(p)

	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.Value != "instant" {
		t.Errorf("expected Value='instant', got %v", r.Value)
	}
	if r.Err != nil {
		t.Errorf("expected nil error, got %v", r.Err)
	}
	if r.Duration < 0 {
		t.Errorf("Duration should be >= 0, got %v", r.Duration)
	}
	if !r.EndTime.After(r.StartTime) && !r.EndTime.Equal(r.StartTime) {
		t.Error("EndTime should be >= StartTime")
	}
}

func TestSubmitAfterContextDone(t *testing.T) {
	// Verify that Submit returns ErrPoolShutdown when context is done
	// (even if Shutdown hasn't been called explicitly).
	p := NewPool(2, 5)

	// Cancel the context directly
	p.cancel()

	task := Task{
		ID:   "late",
		Name: "too late",
		Func: func() (any, error) {
			return nil, nil
		},
	}

	err := p.Submit(task)
	if err != ErrPoolShutdown {
		t.Errorf("expected ErrPoolShutdown after context cancel, got %v", err)
	}

	// Clean up — Shutdown should still work (idempotent)
	p.Shutdown()
}

// collectResults drains all results from the pool's result channel.
func collectResults(p *WorkerPool) []Result {
	var results []Result
	for r := range p.Results() {
		results = append(results, r)
	}
	return results
}
