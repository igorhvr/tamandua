/**
 * MTLK-INTERACTIVE (US-013, PROVISIONAL GAP GAP-09) — session orchestration and
 * pre-launch UX.
 *
 * This module is the composition seam between the CLI group
 * (`src/cli/commands/matchlock.ts`), the shared admission planner (US-004), the
 * shared interactive create-config builder (US-005), the pure in-guest
 * preparation planner (US-006) and the foreground session controller (US-010 /
 * US-011). It builds exactly ONE runtime per invocation:
 *
 *   1. `planInteractiveSession` captures identity + config and applies the
 *      shared root gate FIRST, then admits through the shipped v3 admission;
 *   2. the shared `buildInteractiveSessionCreateConfig` derives the exact mount
 *      scope (including the caller's numeric owner ids) so the pre-launch
 *      summary can report it and so the guest-prep planner knows which guest
 *      destinations are host-backed;
 *   3. the VM-wide launch environment is built by the SHARED
 *      `buildInteractiveGuestLaunchEnv` helper (HOME, admitted config override,
 *      image PATH, terminal settings) — known before the guest exists;
 *   4. after the controller creates the VM, the effective guest-prep plan is
 *      produced from OBSERVED guest facts (a bounded `exec_stream` probe over
 *      the owned backend), so a zsh-less or otherwise unusable image refuses
 *      explicitly with no shell substitution and no installation;
 *   5. the pre-launch summary (resources, image provenance, pinned digests,
 *      guest uid/gid and resolved mount scope) is printed BEFORE the TUI/shell
 *      starts; shell variants also name the harness command to run inside;
 *   6. the launched process exit status is returned as the CLI exit status, and
 *      an unconfirmed VM close is a non-success naming the VM.
 *
 * Synthetic scope only: the probe targets the controller's owned backend, never
 * a real VM in tests. Real-VM PTY qualification stays deferred (GAP-11).
 */

import path from "node:path";

import { MATCHLOCK_RPC_BIN_ENV, MatchlockAdmissionError } from "./admission.js";
import { resolveMatchlockRpcBinary } from "./allow-private-support.js";
import {
  buildInteractiveGuestLaunchEnv,
  defaultInteractiveGuestHome,
  InteractiveGuestPrepError,
  INTERACTIVE_GUEST_GROUP_NAME,
  INTERACTIVE_GUEST_USER_NAME,
  planInteractiveGuestPrep,
  type InteractiveGuestFacts,
  type InteractiveGuestPrepPlan,
  type PlanInteractiveGuestPrepInput,
} from "./interactive-guest-prep.js";
import {
  InteractiveSessionController,
  InteractiveSessionError,
  interactiveSessionSucceeded,
  type InteractiveSessionOptions,
  type InteractiveSessionOutcome,
  type InteractiveSessionVmBackend,
} from "./interactive-session.js";
import {
  INTERACTIVE_SESSION_RPC_BINDING_MISMATCH_CODE,
  InteractiveSessionPlanError,
  planInteractiveSession,
  type InteractiveSessionPlan,
  type PlanInteractiveSessionOptions,
} from "./interactive-session-plan.js";
import {
  buildInteractiveSessionCreateConfig,
  MatchlockMountPlanError,
  type MountAdmissionContext,
} from "./mount-plan.js";
import {
  formatMatchlockResourceSummary,
  MatchlockResourceLimitError,
} from "./resource-limits.js";
import { decodeFrameBytes } from "./rpc-client.js";
import type { MatchlockCreateParams } from "./types.js";
import type { InteractiveSessionArgs } from "../../cli/matchlock-interactive-args.js";

// ── observed guest facts probe ───────────────────────────────────────

/** Result of one bounded probe command inside the disposable guest. */
export interface InteractiveGuestProbeCommandResult {
  exitCode: number;
  stdout: string;
}

/** Injectable command runner for the guest-facts probe (tests). */
export type InteractiveGuestProbeRunner = (
  backend: InteractiveSessionVmBackend,
  command: string,
  timeoutMs: number | undefined,
) => Promise<InteractiveGuestProbeCommandResult>;

/** Injectable inputs for {@link probeInteractiveGuestFacts}. */
export interface ProbeInteractiveGuestFactsOptions {
  /** The image's effective guest PATH (report only; from the admitted policy). */
  imagePath?: string | null;
  /** Terminal type to forward. */
  term?: string | null;
  /** Terminal color hint to forward. */
  colorTerm?: string | null;
  /** Bounded probe deadline (ms). */
  timeoutMs?: number;
  /** Injectable probe runner (tests). Defaults to `exec_stream`. */
  runCommand?: InteractiveGuestProbeRunner;
}

/** Injectable probe seam (tests inject deterministic facts). */
export type InteractiveGuestFactsProbe = (
  backend: InteractiveSessionVmBackend,
  input: PlanInteractiveGuestPrepInput,
) => Promise<InteractiveGuestFacts>;

/** POSIX single-quote a value for a `sh -c` script. */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** Every candidate guest directory (targets + ancestors) to probe for existence. */
function guestProbeDirectories(input: PlanInteractiveGuestPrepInput): string[] {
  const uid = input.identity.uid;
  const targets = [
    input.guestHome ?? defaultInteractiveGuestHome(uid),
    input.guestWorkingDirectory,
    input.guestConfigurationRoot,
  ];
  const dirs = new Set<string>();
  for (const target of targets) {
    let current = path.posix.normalize(target);
    dirs.add(current);
    while (current !== "/" && current !== "." && current !== "") {
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      current = parent;
      dirs.add(current);
    }
  }
  return [...dirs].sort();
}

/**
 * Whether a file's POSIX mode grants execute permission to the selected
 * numeric identity. `meta` is `stat -c '%a %u %g'` output. Unknown/unparseable
 * metadata fails CLOSED (the harness is not confirmed runnable).
 */
function executableForSelectedUser(meta: string, uid: number, gid: number): boolean {
  const parts = meta.trim().split(/\s+/);
  if (parts.length < 3) return false;
  const bits = Number.parseInt(parts[0], 8);
  const fileUid = Number.parseInt(parts[1], 10);
  const fileGid = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(bits) || !Number.isFinite(fileUid) || !Number.isFinite(fileGid)) {
    return false;
  }
  if (uid === 0) return (bits & 0o111) !== 0;
  if (fileUid === uid) return (bits & 0o100) !== 0;
  if (fileGid === gid) return (bits & 0o010) !== 0;
  return (bits & 0o001) !== 0;
}

/** Default probe runner: stream one shell command over `exec_stream`. */
const defaultProbeRunner: InteractiveGuestProbeRunner = async (
  backend,
  command,
  timeoutMs,
) => {
  const chunks: Buffer[] = [];
  const result = await backend.execStream(
    { command },
    (frame) => {
      if (frame.kind === "stdout") chunks.push(decodeFrameBytes(frame));
    },
    timeoutMs,
  );
  return { exitCode: result.exit_code, stdout: Buffer.concat(chunks).toString("utf8") };
};

/**
 * Observe the disposable guest for the facts the pure preparation planner needs:
 * existing passwd/group numeric entries, existing guest directories and the
 * image harness/`zsh` binary runnable by the selected identity. One bounded
 * `exec_stream` round trip; no host state is consulted. Nothing is installed.
 */
export async function probeInteractiveGuestFacts(
  backend: InteractiveSessionVmBackend,
  input: PlanInteractiveGuestPrepInput,
  options: ProbeInteractiveGuestFactsOptions = {},
): Promise<InteractiveGuestFacts> {
  const uid = input.identity.uid;
  const gid = input.identity.gid;
  const binaryName = input.shell ? "zsh" : input.harness;
  const dirs = guestProbeDirectories(input);
  const script = [
    `if grep -q "^[^:]*:[^:]*:${uid}:" /etc/passwd 2>/dev/null; then echo passwd=1; else echo passwd=0; fi`,
    `if grep -q "^[^:]*:[^:]*:${gid}:" /etc/group 2>/dev/null; then echo group=1; else echo group=0; fi`,
    `for d in ${dirs.map(shellQuote).join(" ")}; do [ -d "$d" ] && printf 'dir=%s\\n' "$d"; done`,
    `bin=$(command -v ${shellQuote(binaryName)} 2>/dev/null || true)`,
    `if [ -n "$bin" ]; then meta=$(stat -c '%a %u %g' "$bin" 2>/dev/null || true); printf 'bin=%s|%s\\n' "$bin" "$meta"; fi`,
  ].join("; ");
  const command = `sh -c ${shellQuote(script)}`;

  const runner = options.runCommand ?? defaultProbeRunner;
  const { stdout } = await runner(backend, command, options.timeoutMs);

  const passwdPresent = /^passwd=1\r?$/m.test(stdout);
  const groupPresent = /^group=1\r?$/m.test(stdout);
  const existingDirs: string[] = [];
  for (const match of stdout.matchAll(/^dir=(.+?)\r?$/gm)) {
    if (match[1]) existingDirs.push(match[1]);
  }
  const binaryMatch = /^bin=([^|\r\n]+)\|([^\r\n]*)\r?$/m.exec(stdout);
  const binary = binaryMatch
    ? {
        path: binaryMatch[1],
        runnableAsUser: executableForSelectedUser(binaryMatch[2], uid, gid),
      }
    : null;

  return {
    passwdUids: passwdPresent ? [uid] : [],
    groupGids: groupPresent ? [gid] : [],
    existingDirs,
    imagePath: options.imagePath ?? null,
    term: options.term ?? null,
    colorTerm: options.colorTerm ?? null,
    binary,
  };
}

// ── pre-create runtime ───────────────────────────────────────────────

/** The assembled runtime for one interactive session. */
export interface InteractiveSessionRuntime {
  plan: InteractiveSessionPlan;
  /** The fully derived interactive create params (mount scope). */
  createConfig: MatchlockCreateParams;
  /** Guest destinations backed by host mounts. */
  hostMountDestinations: string[];
  /** Planner inputs (without facts) used to re-plan after the probe. */
  prepInput: PlanInteractiveGuestPrepInput;
  /**
   * The VM-wide create environment/identity prepared BEFORE the guest exists.
   * Its `commands` are intentionally empty: the effective plan is produced by
   * {@link resolveGuestPrep} from observed facts.
   */
  basePrep: InteractiveGuestPrepPlan;
  /** Observe the guest, then produce the effective preparation plan. */
  resolveGuestPrep: (backend: InteractiveSessionVmBackend) => Promise<InteractiveGuestPrepPlan>;
}

/** Injectable inputs for {@link buildInteractiveSessionRuntime}. */
export interface BuildInteractiveSessionRuntimeOptions {
  /** Create-config builder override (tests). */
  createConfig?: typeof buildInteractiveSessionCreateConfig;
  /** Mount-plan admission context (tests pin home/live-state). */
  admission?: MountAdmissionContext;
  /** Environment snapshot for terminal settings (tests). */
  env?: NodeJS.ProcessEnv;
  /** Guest-facts probe override (tests). */
  probeGuestFacts?: InteractiveGuestFactsProbe;
  /** Bounded probe deadline (ms). */
  probeTimeoutMs?: number;
  /** Preparation planner override (tests). */
  planGuestPrep?: typeof planInteractiveGuestPrep;
}

/**
 * Build the pre-create runtime for one admitted interactive session: derive the
 * create params/mount scope, the shared VM-wide launch env and the injectable
 * post-create guest-facts resolver. Throws the typed mount-plan refusals
 * (bad/broad/missing config, destination collision, dsh) unchanged.
 */
export function buildInteractiveSessionRuntime(
  plan: InteractiveSessionPlan,
  options: BuildInteractiveSessionRuntimeOptions = {},
): InteractiveSessionRuntime {
  const env = options.env ?? process.env;
  const uid = plan.identity.uid;
  const gid = plan.identity.gid;

  const buildCreateConfig = options.createConfig ?? buildInteractiveSessionCreateConfig;
  const createConfig = buildCreateConfig(plan.policy, plan.pinnedIdentity, {
    ownerUid: uid,
    ownerGid: gid,
    ...(options.admission !== undefined ? { admission: options.admission } : {}),
  });
  const hostMountDestinations = Object.keys(createConfig.vfs?.mounts ?? {});

  const guestHome = defaultInteractiveGuestHome(uid);
  // MTLK-INTERACTIVE D5: the interactive session mounts the selected
  // configuration at its IDENTICAL absolute host path, so the prep planner,
  // the pre-launch summary and the create env all agree on
  // `policy.configurationRoot` (never the workflow relocation).
  const guestConfigurationRoot = plan.policy.configurationRoot;
  const prepInput: PlanInteractiveGuestPrepInput = {
    harness: plan.harness,
    shell: plan.shell,
    identity: { uid, gid, hostHomeDir: plan.identity.homeDir },
    guestWorkingDirectory: plan.workingDirectory,
    guestConfigurationRoot,
    hostConfigurationRoot: plan.policy.configurationRoot,
    guestHome,
    hostMountDestinations,
  };

  const baseEnv = buildInteractiveGuestLaunchEnv({
    harness: plan.harness,
    guestHome,
    guestConfigurationRoot,
    hostHomeDir: plan.identity.homeDir,
    hostMountDestinations,
    imagePath: plan.policy.imagePath ?? null,
    term: env.TERM ?? null,
    colorTerm: env.COLORTERM ?? null,
  });
  const basePrep: InteractiveGuestPrepPlan = {
    harness: plan.harness,
    shell: plan.shell,
    uid,
    gid,
    user: INTERACTIVE_GUEST_USER_NAME,
    group: INTERACTIVE_GUEST_GROUP_NAME,
    guestHome,
    guestConfigurationRoot,
    guestWorkingDirectory: plan.workingDirectory,
    commands: [],
    env: baseEnv,
  };

  const planGuestPrep = options.planGuestPrep ?? planInteractiveGuestPrep;
  const probe: InteractiveGuestFactsProbe =
    options.probeGuestFacts ??
    ((backend, input) =>
      probeInteractiveGuestFacts(backend, input, {
        imagePath: plan.policy.imagePath ?? null,
        term: env.TERM ?? null,
        colorTerm: env.COLORTERM ?? null,
        ...(options.probeTimeoutMs !== undefined ? { timeoutMs: options.probeTimeoutMs } : {}),
      }));

  const resolveGuestPrep = async (
    backend: InteractiveSessionVmBackend,
  ): Promise<InteractiveGuestPrepPlan> => {
    const facts = await probe(backend, prepInput);
    return planGuestPrep({ ...prepInput, facts });
  };

  return {
    plan,
    createConfig,
    hostMountDestinations,
    prepInput,
    basePrep,
    resolveGuestPrep,
  };
}

// ── pre-launch summary ───────────────────────────────────────────────

/**
 * Render the pre-launch summary printed before entering the TUI or shell:
 * the shared resource summary (with the ` (standard image)` provenance
 * suffix, 5ui), image provenance + pinned digests, guest uid/gid, the
 * guest-sudo line (ICEBOX Pillar B) and the resolved mount scope; shell
 * variants also name the harness command to run inside.
 */
export function formatInteractiveSessionPrelaunch(runtime: InteractiveSessionRuntime): string {
  const { plan, createConfig } = runtime;
  const lines: string[] = [];
  lines.push(`matchlock: interactive ${plan.harness}${plan.shell ? "-shell" : ""} session`);
  // ICEBOX 5ui (design v6 §6): the interactive summary line carries the SAME
  // ` (standard image)` provenance suffix the workflow path prints — driven
  // by the RECORDED provenance (plan.imageSource), never inferred from the
  // image name itself.
  lines.push(
    formatMatchlockResourceSummary(
      plan.image,
      { ...plan.resourceLimits, imageSource: plan.imageSource },
      plan.allowPrivate,
    ),
  );
  lines.push(`image provenance: ${plan.imageSource}`);
  lines.push(
    `image identity: tag=${plan.pinnedIdentity.tag ?? plan.image} ` +
      `digest=${plan.pinnedIdentity.digest} config=${plan.pinnedIdentity.config_digest}`,
  );
  lines.push(`guest identity: uid=${plan.identity.uid} gid=${plan.identity.gid}`);
  // ICEBOX Pillar B: the ADDITIVE guest-sudo line, immediately after the
  // guest identity line. The effective prepared CREATE CONFIGURATION is the
  // authority (not raw flags): the shared composer always emits the resolved
  // boolean, so the banner reports exactly what the VM will be.
  lines.push(
    createConfig.privileged === true
      ? "guest sudo: passwordless for all users (privileged VM)"
      : "guest sudo: blocked (standard VM)",
  );

  const mounts = Object.entries(createConfig.vfs?.mounts ?? {})
    .map(([destination, config]) => ({ destination, readonly: config.readonly === true }))
    .sort((a, b) => a.destination.localeCompare(b.destination));
  lines.push(`mounts (${mounts.length}):`);
  if (mounts.length === 0) lines.push("  (none)");
  for (const mount of mounts) {
    lines.push(`  ${mount.readonly ? "ro" : "rw"} ${mount.destination}`);
  }
  if (plan.shell) {
    lines.push(`run \`${plan.harness}\` inside the shell to start the same session`);
  }
  return `${lines.join("\n")}\n`;
}

// ── orchestration ────────────────────────────────────────────────────

/** The minimal controller surface the orchestrator drives (tests inject a fake). */
export interface InteractiveSessionControllerLike {
  run(): Promise<InteractiveSessionOutcome>;
}

/** Injectable inputs for {@link runInteractiveSession}. */
export interface RunInteractiveSessionOptions {
  /** Admission-plan seam (tests); defaults to `planInteractiveSession`. */
  plan?: (
    args: InteractiveSessionArgs,
    options?: PlanInteractiveSessionOptions,
  ) => Promise<InteractiveSessionPlan>;
  /** Admission-plan options passed to the plan seam. */
  planOptions?: PlanInteractiveSessionOptions;
  /** Runtime builder seam (tests). */
  buildRuntime?: (plan: InteractiveSessionPlan) => InteractiveSessionRuntime;
  /** Controller factory seam (tests). */
  createController?: (
    plan: InteractiveSessionPlan,
    prep: InteractiveGuestPrepPlan,
    options: InteractiveSessionOptions,
  ) => InteractiveSessionControllerLike;
  /** Controller options forwarded to the owned controller. */
  controllerOptions?: InteractiveSessionOptions;
  /** Pre-launch summary sink (default `process.stdout`). */
  stdout?: (text: string) => void;
  /** Diagnostics sink (default `process.stderr`). */
  stderr?: (text: string) => void;
}

/** True for the typed refusal errors the CLI reports as a clean non-zero. */
function isTypedRefusal(error: unknown): error is Error & { code: string } {
  return (
    error instanceof InteractiveSessionPlanError ||
    error instanceof InteractiveGuestPrepError ||
    error instanceof MatchlockMountPlanError ||
    error instanceof MatchlockAdmissionError ||
    error instanceof MatchlockResourceLimitError ||
    error instanceof InteractiveSessionError
  );
}

/** Report a typed refusal on stderr and return a non-zero exit status. */
function reportRefusal(error: unknown, stderr: (text: string) => void): number {
  if (isTypedRefusal(error)) {
    stderr(`Error: ${error.message}\n`);
    return 1;
  }
  throw error;
}

/**
 * MTLK-RPC-BIN-SPLIT (tamandua-dwl): normalize an rpc-binary reference for the
 * admitted-binding comparison with the SAME semantics the launcher's `spawn`
 * applies — a value containing a path separator is resolved relative to the
 * process cwd, a bare name is resolved through PATH (empty entries meaning the
 * cwd). Plain string/path normalization would treat a bare name as
 * cwd-relative and could refuse a bare-name override that names the same
 * executable as the admitted PATH hit (or accept a spelling that launches a
 * different file).
 */
function resolveRpcBinaryForComparison(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return path.resolve(trimmed);
  }
  const resolved = resolveMatchlockRpcBinary({ ...process.env, [MATCHLOCK_RPC_BIN_ENV]: trimmed });
  return resolved.executable ? resolved.path : trimmed;
}

/**
 * Orchestrate ONE interactive `tamandua matchlock ...` invocation end to end:
 * admit, print the pre-launch summary, run the foreground session and return
 * the launched process exit status. Fail-closed refusals are reported on stderr
 * with exit 1; an unconfirmed VM close is a non-success naming the VM. This is
 * the production `runSession` seam of the CLI group.
 */
export async function runInteractiveSession(
  args: InteractiveSessionArgs,
  options: RunInteractiveSessionOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));

  const planFn = options.plan ?? planInteractiveSession;
  let plan: InteractiveSessionPlan;
  try {
    plan = await planFn(args, options.planOptions);
  } catch (error) {
    return reportRefusal(error, stderr);
  }

  let runtime: InteractiveSessionRuntime;
  try {
    runtime = options.buildRuntime
      ? options.buildRuntime(plan)
      : buildInteractiveSessionRuntime(plan, {
          ...(options.planOptions?.admission !== undefined
            ? { admission: options.planOptions.admission }
            : {}),
          ...(options.planOptions?.env !== undefined ? { env: options.planOptions.env } : {}),
        });
  } catch (error) {
    return reportRefusal(error, stderr);
  }

  stdout(formatInteractiveSessionPrelaunch(runtime));
  if (plan.rootUsageWarning !== undefined) {
    stderr(`Warning: ${plan.rootUsageWarning}\n`);
  }

  const createController =
    options.createController ??
    ((planToRun: InteractiveSessionPlan, prep: InteractiveGuestPrepPlan, opts: InteractiveSessionOptions) =>
      new InteractiveSessionController(planToRun, prep, opts));
  // MTLK-RPC-BIN-SPLIT (tamandua-dwl): the session transport must launch the
  // SAME invocation the plan probed and admission bound. The plan's frozen
  // `resolvedRpc` is authoritative; a controller-level override that disagrees
  // is a typed refusal BEFORE any VM side effect — never a silent substitution
  // of an executable the admission never checked.
  const admittedRpc = plan.resolvedRpc;
  if (admittedRpc !== undefined) {
    const overrideBinary = options.controllerOptions?.rpcBinaryPath;
    if (
      overrideBinary !== undefined &&
      resolveRpcBinaryForComparison(overrideBinary) !==
        resolveRpcBinaryForComparison(admittedRpc.binaryPath)
    ) {
      return reportRefusal(
        new InteractiveSessionPlanError(
          INTERACTIVE_SESSION_RPC_BINDING_MISMATCH_CODE,
          `Controller rpc binary override (${overrideBinary}) disagrees with the admitted matchlock invocation ` +
            `(${admittedRpc.binaryPath}); the session must launch the executable admission probed. ` +
            "Remove the override or align it with the admitted binding.",
        ),
        stderr,
      );
    }
    const overrideArgs = options.controllerOptions?.rpcArgs;
    if (overrideArgs !== undefined) {
      // An explicit EMPTY args override mirrors the admission/plan default
      // `["rpc"]` (an explicit empty array never consults the environment);
      // compare it after the same defaulting so it cannot disagree spuriously.
      const normalizedOverrideArgs = overrideArgs.length > 0 ? overrideArgs : ["rpc"];
      if (JSON.stringify(normalizedOverrideArgs) !== JSON.stringify(admittedRpc.args)) {
        return reportRefusal(
          new InteractiveSessionPlanError(
            INTERACTIVE_SESSION_RPC_BINDING_MISMATCH_CODE,
            `Controller rpc args override (${JSON.stringify(overrideArgs)}) disagree with the admitted matchlock ` +
              `invocation args (${JSON.stringify(admittedRpc.args)}); the session must launch the argv admission bound.`,
          ),
          stderr,
        );
      }
    }
  }
  const controller = createController(plan, runtime.basePrep, {
    ...options.controllerOptions,
    ...(admittedRpc !== undefined
      ? { rpcBinaryPath: admittedRpc.binaryPath, rpcArgs: [...admittedRpc.args] }
      : {}),
    resolveGuestPrep: runtime.resolveGuestPrep,
  });

  let outcome: InteractiveSessionOutcome;
  try {
    outcome = await controller.run();
  } catch (error) {
    return reportRefusal(error, stderr);
  }

  if (!outcome.cleanupConfirmed) {
    stderr(
      `Error: ${
        outcome.cleanupError ??
        `Matchlock VM ${outcome.vmId || "(unknown)"} cleanup was not confirmed; ` +
          "killing the RPC child alone is not proof of VM termination."
      }\n`,
    );
    return outcome.exitCode !== null && outcome.exitCode !== 0 ? outcome.exitCode : 1;
  }
  if (!interactiveSessionSucceeded(outcome)) {
    // D1: external termination/disconnect (SIGTERM/SIGHUP/host stream error)
    // yields a CONFIRMED-cleanup but CANCELLED outcome with no guest exit code.
    // That is a non-success at the public boundary, never exit 0.
    const vm = outcome.vmId || "(unknown)";
    stderr(
      `Error: interactive session for Matchlock VM ${vm} was cancelled/terminated before the guest ` +
        `exited${outcome.exitCode === null ? "" : ` (last exit status ${outcome.exitCode})`}; reporting failure.\n`,
    );
    return outcome.exitCode !== null && outcome.exitCode !== 0 ? outcome.exitCode : 1;
  }
  return outcome.exitCode ?? 0;
}
