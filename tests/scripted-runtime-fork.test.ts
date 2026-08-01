import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const runtimesDir = path.join(
  repoRoot,
  "torture-test",
  "scripted-runtimes",
);

const expectedFiles = [
  "runtime-pi.mjs",
  "runtime-hermes.mjs",
  "runtime-shared.mjs",
  "database.mjs",
  "FROZEN_SHA",
];

describe("scripted-runtimes fork (US-001)", () => {
  it("torture-test/scripted-runtimes/ directory exists", () => {
    assert.ok(
      fs.statSync(runtimesDir).isDirectory(),
      "torture-test/scripted-runtimes/ must be a directory",
    );
  });

  for (const file of expectedFiles) {
    it(`${file} exists`, () => {
      const filePath = path.join(runtimesDir, file);
      assert.ok(
        fs.existsSync(filePath),
        `${file} must exist in torture-test/scripted-runtimes/`,
      );
    });
  }

  it("FROZEN_SHA contains a valid 40-char hex commit hash", () => {
    const sha = fs
      .readFileSync(path.join(runtimesDir, "FROZEN_SHA"), "utf-8")
      .trim();
    assert.match(
      sha,
      /^[0-9a-f]{40}$/,
      "FROZEN_SHA must be a 40-character hex string",
    );
  });

  it("FROZEN_SHA is an ancestor of HEAD (the commit whose e2e fakes were forked)", () => {
    const recorded = fs
      .readFileSync(path.join(runtimesDir, "FROZEN_SHA"), "utf-8")
      .trim();
    // Verify it's a valid commit
    execSync(`git cat-file -t ${recorded}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Verify it's an ancestor of HEAD (invariant regardless of how many commits are added on top)
    execSync(`git merge-base --is-ancestor ${recorded} HEAD`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });
  });

  it("all .mjs files pass syntax check (node --check)", () => {
    for (const file of ["runtime-pi.mjs", "runtime-hermes.mjs", "runtime-shared.mjs", "database.mjs"]) {
      const filePath = path.join(runtimesDir, file);
      execSync(`${process.execPath} --check ${JSON.stringify(filePath)}`, {
        cwd: runtimesDir,
        encoding: "utf-8",
      });
    }
  });

  it("runtime-pi.mjs imports are adjusted (no old paths)", () => {
    const content = fs.readFileSync(
      path.join(runtimesDir, "runtime-pi.mjs"),
      "utf-8",
    );
    assert.ok(
      !content.includes("scripted-agent-runtime-shared.mjs"),
      "runtime-pi.mjs must not reference old shared module path",
    );
    assert.ok(
      content.includes("./runtime-shared.mjs"),
      "runtime-pi.mjs must import ./runtime-shared.mjs",
    );
  });

  it("runtime-hermes.mjs imports are adjusted (no old paths)", () => {
    const content = fs.readFileSync(
      path.join(runtimesDir, "runtime-hermes.mjs"),
      "utf-8",
    );
    assert.ok(
      !content.includes("scripted-agent-runtime-shared.mjs"),
      "runtime-hermes.mjs must not reference old shared module path",
    );
    assert.ok(
      content.includes("./runtime-shared.mjs"),
      "runtime-hermes.mjs must import ./runtime-shared.mjs",
    );
    assert.ok(
      !content.includes("e2e-database.mjs"),
      "runtime-hermes.mjs must not reference old database path",
    );
    assert.ok(
      content.includes("./database.mjs"),
      "runtime-hermes.mjs must import ./database.mjs",
    );
  });

  it("runtime-shared.mjs exports all expected functions", async () => {
    const mod = await import(
      path.join(runtimesDir, "runtime-shared.mjs")
    );
    const expected = [
      "applyBehaviorActions",
      "behaviorForInvocation",
      "claimStep",
      "completeStep",
      "createCli",
      "failStep",
      "fatal",
      "loadBehaviors",
      "logInvocation",
      "nextWorkIndex",
      "parseInputVars",
      "parsePrompt",
      "peekStep",
      "substitute",
    ];
    for (const name of expected) {
      assert.ok(
        name in mod,
        `runtime-shared.mjs must export ${name}`,
      );
    }
  });

  it("database.mjs exports openE2eDatabase", async () => {
    const mod = await import(
      path.join(runtimesDir, "database.mjs")
    );
    assert.ok(
      typeof mod.openE2eDatabase === "function",
      "database.mjs must export openE2eDatabase",
    );
  });

  it("files outside torture-test/ are unmodified (e2e-tests/ clean)", () => {
    const diff = execSync("git diff HEAD -- e2e-tests/", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    assert.equal(
      diff,
      "",
      "e2e-tests/ must not be modified by the fork",
    );
  });

  it("forked .mjs files are byte-identical to originals except for import adjustments", () => {
    // diff exits 1 when files differ, so we capture stdout instead of relying on exit code
    const runDiff = (orig: string, fork: string): string => {
      try {
        return execSync(`diff ${orig} ${fork}`, {
          cwd: repoRoot, encoding: "utf-8", maxBuffer: 1024 * 1024,
        }).trim();
      } catch (e: any) {
        // diff exits 1 when files differ — that's expected when we have import changes
        return (e.stdout ?? "").trim();
      }
    };

    // Runtime-pi.mjs has US-003 (shortAgent → agentId) and US-004 (fault
    // injection knobs) modifications. Use KNOB-REGION markers in the forked
    // file to exclude intentional additions from the diff check.
    const piDiff = runDiff(
      "e2e-tests/helpers/scripted-agent-runtime.mjs",
      "torture-test/scripted-runtimes/runtime-pi.mjs",
    );
    if (piDiff) {
      let inKnobRegion = false;
      const nonKnobDiffs = [];
      for (const line of piDiff.split("\n")) {
        // Only check modified lines (additions or deletions)
        if (!line.startsWith("<") && !line.startsWith(">")) continue;

        // Skip empty diff lines (just the direction marker)
        const trimmed = line.slice(2); // strip "< " or "> " prefix
        if (trimmed === "") continue;

        // Track KNOB-REGION state for US-004 additions
        if (trimmed.includes("KNOB-REGION-BEGIN")) { inKnobRegion = true; continue; }
        if (trimmed.includes("KNOB-REGION-END")) { inKnobRegion = false; continue; }
        if (inKnobRegion) continue;
        // Also skip KNOB-REGION marker lines that don't toggle state
        if (trimmed.includes("KNOB-REGION") || trimmed.includes("═══")) continue;

        // US-003 changes: shortAgent / agentId key updates
        if (trimmed.includes("shortAgent") || trimmed.includes("agentId")) continue;

        // US-004 provider_error check (inserted before mode checks)
        if (trimmed.includes("provider_error") || trimmed.includes("handleProvider")) continue;

        // Import path adjustments (US-001)
        if (trimmed.includes("scripted-agent-runtime-shared.mjs")) continue;
        if (trimmed.includes("runtime-shared.mjs")) continue;

        nonKnobDiffs.push(line);
      }
      assert.equal(
        nonKnobDiffs.length,
        0,
        `runtime-pi.mjs has unexpected diffs beyond import + US-003/US-004 changes:\n${nonKnobDiffs.join("\n")}`,
      );
    }

    const hermesDiff = runDiff(
      "e2e-tests/helpers/scripted-hermes-runtime.mjs",
      "torture-test/scripted-runtimes/runtime-hermes.mjs",
    );
    if (hermesDiff) {
      let inKnobRegion = false;
      const nonImportDiffs = [];
      for (const line of hermesDiff.split("\n")) {
        if (!line.startsWith("<") && !line.startsWith(">")) continue;

        const trimmed = line.slice(2);
        if (trimmed === "") continue;

        // KNOB-REGION tracking for US-005 additions
        if (trimmed.includes("KNOB-REGION-BEGIN")) { inKnobRegion = true; continue; }
        if (trimmed.includes("KNOB-REGION-END")) { inKnobRegion = false; continue; }
        if (inKnobRegion) continue;
        if (trimmed.includes("KNOB-REGION") || trimmed.includes("═══")) continue;

        // US-005 knob-related changes
        if (trimmed.includes("emitOversizedStdout") || trimmed.includes("emitMalformedSessionId")) continue;
        if (trimmed.includes("writeBogusSessionRow") || trimmed.includes("handleProviderError")) continue;
        if (trimmed.includes("scheduleSessionTrailer") || trimmed.includes("_exitPending")) continue;
        if (trimmed.includes("maybeExit") || trimmed.includes("provider_error")) continue;
        if (trimmed.includes("hasKnobs") || trimmed.includes("behavior.malformed_trailer")) continue;
        if (trimmed.includes("behavior.omit_trailer") || trimmed.includes("oversized_stdout_mb")) continue;
        if (trimmed.includes("behavior.delayed_trailer_ms")) continue;

        // Import path adjustments (US-001)
        if (trimmed.includes("scripted-agent-runtime-shared.mjs")) continue;
        if (trimmed.includes("runtime-shared.mjs")) continue;
        if (trimmed.includes("e2e-database.mjs")) continue;
        if (trimmed.includes("database.mjs")) continue;

        // US-003: shortAgent/agentId key changes
        if (trimmed.includes("shortAgent")) continue;
        if (trimmed.includes("agentId")) continue;

        // US-005: baseline comment outside KNOB-REGION
        if (trimmed.includes("Baseline path")) continue;

        nonImportDiffs.push(line);
      }
      assert.equal(
        nonImportDiffs.length,
        0,
        `runtime-hermes.mjs has unexpected diffs beyond import + US-003/US-005 changes:\n${nonImportDiffs.join("\n")}`,
      );
    }

    // runtime-shared.mjs has behavioral modifications (US-003 behaviors lookup
    // priority change), so it's no longer byte-identical. Verify only that
    // the diff consists of the expected behavior-for-invocation change.
    const sharedDiff = runDiff(
      "e2e-tests/helpers/scripted-agent-runtime-shared.mjs",
      "torture-test/scripted-runtimes/runtime-shared.mjs",
    );
    if (sharedDiff) {
      const nonBehaviorDiffs = sharedDiff
        .split("\n")
        .filter((line: string) => line.startsWith("<") || line.startsWith(">"))
        .filter(
          (line: string) =>
            !line.includes("behaviorForInvocation") &&
            !line.includes("Full workflowId_agentId") &&
            !line.includes("Tries shortAgent") &&
            !line.includes("backward") &&
            !line.includes("shortAgent") &&
            !line.includes("agentId"),
        );
      assert.equal(
        nonBehaviorDiffs.length,
        0,
        `runtime-shared.mjs has unexpected diffs beyond behaviorForInvocation change:\n${nonBehaviorDiffs.join("\n")}`,
      );
    }

    const dbDiff = runDiff(
      "e2e-tests/helpers/e2e-database.mjs",
      "torture-test/scripted-runtimes/database.mjs",
    );
    assert.equal(
      dbDiff,
      "",
      "database.mjs must be byte-identical to e2e-database.mjs",
    );
  });
});
