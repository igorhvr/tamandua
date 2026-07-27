/**
 * Scripted-agent test helper — generalized "fake pi" for full-pipeline e2e.
 *
 * createScriptedAgent() materializes an executable that the agent scheduler
 * can spawn in place of the real pi binary (via TAMANDUA_PI_BINARY). Unlike
 * the canned fake-pi in unit tests, the scripted agent executes the real
 * work protocol — step claim / complete against the isolated tamandua DB
 * (plus a defensive peek) — and applies deterministic per-agent behaviors
 * (file edits, shell commands, canned STATUS outputs) in the harness workdir.
 *
 * This lets e2e tests drive the REAL daemon → scheduler → harness spawn →
 * stream parse → step-ops → pipeline advance path with zero model tokens.
 *
 * See scripted-agent-runtime.mjs for the behavior semantics and chaos modes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "scripted-agent-runtime.mjs",
);

export interface ScriptedEdit {
  file: string;
  find: string;
  replace: string;
}

export interface ScriptedWrite {
  file: string;
  content: string;
}

export interface ScriptedBehavior {
  /**
   * "work" (default): claim, apply edits/writes/commands, step complete.
   * "hang": never respond (exercises the scheduler timeout-kill path).
   * "hang-after-claim": claim, then hang — the step sits 'running' with
   *   recorded WorkerOwnership (exercises daemon-crash recovery, C18).
   * "die-before-claim": exit non-zero before claiming.
   * "die-after-claim": claim (and apply edits) then exit without reporting.
   * "no-status": claim, apply behavior, emit output WITHOUT step complete
   *   and without a STATUS marker (the lost/abandoned step case).
   * "garbage": emit non-JSON garbage and exit 0.
   */
  mode?: "work" | "hang" | "hang-after-claim" | "die-before-claim" | "die-after-claim" | "no-status" | "garbage";
  /** Find/replace edits applied in the harness workdir before reporting. */
  edits?: ScriptedEdit[];
  /** Files written (created/overwritten) in the harness workdir. */
  writes?: ScriptedWrite[];
  /** Shell commands run in the harness workdir; non-zero exit → step fail. */
  commands?: string[];
  /** Prefix the report with command stdout (used for machine-readable CLI metadata). */
  includeCommandOutput?: boolean;
  /**
   * Text piped to `step complete` and emitted as the assistant message.
   * Supports {{cwd}}, {{gitTree}} (the current HEAD tree), and {{input.KEY}}
   * placeholders (KEY: value lines parsed from the claimed step input).
   * Defaults to "STATUS: done".
   */
  output?: string;
  /** Report via `step fail` instead of `step complete`. */
  stepAction?: "complete" | "fail";
  failReason?: string;
  /**
   * Report `step complete` BEFORE emitting the message_end usage event
   * (real pi's event ordering: the completing tool call precedes the final
   * assistant message). Exercises the completion-teardown grace window.
   */
  reportBeforeEmit?: boolean;
  /** usage.totalTokens emitted in message_end (default: config.defaultTokens). */
  tokens?: number;
  /** Exit code for die-* modes. */
  exitCode?: number;
}

export interface ScriptedAgentConfig {
  /**
   * Behaviors keyed by SHORT agent id (e.g. "fixer" for
   * "bug-fix-merge-worktree_fixer"). An array is consumed one entry per
   * work invocation, last entry repeating — so [failOnce, thenSucceed]
   * scripts retry scenarios.
   */
  agents: Record<string, ScriptedBehavior | ScriptedBehavior[]>;
  /**
   * usage.totalTokens for rounds spawned without pending work (default 17).
   * Under the deterministic dispatch motor these should never happen — the
   * scripted e2e asserts heartbeats().length === 0.
   */
  heartbeatTokens?: number;
  /** Default usage.totalTokens for work rounds (default 111). */
  defaultTokens?: number;
}

export interface InvocationLogEntry {
  ts: string;
  pid: number;
  /**
   * "work" is logged once per work round at claim time (before any behavior
   * runs); "result" entries carry the round outcome. Rounds that complete
   * the final step of a run may lack a "result" entry — the daemon rugpulls
   * the harness process as soon as the run reaches a terminal state.
   */
  phase: "heartbeat" | "work" | "result" | "error";
  workflowId?: string;
  agentId?: string;
  shortAgent?: string;
  runId?: string;
  cwd?: string;
  jobId?: string | null;
  workIndex?: number;
  mode?: string;
  stepId?: string | null;
  ok?: boolean;
  note?: string;
}

export interface ScriptedAgent {
  /** Path to the executable to expose as TAMANDUA_PI_BINARY. */
  binPath: string;
  /** Directory holding invocations.jsonl and per-agent work counters. */
  stateDir: string;
  /** Env overrides to merge into the DAEMON spawn env. */
  env: Record<string, string>;
  /** All invocation log entries so far. */
  readInvocations(): InvocationLogEntry[];
  /** Work-phase invocations (optionally for one short agent id). */
  workInvocations(shortAgent?: string): InvocationLogEntry[];
  /** Heartbeat-phase invocations (optionally for one short agent id). */
  heartbeats(shortAgent?: string): InvocationLogEntry[];
  /** Human-readable dump for failure diagnostics. */
  describe(): string;
}

/**
 * Materialize a scripted agent under `rootDir` (a temp dir owned by the test).
 */
export function createScriptedAgent(
  rootDir: string,
  config: ScriptedAgentConfig,
): ScriptedAgent {
  const dir = path.join(rootDir, "scripted-agent");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  const behaviorsPath = path.join(dir, "behaviors.json");
  fs.writeFileSync(behaviorsPath, JSON.stringify(config, null, 2), "utf-8");

  // Wrapper script: absolute node path so the daemon's PATH doesn't matter.
  const binPath = path.join(dir, "scripted-pi");
  fs.writeFileSync(
    binPath,
    [
      "#!/usr/bin/env bash",
      `exec "${process.execPath}" "${runtimePath}" "$@"`,
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(binPath, 0o755);

  const readInvocations = (): InvocationLogEntry[] => {
    const logPath = path.join(stateDir, "invocations.jsonl");
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InvocationLogEntry);
  };

  return {
    binPath,
    stateDir,
    env: {
      TAMANDUA_PI_BINARY: binPath,
      TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
      TAMANDUA_SCRIPTED_STATE: stateDir,
    },
    readInvocations,
    workInvocations: (shortAgent?: string) =>
      readInvocations().filter(
        (e) => e.phase === "work" && (shortAgent === undefined || e.shortAgent === shortAgent),
      ),
    heartbeats: (shortAgent?: string) =>
      readInvocations().filter(
        (e) => e.phase === "heartbeat" && (shortAgent === undefined || e.shortAgent === shortAgent),
      ),
    describe: () =>
      readInvocations()
        .map(
          (e) =>
            `${e.ts} ${e.phase}${e.shortAgent ? ` agent=${e.shortAgent}` : ""}${
              e.mode ? ` mode=${e.mode}` : ""
            }${e.stepId ? ` step=${String(e.stepId).slice(0, 8)}` : ""}${
              e.ok !== undefined ? ` ok=${e.ok}` : ""
            }${e.note ? ` note=${e.note}` : ""}`,
        )
        .join("\n") || "(no scripted-agent invocations recorded)",
  };
}
