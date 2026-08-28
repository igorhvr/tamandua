// Tier-1 self-test (E3.D US-011 / S10 proof): zero-token ledger proof for
// the python shim PATH convention.
//
// S10 demands a proof that the shim records a tt-python suite ledger row with
// exit_code 0 for a DIRECT `.venv/bin/pytest -q` invocation over a
// provisioned probe-case clone — with zero tokens. This test delivers it
// end-to-end over the product shim (`bin/tamandua-test` -> dist/suite/shim.js,
// untouched product code):
//
//   1. Provision the tt-python probe-case clone via `provisionWorkClone`
//      (the SAME adapter the controller uses for real cases; prebootstrapped
//      arming runs the fixture's committed `bootstrap` and creates `.venv`).
//   2. Invoke the shim DIRECTLY under the contained env:
//        bin/tamandua-test --repo <clone> --run <dry-run-id>
//          --step us011-dry-step -- '.venv/bin/pytest -q'
//      The shim hashes the committed tree, looks up the TSTX key, claims the
//      suite key, executes the explicit-path command, and records the suite
//      result through its control-plane client.
//   3. The shim's control-plane client talks to an in-process stand-in bound
//      to a RANDOM port (TAMANDUA_CONTROL_PORT). The stand-in mirrors the
//      product control-server's /suite/lookup|claim|record|release|event
//      contract verbatim and writes the recorded row into the contained
//      TSTX suite ledger (the `suite_results` table of the contained
//      tamandua.db under torture-test/var/home/.tamandua/) with the product's
//      exact INSERT. The test then asserts BOTH sides of the write: the HTTP
//      body the shim submitted (exit_code 0, cmd_display ".venv/bin/pytest -q",
//      the dry-run attribution) AND the suite_results row in the ledger.
//
// Zero tokens by construction: the only processes spawned are the shim's
// git plumbing and `/bin/sh -c '.venv/bin/pytest -q'` — no pi, no hermes, no
// daemon, no workflow launch, no token ledger activity. No fixed ports are
// bound (random ephemeral port only), and every scratch artifact lives under
// torture-test/var (gitignored).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const shimBin = path.join(repoRoot, "bin", "tamandua-test");
const distShim = path.join(repoRoot, "dist", "suite", "shim.js");
const containedHome = path.join(varRoot, "home");
const containedDb = path.join(containedHome, ".tamandua", "tamandua.db");

// ── In-process control-plane stand-in ─────────────────────────────────────
// Mirrors the product control-server's suite endpoints (src/server/
// control-server.ts) so the product shim's control-plane client records
// through its real path. /suite/record INSERTs into the contained suite
// ledger with the product's exact SQL and response shape.
const recordedBodies: Record<string, unknown>[] = [];
let db: DatabaseSync;
let server: http.Server;
let controlPort = 0;

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

before(async () => {
  // The contained suite ledger must exist (mirror of the product DDL in
  // src/db.ts — suite_results).
  fs.mkdirSync(path.dirname(containedDb), { recursive: true });
  db = new DatabaseSync(containedDb);
  db.exec(`
    CREATE TABLE IF NOT EXISTS suite_results (
      id INTEGER PRIMARY KEY,
      origin_repo TEXT NOT NULL,
      tree_hash TEXT NOT NULL,
      cmd_hash TEXT NOT NULL,
      cmd_display TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      log_tail TEXT,
      run_id TEXT,
      step_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_suite_results_lookup ON suite_results(origin_repo, tree_hash, cmd_hash, created_at)");

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (pathname === "/suite/lookup" && method === "GET") {
      respondJson(res, 200, { latest: null, passCount: 0, failCount: 0, flaky: false });
      return;
    }
    if (pathname === "/suite/duration-history" && method === "GET") {
      respondJson(res, 200, { durations: [] });
      return;
    }
    void readBody(req).then((body) => {
      if (pathname === "/suite/claim" && method === "POST") {
        respondJson(res, 200, { action: "run", claimedAt: new Date().toISOString() });
        return;
      }
      if (pathname === "/suite/release" && method === "POST") {
        respondJson(res, 200, {});
        return;
      }
      if (pathname === "/suite/event" && method === "POST") {
        respondJson(res, 200, {});
        return;
      }
      if (pathname === "/suite/record" && method === "POST") {
        // The product handleSuiteRecord contract (src/server/control-server.ts):
        // validate required fields, INSERT the row, answer {id, created_at}.
        const originRepo = typeof body.origin_repo === "string" ? body.origin_repo : "";
        const treeHash = typeof body.tree_hash === "string" ? body.tree_hash : "";
        const cmdHash = typeof body.cmd_hash === "string" ? body.cmd_hash : "";
        const cmdDisplay = typeof body.cmd_display === "string" ? body.cmd_display : "";
        const exitCode = typeof body.exit_code === "number" ? body.exit_code : null;
        const durationMs = typeof body.duration_ms === "number" ? body.duration_ms : null;
        const logTail = typeof body.log_tail === "string" ? body.log_tail : null;
        const runId = typeof body.run_id === "string" ? body.run_id : null;
        const stepId = typeof body.step_id === "string" ? body.step_id : null;
        if (!originRepo || !treeHash || !cmdHash || !cmdDisplay || exitCode === null || durationMs === null) {
          respondJson(res, 400, {
            error: "Missing required fields: origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms",
          });
          return;
        }
        recordedBodies.push(body);
        const createdAt = new Date().toISOString();
        const result = db.prepare(
          `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(originRepo, treeHash, cmdHash, cmdDisplay, exitCode, durationMs, logTail, runId, stepId, createdAt);
        respondJson(res, 200, { id: Number(result.lastInsertRowid), created_at: createdAt });
        return;
      }
      respondJson(res, 404, { error: `Not found: ${method} ${pathname}` });
    }).catch(() => {
      respondJson(res, 400, { error: "Invalid JSON body" });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "stand-in must bind");
  controlPort = address.port;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) db.close();
});

function shimEnv(): Record<string, string> {
  // The contained env for the shim child. Strip the node:test guard vars
  // (documented self-test pattern — the product guard would otherwise refuse
  // the control-plane request because this worktree lives under
  // ~/.tamandua/worktrees/). The shim itself must see the contained home so
  // its control-plane client resolves the contained state.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  env.HOME = containedHome;
  env.TAMANDUA_STATE_DIR = path.join(containedHome, ".tamandua");
  env.TAMANDUA_CONTROL_PORT = String(controlPort);
  return env;
}

interface ShimRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

// ASYNC spawn is mandatory here: the shim's control-plane client talks to the
// in-process stand-in HTTP server, and a synchronous spawnSync would block
// this process's event loop so the server could never answer — the shim would
// time out and degrade to passthrough. Async spawn keeps the server live
// while the child runs.
function runShim(args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<ShimRunResult> {
  return new Promise((resolve) => {
    const child = spawn(shimBin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ShimRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(result);
    };
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ status: null, signal: "SIGKILL", stdout, stderr, error: "shim timeout" });
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: Error) => {
      finish({ status: null, signal: null, stdout, stderr, error: String(err) });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ status: code, signal, stdout, stderr });
    });
  });
}

describe("US-011 python shim ledger proof (S10)", () => {
  it("the product shim records a tt-python suite ledger row with exit_code 0 for a direct .venv/bin/pytest invocation", async () => {
    assert.ok(fs.existsSync(distShim),
      "dist/suite/shim.js must exist — build the repo first (./build)");
    assert.ok(fs.existsSync(shimBin), "bin/tamandua-test must exist");

    const { provisionWorkClone } = await import("../bin/tt-fixture-provision.mjs");
    const caseId = `us011-shim-proof-${process.pid}-${Date.now()}`;
    let workClonePath: string | null = null;
    const dryRunId = `run-us011-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dryStepId = "us011-dry-step";

    try {
      // 1. Provision the tt-python probe-case clone (prebootstrapped arming:
      //    ./bootstrap creates .venv; junk + operator-notes planted untracked).
      const provisioned = provisionWorkClone({
        fixture: "tt-python",
        caseId,
        arming: "prebootstrapped",
      });
      assert.equal(provisioned.ok, true,
        `provisionWorkClone failed: ${JSON.stringify(provisioned.reason ?? provisioned)}`);
      assert.equal(provisioned.venvBootstrapped, true, "prebootstrapped arming must create the venv");
      workClonePath = provisioned.workClonePath;
      assert.ok(fs.existsSync(path.join(workClonePath, ".venv", "bin", "pytest")),
        "the provisioned clone must carry .venv/bin/pytest (explicit-path convention)");

      // 2. Direct shim invocation under the contained env.
      const res = await runShim(
        ["--repo", workClonePath, "--run", dryRunId, "--step", dryStepId, "--", ".venv/bin/pytest", "-q"],
        { cwd: workClonePath, env: shimEnv(), timeoutMs: 120_000 },
      );
      const stdout = res.stdout;
      const stderr = res.stderr;
      assert.equal(res.status, 0,
        `shim must exit 0 over the green fixture (status ${res.status}, signal ${res.signal}, error ${res.error ?? "none"}):\n${stdout}\n${stderr}`);
      assert.doesNotMatch(stderr, /passthrough mode/,
        "the shim must NOT degrade to passthrough — the TSTX path must be exercised");
      assert.match(stdout, /\d+ passed/,
        `pytest must report the green suite:\n${stdout}`);

      // 3. The shim must have submitted exactly one suite record with the
      //    explicit-path command and the dry-run attribution.
      assert.equal(recordedBodies.length, 1,
        `exactly one /suite/record submission expected, got ${recordedBodies.length}`);
      const record = recordedBodies[0];
      assert.equal(record.exit_code, 0, "the recorded exit_code must be 0");
      assert.equal(record.cmd_display, ".venv/bin/pytest -q",
        "the recorded cmd_display must be the explicit-path command verbatim");
      assert.equal(record.run_id, dryRunId, "the row must carry the dry-run id");
      assert.equal(record.step_id, dryStepId, "the row must carry the dry step id");
      assert.equal(typeof record.origin_repo, "string", "origin_repo must be present");
      assert.ok((record.origin_repo as string).length > 0, "origin_repo must be non-empty");
      assert.match(String(record.tree_hash), /^[0-9a-f]{40}$/,
        "the tree hash must be a full commit-tree hash");

      // 4. The contained TSTX suite ledger must hold the row (the stand-in
      //    writes with the product's exact INSERT; assert the ledger side).
      const rows = db.prepare(
        `SELECT origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, run_id, step_id
         FROM suite_results WHERE run_id = ?`,
      ).all(dryRunId) as Record<string, unknown>[];
      assert.equal(rows.length, 1,
        `exactly one ledger row for the dry-run id, got ${rows.length}`);
      const row = rows[0];
      assert.equal(row.exit_code, 0, "the ledger row must record exit_code 0");
      assert.equal(row.cmd_display, ".venv/bin/pytest -q",
        "the ledger row must name the explicit-path command");
      assert.equal(row.origin_repo, record.origin_repo,
        "the ledger row must carry the shim-submitted origin_repo");
      assert.equal(row.tree_hash, record.tree_hash,
        "the ledger row must carry the shim-submitted tree_hash");
      assert.ok(Number.isInteger(Number(row.duration_ms)) && Number(row.duration_ms) >= 0,
        "the ledger row must carry a non-negative duration");

      // Zero-token proof: the ONLY executed command was the explicit-path
      // pytest — no pi/hermes/tamandua workflow launch anywhere in the chain
      // (the shim's children are git plumbing and /bin/sh -c of the cmd).
      assert.equal(record.cmd_display, ".venv/bin/pytest -q",
        "the executed command is exactly the pytest invocation — no harness, no token spend");
      assert.doesNotMatch(stdout, /tamandua workflow run/,
        "no workflow launch may appear in the shim output");
    } finally {
      if (workClonePath !== null) {
        fs.rmSync(workClonePath, { recursive: true, force: true });
      }
      // Test-isolation (S26 US-006): remove the ledger row this proof
      // inserted. The stand-in control-plane wrote it into the SHARED
      // contained real DB (torture-test/var/home/.tamandua/tamandua.db), and
      // the S26 fresh-campaign suite-state gate (tt-daemon-up ensure-up
      // --fresh) refuses any non-empty suite_results at campaign start — a
      // leftover row would make every later fresh real-campaign preflight
      // (e.g. tt-controller-preflight.test.sh's AC3-real) fail closed. The
      // shim's run id is unique per invocation, so this only ever removes the
      // row this test created. db stays open until after(); it is a no-op if
      // the insert never happened.
      try {
        db.prepare("DELETE FROM suite_results WHERE run_id = ?").run(dryRunId);
      } catch {
        // Best-effort cleanup: if the DB is unavailable the proof has already
        // passed and the gate would have to be diagnosed separately.
      }
    }
  });
});
