package ttgo

import "time"

// Task represents a unit of work to be executed by the worker pool.
type Task struct {
	ID      string
	Name    string
	Func    func() (any, error)
	Timeout time.Duration
}

// Result holds the outcome of a completed task execution.
type Result struct {
	TaskID    string
	Value     any
	Err       error
	Duration  time.Duration
	StartTime time.Time
	EndTime   time.Time
}
