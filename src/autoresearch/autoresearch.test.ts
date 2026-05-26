import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  decideStatus,
  initExperiment,
  logExperiment,
  parseMetric,
  readAutoresearchLog,
  runExperiment,
  summarizeAutoresearch,
} from "../../dist/autoresearch/autoresearch.js";

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
