/**
 * Persona injection into work rounds: executeDispatchRound reads the
 * provisioned persona files (AGENTS.md / IDENTITY.md / SOUL.md) from the
 * agent's workflow workspace and injects them into the work prompt as the
 * PROVISIONED AGENT PERSONA block. Same behavior the polling motor had —
 * the persona now rides the work prompt instead of the polling prompt.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const repoRoot = process.cwd();

function runRoundAndCapturePrompt(opts: { personaFiles?: Record<string, string> }): string {
  const th = createTempHome("tamandua-work-persona-");
  const root = th.root;
  const homeDir = th.homeDir;
  const stateDir = th.tamanduaDir;

  const agentId = "wf-persona_dev";
  const workspaceDir = path.join(stateDir, "workspaces", "workflows", agentId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const [name, content] of Object.entries(opts.personaFiles ?? {})) {
    fs.writeFileSync(path.join(workspaceDir, name), content, "utf-8");
  }

  // Fake pi that dumps its last argument (the prompt) to a file.
  const promptPath = path.join(root, "captured-prompt.txt");
  const fakePi = path.join(root, "fake-pi");
  fs.writeFileSync(
    fakePi,
    [`#!/usr/bin/env bash`, `printf '%s' "\${@: -1}" > "${promptPath}"`, `echo "NO_WORK_AVAILABLE"`, ``].join("\n"),
    "utf-8",
  );
  fs.chmodSync(fakePi, 0o755);

  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();

  const script = `
    import { executeDispatchRound } from "./dist/installer/agent-scheduler.js";
    import { getDb } from "./dist/db.js";

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-persona', 'persona test', 'running', '{}', 0, ?, ?)"
    ).run(${JSON.stringify(runId)}, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'work', ?, 0, 'work', '', 'pending', ?, ?)"
    ).run(${JSON.stringify(stepId)}, ${JSON.stringify(runId)}, ${JSON.stringify(agentId)}, now, now);

    const job = {
      id: "job-persona",
      workflowId: "wf-persona",
      agentId: ${JSON.stringify(agentId)},
      runId: ${JSON.stringify(runId)},
      timeoutSeconds: 30,
      workingDirectoryForHarness: process.cwd(),
      createdAt: now,
    };
    await executeDispatchRound(job, { id: "dev", role: "coding", workspace: { baseDir: process.cwd(), files: {} } });
    console.log(JSON.stringify({ done: true }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv({ HOME: homeDir, TAMANDUA_PI_BINARY: fakePi, TAMANDUA_STATE_DIR: stateDir }),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`script failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf-8") : "";
}

describe("work-round persona prompt injection", () => {
  it("injects provisioned persona files into the spawned work prompt", () => {
    const prompt = runRoundAndCapturePrompt({
      personaFiles: {
        "SOUL.md": "Always double-check arithmetic before reporting.",
        "IDENTITY.md": "You are the persona-test developer.",
      },
    });

    assert.ok(prompt.length > 0, "the fake pi should have captured a prompt");
    assert.ok(prompt.includes("PROVISIONED AGENT PERSONA"), "persona block should be present");
    assert.ok(prompt.includes("Always double-check arithmetic"), "SOUL.md content should be injected");
    assert.ok(prompt.includes("persona-test developer"), "IDENTITY.md content should be injected");
    assert.ok(prompt.includes("step claim"), "the prompt is still the claim-and-execute work prompt");
  });

  it("omits the persona block when no persona files are provisioned", () => {
    const prompt = runRoundAndCapturePrompt({});

    assert.ok(prompt.length > 0, "the fake pi should have captured a prompt");
    assert.ok(!prompt.includes("PROVISIONED AGENT PERSONA"), "no persona block without persona files");
    assert.ok(prompt.includes("step claim"), "work prompt still present");
  });
});
