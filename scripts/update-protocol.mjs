#!/usr/bin/env node
/**
 * scripts/update-protocol.mjs — Dormant cross-version update protocol foundation.
 *
 * Single ESM module containing all mutating DDL, gate, phase, and failure
 * operations. Node built-ins only (no npm dependencies).
 *
 * Exported functions:
 *   acquire(mode, updaterPid, topology, artifacts, readiness)
 *   inspect()
 *   casPhase(token, expectedPhase, newPhase, expectedOwnerPid, expectedOwnerIdentity)
 *   recordGuardian(token, guardianPid, guardianIdentity)
 *   fail(token, reason, details)
 *   isGateActive()
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

// ── Constants ────────────────────────────────────────────────────────────────

const GATE_TABLE = "update_gate";
const SINGLETON_ID = 1;
const BOUND = 4096; // Max length for externally-supplied strings

const VALID_PHASES = Object.freeze(["ACQUIRED", "GUARDIAN_RECORDED", "FAILED"]);
const VALID_MODES = Object.freeze(["legacy", "current"]);

// Legal transition edges for PROT scope
const LEGAL_TRANSITIONS = Object.freeze({
  ACQUIRED: new Set(["GUARDIAN_RECORDED", "FAILED"]),
  "GUARDIAN_RECORDED": new Set(["FAILED"]),
  FAILED: new Set(), // terminal
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function bust(limit, label, value) {
  return typeof value === "string" && value.length <= limit
    ? value
    : `${value}`.slice(0, limit);
}

function validatePhase(name) {
  if (!VALID_PHASES.includes(name)) {
    throw new Error(`Invalid phase: ${name}`);
  }
}

function validateMode(name) {
  if (!VALID_MODES.includes(name)) {
    throw new Error(`Invalid mode: ${name}`);
  }
}

function validateLegalTransition(expected, desired) {
  validatePhase(expected);
  validatePhase(desired);
  const allowed = LEGAL_TRANSITIONS[expected];
  if (!allowed || !allowed.has(desired)) {
    throw new Error(`Illegal transition: ${expected} -> ${desired}`);
  }
}

function validateJSON(label, raw) {
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a string`);
  }
  try {
    JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

// ── DB path resolution ───────────────────────────────────────────────────────

function resolveDbPath() {
  const explicit = process.env.TAMANDUA_DB_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".tamandua", "tamandua.db");
}

// ── Cold DB initialization through real built dist/db.js ─────────────────────

function coldInitDb(dbPath) {
  // Resolve dist/db.js relative to the repository root
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
  );
  const distDbAbsPath = path.join(repoRoot, "dist", "db.js");

  // Use child_process to run a small ESM script that imports dist/db.js
  // synchronously. This handles the ESM import that cannot be require()'d.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { getDb, closeDb } from ${JSON.stringify(distDbAbsPath)};
process.env.TAMANDUA_DB_PATH = ${JSON.stringify(dbPath)};
process.env.HOME = ${JSON.stringify(os.homedir())};
const db = getDb();
closeDb();`,
    ],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, TAMANDUA_DB_PATH: dbPath },
    },
  );

  if (result.status !== 0) {
    const errDetail = result.stderr?.trim() || result.error?.message || "unknown";
    throw new Error(`Cold init failed (exit ${result.status}): ${errDetail}`);
  }

  // Verify the runs table exists
  let verifyDb;
  try {
    verifyDb = new DatabaseSync(dbPath);
    const hasRuns = verifyDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
      )
      .get();
    if (!hasRuns) {
      throw new Error(
        "Cold init: runs table not found after dist/db.js getDb()",
      );
    }
  } finally {
    if (verifyDb) verifyDb.close();
  }
}

function hasRunsTable(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
      )
      .get();
    return row !== undefined;
  } finally {
    db.close();
  }
}

// ── Identity capture ─────────────────────────────────────────────────────────

function captureProcessIdentity(pid) {
  if (process.platform === "linux") {
    return captureLinuxIdentity(pid);
  }
  if (process.platform === "darwin") {
    return captureMacIdentity(pid);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function captureLinuxIdentity(pid) {
  let bootId;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  } catch {
    throw new Error("Cannot read boot_id");
  }

  let startTicks;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Field 22 (1-indexed): starttime. Find the closing ')' of field 2
    // (comm), then split the remainder by space.
    const commEnd = stat.lastIndexOf(")");
    if (commEnd === -1) {
      throw new Error(`Cannot parse /proc/${pid}/stat: no comm field`);
    }
    const afterComm = stat.slice(commEnd + 2); // skip ') ' after comm
    const fields = afterComm.split(" ");
    // fields[0] = state (field 3), ... fields[19] = starttime (field 22)
    // Index: field 3 is fields[0], field 22 is fields[19]
    if (fields.length < 20) {
      throw new Error(`Cannot parse /proc/${pid}/stat: too few fields`);
    }
    startTicks = fields[19];
  } catch (e) {
    throw new Error(`Cannot read /proc/${pid}/stat: ${e.message}`);
  }

  return JSON.stringify({ boot_id: bootId, start_ticks: startTicks });
}

function captureMacIdentity(pid) {
  // Use argument-vector process API — never interpolated shell commands
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error) {
    throw new Error(`ps failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ps exited ${result.status}: ${result.stderr}`);
  }
  const lstart = result.stdout.trim();
  if (!lstart) {
    throw new Error(`ps produced empty output for PID ${pid}`);
  }
  return JSON.stringify({ lstart });
}

// ── Ancestry validation ──────────────────────────────────────────────────────

function validateAncestry(coordinatorPid, claimedUpdaterPid) {
  if (claimedUpdaterPid === coordinatorPid) {
    throw new Error("Coordinator itself cannot be the owner");
  }

  // Walk parent chain using /proc/<pid>/stat field 4 (ppid) on Linux,
  // or ps on macOS
  let currentPid = coordinatorPid;
  const visited = new Set();

  while (currentPid > 1 && !visited.has(currentPid)) {
    visited.add(currentPid);

    const ppid = getParentPid(currentPid);
    if (ppid === null) break;
    if (ppid === claimedUpdaterPid) return; // Found in ancestry
    currentPid = ppid;
  }

  throw new Error(
    `PID ${claimedUpdaterPid} is not an ancestor of coordinator (PID ${coordinatorPid})`,
  );
}

function getParentPid(pid) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const commEnd = stat.lastIndexOf(")");
      if (commEnd === -1) return null;
      const afterComm = stat.slice(commEnd + 2);
      const fields = afterComm.split(" ");
      // field 4 (ppid) = fields[1] (0-indexed after comm: state, ppid, ...)
      if (fields.length < 2) return null;
      return parseInt(fields[1], 10) || null;
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.error || result.status !== 0) return null;
    return parseInt(result.stdout.trim(), 10) || null;
  }

  return null;
}

// ── Gate table DDL ───────────────────────────────────────────────────────────

function createGateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${GATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = ${SINGLETON_ID}),
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
    );
  `);
}

function createBlockingTriggers(db) {
  // Trigger: block INSERT into runs when update gate exists
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_update_gate_block_runs_insert
    BEFORE INSERT ON runs
    WHEN EXISTS (SELECT 1 FROM ${GATE_TABLE} WHERE id = ${SINGLETON_ID})
    BEGIN
      SELECT RAISE(ABORT, 'update in progress');
    END;
  `);

  // Trigger: block status transition INTO 'running' when update gate exists
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_update_gate_block_runs_update
    BEFORE UPDATE OF status ON runs
    WHEN EXISTS (SELECT 1 FROM ${GATE_TABLE} WHERE id = ${SINGLETON_ID})
      AND NEW.status = 'running' AND OLD.status != 'running'
    BEGIN
      SELECT RAISE(ABORT, 'update in progress');
    END;
  `);
}

function dropGateAndTriggers(db) {
  db.exec(`DROP TRIGGER IF EXISTS trg_update_gate_block_runs_insert`);
  db.exec(`DROP TRIGGER IF EXISTS trg_update_gate_block_runs_update`);
  db.exec(`DROP TABLE IF EXISTS ${GATE_TABLE}`);
}

// ── Active work detection ────────────────────────────────────────────────────

function hasRunningOrPausedWork(db) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM runs WHERE status IN ('running', 'paused')",
    )
    .get();
  return (row?.cnt ?? 0) > 0;
}

// ── Singleton helpers ────────────────────────────────────────────────────────

function getGateRow(db) {
  // Check if the table exists first — it may not exist on a fresh DB
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(GATE_TABLE);
  if (!tableExists) return undefined;
  return db
    .prepare(`SELECT * FROM ${GATE_TABLE} WHERE id = ?`)
    .get(SINGLETON_ID);
}

function gateExists(db) {
  return getGateRow(db) !== undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire the update gate. Returns { token, phase: 'ACQUIRED', mode } on success.
 * Throws on any refusal; the caller must handle the error.
 *
 * @param {string} mode - 'legacy' or 'current'
 * @param {number} updaterPid - PID of the updater process (must be ancestor of coordinator)
 * @param {string} topology - topology JSON string
 * @param {string} artifacts - artifacts JSON string
 * @param {string} readiness - readiness JSON string
 * @returns {{ token: string, phase: string, mode: string }}
 */
export function acquire(mode, updaterPid, topology, artifacts, readiness) {
  validateMode(mode);

  // Validate / bound inputs
  const boundedTopology = bust(BOUND, "topology", topology);
  const boundedArtifacts = bust(BOUND, "artifacts", artifacts);
  const boundedReadiness = bust(BOUND, "readiness", readiness);

  validateJSON("topology", boundedTopology);
  validateJSON("artifacts", boundedArtifacts);
  validateJSON("readiness", boundedReadiness);

  // Validate updater PID
  if (!Number.isSafeInteger(updaterPid) || updaterPid < 1) {
    throw new Error(`Invalid updater PID: ${updaterPid}`);
  }

  // Validate ancestry
  const coordinatorPid = process.pid;
  validateAncestry(coordinatorPid, updaterPid);

  // Capture immutable identity of the updater
  const ownerIdentity = captureProcessIdentity(updaterPid);

  // Resolve DB path
  const dbPath = resolveDbPath();

  // Check if this is a truly absent/uninitialized DB
  const dbMissing = !fs.existsSync(dbPath);
  const needsColdInit = dbMissing || !hasRunsTable(dbPath);

  if (needsColdInit) {
    coldInitDb(dbPath);
  }

  // Open for preflight check (no persistent PRAGMA changes)
  const db = new DatabaseSync(dbPath);
  // Set busy_timeout so we don't fail on WAL lock contention during
  // concurrent writer scenarios. This is not a persistent PRAGMA.
  db.exec("PRAGMA busy_timeout = 10000");

  try {
    // Check for existing gate: fail-closed if ANY row exists
    if (gateExists(db)) {
      throw new Error("Update gate already exists — acquisition refused");
    }

    // Open transaction
    db.exec("BEGIN IMMEDIATE");

    try {
      // Check for active work
      if (hasRunningOrPausedWork(db)) {
        throw new Error("Active work exists — acquisition refused");
      }

      // Create gate table and triggers
      createGateTable(db);
      createBlockingTriggers(db);

      // Insert singleton row
      const token = crypto.randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO ${GATE_TABLE}
         (id, token, mode, phase, owner_pid, owner_identity, topology, artifacts, readiness, created_at, updated_at)
         VALUES (?, ?, ?, 'ACQUIRED', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        SINGLETON_ID,
        token,
        mode,
        updaterPid,
        ownerIdentity,
        boundedTopology,
        boundedArtifacts,
        boundedReadiness,
        now,
        now,
      );

      db.exec("COMMIT");

      return { token, phase: "ACQUIRED", mode };
    } catch (e) {
      // Rollback on any failure — gate, triggers, and run data remain unchanged
      db.exec("ROLLBACK");
      // The gate table/triggers may have been created in this transaction
      // before the error — they get rolled back too since they're in the
      // same transaction.
      throw e;
    }
  } finally {
    db.close();
  }
}

/**
 * Inspect the current gate state. Returns null if no gate exists.
 * @returns {object|null}
 */
export function inspect() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) return null;
  if (!hasRunsTable(dbPath)) return null;

  const db = new DatabaseSync(dbPath);
  try {
    const row = getGateRow(db);
    return row ?? null;
  } finally {
    db.close();
  }
}

/**
 * Strict CAS phase transition. All predicates must match or zero rows change.
 *
 * @param {string} token - capability token from acquisition
 * @param {string} expectedPhase - caller must explicitly supply this
 * @param {string} newPhase - target phase
 * @param {number} expectedOwnerPid - expected owner PID
 * @param {string} expectedOwnerIdentity - expected serialized identity
 * @returns {{ changed: boolean, phase: string }}
 */
export function casPhase(
  token,
  expectedPhase,
  newPhase,
  expectedOwnerPid,
  expectedOwnerIdentity,
) {
  validatePhase(expectedPhase);
  validatePhase(newPhase);
  validateLegalTransition(expectedPhase, newPhase);

  if (!Number.isSafeInteger(expectedOwnerPid) || expectedOwnerPid < 1) {
    throw new Error(`Invalid expected owner PID: ${expectedOwnerPid}`);
  }

  const dbPath = resolveDbPath();
  const db = new DatabaseSync(dbPath);

  try {
    db.exec("BEGIN IMMEDIATE");

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE ${GATE_TABLE}
         SET phase = ?, updated_at = ?
         WHERE id = ?
           AND token = ?
           AND phase = ?
           AND owner_pid = ?
           AND owner_identity = ?`,
      )
      .run(
        newPhase,
        now,
        SINGLETON_ID,
        token,
        expectedPhase,
        expectedOwnerPid,
        expectedOwnerIdentity,
      );

    if (result.changes === 0) {
      db.exec("ROLLBACK");
      // Return unchanged — the row did not match all predicates
      const current = getGateRow(db);
      db.close();
      return {
        changed: false,
        phase: current?.phase ?? null,
      };
    }

    db.exec("COMMIT");
    return { changed: true, phase: newPhase };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Record guardian identity. Only ACQUIRED -> GUARDIAN_RECORDED.
 *
 * @param {string} token
 * @param {number} guardianPid
 * @param {string} guardianIdentity - captured live guardian identity
 * @returns {{ changed: boolean, phase: string }}
 */
export function recordGuardian(token, guardianPid, guardianIdentity) {
  if (!Number.isSafeInteger(guardianPid) || guardianPid < 1) {
    throw new Error(`Invalid guardian PID: ${guardianPid}`);
  }

  const dbPath = resolveDbPath();
  const db = new DatabaseSync(dbPath);

  try {
    db.exec("BEGIN IMMEDIATE");

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE ${GATE_TABLE}
         SET phase = 'GUARDIAN_RECORDED',
             guardian_pid = ?,
             guardian_identity = ?,
             updated_at = ?
         WHERE id = ?
           AND token = ?
           AND phase = 'ACQUIRED'`,
      )
      .run(guardianPid, bust(BOUND, "guardian_identity", guardianIdentity), now, SINGLETON_ID, token);

    if (result.changes === 0) {
      db.exec("ROLLBACK");
      const current = getGateRow(db);
      db.close();
      return {
        changed: false,
        phase: current?.phase ?? null,
      };
    }

    db.exec("COMMIT");
    return { changed: true, phase: "GUARDIAN_RECORDED" };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Token-scoped failure. Legal from ACQUIRED or GUARDIAN_RECORDED.
 *
 * @param {string} token
 * @param {string} reason - bounded failure reason
 * @param {string} details - bounded failure details
 * @returns {{ changed: boolean, phase: string }}
 */
export function fail(token, reason, details) {
  const dbPath = resolveDbPath();
  const db = new DatabaseSync(dbPath);

  try {
    db.exec("BEGIN IMMEDIATE");

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE ${GATE_TABLE}
         SET phase = 'FAILED',
             failure_reason = ?,
             failure_details = ?,
             updated_at = ?
         WHERE id = ?
           AND token = ?
           AND phase IN ('ACQUIRED', 'GUARDIAN_RECORDED')`,
      )
      .run(
        bust(BOUND, "failure_reason", reason),
        bust(BOUND, "failure_details", details),
        now,
        SINGLETON_ID,
        token,
      );

    if (result.changes === 0) {
      db.exec("ROLLBACK");
      const current = getGateRow(db);
      db.close();
      return {
        changed: false,
        phase: current?.phase ?? null,
      };
    }

    db.exec("COMMIT");
    return { changed: true, phase: "FAILED" };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Reports active when the singleton row exists, including FAILED state.
 * @returns {boolean}
 */
export function isGateActive() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) return false;

  const db = new DatabaseSync(dbPath);
  try {
    return gateExists(db);
  } finally {
    db.close();
  }
}
