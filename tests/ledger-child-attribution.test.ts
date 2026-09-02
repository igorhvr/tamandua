/**
 * Child-process guard-ledger attribution (TISO.1 US-001 + US-002 serial
 * regressions).
 *
 * When a test spawns a tamandua child (daemon / control-standalone /
 * dashboard-standalone / mcp-standalone), the CHILD's stack has no .test.
 * frames, so its guard-ledger entries would otherwise be orphaned under
 * "(unknown)". The guard now attributes child-side violations two ways:
 *
 *  1. TAMANDUA_TEST_GUARD_TEST_FILE in the child env (merged by spawn sites
 *     via spawnChildAttributionEnv() / buildSpawnEnv()) becomes the entry's
 *     testFile — authoritative: it names the test that spawned the process.
 *  2. Every entry records the writing process's argv as a fallback so an
 *     orphan entry still names its process.
 *
 * US-001 coverage (below): a real node child provoked via a raw .mjs probe.
 * US-002 coverage (below): the daemonctl wiring layer — unit tests for the
 * exported buildSpawnEnv() helper (the single env funnel all four spawn
 * sites share) plus an end-to-end regression in which startDaemon() spawns a
 * REAL dist/server/daemon.js child under the guard; the child guard-fires on
 * the default control port 3339 and its ledger entry must name THIS test
 * file (not null / "(unknown)") and carry the child's argv.
 *
 * Spawns processes → serial lane (tests/serial-files.txt).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSpawnEnv, startDaemon, stopDaemonFamily } from "../dist/server/daemonctl.js";
import {
  createTempHome,
  cleanChildEnv,
  removeTestTempDirWithDiagnostics,
} from "./helpers/test-env.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spawnerTestFile = fileURLToPath(import.meta.url);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a JSONL guard ledger; [] when the file does not exist yet. */
function readLedgerEntries(ledgerPath: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(ledgerPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Poll a ledger until it has at least one entry or the deadline passes. */
async function waitForLedgerEntries(
  ledgerPath: string,
  deadlineMs: number,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + deadlineMs;
  let entries = readLedgerEntries(ledgerPath);
  while (entries.length === 0 && Date.now() < deadline) {
    await sleep(100);
    entries = readLedgerEntries(ledgerPath);
  }
  return entries;
}

/** Wait for a ChildProcess to exit; false on timeout. Never signals. */
async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

// ── US-001: env-var child attribution via a raw node child ─────────

describe("guard ledger child-process attribution", () => {
  it("attributes a child-side violation to TAMANDUA_TEST_GUARD_TEST_FILE and records the child's argv", () => {
    const temp = createTempHome("tamandua-ledger-attr-");
    const ledgerPath = path.join(temp.root, "ledger.jsonl");
    const childDir = path.join(temp.root, "child");
    fs.mkdirSync(childDir, { recursive: true });
    const childScriptPath = path.join(childDir, "probe.mjs");

    // Child script: (1) proves spawnChildAttributionEnv() returns {} inside
    // a child (no .test. frame), then (2) provokes a port-bind violation so
    // the guard appends an entry attributed via the env var. The child
    // catches the thrown violation and exits 0 — the ledger is the product.
    const guardDistUrl = pathToFileURL(path.join(repoRoot, "dist", "lib", "test-guard.js")).href;
    const childSource = [
      `import { assertPortIsolation, spawnChildAttributionEnv } from ${JSON.stringify(guardDistUrl)};`,
      `console.log("ATTR_ENV=" + JSON.stringify(spawnChildAttributionEnv()));`,
      `try {`,
      `  assertPortIsolation(3339, "child-ledger-probe");`,
      `  console.log("NO_THROW");`,
      `} catch (err) {`,
      `  console.log("THREW=" + (err instanceof Error ? err.message.split("\\n")[0] : String(err)));`,
      `}`,
    ].join("\n");
    fs.writeFileSync(childScriptPath, childSource, "utf-8");

    const env = cleanChildEnv({
      HOME: temp.homeDir,
      TAMANDUA_STATE_DIR: path.join(temp.homeDir, ".tamandua"),
      TAMANDUA_DB_PATH: path.join(temp.homeDir, ".tamandua", "tamandua.db"),
      // Deliberate, EXPECT-marked provocation: the child's own ledger entry
      // must be filtered by the lane report (expected:true).
      TAMANDUA_TEST_GUARD: "1",
      TAMANDUA_TEST_GUARD_LEDGER: ledgerPath,
      TAMANDUA_TEST_GUARD_EXPECT: "1",
      // The env a spawn site merges via spawnChildAttributionEnv(): names
      // THIS test file as the process's origin.
      TAMANDUA_TEST_GUARD_TEST_FILE: spawnerTestFile,
    });

    const result = spawnSync(process.execPath, [childScriptPath], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });

    assert.equal(
      result.status,
      0,
      `child probe failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );

    // No .test. frame in a child → the spawner helper injects nothing, even
    // though the guard is active (child-side env var does not feed back).
    assert.ok(
      result.stdout.includes("ATTR_ENV={}"),
      `spawnChildAttributionEnv must return {} without a .test. frame, got:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes("THREW=TEST ISOLATION VIOLATION: child-ledger-probe"),
      `child must have provoked the port-bind violation, got:\n${result.stdout}`,
    );

    const lines = fs
      .readFileSync(ledgerPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    assert.equal(lines.length, 1, "exactly one ledger entry must be written");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.kind, "port-bind");
    assert.equal(entry.path, "3339");
    assert.equal(entry.what, "child-ledger-probe");
    assert.equal(
      entry.testFile,
      spawnerTestFile,
      "child-side entry must be attributed to the spawning test file via env",
    );
    assert.equal(
      entry.testLine,
      null,
      "env attribution names the spawning test, which has no line in the child stack",
    );
    assert.equal(entry.argv, childScriptPath, "entry must carry the child's command line");
    assert.equal(entry.expected, true);
    assert.ok(Number.isInteger(entry.ts), "ts must be a timestamp");

    try {
      fs.rmSync(temp.root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
});

// ── US-002: daemonctl buildSpawnEnv (shared child-env funnel) ───────

describe("daemonctl buildSpawnEnv (child-attribution env wiring)", () => {
  const ENV_KEYS = [
    "TAMANDUA_TEST_GUARD",
    "TAMANDUA_TEST_GUARD_TEST_FILE",
  ] as const;

  function withEnvSnapshots<T>(run: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    try {
      return run();
    } finally {
      for (const key of ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("includes TAMANDUA_TEST_GUARD_TEST_FILE naming the calling test file when the guard is active", () => {
    withEnvSnapshots(() => {
      process.env.TAMANDUA_TEST_GUARD = "1";
      delete process.env.TAMANDUA_TEST_GUARD_TEST_FILE;

      const env = buildSpawnEnv({ TAMANDUA_CONTROL_PORT: "4242", HOME: "/home/fake-user" });
      assert.ok(
        env.TAMANDUA_TEST_GUARD_TEST_FILE?.includes("ledger-child-attribution.test.ts"),
        `attribution env must name the calling test file, got: ${env.TAMANDUA_TEST_GUARD_TEST_FILE}`,
      );
      assert.equal(
        env.TAMANDUA_CONTROL_PORT,
        "4242",
        "site override must be present alongside the attribution var",
      );
      assert.equal(env.HOME, "/home/fake-user", "site HOME override must win");
    });
  });

  it("is byte-identical to the plain process.env merge when the guard is inactive", () => {
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    const prevTestFile = process.env.TAMANDUA_TEST_GUARD_TEST_FILE;
    try {
      process.env.TAMANDUA_TEST_GUARD = "0";
      delete process.env.TAMANDUA_TEST_GUARD_TEST_FILE;

      const overrides = { TAMANDUA_CONTROL_PORT: "4242", HOME: "/home/fake-user" };
      const env = buildSpawnEnv(overrides);
      // The pre-change merge spread process.env then applied overrides; build
      // the expectation without that literal (test files must not spread
      // process.env — see tests/test-isolation-guard.test.ts).
      const expected = Object.assign({}, process.env, overrides);

      assert.deepEqual(
        env,
        expected,
        "guard-inactive spawn env must be byte-identical to the pre-change merge",
      );
      assert.equal(
        env.TAMANDUA_TEST_GUARD_TEST_FILE,
        undefined,
        "no attribution var may be injected when the guard is inactive",
      );
    } finally {
      // Restore the prior value (never restore-by-delete): the guard must
      // stay armed for the rest of this test process.
      if (prevGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
      else process.env.TAMANDUA_TEST_GUARD = prevGuard;
      if (prevTestFile === undefined) delete process.env.TAMANDUA_TEST_GUARD_TEST_FILE;
      else process.env.TAMANDUA_TEST_GUARD_TEST_FILE = prevTestFile;
    }
  });
});

// ── US-002: real daemon child spawned via startDaemon() ────────────

describe("startDaemon child ledger attribution (US-002)", () => {
  const ENV_KEYS = [
    "HOME",
    "TAMANDUA_STATE_DIR",
    "TAMANDUA_DB_PATH",
    "TAMANDUA_CONTROL_PORT",
    "TAMANDUA_WORKTREE_ROOT",
    "TAMANDUA_TEST_GUARD",
    "TAMANDUA_TEST_GUARD_LEDGER",
    "TAMANDUA_TEST_GUARD_EXPECT",
    "TAMANDUA_TEST_GUARD_TEST_FILE",
  ] as const;

  it(
    "attributes the daemon child's default-3339 control-plane bind to this test file",
    { timeout: 60_000 },
    async () => {
      const temp = createTempHome("tamandua-ledger-daemon-");
      const ledgerPath = path.join(temp.root, "ledger.jsonl");

      const saved = new Map<string, string | undefined>();
      for (const key of ENV_KEYS) saved.set(key, process.env[key]);

      let daemonChild: ChildProcess | undefined;
      try {
        // Isolated temp HOME/state dir. TAMANDUA_CONTROL_PORT is deliberately
        // UNSET so startDaemon() falls back to the DEFAULT control port 3339
        // — a production port — and spawns a real dist/server/daemon.js child
        // whose bind guard-fires in the CHILD (its stack has no .test. frame).
        process.env.HOME = temp.homeDir;
        process.env.TAMANDUA_STATE_DIR = path.join(temp.homeDir, ".tamandua");
        process.env.TAMANDUA_DB_PATH = path.join(temp.homeDir, ".tamandua", "tamandua.db");
        process.env.TAMANDUA_WORKTREE_ROOT = path.join(temp.homeDir, ".tamandua", "worktrees");
        delete process.env.TAMANDUA_CONTROL_PORT;
        process.env.TAMANDUA_TEST_GUARD = "1";
        process.env.TAMANDUA_TEST_GUARD_LEDGER = ledgerPath;
        // Deliberate, EXPECT-marked provocation: this test's child-side entry
        // must be filtered by the lane report (expected:true).
        process.env.TAMANDUA_TEST_GUARD_EXPECT = "1";
        delete process.env.TAMANDUA_TEST_GUARD_TEST_FILE;

        // startDaemon() either resolves (a live daemon already answering on
        // 3339 passes the health probe) or rejects (the crashed child's port
        // never comes up). Both outcomes are fine — the ledger entry written
        // by the guard-firing child is the product under test.
        let startOutcome: string;
        try {
          const result = await startDaemon(undefined as unknown as number, {
            homeDir: temp.homeDir,
            keepHandle: true,
          });
          daemonChild = result.child;
          startOutcome = "resolved";
        } catch (err) {
          startOutcome = err instanceof Error ? err.message.split("\n")[0] : String(err);
        }
        void startOutcome;

        // Wait for the child-side ledger entry: the daemon child guard-fires
        // at its control-plane bind (before server.listen) and appends the
        // entry synchronously, then exits 1.
        const entries = await waitForLedgerEntries(ledgerPath, 20_000);
        assert.ok(
          entries.length >= 1,
          `daemon child must have guard-fired on the default control port; startDaemon ${startOutcome}. ` +
            `Ledger at ${ledgerPath} is empty.`,
        );

        const bindEntry = entries.find(
          (e) => e.kind === "port-bind" && e.path === "3339",
        );
        assert.ok(bindEntry, `expected a [port-bind] 3339 entry, got: ${JSON.stringify(entries)}`);
        assert.equal(
          bindEntry.what,
          "control plane",
          "the daemon child's first production bind is its control plane",
        );
        assert.ok(
          typeof bindEntry.testFile === "string" &&
            bindEntry.testFile.includes("ledger-child-attribution.test.ts"),
          `child-side entry must be attributed to THIS test file (not null / "(unknown)"), got: ${bindEntry.testFile}`,
        );
        assert.equal(
          bindEntry.testLine,
          null,
          "env attribution names the spawning test, which has no line in the child stack",
        );
        assert.ok(
          typeof bindEntry.argv === "string" && bindEntry.argv.includes("daemon.js"),
          `entry must carry the daemon child's argv, got: ${bindEntry.argv}`,
        );
        assert.equal(bindEntry.expected, true, "EXPECT-marked provocation must be expected:true");

        // The child guard-fires and exits on its own; if startDaemon resolved
        // before the crash, wait for the exit (or stop only our own pid).
        if (daemonChild) {
          const exited = await waitForChildExit(daemonChild, 10_000);
          if (!exited) {
            // Only pids this test spawned (keepHandle child) are signalled.
            daemonChild.kill("SIGTERM");
            await waitForChildExit(daemonChild, 5_000);
          }
        }
      } finally {
        // Stop the daemon family BEFORE removing the temp HOME (the crashed
        // child may still hold files under it). stopDaemonFamily only ever
        // signals pids whose HOME matches this temp dir — never a live
        // daemon.
        await stopDaemonFamily({ homeDir: temp.homeDir });

        for (const key of ENV_KEYS) {
          const value = saved.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        // Retries absorb stragglers still writing into the temp home during
        // teardown.
        await sleep(250);
        removeTestTempDirWithDiagnostics(temp.root);
      }
    },
  );
});
