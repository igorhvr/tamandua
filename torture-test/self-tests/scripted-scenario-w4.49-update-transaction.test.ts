import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const waveDir = path.join(repoRoot, "torture-test", "scenarios", "w4.49");
const arms = [
  "build-fails-after-pull",
  "sigint-mid-build-install",
  "workflow-install-post-stop",
] as const;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(waveDir, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(read(relativePath));
}

describe("W4.49 update-transaction failure scenarios", () => {
  it("declares three isolated zero-token do-now arms with gating oracles", () => {
    for (const arm of arms) {
      const metadata = readJson(path.join(arm, "scenario.json"));
      const behaviors = readJson(path.join(arm, "behaviors.json"));
      assert.equal(metadata.id, `w4.49-${arm}`);
      assert.equal(metadata.workflow_base, "do-now");
      assert.equal(metadata.command, "run.sh");
      assert.equal(metadata.expected_outcome, "completed");
      assert.deepEqual(metadata.oracles, ["O1", "O3z", "O11"]);
      assert.deepEqual(Object.keys(behaviors.agents), ["doer"]);
      assert.equal(behaviors.agents.doer.tokens, 0);
      assert.equal(behaviors.heartbeatTokens, 0);
      assert.equal(behaviors.defaultTokens, 0);
      assert.ok(fs.statSync(path.join(waveDir, arm, "run.sh")).mode & 0o111);
    }
  });

  it("pins post-pull build failure, old-service usability, diagnosis, and recovery", () => {
    const runner = read("run-update-arm.mjs");
    assert.match(runner, /build-fails-after-pull/);
    assert.match(runner, /BUILD_STARTED/);
    assert.match(runner, /assertSourceAdvanced/);
    assert.match(runner, /assertOldBuildUsable/);
    assert.match(runner, /assertStalenessDiagnosis/);
    assert.match(runner, /recoverUpdate/);
    assert.match(runner, /\["update", "--force"\]/,
      "recovery must follow doctor's force-update remedy despite contained stale run rows");
  });

  it("preserves pre-fault catalog evidence and reports the actual source-dist diagnosis gap", () => {
    const runner = read("run-update-arm.mjs");
    assert.doesNotMatch(runner, /fs\.rmSync\(catalogStamp, \{ force: true \}\)/,
      "build and SIGINT arms must not manufacture a pre-existing missing-stamp warning");
    assert.match(runner, /captureCatalogStampEvidence/,
      "the old valid catalog stamp must be captured before fault injection");
    assert.match(runner, /source(?: checkout| HEAD)?\/dist skew/i,
      "doctor evidence must be classified against the actual post-pull source/dist skew");
    assert.match(runner, /PRODUCT_FINDING/,
      "a missing product diagnosis must be surfaced explicitly rather than replaced by another warning");
  });

  it("delivers SIGINT to the proven foreground process group at an exact marker", () => {
    const runner = read("run-update-arm.mjs");
    assert.match(runner, /sigint-mid-build-install/);
    assert.match(runner, /SIGINT_READY/);
    assert.match(runner, /detached:\s*true/);
    assert.match(runner, /process\.kill\(-update\.pid,\s*"SIGINT"\)/);
    assert.match(runner, /target_provenance/);
    assert.match(runner, /dist_inventory_before/);
    assert.match(runner, /dist_inventory_after_interrupt/);
  });

  it("fails workflow installation after service stop and audits stamp writes before finally restart", () => {
    const runner = read("run-update-arm.mjs");
    assert.match(runner, /workflow-install-post-stop/);
    assert.match(runner, /Stopping daemon/);
    assert.match(runner, /Failed to install bundled workflow/);
    assert.match(runner, /assertDaemonRunning/);
    assert.match(runner, /\.catalog-version\.json/);
    assert.match(runner, /assessCatalogStampWrite/,
      "the post-stop failure must compare the stamp against valid pre-fault evidence");
    assert.match(runner, /failed update rewrote the catalog stamp before the catalog transaction completed/,
      "a premature product stamp write must be surfaced as a finding, not hidden by the fixture");
    assert.match(runner, /partial_temp_files/);
    assert.match(runner, /status", "--porcelain", "--untracked-files=all"/,
      "partial-file sweep must distinguish untracked residue from tracked lockfiles");
  });

  it("contains mutable state and cleanup to the harness-owned invocation", () => {
    const runner = read("run-update-arm.mjs");
    assert.match(runner, /TT_SCENARIO_STATE_DIR/);
    assert.match(runner, /TT_SCENARIO_COMMAND_GROUP_PROVEN/);
    assert.match(runner, /daemon-control/);
    assert.match(runner, /scripted", "stop/);
    assert.match(runner, /tokens_spent/);
    assert.match(runner, /system_tokens_spent/);
    assert.match(runner, /for \(let attempt = 0; attempt < 100; attempt \+= 1\)/,
      "listener cleanup must tolerate daemon stop propagation");
    assert.match(runner, /attempt % 10 === 0[\s\S]*daemonControl/,
      "cleanup must reissue the sanctioned stop across update restart races");
    assert.match(runner, /installedCli, \["daemon", "stop"\]/,
      "update-started replacement control planes need an exact contained stop");
    assert.match(runner, /\[\["daemon", "stop"\], \["dashboard", "stop"\], \["mcp", "stop"\]\]/,
      "every update-restarted contained service needs an exact stop");
    assert.doesNotMatch(runner, /\b(?:3334|3338|3339)\b/);
    assert.doesNotMatch(runner, /os\.tmpdir|mkdtemp|\/tmp\//);
    assert.doesNotMatch(runner, /path\.join\(seed, "node_modules"\)/,
      "fault commits must not accidentally publish fixture dependency symlinks");
  });
});
