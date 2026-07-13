import fs from "node:fs";
import {
  cleanChildEnv,
  createTempHome,
  reservePortHandles,
} from "./helpers/test-env.ts";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

async function setupHarnessTempHome() {
  const [controlHandle] = await reservePortHandles(1);
  const controlPort = controlHandle.port;
  const th = createTempHome("tamandua-harness-cwd-");
  return { root: th.root, homeDir: th.homeDir, controlPort, controlHandle };
}

function writeMinimalWorkflow(homeDir: string, workflowId: string): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    [
      `id: ${workflowId}`,
      "agents:",
      "  - id: dev",
      "    model: fake",
      "    workspace:",
      "      baseDir: .",
      "steps:",
      "  - id: implement",
      "    agent: dev",
      "    input: Implement the task",
      "    expects: STATUS, CHANGES, TESTS",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("working-directory-for-harness", () => {
  it("runWorkflow persists explicit workingDirectoryForHarness in run context and scheduler job metadata", async () => {
    const temp = await setupHarnessTempHome();

    try {
      const workflowId = "harness-explicit";
      writeMinimalWorkflow(temp.homeDir, workflowId);

      const harnessDir = path.join(temp.root, "project");
      fs.mkdirSync(harnessDir, { recursive: true });

      await temp.controlHandle.close();
      const result = runNodeScript(
        `
          import { runWorkflow } from "./dist/installer/run.js";
          import { getDb } from "./dist/db.js";
          import { shutdownAllCrons } from "./dist/installer/agent-scheduler.js";
          import { stopDaemon } from "./dist/server/daemonctl.js";
          import { readDaemonSecret, getControlPort } from "./dist/server/control-server.js";
          import http from "node:http";

          async function daemonJobs() {
            const secret = readDaemonSecret();
            return await new Promise((resolve, reject) => {
              const req = http.request({
                hostname: "127.0.0.1",
                port: getControlPort(),
                path: "/control/jobs",
                method: "GET",
                headers: secret ? { "x-tamandua-secret": secret } : {},
              }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))));
              });
              req.on("error", reject);
              req.end();
            });
          }

          try {
            const started = await runWorkflow({
              workflowId: "${workflowId}",
              taskTitle: "Use explicit harness cwd",
              workingDirectoryForHarness: process.env.HARNESS_DIR,
            });

            const db = getDb();
            const row = db.prepare("SELECT context, scheduling_status FROM runs WHERE id = ?").get(started.runId);
            const context = JSON.parse(row.context);
            const jobs = await daemonJobs();
            const job = (jobs.jobs ?? []).find((j) => j.runId === started.runId);

            console.log(JSON.stringify({
              resultDir: started.workingDirectoryForHarness,
              contextDir: context.working_directory_for_harness,
              schedulingStatus: row.scheduling_status,
              hasJob: Boolean(job),
              jobRunId: job?.runId ?? null,
              jobAgentId: job?.agentId ?? null,
            }));
          } finally {
            shutdownAllCrons();
            stopDaemon({ homeDir: process.env.HOME });
          }
        `,
        {
          HOME: temp.homeDir,
          HARNESS_DIR: harnessDir,
          TAMANDUA_CONTROL_PORT: String(temp.controlPort),
        },
      );

      const expected = path.resolve(harnessDir);
      assert.equal(result.resultDir, expected);
      assert.equal(result.contextDir, expected);
      assert.equal(result.schedulingStatus, "active");
      assert.equal(result.hasJob, true);
      assert.equal(result.jobAgentId, `${"harness-explicit"}_dev`);
    } finally {
      try { await temp.controlHandle.close(); } catch {}
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("defaults workingDirectoryForHarness to the current cwd", async () => {
    const temp = await setupHarnessTempHome();

    try {
      const workflowId = "harness-default";
      writeMinimalWorkflow(temp.homeDir, workflowId);

      await temp.controlHandle.close();
      const result = runNodeScript(
        `
          import { runWorkflow } from "./dist/installer/run.js";
          import { getDb } from "./dist/db.js";
          import { shutdownAllCrons } from "./dist/installer/agent-scheduler.js";
          import { stopDaemon } from "./dist/server/daemonctl.js";

          try {
            const started = await runWorkflow({
              workflowId: "${workflowId}",
              taskTitle: "Use default harness cwd",
            });

            const db = getDb();
            const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(started.runId);
            const context = JSON.parse(row.context);

            console.log(JSON.stringify({
              cwd: process.cwd(),
              resultDir: started.workingDirectoryForHarness,
              contextDir: context.working_directory_for_harness,
            }));
          } finally {
            shutdownAllCrons();
            stopDaemon({ homeDir: process.env.HOME });
          }
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_CONTROL_PORT: String(temp.controlPort),
        },
      );

      const expected = path.resolve(repoRoot);
      assert.equal(result.cwd, expected);
      assert.equal(result.resultDir, expected);
      assert.equal(result.contextDir, expected);
    } finally {
      try { await temp.controlHandle.close(); } catch {}
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
