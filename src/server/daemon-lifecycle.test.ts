/**
 * Unit tests for the daemon heartbeat marker module
 * (src/server/daemon-lifecycle.ts).
 *
 * Pure-logic tests: no child_process imports, no daemon spawns, no
 * process-spawning source dependencies — parallel lane.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import {
  HEARTBEAT_INTERVAL_DEFAULT_MS,
  computeConfigFingerprint,
  detectUncleanExit,
  finalizeHeartbeatMarker,
  getHeartbeatIntervalMs,
  getHeartbeatPath,
  getLastDaemonDeath,
  readHeartbeatMarker,
  touchHeartbeat,
  writeHeartbeatMarker,
} from "../../dist/server/daemon-lifecycle.js";

describe("daemon heartbeat marker module", () => {
  it("exports the required API surface", () => {
    assert.equal(typeof getHeartbeatPath, "function");
    assert.equal(typeof writeHeartbeatMarker, "function");
    assert.equal(typeof readHeartbeatMarker, "function");
    assert.equal(typeof touchHeartbeat, "function");
    assert.equal(typeof finalizeHeartbeatMarker, "function");
    assert.equal(typeof computeConfigFingerprint, "function");
    assert.equal(typeof getHeartbeatIntervalMs, "function");
    assert.equal(HEARTBEAT_INTERVAL_DEFAULT_MS, 10_000);
  });

  it("getHeartbeatPath resolves under <homeDir>/.tamandua", () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };
    assert.equal(
      getHeartbeatPath(opts),
      path.join(th.homeDir, ".tamandua", "daemon-heartbeat.json"),
    );
  });

  it("writeHeartbeatMarker then readHeartbeatMarker round-trips pid, startedAt, lastHeartbeatAt", () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };

    writeHeartbeatMarker(opts);
    const marker = readHeartbeatMarker(opts);
    assert.ok(marker, "marker should be readable after write");
    assert.equal(marker.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(marker.startedAt)), "startedAt must be an ISO timestamp");
    assert.ok(!Number.isNaN(Date.parse(marker.lastHeartbeatAt)), "lastHeartbeatAt must be an ISO timestamp");
    assert.equal(marker.startedAt, marker.lastHeartbeatAt, "fresh marker starts with lastHeartbeatAt == startedAt");

    // The marker must be a single tiny line.
    const raw = fs.readFileSync(getHeartbeatPath(opts), "utf-8");
    assert.ok(!raw.includes("\n"), "marker file must be a single line");
    assert.ok(JSON.parse(raw).pid === process.pid, "marker file must parse as JSON");
  });

  it("touchHeartbeat updates lastHeartbeatAt and preserves pid and startedAt", async () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };

    writeHeartbeatMarker(opts);
    const before = readHeartbeatMarker(opts)!;
    await new Promise((resolve) => setTimeout(resolve, 30));
    touchHeartbeat(opts);

    const after = readHeartbeatMarker(opts)!;
    assert.equal(after.pid, before.pid, "touch must preserve pid");
    assert.equal(after.startedAt, before.startedAt, "touch must preserve startedAt");
    assert.ok(
      Date.parse(after.lastHeartbeatAt) > Date.parse(before.lastHeartbeatAt),
      "touch must advance lastHeartbeatAt",
    );
  });

  it("touchHeartbeat is a no-op when no marker exists", () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };
    assert.doesNotThrow(() => touchHeartbeat(opts));
    assert.equal(readHeartbeatMarker(opts), null, "touch must not create a marker");
  });

  it("finalizeHeartbeatMarker removes the marker file and is idempotent", () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };

    writeHeartbeatMarker(opts);
    assert.ok(fs.existsSync(getHeartbeatPath(opts)), "marker should exist after write");
    assert.doesNotThrow(() => finalizeHeartbeatMarker(opts));
    assert.ok(!fs.existsSync(getHeartbeatPath(opts)), "marker should be removed after finalize");
    assert.doesNotThrow(() => finalizeHeartbeatMarker(opts), "finalize must be idempotent");
    assert.equal(readHeartbeatMarker(opts), null, "no marker after finalize");
  });

  it("readHeartbeatMarker returns null for a missing marker file", () => {
    const th = createTempHome("tamandua-hb-");
    assert.equal(readHeartbeatMarker({ homeDir: th.homeDir }), null);
  });

  it("readHeartbeatMarker returns null for a corrupt marker file", () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };
    const markerPath = getHeartbeatPath(opts);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });

    const corruptContents = [
      "not-json{{{", // unparseable
      "", // empty
      "   \n  ", // whitespace only
      JSON.stringify({ foo: 1 }), // wrong shape
      JSON.stringify({ pid: "not-a-number", startedAt: "x", lastHeartbeatAt: "y" }), // wrong types
      JSON.stringify({ pid: 1, startedAt: "x" }), // missing lastHeartbeatAt
    ];
    for (const content of corruptContents) {
      fs.writeFileSync(markerPath, content, "utf-8");
      assert.equal(readHeartbeatMarker(opts), null, `should return null for corrupt marker: ${JSON.stringify(content)}`);
    }
  });

  it("getHeartbeatIntervalMs returns 10000 by default", () => {
    const prev = process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS;
    delete process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS;
    try {
      assert.equal(getHeartbeatIntervalMs(), 10_000);
      assert.equal(getHeartbeatIntervalMs(), HEARTBEAT_INTERVAL_DEFAULT_MS);
    } finally {
      if (prev === undefined) delete process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS;
      else process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS = prev;
    }
  });

  it("getHeartbeatIntervalMs honors a TAMANDUA_HEARTBEAT_INTERVAL_MS override", () => {
    const prev = process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS;
    try {
      process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS = "100";
      assert.equal(getHeartbeatIntervalMs(), 100);
    } finally {
      if (prev === undefined) delete process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS;
      else process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS = prev;
    }
  });

  it("getHeartbeatIntervalMs falls back to the default for invalid overrides", () => {
    const prev = process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS;
    try {
      for (const bad of ["0", "-100", "1.5", "abc", "  ", "NaN"]) {
        process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS = bad;
        assert.equal(
          getHeartbeatIntervalMs(),
          HEARTBEAT_INTERVAL_DEFAULT_MS,
          `invalid override ${JSON.stringify(bad)} must fall back to the default`,
        );
      }
    } finally {
      if (prev === undefined) delete process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS;
      else process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS = prev;
    }
  });

  it("computeConfigFingerprint returns a sha256 hex for a seeded agents.json", () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };
    const content = JSON.stringify({ agents: [{ id: "wf-demo", role: "developer" }] });
    fs.writeFileSync(path.join(th.tamanduaDir, "agents.json"), content, "utf-8");

    const expected = crypto.createHash("sha256").update(content, "utf-8").digest("hex");
    assert.equal(computeConfigFingerprint(opts), expected);
    assert.match(computeConfigFingerprint(opts), /^[0-9a-f]{64}$/);
  });

  it("computeConfigFingerprint returns 'none' when agents.json is missing", () => {
    const th = createTempHome("tamandua-hb-");
    assert.equal(computeConfigFingerprint({ homeDir: th.homeDir }), "none");
  });
});

// ── Unclean-death detection ─────────────────────────────────────────
//
// detectUncleanExit pairs the heartbeat marker with lifecycle.log to prove a
// prior SIGKILL-class death; getLastDaemonDeath is the shared normalized
// reader for status/dashboard surfacing. These tests seed the marker and
// journal directly under a temp HOME (no daemon spawns — serial lane, but
// classified via the daemonctl import edge).

function seedMarker(
  opts: { homeDir: string },
  pid: number,
  startedAt: string,
  lastHeartbeatAt: string,
): void {
  const file = getHeartbeatPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, startedAt, lastHeartbeatAt }), "utf-8");
}

function appendJournalEntry(opts: { homeDir: string }, entry: Record<string, unknown>): void {
  const log = path.join(opts.homeDir, ".tamandua", "lifecycle.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify(entry) + "\n", "utf-8");
}

function readJournal(opts: { homeDir: string }): Record<string, unknown>[] {
  const log = path.join(opts.homeDir, ".tamandua", "lifecycle.log");
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("daemon unclean-exit detection", () => {
  it("detectUncleanExit returns null when the heartbeat marker is absent", () => {
    const th = createTempHome("tamandua-ue-");
    assert.equal(detectUncleanExit({ homeDir: th.homeDir }), null);
  });

  it("detectUncleanExit returns null when the heartbeat marker is finalized", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    writeHeartbeatMarker(opts);
    assert.ok(readHeartbeatMarker(opts), "marker should exist after write");
    finalizeHeartbeatMarker(opts);
    assert.equal(detectUncleanExit(opts), null);
  });

  it("detectUncleanExit returns null when a matching daemon.shutdown entry exists (targetPid === marker.pid, ts >= startedAt)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    seedMarker(opts, pid, startedAt, new Date(Date.now() - 5_000).toISOString());
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 1_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: pid,
      signal: "SIGTERM",
      exitCode: 0,
    });

    assert.equal(detectUncleanExit(opts), null);
    const entries = readJournal(opts);
    assert.ok(
      !entries.some((entry) => entry.action === "daemon.uncleanExit"),
      "a matching shutdown must suppress the uncleanExit entry",
    );
  });

  it("detectUncleanExit does not treat a shutdown before the marker's start as a clean exit", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAt = new Date().toISOString();
    seedMarker(opts, pid, startedAt, startedAt);
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 60_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: pid,
    });

    const facts = detectUncleanExit(opts);
    assert.ok(facts, "a shutdown before startedAt must not count as a clean exit");
    assert.equal(facts!.priorPid, pid);
  });

  it("detectUncleanExit with a stale unfinalized marker and no matching shutdown appends daemon.uncleanExit and returns the facts", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const lastHeartbeatAt = new Date(Date.now() - 5_000).toISOString();
    seedMarker(opts, pid, startedAt, lastHeartbeatAt);

    const facts = detectUncleanExit(opts);
    assert.ok(facts, "stale unfinalized marker with no shutdown must be detected");
    assert.equal(facts!.priorPid, pid);
    assert.equal(facts!.startedAt, startedAt);
    assert.equal(facts!.lastHeartbeatAt, lastHeartbeatAt);
    assert.ok(
      typeof facts!.lastHeartbeatAgeMs === "number" && facts!.lastHeartbeatAgeMs >= 0,
      "lastHeartbeatAgeMs must be a non-negative number",
    );

    const entries = readJournal(opts);
    const ue = entries.find((entry) => entry.action === "daemon.uncleanExit");
    assert.ok(ue, "a daemon.uncleanExit entry must be appended");
    assert.equal(ue!.targetPid, pid, "targetPid must be the prior instance's pid");
    assert.equal(ue!.priorPid, pid);
    assert.equal(ue!.startedAt, startedAt);
    assert.equal(ue!.lastHeartbeatAt, lastHeartbeatAt);
    assert.ok(
      typeof ue!.lastHeartbeatAgeMs === "number" && (ue!.lastHeartbeatAgeMs as number) >= 0,
      "journal entry must carry a non-negative lastHeartbeatAgeMs",
    );
  });

  it("detectUncleanExit is idempotent per stale marker (does not double-journal on repeat calls)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    seedMarker(opts, pid, startedAt, startedAt);

    const facts = detectUncleanExit(opts);
    assert.ok(facts, "first call must detect the unclean exit");
    // The marker is still stale (nothing removed it), but the journal now has
    // a daemon.uncleanExit for this marker's pid — re-running must return
    // null (already accounted for) instead of appending a second entry.
    assert.equal(detectUncleanExit(opts), null, "repeat detection must be a no-op");
    const entries = readJournal(opts).filter((entry) => entry.action === "daemon.uncleanExit");
    assert.equal(entries.length, 1, "daemon.uncleanExit must be journaled exactly once");
  });

  it("getLastDaemonDeath returns null when lifecycle.log has no death entries", () => {
    const th = createTempHome("tamandua-ue-");
    assert.equal(getLastDaemonDeath({ homeDir: th.homeDir }), null);
  });

  it("getLastDaemonDeath returns the most recent clean death normalized with kind and ts", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 60_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: 111,
      signal: "SIGTERM",
      exitCode: 0,
    });
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 10_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: 222,
      signal: "SIGINT",
      exitCode: 0,
    });

    const death = getLastDaemonDeath(opts);
    assert.ok(death, "a clean death must be returned");
    assert.equal(death!.kind, "clean");
    assert.equal(death!.pid, 222);
    assert.equal(death!.signal, "SIGINT");
    assert.ok(!Number.isNaN(Date.parse(death!.ts)), "death ts must be a parseable ISO timestamp");
  });

  it("getLastDaemonDeath returns an unclean death with priorPid and lastHeartbeatAgeMs", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 5_000).toISOString(),
      action: "daemon.uncleanExit",
      targetPid: 333,
      priorPid: 333,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lastHeartbeatAt: new Date(Date.now() - 5_000).toISOString(),
      lastHeartbeatAgeMs: 5000,
    });

    const death = getLastDaemonDeath(opts);
    assert.ok(death, "an unclean death must be returned");
    assert.equal(death!.kind, "unclean");
    assert.equal(death!.pid, 333);
    assert.equal(death!.priorPid, 333);
    assert.equal(death!.lastHeartbeatAgeMs, 5000);
  });

  it("getLastDaemonDeath picks the newest among mixed clean/unclean deaths", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 120_000).toISOString(),
      action: "daemon.uncleanExit",
      targetPid: 444,
      priorPid: 444,
      lastHeartbeatAgeMs: 100,
    });
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 60_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: 555,
      signal: "SIGTERM",
    });
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 30_000).toISOString(),
      action: "daemon.uncleanExit",
      targetPid: 666,
      priorPid: 666,
      lastHeartbeatAgeMs: 200,
    });

    const death = getLastDaemonDeath(opts);
    assert.ok(death, "the newest death must be returned");
    assert.equal(death!.kind, "unclean");
    assert.equal(death!.pid, 666);
    assert.equal(death!.priorPid, 666);
    assert.equal(death!.lastHeartbeatAgeMs, 200);
  });
});

// ── Test-isolation guard ─────────────────────────────────────────────
//
// With TAMANDUA_TEST_GUARD=1 and HOME pointing at the real user home, marker
// functions must never write the production heartbeat file and must not
// throw (logger-style guard: drop, don't crash).

describe("daemon heartbeat marker test-guard", { concurrency: 1 }, () => {
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;
  let savedGuard: string | undefined;
  let savedNodeTestContext: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedGuard = process.env.TAMANDUA_TEST_GUARD;
    savedNodeTestContext = process.env.NODE_TEST_CONTEXT;

    // Activate the guard and force path resolution into the production state
    // dir (the guard compares against os.userInfo().homedir, not os.homedir()).
    process.env.TAMANDUA_TEST_GUARD = "1";
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedStateDir !== undefined) process.env.TAMANDUA_STATE_DIR = savedStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    if (savedGuard !== undefined) process.env.TAMANDUA_TEST_GUARD = savedGuard;
    else delete process.env.TAMANDUA_TEST_GUARD;
    if (savedNodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
    else delete process.env.NODE_TEST_CONTEXT;
  });

  it("marker functions never write the production heartbeat file and do not throw", () => {
    const realHeartbeat = path.join(os.userInfo().homedir, ".tamandua", "daemon-heartbeat.json");
    const existedBefore = fs.existsSync(realHeartbeat);

    assert.doesNotThrow(() => writeHeartbeatMarker(), "guarded write must not throw");
    assert.doesNotThrow(() => touchHeartbeat(), "guarded touch must not throw");
    assert.doesNotThrow(() => finalizeHeartbeatMarker(), "guarded finalize must not throw");
    assert.equal(readHeartbeatMarker(), null, "guarded read must not read production state");
    assert.equal(computeConfigFingerprint(), "none", "guarded fingerprint must not read production agents.json");

    if (!existedBefore) {
      assert.ok(
        !fs.existsSync(realHeartbeat),
        "guarded write must not create the production heartbeat file",
      );
    }
  });

  it("getHeartbeatPath throws TEST ISOLATION VIOLATION under guard with real HOME", () => {
    assert.throws(
      () => getHeartbeatPath(),
      /TEST ISOLATION VIOLATION/,
      "path resolver must refuse to resolve the production heartbeat file",
    );
  });

  it("detectUncleanExit and getLastDaemonDeath are no-ops under guard with real HOME", () => {
    assert.doesNotThrow(() => detectUncleanExit(), "guarded detection must not throw");
    assert.doesNotThrow(() => getLastDaemonDeath(), "guarded death reader must not throw");
    assert.equal(detectUncleanExit(), null, "guarded detection must not read production state");
    assert.equal(getLastDaemonDeath(), null, "guarded reader must not read production state");
  });

  it("marker functions work normally with an explicit homeDir even under guard", () => {
    const th = createTempHome("tamandua-hb-");
    const opts = { homeDir: th.homeDir };

    writeHeartbeatMarker(opts);
    assert.ok(readHeartbeatMarker(opts), "explicit homeDir must bypass the guard for writes");
    touchHeartbeat(opts);
    assert.ok(fs.existsSync(getHeartbeatPath(opts)), "touch must update the isolated marker");
    finalizeHeartbeatMarker(opts);
    assert.ok(!fs.existsSync(getHeartbeatPath(opts)), "finalize must remove the isolated marker");
  });
});
