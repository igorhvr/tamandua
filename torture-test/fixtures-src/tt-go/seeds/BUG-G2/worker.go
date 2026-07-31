//go:build ignore

package ttgo

import (
	"errors"
)

// worker is the goroutine that processes tasks from the task queue.
func (p *WorkerPool) worker(id int) {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			// Drain remaining tasks before exiting.
			for {
				select {
				case task, ok := <-p.taskQueue:
					if !ok {
						return
					}
					p.running.Add(1)
					result := p.executeTask(task)
					p.running.Add(-1)
					p.completed.Add(1)
					// BUG-G2: worker checks for ErrPoolShutdown to decide
					// whether to send results. But pool.go wraps the error
					// as fmt.Errorf("pool shutdown: %w", context.Canceled),
					// so errors.Is(p.shutdownErr, ErrPoolShutdown) is always
					// false. The worker thinks the pool hasn't shut down
					// cleanly and drops the result silently.
					if errors.Is(p.shutdownErr, ErrPoolShutdown) {
						p.resultQueue <- result
					}
					// else: result silently dropped — worker thinks pool
					//        did not shut down cleanly.
				default:
					return
				}
			}
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
