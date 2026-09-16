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
  DAEMON_LIFECYCLE_INSTANT_TOLERANCE_MS,
  HEARTBEAT_INTERVAL_DEFAULT_MS,
  computeConfigFingerprint,
  detectUncleanExit,
  finalizeHeartbeatMarker,
  getHeartbeatIntervalMs,
  getHeartbeatPath,
  getLastDaemonDeath,
  getLifecycleSeenPath,
  isUnseenDaemonDeath,
  readHeartbeatMarker,
  touchHeartbeat,
  writeHeartbeatMarker,
} from "../../dist/server/daemon-lifecycle.js";
import type { DaemonDeath } from "../../dist/server/daemon-lifecycle.js";

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

/** Legacy SQLite naive UTC shape: `YYYY-MM-DD HH:MM:SS` (no zone, no ms). */
function naiveUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
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

  // ── US-007: lifecycle journal/marker instants go through parseInstant ──

  it("detectUncleanExit treats a naive UTC marker.startedAt as UTC (US-007)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAtMs = Date.now() - 60_000;
    seedMarker(opts, pid, naiveUtc(startedAtMs), new Date(startedAtMs).toISOString());
    // A shutdown 60s BEFORE the true marker start must not account for it.
    appendJournalEntry(opts, {
      ts: new Date(startedAtMs - 60_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: pid,
    });

    const facts = detectUncleanExit(opts);
    assert.ok(
      facts,
      "a shutdown before the naive-UTC startedAt must not count as a clean exit",
    );
    assert.equal(facts!.priorPid, pid);
  });

  it("detectUncleanExit accounts for a shutdown after a naive UTC marker.startedAt (US-007)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAtMs = Date.now() - 60_000;
    seedMarker(opts, pid, naiveUtc(startedAtMs), new Date(startedAtMs).toISOString());
    // A shutdown 30s AFTER the true marker start accounts for it (clean exit).
    appendJournalEntry(opts, {
      ts: new Date(startedAtMs + 30_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: pid,
    });

    assert.equal(
      detectUncleanExit(opts),
      null,
      "a shutdown after the naive-UTC startedAt must suppress unclean detection",
    );
    assert.ok(
      !readJournal(opts).some((entry) => entry.action === "daemon.uncleanExit"),
      "no uncleanExit entry may be journaled for an accounted marker",
    );
  });

  it("detectUncleanExit honors a real offset in marker and journal timestamps (US-007)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAtMs = Date.now() - 60_000;
    const offsetStartedAt = new Date(startedAtMs).toISOString().replace("Z", "+00:00");
    seedMarker(opts, pid, offsetStartedAt, new Date(startedAtMs).toISOString());
    appendJournalEntry(opts, {
      ts: new Date(startedAtMs + 1_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: pid,
    });

    assert.equal(detectUncleanExit(opts), null);
  });

  it("getLastDaemonDeath orders a newer naive UTC ts as UTC (US-007)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 120_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: 111,
      signal: "SIGTERM",
    });
    appendJournalEntry(opts, {
      ts: naiveUtc(Date.now() - 30_000),
      action: "daemon.shutdown",
      targetPid: 222,
      signal: "SIGINT",
    });

    const death = getLastDaemonDeath(opts);
    assert.ok(death);
    assert.equal(death!.pid, 222, "the truly-newer naive-UTC death must win");
  });

  it("getLastDaemonDeath orders an older naive UTC ts as UTC (US-007)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    appendJournalEntry(opts, {
      ts: naiveUtc(Date.now() - 120_000),
      action: "daemon.shutdown",
      targetPid: 111,
      signal: "SIGTERM",
    });
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 30_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: 222,
      signal: "SIGINT",
    });

    const death = getLastDaemonDeath(opts);
    assert.ok(death);
    assert.equal(death!.pid, 222, "the ISO-Z (truly newer) death must win");
  });

  it("getLastDaemonDeath ignores death entries with an unparseable ts (US-007)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    appendJournalEntry(opts, { ts: "not-a-timestamp", action: "daemon.shutdown", targetPid: 111 });
    appendJournalEntry(opts, { ts: "", action: "daemon.uncleanExit", targetPid: 222 });
    appendJournalEntry(opts, {
      ts: new Date(Date.now() - 60_000).toISOString(),
      action: "daemon.shutdown",
      targetPid: 333,
      signal: "SIGTERM",
    });

    const death = getLastDaemonDeath(opts);
    assert.ok(death);
    assert.equal(death!.pid, 333, "the only parseable death must win");
  });

  it("getLastDaemonDeath returns null when every death ts is unparseable (US-007)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    appendJournalEntry(opts, { ts: "nope", action: "daemon.shutdown", targetPid: 111 });
    assert.equal(getLastDaemonDeath(opts), null);
  });
});

// ── Durable-instant comparisons (US-009) ─────────────────────────────
//
// Heartbeat / death instants survive restarts, so their ages are numeric
// comparisons against the wall clock via the shared instantAgeMs/isOlderThan
// helpers, with an explicit documented tolerance. These tests drive the
// comparison with an injected Date.now and with unparseable instants.

describe("daemon-lifecycle durable-instant comparisons (US-009)", () => {
  it("clamps an unparseable heartbeat instant to age 0 instead of fabricating an age", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    seedMarker(opts, pid, new Date(Date.now() - 60_000).toISOString(), "not-a-timestamp");

    const facts = detectUncleanExit(opts);
    assert.ok(facts, "a stale marker with an unparseable heartbeat must still be detected");
    assert.equal(
      facts!.lastHeartbeatAgeMs,
      0,
      "an unknown heartbeat instant must not fabricate an age",
    );

    const ue = readJournal(opts).find((entry) => entry.action === "daemon.uncleanExit");
    assert.ok(ue, "the unclean exit must be journaled");
    assert.equal(ue!.lastHeartbeatAgeMs, 0);
  });

  it("computes the heartbeat age numerically from the wall clock (forward jump grows, backward clamps)", () => {
    const realNow = Date.now();
    const realDateNow = Date.now;
    const pid = 4242;

    const forwardHome = createTempHome("tamandua-ue-");
    const forwardOpts = { homeDir: forwardHome.homeDir };
    seedMarker(
      forwardOpts,
      pid,
      new Date(realNow - 60_000).toISOString(),
      new Date(realNow - 5_000).toISOString(),
    );
    try {
      Date.now = () => realNow + 3_600_000;
      const forward = detectUncleanExit(forwardOpts);
      assert.ok(forward);
      assert.equal(forward!.lastHeartbeatAgeMs, 3_605_000);
    } finally {
      Date.now = realDateNow;
    }

    const backwardHome = createTempHome("tamandua-ue-");
    const backwardOpts = { homeDir: backwardHome.homeDir };
    seedMarker(
      backwardOpts,
      pid,
      new Date(realNow - 60_000).toISOString(),
      new Date(realNow + 5_000).toISOString(),
    );
    try {
      Date.now = () => realNow;
      const backward = detectUncleanExit(backwardOpts);
      assert.ok(backward);
      assert.equal(
        backward!.lastHeartbeatAgeMs,
        0,
        "a future heartbeat must clamp to 0, never negative",
      );
    } finally {
      Date.now = realDateNow;
    }
  });

  it("accounts for a journal entry at the marker start within the documented tolerance", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAtMs = Date.now() - 60_000;
    seedMarker(opts, pid, new Date(startedAtMs).toISOString(), new Date(startedAtMs).toISOString());
    appendJournalEntry(opts, {
      ts: new Date(startedAtMs - 500).toISOString(), // inside the 1s tolerance
      action: "daemon.shutdown",
      targetPid: pid,
    });

    assert.equal(detectUncleanExit(opts), null, "an entry just before the start must still account");
  });

  it("does not account for a journal entry older than the marker start beyond tolerance", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAtMs = Date.now() - 60_000;
    seedMarker(opts, pid, new Date(startedAtMs).toISOString(), new Date(startedAtMs).toISOString());
    appendJournalEntry(opts, {
      ts: new Date(startedAtMs - (DAEMON_LIFECYCLE_INSTANT_TOLERANCE_MS + 5_000)).toISOString(),
      action: "daemon.shutdown",
      targetPid: pid,
    });

    const facts = detectUncleanExit(opts);
    assert.ok(facts, "a shutdown before the start beyond tolerance must not count as clean");
    assert.equal(facts!.priorPid, pid);
  });

  it("never lets an unparseable journal ts account for a death", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const pid = 4242;
    const startedAtMs = Date.now() - 60_000;
    seedMarker(opts, pid, new Date(startedAtMs).toISOString(), new Date(startedAtMs).toISOString());
    appendJournalEntry(opts, {
      ts: "not-a-timestamp",
      action: "daemon.shutdown",
      targetPid: pid,
    });

    const facts = detectUncleanExit(opts);
    assert.ok(facts, "an unknown journal ts must never account for the marker");
    assert.equal(facts!.priorPid, pid);
  });
});

describe("isUnseenDaemonDeath durable-instant comparison (US-009)", () => {
  function uncleanDeath(ts: string): DaemonDeath {
    return { kind: "unclean", ts, pid: 999, priorPid: 999 };
  }

  function seedSeen(opts: { homeDir: string }, ts: string): void {
    const file = getLifecycleSeenPath(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts }), "utf-8");
  }

  it("treats a death newer than the acknowledged ts beyond tolerance as unseen", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const deathTs = Date.now() - 10_000;
    seedSeen(
      opts,
      new Date(deathTs - (DAEMON_LIFECYCLE_INSTANT_TOLERANCE_MS + 5_000)).toISOString(),
    );
    assert.equal(isUnseenDaemonDeath(uncleanDeath(new Date(deathTs).toISOString()), opts), true);
  });

  it("suppresses a re-alert for a death only slightly newer than the acknowledged ts", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const deathTs = Date.now() - 10_000;
    // Acknowledged 500ms BEFORE the death: newer by less than the 1s tolerance
    // -> treated as already seen, so a same-second re-death does not re-alert.
    seedSeen(opts, new Date(deathTs - 500).toISOString());
    assert.equal(isUnseenDaemonDeath(uncleanDeath(new Date(deathTs).toISOString()), opts), false);
  });

  it("treats an equal acknowledged ts as seen and a clean death as never unseen", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    const ts = new Date(Date.now() - 10_000).toISOString();
    seedSeen(opts, ts);
    assert.equal(isUnseenDaemonDeath(uncleanDeath(ts), opts), false);
    assert.equal(
      isUnseenDaemonDeath({ kind: "clean", ts, pid: 1 }, opts),
      false,
      "clean deaths are never unseen",
    );
  });

  it("treats an unparseable acknowledged ts as unseen (cannot prove acknowledgment)", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    seedSeen(opts, "garbage");
    assert.equal(isUnseenDaemonDeath(uncleanDeath(new Date().toISOString()), opts), true);
  });

  it("flags an unclean death as unseen when nothing has been acknowledged", () => {
    const th = createTempHome("tamandua-ue-");
    const opts = { homeDir: th.homeDir };
    assert.equal(isUnseenDaemonDeath(uncleanDeath(new Date().toISOString()), opts), true);
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
  let savedExpect: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedGuard = process.env.TAMANDUA_TEST_GUARD;
    savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
    savedExpect = process.env.TAMANDUA_TEST_GUARD_EXPECT;

    // Activate the guard and force path resolution into the production state
    // dir (the guard compares against os.userInfo().homedir, not os.homedir()).
    process.env.TAMANDUA_TEST_GUARD = "1";
    process.env.HOME = os.userInfo().homedir;
    delete process.env.TAMANDUA_STATE_DIR;
    // Every test in this describe deliberately provokes the guard (or uses an
    // explicit homeDir). No real leaks here — mark the describe expected.
    process.env.TAMANDUA_TEST_GUARD_EXPECT = "1";
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
    if (savedExpect !== undefined) process.env.TAMANDUA_TEST_GUARD_EXPECT = savedExpect;
    else delete process.env.TAMANDUA_TEST_GUARD_EXPECT;
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
