// Tier-2 STORM-REHEARSAL US-001 (S2) — fresh PRODUCT-schema exec-identity DB.
//
// Run #56 aborted because `tt-storm prepare` captured a suite-provisioned,
// hand-rolled `runs` table (no notify_url, user_version 9) at the campaign's
// private DB path as state.exec_identity, and the rehearsal then launched the
// current product against it:
//   Error: table runs has no column named notify_url
//
// This file is the ONE focused torture self-test for the S2 fix:
//   E1  provisionProductExecDb refuses a pre-existing DB (TT_EXEC_DB_STALE)
//       and leaves its bytes byte-identical (never delete/reuse);
//   E2  the injectable spawnProductDb seam receives the ABSOLUTE product
//       module invocation under the private child env (HOME/STATE/DB/guard),
//       cwd = private home, mergeParentEnv:false, no authority leak;
//   E3  the real product path creates a fresh DB whose `runs` table is a
//       superset of the columns getDb() creates on a SEPARATE temp HOME
//       (compared via PRAGMA table_info, never a hard-coded list) and the
//       returned receipt carries ownership.db dev/ino > 0;
//   E4  the REAL `tt-storm prepare` CLI on a fresh TT_VAR scratch exits 0 and
//       records state.exec_identity.db_path + ownership.db dev/ino > 0 with a
//       notify_url-bearing prepared DB;
//   E5  the REAL `tt-storm prepare` CLI against a private root PRE-SEEDED with
//       the EXACT hand-rolled runs DDL from the finding exits non-zero with
//       TT_EXEC_DB_STALE and leaves the pre-seeded DB byte-identical.
//
// Everything runs under test-owned scratch dirs (removed in finally). No
// daemon/harness/chaos is ever spawned by prepare.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  TT_EXEC_DB_STALE,
  TT_PRODUCT_DB_UNAVAILABLE,
  buildPrivateExecContext,
  provisionProductExecDb,
} from "../bin/tt-storm-real.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const PRODUCT_DB_MODULE = path.join(repoRoot, "dist", "db.js");

// EXACT hand-rolled `runs` DDL recorded in storm-rehearsal-exec-contract.json
// suite_findings S2.evidence.wal_create_table (the run #56 stale DB).
const STALE_RUNS_DDL =
  "CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}', tokens_spent INTEGER NOT NULL DEFAULT 0, scheduling_status TEXT, scheduling_requested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)";

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-exec-db-${label}-`));
}

function defaultDbPath(varRoot: string): string {
  return path.join(varRoot, "home", ".tamandua", "tamandua.db");
}

function runsColumns(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

function childEnvForCli(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runCliPrepare(scratchVar: string, args: string[] = []) {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, "prepare", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnvForCli({ TT_VAR: scratchVar }),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

// Create a reference product-schema DB through the REAL getDb() on a separate
// temp HOME (never by hand-rolled DDL and never through the campaign path).
function createReferenceProductDb(scratch: string): string {
  const home = path.join(scratch, "home");
  const state = path.join(home, ".tamandua");
  const dbPath = path.join(state, "tamandua.db");
  fs.mkdirSync(state, { recursive: true });
  const script = `import { getDb } from ${JSON.stringify(PRODUCT_DB_MODULE)}; getDb();`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: home,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      TAMANDUA_STATE_DIR: state,
      TAMANDUA_DB_PATH: dbPath,
      TAMANDUA_TEST_GUARD: "1",
    },
  });
  assert.equal(res.status, 0, `reference getDb() must succeed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.ok(fs.existsSync(dbPath), "reference product DB created");
  return dbPath;
}

describe("STORM-REHEARSAL US-001 (S2): fresh product-schema exec-identity DB", () => {
  it("E1: provisionProductExecDb refuses a pre-existing DB with TT_EXEC_DB_STALE and leaves it byte-identical (never delete/reuse)", async () => {
    const scratch = ownedScratch("stale");
    try {
      const execCtx = buildPrivateExecContext({
        varRoot: scratch,
        binaries: { tamandua: TAMANDUA_BIN },
        ownerRef: "e1-stale",
      });
      assert.equal(execCtx.db_path, defaultDbPath(scratch), "exec context DB lives at the private path");
      fs.mkdirSync(path.dirname(execCtx.db_path), { recursive: true });
      const seed = new DatabaseSync(execCtx.db_path);
      seed.exec(STALE_RUNS_DDL);
      seed.close();
      const before = fs.readFileSync(execCtx.db_path);
      assert.ok(before.length > 0, "pre-seeded DB is non-empty");

      let spawnCalls = 0;
      await assert.rejects(
        () => provisionProductExecDb({
          execCtx,
          spawnProductDb: async () => { spawnCalls += 1; return { exitCode: 0 }; },
        }),
        (err: any) => {
          assert.equal(err?.code, TT_EXEC_DB_STALE, "refusal code is TT_EXEC_DB_STALE");
          assert.match(String(err?.message ?? ""), new RegExp(TT_EXEC_DB_STALE), "message names the code");
          assert.match(String(err?.message ?? ""), /never delete or reuse/, "message explains fail-closed refusal");
          return true;
        },
      );
      assert.equal(spawnCalls, 0, "the product path is never invoked when a stale DB exists");
      assert.deepEqual(fs.readFileSync(execCtx.db_path), before, "pre-seeded DB bytes are byte-identical");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("E2: the injectable spawnProductDb seam receives the ABSOLUTE product invocation under the private child env (mergeParentEnv:false, no authority leak)", async () => {
    const scratch = ownedScratch("seam");
    try {
      const execCtx = buildPrivateExecContext({
        varRoot: scratch,
        binaries: { tamandua: TAMANDUA_BIN },
        ownerRef: "e2-seam",
      });
      const calls: Array<{ argv: string[]; opts: any }> = [];
      const spawnProductDb = async (argv: string[], opts: any) => {
        calls.push({ argv, opts });
        // Simulate the product creating the DB at the env-specified path.
        fs.writeFileSync(execCtx.db_path, "");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      };
      const provisioned = await provisionProductExecDb({ execCtx, spawnProductDb });
      assert.equal(calls.length, 1, "the product schema path is invoked exactly once");
      const { argv, opts } = calls[0];
      assert.equal(argv[0], process.execPath, "argv[0] is the absolute node executable");
      assert.deepEqual(argv.slice(1, 3), ["--input-type=module", "-e"], "argv is an ESM inline program");
      assert.match(argv[3], /dist[\\/]db\.js/, "inline program imports the absolute product dist/db.js");
      assert.match(argv[3], /getDb/, "inline program calls the product getDb()");
      assert.ok(path.isAbsolute(PRODUCT_DB_MODULE), "product module import is absolute");
      assert.equal(opts.cwd, execCtx.home_root, "cwd is the private HOME");
      assert.equal(opts.mergeParentEnv, false, "parent env is never merged");
      assert.equal(opts.env.HOME, execCtx.home_root, "child env HOME is the private root");
      assert.equal(opts.env.TAMANDUA_STATE_DIR, execCtx.state_root, "child env STATE is the private root");
      assert.equal(opts.env.TAMANDUA_DB_PATH, execCtx.db_path, "child env DB is the private campaign DB");
      assert.equal(opts.env.TAMANDUA_TEST_GUARD, "1", "guard is set for the product child");
      assert.equal(opts.env.TAMANDUA_RUN_ID, undefined, "no parent run authority leaked");
      assert.equal(opts.env.TAMANDUA_WORKER_PID, undefined, "no worker authority leaked");
      assert.ok(provisioned.receipt?.ownership?.db?.ino > 0, "receipt DB ino re-captured after creation");
      assert.equal(provisioned.receipt.db_path, execCtx.db_path, "receipt names the campaign DB");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("E3: the real product path creates a fresh DB whose runs table supersets getDb()'s columns on a separate temp HOME (incl notify_url) with receipt db dev/ino > 0", async () => {
    const scratch = ownedScratch("product");
    const refScratch = ownedScratch("ref");
    try {
      const execCtx = buildPrivateExecContext({
        varRoot: scratch,
        binaries: { tamandua: TAMANDUA_BIN },
        ownerRef: "e3-product",
      });
      assert.equal(fs.existsSync(execCtx.db_path), false, "no DB exists before provisioning");
      const provisioned = await provisionProductExecDb({ execCtx });
      assert.equal(provisioned.ok, true, "provisioning succeeds");
      assert.ok(fs.existsSync(execCtx.db_path), "prepared DB exists");

      const refDb = createReferenceProductDb(refScratch);
      const refColumns = runsColumns(refDb);
      const preparedColumns = runsColumns(execCtx.db_path);
      assert.ok(refColumns.includes("notify_url"), "reference getDb() runs table includes notify_url");
      assert.ok(preparedColumns.includes("notify_url"), "prepared runs table includes notify_url");
      for (const col of refColumns) {
        assert.ok(preparedColumns.includes(col), `prepared runs table contains product column ${col}`);
      }
      assert.ok(provisioned.receipt?.ownership?.db?.ino > 0, "receipt ownership.db.ino > 0");
      assert.ok(provisioned.receipt?.ownership?.db?.dev > 0, "receipt ownership.db.dev > 0");
      assert.equal(provisioned.receipt.db_path, execCtx.db_path, "receipt DB path equals the exec context DB path");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.rmSync(refScratch, { recursive: true, force: true });
    }
  });

  it("E4: the REAL tt-storm prepare CLI on a fresh private root exits 0 and records the fresh product DB receipt", () => {
    const scratch = ownedScratch("cli-fresh");
    try {
      fs.mkdirSync(path.join(scratch, "results"), { recursive: true });
      const r = runCliPrepare(scratch);
      assert.equal(r.status, 0, `fresh prepare must exit 0:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      const m = /Campaign dir: (\S+)/.exec(r.stdout);
      assert.ok(m, "prepare prints the campaign dir");
      const campaignDir = m[1];
      const state = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      const dbPath = defaultDbPath(scratch);
      assert.equal(state.exec_identity.db_path, dbPath, "state.exec_identity.db_path is the private exec DB");
      assert.ok(state.exec_identity.ownership.db.ino > 0, "state.exec_identity.ownership.db.ino > 0");
      assert.ok(state.exec_identity.ownership.db.dev > 0, "state.exec_identity.ownership.db.dev > 0");
      assert.ok(fs.existsSync(dbPath), "prepared DB exists");
      assert.ok(runsColumns(dbPath).includes("notify_url"), "prepared DB runs table includes notify_url");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("E5: the REAL tt-storm prepare CLI against a private root pre-seeded with the exact hand-rolled runs DDL refuses TT_EXEC_DB_STALE and leaves it byte-identical", () => {
    const scratch = ownedScratch("cli-stale");
    try {
      fs.mkdirSync(path.join(scratch, "results"), { recursive: true });
      const dbPath = defaultDbPath(scratch);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const seed = new DatabaseSync(dbPath);
      seed.exec(STALE_RUNS_DDL);
      seed.close();
      const before = fs.readFileSync(dbPath);

      const r = runCliPrepare(scratch);
      assert.notEqual(r.status, 0, `stale-DB prepare must refuse:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      assert.match(r.stderr, new RegExp(TT_EXEC_DB_STALE), "stderr names the TT_EXEC_DB_STALE refusal");
      assert.deepEqual(fs.readFileSync(dbPath), before, "pre-seeded DB is byte-identical after the refusal");
      // No campaign was recorded for the refused prepare.
      const resultsDir = path.join(scratch, "results");
      const campaigns = fs.existsSync(resultsDir)
        ? fs.readdirSync(resultsDir).filter((n) => n.startsWith("storm-"))
        : [];
      assert.deepEqual(campaigns, [], "no campaign directory is created for a refused prepare");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
