// Tier-2 STORM-REAL US-009 — arm aged-state adoption into a prepared storm
// campaign's private state root (NO daemon/harness/model, NO real tokens).
//
// The REAL storm runs against the frozen aged corpus produced by the
// torture-owned `tt-storm-aged` generator. This file is the focused self-test
// for the adoption path:
//
//   * a foreign/replaced seed root is refused (owned identity via the aged
//     manifest's assertRootIdentity) BEFORE any campaign write — no partial
//     install, no receipt;
//   * a snapshot/event sha256 mismatch is refused BEFORE any write;
//   * a successful adoption installs the immutable DB snapshot as the campaign
//     TAMANDUA_DB_PATH, copies every pinned event stream and records the
//     adopted run/step/run_worktrees/event counts in an arming receipt;
//   * adoption is LAUNCH-FREE: it changes neither state.mode nor
//     state.qualification and never spawns a daemon/harness;
//   * arming a non-prepared campaign is refused without clobbering its DB;
//   * the REAL profile prepare + adoption and the real CLI `arm aged-state`
//     both work end to end.
//
// Everything runs under fresh owned temp roots; the only subprocesses are
// LOCAL git (fixture creation) and the CLI itself. Tests remove only their own
// scratch dirs in finally.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  AGED_STATE_ARM_KIND,
  AGED_STATE_ARM_SCHEMA_VERSION,
  AGED_STATE_ADOPTION_PATH,
  adoptAgedState,
  agedStateArmReceiptPath,
  readAdoptedCounts,
  readAgedStateArmReceipt,
  verifyAgedStateSeed,
} from "../bin/tt-storm-arm.mjs";
import { allocateSeedRoot, loadManifest, saveManifest } from "../aged/manifest.mjs";
import { sha256FileStream } from "../aged/seedcommon.mjs";
import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { buildPrivateExecContext, persistableExecIdentity } from "../bin/tt-storm-real.mjs";
import { stormPrepare } from "../bin/tt-storm-engine.mjs";
import { DEFAULT_COORDINATOR_APPROVAL_FILE, computeGateHashes } from "../bin/tt-storm-rehearsal.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-arm-${label}-`));
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256File(file: string): string {
  return sha256FileStream(file);
}

// Build a small but REAL owned seed root: an aged manifest with a pinned
// immutable DB snapshot and pinned event streams (the exact shape
// tt-storm-aged publishes).
function makeSeed(baseDir: string, { runs = 3, steps = 4, worktrees = 2 }: { runs?: number; steps?: number; worktrees?: number } = {}) {
  const root = allocateSeedRoot({ baseDir, kind: "full", runId: "us009-test" });
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const live = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(live);
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT)");
  db.exec("CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT)");
  db.exec("CREATE TABLE run_worktrees (id TEXT PRIMARY KEY, run_id TEXT, worktree_path TEXT)");
  for (let i = 0; i < runs; i += 1) db.prepare("INSERT INTO runs (id, workflow_id) VALUES (?, ?)").run(`run-${i}`, "do-now");
  for (let i = 0; i < steps; i += 1) db.prepare("INSERT INTO steps (id, run_id) VALUES (?, ?)").run(`step-${i}`, `run-${i % runs}`);
  for (let i = 0; i < worktrees; i += 1) db.prepare("INSERT INTO run_worktrees (id, run_id, worktree_path) VALUES (?, ?, ?)").run(`wt-${i}`, `run-${i % runs}`, `/seed/wt-${i}`);
  db.close();

  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const snapshot = path.join(evidenceDir, "db-full-post-test.sqlite");
  fs.copyFileSync(live, snapshot);
  fs.chmodSync(snapshot, 0o444);
  const snapshotSha = sha256File(snapshot);

  const eventsDir = path.join(evidenceDir, "events-full-post");
  fs.mkdirSync(eventsDir, { recursive: true });
  const eventBodies: Array<[string, string]> = [
    ["all.jsonl", '{"event":"run.completed"}\n'],
    [`${runs === 0 ? "none" : "run-0"}.jsonl`, '{"event":"run.completed"}\n'],
  ];
  const copied = eventBodies.map(([name, body]) => {
    const file = path.join(eventsDir, name);
    fs.writeFileSync(file, body, "utf8");
    return { name, sha256: sha256File(file) };
  });

  const manifest = loadManifest(root);
  manifest.snapshot = {
    db: { file: snapshot, sha256: snapshotSha, sizeBytes: fs.statSync(snapshot).size, mode: 0o444, userVersion: 14 },
    events: { dir: eventsDir, copied },
  };
  manifest.counts = { runs, steps, run_worktrees: worktrees };
  saveManifest(root, manifest);
  return { root, snapshot, eventsDir, manifest, eventBodies };
}

function makeCampaign(scratch: string, { mode = "prepared" }: { mode?: string } = {}) {
  const campaignDir = path.join(scratch, "campaign");
  const execRoot = path.join(scratch, "exec");
  const homeRoot = path.join(execRoot, "home");
  const stateRoot = path.join(execRoot, "state");
  const tmpRoot = path.join(execRoot, "tmp");
  const dbPath = path.join(execRoot, "tamandua.db");
  for (const d of [homeRoot, stateRoot, tmpRoot]) fs.mkdirSync(d, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT)");
  db.prepare("INSERT INTO runs (id, workflow_id) VALUES ('sentinel', 'do-now')").run();
  db.close();
  const dbStat = fs.statSync(dbPath);
  const stat = (p: string) => { const s = fs.statSync(p); return { path: p, dev: s.dev, ino: s.ino, capturedAt: new Date().toISOString() }; };
  const state: any = {
    schema_version: 2,
    campaign_id: "storm-us009-test",
    mode,
    qualification: { real_launch_allowed: false, note: "not-yet-qualified" },
    exec_identity: {
      schema_version: 2,
      home_root: homeRoot,
      state_root: stateRoot,
      db_path: dbPath,
      tmp_root: tmpRoot,
      ownership: { home: stat(homeRoot), state: stat(stateRoot), db: { path: dbPath, dev: dbStat.dev, ino: dbStat.ino, capturedAt: new Date().toISOString() }, tmp: stat(tmpRoot) },
    },
    rounds: { A: { status: "planned", runs: {} }, B: { status: "planned", runs: {} } },
  };
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
  const execCtx = { db_path: dbPath, state_root: stateRoot, home_root: homeRoot, tmp_root: tmpRoot };
  return { campaignDir, execCtx, state, dbPath, stateRoot, eventsDest: path.join(stateRoot, "events") };
}

function runAdoptedRuns(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM runs ORDER BY id").all().map((r: any) => r.id);
  } finally {
    db.close();
  }
}

function makeRealGitAdapter() {
  return {
    run: async (cwd: string, args: string[], { env = {} }: { env?: Record<string, string> } = {}) =>
      spawnCapture(["git", ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
        mergeParentEnv: false,
        timeoutMs: 120_000,
      }),
  };
}

function makeRecordingProc() {
  const calls: Array<[string, any]> = [];
  const fn = async () => { calls.push(["spawn", null]); throw new Error("recording proc must not be invoked during prepare/arm"); };
  return { calls, spawn: fn, daemonControl: fn, harness: fn };
}

function inProcessRealCtx(scratch: string, overrides: Record<string, any> = {}): any {
  const varRoot = path.join(scratch, "var");
  fs.mkdirSync(varRoot, { recursive: true });
  const installedRoot = path.join(varRoot, "home", ".tamandua", "workflows");
  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
  return {
    fs: REAL_FS,
    clock: { nowMs: () => Date.now(), nowUtc: () => new Date().toISOString(), sleep: async () => {} },
    proc: makeRecordingProc(),
    db: null,
    git: makeRealGitAdapter(),
    varRoot,
    campaignDir: null,
    opts: {
      rehearsalPrepare: true,
      installedCatalogRoot: installedRoot,
      bundledCatalogRoot: BUNDLED_WORKFLOWS,
      sourceCommit: "c".repeat(40),
      sourceTree: "t".repeat(40),
      sourceTreeDirty: false,
      execIdentity: persistableExecIdentity(execCtx),
      gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(scratch, "git-home") },
      gateHashes: computeGateHashes(),
      coordinatorApprovalFile: DEFAULT_COORDINATOR_APPROVAL_FILE,
      profile: "REAL",
      spendCapTokens: "200000000",
      resolveHarnessPins: async (names: string[]) =>
        Object.fromEntries(names.map((n) => [n, {
          harness: n,
          path: `/fake/harness/${n}`,
          resolved_from: `env:TAMANDUA_${n.toUpperCase()}_BINARY`,
          sha256: "a".repeat(64),
          version: `${n} 1.2.3`,
          version_exit_code: 0,
        }])),
      ...overrides,
    },
    argv: ["prepare"],
  };
}

function childEnvForCli(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runCli(args: string[], varRoot: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 600_000,
    env: childEnvForCli({ TT_VAR: varRoot }),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

describe("STORM-REAL US-009 arm aged-state — owned adoption into the campaign state root", () => {
  it("A1: the adoption path is documented as a frozen source→destination table", () => {
    assert.equal(AGED_STATE_ARM_KIND, "aged-state");
    assert.equal(AGED_STATE_ARM_SCHEMA_VERSION, 1);
    assert.equal(agedStateArmReceiptPath("/tmp/campaign"), path.join("/tmp/campaign", "arming", "aged-state.json"));
    assert.equal(AGED_STATE_ADOPTION_PATH.length, 3);
    const steps = AGED_STATE_ADOPTION_PATH.map((s: any) => s.step);
    assert.deepEqual(steps, ["db", "events", "run_worktrees"]);
    for (const entry of AGED_STATE_ADOPTION_PATH) {
      assert.ok(typeof (entry as any).source === "string" && (entry as any).source.length > 0);
      assert.ok(typeof (entry as any).destination === "string" && (entry as any).destination.length > 0);
    }
  });

  it("A2: a foreign/replaced seed root is refused before any campaign write", () => {
    const scratch = ownedScratch("foreign");
    try {
      const seed = makeSeed(path.join(scratch, "seeds"));
      const camp = makeCampaign(scratch);
      const before = fs.readFileSync(camp.dbPath);

      // Replace the owned identity: the manifest's pinned ino no longer matches
      // the real root.
      const manifest = loadManifest(seed.root);
      manifest.ownership.ino = (manifest.ownership.ino as number) + 12345;
      saveManifest(seed.root, manifest);

      assert.throws(
        () => verifyAgedStateSeed({ seedRoot: seed.root }),
        (err: any) => err?.code === "TT_SEED_ROOT_REFUSED",
        "a mismatched owned identity refuses TT_SEED_ROOT_REFUSED",
      );
      // Nothing was written: DB bytes unchanged and no receipt exists.
      assert.deepEqual(fs.readFileSync(camp.dbPath), before);
      assert.equal(fs.existsSync(agedStateArmReceiptPath(camp.campaignDir)), false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("A3: a snapshot/event sha256 mismatch is refused with no partial install", () => {
    const scratch = ownedScratch("hash");
    try {
      const seed = makeSeed(path.join(scratch, "seeds"));
      const camp = makeCampaign(scratch);
      // Corrupt the immutable snapshot AFTER the manifest pinned its hash.
      fs.chmodSync(seed.snapshot, 0o644);
      fs.appendFileSync(seed.snapshot, "corruption");
      assert.throws(
        () => verifyAgedStateSeed({ seedRoot: seed.root }),
        (err: any) => err?.code === "TT_SEED_SNAPSHOT_INVALID",
        "a snapshot sha256 mismatch refuses TT_SEED_SNAPSHOT_INVALID",
      );
      assert.equal(fs.existsSync(agedStateArmReceiptPath(camp.campaignDir)), false);
      assert.equal(runAdoptedRuns(camp.dbPath).includes("sentinel"), true, "campaign DB untouched");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("A4: missing seed root and missing snapshot both refuse", () => {
    const scratch = ownedScratch("missing");
    try {
      assert.throws(() => verifyAgedStateSeed({ seedRoot: "" }), (err: any) => err?.code === "TT_SEED_NOT_ARMABLE");
      assert.throws(() => verifyAgedStateSeed({ seedRoot: path.join(scratch, "nope") }), (err: any) => err?.code === "TT_SEED_ROOT_REFUSED");
      const seed = makeSeed(path.join(scratch, "seeds"));
      const manifest = loadManifest(seed.root);
      manifest.snapshot = {};
      saveManifest(seed.root, manifest);
      assert.throws(() => verifyAgedStateSeed({ seedRoot: seed.root }), (err: any) => err?.code === "TT_SEED_SNAPSHOT_INVALID");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("A5: adoption installs the DB/events, counts them and writes an arming receipt (launch-free)", () => {
    const scratch = ownedScratch("adopt");
    try {
      const seed = makeSeed(path.join(scratch, "seeds"), { runs: 3, steps: 4, worktrees: 2 });
      const camp = makeCampaign(scratch);
      const verified = verifyAgedStateSeed({ seedRoot: seed.root });
      assert.equal(verified.snapshot_sha256, sha256File(seed.snapshot));
      assert.equal(verified.event_files.length, 2);

      const modeBefore = camp.state.mode;
      const qualBefore = JSON.stringify(camp.state.qualification);
      const result = adoptAgedState({ campaignDir: camp.campaignDir, execCtx: camp.execCtx, state: camp.state, verified });

      // DB adopted: the seed rows replaced the sentinel campaign DB.
      const runs = runAdoptedRuns(camp.dbPath);
      assert.deepEqual(runs, ["run-0", "run-1", "run-2"]);
      assert.equal(runs.includes("sentinel"), false);
      // Counts are the real adopted figures.
      assert.equal(result.counts.runs, 3);
      assert.equal(result.counts.steps, 4);
      assert.equal(result.counts.run_worktrees, 2);
      // Events copied byte-exact.
      for (const [name, body] of seed.eventBodies) {
        assert.equal(fs.readFileSync(path.join(camp.eventsDest, name), "utf8"), body);
      }
      // Receipt records source root, snapshot sha256 and adopted counts.
      const receipt = readAgedStateArmReceipt({ campaignDir: camp.campaignDir });
      assert.equal(receipt.kind, "aged-state");
      assert.equal(receipt.armed, true);
      assert.equal(receipt.launch_free, true);
      assert.equal(receipt.source_root, fs.realpathSync(seed.root));
      assert.equal(receipt.snapshot_sha256, sha256File(seed.snapshot));
      assert.equal(receipt.adopted_counts.runs, 3);
      assert.equal(receipt.adopted_counts.steps, 4);
      assert.equal(receipt.adopted_counts.run_worktrees, 2);
      assert.equal(receipt.adopted_counts.event_files, 2);
      // The persisted exec identity re-pins the adopted DB so later modes
      // revalidate against the real installed file.
      assert.equal(camp.state.exec_identity.ownership.db.ino, fs.statSync(camp.dbPath).ino);
      // Launch-free: mode and qualification are unchanged.
      assert.equal(camp.state.mode, modeBefore);
      assert.equal(JSON.stringify(camp.state.qualification), qualBefore);
      assert.equal(camp.state.arming["aged-state"].snapshot_sha256, receipt.snapshot_sha256);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("A6: arming a non-prepared campaign is refused without clobbering its DB", () => {
    const scratch = ownedScratch("notprepared");
    try {
      const seed = makeSeed(path.join(scratch, "seeds"));
      const camp = makeCampaign(scratch, { mode: "run-A" });
      const verified = verifyAgedStateSeed({ seedRoot: seed.root });
      const before = fs.readFileSync(camp.dbPath);
      assert.throws(
        () => adoptAgedState({ campaignDir: camp.campaignDir, execCtx: camp.execCtx, state: camp.state, verified }),
        (err: any) => err?.code === "TT_ARM_STATE_NOT_PREPARED",
      );
      assert.deepEqual(fs.readFileSync(camp.dbPath), before, "the running campaign DB is untouched");
      assert.equal(fs.existsSync(agedStateArmReceiptPath(camp.campaignDir)), false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("A7: readAdoptedCounts refuses a missing DB (never a fabricated 0)", () => {
    const scratch = ownedScratch("counts");
    try {
      assert.throws(() => readAdoptedCounts({ dbPath: path.join(scratch, "missing.db") }), (err: any) => err?.code === "TT_ARM_DB_UNAVAILABLE");
      assert.throws(() => readAdoptedCounts({ dbPath: null as any }), (err: any) => err?.code === "TT_ARM_DB_UNAVAILABLE");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("A8: a REAL-profile prepared campaign adopts the seed and stays unqualified (no spawn)", async () => {
    const scratch = ownedScratch("real");
    try {
      const ctx = inProcessRealCtx(scratch);
      const res: any = await stormPrepare(ctx);
      assert.equal(ctx.proc.calls.length, 0, "prepare must not spawn a daemon/harness");
      assert.equal(res.state.rehearsal.profile, "REAL");
      assert.equal(res.state.mode, "prepared");

      const seed = makeSeed(path.join(scratch, "seeds"), { runs: 5, steps: 7, worktrees: 3 });
      const verified = verifyAgedStateSeed({ seedRoot: seed.root });
      const result = adoptAgedState({
        campaignDir: res.campaignDir,
        execCtx: { db_path: res.state.exec_identity.db_path, state_root: res.state.exec_identity.state_root },
        state: res.state,
        verified,
      });
      assert.equal(result.counts.runs, 5);
      assert.equal(runAdoptedRuns(res.state.exec_identity.db_path).length, 5);
      assert.equal(res.state.mode, "prepared");
      assert.equal(res.state.qualification.real_launch_allowed, false);
      assert.equal(ctx.proc.calls.length, 0, "adoption must not spawn a daemon/harness");
      assert.ok(fs.existsSync(agedStateArmReceiptPath(res.campaignDir)));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("A9: the real CLI performs the adoption, refuses a missing --seed-root and refuses a foreign root", () => {
    const scratch = ownedScratch("cli");
    const varRoot = path.join(scratch, "var");
    try {
      const prepared = runCli(["prepare"], varRoot);
      assert.equal(prepared.status, 0, `scripted prepare must succeed:\n${prepared.stdout}\n${prepared.stderr}`);
      const resultsDir = path.join(varRoot, "results");
      const campaignDir = fs.readdirSync(resultsDir)
        .map((n) => path.join(resultsDir, n))
        .find((p) => fs.existsSync(path.join(p, "state.json")))!;
      assert.ok(campaignDir, "a prepared campaign dir exists");

      const seed = makeSeed(path.join(scratch, "seeds"), { runs: 4, steps: 6, worktrees: 1 });
      const stateBefore = loadJson(path.join(campaignDir, "state.json"));

      // Missing --seed-root is a usage refusal (exit 4), no writes.
      const missing = runCli(["arm", "aged-state", "--campaign", campaignDir], varRoot);
      assert.equal(missing.status, 4, `missing --seed-root exits 4:\n${missing.stderr}`);
      assert.match(missing.stderr, /--seed-root/);

      // Foreign/mismatched root refuses (exit 3) and leaves the campaign DB.
      const foreignSeed = makeSeed(path.join(scratch, "seeds"));
      const fm = loadManifest(foreignSeed.root);
      fm.ownership.ino = (fm.ownership.ino as number) + 7;
      saveManifest(foreignSeed.root, fm);
      const dbBytesBefore = fs.readFileSync(stateBefore.exec_identity.db_path);
      const foreign = runCli(["arm", "aged-state", "--campaign", campaignDir, "--seed-root", foreignSeed.root], varRoot);
      assert.equal(foreign.status, 3, `foreign seed exits 3:\n${foreign.stderr}`);
      assert.match(foreign.stderr, /seed root identity refused/);
      assert.deepEqual(fs.readFileSync(stateBefore.exec_identity.db_path), dbBytesBefore);
      assert.equal(fs.existsSync(agedStateArmReceiptPath(campaignDir)), false);

      // Real adoption succeeds, is launch-free and leaves the campaign prepared.
      const armed = runCli(["arm", "aged-state", "--campaign", campaignDir, "--seed-root", seed.root], varRoot);
      assert.equal(armed.status, 0, `arm aged-state exit 0:\n${armed.stdout}\n${armed.stderr}`);
      assert.match(armed.stdout, /arm aged-state .*: armed/);
      const receipt = readAgedStateArmReceipt({ campaignDir });
      assert.equal(receipt.armed, true);
      assert.equal(receipt.adopted_counts.runs, 4);
      assert.equal(receipt.adopted_counts.steps, 6);
      assert.equal(receipt.adopted_counts.run_worktrees, 1);
      assert.equal(runAdoptedRuns(stateBefore.exec_identity.db_path).length, 4);
      const stateAfter = loadJson(path.join(campaignDir, "state.json"));
      assert.equal(stateAfter.mode, "prepared");
      assert.deepEqual(stateAfter.qualification, stateBefore.qualification);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});