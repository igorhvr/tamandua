import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getStepClaimHelp,
  getStepCompleteHelp,
  getStepFailHelp,
  getStepPeekHelp,
  getStepStoriesHelp,
  handleStep,
} from "../../../dist/cli/commands/step.js";

describe("SPL2 step protocol command module", () => {
  it("is backed by a reachable step command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/step.ts")), true);
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/step\.js"/);
  });

  it("owns all step protocol help", () => {
    assert.match(getStepPeekHelp(), /Output:\n  HAS_WORK/);
    assert.match(getStepClaimHelp(), /On success: \{"stepId":"<UUID>"/);
    assert.match(getStepCompleteHelp(), /reads the agent's output\nfrom either stdin or positional arguments/);
    assert.match(getStepFailHelp(), /"Unknown error" is used/);
    assert.match(getStepStoriesHelp(), /List all stories and their status for a run/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleStep("logs", ["logs"]), false);
  });
});
