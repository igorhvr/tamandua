// Tier-1 self-test (E3.D US-008 / S11 controller): local-sentinel launch
// adapter — never `workflow run local`.
//
// W2.24-docs-drift (tier1.jsonl: workflow `local` + harness `pi`) is the
// docs-drift sentinel. There is no `local` workflow in any catalog, so the
// literal argv `workflow run local` must NEVER be constructed or executed:
//   - the supported W2.24 shape (workflow `local` + harness `pi`) resolves to
//     the shipped TT-custom spec tt-docs-drift (US-007), which the adapter
//     ensures is installed in the contained TT home (tt-catalog-install /
//     tt-required-workflows seam) before the resolved launch;
//   - any other sentinel profile on the workflow-launch path (workflow
//     `local` + a harness other than pi) fails closed with the DISTINCT
//     reason `local-sentinel-unsupported`;
//   - adapter evidence (sentinel profile, resolved workflow id, install
//     outcome) is recorded on the attempt as attempt.sentinel_adapter.
//
// Zero-token by construction: the dry-run hook (TT_DRY_RUN_REAL_LAUNCH)
// records argv without spawning a model; the real-launch controls point the
// `tamandua` executable at a throwaway PATH stub that records its argv and
// exits 0 — no model is ever invoked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const varRoot = path.join(ttRoot, "var");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runTt(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  // The real-launch adapter tests spawn the contained launch path
  // (tt-catalog-install -> the repo's own dist CLI). NODE_TEST_CONTEXT
  // propagates into that CLI and auto-activates the product test-isolation
  // guard, which false-positives because this worktree lives under
  // ~/.tamandua/worktrees/. Strip both guard vars from the controller's spawn
  // env (documented self-test pattern); the controller's own containment
  // layer (assertContainedHome on every spawn) stays fully active.
  const env = { ...process.env, HOME: os.homedir(), ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  const res = spawnSync(process.execPath, [controller, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Read one case record VERBATIM from cases/tier1.jsonl by id.
function tier1Record(id: string): any {
  const lines = fs
    .readFileSync(path.join(ttRoot, "cases", "tier1.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const record = lines.find((record) => record.id === id);
  assert.ok(record, `cases/tier1.jsonl must contain the case ${id}`);
  return structuredClone(record);
}

// Write a temp manifest under var/ (gitignored). Returns the manifest path.
function writeManifest(records: any[]): string {
  const manifestPath = path.join(varRoot, `US008-${Date.now()}-${process.pid}.jsonl`);
  fs.writeFileSync(manifestPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return manifestPath;
}

function campaignIdOf(res: RunResult): string | null {
  const match = CAMPAIGN_LINE.exec(res.stdout);
  return match === null ? null : match[1];
}

function caseStateOf(campaignId: string, caseId: string): any {
  const state = loadJson(path.join(varRoot, "results", campaignId, "state.json"));
  return state.cases.find((caseState: any) => caseState.id === caseId);
}

function cleanupCampaign(campaignId: string | null, manifestPath: string, outPath: string | null = null) {
  fs.rmSync(manifestPath, { force: true });
  if (outPath !== null) fs.rmSync(outPath, { force: true });
  if (campaignId !== null) {
    fs.rmSync(path.join(varRoot, "results", campaignId), { recursive: true, force: true });
  }
}

// Install a throwaway `tamandua` PATH stub that records its argv; returns
// { stubBin, marker }.
function installTamanduaStub(stubBin: string): { marker: string } {
  const marker = path.join(stubBin, "stub-invoked.log");
  const stub = path.join(stubBin, "tamandua");
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "STUB-LAUNCHED: $*" >> "${marker}"\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  return { marker };
}

// Install a throwaway `tt-catalog-install` stub (exit + optional REASON).
function installCatalogStub(stubBin: string, { reason = null, exitCode = 0 } = {}): string {
  const stub = path.join(stubBin, "tt-catalog-install");
  const body = reason === null
    ? `#!/usr/bin/env bash\necho "[stub-catalog] ok"\nexit ${exitCode}\n`
    : `#!/usr/bin/env bash\necho "REASON: ${reason}" >&2\necho "DETAILS: stub catalog failure" >&2\nexit ${exitCode}\n`;
  fs.writeFileSync(stub, body);
  fs.chmodSync(stub, 0o755);
  return stub;
}

describe("US-008 local-sentinel launch adapter (S11 controller)", () => {
  it("AC1: dry-run launch argv for W2.24-docs-drift names tt-docs-drift and never `local`", () => {
    const manifestPath = writeManifest([tier1Record("W2.24-docs-drift")]);
    const outPath = path.join(varRoot, `us008-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

    const records = fs.readFileSync(outPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1, "one argv record for the one sentinel case");
    const record = records[0];
    assert.equal(record.case_id, "W2.24-docs-drift");
    assert.equal(record.workflow, "local", "the manifest workflow field is preserved in the record");
    assert.equal(record.resolved_workflow, "tt-docs-drift",
      "the record must bind the constructed argv to the resolved sentinel workflow");
    assert.deepEqual(record.argv.slice(0, 4), ["tamandua", "workflow", "run", "tt-docs-drift"],
      "the argv must be 'workflow run tt-docs-drift', never 'workflow run local'");
    assert.ok(!record.argv.includes("local"), "the literal `local` must never appear in the argv");
    assert.ok(record.argv.includes("--pi-as-harness"), "the sentinel argv must carry --pi-as-harness");
    const taskIdx = record.argv.indexOf("--task-file");
    assert.ok(taskIdx >= 0, "argv must include --task-file");
    assert.equal(record.argv[taskIdx + 1], "cases/tasks/tier1/W2.24-docs-drift.md");
    const wdIdx = record.argv.indexOf("--working-directory-for-harness");
    assert.ok(wdIdx >= 0, "argv must include --working-directory-for-harness");
    assert.match(record.argv[wdIdx + 1], /W2\.24-docs-drift\/tt-ts$/);
    assert.ok(record.argv.includes("--wait") && record.argv.includes("--json"));

    // AC3 (dry-run flavor): adapter evidence is recorded on the attempt.
    const caseState = caseStateOf(campaignId, "W2.24-docs-drift");
    assert.equal(caseState.outcome, "PASS", "the dry-run case must be PASS (zero tokens)");
    assert.equal(caseState.attempts.length, 1);
    const adapter = caseState.attempts[0].sentinel_adapter;
    assert.ok(adapter !== undefined, "attempt must carry sentinel_adapter evidence");
    assert.deepEqual(adapter.profile, {
      workflow: "local",
      harness: "pi",
      case_id: "W2.24-docs-drift",
    });
    assert.equal(adapter.workflow_id, "tt-docs-drift");
    assert.equal(adapter.resolution, "local-sentinel");
    assert.equal(adapter.install.outcome, "dry-run-skipped",
      "the zero-token dry run records the install outcome as skipped");
    const state = loadJson(path.join(varRoot, "results", campaignId, "state.json"));
    assert.equal(state.spend.tokens_observed, 0, "the dry run spends zero tokens");

    cleanupCampaign(campaignId, manifestPath, outPath);
  });

  it("AC4: a non-sentinel case's launch argv is unchanged (regression)", () => {
    // W1.L2-ts is a pi + tt-shim-probe case with a context passthrough field
    // (test_cmd) — its argv must be byte-identical to the pre-adapter shape.
    const manifestPath = writeManifest([
      tier1Record("W2.24-docs-drift"),
      tier1Record("W1.L2-ts"),
    ]);
    const outPath = path.join(varRoot, `us008-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

    const byId = new Map(fs.readFileSync(outPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .map((record) => [record.case_id, record]));
    assert.equal(byId.size, 2, "one argv record per case");

    const ts = byId.get("W1.L2-ts");
    assert.ok(ts, "W1.L2-ts argv must be recorded");
    assert.equal(ts.resolved_workflow, null, "non-sentinel cases have no resolved-workflow override");
    assert.deepEqual(ts.argv.slice(1), [
      "workflow", "run", "tt-shim-probe",
      "--task-file", "cases/tasks/tier1/W1.L2-ts.md",
      "--context", "test_cmd=npm test",
      "--pi-as-harness",
      "--working-directory-for-harness",
      path.join(varRoot, "fixtures", "work", "W1.L2-ts", "tt-ts"),
      "--wait", "--json",
    ], "a non-sentinel case's argv must be unchanged by the adapter");
    assert.ok(!ts.argv.includes("tt-docs-drift") && !ts.argv.includes("local"),
      "the sentinel mapping must never leak into non-sentinel argv");

    const tsState = caseStateOf(campaignId, "W1.L2-ts");
    assert.equal(tsState.attempts[0].sentinel_adapter, undefined,
      "non-sentinel attempts must not carry sentinel_adapter evidence");
    const sentinelState = caseStateOf(campaignId, "W2.24-docs-drift");
    assert.equal(sentinelState.attempts[0].sentinel_adapter.workflow_id, "tt-docs-drift");

    cleanupCampaign(campaignId, manifestPath, outPath);
  });

  it("AC2: an unsupported sentinel profile (workflow local + hermes) fails closed with local-sentinel-unsupported", () => {
    const record = tier1Record("W2.24-docs-drift");
    record.id = "SENTINEL-LOCAL-HERMES";
    record.harness = "hermes";
    const manifestPath = writeManifest([record]);
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 2, "a fail-closed TEST_INFRA campaign exits 2 (INFRA_FAILURE)");

    const caseState = caseStateOf(campaignId, "SENTINEL-LOCAL-HERMES");
    assert.equal(caseState.outcome, "TEST_INFRA_FAIL");
    assert.equal(caseState.attempts.length, 1, "the guard records exactly one launch-intent attempt");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.classification_reason.category, "local-sentinel-unsupported",
      "the distinct fail-closed reason must be local-sentinel-unsupported");
    assert.deepEqual(attempt.sentinel_adapter, {
      profile: { workflow: "local", harness: "hermes", case_id: "SENTINEL-LOCAL-HERMES" },
      workflow_id: null,
      resolution: "local-sentinel-unsupported",
      install: { outcome: "not-attempted" },
    });
    const state = loadJson(path.join(varRoot, "results", campaignId, "state.json"));
    assert.ok(!JSON.stringify(state).includes('"run","local"'),
      "the literal 'workflow run local' argv must never appear in the campaign state");
    assert.ok(!fs.existsSync(path.join(varRoot, "results", campaignId, "evidence", record.id)),
      "the unsupported sentinel must never reach a spawn (no launch evidence dir)");

    cleanupCampaign(campaignId, manifestPath);
  });

  it("the adapter install leg runs (ok) and the resolved launch argv names tt-docs-drift", () => {
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us008-launch-"));
    const { marker } = installTamanduaStub(stubBin);
    const catalogStub = installCatalogStub(stubBin);
    const manifestPath = writeManifest([tier1Record("W2.24-docs-drift")]);
    let res!: RunResult;
    let campaignId: string | null = null;
    let markerContent = "";
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
        TT_CONTROLLER_PREFLIGHT_CATALOG: catalogStub,
      });
      campaignId = campaignIdOf(res);
      if (fs.existsSync(marker)) markerContent = fs.readFileSync(marker, "utf8");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);

    const launches = markerContent.split(/\r?\n/).filter((line) => line.length > 0);
    assert.equal(launches.length, 1, "the adapter must launch exactly one tamandua process");
    assert.match(launches[0], /workflow run tt-docs-drift /, "the launch must name tt-docs-drift");
    assert.ok(!launches[0].includes(" local") && !launches[0].includes("run local"),
      "the launch argv must never contain the literal `local` workflow name");
    assert.match(launches[0], /--pi-as-harness/, "the launch must carry --pi-as-harness");
    assert.match(launches[0], /--working-directory-for-harness/);

    const caseState = caseStateOf(campaignId, "W2.24-docs-drift");
    const adapter = caseState.attempts[0].sentinel_adapter;
    assert.equal(adapter.workflow_id, "tt-docs-drift");
    assert.equal(adapter.resolution, "local-sentinel");
    assert.equal(adapter.install.ok, true);
    assert.equal(adapter.install.helper, "tt-catalog-install");
    assert.equal(adapter.install.exit_code, 0);
    // The silent stub cannot produce a run id, so the campaign classifies the
    // launch as TEST_INFRA_FAIL — the sentinel evidence above proves the
    // adapter wiring (install -> resolved launch) independently of that.
    assert.equal(caseState.outcome, "TEST_INFRA_FAIL");
    assert.equal(caseState.attempts[0].classification_reason.category, "workflow-run-identification",
      "the silent tamandua stub must be classified by the existing run-identification path");

    cleanupCampaign(campaignId, manifestPath);
  });

  it("a missing tt-docs-drift spec fails closed with catalog-missing: tt-docs-drift and never launches", () => {
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us008-catalog-miss-"));
    const { marker } = installTamanduaStub(stubBin);
    const catalogStub = installCatalogStub(stubBin, { reason: "catalog-missing: tt-docs-drift", exitCode: 1 });
    const manifestPath = writeManifest([tier1Record("W2.24-docs-drift")]);
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
        TT_CONTROLLER_PREFLIGHT_CATALOG: catalogStub,
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.ok(!fs.existsSync(marker),
      "a catalog-missing sentinel must never reach the tamandua launch");

    const caseState = caseStateOf(campaignId, "W2.24-docs-drift");
    assert.equal(caseState.outcome, "TEST_INFRA_FAIL");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.classification_reason.category, "catalog-missing: tt-docs-drift",
      "the distinct catalog-missing: tt-docs-drift reason must be surfaced");
    const adapter = attempt.sentinel_adapter;
    assert.equal(adapter.workflow_id, "tt-docs-drift");
    assert.equal(adapter.install.ok, false);
    assert.equal(adapter.install.reason, "catalog-missing: tt-docs-drift");
    assert.equal(adapter.install.exit_code, 1);

    cleanupCampaign(campaignId, manifestPath);
  });

  it("the REAL tt-catalog-install seam installs tt-docs-drift into the contained TT home and the launch names it", () => {
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us008-real-seam-"));
    const { marker } = installTamanduaStub(stubBin);
    const manifestPath = writeManifest([tier1Record("W2.24-docs-drift")]);
    let res!: RunResult;
    let campaignId: string | null = null;
    let markerContent = "";
    try {
      // No TT_CONTROLLER_PREFLIGHT_CATALOG override: the adapter must invoke
      // the REAL tt-catalog-install seam under the contained spawn env.
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
      });
      campaignId = campaignIdOf(res);
      if (fs.existsSync(marker)) markerContent = fs.readFileSync(marker, "utf8");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);

    assert.ok(
      fs.existsSync(path.join(varRoot, "home", ".tamandua", "workflows", "tt-docs-drift", "workflow.yml")),
      "the real catalog seam must install the tt-docs-drift spec into the contained TT home",
    );
    const launches = markerContent.split(/\r?\n/).filter((line) => line.length > 0);
    assert.equal(launches.length, 1, "the adapter must launch exactly one tamandua process");
    assert.match(launches[0], /workflow run tt-docs-drift /, "the launch must name tt-docs-drift");
    assert.ok(!launches[0].includes(" local") && !launches[0].includes("run local"));

    const caseState = caseStateOf(campaignId, "W2.24-docs-drift");
    const adapter = caseState.attempts[0].sentinel_adapter;
    assert.equal(adapter.workflow_id, "tt-docs-drift");
    assert.equal(adapter.install.ok, true, `install leg failed:\n${JSON.stringify(adapter.install)}`);
    assert.equal(adapter.install.helper, "tt-catalog-install");

    cleanupCampaign(campaignId, manifestPath);
  });
});
