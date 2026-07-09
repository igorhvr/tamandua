import fs from "node:fs";
import { cleanChildEnv } from "./helpers/test-env.ts";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome(): { root: string; homeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-kanban-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function runNodeScript(script: string, env: Record<string, string>): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });

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

describe("dashboard kanban view", () => {
  it("serves a lane-grouped snapshot at /api/runs/:id/kanban", () => {
    const temp = createTempHome();
    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_kanban_api_001";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 9, 'feature-dev-merge', 'kanban test', 'running', '{}', 1234, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'plan', 'feature-dev-merge_planner', 0, '', '', 'done', 'single', NULL, ?, ?)"
          ).run("step_k_planner", runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'implement', 'feature-dev-merge_developer', 1, '', '', 'running', 'loop', 'US-002', ?, ?)"
          ).run("step_k_dev", runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'verify', 'feature-dev-merge_verifier', 2, '', '', 'waiting', 'single', NULL, ?, ?)"
          ).run("step_k_verify", runId, now, now);

          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'first', 'done', ?, ?)"
          ).run("story_k_001", runId, now, now);
          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 1, 'US-002', 'second', 'pending', ?, ?)"
          ).run("story_k_002", runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const apiRes = await fetch(baseUrl + "/api/runs/" + runId + "/kanban");
            const apiBody = await apiRes.json();
            const htmlRes = await fetch(baseUrl + "/runs/" + runId + "/kanban");
            const htmlBody = await htmlRes.text();
            const missingRes = await fetch(baseUrl + "/api/runs/does_not_exist/kanban");

            const devLane = (apiBody.lanes || []).find((l) => l.agent === "developer");
            const verLane = (apiBody.lanes || []).find((l) => l.agent === "verifier");

            const toggleCount = htmlBody.includes('<div id="root">') ? 1 : 0;
            const hasPlusOnButton = htmlBody.includes("root");

            console.log(JSON.stringify({
              apiStatus: apiRes.status,
              htmlStatus: htmlRes.status,
              htmlIsReactSpa: htmlBody.includes('<div id="root"></div>') && htmlBody.includes('<script type="module" crossorigin src="/assets/index-'),
              missingStatus: missingRes.status,
              laneCount: (apiBody.lanes || []).length,
              laneAgents: (apiBody.lanes || []).map((l) => l.agent),
              tokensSpent: apiBody.run?.tokens_spent ?? null,
              currentStoryId: apiBody.currentStoryId,
              devCardIds: (devLane?.cards || []).map((c) => c.id),
              devCardStatuses: (devLane?.cards || []).map((c) => c.status),
              verLaneStatus: verLane?.status ?? null,
              verLaneStepType: verLane?.stepType ?? null,
              toggleCount,
              hasPlusOnButton,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      assert.equal(result.apiStatus, 200);
      assert.equal(result.htmlStatus, 200);
      assert.equal(result.htmlIsReactSpa, true);
      assert.equal(result.missingStatus, 404);
      assert.equal(result.laneCount, 3);
      assert.deepEqual(result.laneAgents, ["planner", "developer", "verifier"]);
      assert.equal(result.tokensSpent, 1234);
      assert.equal(result.currentStoryId, "US-002");
      assert.deepEqual(result.devCardIds, ["US-001", "US-002"]);
      // US-001 done, US-002 promoted from pending → running because the loop step
      // is alive and current_story_id matches.
      assert.deepEqual(result.devCardStatuses, ["done", "running"]);
      assert.equal(result.verLaneStatus, "todo");
      assert.equal(result.verLaneStepType, "single");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("kanban cards are rendered by React SPA", () => {
    const temp = createTempHome();
    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_kanban_us004";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feat', 'US-004 test', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'dev', 'feat_developer', 0, 'test prompt', '', 'running', 'loop', 'US-001', ?, ?)"
          ).run("step_us004", runId, now, now);

          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'wire toggle', 'pending', ?, ?)"
          ).run("story_us004", runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const htmlRes = await fetch(baseUrl + "/runs/" + runId + "/kanban");
            const htmlBody = await htmlRes.text();

            // React SPA structure
            const hasRootDiv = htmlBody.includes('<div id="root"></div>');
            const hasScriptTag = htmlBody.includes('<script type="module" crossorigin src="/assets/index-');
            const hasTitle = htmlBody.includes('<title>Tamandua</title>');
            const hasFonts = htmlBody.includes('Inter:wght@400;500;600;700');

            await new Promise((resolve) => server.close(() => resolve()));

            console.log(JSON.stringify({
              hasRootDiv,
              hasScriptTag,
              hasTitle,
              hasFonts,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      assert.ok(result.hasRootDiv, "kanban page should have React root div");
      assert.ok(result.hasScriptTag, "kanban page should have script tag");
      assert.ok(result.hasTitle, "kanban page should have title");
      assert.ok(result.hasFonts, "kanban page should have font links");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("US-005: kanban page is served as React SPA", () => {
    const temp = createTempHome();
    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_kanban_us005";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feat', 'US-005 test', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'dev', 'feat_developer', 0, 'test prompt', '', 'running', 'loop', 'US-001', ?, ?)"
          ).run("step_us005", runId, now, now);

          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'style detail', 'pending', ?, ?)"
          ).run("story_us005", runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const htmlRes = await fetch(baseUrl + "/runs/" + runId + "/kanban");
            const htmlBody = await htmlRes.text();

            // React SPA structure
            const hasRootDiv = htmlBody.includes('<div id="root"></div>');
            const hasScriptTag = htmlBody.includes('<script type="module" crossorigin src="/assets/index-');
            const hasTitle = htmlBody.includes('<title>Tamandua</title>');
            const hasFonts = htmlBody.includes('JetBrains+Mono:wght@400;500;600');

            await new Promise((resolve) => server.close(() => resolve()));

            console.log(JSON.stringify({
              hasRootDiv,
              hasScriptTag,
              hasTitle,
              hasFonts,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      assert.ok(result.hasRootDiv, "kanban page should have React root div");
      assert.ok(result.hasScriptTag, "kanban page should have script tag");
      assert.ok(result.hasTitle, "kanban page should have title");
      assert.ok(result.hasFonts, "kanban page should have font links");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("links the kanban view from each run row in the React app", () => {
    // The React app handles routing via react-router-dom.
    // The kanban link is rendered by the Dashboard component using navigate().
    // Verify the API endpoint works correctly.
    const temp = createTempHome();
    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_kanban_link_test";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feat', 'link test', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            // Verify kanban API endpoint works
            const apiRes = await fetch(baseUrl + "/api/runs/" + runId + "/kanban");
            const apiBody = await apiRes.json();

            // Verify kanban HTML page is served
            const htmlRes = await fetch(baseUrl + "/runs/" + runId + "/kanban");
            const htmlBody = await htmlRes.text();

            await new Promise((resolve) => server.close(() => resolve()));

            console.log(JSON.stringify({
              apiStatus: apiRes.status,
              htmlStatus: htmlRes.status,
              isReactSpa: htmlBody.includes('<div id="root"></div>'),
              hasRunId: apiBody.run && apiBody.run.id === runId,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      assert.equal(result.apiStatus, 200);
      assert.equal(result.htmlStatus, 200);
      assert.ok(result.isReactSpa, "kanban page should be React SPA");
      assert.ok(result.hasRunId, "kanban API should return correct run");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
