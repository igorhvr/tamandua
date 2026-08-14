/**
 * Scripted-dsh test helper — fake dsh binary for full-pipeline e2e.
 *
 * createScriptedDsh() materializes an executable that the agent scheduler
 * can spawn in place of the real dsh binary (via TAMANDUA_DSH_BINARY).
 * Unlike the canned fake-dsh in unit tests, the scripted dsh executes the
 * real work protocol — step claim / complete against the isolated tamandua DB
 * (plus a defensive peek) — and applies deterministic per-agent behaviors
 * (file edits, shell commands, canned STATUS outputs) in the harness workdir.
 *
 * This lets e2e tests drive the REAL daemon → scheduler → dsh harness →
 * step-ops → pipeline advance path with zero model tokens.
 *
 * See scripted-dsh-runtime.mjs for the behavior semantics and chaos modes.
 *
 * Shares types with scripted-agent.ts so all factories use the same
 * ScriptedAgentConfig shape. The dsh factory also sets:
 *   TAMANDUA_PI_BINARY=/usr/bin/false  (accidental pi spawns fail loudly)
 *   DSH_HOME=<temp dsh home>  (fake session.jsonl.zstd logs live here)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ScriptedAgentConfig,
  InvocationLogEntry,
  ScriptedAgent,
} from "./scripted-agent.js";

const runtimePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "scripted-dsh-runtime.mjs",
);

/**
 * Materialize a scripted dsh binary under `rootDir` (a temp dir owned by
 * the test).
 *
 * The factory creates:
 *   - A bash wrapper script that invokes the dsh runtime via node
 *   - A DSH_HOME directory (the runtime creates session-<uuid> log dirs
 *     under DSH_HOME/sessions/<escaped-cwd>/ on each work round)
 *   - Environment variables for the daemon and CLI to use the fake dsh
 *
 * Returns an object compatible with the ScriptedAgent interface (same shape
 * as createScriptedAgent and createScriptedHermes) so existing test
 * infrastructure can consume all three uniformly.
 */
export function createScriptedDsh(
  rootDir: string,
  config: ScriptedAgentConfig,
): ScriptedAgent {
  const dir = path.join(rootDir, "scripted-dsh");
  const stateDir = path.join(dir, "state");
  const dshHome = path.join(dir, "dsh-home");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });

  const behaviorsPath = path.join(dir, "behaviors.json");
  fs.writeFileSync(behaviorsPath, JSON.stringify(config, null, 2), "utf-8");

  // Wrapper script: absolute node path so the daemon's PATH doesn't matter.
  // Invokes dsh argv: --profile headless "<prompt>"
  const binPath = path.join(dir, "scripted-dsh");
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
      TAMANDUA_DSH_BINARY: binPath,
      DSH_HOME: dshHome,
      TAMANDUA_PI_BINARY: "/usr/bin/false",
      TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
      TAMANDUA_SCRIPTED_STATE: stateDir,
    },
    readInvocations,
    workInvocations: (shortAgent?: string) =>
      readInvocations().filter(
        (e) =>
          e.phase === "work" &&
          (shortAgent === undefined || e.shortAgent === shortAgent),
      ),
    heartbeats: (shortAgent?: string) =>
      readInvocations().filter(
        (e) =>
          e.phase === "heartbeat" &&
          (shortAgent === undefined || e.shortAgent === shortAgent),
      ),
    describe: () =>
      readInvocations()
        .map(
          (e) =>
            `${e.ts} ${e.phase}${
              e.shortAgent ? ` agent=${e.shortAgent}` : ""
            }${e.mode ? ` mode=${e.mode}` : ""}${
              e.stepId ? ` step=${String(e.stepId).slice(0, 8)}` : ""
            }${
              e.ok !== undefined ? ` ok=${e.ok}` : ""
            }${e.note ? ` note=${e.note}` : ""}`,
        )
        .join("\n") || "(no scripted-dsh invocations recorded)",
  };
}
