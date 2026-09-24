// tier0-core-recording-entrypoint.test.ts — CORE-CELLS US-006 (original CORE
// US-008): hermetic entrypoint/membership/exit-propagation gate.
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.4. This file is the DESIGNATED
// hermetic gate for the zero-token frequent-gate entrypoint
// (torture-test/bin/core-recording-cells.mjs + the pure membership module
// torture-test/bin/core-recording-cells-membership.mjs). It proves, WITHOUT
// executing the real recorded cells (they run as the entrypoint's own actual
// full run, retained separately as implementation evidence):
//
//   1. `--help` is side-effect-free: exit 0, prints usage, zero state files /
//      processes / ports (verified hermetically under a private HOME/state/
//      DB/TMPDIR with the test-isolation guard).
//   2. Complete registered membership: all required foundational producers
//      (contract, capture/sanitize, replay-adapter conformance,
//      replay-executor, motor-gate) and recorded cells (TCMD x4, BRUN x2
//      corridors, RVOC/RCNT, PHNT x2 accounts), with the recorded-cell
//      case ids / provenance run ids cross-checked against the shipped
//      sanitized asset modules (no drift between the registry and the
//      recorded assets).
//   3. `--membership` dry run on the real registry exits 0 on the clean
//      committed tree, reports expected vs registered accounting and writes
//      nothing.
//   4. Missing / red / interrupted cells NEVER yield a green exit: proven by
//      driving the entrypoint's TEST-ONLY manifest seam
//      (TT_CORE_CELLS_MANIFEST) with synthetic fixture producers — a missing
//      producer, a failing producer, an interrupting SIGINT mid-producer and
//      a fully-green set — asserting accounting, per-cell evidence files and
//      non-zero / zero exits respectively. An invalid override manifest is
//      refused BEFORE any evidence-root effect.
//
// Isolation: every spawned instance gets a private HOME /
// TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH / TMPDIR, TAMANDUA_TEST_GUARD=1 and a
// randomly reserved control port (no listener is ever opened by this file —
// the hermetic gate starts no daemons and binds nothing). Fixture files and
// instance state are RETAINED under this file's fresh evidence root under
// torture-test/var/review-logs/ (git-ignored; nothing is removed).
//
// Runs as its own `node --test torture-test/self-tests/tier0-core-recording-
// entrypoint.test.ts` and is auto-discovered by self-tests/run.sh's tier0
// glob (not heavy; no daemon; no live state; no origin/live-runtime touch).

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const BIN_DIR = path.join(repoRoot, "torture-test", "bin");
const ENTRYPOINT_PATH = path.join(BIN_DIR, "core-recording-cells.mjs");
const MEMBERSHIP_PATH = path.join(BIN_DIR, "core-recording-cells-membership.mjs");
const REVIEW_LOGS = path.join(repoRoot, "torture-test", "var", "review-logs");

assert.ok(fs.existsSync(ENTRYPOINT_PATH), `entrypoint missing: ${ENTRYPOINT_PATH} — run from the repo root`);
assert.ok(fs.existsSync(MEMBERSHIP_PATH), `membership module missing: ${MEMBERSHIP_PATH} — run from the repo root`);

// One fresh retained evidence root for the whole file run.
const EVIDENCE_ROOT = (() => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(REVIEW_LOGS, `core-cells-entrypoint-${stamp}Z`);
  fs.mkdirSync(root, { recursive: true });
  return root;
})();

// ── lazy module loads (pure .mjs data modules + entrypoint source check) ─
const moduleCache = new Map();
function load(repoRelative: string): Promise<any> {
  const url = pathToFileURL(path.join(repoRoot, repoRelative)).href;
  if (!moduleCache.has(url)) moduleCache.set(url, import(url));
  return moduleCache.get(url);
}
const loadMembership = () => load("torture-test/bin/core-recording-cells-membership.mjs");
const loadTcmdAssets = () => load("torture-test/bin/core-recording-tcmd-cell-assets.mjs");
const loadBrunAssets = () => load("torture-test/bin/core-recording-brun-cell-assets.mjs");
const loadRvocRcntAssets = () => load("torture-test/bin/core-recording-rvoc-rcnt-cell-assets.mjs");
const loadPhntAssets = () => load("torture-test/bin/core-recording-phnt-cell-assets.mjs");

// ── isolation helpers ────────────────────────────────────────────────

function reserveRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address() as net.AddressInfo;
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}

function freshInstanceDir(label: string): string {
  const dir = path.join(EVIDENCE_ROOT, "instances", label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function buildInstanceEnv(label: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const base = freshInstanceDir(label);
  const home = path.join(base, "home");
  const tmp = path.join(base, "tmp");
  const state = path.join(base, "state");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const port = String(await reserveRandomPort());
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmp,
    TAMANDUA_STATE_DIR: state,
    TAMANDUA_DB_PATH: path.join(state, "tamandua.db"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_CONTROL_PORT: port,
  };
  for (const k of ["LANG", "LC_ALL", "LC_CTYPE", "TERM"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  }
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(dir, abs));
    }
  };
  walk(dir);
  return out.sort();
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runEntrypoint(args: string[], opts: { label: string; env?: Record<string, string>; cwd?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    const started = buildInstanceEnv(opts.label, opts.env ?? {});
    started.then((env) => {
      child = spawn(process.execPath, [ENTRYPOINT_PATH, ...args], {
        cwd: opts.cwd ?? repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    }).catch(reject);
  });
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function readSummary(evidenceDir: string): any {
  const file = path.join(evidenceDir, "cells-summary.json");
  assert.ok(fs.existsSync(file), `expected cells-summary.json at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function syntheticManifest(producers: any[]): string {
  const manifest = { version: 1, producers };
  const file = path.join(EVIDENCE_ROOT, `manifest-${producers.map((p) => p.id).join("-")}-${Date.now()}.json`);
  writeJsonFile(file, manifest);
  return file;
}

function fixtureProducer(id: string, title: string, file: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    kind: "node-test",
    scope: "recorded",
    story: "fixture",
    title,
    file,
    cells: [{ id: `cell-${id}`, provenanceRunId: null, note: "synthetic fixture cell" }],
    ...extra,
  };
}

// ── tests ────────────────────────────────────────────────────────────

describe("CORE-CELLS US-006 — zero-token frequent-gate entrypoint (hermetic)", () => {
  it("`--help` exits 0, prints usage and has zero side effects (no state files, no processes, no ports)", async () => {
    const label = "help-side-effect-free";
    const base = freshInstanceDir(label);
    const before = listFilesRecursive(base);
    const res = await runEntrypoint(["--help"], { label, cwd: base });
    assert.equal(res.code, 0, `--help must exit 0 (stderr: ${res.stderr})`);
    assert.ok(res.stdout.includes("core-recording-cells.mjs"), "--help must print the command name");
    assert.ok(res.stdout.includes("--membership"), "--help must document --membership");
    assert.ok(res.stdout.includes("EXIT CODES"), "--help must document exit codes");
    const after = listFilesRecursive(base);
    assert.deepEqual(after, before, "--help must not create any state file anywhere under the instance (HOME/state/TMPDIR/cwd)");
    // No DB/state artifact was created in the private state dir.
    const stateDb = path.join(base, "state", "tamandua.db");
    assert.equal(fs.existsSync(stateDb), false, "--help must not open/create a DB");
    // Structural zero-process/zero-port proof: --help returned before any
    // spawn/installInterruptHandlers/net code path (see entrypoint main():
    // help prints USAGE and exits immediately), and the single spawned
    // process (this child) exited by itself — no kill needed, nothing left
    // behind to reap.
    assert.equal(res.signal, null, "--help child must exit normally, not by signal");
  });

  it("registered membership is complete: 9 producers (5 foundational + 4 recorded), recorded cells TCMD x4 / BRUN x2 / RVOC+RCNT / PHNT x2, provenance cross-checked against the shipped assets", async () => {
    const mem = await loadMembership();
    const membership = mem.CORE_CELLS_MEMBERSHIP;
    assert.equal(mem.CORE_CELLS_ENTRYPOINT_VERSION, 1);
    assert.equal(mem.expectedProducerCount(), 9, "9 registered producers");
    assert.equal(mem.expectedRecordedCellCount(), 10, "10 recorded sub-cells");
    assert.equal(mem.expectedProducerCount(membership), membership.producers.length);

    const ids = membership.producers.map((p: any) => p.id);
    for (const required of [
      "contract",
      "capture-sanitize",
      "replay-adapter-conformance",
      "replay-executor",
      "motor-gate",
      "tcmd-cells",
      "brun-cell",
      "rvoc-rcnt-cells",
      "phnt-cells",
    ]) {
      assert.ok(ids.includes(required), `required producer ${required} must be registered`);
    }

    const byId = (id: string) => {
      const p = membership.producers.find((x: any) => x.id === id);
      assert.ok(p, `producer ${id} must exist`);
      return p;
    };
    const foundational = membership.producers.filter((p: any) => p.scope === "foundational");
    const recorded = membership.producers.filter((p: any) => p.scope === "recorded");
    assert.equal(foundational.length, 5);
    assert.equal(recorded.length, 4);
    for (const p of membership.producers) {
      assert.ok(["node-test", "gate"].includes(p.kind), `producer ${p.id} kind`);
      assert.ok(p.file.length > 0, `producer ${p.id} file`);
      const abs = path.join(repoRoot, p.file);
      assert.ok(fs.existsSync(abs), `producer file must exist on the committed tree: ${p.file}`);
    }

    // recorded sub-cell counts per producer
    assert.equal(byId("tcmd-cells").cells.length, 4);
    assert.equal(byId("brun-cell").cells.length, 2);
    assert.equal(byId("rvoc-rcnt-cells").cells.length, 2);
    assert.equal(byId("phnt-cells").cells.length, 2);

    // provenance integrity vs the shipped sanitized assets
    const tcmd = await loadTcmdAssets();
    const tcmdSpecimens = tcmd.loadTcmdSpecimens();
    const tcmdCells = byId("tcmd-cells").cells;
    assert.deepEqual(
      tcmdCells.map((c: any) => ({ id: c.id, provenanceRunId: c.provenanceRunId })),
      tcmdSpecimens.map((s: any) => ({ id: s.caseId, provenanceRunId: s.historical.runId })),
      "TCMD membership cells must equal the four shipped specimens (caseId/runId)",
    );

    const brun = await loadBrunAssets();
    const brunCells = byId("brun-cell").cells;
    assert.equal(brunCells[0].id, brun.loadBrunAsset().caseId);
    assert.equal(brunCells[0].provenanceRunId, brun.loadBrunAsset().sourceIdentity.runId);
    assert.equal(brunCells[1].provenanceRunId, null, "BRUN corridor (b) has no single historical run (current K6/N20 behavior)");

    const rvocRcnt = await loadRvocRcntAssets();
    const rvocRcntCells = byId("rvoc-rcnt-cells").cells;
    assert.equal(rvocRcntCells[0].id, rvocRcnt.loadRvocAsset().caseId);
    assert.equal(rvocRcntCells[0].provenanceRunId, rvocRcnt.loadRvocAsset().sourceIdentity.runId);
    assert.equal(rvocRcntCells[1].id, rvocRcnt.loadRcntAsset().caseId);
    assert.equal(rvocRcntCells[1].provenanceRunId, rvocRcnt.loadRcntAsset().sourceIdentity.runId);

    const phnt = await loadPhntAssets();
    const phntCells = byId("phnt-cells").cells;
    assert.equal(phntCells[0].id, phnt.loadPhntPythonAsset().caseId);
    assert.equal(phntCells[0].provenanceRunId, phnt.loadPhntPythonAsset().sourceIdentity.runId);
    assert.equal(phntCells[1].id, phnt.loadPhntHermesAsset().caseId);
    assert.equal(phntCells[1].provenanceRunId, phnt.loadPhntHermesAsset().sourceIdentity.runId);

    // recorded cell ids are order-stable and unique
    const allCellIds = mem.recordedCellIds();
    assert.equal(allCellIds.length, 10);
    assert.equal(new Set(allCellIds).size, 10, "recorded cell ids must be unique");
    assert.deepEqual(mem.recordedProducerIds(), ["tcmd-cells", "brun-cell", "rvoc-rcnt-cells", "phnt-cells"]);
  });

  it("`--membership` dry run exits 0 on the committed tree with expected accounting and writes nothing", async () => {
    const label = "membership-dry-run";
    const base = freshInstanceDir(label);
    const before = listFilesRecursive(base);
    const res = await runEntrypoint(["--membership"], { label, cwd: base });
    assert.equal(res.code, 0, `--membership must exit 0 on a committed tree (stderr: ${res.stderr})`);
    assert.ok(res.stdout.includes("registered producers: 9"), "--membership must report 9 registered producers");
    assert.ok(res.stdout.includes("recorded sub-cells: 10"), "--membership must report 10 recorded sub-cells");
    for (const id of ["contract", "capture-sanitize", "replay-adapter-conformance", "replay-executor", "motor-gate", "tcmd-cells", "brun-cell", "rvoc-rcnt-cells", "phnt-cells"]) {
      assert.ok(res.stdout.includes(id), `--membership must list producer ${id}`);
    }
    for (const cell of ["W4.48c-compound-gate-degradation", "W4.18-flaky-alternator", "W4.17-b-red-baseline-refuse", "W4.09-hermes-equivalence", "W4.dsh-do-now-missing-credential", "W4.10-kill-daemon", "W4.10-restart-recovery", "W3.01-bfmw-pi-python", "W3.03-bfmw-hermes-ts"]) {
      assert.ok(res.stdout.includes(cell), `--membership must list recorded cell ${cell}`);
    }
    assert.ok(!res.stdout.includes("MISSING"), "--membership on the committed tree must show every producer present");
    const after = listFilesRecursive(base);
    assert.deepEqual(after, before, "--membership must not create any file (read-only mode)");
  });

  it("a missing producer never yields a green result: exit non-zero with missing accounting and zero executed", async () => {
    const missingFile = path.join(EVIDENCE_ROOT, "does-not-exist.test.mjs");
    const manifestFile = syntheticManifest([fixtureProducer("fixture-missing", "missing fixture", missingFile)]);
    const evidenceDir = path.join(EVIDENCE_ROOT, "run-missing", `r${Date.now()}`);
    const res = await runEntrypoint(["--evidence-dir", evidenceDir], {
      label: "missing-producer",
      env: { TT_CORE_CELLS_MANIFEST: manifestFile },
    });
    assert.notEqual(res.code, 0, "missing producer must yield a non-zero exit");
    const summary = readSummary(evidenceDir);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.accounting.expectedProducers, 1);
    assert.equal(summary.accounting.missing, 1);
    assert.equal(summary.accounting.executedProducers, 0, "a missing producer is never executed");
    assert.equal(summary.accounting.green, 0);
    assert.equal(summary.producers[0].status, "missing");
    assert.ok(summary.producers[0].error.includes("not found"), "missing producer must carry the not-found error");
    assert.equal(summary.recordedCellsAccounting.green, 0, "a missing producer's recorded cells are never green");
  });

  it("a red producer never yields a green result: exit non-zero with red accounting", async () => {
    const redFile = path.join(EVIDENCE_ROOT, "fixtures", "red.test.mjs");
    fs.mkdirSync(path.dirname(redFile), { recursive: true });
    fs.writeFileSync(redFile, 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n', "utf8");
    const manifestFile = syntheticManifest([fixtureProducer("fixture-red", "red fixture", redFile)]);
    const evidenceDir = path.join(EVIDENCE_ROOT, "run-red", `r${Date.now()}`);
    const res = await runEntrypoint(["--evidence-dir", evidenceDir], {
      label: "red-producer",
      env: { TT_CORE_CELLS_MANIFEST: manifestFile },
    });
    assert.notEqual(res.code, 0, "red producer must yield a non-zero exit");
    const summary = readSummary(evidenceDir);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.accounting.red, 1);
    assert.equal(summary.accounting.green, 0);
    assert.equal(summary.producers[0].status, "red");
    assert.equal(summary.producers[0].exitCode, 1);
    assert.equal(summary.producers[0].tap.fail, 1, "TAP evidence must show the failing test");
    assert.equal(summary.recordedCellsAccounting.green, 0, "a red producer's recorded cells are never green");
    // full producer log retained
    const logFile = path.join(evidenceDir, summary.producers[0].logFile);
    assert.ok(fs.existsSync(logFile), "full producer log must be retained for a red cell");
    assert.ok(fs.readFileSync(logFile, "utf8").includes("fail"), "red producer log must contain the failure");
  });

  it("all-green synthetic producers exit 0 with expected==executed accounting and per-cell evidence (argv/UTC/timing/log)", async () => {
    const greenFile = path.join(EVIDENCE_ROOT, "fixtures", "green.test.mjs");
    fs.mkdirSync(path.dirname(greenFile), { recursive: true });
    fs.writeFileSync(greenFile, 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("green", () => { assert.equal(1, 1); });\ntest("green2", async () => {});\n', "utf8");
    const manifestFile = syntheticManifest([
      fixtureProducer("fixture-green", "green fixture", greenFile),
      fixtureProducer("fixture-green2", "green fixture 2", greenFile),
    ]);
    const evidenceDir = path.join(EVIDENCE_ROOT, "run-green", `r${Date.now()}`);
    const res = await runEntrypoint(["--evidence-dir", evidenceDir], {
      label: "green-producers",
      env: { TT_CORE_CELLS_MANIFEST: manifestFile },
    });
    assert.equal(res.code, 0, `all-green run must exit 0 (stderr: ${res.stderr})`);
    const summary = readSummary(evidenceDir);
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.accounting.expectedProducers, 2);
    assert.equal(summary.accounting.executedProducers, 2);
    assert.equal(summary.accounting.green, 2);
    assert.equal(summary.accounting.red, 0);
    assert.equal(summary.accounting.missing, 0);
    assert.equal(summary.accounting.interrupted, 0);
    assert.equal(summary.recordedCellsAccounting.green, 2);
    for (const producer of summary.producers) {
      assert.equal(producer.status, "green");
      assert.equal(producer.exitCode, 0);
      assert.ok(fs.existsSync(producer.file), "per-cell evidence must carry the exact source path");
      assert.ok(producer.argv.length >= 3 && producer.argv[0].includes("node"), "per-cell evidence must carry argv");
      assert.ok(producer.host.length > 0, "per-cell evidence must carry host");
      assert.ok(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(producer.startUtc), "per-cell evidence must carry UTC-Z start");
      assert.ok(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(producer.endUtc), "per-cell evidence must carry UTC-Z end");
      assert.ok(typeof producer.elapsedMs === "number" && producer.elapsedMs >= 0, "per-cell evidence must carry elapsed ms");
      assert.equal(producer.tap.pass, 2, "TAP evidence must count the green tests");
      const logFile = path.join(evidenceDir, producer.logFile);
      assert.ok(fs.existsSync(logFile), "full producer log must be retained");
      const resultFile = path.join(evidenceDir, producer.resultFile);
      assert.ok(fs.existsSync(resultFile), "per-cell result JSON must be retained");
    }
    assert.ok(typeof summary.elapsedMs === "number" && summary.elapsedMs >= 0, "summary must carry measured elapsed ms");
    assert.ok(typeof summary.timingUtcStart === "string" && typeof summary.timingUtcEnd === "string");
  });

  it("an interruption (SIGINT) mid-producer propagates to a non-zero exit with interrupted accounting and exact-child cleanup", async () => {
    const hangFile = path.join(EVIDENCE_ROOT, "fixtures", "hang.test.mjs");
    fs.mkdirSync(path.dirname(hangFile), { recursive: true });
    fs.writeFileSync(hangFile, 'import { test } from "node:test";\ntest("hang", async () => { await new Promise((r) => setTimeout(r, 600000)); });\n', "utf8");
    const manifestFile = syntheticManifest([fixtureProducer("fixture-hang", "hang fixture", hangFile)]);
    const evidenceDir = path.join(EVIDENCE_ROOT, "run-interrupt", `r${Date.now()}`);

    const env = await buildInstanceEnv("interrupt-producer", { TT_CORE_CELLS_MANIFEST: manifestFile });
    const child = spawn(process.execPath, [ENTRYPOINT_PATH, "--evidence-dir", evidenceDir], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    // Wait until the hang producer has actually launched (its log file is
    // created at spawn), then interrupt the entrypoint with SIGINT.
    const producerLog = path.join(evidenceDir, "cells", "fixture-hang", "producer.log");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(producerLog)) {
      if (Date.now() > deadline) throw new Error(`hang producer never started (${stderr})`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150)); // let the spawn settle
    child.kill("SIGINT");

    const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    assert.notEqual(close.code, 0, `interrupted run must exit non-zero (code=${close.code})`);
    assert.equal(close.code, 130, "SIGINT interruption should map to exit 130");

    const summary = readSummary(evidenceDir);
    assert.equal(summary.exitCode, 130);
    assert.equal(summary.interrupted.signal, "SIGINT");
    assert.equal(summary.accounting.expectedProducers, 1);
    assert.equal(summary.accounting.executedProducers, 1);
    assert.equal(summary.accounting.green, 0, "an interrupted producer is never green");
    assert.equal(summary.accounting.interrupted, 1);
    assert.equal(summary.producers[0].status, "interrupted");
    assert.equal(summary.recordedCellsAccounting.green, 0, "an interrupted recorded cell is never green");
    assert.equal(summary.recordedCellsAccounting.interrupted, 1);

    // Exact-child cleanup: the interrupted producer pid must be gone.
    const pid = summary.producers[0].pid;
    assert.ok(typeof pid === "number" && pid > 0, "interrupted producer must record its child pid");
    const goneDeadline = Date.now() + 10000;
    let gone = false;
    while (Date.now() < goneDeadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch (err: any) {
        if (err.code === "ESRCH") {
          gone = true;
          break;
        }
        throw err;
      }
    }
    assert.ok(gone, `interrupted producer child pid ${pid} must be reaped (no orphan)`);
  });

  it("a RELATIVE --evidence-dir is canonicalized to an absolute evidence root (child producers must never receive repo-relative roots)", async () => {
    // CORE-CELLS US-006 regression: the full run passes --evidence-dir to the
    // motor-gate producer, which builds sandbox launcher paths from it; a
    // repo-relative root made the daemon exec "<sandbox>/bin/scripted-pi"
    // against its workdir (probe "not found" -> run force-failed). The
    // entrypoint must resolve relative roots against the invocation cwd.
    const greenFile = path.join(EVIDENCE_ROOT, "fixtures", "green-relative.test.mjs");
    fs.mkdirSync(path.dirname(greenFile), { recursive: true });
    fs.writeFileSync(greenFile, 'import { test } from "node:test";\ntest("green", () => {});\n', "utf8");
    const manifestFile = syntheticManifest([fixtureProducer("fixture-green-rel", "green fixture", greenFile)]);
    const cwd = freshInstanceDir("relative-evidence-cwd");
    const relEvidence = path.join("relative-evidence", `r${Date.now()}`);
    const res = await runEntrypoint(["--evidence-dir", relEvidence], {
      label: "relative-evidence",
      env: { TT_CORE_CELLS_MANIFEST: manifestFile },
      cwd,
    });
    assert.equal(res.code, 0, `relative --evidence-dir run must exit 0 (stderr: ${res.stderr})`);
    const summary = readSummary(path.join(cwd, relEvidence));
    assert.equal(summary.exitCode, 0);
    assert.ok(path.isAbsolute(summary.evidenceRoot), `evidenceRoot must be absolute, got ${summary.evidenceRoot}`);
    assert.equal(summary.evidenceRoot, path.join(cwd, relEvidence), "relative evidence root must resolve against the invocation cwd");
    assert.equal(summary.accounting.green, 1);
  });

  it("an invalid override manifest is refused before any evidence-root effect (exit 2, nothing written)", async () => {
    const badManifest = path.join(EVIDENCE_ROOT, "bad-manifest.json");
    fs.writeFileSync(badManifest, '{"version": 1, "producers": [{"id": 7}]}', "utf8");
    const evidenceDir = path.join(EVIDENCE_ROOT, "run-refused", `r${Date.now()}`);
    const res = await runEntrypoint(["--evidence-dir", evidenceDir], {
      label: "refused-manifest",
      env: { TT_CORE_CELLS_MANIFEST: badManifest },
    });
    assert.equal(res.code, 2, "an invalid override manifest must exit 2");
    assert.ok(res.stderr.includes("refused"), "the refusal reason must be on stderr");
    assert.equal(fs.existsSync(evidenceDir), false, "no evidence root may be created for a refused manifest");
  });

  it("mixed missing+red+green synthetic manifest never yields a green result and accounts each class exactly", async () => {
    const greenFile = path.join(EVIDENCE_ROOT, "fixtures", "green-mix.test.mjs");
    fs.mkdirSync(path.dirname(greenFile), { recursive: true });
    fs.writeFileSync(greenFile, 'import { test } from "node:test";\ntest("green", () => {});\n', "utf8");
    const redFile = path.join(EVIDENCE_ROOT, "fixtures", "red-mix.test.mjs");
    fs.mkdirSync(path.dirname(redFile), { recursive: true });
    fs.writeFileSync(redFile, 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n', "utf8");
    const missingFile = path.join(EVIDENCE_ROOT, "missing-mix.test.mjs");
    const manifestFile = syntheticManifest([
      fixtureProducer("mix-green", "green", greenFile),
      fixtureProducer("mix-red", "red", redFile),
      fixtureProducer("mix-missing", "missing", missingFile),
    ]);
    const evidenceDir = path.join(EVIDENCE_ROOT, "run-mixed", `r${Date.now()}`);
    const res = await runEntrypoint(["--evidence-dir", evidenceDir], {
      label: "mixed-producers",
      env: { TT_CORE_CELLS_MANIFEST: manifestFile },
    });
    assert.notEqual(res.code, 0, "any non-green class must yield a non-zero exit");
    const summary = readSummary(evidenceDir);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.accounting.expectedProducers, 3);
    assert.equal(summary.accounting.executedProducers, 2);
    assert.equal(summary.accounting.green, 1);
    assert.equal(summary.accounting.red, 1);
    assert.equal(summary.accounting.missing, 1);
    assert.equal(summary.accounting.interrupted, 0);
    assert.equal(summary.recordedCellsAccounting.green, 1);
    assert.equal(summary.recordedCellsAccounting.red, 1);
    assert.equal(summary.recordedCellsAccounting.missing, 1);
  });
});
