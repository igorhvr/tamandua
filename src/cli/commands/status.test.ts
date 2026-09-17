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
    assert.match(getStatusHelp(), /--json/);
    assert.match(getDoctorHelp(), /tamandua doctor/);
    assert.match(getDoctorHelp(), /LIVENESS/);
    assert.match(getDoctorHelp(), /LLM PROMPT/);
    assert.match(getDoctorHelp(), /--repair/);
    assert.match(getDoctorHelp(), /tamandua doctor --repair/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleStatus("workflow", ["workflow", "status"]), false);
  });
});

describe("TIME-OUTPUT US-005: tamandua status red-ledger instant is ISO-Z", () => {
  it("normalizes a legacy naive ledgerCreatedAt to an ISO-Z instant", async () => {
    const { formatRunsSummary } = await import("../../../dist/cli/status-format.js");
    const output = formatRunsSummary({
      listRuns: () => [{
        id: "a1010101-0101-0101-0101-010101010101",
        workflowId: "feature-dev-merge",
        task: "task",
        status: "completed",
        createdAt: "2026-09-15 22:00:00",
        updatedAt: "2026-09-15 22:00:00",
        tokensSpent: 0,
        workerLostCount: 0,
        ceilingExpiryCount: 0,
        instantFailCount: 0,
        preclaimDeathCount: 0,
        redLedgerLanding: {
          ledgerRowId: 42,
          exitCode: 7,
          ledgerCreatedAt: "2026-09-15 22:00:00",
        },
      }],
      isDaemonRunning: () => true,
    });
    assert.match(output, /RED LEDGER row 42, exit 7 @ 2026-09-15T22:00:00\.000Z/);
    assert.doesNotMatch(output, /@ 2026-09-15 22:00:00/);
  });
});
