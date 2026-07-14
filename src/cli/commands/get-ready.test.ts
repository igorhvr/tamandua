import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getGetReadyHelp,
  getUninstallHelp,
  handleGetReady,
} from "../../../dist/cli/commands/get-ready.js";

describe("SPL2 get-ready command module", () => {
  it("owns help for get-ready and full uninstall", () => {
    assert.match(getGetReadyHelp(), /tamandua get-ready/);
    assert.match(getGetReadyHelp(), /three processes are started independently/);
    assert.match(getUninstallHelp(), /tamandua uninstall \[--force\]/);
    assert.match(getUninstallHelp(), /Skip the active-runs check/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleGetReady("doctor", ["doctor"]), false);
  });

  it("declines lifecycle commands with unsupported arguments", async () => {
    assert.equal(await handleGetReady("get-ready", ["get-ready", "--force"]), false);
    assert.equal(await handleGetReady("uninstall", ["uninstall", "unexpected"]), false);
  });
});
