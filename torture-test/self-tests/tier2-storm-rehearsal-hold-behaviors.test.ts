// Tier-2 STORM-REHEARSAL-FIX4 US-003 — the generated scripted behaviors carry
// ONE campaign-controlled mid-flight hold per storm workflow (in-process;
// NO daemon/harness/chaos).
//
// Why this exists (requirement 1a / SF-8): attempt 4 (#63) showed every
// live-target Round-B chaos phase resolved run_terminal because the zero-model
// runs finished in ~6 minutes while the phases were due at 5400 s+. The fix is
// a hold the engine owns: each roster run's designated step claims and then
// parks (the runtime waits on a campaign-owned release checkpoint) so the run
// stays ACTIVE long enough for the concurrency window and every chaos phase to
// observe a LIVE target. This file pins the BEHAVIOR GENERATION half:
//   * exactly one hold-bearing agent per workflow;
//   * merge-family -> the merger (hold BEFORE its real merge-branch command,
//     i.e. the pre-merge landing window), non-merge -> the first step agent;
//   * array behaviors (a loop body as first step agent) carry the hold on
//     every element;
//   * the hold id is the stable HOLD_ID and every timeoutMs is a bounded
//     positive number (a non-positive/derived-schedule bug falls back).
//
// Everything here is launch-free: the only effects are contained writes under a
// fresh owned temp dir; nothing is spawned and no src/ file is edited.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL_FS, STORM_WORKFLOW_IDS } from "../bin/tt-storm-roster.mjs";
import {
  boundedHoldTimeoutMs,
  buildRehearsalScriptedBehaviors,
  HOLD_ID,
  HOLD_TIMEOUT_MS,
  materializeRehearsalScriptedRuntime,
  parseWorkflowSteps,
  readRehearsalWorkflowTexts,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

function bundledTexts(): Record<string, string> {
  return readRehearsalWorkflowTexts({ fs: REAL_FS, roots: [BUNDLED_WORKFLOWS], workflowIds: STORM_WORKFLOW_IDS });
}

function entriesOf(behavior: any): any[] {
  return Array.isArray(behavior) ? behavior : [behavior];
}

// Every agent key of `wf` whose behavior carries at least one hold.
function holdKeysFor(behaviors: any, wf: string): string[] {
  return Object.keys(behaviors.agents)
    .filter((k) => k.startsWith(`${wf}_`))
    .filter((k) => entriesOf(behaviors.agents[k]).some((e: any) => e && e.hold));
}

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-hold-beh-${label}-`));
}

// A minimal loop-first, non-merge workflow: the story loop is step[0], so the
// FIRST step agent is the loop body and its behavior is a per-story ARRAY.
const SYNTHETIC_LOOP_YAML = [
  "id: synthetic-loop",
  "steps:",
  "  - id: implement",
  "    agent: dev",
  "    type: loop",
  "    loop:",
  "      over: stories",
  "      verify_step: verify",
  "      fresh_session: true",
  "    input: |",
  "      Implement the story.",
  '    expects: "STATUS: done"',
  "  - id: verify",
  "    agent: verifier",
  "    input: |",
  "      Verify.",
  '    expects: "STATUS: done"',
  "",
].join("\n");

describe("STORM-REHEARSAL-FIX4 US-003 — generated hold behaviors (launch-free)", () => {
  it("H1: exactly one designated hold-bearing agent per storm workflow with the stable HOLD_ID and a bounded timeout", () => {
    assert.equal(HOLD_ID, "storm-midflight", "the hold id is the stable campaign constant");
    assert.ok(Number.isFinite(HOLD_TIMEOUT_MS) && HOLD_TIMEOUT_MS > 0, "HOLD_TIMEOUT_MS is a positive bound");

    const texts = bundledTexts();
    const behaviors: any = buildRehearsalScriptedBehaviors({ workflowTexts: texts });

    for (const wf of STORM_WORKFLOW_IDS) {
      const holdKeys = holdKeysFor(behaviors, wf);
      assert.equal(holdKeys.length, 1, `${wf} has exactly one hold-bearing agent (got ${JSON.stringify(holdKeys)})`);

      // Every entry of the designated agent carries exactly the stable hold
      // with a bounded positive numeric timeout, and no other agent is held.
      const entries = entriesOf(behaviors.agents[holdKeys[0]]);
      assert.ok(entries.length > 0, `${holdKeys[0]} has at least one behavior entry`);
      for (const entry of entries) {
        assert.deepEqual(entry.hold, { id: HOLD_ID, timeoutMs: HOLD_TIMEOUT_MS }, `${holdKeys[0]} entry hold`);
      }
      for (const [key, behavior] of Object.entries(behaviors.agents)) {
        if (!key.startsWith(`${wf}_`) || key === holdKeys[0]) continue;
        for (const entry of entriesOf(behavior)) {
          assert.equal(entry.hold, undefined, `${key} is not the designated hold agent`);
        }
      }
    }
  });

  it("H2: merge-family workflows hold the merger, and its real merge-branch command survives alongside the hold", () => {
    const texts = bundledTexts();
    const behaviors: any = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    const mergeWorkflows = STORM_WORKFLOW_IDS.filter((w) => w.endsWith("-merge-worktree"));
    assert.ok(mergeWorkflows.length >= 1, "at least one merge-worktree workflow in the roster");

    for (const wf of mergeWorkflows) {
      const holdKeys = holdKeysFor(behaviors, wf);
      assert.deepEqual(holdKeys, [`${wf}_merger`], `${wf} holds the merger`);

      const merger = behaviors.agents[`${wf}_merger`];
      assert.equal(Array.isArray(merger), false, `${wf} merger behavior is an object`);
      assert.deepEqual(merger.hold, { id: HOLD_ID, timeoutMs: HOLD_TIMEOUT_MS }, `${wf} merger hold`);
      // The merge command is still present, and (structurally) the runtime
      // applies the hold BEFORE commands, so the real merge only runs after
      // release.
      assert.ok(Array.isArray(merger.commands) && merger.commands.length > 0, `${wf} merger commands present`);
      assert.ok(
        merger.commands.some((c: string) => c.includes("tamandua merge-branch")),
        `${wf} merger still runs the real merge-branch command`,
      );
      assert.equal(merger.includeCommandOutput, true, `${wf} merger keeps includeCommandOutput`);
      assert.ok(typeof merger.output === "string" && merger.output.includes("STATUS: done"), `${wf} merger output intact`);
    }
  });

  it("H3: non-merge workflows hold the FIRST step agent (do-review-do-verify + do-now -> doer)", () => {
    const texts = bundledTexts();
    const behaviors: any = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    const nonMerge = STORM_WORKFLOW_IDS.filter((w) => !w.endsWith("-merge-worktree"));
    assert.ok(nonMerge.length >= 2, "the roster keeps both non-merge workflows");

    for (const wf of nonMerge) {
      const steps = parseWorkflowSteps(texts[wf]);
      const firstAgent = steps[0]?.agent;
      assert.ok(firstAgent, `${wf} has a first step agent`);
      const holdKeys = holdKeysFor(behaviors, wf);
      assert.deepEqual(holdKeys, [`${wf}_${firstAgent}`], `${wf} holds its first step agent (${firstAgent})`);
    }
    assert.deepEqual(holdKeysFor(behaviors, "do-review-do-verify"), ["do-review-do-verify_doer"]);
    assert.deepEqual(holdKeysFor(behaviors, "do-now"), ["do-now_doer"]);
  });

  it("H4: an array behavior (loop body as first step agent) carries the hold on EVERY element", () => {
    const behaviors: any = buildRehearsalScriptedBehaviors({
      workflowTexts: { "synthetic-loop": SYNTHETIC_LOOP_YAML },
      workflowIds: ["synthetic-loop"],
    });
    const holdKeys = holdKeysFor(behaviors, "synthetic-loop");
    assert.deepEqual(holdKeys, ["synthetic-loop_dev"], "the loop-body first agent is the designated hold agent");

    const body = behaviors.agents["synthetic-loop_dev"];
    assert.ok(Array.isArray(body) && body.length >= 2, "loop body is a per-story array");
    for (const entry of body) {
      assert.deepEqual(entry.hold, { id: HOLD_ID, timeoutMs: HOLD_TIMEOUT_MS }, "every loop-body element is held");
    }
    // A non-designated array agent (the verifier) is untouched.
    for (const entry of behaviors.agents["synthetic-loop_verifier"]) {
      assert.equal(entry.hold, undefined);
    }
  });

  it("H5: the hold timeout is override-driven only through the bounded positive fallback, and non-hold fields are unchanged", () => {
    const texts = bundledTexts();
    const base: any = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    const overridden: any = buildRehearsalScriptedBehaviors({ workflowTexts: texts, holdTimeoutMs: 12345 });

    // Explicit positive override is honored; invalid values fall back.
    assert.equal(boundedHoldTimeoutMs(12345), 12345);
    for (const bad of [0, -1, NaN, Infinity, "not-a-number", null, undefined]) {
      assert.equal(boundedHoldTimeoutMs(bad), HOLD_TIMEOUT_MS, `invalid timeout ${String(bad)} falls back`);
    }
    for (const wf of STORM_WORKFLOW_IDS) {
      const key = holdKeysFor(overridden, wf)[0];
      for (const entry of entriesOf(overridden.agents[key])) {
        assert.equal(entry.hold.timeoutMs, 12345, `${key} honors the explicit timeout`);
      }
    }

    // Strip the hold and assert the rest of the document is byte-identical
    // (the hold is additive; outputs/commands/expects are untouched).
    const strip = (doc: any) => {
      const clone = structuredClone(doc);
      for (const behavior of Object.values(clone.agents)) {
        for (const entry of Array.isArray(behavior) ? behavior : [behavior]) delete entry.hold;
      }
      return clone;
    };
    assert.deepEqual(strip(overridden), strip(base), "only the hold timeout changed; outputs/commands are byte-identical");
  });

  it("H6: materializeRehearsalScriptedRuntime writes the holds into behaviors.json (with the campaign timeout)", () => {
    const scratch = ownedScratch("materialize");
    try {
      const inputRoot = path.join(scratch, "rehearsal", "storm-hold-unit");
      const stateRoot = path.join(scratch, "home", ".tamandua");
      fs.mkdirSync(inputRoot, { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true });

      const record = materializeRehearsalScriptedRuntime({
        fs: REAL_FS,
        inputRoot,
        stateRoot,
        campaignId: "storm-hold-unit",
        workflowTexts: bundledTexts(),
        holdTimeoutMs: 987654,
      });

      const parsed = JSON.parse(fs.readFileSync(record.behaviors_file, "utf8"));
      const holdEntries = Object.entries(parsed.agents).flatMap(([key, behavior]: [string, any]) =>
        entriesOf(behavior)
          .filter((e: any) => e && e.hold)
          .map(() => key),
      );
      // Exactly one hold-bearing key per workflow.
      for (const wf of STORM_WORKFLOW_IDS) {
        assert.equal(holdEntries.filter((k) => k.startsWith(`${wf}_`)).length, 1, `${wf} single held agent in behaviors.json`);
      }
      for (const behavior of Object.values(parsed.agents)) {
        for (const entry of entriesOf(behavior)) {
          if (entry.hold) assert.deepEqual(entry.hold, { id: HOLD_ID, timeoutMs: 987654 });
        }
      }
      assert.equal(record.agents, Object.keys(parsed.agents).length, "recorded agent count matches the behaviors file");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
