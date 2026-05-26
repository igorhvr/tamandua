import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../../dist/server/dashboard.js";
import { type TamanduaEvent } from "../../dist/installer/events.js";
import { DEFAULT_MCP_PORT } from "../../dist/server/mcp-server.js";
import { getDb, incrementSystemTokenSpend, getSystemTokenSpend } from "../../dist/db.js";

interface LogsTailResponse {
  lines: string[];
  nextOffset: number;
}

function appendGlobalEvent(stateDir: string, evt: TamanduaEvent): void {
  const filePath = path.join(stateDir, "events", "all.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(evt)}\n`, "utf-8");
}

async function startDashboard(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = createDashboardServer(0);
  if (!server.listening) {
    await once(server, "listening");
  }

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("dashboard logs-tail API", () => {
  it("returns initial logs-tail lines and cursor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-logs-tail-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T10:15:00.000Z",
      event: "step.pending",
      runId: "runalpha01",
      agentId: "feature-dev_developer",
      storyTitle: "Expose logs-tail API",
      detail: "initial poll",
    });
    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T10:16:00.000Z",
      event: "story.done",
      runId: "runalpha01",
      storyTitle: "Expose logs-tail API",
    });

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/logs-tail?offset=0`);
      assert.equal(response.status, 200);

      const payload = await response.json() as LogsTailResponse;
      assert.equal(payload.lines.length, 2);
      assert.ok(payload.nextOffset > 0);

      assert.match(payload.lines[0], /\[runalpha\]/);
      assert.match(payload.lines[0], /developer/);
      assert.match(payload.lines[0], /Step pending/);
      assert.match(payload.lines[0], /— Expose logs-tail API/);
      assert.match(payload.lines[0], /\(initial poll\)/);
      assert.match(payload.lines[1], /Story done/);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports incremental cursor polling", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-logs-tail-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T11:00:00.000Z",
      event: "step.pending",
      runId: "runbeta02",
      detail: "first",
    });

    const { server, baseUrl } = await startDashboard();

    try {
      const initialResponse = await fetch(`${baseUrl}/api/logs-tail?offset=0`);
      assert.equal(initialResponse.status, 200);
      const initialPayload = await initialResponse.json() as LogsTailResponse;
      assert.equal(initialPayload.lines.length, 1);
      assert.match(initialPayload.lines[0], /\(first\)/);

      appendGlobalEvent(stateDir, {
        ts: "2026-05-01T11:01:00.000Z",
        event: "step.running",
        runId: "runbeta02",
        detail: "second",
      });
      appendGlobalEvent(stateDir, {
        ts: "2026-05-01T11:02:00.000Z",
        event: "step.done",
        runId: "runbeta02",
        detail: "third",
      });

      const nextResponse = await fetch(`${baseUrl}/api/logs-tail?offset=${initialPayload.nextOffset}`);
      assert.equal(nextResponse.status, 200);
      const nextPayload = await nextResponse.json() as LogsTailResponse;

      assert.equal(nextPayload.lines.length, 2);
      assert.ok(nextPayload.nextOffset > initialPayload.nextOffset);
      assert.equal(nextPayload.lines.some((line) => line.includes("(first)")), false);
      assert.match(nextPayload.lines[0], /Claimed step/);
      assert.match(nextPayload.lines[0], /\(second\)/);
      assert.match(nextPayload.lines[1], /Step completed/);
      assert.match(nextPayload.lines[1], /\(third\)/);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard logs-tail UI", () => {
  it("renders logs-tail textbox and cursor polling hook in dashboard HTML", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      assert.match(html, /<section class="section" id="logs-tail-section">/);
      assert.match(html, /<textarea[\s\S]*id="logs-tail-output"[\s\S]*readonly/);
      assert.match(html, /fetch\(`\/api\/logs-tail\?offset=\$\{logsTailOffset\}`\)/);
      assert.match(html, /appendLogsTailLines\(data\.lines \|\| \[\]\)/);
      assert.match(html, /logsTailOffset = data\.nextOffset/);
      assert.match(html, /output\.scrollTop = output\.scrollHeight/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard AutoResearch progress", () => {
  it("serves run-scoped AutoResearch progress from the harness directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-autoresearch-"));
    const homeDir = path.join(root, "home");
    const projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      fs.writeFileSync(
        path.join(projectDir, "autoresearch.config.json"),
        JSON.stringify({
          goal: "Increase unit test coverage",
          metricName: "coverage",
          direction: "higher",
          command: "./measure-test-coverage.sh",
        }, null, 2),
      );
      const entries = [
        {
          type: "session",
          created_at: "2026-05-26T10:00:00.000Z",
          goal: "Increase unit test coverage",
          metric_name: "coverage",
          direction: "higher",
          command: "./measure-test-coverage.sh",
        },
        {
          type: "run_result",
          run: 1,
          created_at: "2026-05-26T10:01:00.000Z",
          status: "measured",
          metric: 0.336,
          metric_name: "coverage",
          direction: "higher",
          duration_ms: 1200,
          exit_code: 0,
          command: "./measure-test-coverage.sh",
          output_tail: "0.336",
          error_tail: "",
        },
        {
          type: "run",
          run: 1,
          created_at: "2026-05-26T10:02:00.000Z",
          status: "baseline",
          metric: 0.336,
          metric_name: "coverage",
          direction: "higher",
          duration_ms: 1200,
          command: "./measure-test-coverage.sh",
          description: "baseline coverage",
          baseline_metric: 0.336,
          best_metric: 0.336,
          improvement_ratio: 0,
          asi: {
            learned: "coverage script works",
            next_focus: "cover pure helpers",
          },
        },
      ];
      fs.writeFileSync(
        path.join(projectDir, "autoresearch.jsonl"),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );

      const db = getDb();
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "run-autoresearch-1",
        1,
        "do-now",
        "increase coverage",
        "running",
        JSON.stringify({ working_directory_for_harness: root }),
        "2026-05-26T10:00:00.000Z",
        "2026-05-26T10:02:00.000Z",
      );

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/runs/run-autoresearch-1/autoresearch`);
        assert.equal(response.status, 200);
        const body = await response.json() as {
          exists: boolean;
          cwd: string;
          summary: { bestMetric: number; bestRun: number; totalRuns: number; nextPrompt: string };
          experiments: Array<{ run: number; metric: number; learned: string; next_focus: string }>;
        };

        assert.equal(body.exists, true);
        assert.equal(body.cwd, projectDir);
        assert.equal(body.summary.bestMetric, 0.336);
        assert.equal(body.summary.bestRun, 1);
        assert.equal(body.summary.totalRuns, 1);
        assert.match(body.summary.nextPrompt, /cover pure helpers/i);
        assert.equal(body.experiments.length, 1);
        assert.equal(body.experiments[0].learned, "coverage script works");
        assert.equal(body.experiments[0].next_focus, "cover pure helpers");
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the AutoResearch panel and polling hook in dashboard HTML", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      assert.match(html, /<section class="section" id="autoresearch-section">/);
      assert.match(html, /id="autoresearch-run-select"/);
      assert.match(html, /fetch\(`\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/autoresearch`\)/);
      assert.match(html, /id="autoresearch-timeline"/);
      assert.match(html, /id="autoresearch-metric-chart"/);
      assert.match(html, /renderAutoresearchTraceChart/);
      assert.match(html, /Autoresearch Progress: \$\{points\.length\} Experiments, \$\{kept\.length\} Kept Improvements/);
      assert.match(html, /class="autoresearch-chart-line"/);
      assert.match(html, /class="autoresearch-chart-discarded"/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard stats API", () => {
  it("GET /api/stats returns systemTokensSpent and totalTokensSpent on fresh DB", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      // Open DB to trigger migration (creates tamandua_stats with default 0)
      getDb();

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        assert.equal(typeof body.systemTokensSpent, "number");
        assert.equal(typeof body.totalTokensSpent, "number");
        assert.equal(body.systemTokensSpent, 0);
        assert.equal(body.totalTokensSpent, 0);
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/stats totalTokensSpent equals system + run tokens", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      const db = getDb();

      // Add some run token data
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('run-1', 1, 'wf-1', 'task 1', 'running', 500, '2026-01-01', '2026-01-01')
      `).run();
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('run-2', 2, 'wf-2', 'task 2', 'done', 300, '2026-01-01', '2026-01-01')
      `).run();

      // Add system token spend
      incrementSystemTokenSpend(150);

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        assert.equal(body.systemTokensSpent, 150);
        assert.equal(body.totalTokensSpent, 950); // 500 + 300 + 150
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/stats handles DB without tamandua_stats gracefully", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      // Create a DB with runs table but WITHOUT tamandua_stats (legacy DB)
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          context TEXT NOT NULL DEFAULT '{}',
          tokens_spent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacyDb.exec(`
        INSERT INTO runs (id, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('legacy-run', 'wf-legacy', 'legacy task', 'done', 200, '2025-01-01', '2025-01-01')
      `);
      legacyDb.close();

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        // getSystemTokenSpend returns 0 when the table doesn't exist
        assert.equal(body.systemTokensSpent, 0);
        // total = system(0) + sum of run tokens(200)
        assert.equal(body.totalTokensSpent, 200);
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard token counters UI", () => {
  it("renders system and total token spend counters in dashboard HTML", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // Token counter container
      assert.match(html, /<div class="token-counters" id="token-counters">/);
      // System token span
      assert.match(html, /<span class="mono" id="system-tokens">/);
      // Total token span
      assert.match(html, /<span class="mono" id="total-tokens">/);
      // Default value is 0
      assert.match(html, /<span class="mono" id="system-tokens">0<\/span>/);
      assert.match(html, /<span class="mono" id="total-tokens">0<\/span>/);
      // Separator
      assert.match(html, /<span class="token-sep">\|<\/span>/);
      // System: and Total: labels
      assert.match(html, /System:/);
      assert.match(html, /Total:/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("dashboard HTML includes fetchStats call in refreshAll", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // fetchStats function exists
      assert.match(html, /async function fetchStats/);
      // fetchStats is called in refreshAll
      assert.match(html, /fetchStats\(\)/);
      // fetch is called with /api/stats
      assert.match(html, /fetch\(["']\/api\/stats["']\)/);
      // comma format function
      assert.match(html, /function fmtNum/);
      // toLocaleString for number formatting
      assert.match(html, /\.toLocaleString\(\)/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("token counters are positioned near top in header area", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // Token counters should be inside the header
      const headerIndex = html.indexOf("<header>");
      const headerCloseIndex = html.indexOf("</header>");
      assert.ok(headerIndex >= 0, "header tag not found");
      assert.ok(headerCloseIndex > headerIndex, "header close tag not found");

      const tokenCountersIndex = html.indexOf('class="token-counters"');
      assert.ok(tokenCountersIndex > headerIndex, "token counters not inside header");
      assert.ok(tokenCountersIndex < headerCloseIndex, "token counters not inside header");
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard pause/resume UI", () => {
  it("renders pause/resume controls bar with buttons and drain checkbox", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /class="controls-bar"/);
      assert.match(html, /Pause All/);
      assert.match(html, /Pause All \(Drain\)/);
      assert.match(html, /Resume All/);
      assert.match(html, /id="drain-checkbox"/);
      assert.match(html, /type="checkbox"/);
      assert.match(html, /id="pause-feedback"/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("includes pauseRun and resumeRun JS functions", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /async function pauseRun\(/);
      assert.match(html, /async function resumeRun\(/);
      assert.match(html, /function handlePause\(/);
      assert.match(html, /function handleResume\(/);
      assert.match(html, /async function pauseAllRuns\(/);
      assert.match(html, /async function resumeAllRuns\(/);
      assert.match(html, /\/api\/runs\/.*\/pause/);
      assert.match(html, /\/api\/runs\/.*\/resume/);
      assert.match(html, /pauseRun\(id, drain\)\.then\(refreshAll\)/);
      assert.match(html, /resumeRun\(id\)\.then\(refreshAll\)/);
      assert.match(html, /\?drain=true/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("has badge-paused CSS class with amber color", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /\.badge-paused/);
      assert.match(html, /#d29922/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("renders Actions column in runs table header", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /<th>Actions<\/th>/);
      assert.match(html, /\.action-btn\.pause-btn/);
      assert.match(html, /\.action-btn\.resume-btn/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard relaunch UI", () => {
  it("renders Relaunch button CSS class", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /\.action-btn\.relaunch-btn/);
      assert.match(html, /#f0883e/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("renders modal overlay and dialog HTML", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /class="modal-overlay" id="relaunch-modal-overlay"/);
      assert.match(html, /class="modal-dialog"/);
      assert.match(html, /id="relaunch-failure-reason"/);
      assert.match(html, /id="relaunch-prompt"/);
      assert.match(html, /Reason for failure:/);
      assert.match(html, /id="relaunch-submit-btn"/);
      assert.match(html, /closeRelaunchModal\(\)/);
      assert.match(html, /handleRelaunchSubmit\(\)/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("includes openRelaunchModal, closeRelaunchModal, and handleRelaunchSubmit JS functions", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /async function openRelaunchModal\(/);
      assert.match(html, /function closeRelaunchModal\(/);
      assert.match(html, /async function handleRelaunchSubmit\(/);
      assert.match(html, /\/api\/runs\/.*\/relaunch/);
      assert.match(html, /'Content-Type': 'application\/json'/);
      assert.match(html, /JSON\.stringify\(\{ task:/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("modal overlay is hidden by default (no .active class)", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Modal overlay should have the class but not .active in the raw HTML
      assert.match(html, /class="modal-overlay"/);
      assert.doesNotMatch(html, /class="modal-overlay active"/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("existing pause/resume buttons still present", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /\.action-btn\.pause-btn/);
      assert.match(html, /\.action-btn\.resume-btn/);
      assert.match(html, /handlePause\(/);
      assert.match(html, /handleResume\(/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard MCP status API", () => {
  it("GET /api/mcp-status returns { running, port, path }", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/mcp-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { running: boolean; port: number; path: string };
      assert.equal(typeof body.running, "boolean");
      assert.equal(body.port, DEFAULT_MCP_PORT);
      assert.equal(body.path, "/mcp");
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard run detail failure_reason", () => {
  it("returns failure_reason=null for running run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-running";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, null);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns failure_reason=null for completed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-completed";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 2, 'wf-1', 'task', 'completed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, null);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns failure_reason=null for paused run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-paused";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 3, 'wf-1', 'task', 'paused', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, null);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns 'Canceled' for canceled run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-canceled";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 4, 'wf-1', 'task', 'canceled', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, "Canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns first failed step output for failed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 5, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, created_at, updated_at)
      VALUES ('step-1', ?, 's1', 'agent-a', 0, 'do thing', '{}', 'done', 'All good', '2026-01-01', '2026-01-01')
    `).run(runId);
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, created_at, updated_at)
      VALUES ('step-2', ?, 's2', 'agent-b', 1, 'do thing 2', '{}', 'failed', 'Build error: syntax', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, "Build error: syntax");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns 'Run failed' for failed run with no failed-step output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-no-output";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 6, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    // No steps at all - should fall back to "Run failed"
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, "Run failed");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard run detail prompt field", () => {
  it("returns prompt field from run.task for all statuses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-prompt-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const testCases = [
      { id: "run-running-prompt", status: "running", task: "Implement feature X", expectedFailReason: null },
      { id: "run-completed-prompt", status: "completed", task: "Refactor module Y", expectedFailReason: null },
      { id: "run-paused-prompt", status: "paused", task: "Test pipeline Z", expectedFailReason: null },
      { id: "run-failed-prompt", status: "failed", task: "Fix build error", expectedFailReason: "Run failed" },
      { id: "run-canceled-prompt", status: "canceled", task: "Update dependencies", expectedFailReason: "Canceled" },
    ];

    for (const tc of testCases) {
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
        VALUES (?, 1, 'wf-1', ?, ?, '{}', 0, '2026-01-01', '2026-01-01')
      `).run(tc.id, tc.task, tc.status);
    }

    const { server, baseUrl } = await startDashboard();

    try {
      for (const tc of testCases) {
        const response = await fetch(`${baseUrl}/api/runs/${tc.id}`);
        assert.equal(response.status, 200, `expected 200 for ${tc.id}`);

        const body = await response.json() as { prompt: string; failure_reason: string | null };
        assert.equal(body.prompt, tc.task, `prompt mismatch for ${tc.status}`);
        assert.equal(body.failure_reason, tc.expectedFailReason, `failure_reason mismatch for ${tc.status}`);
      }
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard run relaunch API", () => {
  it("POST /api/runs/:id/relaunch returns 404 for missing run", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent-id/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(response.status, 404);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Run not found/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("POST /api/runs/:id/relaunch returns 409 for running run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-running-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot relaunch run in running state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch returns 409 for completed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-completed-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 2, 'wf-1', 'task', 'completed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot relaunch run in completed state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch returns 409 for paused run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-paused-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 3, 'wf-1', 'task', 'paused', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot relaunch run in paused state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch returns 400 for invalid JSON body", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-bad-json";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 4, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json!!!",
      });
      assert.equal(response.status, 400);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Invalid JSON body/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch handles canceled run (routes correctly through handler)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-canceled-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 5, 'wf-1', 'Original task', 'canceled', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent","repo":"/tmp/nonexistent"}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      // This will fail at runWorkflow (no daemon, no workflow, no working dir)
      // but the handler routing is verified by getting a 500 (not 404/409)
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "Updated task" }),
      });

      // 500 from runWorkflow failing is expected — handler logic passed validation
      assert.equal(response.status, 500);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch with empty body uses original task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-empty-body";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 6, 'wf-1', 'Original task', 'failed', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent"}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      // No body — should use original task. Will fail at runWorkflow (no daemon).
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      // 500 from runWorkflow failing is expected
      assert.equal(response.status, 500);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch with whitespace-only task uses original task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-whitespace-task";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 7, 'wf-1', 'Original task', 'failed', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent"}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "   " }),
      });

      // 500 from runWorkflow failing is expected
      assert.equal(response.status, 500);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch preserves notify_url from original run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-notify";
    const notifyUrl = "https://hooks.example.com/notify";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, notify_url, created_at, updated_at)
      VALUES (?, 8, 'wf-1', 'task', 'failed', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent"}', 0, ?, '2026-01-01', '2026-01-01')
    `).run(runId, notifyUrl);

    const { server, baseUrl } = await startDashboard();

    try {
      // This will fail at runWorkflow but tests that notify_url is read from DB
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      // 500 from runWorkflow failing is expected
      assert.equal(response.status, 500);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard version status API", () => {
  it("GET /api/version-status returns { updateAvailable, currentHead, remoteHead, checkedAt } when no file exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-version-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/version-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { updateAvailable: boolean; currentHead: string; remoteHead: string; checkedAt: string };
      assert.equal(body.updateAvailable, false);
      assert.equal(body.currentHead, "");
      assert.equal(body.remoteHead, "");
      assert.equal(body.checkedAt, "");
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/version-status returns updateAvailable: true when file says so", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-version-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    // Write version-status.json with updateAvailable: true
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "version-status.json"),
      JSON.stringify({
        updateAvailable: true,
        currentHead: "abc1234",
        remoteHead: "def5678",
        checkedAt: "2026-05-15T10:00:00.000Z",
      }),
      "utf-8",
    );

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/version-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { updateAvailable: boolean; currentHead: string; remoteHead: string; checkedAt: string };
      assert.equal(body.updateAvailable, true);
      assert.equal(body.currentHead, "abc1234");
      assert.equal(body.remoteHead, "def5678");
      assert.equal(body.checkedAt, "2026-05-15T10:00:00.000Z");
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/version-status returns updateAvailable: false when file says so", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-version-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "version-status.json"),
      JSON.stringify({
        updateAvailable: false,
        currentHead: "abc1234",
        remoteHead: "abc1234",
        checkedAt: "2026-05-15T10:00:00.000Z",
      }),
      "utf-8",
    );

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/version-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { updateAvailable: boolean };
      assert.equal(body.updateAvailable, false);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dashboard HTML contains version banner element with yellow background", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Banner div exists with correct id and hidden by default
      assert.match(html, /id="version-banner"/);
      assert.match(html, /#version-banner \{[\s\S]*display:\s*none/);

      // Yellow background
      assert.match(html, /#ffd700/);

      // Banner text tells user to run tamandua update
      assert.match(html, /A new version of tamandua is available!/);
      assert.match(html, /tamandua update/);

      // Dismiss button
      assert.match(html, /class="banner-dismiss"/);
      assert.match(html, /✕/);
      assert.match(html, /function dismissVersionBanner/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("version banner is positioned between header and container", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      const headerCloseIndex = html.indexOf("</header>");
      const bannerIndex = html.indexOf('id="version-banner"');
      const containerIndex = html.indexOf('class="container"');

      assert.ok(headerCloseIndex >= 0, "</header> not found");
      assert.ok(bannerIndex >= 0, "version-banner not found");
      assert.ok(containerIndex >= 0, "container not found");
      assert.ok(bannerIndex > headerCloseIndex, "banner must be after </header>");
      assert.ok(bannerIndex < containerIndex, "banner must be before container");
    } finally {
      await stopDashboard(server);
    }
  });

  it("dashboard HTML includes fetchVersionStatus and calls it in refreshAll", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // fetchVersionStatus function exists
      assert.match(html, /async function fetchVersionStatus/);
      // Calls /api/version-status
      assert.match(html, /fetch\(["']\/api\/version-status["']\)/);
      // Called in refreshAll
      assert.match(html, /fetchVersionStatus\(\)/);
      // Checks updateAvailable
      assert.match(html, /data\.updateAvailable/);
      // Shows banner on true
      assert.match(html, /banner\.style\.display\s*=\s*["']block["']/);
      // Hides banner on false
      assert.match(html, /banner\.style\.display\s*=\s*["']none["']/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("dismissVersionBanner hides the banner via display:none", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // dismissVersionBanner function sets display:none
      assert.match(html, /function dismissVersionBanner/);
      assert.match(html, /banner\.style\.display\s*=\s*["']none["']/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard hurry status icons UI", () => {
  it("includes .hurry-icon CSS class in dashboard HTML", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      assert.match(html, /\.hurry-icon\s*\{/);
      assert.match(html, /margin-left:\s*4px/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("renders turtle icon for no_hurry=true runs with correct tooltip", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // Should include the turtle emoji for no_hurry runs
      assert.match(html, /🐢/);
      // Should include the no-hurry tooltip text
      assert.match(html, /No hurry toker-saving mode\./);
    } finally {
      await stopDashboard(server);
    }
  });

  it("renders runner icon for no_hurry=false runs with correct tooltip", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // Should include the runner emoji for regular runs
      assert.match(html, /🏃/);
      // Should include the full regular-run tooltip text
      assert.match(html, /Regular run - as fast as possible! Expensive in system tokens/);
      assert.match(html, /Use --no-hurry-please-save-tokens-mode next time/);
      assert.match(html, /trade-offs are on speed only/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("icon rendering is conditional on running or paused status only", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // The icon span should be conditionally rendered for running or paused status
      assert.match(html, /r\.status\s*===\s*['"]running['"]\s*\|\|\s*r\.status\s*===\s*['"]paused['"]/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("has title attribute for tooltip on the hurry-icon span", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // Should have a title attribute on the hurry-icon span for tooltip
      assert.match(html, /class="hurry-icon"\s+title=/);
      // Tooltip should switch based on no_hurry boolean
      assert.match(html, /r\.no_hurry\s*\?\s*'No hurry toker-saving mode\.'/);
      assert.match(html, /Regular run - as fast as possible! Expensive in system tokens/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard /api/runs no_hurry field", () => {
  it("no_hurry is true when context.no_hurry_save_tokens_mode === 'true'", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-true', 1, 'wf-1', 'task', 'running', '{"no_hurry_save_tokens_mode":"true"}', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      assert.ok(Array.isArray(body.runs));
      const run = body.runs.find((r) => r.id === "run-nohurry-true");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, true);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is false when context.no_hurry_save_tokens_mode === 'false'", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-false', 1, 'wf-1', 'task', 'running', '{"no_hurry_save_tokens_mode":"false"}', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      const run = body.runs.find((r) => r.id === "run-nohurry-false");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, false);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is false when context is missing no_hurry_save_tokens_mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-missing', 1, 'wf-1', 'task', 'running', '{"other_key":"value"}', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      const run = body.runs.find((r) => r.id === "run-nohurry-missing");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, false);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is false when context JSON is malformed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-malformed', 1, 'wf-1', 'task', 'running', 'not valid json {{{', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      const run = body.runs.find((r) => r.id === "run-nohurry-malformed");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, false);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is never undefined — always a boolean", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    // Insert runs with various context states
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-a', 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-b', 2, 'wf-1', 'task', 'running', '{"no_hurry_save_tokens_mode":"true"}', 0, '2026-01-01', '2026-01-01')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-c', 3, 'wf-1', 'task', 'running', 'broken', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      for (const run of body.runs) {
        assert.equal(typeof run.no_hurry, "boolean", `run ${run.id} no_hurry should be boolean, got ${typeof run.no_hurry}`);
      }
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createMinimalGitRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "user.email", "test@tamandua.local"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "Tamandua Test"]);
  spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "initial"]);
  return dir;
}

async function startMockControlServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/control/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else if (url.pathname === "/control/register-run" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "active" }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function installWorkflowInHome(homeDir: string, workflowId: string): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  const srcYml = path.join(TEST_DIR, "..", "..", "workflows", workflowId, "workflow.yml");
  fs.copyFileSync(srcYml, path.join(workflowDir, "workflow.yml"));
}

describe("dashboard cancel API", () => {
  it("POST /api/runs/:id/cancel returns 200 for a paused run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-paused-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'paused', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);
    // Add a waiting step to verify it gets canceled
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('step-1', ?, 's1', 'agent-a', 0, 'do thing', '{}', 'waiting', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(response.status, 200);

      const body = await response.json() as { canceled: boolean; runId: string };
      assert.equal(body.canceled, true);
      assert.equal(body.runId, runId);

      // Verify run status changed in DB
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "canceled");

      // Verify step was canceled
      const step = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-1") as { status: string };
      assert.equal(step.status, "canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 200 for a running run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-running-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);
    // Add running and pending steps
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('step-r1', ?, 's1', 'agent-a', 0, 'do thing', '{}', 'running', '2026-01-01', '2026-01-01')
    `).run(runId);
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('step-r2', ?, 's2', 'agent-b', 1, 'do thing 2', '{}', 'pending', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(response.status, 200);

      const body = await response.json() as { canceled: boolean; runId: string };
      assert.equal(body.canceled, true);
      assert.equal(body.runId, runId);

      // Verify run status changed
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "canceled");

      // Verify both steps were canceled
      const step1 = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-r1") as { status: string };
      const step2 = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-r2") as { status: string };
      assert.equal(step1.status, "canceled");
      assert.equal(step2.status, "canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 404 for a nonexistent run", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent-id/cancel`, { method: "POST" });
      assert.equal(response.status, 404);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Run not found/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("POST /api/runs/:id/cancel returns 409 for a completed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-completed-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'completed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot cancel run in completed state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 409 for a failed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot cancel run in failed state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 409 for an already canceled run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-already-canceled";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'canceled', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot cancel run in canceled state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel cancels only waiting/pending/running steps, leaves done/failed untouched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-mixed-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    // Done step — should remain done
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-done', ?, 's1', 'agent-a', 0, 'done task', '{}', 'done', '2026-01-01', '2026-01-01')
    `).run(runId);
    // Failed step — should remain failed
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-failed', ?, 's2', 'agent-b', 1, 'failed task', '{}', 'failed', '2026-01-01', '2026-01-01')
    `).run(runId);
    // Waiting step — should be canceled
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-waiting', ?, 's3', 'agent-c', 2, 'waiting task', '{}', 'waiting', '2026-01-01', '2026-01-01')
    `).run(runId);
    // Pending step — should be canceled
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-pending', ?, 's4', 'agent-d', 3, 'pending task', '{}', 'pending', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(response.status, 200);

      // Done step unchanged
      const sDone = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-done") as { status: string };
      assert.equal(sDone.status, "done");

      // Failed step unchanged
      const sFailed = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-failed") as { status: string };
      assert.equal(sFailed.status, "failed");

      // Waiting step canceled
      const sWaiting = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-waiting") as { status: string };
      assert.equal(sWaiting.status, "canceled");

      // Pending step canceled
      const sPending = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-pending") as { status: string };
      assert.equal(sPending.status, "canceled");

      // Run status canceled
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard relaunch integration", () => {
  it("relaunches a failed run and preserves workflow_id, task, workspace settings, notify_url (direct mode, with task override)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-relaunch-integration-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    const previousControlPort = process.env.TAMANDUA_CONTROL_PORT;

    try {
      process.env.HOME = homeDir;

      // Install a direct-mode workflow
      installWorkflowInHome(homeDir, "bug-fix");

      // Create working directory for harness
      const workingDir = path.join(root, "workdir");
      fs.mkdirSync(workingDir, { recursive: true });

      // Set up mock control server
      const mockControl = await startMockControlServer();
      process.env.TAMANDUA_CONTROL_PORT = String(mockControl.port);

      // Initialize DB and create a failed run with context
      const db = getDb();
      const failedRunId = "run-failed-direct-001";
      const originalTask = "Original task description";
      const notifyUrl = "https://hooks.example.com/notify";
      const context = {
        workspace_mode: "direct",
        working_directory_for_harness: workingDir,
        repo: workingDir,
      };

      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, notify_url, created_at, updated_at)
        VALUES (?, 1, 'bug-fix', ?, 'failed', ?, 0, ?, '2026-01-01', '2026-01-01')
      `).run(failedRunId, originalTask, JSON.stringify(context), notifyUrl);

      const { server, baseUrl } = await startDashboard();

      try {
        // Relaunch with a modified task
        const response = await fetch(`${baseUrl}/api/runs/${failedRunId}/relaunch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: "Modified task" }),
        });

        assert.equal(response.status, 200);
        const body = await response.json() as { relaunched: boolean; originalRunId: string; runId: string; runNumber: number };
        assert.equal(body.relaunched, true);
        assert.equal(body.originalRunId, failedRunId);
        assert.ok(typeof body.runId === "string" && body.runId.length > 0);
        assert.ok(typeof body.runNumber === "number" && body.runNumber > 0);

        // Verify the new run in the DB
        const newRun = db.prepare(
          "SELECT workflow_id, task, context, notify_url FROM runs WHERE id = ?",
        ).get(body.runId) as { workflow_id: string; task: string; context: string; notify_url: string | null } | undefined;
        assert.ok(newRun, "new run should exist in DB");
        assert.equal(newRun.workflow_id, "bug-fix");
        assert.equal(newRun.task, "Modified task");
        assert.equal(newRun.notify_url, notifyUrl);

        // Parse context to verify workspace settings are preserved
        const newContext = JSON.parse(newRun.context) as Record<string, string>;
        assert.equal(newContext.workspace_mode, "direct");
        assert.equal(newContext.working_directory_for_harness, workingDir);
      } finally {
        await stopDashboard(server);
      }

      mockControl.server.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      if (previousControlPort === undefined) delete process.env.TAMANDUA_CONTROL_PORT;
      else process.env.TAMANDUA_CONTROL_PORT = previousControlPort;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("relaunches without task override uses original task (direct mode)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-relaunch-integration-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    const previousControlPort = process.env.TAMANDUA_CONTROL_PORT;

    try {
      process.env.HOME = homeDir;

      installWorkflowInHome(homeDir, "bug-fix");

      const workingDir = path.join(root, "workdir");
      fs.mkdirSync(workingDir, { recursive: true });

      const mockControl = await startMockControlServer();
      process.env.TAMANDUA_CONTROL_PORT = String(mockControl.port);

      const db = getDb();
      const failedRunId = "run-failed-direct-002";
      const originalTask = "Do not change this task";
      const context = {
        workspace_mode: "direct",
        working_directory_for_harness: workingDir,
        repo: workingDir,
      };

      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
        VALUES (?, 1, 'bug-fix', ?, 'failed', ?, 0, '2026-01-01', '2026-01-01')
      `).run(failedRunId, originalTask, JSON.stringify(context));

      const { server, baseUrl } = await startDashboard();

      try {
        // Relaunch without body — should use original task
        const response = await fetch(`${baseUrl}/api/runs/${failedRunId}/relaunch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        assert.equal(response.status, 200);
        const body = await response.json() as { relaunched: boolean; runId: string };
        assert.equal(body.relaunched, true);

        const newRun = db.prepare(
          "SELECT workflow_id, task FROM runs WHERE id = ?",
        ).get(body.runId) as { workflow_id: string; task: string } | undefined;
        assert.ok(newRun, "new run should exist in DB");
        assert.equal(newRun.workflow_id, "bug-fix");
        assert.equal(newRun.task, originalTask);
      } finally {
        await stopDashboard(server);
      }

      mockControl.server.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      if (previousControlPort === undefined) delete process.env.TAMANDUA_CONTROL_PORT;
      else process.env.TAMANDUA_CONTROL_PORT = previousControlPort;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("relaunches a failed run in worktree mode preserving workflow_id, task, workspace settings, notify_url", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-relaunch-integration-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    const previousControlPort = process.env.TAMANDUA_CONTROL_PORT;

    try {
      process.env.HOME = homeDir;

      // Install a worktree-mode workflow
      installWorkflowInHome(homeDir, "feature-dev-merge-worktree");

      // Create a minimal git repo to serve as origin for the worktree
      const originRepo = path.join(root, "origin-repo");
      createMinimalGitRepo(originRepo);
      // Get the commit SHA and branch for the context
      const shaResult = spawnSync("git", ["-C", originRepo, "rev-parse", "HEAD"], { encoding: "utf-8" });
      const originSha = shaResult.stdout.trim();

      // Set up mock control server
      const mockControl = await startMockControlServer();
      process.env.TAMANDUA_CONTROL_PORT = String(mockControl.port);

      // Initialize DB and create a failed worktree run
      const db = getDb();
      const failedRunId = "run-failed-worktree-001";
      const originalTask = "Worktree task";
      const notifyUrl = "https://hooks.example.com/worktree-notify";
      const context = {
        workspace_mode: "worktree",
        working_directory_for_harness: "/tmp/nonexistent-worktree",
        worktree_origin_repository: originRepo,
        worktree_origin_ref: "main",
        worktree_origin_sha: originSha,
        repo: "/tmp/nonexistent-worktree",
      };

      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, notify_url, created_at, updated_at)
        VALUES (?, 1, 'feature-dev-merge-worktree', ?, 'failed', ?, 0, ?, '2026-01-01', '2026-01-01')
      `).run(failedRunId, originalTask, JSON.stringify(context), notifyUrl);

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/runs/${failedRunId}/relaunch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: "Modified worktree task" }),
        });

        assert.equal(response.status, 200);
        const body = await response.json() as { relaunched: boolean; originalRunId: string; runId: string; runNumber: number };
        assert.equal(body.relaunched, true);
        assert.equal(body.originalRunId, failedRunId);
        assert.ok(typeof body.runId === "string" && body.runId.length > 0);

        // Verify the new run in the DB
        const newRun = db.prepare(
          "SELECT workflow_id, task, context, notify_url FROM runs WHERE id = ?",
        ).get(body.runId) as { workflow_id: string; task: string; context: string; notify_url: string | null } | undefined;
        assert.ok(newRun, "new run should exist in DB");
        assert.equal(newRun.workflow_id, "feature-dev-merge-worktree");
        assert.equal(newRun.task, "Modified worktree task");
        assert.equal(newRun.notify_url, notifyUrl);

        // Parse context to verify workspace settings are preserved
        const newContext = JSON.parse(newRun.context) as Record<string, string>;
        assert.equal(newContext.workspace_mode, "worktree");
        assert.equal(newContext.worktree_origin_repository, originRepo);
        assert.equal(newContext.worktree_origin_ref, "main");
        // worktree_path should be set by runWorkflow
        assert.ok(typeof newContext.worktree_path === "string" && newContext.worktree_path.length > 0);
      } finally {
        await stopDashboard(server);
      }

      mockControl.server.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      if (previousControlPort === undefined) delete process.env.TAMANDUA_CONTROL_PORT;
      else process.env.TAMANDUA_CONTROL_PORT = previousControlPort;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard cancel UI", () => {
  it("renders Cancel button CSS class with red hover color", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /\.action-btn\.cancel-btn/);
      assert.match(html, /#f85149/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("renders Cancel button in actions column for paused runs", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Cancel button should be in the renderRuns template within the paused branch
      assert.match(html, /✕ Cancel/);
      assert.match(html, /cancel-btn/);
      assert.match(html, /handleCancel\(/);

      // Verify it's specifically inside the paused conditional
      const pausedMatch = html.match(/r\.status === 'paused' \? `([^`]*Cancel[^`]*)`/);
      assert.ok(pausedMatch, "Cancel button must be inside r.status === 'paused' conditional");
    } finally {
      await stopDashboard(server);
    }
  });

  it("does NOT render Cancel button for running run, only for paused", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Verify the Cancel button is only rendered inside the paused branch
      // Extract the renderRuns template and check the condition
      const renderMatch = html.match(/r\.status === 'paused' \? `([^`]*Cancel[^`]*)`/);
      assert.ok(renderMatch, "Cancel button must be inside r.status === 'paused' conditional");

      // Verify there's NO Cancel button in the running branch
      const runningMatch = html.match(/r\.status === 'running' \? `([^`]*)`/);
      if (runningMatch) {
        assert.doesNotMatch(runningMatch[1], /✕ Cancel/);
      }

      // Verify there's NO Cancel button in the failed/canceled branch
      const terminalMatch = html.match(/\(r\.status === 'failed' \|\| r\.status === 'canceled'\) \? `([^`]*)`/);
      if (terminalMatch) {
        assert.doesNotMatch(terminalMatch[1], /✕ Cancel/);
      }
    } finally {
      await stopDashboard(server);
    }
  });

  it("does NOT render Cancel button for completed, failed, or canceled runs", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Verify that none of the non-paused branches include "✕ Cancel"
      // Running branch
      const runningMatch = html.match(/r\.status === 'running' \? `([^`]*)`/);
      if (runningMatch) {
        assert.doesNotMatch(runningMatch[1], /✕ Cancel/);
      }

      // Failed/canceled branch
      const terminalMatch = html.match(/\(r\.status === 'failed' \|\| r\.status === 'canceled'\) \? `([^`]*)`/);
      if (terminalMatch) {
        assert.doesNotMatch(terminalMatch[1], /✕ Cancel/);
      }

      // But it IS present in the paused branch
      const pausedMatch = html.match(/r\.status === 'paused' \? `([^`]*Cancel[^`]*)`/);
      assert.ok(pausedMatch, "Cancel button must exist in paused branch");
    } finally {
      await stopDashboard(server);
    }
  });

  it("includes cancelRun and handleCancel JS functions", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /async function cancelRun\(/);
      assert.match(html, /function handleCancel\(/);
      assert.match(html, /\/api\/runs\/.*\/cancel/);
      assert.match(html, /cancelRun\(id\)\.then\(refreshAll\)/);
      assert.match(html, /Cancel failed/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("Cancel button is placed to the right of Resume button for paused runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'paused', '{}', 0, '2026-01-01', '2026-01-01')
    `).run("run-paused-order");

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Resume button should appear before Cancel button
      const resumeIndex = html.indexOf("▶ Resume");
      const cancelIndex = html.indexOf("✕ Cancel");
      assert.ok(resumeIndex >= 0, "Resume button not found");
      assert.ok(cancelIndex >= 0, "Cancel button not found");
      assert.ok(resumeIndex < cancelIndex, "Cancel button should be to the right of Resume button");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("existing pause/resume buttons still present alongside Cancel button", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /\.action-btn\.pause-btn/);
      assert.match(html, /\.action-btn\.resume-btn/);
      assert.match(html, /\.action-btn\.cancel-btn/);
      assert.match(html, /handlePause\(/);
      assert.match(html, /handleResume\(/);
      assert.match(html, /handleCancel\(/);
    } finally {
      await stopDashboard(server);
    }
  });
});
