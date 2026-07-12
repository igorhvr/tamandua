/**
 * step command group — claim/complete/fail/peek/stories for workflow step lifecycle.
 *
 * Extracted from src/cli/cli.ts (SPLC story US-008).
 */

import { claimStep, completeStep, failStep, getStories, getOwnProcessGroupId, peekStep } from "../../installer/step-ops.js";
import { getWorkflowStatus } from "../../installer/status.js";

export function getStepPeekHelp(): string {
  return `tamandua step peek — Check for pending work for an agent

Usage: tamandua step peek <agent-id> --run-id <run-id>

step peek checks whether an agent has pending (waiting or pending) work in the
specified run. It is used by the agent scheduler polling loop to decide whether
to spawn a work session.

Output:
  HAS_WORK    — There is pending work; the scheduler will spawn a work session.
  NO_WORK     — No pending work; the scheduler will poll again later.

The --run-id flag is required so concurrent runs of the same workflow/agent
cannot cross-claim each other's steps.

Examples:
  tamandua step peek feature-dev-merge_developer --run-id abc12345`;
}

export function getStepClaimHelp(): string {
  return `tamandua step claim — Atomically claim a pending step

Usage: tamandua step claim <agent-id> --run-id <run-id>

step claim claims the next pending step for the given agent within a run.
The claim is atomic — if two agents claim simultaneously, only one will
receive the step.

Output (JSON):
  On success: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}
  No pending steps: NO_WORK

The --run-id flag is required so concurrent runs of the same workflow/agent
cannot cross-claim each other's steps.

Examples:
  tamandua step claim feature-dev-merge_developer --run-id abc12345`;
}

export function getStepCompleteHelp(): string {
  return `tamandua step complete — Mark a step as done

Usage: tamandua step complete <step-id>
   or: echo "STATUS: done
  CHANGES: what changed
  TESTS: what was tested" | tamandua step complete <step-id>

step complete marks a claimed step as completed. It reads the agent's output
from either stdin or positional arguments.

Expected input format (newline-delimited key:value blocks):
  STATUS: done
  CHANGES: <what was implemented>
  TESTS: <what tests were run>
  REPO: <repo path>          (optional)
  BRANCH: <branch name>      (optional)
  COMMITS: <commit list>     (optional)

When using positional arguments, the entire output is passed as a single
string. When using stdin, the output is read until EOF.

Examples:
  tamandua step complete 123e4567-e89b-12d3-a456-426614174000
  echo "STATUS: done\nCHANGES: Added feature X\nTESTS: Wrote unit tests" | \\
    tamandua step complete 123e4567-e89b-12d3-a456-426614174000`;
}

export function getStepFailHelp(): string {
  return `tamandua step fail — Mark a step as failed

Usage: tamandua step fail <step-id> [<error message>]

step fail marks a step as failed with a reason. When a step fails, Tamandua
automatically triggers retry logic — the step is reset to pending and will
be re-claimed by the agent on the next polling cycle. The error message
is logged for diagnostics.

If no error message is provided, "Unknown error" is used.

Retry behavior: Steps that exceed the maximum retry count (configured in
the workflow spec) permanently fail the run.

Examples:
  tamandua step fail 123e4567-e89b-12d3-a456-426614174000
  tamandua step fail 123e4567-e89b-12d3-a456-426614174000 "Network timeout"`;
}

export function getStepStoriesHelp(): string {
  return `tamandua step stories — List all stories and their status for a run

Usage: tamandua step stories <run-id>

step stories displays every story in the current story plan for a run,
showing their status (pending, running, done, failed), title, and any
retry counts.

Output format:
  US-001   [done   ] Story title here
  US-002   [running] Another story
  US-003   [pending] Upcoming story (retry 1)

Examples:
  tamandua step stories abc12345`;
}

/** Resolve --run-id from remainder args (args after action + target, i.e. args[3:]). */
function resolveRunIdArg(remainder: string[]): string | undefined {
  for (let i = 0; i < remainder.length; i++) {
    const tok = remainder[i];
    if (tok === "--run-id") return remainder[i + 1]?.trim();
    const inline = "--run-id=";
    if (tok.startsWith(inline)) return tok.slice(inline.length).trim();
  }
  return undefined;
}

/**
 * Handle step command group (peek, claim, complete, fail, stories).
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleStep(group: string, args: string[]): Promise<boolean> {
  if (group !== "step") return false;

  const action = args[1];
  const target = args[2];

  if (action === "peek" || action === "claim") {
    if (!target) {
      process.stderr.write(`Missing agent-id.\nUsage: tamandua step ${action} <agent-id> --run-id <run-id>\n`);
      process.exit(1);
    }
    const runIdArg = resolveRunIdArg(args.slice(3));
    if (!runIdArg) {
      process.stderr.write(
        `Missing --run-id for step ${action}.\nUsage: tamandua step ${action} <agent-id> --run-id <run-id>\n`,
      );
      process.exit(1);
    }
    if (action === "peek") {
      console.log(peekStep(target, runIdArg));
      return true;
    }
    const jobId = process.env.TAMANDUA_WORKER_JOB_ID;
    const pidStr = process.env.TAMANDUA_WORKER_PID;
    const pgidStr = process.env.TAMANDUA_WORKER_PGID;
    const pgid = pgidStr ? Number(pgidStr) : getOwnProcessGroupId();
    const workerOwnership = (jobId && pidStr)
      ? { jobId, pid: Number(pidStr), ...(pgid ? { pgid } : {}) }
      : undefined;
    let r: ReturnType<typeof claimStep>;
    try {
      r = claimStep(target, runIdArg, workerOwnership);
    } catch (err) {
      process.stderr.write(`Claim failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
    console.log(r.found ? JSON.stringify({ stepId: r.stepId, runId: r.runId, input: r.resolvedInput }) : "NO_WORK");
    return true;
  }

  if (action === "complete") {
    if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); }
    let output = args.slice(3).join(" ").trim();
    if (!output) {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c);
      output = Buffer.concat(chunks).toString("utf-8").trim();
    }
    console.log(JSON.stringify(completeStep(target, output)));
    return true;
  }

  if (action === "fail") {
    if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); }
    console.log(JSON.stringify(await failStep(target, args.slice(3).join(" ").trim() || "Unknown error")));
    return true;
  }

  if (action === "stories") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const fullRunId = getWorkflowStatus(target).id;
    const stories = getStories(fullRunId);
    if (stories.length === 0) { console.log("No stories found."); return true; }
    for (const s of stories) console.log(`${s.storyId.padEnd(8)} [${s.status.padEnd(7)}] ${s.title}${s.retryCount > 0 ? ` (retry ${s.retryCount})` : ""}`);
    return true;
  }

  process.stderr.write(`Unknown step action: ${action}\n`);
  process.exit(1);
}
