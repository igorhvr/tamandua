/**
 * tests/update-protocol.test.ts — Dynamic proofs for the update protocol foundation.
 *
 * Every subprocess case uses fresh temp HOME, TAMANDUA_STATE_DIR, TAMANDUA_DB_PATH,
 * and reserved random ports. TAMANDUA_TEST_GUARD=1 always.
 *
 * This file is classified in tests/serial-files.txt (spawns processes).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createTempHome, cleanChildEnv } from "./helpers/test-env.ts";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const PROTOCOL_MODULE = path.join(REPO_ROOT, "scripts", "update-protocol.mjs");
const COORDINATOR_CLI = path.join(
  REPO_ROOT,
  "scripts",
  "update-coordinator.mjs",
);
const DIST_DB = path.join(REPO_ROOT, "dist", "db.js");

// ── Helpers ──────────────────────────────────────────────────────────────

function runNode(args, extraEnv) {
  const env = cleanChildEnv(extraEnv);
  const result = spawnSync(process.execPath, args, {
    encoding: "utf-8",
    env,
    timeout: 30000,
  });
  return result;
}

function runAcquire(tempHome, dbPath, mode = "current") {
  const homeDir = tempHome.homeDir;
  const env = cleanChildEnv({
    HOME: homeDir,
    TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
    TAMANDUA_DB_PATH: dbPath,
  });
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
try {
  const r = acquire(${JSON.stringify(mode)}, process.ppid, "{}", "{}", "{}");
  console.log(JSON.stringify(r));
} catch(e) {
  console.log("ERROR:" + e.message);
  process.exit(1);
}`,
    ],
    { encoding: "utf-8", env, timeout: 30000 },
  );
  return result;
}

function runColdInit(tempHome, dbPath) {
  const homeDir = tempHome.homeDir;
  const env = cleanChildEnv({
    HOME: homeDir,
    TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
    TAMANDUA_DB_PATH: dbPath,
  });
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
try {
  const r = acquire("current", process.ppid, JSON.stringify({test:true}), JSON.stringify({}), JSON.stringify({}));
  console.log(JSON.stringify(r));
} catch(e) {
  console.log("ERROR:" + e.message);
  process.exit(1);
}`,
    ],
    { encoding: "utf-8", env, timeout: 30000 },
  );
  return result;
}

/**
 * Get the actual owner identity by reading a live gate row.
 */
function getGateOwnerIdentity(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT owner_identity FROM update_gate WHERE id = 1")
      .get();
    return row?.owner_identity ?? null;
  } finally {
    db.close();
  }
}

/**
 * Get the token from a live gate row.
 */
function getGateToken(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT token FROM update_gate WHERE id = 1").get();
    return row?.token ?? null;
  } finally {
    db.close();
  }
}

/**
 * Check if a SQLite table exists.
 */
function tableExists(dbPath, tableName) {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get(tableName) !== undefined
    );
  } finally {
    db.close();
  }
}

/**
 * Check if a trigger exists.
 */
function triggerExists(dbPath, triggerName) {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?",
        )
        .get(triggerName) !== undefined
    );
  } finally {
    db.close();
  }
}

/**
 * Get all table names in a database.
 */
function getTableNames(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

/**
 * Get pragma user_version.
 */
function getUserVersion(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA user_version").get();
    return row.user_version;
  } finally {
    db.close();
  }
}

/**
 * Count runs in a database.
 */
function countRuns(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM runs").get();
    return row.cnt;
  } finally {
    db.close();
  }
}

/**
 * Compute a simple file hash.
 */
function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ── DB-PATH: explicit TAMANDUA_DB_PATH wins ──────────────────────────────

describe("DB-PATH resolution", () => {
  /** @type {Set<string>} */
  const roots = new Set();

  afterEach(() => {
    const errors = [];
    for (const r of roots) {
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch (e) {
        errors.push(e);
      }
    }
    roots.clear();
    if (errors.length > 0) {
      throw new Error(
        `Cleanup errors: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
  });

  it("explicit TAMANDUA_DB_PATH wins over default HOME path", () => {
    const temp = createTempHome("update-protocol-dbpath-");
    roots.add(temp.root);

    const explicitDb = path.join(temp.root, "explicit.db");
    const defaultDb = path.join(temp.homeDir, ".tamandua", "tamandua.db");

    // First ensure the default path doesn't exist
    const result = runAcquire(temp, explicitDb);
    assert.equal(result.status, 0, `Acquire failed: ${result.stderr}`);

    // The explicit DB should exist, default should not
    assert.ok(fs.existsSync(explicitDb), "Explicit DB should exist");
    assert.ok(
      !fs.existsSync(defaultDb),
      "Default DB should NOT exist when TAMANDUA_DB_PATH is explicit",
    );
  });

  it("falls back to HOME/.tamandua/tamandua.db when TAMANDUA_DB_PATH is absent", () => {
    const temp = createTempHome("update-protocol-dbpath2-");
    roots.add(temp.root);

    const stateDir = path.join(temp.root, "custom-state");
    fs.mkdirSync(stateDir, { recursive: true });

    const env = cleanChildEnv({
      HOME: temp.homeDir,
      TAMANDUA_STATE_DIR: stateDir,
    });
    // cleanChildEnv synthesizes TAMANDUA_DB_PATH — delete it so the true
    // HOME fallback path is exercised.
    delete env.TAMANDUA_DB_PATH;
    assert.ok(
      !("TAMANDUA_DB_PATH" in env),
      "TAMANDUA_DB_PATH must be absent before spawn",
    );

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
import { writeSync } from "node:fs";
const r = acquire("current", process.ppid, "{}", "{}", "{}");
writeSync(1, JSON.stringify({ phase: r.phase, mode: r.mode }) + "\\n");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.equal(result.status, 0, `Acquire failed: ${result.stderr}`);
    assert.equal(result.signal, null, `Acquire signaled: ${result.signal}`);
    assert.ok(result.error === undefined, `Spawn error: ${result.error}`);
    assert.equal(result.stderr, "", "stderr must be empty");

    const expected = JSON.stringify({ phase: "ACQUIRED", mode: "current" }) + "\n";
    assert.equal(result.stdout, expected, `stdout mismatch, got: ${result.stdout}`);

    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed, { phase: "ACQUIRED", mode: "current" });

    // HOME default DB should exist, custom-state DB should not
    const homeDb = path.join(temp.homeDir, ".tamandua", "tamandua.db");
    assert.ok(fs.existsSync(homeDb), "HOME/.tamandua/tamandua.db should exist");
    assert.ok(
      !fs.existsSync(path.join(stateDir, "tamandua.db")),
      "custom-state/tamandua.db should NOT exist",
    );
  });
});

// ── COLD: absent DB initialization through real built dist/db.js ─────────

describe("COLD initialization", () => {
  /** @type {Set<string>} */
  const roots = new Set();

  afterEach(() => {
    const errors = [];
    for (const r of roots) {
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch (e) {
        errors.push(e);
      }
    }
    roots.clear();
    if (errors.length > 0) {
      throw new Error(
        `Cleanup errors: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
  });

  it("absent DB is initialized through real built dist/db.js", () => {
    const temp = createTempHome("update-protocol-cold-");
    roots.add(temp.root);

    const dbPath = path.join(temp.root, "cold.db");

    // DB should not exist
    assert.ok(!fs.existsSync(dbPath), "DB should not exist before test");

    const result = runColdInit(temp, dbPath);

    assert.equal(
      result.status,
      0,
      `Cold init acquire failed: ${result.stderr}, stdout: ${result.stdout}`,
    );

    // DB should exist (created by dist/db.js cold init path)
    assert.ok(fs.existsSync(dbPath), "DB should exist after cold init");

    // Verify runs table exists (created by dist/db.js, not by coordinator)
    assert.ok(tableExists(dbPath, "runs"), "runs table should exist");
    assert.ok(
      tableExists(dbPath, "steps"),
      "steps table should exist",
    );
    assert.ok(
      tableExists(dbPath, "stories"),
      "stories table should exist",
    );

    // Verify update_gate now exists (created by acquisition)
    assert.ok(
      tableExists(dbPath, "update_gate"),
      "update_gate table should exist after acquisition",
    );

    // Verify triggers exist
    assert.ok(
      triggerExists(dbPath, "trg_update_gate_block_runs_insert"),
      "INSERT trigger should exist",
    );
    assert.ok(
      triggerExists(dbPath, "trg_update_gate_block_runs_update"),
      "UPDATE trigger should exist",
    );

    // Verify gate row inserted (manual handle with try/finally for close)
    const db = new DatabaseSync(dbPath);
    try {
      const gate = db
        .prepare("SELECT * FROM update_gate WHERE id = 1")
        .get();
      assert.ok(gate, "Gate row should exist");
      assert.equal(gate.phase, "ACQUIRED");
      assert.equal(gate.mode, "current");
      assert.equal(gate.topology, JSON.stringify({ test: true }));
    } finally {
      db.close();
    }
  });

  it("cold init does not copy or duplicate the runs schema in the coordinator", () => {
    const temp = createTempHome("update-protocol-cold2-");
    roots.add(temp.root);

    const dbPath = path.join(temp.root, "cold2.db");

    const result = runColdInit(temp, dbPath);
    assert.equal(result.status, 0, `Cold init failed: ${result.stderr}`);

    // The table names should be what dist/db.js creates, not a recreated subset
    const tables = getTableNames(dbPath);
    // We expect the full suite of tables from dist/db.js + update_gate
    assert.ok(tables.includes("runs"));
    assert.ok(tables.includes("steps"));
    assert.ok(tables.includes("stories"));
    assert.ok(tables.includes("update_gate"));
    assert.ok(tables.includes("run_worktrees"));
    assert.ok(tables.includes("autoresearch_sessions"));
    assert.ok(tables.includes("tamandua_stats"));
    assert.ok(tables.includes("suite_results"));
    assert.ok(tables.includes("story_abandonments"));
  });
});

// ── ACTIVE-RUNNING / ACTIVE-PAUSED refusal ───────────────────────────────

describe("Active work refusal", () => {
  function snapshotDb(dbPath) {
    const db = new DatabaseSync(dbPath);
    let tables;
    let userVersion;
    let runCount;
    let runRow;
    try {
      tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      userVersion = db.prepare("PRAGMA user_version").get().user_version;
      runCount = db.prepare("SELECT COUNT(*) AS cnt FROM runs").get().cnt;
      const row = db.prepare("SELECT * FROM runs").get();
      runRow = row ? JSON.parse(JSON.stringify(row)) : null;
    } finally {
      db.close();
    }

    const rawBytes = fs.existsSync(dbPath)
      ? fs.readFileSync(dbPath)
      : null;
    const hash = rawBytes
      ? crypto.createHash("sha256").update(rawBytes).digest("hex")
      : null;

    function sidecar(name) {
      const p = dbPath + name;
      const exists = fs.existsSync(p);
      return { exists, content: exists ? fs.readFileSync(p) : null };
    }

    return {
      tables,
      userVersion,
      runCount,
      runRow,
      rawBytes,
      hash,
      journal: sidecar("-journal"),
      wal: sidecar("-wal"),
      shm: sidecar("-shm"),
    };
  }

  function proveActiveRefusal(status) {
    const temp = createTempHome(`update-protocol-active-${status}-`);
    try {
      const dbPath = path.join(temp.root, `active-${status}.db`);

      const env = cleanChildEnv({
        HOME: temp.homeDir,
        TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
        TAMANDUA_DB_PATH: dbPath,
      });

      const setupResult = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { getDb, closeDb } from ${JSON.stringify(DIST_DB)};
import { writeSync } from "node:fs";
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(temp.homeDir)};
const db = getDb();
try {
  db.prepare("INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, notify_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
     .run("run-1", 1, "wf-1", "Fix the thing", ${JSON.stringify(status)}, "{}", 0, null, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} finally {
  closeDb();
}
writeSync(1, "READY\\n");`,
        ],
        { encoding: "utf-8", env, timeout: 30000 },
      );
      assert.equal(setupResult.status, 0, `Setup failed: ${setupResult.stderr}`);
      assert.equal(setupResult.signal, null);
      assert.ok(setupResult.error === undefined);
      assert.equal(setupResult.stderr, "");
      assert.equal(setupResult.stdout, "READY\n");

      const before = snapshotDb(dbPath);
      assert.equal(before.runCount, 1, "Expected exactly one run row");
      assert.ok(before.runRow, "Expected a run row");
      assert.equal(before.runRow.status, status, `Run status must be ${status}`);
      assert.ok(!before.journal.exists, "-journal must not exist");
      assert.ok(!before.wal.exists, "-wal must not exist");
      assert.ok(!before.shm.exists, "-shm must not exist");

      const refuseEnv = cleanChildEnv({
        HOME: temp.homeDir,
        TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
        TAMANDUA_DB_PATH: dbPath,
      });

      const refuseResult = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
import { writeSync } from "node:fs";
try {
  acquire("current", process.ppid, "{}", "{}", "{}");
  process.exitCode = 2;
} catch (e) {
  writeSync(1, JSON.stringify({ error: e.message }) + "\\n");
  process.exitCode = 1;
}`,
        ],
        { encoding: "utf-8", env: refuseEnv, timeout: 30000 },
      );

      assert.equal(refuseResult.status, 1, "Acquire must exit 1");
      assert.equal(refuseResult.signal, null);
      assert.ok(refuseResult.error === undefined);
      assert.equal(refuseResult.stderr, "", "stderr must be empty");
      assert.equal(
        refuseResult.stdout,
        '{"error":"Active work exists — acquisition refused"}\n',
        `stdout mismatch: ${refuseResult.stdout}`,
      );

      const after = snapshotDb(dbPath);

      assert.deepEqual(after.tables, before.tables);
      assert.equal(after.userVersion, before.userVersion);
      assert.equal(after.runCount, before.runCount);
      assert.deepEqual(after.runRow, before.runRow);
      assert.deepEqual(after.rawBytes, before.rawBytes);
      assert.equal(after.hash, before.hash);
      assert.equal(after.journal.exists, before.journal.exists);
      assert.deepEqual(after.journal.content, before.journal.content);
      assert.equal(after.wal.exists, before.wal.exists);
      assert.deepEqual(after.wal.content, before.wal.content);
      assert.equal(after.shm.exists, before.shm.exists);
      assert.deepEqual(after.shm.content, before.shm.content);
      assert.ok(
        !tableExists(dbPath, "update_gate"),
        "update_gate must not exist after refusal",
      );
      assert.ok(
        !triggerExists(dbPath, "trg_update_gate_block_runs_insert"),
      );
      assert.ok(
        !triggerExists(dbPath, "trg_update_gate_block_runs_update"),
      );
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
      assert.ok(!fs.existsSync(temp.root), "active temp root must be absent");
    }
  }

  it("acquisition exits nonzero when a running run exists", () => {
    proveActiveRefusal("running");
  });

  it("acquisition exits nonzero when a paused run exists", () => {
    proveActiveRefusal("paused");
  });
});

// ── RACE: real orderings with separate processes and IPC barriers ────────

describe("RACE conditions", () => {
  it(
    "writer-first: writer holds BEGIN IMMEDIATE, commits running run, acquirer rolls back",
    { timeout: 60000 },
    async () => {
      const temp = createTempHome("update-protocol-race-wf-");
      const dbPath = path.join(temp.root, "race-wf.db");
      const barrierDir = path.join(temp.root, "barriers");
      fs.mkdirSync(barrierDir, { recursive: true });

      const writerLocked = path.join(barrierDir, "writer-locked");
      const acquirerBusyObserved = path.join(barrierDir, "acquirer-busy-observed");
      const writerCommitted = path.join(barrierDir, "writer-committed");

      const env = cleanChildEnv({
        HOME: temp.homeDir,
        TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
        TAMANDUA_DB_PATH: dbPath,
      });

      // Cold-init the DB first
      const initResult = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { getDb, closeDb } from ${JSON.stringify(DIST_DB)};
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(temp.homeDir)};
const db = getDb();
closeDb();
console.log("cold init done");`,
        ],
        { encoding: "utf-8", env, timeout: 30000 },
      );
      assert.equal(initResult.status, 0, `Cold init failed: ${initResult.stderr}`);

      // Shared barrier-wait helper (synchronous polling via Atomics.wait, no setTimeout)
      const barrierWaitFn = `
function barrierWait(barrierPath, name, timeoutMs) {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(barrierPath)) {
    if (Date.now() > deadline) {
      throw new Error("barrier " + name + " not observed within " + timeoutMs + "ms");
    }
    Atomics.wait(i32, 0, 0, 50);
  }
}`;

      // Writer: takes BEGIN IMMEDIATE with busy_timeout=0, signals locked,
      // waits for acquirer BUSY observation, commits running run, signals done
      const writerCode = `
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const dbPath = process.env.TAMANDUA_DB_PATH;
const writerLocked = ${JSON.stringify(writerLocked)};
const acquirerBusyObserved = ${JSON.stringify(acquirerBusyObserved)};
const writerCommitted = ${JSON.stringify(writerCommitted)};

${barrierWaitFn}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");

// Signal: writer now holds the SQLite writer lock
fs.writeFileSync(writerLocked, "");

// Wait for acquirer to observe real BUSY-5 — progress is event-driven
barrierWait(acquirerBusyObserved, "acquirer-busy-observed", 15000);

// Now insert running run and commit
db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("race-run-1", "wf-1", "task", "running", new Date().toISOString(), new Date().toISOString());
db.exec("COMMIT");
db.close();

// Signal: writer committed — acquirer can now retry
fs.writeFileSync(writerCommitted, "");
process.exit(0);
`;

      // Acquirer: waits for writer lock, monkeypatches DatabaseSync.prototype.exec
      // to intercept the first BEGIN IMMEDIATE, observes real BUSY-5,
      // waits for writer commit, retries, and calls real production acquire()
      const acquirerCode = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const writerLocked = ${JSON.stringify(writerLocked)};
const acquirerBusyObserved = ${JSON.stringify(acquirerBusyObserved)};
const writerCommitted = ${JSON.stringify(writerCommitted)};

${barrierWaitFn}

// Wait for writer to signal it holds the lock
barrierWait(writerLocked, "writer-locked", 15000);

// Monkeypatch DatabaseSync.prototype.exec to intercept the first BEGIN IMMEDIATE
const originalExec = DatabaseSync.prototype.exec;
let busyAttemptCount = 0;
let retryCount = 0;

DatabaseSync.prototype.exec = function(sql) {
  if (sql === "BEGIN IMMEDIATE" && busyAttemptCount === 0) {
    // First BEGIN IMMEDIATE from production acquire().
    // Try with busy_timeout=0 while writer holds the lock — must get BUSY-5.
    originalExec.call(this, "PRAGMA busy_timeout = 0");
    busyAttemptCount++;
    try {
      originalExec.call(this, "BEGIN IMMEDIATE");
      // Unexpected success — roll back best-effort and throw
      try { originalExec.call(this, "ROLLBACK"); } catch (_) {}
      throw new Error("UNEXPECTED: BEGIN IMMEDIATE succeeded while writer held lock");
    } catch (e) {
      if (e.code === "ERR_SQLITE_ERROR" && e.errcode === 5) {
        // Real BUSY-5 observed — PROOF the writer held the lock
        fs.writeFileSync(acquirerBusyObserved, "");
      } else {
        try { originalExec.call(this, "ROLLBACK"); } catch (_) {}
        throw e;
      }
    }

    // Wait for writer to commit before retrying
    barrierWait(writerCommitted, "writer-committed", 15000);

    // Restore production busy_timeout and retry BEGIN IMMEDIATE
    originalExec.call(this, "PRAGMA busy_timeout = 10000");
    retryCount++;
    return originalExec.call(this, "BEGIN IMMEDIATE");
  }

  return originalExec.call(this, sql);
};

// Dynamically import and call the real production acquire()
try {
  const mod = await import(${JSON.stringify(PROTOCOL_MODULE)});
  try {
    mod.acquire("current", process.ppid, "{}", "{}", "{}");
    const result = { busyAttemptCount, retryCount, refused: false, error: null };
    fs.writeSync(1, JSON.stringify(result) + "\\n");
  } catch (e) {
    const refused = e.message === "Active work exists — acquisition refused";
    const result = { busyAttemptCount, retryCount, refused, error: e.message };
    fs.writeSync(1, JSON.stringify(result) + "\\n");
  }
} catch (e) {
  throw new Error("Import failed: " + e.message);
}

process.exitCode = 0;
`;

      // Declare child handles before try so finally can always reach them
      let writerChild, acquirerChild;
      let db;

      try {
        // Spawn both children — capture stdout AND stderr
        writerChild = spawn(process.execPath, ["--input-type=module", "-e", writerCode], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        acquirerChild = spawn(process.execPath, ["--input-type=module", "-e", acquirerCode], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let writerStdout = "", writerStderr = "";
        writerChild.stdout.on("data", (d) => { writerStdout += d.toString(); });
        writerChild.stderr.on("data", (d) => { writerStderr += d.toString(); });
        let acquirerStdout = "", acquirerStderr = "";
        acquirerChild.stdout.on("data", (d) => { acquirerStdout += d.toString(); });
        acquirerChild.stderr.on("data", (d) => { acquirerStderr += d.toString(); });

        // Close promises: resolve on close, reject on error so spawn failures don't hang
        const writerClose = new Promise((resolve, reject) => {
          writerChild.on("close", (code) => resolve(code));
          writerChild.on("error", (err) => reject(err));
        });
        const acquirerClose = new Promise((resolve, reject) => {
          acquirerChild.on("close", (code) => resolve(code));
          acquirerChild.on("error", (err) => reject(err));
        });

        const [writerExitCode, acquirerExitCode] = await Promise.all([
          writerClose,
          acquirerClose,
        ]) as [number, number];

        // Writer should have committed successfully
        assert.equal(writerExitCode, 0,
          `Writer failed (exit ${writerExitCode}): stderr=${writerStderr}`);

        // Acquirer should exit 0 with structured JSON output
        assert.equal(acquirerExitCode, 0,
          `Acquirer failed (exit ${acquirerExitCode}): stderr=${acquirerStderr}`);

        // Parse exactly one JSON line from stdout
        let acquirerResult;
        try {
          acquirerResult = JSON.parse(acquirerStdout.trim());
        } catch {
          assert.fail(`Acquirer stdout is not valid JSON: ${acquirerStdout}`);
        }

        // Assert exact numeric counters and exact refusal message
        assert.equal(acquirerResult.busyAttemptCount, 1,
          `Expected busyAttemptCount=1, got ${JSON.stringify(acquirerResult)}`);
        assert.equal(acquirerResult.retryCount, 1,
          `Expected retryCount=1, got ${JSON.stringify(acquirerResult)}`);
        assert.equal(acquirerResult.refused, true,
          `Expected refused=true, got ${JSON.stringify(acquirerResult)}`);
        assert.equal(acquirerResult.error, "Active work exists — acquisition refused",
          `Expected exact refusal message, got ${JSON.stringify(acquirerResult)}`);

        // Verify the writer's run row exists with expected state
        db = new DatabaseSync(dbPath);
        const row = db.prepare("SELECT id, status FROM runs WHERE id = ?").get("race-run-1");
        assert.ok(row, "race-run-1 row must exist after writer commit");
        assert.equal(row.status, "running",
          `Expected status=running, got ${row.status}`);

        // Query main.sqlite_schema for all three reserved protocol artifact names
        const residue = db.prepare(
          "SELECT lower(name) as name FROM main.sqlite_schema WHERE lower(name) IN (" +
          "'update_gate', 'trg_update_gate_block_runs_insert', " +
          "'trg_update_gate_block_runs_update')"
        ).all();
        assert.equal(residue.length, 0,
          `Expected zero protocol artifact residue, got: ${JSON.stringify(residue)}`);
      } finally {
        // Terminate any still-live children (SIGKILL for deterministic cleanup)
        if (writerChild && writerChild.exitCode === null) writerChild.kill("SIGKILL");
        if (acquirerChild && acquirerChild.exitCode === null) acquirerChild.kill("SIGKILL");

        // Close parent DB handle if still open
        if (db) {
          try { db.close(); } catch { /* ignore */ }
        }

        // Remove the temp root
        try {
          fs.rmSync(temp.root, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  );

  it(
    "acquirer-first: writer gets BUSY, acquirer commits gate, same INSERT is trigger-blocked",
    { timeout: 60000 },
    async () => {
      // Deterministic two-process interleaving proof:
      // (1) writer prepares INSERT before acquisition
      // (2) acquirer holds real BEGIN IMMEDIATE
      // (3) writer gets real BUSY-5 from lock conflict
      // (4) acquirer commits canonical blockers/gate
      // (5) same prepared statement retries and is rejected by trigger

      const temp = createTempHome("update-protocol-race-af-");
      const dbPath = path.join(temp.root, "race-af.db");
      const barrierDir = path.join(temp.root, "barriers");

      const writerPrepared = path.join(barrierDir, "writer-prepared");
      const acquirerLockHeld = path.join(barrierDir, "acquirer-lock-held");
      const writerBusyObserved = path.join(barrierDir, "writer-busy-observed");
      const acquirerCommitted = path.join(barrierDir, "acquirer-committed");

      const env = cleanChildEnv({
        HOME: temp.homeDir,
        TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
        TAMANDUA_DB_PATH: dbPath,
      });

      // Shared barrier-wait helper (deterministic Atomics.wait, no setTimeout)
      const barrierWaitFn = `
function barrierWait(barrierPath, name, timeoutMs) {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(barrierPath)) {
    if (Date.now() > deadline) {
      throw new Error("barrier " + name + " not observed within " + timeoutMs + "ms");
    }
    Atomics.wait(i32, 0, 0, 50);
  }
}`;

      // Writer: opens own DatabaseSync with busy_timeout=0, proves reserved
      // artifacts absent, prepares the legacy INSERT exactly once, retains the
      // StatementSync object, signals writer-prepared.
      // Then waits for acquirer-lock-held, executes the prepared statement once
      // (must get BUSY-5), signals writer-busy-observed.
      // After acquirer-committed, retries the same statement (must get trigger error).
      const writerCode = `
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const dbPath = process.env.TAMANDUA_DB_PATH;
const writerPrepared = ${JSON.stringify(writerPrepared)};
const acquirerLockHeld = ${JSON.stringify(acquirerLockHeld)};
const writerBusyObserved = ${JSON.stringify(writerBusyObserved)};
const acquirerCommitted = ${JSON.stringify(acquirerCommitted)};

${barrierWaitFn}

let db;
try {
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 0");

  // Prove reserved artifacts are absent before preparation —
  // fail-fast: if any exist, throw immediately before preparing or signaling
  const reserved = db.prepare(
    "SELECT lower(name) as name FROM main.sqlite_schema WHERE lower(name) IN (" +
    "'update_gate', 'trg_update_gate_block_runs_insert', 'trg_update_gate_block_runs_update')"
  ).all();
  if (reserved.length > 0) {
    throw new Error("FAIL-FAST: reserved artifacts already exist before acquire");
  }
  const reservedAbsent = reserved.length === 0;

  // Prepare INSERT exactly once, retain the StatementSync
  let prepareCount = 0;
  const stmt = db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  prepareCount++;

  // Signal: writer prepared before acquisition
  fs.writeFileSync(writerPrepared, "");

  // Wait for acquirer to hold the real BEGIN IMMEDIATE lock
  barrierWait(acquirerLockHeld, "acquirer-lock-held", 15000);

  // Execute the retained statement exactly once — must get BUSY-5
  let busyAttemptCount = 0;
  let busyCode = null;
  let busyErrcode = null;
  try {
    busyAttemptCount++;
    stmt.run("race-run-1", "wf-1", "task", "running",
      new Date().toISOString(), new Date().toISOString());
    throw new Error("UNEXPECTED: INSERT succeeded while acquirer held lock");
  } catch (e) {
    if (e.code === "ERR_SQLITE_ERROR" && e.errcode === 5) {
      busyCode = e.code;
      busyErrcode = e.errcode;
    } else {
      throw new Error("UNEXPECTED error instead of BUSY-5: " +
        (e.code || "(none)") + " errcode=" + (e.errcode ?? "(none)") +
        " message=" + e.message);
    }
  }

  // Signal: writer observed real BUSY-5 — acquirer can continue
  fs.writeFileSync(writerBusyObserved, "");

  // Wait for acquirer to commit the gate and triggers
  barrierWait(acquirerCommitted, "acquirer-committed", 15000);

  // Retry the same retained statement exactly once — must get trigger error
  let retryCount = 0;
  let triggerError = null;
  let sameStatementRetried = false;
  try {
    retryCount++;
    sameStatementRetried = true;
    stmt.run("race-run-1", "wf-1", "task", "running",
      new Date().toISOString(), new Date().toISOString());
    throw new Error("UNEXPECTED: retry INSERT succeeded after gate committed");
  } catch (e) {
    if (e.message === "update in progress") {
      triggerError = e.message;
    } else {
      throw new Error("UNEXPECTED retry error: " + (e.code || "(none)") +
        " errcode=" + (e.errcode ?? "(none)") + " message=" + e.message);
    }
  }

  const result = {
    reservedAbsent,
    prepareCount,
    busyAttemptCount,
    busyCode,
    busyErrcode,
    retryCount,
    triggerError,
    sameStatementRetried,
  };
  fs.writeSync(1, JSON.stringify(result) + "\\n");
} finally {
  if (db) {
    try { db.close(); } catch (_) {}
  }
}
`;

      // Acquirer: waits for writer-prepared, monkeypatches DatabaseSync.prototype.exec
      // to intercept the first BEGIN IMMEDIATE from production acquire().
      // Calls the saved original first; only after the real call succeeds
      // (write-lock actually held) increments the count and signals acquirer-lock-held.
      // Before returning from the wrapper, waits for writer-busy-observed.
      const acquirerCode = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const writerPrepared = ${JSON.stringify(writerPrepared)};
const acquirerLockHeld = ${JSON.stringify(acquirerLockHeld)};
const writerBusyObserved = ${JSON.stringify(writerBusyObserved)};
const acquirerCommitted = ${JSON.stringify(acquirerCommitted)};

${barrierWaitFn}

// Wait for writer to prepare its INSERT before acquisition
barrierWait(writerPrepared, "writer-prepared", 15000);

// Monkeypatch DatabaseSync.prototype.exec to intercept the first BEGIN IMMEDIATE
const originalExec = DatabaseSync.prototype.exec;
let interceptedLockCount = 0;

DatabaseSync.prototype.exec = function(sql) {
  if (sql === "BEGIN IMMEDIATE" && interceptedLockCount === 0) {
    // First BEGIN IMMEDIATE from production acquire().
    // Call the saved original first — only after it returns is the lock held.
    const result = originalExec.call(this, "BEGIN IMMEDIATE");
    interceptedLockCount++;

    // Now the write lock is actually held — signal
    fs.writeFileSync(acquirerLockHeld, "");

    // Wait for writer to observe BUSY-5 before returning from wrapper
    barrierWait(writerBusyObserved, "writer-busy-observed", 15000);

    return result;
  }

  return originalExec.call(this, sql);
};

// Call the real production acquire()
try {
  const mod = await import(${JSON.stringify(PROTOCOL_MODULE)});
  let result;
  try {
    result = mod.acquire("current", process.ppid, "{}", "{}", "{}");
  } catch (e) {
    throw new Error("acquire() failed: " + e.message);
  }

  // acquire() returned successfully — the gate is committed, close its DB
  // (the acquire() call internally opens and closes its own DB via finally)

  // Signal: acquirer committed
  fs.writeFileSync(acquirerCommitted, "");

  const out = {
    interceptedLockCount,
    phase: result.phase,
    mode: result.mode,
  };
  fs.writeSync(1, JSON.stringify(out) + "\\n");
} finally {
  // Restore the original exec in all exit paths
  DatabaseSync.prototype.exec = originalExec;
}
`;

      // Declare every handle before try so finally can always reach them
      let writerChild, acquirerChild;
      let writerStdout = "", writerStderr = "";
      let acquirerStdout = "", acquirerStderr = "";
      let db;

      try {
        // I/O and resource allocation inside encompassing try
        fs.mkdirSync(barrierDir, { recursive: true });

        // Cold-init the DB first
        const initResult = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { getDb, closeDb } from ${JSON.stringify(DIST_DB)};
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(temp.homeDir)};
const db = getDb();
closeDb();
console.log("cold init done");`,
          ],
          { encoding: "utf-8", env, timeout: 30000 },
        );
        assert.equal(initResult.status, 0, `Cold init failed: ${initResult.stderr}`);

        // Spawn both children concurrently — the barriers control ordering
        writerChild = spawn(process.execPath, ["--input-type=module", "-e", writerCode], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        acquirerChild = spawn(process.execPath, ["--input-type=module", "-e", acquirerCode], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        writerChild.stdout.on("data", (d) => { writerStdout += d.toString(); });
        writerChild.stderr.on("data", (d) => { writerStderr += d.toString(); });
        acquirerChild.stdout.on("data", (d) => { acquirerStdout += d.toString(); });
        acquirerChild.stderr.on("data", (d) => { acquirerStderr += d.toString(); });

        // Close/resolve promises: resolve on close, reject on error
        const writerClose = new Promise((resolve, reject) => {
          writerChild.on("close", (code) => resolve(code));
          writerChild.on("error", (err) => reject(err));
        });
        const acquirerClose = new Promise((resolve, reject) => {
          acquirerChild.on("close", (code) => resolve(code));
          acquirerChild.on("error", (err) => reject(err));
        });

        const [writerExitCode, acquirerExitCode] = await Promise.all([
          writerClose,
          acquirerClose,
        ]) as [number, number];

        // Assert exact zero exit codes
        assert.equal(writerExitCode, 0,
          `Writer failed (exit ${writerExitCode}): stderr=${writerStderr}`);
        assert.equal(acquirerExitCode, 0,
          `Acquirer failed (exit ${acquirerExitCode}): stderr=${acquirerStderr}`);

        // Assert empty success stderr
        assert.equal(writerStderr, "",
          `Writer stderr not empty: ${writerStderr}`);
        assert.equal(acquirerStderr, "",
          `Acquirer stderr not empty: ${acquirerStderr}`);

        // Parse exactly one nonempty JSON line from each child
        let writerResult, acquirerResult;
        try {
          writerResult = JSON.parse(writerStdout.trim());
        } catch {
          assert.fail(`Writer stdout is not valid JSON: ${writerStdout}`);
        }
        try {
          acquirerResult = JSON.parse(acquirerStdout.trim());
        } catch {
          assert.fail(`Acquirer stdout is not valid JSON: ${acquirerStdout}`);
        }

        // Assert no extra output (exactly one JSON line)
        const writerLines = writerStdout.trim().split("\n");
        assert.equal(writerLines.length, 1,
          `Expected 1 JSON line from writer, got ${writerLines.length}`);
        const acquirerLines = acquirerStdout.trim().split("\n");
        assert.equal(acquirerLines.length, 1,
          `Expected 1 JSON line from aquirer, got ${acquirerLines.length}`);

        // ── Writer JSON assertions ──

        assert.equal(writerResult.reservedAbsent, true,
          "Reserved artifacts must be absent at preparation");
        assert.equal(writerResult.prepareCount, 1,
          `Expected prepareCount=1, got ${writerResult.prepareCount}`);
        assert.equal(writerResult.busyAttemptCount, 1,
          `Expected busyAttemptCount=1, got ${writerResult.busyAttemptCount}`);
        assert.equal(writerResult.busyCode, "ERR_SQLITE_ERROR",
          `Expected busyCode=ERR_SQLITE_ERROR, got ${writerResult.busyCode}`);
        assert.equal(writerResult.busyErrcode, 5,
          `Expected busyErrcode=5, got ${writerResult.busyErrcode}`);
        assert.equal(writerResult.retryCount, 1,
          `Expected retryCount=1, got ${writerResult.retryCount}`);
        assert.equal(writerResult.triggerError, "update in progress",
          `Expected trigger error, got ${writerResult.triggerError}`);
        assert.equal(writerResult.sameStatementRetried, true,
          "Retry must use the same retained statement (no second prepare)");

        // ── Acquirer JSON assertions ──

        assert.equal(acquirerResult.interceptedLockCount, 1,
          `Expected interceptedLockCount=1, got ${acquirerResult.interceptedLockCount}`);
        assert.equal(acquirerResult.phase, "ACQUIRED",
          `Expected phase=ACQUIRED, got ${acquirerResult.phase}`);
        assert.equal(acquirerResult.mode, "current",
          `Expected mode=current, got ${acquirerResult.mode}`);

        // ── Final DB state assertions ──

        db = new DatabaseSync(dbPath);

        // DDL normalization helper (mirrors production normalizeDdl)
        const normalizeDdl = (sql: string | null): string | null => {
          if (sql === null) return null;
          let s = sql.trim();
          while (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
          return s;
        };

        // Exact canonical DDL from frozen production at base commit 39dbf59
        // (inlined as test constants; not imported from production internals)
        const CANONICAL_GATE_DDL = `CREATE TABLE update_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('legacy', 'current')),
  phase TEXT NOT NULL CHECK (phase IN ('ACQUIRED', 'GUARDIAN_RECORDED', 'FAILED')),
  owner_pid INTEGER NOT NULL,
  owner_identity TEXT NOT NULL,
  guardian_pid INTEGER,
  guardian_identity TEXT,
  topology TEXT NOT NULL,
  artifacts TEXT NOT NULL,
  readiness TEXT NOT NULL,
  failure_reason TEXT,
  failure_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
        const CANONICAL_TRIGGER_INSERT_DDL = `CREATE TRIGGER trg_update_gate_block_runs_insert
BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM update_gate WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'update in progress');
END`;
        const CANONICAL_TRIGGER_UPDATE_DDL = `CREATE TRIGGER trg_update_gate_block_runs_update
BEFORE UPDATE OF status ON runs
WHEN EXISTS (SELECT 1 FROM update_gate WHERE id = 1)
  AND NEW.status = 'running' AND OLD.status != 'running'
BEGIN
  SELECT RAISE(ABORT, 'update in progress');
END`;
        const EXPECTED_SQL: Record<string, string | null> = {
          update_gate: CANONICAL_GATE_DDL,
          trg_update_gate_block_runs_insert: CANONICAL_TRIGGER_INSERT_DDL,
          trg_update_gate_block_runs_update: CANONICAL_TRIGGER_UPDATE_DDL,
        };

        // All three reserved artifacts exist with exact canonical types,
        // names, tbl_names, and normalized SQL
        const artifacts = db.prepare(
          "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE lower(name) IN (" +
          "'update_gate', 'trg_update_gate_block_runs_insert', 'trg_update_gate_block_runs_update')" +
          " ORDER BY lower(name)"
        ).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
        assert.equal(artifacts.length, 3,
          `Expected 3 reserved artifacts, got ${artifacts.length}: ${JSON.stringify(artifacts)}`);

        // Deterministic order: ORDER BY lower(name)
        assert.deepEqual(artifacts.map((a) => a.name),
          ["trg_update_gate_block_runs_insert",
            "trg_update_gate_block_runs_update",
            "update_gate"]);
        assert.deepEqual(artifacts.map((a) => a.type),
          ["trigger", "trigger", "table"]);
        assert.deepEqual(artifacts.map((a) => a.tbl_name),
          ["runs", "runs", "update_gate"]);

        // Deep-assert each artifact's normalized SQL against canonical DDL
        for (const a of artifacts) {
          const nameLower = a.name.toLowerCase();
          const expectedNormalized = normalizeDdl(EXPECTED_SQL[nameLower]);
          const actualNormalized = normalizeDdl(a.sql);
          assert.equal(actualNormalized, expectedNormalized,
            `Artifact ${a.name} normalized SQL mismatch.\nExpected:\n${expectedNormalized}\nActual:\n${actualNormalized}`);
        }

        // Gate singleton: exactly one row with complete field values
        const gateRows = db.prepare("SELECT * FROM update_gate").all() as Record<string, unknown>[];
        assert.equal(gateRows.length, 1,
          `Expected exactly 1 update_gate row, got ${gateRows.length}`);
        const gate = gateRows[0] as { id: number; phase: string; mode: string };
        assert.equal(gate.id, 1,
          `Expected gate id=1, got ${gate.id}`);
        assert.equal(gate.phase, "ACQUIRED",
          `Expected gate phase=ACQUIRED, got ${gate.phase}`);
        assert.equal(gate.mode, "current",
          `Expected gate mode=current, got ${gate.mode}`);

        // Legacy writer row race-run-1 does not exist
        const runRow = db.prepare("SELECT id FROM runs WHERE id = ?").get("race-run-1");
        assert.equal(runRow, undefined, "race-run-1 row must not exist");

        // No other runs row was inserted
        const runCount = (db.prepare("SELECT COUNT(*) AS cnt FROM runs").get() as { cnt: number }).cnt;
        assert.equal(runCount, 0,
          `Expected 0 runs rows, got ${runCount}`);
      } finally {
        // SIGKILL only live children (exitCode === null)
        if (writerChild && writerChild.exitCode === null) writerChild.kill("SIGKILL");
        if (acquirerChild && acquirerChild.exitCode === null) acquirerChild.kill("SIGKILL");

        // Close parent DB handle if still open
        if (db) {
          try { db.close(); } catch { /* ignore */ }
        }

        // Remove temp root
        try {
          fs.rmSync(temp.root, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  );
});

// ── OWNER: ancestry validation, identity, PID-reuse protection ──────────

describe("OWNER identity and ancestry", () => {
  it("coordinator self is refused as owner", () => {
    const temp = createTempHome("update-protocol-owner-self-");
    const dbPath = path.join(temp.root, "owner-self.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
try {
  // Pass its own PID as the updater — should be refused
  acquire("current", process.pid, "{}", "{}", "{}");
  console.log("UNEXPECTED: acquired with self PID");
} catch(e) {
  console.log("REFUSED: " + e.message);
}`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.equal(result.status, 0, `Process exited ${result.status}: ${result.stderr}`);
    assert.ok(
      result.stdout.includes("Coordinator itself cannot be the owner"),
      `Expected coordinator-self refusal, got: ${result.stdout}`,
    );
    assert.ok(!fs.existsSync(dbPath) || !tableExists(dbPath, "update_gate"));

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("live non-ancestor PID is refused", () => {
    const temp = createTempHome("update-protocol-owner-nonanc-");
    const dbPath = path.join(temp.root, "owner-nonanc.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // Find a PID that is definitely not an ancestor and not our process.
    // We first scan a range above our own PID to find one that doesn't exist
    // and isn't a parent.
    const ourPid = process.pid;
    // Collect PIDs in our ancestry to exclude
    const ancestryPids = new Set<number>();
    let p = ourPid;
    while (p > 1 && !ancestryPids.has(p)) {
      ancestryPids.add(p);
      try {
        const stat = fs.readFileSync(path.join("/", "proc", String(p), "stat"), "utf-8");
        const commEnd = stat.lastIndexOf(")");
        const afterComm = stat.slice(commEnd + 2);
        const fields = afterComm.split(" ");
        p = parseInt(fields[1], 10) || 0;
      } catch {
        break;
      }
    }
    // Find a high PID that doesn't exist
    let nonAncestorPid = ourPid + 10000;
    while (true) {
      try {
        process.kill(nonAncestorPid, 0);
        nonAncestorPid += 1000; // PID exists, try higher
      } catch {
        break; // PID doesn't exist, use it
      }
    }

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
try {
  acquire("current", ${nonAncestorPid}, "{}", "{}", "{}");
  console.log("UNEXPECTED: acquired with PID " + ${nonAncestorPid});
} catch(e) {
  console.log("REFUSED: " + e.message);
}`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes("is not an ancestor"),
      `Expected non-ancestor refusal, got: ${result.stdout}`,
    );
    assert.ok(!fs.existsSync(dbPath) || !tableExists(dbPath, "update_gate"));

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("exact parent PID is stored as owner", () => {
    const temp = createTempHome("update-protocol-owner-parent-");
    const dbPath = path.join(temp.root, "owner-parent.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // The child process's parent is the current process.
    // Pass process.pid explicitly so the child uses it as the owner.
    const ourPid = process.pid;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = acquire("legacy", ${ourPid}, JSON.stringify({a:1}), JSON.stringify({b:2}), JSON.stringify({c:3}));
console.log("OK:" + r.token);`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.equal(result.status, 0, `Acquire failed: ${result.stderr}, stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes("OK:"), `Expected OK, got: ${result.stdout}`);

    // Verify owner_pid is the current test process
    const db = new DatabaseSync(dbPath);
    const gate = db.prepare("SELECT owner_pid, mode, topology, artifacts, readiness FROM update_gate WHERE id = 1").get();
    db.close();
    assert.equal(gate.owner_pid, ourPid, "Owner PID should be the test process");
    assert.equal(gate.mode, "legacy");
    assert.equal(gate.topology, JSON.stringify({ a: 1 }));
    assert.equal(gate.artifacts, JSON.stringify({ b: 2 }));
    assert.equal(gate.readiness, JSON.stringify({ c: 3 }));

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("second updater is refused (gate already exists)", () => {
    const temp = createTempHome("update-protocol-second-");
    const dbPath = path.join(temp.root, "second.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // First acquire
    const firstResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = acquire("current", process.ppid, "{}", "{}", "{}");
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(firstResult.status, 0);

    // Second acquire should be refused
    const secondResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
try {
  acquire("legacy", process.ppid, "{}", "{}", "{}");
  console.log("UNEXPECTED: second acquire succeeded");
} catch(e) {
  console.log("REFUSED: " + e.message);
}`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(secondResult.status, 0);
    assert.ok(
      secondResult.stdout.includes("Update gate already exists"),
      `Expected gate-exists refusal, got: ${secondResult.stdout}`,
    );

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// ── OLD WRITER: trigger enforcement ──────────────────────────────────────

describe("OLD WRITER trigger enforcement", () => {
  it("old-style runs INSERT blocked by trigger when gate exists", () => {
    const temp = createTempHome("update-protocol-oldwriter-insert-");
    const dbPath = path.join(temp.root, "oldwriter-insert.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // Acquire first
    const acquireResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = acquire("current", process.ppid, "{}", "{}", "{}");
console.log("OK");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(acquireResult.status, 0, `Acquire failed: ${acquireResult.stderr}`);

    // Now try old-style INSERT from a separate process importing the real dist/db.js
    const writerResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { getDb, closeDb } from ${JSON.stringify(DIST_DB)};
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(homeDir)};
try {
  const db = getDb();
  db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("test-run-1", "wf-test", "test task", "running", new Date().toISOString(), new Date().toISOString());
  closeDb();
  console.log("UNEXPECTED: INSERT succeeded");
} catch(e) {
  console.log("TRIGGER_BLOCKED: " + e.message);
  process.exit(0);
}`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.equal(writerResult.status, 0);
    assert.ok(
      writerResult.stdout.includes("TRIGGER_BLOCKED: update in progress"),
      `Expected trigger error, got: ${writerResult.stdout}`,
    );

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("old-style runs status transition to running blocked by trigger", () => {
    const temp = createTempHome("update-protocol-oldwriter-update-");
    const dbPath = path.join(temp.root, "oldwriter-update.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // First, cold-init and insert a non-running run
    const setupResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { getDb, closeDb } from ${JSON.stringify(DIST_DB)};
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(homeDir)};
const db = getDb();
db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("test-run-1", "wf-test", "test task", "done", new Date().toISOString(), new Date().toISOString());
closeDb();
console.log("setup done");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(setupResult.status, 0, `Setup failed: ${setupResult.stderr}`);

    // Now acquire
    const acquireResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = acquire("current", process.ppid, "{}", "{}", "{}");
console.log("OK");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(acquireResult.status, 0, `Acquire failed: ${acquireResult.stderr}`);

    // Now try to transition the done run to running (should be blocked)
    const writerResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { getDb, closeDb } from ${JSON.stringify(DIST_DB)};
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(homeDir)};
try {
  const db = getDb();
  db.prepare("UPDATE runs SET status = ? WHERE id = ?").run("running", "test-run-1");
  closeDb();
  console.log("UNEXPECTED: UPDATE succeeded");
} catch(e) {
  console.log("TRIGGER_BLOCKED: " + e.message);
  process.exit(0);
}`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.equal(writerResult.status, 0);
    assert.ok(
      writerResult.stdout.includes("TRIGGER_BLOCKED: update in progress"),
      `Expected trigger block on UPDATE, got: ${writerResult.stdout}`,
    );

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// ── PHASES: legal and illegal transitions ────────────────────────────────

describe("PHASE transitions", () => {
  const roots = new Set<string>();
  // Each test gets its own isolated gate to avoid state leakage
  function setupAndAcquire() {
    const temp = createTempHome("update-protocol-phases-");
    roots.add(temp.root);
    const dbPath = path.join(temp.root, "phases.db");
    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // Acquire
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = acquire("current", process.ppid, "{}", "{}", "{}");
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(result.status, 0, `Acquire failed: ${result.stderr}`);
    const data = JSON.parse(result.stdout.trim());
    const token = data.token;
    const ownerPid = data.ownerPid;
    const ownerIdentity = data.ownerIdentity;
    return { temp, dbPath, env, token, ownerPid, ownerIdentity };
  }

  afterEach(() => {
    const captured = [...roots];
    const failures: Error[] = [];
    try {
      for (const root of captured) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
          assert.ok(!fs.existsSync(root), `temp root still exists after removal: ${root}`);
        } catch (e) {
          failures.push(e instanceof Error ? e : new Error(String(e)));
        }
      }
      if (failures.length > 0) {
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, `${failures.length} temp root removal failures`);
      }
    } finally {
      roots.clear();
    }
  });

  it("ACQUIRED -> GUARDIAN_RECORDED is legal (via recordGuardian)", () => {
    const { token, env, ownerPid, ownerIdentity } = setupAndAcquire();

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { recordGuardian, captureProcessIdentity } from ${JSON.stringify(PROTOCOL_MODULE)};
const gid = captureProcessIdentity(process.pid);
const r = recordGuardian(${JSON.stringify(token)}, "ACQUIRED", ${ownerPid}, ${JSON.stringify(ownerIdentity)}, process.pid, gid);
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(result.status, 0);
    const gr = JSON.parse(result.stdout.trim());
    assert.equal(gr.changed, true);
    assert.equal(gr.phase, "GUARDIAN_RECORDED");
  });

  it("ACQUIRED -> FAILED is legal", () => {
    const { token, env, ownerPid, ownerIdentity } = setupAndAcquire();

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { fail } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = fail(${JSON.stringify(token)}, "ACQUIRED", ${ownerPid}, ${JSON.stringify(ownerIdentity)}, "reason", "details");
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(result.status, 0);
    const fr = JSON.parse(result.stdout.trim());
    assert.equal(fr.changed, true);
    assert.equal(fr.phase, "FAILED");
  });

  it("GUARDIAN_RECORDED -> FAILED is legal", () => {
    const { token, env, ownerPid, ownerIdentity } = setupAndAcquire();

    // First record guardian
    const gr = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { recordGuardian, captureProcessIdentity } from ${JSON.stringify(PROTOCOL_MODULE)};
const gid = captureProcessIdentity(process.pid);
const r = recordGuardian(${JSON.stringify(token)}, "ACQUIRED", ${ownerPid}, ${JSON.stringify(ownerIdentity)}, process.pid, gid);
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(JSON.parse(gr.stdout.trim()).changed, true);

    // Then fail
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { fail } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = fail(${JSON.stringify(token)}, "GUARDIAN_RECORDED", ${ownerPid}, ${JSON.stringify(ownerIdentity)}, "reason", "details");
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(result.status, 0);
    const fr = JSON.parse(result.stdout.trim());
    assert.equal(fr.changed, true);
    assert.equal(fr.phase, "FAILED");
  });

  it("FAILED row still blocks writers", () => {
    const { token, env, dbPath, ownerPid, ownerIdentity } = setupAndAcquire();

    // Fail the gate
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { fail } from ${JSON.stringify(PROTOCOL_MODULE)};
fail(${JSON.stringify(token)}, "ACQUIRED", ${ownerPid}, ${JSON.stringify(ownerIdentity)}, "reason", "details");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    // Try INSERT — should still be blocked
    const writerResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(dbPath)});
try {
  db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("test-run-1", "wf-test", "task", "running", new Date().toISOString(), new Date().toISOString());
  console.log("UNEXPECTED_INSERT_OK");
} catch(e) {
  console.log("BLOCKED: " + e.message);
}
db.close();`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.ok(
      writerResult.stdout.includes("BLOCKED: update in progress"),
      `FAILED gate should still block INSERTs, got: ${writerResult.stdout}`,
    );

    // isGateActive should report true
    const activeResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { isGateActive } from ${JSON.stringify(PROTOCOL_MODULE)};
console.log(isGateActive() ? "ACTIVE" : "INACTIVE");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.ok(
      activeResult.stdout.includes("ACTIVE"),
      "isGateActive should report true for FAILED gate",
    );
  });
});

// ── CLEANUP: no surviving child processes ────────────────────────────────

describe("Cold/active cleanup", () => {
  it("exact child identities are retained and terminated in finally", { timeout: 30000 }, async () => {
    const temp = createTempHome("update-protocol-cleanup-");
    const dbPath = path.join(temp.root, "cleanup.db");
    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    let child: ReturnType<typeof spawn> | null = null;
    let childPid: number | null = null;
    let stdout = "";
    let stderr = "";
    let closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
    let childError: Error | null = null;
    let closeResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let bodyError: Error | null = null;
    let readinessReject: ((err: Error) => void) | null = null;
    const cleanupErrors: Error[] = [];

    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import fs from "node:fs";
import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = acquire("current", process.ppid, "{}", "{}", "{}");
fs.writeSync(1, JSON.stringify({ phase: r.phase, mode: r.mode }) + "\\n");
// Stay alive with a referenced handle to prove live-child cleanup
const keepalive = setInterval(() => {}, 10000);`,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );

      childPid = child.pid!;

      // Permanent capture listeners — never removed
      child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

      // Single error handler — retains error for diagnostics, rejects readiness
      child.on("error", (err: Error) => {
        childError = err;
        if (readinessReject) readinessReject(err);
      });

      // Register close promise immediately for reaping in finally
      closePromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child!.on("close", (code, signal) => resolve({ code, signal }));
      });

      // Readiness: wait for first newline-delimited record with bounded deadline
      let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
      let onReadyData: ((d: Buffer) => void) | null = null;
      let jsonLine: unknown;
      try {
        jsonLine = await new Promise<unknown>((resolve, reject) => {
          readinessReject = reject;
          onReadyData = () => {
            const nl = stdout.indexOf("\n");
            if (nl >= 0) {
              child!.stdout!.removeListener("data", onReadyData!);
              const line = stdout.slice(0, nl);
              try {
                resolve(JSON.parse(line));
              } catch (e) {
                reject(
                  new Error(
                    `Failed to parse child JSON: ${(e as Error).message}`,
                  ),
                );
              }
            }
          };
          child!.stdout!.on("data", onReadyData);
          readinessDeadline = setTimeout(() => {
            child!.stdout!.removeListener("data", onReadyData!);
            reject(new Error("Child output readiness timed out"));
          }, 8000);
        });
      } finally {
        clearTimeout(readinessDeadline);
        readinessReject = null;
        if (onReadyData) child!.stdout!.removeListener("data", onReadyData);
      }

      // Before cleanup: prove child is genuinely live with valid acquisition
      assert.equal(
        childError,
        null,
        "child should have no error before cleanup",
      );
      assert.ok(
        typeof childPid === "number" &&
          Number.isSafeInteger(childPid) &&
          childPid > 0,
        `childPid must be canonical positive safe integer, got ${childPid}`,
      );
      assert.equal(
        childPid,
        child!.pid,
        "childPid must match retained handle PID",
      );
      assert.deepStrictEqual(jsonLine, {
        phase: "ACQUIRED",
        mode: "current",
      });
      assert.equal(
        child!.exitCode,
        null,
        "child must be live before cleanup",
      );
    } catch (e) {
      bodyError = e instanceof Error ? e : new Error(String(e));
    } finally {
      // Signal only the retained handle and only if child is live
      if (child && child.exitCode === null) {
        try {
          const killed = child.kill("SIGKILL");
          if (!killed) {
            cleanupErrors.push(
              new Error("cleanup: kill signal not delivered"),
            );
          }
        } catch (e) {
          cleanupErrors.push(
            e instanceof Error ? e : new Error(String(e)),
          );
        }
      }
      // Await reaping of the exact child with bounded safety deadline
      if (closePromise) {
        let closeDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          closeResult = await Promise.race([
            closePromise,
            new Promise<never>((_, reject) => {
              closeDeadline = setTimeout(
                () => reject(new Error("cleanup: close timed out")),
                5000,
              );
            }),
          ]);
        } catch (e) {
          cleanupErrors.push(
            e instanceof Error ? e : new Error(String(e)),
          );
        } finally {
          clearTimeout(closeDeadline);
        }
      }
      // Un-suppressed recursive temp removal — always attempted
      try {
        fs.rmSync(temp.root, { recursive: true, force: true });
      } catch (e) {
        cleanupErrors.push(
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    }

    // Combine body and cleanup errors so neither class is silently discarded
    const allErrors: Error[] = [];
    if (bodyError) allErrors.push(bodyError);
    allErrors.push(...cleanupErrors);

    if (allErrors.length === 1) throw allErrors[0];
    if (allErrors.length > 1) {
      throw new AggregateError(
        allErrors,
        `${allErrors.length} errors (body + cleanup)`,
      );
    }

    // Success-path assertions
    assert.strictEqual(
      closeResult!.code,
      null,
      "child close code must be null (killed by signal)",
    );
    assert.strictEqual(
      closeResult!.signal,
      "SIGKILL",
      "child must be killed by SIGKILL",
    );
    assert.equal(childError, null, "child should have no retained error");
    // Byte-for-byte: single non-secret JSON line plus newline
    assert.equal(
      stdout,
      JSON.stringify({ phase: "ACQUIRED", mode: "current" }) + "\n",
      "stdout must be exactly the non-secret JSON line plus newline",
    );
    assert.equal(stderr, "", "stderr must be empty");
    assert.ok(
      !fs.existsSync(temp.root),
      "temp root must be absent after cleanup",
    );
  });
});

// ── TOKEN CONTRACT: 256-bit base64url token and five-field authority ─────

describe("TOKEN contract and five-field return", () => {
  it("acquire returns 43-char base64url token and five-field authority with ownerPid/ownerIdentity parity", () => {
    const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
    const tempA = createTempHome("upgx-token-a-");
    const tempB = createTempHome("upgx-token-b-");
    try {
      const dbA = path.join(tempA.root, "a.db");
      const dbB = path.join(tempB.root, "b.db");

      const resultA = runAcquire(tempA, dbA);
      assert.equal(resultA.status, 0, `acquisition A failed: ${resultA.stderr}`);
      const dataA = JSON.parse(resultA.stdout.trim());

      const resultB = runAcquire(tempB, dbB);
      assert.equal(resultB.status, 0, `acquisition B failed: ${resultB.stderr}`);
      const dataB = JSON.parse(resultB.stdout.trim());

      // 43-char base64url, no padding, 32 bytes decoded
      assert.ok(TOKEN_RE.test(dataA.token), "token A should be 43-char base64url");
      assert.ok(TOKEN_RE.test(dataB.token), "token B should be 43-char base64url");
      assert.ok(!dataA.token.includes("="), "token A should not contain padding");
      assert.ok(!dataB.token.includes("="), "token B should not contain padding");
      assert.equal(Buffer.from(dataA.token, "base64url").length, 32, "token A decodes to 32 bytes");
      assert.equal(Buffer.from(dataB.token, "base64url").length, 32, "token B decodes to 32 bytes");

      // Two independent acquisitions produce different tokens
      assert.ok(dataA.token !== dataB.token, "tokens from two acquisitions should differ");

      // Exact sorted key set
      const expectedKeys = ["mode", "ownerIdentity", "ownerPid", "phase", "token"];
      assert.deepEqual(Object.keys(dataA).sort(), expectedKeys);
      assert.deepEqual(Object.keys(dataB).sort(), expectedKeys);

      // Phase and mode values
      assert.equal(dataA.phase, "ACQUIRED");
      assert.equal(dataA.mode, "current");
      assert.equal(dataB.phase, "ACQUIRED");
      assert.equal(dataB.mode, "current");

      // ownerPid equals the test parent PID (child passes process.ppid)
      assert.equal(dataA.ownerPid, process.pid, "ownerPid A should equal parent process.pid");
      assert.equal(dataB.ownerPid, process.pid, "ownerPid B should equal parent process.pid");

      // Query gate rows and verify parity
      for (const [idx, dbPath] of [dbA, dbB].entries()) {
        const data = idx === 0 ? dataA : dataB;
        const db = new DatabaseSync(dbPath);
        try {
          const row = db.prepare("SELECT token, owner_pid, owner_identity FROM update_gate WHERE id = 1").get();
          assert.ok(row, "gate row should exist");
          assert.ok(data.token === row.token, "returned token should match persisted token");
          assert.equal(row.owner_pid, process.pid, "persisted owner_pid should equal parent process.pid");
          assert.ok(data.ownerIdentity === row.owner_identity, "returned ownerIdentity should match persisted");
        } finally {
          db.close();
        }
      }
    } finally {
      try { fs.rmSync(tempA.root, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(tempB.root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ── INSPECT REDACTION: token is never disclosed via inspect() ────────────

describe("inspect redaction", () => {
  const ALLOWLIST = ["artifacts","created_at","failure_details","failure_reason",
    "guardian_identity","guardian_pid","id","mode","owner_identity",
    "owner_pid","phase","readiness","topology","updated_at"].sort();

  it("inspect() returns 14-key view without token; token persists in DB; stdout/stderr clean", () => {
    const temp = createTempHome("upgx-inspect-redaction-");
    try {
      const hd = temp.homeDir;
      const sd = path.join(hd, ".tamandua");
      const dp = path.join(temp.root, "redaction.db");
      fs.mkdirSync(sd, { recursive: true });
      const env = { HOME: hd, TAMANDUA_STATE_DIR: sd, TAMANDUA_DB_PATH: dp };

      // 1. Acquire through real coordinator CLI
      const aq = runNode([COORDINATOR_CLI, "acquire", "current", String(process.pid), "{}", "{}", "{}"], env);
      assert.equal(aq.status, 0, `Acquire failed: ${aq.stderr}`);
      const ad = JSON.parse(aq.stdout.trim());
      assert.ok(ad.token);
      const tok = ad.token;

      // 2. Read persisted gate row, prove token matches
      let pre;
      { const db = new DatabaseSync(dp);
        try { pre = db.prepare("SELECT * FROM update_gate WHERE id = 1").get();
          assert.ok(pre); assert.equal(pre.token, tok); }
        finally { db.close(); } }

      // 3a. Module inspect
      const mr = runNode(["--input-type=module", "-e",
        `import { inspect } from ${JSON.stringify(PROTOCOL_MODULE)};
console.log(JSON.stringify(inspect()));`], env);
      assert.equal(mr.status, 0, `Module inspect: ${mr.stderr || ""}`);

      // 3b. Coordinator inspect
      const cr = runNode([COORDINATOR_CLI, "inspect"], env);
      assert.equal(cr.status, 0, `Coord inspect: ${cr.stderr}`);

      const mg = JSON.parse(mr.stdout.trim());
      const cg = JSON.parse(cr.stdout.trim()).gate;

      // 4. Assert non-null, 14-key allowlist, no token, field parity, clean stdout/stderr
      assert.ok(mg !== null); assert.ok(cg !== null);
      for (const [l, g] of [["mod", mg], ["cli", cg]] as const) {
        assert.deepEqual(Object.keys(g).sort(), ALLOWLIST, `${l}: allowlist mismatch`);
        assert.ok(!("token" in g), `${l}: token present`);
        for (const k of ALLOWLIST) assert.deepEqual(g[k], pre[k], `${l}: ${k} mismatch`);
      }
      assert.ok(!mr.stdout.includes(tok) && !mr.stderr.includes(tok), "module output leaked token");
      assert.ok(!cr.stdout.includes(tok) && !cr.stderr.includes(tok), "coordinator output leaked token");

      // 5. Re-read DB row; prove deep equality and token persistence
      { const db2 = new DatabaseSync(dp);
        try { const post = db2.prepare("SELECT * FROM update_gate WHERE id = 1").get();
          assert.deepEqual(post, pre, "post-inspect should equal pre-inspect");
          assert.equal(post.token, tok); }
        finally { db2.close(); } }
    } finally {
      try { fs.rmSync(temp.root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ── COORDINATOR: phase-cas is removed, inspect survives ──────────────────

describe("COORDINATOR phase-cas removal", () => {
  it("phase-cas rejected as unknown; inspect still loads and returns null gate", () => {
    const temp = createTempHome("update-protocol-cas-removed-");
    const dbPath = path.join(temp.root, "no-db-create.db");
    assert.ok(!fs.existsSync(dbPath), "DB should not exist before test");

    // phase-cas should be rejected as unknown command
    const phaseCasResult = spawnSync(
      process.execPath,
      [COORDINATOR_CLI, "phase-cas", "token", "ACQUIRED", "FAILED", "1", "ident"],
      {
        encoding: "utf-8",
        timeout: 30000,
        env: cleanChildEnv({
          HOME: temp.homeDir,
          TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
          TAMANDUA_DB_PATH: dbPath,
        }),
      },
    );
    assert.equal(phaseCasResult.status, 2, `phase-cas exit: ${phaseCasResult.status}`);
    assert.equal(phaseCasResult.stdout.trim(), "", "phase-cas should not emit JSON");
    assert.ok(phaseCasResult.stderr.includes("Unknown command"), `Expected 'Unknown command' in: ${phaseCasResult.stderr}`);
    assert.ok(!fs.existsSync(dbPath), "DB should NOT be created by phase-cas unknown-command rejection");

    // inspect should still work and return null gate
    const inspectResult = spawnSync(
      process.execPath,
      [COORDINATOR_CLI, "inspect"],
      {
        encoding: "utf-8",
        timeout: 30000,
        env: cleanChildEnv({
          HOME: temp.homeDir,
          TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
          TAMANDUA_DB_PATH: dbPath,
        }),
      },
    );
    assert.equal(inspectResult.status, 0, `inspect exit: ${inspectResult.status}`);
    const inspectOutput = JSON.parse(inspectResult.stdout.trim());
    assert.equal(inspectOutput.gate, null, "inspect should return null gate on absent DB");
    assert.ok(!fs.existsSync(dbPath), "inspect should not create DB on absent DB");

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// ── ACQUIRE: direct-input contract ───────────────────────────────────────

describe("acquire direct-input contract", () => {
  const INVALID = "Invalid argument";
  const BOUND = 4096;

  function withEnv(temp, fn) {
    const save = { HOME: process.env.HOME, TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR, TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH };
    try {
      process.env.HOME = temp.homeDir;
      process.env.TAMANDUA_STATE_DIR = temp.tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(temp.root, "test.db");
      return fn();
    } finally {
      for (const [k, v] of Object.entries(save)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  async function loadAcquire() {
    return (await import(PROTOCOL_MODULE)).acquire;
  }

  it("rejects all invalid direct inputs before I/O with bounded generic diagnostics", async () => {
    const acquire = await loadAcquire();

    // 4097-byte valid JSON: "{}" padded with spaces; first 4096 bytes also valid JSON (old bust would pass)
    const OVER = "{}" + " ".repeat(BOUND - 1);
    // multibyte: 1366 × U+20AC (€, 3 UTF-8 bytes each) = 4098 bytes, JS .length = 1366 < 4096
    const MB = JSON.stringify("\u20AC".repeat(1366));
    // huge sentinel-bearing strings for no-echo diagnostics
    const HUGE_MODE = "MODE_SENTINEL_" + "m".repeat(5000);
    const HUGE_PID = "PID_SENTINEL_" + "9".repeat(5000);
    // poison object that throws on coercion — proves production never invokes String()
    const POISON = { [Symbol.toPrimitive]: () => { throw new Error("coerced"); } };

    // pre-assert OVER properties: valid JSON, 4097 bytes, first 4096 bytes also parse
    assert.equal(Buffer.byteLength(OVER, "utf8"), BOUND + 1);
    assert.doesNotThrow(() => JSON.parse(OVER));
    assert.doesNotThrow(() => JSON.parse(OVER.slice(0, BOUND)));

    const cases: Array<[unknown, unknown, unknown, unknown, unknown, string]> = [
      // invalid/non-string mode
      [null, 1, "{}", "{}", "{}", "Invalid mode"],
      ["bogus", 1, "{}", "{}", "{}", "Invalid mode"],
      [42, 1, "{}", "{}", "{}", "Invalid mode"],
      [true, 1, "{}", "{}", "{}", "Invalid mode"],
      [POISON, 1, "{}", "{}", "{}", "Invalid mode"],
      [HUGE_MODE, 1, "{}", "{}", "{}", "Invalid mode"],
      // invalid PID shapes
      ["current", 0, "{}", "{}", "{}", "Invalid updater PID"],
      ["current", -1, "{}", "{}", "{}", "Invalid updater PID"],
      ["current", 1.5, "{}", "{}", "{}", "Invalid updater PID"],
      ["current", null, "{}", "{}", "{}", "Invalid updater PID"],
      ["current", "99999", "{}", "{}", "{}", "Invalid updater PID"],
      ["current", POISON, "{}", "{}", "{}", "Invalid updater PID"],
      ["current", HUGE_PID, "{}", "{}", "{}", "Invalid updater PID"],
      // non-string topology
      ["current", 1, null, "{}", "{}", INVALID],
      ["current", 1, 42, "{}", "{}", INVALID],
      ["current", 1, true, "{}", "{}", INVALID],
      ["current", 1, { a: 1 }, "{}", "{}", INVALID],
      // non-string artifacts
      ["current", 1, "{}", undefined, "{}", INVALID],
      ["current", 1, "{}", [], "{}", INVALID],
      // non-string readiness
      ["current", 1, "{}", "{}", null, INVALID],
      // invalid JSON
      ["current", 1, "{bad", "{}", "{}", "topology is not valid JSON"],
      ["current", 1, "{}", "nope", "{}", "artifacts is not valid JSON"],
      ["current", 1, "{}", "{}", "[}", "readiness is not valid JSON"],
      // oversized: 4097 valid JSON bytes (old bust would NOT reject — truncation bypass proof)
      ["current", 1, OVER, "{}", "{}", INVALID],
      ["current", 1, "{}", OVER, "{}", INVALID],
      ["current", 1, "{}", "{}", OVER, INVALID],
      // multibyte: JS .length < 4096 but UTF-8 size > 4096 (old truncation bypass)
      ["current", 1, MB, "{}", "{}", INVALID],
      ["current", 1, "{}", MB, "{}", INVALID],
      ["current", 1, "{}", "{}", MB, INVALID],
    ];

    for (let i = 0; i < cases.length; i++) {
      const [mode, pid, topo, art, ready, expected] = cases[i];
      const temp = createTempHome("upgx-dic-");
      const dbPath = path.join(temp.root, "test.db");
      try {
        let threw = false, errMsg = "";
        try {
          withEnv(temp, () => acquire(mode, pid, topo, art, ready));
        } catch (e: any) {
          threw = true;
          errMsg = e.message;
        }
        assert.ok(threw, `Expected rejection for case #${i}`);
        assert.equal(errMsg, expected, `Expected "${expected}", got "${errMsg}"`);
        // fixed diagnostics must not echo caller values — verify no payload leaks
        if (typeof mode === "string" && mode.length > 100) {
          assert.ok(!errMsg.includes(mode), `mode echoed: ${errMsg.slice(0, 80)}`);
        }
        if (typeof pid === "string" && pid.length > 100) {
          assert.ok(!errMsg.includes(pid), `pid echoed: ${errMsg.slice(0, 80)}`);
        }
        for (const val of [topo, art, ready]) {
          if (typeof val === "string" && val.length > 100) {
            assert.ok(!errMsg.includes(val.slice(0, 10)), `payload echoed: ${errMsg.slice(0, 80)}`);
          }
        }
        // DB must not exist after pre-I/O rejection
        assert.ok(!fs.existsSync(dbPath), `DB created after pre-I/O rejection`);
      } finally {
        try { fs.rmSync(temp.root, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });

  it("persists exact 4096-byte JSON strings with correct five-field authority", async () => {
    const acquire = await loadAcquire();

    const make4096 = (key: string): string => {
      const prefix = `{"${key}":"`;
      const suffix = '"}';
      const overhead = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
      return prefix + "x".repeat(BOUND - overhead) + suffix;
    };
    const topo4096 = make4096("t");
    const art4096 = make4096("a");
    const ready4096 = make4096("r");

    assert.equal(Buffer.byteLength(topo4096, "utf8"), BOUND, "topology not exactly 4096 bytes");
    assert.equal(Buffer.byteLength(art4096, "utf8"), BOUND, "artifacts not exactly 4096 bytes");
    assert.equal(Buffer.byteLength(ready4096, "utf8"), BOUND, "readiness not exactly 4096 bytes");
    assert.ok(typeof JSON.parse(topo4096).t === "string");
    assert.ok(typeof JSON.parse(art4096).a === "string");
    assert.ok(typeof JSON.parse(ready4096).r === "string");
    assert.notEqual(topo4096, art4096);
    assert.notEqual(art4096, ready4096);

    const temp = createTempHome("upgx-dic-valid-");
    const dbPath = path.join(temp.root, "test.db");
    try {
      const result = withEnv(temp, () =>
        acquire("current", process.ppid, topo4096, art4096, ready4096),
      );

      assert.deepEqual(Object.keys(result).sort(), ["mode", "ownerIdentity", "ownerPid", "phase", "token"]);
      assert.equal(result.phase, "ACQUIRED");
      assert.equal(result.mode, "current");
      assert.equal(typeof result.token, "string");
      assert.ok(/^[A-Za-z0-9_-]{43}$/.test(result.token));

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare(
          "SELECT topology, artifacts, readiness FROM update_gate WHERE id = 1",
        ).get() as { topology: string; artifacts: string; readiness: string };
        // per-field byte-length assertions
        assert.equal(Buffer.byteLength(row.topology, "utf8"), BOUND, "persisted topology wrong byte length");
        assert.equal(Buffer.byteLength(row.artifacts, "utf8"), BOUND, "persisted artifacts wrong byte length");
        assert.equal(Buffer.byteLength(row.readiness, "utf8"), BOUND, "persisted readiness wrong byte length");
        // whole-row deep equality on normalized plain-object three-field row
        const normalized = { topology: row.topology, artifacts: row.artifacts, readiness: row.readiness };
        assert.deepEqual(normalized, { topology: topo4096, artifacts: art4096, readiness: ready4096 });
      } finally {
        db.close();
      }
    } finally {
      try { fs.rmSync(temp.root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ── COORDINATOR CONTRACT: strict parser, authority, UTF-8, output caps ──

describe("coordinator-contract", () => {
  const DUMB_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const DUMB_ID = '{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"1"}';
  const LONG_CMD = "x".repeat(4100);
  const LONG_DIGITS = "1".repeat(4100);
  const LONG_STR = "y".repeat(5000);

  function envFor(temp) {
    return cleanChildEnv({
      HOME: temp.homeDir,
      TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: path.join(temp.root, "test.db"),
    });
  }

  // exact-failure assertion: status 2, stdout exactly "", DB absent, stderr match
  function assertRej(r, expectedStderr) {
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, expectedStderr);
    assert.ok(Buffer.byteLength(r.stderr, "utf-8") <= 4096);
  }

  function snap(dbPath) {
    const d = new DatabaseSync(dbPath);
    try { return d.prepare("SELECT * FROM update_gate WHERE id = 1").get(); }
    finally { d.close(); }
  }

  function publicRow(dbPath) {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    try { return { ...d.prepare("SELECT artifacts, created_at, failure_details, failure_reason, guardian_identity, guardian_pid, id, mode, owner_identity, owner_pid, phase, readiness, topology, updated_at FROM update_gate WHERE id = 1").get() }; }
    finally { d.close(); }
  }

  // ── Case 1: strict parser and all pre-I/O rejection boundaries ─────────

  it("strict parser and all pre-I/O rejection boundaries", () => {
    const temp = createTempHome("upgx-cc-bdy-");
    const e = envFor(temp);
    const dbPath = path.join(temp.root, "test.db");
    function assertPreIoRejection(r, expectedStderr) {
      assertRej(r, expectedStderr);
      assert.ok(!fs.existsSync(dbPath), `DB exists after pre-I/O rejection: ${expectedStderr.trim()}`);
    }

    try {
      // No command → usage — pre-I/O proof
      assertPreIoRejection(runNode([COORDINATOR_CLI], e), "Usage: update-coordinator.mjs <acquire|inspect|record-guardian-cas|fail> [args...]\n");

      // Unknown commands (ordinary-unknown, inherited-property, >4096-byte) → exact "Unknown command\n" + pre-I/O proof
      for (const cmd of ["ordinary-unknown", "toString", "constructor", "__proto__", LONG_CMD]) {
        const r = runNode([COORDINATOR_CLI, cmd], e);
        assertPreIoRejection(r, "Unknown command\n");
        assert.ok(!r.stderr.includes(cmd.slice(0, 4)), `command echoed for ${cmd}`);
      }

      // ── Arity boundaries for all four commands ──
      const arityTests = [
        { cmd: "acquire", payload: 5 },
        { cmd: "inspect", payload: 0 },
        { cmd: "record-guardian-cas", payload: 6 },
        { cmd: "fail", payload: 6 },
      ];
      for (const { cmd, payload } of arityTests) {
        const err = `Invalid argument count for ${cmd}\n`;
        // too few (skip when payload is 0 — no too-few for inspect)
        if (payload > 0) {
          assertPreIoRejection(runNode([COORDINATOR_CLI, cmd, ...Array(payload - 1).fill("x")], e), err);
        }
        // too many — ordinary extra → pre-I/O proof
        assertPreIoRejection(runNode([COORDINATOR_CLI, cmd, ...Array(payload + 1).fill("x")], e), err);
        // too many — >4096-byte extra → individual pre-I/O proof + byte-identical stderr
        const rOrd = runNode([COORDINATOR_CLI, cmd, ...Array(payload).fill("x"), "extra"], e);
        const rBig = runNode([COORDINATOR_CLI, cmd, ...Array(payload).fill("x"), LONG_STR], e);
        assertPreIoRejection(rOrd, err);
        assertPreIoRejection(rBig, err);
        assert.equal(rOrd.stderr, rBig.stderr, `extra-arg identity mismatch for ${cmd}`);
      }

      // obsolete three-field guardian / fail → arity error + pre-I/O proof
      assertPreIoRejection(runNode([COORDINATOR_CLI, "record-guardian-cas", "tok", "1", "id"], e),
        "Invalid argument count for record-guardian-cas\n");
      assertPreIoRejection(runNode([COORDINATOR_CLI, "fail", "tok", "r", "d"], e),
        "Invalid argument count for fail\n");

      // ── Bound checks after valid arity (oversized safeBoundArg fields) — per-invocation pre-I/O proof ──
      // acquire mode
      assertPreIoRejection(runNode([COORDINATOR_CLI, "acquire", LONG_STR, "1", "{}", "{}", "{}"], e), "Invalid argument\n");
      // acquire topology
      assertPreIoRejection(runNode([COORDINATOR_CLI, "acquire", "current", "1", LONG_STR, "{}", "{}"], e), "Invalid argument\n");
      // guardian token
      assertPreIoRejection(runNode([COORDINATOR_CLI, "record-guardian-cas", LONG_STR, "ACQUIRED", "1", DUMB_ID, "1", DUMB_ID], e), "Invalid argument\n");
      // guardian expected-owner identity
      assertPreIoRejection(runNode([COORDINATOR_CLI, "record-guardian-cas", DUMB_TOKEN, "ACQUIRED", "1", LONG_STR, "1", DUMB_ID], e), "Invalid argument\n");
      // guardian expected-guardian identity
      assertPreIoRejection(runNode([COORDINATOR_CLI, "record-guardian-cas", DUMB_TOKEN, "ACQUIRED", "1", DUMB_ID, "1", LONG_STR], e), "Invalid argument\n");
      // fail details
      assertPreIoRejection(runNode([COORDINATOR_CLI, "fail", DUMB_TOKEN, "ACQUIRED", "1", DUMB_ID, "r", LONG_STR], e), "Invalid argument\n");

      // ── PID spelling/value: 11 bad values × 4 positions = 44 rejections ──
      const badPids = [
        "0", "-1", "+1", "01", " 1", "1 ", "1junk", "1.0", "1e0",
        "9007199254740992", LONG_DIGITS,
      ];
      // position helper: args array builder for each of the 4 PID slots
      function pidArgs(pos, badPid) {
        switch (pos) {
          case "acquire-updater":
            return [COORDINATOR_CLI, "acquire", "current", badPid, "{}", "{}", "{}"];
          case "guardian-expected-owner":
            return [COORDINATOR_CLI, "record-guardian-cas", DUMB_TOKEN, "ACQUIRED", badPid, DUMB_ID, "1", DUMB_ID];
          case "guardian-pid":
            return [COORDINATOR_CLI, "record-guardian-cas", DUMB_TOKEN, "ACQUIRED", "1", DUMB_ID, badPid, DUMB_ID];
          case "fail-expected-owner":
            return [COORDINATOR_CLI, "fail", DUMB_TOKEN, "ACQUIRED", badPid, DUMB_ID, "r", "d"];
          default:
            throw new Error(`unknown position: ${pos}`);
        }
      }
      const positions = ["acquire-updater", "guardian-expected-owner", "guardian-pid", "fail-expected-owner"];
      for (const pos of positions) {
        for (const bp of badPids) {
          assertPreIoRejection(runNode(pidArgs(pos, bp), e), "Invalid argument\n");
        }
      }
    } finally {
      try { fs.rmSync(temp.root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── Case 2: real six-field authority flow and compatibility ────────────

  it("real six-field authority flow and compatibility", () => {
    const temp = createTempHome("upgx-cc-auth-");
    const e = envFor(temp);
    const dbPath = path.join(temp.root, "test.db");
    try {
      // (1) Acquire — deep-equal the entire result object
      const rAcq = runNode([COORDINATOR_CLI, "acquire", "current", String(process.pid), "{}", "{}", "{}"], e);
      assert.equal(rAcq.status, 0, rAcq.stderr);
      const ad = JSON.parse(rAcq.stdout);
      assert.equal(ad.phase, "ACQUIRED");
      assert.equal(ad.mode, "current");
      assert.equal(ad.ownerPid, process.pid);
      assert.equal(typeof ad.ownerIdentity, "string");
      assert.equal(typeof ad.token, "string");
      // validate 43-char base64url token
      assert.ok(/^[A-Za-z0-9_-]{43}$/.test(ad.token), `bad token format: ${ad.token}`);
      assert.deepEqual(ad, {
        token: ad.token,
        phase: "ACQUIRED",
        mode: "current",
        ownerPid: process.pid,
        ownerIdentity: ad.ownerIdentity,
      });
      // DB parity — explicit five-field aliased query with deep equality
      {
        let row;
        {
          const d = new DatabaseSync(dbPath);
          try { row = d.prepare("SELECT token, phase, mode, owner_pid AS ownerPid, owner_identity AS ownerIdentity FROM update_gate WHERE id = 1").get(); }
          finally { d.close(); }
        }
        assert.deepEqual({ ...row }, {
          token: ad.token,
          phase: "ACQUIRED",
          mode: "current",
          ownerPid: process.pid,
          ownerIdentity: ad.ownerIdentity,
        });
      }

      // (2) Capture the still-live test parent process identity via helper child
      const capOut = runNode(["--input-type=module", "-e",
        `import { captureProcessIdentity } from ${JSON.stringify(PROTOCOL_MODULE)}; console.log(captureProcessIdentity(${process.pid}));`], e);
      assert.equal(capOut.status, 0, capOut.stderr);
      const gid = capOut.stdout.trim();
      assert.ok(gid.length > 0);
      const ps = String(process.pid);

      // (3) Full SELECT * snapshot → syntactically-valid six-field guardian with wrong authority
      const preGuard = snap(dbPath);
      assertRej(runNode([COORDINATOR_CLI, "record-guardian-cas", ad.token, "ACQUIRED", "99999", ad.ownerIdentity, ps, gid], e),
        "Record-guardian refused\n");
      assert.deepEqual(snap(dbPath), preGuard, "row changed on refused guardian");

      // (4) Correct six-field guardian — deep-equal result, no token in stdout/stderr
      const rGok = runNode([COORDINATOR_CLI, "record-guardian-cas", ad.token, "ACQUIRED", ps, ad.ownerIdentity, ps, gid], e);
      assert.equal(rGok.status, 0, rGok.stderr);
      const gr = JSON.parse(rGok.stdout);
      assert.deepEqual(gr, { changed: true, phase: "GUARDIAN_RECORDED" });
      assert.ok(!rGok.stdout.includes(ad.token) && !rGok.stderr.includes(ad.token), "token leaked in guardian output");
      {
        const row = snap(dbPath);
        assert.equal(row.guardian_pid, process.pid);
        assert.equal(row.guardian_identity, gid);
        assert.equal(row.phase, "GUARDIAN_RECORDED");
        // unrelated fields unchanged (except updated_at)
        for (const k of Object.keys(preGuard)) {
          if (k === "guardian_pid" || k === "guardian_identity" || k === "phase" || k === "updated_at") continue;
          assert.deepEqual(row[k], preGuard[k], `field ${k} changed unexpectedly on guardian success`);
        }
      }

      // (5) Full snapshot → stale-phase fail → refusal + full-row equality
      const postGuard = snap(dbPath);
      assertRej(runNode([COORDINATOR_CLI, "fail", ad.token, "ACQUIRED", ps, ad.ownerIdentity, "r", "d"], e),
        "Fail refused\n");
      assert.deepEqual(snap(dbPath), postGuard, "row changed on refused fail");

      // (6) Correct six-field fail — deep-equal result, no token, exact persisted phase/reason/details
      const rFok = runNode([COORDINATOR_CLI, "fail", ad.token, "GUARDIAN_RECORDED", ps, ad.ownerIdentity, "r1", "d1"], e);
      assert.equal(rFok.status, 0, rFok.stderr);
      const fr = JSON.parse(rFok.stdout);
      assert.deepEqual(fr, { changed: true, phase: "FAILED" });
      assert.ok(!rFok.stdout.includes(ad.token) && !rFok.stderr.includes(ad.token), "token leaked in fail output");
      {
        const row = snap(dbPath);
        assert.equal(row.phase, "FAILED");
        assert.equal(row.failure_reason, "r1");
        assert.equal(row.failure_details, "d1");
        for (const k of Object.keys(postGuard)) {
          if (k === "phase" || k === "failure_reason" || k === "failure_details" || k === "updated_at") continue;
          assert.deepEqual(row[k], postGuard[k], `field ${k} changed unexpectedly on fail`);
        }
      }

      // (7) Inspect: query explicit ordered 14-column public view, deep-equal to { gate: publicRow }, no token leaked
      const preInspRow = snap(dbPath);
      const publicRowData = publicRow(dbPath);
      // 14-column allowlist assertion — accidental internal column expansion must fail
      assert.deepEqual(Object.keys(publicRowData), [
        "artifacts", "created_at", "failure_details", "failure_reason",
        "guardian_identity", "guardian_pid", "id", "mode", "owner_identity",
        "owner_pid", "phase", "readiness", "topology", "updated_at",
      ]);
      const rInsp = runNode([COORDINATOR_CLI, "inspect"], e);
      assert.equal(rInsp.status, 0, rInsp.stderr);
      const inspParsed = JSON.parse(rInsp.stdout);
      assert.deepEqual(inspParsed, { gate: publicRowData });
      assert.ok(!rInsp.stdout.includes(ad.token) && !rInsp.stderr.includes(ad.token), "token leaked in inspect output");
      assert.deepEqual(snap(dbPath), preInspRow, "inspect mutated the row");
    } finally {
      try { fs.rmSync(temp.root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── Case 3: UTF-8 diagnostic and success-output caps ──────────────────

  it("UTF-8 diagnostic and success-output caps", () => {
    // 3a: invalid mode at truncation boundary — 4080 ASCII + 2-byte UTF-8 é
    {
      const temp = createTempHome("upgx-cc-u8-");
      const e = envFor(temp);
      const dbPath = path.join(temp.root, "test.db");
      try {
        const badMode = "x".repeat(4080) + "\u00E9"; // 4082 UTF-8 bytes
        const r = runNode([COORDINATOR_CLI, "acquire", badMode, "1", "{}", "{}", "{}"], e);
        assert.equal(r.status, 2);
        assert.equal(r.stdout, "");
        const n = Buffer.byteLength(r.stderr, "utf-8");
        assert.ok(n <= 4096, `stderr byte length ${n} > 4096`);
        assert.ok(r.stderr.endsWith("\n"), "missing final newline");
        assert.ok(!r.stderr.includes("\uFFFD"), "U+FFFD introduced by bad truncation");
        assert.ok(!fs.existsSync(dbPath));
      } finally {
        try { fs.rmSync(temp.root, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    // 3b: inspect output exceeds 65536-byte cap — snapshot AFTER enlargement, BEFORE inspect
    {
      const temp = createTempHome("upgx-cc-oc-");
      const e = envFor(temp);
      const dbPath = path.join(temp.root, "test.db");
      try {
        // acquire normally in a fresh DB
        const rAcq = runNode([COORDINATOR_CLI, "acquire", "current", String(process.pid), "{}", "{}", "{}"], e);
        assert.equal(rAcq.status, 0, rAcq.stderr);

        // enlarge one inspect-visible field with multibyte data so { gate: inspect() } + newline > 65536
        const bigVal = JSON.stringify("\u20AC".repeat(22000));
        {
          const d = new DatabaseSync(dbPath);
          try { d.prepare("UPDATE update_gate SET topology = ? WHERE id = 1").run(bigVal); }
          finally { d.close(); }
        }

        // take full SELECT * snapshot AFTER enlargement and BEFORE inspect
        const preInsp = snap(dbPath);
        assert.equal(preInsp.topology, bigVal, "topology not enlarged as expected");

        // assert inspect exits 2, empty stdout, exact stderr
        const rInsp = runNode([COORDINATOR_CLI, "inspect"], e);
        assert.equal(rInsp.status, 2);
        assert.equal(rInsp.stdout, "");
        assert.equal(rInsp.stderr, "Output exceeds maximum length\n");

        // deep-equal post-inspect row to the post-enlargement pre-inspect snapshot (all columns)
        const postInsp = snap(dbPath);
        assert.deepEqual(postInsp, preInsp, "inspect mutated the row on cap failure");
      } finally {
        try { fs.rmSync(temp.root, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });
});

// ── ACQUIRE: protocol artifact integrity ────────────────────────────────

describe("acquire protocol artifact integrity", () => {
  const CE = "Update protocol artifacts are corrupted — acquisition refused";
  const AE = "Update gate already exists — acquisition refused";

  function snap(dbPath) {
    const d = new DatabaseSync(dbPath);
    try {
      const schema = (d.prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name, tbl_name").all() as any)
        .map((r: any) => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql }));
      const sv = (d.prepare("PRAGMA schema_version").get() as any).schema_version;
      const uv = (d.prepare("PRAGMA user_version").get() as any).user_version;
      let runs: { id: string; status: string }[] = [];
      try {
        runs = (d.prepare("SELECT id, status FROM runs ORDER BY id").all() as any)
          .map((r: any) => ({ id: r.id, status: r.status }));
      } catch { /* */ }
      const hasTable = schema.some(
        (r: any) => r.type === "table" && r.name.toLowerCase() === "update_gate"
      );
      let gateRowCount: number | null = null;
      if (hasTable) {
        gateRowCount = (d.prepare("SELECT COUNT(*) AS cnt FROM update_gate").get() as any).cnt;
      }
      return { schema, sv, uv, runs, gateRowCount };
    } finally { d.close(); }
  }

  function aq(env: Record<string, string>) {
    return spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
try { const r = acquire("current", process.ppid, "{}", "{}", "{}"); console.log(JSON.stringify(r)); } catch(e) { console.log("ERROR:" + e.message); process.exit(1); }`],
      { encoding: "utf-8", env, timeout: 30000 });
  }

  function env(temp: ReturnType<typeof createTempHome>, dp: string) {
    return cleanChildEnv({ HOME: temp.homeDir, TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"), TAMANDUA_DB_PATH: dp });
  }

  function mutateDb(dp: string, sql: string[]) {
    const d = new DatabaseSync(dp);
    try { for (const s of sql) d.exec(s); } finally { d.close(); }
  }

  it("fresh acquisition produces exact canonical artifacts with blocking behavior", () => {
    const t = createTempHome("upgx-fresh-");
    try {
      const dp = path.join(t.root, "f.db");
      assert.equal(aq(env(t, dp)).status, 0);
      const s = snap(dp);
      const reservedNames = ["update_gate", "trg_update_gate_block_runs_insert", "trg_update_gate_block_runs_update"];
      const reserved = s.schema.filter((r: any) => reservedNames.includes(r.name));
      assert.equal(reserved.length, 3);
      assert.deepEqual(reserved.map((r: any) => r.name), ["update_gate", "trg_update_gate_block_runs_insert", "trg_update_gate_block_runs_update"]);
      assert.deepEqual(reserved.map((r: any) => r.type), ["table", "trigger", "trigger"]);
      assert.deepEqual(reserved.map((r: any) => r.tbl_name), ["update_gate", "runs", "runs"]);
      for (const a of reserved) assert.ok(typeof a.sql === "string" && a.sql!.length > 0, `${a.name} sql empty`);
      assert.equal(s.gateRowCount, 1, "gate singleton missing");
      const db = new DatabaseSync(dp);
      try {
        assert.throws(() => db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("t", "w", "x", "running", new Date().toISOString(), new Date().toISOString()), /update in progress/);
      } finally { db.close(); }
    } finally { try { fs.rmSync(t.root, { recursive: true, force: true }); } catch { /* */ } }
  });

  it("fail-closed matrix: seven states refuse without mutation", () => {
    const cases: Array<{ label: string; sql: string[]; err: string }> = [
      { label: "canonical-but-empty", sql: ["DELETE FROM update_gate WHERE id = 1"], err: AE },
      { label: "partial-set", sql: ["DELETE FROM update_gate WHERE id = 1", "DROP TRIGGER trg_update_gate_block_runs_insert"], err: CE },
      { label: "malformed-table", sql: ["DELETE FROM update_gate WHERE id = 1", "DROP TABLE update_gate", "CREATE TABLE update_gate (x INTEGER)"], err: CE },
      { label: "wrong-def-trigger", sql: ["DELETE FROM update_gate WHERE id = 1", "DROP TRIGGER trg_update_gate_block_runs_insert", "CREATE TRIGGER trg_update_gate_block_runs_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'wrong'); END"], err: CE },
      { label: "mixed-view", sql: ["DELETE FROM update_gate WHERE id = 1", "DROP TABLE update_gate", 'CREATE VIEW "Update_Gate" AS SELECT 1'], err: CE },
      { label: "mixed-index", sql: ["DELETE FROM update_gate WHERE id = 1", "DROP TABLE update_gate", 'CREATE INDEX "Update_Gate" ON runs(status)'], err: CE },
      { label: "wrong-type-mixed", sql: ["DELETE FROM update_gate WHERE id = 1", "DROP TRIGGER trg_update_gate_block_runs_insert", 'CREATE TABLE "Trg_Update_Gate_Block_Runs_Insert" (x INTEGER)'], err: CE },
    ];
    for (const c of cases) {
      const t = createTempHome(`upgx-mx-${c.label}-`);
      try {
        const dp = path.join(t.root, "mx.db");
        const e = env(t, dp);
        assert.equal(aq(e).status, 0, `[${c.label}] first acquire failed`);
        mutateDb(dp, c.sql);
        const before = snap(dp);
        const r = aq(e);
        assert.notEqual(r.status, 0, `[${c.label}] expected refusal`);
        assert.equal(r.stdout, `ERROR:${c.err}\n`, `[${c.label}] stdout mismatch`);
        assert.equal(r.stderr, '', `[${c.label}] stderr not empty`);
        assert.deepEqual(snap(dp), before, `[${c.label}] state mutated`);
      } finally { try { fs.rmSync(t.root, { recursive: true, force: true }); } catch { /* */ } }
    }
  });
});
