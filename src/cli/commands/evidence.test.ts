/**
 * DIAG-PRUNE US-015 — tests for `tamandua evidence prune`.
 *
 * Two layers are covered:
 *
 *  1. In-process handler tests (injected in-memory db + isolated state dir +
 *     captured streams) for the dry-run plan, the `--yes` execution, the
 *     `--json` shapes and the error exits.
 *  2. Real CLI subprocess tests through `bin/tamandua` for the acceptance
 *     criteria (exit codes, `--help` routes, global usage) with an isolated
 *     temp HOME/state dir via `cleanChildEnv` (the test-isolation contract).
 *
 * The file imports `node:child_process` (the CLI subprocess), so it is
 * registered in `tests/serial-files.txt`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  getEvidenceGroupHelp,
  getEvidencePruneHelp,
  handleEvidence,
  type EvidenceCommandDeps,
} from "../../../dist/cli/commands/evidence.js";
import { getDb } from "../../../dist/db.js";
import { cleanChildEnv, createTempHome } from "../../../tests/helpers/test-env.ts";

const OLD_RUN = "aaaaaaaa-1111-4111-8111-111111111111";
const LIVE_RUN = "bbbbbbbb-2222-4222-8222-222222222222";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const created: string[] = [];

function makeTemp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const RUNS_DDL = `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    status TEXT,
    scheduling_status TEXT,
    updated_at TEXT
  );
`;

/**
 * Fixture: one terminal run old enough to prune (`OLD_RUN`) and one live run
 * (`LIVE_RUN`) whose evidence must be refused.
 */
function makeFixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(RUNS_DDL);
  db.exec(`
    INSERT INTO runs (id, status, scheduling_status, updated_at)
      VALUES ('${OLD_RUN}', 'failed', NULL, '2026-09-01T00:00:00.000Z');
    INSERT INTO runs (id, status, scheduling_status, updated_at)
      VALUES ('${LIVE_RUN}', 'running', 'active', '2026-09-01T00:00:00.000Z');
  `);
  return db;
}

/** Create `<state>/runs/<bareRunId>/artifact.txt` and return its path. */
function seedEvidence(stateDir: string, bareRunId: string): string {
  const dir = path.join(stateDir, "runs", bareRunId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "artifact.txt");
  fs.writeFileSync(file, "evidence");
  return dir;
}

interface Captured {
  stdout: string;
  stderr: string;
  exits: number[];
}

function captureDeps(db: DatabaseSync, stateDir: string): { deps: EvidenceCommandDeps; captured: Captured } {
  const captured: Captured = { stdout: "", stderr: "", exits: [] };
  const deps: EvidenceCommandDeps = {
    db: db as unknown as EvidenceCommandDeps["db"],
    stateDir,
    now: NOW,
    stdout: (text) => { captured.stdout += text; },
    stderr: (text) => { captured.stderr += text; },
    exit: (code) => { captured.exits.push(code); },
  };
  return { deps, captured };
}

describe("tamandua evidence prune — in-process handler", () => {
  it("declines command groups it does not own", () => {
    assert.equal(handleEvidence("workflow", ["workflow", "list"]), false);
    assert.equal(handleEvidence("run", ["run", "diagnose"]), false);
  });

  it("owns the evidence help text", () => {
    assert.match(getEvidenceGroupHelp(), /tamandua evidence — Manage and prune/);
    assert.match(getEvidenceGroupHelp(), /prune/);
    assert.match(getEvidencePruneHelp(), /Usage: tamandua evidence prune --older-than <days>/);
    assert.match(getEvidencePruneHelp(), /DRY-RUN BY DEFAULT/);
    assert.match(getEvidencePruneHelp(), /--yes/);
    assert.match(getEvidencePruneHelp(), /--json/);
  });

  it("dry-runs by default: lists planned removals and totals without deleting", () => {
    const stateDir = makeTemp("evidence-cli-dry-");
    const db = makeFixture();
    const eligible = seedEvidence(stateDir, OLD_RUN);
    const live = seedEvidence(stateDir, LIVE_RUN);
    const { deps, captured } = captureDeps(db, stateDir);

    const handled = handleEvidence("evidence", ["evidence", "prune", "--older-than", "7"], deps);

    assert.equal(handled, true);
    assert.deepEqual(captured.exits, []);
    assert.equal(captured.stderr, "");
    assert.match(captured.stdout, /Evidence prune plan \(dry run\)/);
    assert.match(captured.stdout, /older than 7 day\(s\)/);
    assert.match(captured.stdout, /Planned removals: 1 item\(s\)/);
    assert.match(captured.stdout, new RegExp(eligible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(captured.stdout, /Refused 1 run\(s\)/);
    assert.match(captured.stdout, new RegExp(LIVE_RUN));
    assert.match(captured.stdout, /Dry run only/);

    // Nothing was deleted.
    assert.ok(fs.statSync(eligible).isDirectory());
    assert.ok(fs.statSync(live).isDirectory());
    db.close();
  });

  it("accepts the <N>d day form in a dry run", () => {
    const stateDir = makeTemp("evidence-cli-days-");
    const db = makeFixture();
    seedEvidence(stateDir, OLD_RUN);
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7d", "--json"], deps);

    assert.deepEqual(captured.exits, []);
    const parsed = JSON.parse(captured.stdout) as { olderThanMs: number };
    assert.equal(parsed.olderThanMs, 7 * MS_PER_DAY);
    db.close();
  });

  it("executes the plan with --yes and reports removed items", () => {
    const stateDir = makeTemp("evidence-cli-yes-");
    const db = makeFixture();
    const eligible = seedEvidence(stateDir, OLD_RUN);
    const live = seedEvidence(stateDir, LIVE_RUN);
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7", "--yes"], deps);

    assert.deepEqual(captured.exits, []);
    assert.match(captured.stdout, /Evidence prune — older than 7 day\(s\)/);
    assert.match(captured.stdout, /Removed: 1 item\(s\)/);
    assert.equal(fs.existsSync(eligible), false);
    assert.ok(fs.statSync(live).isDirectory(), "live run evidence must survive");
    db.close();
  });

  it("--yes is idempotent: a second run removes nothing and fails nothing", () => {
    const stateDir = makeTemp("evidence-cli-idem-");
    const db = makeFixture();
    seedEvidence(stateDir, OLD_RUN);
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7", "--yes"], deps);
    captured.stdout = "";
    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7", "--yes"], deps);

    assert.deepEqual(captured.exits, []);
    assert.match(captured.stdout, /Removed: 0 item\(s\)/);
    assert.doesNotMatch(captured.stdout, /Failed:/);
    db.close();
  });

  it("emits exactly one JSON object with dryRun, olderThanMs, items, refusals and totals", () => {
    const stateDir = makeTemp("evidence-cli-json-");
    const db = makeFixture();
    seedEvidence(stateDir, OLD_RUN);
    seedEvidence(stateDir, LIVE_RUN);
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7", "--json"], deps);

    assert.deepEqual(captured.exits, []);
    assert.equal(captured.stdout.trim().split("\n").length, 1);
    const parsed = JSON.parse(captured.stdout) as {
      dryRun: boolean;
      olderThanMs: number;
      items: { action: string }[];
      refusals: unknown[];
      totals: { removeCount: number; keepCount: number };
    };
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.olderThanMs, 7 * MS_PER_DAY);
    assert.ok(Array.isArray(parsed.items));
    assert.ok(parsed.items.some((item) => item.action === "remove"));
    assert.equal(parsed.refusals.length, 1);
    assert.equal(parsed.totals.removeCount, 1);
    db.close();
  });

  it("emits removed/skipped/failed in execute JSON mode", () => {
    const stateDir = makeTemp("evidence-cli-json-yes-");
    const db = makeFixture();
    seedEvidence(stateDir, OLD_RUN);
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7", "--yes", "--json"], deps);

    assert.deepEqual(captured.exits, []);
    const parsed = JSON.parse(captured.stdout) as {
      dryRun: boolean;
      removed: unknown[];
      skipped: unknown[];
      failed: { error: string }[];
    };
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.removed.length, 1);
    assert.equal(parsed.skipped.length, 0);
    assert.equal(parsed.failed.length, 0);
    db.close();
  });

  it("rejects a missing --older-than value", () => {
    const stateDir = makeTemp("evidence-cli-missing-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "prune"], deps);

    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /Missing required --older-than/);
    db.close();
  });

  it("rejects an invalid --older-than value", () => {
    const stateDir = makeTemp("evidence-cli-invalid-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "prune", "--older-than", "seven"], deps);

    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /Invalid --older-than "seven"/);
    db.close();
  });

  it("rejects an unknown flag and an unexpected positional", () => {
    const stateDir = makeTemp("evidence-cli-flags-");
    const db = makeFixture();

    const unknown = captureDeps(db, stateDir);
    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7", "--bogus"], unknown.deps);
    assert.deepEqual(unknown.captured.exits, [1]);
    assert.match(unknown.captured.stderr, /Unknown option "--bogus"/);

    const extra = captureDeps(db, stateDir);
    handleEvidence("evidence", ["evidence", "prune", "--older-than", "7", "extra"], extra.deps);
    assert.deepEqual(extra.captured.exits, [1]);
    assert.match(extra.captured.stderr, /Unexpected argument "extra"/);
    db.close();
  });

  it("rejects an unknown evidence action", () => {
    const stateDir = makeTemp("evidence-cli-action-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleEvidence("evidence", ["evidence", "bogus"], deps);

    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /Unknown evidence action: bogus/);
    db.close();
  });
});

describe("tamandua evidence prune — CLI subprocess", () => {
  function cli(args: string[], env: Record<string, string | undefined>) {
    const wrapperPath = path.resolve("bin/tamandua");
    return spawnSync("/bin/sh", [wrapperPath, ...args], {
      encoding: "utf8",
      env: cleanChildEnv(env),
      timeout: 60_000,
    });
  }

  function seedRun(dbPath: string): void {
    const prev = process.env.TAMANDUA_DB_PATH;
    process.env.TAMANDUA_DB_PATH = dbPath;
    try {
      const db = getDb();
      db.prepare(
        "INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        OLD_RUN,
        1,
        "feature-dev-merge-worktree",
        "old run",
        "failed",
        "{}",
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
      );
    } finally {
      if (prev === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = prev;
    }
  }

  it("dry-runs and then --yes removes the eligible evidence only", () => {
    const th = createTempHome("tamandua-evidence-cli-");
    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    seedRun(dbPath);
    const eligible = path.join(th.tamanduaDir, "runs", OLD_RUN);
    fs.mkdirSync(eligible, { recursive: true });
    fs.writeFileSync(path.join(eligible, "artifact.txt"), "evidence");

    const env = { HOME: th.homeDir, TAMANDUA_DB_PATH: dbPath };

    const dry = cli(["evidence", "prune", "--older-than", "7"], env);
    assert.equal(dry.status, 0, `stderr: ${dry.stderr}`);
    assert.match(dry.stdout, /Planned removals: 1 item\(s\)/);
    assert.match(dry.stdout, new RegExp(OLD_RUN));
    assert.ok(fs.statSync(eligible).isDirectory(), "dry run must not delete");

    const execute = cli(["evidence", "prune", "--older-than", "7", "--yes"], env);
    assert.equal(execute.status, 0, `stderr: ${execute.stderr}`);
    assert.match(execute.stdout, /Removed: 1 item\(s\)/);
    assert.equal(fs.existsSync(eligible), false);
  });

  it("emits a single JSON object for dry-run and execute modes", () => {
    const th = createTempHome("tamandua-evidence-cli-json-");
    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    seedRun(dbPath);
    const eligible = path.join(th.tamanduaDir, "runs", OLD_RUN);
    fs.mkdirSync(eligible, { recursive: true });
    fs.writeFileSync(path.join(eligible, "artifact.txt"), "evidence");

    const env = { HOME: th.homeDir, TAMANDUA_DB_PATH: dbPath };

    const dry = cli(["evidence", "prune", "--older-than", "7", "--json"], env);
    assert.equal(dry.status, 0, `stderr: ${dry.stderr}`);
    const dryJson = JSON.parse(dry.stdout.trim()) as { dryRun: boolean; items: unknown[] };
    assert.equal(dryJson.dryRun, true);
    assert.ok(Array.isArray(dryJson.items));

    const execute = cli(["evidence", "prune", "--older-than", "7", "--yes", "--json"], env);
    assert.equal(execute.status, 0, `stderr: ${execute.stderr}`);
    const execJson = JSON.parse(execute.stdout.trim()) as { dryRun: boolean; removed: unknown[] };
    assert.equal(execJson.dryRun, false);
    assert.equal(execJson.removed.length, 1);
  });

  it("exits non-zero for missing/invalid --older-than and unknown flags", () => {
    const th = createTempHome("tamandua-evidence-cli-badargs-");
    const env = { HOME: th.homeDir };

    const missing = cli(["evidence", "prune"], env);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Missing required --older-than/);

    const invalid = cli(["evidence", "prune", "--older-than", "soon"], env);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Invalid --older-than "soon"/);

    const unknown = cli(["evidence", "prune", "--older-than", "7", "--nope"], env);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown option "--nope"/);
  });

  it("serves evidence/prune help and lists the command in the global usage", () => {
    const th = createTempHome("tamandua-evidence-cli-help-");
    const env = { HOME: th.homeDir };

    const pruneHelp = cli(["evidence", "prune", "--help"], env);
    assert.equal(pruneHelp.status, 0);
    assert.match(pruneHelp.stdout, /Usage: tamandua evidence prune --older-than <days>/);

    const groupHelp = cli(["evidence", "--help"], env);
    assert.equal(groupHelp.status, 0);
    assert.match(groupHelp.stdout, /tamandua evidence — Manage and prune/);

    const globalHelp = cli(["--help"], env);
    assert.equal(globalHelp.status, 0);
    assert.match(globalHelp.stdout, /tamandua evidence prune/);
  });
});