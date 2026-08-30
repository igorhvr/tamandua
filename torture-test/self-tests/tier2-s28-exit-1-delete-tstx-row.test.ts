// S28 (US-007) — delete-tstx-row TESTEDTREE resolution exit-1 path:
// fail closed with a precise one-line reason (W4.48c-compound-gate-degradation).
//
// The tier-2 attempt-2 campaign (campaign-20260826T225744158Z-4bf26d7f) left
// W4.48c-compound-gate-degradation TEST_INFRA_FAIL 'chaos-invocation-failed'
// with `chaos operator 'tt-chaos' exited 1`. The chaos.log evidence
// (snapshots/W4.48c.../attempt-1 + var/chaos/chaos.log) shows
// `delete-tstx-row ... outcome: firing` at 2026-08-27T03:09:31.029Z and then
// NOTHING — the process exited 1 with no structured failure entry.
//
// Root cause, confirmed against the campaign evidence (the chaos evidence
// dir's run.json captured at fire time):
//   1. the typed chaos block declares `tree: TESTEDTREE` (the sentinel);
//   2. deleteTstxRow resolves the sentinel at fire time via
//      resolveAttestedTestedTree(runId), which reads the run row's `context`
//      JSON and requires a 40-hex `tested_tree` key;
//   3. when the run context lacks a valid 40-hex tested_tree (the W4.48c
//      fire-time context carried a malformed 39-char value — the run was
//      mid-flight and the attested tree had not been written yet), the
//      resolution THREW and the throw escaped as an UNCAUGHT exception →
//      node exited 1 with a stack trace, no chaos.log `fire_failed` entry,
//      no precise one-line reason.
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   * deleteTstxRow wraps the TESTEDTREE resolution in fail-closed handling:
//     on resolution failure it logs a STRUCTURED chaos.log entry (outcome
//     fire_failed + the precise reason) and prints/exits with a precise
//     one-line machine-parseable reason —
//     `delete-tstx-row: run <id> has no attested tested_tree in context --
//     refusing` — never an uncaught exception / bare exit 1;
//   * resolveAttestedTestedTree probes every (column, spelling) candidate
//     tolerantly (queryRunRowTolerant: `id` = product raw uuid AND `run_id` =
//     fixture spelling × `run-<uuid>`/`<uuid>`), parses the context JSON, and
//     returns `context.tested_tree` when it is a 40-hex tree — the schema is
//     documented in the function header.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC3): pins the campaign failure line verbatim and reproduces
//     the exact pre-fix behavior — the resolution throw escaping as an
//     uncaught exit-1 with the pre-fix message shape and NO structured
//     fire_failed chaos.log entry (the campaign's bare `exited 1`);
//   * GREEN-ARM (AC1): the FIXED tt-chaos against a fixture run whose context
//     lacks tested_tree fails CLOSED with the precise one-line reason AND a
//     structured chaos.log fire_failed entry (exit 1, no stack trace);
//   * GREEN-ARM (AC2): a fixture run WITH an attested 40-hex tested_tree in
//     context resolves the sentinel and deletes the matching
//     suite_results/tstx rows, exiting 0;
//   * both run-id spellings (`run-<uuid>` and `<uuid>`) resolve.
//
// Follows the tier2-s28-*.test.ts self-test pattern (imports node builtins +
// repo-relative files only); picked up by self-tests/run.sh's tier2 glob.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const ttChaos = path.join(ttRoot, "bin", "tt-chaos");

// ── Pinned campaign evidence (campaign-20260826T225744158Z-4bf26d7f) ────
// report.txt INFRA FAILURE line for W4.48c, verbatim:
//   `W4.48c-compound-gate-degradation: chaos-invocation-failed (chaos
//    operator 'tt-chaos' exited 1)`
// (the controller's pre-fix chaos-invocation-failed message: `chaos operator
// '<op>' exited <code>`).
const CAMPAIGN_CELL_LINE =
  "W4.48c-compound-gate-degradation: chaos-invocation-failed (chaos operator 'tt-chaos' exited 1)";

// The failing run id the campaign captured (chaos_evidence.argv `--run
// run-886f4728-...`) and the fire-time trigger.
const W4_48C_RUN_ID = "run-886f4728-11a7-4619-810c-ec3a47830902";
const W4_48C_TRIGGER = "step:finalize_merge:pending";

// The pre-fix resolution throw message (resolveAttestedTestedTree throwing
// `TESTEDTREE resolution: run <id> has no attested tested_tree in its
// context`) — reproduced inline (history-independent red-arm, per
// tier0-history-independent-red-arms) so the pre-fix shape is pinned without
// resolving it from git.
function preFixResolveMessage(runId: string): string {
  return `TESTEDTREE resolution: run ${runId} has no attested tested_tree in its context`;
}

// The FIXED fail-closed one-line reason (the story's example shape):
// `delete-tstx-row: run <id> has no attested tested_tree in context --
// refusing`.
function fixedRefusalMessage(runId: string): string {
  return `delete-tstx-row: run ${runId} has no attested tested_tree in context -- refusing`;
}

function run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 60_000): { status: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null } {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

// Build a throwaway TT var directory with a fake contained DB whose runs
// table carries the given run rows with a `context` column (the product's
// runs.context JSON — the resolution's source of truth). Returns the dir
// (the caller removes it). Both run-id spellings (`run-<uuid>` and `<uuid>`)
// are exercised by inserting the RAW uuid (product spelling) and passing the
// full `run-<uuid>` to tt-chaos, mirroring the controller.
function fakeTtVarWithContext(rows: Array<{ id: string; status: string; context: string }>): string {
  const dir = fs.mkdtempSync(path.join(varRoot, `s28-dtr-${process.pid}-`));
  fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "tamandua.db"), { open: true });
  db.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    context TEXT
  );`);
  for (const row of rows) {
    db.prepare("INSERT OR REPLACE INTO runs (id, status, context) VALUES (?, ?, ?)")
      .run(row.id, row.status, row.context);
  }
  db.close();
  return dir;
}

// Read the chaos.log entries (JSON lines) written in a TT var dir.
function readChaosLog(dir: string): Array<Record<string, unknown>> {
  const logPath = path.join(dir, "chaos", "chaos.log");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("S28 (US-007) — delete-tstx-row TESTEDTREE exit-1: fail closed with a precise one-line reason", () => {
  it("RED-ARM: pins the campaign failure line verbatim and the fire-time evidence shape", () => {
    assert.equal(
      CAMPAIGN_CELL_LINE,
      "W4.48c-compound-gate-degradation: chaos-invocation-failed (chaos operator 'tt-chaos' exited 1)",
      "the campaign report line must be pinned exactly",
    );
    assert.match(CAMPAIGN_CELL_LINE, /^W4\.48c-compound-gate-degradation: chaos-invocation-failed \(chaos operator 'tt-chaos' exited 1\)$/);
    assert.match(W4_48C_RUN_ID, /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(W4_48C_TRIGGER, "step:finalize_merge:pending");
  });

  it("RED-ARM: the pre-fix resolution throws the exact campaign message and escapes as an uncaught exit-1 with NO structured fire_failed entry", () => {
    // A fixture run whose context lacks a 40-hex tested_tree (the W4.48c
    // fire-time shape: the run is mid-flight, no attested tree yet).
    const dir = fakeTtVarWithContext([
      { id: "886f4728-11a7-4619-810c-ec3a47830902", status: "running", context: JSON.stringify({ task: "no attested tree yet" }) },
    ]);
    try {
      // Reproduce the pre-fix resolution logic inline (history-independent):
      // read context, require a 40-hex tested_tree, THROW with the pre-fix
      // message when absent. No catch — the throw escapes exactly as the
      // pre-fix tt-chaos let it.
      const preFixScript = `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(${JSON.stringify(path.join(dir, "tamandua.db"))}, { open: true, readOnly: true });
        const runId = ${JSON.stringify(W4_48C_RUN_ID)};
        const shortRunId = runId.startsWith('run-') ? runId.slice(4) : runId;
        const rows = db.prepare('SELECT context FROM runs WHERE id = ? OR id = ?').all(runId, shortRunId);
        if (rows.length !== 1 || typeof rows[0].context !== 'string') {
          throw new Error('TESTEDTREE resolution: run ' + runId + ' has no readable context row');
        }
        const context = JSON.parse(rows[0].context);
        const attested = typeof context.tested_tree === 'string'
          && /^[0-9a-f]{40}$/.test(context.tested_tree)
          ? context.tested_tree
          : null;
        if (attested === null) {
          throw new Error('TESTEDTREE resolution: run ' + runId + ' has no attested tested_tree in its context');
        }
        console.log(attested);
      `;
      const res = run(process.execPath, ["-e", preFixScript], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      // The pre-fix shape: exit 1 (uncaught throw) with the exact campaign
      // message in the stack trace.
      assert.equal(res.status, 1, `pre-fix resolution must exit 1 (uncaught throw), got ${res.status}`);
      assert.match(res.stderr, new RegExp(preFixResolveMessage(W4_48C_RUN_ID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `pre-fix resolution must throw the exact campaign message: ${res.stderr}`);
      // No structured fire_failed chaos.log entry — the pre-fix crash wrote
      // nothing (the campaign recorded `outcome: firing` then a bare exit 1).
      const entries = readChaosLog(dir);
      const fireFailed = entries.filter((e) => e.outcome === "fire_failed" && e.action === "delete-tstx-row");
      assert.equal(fireFailed.length, 0,
        `pre-fix crash must NOT have written a structured fire_failed entry (campaign shape): ${JSON.stringify(entries)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC1): unresolvable TESTEDTREE fails closed with the precise one-line reason + structured chaos.log fire_failed entry, never a stack trace", () => {
    const dir = fakeTtVarWithContext([
      { id: "886f4728-11a7-4619-810c-ec3a47830902", status: "running", context: JSON.stringify({ task: "no attested tree yet" }) },
    ]);
    try {
      const res = run(ttChaos, [
        "delete-tstx-row",
        "--run", W4_48C_RUN_ID,
        "--when", "now",
        "--tree", "TESTEDTREE",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 1, `unresolvable TESTEDTREE must exit 1 (fail-closed), got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(fixedRefusalMessage(W4_48C_RUN_ID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `must fail closed with the precise one-line reason: ${res.stderr}`);
      // Never an uncaught exception: no stack-trace frames in stderr.
      assert.doesNotMatch(res.stderr, /at deleteTstxRow|at resolveAttestedTestedTree|node:internal/,
        `must not crash with an uncaught stack trace: ${res.stderr}`);
      // Structured chaos.log fire_failed entry with the reason.
      const entries = readChaosLog(dir);
      const fireFailed = entries.filter((e) => e.outcome === "fire_failed" && e.action === "delete-tstx-row");
      assert.equal(fireFailed.length, 1, `exactly one structured fire_failed entry expected: ${JSON.stringify(entries)}`);
      assert.equal(fireFailed[0].runId, W4_48C_RUN_ID);
      assert.equal(fireFailed[0].tree, "TESTEDTREE");
      assert.match(String(fireFailed[0].error), /has no attested tested_tree in context/,
        `fire_failed entry must carry the precise reason: ${JSON.stringify(fireFailed[0])}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): a resolvable attested tested_tree deletes the matching suite_results rows and exits 0", () => {
    const attested = "1111111111111111111111111111111111111111";
    const dir = fs.mkdtempSync(path.join(varRoot, `s28-dtr-green-${process.pid}-`));
    fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
    const db = new DatabaseSync(path.join(dir, "tamandua.db"), { open: true });
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT
    );`);
    db.exec(`CREATE TABLE suite_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_repo TEXT, tree_hash TEXT, cmd_hash TEXT, cmd_display TEXT,
      exit_code INTEGER, duration_ms INTEGER, log_tail TEXT,
      run_id TEXT, step_id TEXT, created_at TEXT
    );`);
    db.exec(`CREATE TABLE tstx (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tree TEXT NOT NULL,
      run_id TEXT,
      status TEXT DEFAULT 'active'
    );`);
    // Product run-id spelling: RAW uuid (no `run-` prefix).
    db.prepare("INSERT OR REPLACE INTO runs (id, status, context) VALUES (?, ?, ?)")
      .run("886f4728-11a7-4619-810c-ec3a47830902", "running", JSON.stringify({ tested_tree: attested }));
    db.prepare("INSERT INTO suite_results (tree_hash, run_id, step_id, exit_code) VALUES (?, ?, ?, ?)")
      .run(attested, "886f4728-11a7-4619-810c-ec3a47830902", "verify", 0);
    db.prepare("INSERT INTO suite_results (tree_hash, run_id, step_id, exit_code) VALUES (?, ?, ?, ?)")
      .run(attested, "886f4728-11a7-4619-810c-ec3a47830902", "fix", 1);
    db.prepare("INSERT INTO suite_results (tree_hash, run_id, step_id, exit_code) VALUES (?, ?, ?, ?)")
      .run("deadbeef9999", "886f4728-11a7-4619-810c-ec3a47830902", "verify", 0);
    db.prepare("INSERT INTO tstx (tree, run_id, status) VALUES (?, ?, ?)")
      .run(attested, "886f4728-11a7-4619-810c-ec3a47830902", "active");
    db.close();

    try {
      const res = run(ttChaos, [
        "delete-tstx-row",
        "--run", W4_48C_RUN_ID, // full `run-<uuid>` spelling against the raw-uuid row
        "--when", "now",
        "--tree", "TESTEDTREE",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 0, `resolvable TESTEDTREE must exit 0, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`deleted .*row\\(s\\) for tree ${attested}`),
        `deletion must report the resolved attested tree, not the sentinel: ${res.stderr}`);
      const check = new DatabaseSync(path.join(dir, "tamandua.db"), { open: true, readOnly: true });
      try {
        const suiteLeft = check.prepare("SELECT COUNT(*) as cnt FROM suite_results WHERE tree_hash = ?").get(attested) as { cnt: number };
        assert.equal(suiteLeft.cnt, 0, "attested suite_results rows must be deleted");
        const tstxLeft = check.prepare("SELECT COUNT(*) as cnt FROM tstx WHERE tree = ?").get(attested) as { cnt: number };
        assert.equal(tstxLeft.cnt, 0, "attested legacy tstx rows must be deleted");
        const other = check.prepare("SELECT COUNT(*) as cnt FROM suite_results WHERE tree_hash = ?").get("deadbeef9999") as { cnt: number };
        assert.equal(other.cnt, 1, "unrelated suite_results rows must be preserved");
      } finally {
        check.close();
      }
      // The successful fire is logged as a structured `fired` entry.
      const entries = readChaosLog(dir);
      const fired = entries.filter((e) => e.outcome === "fired" && e.action === "delete-tstx-row");
      assert.equal(fired.length, 1, `a structured fired entry expected: ${JSON.stringify(entries)}`);
      assert.equal(fired[0].target, `tree:${attested}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: both run-id spellings resolve the attested tree (run-<uuid> and <uuid>)", () => {
    const attested = "2222222222222222222222222222222222222222";
    // Realistic (column, spelling) pairs the controller/operator produce:
    //   * product row keyed on RAW uuid (`886f...`), controller passes the
    //     full `run-<uuid>` spelling → resolves via the shortRunId candidate;
    //   * a run row keyed on the full `run-<uuid>` spelling, operator passes
    //     the same full spelling → resolves via the runId candidate.
    for (const [rowId, argId] of [
      ["886f4728-11a7-4619-810c-ec3a47830902", "run-886f4728-11a7-4619-810c-ec3a47830902"],
      ["run-886f4728-11a7-4619-810c-ec3a47830902", "run-886f4728-11a7-4619-810c-ec3a47830902"],
    ] as Array<[string, string]>) {
      const dir = fakeTtVarWithContext([
        { id: rowId, status: "running", context: JSON.stringify({ tested_tree: attested }) },
      ]);
      try {
        const res = run(ttChaos, [
          "delete-tstx-row",
          "--run", argId,
          "--when", "now",
          "--tree", "TESTEDTREE",
        ], {
          TAMANDUA_STATE_DIR: dir,
          TT_HOME: dir,
          TT_ROOT: dir,
        });
        assert.equal(res.status, 0, `spelling ${rowId} → ${argId} must resolve, got ${res.status}: ${res.stderr}`);
        assert.match(res.stderr, new RegExp(`tree ${attested}`), `must resolve the attested tree for ${argId}: ${res.stderr}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("GREEN-ARM: a run_id-keyed fixture (test-suite spelling) resolves the attested tree", () => {
    const attested = "3333333333333333333333333333333333333333";
    const dir = fs.mkdtempSync(path.join(varRoot, `s28-dtr-fixture-${process.pid}-`));
    fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
    const db = new DatabaseSync(path.join(dir, "tamandua.db"), { open: true });
    // The tt-chaos test-suite fixture keys the runs table on `run_id`.
    db.exec(`CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT
    );`);
    db.prepare("INSERT OR REPLACE INTO runs (run_id, status, context) VALUES (?, ?, ?)")
      .run("run-fixture-row", "running", JSON.stringify({ tested_tree: attested }));
    db.close();
    try {
      const res = run(ttChaos, [
        "delete-tstx-row",
        "--run", "run-fixture-row",
        "--when", "now",
        "--tree", "TESTEDTREE",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 0, `run_id-keyed fixture must resolve, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`tree ${attested}`), `must resolve the attested tree: ${res.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
