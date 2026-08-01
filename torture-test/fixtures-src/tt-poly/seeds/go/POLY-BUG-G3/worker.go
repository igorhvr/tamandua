//go:build ignore

package ttgo

// worker is the goroutine that processes tasks from the task queue.
//
// BUG-G3: when ctx.Done() fires (shutdown signal), the worker exits
// immediately WITHOUT draining the remaining tasks from taskQueue.
// This causes a goroutine leak: tasks left in the queue are never
// processed, but Shutdown() is waiting for resultQueue to drain.
// If 1000 tasks are queued and Shutdown is called, the workers exit,
// no more results arrive, and the caller reading from Results() hangs
// forever — a deadlock that looks like a test infrastructure timeout.
func (p *WorkerPool) worker(id int) {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			// BUG: exit immediately without draining the task queue.
			// Any tasks still in taskQueue are abandoned. Since no more
			// results are produced, the resultQueue never drains, and
			// the caller reading from Results() hangs indefinitely.
			return
		case task, ok := <-p.taskQueue:
			if !ok {
				return
			}
			p.running.Add(1)
			result := p.executeTask(task)
			p.running.Add(-1)
			p.completed.Add(1)
			select {
			case p.resultQueue <- result:
			case <-p.ctx.Done():
				// Keep trying to deliver until successful.
				p.resultQueue <- result
			}
		}
	}
}
