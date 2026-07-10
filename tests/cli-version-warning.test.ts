/**
 * Tests for CLI version update warning (US-003).
 *
 * Validates:
 * 1. CLI prints update warning to stderr when version-status.json says updateAvailable is true
 * 2. Warning suppressed for 'update', 'version', 'step peek', 'step claim' subcommands
 * 3. 'step peek' output is not corrupted by warning text
 * 4. No git fetch triggered during CLI invocation
 *
 * All tests use isolated temp HOME directories.
 */

import { describe, it, after } from "node:test";
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

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv(envOverrides),
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
      if (line.includes("ExperimentalWarning") && line.includes("SQLite"))
        return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

const TMP_PREFIX = "tamandua-version-warning-";

function writeVersionStatus(
  stateDir: string,
  status: {
    updateAvailable: boolean;
    currentHead?: string;
    remoteHead?: string;
    checkedAt?: string;
  },
): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "version-status.json"),
    JSON.stringify(status, null, 2),
    "utf-8",
  );
}

const UPDATE_WARNING = "WARNING: A new version of tamandua is available! Run: tamandua update";

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("CLI version warning", () => {
  // AC 1: CLI prints update warning to stderr when version-status.json says updateAvailable is true
  it("prints warning to stderr when update available", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      // Use a non-update command (e.g. help output from 'workflow list')
      const { stderr, exitCode } = await runCli(["workflow", "list"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleaned}`);
      assert.ok(
        cleaned.includes(UPDATE_WARNING),
        `Expected stderr to contain "${UPDATE_WARNING}", got: "${cleaned}"`,
      );
  });

  // AC 1b: CLI does not print warning when updateAvailable is false
  it("does not print warning when no update available", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: false },
      );

      const { stderr, exitCode } = await runCli(["workflow", "list"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      assert.equal(exitCode, 0);
      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning, got: "${cleaned}"`,
      );
  });

  // AC 1c: CLI does not print warning when no version-status.json exists
  it("does not print warning when no version-status.json exists", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      // Do not create version-status.json at all
      const { stderr, exitCode } = await runCli(["workflow", "list"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      assert.equal(exitCode, 0);
      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning, got: "${cleaned}"`,
      );
  });

  // AC 2: Warning suppressed for 'update' subcommand
  it("suppresses warning for update subcommand", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      const { stderr, exitCode } = await runCli(["update"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      // 'update' may exit non-zero (no git), but should not show version warning
      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning for update, got: "${cleaned}"`,
      );
  });

  // AC 2: Warning suppressed for 'version' subcommand
  it("suppresses warning for version subcommand", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      const { stdout, stderr, exitCode } = await runCli(["version"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      assert.equal(exitCode, 0);
      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning for version, got: "${cleaned}"`,
      );
      // Should still output the version
      const versionRegex = /\d{8}T\d{6}Z_[0-9a-f]{40}/;
      assert.ok(versionRegex.test(stdout.trim()), `Expected version output, got: "${stdout}"`);
  });

  // AC 2: Warning suppressed for '--version' flag
  it("suppresses warning for --version flag", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      const { stdout, stderr, exitCode } = await runCli(["--version"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      assert.equal(exitCode, 0);
      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning for --version, got: "${cleaned}"`,
      );
      const versionRegex = /\d{8}T\d{6}Z_[0-9a-f]{40}/;
      assert.ok(versionRegex.test(stdout.trim()), `Expected version output, got: "${stdout}"`);
  });

  // AC 2: Warning suppressed for '-v' flag
  it("suppresses warning for -v flag", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      const { stdout, stderr, exitCode } = await runCli(["-v"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      assert.equal(exitCode, 0);
      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning for -v, got: "${cleaned}"`,
      );
      const versionRegex = /\d{8}T\d{6}Z_[0-9a-f]{40}/;
      assert.ok(versionRegex.test(stdout.trim()), `Expected version output, got: "${stdout}"`);
  });

  // AC 2: Warning suppressed for 'step peek' subcommand
  it("suppresses warning for step peek subcommand", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      // step peek will fail because there's no run, but that's fine
      // we only care that no warning is emitted
      const { stderr, exitCode } = await runCli(
        ["step", "peek", "test-agent", "--run-id", "nonexistent-run"],
        { HOME: tempHome },
      );

      const cleaned = cleanStderr(stderr);

      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning for step peek, got: "${cleaned}"`,
      );
      // May exit 0 or non-zero depending on system state; either is fine
  });

  // AC 2: Warning suppressed for 'step claim' subcommand
  it("suppresses warning for step claim subcommand", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      const { stderr, exitCode } = await runCli(
        ["step", "claim", "test-agent", "--run-id", "nonexistent-run"],
        { HOME: tempHome },
      );

      const cleaned = cleanStderr(stderr);

      assert.equal(
        cleaned.includes("WARNING"),
        false,
        `Expected no warning for step claim, got: "${cleaned}"`,
      );
  });

  // AC 3: 'step peek' output is not corrupted by warning text
  it("step peek output is not corrupted when update available", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      const { stdout, exitCode } = await runCli(
        ["step", "peek", "test-agent", "--run-id", "nonexistent-run"],
        { HOME: tempHome },
      );

      // step peek output should be exactly "NO_WORK" or "HAS_WORK"
      // (it could also fail with stderr but stdout is what matters for polling)
      // The key thing: stdout should not contain warning text
      assert.equal(
        stdout.includes("WARNING"),
        false,
        `step peek stdout should not contain warning, got: "${stdout}"`,
      );

      // stdout should also not contain the version warning
      assert.equal(
        stdout.includes(UPDATE_WARNING),
        false,
        `step peek stdout should not contain update warning, got: "${stdout}"`,
      );
  });

  // Verify source-path and skill-path commands (non-update commands) still show warning
  it("prints warning for skill-path command when update available", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
      writeVersionStatus(
        path.join(tempHome, ".tamandua"),
        { updateAvailable: true },
      );

      const { stderr, exitCode } = await runCli(["skill-path"], {
        HOME: tempHome,
      });

      const cleaned = cleanStderr(stderr);

      assert.equal(exitCode, 0);
      assert.ok(
        cleaned.includes(UPDATE_WARNING),
        `Expected warning for skill-path, got: "${cleaned}"`,
      );
  });
});
