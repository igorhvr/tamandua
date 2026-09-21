/**
 * SKILL-UX S3 (US-002): resolve the launch-time facts that
 * `tamandua workflow run` prints BEFORE the run row is inserted / the
 * `run #N created` stderr line is emitted.
 *
 * The CLI computes these, prints one stable line per fact, and only then
 * calls runWorkflow (whose first observable output is the synchronous
 * `run #N ... created; preparing workspace...` stderr line). Resolution is
 * deliberately best-effort: a fact that cannot be determined is omitted from
 * the lines (never a launch failure), because runWorkflow owns the
 * authoritative validation errors and exit codes.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getHarnessAdapter } from "./harness-adapter.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { getControlPort } from "../server/control-server.js";
import { isDaemonControlReachable } from "../server/control-client.js";
import { formatMatchlockResourceSummary } from "./matchlock/resource-limits.js";
import type { HarnessType } from "./types.js";

/**
 * MTLK-VM-SIZE US-005: the Matchlock launch facts the resolved-launch block
 * carries for an opted-in `workflow run`. Deliberately the SAME shape as
 * `workflow status --json`'s `matchlockResources`
 * (src/installer/status.ts) so a script can read the admitted VM size the
 * same way from a launch as from a status query.
 */
export interface WorkflowRunLaunchMatchlockResources {
  /** Requested image reference (`--matchlock <image>`). */
  image: string;
  /** Resolved vCPU count. */
  cpus: number;
  /** Resolved guest memory in MB. */
  memoryMB: number;
  /** Resolved guest disk size in MB. */
  diskSizeMB: number;
}

export interface WorkflowRunLaunchInfo {
  workspaceMode: "direct" | "worktree";
  /** direct mode: resolved absolute harness working directory */
  workingDirectory?: string;
  /** worktree mode: resolved absolute origin repository */
  originRepository?: string;
  /** worktree mode: ref used to create the worktree */
  originRef?: string;
  /** worktree mode: resolved commit SHA of originRef */
  originSha?: string;
  /** whether the working tree (direct) / origin repo (worktree) is clean */
  clean: boolean;
  /** harness type as selected (pi/hermes/dsh) */
  harnessType: string;
  /** resolved absolute harness binary path (undefined when not resolvable) */
  harnessBinary?: string;
  /** cheaply-probed harness version (undefined when unavailable) */
  harnessVersion?: string;
  /** control-plane endpoint the run reaches (http://127.0.0.1:<port>) */
  daemonEndpoint: string;
  /** whether /control/health answered ok at probe time */
  daemonOk: boolean;
  /**
   * MTLK-VM-SIZE US-005: resolved Matchlock VM facts, present only for an
   * opted-in `--matchlock <image>` launch. A native run leaves this unset so
   * it prints no matchlock line and its JSON stays byte-identical.
   */
  matchlockResources?: WorkflowRunLaunchMatchlockResources;
}

export interface ResolveWorkflowRunLaunchInfoParams {
  workflowId: string;
  harnessType?: HarnessType;
  workingDirectoryForHarness?: string;
  worktreeOriginRepository?: string;
  worktreeOriginRef?: string;
}

/** Bounded git helper — never throws, mirrors the run.ts capture style. */
function gitIn(
  cwd: string,
  args: string[],
): { stdout: string; status: number } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    status: result.status ?? -1,
  };
}

/**
 * A working tree is "dirty" when `git status --porcelain` reports any change.
 * A non-git directory (or a git probe failure) reports clean — there is no
 * git state to be dirty, and runWorkflow performs the authoritative
 * validation separately.
 */
function isCleanWorkingTree(cwd: string): boolean {
  const result = gitIn(cwd, ["status", "--porcelain"]);
  if (result.status !== 0) return true;
  return result.stdout.length === 0;
}

/** Bounded `<binary> --version` probe; returns a version token or undefined. */
function probeHarnessVersion(binary: string): string | undefined {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2000,
  });
  if (result.error || result.status !== 0) return undefined;
  const text = String((result.stdout ?? "") || (result.stderr ?? "")).trim();
  if (!text) return undefined;
  const firstLine = text.split(/\r?\n/)[0];
  const match = firstLine.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : undefined;
}

/**
 * Resolve the launch facts to print. Returns null when the workflow spec
 * cannot be loaded (e.g. an unknown workflow id) so runWorkflow can produce
 * the authoritative error and exit code unchanged.
 */
export async function resolveWorkflowRunLaunchInfo(
  params: ResolveWorkflowRunLaunchInfoParams,
): Promise<WorkflowRunLaunchInfo | null> {
  let spec;
  try {
    spec = await loadWorkflowSpec(resolveWorkflowDir(params.workflowId));
  } catch {
    return null;
  }

  const workspaceMode = spec.run?.workspace ?? "direct";
  const harnessType: HarnessType = params.harnessType ?? "pi";

  // SKILL-UX S3: the control-port shown here is the env-aware port the
  // control client actually reaches and the daemon actually binds
  // (getControlPort). Once the daemon has written its port file this equals
  // readControlPlanePort(); pre-daemon-start, getControlPort is the value
  // that will be bound, so it is the accurate endpoint to display.
  const info: WorkflowRunLaunchInfo = {
    workspaceMode,
    clean: true,
    harnessType,
    daemonEndpoint: `http://127.0.0.1:${getControlPort()}`,
    daemonOk: await isDaemonControlReachable(500),
  };

  // Harness binary: omit the line rather than failing when unavailable.
  try {
    info.harnessBinary = await getHarnessAdapter(harnessType).findBinary();
  } catch {
    info.harnessBinary = undefined;
  }
  if (info.harnessBinary) {
    info.harnessVersion = probeHarnessVersion(info.harnessBinary);
  }

  if (workspaceMode === "direct") {
    info.workingDirectory = path.resolve(
      params.workingDirectoryForHarness ?? process.cwd(),
    );
    info.clean = isCleanWorkingTree(info.workingDirectory);
  } else {
    const originRepoInput = params.worktreeOriginRepository ?? process.cwd();
    let originRepo: string;
    try {
      originRepo = fs.realpathSync(path.resolve(originRepoInput));
    } catch {
      originRepo = path.resolve(originRepoInput);
    }
    info.originRepository = originRepo;

    // Explicit ref wins; otherwise the origin's current branch.
    let originRef = params.worktreeOriginRef;
    if (!originRef) {
      const branch = gitIn(originRepo, ["branch", "--show-current"]);
      originRef =
        branch.status === 0 && branch.stdout ? branch.stdout : undefined;
    }
    info.originRef = originRef;

    if (originRef) {
      const sha = gitIn(originRepo, ["rev-parse", originRef]);
      info.originSha = sha.status === 0 && sha.stdout ? sha.stdout : undefined;
    }

    info.clean = isCleanWorkingTree(originRepo);
  }

  return info;
}

/**
 * Render the stable one-line launch facts. Order: working-directory/origin
 * first, then harness, then daemon, then (for an opted-in Matchlock run) the
 * resolved VM size — the same order they are printed before the run-created
 * lines.
 */
export function formatWorkflowRunLaunchLines(
  info: WorkflowRunLaunchInfo,
): string[] {
  const lines: string[] = [];

  if (info.workspaceMode === "direct" && info.workingDirectory) {
    lines.push(
      `working-directory: ${info.workingDirectory} ${info.clean ? "clean" : "dirty"}`,
    );
  } else if (info.workspaceMode === "worktree" && info.originRepository) {
    let line = `origin: ${info.originRepository} @ ${info.originRef ?? ""}`;
    if (info.originSha) line += ` (${info.originSha})`;
    line += ` ${info.clean ? "clean" : "dirty"}`;
    lines.push(line);
  }

  if (info.harnessBinary) {
    lines.push(
      `harness: ${info.harnessType} ${info.harnessBinary}` +
        (info.harnessVersion ? ` (${info.harnessVersion})` : ""),
    );
  }

  lines.push(
    `daemon: ${info.daemonEndpoint} ${info.daemonOk ? "ok" : "unreachable"}`,
  );

  // MTLK-VM-SIZE US-005: the opted-in Matchlock VM facts join this same
  // resolved-launch block (same stable-prefix style as the lines above), so
  // the operator sees the admitted image/limits BEFORE the synchronous
  // `run #N ... created` line.
  if (info.matchlockResources) {
    lines.push(
      formatMatchlockResourceSummary(
        info.matchlockResources.image,
        info.matchlockResources,
      ),
    );
  }

  return lines;
}

/**
 * Structured (JSON) form of the same launch facts the text lines carry.
 * Field names stay close to the text prefixes so scripts can correlate them:
 *   working-directory / origin.path / origin.ref / origin.sha / clean /
 *   harness.type / harness.path / harness.version / daemon.endpoint /
 *   daemon.ok / matchlockResources.{image,cpus,memoryMB,diskSizeMB}.
 *
 * US-003: this is emitted whenever `workflow run --json` is requested, so the
 * resolved values are machine-consumable; optional facts (a missing harness
 * binary, an unprobeable version, an absent ref/sha) are omitted, never
 * fabricated.
 */
export interface WorkflowRunLaunchJson {
  workspaceMode: "direct" | "worktree";
  /** direct mode: resolved absolute harness working directory */
  workingDirectory?: string;
  /** worktree mode: resolved origin repository, ref, and resolved sha */
  origin?: {
    path: string;
    ref?: string;
    sha?: string;
  };
  clean: boolean;
  harness: {
    type: string;
    path?: string;
    version?: string;
  };
  daemon: {
    endpoint: string;
    ok: boolean;
  };
  /**
   * MTLK-VM-SIZE US-005: the resolved Matchlock VM facts for an opted-in run.
   * Same shape as `workflow status --json`'s `matchlockResources`; omitted for
   * a native run (whose JSON therefore stays byte-identical).
   */
  matchlockResources?: WorkflowRunLaunchMatchlockResources;
}

export function workflowRunLaunchInfoToJson(
  info: WorkflowRunLaunchInfo,
): WorkflowRunLaunchJson {
  const json: WorkflowRunLaunchJson = {
    workspaceMode: info.workspaceMode,
    clean: info.clean,
    harness: { type: info.harnessType },
    daemon: { endpoint: info.daemonEndpoint, ok: info.daemonOk },
  };

  if (info.harnessBinary) json.harness.path = info.harnessBinary;
  if (info.harnessVersion) json.harness.version = info.harnessVersion;

  // MTLK-VM-SIZE US-005: mirror the matchlock launch line in the same JSON
  // document (inside `resolution`, next to the other launch facts).
  if (info.matchlockResources) {
    json.matchlockResources = { ...info.matchlockResources };
  }

  if (info.workspaceMode === "direct" && info.workingDirectory) {
    json.workingDirectory = info.workingDirectory;
  } else if (info.workspaceMode === "worktree" && info.originRepository) {
    json.origin = { path: info.originRepository };
    if (info.originRef) json.origin.ref = info.originRef;
    if (info.originSha) json.origin.sha = info.originSha;
  }

  return json;
}
