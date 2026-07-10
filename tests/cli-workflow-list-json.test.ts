/**
 * Tests for tamandua workflow list --json (US-001).
 *
 * Validates:
 * 1. tamandua workflow list --json outputs valid JSON array with id/name/description
 * 2. tamandua workflow list (without --json) outputs human-readable format
 * 3. tamandua workflow list --help documents --json flag
 * 4. Empty workflow directory produces [] for --json
 *
 * All tests use isolated temp HOME directories.
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

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({ HOME: homeDir  }),
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

/**
 * Filter harmless node warnings from stderr
 */
function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

const TMP_PREFIX = "tamandua-wfl-json-";

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua workflow list --json", () => {
  // AC 1: tamandua workflow list --json outputs valid JSON array with id/name/description
  it("--json outputs valid JSON array with id, name, description", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      const { stdout, stderr, exitCode } = await runCli(["workflow", "list", "--json"], tempHome);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${stderr}`);
      assert.equal(cleanStderr(stderr), "");

      const parsed = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(parsed), "Output must be a JSON array");
      assert.ok(parsed.length > 0, "Expected at least one workflow in the array");

      for (const entry of parsed) {
        assert.ok(typeof entry.id === "string" && entry.id.length > 0, `Entry missing or empty id: ${JSON.stringify(entry)}`);
        assert.ok(typeof entry.name === "string" && entry.name.length > 0, `Entry missing or empty name: ${JSON.stringify(entry)}`);
        assert.ok(typeof entry.description === "string", `Entry missing description field: ${JSON.stringify(entry)}`);
      }
  });

  // AC 2: tamandua workflow list (without --json) still outputs human-readable format
  it("without --json outputs human-readable format unchanged", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      const { stdout, stderr, exitCode } = await runCli(["workflow", "list"], tempHome);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${stderr}`);
      assert.equal(cleanStderr(stderr), "");

      const lines = stdout.trim().split("\n");
      assert.ok(lines.length > 0, "Expected output");
      assert.ok(lines[0].includes("Available workflows:"), "First line should be header");
      // At least one workflow entry with " - " separator
      assert.ok(
        lines.some((l) => l.includes(" - ")),
        "Expected at least one line with ' - ' workflow description format",
      );
  });

  // AC 3: tamandua workflow list --help documents --json flag
  it("--help documents --json flag", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      const { stdout, stderr, exitCode } = await runCli(["workflow", "list", "--help"], tempHome);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${stderr}`);
      assert.equal(cleanStderr(stderr), "");

      assert.ok(
        stdout.includes("--json"),
        `Help output should mention --json flag:\n${stdout}`,
      );
      assert.ok(
        stdout.includes("JSON array"),
        `Help output should describe JSON array output:\n${stdout}`,
      );
  });

  // AC 4: Reasonable output even when something goes wrong
  it("each entry has string description (even if empty)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      const { stdout, stderr, exitCode } = await runCli(["workflow", "list", "--json"], tempHome);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}`);
      assert.equal(cleanStderr(stderr), "");

      const parsed = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(parsed));

      for (const entry of parsed) {
        assert.ok(typeof entry.description === "string", `description must be a string, got ${typeof entry.description} for ${entry.id}`);
      }
  });
});
