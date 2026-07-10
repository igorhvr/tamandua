/**
 * Comprehensive tests for the AutoResearch wizard feature.
 *
 * Covers: wizard-types, wizard-prompt, and CLI --help integration.
 * Individual module tests are in wizard-commands.test.ts,
 * wizard-evaluator.test.ts, and wizard-orchestrator.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type {
  WizardTranscriptEntry,
  WizardEvaluatorInput,
  WizardEvaluatorNotReady,
  WizardEvaluatorReady,
} from "../../dist/cli/wizard-types.js";
import { buildEvaluatorPrompt } from "../../dist/cli/wizard-prompt.js";
import { cleanChildEnv, createTempHome } from "../../tests/helpers/test-env.ts";

describe("wizard-types", () => {
  it("exports WizardEvaluatorInput type", () => {
    const input: WizardEvaluatorInput = {
      cwd: "/test",
      initialized: false,
      transcript: [],
    };
    assert.equal(input.cwd, "/test");
    assert.equal(input.initialized, false);
    assert.deepEqual(input.transcript, []);
  });

  it("exports WizardEvaluatorNotReady type", () => {
    const notReady: WizardEvaluatorNotReady = {
      ready: false,
      question: "What is the benchmark command?",
      reason: "Missing benchmark command",
    };
    assert.equal(notReady.ready, false);
    assert.ok(notReady.question.length > 0);
    assert.ok(notReady.reason.length > 0);
  });

  it("exports WizardEvaluatorReady type", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "All flags map cleanly.",
      needsInit: false,
      initArgv: null,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    assert.equal(ready.ready, true);
    assert.equal(ready.needsInit, false);
    assert.equal(ready.initArgv, null);
    assert.deepEqual(ready.loopArgv, ["autoresearch", "loop", "--prompt"]);
  });

  it("supports needsInit: true with initArgv", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "Session not yet initialized.",
      needsInit: true,
      initArgv: [
        "autoresearch",
        "init",
        "--goal",
        "reduce build time",
        "--metric",
        "compile_seconds",
        "--direction",
        "lower",
        "--command",
        "./autoresearch.sh",
      ],
      loopArgv: ["autoresearch", "loop", "--prompt", "--max-iterations", "25"],
    };
    assert.equal(ready.ready, true);
    assert.equal(ready.needsInit, true);
    assert.ok(Array.isArray(ready.initArgv));
    assert.ok(ready.initArgv!.length > 0);
  });
});

describe("buildEvaluatorPrompt", () => {
  it("includes cwd", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/home/user/project",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes("/home/user/project"),
      "prompt should include cwd",
    );
  });

  it("includes init status — not initialized", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/home/user/project",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes("NOT initialized"),
      "prompt should indicate not initialized",
    );
  });

  it("includes init status — initialized with config summary", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/home/user/project",
      initialized: true,
      configSummary: "goal: reduce build time, metric: compile_seconds",
      transcript: [],
    });
    assert.ok(
      prompt.includes("IS initialized"),
      "prompt should indicate initialized",
    );
    assert.ok(
      prompt.includes("reduce build time"),
      "prompt should include config summary",
    );
  });

  it('includes "(transcript is empty — this is the first question)" for empty transcript', () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes("transcript is empty"),
      "prompt should note empty transcript",
    );
  });

  it("includes transcript entries", () => {
    const transcript: WizardTranscriptEntry[] = [
      { role: "user", text: "I want to speed up my test suite." },
      {
        role: "assistant",
        text: "What command runs your test suite?",
      },
    ];
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript,
    });
    assert.ok(
      prompt.includes("speed up my test suite"),
      "prompt should include user text",
    );
    assert.ok(
      prompt.includes("runs your test suite"),
      "prompt should include assistant text",
    );
    assert.ok(
      prompt.match(/USER:/),
      "prompt should label user entries",
    );
    assert.ok(
      prompt.match(/WIZARD:/),
      "prompt should label wizard entries",
    );
  });

  it("includes the two JSON schemas (not-ready and ready)", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes('"ready": false'),
      "prompt should include not-ready schema",
    );
    assert.ok(
      prompt.includes('"question":'),
      "prompt should include question field",
    );
    assert.ok(
      prompt.includes('"reason":'),
      "prompt should include reason field",
    );
    assert.ok(
      prompt.includes('"ready": true'),
      "prompt should include ready schema",
    );
    assert.ok(
      prompt.includes('"commentary":'),
      "prompt should include commentary field",
    );
    assert.ok(
      prompt.includes('"needsInit":'),
      "prompt should include needsInit field",
    );
    assert.ok(
      prompt.includes('"initArgv":'),
      "prompt should include initArgv field",
    );
    assert.ok(
      prompt.includes('"loopArgv":'),
      "prompt should include loopArgv field",
    );
  });

  it("includes instructions for raw JSON with tolerance for single ```json fence", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes("Return ONLY the JSON object"),
      "prompt should instruct to return only JSON",
    );
    assert.ok(
      prompt.includes("Prefer raw JSON"),
      "prompt should prefer raw JSON",
    );
    assert.ok(
      prompt.includes("```json"),
      "prompt should tolerate fenced JSON",
    );
    assert.ok(
      prompt.includes("Do not include any other text"),
      "prompt should forbid other text",
    );
  });

  it("lists all allowed init flags", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    const expectedInitFlags = [
      "--goal",
      "--metric",
      "--unit",
      "--direction",
      "--command",
      "--metric-regex",
      "--checks-command",
      "--cwd",
      "--overwrite",
    ];
    for (const flag of expectedInitFlags) {
      assert.ok(
        prompt.includes(flag),
        `prompt should include init flag: ${flag}`,
      );
    }
  });

  it("lists all allowed loop flags", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    const expectedLoopFlags = [
      "--target-metric",
      "--max-iterations",
      "--max-consecutive-failures",
      "--timeout",
      "--cwd",
    ];
    for (const flag of expectedLoopFlags) {
      assert.ok(
        prompt.includes(flag),
        `prompt should include loop flag: ${flag}`,
      );
    }
  });

  it("includes --prompt is a flag (takes NO value) warning", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes("--prompt is a flag"),
      "prompt should warn that --prompt is a flag",
    );
    assert.ok(
      prompt.includes("takes NO value"),
      "prompt should say --prompt takes no value",
    );
  });

  it("includes allowed init argv header", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes('["autoresearch", "init"]'),
      "prompt should mention init argv must start with autoresearch init",
    );
  });

  it("includes allowed loop argv header", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    assert.ok(
      prompt.includes('["autoresearch", "loop", "--prompt"]'),
      "prompt should mention loop argv must start with autoresearch loop --prompt",
    );
  });

  it("handles initialized:true with empty configSummary gracefully", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: true,
      configSummary: "",
      transcript: [],
    });
    assert.ok(
      prompt.includes("IS initialized"),
      "prompt should indicate initialized",
    );
  });

  it("handles initialized:true without configSummary (undefined)", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: true,
      transcript: [],
    });
    assert.ok(
      prompt.includes("IS initialized"),
      "prompt should indicate initialized",
    );
    assert.ok(
      prompt.includes("config summary not available") ||
        prompt.includes("Current config:"),
      "prompt should handle missing config summary",
    );
  });

  it("handles long transcript with many entries", () => {
    const transcript: WizardTranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      transcript.push({
        role: "user",
        text: `User message number ${i + 1} with some detail about what they want to optimize.`,
      });
      transcript.push({
        role: "assistant",
        text: `Wizard follow-up question number ${i + 1} to clarify requirements.`,
      });
    }
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript,
    });
    assert.ok(
      prompt.includes("USER:"),
      "prompt should have user labels",
    );
    assert.ok(
      prompt.includes("WIZARD:"),
      "prompt should have wizard labels",
    );
    assert.ok(prompt.includes("User message number 1"));
    assert.ok(prompt.includes("User message number 10"));
    assert.ok(prompt.includes("Wizard follow-up question number 1"));
    assert.ok(prompt.includes("Wizard follow-up question number 10"));
  });

  it("does NOT include loop-only flags in init flag listing", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    const initSection = prompt.substring(
      prompt.indexOf("ALLOWED INIT ARGV FLAGS"),
      prompt.indexOf("ALLOWED LOOP ARGV FLAGS"),
    );
    assert.ok(
      !initSection.includes("--max-iterations"),
      "--max-iterations should not be in init flags section",
    );
  });

  it("does NOT include init-only flags in loop flag listing", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });
    const loopSection = prompt.substring(
      prompt.indexOf("ALLOWED LOOP ARGV FLAGS"),
    );
    assert.ok(
      !loopSection.includes("--goal"),
      "--goal should not be in loop flags section",
    );
  });

  it("documents --target-metric as numeric and warns against passing metric names", () => {
    const prompt = buildEvaluatorPrompt({
      cwd: "/test",
      initialized: false,
      transcript: [],
    });

    // Regression: --target-metric should be documented as taking a number, not a metric name
    const loopSection = prompt.substring(
      prompt.indexOf("ALLOWED LOOP ARGV FLAGS"),
    );

    // Should document that --target-metric takes a numeric value
    assert.ok(
      loopSection.includes("--target-metric <number>"),
      "--target-metric should be documented as accepting a number",
    );

    // Should explicitly warn against passing the metric name
    assert.ok(
      loopSection.includes("NEVER pass the metric name here"),
      "should warn not to pass metric name to --target-metric",
    );

    // Should document it as OPTIONAL
    assert.ok(
      loopSection.includes("OPTIONAL"),
      "--target-metric should be documented as OPTIONAL",
    );

    // CRITICAL instruction should exist in the prompt body
    assert.ok(
      prompt.includes("--target-metric takes a number, never a name"),
      "prompt should have critical instruction about --target-metric",
    );

    assert.ok(
      prompt.includes("The metric name (e.g.") && prompt.includes("is configured in initArgv --metric"),
      "prompt should clarify that metric name goes in initArgv --metric",
    );
  });
});

// ── CLI --help integration test ───────────────────────────────────

describe("tamandua autoresearch wizard --help", () => {
  function cli(args: string[], envOverrides?: Record<string, string>) {
    const wrapperPath = path.resolve("bin/tamandua");
    const th = createTempHome("wizard-help-test-");
    return spawnSync("/bin/sh", [wrapperPath, ...args], {
      encoding: "utf8",
      env: cleanChildEnv({
        HOME: th.homeDir,
        TAMANDUA_STATE_DIR: th.tamanduaDir,
        ...envOverrides,
      }),
    });
  }

  it("prints help and exits 0", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    assert.equal(result.status, 0, `exit code ${result.status}`);
    assert.ok(
      result.stdout && result.stdout.length > 0,
      "help should produce stdout",
    );
  });

  it("output contains wizard title", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    assert.match(
      result.stdout ?? "",
      /autoresearch wizard/,
    );
    assert.match(
      result.stdout ?? "",
      /Interactive.*AutoResearch.*setup wizard/i,
    );
  });

  it("output describes the wizard's purpose", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    assert.match(
      result.stdout ?? "",
      /guides you through setting up/,
    );
    // Help text may wrap at terminal width. Check words separately.
    assert.match(
      result.stdout ?? "",
      /what you want to/,
    );
    assert.match(
      result.stdout ?? "",
      /how to measure success/,
    );
  });

  it("output mentions init and loop commands", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    // Help text may wrap at terminal width — use multiline regex.
    assert.match(
      result.stdout ?? "",
      /autoresearch\s+init/,
    );
    assert.match(
      result.stdout ?? "",
      /autoresearch\s+loop/,
    );
  });

  it("output states wizard does not directly create files", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    assert.match(
      result.stdout ?? "",
      /does not directly create.*files/i,
    );
  });

  it("output includes --cwd option", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    assert.match(
      result.stdout ?? "",
      /--cwd/,
    );
  });

  it("output includes usage examples", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    assert.match(
      result.stdout ?? "",
      /Examples:/,
    );
    assert.match(
      result.stdout ?? "",
      /tamandua autoresearch wizard/,
    );
  });

  it("--help suppresses update warning on stderr", () => {
    const result = cli(["autoresearch", "wizard", "--help"]);
    assert.doesNotMatch(
      result.stderr ?? "",
      /WARNING: A new version/,
    );
  });

  it("--help works even when --cwd flag is also present", () => {
    const result = cli(["autoresearch", "wizard", "--help", "--cwd", "/tmp"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /autoresearch wizard/);
  });

  it("wizard appears in autoresearch subcommand help listing", () => {
    const result = cli(["autoresearch", "--help"]);
    assert.match(
      result.stdout ?? "",
      /wizard/,
    );
    assert.match(
      result.stdout ?? "",
      /Interactive.*setup/i,
    );
  });

  it("wizard appears in global usage text", () => {
    const result = cli(["--help"]);
    assert.match(
      result.stdout ?? "",
      /tamandua autoresearch wizard/,
    );
  });
});
