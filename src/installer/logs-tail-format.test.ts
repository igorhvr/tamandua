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
