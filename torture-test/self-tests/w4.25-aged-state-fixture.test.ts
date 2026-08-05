import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const scenarioDir = path.join(repoRoot, "torture-test", "scenarios", "w4.25");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(scenarioDir, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(read(relativePath));
}

describe("W4.25 aged-state and custom-workflow fixture", () => {
  it("pins puma identity and materializes both version-shaped binaries without network commands", () => {
    const fixture = readJson("fixture.json");
    const preparer = read("prepare-fixture.mjs");

    assert.equal(fixture.schema_version, 1);
    assert.equal(fixture.puma_ref, "refs/tags/puma");
    assert.match(fixture.puma_commit, /^[0-9a-f]{40}$/);
    assert.equal(fixture.tt_commit_source, "TT_COMMIT-or-HEAD");
    assert.match(preparer, /rev-parse[^\n]+refs\/tags\/puma\^\{commit\}/);
    assert.match(preparer, /TT_COMMIT/);
    assert.match(preparer, /git[^\n]+archive/);
    assert.match(preparer, /versions[^\n]+puma/);
    assert.match(preparer, /versions[^\n]+tt-commit/);
    assert.match(preparer, /npm[^\n]+run[^\n]+build/);
    assert.doesNotMatch(preparer, /\b(?:fetch|pull|clone|npm install|npm ci)\b/,
      "fixture execution must use prepared local objects/dependencies without network-capable commands");
  });

  it("creates completed, paused, and failed puma runs only through supported CLI operations", () => {
    const runner = read("prepare-fixture.mjs");

    assert.match(runner, /workflow[^\n]+run/);
    assert.match(runner, /workflow[^\n]+pause/);
    assert.match(runner, /workflow[^\n]+fail/);
    assert.match(runner, /status[^\n]+completed/);
    assert.match(runner, /status[^\n]+paused/);
    assert.match(runner, /status[^\n]+failed/);
    assert.match(runner, /tokens_spent/);
    assert.match(runner, /system_tokens_spent/);
    assert.doesNotMatch(runner, /INSERT\s+INTO\s+runs/i,
      "aged history must be produced by puma, never synthetic run-row insertion");
  });

  it("authors a puma-documented custom workflow with a verified SHA-256 inventory", () => {
    const workflow = read("custom-workflow/workflow.yml");
    const persona = read("custom-workflow/agents/worker/AGENTS.md");
    const inventory = read("custom-workflow.sha256").trim().split("\n");
    const runner = read("prepare-fixture.mjs");

    assert.match(workflow, /^id: puma-custom-probe$/m);
    assert.match(workflow, /^version: 1$/m);
    assert.match(workflow, /^agents:$/m);
    assert.match(workflow, /^steps:$/m);
    assert.match(workflow, /baseDir: agents\/worker/);
    assert.match(workflow, /expects: "STATUS: done"/);
    assert.match(persona, /^STATUS: done$/m);
    assert.ok(inventory.length >= 2);
    for (const line of inventory) {
      assert.match(line, /^[0-9a-f]{64}  custom-workflow\//);
      const [expected, relativePath] = line.split("  ");
      const actual = spawnSync("sha256sum", [path.join(scenarioDir, relativePath)], { encoding: "utf8" });
      assert.equal(actual.status, 0, actual.stderr);
      assert.equal(actual.stdout.split(/\s+/)[0], expected);
    }
    assert.match(runner, /workflow[^\n]+install/);
    assert.match(runner, /workflow[^\n]+list/);
    assert.match(runner, /puma-custom-probe/);
    assert.match(runner, /custom_workflow_inventory/);
  });

  it("uses deterministic puma behaviors and sanctioned hermetic daemon cleanup", () => {
    const behaviors = readJson("behaviors.json");
    const pumaBehaviors = readJson("puma-behaviors.json");
    const runner = read("prepare-fixture.mjs");

    assert.equal(behaviors.heartbeatTokens, 0);
    assert.equal(behaviors.defaultTokens, 0);
    assert.equal(behaviors.agents.doer.tokens, 0);
    assert.match(behaviors.agents.doer.mode, /^hang/);
    assert.equal(pumaBehaviors.agents.worker.tokens, 0);
    assert.match(pumaBehaviors.agents.worker.output, /^STATUS: done$/m);
    assert.match(runner, /daemon-control/);
    assert.match(runner, /scripted[^\n]+stop/);
    assert.match(runner, /scripted[^\n]+start/);
    assert.match(runner, /TT_SCENARIO_STATE_DIR/);
    assert.match(runner, /TT_SCENARIO_COMMAND_GROUP_PROVEN/);
    assert.match(runner, /fs\.realpathSync\(resolved\)/,
      "contained roots must be checked by canonical path, not lexical prefix alone");
    assert.match(runner, /contains a symlinked path component/);
    assert.match(runner, /HOME must be the exact scripted harness home/);
    assert.match(runner, /must be owned by this scenario/);
    assert.match(runner, /trustedCommandPath/);
    assert.match(runner, /hostToolPath/);
    assert.match(runner, /GIT_NO_LAZY_FETCH/);
    assert.match(runner, /GIT_CONFIG_GLOBAL/);
    assert.match(runner, /cleanupErrors/);
    assert.match(runner, /await assertPortsFree\(\)/);
    assert.match(runner, /contained evidence was preserved/);
    assert.match(runner, /PATH: `\$\{pumaBinDir\}:\$\{hostToolPath\}`/);
    assert.doesNotMatch(runner, /spawnSync\("bash", \["-lc"/,
      "host tools must not be discovered through an ambient login shell");
    assert.doesNotMatch(runner, /\b(?:3334|3338|3339|4334|4338|4339)\b/);
    assert.doesNotMatch(runner, /os\.tmpdir|mkdtemp|\/tmp\//);
    assert.ok(fs.statSync(path.join(scenarioDir, "run.sh")).mode & 0o111);
  });

  it("passes the identity and inventory preflight without mutating the checkout", () => {
    const before = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout;
    const result = spawnSync(process.execPath, [path.join(scenarioDir, "prepare-fixture.mjs"), "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TT_COMMIT: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() },
    });
    const after = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout;

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"result":"PASS"/);
    assert.equal(after, before);
  });

  it("rejects a forged sibling HOME before deleting any state", () => {
    const varRoot = path.join(repoRoot, "torture-test", "var");
    const fakeHome = fs.mkdtempSync(path.join(varRoot, "w4.25-forged-home-"));
    const fakeState = path.join(fakeHome, ".tamandua");
    const scenarioStateRoot = path.join(varRoot, "scenarios");
    fs.mkdirSync(fakeState, { recursive: true });
    fs.mkdirSync(scenarioStateRoot, { recursive: true });
    const invocation = fs.mkdtempSync(path.join(scenarioStateRoot, "w4.25-aged-state-fixture-forged-"));
    const marker = path.join(fakeHome, "must-survive");
    fs.writeFileSync(marker, "preserved\n");
    try {
      const result = spawnSync(process.execPath, [path.join(scenarioDir, "prepare-fixture.mjs")], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fakeHome,
          TAMANDUA_STATE_DIR: fakeState,
          TT_SCENARIO_STATE_DIR: invocation,
          TT_SCENARIO_COMMAND_GROUP_PROVEN: "1",
          TT_COMMIT: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(),
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /HOME must be the exact scripted harness home/);
      assert.equal(fs.readFileSync(marker, "utf8"), "preserved\n");
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(invocation, { recursive: true, force: true });
    }
  });
});

describe("W4.25 forward upgrade and custom-workflow survival", () => {
  it("uses the TT_COMMIT install shape and refreshes bundled workflows without deleting custom bytes", () => {
    const runner = read("run-upgrade.mjs");

    assert.match(runner, /prepare-fixture\.mjs/);
    assert.match(runner, /--preserve/);
    assert.match(runner, /path\.join\(scriptedHome, "\.local", "bin"\)/);
    assert.match(runner, /path\.join\(localBin, "tamandua"\)/);
    assert.match(runner, /workflow[^\n]+install[^\n]+--all/);
    assert.match(runner, /assertCustomWorkflowInventory/);
    assert.match(runner, /bundled_refresh_preserved_custom_bytes/);
  });

  it("renders aged history, checks timestamps, and resumes the paused run under TT_COMMIT", () => {
    const runner = read("run-upgrade.mjs");

    assert.match(runner, /doctor/);
    assert.match(runner, /workflow[^\n]+status/);
    assert.match(runner, /workflow[^\n]+runs[^\n]+--json/);
    assert.match(runner, /logs/);
    assert.match(runner, /assertTimestampConsistent/);
    assert.match(runner, /workflow[^\n]+resume/);
    assert.match(runner, /resume_outcome/);
  });

  it("revalidates, lists, and completes the preserved custom workflow with zero-token behaviors", () => {
    const runner = read("run-upgrade.mjs");
    const behaviors = readJson("upgrade-behaviors.json");

    assert.equal(behaviors.heartbeatTokens, 0);
    assert.equal(behaviors.defaultTokens, 0);
    assert.equal(behaviors.agents.doer.tokens, 0);
    assert.match(behaviors.agents.doer.output, /^STATUS: done$/m);
    assert.equal(behaviors.agents.worker.tokens, 0);
    assert.match(runner, /puma-custom-probe/);
    assert.match(runner, /custom_workflow_validated/);
    assert.match(runner, /custom_workflow_completed/);
    assert.match(runner, /system_tokens_spent/);
    assert.match(runner, /daemon-control/);
    assert.match(runner, /assertPortsFree/);
  });

  it("passes the forward-upgrade preflight without mutating the checkout", () => {
    const before = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout;
    const result = spawnSync(process.execPath, [path.join(scenarioDir, "run-upgrade.mjs"), "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TT_COMMIT: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() },
    });
    const after = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout;

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"leg":"forward-upgrade"/);
    assert.match(result.stdout, /"result":"PASS"/);
    assert.equal(after, before);
  });
});

describe("W4.25 downgrade and re-upgrade", () => {
  it("reuses the preserved forward-migrated state and swaps contained version binaries", () => {
    const runner = read("run-downgrade-reupgrade.mjs");

    assert.match(runner, /run-upgrade\.mjs/);
    assert.match(runner, /--preserve/);
    assert.match(runner, /versions[^\n]+puma/);
    assert.match(runner, /versions[^\n]+tt-commit/);
    assert.match(runner, /path\.join\(localBin, "tamandua"\)/);
    assert.match(runner, /daemonControl\("start", pumaBinDir/);
    assert.match(runner, /daemonControl\("start", ttBinDir/);
  });

  it("inventories schema, historical rows, DDL, migrations, and custom workflow bytes at every boundary", () => {
    const runner = read("run-downgrade-reupgrade.mjs");

    assert.match(runner, /PRAGMA user_version/);
    assert.match(runner, /sqlite_master/);
    assert.match(runner, /historical_run_rows/);
    assert.match(runner, /custom_workflow_inventory/);
    assert.match(runner, /forward_boundary/);
    assert.match(runner, /downgrade_boundary/);
    assert.match(runner, /reupgrade_boundary/);
    assert.match(runner, /silent_user_version_reduction/);
    assert.match(runner, /repeated_ddl/);
    assert.match(runner, /lost_migration_evidence/);
  });

  it("accepts only read-only compatibility or a versioned refusal and declares unsafe rollback findings", () => {
    const runner = read("run-downgrade-reupgrade.mjs");

    assert.match(runner, /read-only-compatible/);
    assert.match(runner, /diagnosable-newer-schema-refusal/);
    assert.match(runner, /PRODUCT_FINDING/);
    assert.match(runner, /(?:schema|version)/i);
    assert.match(runner, /changed_historical_run_rows/);
    assert.match(runner, /custom_workflow_mutation/);
    assert.ok(runner.indexOf("if (findings.length > 0)") < runner.indexOf("else if (downgradeRefused)"),
      "state mutations must remain PRODUCT_FINDING even when the old process also refuses");
  });

  it("disables ambient Git configuration and repository-local fsmonitor helpers", () => {
    for (const script of ["prepare-fixture.mjs", "run-upgrade.mjs", "run-downgrade-reupgrade.mjs"]) {
      const runner = read(script);
      assert.match(runner, /GIT_CONFIG_COUNT/);
      assert.match(runner, /GIT_CONFIG_PARAMETERS/);
      assert.match(runner, /GIT_CONFIG_KEY_0/);
      assert.match(runner, /core\.fsmonitor/);
      assert.match(runner, /GIT_OPTIONAL_LOCKS/);
    }
  });

  it("re-upgrades idempotently, reruns the custom workflow, and cleans zero-token state", () => {
    const runner = read("run-downgrade-reupgrade.mjs");
    const launcher = read("run.sh");

    assert.match(runner, /migration_idempotent/);
    assert.match(runner, /doctor/);
    assert.match(runner, /workflow[^\n]+runs[^\n]+--json/);
    assert.match(runner, /workflow[^\n]+list[^\n]+--json/);
    assert.match(runner, /puma-custom-probe/);
    assert.match(runner, /system_tokens_spent/);
    assert.match(runner, /assertPortsFree/);
    assert.match(runner, /state: "removed"/);
    assert.match(launcher, /run-downgrade-reupgrade\.mjs/);
  });

  it("passes downgrade/re-upgrade preflight without mutating the checkout", () => {
    const before = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout;
    const result = spawnSync(process.execPath, [path.join(scenarioDir, "run-downgrade-reupgrade.mjs"), "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TT_COMMIT: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() },
    });
    const after = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout;

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"leg":"downgrade-reupgrade"/);
    assert.match(result.stdout, /"result":"PASS"/);
    assert.equal(after, before);
  });
});
