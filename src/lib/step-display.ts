/**
 * Presentation-only display status helper.
 *
 * These helpers compute human-friendly labels for step/story status
 * presentation. They never mutate or reflect storage — the raw `status`
 * fields are untouched.
 *
 * Label rules:
 * - Parked verify_each loop (type=loop, status=running, currentStoryId=null) → "verifying"
 * - Active loop (currentStoryId set) → raw status (typically "running")
 * - Everything else → raw status
 */

export interface StepDisplayInput {
  type: string;
  status: string;
  currentStoryId: string | null;
}

/**
 * Compute the presentation-only display label for a step.
 *
 * | type   | status  | currentStoryId | → label      |
 * |--------|---------|----------------|-------------|
 * | loop   | running | null           | verifying   |
 * | loop   | running | set            | running     |
 * | loop   | any     | any            | raw status  |
 * | single | any     | (null)         | raw status  |
 */
export function displayStepStatus(s: StepDisplayInput): string {
  if (
    s.type === "loop" &&
    s.status === "running" &&
    s.currentStoryId === null
  ) {
    return "verifying";
  }
  return s.status;
}

/**
 * Input for the presentation-only story status label.
 */
export interface StoryDisplayInput {
  /** Raw stored story status ('pending' | 'running' | 'done' | 'failed'). */
  status: string;
  /** Number of resume re-queues for this story (stories.resume_reset_count);
   *  0/absent means the story was never reset on resume. */
  resumeResetCount?: number;
}

/**
 * Compute the presentation-only display label for a story.
 *
 * A story that a resume re-queued from FAILED is still stored with
 * status 'pending' (the stored status is NEVER changed) but is displayed
 * with a distinct annotation so an operator can see at a glance that the
 * pending story carries a prior failure history:
 *
 *   status === 'pending' && resumeResetCount > 0 →
 *     "pending (reset on resume, N prior failure[s])"  (1 prior failure singular)
 *   otherwise → raw status
 */
export function displayStoryStatus(s: StoryDisplayInput): string {
  const resetCount = s.resumeResetCount ?? 0;
  if (s.status === "pending" && resetCount > 0) {
    const plural = resetCount === 1 ? "failure" : "failures";
    return `pending (reset on resume, ${resetCount} prior ${plural})`;
  }
  return s.status;
}
