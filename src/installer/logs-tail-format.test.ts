import { describe, it } from "node:test";
import assert from "node:assert";
import {
  formatLogsTailLabel,
  formatLogsTailLine,
  formatLogsTailLines,
} from "../../dist/installer/logs-tail-format.js";
import type { TamanduaEvent } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

function makeEvent(event: string, overrides: Partial<TamanduaEvent> = {}): TamanduaEvent {
  return {
    ts: new Date().toISOString(),
    event,
    runId: "test-run-id",
    ...overrides,
  };
}

describe("formatLogsTailLabel", () => {
  it("displays 'Run nudged' for run.nudged events", () => {
    const evt = makeEvent("run.nudged");
    assert.equal(formatLogsTailLabel(evt), "Run nudged");
  });

  it("displays 'Agent nudged' for agent.nudged events", () => {
    const evt = makeEvent("agent.nudged");
    assert.equal(formatLogsTailLabel(evt), "Agent nudged");
  });

  it("displays 'Nudge skipped' for agent.nudge.skipped events", () => {
    const evt = makeEvent("agent.nudge.skipped");
    assert.equal(formatLogsTailLabel(evt), "Nudge skipped");
  });

  it("preserves existing event labels", () => {
    assert.equal(formatLogsTailLabel(makeEvent("run.started")), "Run started");
    assert.equal(formatLogsTailLabel(makeEvent("step.pending")), "Step pending");
    assert.equal(formatLogsTailLabel(makeEvent("story.done")), "Story done");
    assert.equal(formatLogsTailLabel(makeEvent("pipeline.advanced")), "Pipeline advanced");
  });

  it("displays 'Step respawned' for step.respawned events (RVOC US-002)", () => {
    const evt = makeEvent("step.respawned");
    assert.equal(formatLogsTailLabel(evt), "Step respawned");
  });

  it("displays 'Run canceled' for run.canceled events", () => {
    const evt = makeEvent("run.canceled");
    assert.equal(formatLogsTailLabel(evt), "Run canceled");
  });

  it("still formats terminal run.completed/run.failed events", () => {
    assert.equal(formatLogsTailLabel(makeEvent("run.completed")), "Run completed");
    assert.equal(formatLogsTailLabel(makeEvent("run.failed")), "Run failed");
  });

  it("falls back to raw event name for unknown events", () => {
    const evt = makeEvent("custom.unknown.event");
    assert.equal(formatLogsTailLabel(evt), "custom.unknown.event");
  });

  it("displays the plain label for an in-run run.tokens.updated", () => {
    const evt = makeEvent("run.tokens.updated", { tokenDelta: 100, tokensSpent: 100 });
    assert.equal(formatLogsTailLabel(evt), "Token spend updated");
  });

  it("displays a distinct label for a post-terminal run.tokens.updated (TATR US-007)", () => {
    const evt = makeEvent("run.tokens.updated", {
      tokenDelta: 100,
      tokensSpent: 100,
      postTerminal: true,
      terminalStatus: "failed",
    });
    assert.equal(formatLogsTailLabel(evt), "Token spend updated (post-terminal)");
  });

  it("displays a distinct label for run.tokens.final (F3)", () => {
    const evt = makeEvent("run.tokens.final", { tokenDelta: 137, tokensSpent: 137 });
    assert.equal(formatLogsTailLabel(evt), "Token spend finalized");
  });

  it("displays 'Step rerouted' for step.rerouted events (WAVE-B.1)", () => {
    const evt = makeEvent("step.rerouted");
    assert.equal(formatLogsTailLabel(evt), "Step rerouted");
  });

  it("displays the plain label for a non-terminal step.rerouted (WAVE-B.1)", () => {
    const evt = makeEvent("step.rerouted", { rerouteMode: "legacy", terminal: false });
    assert.equal(formatLogsTailLabel(evt), "Step rerouted");
  });

  it("displays a terminal marker for a terminal-class step.rerouted (WAVE-B.1)", () => {
    const evt = makeEvent("step.rerouted", { rerouteMode: "terminal", terminal: true });
    assert.equal(formatLogsTailLabel(evt), "Step rerouted (terminal)");
  });
});

describe("formatLogsTailLine", () => {
  it("includes nudge event labels in formatted output", () => {
    const evt = makeEvent("run.nudged", {
      runId: "abcd1234",
      agentId: "feature-dev-merge-worktree_developer",
    });
    const line = formatLogsTailLine(evt);
    assert.ok(line.includes("Run nudged"), `Expected 'Run nudged' in: ${line}`);
    assert.ok(line.includes("run-abcd1234"), `Expected run ID in: ${line}`);
    assert.ok(line.includes("developer"), `Expected agent label in: ${line}`);
  });

  it("includes agent.nudged label in formatted output", () => {
    const evt = makeEvent("agent.nudged");
    const line = formatLogsTailLine(evt);
    assert.ok(line.includes("Agent nudged"), `Expected 'Agent nudged' in: ${line}`);
  });

  it("includes nudge skipped label in formatted output", () => {
    const evt = makeEvent("agent.nudge.skipped");
    const line = formatLogsTailLine(evt);
    assert.ok(line.includes("Nudge skipped"), `Expected 'Nudge skipped' in: ${line}`);
  });

  it("renders the distinct post-terminal label in the full line (TATR US-007)", () => {
    const evt = makeEvent("run.tokens.updated", {
      runId: "abcd1234",
      tokenDelta: 137,
      tokensSpent: 137,
      postTerminal: true,
      terminalStatus: "failed",
    });
    const line = formatLogsTailLine(evt);
    assert.ok(line.includes("Token spend updated (post-terminal)"), `Expected post-terminal label in: ${line}`);
    assert.ok(line.includes("[tokens: Δ +137, total 137]"), `Expected token spend detail in: ${line}`);
  });

  it("renders the finalization label and closing totals for run.tokens.final (F3)", () => {
    const evt = makeEvent("run.tokens.final", {
      runId: "abcd1234",
      tokenDelta: 137,
      tokensSpent: 137,
    });
    const line = formatLogsTailLine(evt);
    assert.ok(line.includes("Token spend finalized"), `Expected finalization label in: ${line}`);
    assert.ok(line.includes("[tokens: Δ +137, total 137]"), `Expected closing token spend in: ${line}`);
  });

  it("annotates a terminal event's token total as an as-of-completion snapshot (F3)", () => {
    const completed = formatLogsTailLine(makeEvent("run.completed", { runId: "abcd1234", tokensSpent: 80 }));
    assert.ok(
      completed.includes("[tokens: total 80 as of completion]"),
      `Expected snapshot caveat on run.completed in: ${completed}`,
    );
    const failed = formatLogsTailLine(makeEvent("run.failed", { runId: "abcd1234", tokensSpent: 70 }));
    assert.ok(
      failed.includes("[tokens: total 70 as of completion]"),
      `Expected snapshot caveat on run.failed in: ${failed}`,
    );
    // A canceled run settles its attribution before run.canceled (TATR
    // US-006), so its total is already authoritative and keeps the plain label.
    const canceled = formatLogsTailLine(makeEvent("run.canceled", { runId: "abcd1234", tokensSpent: 60 }));
    assert.ok(canceled.includes("[tokens: total 60]"), `Expected plain canceled total in: ${canceled}`);
    assert.ok(!canceled.includes("as of completion"), `Canceled total must not be marked a snapshot: ${canceled}`);
  });

  it("renders the plain step.rerouted label in the full line (WAVE-B.1)", () => {
    const evt = makeEvent("step.rerouted", {
      runId: "abcd1234",
      agentId: "feature-dev-merge-worktree_developer",
      stepId: "finalize_merge",
      rerouteMode: "legacy",
      terminal: false,
      detail: "Rerouted to test (1/8). Consumer failure: expects mismatch",
    });
    const line = formatLogsTailLine(evt);
    assert.ok(line.includes("Step rerouted"), `Expected 'Step rerouted' in: ${line}`);
    assert.ok(!line.includes("(terminal)"), `Expected no terminal marker in: ${line}`);
    assert.ok(line.includes("expects mismatch"), `Expected detail in: ${line}`);
  });

  it("renders the terminal marker in the full line for a terminal-class step.rerouted (WAVE-B.1)", () => {
    const evt = makeEvent("step.rerouted", {
      runId: "abcd1234",
      stepId: "finalize_merge",
      rerouteMode: "terminal",
      terminal: true,
      detail: "Rerouted to test (2/8). Consumer failure: FAILURE_CLASS: refused_permanent",
    });
    const line = formatLogsTailLine(evt);
    assert.ok(line.includes("Step rerouted (terminal)"), `Expected terminal marker in: ${line}`);
    assert.ok(line.includes("refused_permanent"), `Expected reason in: ${line}`);
  });
});

describe("formatLogsTailLines", () => {
  it("formats multiple nudge events correctly", () => {
    const events: TamanduaEvent[] = [
      makeEvent("run.nudged", { runId: "r1" }),
      makeEvent("agent.nudged", { agentId: "wf_agent1" }),
      makeEvent("agent.nudge.skipped", { agentId: "wf_agent2", detail: "in-flight" }),
    ];
    const lines = formatLogsTailLines(events);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].includes("Run nudged"));
    assert.ok(lines[1].includes("Agent nudged"));
    assert.ok(lines[2].includes("Nudge skipped"));
    assert.ok(lines[2].includes("in-flight"));
  });
});
