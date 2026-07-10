/**
 * Tests for tamandua skill-path CLI command and no-argument help ordering (US-004).
 *
 * Validates:
 * 1. tamandua skill-path prints a path ending with skills/tamandua-agents/SKILL.md
 * 2. tamandua skill-path output is an absolute path that exists on disk
 * 3. tamandua with no arguments lists skill-path before source-path in help output
 *
 * All tests use isolated temp HOME directories.
 */

import { describe, it, before, after } from "node:test";
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
 * Filter harmless node warnings from stderr (e.g. SQLite experimental warning)
 * so they don't pollute test assertions.
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

const TMP_PREFIX = "tamandua-skill-path-";

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua skill-path CLI", () => {
  const EXPECTED_SKILL_SUFFIX = path.join("skills", "tamandua-agents", "SKILL.md");

  // AC 1: tamandua skill-path prints a path ending with skills/tamandua-agents/SKILL.md
  it("skill-path prints path ending with skills/tamandua-agents/SKILL.md", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    const { stdout, stderr, exitCode } = await runCli(["skill-path"], tempHome);

    const cleanOut = stdout.trim();
    const cleanErr = cleanStderr(stderr);

    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanErr}`);
    assert.equal(cleanErr, "");
    assert.ok(
      cleanOut.endsWith(EXPECTED_SKILL_SUFFIX),
      `Expected path ending with "${EXPECTED_SKILL_SUFFIX}", got: "${cleanOut}"`,
    );
  });

  // AC 2: tamandua skill-path output is an absolute path that exists on disk
  it("skill-path outputs an absolute path that exists on disk", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    const { stdout, stderr, exitCode } = await runCli(["skill-path"], tempHome);

    const cleanOut = stdout.trim();
    const cleanErr = cleanStderr(stderr);

    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanErr}`);
    assert.equal(cleanErr, "");

    // Must be absolute
    assert.ok(
      path.isAbsolute(cleanOut),
      `Expected absolute path, got: "${cleanOut}"`,
    );

    // Must exist on disk
    assert.ok(
      fs.existsSync(cleanOut),
      `Path does not exist on disk: "${cleanOut}"`,
    );
  });

  // AC 3: tamandua with no arguments lists skill-path before source-path in help output
  it("no-argument help lists skill-path before source-path", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    const { stdout, stderr, exitCode } = await runCli([], tempHome);

    // No-arg CLI exits with code 1 (prints usage then exits)
    assert.equal(exitCode, 1, `Expected exit code 1, got ${exitCode}`);
    assert.equal(cleanStderr(stderr), "");

    const skillPathIdx = stdout.indexOf("tamandua skill-path");
    const sourcePathIdx = stdout.indexOf("tamandua source-path");

    assert.ok(skillPathIdx >= 0, "skill-path not found in help output");
    assert.ok(sourcePathIdx >= 0, "source-path not found in help output");
    assert.ok(skillPathIdx < sourcePathIdx, "skill-path must appear before source-path in help output");
  });
});
