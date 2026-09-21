/**
 * Guest worker CLI (restricted surface).
 *
 * Runs inside the Matchlock VM from the portable RO helper pack at
 * /workspace/runtime/bin/tamandua. It answers version/--version/-v,
 * --help/-h and skill-path LOCALLY from the pack, and forwards the worker
 * step commands (peek/claim/current/complete/fail) to the guest bridge
 * service, which relays them to the scoped host broker. Every other command
 * fails explicitly — there is no admin/DB/update/install/release surface and
 * no fallback to an unrestricted host CLI.
 *
 * Parity targets (native src/cli/commands/step.ts + standalone.ts):
 *   - prefixed-id validation and identical error wording for bad usage
 *   - stdout JSON / NO_WORK / NONE contracts, stderr, exit codes
 *   - --file/--reason-file/STORIES_JSON_FILE dereferenced guest-side, once,
 *     bounded, relative to the guest caller cwd; guest filenames never leave
 *     the VM
 *   - `step complete` reads reports from --file or stdin; positional report
 *     argv is an error
 *   - a submit-time expects rejection returns REJECTED on stderr with exit 1
 *     and retains the claim for correction
 *
 * Node-core only — safe for the guest pack closure.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  ENV_BRIDGE_REQUEST_TIMEOUT_MS,
  ENV_GUEST_SOCKET,
  ENV_GUEST_SOCKET_DIR,
  GUEST_SOCKET_FILENAME,
  MERGE_WIRE_CONFLICTS_MAX_BYTES,
  MERGE_WIRE_DETAIL_MAX_BYTES,
  detectWrongPrefix,
  stripIdPrefix,
  type BridgeResponsePayload,
  type GuestLogsPayload,
  type GuestStoriesPayload,
  type GuestStoryItem,
  type MergeAuthorization,
  type MergeReportRequest,
} from "./guest-protocol.js";
import { guestRequest } from "./guest-socket-client.js";
import { runMergeCore, type MergeCoreGitResult, type MergeCoreResult } from "./merge-core.js";
import {
  REASON_MAX_BYTES,
  REPORT_MAX_BYTES,
  dereferenceStoriesJsonFile,
  readFlagFileBounded,
} from "./guest-files.js";

/** I/O surface injected so the CLI is testable without a real process. */
export interface GuestCliIo {
  cwd: string;
  envGet: (name: string) => string | undefined;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  readStdin: () => Promise<string>;
}

export interface GuestCliResult {
  exitCode: number;
}

export interface GuestCliEnvOverrides {
  socketPath?: string;
  requestTimeoutMs?: number;
}

function stdoutLines(io: GuestCliIo, ...lines: string[]): void {
  for (const line of lines) io.writeOut(`${line}\n`);
}

function stderrLines(io: GuestCliIo, ...lines: string[]): void {
  for (const line of lines) io.writeErr(`${line}\n`);
}

/**
 * Locate the pack root (dir containing manifest.json) by walking up from this
 * module's compiled location. Bounded walk; returns null when not found (the
 * module runs outside a built pack).
 */
export function resolvePackRoot(fromDir?: string): string | null {
  let dir = fromDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const manifestPath = path.join(dir, "manifest.json");
    try {
      fs.accessSync(manifestPath, fs.constants.R_OK);
      return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

interface PackManifest {
  name?: string;
  packLayoutVersion?: number;
  protocolVersion?: number;
  tamanduaBuildVersion?: string;
  helperProtocolVersion?: string;
  [key: string]: unknown;
}

export function readPackManifest(packRoot: string): PackManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(packRoot, "manifest.json"), "utf-8")) as PackManifest;
  } catch {
    return null;
  }
}

/** Native-matching version answer from the pack manifest. */
export function guestVersion(packRoot: string | null): string {
  if (packRoot) {
    const manifest = readPackManifest(packRoot);
    if (manifest?.tamanduaBuildVersion) return manifest.tamanduaBuildVersion;
  }
  return "unknown";
}

export const GUEST_HELP = `tamandua — Matchlock guest worker helper (restricted surface)

Usage: tamandua <command> [args]

This is the version-matched read-only guest helper pack, not an unrestricted
Tamandua installation. Supported commands are answered locally or forwarded to
the scoped host broker for THIS run/invocation only.

Commands:
  version, --version, -v   Print the matching Tamandua build version
  --help, -h, help         Show this help
  skill-path               Print the readable guest tamandua-agents skill path
  step peek <agent> --run-id <run>
  step claim <agent> --run-id <run>
  step current <agent> --run-id <run>
  step complete <step-id> [--file <path>]   (report from file or stdin)
  step fail <step-id> [--reason-file <path>] [<reason>]
  step stories <run> [--json]   Bound-run stories (native JSON or listing)
  workflow status <run> --json  Native workflow status run-JSON for this run
  logs <run>                    Bounded native run-event lines for this run
  merge-branch --origin <path> --branch <b> --into <t> \
               --expect-tip <sha> --message <msg> [--run-id <run>]
                                Authorized squash landing into the run's
                                original branch (native output/exit codes)

Output contracts match the native CLI: claim/current print JSON
({"stepId","runId","input"}), peek prints HAS_WORK/NO_WORK, current prints
NONE when no step is held, complete/fail print result JSON, and REJECTED
completions print to stderr with exit 1 while you still hold the step.
step stories --json prints {"runId":"run-…","stories":[…]}, workflow status
--json prints the native run-JSON object, and logs prints bounded native
run-event lines (a strict finite tail, never the whole event file).
merge-branch runs the shared merge core with GUEST git only after the host
broker returns a typed authorization for the live finalize_merge claim; it
preserves the native STATUS/MERGED_TREE/MERGED_COMMIT/NOOP/CHECKOUT_REFRESH/
PARKED_* output and exit codes 0/1/2/3.

step stories / workflow status / logs are READ-ONLY and are served only for
the run bound to this invocation — asking for any other run is refused. They
never complete or fail a step.

Unsupported (fail explicitly, no host fallback): step release,
workflow run/list/runs/install/uninstall/stop/pause/resume/delete/wait/fail
and other workflow lifecycle commands, logs-tail, global log enumeration
(logs with no run-id / logs <N> / logs #<N>), suite/ledger (tamandua-test)
without a host-injected suite service, dispatcher child runs,
update/install/uninstall, source-path, daemon/control-plane,
admin/operator actions and direct database access.

Reporting contract:
  - STATUS: and KEY: lines are plain text at column 0 — no markdown, code
    fences, or bullets. Success starts with STATUS: done.
  - Report through this CLI (step complete with --file or stdin). Printing a
    final chat message never completes a step.
`;

/** Native-mirror story display label (src/lib/step-display.ts displayStoryStatus). */
function guestStoryDisplayLabel(status: string, resumeResetCount: number): string {
  const resetCount = resumeResetCount ?? 0;
  if (status === "pending" && resetCount > 0) {
    const plural = resetCount === 1 ? "failure" : "failures";
    return `pending (reset on resume, ${resetCount} prior ${plural})`;
  }
  return status;
}

/** Parse a `--run-id <value>` / `--run-id=<value>` token sequence. */
function parseRunIdArg(tokens: string[]): { value?: string; error?: string } {
  let runIdArg: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--run-id") {
      runIdArg = tokens[i + 1]?.trim();
      i++;
      continue;
    }
    const inline = "--run-id=";
    if (tok.startsWith(inline)) runIdArg = tok.slice(inline.length).trim();
  }
  if (runIdArg === undefined || runIdArg === "") {
    return { error: "Missing --run-id for this command.\nUsage: tamandua step <peek|claim|current> <agent-id> --run-id <run-id>" };
  }
  const wrong = detectWrongPrefix(runIdArg, "run");
  if (wrong) return { error: wrong };
  return { value: stripIdPrefix(runIdArg) };
}

function parseAgentAndRun(action: string, argv: string[]): { agentId: string; runId: string } | { error: string } {
  // argv: [tamandua, step, <action>, <agent-id>, ...]
  const target = argv[3];
  if (!target) {
    return { error: `Missing agent-id.\nUsage: tamandua step ${action} <agent-id> --run-id <run-id>` };
  }
  const parsed = parseRunIdArg(argv.slice(4));
  if (parsed.error) return { error: parsed.error };
  return { agentId: target, runId: parsed.value! };
}

function parseCompleteArgs(argv: string[]): { stepId?: string; filePath?: string } | { error: string } {
  // argv: [tamandua, step, complete, <step-id>, ...]
  const target = argv[3];
  if (!target) return { error: "Missing step-id.\n" };
  const wrong = detectWrongPrefix(target, "step");
  if (wrong) return { error: `${wrong}\n` };
  const remainder = argv.slice(4);
  let filePath: string | undefined;
  const nonFlagArgs: string[] = [];
  for (let i = 0; i < remainder.length; i++) {
    const tok = remainder[i];
    if (tok === "--file") {
      filePath = remainder[i + 1]?.trim();
      i++;
    } else if (tok.startsWith("--file=")) {
      filePath = tok.slice("--file=".length).trim();
    } else if (!tok.startsWith("-")) {
      nonFlagArgs.push(tok);
    }
  }
  if (nonFlagArgs.length > 0) {
    return { error: `step complete reads the report from stdin or --file; unexpected argument: ${nonFlagArgs[0]}\n` };
  }
  return { stepId: target, filePath };
}

function parseFailArgs(argv: string[]): { stepId?: string; reason?: string; reasonFilePath?: string } | { error: string } {
  // argv: [tamandua, step, fail, <step-id>, ...]
  const target = argv[3];
  if (!target) return { error: "Missing step-id.\n" };
  const wrong = detectWrongPrefix(target, "step");
  if (wrong) return { error: `${wrong}\n` };
  const remainder = argv.slice(4);
  let reasonFilePath: string | undefined;
  let inlineReason: string | undefined;
  for (let i = 0; i < remainder.length; i++) {
    const tok = remainder[i];
    if (tok === "--reason-file") {
      reasonFilePath = remainder[i + 1]?.trim();
      i++;
    } else if (tok.startsWith("--reason-file=")) {
      reasonFilePath = tok.slice("--reason-file=".length).trim();
    } else if (!tok.startsWith("-")) {
      inlineReason = (inlineReason ? inlineReason + " " : "") + tok;
    }
  }
  return { stepId: target, reason: inlineReason, reasonFilePath };
}

export function unsupportedMessage(command: string): string {
  return `tamandua: "${command}" is not supported by the Matchlock guest helper.\nSupported: version, --version, -v, --help, -h, help, skill-path, step peek|claim|current|complete|fail|stories, workflow status <run> --json, logs <run>, and merge-branch (authorized finalizer landing) — for this run only.\nRun "tamandua --help" for details.\n`;
}

/** Small finite retry wrapper around one guest request (same opKey+content). */
async function requestWithRetry<P extends BridgeResponsePayload>(
  io: GuestCliIo,
  env: GuestCliEnvOverrides & { helperBuildVersion: string },
  frame: { op: string; params: unknown; opKey?: string },
): Promise<{ ok: true; payload: P } | { ok: false; code: string; message: string }> {
  const socketPath = env.socketPath ?? resolveSocketPath(io);
  if (!socketPath) {
    return {
      ok: false,
      code: "IO",
      message:
        `tamandua: guest bridge socket is not configured.\n` +
        `Set ${ENV_GUEST_SOCKET} (full path) or ${ENV_GUEST_SOCKET_DIR} (fresh guest-owned directory) to the bridge socket provided by this invocation.\n`,
    };
  }
  const requestTimeoutMs = env.requestTimeoutMs ?? parseTimeoutMs(io.envGet(ENV_BRIDGE_REQUEST_TIMEOUT_MS), DEFAULT_REQUEST_TIMEOUT_MS);
  let last: { ok: false; code: string; message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await guestRequest<P>(
      { socketPath, helperBuildVersion: env.helperBuildVersion, requestTimeoutMs },
      frame,
    );
    if (result.ok) return result;
    last = result;
    if (result.code === "DEADLINE" || result.code === "IO") {
      // Retryable transport outcome: same opKey + same content, so an accepted
      // host transition is acknowledged exactly once (idempotent replay).
      continue;
    }
    return result;
  }
  return last ?? { ok: false, code: "IO", message: "guest bridge request failed" };
}

function resolveSocketPath(io: GuestCliIo): string | null {
  const direct = io.envGet(ENV_GUEST_SOCKET)?.trim();
  if (direct) return direct;
  const dir = io.envGet(ENV_GUEST_SOCKET_DIR)?.trim();
  if (dir) return path.join(dir, GUEST_SOCKET_FILENAME);
  return null;
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 120_000);
}

/**
 * Run the guest CLI. `argv` mirrors the native CLI shape:
 * argv[0]="tamandua", argv[1]=command, argv[2..]=command args.
 */
export async function runGuestCli(
  argv: string[],
  io: GuestCliIo,
  env: GuestCliEnvOverrides = {},
): Promise<GuestCliResult> {
  const command = argv[1] ?? "";
  const packRoot = resolvePackRoot();
  const helperBuildVersion = guestVersion(packRoot);

  const fail = (message: string): GuestCliResult => {
    stderrLines(io, message.replace(/\n$/, ""));
    return { exitCode: 1 };
  };

  // ---- local answers ---------------------------------------------------
  if (command === "version" || command === "--version" || command === "-v") {
    stdoutLines(io, guestVersion(packRoot));
    return { exitCode: 0 };
  }
  if (command === "--help" || command === "-h" || command === "help") {
    io.writeOut(GUEST_HELP);
    return { exitCode: 0 };
  }
  if (command === "") {
    io.writeOut(GUEST_HELP);
    return { exitCode: 0 };
  }
  if (command === "skill-path") {
    if (argv.length > 2) return fail(`Unknown skill-path option: ${argv.slice(2).join(" ")}`);
    if (!packRoot) return fail("tamandua: skill-path is unavailable outside a guest pack");
    const skillPath = path.join(packRoot, "skills", "tamandua-agents", "SKILL.md");
    try {
      fs.accessSync(skillPath, fs.constants.R_OK);
    } catch {
      return fail(`tamandua: guest skill not found at "${skillPath}"`);
    }
    stdoutLines(io, skillPath);
    return { exitCode: 0 };
  }


  // ---- command groups ---------------------------------------------------
  // step group: peek/claim/current/complete/fail/stories (release refused).
  if (command === "step") {
    const action = argv[2];
    if (action === undefined) {
      return fail("Unknown step action.\nUsage: tamandua step <peek|claim|current|complete|fail|stories>");
    }
    if (action === "--help" || action === "-h" || action === "help") {
      io.writeOut(GUEST_HELP);
      return { exitCode: 0 };
    }
    return runGuestStepAction(argv, action, io, { ...env, helperBuildVersion });
  }

  // workflow group: ONLY the run-scoped status --json query is supported;
  // every other workflow lifecycle subcommand is refused explicitly.
  if (command === "workflow") {
    const sub = argv[2];
    if (sub === "--help" || sub === "-h" || sub === "help") {
      io.writeOut(GUEST_HELP);
      return { exitCode: 0 };
    }
    if (sub === undefined) {
      return fail("Unknown workflow action.\nUsage: tamandua workflow status <run-id> --json");
    }
    if (sub !== "status") {
      return fail(
        `tamandua: "workflow ${sub}" is not supported by the Matchlock guest helper.\n` +
        `Only "workflow status <run-id> --json" is available, for the run bound to this invocation.\n`,
      );
    }
    return runGuestWorkflowStatus(argv, io, { ...env, helperBuildVersion });
  }

  // logs group: bounded run-scoped logs only (no global enumeration).
  if (command === "logs") {
    return runGuestLogs(argv, io, { ...env, helperBuildVersion });
  }

  // merge-branch: scoped, broker-authorized squash landing (US-007).
  if (command === "merge-branch") {
    return runGuestMergeBranch(argv, io, { ...env, helperBuildVersion });
  }

  return fail(unsupportedMessage(command));
}

/**
 * Native-mirror `step stories --json` story entry (step-ops buildStoriesJson):
 * {storyId,title,status} + abandonedCount when > 0 + updatedAt when set.
 * The wire payload carries extra presentation fields (retryCount /
 * resumeResetCount) so the human listing can render byte-identically to the
 * native CLI; this entry intentionally OMITS them like the native JSON shape.
 */
function nativeStoriesJsonEntry(s: GuestStoryItem): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    storyId: s.storyId,
    title: s.title,
    status: s.status,
  };
  if (s.abandonedCount !== undefined && s.abandonedCount !== 0) entry.abandonedCount = s.abandonedCount;
  if (s.updatedAt) entry.updatedAt = s.updatedAt;
  return entry;
}

/** Guest query env: CLI env overrides plus the pack's helper build version. */
type GuestQueryEnv = GuestCliEnvOverrides & { helperBuildVersion: string };

function guestQueryFail(io: GuestCliIo, message: string): GuestCliResult {
  stderrLines(io, message.replace(/\n$/, ""));
  return { exitCode: 1 };
}

/**
 * First unexpected token after a query command's run target. Unknown options
 * and extra positionals fail explicitly (no silent global-enumeration drift).
 * Returns an error message or null when `tokens` contains nothing extra.
 */
function rejectQueryExtras(tokens: string[], allowedFlags: string[], label: string): string | null {
  for (const tok of tokens) {
    if (tok.startsWith("-")) {
      if (!allowedFlags.includes(tok)) {
        return `Unknown option "${tok}" for tamandua ${label}. Run tamandua --help for available options.`;
      }
      continue;
    }
    return `tamandua ${label}: unexpected argument: ${tok}`;
  }
  return null;
}

// ---- step group actions --------------------------------------------------

/** `step stories <run> [--json]` — bound-run stories (US-004, read-only). */
async function runGuestStepStories(argv: string[], io: GuestCliIo, env: GuestQueryEnv): Promise<GuestCliResult> {
  const target = argv[3];
  if (!target) return guestQueryFail(io, "Missing run-id.\n");
  const wrong = detectWrongPrefix(target, "run");
  if (wrong) return guestQueryFail(io, `${wrong}\n`);
  const jsonFlag = argv.slice(4).includes("--json");
  const extra = rejectQueryExtras(argv.slice(4), ["--json"], "step stories");
  if (extra) return guestQueryFail(io, extra);

  const result = await requestWithRetry<BridgeResponsePayload>(
    io,
    env,
    { op: "step.stories", params: { runId: stripIdPrefix(target) } },
  );
  if (!result.ok) return guestQueryFail(io, `tamandua: ${result.message}`);
  const payload = result.payload as { stories: GuestStoriesPayload };
  if (jsonFlag) {
    stdoutLines(
      io,
      JSON.stringify({
        runId: payload.stories.runId,
        stories: payload.stories.stories.map(nativeStoriesJsonEntry),
      }),
    );
    return { exitCode: 0 };
  }
  if (payload.stories.stories.length === 0) {
    stdoutLines(io, "No stories found.");
    return { exitCode: 0 };
  }
  for (const story of payload.stories.stories) {
    const label = guestStoryDisplayLabel(story.status, story.resumeResetCount);
    stdoutLines(
      io,
      `${story.storyId.padEnd(8)} [${label.padEnd(7)}] ${story.title}${story.retryCount > 0 ? ` (retry ${story.retryCount})` : ""}`,
    );
  }
  return { exitCode: 0 };
}

/**
 * One step action of the guest worker CLI. `argv` mirrors the native shape:
 * argv[0]="tamandua", argv[1]="step", argv[2]=action, argv[3..]=action args.
 */
async function runGuestStepAction(
  argv: string[],
  action: string,
  io: GuestCliIo,
  env: GuestQueryEnv,
): Promise<GuestCliResult> {
  // ---- step stories (US-004 read-only query) ----------------------------
  if (action === "stories") return runGuestStepStories(argv, io, env);

  // ---- step release (operator-only; explicitly refused, no host fallback)
  if (action === "release") {
    return guestQueryFail(
      io,
      'tamandua: "step release" is not supported by the Matchlock guest helper (operator-only; no host fallback).',
    );
  }

  // ---- step peek/claim/current -----------------------------------------
  if (action === "peek" || action === "claim" || action === "current") {
    const parsed = parseAgentAndRun(action, argv);
    if ("error" in parsed) return guestQueryFail(io, parsed.error);
    const opKey = action === "claim" ? randomUUID() : undefined;
    const result = await requestWithRetry<BridgeResponsePayload>(
      io,
      env,
      {
        op: `step.${action}`,
        params: { agentId: parsed.agentId, runId: parsed.runId },
        ...(opKey !== undefined ? { opKey } : {}),
      },
    );
    if (!result.ok) return guestQueryFail(io, `tamandua: ${result.message}`);
    if (action === "peek") {
      const payload = result.payload as { peek: "HAS_WORK" | "NO_WORK" };
      stdoutLines(io, payload.peek);
      return { exitCode: 0 };
    }
    if (action === "claim") {
      const payload = result.payload as { claim: { found: boolean; stepId?: string; runId?: string; input?: string } };
      if (!payload.claim.found) {
        stdoutLines(io, "NO_WORK");
        return { exitCode: 0 };
      }
      stdoutLines(
        io,
        JSON.stringify({
          stepId: payload.claim.stepId,
          runId: payload.claim.runId,
          input: payload.claim.input,
        }),
      );
      return { exitCode: 0 };
    }
    const payload = result.payload as { current: { found: boolean; stepId?: string; runId?: string; input?: string } };
    if (!payload.current.found) {
      stdoutLines(io, "NONE");
      return { exitCode: 0 };
    }
    stdoutLines(
      io,
      JSON.stringify({
        stepId: payload.current.stepId,
        runId: payload.current.runId,
        input: payload.current.input,
      }),
    );
    return { exitCode: 0 };
  }

  // ---- step complete ----------------------------------------------------
  if (action === "complete") {
    const parsed = parseCompleteArgs(argv);
    if ("error" in parsed) return guestQueryFail(io, parsed.error);
    let output: string;
    if (parsed.filePath !== undefined) {
      const read = readFlagFileBounded(parsed.filePath, io.cwd, "--file");
      if (!read.ok) return guestQueryFail(io, read.message);
      output = read.text;
    } else {
      output = (await io.readStdin()).trim();
      if (output.length > REPORT_MAX_BYTES) {
        return guestQueryFail(io, `tamandua: report from stdin exceeds ${REPORT_MAX_BYTES} bytes; refusing to transfer`);
      }
    }
    const deref = dereferenceStoriesJsonFile(output, io.cwd);
    if (!deref.ok) return guestQueryFail(io, deref.message);
    output = deref.text;

    const opKey = randomUUID();
    const result = await requestWithRetry<BridgeResponsePayload>(
      io,
      env,
      { op: "step.complete", params: { stepId: parsed.stepId, output }, opKey },
    );
    if (!result.ok) return guestQueryFail(io, `tamandua: ${result.message}`);
    const payload = result.payload as {
      complete: { status: string; detail?: string; rejected?: { message: string; hint?: string } };
    };
    if (payload.complete.rejected) {
      stderrLines(
        io,
        `REJECTED: ${payload.complete.rejected.message}`,
        `Hint: ${payload.complete.rejected.hint ?? "plain-text KEY: lines at column 0, no markdown. Fix your output and resubmit — you still hold the step."}`,
      );
      return { exitCode: 1 };
    }
    stdoutLines(
      io,
      JSON.stringify(
        payload.complete.detail !== undefined
          ? { status: payload.complete.status, detail: payload.complete.detail }
          : { status: payload.complete.status },
      ),
    );
    return { exitCode: 0 };
  }

  // ---- step fail ---------------------------------------------------------
  if (action === "fail") {
    const parsed = parseFailArgs(argv);
    if ("error" in parsed) return guestQueryFail(io, parsed.error);
    let reason: string;
    if (parsed.reasonFilePath !== undefined) {
      const read = readFlagFileBounded(parsed.reasonFilePath, io.cwd, "--reason-file");
      if (!read.ok) return guestQueryFail(io, read.message);
      reason = read.text;
    } else if (parsed.reason !== undefined) {
      reason = parsed.reason;
      if (Buffer.byteLength(reason, "utf-8") > REASON_MAX_BYTES) {
        return guestQueryFail(io, `tamandua: inline reason exceeds ${REASON_MAX_BYTES} bytes; refusing to transfer`);
      }
    } else {
      reason = "Unknown error";
    }
    const opKey = randomUUID();
    const result = await requestWithRetry<BridgeResponsePayload>(
      io,
      env,
      { op: "step.fail", params: { stepId: parsed.stepId, reason }, opKey },
    );
    if (!result.ok) return guestQueryFail(io, `tamandua: ${result.message}`);
    const payload = result.payload as { fail: { status: string } };
    stdoutLines(io, JSON.stringify({ status: payload.fail.status }));
    return { exitCode: 0 };
  }

  return guestQueryFail(io, `Unknown step action: ${action}\n`);
}

// ---- workflow group --------------------------------------------------------

/** `workflow status <run> --json` — native workflow status run-JSON (US-004). */
async function runGuestWorkflowStatus(argv: string[], io: GuestCliIo, env: GuestQueryEnv): Promise<GuestCliResult> {
  const target = argv[3];
  if (!target) {
    return guestQueryFail(io, "Missing query.\nUsage: tamandua workflow status <run-id> --json");
  }
  const wrong = detectWrongPrefix(target, "run");
  if (wrong) return guestQueryFail(io, `${wrong}\n`);
  const jsonFlag = argv.slice(4).includes("--json");
  const extra = rejectQueryExtras(argv.slice(4), ["--json"], "workflow status");
  if (extra) return guestQueryFail(io, extra);
  if (!jsonFlag) {
    return guestQueryFail(
      io,
      "tamandua: workflow status requires --json in the Matchlock guest helper (the human status display is not available on this restricted surface).\nUsage: tamandua workflow status <run-id> --json",
    );
  }

  const result = await requestWithRetry<BridgeResponsePayload>(
    io,
    env,
    { op: "workflow.status", params: { runId: stripIdPrefix(target) } },
  );
  if (!result.ok) return guestQueryFail(io, `tamandua: ${result.message}`);
  const payload = result.payload as { status: Record<string, unknown> };
  stdoutLines(io, JSON.stringify(payload.status));
  return { exitCode: 0 };
}

// ---- logs group ------------------------------------------------------------

/** `logs <run>` — bounded run-scoped native log lines (US-004, read-only). */
async function runGuestLogs(argv: string[], io: GuestCliIo, env: GuestQueryEnv): Promise<GuestCliResult> {
  const rest = argv.slice(2); // tokens after the "logs" command word
  if (rest.length === 0) {
    return guestQueryFail(
      io,
      "Missing run-id.\nUsage: tamandua logs <run-id> — bounded run-scoped logs for the run bound to this invocation",
    );
  }
  const first = rest[0];
  if (first === "--help" || first === "-h" || first === "help") {
    io.writeOut(GUEST_HELP);
    return { exitCode: 0 };
  }
  const unknownFlag = rest.find((t) => t.startsWith("--"));
  if (unknownFlag) {
    return guestQueryFail(io, `Unknown option "${unknownFlag}" for tamandua logs. Run tamandua --help for available options.\n`);
  }
  // Global enumeration / run-number shapes are refused explicitly.
  if (/^\d+$/.test(first) || first.startsWith("#")) {
    return guestQueryFail(
      io,
      `tamandua: global log enumeration ("logs ${first}") is not supported by the Matchlock guest helper — only run-scoped logs for the run bound to this invocation (logs <run-id>).`,
    );
  }
  if (rest.length > 1) return guestQueryFail(io, `tamandua logs: unexpected argument: ${rest[1]}\n`);
  const wrong = detectWrongPrefix(first, "run");
  if (wrong) return guestQueryFail(io, `${wrong}\n`);

  const result = await requestWithRetry<BridgeResponsePayload>(
    io,
    env,
    { op: "logs.run", params: { runId: stripIdPrefix(first) } },
  );
  if (!result.ok) return guestQueryFail(io, `tamandua: ${result.message}`);
  const payload = result.payload as { logs: GuestLogsPayload };
  if (payload.logs.lines.length === 0) {
    stdoutLines(io, "No events yet.");
    return { exitCode: 0 };
  }
  for (const line of payload.logs.lines) stdoutLines(io, line);
  return { exitCode: 0 };
}

// ---- merge-branch (US-007 scoped authorized landing) -----------------------

export const GUEST_MERGE_HELP = `tamandua merge-branch — authorized squash landing (Matchlock guest surface)

Usage: tamandua merge-branch --origin <repo-path> --branch <feature-branch> --into <target-ref> --expect-tip <sha> --message <commit-message> [--run-id <run-id>]

Required options (exactly once):
  --origin <repo-path>       Admitted original repository whose target ref is updated
  --branch <feature-branch>  Feature branch to squash
  --into <target-ref>        Target branch name (must be this run's original branch)
  --expect-tip <sha>         Required current target commit (atomic compare-and-swap)
  --message <message>        Commit message for the squash commit

Optional options:
  --run-id <run-id>          Run to attribute the landing to (must match this invocation)

The host broker type-checks the finalizer binding (merger role, live
finalize_merge claim, admitted origin, original target, current authoritative
tip) BEFORE any Git runs. Only then does the guest execute the shared merge
core with guest Git against the RW-mounted original. Output and exit codes are
the native contracts: STATUS/MERGED_TREE/MERGED_COMMIT/NOOP/CHECKOUT_REFRESH/
PARKED_* and 0 landed, 1 operational error, 2 target_moved, 3 conflicts.`;

const GUEST_MERGE_REQUIRED_OPTIONS = ["--origin", "--branch", "--into", "--expect-tip", "--message"] as const;
const GUEST_MERGE_OPTIONAL_OPTIONS = ["--run-id"] as const;
const GUEST_MERGE_OPTIONS = [...GUEST_MERGE_REQUIRED_OPTIONS, ...GUEST_MERGE_OPTIONAL_OPTIONS] as const;

/**
 * Guest merge-branch option parser. Mirrors the native
 * parseMergeBranchOptions (src/cli/commands/merge-branch.ts) exactly: named
 * options only, `--name value` and `--name=value`, duplicate/unknown/missing
 * refusals and non-empty trimmed values. Multiline/Unicode messages survive as
 * a single (shell-quoted) token.
 */
export function parseGuestMergeBranchOptions(args: string[]): Record<string, string> {
  const allowed = new Set<string>(GUEST_MERGE_OPTIONS);
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token}. All merge-branch inputs must use named options.`);
    }
    const equalsIndex = token.indexOf("=");
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (!allowed.has(name)) throw new Error(`Unknown option ${name}.`);
    if (parsed.has(name)) throw new Error(`Duplicate option ${name}.`);
    let value: string | undefined;
    if (equalsIndex !== -1) {
      value = token.slice(equalsIndex + 1);
    } else {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index++;
      }
    }
    if (!value?.trim()) throw new Error(`Missing value for ${name}.`);
    parsed.set(name, value);
  }
  for (const name of GUEST_MERGE_REQUIRED_OPTIONS) {
    if (!parsed.has(name)) throw new Error(`Missing required option ${name}.`);
  }
  return Object.fromEntries(parsed);
}

/**
 * Guest-side Git runner for the shared merge core. `git -C <cwd> …` with no
 * shell interpolation; stdout/stderr are trimmed exactly like the native
 * delegate. All hook/signing/helper-bearing plumbing stays in the guest VM.
 */
export function guestMergeGitRunner(cwd: string, args: string[]): MergeCoreGitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function bounded(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  return value.slice(0, maxBytes);
}

/** Build the wire report record from the shared pure-core result. */
export function mergeReportFromResult(
  authorizationId: string,
  result: MergeCoreResult,
): MergeReportRequest {
  switch (result.status) {
    case "landed":
      return {
        authorizationId,
        status: "landed",
        exitCode: result.exitCode,
        mergedTree: result.mergedTree,
        mergedCommit: result.mergedCommit,
        noop: result.noop,
        checkoutRefresh: result.checkoutRefresh,
        ...(result.parkedBranch ? { parkedBranch: result.parkedBranch } : {}),
        ...(result.parkedReason ? { parkedReason: bounded(result.parkedReason, MERGE_WIRE_DETAIL_MAX_BYTES) } : {}),
      };
    case "target_moved":
      return {
        authorizationId,
        status: "target_moved",
        exitCode: result.exitCode,
        expectedTip: result.expectedTip,
        ...(result.actualTip !== undefined ? { actualTip: result.actualTip } : {}),
        ...(result.mergedTree !== undefined ? { mergedTree: result.mergedTree } : {}),
        ...(result.mergedCommit !== undefined ? { mergedCommit: result.mergedCommit } : {}),
        detail: bounded(result.detail, MERGE_WIRE_DETAIL_MAX_BYTES),
      };
    case "conflicts":
      return {
        authorizationId,
        status: "conflicts",
        exitCode: result.exitCode,
        ...(result.mergedTree !== undefined ? { mergedTree: result.mergedTree } : {}),
        conflicts: bounded(result.conflicts, MERGE_WIRE_CONFLICTS_MAX_BYTES),
      };
    default:
      return {
        authorizationId,
        status: "operational_error",
        exitCode: result.exitCode,
        detail: bounded(result.detail, MERGE_WIRE_DETAIL_MAX_BYTES),
      };
  }
}

/** Render the native merge-branch stdout/stderr and exit code for a result. */
export function printMergeResult(io: GuestCliIo, result: MergeCoreResult): GuestCliResult {
  if (result.status === "landed") {
    let output = `STATUS: landed\nNOOP: ${result.noop}\nMERGED_COMMIT: ${result.mergedCommit}\nMERGED_TREE: ${result.mergedTree}\nTARGET: ${result.target}\nCHECKOUT_REFRESH: ${result.checkoutRefresh}\n`;
    if (result.checkoutRefresh.startsWith("parked:")) {
      output += `PARKED_BRANCH: ${result.parkedBranch}\nPARKED_REASON: ${result.parkedReason}\n`;
    }
    io.writeOut(output);
    return { exitCode: result.exitCode };
  }
  if (result.status === "target_moved") {
    io.writeOut("STATUS: target_moved\n");
    stderrLines(io, result.detail);
    return { exitCode: result.exitCode };
  }
  if (result.status === "conflicts") {
    io.writeOut(`STATUS: conflicts\n${result.conflicts}${result.conflicts.endsWith("\n") ? "" : "\n"}`);
    return { exitCode: result.exitCode };
  }
  stderrLines(io, `Error: ${result.detail}`);
  return { exitCode: result.exitCode };
}

/**
 * `merge-branch --origin …` — request a typed host authorization, execute the
 * shared merge core with guest Git, report the outcome for independent host
 * verification, then print the native result. A refused authorization (or an
 * unrecordable receipt) exits 1 WITHOUT any Git action.
 */
async function runGuestMergeBranch(argv: string[], io: GuestCliIo, env: GuestQueryEnv): Promise<GuestCliResult> {
  const options = argv.slice(2);
  if (options.includes("--help") || options.includes("-h")) {
    io.writeOut(GUEST_MERGE_HELP);
    return { exitCode: 0 };
  }
  let parsed: Record<string, string>;
  try {
    parsed = parseGuestMergeBranchOptions(options);
  } catch (err) {
    stderrLines(io, `Error: ${err instanceof Error ? err.message : String(err)}`, "Run tamandua merge-branch --help for usage.");
    return { exitCode: 1 };
  }

  const runId = parsed["--run-id"];
  const authResult = await requestWithRetry<BridgeResponsePayload>(
    io,
    env,
    {
      op: "merge.authorize",
      params: {
        origin: parsed["--origin"],
        branch: parsed["--branch"],
        into: parsed["--into"],
        expectTip: parsed["--expect-tip"],
        message: parsed["--message"],
        ...(runId !== undefined ? { runId } : {}),
      },
    },
  );
  if (!authResult.ok) {
    stderrLines(io, `Error: ${authResult.message}`);
    return { exitCode: 1 };
  }
  const authorization = (authResult.payload as { mergeAuthorization: MergeAuthorization }).mergeAuthorization;

  // Host authorized the exact finalizer binding: run the shared pure core with
  // guest Git only. Canonical host-validated values are used.
  const coreResult = runMergeCore(
    {
      origin: authorization.origin,
      branch: authorization.branch,
      into: authorization.into,
      expectTip: authorization.expectTip,
      message: authorization.message,
      runId: authorization.runId,
    },
    { runGit: guestMergeGitRunner },
  );

  const report = mergeReportFromResult(authorization.authorizationId, coreResult);
  const reportResult = await requestWithRetry<BridgeResponsePayload>(
    io,
    env,
    { op: "merge.report", params: report, opKey: randomUUID() },
  );
  if (!reportResult.ok) {
    stderrLines(io, `tamandua: merge receipt was not accepted: ${reportResult.message}`);
    return { exitCode: 1 };
  }
  return printMergeResult(io, coreResult);
}

