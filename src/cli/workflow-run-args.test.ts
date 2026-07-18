import { describe, it } from "node:test";
import assert from "node:assert";
import { parseWorkflowRunArgs } from "../../dist/cli/workflow-run-args.js";

describe("parseWorkflowRunArgs", () => {
  it("parses task only", () => {
    const result = parseWorkflowRunArgs(["Do something"]);
    assert.equal(result.taskTitle, "Do something");
    assert.deepEqual(result.context, {});
  });

  it("parses --context with single key=value", () => {
    const result = parseWorkflowRunArgs(["Some task", "--context", "branch=feature/x"]);
    assert.equal(result.taskTitle, "Some task");
    assert.deepEqual(result.context, { branch: "feature/x" });
  });

  it("parses --context with value containing =", () => {
    const result = parseWorkflowRunArgs(["task", "--context", "url=http://example.com?a=b&c=d"]);
    assert.deepEqual(result.context, { url: "http://example.com?a=b&c=d" });
  });

  it("parses multiple --context flags", () => {
    const result = parseWorkflowRunArgs([
      "Multi context",
      "--context", "branch=fix/bug",
      "--context", "env=staging",
      "--context", "repo=/tmp/repo",
    ]);
    assert.deepEqual(result.context, {
      branch: "fix/bug",
      env: "staging",
      repo: "/tmp/repo",
    });
  });

  it("rejects --context with missing =", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "novalueseparator"]),
      /must contain '='/,
    );
  });

  it("rejects --context with empty key", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "=value"]),
      /key must be non-empty/,
    );
  });

  it("rejects duplicate --context keys", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "branch=a", "--context", "branch=b"]),
      /Duplicate --context key "branch"/,
    );
  });

  it("rejects --context with missing value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context"]),
      /Missing value for --context/,
    );
  });

  it("parses context alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--context", "branch=quarantine/broken-tests",
      "Quarantine broken tests",
      "--context", "repo=/tmp/myapp",
    ]);
    assert.equal(result.taskTitle, "Quarantine broken tests");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.deepEqual(result.context, {
      branch: "quarantine/broken-tests",
      repo: "/tmp/myapp",
    });
  });

  it("parses empty context when no --context flags provided", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--worktree-origin-repository", "/tmp/repo",
      "Build feature",
    ]);
    assert.equal(result.taskTitle, "Build feature");
    assert.deepEqual(result.context, {});
    assert.equal(result.worktreeOriginRepository, "/tmp/repo");
  });

  it("parses --wait flag", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait"]);
    assert.equal(result.wait, true);
    assert.equal(result.jsonFlag, false);
    assert.equal(result.timeout, undefined);
  });

  it("wait is false by default", () => {
    const result = parseWorkflowRunArgs(["Do something"]);
    assert.equal(result.wait, false);
    assert.equal(result.jsonFlag, false);
    assert.equal(result.timeout, undefined);
  });

  it("parses --timeout <duration>", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--timeout", "30s"]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "30s");
  });

  it("parses --timeout=<duration>", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--timeout=10m"]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "10m");
  });

  it("parses --json flag", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--json"]);
    assert.equal(result.wait, true);
    assert.equal(result.jsonFlag, true);
  });

  it("parses --wait, --timeout, and --json together", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--timeout", "2h", "--json"]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "2h");
    assert.equal(result.jsonFlag, true);
  });

  it("--wait does not affect task title", () => {
    const result = parseWorkflowRunArgs(["My task description", "--wait", "--timeout", "90s"]);
    assert.equal(result.taskTitle, "My task description");
  });

  it("--json without --wait is parsed correctly", () => {
    const result = parseWorkflowRunArgs(["Do something", "--json"]);
    assert.equal(result.wait, false);
    assert.equal(result.jsonFlag, true);
  });

  it("--wait combined with other flags preserves them", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--wait",
      "--timeout", "5m",
      "--context", "branch=fix/x",
      "Build feature",
    ]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "5m");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.deepEqual(result.context, { branch: "fix/x" });
    assert.equal(result.taskTitle, "Build feature");
  });

  it("rejects --timeout with missing value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--timeout"]),
      /Missing value for --timeout/,
    );
  });

  // US-001: Unknown flag rejection
  it("rejects unknown --flag", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["some task", "--unknown-flag", "value"]),
      /Unknown option "--unknown-flag" for workflow run/,
    );
  });

  it("rejects unknown -u short flag", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "-u"]),
      /Unknown option "-u" for workflow run/,
    );
  });

  it("rejects unknown -X short flag", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "-X"]),
      /Unknown option "-X" for workflow run/,
    );
  });

  it("allows bare - as task text", () => {
    const result = parseWorkflowRunArgs(["task", "-", "and-more"]);
    assert.equal(result.taskTitle, "task - and-more");
  });

  it("allows negative numbers as task text", () => {
    const result = parseWorkflowRunArgs(["task", "-42"]);
    assert.equal(result.taskTitle, "task -42");
  });

  it("allows -- separator: everything after goes verbatim to task title", () => {
    const result = parseWorkflowRunArgs(["task", "--", "--still-task", "-x", "--more-flags"]);
    assert.equal(result.taskTitle, "task --still-task -x --more-flags");
  });

  it("-- separator: prefixing task words are preserved", () => {
    const result = parseWorkflowRunArgs(["my task", "--", "--pretend-flag"]);
    assert.equal(result.taskTitle, "my task --pretend-flag");
  });

  it("-- separator: recognized flags after -- become task text", () => {
    const result = parseWorkflowRunArgs(["task", "--", "--wait", "--json"]);
    assert.equal(result.taskTitle, "task --wait --json");
    assert.equal(result.wait, false);
    assert.equal(result.jsonFlag, false);
  });

  it("-- separator with recognized flags before -- still works", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "my task",
      "--",
      "--unknown-flag",
    ]);
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.taskTitle, "my task --unknown-flag");
  });

  it("rejects unknown --flag before -- separator", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--bad-flag", "--", "after-sep"]),
      /Unknown option "--bad-flag" for workflow run/,
    );
  });
});
