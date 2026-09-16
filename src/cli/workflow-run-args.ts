import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveWorkdirCollisionPolicy,
  type WorkdirCollisionPolicy,
} from "../installer/workdir-collision.js";

export interface WorkflowRunArgs {
  taskTitle: string;
  workingDirectoryForHarness?: string;
  worktreeOriginRepository?: string;
  worktreeOriginRef?: string;
  noHurrySaveTokensMode?: boolean;
  noRelaunchUponRugpull?: boolean;
  harnessAs?: "pi" | "hermes" | "dsh";
  /**
   * WORKDIR-FLAGS: what to do when the harness working directory is already
   * held by a live direct run. `refuse` (default) rejects the launch;
   * `queue` (`--queue-behind-holder`) waits for the holder to release;
   * `allow` (`--allow-multiple-runs-in-one-working-directory` or
   * `TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1`) runs concurrently.
   */
  workdirCollisionPolicy: WorkdirCollisionPolicy;
  /** Key-value pairs injected as run template context */
  context: Record<string, string>;
  /** Block until the run reaches a terminal status */
  wait: boolean;
  /** Max wait duration (e.g. 30s, 10m, 2h) — only meaningful with --wait */
  timeout?: string;
  /** Output JSON after wait completes — only meaningful with --wait */
  jsonFlag: boolean;
}

const KNOWN_FLAGS = new Set([
  "--no-hurry-please-save-tokens-mode",
  "--no-relaunch-upon-rugpull",
  "--wait",
  "--json",
  "--timeout",
  "--pi-as-harness",
  "--hermes-as-harness",
  "--dsh-as-harness",
  "--working-directory-for-harness",
  "--worktree-origin-repository",
  "--worktree-origin-ref",
  "--context",
  "--task-file",
  "--queue-behind-holder",
  "--allow-multiple-runs-in-one-working-directory",
]);

const HARNESS_FLAG_TO_TYPE: Record<string, "pi" | "hermes" | "dsh"> = {
  "--pi-as-harness": "pi",
  "--hermes-as-harness": "hermes",
  "--dsh-as-harness": "dsh",
};

/**
 * WORKDIR-FLAGS US-005: parse just the two workdir-collision flags out of an
 * arbitrary argv slice and resolve the policy. Shared by `workflow run` (via
 * parseWorkflowRunArgs) and `workflow resume`, so both commands accept exactly
 * the same flags with the same precedence and env fallback: an explicit
 * --queue-behind-holder wins, then an explicit
 * --allow-multiple-runs-in-one-working-directory, then the environment form of
 * allow (TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1); everything else refuses.
 * Specifying both flags is a usage error. Tokens after an end-of-options `--`
 * are never treated as flags.
 */
export function parseWorkdirCollisionPolicyFlags(
  args: string[],
): WorkdirCollisionPolicy {
  const dashDashIdx = args.indexOf("--");
  const flagArgs = dashDashIdx === -1 ? args : args.slice(0, dashDashIdx);
  let queueBehindHolder = false;
  let allowMultipleRunsInOneWorkingDirectory = false;

  for (const token of flagArgs) {
    if (token === "--queue-behind-holder") {
      if (allowMultipleRunsInOneWorkingDirectory) {
        throw new Error(
          `Cannot specify both --allow-multiple-runs-in-one-working-directory and ${token}. Choose one workdir collision policy.`,
        );
      }
      queueBehindHolder = true;
      continue;
    }
    if (token === "--allow-multiple-runs-in-one-working-directory") {
      if (queueBehindHolder) {
        throw new Error(
          `Cannot specify both --queue-behind-holder and ${token}. Choose one workdir collision policy.`,
        );
      }
      allowMultipleRunsInOneWorkingDirectory = true;
    }
  }

  if (queueBehindHolder) return "queue";
  if (allowMultipleRunsInOneWorkingDirectory) return "allow";
  return resolveWorkdirCollisionPolicy({}, process.env);
}

export function parseWorkflowRunArgs(args: string[]): WorkflowRunArgs {
  let taskFileName: string | undefined;
  const taskParts: string[] = [];
  let workingDirectoryForHarness: string | undefined;
  let worktreeOriginRepository: string | undefined;
  let worktreeOriginRef: string | undefined;
  let noHurrySaveTokensMode: boolean | undefined;
  let noRelaunchUponRugpull: boolean | undefined;
  let harnessAs: "pi" | "hermes" | "dsh" | undefined;
  let harnessFlagName: string | undefined;
  let queueBehindHolder = false;
  let allowMultipleRunsInOneWorkingDirectory = false;
  const context: Record<string, string> = {};

  let afterDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    // -- end-of-options separator: everything after goes verbatim to task title
    if (token === "--") {
      afterDashDash = true;
      continue;
    }

    if (afterDashDash) {
      taskParts.push(token);
      continue;
    }

    if (token === "--no-hurry-please-save-tokens-mode") {
      noHurrySaveTokensMode = true;
      continue;
    }

    if (token === "--no-relaunch-upon-rugpull") {
      noRelaunchUponRugpull = true;
      continue;
    }

    if (token === "--queue-behind-holder") {
      if (allowMultipleRunsInOneWorkingDirectory) {
        throw new Error(
          `Cannot specify both --allow-multiple-runs-in-one-working-directory and ${token}. Choose one workdir collision policy.`,
        );
      }
      queueBehindHolder = true;
      continue;
    }

    if (token === "--allow-multiple-runs-in-one-working-directory") {
      if (queueBehindHolder) {
        throw new Error(
          `Cannot specify both --queue-behind-holder and ${token}. Choose one workdir collision policy.`,
        );
      }
      allowMultipleRunsInOneWorkingDirectory = true;
      continue;
    }

    if (token === "--wait") {
      continue;
    }

    if (token === "--json") {
      continue;
    }

    if (token === "--timeout") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --timeout.");
      }
      i++;
      continue;
    }

    if (token.startsWith("--timeout=")) {
      continue;
    }

    if (HARNESS_FLAG_TO_TYPE[token] !== undefined) {
      if (harnessAs !== undefined) {
        throw new Error(
          `Cannot specify both ${harnessFlagName} and ${token}. Choose one harness.`,
        );
      }
      harnessAs = HARNESS_FLAG_TO_TYPE[token];
      harnessFlagName = token;
      continue;
    }

    if (token === "--working-directory-for-harness") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      i++;
      continue;
    }

    const inlinePrefix = "--working-directory-for-harness=";
    if (token.startsWith(inlinePrefix)) {
      const value = token.slice(inlinePrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      continue;
    }

    if (token === "--worktree-origin-repository") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      i++;
      continue;
    }

    const wtRepoPrefix = "--worktree-origin-repository=";
    if (token.startsWith(wtRepoPrefix)) {
      const value = token.slice(wtRepoPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      continue;
    }

    if (token === "--worktree-origin-ref") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      i++;
      continue;
    }

    const wtRefPrefix = "--worktree-origin-ref=";
    if (token.startsWith(wtRefPrefix)) {
      const value = token.slice(wtRefPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      continue;
    }

    if (token === "--task-file") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --task-file.");
      }
      taskFileName = value;
      i++;
      continue;
    }

    const taskFileInlinePrefix = "--task-file=";
    if (token.startsWith(taskFileInlinePrefix)) {
      const value = token.slice(taskFileInlinePrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --task-file.");
      }
      taskFileName = value;
      continue;
    }

    if (token === "--context") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --context. Expected format: --context key=value");
      }
      const eqIdx = value.indexOf("=");
      if (eqIdx === -1) {
        throw new Error(`Invalid --context value "${value}": expected key=value format (must contain '=')`);
      }
      const key = value.slice(0, eqIdx);
      const val = value.slice(eqIdx + 1);
      if (key.length === 0) {
        throw new Error(`Invalid --context value "${value}": key must be non-empty`);
      }
      if (key in context) {
        throw new Error(`Duplicate --context key "${key}": each key may only be specified once`);
      }
      context[key] = val;
      i++;
      continue;
    }

    // Reject unknown --flags: any token starting with -- that isn't a recognized flag
    if (token.startsWith("--")) {
      const flagName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      if (!KNOWN_FLAGS.has(flagName)) {
        throw new Error(
          `Unknown option "${token}" for workflow run. Use -- to pass a task starting with --, or see tamandua workflow run --help.`,
        );
      }
    }

    // Reject unknown short flags: -x where x is a letter (bare - and negative numbers are task text)
    if (
      token.length > 1 &&
      token[0] === "-" &&
      token[1] !== "-" &&
      /^-[a-zA-Z]/.test(token)
    ) {
      throw new Error(
        `Unknown option "${token}" for workflow run. Use -- to pass a task starting with --, or see tamandua workflow run --help.`,
      );
    }

    taskParts.push(token);
  }

  // Mutual exclusion: --task-file and inline task words cannot both be given
  const hasInlineTask = taskParts.length > 0;
  if (taskFileName && hasInlineTask) {
    throw new Error(
      "--task-file is mutually exclusive with inline task text. Provide the task via --task-file OR as positional arguments, not both.",
    );
  }

  // Read task from file if --task-file was given. Dereferenced EXACTLY ONCE at
  // CLI time — the file path never reaches the DB, events, or any downstream
  // consumer. Temp files may be deleted immediately after this command returns
  // with zero effect.
  let taskTitle: string;
  if (taskFileName) {
    const resolvedPath = resolve(process.cwd(), taskFileName);
    try {
      taskTitle = readFileSync(resolvedPath, "utf-8").trim();
    } catch (err) {
      throw new Error(
        `Cannot read --task-file "${taskFileName}": ${(err as NodeJS.ErrnoException).message}`,
      );
    }
  } else {
    taskTitle = taskParts.join(" ").trim();
  }

  // Only consider flags that appear before the -- separator (if any)
  const dashDashIdx = args.indexOf("--");
  const flagArgs = dashDashIdx === -1 ? args : args.slice(0, dashDashIdx);

  const wait = flagArgs.includes("--wait");
  const jsonFlag = flagArgs.includes("--json");
  let timeout: string | undefined;
  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === "--timeout" && i + 1 < flagArgs.length) {
      timeout = flagArgs[i + 1];
      break;
    }
    if (flagArgs[i].startsWith("--timeout=")) {
      timeout = flagArgs[i].slice("--timeout=".length);
      break;
    }
  }

  // WORKDIR-FLAGS: resolve the collision policy for a fresh launch through the
  // shared parser so `workflow resume` accepts exactly the same flags with the
  // same precedence and env fallback. There is no persisted context to consult
  // at CLI-parse time.
  const workdirCollisionPolicy = parseWorkdirCollisionPolicyFlags(flagArgs);

  return {
    taskTitle,
    workingDirectoryForHarness,
    worktreeOriginRepository,
    worktreeOriginRef,
    noHurrySaveTokensMode,
    noRelaunchUponRugpull,
    harnessAs,
    workdirCollisionPolicy,
    context,
    wait,
    timeout,
    jsonFlag,
  };
}
