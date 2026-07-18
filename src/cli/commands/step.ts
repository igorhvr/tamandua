/**
 * Worker step protocol commands.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-008).
 */

import { getWorkflowStatus } from "../../installer/status.js";
import {
  buildStoriesJson,
  claimStep,
  completeStep,
  failStep,
  getOwnProcessGroupId,
  getStories,
  peekStep,
  stepCurrent,
} from "../../installer/step-ops.js";

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

Usage: tamandua step stories <run-id> [--json]

step stories displays every story in the current story plan for a run,
showing their status (pending, running, done, failed), title, and any
retry counts.

Options:
  --json    Output a JSON object with runId and stories array for
            machine consumption (camelCase, omits zero/absent fields)

Output format:
  US-001   [done   ] Story title here
  US-002   [running] Another story
  US-003   [pending] Upcoming story (retry 1)

Examples:
  tamandua step stories abc12345
  tamandua step stories abc12345 --json`;
}

export function getStepCurrentHelp(): string {
  return `tamandua step current — Read-only query for a held step

Usage: tamandua step current <agent-id> --run-id <run-id>

step current returns the claim JSON for the step currently held (running)
by the given agent in the run. It is a pure read-only query — no state
mutation, no side effects.

Output:
  JSON: {"stepId":"<UUID>","runId":"<UUID>","input":"<task description>"}
  NONE — when the agent has no in-flight (running) step in this run

Exit 0 either way; exit 1 on bad args (missing agent-id or --run-id).

The --run-id flag is required so concurrent runs of the same workflow/agent
cannot cross-claim each other's steps.

Examples:
  tamandua step current feature-dev-merge_developer --run-id abc12345`;
}

/** Handle step protocol commands. Returns false for unrelated command groups. */
export async function handleStep(group: string, args: string[]): Promise<boolean> {
  if (group !== "step") return false;

  const action = args[1];
  const target = args[2];

  if (action === "peek" || action === "claim") {
    if (!target) {
      process.stderr.write(`Missing agent-id.\nUsage: tamandua step ${action} <agent-id> --run-id <run-id>\n`);
      process.exit(1);
    }
    // --run-id is required for peek/claim so concurrent runs of the same
    // workflow + agent can't cross-claim. No implicit inference — the
    // caller (typically the polling prompt) must pass it.
    let runIdArg: string | undefined;
    const remainder = args.slice(3);
    for (let i = 0; i < remainder.length; i++) {
      const tok = remainder[i];
      if (tok === "--run-id") { runIdArg = remainder[i + 1]?.trim(); i++; continue; }
      const inline = "--run-id=";
      if (tok.startsWith(inline)) { runIdArg = tok.slice(inline.length).trim(); }
    }
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
    // Harness process group: env override, else self-detected — the CLI
    // descends from the detached harness (its group leader), so our own
    // pgid IS the harness group. Lets the dead-worker sweep (C18) tell a
    // surviving harness apart from a fully dead one.
    const pgidStr = process.env.TAMANDUA_WORKER_PGID;
    const pgid = pgidStr ? Number(pgidStr) : getOwnProcessGroupId();
    const workerOwnership = (jobId && pidStr)
      ? { jobId, pid: Number(pidStr), ...(pgid ? { pgid } : {}) }
      : undefined;
    let result: ReturnType<typeof claimStep>;
    try {
      result = claimStep(target, runIdArg, workerOwnership);
    } catch (err) {
      process.stderr.write(`Claim failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
    console.log(result.found
      ? JSON.stringify({ stepId: result.stepId, runId: result.runId, input: result.resolvedInput })
      : "NO_WORK");
    return true;
  }
  if (action === "complete") {
    if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); }
    let output = args.slice(3).join(" ").trim();
    if (!output) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
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
  if (action === "current") {
    if (!target) {
      process.stderr.write(`Missing agent-id.\nUsage: tamandua step current <agent-id> --run-id <run-id>\n`);
      process.exit(1);
    }
    let runIdArg: string | undefined;
    const remainder = args.slice(3);
    for (let i = 0; i < remainder.length; i++) {
      const tok = remainder[i];
      if (tok === "--run-id") { runIdArg = remainder[i + 1]?.trim(); i++; continue; }
      const inline = "--run-id=";
      if (tok.startsWith(inline)) { runIdArg = tok.slice(inline.length).trim(); }
    }
    if (!runIdArg) {
      process.stderr.write(
        `Missing --run-id for step current.\nUsage: tamandua step current <agent-id> --run-id <run-id>\n`,
      );
      process.exit(1);
    }
    const result = stepCurrent(target, runIdArg);
    if (result) {
      console.log(JSON.stringify(result));
    } else {
      console.log("NONE");
    }
    return true;
  }
  if (action === "stories") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const jsonFlag = args.includes("--json");
    const fullRunId = getWorkflowStatus(target).id;
    const stories = getStories(fullRunId);
    if (stories.length === 0) {
      if (jsonFlag) console.log(JSON.stringify({ runId: fullRunId, stories: [] }));
      else console.log("No stories found.");
      return true;
    }
    if (jsonFlag) {
      console.log(JSON.stringify({ runId: fullRunId, stories: buildStoriesJson(stories) }));
      return true;
    }
    for (const story of stories) {
      console.log(`${story.storyId.padEnd(8)} [${story.status.padEnd(7)}] ${story.title}${story.retryCount > 0 ? ` (retry ${story.retryCount})` : ""}`);
    }
    return true;
  }
  process.stderr.write(`Unknown step action: ${action}\n`);
  process.exit(1);
}
