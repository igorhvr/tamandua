// Tier-2 STORM-REHEARSAL-FIX3 US-001 — parse the story-loop graph from the REAL
// bundled workflow.yml steps (pure; NO daemon/harness/model).
//
// SF-1 (attempt 3, run #61): the generated scripted behaviors synthesized each
// agent's output only from that step's literal/regex expects. Step-ops
// separately requires a STORIES_JSON block whenever the NEXT step is
// `type: loop, loop.over: stories`, so feature-dev `plan` and security-audit
// `prioritize` were reset to pending and exhausted retries. US-001 makes the
// graph derivable from the real text: parseWorkflowSteps now exposes every
// step's type/loop/condition and whether its own `input:` body mentions
// STORIES_JSON, and deriveStoryLoopProducers identifies the producer that feeds
// the story loop for ANY workflow — never a hardcoded id.
//
// This file is launch-free: it only reads the bundled workflows/ directory and
// exercises pure exported functions. Nothing is written, spawned, or mutated.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadWorkflowSpec } from "../../dist/installer/workflow-spec.js";
import { validateExpects } from "../../dist/installer/step-ops.js";
import { AUTO_CONTEXT_KEYS } from "../../dist/installer/workflow-contract.js";
import {
  appendScriptedStoriesJson,
  buildRehearsalScriptedBehaviors,
  buildScriptedOutputForChecks,
  collectPlaceholders,
  deriveFeedForwardKeys,
  deriveStoryLoopProducers,
  generatedOutputKeys,
  isRunProvidedContextKey,
  parseExpectsChecks,
  parseWorkflowSteps,
  SCRIPTED_STORY_COUNT,
  scriptedLineForRegex,
  scriptedStories,
  scriptedStoriesJsonLine,
  synthesizeScriptedRegexLine,
} from "../bin/tt-storm-rehearsal.mjs";
import { STORM_WORKFLOW_IDS } from "../bin/tt-storm-roster.mjs";

const repoRoot = process.cwd();
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

interface ParsedStep {
  id: string;
  agent: string | null;
  expects: string | null;
  input: string | null;
  type: string;
  loop: Record<string, unknown> | null;
  condition: string | null;
  inputMentionsStoriesJson: boolean;
}

interface StoryLoopGraph {
  producers: ParsedStep[];
  loopStep: ParsedStep | null;
  bodyAgent: string | null;
  verifyStep: string | null;
  verifyStepId: string | null;
  verifyAgent: string | null;
}

function bundledWorkflowIds(): string[] {
  return fs
    .readdirSync(BUNDLED_WORKFLOWS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(BUNDLED_WORKFLOWS, name, "workflow.yml")))
    .sort();
}

function workflowText(id: string): string {
  return fs.readFileSync(path.join(BUNDLED_WORKFLOWS, id, "workflow.yml"), "utf8");
}

function parsedById(steps: ParsedStep[], id: string): ParsedStep {
  const step = steps.find((s) => s.id === id);
  assert.ok(step, `workflow has a step with id '${id}'`);
  return step!;
}

// Family classification from the ACTUAL parsed text, not a hand-picked list.
function expectedProducerFor(id: string): string {
  if (id.startsWith("feature-dev")) return "plan";
  if (id.startsWith("security-audit")) return "prioritize";
  throw new Error(`unexpected loop-over-stories workflow id '${id}'`);
}

function expectedBodyAgentFor(id: string): string {
  if (id.startsWith("feature-dev")) return "developer";
  if (id.startsWith("security-audit")) return "fixer";
  throw new Error(`unexpected loop-over-stories workflow id '${id}'`);
}

function looplessWorkflowIds(): string[] {
  return bundledWorkflowIds().filter((id) => {
    const steps = parseWorkflowSteps(workflowText(id));
    return !steps.some((s) => s.type === "loop" && s.loop?.over === "stories");
  });
}

function storyLoopWorkflowIds(): string[] {
  return bundledWorkflowIds().filter((id) => {
    const steps = parseWorkflowSteps(workflowText(id));
    return steps.some((s) => s.type === "loop" && s.loop?.over === "stories");
  });
}

describe("STORM-REHEARSAL-FIX3 US-001 — story-loop graph derived from the real workflows (pure)", () => {
  it("G1: parseWorkflowSteps exposes type/loop/condition for every step of every bundled workflow", () => {
    const ids = bundledWorkflowIds();
    assert.equal(ids.length, 23, "every bundled workflow is discovered");

    for (const wf of ids) {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      assert.ok(steps.length > 0, `${wf} parses at least one step`);
      for (const step of steps) {
        assert.equal(typeof step.id, "string", `${wf}/${step.id} id is a string`);
        assert.equal(typeof step.agent, "string", `${wf}/${step.id} has an agent`);
        assert.ok((step.agent as string).length > 0, `${wf}/${step.id} agent is non-empty`);
        assert.equal(typeof step.expects, "string", `${wf}/${step.id} has an expects block`);
        assert.ok((step.expects as string).trim().length > 0, `${wf}/${step.id} expects is non-empty`);
        // type defaults to 'step' and is always a non-empty string.
        assert.equal(typeof step.type, "string", `${wf}/${step.id} type is a string`);
        assert.ok(step.type.length > 0, `${wf}/${step.id} type is non-empty`);
        // loop is null or a parsed mapping; condition is null or a string.
        assert.ok(step.loop === null || (typeof step.loop === "object" && !Array.isArray(step.loop)), `${wf}/${step.id} loop is null|object`);
        assert.ok(step.condition === null || typeof step.condition === "string", `${wf}/${step.id} condition is null|string`);
        assert.equal(typeof step.inputMentionsStoriesJson, "boolean", `${wf}/${step.id} inputMentionsStoriesJson is boolean`);
        // US-002: the raw input template is captured so feed-forward
        // completeness can derive every {{placeholder}} from the parsed steps.
        assert.equal(typeof step.input, "string", `${wf}/${step.id} input is a string`);
        assert.ok((step.input as string).trim().length > 0, `${wf}/${step.id} input is non-empty`);
      }
    }
  });

  it("G2: the ten loop-over-stories workflows expose the real loop wiring (type/over/verify_each/verify_step)", () => {
    const ids = bundledWorkflowIds();
    const loopWorkflows: string[] = [];
    for (const wf of ids) {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      const loopSteps = steps.filter((s) => s.type === "loop");
      assert.ok(loopSteps.length <= 1, `${wf} has at most one loop step`);
      const storyLoop = loopSteps.find((s) => s.loop?.over === "stories");
      if (!storyLoop) {
        // Any other loop must not be a stories loop.
        for (const s of loopSteps) assert.notEqual(s.loop?.over, "stories", `${wf} non-story loop stays non-story`);
        continue;
      }
      loopWorkflows.push(wf);
      assert.equal(loopSteps.length, 1, `${wf} has exactly one loop step`);
      assert.equal(storyLoop.loop?.over, "stories", `${wf} loop.over is stories`);
      assert.equal(storyLoop.loop?.completion, "all_done", `${wf} loop.completion is all_done`);
      assert.equal(storyLoop.loop?.fresh_session, true, `${wf} loop.fresh_session is true`);
      assert.equal(storyLoop.loop?.verify_each, true, `${wf} loop.verify_each is true`);
      assert.equal(storyLoop.loop?.verify_step, "verify", `${wf} loop.verify_step is verify`);
    }

    assert.equal(loopWorkflows.length, 10, "exactly ten bundled workflows loop over stories");
    for (const wf of loopWorkflows) {
      assert.ok(
        wf.startsWith("feature-dev") || wf.startsWith("security-audit"),
        `${wf} is a feature-dev/security-audit family workflow`,
      );
    }
  });

  it("G3: deriveStoryLoopProducers yields exactly the real producer/body/verify agents for every story-loop workflow", () => {
    const loopWorkflows = bundledWorkflowIds().filter((wf) => {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      return steps.some((s) => s.type === "loop" && s.loop?.over === "stories");
    });
    assert.equal(loopWorkflows.length, 10, "ten loop-over-stories workflows");

    for (const wf of loopWorkflows) {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      const graph: StoryLoopGraph = deriveStoryLoopProducers(steps);
      const expectedProducer = expectedProducerFor(wf);
      const expectedBody = expectedBodyAgentFor(wf);

      assert.ok(graph.loopStep, `${wf} derived loopStep`);
      assert.equal(graph.loopStep?.id, steps.find((s) => s.type === "loop")?.id, `${wf} loopStep is the real loop step`);
      assert.equal(graph.producers.length, 1, `${wf} has exactly one STORIES_JSON producer`);
      assert.equal(graph.producers[0].id, expectedProducer, `${wf} producer is ${expectedProducer}`);
      assert.equal(graph.producers[0].inputMentionsStoriesJson, true, `${wf} producer input mentions STORIES_JSON`);
      assert.equal(graph.bodyAgent, expectedBody, `${wf} loop body agent is ${expectedBody}`);
      assert.equal(graph.verifyStepId, "verify", `${wf} verify step id is verify`);
      assert.equal(graph.verifyStep, "verifier", `${wf} verifyStep resolves to the verifier agent`);
      assert.equal(graph.verifyAgent, "verifier", `${wf} verifyAgent resolves to the verifier agent`);
      assert.equal(parsedById(steps, "verify").agent, "verifier", `${wf} verify step really runs the verifier`);

      // Only the producer mentions STORIES_JSON in its input; the loop body and
      // verify agent must not be misidentified as producers even though they
      // run per-story.
      const storyInputSteps = steps.filter((s) => s.inputMentionsStoriesJson).map((s) => s.id);
      assert.deepEqual(storyInputSteps, [expectedProducer], `${wf} only the producer input mentions STORIES_JSON`);
    }

    // security-audit has an intermediate setup step between the producer
    // (prioritize) and the loop (fix): the producer derivation must skip it.
    const auditSteps: ParsedStep[] = parseWorkflowSteps(workflowText("security-audit"));
    const auditIds = auditSteps.map((s) => s.id);
    assert.ok(auditIds.indexOf("prioritize") < auditIds.indexOf("setup"), "prioritize precedes setup");
    assert.ok(auditIds.indexOf("setup") < auditIds.indexOf("fix"), "setup precedes the fix loop");
    assert.equal(deriveStoryLoopProducers(auditSteps).producers[0].id, "prioritize", "intermediate setup is not the producer");

    // feature-dev has plan then setup then implement (loop).
    const devSteps: ParsedStep[] = parseWorkflowSteps(workflowText("feature-dev"));
    const devIds = devSteps.map((s) => s.id);
    assert.ok(devIds.indexOf("plan") < devIds.indexOf("setup"), "plan precedes setup");
    assert.ok(devIds.indexOf("setup") < devIds.indexOf("implement"), "setup precedes the implement loop");
    assert.equal(deriveStoryLoopProducers(devSteps).producers[0].id, "plan", "intermediate setup is not the producer");
  });

  it("G4: deriveStoryLoopProducers yields zero producers for every workflow without a story loop", () => {
    const loopless = looplessWorkflowIds();
    assert.equal(loopless.length, 13, "thirteen bundled workflows have no story loop");

    for (const wf of loopless) {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      const graph: StoryLoopGraph = deriveStoryLoopProducers(steps);
      assert.equal(graph.loopStep, null, `${wf} has no derived loopStep`);
      assert.deepEqual(graph.producers, [], `${wf} has no producers`);
      assert.equal(graph.bodyAgent, null, `${wf} has no bodyAgent`);
      assert.equal(graph.verifyStep, null, `${wf} has no verifyStep`);
      assert.equal(graph.verifyStepId, null, `${wf} has no verifyStepId`);
      assert.equal(graph.verifyAgent, null, `${wf} has no verifyAgent`);
      assert.equal(
        steps.some((s) => s.inputMentionsStoriesJson),
        false,
        `${wf} has no STORIES_JSON producer input`,
      );
    }
  });

  it("G5: the existing expects/agent parsing stays byte-compatible (block scalar + inline quoted + skipped input)", () => {
    const fdText = workflowText("feature-dev-merge-worktree");
    const fd: ParsedStep[] = parseWorkflowSteps(fdText);
    const fdAgents = new Set(fd.map((s) => s.agent).filter(Boolean));
    assert.deepEqual(
      [...fdAgents].sort(),
      ["developer", "merger", "planner", "reviewer", "setup", "tester", "verifier"],
      "documented agent examples inside input bodies never become step agents",
    );

    const plan = parsedById(fd, "plan");
    assert.equal(plan.type, "step", "plan uses the default step type");
    assert.equal(plan.condition, null, "plan has no condition");
    assert.ok(plan.expects?.includes("STATUS: done"), "plan inline expects keeps the STATUS literal");
    assert.match(plan.expects ?? "", /regex:\^BRANCH:/, "plan inline expects keeps the BRANCH regex");

    const review = parsedById(fd, "test_cmd_review");
    assert.equal(review.type, "conditional", "conditional step type is parsed");
    assert.equal(review.condition, "test_cmd_review_required", "conditional gate is parsed");

    const implement = parsedById(fd, "implement");
    assert.equal(implement.type, "loop", "loop step type is parsed");
    assert.equal(implement.loop?.over, "stories", "loop over is parsed");
    assert.equal(implement.inputMentionsStoriesJson, false, "loop body input does not mention STORIES_JSON");

    const merge = parsedById(fd, "finalize_merge");
    const regexLines = (merge.expects ?? "").split("\n").filter((l) => l.trim().startsWith("regex:"));
    assert.equal(regexLines.length, 3, "block-scalar expects still yields its three regex clauses");
    assert.ok(fd.some((s) => s.id === "finalize_merge" && s.agent === "merger"), "merger step preserved");

    // Pure helper: deriving the graph never mutates the parsed steps.
    const before = JSON.stringify(fd);
    deriveStoryLoopProducers(fd);
    assert.equal(JSON.stringify(fd), before, "deriveStoryLoopProducers is side-effect free");
  });

  it("G6: deriveStoryLoopProducers is graph-driven, not id-driven (synthetic loops)", () => {
    // A loop over something other than stories is not a story loop.
    const otherLoop = [
      { id: "scan", agent: "scanner", type: "step", loop: null, condition: null, inputMentionsStoriesJson: true },
      { id: "churn", agent: "churner", type: "loop", loop: { over: "issues", verify_step: "check" }, condition: null, inputMentionsStoriesJson: false },
    ];
    assert.deepEqual(deriveStoryLoopProducers(otherLoop).producers, [], "non-stories loop yields no producer");

    // A STORIES_JSON input AFTER the loop is not a producer.
    const trailingProducer = [
      { id: "first", agent: "a", type: "step", loop: null, condition: null, inputMentionsStoriesJson: false },
      { id: "implement", agent: "developer", type: "loop", loop: { over: "stories", verify_step: "verify" }, condition: null, inputMentionsStoriesJson: false },
      { id: "later", agent: "planner", type: "step", loop: null, condition: null, inputMentionsStoriesJson: true },
    ];
    const graph = deriveStoryLoopProducers(trailingProducer);
    assert.deepEqual(graph.producers, [], "only steps BEFORE the loop can be producers");
    assert.equal(graph.loopStep?.id, "implement", "the loop step is still found");
    assert.equal(graph.bodyAgent, "developer", "body agent is the loop step agent");

    // Multiple pre-loop STORIES_JSON inputs are all reported (callers decide if
    // that is a malformed graph); the bundled catalog never does this.
    const twoProducers = [
      { id: "p1", agent: "x", type: "step", loop: null, condition: null, inputMentionsStoriesJson: true },
      { id: "p2", agent: "y", type: "step", loop: null, condition: null, inputMentionsStoriesJson: true },
      { id: "implement", agent: "developer", type: "loop", loop: { over: "stories", verify_step: "verify" }, condition: null, inputMentionsStoriesJson: false },
    ];
    assert.equal(deriveStoryLoopProducers(twoProducers).producers.length, 2, "all pre-loop producers are reported");

    // A missing/unknown verify step resolves to a null agent, never a throw.
    const noVerifyStep = [
      { id: "plan", agent: "planner", type: "step", loop: null, condition: null, inputMentionsStoriesJson: true },
      { id: "implement", agent: "developer", type: "loop", loop: { over: "stories", verify_step: "verify" }, condition: null, inputMentionsStoriesJson: false },
    ];
    const missing = deriveStoryLoopProducers(noVerifyStep);
    assert.equal(missing.verifyStepId, "verify");
    assert.equal(missing.verifyStep, null, "unresolvable verify step yields null agent");

    // Malformed input never throws.
    assert.deepEqual(deriveStoryLoopProducers(undefined as any).producers, [], "undefined steps yields no producers");
    assert.deepEqual(deriveStoryLoopProducers([] as any).producers, [], "empty steps yields no producers");
  });

  // ── US-002: generated-behavior completeness for EVERY bundled workflow ──
  // SF-1 follow-through: the generated scripted behaviors must satisfy every
  // step's expects (including the step-ops stories loop) for the whole
  // catalog, with a deterministic regex synthesizer used only as a fallback
  // and graph-derived feed-forward keys for genuinely unresolved templates.

  function bundledTextsMap(ids: string[] = bundledWorkflowIds()): Record<string, string> {
    const texts: Record<string, string> = {};
    for (const wf of ids) texts[wf] = workflowText(wf);
    return texts;
  }

  it("G7: generated behaviors satisfy every bundled step's expects under the product validator", async () => {
    const ids = bundledWorkflowIds();
    assert.equal(ids.length, 23, "the full bundled catalog");
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: bundledTextsMap(ids), workflowIds: ids });

    let checked = 0;
    for (const wf of ids) {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      const spec: any = await loadWorkflowSpec(path.join(BUNDLED_WORKFLOWS, wf));
      const specById = new Map<string, any>(spec.steps.map((s: any) => [s.id, s]));
      for (const step of steps) {
        const specStep = specById.get(step.id);
        assert.ok(specStep, `${wf}/${step.id} exists in the real spec`);
        const behavior = behaviors.agents[`${wf}_${step.agent}`];
        assert.ok(behavior, `${wf}_${step.agent} generated behavior`);
        // US-003: loop-body (developer/fixer) and loop-verify (verifier)
        // agents are arrays (one entry per emitted story). Every entry must
        // satisfy the step's expects for a single-step agent; for a
        // multi-step agent (e.g. feature-dev-github-pr's developer owning
        // implement + pr) at least one entry satisfies each step's expects.
        const entries = Array.isArray(behavior) ? behavior : [behavior];
        const ownsStepCount = steps.filter((s) => s.agent === step.agent).length;
        if (ownsStepCount === 1) {
          for (const entry of entries) {
            assert.equal(typeof entry.output, "string", `${wf}_${step.agent} entry output`);
            const err = validateExpects(entry.output, specStep.expects);
            checked += 1;
            assert.equal(err, null, `${wf}/${step.id} (${step.agent}) expects mismatch: ${err}\nOUTPUT: ${entry.output}`);
          }
        } else {
          const errs = entries.map((entry: any) => validateExpects(entry.output, specStep.expects));
          checked += 1;
          assert.ok(
            errs.some((e: string | null) => e === null),
            `${wf}/${step.id} (${step.agent}) no behavior entry satisfies expects: ${errs.filter(Boolean).join(" | ")}`,
          );
        }
      }
    }
    assert.ok(checked >= 100, `validated ${checked} step/expects pairs`);
  });

  it("G8: the synthesizer is a fallback only (candidate matches still win)", () => {
    // The exact regexes that previously threw (no candidate) now synthesize a
    // line that itself satisfies the regex.
    const noCandidate = [
      "^RESULTS:\\s*\\S+",
      "^DEFERRED:\\s*\\S+",
      "^SKILLS_COUNT:\\s*\\d+",
      "^CLUSTERS_FOUND:\\s*\\d+",
      "^AUDIT_AFTER:\\s*\\S+",
      "^CLEAN_SKILLS:\\s*\\S+",
      "^SKILLS_JSON:\\s*\\S+",
      "^CLUSTERS_JSON:\\s*\\S+",
      "^REDUNDANT_COUNT:\\s*\\d+",
    ];
    for (const source of noCandidate) {
      assert.equal(scriptedLineForRegex(source), null, `${source} has no candidate`);
      const line = synthesizeScriptedRegexLine(source);
      assert.match(line, new RegExp(source, "m"), `synthesized "${line}" must satisfy ${source}`);
    }
    // Candidates always win where one exists.
    const output = buildScriptedOutputForChecks({
      literals: ["STATUS: done"],
      regexes: ["^STATUS:\\s*(done|retry)\\s*$"],
    });
    assert.equal(output, "STATUS: done", "the candidate STATUS: done wins over the synthesizer");
  });

  it("G9: the six SCRIPTED_REHEARSAL workflows keep their candidate-only outputs (no synthesizer/feed-forward)", () => {
    const texts = bundledTextsMap([...STORM_WORKFLOW_IDS]);
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    for (const wf of STORM_WORKFLOW_IDS) {
      const steps: ParsedStep[] = parseWorkflowSteps(texts[wf]);
      // No feed-forward key is needed anywhere in the established workflows.
      for (const set of deriveFeedForwardKeys(steps, wf)) {
        assert.equal(set.size, 0, `${wf} has no feed-forward keys`);
      }
      // Every regex has an existing candidate, so the synthesizer never runs.
      for (const step of steps) {
        for (const source of parseExpectsChecks(step.expects ?? "").regexes) {
          assert.notEqual(scriptedLineForRegex(source), null, `${wf}/${step.id} regex ${source} keeps a candidate`);
        }
      }
    }
    // Pin the established outputs: non-producer agents stay byte-identical;
    // the story producer keeps its candidate-only prefix and gains exactly one
    // STORIES_JSON plan as the LAST line (US-003).
    // US-004: the BRANCH candidate is run-scoped (`{{input.RUN_ID}}`), so two
    // runs of the same workflow can never share a merge branch.
    assert.equal(
      scriptedLineForRegex("^BRANCH:\\s*\\S+"),
      "BRANCH: storm-scripted-fixture-{{input.RUN_ID}}",
      "the BRANCH candidate is run-scoped",
    );
    const planner = behaviors.agents["feature-dev-merge-worktree_planner"].output;
    assert.ok(
      planner.startsWith("STATUS: done\nBRANCH: storm-scripted-fixture-{{input.RUN_ID}}\n"),
      "producer keeps its candidate-only prefix with the run-scoped branch placeholder",
    );
    assert.equal((planner.match(/^STORIES_JSON:/gm) ?? []).length, 1, "producer has exactly one STORIES_JSON plan");
    assert.equal(planner.split("\n").at(-1), scriptedStoriesJsonLine(), "STORIES_JSON is the last line");
    assert.equal(behaviors.agents["do-now_doer"].output, "STATUS: done");
    assert.equal(
      behaviors.agents["bug-fix-merge-worktree_triager"].output,
      "STATUS: done\nBRANCH: storm-scripted-fixture-{{input.RUN_ID}}\nSEVERITY: high\nAFFECTED_AREA: go/workerpool/pool.go\n" +
        "REPRODUCTION: the owned fixture reproduces the seeded bug deterministically\nPROBLEM_STATEMENT: the seeded fixture bug is deterministic",
    );
  });

  it("G10: synthesizeScriptedRegexLine handles numerics, urls, alternations, and never claims a rebase", () => {
    assert.equal(synthesizeScriptedRegexLine("^RESULTS:\\s*\\S+"), "RESULTS: scripted-results");
    assert.equal(synthesizeScriptedRegexLine("^SKILLS_COUNT:\\s*\\d+"), "SKILLS_COUNT: 0");
    assert.equal(synthesizeScriptedRegexLine("^SEVERITY:\\s*(critical|high|medium|low)"), "SEVERITY: critical");
    assert.equal(synthesizeScriptedRegexLine("^REBASED:\\s*(true|false)\\s*$"), "REBASED: false");
    const url = synthesizeScriptedRegexLine("PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+");
    assert.match(url, /^PR: https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
    // Full-pair alternations are not key-position alternations: fall back
    // without inventing a KEY from the pair.
    assert.equal(synthesizeScriptedRegexLine("^(STATUS:\\s*retry|REBASED:\\s*false)\\s*$"), "synthetic: scripted-value");
  });

  it("G11: feed-forward completeness fills a genuine gap and never synthesizes run-provided keys", () => {
    const yaml = [
      "id: synthetic-gap",
      "steps:",
      "  - id: first",
      "    agent: alpha",
      "    input: |",
      "      Do {{task}} in {{repo}}",
      "    expects: \"STATUS: done\"",
      "  - id: second",
      "    agent: beta",
      "    input: |",
      "      USE: {{report_key}}",
      "    expects: \"STATUS: done\"",
    ].join("\n");
    const steps: ParsedStep[] = parseWorkflowSteps(yaml);
    const ff = deriveFeedForwardKeys(steps, "synthetic-gap");
    assert.deepEqual([...ff[0]], ["report_key"], "the missing key is fed forward by the earliest step");
    assert.deepEqual([...ff[1]], [], "the last step feeds nothing forward");

    const behaviors = buildRehearsalScriptedBehaviors({
      workflowTexts: { "synthetic-gap": yaml },
      workflowIds: ["synthetic-gap"],
    });
    const alpha = behaviors.agents["synthetic-gap_alpha"].output;
    assert.match(alpha, /^REPORT_KEY: scripted-report_key$/m, "the fed-forward key is emitted");
    assert.doesNotMatch(alpha, /^REPO:/m, "run-seeded repo is never synthesized");
    assert.doesNotMatch(alpha, /^TASK:/m, "auto task is never synthesized");
    assert.equal(isRunProvidedContextKey("task"), true);
    assert.equal(AUTO_CONTEXT_KEYS.has("task"), true);
    assert.equal(isRunProvidedContextKey("report_key", "synthetic-gap"), false);
  });

  it("G12: every {{placeholder}} of every bundled workflow is emitted or run-provided", () => {
    const ids = bundledWorkflowIds();
    buildRehearsalScriptedBehaviors({ workflowTexts: bundledTextsMap(ids), workflowIds: ids });
    const uncovered: string[] = [];
    for (const wf of ids) {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      // generatedOutputKeys declares the KEY each step's generated output
      // carries; for a key-position alternation (^(A|B):) BOTH branches count
      // because step-ops normalizes the absent branch to "" (the
      // REPRO_EVIDENCE/CANNOT_REPRODUCE contract) rather than MISS-deadlocking.
      const emitted = new Set<string>();
      for (const step of steps) {
        for (const key of generatedOutputKeys(step.expects ?? "")) emitted.add(key);
      }
      for (const step of steps) {
        for (const key of collectPlaceholders(step.input ?? "")) {
          if (!emitted.has(key) && !isRunProvidedContextKey(key, wf)) {
            uncovered.push(`${wf}:${step.id}:${key}`);
          }
        }
      }
    }
    assert.deepEqual(uncovered, [], "no step template has an unresolved placeholder");
  });

  it("G13: a folded multi-line double-quoted expects carries its continuation regex (pr step)", () => {
    for (const wf of ["feature-dev-github-pr", "bug-fix-github-pr"]) {
      const steps: ParsedStep[] = parseWorkflowSteps(workflowText(wf));
      const pr = steps.find((s) => s.id === "pr");
      assert.ok(pr, `${wf} has a pr step`);
      assert.match(pr!.expects ?? "", /regex:PR:\\s\*https\?/, `${wf} pr expects kept its PR regex`);
      const output = buildScriptedOutputForChecks(parseExpectsChecks(pr!.expects ?? ""));
      assert.match(output, /^STATUS: done$/m, `${wf} pr output keeps STATUS`);
      assert.match(output, /^PR: https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/m, `${wf} pr output carries a PR url`);
    }
    // generatedOutputKeys must see the PR key from the folded scalar.
    const steps: ParsedStep[] = parseWorkflowSteps(workflowText("feature-dev-github-pr"));
    const pr = steps.find((s) => s.id === "pr")!;
    assert.equal(generatedOutputKeys(pr.expects ?? "").has("pr"), true, "pr key is a generated output key");
  });

  // ── US-003 (SF-1): STORIES_JSON + per-story loop-body/verify outputs ──

  it("G14: every story-loop producer emits exactly one schema-valid STORIES_JSON plan as the last line", () => {
    const ids = bundledWorkflowIds();
    const texts = bundledTextsMap(ids);
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts, workflowIds: ids });
    const loopIds = storyLoopWorkflowIds();
    assert.equal(loopIds.length, 10, "ten story-loop workflows");

    for (const wf of loopIds) {
      const steps: ParsedStep[] = parseWorkflowSteps(texts[wf]);
      const graph: StoryLoopGraph = deriveStoryLoopProducers(steps);
      assert.equal(graph.producers.length, 1, `${wf} has exactly one producer`);
      const behavior = behaviors.agents[`${wf}_${graph.producers[0].agent}`];
      assert.ok(behavior && !Array.isArray(behavior), `${wf} producer is a single-object behavior`);

      const lines: string[] = behavior.output.split("\n");
      const planLines = lines.filter((l) => l.startsWith("STORIES_JSON:"));
      assert.equal(planLines.length, 1, `${wf} producer has exactly one STORIES_JSON line`);
      assert.equal(lines[lines.length - 1], planLines[0], `${wf} STORIES_JSON is the last line`);

      const stories = JSON.parse(planLines[0].slice("STORIES_JSON:".length).trim());
      assert.ok(Array.isArray(stories), `${wf} plan is a JSON array`);
      assert.equal(stories.length, SCRIPTED_STORY_COUNT, `${wf} plan has ${SCRIPTED_STORY_COUNT} stories`);
      const seen = new Set<string>();
      for (const s of stories) {
        assert.match(String(s.id), /^[A-Z]+-\d+$/, `${wf} story id ${s.id} matches ^[A-Z]+-\\d+$`);
        assert.equal(seen.has(s.id), false, `${wf} story id ${s.id} is unique`);
        seen.add(s.id);
        assert.ok(typeof s.title === "string" && s.title.trim().length > 0, `${wf} story title non-empty`);
        assert.ok(typeof s.description === "string" && s.description.trim().length > 0, `${wf} story description non-empty`);
        assert.ok(Array.isArray(s.acceptanceCriteria) && s.acceptanceCriteria.length > 0, `${wf} acceptanceCriteria array non-empty`);
        for (const ac of s.acceptanceCriteria) {
          assert.ok(typeof ac === "string" && ac.trim().length > 0, `${wf} acceptanceCriteria item non-empty`);
        }
      }
      // The plan is the deterministic helper output, byte-for-byte.
      assert.equal(planLines[0], scriptedStoriesJsonLine(), `${wf} plan is the deterministic scripted plan`);
      assert.deepEqual(stories, scriptedStories(), `${wf} plan matches scriptedStories()`);
    }
  });

  it("G15: STORIES_JSON appears ONLY in the story producer's output (none in loopless workflows)", () => {
    const ids = bundledWorkflowIds();
    const texts = bundledTextsMap(ids);
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts, workflowIds: ids });

    for (const wf of ids) {
      const steps: ParsedStep[] = parseWorkflowSteps(texts[wf]);
      const graph: StoryLoopGraph = deriveStoryLoopProducers(steps);
      const producerKeys = new Set(graph.producers.map((p) => `${wf}_${p.agent}`));
      for (const key of Object.keys(behaviors.agents).filter((k) => k.startsWith(`${wf}_`))) {
        const behavior = behaviors.agents[key];
        const entries = Array.isArray(behavior) ? behavior : [behavior];
        const hasPlan = entries.some((entry: any) =>
          entry.output.split("\n").some((l: string) => l.startsWith("STORIES_JSON:")),
        );
        assert.equal(hasPlan, producerKeys.has(key), `${key} STORIES_JSON presence matches producer status`);
      }
      if (graph.producers.length === 0) {
        assert.equal(
          Object.keys(behaviors.agents)
            .filter((k) => k.startsWith(`${wf}_`))
            .some((k) => {
              const b = behaviors.agents[k];
              const entries = Array.isArray(b) ? b : [b];
              return entries.some((e: any) => e.output.includes("STORIES_JSON"));
            }),
          false,
          `${wf} (no story loop) never synthesizes STORIES_JSON`,
        );
      }
    }
    assert.equal(looplessWorkflowIds().length, 13, "thirteen loopless workflows checked");
  });

  it("G16: loop-body and verify agents are arrays with one valid entry per story", () => {
    const ids = bundledWorkflowIds();
    const texts = bundledTextsMap(ids);
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts, workflowIds: ids });
    for (const wf of storyLoopWorkflowIds()) {
      const steps: ParsedStep[] = parseWorkflowSteps(texts[wf]);
      const graph: StoryLoopGraph = deriveStoryLoopProducers(steps);
      const verifyStep = steps.find((s) => s.id === graph.verifyStepId);
      assert.ok(verifyStep, `${wf} verify step exists`);
      const pairs: Array<[string, string | null, string]> = [
        ["loop-body", graph.bodyAgent, graph.loopStep?.expects ?? ""],
        ["verify", graph.verifyAgent, verifyStep!.expects ?? ""],
      ];
      for (const [label, agent, expects] of pairs) {
        assert.ok(agent, `${wf} ${label} agent resolved`);
        const behavior = behaviors.agents[`${wf}_${agent}`];
        assert.ok(Array.isArray(behavior), `${wf} ${label} (${agent}) behavior is an array`);
        assert.equal(behavior.length, SCRIPTED_STORY_COUNT, `${wf} ${label} has one entry per story`);
        for (const entry of behavior) {
          assert.equal(typeof entry.output, "string", `${wf} ${label} entry output is a string`);
          assert.equal(validateExpects(entry.output, expects), null, `${wf} ${label} entry satisfies its step expects`);
          assert.equal(entry.tokens, 0, `${wf} ${label} entry is zero-token`);
        }
      }
      assert.notEqual(graph.bodyAgent, graph.verifyAgent, `${wf} loop body and verify are distinct agents`);
    }
  });

  it("G17: appendScriptedStoriesJson is idempotent and always places the plan last", () => {
    const base = "STATUS: done\nBRANCH: storm-scripted-fixture";
    const once = appendScriptedStoriesJson(base);
    assert.equal(once, `${base}\n${scriptedStoriesJsonLine()}`);
    const twice = appendScriptedStoriesJson(once);
    assert.equal(twice, once, "re-appending does not duplicate the plan");
    assert.equal((twice.match(/^STORIES_JSON:/gm) ?? []).length, 1, "exactly one plan line");
  });

  it("G18: the real parseAndInsertStories accepts every generated producer output (isolated temp HOME)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-us003-db-"));
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
      const ids = bundledWorkflowIds();
      const texts = bundledTextsMap(ids);
      const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts, workflowIds: ids });
      const { getDb } = await import("../../dist/db.js");
      const { parseAndInsertStories } = await import("../../dist/installer/step-ops.js");
      const db = getDb();
      const insertRun = db.prepare(
        `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', '{}', 0, NULL, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const wf of storyLoopWorkflowIds()) {
        const steps: ParsedStep[] = parseWorkflowSteps(texts[wf]);
        const graph: StoryLoopGraph = deriveStoryLoopProducers(steps);
        const behavior = behaviors.agents[`${wf}_${graph.producers[0].agent}`];
        const runId = `run-${wf}`;
        insertRun.run(runId, 1, wf, `task for ${wf}`, now, now);
        assert.doesNotThrow(() => parseAndInsertStories(behavior.output, runId), `${wf} producer output parses`);
        const rows = db
          .prepare("SELECT story_id, status FROM stories WHERE run_id = ? ORDER BY story_index")
          .all(runId) as Array<{ story_id: string; status: string }>;
        assert.equal(rows.length, SCRIPTED_STORY_COUNT, `${wf} inserted ${SCRIPTED_STORY_COUNT} stories`);
        assert.deepEqual(rows.map((r) => r.story_id), ["US-001", "US-002"], `${wf} inserted the plan story ids`);
        for (const r of rows) assert.equal(r.status, "pending", `${wf} story ${r.story_id} starts pending`);
      }
    } finally {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.TAMANDUA_STATE_DIR === undefined) delete process.env.TAMANDUA_STATE_DIR; else process.env.TAMANDUA_STATE_DIR = prev.TAMANDUA_STATE_DIR;
      if (prev.TAMANDUA_DB_PATH === undefined) delete process.env.TAMANDUA_DB_PATH; else process.env.TAMANDUA_DB_PATH = prev.TAMANDUA_DB_PATH;
      if (prev.TAMANDUA_CONTROL_PORT === undefined) delete process.env.TAMANDUA_CONTROL_PORT; else process.env.TAMANDUA_CONTROL_PORT = prev.TAMANDUA_CONTROL_PORT;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
