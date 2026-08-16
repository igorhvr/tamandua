// Tier-2 US-009: section-E (update/migration/staleness) roster.
//
// Pins the section-E batch of cases/tier2.jsonl:
//   * the 3 new rows exist and tt-controller --manifest cases/tier2.jsonl
//     --validate-only exits 0 (Validated 70 case(s) after US-012);
//   * W4.19 is a zero-token scripted local-command cell (harness local,
//     workflow local, execution_mode scripted, caps.tokens 0) whose scenario
//     cell scenarios/w4.19/stale-catalog-warn-not-block/ overwrites the
//     contained catalog stamp with an artificially stale version and asserts
//     the one-line launch warning + doctor STALENESS flag + warn-not-block;
//   * W4.20 is the four-leg update classification cell (behind -> updated,
//     ahead -> refused_diverged, diverged -> refused_diverged with
//     remote-only commits >= 1, network-error -> pull_failed) asserting zero
//     destructive steps on refusal (DC31) in BOTH the runner and the task
//     text; the HARN seam is registered KNOWN-OPEN, not gated;
//   * W4.34 materializes the puma-tag CLI and invokes status/nudge/doctor
//     against the TT_COMMIT daemon — the doctor STALENESS check must surface
//     the version mismatch (daemon build vs installed build named);
//   * all three cells pass the shared scenario validator and their run.sh +
//     runners are executable; every cell is zero-token (caps.tokens 0);
//   * the tier0 w4.25/w4.49 section-E cells are REFERENCED in the
//     traceability (tier0-provided) and NOT duplicated in tier2.jsonl;
//   * traceability rows + the section-E map + exclusion enumeration +
//     machinery-delta rows + token budget exist; manifest summary shows 43.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const controller = path.join(ttRoot, "bin", "tt-controller");
const validator = path.join(ttRoot, "scenarios", "lib", "validate-scenario.mjs");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier2");

// The 3 section-E cases (spec 08 §E, US-009).
const SECTION_E_IDS = [
  "W4.19-stale-catalog-warn-not-block",
  "W4.20-update-repo-state-classification",
  "W4.34-stale-cli-new-daemon",
];

// Scenario cell directory per case id.
const CELL_DIRS: Record<string, string> = {
  "W4.19-stale-catalog-warn-not-block": "scenarios/w4.19/stale-catalog-warn-not-block",
  "W4.20-update-repo-state-classification": "scenarios/w4.20/update-repo-state-classification",
  "W4.34-stale-cli-new-daemon": "scenarios/w4.34/stale-cli-new-daemon",
};

type Case = Record<string, any>;

// node:test marks descendant processes; drop NODE_TEST_CONTEXT so the
// TAMANDUA_TEST_GUARD live-state protection does not auto-activate for the
// spawned controller (the standard self-test pattern). /bin/false backstops
// guard against any accidental real model invocation.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
};

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

function run(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 300_000) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function taskText(record: Case): string {
  return fs.readFileSync(path.join(ttRoot, record.task), "utf8");
}

describe("Tier-2 US-009 — section-E roster (update/migration/staleness)", () => {
  it("cases/tier2.jsonl contains the 3 section-E cases and --validate-only exits 0", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    for (const id of SECTION_E_IDS) {
      assert.ok(ids.includes(id), `section-E case ${id} must be present`);
    }
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("W4.19/20/34 are zero-token scripted local-command cases in the tier0 w4.49 cell shape", () => {
    for (const id of SECTION_E_IDS) {
      const record = recordById(readManifest(), id);
      assert.equal(record.harness, "local", `${id} must be a local-command case`);
      assert.equal(record.workflow, "local", `${id} must be a local (non-workflow) case`);
      assert.equal(record.context.execution_mode, "scripted", `${id} must be execution_mode scripted`);
      assert.equal(record.caps.tokens, 0, `${id} must be zero-token`);
      assert.equal(record.fixture, "none", `${id} provisions no fixture (the scenario builds its own fixtures)`);
      assert.ok(record.command, `${id} must carry the local command hook (the tier0 w4.49 scenario-cell shape)`);
      assert.equal(record.command.executable, "scenarios/lib/run-scripted-scenario",
        `${id} command hook must be the shared scripted-scenario harness`);
      const cellDir = CELL_DIRS[id];
      assert.deepEqual(record.command.args, [cellDir], `${id} command hook must point at its scenario cell`);
      // The tier0 w4.49 cell shape: scenario_id/scenario_path/expected_command_outcome.
      assert.ok(record.context.scenario_id.startsWith("w4."), `${id} scenario_id must match the cell id`);
      assert.equal(record.context.scenario_path, cellDir, `${id} scenario_path must match`);
      assert.equal(record.context.expected_command_outcome, "PASS", `${id} expected_command_outcome must be PASS`);
      // requires: platform linux + node-sqlite + systemd-user-scope + node_min 22.
      assert.equal(record.requires?.platform, "linux", `${id} must gate on platform linux`);
      assert.ok(record.requires?.capabilities?.includes("node-sqlite"), `${id} must require node-sqlite`);
      assert.ok(record.requires?.containment?.includes("systemd-user-scope"),
        `${id} must require systemd-user-scope containment`);
      assert.equal(record.requires?.node_min, 22, `${id} must require node_min 22`);
      // Gates / class / spec_ref / mandatory / shed_ok.
      assert.deepEqual(record.gates, ["TIER2", "W4"], `${id} gates must be [TIER2, W4]`);
      assert.equal(record.class, "verification", `${id} must be verification (mechanical corridor)`);
      assert.equal(record.mandatory, true, `${id} must be mandatory`);
      assert.equal(record.shed_ok, false, `${id} must not be shed-ok`);
      assert.match(record.spec_ref, /^08-wave-4-fault-injection\.md#W4\./, `${id} spec_ref must point into spec 08`);
      assert.equal(record.chaos, null, `${id} must carry chaos null (no typed chaos block)`);
      assert.ok(record.production_duration_floor_ms > 0, `${id} must carry production_duration_floor_ms`);
    }
  });

  it("each scenario cell exists, passes the shared validator, and its runner covers the section-E corridor", () => {
    for (const id of SECTION_E_IDS) {
      const record = recordById(readManifest(), id);
      const cellDir = CELL_DIRS[id];
      const scenarioDir = path.join(ttRoot, cellDir);
      const scenarioJson = path.join(scenarioDir, "scenario.json");
      assert.ok(fs.existsSync(scenarioJson), `${id}: scenario.json must exist`);
      const scenario = JSON.parse(fs.readFileSync(scenarioJson, "utf8"));
      assert.equal(scenario.id, record.context.scenario_id, `${id}: scenario.id must match context.scenario_id`);
      assert.equal(scenario.expected_outcome, record.context.scenario_expected_outcome,
        `${id}: scenario.expected_outcome must match`);
      assert.deepEqual(scenario.oracles, ["O1", "O3z", "O11"], `${id}: local-case oracle set`);
      for (const file of ["run.sh", "behaviors.json"]) {
        const details = fs.lstatSync(path.join(scenarioDir, file), { throwIfNoEntry: false });
        assert.ok(details?.isFile(), `${id}: scenario cell file missing: ${file}`);
      }
      const runSh = path.join(scenarioDir, "run.sh");
      assert.ok(fs.accessSync(runSh, fs.constants.X_OK) === undefined, `${id}: run.sh must be executable`);
      const validated = run("node", [validator, path.join("torture-test", cellDir)]);
      assert.equal(validated.status, 0, `${id}: validate-scenario must pass:\n${validated.stdout}${validated.stderr}`);
    }
  });

  it("W4.19's cell asserts the artificial stale stamp, the one-line launch warning, doctor STALENESS, and warn-not-block", () => {
    const record = recordById(readManifest(), "W4.19-stale-catalog-warn-not-block");
    assert.equal(record.context.scenario_id, "w4.19-stale-catalog-warn-not-block", "scenario_id must match");
    const runner = fs.readFileSync(
      path.join(ttRoot, CELL_DIRS["W4.19-stale-catalog-warn-not-block"], "run-stale-catalog.mjs"), "utf8");
    for (const needle of [
      "artificially-stale",                 // the injection version
      ".catalog-version.json",              // the stamp path
      "Warning: installed catalog is older than bundled catalog", // the one-line launch warning
      "workflow", "run",                    // the launch verb
      "─── STALENESS ───",                  // doctor group
      "Installed catalog vs bundled catalog",
      "is older than bundled catalog",
      "tamandua update --force",            // the remedy
      "warn-not-block",
    ]) {
      assert.ok(runner.includes(needle), `W4.19 runner must cover ${needle}`);
    }
    const task = taskText(record);
    assert.match(task, /warn-not-block/, "W4.19 task must pin the warn-not-block expectation");
    assert.match(task, /stale/, "W4.19 task must name the artificial staleness injection");
    assert.match(task, /STALENESS/, "W4.19 task must pin the doctor STALENESS flag");
  });

  it("W4.20's cell covers behind/ahead/diverged/network-error with zero destructive steps on refusal (DC31)", () => {
    const record = recordById(readManifest(), "W4.20-update-repo-state-classification");
    assert.equal(record.context.scenario_id, "w4.20-update-repo-state-classification", "scenario_id must match");
    const runner = fs.readFileSync(
      path.join(ttRoot, CELL_DIRS["W4.20-update-repo-state-classification"], "run-update-repo-state.mjs"), "utf8");
    // The four legs.
    for (const leg of ["behind", "ahead", "diverged", "network-error"]) {
      assert.ok(runner.includes(leg), `W4.20 runner must cover the ${leg} leg`);
    }
    // Distinct classifications.
    for (const needle of [
      "refused_diverged",
      "pull_failed",
      "no_change",
      "Tamandua update complete.",
      "has local commits origin does not have",
      "Not pulling",
      "git pull failed:",
      "Aborting update.",
    ]) {
      assert.ok(runner.includes(needle), `W4.20 runner must classify with ${needle}`);
    }
    // DC31 zero-destructive-steps assertions.
    for (const needle of [
      "DC31",
      "zero-destructive-steps",
      "must not move HEAD",
      "must not touch the working tree",
      "must not mutate the executable dist tree",
      "must never execute build-and-install",
      "MERGE_HEAD",
      "rebase-merge",
    ]) {
      assert.ok(runner.includes(needle), `W4.20 runner must assert DC31 via ${needle}`);
    }
    // The ahead/diverged distinction is pinned via remote-only commit count.
    assert.match(runner, /remote_only_commits/, "W4.20 runner must record remote-only commit counts");
    assert.match(runner, /countRemoteOnlyCommits/, "W4.20 runner must count remote-only commits");
    // The task text carries the four legs + DC31 + HARN KNOWN-OPEN (not gated).
    const task = taskText(record);
    for (const leg of ["behind", "ahead", "diverged", "network-error"]) {
      assert.match(task, new RegExp(leg), `W4.20 task must document the ${leg} leg`);
    }
    assert.match(task, /DC31/, "W4.20 task must assert zero destructive steps on refusal (DC31)");
    assert.match(task, /zero destructive steps/, "W4.20 task must name the DC31 assertion");
    assert.match(task, /HARN/, "W4.20 task must register the HARN seam");
    assert.match(task, /KNOWN-OPEN/, "W4.20 task must mark HARN KNOWN-OPEN (not gated)");
    assert.match(task, /never gated|NOT gated|do not gate/i, "W4.20 task must declare HARN is not gated");
  });

  it("W4.34's cell materializes the puma-tag CLI and surfaces the version mismatch against the TT daemon", () => {
    const record = recordById(readManifest(), "W4.34-stale-cli-new-daemon");
    assert.equal(record.context.scenario_id, "w4.34-stale-cli-new-daemon", "scenario_id must match");
    const runner = fs.readFileSync(
      path.join(ttRoot, CELL_DIRS["W4.34-stale-cli-new-daemon"], "run-stale-cli.mjs"), "utf8");
    for (const needle of [
      "refs/tags/puma",                     // the puma-tag materialization
      "git", "archive",                     // archive materialization
      "npm", "run", "build",                // build
      "daemon", "status",                   // status verb
      "nudge",                              // nudge verb
      "Daemon build version vs installed",  // doctor STALENESS check
      "Daemon running build",
      "installed build is",
      "tamandua daemon restart",            // the remedy
      "BUILT_VERSION",                      // version stamping
      ".tt-source-identity.json",           // provenance
    ]) {
      assert.ok(runner.includes(needle), `W4.34 runner must cover ${needle}`);
    }
    assert.match(runner, /no silent protocol confusion|silent protocol confusion/,
      "W4.34 runner must pin the no-silent-protocol-confusion contract");
    const task = taskText(record);
    assert.match(task, /puma/, "W4.34 task must name the puma-tag CLI");
    assert.match(task, /TT_COMMIT/, "W4.34 task must name the TT_COMMIT daemon");
    assert.match(task, /version mismatch surfaced|Version mismatch surfaced/,
      "W4.34 task must pin the surfaced version mismatch");
    assert.match(task, /silent protocol confusion/, "W4.34 task must pin the no-silent-protocol-confusion contract");
  });

  it("task files exist for the 3 section-E cases under cases/tasks/tier2/ and describe the cell's actual contents", () => {
    const records = readManifest();
    for (const id of SECTION_E_IDS) {
      const record = recordById(records, id);
      assert.ok(record.task.startsWith("cases/tasks/tier2/"), `${id}: task must live under cases/tasks/tier2/`);
      const taskPath = path.join(ttRoot, record.task);
      const details = fs.lstatSync(taskPath, { throwIfNoEntry: false });
      assert.ok(details?.isFile() && !details.isSymbolicLink(), `${id}: task file must exist as a regular file: ${record.task}`);
      const realTask = fs.realpathSync(taskPath);
      assert.ok(realTask.startsWith(`${fs.realpathSync(tasksDir)}${path.sep}`),
        `${id}: task file must resolve inside cases/tasks/tier2/`);
      const task = taskText(record);
      assert.ok(task.trim().length > 0, `${id}: task file must be non-empty`);
      // The section-E cells have fixture "none" — the scenario cell IS the
      // content; each task must name its own cell directory.
      assert.match(task, new RegExp(CELL_DIRS[id].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${id}: task must name its scenario cell (${CELL_DIRS[id]})`);
    }
    // No leftover extra files beyond the 53 authored.
    const authored = fs.readdirSync(tasksDir).filter((name) => name.endsWith(".md")).sort();
    const expected = records.map((record) => path.basename(record.task)).sort();
    assert.deepEqual(authored, expected, "cases/tasks/tier2/ must contain exactly the 53 authored task files");
  });

  it("the tier0 w4.25/w4.49 section-E cells are referenced (tier0-provided) and NOT duplicated in tier2.jsonl", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    // The tier0 cell ids must NOT appear as tier2 rows.
    for (const tier0Id of ["w4.25-aged-state-fixture", "w4.49-build-fails-after-pull",
      "w4.49-sigint-mid-build-install", "w4.49-workflow-install-post-stop"]) {
      assert.ok(!ids.includes(tier0Id), `tier0 cell ${tier0Id} must NOT be duplicated into tier2.jsonl`);
    }
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    for (const tier0Id of ["w4.25-aged-state-fixture", "w4.49-build-fails-after-pull",
      "w4.49-sigint-mid-build-install", "w4.49-workflow-install-post-stop"]) {
      assert.match(trace, new RegExp(tier0Id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must reference the tier0-provided cell ${tier0Id}`);
    }
    assert.match(trace, /Section E note \(US-009\)/, "traceability must carry the section-E tier0-reference note");
    assert.match(trace, /provided by tier0|Provided by the tier0/, "traceability must mark W4.25/W4.49 as tier0-provided");
    assert.match(trace, /referenced, never duplicated|referenced here, never duplicated/,
      "tier0 cells must be documented as references, not duplicates");
  });

  it("the traceability report carries the section-E map, exclusion enumeration, machinery deltas, and token budget", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## Case ↔ Spec Reference Map — Wave 4 Section E/, "section-E reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section E\)/, "section-E exclusion enumeration");
    assert.match(trace, /## Token Budget Note \(section E\)/, "section-E token budget note");
    assert.match(trace, /Total Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*/,
      "manifest summary must show 70 cases");
    assert.match(trace, /| Wave 4 section E \(update\/migration\/staleness\) \| 3 /,
      "manifest summary must show the 3 section-E rows");
    for (const id of SECTION_E_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    // Machinery deltas for the section-E seams.
    assert.match(trace, /W4\.20-update-repo-state-classification/, "traceability must document the W4.20 daemon-stop barrier");
    assert.match(trace, /HARN/, "traceability must document the HARN KNOWN-OPEN registration");
    assert.match(trace, /W4\.34-stale-cli-new-daemon/, "traceability must document the W4.34 version-stamping delta");
    assert.match(trace, /BUILT_VERSION/, "the W4.34 version-stamping machinery note must be recorded");
    assert.match(trace, /W4\.19-stale-catalog-warn-not-block/, "traceability must document the W4.19 cell");
    // The exclusion enumeration says section E is covered by tier2 rows +
    // tier0 references.
    assert.match(trace, /none — section E covered by tier2 rows \+ tier0 references/,
      "section-E exclusion enumeration must report the tier0-provided coverage");
  });
});
