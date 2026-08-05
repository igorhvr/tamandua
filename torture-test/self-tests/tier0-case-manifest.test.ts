import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier0.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");
const fullMergeOracles = ["O1", "O2", "O3z", "O8", "O9", "O10", "O11"];
const workflowOracles = ["O1", "O3z", "O11"];

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readCases(): Record<string, any>[] {
  return fs.readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function discoverScenarioMetadata(): Record<string, any>[] {
  const files: string[] = [
    path.join(ttRoot, "scenarios", "w0.9", "scenario.json"),
    path.join(ttRoot, "scenarios", "w4.25", "scenario.json"),
  ];
  for (const arm of fs.readdirSync(path.join(ttRoot, "scenarios", "w4.49"), { withFileTypes: true })) {
    if (arm.isDirectory()) files.push(path.join(ttRoot, "scenarios", "w4.49", arm.name, "scenario.json"));
  }
  for (const cell of fs.readdirSync(path.join(ttRoot, "scenarios", "w4.35"), { withFileTypes: true })) {
    if (cell.isDirectory()) files.push(path.join(ttRoot, "scenarios", "w4.35", cell.name, "scenario.json"));
  }
  return files.map(readJson).sort((left, right) => left.id.localeCompare(right.id));
}

function assertContainedExisting(relative: string, label: string): void {
  const resolved = path.resolve(ttRoot, relative);
  assert.ok(resolved === ttRoot || resolved.startsWith(`${ttRoot}${path.sep}`), `${label} escapes torture-test/: ${relative}`);
  assert.ok(fs.existsSync(resolved), `${label} does not exist: ${relative}`);
}

describe("Tier-0 case manifest", () => {
  it("is schema-valid through the production controller", () => {
    const result = spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TAMANDUA_PI_BINARY: "/usr/bin/false", TAMANDUA_HERMES_BINARY: "/usr/bin/false" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Validated 35 case\(s\)/);
  });

  it("contains the complete unique preflight, scenario, and real-canary roster", () => {
    const cases = readCases();
    const ids = cases.map((record) => record.id);
    assert.equal(cases.length, 35);
    assert.equal(new Set(ids).size, ids.length, "case IDs must be unique");

    for (const id of ["W0.0-fast", "W0.1-build-unit", "W0.2-scripted-e2e", "W0.3b-binding-proof"]) {
      assert.ok(ids.includes(id), `missing Tier-0 preflight case ${id}`);
    }

    const scenarios = discoverScenarioMetadata();
    assert.equal(scenarios.filter((scenario) => scenario.id.startsWith("w4.35-")).length, 24);
    for (const scenario of scenarios) {
      const matches = cases.filter((record) => record.context?.scenario_id === scenario.id);
      assert.equal(matches.length, 1, `scenario ${scenario.id} must appear exactly once`);
      assert.equal(matches[0].context.scenario_expected_outcome, scenario.expected_outcome);
      if (scenario.expected_route !== undefined) {
        assert.deepEqual(matches[0].context.scenario_expected_route, scenario.expected_route);
      }
    }

    const w425 = cases.find((record) => record.context?.scenario_id === "w4.25-aged-state-fixture");
    assert.deepEqual(w425?.context?.scenario_legs, ["upgrade", "custom-workflow-survival", "downgrade", "re-upgrade"]);
  });

  it("pins every scripted/local case to zero tokens, mandatory gates, evidence, predicates, and existing inventory", () => {
    const cases = readCases();
    const scripted = cases.filter((record) => record.context.execution_mode === "scripted");
    assert.equal(scripted.length, 33);
    for (const record of scripted) {
      assert.equal(record.caps.tokens, 0, `${record.id} is not zero-token`);
      assert.equal(record.mandatory, true, `${record.id} is not mandatory`);
      assert.equal(record.shed_ok, false, `${record.id} is sheddable`);
      assert.ok(record.oracles.includes("O3z"), `${record.id} omits O3z`);
      assert.ok(record.gates.includes("TIER0"), `${record.id} omits the Tier-0 gate`);
      if (record.id !== "W0.0-fast") {
        assert.ok(Object.keys(record.requires).length > 0, `${record.id} has no host predicates`);
      } else {
        assert.deepEqual(record.requires, {}, "W0.0 must bootstrap the host profile without requiring it");
      }
      assert.ok(record.boundary_files.length > 0, `${record.id} has no boundary declaration`);
      assert.ok(record.forbidden.length > 0, `${record.id} has no forbidden declaration`);
      assert.equal(record.harness, "local", `${record.id} must launch through a contained local hook`);
      assert.ok(record.command, `${record.id} has no local command hook`);
    }
  });

  it("references only existing contained tasks, hooks, fixtures, workflows, scenarios, boundaries, and forbidden paths", () => {
    for (const record of readCases()) {
      assertContainedExisting(record.task, `${record.id} task`);
      for (const boundary of record.boundary_files) assertContainedExisting(boundary, `${record.id} boundary`);
      for (const forbidden of record.forbidden) assertContainedExisting(forbidden, `${record.id} forbidden path`);
      for (const hookName of ["reset", "command"] as const) {
        if (record[hookName]) assertContainedExisting(record[hookName].executable, `${record.id} ${hookName} hook`);
      }
      if (record.fixture !== "none") assertContainedExisting(`fixtures-src/${record.fixture}`, `${record.id} fixture`);
      if (record.workflow !== "local") assert.ok(fs.existsSync(path.join(repoRoot, "workflows", record.workflow)), `${record.id} workflow is missing`);
      if (record.context.scenario_path) assertContainedExisting(record.context.scenario_path, `${record.id} scenario`);
    }
  });

  it("defines exactly one real pi bfmw and one real Hermes do-now within Tier-0 budgets", () => {
    const cases = readCases();
    const real = cases.filter((record) => record.context.execution_mode === "real");
    assert.equal(real.length, 2);

    const pi = real.find((record) => record.harness === "pi");
    assert.equal(pi?.workflow, "bug-fix-merge-worktree");
    assert.equal(pi?.fixture, "tt-ts");
    assert.deepEqual(pi?.oracles, fullMergeOracles);
    assert.deepEqual(pi?.requires?.toolchains, ["node"]);

    const hermes = real.find((record) => record.harness === "hermes");
    assert.equal(hermes?.workflow, "do-now");
    assert.equal(hermes?.fixture, "tt-ts");
    assert.deepEqual(hermes?.oracles, workflowOracles);
    assert.deepEqual(hermes?.requires?.toolchains, ["node"]);

    assert.ok(cases.reduce((sum, record) => sum + record.caps.tokens, 0) <= 2_000_000, "Tier-0 exceeds 2M tokens");
    assert.ok(cases.reduce((sum, record) => sum + record.caps.wall_min, 0) <= 180, "Tier-0 exceeds 180 wall minutes");
  });
});
