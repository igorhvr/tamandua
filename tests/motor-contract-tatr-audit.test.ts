import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Doc-contract audit for the TATR (token attribution + run identity) work.
// Pins tests/MOTOR-CONTRACT.md: the token-attribution race must no longer
// be claimed out of scope, and the new attribution/identity contracts
// (settle-before-terminal, post-terminal token events, dispatch-run
// attribution, merge run identity, parent linkage) must be documented.

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(__dirname, "MOTOR-CONTRACT.md");

function readContract(): string {
  return readFileSync(contractPath, "utf-8");
}

describe("MOTOR-CONTRACT.md TATR contract audit (US-012)", () => {
  let content: string;

  before(() => {
    assert.ok(readFileSync(contractPath, "utf-8").length > 0);
    content = readContract();
  });

  it("no longer claims the TATR token-attribution race is out of scope", () => {
    // The CNEV-era caveat paragraphs in the run.canceled audit section and
    // C15 used to declare the straggling run.tokens.updated race
    // "explicitly OUT of scope". The cancel path now settles in-flight
    // attribution before the terminal event (US-006), so that phrasing
    // must be gone.
    assert.doesNotMatch(
      content,
      /explicitly\s+OUT\s+of\s+scope/i,
      'MOTOR-CONTRACT.md must not contain "explicitly OUT of scope"'
    );
    assert.doesNotMatch(
      content,
      /TATR[^\n]*out\s+of\s+scope/i,
      "no sentence may claim the TATR race is out of scope"
    );
  });

  it("documents settle-before-terminal for run.canceled", () => {
    assert.match(
      content,
      /Settle-before-terminal\s*\(TATR US-005 \+ US-006\)/,
      "run.canceled audit section must document settle-before-terminal"
    );
    assert.match(
      content,
      /emits `run\.canceled` ONLY after\s+the settle/,
      "the cancel path must be documented as emitting run.canceled only after the settle"
    );
  });

  it("documents post-terminal run.tokens.updated identity", () => {
    assert.match(
      content,
      /postTerminal: true/,
      "must document postTerminal: true on late token flushes"
    );
    assert.match(
      content,
      /terminalStatus/,
      "must document the terminalStatus field on post-terminal flushes"
    );
    assert.match(
      content,
      /consumers may subscribe|subscribe to (those|post-terminal|it)/,
      "must tell consumers they may subscribe to post-terminal token events"
    );
  });

  it("documents dispatch-run attribution and round identity", () => {
    assert.match(
      content,
      /Dispatch-run attribution is authoritative\s*\(TATR US-008\)/,
      "C14 must document authoritative dispatch-run attribution"
    );
    assert.match(
      content,
      /cross_run_metadata_hijack/,
      "C14 must document the cross-run metadata hijack warning"
    );
    assert.match(
      content,
      /`roundId`/,
      "token events must document the roundId identity field"
    );
    assert.match(
      content,
      /`stepId`/,
      "token events must document the stepId identity field"
    );
  });

  it("documents merge event run identity", () => {
    assert.match(
      content,
      /Merge event run identity\s*\(TATR US-003\/US-010\)/,
      "must document merge event run identity"
    );
    assert.match(
      content,
      /TAMANDUA_RUN_ID/,
      "must document the TAMANDUA_RUN_ID env fallback"
    );
    assert.match(
      content,
      /events\/<runId>\.jsonl/,
      "must document that run-scoped merge events land in events/<runId>.jsonl"
    );
    assert.match(
      content,
      /runId: ""/,
      "must document that runless manual merges carry runId \"\""
    );
  });

  it("documents parent/child run linkage", () => {
    assert.match(
      content,
      /Parent\/child run linkage\s*\(TATR US-009\)/,
      "must document parent/child run linkage"
    );
    assert.match(
      content,
      /`runs\.parent_run_id`/,
      "must document the runs.parent_run_id column"
    );
    assert.match(
      content,
      /`parentRunId`/,
      "must document the parentRunId field on run.started"
    );
  });
});
