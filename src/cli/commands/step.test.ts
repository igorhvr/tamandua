import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getStepClaimHelp,
  getStepCompleteHelp,
  getStepCurrentHelp,
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
    assert.match(getStepCurrentHelp(), /Read-only query for a held step/);
    assert.match(getStepCurrentHelp(), /Exit 0 either way; exit 1 on bad args/);
    assert.match(getStepCompleteHelp(), /reads the agent's output\nfrom either stdin or positional arguments/);
    assert.match(getStepFailHelp(), /"Unknown error" is used/);
    assert.match(getStepStoriesHelp(), /List all stories and their status for a run/);
    assert.match(getStepStoriesHelp(), /--json/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleStep("logs", ["logs"]), false);
  });

  it("getStepCurrentHelp is referenced from cli.ts --help dispatch", () => {
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /getStepCurrentHelp/);
    assert.match(dispatcher, /"current".*printHelp\(getStepCurrentHelp/);
  });
});
