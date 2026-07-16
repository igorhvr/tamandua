/**
 * tests/update-protocol-no-generic-cas.test.ts — Runtime export-surface guard.
 *
 * Asserts that the module exports exactly the seven-name allowlist and that
 * casPhase is absent. No child-process, temp DB, shell, daemon, or timer imports.
 * Parallel-lane only; tests/serial-files.txt unchanged.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as protocolModule from "../scripts/update-protocol.mjs";

describe("Export surface: no generic CAS", () => {
  it("exports the seven-name allowlist and casPhase is absent", () => {
    const exports = Object.keys(protocolModule).sort();
    assert.deepEqual(exports, [
      "acquire",
      "captureProcessIdentity",
      "fail",
      "inspect",
      "isGateActive",
      "recordGuardian",
      "validateProcessIdentity",
    ]);
    assert.equal(
      protocolModule.casPhase,
      undefined,
      "casPhase must not be exported",
    );
  });
});
