import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/*
 * SPL2 structural regression guard.
 *
 * The original SPLC split was silently reverted when a concurrent branch restored
 * the pre-split monolith during conflict resolution. Because behavior stayed
 * identical, behavioral tests could not detect the regression. These assertions
 * make dispatcher growth and reintroduced command implementations fail loudly.
 */
const cliPath = join(process.cwd(), "src/cli/cli.ts");
const cliSource = readFileSync(cliPath, "utf8");

// The post-SPL2 dispatcher is 356 lines. A 465-line ceiling gives about 30%
// headroom for new command routing while remaining far below the former monolith.
const CLI_LINE_CEILING = 465;
const DISPATCHER_FUNCTIONS = ["getUsageText", "printUsage", "main"];

function importedModules(source: string): string[] {
  return [...source.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];/g)]
    .map((match) => match[1]);
}

describe("SPL2 thin CLI dispatcher", () => {
  it("stays below the dispatcher line ceiling", () => {
    const lineCount = cliSource.trimEnd().split("\n").length;

    assert.ok(
      lineCount <= CLI_LINE_CEILING,
      `src/cli/cli.ts grew to ${lineCount} lines (ceiling: ${CLI_LINE_CEILING}); move command logic into src/cli/commands/`,
    );
  });

  it("declares only the three dispatcher orchestration functions", () => {
    const declarations = [...cliSource.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)]
      .map((match) => match[1]);

    assert.deepEqual(
      declarations,
      DISPATCHER_FUNCTIONS,
      "src/cli/cli.ts must not regain command implementation functions; move them into src/cli/commands/",
    );
  });

  it("depends only on command modules, shared CLI utilities, and version status", () => {
    const imports = importedModules(cliSource);
    const unexpected = imports.filter((specifier) =>
      specifier !== "node:sqlite"
      && specifier !== "../lib/version-check.js"
      && specifier !== "./shared.js"
      && !specifier.startsWith("./commands/"),
    );

    assert.deepEqual(unexpected, [], `Command-private dispatcher imports:\n${unexpected.join("\n")}`);
  });

  it("directly imports every production command module", () => {
    const commandModules = readdirSync(join(process.cwd(), "src/cli/commands"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => `./commands/${name.replace(/\.ts$/, ".js")}`)
      .sort();
    const dispatcherCommandImports = importedModules(cliSource)
      .filter((specifier) => specifier.startsWith("./commands/"))
      .sort();

    assert.deepEqual(dispatcherCommandImports, commandModules);
  });

  it("selects only the group and action needed for help and dispatch", () => {
    assert.match(cliSource, /const \[group, action\] = args;/);
    assert.doesNotMatch(cliSource, /const \[group, action, target\] = args;/);
  });

  it("keeps command delegation in the established behavior-preserving order", () => {
    const handlers = [...cliSource.matchAll(/if \((?:await )?(handle\w+)\(/g)]
      .map((match) => match[1]);

    assert.deepEqual(handlers, [
      "handleStandalone",
      "handleMergeBranch",
      "handleGetReady",
      "handleMcp",
      "handleDashboard",
      "handleDaemon",
      "handleRestart",
      "handleStatus",
      "handleStep",
      "handleLogs",
      "handleWorktree",
      "handleAutoresearch",
      "handleWorkflow",
    ]);
  });
});
