// NPF-2 (US-008) — documentation pins for the content-addressed O12 pin and
// the scripted suite-ledger evidence step.
//
// The O12-REPIN/NPF-2 work replaced the unreachable pre-squash commit pin
// (064e9cb5, killed by the merge-worktree squash) with a CONTENT-addressed
// pin, and made the scripted rehearsal test step record real shim-backed
// suite-ledger evidence so the FIRST finalize_merge attempt lands.  Those
// facts now live in prose, so this test keeps the prose from drifting:
//
//   * aged/docs/STORM-AGED-CONTRACT.md and aged/README.md name the content
//     pin + provenance commit, state the squash-survival property, and do NOT
//     resurrect the dead commit pin on a current-pin line;
//   * 08-wave-4-fault-injection.md and 12-runner-automation.md document the
//     shim-backed evidence, the negative configuration, the no-fabrication
//     rule and the first-attempt landing;
//   * the content pin the docs quote is the SAME value exported by
//     aged/validate.mjs (cross-checked, never retyped from memory).
//
// Fast + read-only (no daemon, no harness, no model, no ports, no writes).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

const validateSource = read("torture-test/aged/validate.mjs");
const agedContract = read("torture-test/aged/docs/STORM-AGED-CONTRACT.md");
const agedReadme = read("torture-test/aged/README.md");
const wave4 = read("torture-test/tamandua-torture-test-spec/08-wave-4-fault-injection.md");
const runnerAutomation = read("torture-test/tamandua-torture-test-spec/12-runner-automation.md");

/** Parse `export const NAME = "..."` out of the validator source. */
function parseConst(name: string): string {
  const match = new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`).exec(validateSource);
  assert.ok(match, `validate.mjs must export ${name}`);
  return match[1] as string;
}

const CONTENT_SHA = parseConst("O12_PINNED_CONTENT_SHA256");
const PROVENANCE_COMMIT = parseConst("O12_PINNED_PROVENANCE_COMMIT");
const PROVENANCE_SUBJECT = parseConst("O12_PINNED_PROVENANCE_SUBJECT");
const CONTENT_PREFIX = CONTENT_SHA.slice(0, 12);
const PROVENANCE_SHORT = PROVENANCE_COMMIT.slice(0, 8);

describe("NPF-2 US-008 documentation pins", () => {
  it("the validator's content pin is a full 64-hex SHA-256", () => {
    assert.match(CONTENT_SHA, /^[0-9a-f]{64}$/);
    assert.match(PROVENANCE_COMMIT, /^[0-9a-f]{40}$/);
    assert.ok(PROVENANCE_SUBJECT.length > 0);
  });

  describe("aged docs carry the content pin, not the pre-squash commit", () => {
    for (const [name, doc] of [
      ["docs/STORM-AGED-CONTRACT.md", agedContract],
      ["README.md", agedReadme],
    ] as const) {
      it(`${name} names O12_PINNED_CONTENT_SHA256 and its value`, () => {
        assert.ok(doc.includes("O12_PINNED_CONTENT_SHA256"), `${name}: content pin constant`);
        assert.ok(doc.includes(CONTENT_PREFIX), `${name}: content pin prefix ${CONTENT_PREFIX}`);
      });

      it(`${name} names the provenance commit as provenance, not the pin`, () => {
        assert.ok(doc.includes(PROVENANCE_SHORT), `${name}: provenance commit ${PROVENANCE_SHORT}`);
        assert.match(doc, /provenance/i, `${name}: must label the commit as provenance`);
      });

      it(`${name} states the content pin survives merge-worktree squashes`, () => {
        assert.match(doc, /content[- ]?address|content[ -]pin|SHA-256 (of|over) the O12/i,
          `${name}: must describe the content-addressed pin`);
        assert.match(doc, /SHA-256/i, `${name}: must name the content hash function`);
        assert.match(doc, /squash/i, `${name}: must state the squash-survival property`);
      });

      it(`${name} no longer names the dead pre-squash pin on a current-pin line`, () => {
        assert.ok(!doc.includes("064e9cb5"),
          `${name}: the unreachable pre-squash commit must not be presented as the pin`);
      });
    }
  });

  describe("wave-4 / runner docs document the scripted suite-ledger evidence", () => {
    it("08-wave-4 documents NPF-2, the shim seam and the first-attempt landing", () => {
      assert.match(wave4, /NPF-2/, "08: must carry the NPF-2 traceability marker");
      assert.ok(wave4.includes("{{input.TEST_CMD}}"), "08: must name the shim-wrapped TEST_CMD");
      assert.match(wave4, /tamandua-test/, "08: must name the tamandua-test shim");
      assert.match(wave4, /suite_results/, "08: must name the ledger row");
      assert.match(wave4, /LEDGER_EVIDENCE: missing/, "08: must name the gate refusal");
      assert.match(wave4, /first[- ]attempt|first `finalize_merge`|first finalize_merge/i,
        "08: must state the first-attempt landing requirement");
    });

    it("08-wave-4 documents the negative configuration as omitting the command", () => {
      assert.match(wave4, /suiteEvidence:\s*false/, "08: must name the negative configuration");
      assert.match(wave4, /omit/i, "08: must state the command is omitted");
    });

    it("08-wave-4 forbids fabricating ledger evidence", () => {
      assert.match(wave4, /fabricat/i, "08: must forbid fabricated evidence");
      assert.match(wave4, /(only|never)[^.\n]*(shim|execut)|shim[^.\n]*only/i,
        "08: must state that only the shim execution writes evidence");
    });

    it("12-runner-automation documents the same scripted evidence contract", () => {
      assert.match(runnerAutomation, /NPF-2/, "12: must carry the NPF-2 marker");
      assert.match(runnerAutomation, /tamandua-test/, "12: must name the shim");
      assert.match(runnerAutomation, /suite_results|suite-ledger/, "12: must name the ledger");
      assert.match(runnerAutomation, /never fabricated/i, "12: must forbid fabricated evidence");
      assert.match(runnerAutomation, /suiteEvidence:\s*false|negative configuration/i,
        "12: must document the negative configuration");
    });
  });
});
