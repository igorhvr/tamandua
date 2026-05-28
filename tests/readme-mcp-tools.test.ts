import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");

// Tool names as defined in src/server/mcp-server.ts
const allMcpTools = [
  "tamandua.runs.list",
  "tamandua.run.status",
  "tamandua.run.start",
  "tamandua.run.pause",
  "tamandua.run.resume",
  "tamandua.run.delete",
  "tamandua.events.recent",
  "tamandua.skill.path",
  "tamandua.source.path",
  "tamandua.update.command",
  "tamandua.autoresearch.init",
  "tamandua.autoresearch.run_experiment",
  "tamandua.autoresearch.log_experiment",
  "tamandua.autoresearch.status",
];

describe("README MCP tools documentation", () => {
  it("lists all 14 MCP tools", () => {
    assert.equal(allMcpTools.length, 14, "There should be exactly 14 MCP tools");
    for (const tool of allMcpTools) {
      const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp("`" + escaped + "`");
      assert.ok(
        pattern.test(readmeContent),
        `MCP tool '${tool}' must be documented in README.md`
      );
    }
  });

  it("documents tamandua.run.pause with its parameters", () => {
    assert.ok(
      readmeContent.includes("tamandua.run.pause"),
      "README must document tamandua.run.pause"
    );
    assert.ok(
      readmeContent.includes("runId"),
      "tamandua.run.pause documentation must mention runId parameter"
    );
    assert.ok(
      readmeContent.includes("drain"),
      "tamandua.run.pause documentation must mention drain parameter"
    );
  });

  it("documents tamandua.run.resume with its parameters", () => {
    assert.ok(
      readmeContent.includes("tamandua.run.resume"),
      "README must document tamandua.run.resume"
    );
    assert.ok(
      readmeContent.includes("runId"),
      "tamandua.run.resume documentation must mention runId parameter"
    );
  });

  it("documents tamandua.run.delete with its parameters", () => {
    assert.ok(
      readmeContent.includes("tamandua.run.delete"),
      "README must document tamandua.run.delete"
    );
    assert.ok(
      readmeContent.includes("force"),
      "tamandua.run.delete documentation must mention force parameter"
    );
  });

  it("documents tamandua.run.start worktree parameters", () => {
    assert.ok(
      readmeContent.includes("worktreeOriginRepository"),
      "README must document worktreeOriginRepository parameter for run.start"
    );
    assert.ok(
      readmeContent.includes("worktreeOriginRef"),
      "README must document worktreeOriginRef parameter for run.start"
    );
    assert.ok(
      readmeContent.includes("noHurrySaveTokensMode"),
      "README must document noHurrySaveTokensMode parameter for run.start"
    );
  });

  it("documents workingDirectoryForHarness and worktreeOriginRepository mutual exclusivity", () => {
    assert.ok(
      readmeContent.includes("mutually exclusive"),
      "README must state workingDirectoryForHarness and worktreeOriginRepository are mutually exclusive"
    );
  });

  it("parameter descriptions match mcp-server.ts requirements", () => {
    // Verify that key descriptions from the MCP server are reflected in the README
    assert.ok(
      readmeContent.includes("Harness working directory"),
      "README must describe workingDirectoryForHarness as harness working directory"
    );
    assert.ok(
      readmeContent.includes("15-min"),
      "README must document noHurrySaveTokensMode polling frequency details"
    );
    assert.ok(
      readmeContent.includes("wait for in-flight work"),
      "README must describe drain parameter behavior for tamandua.run.pause"
    );
    assert.ok(
      readmeContent.includes("Pause a running"),
      "README must describe tamandua.run.pause as pausing a running workflow"
    );
    assert.ok(
      readmeContent.includes("Resume a paused"),
      "README must describe tamandua.run.resume as resuming a paused workflow"
    );
  });
});
