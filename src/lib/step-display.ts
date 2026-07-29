/**
 * Presentation-only display status helper.
 *
 * This helper computes a human-friendly label for step status presentation.
 * It never mutates or reflects storage — the raw `status` field is untouched.
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
