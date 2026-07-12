/**
 * Tests for real e2e helpers (daemon lifecycle + run polling).
 *
 * These tests use an isolated HOME to avoid touching live state.
 * They require a built dist/ (npm run build) to use daemon.js.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";
import {
  reserveDistinctRandomPorts,
} from "../../tests/helpers/test-env.ts";
import {
  pollForRunCompletion,
  startIsolatedDaemon,
  stopIsolatedDaemon,
  waitForRunTerminal,
  isSuccessfulRunTerminalStatus,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from "./e2e-helpers.ts";

let tempRoot: string;
let homeDir: string;
let tamanduaDir: string;
let controlPort: number;
let dashboardPort: number;

function createTempHome() {
  tempRoot = tamanduaTempDir("tamandua-e2e-helpers-test-");
  homeDir = path.join(tempRoot, "home");
  tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });

  // Write port file (required by daemon)
  fs.writeFileSync(
    path.join(tamanduaDir, "port"),
    String(dashboardPort),
    "utf-8",
  );

  // Minimal pi config (required by workflow install)
  const piAgentDir = path.join(homeDir, ".pi", "agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
    "utf-8",
  );
}

function cleanupTempHome() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe("e2e-helpers (real e2e test helpers)", () => {
  before(async () => {
    [controlPort, dashboardPort] = await reserveDistinctRandomPorts(2);
    createTempHome();
  });

  after(() => {
    cleanupTempHome();
  });

  describe("startIsolatedDaemon / stopIsolatedDaemon", () => {
    it("starts a daemon in an isolated HOME", async () => {
      const child = await startIsolatedDaemon(dashboardPort, homeDir, controlPort);

      assert.ok(child.pid, "daemon should have a PID");
      assert.equal(child.exitCode, null, "daemon should be running");

      await stopIsolatedDaemon(child);

      // After stop the process should have exited
      assert.ok(
        child.exitCode !== null || child.killed,
        "daemon should have exited after stop",
      );
    });

    it("stopIsolatedDaemon is idempotent on already-exited process", async () => {
      const child = await startIsolatedDaemon(dashboardPort, homeDir, controlPort);
      await stopIsolatedDaemon(child);
      // Second stop should not throw
      await stopIsolatedDaemon(child);
    });

    it("creates expected files in the isolated HOME", async () => {
      const child = await startIsolatedDaemon(dashboardPort, homeDir, controlPort);

      // Give the daemon a moment to write its files
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // PID file is created by the daemon on startup
      const pidFile = path.join(tamanduaDir, "tamandua.pid");
      assert.ok(fs.existsSync(pidFile), `PID file should exist at ${pidFile}`);

      // Port file was pre-written by createTempHome
      const portFile = path.join(tamanduaDir, "port");
      assert.ok(fs.existsSync(portFile), `Port file should exist at ${portFile}`);

      // DB is created lazily on first access and may not exist yet — that's OK.
      // dashboard.log is only created by daemonctl's spawn wrapper, not by
      // direct daemon.js spawning (output goes to stdio pipes instead).

      await stopIsolatedDaemon(child);
    });
  });

  describe("pollForRunCompletion", () => {
    it("times out with diagnostics for a non-existent run", async () => {
      const fakeRunId = "00000000-0000-0000-0000-000000000000";
      const shortTimeout = 1000; // ms
      const shortPoll = 200; // ms

      await assert.rejects(
        () =>
          pollForRunCompletion(fakeRunId, { HOME: homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) }, shortTimeout, shortPoll),
        (err: Error) => {
          return (
            err.message.includes("Timeout after") &&
            err.message.includes("Last status:") &&
            err.message.includes("Last output:")
          );
        },
      );
    });
  });

  describe("waitForRunTerminal", () => {
    it("treats completed and legacy done as successful terminal statuses", () => {
      assert.equal(isSuccessfulRunTerminalStatus("completed"), true);
      assert.equal(isSuccessfulRunTerminalStatus("done"), true);
      assert.equal(isSuccessfulRunTerminalStatus("failed"), false);
      assert.equal(isSuccessfulRunTerminalStatus("canceled"), false);
    });

    it("throws when the run does not reach a successful terminal status", async () => {
      // We can't easily create a terminal run in the DB (no run in this empty HOME),
      // but we verify waitForRunTerminal throws when pollForRunCompletion times out.
      const fakeRunId = "00000000-0000-0000-0000-000000000000";
      const shortTimeout = 1000;

      await assert.rejects(
        () =>
          waitForRunTerminal(fakeRunId, { HOME: homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) }, shortTimeout, 200),
        /Timeout after/,
      );
    });
  });

  describe("exports", () => {
    it("exports all required symbols", () => {
      assert.equal(typeof pollForRunCompletion, "function");
      assert.equal(typeof startIsolatedDaemon, "function");
      assert.equal(typeof stopIsolatedDaemon, "function");
      assert.equal(typeof waitForRunTerminal, "function");
      assert.ok(DEFAULT_POLL_INTERVAL_MS > 0);
      assert.ok(DEFAULT_RUN_TIMEOUT_MS > 0);
    });
  });
});
