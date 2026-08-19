/**
 * Unit tests for the daemon-lifecycle status surface
 * (formatDaemonLifecycle / collectDaemonLifecycle in src/cli/status-format.ts).
 *
 * Covers:
 * - 'No recorded daemon deaths.' when no death entry exists (DI + seeded log)
 * - clean-death line with kind, ts, pid, signal
 * - unclean-death line with a visually distinct '[UNSEEN]' marker when the
 *   death ts is newer than lifecycle-seen.json, and without '[UNSEEN]' on the
 *   next call after lifecycle-seen.json was written (acknowledgment)
 * - collectDaemonLifecycle returns { lastDaemonDeath: ... | null } with
 *   unseen=true for a fresh unclean exit and never modifies lifecycle-seen.json
 * - test-isolation guard: no production state is read or written when guarded
 *
 * Serial lane: importing dist/cli/status-format.js reaches node:child_process
 * (listed in tests/serial-files.txt).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import {
  collectDaemonLifecycle,
  formatDaemonLifecycle,
} from "../../dist/cli/status-format.js";
import { getLifecycleSeenPath } from "../../dist/server/daemon-lifecycle.js";
import type { DaemonDeath } from "../../dist/server/daemon-lifecycle.js";

// ── Journal seeding helpers ──────────────────────────────────────────

function appendJournalEntry(opts: { homeDir: string }, entry: Record<string, unknown>): void {
  const log = path.join(opts.homeDir, ".tamandua", "lifecycle.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify(entry) + "\n", "utf-8");
}

function seedCleanDeath(opts: { homeDir: string }, ts: string, pid: number, signal = "SIGTERM"): void {
  appendJournalEntry(opts, {
    ts,
    action: "daemon.shutdown",
    targetPid: pid,
    signal,
    exitCode: 0,
  });
}

function seedUncleanDeath(
  opts: { homeDir: string },
  ts: string,
  pid: number,
  lastHeartbeatAgeMs = 5000,
): void {
  appendJournalEntry(opts, {
    ts,
    action: "daemon.uncleanExit",
    targetPid: pid,
    priorPid: pid,
    startedAt: new Date(Date.parse(ts) - 60_000).toISOString(),
    lastHeartbeatAt: new Date(Date.parse(ts) - lastHeartbeatAgeMs).toISOString(),
    lastHeartbeatAgeMs,
  });
}

function readSeenFile(opts: { homeDir: string }): { ts: string } | null {
  const file = getLifecycleSeenPath(opts);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as { ts: string };
}

// ── formatDaemonLifecycle ────────────────────────────────────────────

describe("formatDaemonLifecycle", () => {
  it("prints 'No recorded daemon deaths.' when no death entry exists (DI)", () => {
    assert.equal(
      formatDaemonLifecycle({ getLastDaemonDeath: () => null }),
      "Daemon Lifecycle\n----------------\nNo recorded daemon deaths.",
    );
  });

  it("prints 'No recorded daemon deaths.' when lifecycle.log has no death entries", () => {
    const th = createTempHome("tamandua-dl-");
    assert.equal(
      formatDaemonLifecycle({ homeDir: th.homeDir }),
      "Daemon Lifecycle\n----------------\nNo recorded daemon deaths.",
    );
  });

  it("prints a clean-death line with kind, ts, pid, and signal", () => {
    const th = createTempHome("tamandua-dl-");
    const ts = new Date(Date.now() - 60_000).toISOString();
    seedCleanDeath(th, ts, 4242, "SIGINT");

    const out = formatDaemonLifecycle({ homeDir: th.homeDir });
    assert.match(out, /Daemon Lifecycle/);
    assert.match(out, /Last daemon exit: clean at /);
    assert.ok(out.includes(ts), "clean line must include the death ts");
    assert.ok(out.includes("pid 4242"), "clean line must include the pid");
    assert.ok(out.includes("signal SIGINT"), "clean line must include the signal");
    assert.ok(!out.includes("UNCLEAN"), "clean line must not mention UNCLEAN");
  });

  it("prints an unclean-death line with '[UNSEEN]' when lifecycle-seen.json is absent, and acknowledges", () => {
    const th = createTempHome("tamandua-dl-");
    const ts = new Date(Date.now() - 30_000).toISOString();
    seedUncleanDeath(th, ts, 5150, 7000);

    const out = formatDaemonLifecycle({ homeDir: th.homeDir });
    assert.match(out, /Daemon Lifecycle/);
    assert.match(out, /Last daemon exit: UNCLEAN \[UNSEEN\] at /);
    assert.ok(out.includes(ts), "unclean line must include the death ts");
    assert.ok(out.includes("prior pid 5150"), "unclean line must include the prior pid");
    assert.ok(out.includes("last heartbeat 7s ago"), "unclean line must include the heartbeat age in seconds");

    // Rendering the text section acknowledges: lifecycle-seen.json now holds the death ts.
    const seen = readSeenFile(th);
    assert.ok(seen, "lifecycle-seen.json must be written after rendering an unseen unclean death");
    assert.equal(seen!.ts, ts, "acknowledged ts must equal the surfaced death ts");
  });

  it("drops '[UNSEEN]' on the next call after lifecycle-seen.json was written", () => {
    const th = createTempHome("tamandua-dl-");
    const ts = new Date(Date.now() - 30_000).toISOString();
    seedUncleanDeath(th, ts, 5150);

    const first = formatDaemonLifecycle({ homeDir: th.homeDir });
    assert.ok(first.includes("[UNSEEN]"), "first render must flag the death as unseen");

    const second = formatDaemonLifecycle({ homeDir: th.homeDir });
    assert.ok(!second.includes("[UNSEEN]"), "second render must show the death as seen");
    assert.match(second, /Last daemon exit: UNCLEAN at /);
  });

  it("prints no '[UNSEEN]' when lifecycle-seen.json already holds an equal ts", () => {
    const th = createTempHome("tamandua-dl-");
    const ts = new Date(Date.now() - 30_000).toISOString();
    seedUncleanDeath(th, ts, 5150);
    fs.mkdirSync(th.tamanduaDir, { recursive: true });
    fs.writeFileSync(getLifecycleSeenPath(th), JSON.stringify({ ts }), "utf-8");

    const out = formatDaemonLifecycle({ homeDir: th.homeDir });
    assert.ok(!out.includes("[UNSEEN]"), "an acknowledged death must not be flagged unseen");
    assert.match(out, /Last daemon exit: UNCLEAN at /);
  });

  it("prints no '[UNSEEN]' when lifecycle-seen.json holds a newer ts and does not rewrite it", () => {
    const th = createTempHome("tamandua-dl-");
    const deathTs = new Date(Date.now() - 60_000).toISOString();
    const seenTs = new Date(Date.now() - 10_000).toISOString();
    seedUncleanDeath(th, deathTs, 5150);
    fs.mkdirSync(th.tamanduaDir, { recursive: true });
    fs.writeFileSync(getLifecycleSeenPath(th), JSON.stringify({ ts: seenTs }), "utf-8");

    const out = formatDaemonLifecycle({ homeDir: th.homeDir });
    assert.ok(!out.includes("[UNSEEN]"), "a death older than the acknowledged ts must be seen");
    assert.equal(readSeenFile(th)!.ts, seenTs, "a seen death must not rewrite lifecycle-seen.json");
  });

  it("uses the injected reader and renders an unclean death with a default age when age is missing", () => {
    const death: DaemonDeath = {
      kind: "unclean",
      ts: new Date(Date.now() - 5000).toISOString(),
      pid: 777,
      priorPid: 777,
    };
    const out = formatDaemonLifecycle({ getLastDaemonDeath: () => death });
    assert.ok(out.includes("[UNSEEN]"), "a fresh injected unclean death must be unseen");
    assert.ok(out.includes("last heartbeat 0s ago"), "missing age must fall back to 0s");
  });
});

// ── collectDaemonLifecycle ───────────────────────────────────────────

describe("collectDaemonLifecycle", () => {
  it("returns { lastDaemonDeath: null } when no death entry exists", () => {
    assert.deepEqual(collectDaemonLifecycle({ getLastDaemonDeath: () => null }), {
      lastDaemonDeath: null,
    });
    const th = createTempHome("tamandua-dl-");
    assert.deepEqual(collectDaemonLifecycle({ homeDir: th.homeDir }), {
      lastDaemonDeath: null,
    });
  });

  it("returns unseen=true for a fresh unclean exit and does not modify lifecycle-seen.json", () => {
    const th = createTempHome("tamandua-dl-");
    const ts = new Date(Date.now() - 30_000).toISOString();
    seedUncleanDeath(th, ts, 5150, 9000);

    const result = collectDaemonLifecycle({ homeDir: th.homeDir });
    assert.ok(result.lastDaemonDeath, "an unclean death must be returned");
    assert.equal(result.lastDaemonDeath!.kind, "unclean");
    assert.equal(result.lastDaemonDeath!.ts, ts);
    assert.equal(result.lastDaemonDeath!.pid, 5150);
    assert.equal(result.lastDaemonDeath!.priorPid, 5150);
    assert.equal(result.lastDaemonDeath!.lastHeartbeatAgeMs, 9000);
    assert.equal(result.lastDaemonDeath!.unseen, true, "a fresh unclean exit must be unseen");

    assert.ok(
      !fs.existsSync(getLifecycleSeenPath(th)),
      "--json-style collection must NOT acknowledge (must not write lifecycle-seen.json)",
    );
  });

  it("returns unseen=false for a clean death and carries signal", () => {
    const th = createTempHome("tamandua-dl-");
    const ts = new Date(Date.now() - 60_000).toISOString();
    seedCleanDeath(th, ts, 4242, "SIGTERM");

    const result = collectDaemonLifecycle({ homeDir: th.homeDir });
    assert.ok(result.lastDaemonDeath, "a clean death must be returned");
    assert.equal(result.lastDaemonDeath!.kind, "clean");
    assert.equal(result.lastDaemonDeath!.ts, ts);
    assert.equal(result.lastDaemonDeath!.pid, 4242);
    assert.equal(result.lastDaemonDeath!.signal, "SIGTERM");
    assert.equal(result.lastDaemonDeath!.unseen, false, "clean deaths are never unseen");
  });

  it("returns unseen=false when the unclean death ts is not newer than lifecycle-seen.json", () => {
    const th = createTempHome("tamandua-dl-");
    const deathTs = new Date(Date.now() - 60_000).toISOString();
    const seenTs = new Date(Date.now() - 10_000).toISOString();
    seedUncleanDeath(th, deathTs, 5150);
    fs.mkdirSync(th.tamanduaDir, { recursive: true });
    fs.writeFileSync(getLifecycleSeenPath(th), JSON.stringify({ ts: seenTs }), "utf-8");

    const result = collectDaemonLifecycle({ homeDir: th.homeDir });
    assert.equal(result.lastDaemonDeath!.unseen, false, "acknowledged unclean death must be seen");
    assert.equal(
      readSeenFile(th)!.ts,
      seenTs,
      "collection must not overwrite the acknowledged ts",
    );
  });
});

// ── Test-isolation guard ─────────────────────────────────────────────
//
// With TAMANDUA_TEST_GUARD=1 and HOME pointing at the real user home, the
// status lifecycle surface must neither read nor write production state and
// must not throw (logger-style guard: drop, don't crash).

describe("daemon-lifecycle status surface test-guard", { concurrency: 1 }, () => {
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;
  let savedGuard: string | undefined;
  let savedNodeTestContext: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedGuard = process.env.TAMANDUA_TEST_GUARD;
    savedNodeTestContext = process.env.NODE_TEST_CONTEXT;

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

  it("formatDaemonLifecycle and collectDaemonLifecycle are no-ops under guard with real HOME", () => {
    const realSeen = path.join(os.userInfo().homedir, ".tamandua", "lifecycle-seen.json");
    const existedBefore = fs.existsSync(realSeen);

    assert.doesNotThrow(() => formatDaemonLifecycle(), "guarded format must not throw");
    assert.doesNotThrow(() => collectDaemonLifecycle(), "guarded collect must not throw");
    assert.equal(
      formatDaemonLifecycle(),
      "Daemon Lifecycle\n----------------\nNo recorded daemon deaths.",
      "guarded format must not read production lifecycle.log",
    );
    assert.deepEqual(collectDaemonLifecycle(), { lastDaemonDeath: null });

    if (!existedBefore) {
      assert.ok(
        !fs.existsSync(realSeen),
        "guarded rendering must not write the production lifecycle-seen.json",
      );
    }
  });
});
