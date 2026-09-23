import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveWorkdirCollisionPolicy,
  type WorkdirCollisionPolicy,
} from "../installer/workdir-collision.js";
import {
  MATCHLOCK_ALLOW_PRIVATE_ENV,
  assertAllowPrivateEntries,
  parseAllowPrivateEnv,
} from "../installer/matchlock/allow-private.js";

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
  /**
   * MTLK-PI US-001 / MTLK-HERMES-EXEC US-003 / MTLK-DSH-EXEC US-002: the
   * explicitly requested Matchlock image (--matchlock IMAGE /
   * --matchlock=IMAGE). Present only when the operator opted in; absent means
   * the run uses the native path and performs zero Matchlock actions. With
   * --matchlock the run executes the pi (default), hermes
   * (--hermes-as-harness) or dsh (--dsh-as-harness) harness inside a fresh VM;
   * all three harness selections are admitted.
   */
  matchlockImage?: string;
  /**
   * MTLK-VM-SIZE US-002: raw (unvalidated) VM size overrides for an opted-in
   * Matchlock run. Kept as raw strings here on purpose — the resolver
   * (`src/installer/matchlock/resource-limits.ts`) owns parsing, host-derived
   * defaults and clamping at launch time. Present only when the flag was
   * supplied; each of the three requires --matchlock <image>.
   */
  matchlockCpus?: string;
  matchlockMemory?: string;
  matchlockDisk?: string;
  /**
   * MTLK-ALLOW-PRIVATE US-004: the launch-resolved per-run exception list of
   * private destinations the Matchlock VM may reach (repeatable
   * `--matchlock-allow-private <entry>`, falling back to the comma-separated
   * `TAMANDUA_MATCHLOCK_ALLOW_PRIVATE` env default when the flag is absent).
   * Entries are shape-validated and deduped here; DNS resolution stays
   * matchlock's job. Present only for an opted-in Matchlock run with a
   * non-empty effective list — a native run never carries one, and the env
   * default is ignored without --matchlock.
   */
  matchlockAllowPrivate?: string[];
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
  "--matchlock",
  "--matchlock-cpus",
  "--matchlock-memory",
  "--matchlock-disk",
  "--matchlock-allow-private",
]);

// MTLK-ALLOW-PRIVATE US-004: the repeatable allow-private flag. Its entry
// grammar lives in the shared validator module (allow-private.ts).
const MATCHLOCK_ALLOW_PRIVATE_FLAG = "--matchlock-allow-private";

// MTLK-VM-SIZE US-002: the three raw VM-size overrides and the
// WorkflowRunArgs field each populates. The without---matchlock error names
// the FIRST supplied --matchlock-dependent flag, tracked while parsing.
const MATCHLOCK_SIZE_FLAG_TO_FIELD: Record<
  string,
  "matchlockCpus" | "matchlockMemory" | "matchlockDisk"
> = {
  "--matchlock-cpus": "matchlockCpus",
  "--matchlock-memory": "matchlockMemory",
  "--matchlock-disk": "matchlockDisk",
};

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
  let matchlockImage: string | undefined;
  const matchlockSizeValues: Partial<
    Record<"matchlockCpus" | "matchlockMemory" | "matchlockDisk", string>
  > = {};
  // MTLK-ALLOW-PRIVATE US-004: raw repeatable allow-private entries (validated
  // and deduped after the loop) plus the first --matchlock-dependent flag
  // supplied, so a missing --matchlock names the flag the operator wrote first.
  const matchlockAllowPrivateEntries: string[] = [];
  let matchlockAllowPrivateSupplied = false;
  let firstMatchlockDependentFlag: string | undefined;
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

    if (token === "--matchlock") {
      // Image value is mandatory and must NEVER consume a following option:
      // a missing value, an empty value, a duplicate occurrence, or a value
      // that is actually another recognized --flag all fail clearly.
      if (matchlockImage !== undefined) {
        throw new Error(
          "Duplicate --matchlock. Specify the Matchlock image at most once.",
        );
      }
      const value = args[i + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error(
          "Missing value for --matchlock. Use --matchlock <image>.",
        );
      }
      // A value that is actually another recognized --flag must not be
      // consumed as the image (e.g. `--matchlock --pi-as-harness`).
      if (value.startsWith("--") && KNOWN_FLAGS.has(value.split("=")[0])) {
        throw new Error(
          `Missing value for --matchlock. The next token "${value}" is an option, not an image.`,
        );
      }
      matchlockImage = value;
      i++;
      continue;
    }

    const inlineMatchlockPrefix = "--matchlock=";
    if (token.startsWith(inlineMatchlockPrefix)) {
      if (matchlockImage !== undefined) {
        throw new Error(
          "Duplicate --matchlock. Specify the Matchlock image at most once.",
        );
      }
      const value = token.slice(inlineMatchlockPrefix.length).trim();
      if (value === "") {
        throw new Error(
          "Missing value for --matchlock (--matchlock= must be followed by an image).",
        );
      }
      matchlockImage = value;
      continue;
    }

    // MTLK-VM-SIZE US-002: raw `--matchlock-*` size overrides. The parser
    // stores them verbatim (the launch-time resolver validates); it only
    // enforces syntax-independent rules: at most once, a non-empty value,
    // and a value that is not itself a recognized option.
    const matchlockSizeField = MATCHLOCK_SIZE_FLAG_TO_FIELD[token];
    if (matchlockSizeField !== undefined) {
      if (matchlockSizeValues[matchlockSizeField] !== undefined) {
        throw new Error(
          `Duplicate ${token}. Specify ${token} at most once.`,
        );
      }
      const value = args[i + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error(`Missing value for ${token}. Use ${token} <value>.`);
      }
      // A value that is actually another recognized --flag must never be
      // consumed (e.g. `--matchlock-cpus --wait`).
      if (value.startsWith("--") && KNOWN_FLAGS.has(value.split("=")[0])) {
        throw new Error(
          `Missing value for ${token}. The next token "${value}" is an option, not a value.`,
        );
      }
      matchlockSizeValues[matchlockSizeField] = value.trim();
      if (firstMatchlockDependentFlag === undefined) firstMatchlockDependentFlag = token;
      i++;
      continue;
    }

    const inlineMatchlockSizeFlag = Object.keys(MATCHLOCK_SIZE_FLAG_TO_FIELD).find(
      (flag) => token.startsWith(`${flag}=`),
    );
    if (inlineMatchlockSizeFlag !== undefined) {
      const field = MATCHLOCK_SIZE_FLAG_TO_FIELD[inlineMatchlockSizeFlag];
      if (matchlockSizeValues[field] !== undefined) {
        throw new Error(
          `Duplicate ${inlineMatchlockSizeFlag}. Specify ${inlineMatchlockSizeFlag} at most once.`,
        );
      }
      const value = token.slice(inlineMatchlockSizeFlag.length + 1).trim();
      if (value === "") {
        throw new Error(
          `Missing value for ${inlineMatchlockSizeFlag} (${inlineMatchlockSizeFlag}= must be followed by a value).`,
        );
      }
      if (value.startsWith("--") && KNOWN_FLAGS.has(value.split("=")[0])) {
        throw new Error(
          `Missing value for ${inlineMatchlockSizeFlag}. The value "${value}" is an option, not a value.`,
        );
      }
      matchlockSizeValues[field] = value;
      if (firstMatchlockDependentFlag === undefined) {
        firstMatchlockDependentFlag = inlineMatchlockSizeFlag;
      }
      continue;
    }

    // MTLK-ALLOW-PRIVATE US-004: repeatable `--matchlock-allow-private <entry>`
    // (space and `--matchlock-allow-private=<entry>` forms). Entries are stored
    // raw here and validated/normalized once after the loop so a malformed
    // entry exits non-zero before run creation. Reusing the size-flag error
    // style keeps missing-value / next-token-is-an-option behaviour uniform.
    if (token === MATCHLOCK_ALLOW_PRIVATE_FLAG) {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error(
          `Missing value for ${MATCHLOCK_ALLOW_PRIVATE_FLAG}. Use ${MATCHLOCK_ALLOW_PRIVATE_FLAG} <entry>.`,
        );
      }
      if (value.startsWith("--") && KNOWN_FLAGS.has(value.split("=")[0])) {
        throw new Error(
          `Missing value for ${MATCHLOCK_ALLOW_PRIVATE_FLAG}. The next token "${value}" is an option, not an entry.`,
        );
      }
      matchlockAllowPrivateEntries.push(value);
      matchlockAllowPrivateSupplied = true;
      if (firstMatchlockDependentFlag === undefined) {
        firstMatchlockDependentFlag = MATCHLOCK_ALLOW_PRIVATE_FLAG;
      }
      i++;
      continue;
    }

    const inlineAllowPrivatePrefix = `${MATCHLOCK_ALLOW_PRIVATE_FLAG}=`;
    if (token.startsWith(inlineAllowPrivatePrefix)) {
      const value = token.slice(inlineAllowPrivatePrefix.length).trim();
      if (value === "") {
        throw new Error(
          `Missing value for ${MATCHLOCK_ALLOW_PRIVATE_FLAG} (${MATCHLOCK_ALLOW_PRIVATE_FLAG}= must be followed by an entry).`,
        );
      }
      if (value.startsWith("--") && KNOWN_FLAGS.has(value.split("=")[0])) {
        throw new Error(
          `Missing value for ${MATCHLOCK_ALLOW_PRIVATE_FLAG}. The value "${value}" is an option, not an entry.`,
        );
      }
      matchlockAllowPrivateEntries.push(value);
      matchlockAllowPrivateSupplied = true;
      if (firstMatchlockDependentFlag === undefined) {
        firstMatchlockDependentFlag = MATCHLOCK_ALLOW_PRIVATE_FLAG;
      }
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

  // MTLK-INTEGRATE union (MTLK-PI-EXEC + MTLK-HERMES-EXEC + MTLK-DSH-EXEC):
  // --matchlock is admitted with ALL THREE harness selections. Earlier slices
  // refused --dsh-as-harness (pi/hermes union) or --hermes-as-harness
  // (pi/dsh union) here; the three-harness union supersedes both, so the
  // paired refusal is intentionally dropped. Unknown/invalid harness values
  // are still rejected by the flag parser above, so no silent degradation to
  // a host fallback is possible.

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

  // MTLK-VM-SIZE US-002 / MTLK-ALLOW-PRIVATE US-004: the size overrides and
  // the allow-private list only make sense for an opted-in Matchlock run, so
  // any of them without --matchlock is a usage error naming the first supplied
  // flag (`--matchlock-allow-private` is repeatable, so its first occurrence
  // is the one named).
  if (matchlockImage === undefined && firstMatchlockDependentFlag !== undefined) {
    throw new Error(`${firstMatchlockDependentFlag} requires --matchlock <image>.`);
  }

  // MTLK-ALLOW-PRIVATE US-004 precedence: explicit repeated flags win, and the
  // comma-separated env default is consulted only when the flag is absent (and
  // only for a Matchlock run — a native run ignores it entirely). The shape
  // validator is authoritative and runs at launch so an invalid flag or env
  // entry exits non-zero before run creation. A flag-supplied list is
  // normalized/deduped; the field stays absent when the effective list is
  // empty.
  let matchlockAllowPrivate: string[] | undefined;
  if (matchlockAllowPrivateSupplied) {
    matchlockAllowPrivate = assertAllowPrivateEntries(
      matchlockAllowPrivateEntries,
      MATCHLOCK_ALLOW_PRIVATE_FLAG,
    );
  } else if (matchlockImage !== undefined) {
    const envEntries = parseAllowPrivateEnv(process.env[MATCHLOCK_ALLOW_PRIVATE_ENV]);
    if (envEntries.length > 0) {
      matchlockAllowPrivate = assertAllowPrivateEntries(envEntries, MATCHLOCK_ALLOW_PRIVATE_ENV);
    }
  }

  return {
    taskTitle,
    workingDirectoryForHarness,
    worktreeOriginRepository,
    worktreeOriginRef,
    noHurrySaveTokensMode,
    noRelaunchUponRugpull,
    harnessAs,
    workdirCollisionPolicy,
    matchlockImage,
    matchlockCpus: matchlockSizeValues.matchlockCpus,
    matchlockMemory: matchlockSizeValues.matchlockMemory,
    matchlockDisk: matchlockSizeValues.matchlockDisk,
    matchlockAllowPrivate,
    context,
    wait,
    timeout,
    jsonFlag,
  };
}
