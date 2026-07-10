import fs from "node:fs";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const TMP_PREFIX = "tamandua-dashboard-run-tokens-";
const repoRoot = process.cwd();

function runNodeScript(script: string, env: Record<string, string>) {
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

describe("dashboard run token spend surfaces", () => {
  it("includes tokens_spent in /api/runs and /api/runs/:id payloads", () => {
    const temp = createTempHome(TMP_PREFIX);
    const result = runNodeScript(
      `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_tokens_api_001";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 7, 'wf-dashboard', 'Token visibility', 'running', '{}', 144, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES ('step_token_api_001', ?, 'implement', 'dev', 1, 'input', 'expects', 'done', ?, ?)"
          ).run(runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) {
            await once(server, "listening");
          }

          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Unexpected server address");
          }

          const baseUrl = "http://127.0.0.1:" + address.port;

          try {
            const listRes = await fetch(baseUrl + "/api/runs");
            const listBody = await listRes.json();
            const runRow = (listBody.runs || []).find((row) => row.id === runId);

            const detailRes = await fetch(baseUrl + "/api/runs/" + runId);
            const detailBody = await detailRes.json();

            const hasTokensOnEveryRun = (listBody.runs || []).every((row) =>
              Object.prototype.hasOwnProperty.call(row, "tokens_spent")
            );

            console.log(JSON.stringify({
              listStatus: listRes.status,
              detailStatus: detailRes.status,
              hasTokensOnEveryRun,
              listTokens: runRow?.tokens_spent ?? null,
              detailTokens: detailBody?.run?.tokens_spent ?? null,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
      { HOME: temp.homeDir },
    );

    assert.equal(result.listStatus, 200);
    assert.equal(result.detailStatus, 200);
    assert.equal(result.hasTokensOnEveryRun, true);
    assert.equal(result.listTokens, 144);
    assert.equal(result.detailTokens, 144);
  });

  it("renders a Tokens column with safe defaulting logic in the runs table", () => {
    const html = fs.readFileSync(path.join(repoRoot, "src", "server", "index.html"), "utf-8");

    assert.match(html, /<th>#<\/th><th>Run ID<\/th><th>Workflow<\/th><th>Task<\/th><th>Status<\/th><th>Progress<\/th><th>Tokens<\/th><th title="Suite test executions">Suite<\/th><th>Updated<\/th><th>Actions<\/th><th>View<\/th>/);
    assert.match(html, /const parsedTokens = Number\(r\.tokens_spent\);/);
    assert.match(html, /const tokensSpent = Number\.isFinite\(parsedTokens\) \? parsedTokens : 0;/);
    assert.match(html, /<td class="num">\$\{tokensSpent\}<\/td>/);
  });
});
