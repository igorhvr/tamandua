import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getAutoresearchHelp,
  getAutoresearchInitHelp,
  getAutoresearchLogExperimentHelp,
  getAutoresearchLoopHelp,
  getAutoresearchNextHelp,
  getAutoresearchPruneHelp,
  getAutoresearchRunExperimentHelp,
  getAutoresearchRunLoopIterationHelp,
  getAutoresearchStatusHelp,
  getAutoresearchWizardHelp,
  handleAutoresearch,
} from "../../../dist/cli/commands/autoresearch.js";

describe("SPL2 autoresearch command module", () => {
  it("is backed by a reachable autoresearch command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/autoresearch.ts")), true);
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/autoresearch\.js"/);
  });

  it("owns the autoresearch group and all action help", () => {
    assert.match(getAutoresearchHelp(), /Run durable optimization experiment loops/);
    assert.match(getAutoresearchInitHelp(), /Create an AutoResearch session/);
    assert.match(getAutoresearchRunExperimentHelp(), /Execute the current experiment/);
    assert.match(getAutoresearchLogExperimentHelp(), /Record experiment learning and decision/);
    assert.match(getAutoresearchStatusHelp(), /Summarize the experiment loop/);
    assert.match(getAutoresearchNextHelp(), /Print the next experiment prompt/);
    assert.match(getAutoresearchLoopHelp(), /Run a bounded experiment loop/);
    assert.match(getAutoresearchRunLoopIterationHelp(), /Run a transactional experiment iteration/);
    assert.match(getAutoresearchPruneHelp(), /Remove stale AutoResearch registry rows/);
    assert.match(getAutoresearchWizardHelp(), /Interactive AutoResearch setup wizard/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleAutoresearch("workflow", ["workflow", "list"]), false);
  });
});
