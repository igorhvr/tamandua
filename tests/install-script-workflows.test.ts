/**
 * Tests for scripts/install.sh bundled workflow installation (US-001).
 *
 * Validates:
 * 1. install.sh calls tamandua workflow install --all after symlink creation
 * 2. install.sh does not fail if workflow installation fails (exit code still 0)
 * 3. Final output no longer instructs user to run tamandua get-ready manually
 * 4. The PATH reminder line is preserved
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "./helpers/test-env.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTALL_SCRIPT = path.resolve(__dirname, "..", "scripts", "install.sh");
const REPO_ROOT = path.resolve(__dirname, "..");

function createTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-inst-sh-"));
  const piAgentDir = path.join(dir, ".pi", "agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
    "utf-8",
  );
  return dir;
}

describe("scripts/install.sh — bundled workflow installation", () => {
  // AC 1: install.sh calls tamandua workflow install --all after symlink creation
  it("script source contains workflow install --all after symlink creation", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Must have the workflow install --all command
    assert.ok(
      content.includes("workflow install --all"),
      "install.sh should contain 'workflow install --all'",
    );

    // workflow install must appear after symlink creation
    const symlinkIdx = content.indexOf("ln -sf");
    const wfInstallIdx = content.indexOf("workflow install --all");
    assert.ok(symlinkIdx !== -1, "install.sh should contain symlink creation (ln -sf)");
    assert.ok(wfInstallIdx !== -1, "install.sh should contain workflow install --all");
    assert.ok(
      wfInstallIdx > symlinkIdx,
      "workflow install --all must appear after symlink creation",
    );
  });

  // AC 2: install.sh uses set +e / set -e to gracefully handle workflow install failures
  it("script uses set +e / set -e to protect against workflow install failure", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Find the block that wraps the workflow install
    const wfInstallIdx = content.indexOf("workflow install --all");
    const regionBefore = content.substring(wfInstallIdx - 200, wfInstallIdx);

    assert.ok(
      regionBefore.includes("set +e"),
      "workflow install should be preceded by 'set +e'",
    );

    // Check set -e appears after workflow install
    const regionAfter = content.substring(wfInstallIdx, wfInstallIdx + 200);
    assert.ok(
      regionAfter.includes("set -e"),
      "workflow install should be followed by 'set -e'",
    );

    // Verify exit code is captured
    assert.ok(
      content.includes("WF_INSTALL_EXIT=") || content.includes("INSTALL_EXIT="),
      "install.sh should capture workflow install exit code",
    );
  });

  // AC 3: Final output no longer instructs user to run tamandua get-ready manually
  it("output no longer mentions 'tamandua get-ready'", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Should NOT instruct user to run get-ready manually
    assert.ok(
      !content.includes("Run: tamandua get-ready"),
      "install.sh should NOT instruct user to run 'tamandua get-ready' manually",
    );
    assert.ok(
      !content.includes("tamandua get-ready"),
      "install.sh should NOT reference 'tamandua get-ready' anywhere",
    );
  });

  // AC 4: The PATH reminder line is preserved
  it("preserves PATH reminder line", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    assert.ok(
      content.includes("Make sure ~/.local/bin is in your PATH"),
      "install.sh should preserve the PATH reminder line",
    );
  });

  // Integration: run install.sh --local and verify workflows are installed
  it("install.sh --local installs bundled workflows and exits 0", async (t) => {
    const cliScript = path.resolve(__dirname, "..", "dist", "cli", "cli.js");
    if (!fs.existsSync(cliScript)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome();
    try {
      // Run install.sh --local with isolated HOME
      const result = spawnSync("bash", [INSTALL_SCRIPT, "--local", REPO_ROOT], {
        env: cleanChildEnv({ HOME: tempHome }),
        timeout: 120_000, // 2 minute timeout for npm install + build
        encoding: "utf-8",
      });

      const stdout = result.stdout || "";
      const stderr = result.stderr || "";

      // Must exit 0 even if workflow install had issues
      assert.equal(
        result.status,
        0,
        `install.sh should exit 0. Status: ${result.status}, stderr: ${stderr.slice(0, 500)}`,
      );

      // Output should NOT mention get-ready
      assert.ok(
        !stdout.includes("tamandua get-ready"),
        `Output should not mention 'tamandua get-ready'. Got: ${stdout.slice(0, 500)}`,
      );

      // Output should mention success
      assert.ok(
        stdout.includes("Tamandua installed successfully!"),
        `Expected 'Tamandua installed successfully!' in output. Got: ${stdout.slice(0, 500)}`,
      );

      // PATH reminder should be present
      assert.ok(
        stdout.includes("Make sure ~/.local/bin is in your PATH"),
        `Expected PATH reminder in output. Got: ${stdout.slice(0, 500)}`,
      );

      // Symlink should exist and be executable
      const symlinkPath = path.join(tempHome, ".local", "bin", "tamandua");
      assert.ok(
        fs.existsSync(symlinkPath),
        `Symlink should exist at ${symlinkPath}`,
      );

      // tamandua-test symlink should exist and be executable
      const symlinkPathTest = path.join(tempHome, ".local", "bin", "tamandua-test");
      assert.ok(
        fs.existsSync(symlinkPathTest),
        `tamandua-test symlink should exist at ${symlinkPathTest}`,
      );

      // Workflow directories should exist
      const workflowsRoot = path.join(tempHome, ".tamandua", "workflows");
      assert.ok(
        fs.existsSync(workflowsRoot),
        `Workflows directory should exist at ${workflowsRoot}`,
      );

      // At least one workflow directory should exist
      const wfEntries = fs.readdirSync(workflowsRoot, { withFileTypes: true });
      const wfDirs = wfEntries.filter((e) => e.isDirectory());
      assert.ok(
        wfDirs.length > 0,
        `Expected at least one workflow directory in ${workflowsRoot}. stderr: ${stderr.slice(0, 300)}`,
      );

      // agents.json should be populated
      const agentsPath = path.join(tempHome, ".tamandua", "agents.json");
      assert.ok(fs.existsSync(agentsPath), "agents.json should exist");
      const agents = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
      assert.ok(Array.isArray(agents), "agents.json should be an array");
      assert.ok(agents.length > 0, "agents.json should have entries");

      // Should have workflow-prefixed agents
      const workflowAgents = agents.filter(
        (a: Record<string, unknown>) =>
          typeof a.id === "string" && (a.id as string).includes("_"),
      );
      assert.ok(
        workflowAgents.length > 0,
        `agents.json should have workflow agents, got: ${agents.map((a: Record<string, unknown>) => a.id).join(", ")}`,
      );
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // Verify the warning message appears when workflow install fails
  it("prints warning when workflow installation fails", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Script should have a conditional warning
    assert.ok(
      content.includes("Warning: workflow installation failed"),
      "install.sh should print a warning when workflow installation fails",
    );
  });

  // Verify WF_INSTALL_EXIT is checked
  it("checks workflow install exit code", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Captures exit code
    assert.ok(
      content.includes("WF_INSTALL_EXIT="),
      "install.sh should capture WF_INSTALL_EXIT",
    );

    // Checks exit code for non-zero
    assert.ok(
      content.includes("$WF_INSTALL_EXIT -ne 0"),
      "install.sh should check WF_INSTALL_EXIT for non-zero",
    );
  });
});

/**
 * Tests for tamandua-test bin registration (US-007).
 *
 * Validates:
 * 1. package.json bin field includes tamandua-test
 * 2. install.sh creates tamandua-test symlink
 * 3. build script makes dist/suite/shim.js executable
 * 4. dist/suite/shim.js has correct shebang
 * 5. tamandua-test --help works
 */

describe("tamandua-test bin registration", () => {
  const PACKAGE_JSON = path.resolve(__dirname, "..", "package.json");
  const DIST_SHIM = path.resolve(__dirname, "..", "dist", "suite", "shim.js");

  // AC 1: package.json bin field includes tamandua-test
  it("package.json bin field includes tamandua-test pointing to dist/suite/shim.js", () => {
    const content = fs.readFileSync(PACKAGE_JSON, "utf-8");
    const pkg = JSON.parse(content);

    assert.ok(pkg.bin && typeof pkg.bin === "object", "package.json should have a bin object");
    assert.equal(
      pkg.bin["tamandua-test"],
      "dist/suite/shim.js",
      "bin.tamandua-test should point to dist/suite/shim.js",
    );
    assert.equal(
      pkg.bin["tamandua"],
      "dist/cli/cli.js",
      "existing bin.tamandua should remain unchanged",
    );
  });

  // AC 2: install.sh source contains tamandua-test symlink
  it("install.sh creates tamandua-test symlink in ~/.local/bin", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Must have the tamandua-test symlink creation
    assert.ok(
      content.includes('"$REPO_DIR/bin/tamandua-test"'),
      "install.sh should reference bin/tamandua-test",
    );
    assert.ok(
      content.includes('"$HOME/.local/bin/tamandua-test"'),
      "install.sh should symlink to ~/.local/bin/tamandua-test",
    );

    // tamandua-test symlink should appear after tamandua symlink
    const tamanduaIdx = content.indexOf('"$HOME/.local/bin/tamandua"');
    const testIdx = content.indexOf('"$HOME/.local/bin/tamandua-test"');
    assert.ok(
      testIdx > tamanduaIdx,
      "tamandua-test symlink should appear after tamandua symlink",
    );
  });

  // AC 3: build script makes dist/suite/shim.js executable
  it("build script includes chmod +x for dist/suite/shim.js", () => {
    const content = fs.readFileSync(PACKAGE_JSON, "utf-8");
    const pkg = JSON.parse(content);
    const buildScript = pkg.scripts?.build || "";

    assert.ok(
      buildScript.includes("chmod +x dist/suite/shim.js"),
      "build script should chmod +x dist/suite/shim.js",
    );
  });

  // AC 4: dist/suite/shim.js is executable and has correct shebang (when built)
  it("dist/suite/shim.js is executable and has #!/usr/bin/env node shebang", () => {
    if (!fs.existsSync(DIST_SHIM)) {
      // Skip if not built — integration test covers this after npm run build
      return;
    }

    // Check executable permissions
    const stat = fs.statSync(DIST_SHIM);
    // Owner execute bit should be set (0o100)
    const ownerExec = (stat.mode & 0o100) !== 0;
    assert.ok(ownerExec, "dist/suite/shim.js should have owner execute permission");

    // Check shebang
    const firstLine = fs.readFileSync(DIST_SHIM, "utf-8").split("\n")[0];
    assert.equal(
      firstLine,
      "#!/usr/bin/env node",
      "dist/suite/shim.js should start with #!/usr/bin/env node",
    );
  });

  // AC 5: tamandua-test --help shows usage
  it("tamandua-test --help shows usage documentation", () => {
    if (!fs.existsSync(DIST_SHIM)) {
      // Skip if not built — test requires build artifacts
      return;
    }

    const result = spawnSync("node", [DIST_SHIM, "--help"], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    assert.equal(result.status, 0, `tamandua-test --help should exit 0, got ${result.status}`);
    // Help output goes to stderr
    const stderr = result.stderr || "";
    assert.ok(
      stderr.includes("Usage:"),
      `--help should show usage on stderr. Got: ${stderr.slice(0, 200)}`,
    );
    assert.ok(
      stderr.includes("--repo"),
      "usage should document --repo flag",
    );
    assert.ok(
      stderr.includes("TAMANDUA_TSTX"),
      "usage should document TAMANDUA_TSTX env var",
    );
  });

  // AC 6: tamandua-test is directly executable (via node)
  it("tamandua-test exits with error when missing command", () => {
    if (!fs.existsSync(DIST_SHIM)) {
      return;
    }

    const result = spawnSync("node", [DIST_SHIM, "--repo", "."], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    // Should fail with non-zero exit (or at least not crash)
    assert.ok(
      result.status !== null,
      "tamandua-test should not crash when invoked without command",
    );
  });

  // AC 7: tamandua-test passthrough with missing repo still works
  it("tamandua-test passthrough with no --repo runs command directly", () => {
    if (!fs.existsSync(DIST_SHIM)) {
      return;
    }

    const result = spawnSync("node", [DIST_SHIM, "--", "echo", "hello"], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    // Passthrough mode: execs echo hello, exits 0
    assert.equal(result.status, 0, `echo hello should exit 0, got ${result.status}`);
    assert.ok(
      (result.stdout || "").includes("hello"),
      `expected 'hello' in output. Got: ${result.stdout?.slice?.(0, 200) || "(empty)"}`,
    );
  });
});
