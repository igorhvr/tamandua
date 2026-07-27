import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { closeDb, getDb } from "../../dist/db.js";
import { emitEvent } from "../../dist/installer/events.js";
import { getWorkflowStatus, listRuns } from "../../dist/installer/status.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

describe("red-ledger landing status model", () => {
  let stateRoot: string;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    stateRoot = tamanduaTempDir("tamandua-red-ledger-status-");
    process.env.HOME = stateRoot;
    process.env.TAMANDUA_STATE_DIR = path.join(stateRoot, ".tamandua");
    process.env.TAMANDUA_DB_PATH = path.join(stateRoot, ".tamandua", "tamandua.db");
    assertStatePathIsolation(process.env.TAMANDUA_STATE_DIR, "red-ledger status test state");
    assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "red-ledger status test database");
    fs.mkdirSync(process.env.TAMANDUA_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    closeDb();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("exposes persisted ledger evidence without reading step output", () => {
    const db = getDb();
    const runId = "red-ledger-status-run";
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "feature-dev-merge", "Land over known red suite", "completed", "{}", "2026-07-26T20:00:00.000Z", "2026-07-26T20:00:01.000Z");
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, type, status, output, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("red-step-row", runId, "finalize_merge", "merger", 0, "Merge", "STATUS: done", "single", "done", "SECRET STEP OUTPUT", "2026-07-26T20:00:00.000Z", "2026-07-26T20:00:01.000Z");
    emitEvent({
      ts: "2026-07-26T20:00:01.000Z",
      event: "merge.landed_over_red_suite",
      runId,
      ledgerRowId: 42,
      exitCode: 7,
      ledgerCreatedAt: "2026-07-26T20:00:00.000Z",
    });

    const detail = getWorkflowStatus(runId);
    assert.deepEqual(detail.redLedgerLanding, {
      ledgerRowId: 42,
      exitCode: 7,
      ledgerCreatedAt: "2026-07-26T20:00:00.000Z",
    });
    assert.deepEqual(listRuns()[0].redLedgerLanding, detail.redLedgerLanding);
    assert.equal(JSON.stringify(detail.redLedgerLanding).includes("SECRET STEP OUTPUT"), false);
  });

  it("omits the optional field when no landing annotation exists", () => {
    getDb().prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("green-run", "feature-dev-merge", "Green landing", "completed", "{}", "2026-07-26T20:00:00.000Z", "2026-07-26T20:00:01.000Z");

    assert.equal("redLedgerLanding" in getWorkflowStatus("green-run"), false);
    assert.equal("redLedgerLanding" in listRuns()[0], false);
  });
});
