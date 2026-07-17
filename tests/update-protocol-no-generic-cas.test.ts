/**
 * tests/update-protocol-no-generic-cas.test.ts — Runtime export-surface guard.
 *
 * Asserts that the module exports exactly the seven-name allowlist and that
 * casPhase is absent. No child-process, temp DB, shell, daemon, or timer imports.
 * Parallel-lane only; tests/serial-files.txt unchanged.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as protocolModule from "../scripts/update-protocol.mjs";

const PROTOCOL_SOURCE = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "update-protocol.mjs",
  ),
  "utf8",
);

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

  it("contains no dormant gate-release helper or production DROP sequence", () => {
    assert.doesNotMatch(PROTOCOL_SOURCE, /\bdropGateAndTriggers\b/);
    assert.doesNotMatch(
      PROTOCOL_SOURCE,
      /DROP TRIGGER IF EXISTS trg_update_gate_block_runs_insert[\s\S]*DROP TRIGGER IF EXISTS trg_update_gate_block_runs_update[\s\S]*DROP TABLE IF EXISTS \$\{GATE_TABLE\}/,
    );
  });
});
