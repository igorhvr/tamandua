import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { acquire, fail, captureProcessIdentity } from "../scripts/update-protocol.mjs";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const KEYS = ["HOME","TAMANDUA_STATE_DIR","TAMANDUA_DB_PATH","TAMANDUA_DASHBOARD_PORT","TAMANDUA_MCP_PORT","TAMANDUA_CONTROL_PORT","TAMANDUA_TEST_GUARD"];

function saved() { const o = {}; for (const k of KEYS) o[k] = process.env[k]; return o; }
function restore(o) { for (const k of KEYS) { if (o[k] === undefined) delete process.env[k]; else process.env[k] = o[k]; } }

function setup(root) {
  const h = path.join(root, "home"), s = path.join(h, ".tamandua"), d = path.join(s, "tamandua.db");
  fs.mkdirSync(s, { recursive: true });
  return { h, s, d, e: { HOME: h, TAMANDUA_STATE_DIR: s, TAMANDUA_DB_PATH: d, TAMANDUA_DASHBOARD_PORT: "0", TAMANDUA_MCP_PORT: "0", TAMANDUA_CONTROL_PORT: "0" } };
}

function apply(e) { process.env.HOME = e.HOME; process.env.TAMANDUA_STATE_DIR = e.TAMANDUA_STATE_DIR; process.env.TAMANDUA_DB_PATH = e.TAMANDUA_DB_PATH; process.env.TAMANDUA_DASHBOARD_PORT = e.TAMANDUA_DASHBOARD_PORT; process.env.TAMANDUA_MCP_PORT = e.TAMANDUA_MCP_PORT; process.env.TAMANDUA_CONTROL_PORT = e.TAMANDUA_CONTROL_PORT; process.env.TAMANDUA_TEST_GUARD = "1"; }

function withEnv(fn) {
  const root = tamanduaTempDir("fc-");
  const s = saved();
  try { return fn(root); } finally { restore(s); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function readGate(dbPath) { const db = new DatabaseSync(dbPath); try { return db.prepare("SELECT * FROM update_gate WHERE id = 1").get(); } finally { db.close(); } }
function allRows(dbPath) { const db = new DatabaseSync(dbPath); try { return db.prepare("SELECT * FROM update_gate ORDER BY rowid").all(); } finally { db.close(); } }
function otherToken(orig) { for (let i = 0; i < 100; i++) { const t = crypto.randomBytes(32).toString("base64url"); if (t !== orig) return t; } const v = ["A","Q","g","w"]; const l = orig[orig.length-1]; return orig.slice(0,42) + (v.find(c => c !== l) || "A"); }

// ── Test 1: authorized success from both allowed sources ─────────────────

it("authorized success from ACQUIRED and GUARDIAN_RECORDED", () => {
  // ACQUIRED with multibyte non-ASCII diagnostics
  withEnv((root) => {
    const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const r = fail(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, "Build failed", "café résumé naïve");
    assert.deepEqual(r, { changed: true, phase: "FAILED" });
    const row = readGate(d);
    assert.equal(row.phase, "FAILED"); assert.equal(row.failure_reason, "Build failed");
    assert.equal(row.failure_details, "café résumé naïve");
    assert.equal(row.token, a.token); assert.equal(row.owner_pid, a.ownerPid); assert.equal(row.owner_identity, a.ownerIdentity);
  });
  // GUARDIAN_RECORDED via direct SQL phase update only
  withEnv((root) => {
    const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const db = new DatabaseSync(d); try { db.exec("UPDATE update_gate SET phase = 'GUARDIAN_RECORDED' WHERE id = 1"); } finally { db.close(); }
    const r = fail(a.token, "GUARDIAN_RECORDED", a.ownerPid, a.ownerIdentity, "timeout", "");
    assert.deepEqual(r, { changed: true, phase: "FAILED" });
    const row = readGate(d);
    assert.equal(row.phase, "FAILED"); assert.equal(row.failure_reason, "timeout"); assert.equal(row.failure_details, "");
  });
});

// ── Test 2: isolate every authorization mismatch ─────────────────────────

it("each authorization mismatch returns { changed: false }, row unchanged", () => {
  // Different canonical token
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}"); const snap = readGate(d);
    const r = fail(otherToken(a.token), "ACQUIRED", a.ownerPid, a.ownerIdentity, "r", "d");
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });
  // Wrong expected phase (GUARDIAN_RECORDED while at ACQUIRED)
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}"); const snap = readGate(d);
    const r = fail(a.token, "GUARDIAN_RECORDED", a.ownerPid, a.ownerIdentity, "r", "d");
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });
  // Different owner PID
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}"); const snap = readGate(d);
    const r = fail(a.token, "ACQUIRED", a.ownerPid + 1, a.ownerIdentity, "r", "d");
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });
  // Altered real owner identity (change start_ticks on Linux / lstart on macOS)
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}"); const snap = readGate(d);
    const parsed = JSON.parse(a.ownerIdentity);
    if (process.platform === "linux") parsed.start_ticks = parsed.start_ticks === "1" ? "2" : "1";
    else if (process.platform === "darwin") { const alternate = "Mon Jan 10 00:00:00 1970"; parsed.lstart = parsed.lstart === alternate ? "Tue Feb 11 01:02:03 1971" : alternate; }
    const alteredIdentity = JSON.stringify(parsed);
    assert.notStrictEqual(alteredIdentity, a.ownerIdentity);
    const r = fail(a.token, "ACQUIRED", a.ownerPid, alteredIdentity, "r", "d");
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });
});

// ── Test 3: strict input validation + no-create refusal + multi-row rollback

it("strict validation before DB work, no-create refusal, and multi-row rollback", () => {
  withEnv((root) => {
    const { d, e } = setup(root); apply(e);
    const tok = crypto.randomBytes(32).toString("base64url");
    const vid = captureProcessIdentity(process.ppid);

    // Coercion-proof token object
    let coerced = false; const sentinel = new Error("x");
    const obj = { [Symbol.toPrimitive]() { coerced = true; throw sentinel; }, toString() { coerced = true; throw sentinel; }, valueOf() { coerced = true; throw sentinel; } };
    assert.throws(() => fail(obj, "ACQUIRED", 1, vid, "r", "d"), { message: "Invalid capability token" });
    assert.equal(coerced, false);

    // Regex-valid noncanonical token (last char B)
    assert.throws(() => fail(tok.slice(0, 42) + "B", "ACQUIRED", 1, vid, "r", "d"), { message: "Invalid capability token" });

    // Padded, malformed, wrong-length tokens
    const IT = { message: "Invalid capability token" };
    assert.throws(() => fail(123, "ACQUIRED", 1, vid, "r", "d"), IT);
    assert.throws(() => fail("abc==", "ACQUIRED", 1, vid, "r", "d"), IT);
    assert.throws(() => fail("!@#$%", "ACQUIRED", 1, vid, "r", "d"), IT);
    assert.throws(() => fail("short", "ACQUIRED", 1, vid, "r", "d"), IT);
    assert.throws(() => fail(tok + "=", "ACQUIRED", 1, vid, "r", "d"), IT);

    // Invalid phases
    const IP = { message: "Invalid failure source phase" };
    assert.throws(() => fail(tok, "FAILED", 1, vid, "r", "d"), IP);
    assert.throws(() => fail(tok, "UNKNOWN", 1, vid, "r", "d"), IP);
    assert.throws(() => fail(tok, "", 1, vid, "r", "d"), IP);

    // Invalid PIDs
    const IPD = { message: "Invalid expected owner PID" };
    assert.throws(() => fail(tok, "ACQUIRED", 0, vid, "r", "d"), IPD);
    assert.throws(() => fail(tok, "ACQUIRED", -1, vid, "r", "d"), IPD);
    assert.throws(() => fail(tok, "ACQUIRED", 1.5, vid, "r", "d"), IPD);

    // Invalid identity
    assert.throws(() => fail(tok, "ACQUIRED", 1, "not-json", "r", "d"), { message: "Invalid process identity" });

    // Wrong-type reason
    assert.throws(() => fail(tok, "ACQUIRED", 1, vid, 123, "d"), { message: "Invalid failure reason" });
    // Over-byte-limit reason (em dash = 3 UTF-8 bytes, 86 × 3 = 258 > 256)
    assert.throws(() => fail(tok, "ACQUIRED", 1, vid, "—".repeat(86), "d"), { message: "Invalid failure reason" });

    // Wrong-type details
    assert.throws(() => fail(tok, "ACQUIRED", 1, vid, "r", 123), { message: "Invalid failure details" });
    // Over-byte-limit details (1366 × 3 = 4098 > 4096)
    assert.throws(() => fail(tok, "ACQUIRED", 1, vid, "r", "—".repeat(1366)), { message: "Invalid failure details" });

    // No artifacts created
    assert.equal(fs.existsSync(d), false); assert.equal(fs.existsSync(d + "-journal"), false);
    assert.equal(fs.existsSync(d + "-wal"), false); assert.equal(fs.existsSync(d + "-shm"), false);

    // Valid inputs to absent DB
    assert.deepEqual(fail(tok, "ACQUIRED", 1, vid, "r", "d"), { changed: false });
    assert.equal(fs.existsSync(d), false);

    // Empty SQLite file → generic refusal, no gate created
    const edb = new DatabaseSync(d); edb.close();
    assert.deepEqual(fail(tok, "ACQUIRED", 1, vid, "r", "d"), { changed: false });
    const vdb = new DatabaseSync(d);
    try { assert.equal(vdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='update_gate'").get(), undefined); } finally { vdb.close(); }
  });

  // Absent DB with special-char basename (spaces, ?, #)
  withEnv((root) => {
    const stateDir = path.join(root, "home", ".tamandua"); fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, "has spaces ? and #.db");
    apply({ HOME: path.join(root, "home"), TAMANDUA_STATE_DIR: stateDir, TAMANDUA_DB_PATH: dbPath, TAMANDUA_DASHBOARD_PORT: "0", TAMANDUA_MCP_PORT: "0", TAMANDUA_CONTROL_PORT: "0" });
    const tok = crypto.randomBytes(32).toString("base64url"); const vid = captureProcessIdentity(process.ppid);
    assert.throws(() => fail(123, "ACQUIRED", 1, vid, "r", "d"), { message: "Invalid capability token" });
    assert.equal(fs.existsSync(dbPath), false); assert.equal(fs.existsSync(dbPath + "-journal"), false);
    assert.equal(fs.existsSync(dbPath + "-wal"), false); assert.equal(fs.existsSync(dbPath + "-shm"), false);
    assert.deepEqual(fail(tok, "ACQUIRED", 1, vid, "r", "d"), { changed: false });
    assert.equal(fs.existsSync(dbPath), false); assert.equal(fs.existsSync(dbPath + "-journal"), false);
    assert.equal(fs.existsSync(dbPath + "-wal"), false); assert.equal(fs.existsSync(dbPath + "-shm"), false);
  });

  // Multi-row rollback: fixture table with two id=1 rows
  withEnv((root) => {
    const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const db = new DatabaseSync(d);
    try {
      db.exec("DROP TRIGGER IF EXISTS trg_update_gate_block_runs_insert");
      db.exec("DROP TRIGGER IF EXISTS trg_update_gate_block_runs_update");
      db.exec("DROP TABLE IF EXISTS update_gate");
      db.exec("CREATE TABLE update_gate (id INTEGER, token TEXT NOT NULL, phase TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_identity TEXT NOT NULL, failure_reason TEXT, failure_details TEXT, updated_at TEXT NOT NULL)");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO update_gate (id,token,phase,owner_pid,owner_identity,updated_at) VALUES (1,?,?,?,?,?)").run(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, now);
      db.prepare("INSERT INTO update_gate (id,token,phase,owner_pid,owner_identity,updated_at) VALUES (1,?,?,?,?,?)").run(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, now);
    } finally { db.close(); }
    const before = allRows(d); assert.equal(before.length, 2);
    const r = fail(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, "boom", "multi-row");
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false);
    assert.deepEqual(allRows(d), before);
  });
});

// ── Test 4: terminal / late-call behavior ────────────────────────────────

it("late call on FAILED refuses, FAILED phase rejected as source", () => {
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    assert.deepEqual(fail(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, "first", "x"), { changed: true, phase: "FAILED" });
    const snap = readGate(d);
    const late = fail(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, "second", "no");
    assert.deepEqual(late, { changed: false }); assert.equal("phase" in late, false); assert.deepEqual(readGate(d), snap);
  });
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    assert.deepEqual(fail(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, "done", ""), { changed: true, phase: "FAILED" });
    const snap = readGate(d);
    assert.throws(() => fail(a.token, "FAILED", a.ownerPid, a.ownerIdentity, "retry", ""), { message: "Invalid failure source phase" });
    assert.deepEqual(readGate(d), snap);
  });
});
