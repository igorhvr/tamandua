/**
 * Unit tests for US-006: install-scenario-workflows tool and fork-parity-check.
 *
 * Verifies:
 *  1. install-scenario-workflows creates workflow copies with unique IDs
 *  2. Copied workflow.yml has correct id field, other files byte-identical
 *  3. Behaviors fragment has correct full workflowId_agentId keys
 *  4. fork-parity-check exits 0 when non-knob regions match
 *  5. fork-parity-check exits non-zero when a non-knob line is modified
 *  6. fork-parity-check exits 0 when only knob regions are modified
 *  7. KNOB-REGIONS.md documents all knob regions
 *  8. Error handling for both scripts
 *
 * This file uses node:child_process (execSync) for CLI invocation and
 * therefore belongs in the serial test lane.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const runtimesDir = path.join(repoRoot, "torture-test", "scripted-runtimes");

const installScript = path.join(runtimesDir, "install-scenario-workflows");
const forkParityScript = path.join(runtimesDir, "fork-parity-check");

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(
    repoRoot,
    "torture-test",
    "var",
    `us006-test-${crypto.randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Create a minimal workflow directory for testing install-scenario-workflows.
 * Returns the path to the workflow directory and the state dir.
 */
function createTestWorkflow(baseDir: string, workflowId: string): string {
  const workflowsDir = path.join(baseDir, "workflows");
  const wfDir = path.join(workflowsDir, workflowId);
  fs.mkdirSync(wfDir, { recursive: true });

  // Write workflow.yml with known structure
  const yml = [
    `id: ${workflowId}`,
    `name: Test Workflow`,
    `version: 1`,
    `description: Test workflow for US-006`,
    ``,
    `agents:`,
    `  - id: planner`,
    `    name: Planner`,
    `    role: analysis`,
    `    description: Plans things`,
    `  - id: developer`,
    `    name: Developer`,
    `    role: coding`,
    `    description: Builds things`,
    `  - id: verifier`,
    `    name: Verifier`,
    `    role: verification`,
    `    description: Checks things`,
    ``,
    `steps:`,
    `  - id: plan`,
    `    agent: planner`,
  ].join("\n");

  fs.writeFileSync(path.join(wfDir, "workflow.yml"), yml);

  // Write a dummy file to verify byte-identical copy
  fs.writeFileSync(path.join(wfDir, "README.md"), "# Test Workflow\n");

  return wfDir;
}

// ── install-scenario-workflows tests ─────────────────────────────────────

describe("install-scenario-workflows (US-006)", () => {
  it("script exists and is executable", () => {
    assert.ok(fs.existsSync(installScript), "install-scenario-workflows must exist");
    const stat = fs.statSync(installScript);
    // Must be executable by owner
    assert.ok((stat.mode & 0o100) !== 0, "install-scenario-workflows must be executable");
  });

  it("prints usage when called with no arguments", () => {
    // TAMANDUA_STATE_DIR not set → should print usage to stderr, exit 2
    try {
      execSync(`bash ${JSON.stringify(installScript)}`, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.fail("Should have exited non-zero");
    } catch (e: any) {
      assert.ok(e.stderr?.includes("Usage:"),
        `stderr should contain Usage, got: ${e.stderr}`);
      assert.equal(e.status, 2, "should exit with code 2");
    }
  });

  it("fails with clear message when TAMANDUA_STATE_DIR is not set", () => {
    try {
      execSync(`bash ${JSON.stringify(installScript)} base s1`, {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.fail("Should have exited non-zero");
    } catch (e: any) {
      assert.ok(e.stderr?.includes("TAMANDUA_STATE_DIR"),
        `stderr should mention TAMANDUA_STATE_DIR, got: ${e.stderr}`);
      assert.ok(e.status !== 0, "should exit non-zero");
    }
  });

  it("fails when source workflow does not exist", () => {
    const tmpHome = makeTempDir();
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      fs.mkdirSync(stateDir, { recursive: true });
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpHome,
        TAMANDUA_STATE_DIR: stateDir,
      };
      try {
        execSync(
          `bash ${JSON.stringify(installScript)} nonexistent s1 2>&1`,
          { encoding: "utf-8", env },
        );
        assert.fail(`Should have failed`);
      } catch (e: any) {
        assert.ok(
          (e.stdout ?? "").includes("not found") || (e.stderr ?? "").includes("not found") ||
          (e.stdout ?? "").includes("source") || (e.stderr ?? "").includes("source"),
          `should mention missing source, stdout: ${e.stdout}, stderr: ${e.stderr}`,
        );
        assert.notEqual(e.status, 0);
      }
    } finally {
      cleanup(tmpHome);
    }
  });

  it("creates workflow copy with unique ID (base-scenarioId)", () => {
    const tmpHome = makeTempDir();
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      const baseWfId = "test-wf";
      const scenarioId = "w414";
      const newId = `${baseWfId}-${scenarioId}`;

      // Setup: create test workflow
      createTestWorkflow(stateDir, baseWfId);

      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpHome,
        TAMANDUA_STATE_DIR: stateDir,
      };

      // Run install — capture stderr (output goes to stderr)
      const result = execSync(
        `bash ${JSON.stringify(installScript)} ${baseWfId} ${scenarioId} 2>&1`,
        { encoding: "utf-8", env },
      );

      // Verify has success message on stderr
      assert.ok(
        result.includes(`installed ${newId}`),
        `should mention installed ${newId}, got: ${result}`,
      );

      // Verify destination exists
      const dstDir = path.join(stateDir, "workflows", newId);
      assert.ok(fs.statSync(dstDir).isDirectory(), `destination dir must exist: ${dstDir}`);

      // Verify workflow.yml id is rewritten (exact match, not substring)
      const ymlContent = fs.readFileSync(path.join(dstDir, "workflow.yml"), "utf-8");
      assert.ok(
        new RegExp(`^id: ${newId}\\s*$`, "m").test(ymlContent),
        `workflow.yml must have id: ${newId} as its own line`,
      );
      assert.ok(
        !new RegExp(`^id: ${baseWfId}\\s*$`, "m").test(ymlContent),
        `workflow.yml must NOT contain id: ${baseWfId} as its own line`,
      );

      // Verify other files are byte-identical
      const srcReadme = fs.readFileSync(path.join(stateDir, "workflows", baseWfId, "README.md"));
      const dstReadme = fs.readFileSync(path.join(dstDir, "README.md"));
      assert.deepEqual(srcReadme, dstReadme, "README.md must be byte-identical");
    } finally {
      cleanup(tmpHome);
    }
  });

  it("workflow.yml id field is correctly rewritten (exact match only)", () => {
    const tmpHome = makeTempDir();
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      const baseWfId = "bug-fix-merge";
      const scenarioId = "s99";
      const newId = `${baseWfId}-${scenarioId}`;

      // Create workflow with a similar-but-different id to verify exact match
      const workflowsDir = path.join(stateDir, "workflows");
      const wfDir = path.join(workflowsDir, baseWfId);
      fs.mkdirSync(wfDir, { recursive: true });

      // Contains both the exact id and a comment mentioning the id
      const yml = [
        `# id: ${baseWfId}-extra should not be touched`,
        `id: ${baseWfId}`,
        `name: Test`,
        `version: 1`,
        ``,
        `agents:`,
        `  - id: fixer`,
        `    name: Fixer`,
      ].join("\n");
      fs.writeFileSync(path.join(wfDir, "workflow.yml"), yml);

      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpHome,
        TAMANDUA_STATE_DIR: stateDir,
      };

      execSync(
        `bash ${JSON.stringify(installScript)} ${baseWfId} ${scenarioId}`,
        { encoding: "utf-8", env, stdio: ["pipe", "pipe", "pipe"] },
      );

      const dstYml = fs.readFileSync(
        path.join(workflowsDir, newId, "workflow.yml"),
        "utf-8",
      );

      // The comment line should NOT be touched
      assert.ok(
        dstYml.includes(`# id: ${baseWfId}-extra should not be touched`),
        "comment line should remain unchanged",
      );
      // The actual id line should be rewritten
      assert.ok(dstYml.includes(`id: ${newId}`), `must have id: ${newId}`);
      assert.ok(!dstYml.match(/^id: bug-fix-merge$/m), "must not have old id");
    } finally {
      cleanup(tmpHome);
    }
  });

  it("fails when destination already exists", () => {
    const tmpHome = makeTempDir();
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      const baseWfId = "test-dup";
      const scenarioId = "s1";
      const newId = `${baseWfId}-${scenarioId}`;

      createTestWorkflow(stateDir, baseWfId);

      // Create destination ahead of time (simulate prior install)
      fs.mkdirSync(path.join(stateDir, "workflows", newId), { recursive: true });

      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpHome,
        TAMANDUA_STATE_DIR: stateDir,
      };

      try {
        execSync(
          `bash ${JSON.stringify(installScript)} ${baseWfId} ${scenarioId} 2>&1`,
          { encoding: "utf-8", env },
        );
        assert.fail("Should have failed");
      } catch (e: any) {
        assert.ok(
          (e.stdout ?? "").includes("already exists") || (e.stderr ?? "").includes("already exists"),
          `should mention already exists, stdout: ${e.stdout}, stderr: ${e.stderr}`,
        );
      }
    } finally {
      cleanup(tmpHome);
    }
  });

  it("produces behaviors fragment with correct workflowId_agentId keys", () => {
    const tmpHome = makeTempDir();
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      const baseWfId = "feature-dev-merge-worktree";
      const scenarioId = "test";
      const newId = `${baseWfId}-${scenarioId}`;

      // Create a workflow with the same structure as real feature-dev-merge-worktree
      const workflowsDir = path.join(stateDir, "workflows");
      const wfDir = path.join(workflowsDir, baseWfId);
      fs.mkdirSync(wfDir, { recursive: true });

      const yml = [
        `id: ${baseWfId}`,
        `name: Feature Dev Merge`,
        `version: 1`,
        `description: Test`,
        ``,
        `agents:`,
        `  - id: planner`,
        `    name: Planner`,
        `    role: analysis`,
        `    description: Plans things`,
        `  - id: developer`,
        `    name: Developer`,
        `    role: coding`,
        `    description: Builds things`,
        `  - id: verifier`,
        `    name: Verifier`,
        `    role: verification`,
        `    description: Checks things`,
      ].join("\n");
      fs.writeFileSync(path.join(wfDir, "workflow.yml"), yml);

      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpHome,
        TAMANDUA_STATE_DIR: stateDir,
      };

      const result = execSync(
        `bash ${JSON.stringify(installScript)} ${baseWfId} ${scenarioId}`,
        { encoding: "utf-8", env },
      );

      // stdout contains the behaviors fragment with keys for each agent
      assert.ok(result.includes(`"${newId}_planner": {}`), "should have planner key");
      assert.ok(result.includes(`"${newId}_developer": {}`), "should have developer key");
      assert.ok(result.includes(`"${newId}_verifier": {}`), "should have verifier key");
    } finally {
      cleanup(tmpHome);
    }
  });

  it("--json produces compact JSON output", () => {
    const tmpHome = makeTempDir();
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      const baseWfId = "test-json";
      const scenarioId = "j1";

      const workflowsDir = path.join(stateDir, "workflows");
      const wfDir = path.join(workflowsDir, baseWfId);
      fs.mkdirSync(wfDir, { recursive: true });

      fs.writeFileSync(path.join(wfDir, "workflow.yml"), [
        `id: ${baseWfId}`,
        `name: Test JSON`,
        `version: 1`,
        ``,
        `agents:`,
        `  - id: agent1`,
        `    name: Agent One`,
      ].join("\n"));

      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpHome,
        TAMANDUA_STATE_DIR: stateDir,
      };

      const result = execSync(
        `bash ${JSON.stringify(installScript)} ${baseWfId} ${scenarioId} --json`,
        { encoding: "utf-8", env },
      );

      // stdout should be valid JSON
      const parsed = JSON.parse(result.trim().split("\n").pop()!);
      assert.ok(typeof parsed === "object", "output should be a JSON object");
      assert.ok(`${baseWfId}-${scenarioId}_agent1` in parsed,
        `should have full workflowId_agentId key`);
    } finally {
      cleanup(tmpHome);
    }
  });

  it("agent IDs are extracted from workflow.yml correctly", () => {
    const tmpHome = makeTempDir();
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      const baseWfId = "multi-agent";

      const workflowsDir = path.join(stateDir, "workflows");
      const wfDir = path.join(workflowsDir, baseWfId);
      fs.mkdirSync(wfDir, { recursive: true });

      // More complex YAML with agents and other keys
      fs.writeFileSync(path.join(wfDir, "workflow.yml"), [
        `id: ${baseWfId}`,
        `name: Multi Agent Test`,
        `version: 1`,
        ``,
        `run:`,
        `  workspace: worktree`,
        ``,
        `agents:`,
        `  - id: alpha`,
        `    name: Alpha`,
        `    role: analysis`,
        `  - id: beta`,
        `    name: Beta`,
        `    role: coding`,
        `  - id: gamma`,
        `    name: Gamma`,
        `    role: verification`,
        ``,
        `steps:`,
        `  - id: step1`,
        `    agent: alpha`,
      ].join("\n"));

      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpHome,
        TAMANDUA_STATE_DIR: stateDir,
      };

      const result = execSync(
        `bash ${JSON.stringify(installScript)} ${baseWfId} s1`,
        { encoding: "utf-8", env },
      );

      assert.ok(result.includes(`${baseWfId}-s1_alpha`), "should have alpha key");
      assert.ok(result.includes(`${baseWfId}-s1_beta`), "should have beta key");
      assert.ok(result.includes(`${baseWfId}-s1_gamma`), "should have gamma key");
    } finally {
      cleanup(tmpHome);
    }
  });
});

// ── fork-parity-check tests ──────────────────────────────────────────────

describe("fork-parity-check (US-006)", () => {
  it("script exists and is executable", () => {
    assert.ok(fs.existsSync(forkParityScript), "fork-parity-check must exist");
    const stat = fs.statSync(forkParityScript);
    assert.ok((stat.mode & 0o100) !== 0, "fork-parity-check must be executable");
  });

  it("exits 0 when non-knob regions match FROZEN_SHA", () => {
    const result = execSync(`bash ${JSON.stringify(forkParityScript)} 2>&1`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    // Verify it reports all passed
    assert.ok(
      result.includes("all 4 files passed"),
      `should report all passed, got: ${result}`,
    );
  });

  it("exits non-zero with diff when a non-knob line is modified", () => {
    // Modify runtime-shared.mjs temporarily with a non-knob change
    const sharedPath = path.join(runtimesDir, "runtime-shared.mjs");
    const backup = `${sharedPath}.test-backup`;
    fs.copyFileSync(sharedPath, backup);

    try {
      // Add a non-knob modification — change a function name
      // runtime-shared.mjs has: export function parsePrompt(...)
      const content = fs.readFileSync(sharedPath, "utf-8");
      const modified = content.replace(
        "export function parsePrompt(",
        "export function xxxParsePrompt(",
      );
      fs.writeFileSync(sharedPath, modified);

      try {
        execSync(`bash ${JSON.stringify(forkParityScript)}`, {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert.fail("Should have exited non-zero");
      } catch (e: any) {
        assert.ok(e.stderr?.includes("drift"),
          `stderr should mention drift, got: ${e.stderr}`);
        assert.notEqual(e.status, 0, "should exit non-zero");
      }
    } finally {
      fs.copyFileSync(backup, sharedPath);
      fs.unlinkSync(backup);
    }
  });

  it("exits 0 when only knob regions are modified", () => {
    // Add a line inside a KNOB-REGION block
    const piPath = path.join(runtimesDir, "runtime-pi.mjs");
    const backup = `${piPath}.test-backup`;
    fs.copyFileSync(piPath, backup);

    try {
      const content = fs.readFileSync(piPath, "utf-8");
      // Insert a line right after the first KNOB-REGION-BEGIN
      const modified = content.replace(
        "// KNOB-REGION-BEGIN — US-004 fault injection knobs\n// ══════",
        "// KNOB-REGION-BEGIN — US-004 fault injection knobs\n// ══════\n// test: knob-only modification\n",
      );
      fs.writeFileSync(piPath, modified);

      // Should still pass
      const result = execSync(`bash ${JSON.stringify(forkParityScript)} 2>&1`, {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      assert.ok(
        result.includes("all 4 files passed"),
        `should pass with knob-only change, got: ${result}`,
      );
    } finally {
      fs.copyFileSync(backup, piPath);
      fs.unlinkSync(backup);
    }
  });

  it("--verbose shows per-file status", () => {
    const result = execSync(`bash ${JSON.stringify(forkParityScript)} --verbose 2>&1`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    assert.ok(result.includes("OK:"), "verbose should show per-file OK lines");
    assert.ok(result.includes("runtime-pi.mjs"), "verbose should mention runtime-pi.mjs");
    assert.ok(result.includes("runtime-hermes.mjs"), "verbose should mention runtime-hermes.mjs");
  });

  it("--verify-perturb detects deliberate non-knob modification", () => {
    const result = execSync(
      `bash ${JSON.stringify(forkParityScript)} --verify-perturb 2>&1`,
      {
        cwd: repoRoot,
        encoding: "utf-8",
      },
    );
    assert.ok(
      result.includes("PASSED (detected perturbation)"),
      `should report perturbation detected, got: ${result}`,
    );
  });

  it("--verify-perturb restores the file after testing", () => {
    const sharedPath = path.join(runtimesDir, "runtime-shared.mjs");
    const before = fs.readFileSync(sharedPath, "utf-8");

    execSync(`bash ${JSON.stringify(forkParityScript)} --verify-perturb 2>&1`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    const after = fs.readFileSync(sharedPath, "utf-8");
    assert.equal(before, after, "file must be restored after --verify-perturb");
    // Clean up any leftover backup
    try { fs.unlinkSync(`${sharedPath}.perturb-backup`); } catch { /* ok */ }
  });

  it("detects invalid FROZEN_SHA", () => {
    const shaBackup = path.join(runtimesDir, "FROZEN_SHA");
    const backup = `${shaBackup}.test-backup`;
    fs.copyFileSync(shaBackup, backup);

    try {
      fs.writeFileSync(shaBackup, "0000000000000000000000000000000000000000");
      try {
        execSync(`bash ${JSON.stringify(forkParityScript)}`, {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert.fail("Should have failed");
      } catch (e: any) {
        assert.ok(
          e.stderr?.includes("not a valid commit"),
          `stderr should mention not a valid commit, got: ${e.stderr}`,
        );
        assert.notEqual(e.status, 0);
      }
    } finally {
      fs.copyFileSync(backup, shaBackup);
      fs.unlinkSync(backup);
    }
  });
});

// ── KNOB-REGIONS.md tests ────────────────────────────────────────────────

describe("KNOB-REGIONS.md (US-006)", () => {
  it("file exists in torture-test/scripted-runtimes/", () => {
    const mdPath = path.join(runtimesDir, "KNOB-REGIONS.md");
    assert.ok(fs.existsSync(mdPath), "KNOB-REGIONS.md must exist");
  });

  it("documents runtime-pi.mjs knob regions", () => {
    const content = fs.readFileSync(
      path.join(runtimesDir, "KNOB-REGIONS.md"),
      "utf-8",
    );
    assert.ok(content.includes("runtime-pi.mjs"), "must document runtime-pi.mjs");
    assert.ok(content.includes("US-004"), "must reference US-004");
    assert.ok(content.match(/Total regions: \d/), "must state total regions count");
  });

  it("documents runtime-hermes.mjs knob regions", () => {
    const content = fs.readFileSync(
      path.join(runtimesDir, "KNOB-REGIONS.md"),
      "utf-8",
    );
    assert.ok(content.includes("runtime-hermes.mjs"), "must document runtime-hermes.mjs");
    assert.ok(content.includes("US-005"), "must reference US-005");
  });

  it("documents non-knob baseline modifications", () => {
    const content = fs.readFileSync(
      path.join(runtimesDir, "KNOB-REGIONS.md"),
      "utf-8",
    );
    assert.ok(
      content.includes("Non-knob modifications"),
      "must document non-knob modifications section",
    );
    assert.ok(content.includes("Import path adjustment"), "must document import path adjustments");
    assert.ok(
      content.includes("behaviorForInvocation"),
      "must document behaviorForInvocation change",
    );
  });
});
