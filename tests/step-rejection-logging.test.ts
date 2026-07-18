/**
 * US-003: WARN logging for rejected step-API calls.
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], homeDir: string, stateDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: stateDir,
      }),
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function getLogPath(stateDir: string): string {
  return path.join(stateDir, "tamandua.log");
}

function readLogWarnLines(stateDir: string): string[] {
  const logPath = getLogPath(stateDir);
  if (!fs.existsSync(logPath)) return [];
  const content = fs.readFileSync(logPath, "utf-8");
  return content.split("\n").filter((l) => l.includes("WARN"));
}

describe("US-003: step rejection WARN logging", () => {
  describe("step-ops.ts — completeStep / failStep not found", () => {
    it("completeStep with nonexistent step logs a WARN message", async () => {
      const th = createTempHome("tamandua-reject-comp-");
      try {
        process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
        process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");

        const { completeStep } = await import("../dist/installer/step-ops.js");
        try {
          completeStep("nonexistent-step-id", "output");
          assert.fail("should have thrown");
        } catch (err: any) {
          assert.match(err.message, /Step not found/);
        }

        const warnLines = readLogWarnLines(th.tamanduaDir);
        assert.ok(warnLines.length >= 1, "should have at least one WARN line");
        const found = warnLines.some((l) =>
          l.includes("Rejected step complete") && l.includes("nonexistent-step-id"),
        );
        assert.ok(found, `WARN log should contain "Rejected step complete" with step-id. Got: ${warnLines.join("|")}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("failStep with nonexistent step logs a WARN message", async () => {
      const th = createTempHome("tamandua-reject-fail-");
      try {
        process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
        process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");

        const { failStep } = await import("../dist/installer/step-ops.js");
        try {
          await failStep("nonexistent-fail-id", "error reason");
          assert.fail("should have thrown");
        } catch (err: any) {
          assert.match(err.message, /Step not found/);
        }

        const warnLines = readLogWarnLines(th.tamanduaDir);
        assert.ok(warnLines.length >= 1, "should have at least one WARN line");
        const found = warnLines.some((l) =>
          l.includes("Rejected step fail") && l.includes("nonexistent-fail-id"),
        );
        assert.ok(found, `WARN log should contain "Rejected step fail" with step-id. Got: ${warnLines.join("|")}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });
  });

  describe("CLI — missing --run-id on step claim/peek/current", () => {
    it("logs a WARN when --run-id is missing for step claim", async () => {
      const th = createTempHome("tamandua-reject-cli-claim-");
      process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
      try {
        const result = await runCli(["step", "claim", "test-agent"], th.homeDir, th.tamanduaDir);
        assert.notEqual(result.exitCode, 0, "should exit non-zero");

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const found = warnLines.some((l) =>
          l.includes("Rejected step claim") && l.includes("missing --run-id"),
        );
        assert.ok(found, `WARN log should contain "Rejected step claim: missing --run-id". Got: ${warnLines.join("|")}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("logs a WARN when --run-id is missing for step peek", async () => {
      const th = createTempHome("tamandua-reject-cli-peek-");
      process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
      try {
        const result = await runCli(["step", "peek", "test-agent"], th.homeDir, th.tamanduaDir);
        assert.notEqual(result.exitCode, 0, "should exit non-zero");

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const found = warnLines.some((l) =>
          l.includes("Rejected step peek") && l.includes("missing --run-id"),
        );
        assert.ok(found, `WARN log should contain "Rejected step peek: missing --run-id". Got: ${warnLines.join("|")}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("logs a WARN when --run-id is missing for step current", async () => {
      const th = createTempHome("tamandua-reject-cli-current-");
      process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
      try {
        const result = await runCli(["step", "current", "test-agent"], th.homeDir, th.tamanduaDir);
        assert.notEqual(result.exitCode, 0, "should exit non-zero");

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const found = warnLines.some((l) =>
          l.includes("Rejected step current") && l.includes("missing --run-id"),
        );
        assert.ok(found, `WARN log should contain "Rejected step current: missing --run-id". Got: ${warnLines.join("|")}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });
  });

  describe("CLI — missing step-id on complete/fail", () => {
    it("logs a WARN when step-id is missing for step complete", async () => {
      const th = createTempHome("tamandua-reject-missing-stepid-");
      process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
      try {
        const result = await runCli(["step", "complete"], th.homeDir, th.tamanduaDir);
        assert.notEqual(result.exitCode, 0, "should exit non-zero");

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const found = warnLines.some((l) =>
          l.includes("Rejected step complete") && l.includes("missing step-id"),
        );
        assert.ok(found, `WARN log should contain "Rejected step complete: missing step-id". Got: ${warnLines.join("|")}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("logs a WARN when step-id is missing for step fail", async () => {
      const th = createTempHome("tamandua-reject-missing-failid-");
      process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
      try {
        const result = await runCli(["step", "fail"], th.homeDir, th.tamanduaDir);
        assert.notEqual(result.exitCode, 0, "should exit non-zero");

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const found = warnLines.some((l) =>
          l.includes("Rejected step fail") && l.includes("missing step-id"),
        );
        assert.ok(found, `WARN log should contain "Rejected step fail: missing step-id". Got: ${warnLines.join("|")}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });
  });

  describe("Rejection count — one WARN per rejection", () => {
    it("step complete with nonexistent step emits exactly one WARN", async () => {
      const th = createTempHome("tamandua-one-warn-comp-");
      try {
        process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
        process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");

        const { completeStep } = await import("../dist/installer/step-ops.js");
        try { completeStep("onetime-id", "x"); } catch {}

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const count = warnLines.filter((l) => l.includes("onetime-id")).length;
        assert.equal(count, 1, `Expected exactly 1 WARN for this step, got ${count}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("step fail with nonexistent step emits exactly one WARN", async () => {
      const th = createTempHome("tamandua-one-warn-fail-");
      try {
        process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
        process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");

        const { failStep } = await import("../dist/installer/step-ops.js");
        try { await failStep("onetime-fail-id", "error"); } catch {}

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const count = warnLines.filter((l) => l.includes("onetime-fail-id")).length;
        assert.equal(count, 1, `Expected exactly 1 WARN for this step, got ${count}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("missing --run-id on step claim emits exactly one WARN", async () => {
      const th = createTempHome("tamandua-one-warn-runid-");
      process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
      try {
        await runCli(["step", "claim", "unique-agent"], th.homeDir, th.tamanduaDir);

        const warnLines = readLogWarnLines(th.tamanduaDir);
        const count = warnLines.filter((l) => l.includes("unique-agent") && l.includes("missing --run-id")).length;
        assert.equal(count, 1, `Expected exactly 1 WARN for agent unique-agent, got ${count}`);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });
  });
});
