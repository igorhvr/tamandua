/**
 * Unit tests for hermes-usage.ts — lookupHermesSessionTokens.
 *
 * All tests use synthetic SQLite fixtures (no real hermes installation).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { DatabaseSync } from "node:sqlite";
import { lookupHermesSessionTokens, probeHermesStateContract } from "../../dist/installer/hermes-usage.js";

function createTempHome(): string {
  return tamanduaTempDir("tamandua-test-hermes-usage-");
}

function seedStateDb(hermesHome: string, rows: Array<Record<string, unknown>>): string {
  const dbPath = path.join(hermesHome, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL
    )
  `);
  for (const row of rows) {
    const keys = Object.keys(row);
    const placeholders = keys.map(() => "?").join(", ");
    const values = keys.map((k) => row[k]);
    db.prepare(`INSERT INTO sessions (${keys.join(", ")}) VALUES (${placeholders})`).run(
      ...values,
    );
  }
  db.close();
  return dbPath;
}

function makeEnv(hermesHome: string): NodeJS.ProcessEnv {
  // Only pass the HERMES_HOME var; avoid spreading process.env which
  // triggers the test-isolation guard (TAMANDUA_TEST_GUARD leakage).
  // The lookupHermesSessionTokens function only reads HERMES_HOME and
  // os.homedir() — no other env vars are consumed.
  return { HERMES_HOME: hermesHome };
}

describe("lookupHermesSessionTokens", () => {
  let tempDir: string | null = null;
  let savedHermesHome: string | undefined;

  beforeEach(() => {
    tempDir = createTempHome();
    savedHermesHome = process.env.HERMES_HOME;
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (savedHermesHome === undefined) {
      delete process.env.HERMES_HOME;
    } else {
      process.env.HERMES_HOME = savedHermesHome;
    }
  });

  it("returns total tokens for a valid session", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-abc", input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 25 },
    ]);
    const result = await lookupHermesSessionTokens("sess-abc", makeEnv(tempDir!));
    assert.equal(result, 325);
  });

  it("excludes reasoning_tokens from the total", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-abc", input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 25, reasoning_tokens: 500 },
    ]);
    const result = await lookupHermesSessionTokens("sess-abc", makeEnv(tempDir!));
    assert.equal(result, 325);
  });

  it("clamps negative token values to 0", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-abc", input_tokens: -10, output_tokens: 200, cache_read_tokens: -5, cache_write_tokens: 25 },
    ]);
    const result = await lookupHermesSessionTokens("sess-abc", makeEnv(tempDir!));
    assert.equal(result, 225);
  });

  it("handles NULL token columns as 0", async () => {
    const dbPath = path.join(tempDir!, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER
      )
    `);
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("sess-null");
    db.close();

    const result = await lookupHermesSessionTokens("sess-null", makeEnv(tempDir!));
    assert.equal(result, 0);
  });

  it("returns null when state.db is missing", async () => {
    const result = await lookupHermesSessionTokens("sess-abc", makeEnv(tempDir!));
    assert.equal(result, null);
  });

  it("returns null when sessions table is missing", async () => {
    const dbPath = path.join(tempDir!, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other_table (x int)");
    db.close();

    const result = await lookupHermesSessionTokens("sess-abc", makeEnv(tempDir!));
    assert.equal(result, null);
  });

  it("returns null when a required column is missing (e.g. no cache_write_tokens)", async () => {
    const dbPath = path.join(tempDir!, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER
      )
    `);
    db.prepare("INSERT INTO sessions (id, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?)").run(
      "sess-abc", 100, 200, 50,
    );
    db.close();

    const result = await lookupHermesSessionTokens("sess-abc", makeEnv(tempDir!));
    assert.equal(result, null);
  });

  it("returns null when row not found after retries", async () => {
    seedStateDb(tempDir!, [
      { id: "other-session", input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 25 },
    ]);

    const result = await lookupHermesSessionTokens("sess-missing", makeEnv(tempDir!));
    assert.equal(result, null);
  });

  it("never creates the state.db file when missing (read-only)", async () => {
    const stateDbPath = path.join(tempDir!, "state.db");
    assert.ok(!fs.existsSync(stateDbPath));

    await lookupHermesSessionTokens("sess-abc", makeEnv(tempDir!));

    // readOnly mode should prevent file creation
    assert.ok(!fs.existsSync(stateDbPath));
  });

  it("resolves HERMES_HOME from the env parameter", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-env", input_tokens: 10, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 3 },
    ]);

    // Clear process.env.HERMES_HOME so only the parameter is used
    delete process.env.HERMES_HOME;
    const result = await lookupHermesSessionTokens("sess-env", { HERMES_HOME: tempDir! });
    assert.equal(result, 33);
  });

  it("falls back to process.env.HERMES_HOME when env parameter omits it", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-proc", input_tokens: 10, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 3 },
    ]);

    process.env.HERMES_HOME = tempDir!;
    const result = await lookupHermesSessionTokens("sess-proc", {});
    assert.equal(result, 33);
  });

  it("env parameter HERMES_HOME takes precedence over process.env", async () => {
    const otherDir = createTempHome();
    seedStateDb(otherDir, [
      { id: "sess-prec", input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    ]);

    process.env.HERMES_HOME = "/some/nonexistent/path";
    const result = await lookupHermesSessionTokens("sess-prec", { HERMES_HOME: otherDir });
    assert.equal(result, 20);

    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it("returns integer total (rounds fractional)", async () => {
    // SQLite INTEGER can't really be fractional, but encode test intent
    seedStateDb(tempDir!, [
      { id: "sess-round", input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 25 },
    ]);
    const result = await lookupHermesSessionTokens("sess-round", makeEnv(tempDir!));
    assert.equal(result, 325);
    assert.ok(Number.isInteger(result));
  });

  it("sums only the four required token columns", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-sum", input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40 },
    ]);
    const result = await lookupHermesSessionTokens("sess-sum", makeEnv(tempDir!));
    // 10 + 20 + 40 = 70 (cache_read excluded)
    assert.equal(result, 70);
  });

  it("excludes cache_read_tokens from the total", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-cache", input_tokens: 100, output_tokens: 50, cache_read_tokens: 5_000_000, cache_write_tokens: 0 },
    ]);
    const result = await lookupHermesSessionTokens("sess-cache", makeEnv(tempDir!));
    // 100 + 50 + 0 = 150 (cache_read of 5_000_000 excluded)
    assert.equal(result, 150);
  });

  it("works with zero tokens", async () => {
    seedStateDb(tempDir!, [
      { id: "sess-zero", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    ]);
    const result = await lookupHermesSessionTokens("sess-zero", makeEnv(tempDir!));
    assert.equal(result, 0);
  });
});

describe("probeHermesStateContract", () => {
  let tempDir: string | null = null;
  let savedHermesHome: string | undefined;

  beforeEach(() => {
    tempDir = createTempHome();
    savedHermesHome = process.env.HERMES_HOME;
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (savedHermesHome === undefined) {
      delete process.env.HERMES_HOME;
    } else {
      process.env.HERMES_HOME = savedHermesHome;
    }
  });

  it("returns ok:true for a valid state.db with all required columns", () => {
    seedStateDb(tempDir!, [
      { id: "sess-1", input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 25 },
    ]);
    const result = probeHermesStateContract(makeEnv(tempDir!));
    assert.deepEqual(result, { ok: true });
  });

  it("returns ok:false when state.db is missing", () => {
    const result = probeHermesStateContract(makeEnv(tempDir!));
    assert.equal(result.ok, false);
    assert.ok(result.reason!.includes("state.db not found"), `reason should mention missing state.db, got: ${result.reason}`);
  });

  it("returns ok:false when sessions table is missing", () => {
    const dbPath = path.join(tempDir!, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other_table (x int)");
    db.close();

    const result = probeHermesStateContract(makeEnv(tempDir!));
    assert.equal(result.ok, false);
    assert.ok(result.reason!.includes("no sessions table"), `reason should mention no sessions table, got: ${result.reason}`);
  });

  it("returns ok:false when a single required column is missing", () => {
    const dbPath = path.join(tempDir!, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER
      )
    `);
    db.prepare("INSERT INTO sessions (id, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?)").run(
      "sess-abc", 100, 200, 50,
    );
    db.close();

    const result = probeHermesStateContract(makeEnv(tempDir!));
    assert.equal(result.ok, false);
    assert.ok(result.reason!.includes("missing columns"), `reason should mention missing columns, got: ${result.reason}`);
    assert.ok(result.reason!.includes("cache_write_tokens"), `reason should list cache_write_tokens, got: ${result.reason}`);
  });

  it("returns ok:false when multiple required columns are missing", () => {
    const dbPath = path.join(tempDir!, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        input_tokens INTEGER
      )
    `);
    db.close();

    const result = probeHermesStateContract(makeEnv(tempDir!));
    assert.equal(result.ok, false);
    assert.ok(result.reason!.includes("missing columns"), `reason should mention missing columns, got: ${result.reason}`);
    assert.ok(result.reason!.includes("output_tokens"), `reason should list output_tokens, got: ${result.reason}`);
    assert.ok(result.reason!.includes("cache_read_tokens"), `reason should list cache_read_tokens, got: ${result.reason}`);
    assert.ok(result.reason!.includes("cache_write_tokens"), `reason should list cache_write_tokens, got: ${result.reason}`);
  });

  it("works with extra columns beyond the required ones", () => {
    seedStateDb(tempDir!, [
      { id: "sess-1", input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 25 },
    ]);
    // seedStateDb already includes reasoning_tokens and estimated_cost_usd as extras
    const result = probeHermesStateContract(makeEnv(tempDir!));
    assert.deepEqual(result, { ok: true });
  });

  it("uses HERMES_HOME from env parameter", () => {
    seedStateDb(tempDir!, [
      { id: "sess-1", input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    ]);
    delete process.env.HERMES_HOME;
    const result = probeHermesStateContract({ HERMES_HOME: tempDir! });
    assert.deepEqual(result, { ok: true });
  });

  it("falls back to process.env.HERMES_HOME", () => {
    seedStateDb(tempDir!, [
      { id: "sess-1", input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    ]);
    process.env.HERMES_HOME = tempDir!;
    const result = probeHermesStateContract({});
    assert.deepEqual(result, { ok: true });
  });

  it("is synchronous (returns immediately, not a Promise)", () => {
    seedStateDb(tempDir!, [
      { id: "sess-1", input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
    ]);
    const result = probeHermesStateContract(makeEnv(tempDir!));
    assert.ok(!(result instanceof Promise), "probeHermesStateContract should return a plain object, not a Promise");
    assert.deepEqual(result, { ok: true });
  });
});
