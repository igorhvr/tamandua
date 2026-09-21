/**
 * vm-reaper.test.ts — MTLK-CLEANUP US-006 (bead tamandua-6sy.33.10.42).
 *
 * Serial lane: the reaper delegates its spawn to `vm-evidence.ts`, so this test
 * file transitively imports `node:child_process` and is classified serial (it
 * spawns a fake `matchlock` CLI child, never a VM, image, model or daemon).
 *
 * Everything is a local fixture: a real SQLite `state.db` (created with
 * node:sqlite), fake `~/.matchlock/vms/<id>` dirs and a fake `matchlock` CLI
 * that records its exact argv + effective HOME and removes the fake VM dir.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  defaultVmProcessAliveProbe,
  readStoppedVmRows,
  reapOrphanedMatchlockVms,
  reapStoppedMatchlockVms,
} from "../../../dist/installer/matchlock/vm-reaper.js";
import {
  readOrphanVms,
  writeOrphanVm,
} from "../../../dist/installer/matchlock/vm-orphans.js";

/** Fake `matchlock` CLI: records one JSON line per invocation, optionally keeps the dir. */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const home = process.env.HOME || "";
const vmId = argv[argv.length - 1];
const vmDir = path.join(home, ".matchlock", "vms", vmId);

function list(dir, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...list(path.join(dir, entry.name), prefix + entry.name + "/"));
    else out.push(prefix + entry.name);
  }
  return out;
}

let destListing = null;
const destDir = process.env.FAKE_DEST_DIR;
if (destDir) {
  try { destListing = list(destDir, "").sort(); } catch { destListing = null; }
}

if (process.env.FAKE_RECORD) {
  fs.appendFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({ argv, home, destListing, vmDirExists: fs.existsSync(vmDir) }) + "\\n",
  );
}
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);

const exit = Number(process.env.FAKE_EXIT || "0");
if (process.env.FAKE_KEEP_DIR !== "1" && argv.includes("rm")) {
  try { fs.rmSync(vmDir, { recursive: true, force: true }); } catch {}
}
process.exit(exit);
`;

interface FakeRecord {
  argv: string[];
  home: string;
  destListing: string[] | null;
  vmDirExists: boolean;
}

const RUN = "0e1131db-1111-2222-3333-444444444444";
const VM_DEAD = "vm-394274ee";
const VM_OTHER = "vm-f9377c28";
const VM_LIVE = "vm-929b72e0";

describe("reapStoppedMatchlockVms (fake matchlock CLI + real SQLite state.db)", () => {
  let tmpRoot: string;
  let fakeCli: string;
  const tmpRoots: string[] = [];

  before(() => {
    tmpRoot = tamanduaTempDir("tamandua-vm-reaper-");
    tmpRoots.push(tmpRoot);
    fakeCli = path.join(tmpRoot, "fake-matchlock");
    fs.writeFileSync(fakeCli, FAKE_CLI, "utf-8");
    fs.chmodSync(fakeCli, 0o755);
  });

  after(() => {
    for (const dir of tmpRoots.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  function mkTmp(prefix: string): string {
    const dir = tamanduaTempDir(prefix);
    tmpRoots.push(dir);
    return dir;
  }

  /** Create a real Matchlock-style state.db with the documented vms columns. */
  function makeStateDb(
    home: string,
    rows: Array<{ id: string; pid: number; status: string }>,
  ): string {
    const dir = path.join(home, ".matchlock");
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE vms (id TEXT PRIMARY KEY, pid INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO vms (id, pid, status) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.id, row.pid, row.status);
    db.close();
    return dbPath;
  }

  /** Create a fake VM state dir at <home>/.matchlock/vms/<vmId>/. */
  function makeVm(
    home: string,
    vmId: string,
    extras: Record<string, string> = {},
  ): { vmDir: string } {
    const vmDir = path.join(home, ".matchlock", "vms", vmId);
    fs.mkdirSync(path.join(vmDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(vmDir, "config.json"), `{"vm":"${vmId}"}\n`, "utf-8");
    for (const [relative, body] of Object.entries(extras)) {
      const target = path.join(vmDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, "utf-8");
    }
    return { vmDir };
  }

  function readRecords(recordPath: string): FakeRecord[] {
    if (!fs.existsSync(recordPath)) return [];
    return fs
      .readFileSync(recordPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeRecord);
  }

  it("removes a stopped VM with a dead pid via exactly one `rm <id>` with HOME forced, after evidence copy", () => {
    const home = path.join(mkTmp("vmreap-home-"), "h");
    makeStateDb(home, [
      { id: VM_DEAD, pid: 0, status: "stopped" },
      // A running row is NOT selected (only status='stopped' is a candidate).
      { id: VM_OTHER, pid: 424242, status: "running" },
    ]);
    makeVm(home, VM_DEAD, { "logs/round.log": "round-log\n", "logs/nested/deep.log": "deep\n" });
    const { vmDir: otherDir } = makeVm(home, VM_OTHER, { "logs/other.log": "other\n" });

    const evidenceBaseDir = path.join(tmpRoot, "evidence-global");
    const recordPath = path.join(tmpRoot, "record-global.jsonl");

    const result = reapStoppedMatchlockVms({
      matchlockHome: home,
      cliBinaryPath: fakeCli,
      evidenceBaseDir,
      env: { FAKE_RECORD: recordPath, FAKE_DEST_DIR: path.join(evidenceBaseDir, VM_DEAD) },
      isProcessAlive: () => false,
      onLog: () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.scanned, 1);
    assert.equal(result.eligible, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].vmId, VM_DEAD);
    assert.equal(result.results[0].action, "removed");

    // Evidence copied verbatim BEFORE the rm child ran.
    assert.equal(
      fs.readFileSync(path.join(evidenceBaseDir, VM_DEAD, "config.json"), "utf-8"),
      `{"vm":"${VM_DEAD}"}\n`,
    );
    assert.equal(
      fs.readFileSync(path.join(evidenceBaseDir, VM_DEAD, "logs", "round.log"), "utf-8"),
      "round-log\n",
    );
    assert.equal(
      fs.readFileSync(path.join(evidenceBaseDir, VM_DEAD, "logs", "nested", "deep.log"), "utf-8"),
      "deep\n",
    );

    // Exactly one child, exact argv, HOME forced to the matchlock home.
    const records = readRecords(recordPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].argv, ["rm", VM_DEAD]);
    assert.equal(records[0].home, home);
    assert.equal(records[0].vmDirExists, true);
    assert.deepEqual(records[0].destListing, [
      "config.json",
      "logs/nested/deep.log",
      "logs/round.log",
    ]);

    // NEVER prune/gc, never a name/glob.
    assert.ok(
      !records.some((r) => r.argv.includes("prune") || r.argv.includes("gc")),
      JSON.stringify(records.map((r) => r.argv)),
    );

    // The dead VM's dir is gone; the running row's VM was never touched.
    assert.equal(fs.existsSync(path.join(home, ".matchlock", "vms", VM_DEAD)), false);
    assert.equal(fs.existsSync(otherDir), true);
  });

  it("skips a VM whose recorded pid is a live process and never passes it to rm", () => {
    const home = path.join(mkTmp("vmreap-live-"), "h");
    makeStateDb(home, [{ id: VM_LIVE, pid: 43210, status: "stopped" }]);
    const { vmDir } = makeVm(home, VM_LIVE, { "logs/live.log": "live\n" });
    const recordPath = path.join(tmpRoot, "record-live.jsonl");

    const result = reapStoppedMatchlockVms({
      matchlockHome: home,
      cliBinaryPath: fakeCli,
      evidenceBaseDir: path.join(tmpRoot, "evidence-live"),
      env: { FAKE_RECORD: recordPath },
      // Injected live-process probe: only this pid is alive.
      isProcessAlive: (pid) => pid === 43210,
      onLog: () => {},
    });

    assert.equal(result.eligible, 0);
    assert.deepEqual(
      result.results.map((r) => ({ vmId: r.vmId, action: r.action, pid: r.pid })),
      [{ vmId: VM_LIVE, action: "skipped-live", pid: 43210 }],
    );
    assert.equal(fs.existsSync(recordPath), false, "no rm child may spawn for a live VM");
    assert.equal(fs.existsSync(vmDir), true, "a live VM's state dir must be retained");
  });

  it("treats an absent or corrupt state.db as a bounded diagnostic with an empty result and never throws", () => {
    // Absent DB (and no orphans): operator mode has no candidates.
    const absentHome = path.join(mkTmp("vmreap-absent-"), "h");
    fs.mkdirSync(absentHome, { recursive: true });
    const absent = reapStoppedMatchlockVms({
      matchlockHome: absentHome,
      cliBinaryPath: fakeCli,
      onLog: () => {},
    });
    assert.equal(absent.ok, false);
    assert.equal(absent.scanned, 0);
    assert.deepEqual(absent.results, []);
    assert.ok(absent.diagnostics.length >= 1, "absent DB must be diagnosed");
    assert.match(absent.diagnostics.join(" | "), /state\.db unavailable/);

    // Corrupt DB is also bounded, never a throw.
    const corruptHome = path.join(mkTmp("vmreap-corrupt-"), "h");
    makeStateDb(corruptHome, [{ id: VM_DEAD, pid: 0, status: "stopped" }]);
    fs.writeFileSync(path.join(corruptHome, ".matchlock", "state.db"), "not a database at all");
    let corrupt: ReturnType<typeof reapStoppedMatchlockVms> | null = null;
    assert.doesNotThrow(() => {
      corrupt = reapStoppedMatchlockVms({
        matchlockHome: corruptHome,
        cliBinaryPath: fakeCli,
        onLog: () => {},
      });
    });
    assert.ok(corrupt !== null);
    assert.equal(corrupt!.ok, false);
    assert.deepEqual(corrupt!.results, []);
    assert.ok(corrupt!.diagnostics.length >= 1, "corrupt DB must be diagnosed");
    assert.match(corrupt!.diagnostics.join(" | "), /state\.db read failed/);

    // Direct reader: absent/corrupt never throw either.
    assert.equal(readStoppedVmRows(path.join(absentHome, ".matchlock", "state.db")).ok, false);
    assert.equal(fs.existsSync(path.join(absentHome, ".matchlock", "state.db")), false);
  });

  it("opens the state.db read-only (byte-identical, no journal sidecars) and still reaps", () => {
    const home = path.join(mkTmp("vmreap-ro-"), "h");
    const dbPath = makeStateDb(home, [{ id: VM_DEAD, pid: 0, status: "stopped" }]);
    const { vmDir } = makeVm(home, VM_DEAD, { "logs/ro.log": "ro\n" });
    const evidenceBaseDir = path.join(tmpRoot, "evidence-ro");
    const recordPath = path.join(tmpRoot, "record-ro.jsonl");

    const beforeBytes = fs.readFileSync(dbPath);
    const beforeMode = fs.statSync(dbPath).mode & 0o777;
    assert.equal(beforeMode, 0o644);

    // A read-write repair would need to create a journal in this dir; a
    // read-only open succeeds without it.
    fs.chmodSync(dbPath, 0o444);
    fs.chmodSync(path.join(home, ".matchlock"), 0o555);
    let result: ReturnType<typeof reapStoppedMatchlockVms>;
    try {
      result = reapStoppedMatchlockVms({
        matchlockHome: home,
        cliBinaryPath: fakeCli,
        evidenceBaseDir,
        env: { FAKE_RECORD: recordPath },
        isProcessAlive: () => false,
        onLog: () => {},
      });
    } finally {
      fs.chmodSync(path.join(home, ".matchlock"), 0o755);
      fs.chmodSync(dbPath, 0o644);
    }

    assert.equal(result!.ok, true);
    assert.equal(result!.eligible, 1);
    assert.equal(result!.results[0].action, "removed");
    assert.equal(fs.existsSync(vmDir), false);

    // The DB was never written or repaired.
    assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-journal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);

    // Direct reader returns the exact row and creates no sidecars.
    const read = readStoppedVmRows(dbPath);
    assert.equal(read.ok, true);
    assert.deepEqual(read.rows, [{ vmId: VM_DEAD, pid: 0, status: "stopped" }]);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  });

  it("run-scoped mode never removes an unrelated stopped VM and is a no-op with no orphan records", () => {
    const home = path.join(mkTmp("vmreap-scoped-noop-"), "h");
    makeStateDb(home, [{ id: VM_DEAD, pid: 0, status: "stopped" }]);
    const { vmDir } = makeVm(home, VM_DEAD, { "logs/x.log": "x\n" });
    const runRoot = mkTmp("vmreap-scoped-noop-runs-");
    const recordPath = path.join(tmpRoot, "record-scoped-noop.jsonl");

    const warns: string[] = [];
    const result = reapStoppedMatchlockVms({
      matchlockHome: home,
      runId: RUN,
      runRoot,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: () => false,
      onLog: (level, message) => {
        if (level === "warn") warns.push(message);
      },
    });

    assert.equal(result.eligible, 0);
    assert.deepEqual(
      result.results.map((r) => ({ vmId: r.vmId, action: r.action })),
      [{ vmId: VM_DEAD, action: "skipped-unowned" }],
    );
    assert.equal(fs.existsSync(recordPath), false, "no unrelated VM may be passed to rm");
    assert.equal(fs.existsSync(vmDir), true);
  });

  it("run-scoped mode removes the run's recorded orphan and clears its record", () => {
    const home = path.join(mkTmp("vmreap-orphan-"), "h");
    makeStateDb(home, [{ id: VM_DEAD, pid: 0, status: "stopped" }]);
    makeVm(home, VM_DEAD, { "logs/orphan.log": "orphan\n" });
    const runRoot = mkTmp("vmreap-orphan-runs-");

    const written = writeOrphanVm(
      {
        vmId: VM_DEAD,
        matchlockHome: home,
        invocationId: "inv-orphan-1",
        phase: "close",
        error: "matchlock error [phase=close] name=MatchlockRpcError; code=-32000; message=boom",
      },
      { runId: RUN, runRoot, onLog: () => {} },
    );
    assert.ok(written, "orphan record must be written");
    assert.equal(readOrphanVms({ runId: RUN, runRoot, onLog: () => {} }).length, 1);

    const recordPath = path.join(tmpRoot, "record-orphan.jsonl");
    const result = reapStoppedMatchlockVms({
      matchlockHome: home,
      runId: RUN,
      runRoot,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: () => false,
      onLog: () => {},
    });

    assert.equal(result.eligible, 1);
    assert.deepEqual(
      result.results.map((r) => ({ vmId: r.vmId, action: r.action })),
      [{ vmId: VM_DEAD, action: "removed" }],
    );
    const records = readRecords(recordPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].argv, ["rm", VM_DEAD]);
    assert.equal(records[0].home, home);
    // Evidence went to the run's matchlock/<vmId> dir.
    assert.equal(
      fs.readFileSync(path.join(runRoot, RUN, "matchlock", VM_DEAD, "logs", "orphan.log"), "utf-8"),
      "orphan\n",
    );
    // The orphan record was cleared after the confirmed removal.
    assert.deepEqual(readOrphanVms({ runId: RUN, runRoot, onLog: () => {} }), []);
  });

  it("run-scoped mode keeps the orphan record when the VM's process is still alive", () => {
    const home = path.join(mkTmp("vmreap-orphan-live-"), "h");
    makeStateDb(home, [{ id: VM_LIVE, pid: 777, status: "stopped" }]);
    const { vmDir } = makeVm(home, VM_LIVE, { "logs/live.log": "live\n" });
    const runRoot = mkTmp("vmreap-orphan-live-runs-");
    writeOrphanVm(
      {
        vmId: VM_LIVE,
        matchlockHome: home,
        invocationId: "inv-live-1",
        phase: "dispose",
        error: "boom",
      },
      { runId: RUN, runRoot, onLog: () => {} },
    );

    const recordPath = path.join(tmpRoot, "record-orphan-live.jsonl");
    const result = reapStoppedMatchlockVms({
      matchlockHome: home,
      runId: RUN,
      runRoot,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: (pid) => pid === 777,
      onLog: () => {},
    });

    assert.equal(result.eligible, 0);
    assert.deepEqual(
      result.results.map((r) => ({ vmId: r.vmId, action: r.action })),
      [{ vmId: VM_LIVE, action: "skipped-live" }],
    );
    assert.equal(fs.existsSync(recordPath), false);
    assert.equal(fs.existsSync(vmDir), true);
    assert.equal(readOrphanVms({ runId: RUN, runRoot, onLog: () => {} }).length, 1);
  });

  it("restricts the pass to explicit vmIds (operator entry point) and respects the cap", () => {
    const home = path.join(mkTmp("vmreap-ids-"), "h");
    const vmThird = "vm-1cb29b7c";
    makeStateDb(home, [
      { id: VM_DEAD, pid: 0, status: "stopped" },
      { id: VM_OTHER, pid: 0, status: "stopped" },
      { id: vmThird, pid: 0, status: "stopped" },
    ]);
    makeVm(home, VM_DEAD, { "logs/a.log": "a\n" });
    const { vmDir: otherDir } = makeVm(home, VM_OTHER, { "logs/b.log": "b\n" });
    makeVm(home, vmThird, { "logs/c.log": "c\n" });
    const recordPath = path.join(tmpRoot, "record-ids.jsonl");

    const restricted = reapStoppedMatchlockVms({
      matchlockHome: home,
      vmIds: [VM_DEAD],
      cliBinaryPath: fakeCli,
      evidenceBaseDir: path.join(tmpRoot, "evidence-ids"),
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: () => false,
      onLog: () => {},
    });
    assert.equal(restricted.eligible, 1);
    assert.deepEqual(restricted.results.map((r) => r.vmId), [VM_DEAD]);
    assert.equal(fs.existsSync(otherDir), true, "an unnamed VM must never be touched");

    // Cap is applied before any spawn: only the first (sorted) candidate is reaped.
    const capped = reapStoppedMatchlockVms({
      matchlockHome: home,
      cliBinaryPath: fakeCli,
      evidenceBaseDir: path.join(tmpRoot, "evidence-cap"),
      env: { FAKE_RECORD: path.join(tmpRoot, "record-cap.jsonl") },
      isProcessAlive: () => false,
      maxVms: 1,
      onLog: () => {},
    });
    assert.equal(capped.eligible, 1);
    assert.ok(capped.diagnostics.some((d) => /cap reached/.test(d)));
  });

  it("never throws for an empty matchlockHome and reports a bounded diagnostic", () => {
    let result: ReturnType<typeof reapStoppedMatchlockVms> | null = null;
    assert.doesNotThrow(() => {
      result = reapStoppedMatchlockVms({ matchlockHome: "", onLog: () => {} });
    });
    assert.ok(result !== null);
    assert.equal(result!.results.length, 0);
    assert.ok(result!.diagnostics.length >= 1);
  });

  it("defaultVmProcessAliveProbe treats pid 0 / invalid pids as dead and never throws", () => {
    assert.equal(defaultVmProcessAliveProbe(0), false);
    assert.equal(defaultVmProcessAliveProbe(-1), false);
    assert.equal(defaultVmProcessAliveProbe(1.5), false);
    assert.equal(defaultVmProcessAliveProbe(Number.NaN), false);
    // A very high pid is extremely unlikely to exist and must not throw.
    assert.doesNotThrow(() => defaultVmProcessAliveProbe(2_000_000_000));
  });

  // ── MTLK-CLEANUP US-007: operator / run-teardown entry point ─────────

  it("US-007 run-teardown mode derives the home from the orphan store, removes the exact VM and clears the record", () => {
    const home = path.join(mkTmp("vmreap-entry-"), "h");
    makeStateDb(home, [{ id: VM_DEAD, pid: 0, status: "stopped" }]);
    makeVm(home, VM_DEAD, { "logs/entry.log": "entry\n" });
    const runRoot = mkTmp("vmreap-entry-runs-");
    writeOrphanVm(
      {
        vmId: VM_DEAD,
        matchlockHome: home,
        invocationId: "inv-entry-1",
        phase: "close",
        error: "matchlock error [phase=close] name=MatchlockRpcError; code=-32000; message=boom",
      },
      { runId: RUN, runRoot, onLog: () => {} },
    );

    const recordPath = path.join(tmpRoot, "record-entry.jsonl");
    // NOTE: no explicit matchlockHome — it is derived from the orphan record,
    // exactly as the scheduler teardown hook calls it.
    const result = reapOrphanedMatchlockVms({
      runId: RUN,
      runRoot,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: () => false,
      onLog: () => {},
    });

    assert.equal(result.homes.length, 1);
    assert.equal(result.homes[0], path.resolve(home));
    assert.equal(result.eligible, 1);
    assert.deepEqual(
      result.results.map((r) => ({ vmId: r.vmId, action: r.action })),
      [{ vmId: VM_DEAD, action: "removed" }],
    );
    const records = readRecords(recordPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].argv, ["rm", VM_DEAD]);
    assert.equal(records[0].home, home, "HOME is forced to the derived matchlock home");
    // The record was cleared after the confirmed removal.
    assert.deepEqual(readOrphanVms({ runId: RUN, runRoot, onLog: () => {} }), []);
    assert.equal(fs.existsSync(path.join(home, ".matchlock", "vms", VM_DEAD)), false);
  });

  it("US-007 run-teardown mode is a no-op with no orphan records and never touches an unrelated stopped VM", () => {
    const home = path.join(mkTmp("vmreap-entry-noop-"), "h");
    makeStateDb(home, [{ id: VM_DEAD, pid: 0, status: "stopped" }]);
    const { vmDir } = makeVm(home, VM_DEAD, { "logs/unrelated.log": "x\n" });
    const runRoot = mkTmp("vmreap-entry-noop-runs-");
    const recordPath = path.join(tmpRoot, "record-entry-noop.jsonl");

    const result = reapOrphanedMatchlockVms({
      runId: RUN,
      runRoot,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: () => false,
      onLog: () => {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.homes, [], "no orphan record means no home is even opened");
    assert.equal(result.scanned, 0);
    assert.equal(result.eligible, 0);
    assert.deepEqual(result.results, []);
    assert.ok(
      result.diagnostics.some((d) => /no recorded orphan VMs/.test(d)),
      "the no-op is diagnosed",
    );
    assert.equal(fs.existsSync(recordPath), false, "no rm child may spawn for a run with no orphans");
    assert.equal(fs.existsSync(vmDir), true, "an unrelated stopped VM must never be touched");
  });

  it("US-007 run-teardown mode never touches a live-pid orphan VM and retains its record", () => {
    const home = path.join(mkTmp("vmreap-entry-live-"), "h");
    makeStateDb(home, [{ id: VM_LIVE, pid: 777, status: "stopped" }]);
    const { vmDir } = makeVm(home, VM_LIVE, { "logs/live.log": "live\n" });
    const runRoot = mkTmp("vmreap-entry-live-runs-");
    writeOrphanVm(
      {
        vmId: VM_LIVE,
        matchlockHome: home,
        invocationId: "inv-entry-live",
        phase: "dispose",
        error: "boom",
      },
      { runId: RUN, runRoot, onLog: () => {} },
    );
    const recordPath = path.join(tmpRoot, "record-entry-live.jsonl");

    const result = reapOrphanedMatchlockVms({
      runId: RUN,
      runRoot,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: (pid) => pid === 777,
      onLog: () => {},
    });

    assert.equal(result.eligible, 0);
    assert.deepEqual(
      result.results.map((r) => ({ vmId: r.vmId, action: r.action })),
      [{ vmId: VM_LIVE, action: "skipped-live" }],
    );
    assert.equal(fs.existsSync(recordPath), false, "a live VM is never passed to rm");
    assert.equal(fs.existsSync(vmDir), true);
    assert.equal(
      readOrphanVms({ runId: RUN, runRoot, onLog: () => {} }).length,
      1,
      "a live VM keeps its orphan record for a later pass",
    );
  });

  it("US-007 operator/gate mode reaps exactly the explicit matchlockHome + vmIds", () => {
    const home = path.join(mkTmp("vmreap-entry-operator-"), "h");
    const other = "vm-f9377c28";
    makeStateDb(home, [
      { id: VM_DEAD, pid: 0, status: "stopped" },
      { id: other, pid: 0, status: "stopped" },
    ]);
    makeVm(home, VM_DEAD, { "logs/a.log": "a\n" });
    const { vmDir: otherDir } = makeVm(home, other, { "logs/b.log": "b\n" });
    const recordPath = path.join(tmpRoot, "record-entry-operator.jsonl");

    const result = reapOrphanedMatchlockVms({
      matchlockHome: home,
      vmIds: [VM_DEAD],
      cliBinaryPath: fakeCli,
      evidenceBaseDir: path.join(tmpRoot, "evidence-entry-operator"),
      env: { FAKE_RECORD: recordPath },
      isProcessAlive: () => false,
      onLog: () => {},
    });

    assert.deepEqual(result.homes, [path.resolve(home)]);
    assert.equal(result.eligible, 1);
    assert.deepEqual(result.results.map((r) => r.vmId), [VM_DEAD]);
    const records = readRecords(recordPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].argv, ["rm", VM_DEAD]);
    assert.equal(fs.existsSync(otherDir), true, "an unnamed VM must never be touched");
    assert.equal(fs.existsSync(path.join(home, ".matchlock", "vms", VM_DEAD)), false);
  });

  it("US-007 entry point never throws for an unsafe run id, empty options or a missing home", () => {
    // Unsafe run id: the store refuses, but the entry point degrades to a
    // bounded diagnostic instead of throwing.
    let unsafe: ReturnType<typeof reapOrphanedMatchlockVms> | null = null;
    assert.doesNotThrow(() => {
      unsafe = reapOrphanedMatchlockVms({ runId: "not-a-uuid", onLog: () => {} });
    });
    assert.ok(unsafe !== null);
    assert.deepEqual(unsafe!.results, []);
    assert.ok(unsafe!.diagnostics.length >= 1);

    // No home, no run context: bounded no-op, never a throw.
    let empty: ReturnType<typeof reapOrphanedMatchlockVms> | null = null;
    assert.doesNotThrow(() => {
      empty = reapOrphanedMatchlockVms({ onLog: () => {} });
    });
    assert.ok(empty !== null);
    assert.deepEqual(empty!.results, []);
    assert.ok(empty!.diagnostics.some((d) => /matchlockHome is required/.test(d)));
  });
});
