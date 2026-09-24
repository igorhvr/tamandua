// Tier-2 STORM-REHEARSAL fix-2 US-001 — per-campaign scripted-runtime
// behaviors + state-dir materializer (in-process; NO daemon/harness/chaos).
//
// Attempt 2 (run #59) proved the zero-model rehearsal never claimed a step:
// the campaign daemon.env.sh carried no TAMANDUA_SCRIPTED_BEHAVIORS /
// TAMANDUA_SCRIPTED_STATE, so runtime-pi.mjs:59 / runtime-hermes.mjs:60
// derived stateDir='' and runtime-shared.mjs:289 mkdirSync('') threw ENOENT
// on every work round. This file is the ONE focused torture self-test for the
// fix: the behaviors builder must derive the COMPLETE scripted-runtime input
// contract from the ACTUAL storm workflow.yml files (every step agent, every
// `expects` literal + regex, keyed '<workflowId>_<agent>'), the materializer
// must write it under the owned rehearsal input root and create the private
// scripted state dir under the exec-identity state root, and a real
// launch-free rehearsal prepare must persist + mirror the record.
//
// Everything here is launch-free: the only effects are contained writes under
// fresh owned temp roots; nothing is spawned and no file under src/ is read
// for mutation.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL_FS, STORM_WORKFLOW_IDS } from "../bin/tt-storm-roster.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";
import { buildPrivateExecContext, persistableExecIdentity } from "../bin/tt-storm-real.mjs";
import { stormPrepare } from "../bin/tt-storm-engine.mjs";
import {
  appendScriptedStoriesJson,
  buildRehearsalScriptedBehaviors,
  computeGateHashes,
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  deriveStoryLoopProducers,
  deriveTestedTreeAgent,
  materializeRehearsalScriptedRuntime,
  MERGER_MERGE_BRANCH_COMMAND,
  parseExpectsChecks,
  parseWorkflowSteps,
  readRehearsalWorkflowTexts,
  SCRIPTED_STORY_COUNT,
  scriptedStoriesJsonLine,
  TESTER_SUITE_EVIDENCE_COMMAND,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-behaviors-${label}-`));
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function bundledTexts(): Record<string, string> {
  return readRehearsalWorkflowTexts({ fs: REAL_FS, roots: [BUNDLED_WORKFLOWS], workflowIds: STORM_WORKFLOW_IDS });
}

// Faithful mirror of src/installer/step-ops.ts validateExpects (used only when
// the built product module is unavailable).
function localValidateExpects(output: string, expects: string): string | null {
  if (!expects || expects.trim() === "") return null;
  for (const rawLine of expects.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("regex:")) {
      const pattern = line.slice("regex:".length);
      let re: RegExp;
      try {
        re = new RegExp(pattern, "m");
      } catch {
        return `Invalid expects regex pattern: ${pattern}`;
      }
      if (!re.test(output)) return `Output does not match expects regex: ${pattern}`;
    } else if (!output.includes(line)) {
      return `Output missing expects string: "${line}"`;
    }
  }
  return null;
}

// Prefer the REAL product validator from dist; fall back to the mirror above.
async function productValidateExpects(): Promise<(output: string, expects: string) => string | null> {
  try {
    const mod: any = await import("../../dist/installer/step-ops.js");
    if (typeof mod.validateExpects === "function") return mod.validateExpects;
  } catch {
    // dist not built yet — the faithful local mirror still enforces the contract
  }
  return localValidateExpects;
}

// A real, LOCAL git adapter for the in-process full-prepare integration arm.
function makeRealGitAdapter() {
  return {
    run: async (cwd: string, args: string[], { env = {} }: { env?: Record<string, string> } = {}) => {
      return spawnCapture(["git", ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
        mergeParentEnv: false,
        timeoutMs: 120_000,
      });
    },
  };
}

describe("STORM-REHEARSAL fix-2 US-001 — scripted-runtime behaviors + state dir (launch-free)", () => {
  it("B1: parseWorkflowSteps derives every step's agent + expects from the ACTUAL storm workflow.yml files", () => {
    const texts = bundledTexts();
    for (const wf of STORM_WORKFLOW_IDS) {
      const steps = parseWorkflowSteps(texts[wf]);
      assert.ok(steps.length > 0, `${wf} parsed steps`);
      for (const step of steps) {
        assert.ok(step.agent, `${wf} step ${step.id} has an agent`);
        assert.equal(typeof step.expects, "string", `${wf} step ${step.id} has an expects block`);
        assert.ok(step.expects.trim().length > 0, `${wf} step ${step.id} expects is non-empty`);
      }
      if (wf.endsWith("-merge-worktree")) {
        assert.ok(steps.some((s) => s.agent === "merger"), `${wf} exposes its merger step`);
      } else {
        assert.ok(!steps.some((s) => s.agent === "merger"), `${wf} has no merger step`);
      }
    }

    // Loop + conditional steps are found and keep their real agent id.
    const fd = parseWorkflowSteps(texts["feature-dev-merge-worktree"]);
    assert.equal(fd.find((s) => s.id === "implement")?.agent, "developer", "loop step agent");
    assert.equal(fd.find((s) => s.id === "test_cmd_review")?.agent, "reviewer", "conditional step agent");
    assert.equal(fd.find((s) => s.id === "finalize_merge")?.agent, "merger", "merge step agent");

    // Block-scalar expects is collected (three regex lines), inline quoted
    // expects is unescaped into real newlines.
    const mergerExpects = parseExpectsChecks(fd.find((s) => s.id === "finalize_merge")?.expects ?? "");
    assert.equal(mergerExpects.regexes.length, 3, "block-scalar expects yields three regex checks");
    const plannerExpects = parseExpectsChecks(fd.find((s) => s.id === "plan")?.expects ?? "");
    assert.deepEqual(plannerExpects.literals, ["STATUS: done"]);
    assert.equal(plannerExpects.regexes.length, 1, "inline quoted expects yields one regex check");

    // An input block that documents step-like text can never contribute an
    // agent: the derived agent set is exactly the distinct real step agents.
    const stepAgents = new Set(fd.map((s) => s.agent).filter(Boolean));
    assert.deepEqual([...stepAgents].sort(), ["developer", "merger", "planner", "reviewer", "setup", "tester", "verifier"]);
  });

  it("B2: every workflow step agent is keyed '<workflowId>_<agent>' and its output satisfies every expects clause", async () => {
    const validate = await productValidateExpects();
    const texts = bundledTexts();
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });

    assert.equal(behaviors.heartbeatTokens, 0, "heartbeatTokens zero (zero-model)");
    assert.equal(behaviors.defaultTokens, 0, "defaultTokens zero (zero-model)");
    assert.ok(behaviors.agents && typeof behaviors.agents === "object");

    const expectedKeys = new Set<string>();
    for (const wf of STORM_WORKFLOW_IDS) {
      for (const step of parseWorkflowSteps(texts[wf])) expectedKeys.add(`${wf}_${step.agent}`);
    }
    for (const key of expectedKeys) {
      assert.ok(behaviors.agents[key], `behaviors has the full key ${key}`);
      // US-003: loop-body/verify agents are arrays of per-story behaviors.
      const entries = Array.isArray(behaviors.agents[key]) ? behaviors.agents[key] : [behaviors.agents[key]];
      assert.ok(entries.length > 0, `${key} has at least one behavior entry`);
      for (const entry of entries) {
        assert.equal(entry.tokens, 0, `${key} entry tokens 0`);
        assert.equal(typeof entry.output, "string", `${key} entry carries an output`);
      }
    }

    // Independently validate EVERY step's expects against its agent's
    // behavior using the product's own validator (not the generator's
    // helpers). US-003: loop-body/verify agents now carry an ARRAY of one
    // behavior entry per emitted story; every entry must satisfy a
    // single-step agent's expects, and a multi-step agent needs one entry per
    // step (the array entries are the agent's full merged output).
    let checked = 0;
    for (const wf of STORM_WORKFLOW_IDS) {
      const steps = parseWorkflowSteps(texts[wf]);
      for (const step of steps) {
        const behavior = behaviors.agents[`${wf}_${step.agent}`];
        const entries = Array.isArray(behavior) ? behavior : [behavior];
        const ownsStepCount = steps.filter((s) => s.agent === step.agent).length;
        if (ownsStepCount === 1) {
          for (const entry of entries) {
            const err = validate(entry.output, step.expects);
            checked += 1;
            assert.equal(err, null, `${wf}/${step.id} (${step.agent}) expects mismatch: ${err}\nEXPECTS: ${step.expects}\nOUTPUT: ${entry.output}`);
          }
        } else {
          const errs = entries.map((entry: any) => validate(entry.output, step.expects));
          checked += 1;
          assert.ok(
            errs.some((e: string | null) => e === null),
            `${wf}/${step.id} (${step.agent}) no behavior entry satisfies expects: ${errs.filter(Boolean).join(" | ")}`,
          );
        }
      }
    }
    assert.ok(checked >= STORM_WORKFLOW_IDS.length, `validated ${checked} step/expects pairs`);
  });

  it("B3: merge-family merger behaviors carry the real tamandua merge-branch command with includeCommandOutput and truthful MERGED_* output", () => {
    const texts = bundledTexts();
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    const mergeWorkflows = STORM_WORKFLOW_IDS.filter((w) => w.endsWith("-merge-worktree"));
    assert.ok(mergeWorkflows.length >= 1, "at least one merge-worktree workflow");

    for (const wf of mergeWorkflows) {
      const merger = behaviors.agents[`${wf}_merger`];
      assert.ok(merger, `${wf} merger behavior exists`);
      assert.equal(merger.includeCommandOutput, true, `${wf} merger includes command output`);
      assert.ok(Array.isArray(merger.commands) && merger.commands.length > 0, `${wf} merger carries commands`);
      assert.ok(
        merger.commands.some((c: string) => c.includes("tamandua merge-branch")),
        `${wf} merger runs the REAL tamandua merge-branch command`,
      );
      assert.ok(
        merger.commands.some((c: string) => c.includes("--origin") && c.includes("--into") && c.includes("--expect-tip")),
        `${wf} merge-branch command names origin/into/expect-tip`,
      );
      assert.match(merger.output, /^STATUS: done$/m, `${wf} merger STATUS done`);
      assert.match(merger.output, /^REBASED: false$/m, `${wf} merger REBASED false`);
      assert.match(merger.output, /^MERGE_COMMIT: \S+$/m, `${wf} merger MERGE_COMMIT`);
      assert.match(merger.output, /^MERGED_INTO: \S+$/m, `${wf} merger MERGED_INTO`);
      assert.match(merger.output, /^MERGED_TREE: \S+$/m, `${wf} merger MERGED_TREE`);
    }
    assert.ok(MERGER_MERGE_BRANCH_COMMAND.includes("tamandua merge-branch"), "exported merge command is the real one");

    // Non-merger agents never receive the merge command. The merge-family
    // feature agent DOES carry the US-007 branch/commit command (on every
    // per-story entry), but never the merge command itself.
    assert.equal(behaviors.agents["do-now_doer"].commands, undefined, "do-now doer has no commands");
    const devEntries = behaviors.agents["feature-dev-merge-worktree_developer"];
    assert.ok(Array.isArray(devEntries), "developer behavior is the per-story array");
    for (const entry of devEntries) {
      assert.ok(Array.isArray(entry.commands), "developer entry carries commands");
      assert.ok(entry.commands.some((c: string) => c.includes("git checkout -b")), "developer creates the feature branch");
      assert.equal(entry.commands.some((c: string) => c.includes("tamandua merge-branch")), false, "developer never runs the merge command");
    }
  });

  it("B4: materializeRehearsalScriptedRuntime writes behaviors under the owned input root, creates the state dir under the state root, and hashes the exact bytes", () => {
    const scratch = ownedScratch("materialize");
    try {
      const inputRoot = path.join(scratch, "rehearsal", "storm-unit-1");
      const stateRoot = path.join(scratch, "home", ".tamandua");
      const campaignDir = path.join(scratch, "results", "storm-unit-1");
      fs.mkdirSync(inputRoot, { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.mkdirSync(campaignDir, { recursive: true });
      const campaignBefore = fs.readdirSync(campaignDir).sort();

      const record = materializeRehearsalScriptedRuntime({
        fs: REAL_FS,
        inputRoot,
        stateRoot,
        campaignId: "storm-unit-1",
        workflowTexts: bundledTexts(),
      });

      // Valid JSON behaviors document under the OWNED rehearsal input root.
      assert.ok(path.isAbsolute(record.behaviors_file), "behaviors_file is absolute");
      assert.ok(isWithin(inputRoot, record.behaviors_file), `behaviors_file under inputRoot: ${record.behaviors_file}`);
      assert.equal(path.relative(inputRoot, record.behaviors_file), path.join("scripted", "behaviors.json"));
      const parsed = JSON.parse(fs.readFileSync(record.behaviors_file, "utf8"));
      assert.ok(parsed.agents && typeof parsed.agents === "object", "behaviors JSON has an agents map");
      assert.equal(parsed.heartbeatTokens, 0);
      assert.equal(parsed.defaultTokens, 0);

      // Scripted state dir under the exec-identity state root.
      assert.ok(path.isAbsolute(record.state_dir), "state_dir is absolute");
      assert.ok(isWithin(stateRoot, record.state_dir), `state_dir under stateRoot: ${record.state_dir}`);
      assert.notEqual(record.state_dir, stateRoot, "state dir is a dedicated child of the state root");
      assert.ok(fs.existsSync(record.state_dir) && fs.statSync(record.state_dir).isDirectory(), "state dir created");

      // sha256 matches the exact file bytes; 64 hex chars.
      const bytes = fs.readFileSync(record.behaviors_file);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), record.behaviors_sha256);
      assert.match(record.behaviors_sha256, /^[0-9a-f]{64}$/);

      // Agent count + keys.
      assert.equal(record.agents, Object.keys(parsed.agents).length, "agent count matches the behaviors file");
      assert.equal(record.agent_keys.length, record.agents);
      assert.deepEqual([...record.agent_keys].sort(), Object.keys(parsed.agents).sort());

      // NOTHING new is written into campaignDir.
      assert.deepEqual(fs.readdirSync(campaignDir).sort(), campaignBefore, "campaignDir untouched");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("B5: the builder/materializer refuse malformed inputs (fail-closed, no partial writes)", () => {
    const scratch = ownedScratch("refuse");
    try {
      const texts = bundledTexts();
      const inputRoot = path.join(scratch, "inputs");
      const stateRoot = path.join(scratch, "state");
      assert.throws(
        () => materializeRehearsalScriptedRuntime({ fs: REAL_FS, inputRoot: "relative", stateRoot, campaignId: "c", workflowTexts: texts }),
        (e: any) => e.code === "TT_USAGE",
      );
      assert.throws(
        () => materializeRehearsalScriptedRuntime({ fs: REAL_FS, inputRoot, stateRoot: "relative", campaignId: "c", workflowTexts: texts }),
        (e: any) => e.code === "TT_USAGE",
      );
      assert.throws(
        () => materializeRehearsalScriptedRuntime({ fs: REAL_FS, inputRoot, stateRoot, campaignId: "../escape", workflowTexts: texts }),
        (e: any) => e.code === "TT_USAGE",
      );
      assert.throws(
        () => buildRehearsalScriptedBehaviors({ workflowTexts: { "feature-dev-merge-worktree": "" }, workflowIds: ["feature-dev-merge-worktree"] }),
        (e: any) => e.code === "TT_CATALOG",
      );
      assert.throws(
        () => readRehearsalWorkflowTexts({ fs: REAL_FS, roots: [path.join(scratch, "nope")], workflowIds: ["feature-dev-merge-worktree"] }),
        (e: any) => e.code === "TT_CATALOG",
      );
      // Refusals happen before any write.
      assert.ok(!fs.existsSync(inputRoot), "no behaviors directory written on refusal");
      assert.ok(!fs.existsSync(stateRoot), "no state directory written on refusal");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("B6: a real launch-free rehearsal prepare persists state.rehearsal.scripted_runtime and mirrors it into descriptor.json", async () => {
    const scratch = ownedScratch("prepare");
    try {
      const varRoot = path.join(scratch, "var");
      fs.mkdirSync(varRoot, { recursive: true });
      const installedRoot = path.join(varRoot, "home", ".tamandua", "workflows");
      const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
      const ctx: any = {
        fs: REAL_FS,
        clock: { nowMs: () => Date.now(), nowUtc: () => new Date().toISOString(), sleep: async () => {} },
        proc: null,
        db: null,
        git: makeRealGitAdapter(),
        varRoot,
        campaignDir: null,
        opts: {
          rehearsalPrepare: true,
          installedCatalogRoot: installedRoot,
          bundledCatalogRoot: BUNDLED_WORKFLOWS,
          sourceCommit: "c".repeat(40),
          sourceTree: "t".repeat(40),
          sourceTreeDirty: false,
          execIdentity: persistableExecIdentity(execCtx),
          gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(scratch, "git-home") },
          gateHashes: computeGateHashes(),
          coordinatorApprovalFile: DEFAULT_COORDINATOR_APPROVAL_FILE,
          scriptedRuntimes: {
            pi: path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-pi"),
            hermes: path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-hermes"),
          },
        },
        argv: ["prepare"],
      };

      const res: any = await stormPrepare(ctx);

      // Campaign dir still holds exactly the prepare file set (no new file).
      assert.deepEqual(
        fs.readdirSync(res.campaignDir).sort(),
        ["descriptor.json", "intent.jsonl", "ops.jsonl", "results", "state.json"],
        "campaign dir file set unchanged",
      );

      const state = JSON.parse(fs.readFileSync(path.join(res.campaignDir, "state.json"), "utf8"));
      const sr = state.rehearsal?.scripted_runtime;
      assert.ok(sr, "state.rehearsal.scripted_runtime persisted");
      assert.ok(path.isAbsolute(sr.behaviors_file), "behaviors_file absolute");
      assert.ok(fs.existsSync(sr.behaviors_file), "behaviors_file exists");
      assert.match(sr.behaviors_sha256, /^[0-9a-f]{64}$/);
      assert.equal(createHash("sha256").update(fs.readFileSync(sr.behaviors_file)).digest("hex"), sr.behaviors_sha256);
      assert.ok(isWithin(res.rehearsal.inputRoots.root, sr.behaviors_file), "behaviors file under the owned input root");
      assert.ok(isWithin(execCtx.state_root, sr.state_dir), "state dir under exec_identity.state_root");
      assert.ok(fs.existsSync(sr.state_dir) && fs.statSync(sr.state_dir).isDirectory(), "state dir created");
      const parsed = JSON.parse(fs.readFileSync(sr.behaviors_file, "utf8"));
      assert.equal(sr.agents, Object.keys(parsed.agents).length, "recorded agent count matches behaviors file");

      const desc = JSON.parse(fs.readFileSync(path.join(res.campaignDir, "descriptor.json"), "utf8"));
      assert.deepEqual(desc.scripted_runtime, sr, "descriptor.json mirrors the scripted_runtime record");

      // Every roster workflow/agent is present and its output validates.
      // US-003: loop-body/verify agents are arrays (one entry per emitted
      // story); every entry must satisfy a single-step agent's expects.
      const validate = await productValidateExpects();
      for (const wf of STORM_WORKFLOW_IDS) {
        const text = fs.readFileSync(path.join(installedRoot, wf, "workflow.yml"), "utf8");
        const steps = parseWorkflowSteps(text);
        for (const step of steps) {
          const behavior = parsed.agents[`${wf}_${step.agent}`];
          assert.ok(behavior, `${wf}_${step.agent} present in materialized behaviors`);
          const entries = Array.isArray(behavior) ? behavior : [behavior];
          const ownsStepCount = steps.filter((s) => s.agent === step.agent).length;
          if (ownsStepCount === 1) {
            for (const entry of entries) {
              assert.equal(validate(entry.output, step.expects), null, `${wf}/${step.id} expects satisfied`);
            }
          } else {
            const errs = entries.map((entry: any) => validate(entry.output, step.expects));
            assert.ok(
              errs.some((e: string | null) => e === null),
              `${wf}/${step.id} expects satisfied by at least one entry`,
            );
          }
        }
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("B7: US-003 — story producers emit STORIES_JSON and loop-body/verify agents carry one entry per story", () => {
    const texts = bundledTexts();
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    const loopWorkflows = STORM_WORKFLOW_IDS.filter((wf) => deriveStoryLoopProducers(parseWorkflowSteps(texts[wf])).loopStep !== null);
    assert.ok(loopWorkflows.length >= 2, "the roster keeps its story-loop workflows");

    for (const wf of STORM_WORKFLOW_IDS) {
      const steps = parseWorkflowSteps(texts[wf]);
      const graph = deriveStoryLoopProducers(steps);
      const producerKeys = new Set(graph.producers.map((p) => `${wf}_${p.agent}`));

      // STORIES_JSON appears on producer keys ONLY.
      for (const key of Object.keys(behaviors.agents).filter((k) => k.startsWith(`${wf}_`))) {
        const b = behaviors.agents[key];
        const entries = Array.isArray(b) ? b : [b];
        const hasPlan = entries.some((e: any) => e.output.split("\n").some((l: string) => l.startsWith("STORIES_JSON:")));
        assert.equal(hasPlan, producerKeys.has(key), `${key} STORIES_JSON presence matches producer status`);
      }
      if (!graph.loopStep) continue;

      assert.equal(graph.producers.length, 1, `${wf} has exactly one producer`);
      const producer = behaviors.agents[`${wf}_${graph.producers[0].agent}`];
      const lines: string[] = producer.output.split("\n");
      assert.equal(lines.filter((l) => l.startsWith("STORIES_JSON:")).length, 1, `${wf} producer has one plan line`);
      assert.equal(lines[lines.length - 1], scriptedStoriesJsonLine(), `${wf} producer plan is the last line`);

      const verifyStep = steps.find((s) => s.id === graph.verifyStepId)!;
      const pairs: Array<[string, string | null, string]> = [
        ["loop-body", graph.bodyAgent, graph.loopStep.expects ?? ""],
        ["verify", graph.verifyAgent, verifyStep.expects ?? ""],
      ];
      for (const [label, agent, expects] of pairs) {
        const b = behaviors.agents[`${wf}_${agent}`];
        assert.ok(Array.isArray(b), `${wf} ${label} (${agent}) behavior is an array`);
        assert.equal(b.length, SCRIPTED_STORY_COUNT, `${wf} ${label} has one entry per story`);
        for (const entry of b) {
          assert.equal(localValidateExpects(entry.output, expects), null, `${wf} ${label} entry satisfies its step expects`);
          assert.equal(entry.tokens, 0, `${wf} ${label} entry is zero-token`);
        }
      }
    }
    assert.equal(loopWorkflows.length, 2, "the roster's two story-loop workflows");
  });

  it("B8: US-003 — the real parseAndInsertStories accepts every story producer output (isolated temp HOME)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-reh-behaviors-db-"));
    const prev = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_CONTROL_PORT: process.env.TAMANDUA_CONTROL_PORT,
    };
    process.env.HOME = home;
    process.env.TAMANDUA_STATE_DIR = path.join(home, ".tamandua");
    process.env.TAMANDUA_DB_PATH = path.join(home, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_CONTROL_PORT = "1";
    try {
      const texts = bundledTexts();
      const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
      const { getDb } = await import("../../dist/db.js");
      const { parseAndInsertStories } = await import("../../dist/installer/step-ops.js");
      const db = getDb();
      const insertRun = db.prepare(
        `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', '{}', 0, NULL, ?, ?)`,
      );
      const now = new Date().toISOString();
      let loopWorkflows = 0;
      for (const wf of STORM_WORKFLOW_IDS) {
        const steps = parseWorkflowSteps(texts[wf]);
        const graph = deriveStoryLoopProducers(steps);
        if (!graph.loopStep) continue;
        loopWorkflows += 1;
        const behavior = behaviors.agents[`${wf}_${graph.producers[0].agent}`];
        const runId = `run-${wf}`;
        insertRun.run(runId, 1, wf, `task for ${wf}`, now, now);
        assert.doesNotThrow(() => parseAndInsertStories(behavior.output, runId), `${wf} producer output parses`);
        const rows = db
          .prepare("SELECT story_id, status FROM stories WHERE run_id = ? ORDER BY story_index")
          .all(runId) as Array<{ story_id: string; status: string }>;
        assert.equal(rows.length, SCRIPTED_STORY_COUNT, `${wf} inserted ${SCRIPTED_STORY_COUNT} stories`);
        assert.deepEqual(rows.map((r) => r.story_id), ["US-001", "US-002"], `${wf} inserted the plan story ids`);
      }
      assert.equal(loopWorkflows, 2, "the roster's two story-loop workflows were exercised");
    } finally {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.TAMANDUA_STATE_DIR === undefined) delete process.env.TAMANDUA_STATE_DIR; else process.env.TAMANDUA_STATE_DIR = prev.TAMANDUA_STATE_DIR;
      if (prev.TAMANDUA_DB_PATH === undefined) delete process.env.TAMANDUA_DB_PATH; else process.env.TAMANDUA_DB_PATH = prev.TAMANDUA_DB_PATH;
      if (prev.TAMANDUA_CONTROL_PORT === undefined) delete process.env.TAMANDUA_CONTROL_PORT; else process.env.TAMANDUA_CONTROL_PORT = prev.TAMANDUA_CONTROL_PORT;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── NPF-2 (US-001): the scripted test step records REAL suite-ledger
  // evidence through the product's public shim seam, so the product's
  // finalize_merge ledger gate lands on the FIRST attempt. The evidence is
  // never fabricated: the behavior only carries the unresolved
  // `{{input.TEST_CMD}}` placeholder, which the scripted runtime renders from
  // the claim-time step input (the shim-wrapped command the real tester runs).
  const MERGE_WORKFLOWS = [
    "feature-dev-merge-worktree",
    "security-audit-merge-worktree",
    "bug-fix-merge-worktree",
    "quarantine-broken-tests-merge-worktree",
  ];
  const TESTED_TREE_AGENT_BY_WORKFLOW: Record<string, string> = {
    "feature-dev-merge-worktree": "tester",
    "security-audit-merge-worktree": "tester",
    "bug-fix-merge-worktree": "verifier",
    "quarantine-broken-tests-merge-worktree": "verifier",
  };
  const behaviorEntries = (behavior: any): any[] => (Array.isArray(behavior) ? behavior : [behavior]);

  it("B9: NPF-2 — the TESTED_TREE agent of every merge-family workflow runs the shim-backed suite-evidence command", () => {
    assert.equal(TESTER_SUITE_EVIDENCE_COMMAND, "{{input.TEST_CMD}}", "evidence command is the product's own TEST_CMD placeholder");
    const texts = bundledTexts();
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    const mergeWorkflows = STORM_WORKFLOW_IDS.filter((w) => w.endsWith("-merge-worktree"));
    assert.deepEqual([...mergeWorkflows].sort(), [...MERGE_WORKFLOWS].sort(), "all four merge-family workflows are in the roster");

    for (const wf of mergeWorkflows) {
      const steps = parseWorkflowSteps(texts[wf]);
      const agent = deriveTestedTreeAgent(steps);
      assert.equal(agent, TESTED_TREE_AGENT_BY_WORKFLOW[wf], `${wf} TESTED_TREE-producing agent`);

      // The derived agent owns the step whose expects attests TESTED_TREE.
      const step = steps.find((s) => s.agent === agent);
      assert.ok(step, `${wf} has the TESTED_TREE step`);
      const checks = parseExpectsChecks(step.expects ?? "");
      assert.ok(
        [...checks.regexes, ...checks.literals].some((e) => /TESTED_TREE/.test(String(e))),
        `${wf}/${step.id} expects attest TESTED_TREE`,
      );

      // The evidence command is attached to EVERY entry of the behavior,
      // additively (no existing command is lost).
      const entries = behaviorEntries(behaviors.agents[`${wf}_${agent}`]);
      assert.ok(entries.length > 0, `${wf}_${agent} has behavior entries`);
      for (const entry of entries) {
        assert.ok(Array.isArray(entry.commands), `${wf}_${agent} entry carries commands`);
        assert.ok(entry.commands.includes(TESTER_SUITE_EVIDENCE_COMMAND), `${wf}_${agent} entry runs the shim-wrapped TEST_CMD`);
        // Exactly the placeholder: no expanded/hardcoded shim command at build time.
        assert.equal(entry.commands.filter((c: string) => c === TESTER_SUITE_EVIDENCE_COMMAND).length, 1, `${wf}_${agent} attaches the evidence command once`);
        assert.equal(entry.commands.some((c: string) => c.includes("tamandua-test")), false, `${wf}_${agent} never hardcodes an expanded shim command`);
      }
      // These agents had no prior command, so evidence is the only one.
      assert.deepEqual(entries.map((e: any) => e.commands), entries.map(() => [TESTER_SUITE_EVIDENCE_COMMAND]), `${wf}_${agent} evidence is additive on an otherwise command-free agent`);
    }
  });

  it("B10: NPF-2 — non-TESTED_TREE agents stay untouched, and suiteEvidence:false omits the command from every behavior entry", () => {
    const texts = bundledTexts();
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });

    // do-now (not a merge family) is unchanged.
    assert.equal(behaviors.agents["do-now_doer"].commands, undefined, "do-now doer receives no suite-evidence command");

    // The per-story feature-dev verifier (loop verify) does NOT produce
    // TESTED_TREE (the tester does), so it stays command-free.
    const fdmwVerifier = behaviors.agents["feature-dev-merge-worktree_verifier"];
    assert.ok(Array.isArray(fdmwVerifier), "fdmw verifier is the per-story array");
    for (const entry of fdmwVerifier) {
      assert.equal(entry.commands, undefined, "per-story fdmw verifier stays command-free");
    }

    // Existing commands are preserved and never polluted with the evidence command.
    const devEntries = behaviorEntries(behaviors.agents["feature-dev-merge-worktree_developer"]);
    for (const entry of devEntries) {
      assert.ok(entry.commands.some((c: string) => c.includes("git checkout -b")), "developer keeps its feature-branch command");
      assert.equal(entry.commands.includes(TESTER_SUITE_EVIDENCE_COMMAND), false, "developer does not run the evidence command");
    }
    const mergerEntries = behaviorEntries(behaviors.agents["feature-dev-merge-worktree_merger"]);
    for (const entry of mergerEntries) {
      assert.ok(entry.commands.some((c: string) => c.includes("tamandua merge-branch")), "merger keeps its merge command");
      assert.equal(entry.commands.includes(TESTER_SUITE_EVIDENCE_COMMAND), false, "merger does not run the evidence command");
    }

    // suiteEvidence:false is the negative configuration: no merge-family
    // behavior entry carries the evidence command.
    const negative = buildRehearsalScriptedBehaviors({ workflowTexts: texts, suiteEvidence: false });
    for (const wf of MERGE_WORKFLOWS) {
      const agent = TESTED_TREE_AGENT_BY_WORKFLOW[wf];
      const entries = behaviorEntries(negative.agents[`${wf}_${agent}`]);
      for (const entry of entries) {
        assert.equal(
          (entry.commands ?? []).includes(TESTER_SUITE_EVIDENCE_COMMAND),
          false,
          `${wf}_${agent} omits the evidence command when suiteEvidence:false`,
        );
      }
    }
    // Untouched agents are byte-identical between the two configurations.
    for (const key of Object.keys(behaviors.agents)) {
      const on = JSON.stringify(behaviors.agents[key]);
      const off = JSON.stringify(negative.agents[key]);
      const isTestedTreeAgent = MERGE_WORKFLOWS.some((wf) => key === `${wf}_${TESTED_TREE_AGENT_BY_WORKFLOW[wf]}`);
      if (!isTestedTreeAgent) assert.equal(off, on, `${key} is unchanged by suiteEvidence:false`);
    }

    // materializeRehearsalScriptedRuntime threads suiteEvidence through to the
    // written behaviors file (both directions).
    const scratch = ownedScratch("suite-evidence");
    try {
      const inputRoot = path.join(scratch, "rehearsal");
      const inputRootOff = path.join(scratch, "rehearsal-off");
      const stateRoot = path.join(scratch, "state");
      fs.mkdirSync(inputRoot, { recursive: true });
      fs.mkdirSync(inputRootOff, { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true });
      const on = materializeRehearsalScriptedRuntime({ fs: REAL_FS, inputRoot, stateRoot, campaignId: "on", workflowTexts: texts });
      const off = materializeRehearsalScriptedRuntime({ fs: REAL_FS, inputRoot: inputRootOff, stateRoot, campaignId: "off", workflowTexts: texts, suiteEvidence: false });
      const onBehaviors = JSON.parse(fs.readFileSync(on.behaviors_file, "utf8"));
      const offBehaviors = JSON.parse(fs.readFileSync(off.behaviors_file, "utf8"));
      assert.ok(
        behaviorEntries(onBehaviors.agents["feature-dev-merge-worktree_tester"])[0].commands.includes(TESTER_SUITE_EVIDENCE_COMMAND),
        "default materialized behaviors carry the evidence command",
      );
      assert.equal(
        (behaviorEntries(offBehaviors.agents["feature-dev-merge-worktree_tester"])[0].commands ?? []).includes(TESTER_SUITE_EVIDENCE_COMMAND),
        false,
        "materialized negative behaviors omit the evidence command",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("B11: NPF-2 — the only evidence mechanism is executing the shim-wrapped TEST_CMD; no direct ledger write exists", () => {
    assert.equal(TESTER_SUITE_EVIDENCE_COMMAND, "{{input.TEST_CMD}}", "the command is the unresolved product placeholder");
    // The rehearsal module never opens the product DB or emits SQL: it cannot
    // fabricate a suite_results row. The only way a row appears is the shim
    // executing the rendered TEST_CMD.
    const source = fs.readFileSync(path.join(repoRoot, "torture-test", "bin", "tt-storm-rehearsal.mjs"), "utf8");
    assert.equal(/INSERT\s+INTO/i.test(source), false, "no raw SQL INSERT in the rehearsal module");
    assert.equal(/new\s+DatabaseSync|getDb\s*\(|require\(['"]node:sqlite/.test(source), false, "no direct product-DB access in the rehearsal module");
    // Every reference to suite_results is a comment (documentation), never code.
    for (const line of source.split("\n")) {
      if (!line.includes("suite_results")) continue;
      assert.ok(line.trim().startsWith("//"), `suite_results may only appear in comments: ${line.trim()}`);
    }

    const texts = bundledTexts();
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    for (const [key, behavior] of Object.entries(behaviors.agents)) {
      for (const entry of behaviorEntries(behavior)) {
        for (const command of (entry as any).commands ?? []) {
          // Build-time commands never embed an actual ledger write; the only
          // product seam is the unresolved placeholder resolved at runtime.
          assert.equal(command.includes("suite_results"), false, `${key} command never writes the ledger directly`);
          assert.equal(command.includes("INSERT"), false, `${key} command never issues SQL`);
        }
      }
    }
  });
});
