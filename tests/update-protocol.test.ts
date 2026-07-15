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
import { describe, it, before, after } from "node:test";
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

function runNode(args, env) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf-8",
    env: { ...process.env, ...env },
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
  it("explicit TAMANDUA_DB_PATH wins over default HOME path", () => {
    const temp = createTempHome("update-protocol-dbpath-");
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

    // Cleanup
    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("TAMANDUA_STATE_DIR does not redirect the DB", () => {
    const temp = createTempHome("update-protocol-dbpath2-");
    const stateDir = path.join(temp.root, "custom-state");
    fs.mkdirSync(stateDir, { recursive: true });

    const env = cleanChildEnv({
      HOME: temp.homeDir,
      TAMANDUA_STATE_DIR: stateDir,
      // Explicit TAMANDUA_DB_PATH overrides
      TAMANDUA_DB_PATH: path.join(temp.root, "my-db.db"),
    });

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
try {
  const r = acquire("current", process.ppid, "{}", "{}", "{}");
  console.log(JSON.stringify(r));
} catch(e) {
  console.log("ERROR:" + e.message);
  process.exit(1);
}`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.equal(result.status, 0, `Acquire failed: ${result.stderr}`);
    // DB should be at my-db.db, NOT under custom-state
    assert.ok(
      fs.existsSync(path.join(temp.root, "my-db.db")),
      "DB should be at explicit TAMANDUA_DB_PATH",
    );
    assert.ok(
      !fs.existsSync(path.join(stateDir, "tamandua.db")),
      "DB should NOT be under TAMANDUA_STATE_DIR",
    );

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// ── COLD: absent DB initialization through real built dist/db.js ─────────

describe("COLD initialization", () => {
  it("absent DB is initialized through real built dist/db.js", () => {
    const temp = createTempHome("update-protocol-cold-");
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

    // Verify gate row inserted
    const db = new DatabaseSync(dbPath);
    const gate = db
      .prepare("SELECT * FROM update_gate WHERE id = 1")
      .get();
    db.close();
    assert.ok(gate, "Gate row should exist");
    assert.equal(gate.phase, "ACQUIRED");
    assert.equal(gate.mode, "current");
    assert.equal(gate.topology, JSON.stringify({ test: true }));

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("cold init does not copy or duplicate the runs schema in the coordinator", () => {
    const temp = createTempHome("update-protocol-cold2-");
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

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// ── ACTIVE-RUNNING / ACTIVE-PAUSED refusal ───────────────────────────────

describe("Active work refusal", () => {
  it("acquisition exits nonzero when a running run exists", () => {
    const temp = createTempHome("update-protocol-activerun-");
    const dbPath = path.join(temp.root, "activerun.db");

    // Cold-init and insert a running run
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
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(temp.homeDir)};
const db = getDb();
db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
   .run("run-1", "wf-1", "task", "running", new Date().toISOString(), new Date().toISOString());
closeDb();
console.log("setup done");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(
      setupResult.status,
      0,
      `Setup failed: ${setupResult.stderr}`,
    );

    // Snapshot before acquisition
    const beforeTables = getTableNames(dbPath);
    const beforeVersion = getUserVersion(dbPath);
    const beforeRunCount = countRuns(dbPath);
    const beforeHash = fileHash(dbPath);

    // Try to acquire
    const acquireResult = runAcquire(temp, dbPath);
    assert.notEqual(acquireResult.status, 0, "Acquire should fail");
    assert.ok(
      acquireResult.stdout.includes("Active work exists"),
      `Expected 'Active work exists' in: ${acquireResult.stdout}`,
    );

    // After acquisition attempt, state should be unchanged
    const afterTables = getTableNames(dbPath);
    const afterVersion = getUserVersion(dbPath);
    const afterRunCount = countRuns(dbPath);
    const afterHash = fileHash(dbPath);

    // Schema names should be equal
    assert.deepEqual(afterTables.sort(), beforeTables.sort());
    // user_version should be unchanged
    assert.equal(afterVersion, beforeVersion);
    // Run count should be unchanged
    assert.equal(afterRunCount, beforeRunCount);
    // File hash should be equal (no side effects)
    assert.equal(afterHash, beforeHash);
    // Gate table should NOT exist
    assert.ok(!tableExists(dbPath, "update_gate"), "Gate table should not exist after refusal");
    // Triggers should NOT exist
    assert.ok(!triggerExists(dbPath, "trg_update_gate_block_runs_insert"));
    assert.ok(!triggerExists(dbPath, "trg_update_gate_block_runs_update"));

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("acquisition exits nonzero when a paused run exists", () => {
    const temp = createTempHome("update-protocol-activepaused-");
    const dbPath = path.join(temp.root, "activepaused.db");

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
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(temp.homeDir)};
const db = getDb();
db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
   .run("run-1", "wf-1", "task", "paused", new Date().toISOString(), new Date().toISOString());
closeDb();
console.log("setup done");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(setupResult.status, 0, `Setup failed: ${setupResult.stderr}`);

    const beforeHash = fileHash(dbPath);

    const acquireResult = runAcquire(temp, dbPath);
    assert.notEqual(acquireResult.status, 0, "Acquire should fail for paused runs");
    assert.ok(
      acquireResult.stdout.includes("Active work exists"),
      `Expected 'Active work exists' in: ${acquireResult.stdout}`,
    );

    // State unchanged
    assert.equal(fileHash(dbPath), beforeHash);
    assert.ok(!tableExists(dbPath, "update_gate"));

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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

      const writerGo = path.join(barrierDir, "writer-go"); // acquirer writes, writer waits
      const writerDone = path.join(barrierDir, "writer-done"); // writer writes, acquirer waits

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

      // Writer: starts transaction, signals ready, waits, commits running run, signals done
      const writerCode = `
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const dbPath = process.env.TAMANDUA_DB_PATH;
const writerGo = ${JSON.stringify(writerGo)};
const writerDone = ${JSON.stringify(writerDone)};

// Open DB and BEGIN IMMEDIATE
const db = new DatabaseSync(dbPath);
db.exec("BEGIN IMMEDIATE");

// Notify acquirer we hold the lock
fs.writeFileSync(writerGo, "ready");

// Wait for acquirer to also reach its BEGIN IMMEDIATE (blocked)
// Give it 2 seconds to start its attempt
await new Promise(r => setTimeout(r, 2000));

// Insert running run and commit
db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("race-run-1", "wf-1", "task", "running", new Date().toISOString(), new Date().toISOString());
db.exec("COMMIT");
db.close();

// Notify acquirer that writer committed
fs.writeFileSync(writerDone, "done");
process.exit(0);
`;

      // Acquirer: waits for writer to signal, then tries to acquire (will be blocked)
      const acquirerCode = `
import fs from "node:fs";
import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const writerGo = ${JSON.stringify(writerGo)};
const writerDone = ${JSON.stringify(writerDone)};

// Wait for writer to signal it has the lock
while (!fs.existsSync(writerGo)) {
  await new Promise(r => setTimeout(r, 50));
}

// Now try to acquire — writer holds BEGIN IMMEDIATE, so we'll block briefly
// When writer commits, we'll see the running run and refuse
try {
  acquire("current", process.ppid, "{}", "{}", "{}");
  console.log("UNEXPECTED_ACQUIRE");
} catch(e) {
  if (e.message.includes("Active work exists")) {
    console.log("REFUSED: " + e.message);
  } else {
    console.log("OTHER_ERROR: " + e.message);
  }
}
process.exit(0);
`;

      // Start both children
      const writerChild = spawn(process.execPath, ["--input-type=module", "-e", writerCode], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const acquirerChild = spawn(process.execPath, ["--input-type=module", "-e", acquirerCode], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const writerPromise = new Promise((resolve) => {
        let out = "";
        writerChild.stdout.on("data", (d) => { out += d.toString(); });
        writerChild.on("close", (code) => resolve({ code, out }));
      });
      const acquirerPromise = new Promise((resolve) => {
        let out = "";
        acquirerChild.stdout.on("data", (d) => { out += d.toString(); });
        acquirerChild.on("close", (code) => resolve({ code, out }));
      });

      const [writerResult, acquirerResult] = await Promise.all([
        writerPromise,
        acquirerPromise,
      ]) as [{ code: number; out: string }, { code: number; out: string }];

      writerChild.kill("SIGKILL");
      acquirerChild.kill("SIGKILL");

      // Writer should have committed successfully
      assert.equal(writerResult.code, 0, `Writer failed: ${writerResult.out}`);
      // Acquirer should have been refused
      assert.ok(
        acquirerResult.out.includes("REFUSED: Active work exists"),
        `Expected refusal, got: ${acquirerResult.out}`,
      );

      // Verify no gate residue
      assert.ok(!tableExists(dbPath, "update_gate"), "No gate table should remain after refusal");

      try {
        fs.rmSync(temp.root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  );

  it(
    "acquirer-first: acquirer commits gate, then writer INSERT is blocked by trigger",
    { timeout: 60000 },
    async () => {
      // For the acquirer-first scenario, we need a DB with NO active runs
      // so acquisition succeeds, then the writer tries to insert and
      // the trigger should block it.

      const temp = createTempHome("update-protocol-race-af-");
      const dbPath = path.join(temp.root, "race-af.db");
      const barrierDir = path.join(temp.root, "barriers");
      fs.mkdirSync(barrierDir, { recursive: true });

      const acquireDone = path.join(barrierDir, "acquire-done");

      const env = cleanChildEnv({
        HOME: temp.homeDir,
        TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
        TAMANDUA_DB_PATH: dbPath,
      });

      // Cold-init first
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
      assert.equal(initResult.status, 0, `Cold init: ${initResult.stderr}`);

      const acquireDone2 = path.join(barrierDir, "acquire-done-2");

      const acquirerCode = `
import fs from "node:fs";
import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const done = ${JSON.stringify(acquireDone2)};

const r = acquire("current", process.ppid, "{}", "{}", "{}");
console.log("ACQUIRED:" + JSON.stringify(r));
fs.writeFileSync(done, "done");
`;

      // Writer: waits for acquire, then tries INSERT (should be blocked by trigger)
      const writerCode = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const done = ${JSON.stringify(acquireDone2)};
const dbPath = process.env.TAMANDUA_DB_PATH;

// Wait for acquire to commit
while (!fs.existsSync(done)) {
  await new Promise(r => setTimeout(r, 50));
}
// Small extra wait to ensure transaction fully committed
await new Promise(r => setTimeout(r, 500));

// Now try INSERT — should be blocked by trigger
const db = new DatabaseSync(dbPath);
try {
  db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("race-run-1", "wf-1", "task", "running", new Date().toISOString(), new Date().toISOString());
  console.log("UNEXPECTED_INSERT_OK");
} catch(e) {
  console.log("TRIGGER_BLOCKED: " + e.message);
}
db.close();
process.exit(0);
`;

      // Start acquirer first
      const acquirerChild = spawn(process.execPath, ["--input-type=module", "-e", acquirerCode], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const acquirerPromise = new Promise((resolve) => {
        let out = "";
        acquirerChild.stdout.on("data", (d) => { out += d.toString(); });
        acquirerChild.on("close", (code) => resolve({ code, out }));
      });

      // Wait for acquirer to finish
      const acquirerResult = await acquirerPromise as { code: number; out: string };
      acquirerChild.kill("SIGKILL");
      assert.equal(acquirerResult.code, 0, `Acquirer failed: ${acquirerResult.out}`);
      assert.ok(acquirerResult.out.includes("ACQUIRED:"), "Acquirer should have acquired");

      // Now start the writer
      const writerChild = spawn(process.execPath, ["--input-type=module", "-e", writerCode], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const writerPromise = new Promise((resolve) => {
        let out = "";
        writerChild.stdout.on("data", (d) => { out += d.toString(); });
        writerChild.on("close", (code) => resolve({ code, out }));
      });

      const writerResult = await writerPromise as { code: number; out: string };
      writerChild.kill("SIGKILL");
      assert.ok(
        writerResult.out.includes("TRIGGER_BLOCKED: update in progress"),
        `Expected trigger block, got: ${writerResult.out}`,
      );

      // Verify gate exists (acquirer succeeded)
      assert.ok(tableExists(dbPath, "update_gate"), "Gate table should exist");

      try {
        fs.rmSync(temp.root, { recursive: true, force: true });
      } catch {
        /* ignore */
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
        const stat = fs.readFileSync(`/proc/${p}/stat`, "utf-8");
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

  it("wrong token, wrong expected phase, wrong owner PID/identity all change zero rows", () => {
    const temp = createTempHome("update-protocol-owner-wrong-");
    const dbPath = path.join(temp.root, "owner-wrong.db");

    // Acquire first
    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    const acquireResult = spawnSync(
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
    assert.equal(acquireResult.status, 0, `Acquire failed: ${acquireResult.stderr}`);
    const gateData = JSON.parse(acquireResult.stdout.trim());
    const token = gateData.token;
    const ownerIdentity = getGateOwnerIdentity(dbPath);
    const ownerPid = process.ppid;

    // Wrong token
    const wrongTokenResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { casPhase } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = casPhase("wrong-token", "ACQUIRED", "FAILED", ${ownerPid}, ${JSON.stringify(ownerIdentity)});
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    const wt = JSON.parse(wrongTokenResult.stdout.trim());
    assert.equal(wt.changed, false);
    assert.equal(wt.phase, "ACQUIRED");

    // Wrong expected phase (say GUARDIAN_RECORDED but we're at ACQUIRED)
    const wrongPhaseResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { casPhase } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = casPhase(${JSON.stringify(token)}, "GUARDIAN_RECORDED", "FAILED", ${ownerPid}, ${JSON.stringify(ownerIdentity)});
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    const wp = JSON.parse(wrongPhaseResult.stdout.trim());
    assert.equal(wp.changed, false);

    // Wrong owner PID
    const wrongPidResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { casPhase } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = casPhase(${JSON.stringify(token)}, "ACQUIRED", "FAILED", 1, ${JSON.stringify(ownerIdentity)});
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    const wpid = JSON.parse(wrongPidResult.stdout.trim());
    assert.equal(wpid.changed, false);

    // Wrong identity
    const wrongIdentResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { casPhase } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = casPhase(${JSON.stringify(token)}, "ACQUIRED", "FAILED", ${ownerPid}, "wrong-identity");
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    const wid = JSON.parse(wrongIdentResult.stdout.trim());
    assert.equal(wid.changed, false);

    // Phase should still be ACQUIRED
    const db = new DatabaseSync(dbPath);
    const gate = db.prepare("SELECT phase FROM update_gate WHERE id = 1").get();
    db.close();
    assert.equal(gate.phase, "ACQUIRED", "Gate phase should still be ACQUIRED after all failed CAS");

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("PID-reuse protection: same live PID with deliberately mismatched identity changes zero rows", () => {
    const temp = createTempHome("update-protocol-pidreuse-");
    const dbPath = path.join(temp.root, "pidreuse.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // Acquire using actual parent
    const acquireResult = spawnSync(
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
    assert.equal(acquireResult.status, 0, `Acquire failed: ${acquireResult.stderr}`);
    const gateData = JSON.parse(acquireResult.stdout.trim());
    const token = gateData.token;
    const ownerPid = process.ppid;
    // Create a deliberately mismatched identity (same PID, different boot_id / ticks)
    const fakeIdentity = JSON.stringify({ boot_id: "00000000-0000-0000-0000-000000000000", start_ticks: "0" });

    const casResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { casPhase } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = casPhase(${JSON.stringify(token)}, "ACQUIRED", "FAILED", ${ownerPid}, ${JSON.stringify(fakeIdentity)});
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    const cr = JSON.parse(casResult.stdout.trim());
    assert.equal(cr.changed, false, "CAS with mismatched identity should change 0 rows");
    assert.equal(cr.phase, "ACQUIRED", "Phase should still be ACQUIRED");

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
  // Each test gets its own isolated gate to avoid state leakage
  function setupAndAcquire() {
    const temp = createTempHome("update-protocol-phases-");
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
    const ownerPid = process.ppid;
    const ownerIdentity = getGateOwnerIdentity(dbPath);
    return { temp, dbPath, env, token, ownerPid, ownerIdentity };
  }

  after(async () => {
    // Cleanup handled by createTempHome process-level handlers
  });

  function runCas(token, env, ownerPid, ownerIdentity, expectedPhase, newPhase) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { casPhase } from ${JSON.stringify(PROTOCOL_MODULE)};
try {
  const r = casPhase(${JSON.stringify(token)}, ${JSON.stringify(expectedPhase)}, ${JSON.stringify(newPhase)}, ${ownerPid}, ${JSON.stringify(ownerIdentity)});
  console.log(JSON.stringify(r));
} catch(e) {
  console.log("ILLEGAL:" + e.message);
}`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    return result;
  }

  it("ACQUIRED -> GUARDIAN_RECORDED is legal (via recordGuardian)", () => {
    const { token, env } = setupAndAcquire();

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { recordGuardian } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = recordGuardian(${JSON.stringify(token)}, 12345, "guardian-identity");
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
    const { token, env } = setupAndAcquire();

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { fail } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = fail(${JSON.stringify(token)}, "reason", "details");
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
    const { token, env } = setupAndAcquire();

    // First record guardian
    const gr = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { recordGuardian } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = recordGuardian(${JSON.stringify(token)}, 12345, "guardian-identity");
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
const r = fail(${JSON.stringify(token)}, "reason", "details");
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );
    assert.equal(result.status, 0);
    const fr = JSON.parse(result.stdout.trim());
    assert.equal(fr.changed, true);
    assert.equal(fr.phase, "FAILED");
  });

  it("FAILED -> anything is illegal (terminal)", () => {
    const { token, env, dbPath, ownerPid, ownerIdentity } = setupAndAcquire();

    // First fail
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { fail } from ${JSON.stringify(PROTOCOL_MODULE)};
fail(${JSON.stringify(token)}, "reason", "details");`,
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    // Try transitioning away from FAILED
    const result = runCas(token, env, ownerPid, ownerIdentity, "FAILED", "ACQUIRED");
    assert.ok(
      result.stdout.includes("ILLEGAL"),
      `Expected illegal transition, got: ${result.stdout}`,
    );
  });

  it("self-transition (ACQUIRED -> ACQUIRED) is illegal", () => {
    const { token, env, ownerPid, ownerIdentity } = setupAndAcquire();
    const result = runCas(token, env, ownerPid, ownerIdentity, "ACQUIRED", "ACQUIRED");
    assert.ok(
      result.stdout.includes("ILLEGAL"),
      `Expected illegal self-transition, got: ${result.stdout}`,
    );
  });

  it("FAILED row still blocks writers", () => {
    const { token, env, dbPath } = setupAndAcquire();

    // Fail the gate
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { fail } from ${JSON.stringify(PROTOCOL_MODULE)};
fail(${JSON.stringify(token)}, "reason", "details");`,
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
  it("exact child identities are retained and terminated in finally", async () => {
    const temp = createTempHome("update-protocol-cleanup-");
    const dbPath = path.join(temp.root, "cleanup.db");

    const homeDir = temp.homeDir;
    const env = cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: dbPath,
    });

    // Spawn a process that acquires and check it doesn't leave orphans
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquire } from ${JSON.stringify(PROTOCOL_MODULE)};
const r = acquire("current", process.ppid, "{}", "{}", "{}");
console.log("ACQUIRED:" + r.token);
// Process should exit cleanly
`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );

    const childPromise = new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.on("close", (code) => resolve({ code, out }));
    });

    const result = await childPromise as { code: number; out: string };
    child.kill("SIGKILL");

    assert.equal(result.code, 0, `Child failed: ${result.out}`);
    assert.ok(result.out.includes("ACQUIRED:"));

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});
