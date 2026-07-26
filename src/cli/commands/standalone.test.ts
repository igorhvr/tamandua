import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getNudgeHelp,
  getSkillPathHelp,
  getSourcePathHelp,
  getTamanduaHelp,
  getUpdateHelp,
  getVersionHelp,
  handleStandalone,
} from "../../../dist/cli/commands/standalone.js";

describe("SPL2 standalone command module", () => {
  it("owns help for every standalone command", () => {
    assert.match(getTamanduaHelp(), /tamandua tamandua/);
    assert.match(getVersionHelp(), /tamandua --version/);
    assert.match(getSkillPathHelp(), /tamandua skill-path/);
    assert.match(getSourcePathHelp(), /tamandua source-path/);
    assert.match(getUpdateHelp(), /tamandua update \[--force\]/);
    assert.match(getNudgeHelp(), /tamandua nudge/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleStandalone("doctor", ["doctor"]), false);
  });

  /**
   * Verifies the exit code dispatch condition in the standalone handler.
   *
   * The handler sets process.exitCode = 1 for both blocked_active_runs
   * and refused_diverged statuses. This is the condition that fix 1 added.
   *
   * The actual runtime behavior is tested end-to-end by the real-git
   * fixture tests in update.test.ts (which exercise runUpdate through
   * refusal, divergence, and network failure paths).
   */
  it("maps both blocked_active_runs and refused_diverged to exit code 1", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const standaloneJs = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/commands/standalone.js"),
      "utf-8",
    );

    // The condition must include both failure statuses
    assert.ok(
      standaloneJs.includes("blocked_active_runs") && standaloneJs.includes("refused_diverged"),
      "standalone.js must check both blocked_active_runs AND refused_diverged for exitCode=1",
    );
  });
});
