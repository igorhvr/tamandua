import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const scenarioDir = path.join(repoRoot, "torture-test", "scenarios", "w0.9");

function read(file: string): string {
  return fs.readFileSync(path.join(scenarioDir, file), "utf8");
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(read(file));
}

describe("W0.9 install-shape fidelity scenario", () => {
  it("declares one zero-token do-now scenario with the gating oracle contract", () => {
    const metadata = readJson("scenario.json");
    const behaviors = readJson("behaviors.json");

    assert.deepEqual(metadata, {
      schema_version: 1,
      id: "w0.9-install-shape-fidelity",
      workflow_base: "do-now",
      behaviors: "behaviors.json",
      command: "run.sh",
      expected_outcome: "completed",
      oracles: ["O1", "O3z", "O11"],
    });
    assert.deepEqual(Object.keys(behaviors.agents), ["doer"]);
    assert.match(behaviors.agents.doer.output, /^STATUS: done$/m);
    assert.equal(behaviors.agents.doer.tokens, 0);
    assert.equal(behaviors.heartbeatTokens, 0);
    assert.equal(behaviors.defaultTokens, 0);
    assert.ok(fs.statSync(path.join(scenarioDir, "run.sh")).mode & 0o111);
  });

  it("pins the remote installer, shallow clone, fresh resolution, and installed symlinks", () => {
    const runner = read("run-install-shape.mjs");
    const installer = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");

    assert.match(runner, /"scripts", "install\.sh"/);
    assert.match(installer, /https:\/\/github\.com\/\$\{REPO\}\.git/);
    assert.match(runner, /file:\/\//);
    assert.match(runner, /"\.git", "shallow"/);
    assert.match(runner, /rev-list[^\n]+--count[^\n]+HEAD/);
    assert.match(runner, /npm-log\.jsonl/);
    assert.match(runner, /npm install/);
    assert.match(runner, /npm ci/);
    assert.match(runner, /"dist", "cli", "cli\.js"/);
    assert.match(runner, /"\.local", "bin", "tamandua"/);
    assert.match(installer, /workflow install --all/);
  });

  it("pins doctor, scripted do-now, zero-token, update, reset-hard reinstall, and uninstall evidence", () => {
    const runner = read("run-install-shape.mjs");

    assert.match(runner, /doctor/);
    assert.match(runner, /workflow[^\n]+run/);
    assert.match(runner, /TT_SCENARIO_WORKFLOW_ID/);
    assert.match(runner, /requiredValue\("TT_SCENARIO_WORKFLOW_ID"\)/,
      "workflow IDs must remain identifiers rather than being path-resolved");
    assert.match(runner, /tokens_spent/);
    assert.match(runner, /system_tokens_spent/);
    assert.match(runner, /update/);
    assert.match(runner, /--ff-only/);
    assert.match(runner, /reset --hard/);
    assert.match(runner, /uninstall/);
    assert.match(runner, /daemon-control/);
    assert.match(runner, /scripted[^\n]+stop/);
  });

  it("contains every mutable artifact beneath the disposable HOME or torture-test var", () => {
    const runner = read("run-install-shape.mjs");
    const harness = fs.readFileSync(path.join(repoRoot, "torture-test", "scenarios", "lib", "run-scripted-scenario"), "utf8");

    assert.match(runner, /TT_SCENARIO_STATE_DIR/);
    assert.match(runner, /TT_SCENARIO_COMMAND_GROUP_PROVEN/);
    assert.match(runner, /home-disposable/);
    assert.match(runner, /remote\.git/);
    assert.doesNotMatch(runner, /\b(?:3334|3338|3339)\b/);
    assert.doesNotMatch(runner, /os\.tmpdir|mkdtemp|\/tmp\//);
    assert.match(harness, /env PATH="\$REPO_ROOT\/bin:\$PATH"[\s\S]*?"\$DAEMON_CONTROL" scripted/,
      "scripted daemon must launch the checkout under test, not an unrelated PATH install");
  });
});
