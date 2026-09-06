// Tier-0/2 scenario <-> workflow roster/fix-step parity guard (S58 US-007).
//
// A scripted scenario cell declares workflow_base in scenario.json and canned
// agent behaviors in behaviors.json. Two invariants must hold or the scenario
// silently stops exercising the product's real corridor:
//
//   (a) roster parity — behaviors.json agent keys EXACTLY equal the `- id:`
//       agent roster parsed from workflows/<workflow_base>/workflow.yml;
//   (b) fix-expects parity — when the base workflow's fix step expects
//       contains the WAVE-A `(REPRO_EVIDENCE|CANNOT_REPRODUCE)` contract,
//       EVERY output-bearing canned fixer invocation output must match
//       `^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\s*\S+`.
//
// This guard is the loud tripwire for the next WAVE-A-class change: a
// workflow roster/fix-expects change that is not mirrored into the scenario
// assets turns this self-test red with a NAMED mismatch (and, via
// bin/tt-tier0-assets / bin/tt-tier2-assets, flips the tier gates red at gate
// time) instead of the confusing exit-3 "Tier ... unavailable" that masked
// the S58 drift.
//
// Green arm: every scenario cell referenced by cases/tier0.jsonl +
// cases/tier2.jsonl (58 unique dirs; 43 drive the bug-fix-merge-worktree
// WAVE-A roster/fix-expects contract — incl. the four S49 split cells) passes both checks.
// Red arms: temp copies with (1) a workflow.yml gaining a phantom agent id,
// (2) a behaviors.json gaining a stale agent key, and (3) a behaviors.json
// whose fixer output lost the CANNOT_REPRODUCE marker each report a named
// mismatch. The real tree is never modified.
//
// Confined to torture-test/ (scratch under os.tmpdir(), cleaned up). Zero
// tokens. Imported checker: scenarios/lib/scenario-workflow-parity.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { checkScenarioWorkflowParity } from "../scenarios/lib/scenario-workflow-parity.mjs";

const selfDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(selfDir, "..", "..");
const ttRoot = path.join(repoRoot, "torture-test");
const bfmwWorkflowYml = path.join(repoRoot, "workflows", "bug-fix-merge-worktree", "workflow.yml");

// Every scenario cell referenced by the tier manifests, in manifest order of
// first appearance (tier0 then tier2), deduped by absolute dir.
function manifestScenarioCells(): Array<{ caseId: string; relative: string }> {
  const cells = new Map<string, string>();
  for (const tier of ["tier0", "tier2"]) {
    const manifestPath = path.join(ttRoot, "cases", `${tier}.jsonl`);
    const lines = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
    for (const line of lines) {
      const record = JSON.parse(line);
      const context = record?.context;
      if (!context || typeof context !== "object" || Array.isArray(context)) continue;
      if (typeof context.scenario_path !== "string" || context.scenario_path.length === 0) continue;
      const abs = path.resolve(ttRoot, context.scenario_path);
      const caseId = typeof record?.id === "string" ? record.id : context.scenario_path;
      if (!cells.has(abs)) cells.set(abs, caseId);
    }
  }
  return [...cells.entries()].map(([abs, caseId]) => ({
    caseId,
    relative: path.relative(ttRoot, abs),
  }));
}

// Number of manifest-referenced cells whose workflow declares the WAVE-A
// REPRO_EVIDENCE|CANNOT_REPRODUCE fix-expects contract (the 43
// bug-fix-merge-worktree cells: 24 w4.35 + 19 tier2 cells — the S49 split
// added the four W4.33d/W4.48b cells).
function countMarkerWorkflowCells(): number {
  const markerWorkflowBases = new Set<string>();
  for (const { relative } of manifestScenarioCells()) {
    const meta = JSON.parse(fs.readFileSync(path.join(ttRoot, relative, "scenario.json"), "utf8"));
    const wfYml = path.join(repoRoot, "workflows", meta.workflow_base, "workflow.yml");
    if (!fs.existsSync(wfYml)) continue;
    const text = fs.readFileSync(wfYml, "utf8");
    const inSteps = text.split(/\r?\n/).some((line, i, arr) => {
      if (!/^steps:\s*$/.test(line)) return false;
      return arr.slice(i).some((l) => l.includes("(REPRO_EVIDENCE|CANNOT_REPRODUCE)"));
    });
    if (inSteps) markerWorkflowBases.add(meta.workflow_base);
  }
  let count = 0;
  for (const { relative } of manifestScenarioCells()) {
    const meta = JSON.parse(fs.readFileSync(path.join(ttRoot, relative, "scenario.json"), "utf8"));
    if (markerWorkflowBases.has(meta.workflow_base)) count += 1;
  }
  return count;
}

let scratchCounter = 0;
function scratchDir(): string {
  scratchCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `scenario-parity-${process.pid}-${scratchCounter}-`));
}

describe("Tier-0/2 scenario<->workflow roster/fix-step parity guard (S58 US-007)", () => {
  it("green arm: every manifest-referenced cell (tier0.jsonl + tier2.jsonl) matches its workflow roster and, where the fix step expects the WAVE-A marker, every canned fixer output carries it", () => {
    const cells = manifestScenarioCells();
    assert.ok(cells.length >= 58, `expected the 58 manifest-referenced scenario cells, got ${cells.length}`);
    assert.equal(countMarkerWorkflowCells(), 43,
      `expected exactly the 43 bug-fix-merge-worktree cells to drive a marker-workflow, got ${countMarkerWorkflowCells()}`);
    const problems: string[] = [];
    for (const { caseId, relative } of cells) {
      const cellProblems = checkScenarioWorkflowParity(path.join(ttRoot, relative));
      for (const problem of cellProblems) problems.push(`[${caseId} ${relative}] ${problem}`);
    }
    assert.deepEqual(problems, [],
      `scenario assets out of parity with their workflows (${problems.length} problem(s)):\n${problems.join("\n")}`);
  });

  it("red arm: a workflow.yml gaining a phantom agent id is reported as a NAMED roster mismatch", () => {
    const scratch = scratchDir();
    try {
      const doctored = path.join(scratch, "workflow.yml");
      const original = fs.readFileSync(bfmwWorkflowYml, "utf8");
      assert.match(original, /- id: triager\n/, "fixture: bug-fix-merge-worktree declares triager");
      fs.writeFileSync(doctored, original.replace("- id: triager\n", "- id: phantom-guard-agent\n- id: triager\n", 1));
      const problems = checkScenarioWorkflowParity(
        path.join(ttRoot, "scenarios", "w4.35", "w4.35-done-rebased-absent-green"),
        { workflowOverride: doctored },
      );
      assert.ok(problems.length > 0, "a phantom workflow agent id must be reported");
      assert.match(problems[0], /must exactly match|phantom-guard-agent/,
        `the mismatch must be named: ${problems[0]}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("red arm: a behaviors.json gaining a stale agent key is reported as a NAMED roster mismatch", () => {
    const scratch = scratchDir();
    try {
      const behaviorsPath = path.join(ttRoot, "scenarios", "w4.35", "w4.35-done-rebased-absent-green", "behaviors.json");
      const doctored = path.join(scratch, "behaviors.json");
      const original = JSON.parse(fs.readFileSync(behaviorsPath, "utf8"));
      original.agents["stale-guard-agent"] = original.agents.fixer;
      fs.writeFileSync(doctored, `${JSON.stringify(original, null, 2)}\n`);
      const problems = checkScenarioWorkflowParity(
        path.join(ttRoot, "scenarios", "w4.35", "w4.35-done-rebased-absent-green"),
        { behaviorsOverride: doctored },
      );
      assert.ok(problems.length > 0, "a stale behaviors agent key must be reported");
      assert.match(problems[0], /must exactly match|stale-guard-agent/,
        `the mismatch must be named: ${problems[0]}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("red arm: a behaviors.json whose fixer output lost the CANNOT_REPRODUCE marker is reported as a NAMED fix-expects mismatch", () => {
    const scratch = scratchDir();
    try {
      const behaviorsPath = path.join(ttRoot, "scenarios", "w4.35", "w4.35-done-rebased-absent-green", "behaviors.json");
      const doctored = path.join(scratch, "behaviors.json");
      const original = JSON.parse(fs.readFileSync(behaviorsPath, "utf8"));
      const fixer = original.agents.fixer;
      const strip = (entry: Record<string, unknown>): void => {
        if (typeof entry.output === "string") {
          entry.output = entry.output.split(/\r?\n/).filter((l) => !/^(REPRO_EVIDENCE|CANNOT_REPRODUCE):/.test(l)).join("\n");
        }
      };
      if (Array.isArray(fixer)) fixer.forEach(strip);
      else strip(fixer);
      fs.writeFileSync(doctored, `${JSON.stringify(original, null, 2)}\n`);
      const problems = checkScenarioWorkflowParity(
        path.join(ttRoot, "scenarios", "w4.35", "w4.35-done-rebased-absent-green"),
        { behaviorsOverride: doctored },
      );
      assert.ok(problems.length > 0, "a fixer output missing the CANNOT_REPRODUCE marker must be reported");
      assert.match(problems[0], /REPRO_EVIDENCE|CANNOT_REPRODUCE/,
        `the mismatch must name the fix-expects contract: ${problems[0]}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("green arm after the red arms: the real tree still passes parity (no state leaked)", () => {
    const cells = manifestScenarioCells();
    const problems: string[] = [];
    for (const { caseId, relative } of cells) {
      for (const problem of checkScenarioWorkflowParity(path.join(ttRoot, relative))) {
        problems.push(`[${caseId} ${relative}] ${problem}`);
      }
    }
    assert.deepEqual(problems, [], `real tree must stay green after the red arms:\n${problems.join("\n")}`);
    assert.equal(fs.existsSync(bfmwWorkflowYml), true, "real workflow.yml must be untouched");
  });
});
