import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getDoctorHelp,
  getStatusHelp,
  handleStatus,
} from "../../../dist/cli/commands/status.js";

describe("SPL2 status and doctor command module", () => {
  it("owns help for status and doctor", () => {
    assert.match(getStatusHelp(), /tamandua status/);
    assert.match(getStatusHelp(), /Running Processes/);
    assert.match(getDoctorHelp(), /tamandua doctor/);
    assert.match(getDoctorHelp(), /LLM PROMPT/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleStatus("workflow", ["workflow", "status"]), false);
  });
});
