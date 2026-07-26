/**
 * Standalone commands: version, tamandua, skill-path, source-path, update, nudge.
 *
 * These are single-word commands with no subcommands and minimal logic.
 * Extracted from src/cli/cli.ts (SPL2 story US-002).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveSkillPath, resolveSourcePath } from "../../installer/paths.js";
import { getBuildVersion } from "../../lib/version.js";
import { nudgeWithDaemon } from "../../server/control-client.js";
import { runUpdate } from "../update.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "..", "..", "package.json");

const BUILT_VERSION = "__VERSION__";

export function getVersion(): string {
  const buildVersion = getBuildVersion();
  if (buildVersion !== "unknown") return buildVersion;
  if (BUILT_VERSION !== "__VERSION__") return BUILT_VERSION;
  try { const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")); return pkg.version ?? "unknown"; }
  catch { return "unknown"; }
}

export function getVersionHelp(): string {
  return `tamandua version — Display build version

Usage: tamandua version
   or: tamandua --version
   or: tamandua -v

Prints the build version of Tamandua in ISO8601_refhash format.
The version is composed of the UTC timestamp of the HEAD commit
and its full 40-character SHA1 hash, separated by an underscore.
This string is computed at build time and embedded in the dist
output.

Examples:
  tamandua version           # Prints e.g. "20260526T140530Z_4ad4844ff86d37cd04eaf736e8cc43ad467b0338"
  tamandua --version         # Same output
  tamandua -v                # Same output`;
}

export function getTamanduaHelp(): string {
  return `tamandua — ASCII art easter egg

Usage: tamandua tamandua

Prints a large ASCII art representation of a tamandua (anteater) along with
a randomly selected tamandua-themed quote. This is a fun easter egg with no
functional purpose beyond entertainment.

Examples:
  tamandua tamandua          # Print the tamandua ASCII art and a random quote`;
}

export function getSkillPathHelp(): string {
  return `tamandua skill-path — Print path to bundled tamandua-agents skill

Usage: tamandua skill-path

Prints the absolute filesystem path to the bundled tamandua-agents skill
directory. This is the directory containing the AGENTS.md, IDENTITY.md,
and SOUL.md files that are provisioned to workflow agents.

Examples:
  tamandua skill-path        # Prints the skill directory path`;
}

export function getSourcePathHelp(): string {
  return `tamandua source-path — Print Tamandua source checkout path

Usage: tamandua source-path

Prints the absolute filesystem path to the resolved Tamandua source checkout.
This is the directory containing the built dist/, package.json, and
build-and-install script.

Examples:
  tamandua source-path       # Prints the source checkout path`;
}

export function getUpdateHelp(): string {
  return `tamandua update — Pull latest source, rebuild, and reinstall

Usage: tamandua update [--force]

tamandua update is local source maintenance, not a package-manager update.

In order, it does this:

  1. Resolves the installed Tamandua source checkout and verifies it has
     package.json and build-and-install.
  2. Reads current git HEAD.
  3. Runs git pull --ff-only in that checkout. On divergence (local
     ahead or history forked from origin) the update stops before any
     destructive steps, with an actionable message listing recovery
     options. Use --force to skip the pull and rebuild as-is.
  4. Reads git HEAD again.
  5. If HEAD did not change and --force is not set, it stops there: no
     build, no workflow install, no service restart. With --force, it
     continues to rebuild even without source changes.
  6. If HEAD changed, it runs ./build-and-install.
  7. Takes a snapshot of currently running Tamandua services: dashboard
     daemon, standalone MCP, and control plane.
  8. Checks for active runs with status running or paused.
  9. If active runs exist and --force is not set, it exits with code 1
     and leaves services/workflows unchanged.
  10. Otherwise, it stops the services that were running before the
      update.
  11. Installs every bundled workflow (refreshes all installed bundled files — local edits are overwritten).
  12. Restarts only the services that were running before, on their
      previous ports.

Options:
  --force    Continue update despite active runs (step 9). Also forces
             rebuild/reinstall even without source changes (step 5).

Examples:
  tamandua update             # Pull, rebuild, reinstall (blocks if active runs exist)
  tamandua update --force     # Force update even with active runs`;
}

export function getNudgeHelp(): string {
  return `tamandua nudge — Trigger an immediate dispatch round for running runs

Usage: tamandua nudge

Launches an immediate dispatch round for every scheduled agent of every
running run: the scheduler peeks for pending work (a database check — no
model is invoked) and spawns an agent only where a step is ready. Normally
unnecessary — step completions and run starts nudge automatically and a 15s
fallback sweep covers missed nudges — but useful to force a check right
away, e.g. after manual state changes. Does not resume paused runs or
interrupt in-flight agents; idle nudges cost nothing.

Examples:
  tamandua nudge            # Dispatch immediately for all active runs`;
}

/**
 * Handle standalone commands with no subcommands.
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleStandalone(group: string, args: string[]): Promise<boolean> {
  if (group === "version" || group === "--version" || group === "-v") {
    console.log(getVersion()); return true;
  }
  if (group === "tamandua") {
    const { printTamandua } = await import("../ant.js"); printTamandua(); return true;
  }
  if (group === "skill-path") {
    console.log(resolveSkillPath()); return true;
  }
  if (group === "source-path") {
    console.log(resolveSourcePath()); return true;
  }
  if (group === "update") {
    const force = args.includes("--force");
    const unknownArgs = args.slice(1).filter((arg) => arg !== "--force");
    if (unknownArgs.length > 0) {
      process.stderr.write(`Unknown update option: ${unknownArgs[0]}\nUsage: tamandua update [--force]\n`);
      process.exitCode = 1;
      return true;
    }
    const result = await runUpdate({ force });
    if (result.status === "blocked_active_runs" || result.status === "refused_diverged") {
      process.exitCode = 1;
    }
    return true;
  }
  if (group === "nudge") {
    if (args.length > 1) {
      process.stderr.write(`Unknown nudge option: ${args.slice(1).join(" ")}\nUsage: tamandua nudge\n`);
      process.exit(1);
    }
    let response = await nudgeWithDaemon();
    if (response === null) {
      process.stderr.write("Failed to nudge: control plane is not reachable.\n");
      process.exit(1);
    }
    if (response.status !== 200) {
      const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
      process.stderr.write(`Failed to nudge: ${errMsg}\n`);
      process.exit(1);
    }
    const body = response.body;
    const runningRuns = typeof body.runningRuns === "number" ? body.runningRuns : 0;
    if (runningRuns === 0) {
      console.log("No running Tamandua runs to nudge.");
      return true;
    }
    const launched = typeof body.launched === "number" ? body.launched : 0;
    const skippedInFlight = typeof body.skippedInFlight === "number" ? body.skippedInFlight : 0;
    console.log(`Nudged ${runningRuns} running run(s): launched ${launched} agent(s), skipped ${skippedInFlight} in-flight.`);
    return true;
  }
  return false;
}