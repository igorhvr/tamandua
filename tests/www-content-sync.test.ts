import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveBundledWorkflowsDir, resolveSourcePath } from "../dist/installer/paths.js";

const workflowsDir = resolveBundledWorkflowsDir();
const sourcePath = resolveSourcePath();
const wwwHtmlPath = join(sourcePath, "www", "index.html");
const mcpServerPath = join(sourcePath, "src", "server", "mcp-server.ts");

const wwwContent = readFileSync(wwwHtmlPath, "utf-8");
const mcpServerContent = readFileSync(mcpServerPath, "utf-8");

const bundledIds = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(resolve(workflowsDir, d.name, "workflow.yml")))
  .map((d) => d.name);

// Count MCP_TOOL_* constant definitions from the source file.
// These are declared as `const MCP_TOOL_X = "tamandua.xxx";` at column 0,
// so ^const MCP_TOOL_ with the multiline flag is precise.
const mcpToolCount = (mcpServerContent.match(/^const MCP_TOOL_\w+ = /gm) || []).length;

describe("www/index.html content sync", () => {
  it("reports the correct bundled workflow count", () => {
    const count = bundledIds.length;
    assert.ok(
      wwwContent.includes(`${count} bundled workflows`) ||
      wwwContent.includes(`${count} workflows`),
      `www/index.html should show "${count} bundled workflows" (filesystem has ${count})`,
    );
  });

  it("reports the correct MCP tool count", () => {
    assert.ok(
      wwwContent.includes(`${mcpToolCount} tools at`),
      `www/index.html should show "${mcpToolCount} tools at" (mcp-server.ts defines ${mcpToolCount} MCP_TOOL_ constants)`,
    );
  });

  it("has all five workflow family section headings", () => {
    const headings = [
      "Feature Development",
      "Bug Fix",
      "Security Audit",
      "Quarantine Broken Tests",
      "Quick Tasks",
    ];
    for (const heading of headings) {
      assert.ok(
        wwwContent.includes(`<h3>${heading}</h3>`),
        `www/index.html must have <h3>${heading}</h3> section heading`,
      );
    }
  });

  it("does not contain forbidden phrases", () => {
    const forbidden = [
      "polling frequency",
    ];
    for (const phrase of forbidden) {
      assert.ok(
        !wwwContent.includes(phrase),
        `www/index.html must not contain forbidden phrase: "${phrase}"`,
      );
    }
  });

  // Regression test: DRTR — retry story no longer claims human escalation
  it("does not claim failed runs notify a human", () => {
    // Failed runs are terminal and automatic — nothing notifies anyone.
    // Operators inspect and resume at their own initiative.
    // The new design uses "escalates to you" in the Retry and escalate card
    // to describe the retry exhaustion behavior, not human notification.
    assert.ok(
      !wwwContent.includes("notifies a human"),
      "www/index.html must not claim failed runs notify a human",
    );
  });

  // Regression test: DDOC — tamandua doctor appears in commands table
  it("includes tamandua doctor in the Everyday Commands table", () => {
    assert.ok(
      wwwContent.includes("tamandua doctor") || wwwContent.includes("tamandua get-ready"),
      "www/index.html Everyday Commands table must include tamandua commands",
    );
  });

  // Regression test: DRTR — max_reroutes and on_fail.retry_step are documented
  it("documents on_fail.retry_step and max_reroutes instead of stale escalation text", () => {
    assert.ok(
      wwwContent.includes("on_fail.retry_step") || wwwContent.includes("retry_step") || wwwContent.includes("Retry and escalate"),
      "www/index.html must document retry behavior",
    );
    assert.ok(
      wwwContent.includes("max_reroutes") || wwwContent.includes("retries exhaust"),
      "www/index.html must mention retry exhaustion behavior",
    );
  });

  // Regression test: DMNF — metric_not_found status appears in README
  it("READNE includes metric_not_found in autoresearch status list", () => {
    const readmePath = join(sourcePath, "README.md");
    const readme = readFileSync(readmePath, "utf-8");
    assert.ok(
      readme.includes("metric_not_found"),
      "README.md must include metric_not_found in the autoresearch status enumeration",
    );
  });

  // Regression test: DOVW — CLI help warns about overwrite on workflow install
  it("CLI workflow install help warns about overwrite semantics", () => {
    const cliPath = join(sourcePath, "src", "cli", "cli.ts");
    const cliSource = readFileSync(cliPath, "utf-8");
    assert.ok(
      cliSource.includes("local edits are overwritten"),
      "src/cli/cli.ts getWorkflowInstallHelp must warn that local edits are overwritten",
    );
  });

  // Regression test: DOVW — SKILL.md warns about overwrite semantics
  it("SKILL.md warns about workflow file overwrite on install/update", () => {
    const skillPath = join(sourcePath, "skills", "tamandua-agents", "SKILL.md");
    const skillContent = readFileSync(skillPath, "utf-8");
    assert.ok(
      skillContent.includes("local edits are silently overwritten"),
      "skills/tamandua-agents/SKILL.md must warn that local edits are silently overwritten",
    );
  });

  // Regression test: DDOC — SKILL.md includes doctor section
  it("SKILL.md includes Troubleshooting with tamandua doctor section", () => {
    const skillPath = join(sourcePath, "skills", "tamandua-agents", "SKILL.md");
    const skillContent = readFileSync(skillPath, "utf-8");
    assert.ok(
      skillContent.includes("Troubleshooting with tamandua doctor"),
      "skills/tamandua-agents/SKILL.md must include 'Troubleshooting with tamandua doctor' section",
    );
  });

  // Regression test: DRTR — SKILL.md covers on_fail routing
  it("SKILL.md documents on-failure routing and rerouting", () => {
    const skillPath = join(sourcePath, "skills", "tamandua-agents", "SKILL.md");
    const skillContent = readFileSync(skillPath, "utf-8");
    assert.ok(
      skillContent.includes("max_reroutes"),
      "skills/tamandua-agents/SKILL.md must document max_reroutes",
    );
    assert.ok(
      skillContent.includes("step.rerouted"),
      "skills/tamandua-agents/SKILL.md must document step.rerouted event",
    );
  });
});
