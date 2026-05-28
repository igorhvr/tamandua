import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "cli", "cli.js");
import {
  calculateAutoresearchConfidence,
  commitAutoresearchResult,
  decideStatus,
  hasDirtyNonAutoresearchFiles,
  initExperiment,
  logExperiment,
  loopAutoresearch,
  parseAgentFields,
  parseMetric,
  readAutoresearchLog,
  runExperiment,
  summarizeAutoresearch,
  runLoopIteration,
} from "../../dist/autoresearch/autoresearch.js";
import { parsePiOutputStream } from "../../dist/installer/pi-stream-parser.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-autoresearch-"));
}

function nodeMetricCommand(metricName: string, value: number): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log("${metricName}: ${value}")`)}`;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function confidenceRun(
  run: number,
  status: "baseline" | "keep" | "discard" | "crash" | "checks_failed",
  metric: number | null,
  direction: "lower" | "higher" = "lower",
) {
  return {
    type: "run" as const,
    run,
    created_at: `2026-01-01T00:0${run}:00.000Z`,
    status,
    metric,
    metric_name: "score",
    direction,
    description: `run ${run}`,
    baseline_metric: run === 1 ? metric : 10,
    best_metric: metric,
    improvement_ratio: null,
    confidence_score: null,
    confidence_band: "unknown" as const,
    noise_floor_mad: null,
    confidence_sample_count: 0,
  };
}

describe("autoresearch confidence", () => {
  it("returns unknown for fewer than 3 numeric metrics", () => {
    const confidence = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "keep", 9),
    ]);

    assert.equal(confidence.confidence_score, null);
    assert.equal(confidence.confidence_band, "unknown");
    assert.equal(confidence.confidence_sample_count, 2);
  });

  it("scores lower-is-better and higher-is-better improvements", () => {
    const lower = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "discard", 11),
      confidenceRun(3, "keep", 8),
    ], "lower");
    assert.equal(lower.confidence_score, 2);
    assert.equal(lower.confidence_band, "high");

    const higher = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 0.7, "higher"),
      confidenceRun(2, "discard", 0.6, "higher"),
      confidenceRun(3, "keep", 0.8, "higher"),
    ], "higher");
    assert.ok(Math.abs((higher.confidence_score ?? 0) - 1) < 1e-12);
    assert.equal(higher.confidence_band, "medium");
  });

  it("treats the first numeric experiment as baseline for pi-style logs", () => {
    const confidence = calculateAutoresearchConfidence([
      confidenceRun(1, "keep", 10),
      confidenceRun(2, "discard", 11),
      confidenceRun(3, "keep", 8),
    ]);

    assert.equal(confidence.confidence_score, 2);
    assert.equal(confidence.confidence_band, "high");
  });

  it("produces low, medium, and high bands from noisy metrics", () => {
    const low = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "discard", 12),
      confidenceRun(3, "discard", 13),
      confidenceRun(4, "keep", 9.5),
    ]);
    assert.equal(low.confidence_band, "low");

    const medium = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "discard", 12),
      confidenceRun(3, "discard", 13),
      confidenceRun(4, "keep", 8.5),
    ]);
    assert.equal(medium.confidence_band, "medium");

    const high = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "discard", 12),
      confidenceRun(3, "discard", 13),
      confidenceRun(4, "keep", 7),
    ]);
    assert.equal(high.confidence_band, "high");
  });

  it("uses positive numeric metrics and ignores null or zero crash metrics", () => {
    const confidence = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "crash", 0),
      confidenceRun(3, "checks_failed", 11),
      confidenceRun(4, "discard", null),
      confidenceRun(5, "discard", 12),
      confidenceRun(6, "keep", 8.5),
    ]);

    assert.equal(confidence.confidence_sample_count, 4);
    assert.equal(confidence.confidence_band, "medium");
  });

  it("handles zero MAD with zero and nonzero improvements", () => {
    const unchanged = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "discard", 10),
      confidenceRun(3, "keep", 10),
    ]);
    assert.equal(unchanged.confidence_score, null);
    assert.equal(unchanged.confidence_band, "unknown");
    assert.equal(unchanged.noise_floor_mad, null);

    const improved = calculateAutoresearchConfidence([
      confidenceRun(1, "baseline", 10),
      confidenceRun(2, "discard", 10),
      confidenceRun(3, "keep", 9),
      confidenceRun(4, "discard", 10),
      confidenceRun(5, "discard", 10),
    ]);
    assert.equal(improved.confidence_score, null);
    assert.equal(improved.confidence_band, "unknown");
    assert.equal(improved.noise_floor_mad, 0);
  });
});

describe("autoresearch state model", () => {
  it("initializes durable session files", () => {
    const cwd = makeTempDir();

    const entry = initExperiment({
      cwd,
      goal: "reduce validation loss",
      metricName: "val_bpb",
      metricUnit: "bpb",
      direction: "lower",
      command: nodeMetricCommand("val_bpb", 1.5),
    });

    assert.equal(entry.type, "session");
    assert.equal(entry.metric_name, "val_bpb");
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.config.json")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.md")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.sh")));
    assert.match(fs.readFileSync(path.join(cwd, "autoresearch.md"), "utf-8"), /ratchet/i);
  });

  it("runs experiments, parses metrics, and logs baseline then discard", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce validation loss",
      metricName: "val_bpb",
      direction: "lower",
      command: nodeMetricCommand("val_bpb", 1.5),
    });

    const firstResult = await runExperiment({ cwd });
    assert.equal(firstResult.run, 1);
    assert.equal(firstResult.status, "measured");
    assert.equal(firstResult.metric, 1.5);

    const firstLog = await logExperiment({
      cwd,
      status: "auto",
      description: "baseline run",
      hypothesis: "measure starting point",
      learned: "baseline is stable",
      nextFocus: "try a lower value",
    });
    assert.equal(firstLog.status, "baseline");
    assert.equal(firstLog.best_metric, 1.5);

    const secondResult = await runExperiment({ cwd, command: nodeMetricCommand("val_bpb", 1.7) });
    assert.equal(secondResult.run, 2);
    assert.equal(secondResult.metric, 1.7);

    const secondLog = await logExperiment({
      cwd,
      status: "auto",
      description: "regression run",
      learned: "metric got worse",
      nextFocus: "undo and test a narrower change",
    });
    assert.equal(secondLog.status, "discard");
    assert.equal(secondLog.best_metric, 1.5);

    const summary = summarizeAutoresearch(cwd);
    assert.equal(summary.totalRuns, 2);
    assert.equal(summary.keptRuns, 1);
    assert.equal(summary.discardedRuns, 1);
    assert.equal(summary.bestMetric, 1.5);
    assert.match(summary.nextPrompt, /metric got worse/);

    const entries = readAutoresearchLog(cwd);
    assert.equal(entries.filter((entry) => entry.type === "run").length, 2);
    assert.equal(entries.filter((entry) => entry.type === "run_result").length, 2);
  });

  it("persists confidence fields on logged experiments", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce validation loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 10),
    });

    await logExperiment({ cwd, status: "baseline", metric: 10, description: "baseline" });
    await logExperiment({ cwd, status: "discard", metric: 11, description: "noisy regression" });
    const third = await logExperiment({ cwd, status: "keep", metric: 8, description: "improvement" });

    assert.equal(third.confidence_band, "high");
    assert.equal(third.confidence_score, 2);
    assert.equal(third.noise_floor_mad, 1);
    assert.equal(third.confidence_sample_count, 3);

    const loggedRuns = readAutoresearchLog(cwd).filter((entry): entry is Awaited<ReturnType<typeof logExperiment>> => entry.type === "run");
    assert.equal(loggedRuns.at(-1)?.confidence_band, "high");
    assert.equal(loggedRuns.at(-1)?.confidence_score, 2);
  });

  it("summarizes confidence from old logs without stored confidence fields", () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce validation loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 10),
    });

    const logPath = path.join(cwd, "autoresearch.jsonl");
    const session = fs.readFileSync(logPath, "utf-8").trim();
    fs.writeFileSync(logPath, [
      session,
      JSON.stringify({
        type: "run", run: 1, created_at: "2026-01-01T00:00:00.000Z",
        status: "baseline", metric: 10, metric_name: "loss", direction: "lower",
        description: "baseline", baseline_metric: 10, best_metric: 10, improvement_ratio: null,
      }),
      JSON.stringify({
        type: "run", run: 2, created_at: "2026-01-01T00:01:00.000Z",
        status: "discard", metric: 11, metric_name: "loss", direction: "lower",
        description: "noise", baseline_metric: 10, best_metric: 10, improvement_ratio: null,
      }),
      JSON.stringify({
        type: "run", run: 3, created_at: "2026-01-01T00:02:00.000Z",
        status: "keep", metric: 8, metric_name: "loss", direction: "lower",
        description: "better", baseline_metric: 10, best_metric: 8, improvement_ratio: null,
      }),
    ].join("\n") + "\n");

    const summary = summarizeAutoresearch(cwd);
    assert.equal(summary.confidence_band, "high");
    assert.equal(summary.confidence_score, 2);
    assert.equal(summary.noise_floor_mad, 1);
    assert.equal(summary.confidence_sample_count, 3);
    assert.match(summary.nextPrompt, /Confidence: high/);
  });

  it("classifies improvements according to direction", () => {
    const entries = [
      { type: "session", created_at: "2026-01-01T00:00:00.000Z", goal: "increase auc", metric_name: "auc", direction: "higher", command: "echo auc: 0.7" },
      {
        type: "run",
        run: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        status: "baseline",
        metric: 0.7,
        metric_name: "auc",
        direction: "higher",
        description: "baseline",
        baseline_metric: 0.7,
        best_metric: 0.7,
        improvement_ratio: 1,
      },
    ] as const;

    assert.equal(decideStatus([...entries], 0.8, "measured"), "keep");
    assert.equal(decideStatus([...entries], 0.6, "measured"), "discard");
    assert.equal(decideStatus([...entries], null, "crash"), "crash");
  });

  it("marks successful benchmarks as checks_failed when checks fail", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "keep correctness",
      metricName: "total_ms",
      direction: "lower",
      command: nodeMetricCommand("total_ms", 42),
      checksCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(2)")}`,
    });

    const result = await runExperiment({ cwd });

    assert.equal(result.status, "checks_failed");
    assert.equal(result.metric, 42);
    assert.equal(result.checks?.exit_code, 2);
  });

  it("reverts tracked and untracked experiment files while preserving autoresearch state", async () => {
    const cwd = makeTempDir();
    git(cwd, ["init", "--initial-branch=main"]);
    git(cwd, ["config", "user.email", "test@tamandua.local"]);
    git(cwd, ["config", "user.name", "Tamandua Test"]);
    fs.writeFileSync(path.join(cwd, "model.py"), "BASELINE\n");
    git(cwd, ["add", "model.py"]);
    git(cwd, ["commit", "-m", "baseline"]);

    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 1),
    });
    fs.writeFileSync(path.join(cwd, "model.py"), "EXPERIMENT\n");
    fs.writeFileSync(path.join(cwd, "scratch.txt"), "temporary\n");

    await logExperiment({
      cwd,
      status: "discard",
      metric: 2,
      description: "discard regression",
      revertDiscard: true,
    });

    assert.equal(fs.readFileSync(path.join(cwd, "model.py"), "utf-8"), "BASELINE\n");
    assert.equal(fs.existsSync(path.join(cwd, "scratch.txt")), false);
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));
  });

  it("parses metric regex capture group before generic metric names", () => {
    assert.equal(parseMetric("loss=1.2\ncustom=9.8", "loss", "custom=([0-9.]+)"), 9.8);
    assert.equal(parseMetric("val_bpb: 1.234", "val_bpb"), 1.234);
    assert.equal(parseMetric("no metric here", "val_bpb"), null);
  });
});

describe("autoresearch loop", () => {
  function dirtyGitInit(cwd: string): void {
    git(cwd, ["init", "--initial-branch=main"]);
    git(cwd, ["config", "user.email", "test@tamandua.local"]);
    git(cwd, ["config", "user.name", "Tamandua Test"]);
  }

  it("rejects loopAutoresearch without actionMode", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    await assert.rejects(
      loopAutoresearch({ cwd, maxIterations: 1 }),
      /No action mode specified/,
    );
  });

  it("runs measure-only loop and labels iterations", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    const result = await loopAutoresearch({
      cwd,
      maxIterations: 2,
      actionMode: "measure-only",
    });

    assert.equal(result.iterations, 2);
    assert.equal(result.bestMetric, 5);
    assert.ok(result.stopReason?.includes("Max iterations"));

    const summary = summarizeAutoresearch(cwd);
    assert.equal(summary.totalRuns, 2);
  });

  it("displays historical best distinctly from loop best", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    // Create a prior session with a historical best of 3.0
    const priorDir = makeTempDir();
    initExperiment({
      cwd: priorDir,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 3),
    });
    const priorResult = await runExperiment({ cwd: priorDir });
    await logExperiment({
      cwd: priorDir,
      status: "auto",
      description: "prior best run",
    });

    // Copy the prior log to the current dir so there is history
    fs.copyFileSync(
      path.join(priorDir, "autoresearch.jsonl"),
      path.join(cwd, "autoresearch.jsonl"),
    );

    const result = await loopAutoresearch({
      cwd,
      maxIterations: 1,
      actionMode: "measure-only",
    });

    // New loop measured 5, so loop best is 5
    assert.equal(result.bestMetric, 5);
    // But all-time best from prior session (3) should still be reported
    // The allTimeBestMetric should reflect the prior best if the combined log shows it
    // Note: copying the log doesn't change the config's knowledge of history,
    // but loopAutoresearch reads from the actual log file on each iteration.
    // On the second iteration, the log has both prior best (3) and new run (5).
    // The initial summary should show bestMetric=3 from prior session.
    // Since result.allTimeBestMetric is set from initialSummary, it should be 3.
    assert.equal(result.allTimeBestMetric, 3);
  });

  it("accepts --prompt mode and invokes agent between iterations", async () => {
    const cwd = makeTempDir();
    // Create a fake pi that responds with STATUS: done immediately
    const fakePi = path.join(cwd, "pi");
    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `console.log(JSON.stringify({ type: "session", version: 1 }));`,
      `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STATUS: done\\nCHANGES: test change\\nHYPOTHESIS: test hypothesis\\nLEARNED: test learned\\nNEXT_FOCUS: more tests" }] } }));`,
      `console.log(JSON.stringify({ type: "agent_end" }));`,
      `process.exit(0);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${cwd}${path.delimiter}${origPath}`;

    try {
      initExperiment({
        cwd,
        goal: "reduce loss",
        metricName: "loss",
        direction: "lower",
        command: nodeMetricCommand("loss", 5),
      });

      const result = await loopAutoresearch({
        cwd,
        maxIterations: 1,
        actionMode: "prompt",
      });

      // The fake pi responded with STATUS: done, so the loop should complete
      assert.ok(result.stopReason !== null);
      assert.equal(result.iterations, 1);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("invokes pi with correct args (--print, --no-session, --mode json, no --cwd/--message/--no-tui)", async () => {
    // Create a fake pi script (Node.js) that records the received arguments
    const cwd = makeTempDir();
    const recordFile = path.join(cwd, "pi-args.json");
    const fakePi = path.join(cwd, "fake-pi");

    // Build a realistic assistant message_end JSONL response
    const messageEnd = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "STATUS: done\nCHANGES: fixed the thing\nHYPOTHESIS: it should work\nLEARNED: coding is fun\nNEXT_FOCUS: more tests" },
        ],
      },
    });

    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `const fs = require("node:fs");`,
      `const recordFile = ${JSON.stringify(recordFile)};`,
      `fs.writeFileSync(recordFile, JSON.stringify(process.argv.slice(1)));`,
      `console.log(${JSON.stringify(JSON.stringify({ type: "session", version: 1 }))});`,
      `console.log(${JSON.stringify(messageEnd)});`,
      `console.log(${JSON.stringify(JSON.stringify({ type: "agent_end" }))});`,
      `process.exit(0);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    // We can't directly call runPiAgent (it's not exported and it spawns "pi").
    // Instead, verify by spawning fake-pi directly with the expected args + spawn cwd option.
    const child = spawnSync(fakePi, ["--print", "--no-session", "--mode", "json", "test prompt"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    assert.equal(child.status, 0);
    const recorded = JSON.parse(fs.readFileSync(recordFile, "utf-8"));
    assert.ok(Array.isArray(recorded));

    // Verify the supported flags are present and unsupported ones are absent
    assert.ok(recorded.includes("--print"), `expected --print in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--no-session"), `expected --no-session in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--mode"), `expected --mode in args: ${JSON.stringify(recorded)}`);
    const modeIdx = recorded.indexOf("--mode");
    assert.equal(recorded[modeIdx + 1], "json", `expected --mode json in args: ${JSON.stringify(recorded)}`);

    // Verify unsupported flags are NOT present
    assert.ok(!recorded.includes("--no-tui"), `--no-tui should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--cwd"), `--cwd should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--message"), `--message should NOT be in args: ${JSON.stringify(recorded)}`);

    // Verify the prompt is passed positionally
    assert.ok(recorded.includes("test prompt"), `expected prompt in args: ${JSON.stringify(recorded)}`);
  });

  it("closes pi stdin so pi does not hang waiting for input (regression test for stdin-left-open bug)", async () => {
    // Regression test: the runPiAgent function previously spawned pi with
    // stdio: ["pipe","pipe","pipe"] and never wrote to or closed stdin.
    // pi in --print mode waits for stdin EOF before processing argv, so
    // it would hang until the 300s timeout. The fix uses ["ignore","pipe","pipe"].
    const cwd = makeTempDir();
    const recordFile = path.join(cwd, "pi-args.json");
    const fakePiPath = path.join(cwd, "pi");

    // Fake pi that waits for stdin EOF, writes JSONL output, and records argv.
    // With stdin ignored/closed, process.stdin emits "end" immediately and the
    // output is produced. With stdin left open (the bug), it hangs forever.
    const messageEnd = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "STATUS: done\\nCHANGES: stdin correctly ignored\\nHYPOTHESIS: ignore stdin for prompt mode\\nLEARNED: pi waits for stdin EOF\\nNEXT_FOCUS: none" }],
      },
    });
    fs.writeFileSync(fakePiPath, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `const fs = require("node:fs");`,
      `const recordFile = ${JSON.stringify(recordFile)};`,
      `fs.writeFileSync(recordFile, JSON.stringify(process.argv.slice(1)));`,
      `process.stdin.resume();`,
      `process.stdin.on("end", () => {`,
      `  console.log(${JSON.stringify(JSON.stringify({ type: "session", version: 1 }))});`,
      `  console.log(${JSON.stringify(messageEnd)});`,
      `  console.log(${JSON.stringify(JSON.stringify({ type: "agent_end" }))});`,
      `  process.exit(0);`,
      `});`,
    ].join("\n"));
    fs.chmodSync(fakePiPath, 0o755);

    // Spawn with the fix: stdio: ["ignore", "pipe", "pipe"]
    const child = spawnSync(fakePiPath, ["--print", "--no-session", "--mode", "json", "test prompt"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000, // 10s safety net — should complete in <1s
    });

    assert.equal(child.status, 0, `fake pi exited ${child.status}: ${child.stderr}`);
    assert.ok(child.stdout.includes("STATUS: done"), `expected STATUS in stdout: ${child.stdout}`);

    // Verify argv correctness (same checks as the existing argv test)
    const recorded = JSON.parse(fs.readFileSync(recordFile, "utf-8"));
    assert.ok(recorded.includes("--print"), `expected --print in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--no-session"), `expected --no-session in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--mode"), `expected --mode in args: ${JSON.stringify(recorded)}`);
    const modeIdx = recorded.indexOf("--mode");
    assert.equal(recorded[modeIdx + 1], "json", `expected --mode json in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--no-tui"), `--no-tui should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--cwd"), `--cwd should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--message"), `--message should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("test prompt"), `expected prompt in args: ${JSON.stringify(recorded)}`);
  });

  it("loopAutoresearch --prompt refuses to start with dirty non-autoresearch files", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    // Make a non-autoresearch file dirty
    fs.writeFileSync(path.join(cwd, "app.ts"), "dirty");

    await assert.rejects(
      loopAutoresearch({ cwd, maxIterations: 1, actionMode: "prompt" }),
      /Working tree has dirty non-autoresearch files/,
    );
  });

  it("loopAutoresearch --prompt does NOT refuse when only autoresearch files are dirty", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    // Only autoresearch files are dirty (initExperiment already created valid jsonl)
    fs.appendFileSync(path.join(cwd, "autoresearch.md"), "# test");

    // Should not throw — autoresearch files are protected
    const result = await loopAutoresearch({
      cwd,
      maxIterations: 1,
      actionMode: "measure-only",
    });
    assert.equal(result.iterations, 1);
  });

  it("loopAutoresearch --measure-only refuses to start with dirty non-autoresearch files", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    // Make a non-autoresearch file dirty
    fs.writeFileSync(path.join(cwd, "app.ts"), "dirty");

    await assert.rejects(
      loopAutoresearch({ cwd, maxIterations: 1, actionMode: "measure-only" }),
      /Working tree has dirty non-autoresearch files/,
    );
  });

  it("each measure-only iteration leaves working tree clean", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    const result = await loopAutoresearch({
      cwd,
      maxIterations: 3,
      actionMode: "measure-only",
    });

    assert.equal(result.iterations, 3);
    // After the loop, the tree must have no dirty non-autoresearch files
    const dirtyAfter = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirtyAfter.dirty, false);
  });

  it("loopAutoresearch --prompt does NOT refuse when only autoresearch files are dirty (prompt mode)", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Fake pi in a separate directory (outside the repo) so it does not dirty the working tree
    const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
    const fakePi = path.join(piDir, "pi");
    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `console.log(JSON.stringify({ type: "session", version: 1 }));`,
      `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STATUS: done\\nCHANGES: test change\\nHYPOTHESIS: test hypothesis\\nLEARNED: test learned\\nNEXT_FOCUS: more tests" }] } }));`,
      `console.log(JSON.stringify({ type: "agent_end" }));`,
      `process.exit(0);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${piDir}${path.delimiter}${origPath}`;

    try {
      initExperiment({
        cwd,
        goal: "reduce loss",
        metricName: "loss",
        direction: "lower",
        command: nodeMetricCommand("loss", 5),
      });

      // Only autoresearch files are dirty (initExperiment already created valid jsonl)
      fs.appendFileSync(path.join(cwd, "autoresearch.md"), "# test");

      // Should not throw — autoresearch files are protected, even in prompt mode
      const result = await loopAutoresearch({
        cwd,
        maxIterations: 1,
        actionMode: "prompt",
      });

      assert.equal(result.iterations, 1);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("autoresearch.jsonl survives full measure-only loop and is never committed", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    const jsonlPath = path.join(cwd, "autoresearch.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "autoresearch.jsonl should exist after init");
    const initialSize = fs.statSync(jsonlPath).size;
    assert.ok(initialSize > 0, "autoresearch.jsonl should have config header");

    const result = await loopAutoresearch({
      cwd,
      maxIterations: 3,
      actionMode: "measure-only",
    });

    assert.equal(result.iterations, 3);

    // autoresearch.jsonl exists and grew (has new entries)
    assert.ok(fs.existsSync(jsonlPath), "autoresearch.jsonl should survive the loop");
    const finalSize = fs.statSync(jsonlPath).size;
    assert.ok(finalSize > initialSize, "autoresearch.jsonl should have grown across iterations");

    // autoresearch.jsonl is not staged
    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf-8" });
    assert.equal(staged.status, 0);
    assert.ok(!staged.stdout.includes("autoresearch.jsonl"), "autoresearch.jsonl should not be staged");

    // No commit contains autoresearch.jsonl (grep over git log for safety)
    const logResult = spawnSync("git", ["log", "--oneline", "--name-only"], { cwd, encoding: "utf-8" });
    assert.equal(logResult.status, 0);
    // Split by commit markers: lines starting with a hex hash
    const logLines = logResult.stdout.trim().split(/\r?\n/).filter(Boolean);
    let currentSha = "";
    for (const line of logLines) {
      // Commit hash lines start with hex chars and a space
      if (/^[0-9a-f]{7,}/.test(line)) {
        currentSha = line.split(" ")[0];
      } else if (currentSha && line === "autoresearch.jsonl") {
        assert.fail(`commit ${currentSha} includes autoresearch.jsonl`);
      }
    }

    // Working tree clean after loop
    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });
});

describe("pi JSONL stream parsing in autoresearch context", () => {
  it("parses assistant text from a realistic message_end event via parsePiOutputStream", async () => {
    const lines = [
      JSON.stringify({ type: "session", version: 1 }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_start", message: { role: "user" } }),
      // message_update events (should be discarded by parser)
      JSON.stringify({ type: "message_update", message: { content: [{ type: "text_delta", text: "partial" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
        { type: "thinking", thinking: "let me think..." },
        { type: "text", text: "STATUS: done\nCHANGES: fixed pi invocation\nHYPOTHESIS: using JSON mode correctly\nLEARNED: parsePiOutputStream works\nNEXT_FOCUS: add timeout option" },
      ] } }),
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "agent_end" }),
    ];

    const result = await parsePiOutputStream(lines);

    assert.ok(result.assistantText.length > 0, "expected non-empty assistantText");
    assert.match(result.assistantText, /STATUS: done/);
    assert.match(result.assistantText, /CHANGES: fixed pi invocation/);
    assert.match(result.assistantText, /HYPOTHESIS: using JSON mode correctly/);
    assert.match(result.assistantText, /LEARNED: parsePiOutputStream works/);
    assert.match(result.assistantText, /NEXT_FOCUS: add timeout option/);
    assert.equal(result.textFallback, null, "no text fallback expected for valid JSONL");
    // Only assistant message_end and tool_execution_* should be kept
    const keptTypes = result.events.map((event) => event.type);
    assert.ok(keptTypes.includes("message_end"), "message_end should be kept");
    assert.ok(!keptTypes.includes("session"), "session should be discarded");
    assert.ok(!keptTypes.includes("message_update"), "message_update should be discarded");
  });

  it("parseAgentFields extracts all fields from assistant text", () => {
    const text = [
      "STATUS: done",
      "CHANGES: rewrote runPiAgent",
      "HYPOTHESIS: JSON mode fixes parsing",
      "LEARNED: pi --no-session is needed",
      "NEXT_FOCUS: add --timeout CLI flag",
    ].join("\n");

    const fields = parseAgentFields(text);
    assert.ok(fields !== null, "expected non-null fields");
    assert.equal(fields!.status, "done");
    assert.equal(fields!.changes, "rewrote runPiAgent");
    assert.equal(fields!.hypothesis, "JSON mode fixes parsing");
    assert.equal(fields!.learned, "pi --no-session is needed");
    assert.equal(fields!.nextFocus, "add --timeout CLI flag");
  });

  it("parseAgentFields handles minimal input with only STATUS and CHANGES", () => {
    const text = "STATUS: done\nCHANGES: fixed bug";
    const fields = parseAgentFields(text);
    assert.ok(fields !== null);
    assert.equal(fields!.status, "done");
    assert.equal(fields!.changes, "fixed bug");
    assert.equal(fields!.hypothesis, undefined);
    assert.equal(fields!.learned, undefined);
    assert.equal(fields!.nextFocus, undefined);
  });

  it("parseAgentFields returns null when no STATUS field", () => {
    assert.equal(parseAgentFields("just some text"), null);
    assert.equal(parseAgentFields(""), null);
    assert.equal(parseAgentFields("CHANGES: something"), null);
  });

  it("loopAutoresearch respects timeoutSeconds option with a short timeout", async () => {
    // Create a fake pi that hangs (no output, no exit), then verify the loop
    // times it out and handles the failure gracefully.
    const cwd = makeTempDir();
    const fakePi = path.join(cwd, "pi");
    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `// Hang forever — the loop should time this out`,
      `setTimeout(() => {}, 600_000);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    const origPath = process.env.PATH ?? "";
    // Prepend the cwd to PATH so the fake pi is found
    process.env.PATH = `${cwd}${path.delimiter}${origPath}`;

    try {
      initExperiment({
        cwd,
        goal: "reduce loss",
        metricName: "loss",
        direction: "lower",
        command: nodeMetricCommand("loss", 5),
      });

      // Use a short 1-second timeout so the test is fast.
      // maxConsecutiveFailures=3 (default), so with 2 iterations both
      // will time out and the loop will complete 2 iterations.
      const result = await loopAutoresearch({
        cwd,
        maxIterations: 2,
        actionMode: "prompt",
        timeoutSeconds: 1,
      });

      // Both iterations should complete (agent times out, loop continues)
      assert.equal(result.iterations, 2);
      // runLoopIteration now logs crash entries on agent failure
      assert.equal(result.crashed, 2);
      assert.ok(result.stopReason?.includes("Max iterations reached"));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("loopAutoresearch uses default 300s timeout when no timeoutSeconds option", async () => {
    // Verify the type system: timeoutSeconds is optional and defaults to 300.
    // We can't easily observe the internal timeout, but we verify the loop runs.
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    // measure-only mode doesn't use runPiAgent, so it should succeed
    const result = await loopAutoresearch({
      cwd,
      maxIterations: 1,
      actionMode: "measure-only",
    });

    // Verify no timeoutSeconds was provided, but loop still runs
    assert.equal(result.iterations, 1);
  });

  it("parseAgentFields handles STATUS: no_change", () => {
    const text = "STATUS: no_change\nCHANGES: nothing to do\nLEARNED: metric is optimal";
    const fields = parseAgentFields(text);
    assert.ok(fields !== null);
    assert.equal(fields!.status, "no_change");
    assert.equal(fields!.changes, "nothing to do");
    assert.equal(fields!.learned, "metric is optimal");
  });
});

describe("hasDirtyNonAutoresearchFiles", () => {
  function dirtyGitInit(cwd: string): void {
    git(cwd, ["init", "--initial-branch=main"]);
    git(cwd, ["config", "user.email", "test@tamandua.local"]);
    git(cwd, ["config", "user.name", "Tamandua Test"]);
  }

  it("returns {dirty: false} for a clean working tree", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "src.txt"), "clean");
    git(cwd, ["add", "src.txt"]);
    git(cwd, ["commit", "-m", "initial"]);

    const result = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(result.dirty, false);
    assert.deepEqual(result.dirtyFiles, []);
  });

  it("returns {dirty: false} when only autoresearch files are modified", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "src.txt"), "clean");
    git(cwd, ["add", "src.txt"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Touch only autoresearch files
    fs.writeFileSync(path.join(cwd, "autoresearch.jsonl"), "{}\
");
    fs.writeFileSync(path.join(cwd, "autoresearch.md"), "# test");
    fs.writeFileSync(path.join(cwd, "autoresearch.config.json"), "{}");
    fs.writeFileSync(path.join(cwd, "autoresearch.sh"), "echo test");
    fs.writeFileSync(path.join(cwd, "autoresearch.checks.sh"), "echo check");
    fs.mkdirSync(path.join(cwd, "autoresearch.hooks"));
    fs.writeFileSync(path.join(cwd, "autoresearch.hooks", "before.sh"), "#!/bin/sh\necho hook");

    const result = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(result.dirty, false);
    assert.deepEqual(result.dirtyFiles, []);
  });

  it("returns {dirty: true} with correct dirtyFiles when non-protected files are modified", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "src.txt"), "clean");
    git(cwd, ["add", "src.txt"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Modify a non-protected file and add an untracked one
    fs.writeFileSync(path.join(cwd, "src.txt"), "modified");
    fs.writeFileSync(path.join(cwd, "new-file.ts"), "new");

    const result = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(result.dirty, true);
    assert.ok(result.dirtyFiles.includes("src.txt"));
    assert.ok(result.dirtyFiles.includes("new-file.ts"));
  });

  it("detects dirty non-protected files alongside dirty autoresearch files", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);
    fs.writeFileSync(path.join(cwd, "src.txt"), "clean");
    git(cwd, ["add", "src.txt"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Modify both protected and non-protected files
    fs.writeFileSync(path.join(cwd, "src.txt"), "modified");
    fs.writeFileSync(path.join(cwd, "autoresearch.jsonl"), "{}\
");

    const result = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(result.dirty, true);
    assert.ok(result.dirtyFiles.includes("src.txt"));
    assert.ok(!result.dirtyFiles.includes("autoresearch.jsonl"));
  });

  it("returns {dirty: false} when not a git repo", () => {
    const cwd = makeTempDir();
    const result = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(result.dirty, false);
    assert.deepEqual(result.dirtyFiles, []);
  });
});

describe("commitAutoresearchResult", () => {
  function dirtyGitInit(cwd: string) {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@test.test"]);
    git(cwd, ["config", "user.name", "Test"]);
  }

  function commit(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const result = spawnSync("git", ["commit", ...args], { cwd, encoding: "utf-8" });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
  }

  function listCommittedFiles(cwd: string, commitSha: string): string[] {
    const result = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha], { cwd, encoding: "utf-8" });
    assert.equal(result.status, 0, `git diff-tree failed: ${result.stderr}`);
    return result.stdout.trim().split(/\r?\n/).filter(Boolean);
  }

  it("commits non-autoresearch files and excludes all protected files", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    // Create source file + initial commit
    fs.writeFileSync(path.join(cwd, "src.ts"), "initial");
    git(cwd, ["add", "src.ts"]);
    git(cwd, ["commit", "-m", "initial commit"]);

    // Now modify source file and create various autoresearch files
    fs.writeFileSync(path.join(cwd, "src.ts"), "modified");
    fs.writeFileSync(path.join(cwd, "autoresearch.jsonl"), "{}\
");
    fs.writeFileSync(path.join(cwd, "autoresearch.config.json"), "{}");
    fs.writeFileSync(path.join(cwd, "autoresearch.md"), "# test");
    fs.writeFileSync(path.join(cwd, "autoresearch.sh"), "echo hi");
    fs.writeFileSync(path.join(cwd, "autoresearch.checks.sh"), "echo check");
    fs.mkdirSync(path.join(cwd, "autoresearch.hooks"));
    fs.writeFileSync(path.join(cwd, "autoresearch.hooks", "before.sh"), "#!/bin/sh\necho hook");
    // Also add another non-autoresearch file
    fs.writeFileSync(path.join(cwd, "other.ts"), "extra");

    const result = commitAutoresearchResult(cwd, 1, "test commit");
    assert.ok(typeof result === "string", "should return commit sha");
    assert.ok(result.length > 0, "commit sha should not be empty");

    // Check committed files do NOT include any autoresearch files
    const committed = listCommittedFiles(cwd, result);
    assert.ok(committed.includes("src.ts"), "src.ts should be committed");
    assert.ok(committed.includes("other.ts"), "other.ts should be committed");
    assert.ok(!committed.includes("autoresearch.jsonl"), "autoresearch.jsonl should NOT be committed");
    assert.ok(!committed.includes("autoresearch.config.json"), "autoresearch.config.json should NOT be committed");
    assert.ok(!committed.includes("autoresearch.md"), "autoresearch.md should NOT be committed");
    assert.ok(!committed.includes("autoresearch.sh"), "autoresearch.sh should NOT be committed");
    assert.ok(!committed.includes("autoresearch.checks.sh"), "autoresearch.checks.sh should NOT be committed");
    assert.ok(!committed.includes("autoresearch.hooks/before.sh"), "autoresearch.hooks/before.sh should NOT be committed");

    // Verify autoresearch files remain on disk (not deleted by reset)
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.config.json")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.hooks", "before.sh")));
  });

  it("autoresearch.jsonl is never staged or committed", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(cwd, "app.ts"), "updated");
    fs.writeFileSync(path.join(cwd, "autoresearch.jsonl"), '{"type":"session"}\n');

    const result = commitAutoresearchResult(cwd, 2, "update app");
    const committed = listCommittedFiles(cwd, result);
    assert.ok(committed.includes("app.ts"));
    assert.ok(!committed.includes("autoresearch.jsonl"));

    // Check autoresearch.jsonl is still present on disk and has expected content
    const content = fs.readFileSync(path.join(cwd, "autoresearch.jsonl"), "utf-8");
    assert.ok(content.includes('"type":"session"'));
  });

  it("only non-autoresearch files end up in commit when mixed", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "main.rs"), "fn main() {}");
    git(cwd, ["add", "main.rs"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Modify many files of both types
    fs.writeFileSync(path.join(cwd, "main.rs"), "fn main() { println!(); }");
    fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]");
    fs.writeFileSync(path.join(cwd, "autoresearch.jsonl"), "{}\n");
    fs.writeFileSync(path.join(cwd, "autoresearch.md"), "# docs");
    fs.writeFileSync(path.join(cwd, "autoresearch.sh"), "#!/bin/sh");
    fs.writeFileSync(path.join(cwd, "README.md"), "# readme");

    const result = commitAutoresearchResult(cwd, 3, "multi-file change");
    const committed = listCommittedFiles(cwd, result);

    assert.ok(committed.includes("main.rs"));
    assert.ok(committed.includes("Cargo.toml"));
    assert.ok(committed.includes("README.md"));
    assert.ok(!committed.includes("autoresearch.jsonl"));
    assert.ok(!committed.includes("autoresearch.md"));
    assert.ok(!committed.includes("autoresearch.sh"));
  });

  it("returns undefined when only autoresearch files are changed", () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "lib.ts"), "export {}");
    git(cwd, ["add", "lib.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Only modify autoresearch files
    fs.writeFileSync(path.join(cwd, "autoresearch.jsonl"), "{}\
");
    fs.writeFileSync(path.join(cwd, "autoresearch.md"), "# update");

    const result = commitAutoresearchResult(cwd, 4, "autoresearch only");
    assert.equal(result, undefined, "should return undefined when only autoresearch files changed");

    // Verify autoresearch files still exist on disk
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.md")));
  });
});

describe("runLoopIteration", () => {
  function dirtyGitInit(cwd: string) {
    git(cwd, ["init"]);
    git(cwd, ["config", "user.email", "test@test.test"]);
    git(cwd, ["config", "user.name", "Test"]);
  }

  function listCommittedFiles(cwd: string, commitSha: string): string[] {
    const result = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha], { cwd, encoding: "utf-8" });
    assert.equal(result.status, 0, `git diff-tree failed: ${result.stderr}`);
    return result.stdout.trim().split(/\r?\n/).filter(Boolean);
  }

  it("commits changes and returns status=keep when experiment improves metric (measure-only)", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "initial");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "improve score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 10.0),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline", hypothesis: "start" });

    fs.writeFileSync(path.join(cwd, "app.ts"), "improved");

    const result = await runLoopIteration({
      cwd,
      command: nodeMetricCommand("score", 5.0),
      description: "improvement iteration",
      iteration: 2,
    });

    assert.equal(result.status, "keep");
    assert.ok(result.committed, "should have committed");
    assert.equal(result.reverted, false);
    assert.equal(result.metric, 5.0);

    const committed = listCommittedFiles(cwd, result.logEntry.commit_after!);
    assert.ok(committed.includes("app.ts"));
    assert.ok(!committed.includes("autoresearch.jsonl"));

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });

  it("reverts changes and returns status=discard when experiment regresses", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "improve score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 5.0),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    fs.writeFileSync(path.join(cwd, "app.ts"), "regression");

    const result = await runLoopIteration({
      cwd,
      command: nodeMetricCommand("score", 10.0),
      description: "regression iteration",
      iteration: 2,
    });

    assert.equal(result.status, "discard");
    assert.equal(result.committed, false);
    assert.ok(result.reverted, "should have reverted discarded changes");

    const content = fs.readFileSync(path.join(cwd, "app.ts"), "utf-8");
    assert.equal(content, "original");

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });

  it("reverts changes and returns status=crash when experiment crashes", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "improve score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 3.0),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    fs.writeFileSync(path.join(cwd, "app.ts"), "crash change");

    const result = await runLoopIteration({
      cwd,
      command: "exit 1",
      description: "crash iteration",
      iteration: 2,
    });

    assert.equal(result.status, "crash");
    assert.equal(result.committed, false);
    assert.ok(result.reverted, "should have reverted");

    const content = fs.readFileSync(path.join(cwd, "app.ts"), "utf-8");
    assert.equal(content, "original");

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });

  it("reverts changes and returns status=checks_failed when checks fail", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    const checksScript = path.join(cwd, "autoresearch.checks.sh");
    fs.writeFileSync(checksScript, "#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n");
    fs.chmodSync(checksScript, 0o755);

    initExperiment({
      cwd,
      goal: "improve score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 7.0),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    fs.writeFileSync(path.join(cwd, "app.ts"), "check fail change");

    const result = await runLoopIteration({
      cwd,
      description: "checks_failed iteration",
      iteration: 2,
    });

    assert.equal(result.status, "checks_failed");
    assert.equal(result.committed, false);
    assert.ok(result.reverted, "should have reverted");

    const content = fs.readFileSync(path.join(cwd, "app.ts"), "utf-8");
    assert.equal(content, "original");

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });

  it("throws if working tree is dirty after runLoopIteration", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "improve score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 1.0),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    // Normal case: should not throw, tree clean
    const result = await runLoopIteration({
      cwd,
      description: "clean iteration",
      iteration: 2,
    });

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
    assert.equal(result.status, "discard");
  });

  it("keep followed by discard preserves kept code, removes discarded edits", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "v0");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "lower score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 100),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    // Keep: improvement
    fs.writeFileSync(path.join(cwd, "app.ts"), "v1-kept");
    const keepResult = await runLoopIteration({
      cwd,
      command: nodeMetricCommand("score", 50),
      description: "keep improvement",
      iteration: 2,
    });
    assert.equal(keepResult.status, "keep");
    assert.ok(keepResult.committed);
    assert.equal(fs.readFileSync(path.join(cwd, "app.ts"), "utf-8"), "v1-kept");

    // Discard: regression
    fs.writeFileSync(path.join(cwd, "app.ts"), "v2-discard");
    const discardResult = await runLoopIteration({
      cwd,
      command: nodeMetricCommand("score", 90),
      description: "regression to discard",
      iteration: 3,
    });
    assert.equal(discardResult.status, "discard");
    assert.ok(discardResult.reverted);

    // Should be back to v1 (kept), not v0 or v2
    assert.equal(fs.readFileSync(path.join(cwd, "app.ts"), "utf-8"), "v1-kept");

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });

  it("autoresearch.jsonl is preserved and never committed across iterations", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "lower score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 10),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));
    const initialSize = fs.statSync(path.join(cwd, "autoresearch.jsonl")).size;
    assert.ok(initialSize > 0);

    for (let i = 2; i <= 4; i++) {
      fs.writeFileSync(path.join(cwd, "app.ts"), `v${i}`);
      const result = await runLoopIteration({
        cwd,
        command: nodeMetricCommand("score", 10 + i),
        description: `iteration ${i}`,
        iteration: i,
      });
      const dirty = hasDirtyNonAutoresearchFiles(cwd);
      assert.equal(dirty.dirty, false, `iteration ${i} left dirty files`);
    }

    const finalSize = fs.statSync(path.join(cwd, "autoresearch.jsonl")).size;
    assert.ok(finalSize > initialSize, "autoresearch.jsonl should have grown");

    // No commit includes autoresearch.jsonl
    const log = spawnSync("git", ["log", "--oneline"], { cwd, encoding: "utf-8" });
    assert.equal(log.status, 0);
    const commits = log.stdout.trim().split(/\r?\n/).filter(Boolean);
    for (const line of commits) {
      const sha = line.split(" ")[0];
      if (line.includes("initial")) continue;
      const files = listCommittedFiles(cwd, sha);
      assert.ok(!files.includes("autoresearch.jsonl"), `commit ${sha} should not include autoresearch.jsonl`);
    }
  });

  it("crash reverts changes and preserves autoresearch.jsonl", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    initExperiment({
      cwd,
      goal: "improve score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 3.0),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    // Record autoresearch.jsonl content before crash
    const jsonlBefore = fs.readFileSync(path.join(cwd, "autoresearch.jsonl"), "utf-8");
    assert.ok(jsonlBefore.length > 0);

    fs.writeFileSync(path.join(cwd, "app.ts"), "crash change");
    // Append valid JSON to autoresearch.jsonl — autoresearch modifications should survive revert
    fs.appendFileSync(path.join(cwd, "autoresearch.jsonl"), JSON.stringify({ type: "extra", note: "should survive" }) + "\n");

    const result = await runLoopIteration({
      cwd,
      command: "exit 1",
      description: "crash iteration",
      iteration: 2,
    });

    assert.equal(result.status, "crash");
    assert.equal(result.committed, false);
    assert.ok(result.reverted, "should have reverted");

    // Non-autoresearch files reverted
    assert.equal(fs.readFileSync(path.join(cwd, "app.ts"), "utf-8"), "original");

    // Autoresearch.jsonl preserved (still has extra entry appended before crash)
    const jsonlAfter = fs.readFileSync(path.join(cwd, "autoresearch.jsonl"), "utf-8");
    assert.ok(jsonlAfter.includes("should survive"), "autoresearch.jsonl should preserve modifications made alongside crash changes");
    assert.ok(jsonlAfter.length > jsonlBefore.length);

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });

  it("checks_failed reverts changes and preserves autoresearch.jsonl", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    const checksScript = path.join(cwd, "autoresearch.checks.sh");
    fs.writeFileSync(checksScript, "#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n");
    fs.chmodSync(checksScript, 0o755);

    initExperiment({
      cwd,
      goal: "improve score",
      metricName: "score",
      direction: "lower",
      command: nodeMetricCommand("score", 7.0),
    });

    await runExperiment({ cwd });
    await logExperiment({ cwd, status: "auto", description: "baseline" });

    const jsonlBefore = fs.readFileSync(path.join(cwd, "autoresearch.jsonl"), "utf-8");
    assert.ok(jsonlBefore.length > 0);

    fs.writeFileSync(path.join(cwd, "app.ts"), "checks-fail change");
    fs.appendFileSync(path.join(cwd, "autoresearch.jsonl"), JSON.stringify({ type: "extra", note: "should survive" }) + "\n");

    const result = await runLoopIteration({
      cwd,
      description: "checks_failed iteration",
      iteration: 2,
    });

    assert.equal(result.status, "checks_failed");
    assert.equal(result.committed, false);
    assert.ok(result.reverted, "should have reverted");

    assert.equal(fs.readFileSync(path.join(cwd, "app.ts"), "utf-8"), "original");

    const jsonlAfter = fs.readFileSync(path.join(cwd, "autoresearch.jsonl"), "utf-8");
    assert.ok(jsonlAfter.includes("should survive"), "autoresearch.jsonl should preserve modifications made alongside checks_failed changes");
    assert.ok(jsonlAfter.length > jsonlBefore.length);

    const dirty = hasDirtyNonAutoresearchFiles(cwd);
    assert.equal(dirty.dirty, false);
  });

  it("prompt mode: agent failure with partial edits reverts changes", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Fake pi that exits non-zero after making some file changes
    const fakePi = path.join(cwd, "pi");
    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `const fs = require("node:fs");`,
      `fs.writeFileSync(${JSON.stringify(path.join(cwd, "app.ts"))}, "agent-dirty");`,
      `fs.writeFileSync(${JSON.stringify(path.join(cwd, "untracked.txt"))}, "agent created me");`,
      `process.exit(1);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${cwd}${path.delimiter}${origPath}`;

    try {
      initExperiment({
        cwd,
        goal: "lower score",
        metricName: "score",
        direction: "lower",
        command: nodeMetricCommand("score", 5),
      });

      await runExperiment({ cwd });
      await logExperiment({ cwd, status: "auto", description: "baseline" });

      const result = await runLoopIteration({
        cwd,
        prompt: "test prompt for failing agent",
        description: "agent failure iteration",
        iteration: 2,
      });

      assert.equal(result.status, "crash", "agent failure should result in crash status");
      assert.equal(result.agentSuccess, false);
      assert.ok(result.reverted, "should have reverted agent's dirty files");

      // Non-autoresearch files reverted
      assert.equal(fs.readFileSync(path.join(cwd, "app.ts"), "utf-8"), "original");
      assert.equal(fs.existsSync(path.join(cwd, "untracked.txt")), false, "untracked agent file should be removed");

      // Autoresearch.jsonl preserved (crash entry logged)
      assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));

      const dirty = hasDirtyNonAutoresearchFiles(cwd);
      assert.equal(dirty.dirty, false);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("prompt mode: agent no_change with touched files reverts changes", async () => {
    const cwd = makeTempDir();
    dirtyGitInit(cwd);

    fs.writeFileSync(path.join(cwd, "app.ts"), "original");
    git(cwd, ["add", "app.ts"]);
    git(cwd, ["commit", "-m", "initial"]);

    // Fake pi that reports no_change but has modified files
    const fakePi = path.join(cwd, "pi");
    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `const fs = require("node:fs");`,
      `fs.writeFileSync(${JSON.stringify(path.join(cwd, "app.ts"))}, "no-change-but-dirty");`,
      `console.log(JSON.stringify({ type: "session", version: 1 }));`,
      `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STATUS: no_change\\nCHANGES: nothing to do\\nHYPOTHESIS: already optimal\\nLEARNED: no improvement possible\\nNEXT_FOCUS: stop" }] } }));`,
      `console.log(JSON.stringify({ type: "agent_end" }));`,
      `process.exit(0);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${cwd}${path.delimiter}${origPath}`;

    try {
      initExperiment({
        cwd,
        goal: "lower score",
        metricName: "score",
        direction: "lower",
        command: nodeMetricCommand("score", 5),
      });

      await runExperiment({ cwd });
      await logExperiment({ cwd, status: "auto", description: "baseline" });

      const result = await runLoopIteration({
        cwd,
        prompt: "test prompt for no_change agent",
        description: "no_change iteration",
        iteration: 2,
      });

      assert.equal(result.status, "crash", "no_change with dirty files should result in crash status");
      assert.equal(result.agentSuccess, true, "agent ran fine but declared no_change");
      assert.ok(result.reverted, "should have reverted agent's dirty files");

      // Non-autoresearch files reverted
      assert.equal(fs.readFileSync(path.join(cwd, "app.ts"), "utf-8"), "original");

      // Autoresearch.jsonl preserved (crash entry logged)
      assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));

      const dirty = hasDirtyNonAutoresearchFiles(cwd);
      assert.equal(dirty.dirty, false);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("autoresearch run-loop-iteration CLI", () => {
  function cli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env = {
      PATH: process.env.PATH,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cli-")),
      TAMANDUA_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-state-")),
    };
    const result = spawnSync(process.execPath, [CLI_SCRIPT, ...args], {
      cwd,
      env,
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }

  it("outputs JSON with run number, status, and metric", () => {
    const cwd = makeTempDir();
    spawnSync("git", ["init"], { cwd });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd });
    spawnSync("git", ["config", "user.name", "Test"], { cwd });
    fs.writeFileSync(path.join(cwd, "README.md"), "test\n");
    spawnSync("git", ["add", "README.md"], { cwd });
    spawnSync("git", ["commit", "-m", "initial"], { cwd });

    initExperiment({
      cwd,
      goal: "test",
      metricName: "total_ms",
      metricUnit: "ms",
      direction: "lower",
      command: `echo "METRIC total_ms=42"`,
    });

    const result = cli(cwd, ["autoresearch", "run-loop-iteration", "--cwd", cwd, "--iteration", "1", "--description", "baseline"]);
    assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.run, "number");
    assert.equal(parsed.status, "baseline");
    assert.equal(parsed.metric, 42);
    assert.equal(typeof parsed.agentSuccess, "boolean");
    assert.equal(typeof parsed.committed, "boolean");
    assert.equal(typeof parsed.reverted, "boolean");
    assert.ok(parsed.logEntry);
    assert.equal(parsed.logEntry.run, parsed.run);
    assert.equal(parsed.logEntry.status, parsed.status);
    assert.equal(parsed.logEntry.metric, parsed.metric);
  });

  it("shows help text with --help", () => {
    const cwd = makeTempDir();
    const result = cli(cwd, ["autoresearch", "run-loop-iteration", "--help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("tamandua autoresearch run-loop-iteration"));
    assert.ok(result.stdout.includes("--prompt"));
    assert.ok(result.stdout.includes("--cwd"));
    assert.ok(result.stdout.includes("--iteration"));
    assert.ok(result.stdout.includes("--description"));
    assert.ok(result.stdout.includes("--timeout"));
    assert.ok(result.stdout.includes("JSON object"));
  });

  it("is listed in autoresearch --help subcommands", () => {
    const cwd = makeTempDir();
    const result = cli(cwd, ["autoresearch", "--help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("run-loop-iteration"));
    assert.ok(result.stdout.includes("transactional experiment iteration"));
  });

  it("is listed in global --help usage text", () => {
    const cwd = makeTempDir();
    const result = cli(cwd, ["--help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("autoresearch run-loop-iteration"));
  });

  it("handles --iteration parsing", () => {
    const cwd = makeTempDir();
    spawnSync("git", ["init"], { cwd });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd });
    spawnSync("git", ["config", "user.name", "Test"], { cwd });
    fs.writeFileSync(path.join(cwd, "README.md"), "test\n");
    spawnSync("git", ["add", "README.md"], { cwd });
    spawnSync("git", ["commit", "-m", "initial"], { cwd });

    initExperiment({
      cwd,
      goal: "test",
      metricName: "total_ms",
      metricUnit: "ms",
      direction: "lower",
      command: `echo "METRIC total_ms=50"`,
    });

    const result = cli(cwd, ["autoresearch", "run-loop-iteration", "--cwd", cwd, "--iteration", "5", "--description", "iter 5"]);
    assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.run, 1); // run number comes from jsonl, not --iteration
    assert.equal(parsed.metric, 50);

    // Also test invalid iteration
    const badResult = cli(cwd, ["autoresearch", "run-loop-iteration", "--cwd", cwd, "--iteration", "not-a-number"]);
    assert.ok(badResult.status !== 0 || badResult.stderr.includes("Invalid"));
  });

  it("handles --timeout parsing", () => {
    const cwd = makeTempDir();
    spawnSync("git", ["init"], { cwd });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd });
    spawnSync("git", ["config", "user.name", "Test"], { cwd });
    fs.writeFileSync(path.join(cwd, "README.md"), "test\n");
    spawnSync("git", ["add", "README.md"], { cwd });
    spawnSync("git", ["commit", "-m", "initial"], { cwd });

    initExperiment({
      cwd,
      goal: "test",
      metricName: "total_ms",
      metricUnit: "ms",
      direction: "lower",
      command: `echo "METRIC total_ms=10"`,
    });

    // Valid timeout
    const result = cli(cwd, ["autoresearch", "run-loop-iteration", "--cwd", cwd, "--timeout", "10m", "--description", "with timeout"]);
    assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "baseline");

    // Invalid timeout
    const badResult = cli(cwd, ["autoresearch", "run-loop-iteration", "--cwd", cwd, "--timeout", "invalid"]);
    assert.ok(badResult.status !== 0 || badResult.stderr.includes("Invalid"));
  });
});
