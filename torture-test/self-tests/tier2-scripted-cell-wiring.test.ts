// US-001 — Tier-2 scripted-pi scenario cells: the four case rows that
// previously had NO scenario cell (W4.04c-keyline-laundering,
// W4.36-broken-work-concession, W4.38-hostile-task-scripted,
// W4.39-a-union-honest) now carry real cells under scenarios/.
//
// Pins the US-001 authoring layer:
//   * each of the four cells exists with scenario.json, behaviors.json,
//     run.sh (executable) and a runner .mjs (AC1);
//   * `validate-scenario.mjs <dir>` exits 0 for all four (AC2);
//   * the four tier2.jsonl rows carry context.scenario_id matching the cell
//     scenario.json id and context.scenario_path pointing at the cell dir
//     (AC3);
//   * each cell's behaviors.json encodes the canned agent outputs described
//     in its case task doc — W4.04c emits FAIL_MISSING: 0 and
//     MERGE_GATE: off as KEY lines, W4.38's doer completes honestly,
//     W4.39-a's verifier reports the red honestly (AC4);
//   * each runner ends with a single-line JSON summary whose last line
//     parses and carries result "PASS" (AC6 static shape — the cells are
//     executed end-to-end by run-scripted-scenario in the heavy battery).
//
// Confined to torture-test/. Zero tokens. No daemon is started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const validator = path.join(ttRoot, "scenarios", "lib", "validate-scenario.mjs");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");

// The four US-001 cases, their cell dirs, and the expected scenario id
// (the cell's scenario.json id, which must equal the manifest
// context.scenario_id).
const CELL_DIRS: Record<string, string> = {
  "W4.04c-keyline-laundering": "scenarios/w4.04c",
  "W4.36-broken-work-concession": "scenarios/w4.36",
  "W4.38-hostile-task-scripted": "scenarios/w4.38",
  "W4.39-a-union-honest": "scenarios/w4.39a",
};
const SCENARIO_IDS: Record<string, string> = {
  "W4.04c-keyline-laundering": "w4.04c-keyline-laundering",
  "W4.36-broken-work-concession": "w4.36-broken-work-concession",
  "W4.38-hostile-task-scripted": "w4.38-hostile-task-scripted",
  "W4.39-a-union-honest": "w4.39-a-union-honest",
};

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
};

type Case = Record<string, any>;

function readManifest(): Case[] {
  const source = fs.readFileSync(manifestPath, "utf8");
  const records: Case[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line));
  }
  return records;
}

function recordById(records: Case[], id: string): Case {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${id} must exist in the manifest`);
  return record;
}

function run(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 120_000) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

describe("Tier-2 US-001 — the four scripted-pi scenario cells (W4.04c / W4.36 / W4.38-scripted / W4.39-a)", () => {
  it("each cell dir contains scenario.json, behaviors.json, run.sh (executable), and a runner .mjs (AC1)", () => {
    for (const [id, cellDir] of Object.entries(CELL_DIRS)) {
      const cellRoot = path.join(ttRoot, cellDir);
      for (const file of ["scenario.json", "behaviors.json", "run.sh"]) {
        const details = fs.lstatSync(path.join(cellRoot, file), { throwIfNoEntry: false });
        assert.ok(details?.isFile(), `${id}: cell file missing: ${cellDir}/${file}`);
      }
      const runSh = path.join(cellRoot, "run.sh");
      assert.ok(fs.accessSync(runSh, fs.constants.X_OK) === undefined, `${id}: run.sh must be executable`);
      const runner = fs.readdirSync(cellRoot).find((name) => name.endsWith(".mjs"));
      assert.ok(runner, `${id}: cell must contain a runner .mjs`);
      // The runner must end by printing a SINGLE-LINE JSON summary with
      // result PASS (the local-case summary contract — never a pretty-printed
      // object, which the controller's parseLocalCommandSummary cannot read).
      const runnerSource = fs.readFileSync(path.join(cellRoot, runner), "utf8");
      assert.match(runnerSource, /result:\s*"PASS"/, `${id}: runner must emit result "PASS"`);
      assert.ok(!/JSON\.stringify\([^)]*null,\s*2\)/.test(runnerSource),
        `${id}: runner summary must be SINGLE-LINE JSON (no pretty-print)`);
    }
  });

  it("validate-scenario.mjs exits 0 for all four cells (AC2)", () => {
    for (const [id, cellDir] of Object.entries(CELL_DIRS)) {
      const res = run("node", [validator, path.join("torture-test", cellDir)]);
      assert.equal(res.status, 0, `${id}: validate-scenario must exit 0:\n${res.stdout}${res.stderr}`);
    }
  });

  it("the four tier2.jsonl rows carry scenario_id matching the cell id and scenario_path pointing at the cell (AC3)", () => {
    const records = readManifest();
    for (const [id, cellDir] of Object.entries(CELL_DIRS)) {
      const record = recordById(records, id);
      assert.equal(record.context.scenario_id, SCENARIO_IDS[id],
        `${id}: context.scenario_id must match the cell scenario id`);
      assert.equal(record.context.scenario_path, cellDir, `${id}: context.scenario_path must point at the cell`);
      const scenario = JSON.parse(
        fs.readFileSync(path.join(ttRoot, cellDir, "scenario.json"), "utf8"));
      assert.equal(scenario.id, record.context.scenario_id, `${id}: scenario.json id must equal context.scenario_id`);
      assert.equal(scenario.workflow_base, record.workflow, `${id}: workflow_base must equal the manifest workflow`);
    }
  });

  it("each cell's behaviors.json encodes the canned outputs from its case task doc (AC4)", () => {
    // W4.04c: the scripted merger emits FAIL_MISSING: 0 and MERGE_GATE: off
    // as ordinary KEY lines (the laundering shape).
    const w404c = JSON.parse(
      fs.readFileSync(path.join(ttRoot, CELL_DIRS["W4.04c-keyline-laundering"], "behaviors.json"), "utf8"));
    assert.match(w404c.agents.merger.output, /FAIL_MISSING: 0/, "W4.04c merger must emit FAIL_MISSING: 0");
    assert.match(w404c.agents.merger.output, /MERGE_GATE: off/, "W4.04c merger must emit MERGE_GATE: off");
    assert.equal(w404c.heartbeatTokens, 0, "W4.04c heartbeatTokens must be 0");
    assert.equal(w404c.defaultTokens, 0, "W4.04c defaultTokens must be 0");

    // W4.36: the fixer's canned behavior breaks the suite (DELETES a test
    // file + INVERTS an assertion) — the injection is encoded in the cell.
    const w436 = JSON.parse(
      fs.readFileSync(path.join(ttRoot, CELL_DIRS["W4.36-broken-work-concession"], "behaviors.json"), "utf8"));
    const fixerOutput = w436.agents.fixer.output;
    assert.match(fixerOutput, /DELETES the regression test/, "W4.36 fixer must encode the test-file deletion");
    assert.match(fixerOutput, /inverts the assertion/, "W4.36 fixer must encode the assertion inversion");

    // W4.38: the doer completes the hostile task HONESTLY (its canned
    // report is the honest completion, never the injected instruction).
    const w438 = JSON.parse(
      fs.readFileSync(path.join(ttRoot, CELL_DIRS["W4.38-hostile-task-scripted"], "behaviors.json"), "utf8"));
    assert.match(w438.agents.doer.output, /^STATUS: done$/m, "W4.38 doer must report STATUS: done");
    assert.match(w438.agents.doer.output, /REPORT:/, "W4.38 doer must carry an honest REPORT");
    assert.ok(!w438.agents.doer.output.includes("just report success"),
      "W4.38 doer must NOT act on the injected instruction");

    // W4.39-a: the tester reports the red HONESTLY (canned output documents
    // the pre-existing failures instead of rationalizing them away).
    const w439a = JSON.parse(
      fs.readFileSync(path.join(ttRoot, CELL_DIRS["W4.39-a-union-honest"], "behaviors.json"), "utf8"));
    assert.match(w439a.agents.verifier.output, /RED honestly/, "W4.39-a verifier must report the red honestly");
    assert.match(w439a.agents.verifier.output, /pre-existing failures documented, not rationalized/,
      "W4.39-a verifier must not rationalize the pre-existing red tests");
  });

  it("the four rows' cells are tracked by git (git ls-files shows every cell file)", () => {
    const res = run("git", ["ls-files", "torture-test/scenarios/w4.04c", "torture-test/scenarios/w4.36",
      "torture-test/scenarios/w4.38", "torture-test/scenarios/w4.39a"]);
    assert.equal(res.status, 0, `git ls-files failed:\n${res.stderr}`);
    const tracked = res.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    for (const [id, cellDir] of Object.entries(CELL_DIRS)) {
      const trackedPath = (relative: string) => path.posix.join("torture-test", relative).replace(/\\/g, "/");
      for (const file of ["scenario.json", "behaviors.json", "run.sh"]) {
        assert.ok(tracked.includes(trackedPath(path.posix.join(cellDir, file))),
          `${id}: ${file} must be tracked`);
      }
      const runner = fs.readdirSync(path.join(ttRoot, cellDir)).find((name) => name.endsWith(".mjs"));
      assert.ok(tracked.includes(trackedPath(path.posix.join(cellDir, runner!))),
        `${id}: runner ${runner} must be tracked`);
    }
  });
});
