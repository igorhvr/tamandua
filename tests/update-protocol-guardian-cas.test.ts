import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { acquire, recordGuardian, captureProcessIdentity } from "../scripts/update-protocol.mjs";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const KEYS = ["HOME","TAMANDUA_STATE_DIR","TAMANDUA_DB_PATH","TAMANDUA_DASHBOARD_PORT","TAMANDUA_MCP_PORT","TAMANDUA_CONTROL_PORT","TAMANDUA_TEST_GUARD"];

function saved() { const o: Record<string, string | undefined> = {}; for (const k of KEYS) o[k] = process.env[k]; return o; }
function restore(o: Record<string, string | undefined>) { for (const k of KEYS) { if (o[k] === undefined) delete process.env[k]; else process.env[k] = o[k]; } }

function setup(root: string) {
  const h = path.join(root, "home"), s = path.join(h, ".tamandua"), d = path.join(s, "tamandua.db");
  fs.mkdirSync(s, { recursive: true });
  return { h, s, d, e: { HOME: h, TAMANDUA_STATE_DIR: s, TAMANDUA_DB_PATH: d, TAMANDUA_DASHBOARD_PORT: "0", TAMANDUA_MCP_PORT: "0", TAMANDUA_CONTROL_PORT: "0" } };
}

function apply(e: { HOME: string; TAMANDUA_STATE_DIR: string; TAMANDUA_DB_PATH: string; TAMANDUA_DASHBOARD_PORT: string; TAMANDUA_MCP_PORT: string; TAMANDUA_CONTROL_PORT: string }) {
  process.env.HOME = e.HOME; process.env.TAMANDUA_STATE_DIR = e.TAMANDUA_STATE_DIR; process.env.TAMANDUA_DB_PATH = e.TAMANDUA_DB_PATH;
  process.env.TAMANDUA_DASHBOARD_PORT = e.TAMANDUA_DASHBOARD_PORT; process.env.TAMANDUA_MCP_PORT = e.TAMANDUA_MCP_PORT; process.env.TAMANDUA_CONTROL_PORT = e.TAMANDUA_CONTROL_PORT; process.env.TAMANDUA_TEST_GUARD = "1";
}

function withEnv(fn: (root: string) => void) {
  const root = tamanduaTempDir("gc-");
  const s = saved();
  try { return fn(root); } finally { restore(s); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function readGate(dbPath: string) { const db = new DatabaseSync(dbPath); try { return db.prepare("SELECT * FROM update_gate WHERE id = 1").get(); } finally { db.close(); } }
function allRows(dbPath: string) { const db = new DatabaseSync(dbPath); try { return db.prepare("SELECT * FROM update_gate ORDER BY rowid").all(); } finally { db.close(); } }
function otherToken(orig: string) { for (let i = 0; i < 100; i++) { const t = crypto.randomBytes(32).toString("base64url"); if (t !== orig) return t; } const v = ["A","Q","g","w"]; const l = orig[orig.length-1]; return orig.slice(0,42) + (v.find(c => c !== l) || "A"); }

function assertNone(dbPath: string, parentDir: string) {
  assert.equal(fs.existsSync(dbPath), false); assert.equal(fs.existsSync(dbPath + "-journal"), false); assert.equal(fs.existsSync(dbPath + "-wal"), false); assert.equal(fs.existsSync(dbPath + "-shm"), false); assert.equal(fs.existsSync(parentDir), false);
}

function hostile() { let f=false; const e=new Error("x"); const o={[Symbol.toPrimitive](){f=true;throw e},toString(){f=true;throw e},valueOf(){f=true;throw e}}; return{obj:o,coerced:()=>f}; }

// ── Test 1: Authorized ACQUIRED -> GUARDIAN_RECORDED ──────────────────────

it("authorized ACQUIRED -> GUARDIAN_RECORDED success", () => {
  withEnv((root) => {
    const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const guardianPid = process.pid;
    const expectedGuardianIdentity = captureProcessIdentity(guardianPid);

    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, guardianPid, expectedGuardianIdentity);
    assert.deepEqual(r, { changed: true, phase: "GUARDIAN_RECORDED" });

    const row = readGate(d);
    assert.equal(row.phase, "GUARDIAN_RECORDED");
    assert.equal(row.guardian_pid, guardianPid);
    assert.equal(row.guardian_identity, expectedGuardianIdentity);
    assert.equal(row.token, a.token);
    assert.equal(row.owner_pid, a.ownerPid);
    assert.equal(row.owner_identity, a.ownerIdentity);
    // Unrelated payload unchanged
    assert.equal(row.mode, "current");
    assert.equal(row.topology, "{}");
    assert.equal(row.artifacts, "{}");
    assert.equal(row.readiness, "{}");
    assert.equal(row.failure_reason, null);
    assert.equal(row.failure_details, null);
  });
});

// ── Test 2: Isolated authorization/phase mismatches ───────────────────────

it("each authorization mismatch returns { changed: false }, row unchanged", () => {
  // Different valid canonical token
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const guardianId = captureProcessIdentity(process.pid);
    const snap = readGate(d);
    const r = recordGuardian(otherToken(a.token), "ACQUIRED", a.ownerPid, a.ownerIdentity, process.pid, guardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });

  // Stored phase mismatch while caller supplies literal "ACQUIRED"
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const guardianId = captureProcessIdentity(process.pid);
    // Advance row to GUARDIAN_RECORDED first
    assert.deepEqual(recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, process.pid, guardianId), { changed: true, phase: "GUARDIAN_RECORDED" });
    const snap = readGate(d);
    // Now warehouse phase is GUARDIAN_RECORDED, but caller supplies ACQUIRED — predicate should not match
    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, process.pid, guardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });

  // Different positive owner PID only
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const guardianId = captureProcessIdentity(process.pid);
    const snap = readGate(d);
    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid + 1, a.ownerIdentity, process.pid, guardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });

  // Same owner PID with a different but canonical owner identity
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const guardianId = captureProcessIdentity(process.pid);
    const snap = readGate(d);
    const parsed = JSON.parse(a.ownerIdentity);
    if (process.platform === "linux") parsed.start_ticks = parsed.start_ticks === "1" ? "2" : "1";
    else if (process.platform === "darwin") { const alternate = "Mon Jan 10 00:00:00 1970"; parsed.lstart = parsed.lstart === alternate ? "Tue Feb 11 01:02:03 1971" : alternate; }
    const alteredOwnerIdentity = JSON.stringify(parsed);
    assert.notStrictEqual(alteredOwnerIdentity, a.ownerIdentity);
    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid, alteredOwnerIdentity, process.pid, guardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false); assert.deepEqual(readGate(d), snap);
  });
});

// ── Test 3: Guardian proof / refusal ──────────────────────────────────────

it("guardian proof refusal — altered identity, nonexistent PID, validation-before-DB proof", () => {
  // ── Real-gate: altered guardian identity (PID alive, identity mismatched) ──
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const snap = readGate(d);
    const realId = captureProcessIdentity(process.pid);
    const parsed = JSON.parse(realId);
    if (process.platform === "linux") parsed.start_ticks = parsed.start_ticks === "1" ? "2" : "1";
    else if (process.platform === "darwin") { const alternate = "Mon Jan 10 00:00:00 1970"; parsed.lstart = parsed.lstart === alternate ? "Tue Feb 11 01:02:03 1971" : alternate; }
    const alteredGuardianId = JSON.stringify(parsed);
    assert.notStrictEqual(alteredGuardianId, realId);
    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, process.pid, alteredGuardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false);
    assert.deepEqual(readGate(d), snap);
  });

  // ── Real-gate: guaranteed nonexistent guardian PID ──────────────────────
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const snap = readGate(d);
    const nonexistentPid = Number.MAX_SAFE_INTEGER;
    const canonicalId = captureProcessIdentity(process.pid);
    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, nonexistentPid, canonicalId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false);
    assert.deepEqual(readGate(d), snap);
  });

  // ── Validation-before-DB: malformed inputs, absent parent, no DB creation ──
  withEnv((root) => {
    const nop = path.join(root, "parent with spaces ? and #");
    const dbPath = path.join(nop, "gc.db");
    // Set env with deliberately nonexistent paths — do NOT create parent or TAMANDUA_STATE_DIR
    process.env.HOME = path.join(root, "home"); process.env.TAMANDUA_STATE_DIR = path.join(root, "home", ".tamandua");
    process.env.TAMANDUA_DB_PATH = dbPath; process.env.TAMANDUA_DASHBOARD_PORT = "0"; process.env.TAMANDUA_MCP_PORT = "0"; process.env.TAMANDUA_CONTROL_PORT = "0"; process.env.TAMANDUA_TEST_GUARD = "1";
    // Compute valid canonical authority independently of any DB use
    const vt = crypto.randomBytes(32).toString("base64url");
    const voi = captureProcessIdentity(process.ppid);
    const vgi = captureProcessIdentity(process.pid);
    // 1. Regex-valid 43-char but noncanonical token
    assert.throws(() => recordGuardian(vt.slice(0, 42) + "B", "ACQUIRED", process.ppid, voi, process.pid, vgi), { message: "Invalid capability token" });
    assertNone(dbPath, nop);
    // 2. Wrong-type token object with throwing coercion hooks
    const ht = hostile();
    assert.throws(() => recordGuardian(ht.obj, "ACQUIRED", process.ppid, voi, process.pid, vgi), { message: "Invalid capability token" });
    assert.equal(ht.coerced(), false); assertNone(dbPath, nop);
    // 3. Expected phase other than literal ACQUIRED
    assert.throws(() => recordGuardian(vt, "GUARDIAN_RECORDED", process.ppid, voi, process.pid, vgi), { message: "Invalid guardian source phase" });
    assertNone(dbPath, nop);
    // 4a. Invalid expected owner PID: zero
    assert.throws(() => recordGuardian(vt, "ACQUIRED", 0, voi, process.pid, vgi), { message: "Invalid expected owner PID" });
    assertNone(dbPath, nop);
    // 4b. Invalid expected owner PID: hostile object (hooks must not run)
    const hop = hostile();
    assert.throws(() => recordGuardian(vt, "ACQUIRED", hop.obj, voi, process.pid, vgi), { message: "Invalid expected owner PID" });
    assert.equal(hop.coerced(), false); assertNone(dbPath, nop);
    // 5. Malformed expected owner identity
    assert.throws(() => recordGuardian(vt, "ACQUIRED", process.ppid, "not-valid-identity", process.pid, vgi), { message: "Invalid process identity" });
    assertNone(dbPath, nop);
    // 6a. Invalid guardian PID: zero
    assert.throws(() => recordGuardian(vt, "ACQUIRED", process.ppid, voi, 0, vgi), { message: "Invalid guardian PID" });
    assertNone(dbPath, nop);
    // 6b. Invalid guardian PID: hostile object (hooks must not run)
    const hgp = hostile();
    assert.throws(() => recordGuardian(vt, "ACQUIRED", process.ppid, voi, hgp.obj, vgi), { message: "Invalid guardian PID" });
    assert.equal(hgp.coerced(), false); assertNone(dbPath, nop);
    // 7. Malformed expected guardian identity
    assert.throws(() => recordGuardian(vt, "ACQUIRED", process.ppid, voi, process.pid, "not-valid-identity"), { message: "Invalid process identity" });
    assertNone(dbPath, nop);
  });
});

// ── Test 4: Operational / atomic refusal ──────────────────────────────────

it("operational refusal — absent DB no-create proof, no gate, late call, duplicate-row rollback", () => {
  // ── Valid-input no-create proof: absent parent, fully valid inputs ──────
  withEnv((root) => {
    const nop = path.join(root, "absent parent with ? and #");
    const dbPath = path.join(nop, "absent.db");
    // Deliberately do NOT mkdirSync the parent or call setup()/acquire()
    process.env.HOME = path.join(root, "home"); process.env.TAMANDUA_STATE_DIR = path.join(root, "home", ".tamandua");
    process.env.TAMANDUA_DB_PATH = dbPath; process.env.TAMANDUA_DASHBOARD_PORT = "0"; process.env.TAMANDUA_MCP_PORT = "0"; process.env.TAMANDUA_CONTROL_PORT = "0"; process.env.TAMANDUA_TEST_GUARD = "1";
    const r = recordGuardian(crypto.randomBytes(32).toString("base64url"), "ACQUIRED", process.ppid, captureProcessIdentity(process.ppid), process.pid, captureProcessIdentity(process.pid));
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false);
    assertNone(dbPath, nop);
  });

  // ── Existing DB without the gate table changes nothing ──────────────────
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const guardianId = captureProcessIdentity(process.pid);
    const ownerId = captureProcessIdentity(process.ppid);
    // Create an empty SQLite file with no gate table
    const edb = new DatabaseSync(d); edb.close();
    const tok = crypto.randomBytes(32).toString("base64url");
    const r = recordGuardian(tok, "ACQUIRED", 1, ownerId, process.pid, guardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false);
    // Verify no gate table was created
    const vdb = new DatabaseSync(d);
    try { assert.equal(vdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='update_gate'").get(), undefined); } finally { vdb.close(); }
  });

  // ── Late call after an already recorded guardian changes nothing ────────
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const guardianId = captureProcessIdentity(process.pid);
    assert.deepEqual(recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, process.pid, guardianId), { changed: true, phase: "GUARDIAN_RECORDED" });
    const snap = readGate(d);
    // Second call with same valid authority — row already GUARDIAN_RECORDED, phase predicate fails
    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, process.pid, guardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false);
    assert.deepEqual(readGate(d), snap);
  });

  // ── Duplicate-row exact-one rollback: two matching id=1 rows ────────────
  withEnv((root) => { const { d, e } = setup(root); apply(e);
    const a = acquire("current", process.ppid, "{}", "{}", "{}");
    const guardianId = captureProcessIdentity(process.pid);
    const db = new DatabaseSync(d);
    try {
      db.exec("DROP TRIGGER IF EXISTS trg_update_gate_block_runs_insert");
      db.exec("DROP TRIGGER IF EXISTS trg_update_gate_block_runs_update");
      db.exec("DROP TABLE IF EXISTS update_gate");
      db.exec("CREATE TABLE update_gate (id INTEGER, token TEXT NOT NULL, phase TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_identity TEXT NOT NULL, guardian_pid INTEGER, guardian_identity TEXT, updated_at TEXT NOT NULL)");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO update_gate (id,token,phase,owner_pid,owner_identity,updated_at) VALUES (1,?,?,?,?,?)").run(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, now);
      db.prepare("INSERT INTO update_gate (id,token,phase,owner_pid,owner_identity,updated_at) VALUES (1,?,?,?,?,?)").run(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, now);
    } finally { db.close(); }
    const before = allRows(d); assert.equal(before.length, 2);
    const r = recordGuardian(a.token, "ACQUIRED", a.ownerPid, a.ownerIdentity, process.pid, guardianId);
    assert.deepEqual(r, { changed: false }); assert.equal("phase" in r, false);
    assert.deepEqual(allRows(d), before);
  });
});
