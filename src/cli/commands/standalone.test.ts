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
});
