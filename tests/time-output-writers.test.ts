/**
 * TIME-OUTPUT US-007 — canonical ISO-Z instants at the event and report
 * writer chokepoints.
 *
 * Every instant Tamandua serializes outside the browser must be ISO-8601 UTC
 * with an explicit `Z`. This file pins:
 *
 *   - `emitEventCore` normalizes `evt.ts` through `formatInstant(..., 'iso')`
 *     before writing, and falls back to a fresh canonical `nowIso()` when the
 *     ts is missing/unparseable (never a naive or garbage string).
 *   - the "current instant" report/contract writers (catalog stamp, kanban
 *     generatedAt, medic checkedAt, daemon heartbeat marker, autoresearch
 *     created_at) produce canonical ISO-Z values.
 *
 * Parallel lane: pure fs/sqlite imports, no child_process and no daemon spawns.
 * The `nowIso()`-only writers whose source modules own a spawn dependency
 * (autoresearch, medic-cron) are pinned with static source assertions here and
 * exercised at runtime by their own serial-lane suites.
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../dist/lib/temp-dir.js";
import { emitEvent, getRunEvents, type TamanduaEvent } from "../dist/installer/events.js";
import { generateCatalogStamp } from "../dist/installer/catalog-version.js";
import { buildKanbanSnapshot } from "../dist/server/kanban-data.js";
import {
  readHeartbeatMarker,
  touchHeartbeat,
  writeHeartbeatMarker,
} from "../dist/server/daemon-lifecycle.js";
import { getMedicStatus, runMedicCheck } from "../dist/medic/medic.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf-8");
}

// ── Event writer chokepoint ─────────────────────────────────────────

describe("TIME-OUTPUT US-007: event writer instants", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    stateDir = tamanduaTempDir("tamandua-tow-events-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
    // Keep the fire-and-forget webhook DB lookup off the real state dir.
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function persistedTs(runId: string): string {
    const events = getRunEvents(runId);
    assert.ok(events.length > 0, `expected at least one event for ${runId}`);
    return events[0]!.ts;
  }

  it("normalizes a legacy naive ts to canonical ISO-Z before writing", () => {
    emitEvent({ ts: "2026-09-15 22:00:00", event: "step.completed", runId: "run-naive" });
    const ts = persistedTs("run-naive");
    assert.equal(ts, "2026-09-15T22:00:00.000Z");
    assert.match(ts, ISO_Z_RE);
  });

  it("normalizes a numeric-offset ts to canonical UTC ISO-Z", () => {
    emitEvent({
      ts: "2026-09-15T22:00:00+03:00",
      event: "step.completed",
      runId: "run-offset",
    });
    assert.equal(persistedTs("run-offset"), "2026-09-15T19:00:00.000Z");
  });

  it("leaves an already-canonical ISO-Z ts unchanged", () => {
    emitEvent({
      ts: "2026-09-15T22:00:00.000Z",
      event: "step.completed",
      runId: "run-canonical",
    });
    assert.equal(persistedTs("run-canonical"), "2026-09-15T22:00:00.000Z");
  });

  it("falls back to a fresh canonical ISO-Z now when ts is missing", () => {
    const before = Date.now();
    emitEvent({ event: "step.completed", runId: "run-missing" } as TamanduaEvent);
    const ts = persistedTs("run-missing");
    assert.match(ts, ISO_Z_RE);
    const ms = Date.parse(ts);
    assert.ok(ms >= before - 2_000 && ms <= Date.now() + 2_000, `now fallback off: ${ts}`);
  });

  it("falls back to a fresh canonical ISO-Z now for an unparseable ts", () => {
    emitEvent({
      ts: "not-a-date",
      event: "step.completed",
      runId: "run-garbage",
    });
    const ts = persistedTs("run-garbage");
    assert.match(ts, ISO_Z_RE);
    assert.ok(!ts.includes("not-a-date"), `garbage ts persisted: ${ts}`);
  });

  it("persists the normalized ts to the global events file too", () => {
    emitEvent({ ts: "2026-09-15 22:00:00", event: "step.completed", runId: "run-global" });
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    const lines = fs
      .readFileSync(globalFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TamanduaEvent);
    const evt = lines.find((e) => e.runId === "run-global");
    assert.ok(evt, "event should be in the global stream");
    assert.equal(evt!.ts, "2026-09-15T22:00:00.000Z");
  });
});

// ── Current-instant report / contract writers ───────────────────────

describe("TIME-OUTPUT US-007: report/contract writer instants", () => {
  it("catalog stamp installedAt is canonical ISO-Z", () => {
    const before = Date.now();
    const stamp = generateCatalogStamp("/some/source/path");
    assert.match(stamp.installedAt, ISO_Z_RE);
    const ms = Date.parse(stamp.installedAt);
    assert.ok(ms >= before - 2_000 && ms <= Date.now() + 2_000);
  });

  it("kanban snapshot generatedAt is canonical ISO-Z", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT NOT NULL,
          task TEXT NOT NULL, status TEXT NOT NULL, tokens_spent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE steps (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
          agent_id TEXT NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL,
          retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4,
          type TEXT NOT NULL DEFAULT 'single', current_story_id TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE stories (
          story_id TEXT NOT NULL, run_id TEXT NOT NULL, story_index INTEGER NOT NULL,
          title TEXT NOT NULL, status TEXT NOT NULL, retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 4, updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at) " +
          "VALUES ('run-1', 1, 'time-output', 'task', 'running', 0, '2026-09-15T22:00:00.000Z', '2026-09-15T22:00:00.000Z')",
      ).run();
      const snapshot = buildKanbanSnapshot(db, "run-1");
      assert.ok(snapshot, "snapshot should exist for the seeded run");
      assert.match(snapshot!.generatedAt, ISO_Z_RE);
    } finally {
      db.close();
    }
  });

  it("medic checkedAt is canonical ISO-Z and round-trips through status", async () => {
    const stateDir = tamanduaTempDir("tamandua-tow-medic-");
    const originalStateDir = process.env.TAMANDUA_STATE_DIR;
    const originalDbPath = process.env.TAMANDUA_DB_PATH;
    const originalHome = process.env.HOME;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.HOME = stateDir;
    try {
      const result = await runMedicCheck();
      assert.match(result.checkedAt, ISO_Z_RE);
      const status = getMedicStatus();
      assert.equal(status.lastCheck?.checkedAt, result.checkedAt);
      assert.match(status.lastCheck!.checkedAt, ISO_Z_RE);
    } finally {
      if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = originalStateDir;
      if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = originalDbPath;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("daemon heartbeat marker timestamps are canonical ISO-Z", () => {
    const homeDir = tamanduaTempDir("tamandua-tow-heartbeat-");
    try {
      writeHeartbeatMarker({ homeDir });
      const marker = readHeartbeatMarker({ homeDir });
      assert.ok(marker, "marker should be written");
      assert.match(marker!.startedAt, ISO_Z_RE);
      assert.match(marker!.lastHeartbeatAt, ISO_Z_RE);

      touchHeartbeat({ homeDir });
      const touched = readHeartbeatMarker({ homeDir });
      assert.ok(touched);
      assert.match(touched!.lastHeartbeatAt, ISO_Z_RE);
      assert.equal(touched!.startedAt, marker!.startedAt, "touch must preserve startedAt");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// ── Static source pin for the nowIso()-only writers ─────────────────

describe("TIME-OUTPUT US-007: nowIso() writer routing", () => {
  // Each entry pins the exact "current instant" assignment to nowIso() and
  // forbids the bare `new Date().toISOString()` it replaced.
  const writers: { file: string; usage: string; forbidden: string }[] = [
    {
      file: "src/installer/catalog-version.ts",
      usage: "installedAt: nowIso()",
      forbidden: "installedAt: new Date().toISOString()",
    },
    {
      file: "src/server/kanban-data.ts",
      usage: "generatedAt: nowIso()",
      forbidden: "generatedAt: new Date().toISOString()",
    },
    {
      file: "src/medic/medic.ts",
      usage: "const checkedAt = nowIso()",
      forbidden: "const checkedAt = new Date().toISOString()",
    },
    {
      file: "src/medic/medic-cron.ts",
      usage: "installedAt: nowIso()",
      forbidden: "installedAt: new Date().toISOString()",
    },
    {
      file: "src/server/daemon-lifecycle.ts",
      usage: "const now = nowIso()",
      forbidden: "const now = new Date().toISOString()",
    },
    {
      file: "src/autoresearch/autoresearch.ts",
      usage: "created_at: nowIso()",
      forbidden: "created_at: new Date().toISOString()",
    },
    {
      file: "src/db.ts",
      usage: "const now = nowIso()",
      forbidden: "const now = new Date().toISOString()",
    },
  ];

  for (const { file, usage, forbidden } of writers) {
    it(`${file} routes its current instant through nowIso()`, () => {
      const source = readSource(file);
      assert.ok(source.includes(usage), `${file} must contain: ${usage}`);
      assert.ok(
        !source.includes(forbidden),
        `${file} must not use the raw writer: ${forbidden}`,
      );
      assert.match(source, /from\s+["'][^"']*\/lib\/instant\.js["']/, `${file} must import ../lib/instant.js`);
      assert.match(source, /\bnowIso\b/, `${file} must import nowIso`);
    });
  }

  it("control-server normalizes the suite started_at via formatInstant", () => {
    const source = readSource("src/server/control-server.ts");
    assert.match(source, /formatInstant\(\s*\n?\s*typeof body\.started_at === "string"/);
    assert.ok(source.includes('{ style: "iso" }'), "started_at must use the iso style");
    assert.ok(
      !source.includes("evt.startedAt = body.started_at"),
      "suite-event started_at must not be emitted raw",
    );
  });
});
