// Tier-2 STORM-REAL US-011 — STORM-AGED contract adoption path and arming
// rule clarification (documentation self-test; NO daemon/harness/model/token).
//
// US-009/US-010 implemented the REAL campaign adoption path (`tt-storm arm
// aged-state`) and the seed-validation arming rule (`tt-storm arm
// seed-validation`) in torture-test/bin/tt-storm-arm.mjs and
// torture-test/bin/tt-storm-seed-validation.mjs.  US-011 publishes that
// surface in the STORM-AGED contract (torture-test/aged/docs/STORM-AGED-
// CONTRACT.md) so a future steward can adopt a qualified seed and arm a REAL
// campaign from the document alone.
//
// This self-test is the doc-drift sentinel for that publication.  It asserts:
//   * the contract contains an adoption-path section that names every seed
//     source and campaign destination VERBATIM from the single shared
//     AGED_STATE_ADOPTION_PATH table (imported here, never re-typed);
//   * the contract carries the exact REAL arm commands;
//   * the Igor 2026-09-23 arming rule appears VERBATIM (the single shared
//     SEED_VALIDATION_ARMING_RULE constant) as a spec clarification
//     attributed to Igor 2026-09-23;
//   * prior contract pins (sections 1-5, the O12 content pin, the "never
//     qualification" rule) survive unchanged.
//
// In-process only: it reads two files and imports two pure modules.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { AGED_STATE_ADOPTION_PATH } from "../bin/tt-storm-arm.mjs";
import { SEED_VALIDATION_ARMING_RULE } from "../bin/tt-storm-seed-validation.mjs";

const repoRoot = process.env.TT_REPO_ROOT ?? path.resolve(process.cwd());
const contractPath = path.join(repoRoot, "torture-test", "aged", "docs", "STORM-AGED-CONTRACT.md");

function readContract(): string {
  assert.ok(fs.existsSync(contractPath), `STORM-AGED contract must exist at ${contractPath}`);
  return fs.readFileSync(contractPath, "utf8");
}

// The adoption/arming window: from the "## 6." heading to the end of the
// document (the appended US-011 sections are the tail of the contract).  The
// verbatim rule and arm commands must live in this window, not merely
// somewhere in the file.
function adoptionSection(doc: string): string {
  const marker = "## 6. REAL campaign adoption path and arming";
  const start = doc.indexOf(marker);
  assert.ok(start !== -1, `contract must contain the adoption-path section heading: ${marker}`);
  return doc.slice(start);
}

describe("STORM-REAL US-011 STORM-AGED contract adoption path and arming rule", () => {
  it("D1: the contract names every adoption-path seed source and campaign destination verbatim", () => {
    const doc = readContract();
    const section = adoptionSection(doc);
    assert.ok(AGED_STATE_ADOPTION_PATH.length >= 3, "the adoption table covers db/events/run_worktrees");
    const steps = AGED_STATE_ADOPTION_PATH.map((e: any) => e.step);
    assert.deepEqual(steps, ["db", "events", "run_worktrees"], "the documented adoption steps are db/events/run_worktrees");
    for (const entry of AGED_STATE_ADOPTION_PATH) {
      assert.ok(
        section.includes(entry.source),
        `adoption section must name the seed source verbatim [${entry.step}]: ${entry.source}`,
      );
      assert.ok(
        section.includes(entry.destination),
        `adoption section must name the campaign destination verbatim [${entry.step}]: ${entry.destination}`,
      );
    }
    // The task's source families (snapshot / events / worktree rows) are all named.
    for (const needle of ["snapshot", "events", "run_worktrees"]) {
      assert.ok(section.includes(needle), `adoption section names the ${needle} source`);
    }
  });

  it("D2: the contract records the arming rule verbatim as a spec clarification attributed to Igor 2026-09-23", () => {
    const doc = readContract();
    const section = adoptionSection(doc);
    assert.ok(
      section.includes(SEED_VALIDATION_ARMING_RULE),
      "the exact shared SEED_VALIDATION_ARMING_RULE constant must appear verbatim in the adoption/arming section",
    );
    assert.ok(section.includes("Igor 2026-09-23"), "the rule must be attributed to Igor 2026-09-23");
    assert.ok(/spec\s+clarification/i.test(section), "the rule must be recorded as a spec clarification");
    for (const needle of [
      "seed-integrity",
      "referential breakage",
      "orphaned rows",
      "unreadable events",
      "NOT_RUN/NOT_EVALUABLE",
      "carried into the campaign",
      "policy-class",
      "recorded with counts and do not block",
    ]) {
      assert.ok(section.includes(needle), `rule fragment must be recorded verbatim: ${needle}`);
    }
  });

  it("D3: the contract gives the exact REAL arm commands", () => {
    const section = adoptionSection(readContract());
    for (const cmd of [
      "tt-storm arm aged-state --campaign <campaign-dir> --seed-root <owned-seed-root>",
      "tt-storm arm seed-validation --campaign <campaign-dir>",
      "tt-storm arm seed-validation --campaign <campaign-dir> --seed-validation-matrix <recorded-matrix.json>",
    ]) {
      assert.ok(section.includes(cmd), `contract must record the exact arm command: ${cmd}`);
    }
    assert.ok(section.includes("--profile REAL"), "contract must show the REAL prepare command");
    assert.ok(section.includes("--spend-cap-tokens"), "REAL prepare must document the required spend cap");
    assert.ok(section.includes("launch-free") || section.includes("LAUNCH-FREE"), "contract records that arming is launch-free");
  });

  it("D4: prior contract semantics are intact (no prior pin was reworded away)", () => {
    const doc = readContract();
    for (const needle of [
      "## 1. Command surface",
      "## 2. Module APIs",
      "## 3. Data shape produced",
      "## 4. Validation routing semantics",
      "## 5. Ownership",
      "O12_PINNED_CONTENT_SHA256",
      "d50275466dcb",
      "Missing oracles/evidence are",
      "Only a fully valid seed can arm the real storm.",
      "Owned by STORM-AGED",
    ]) {
      assert.ok(doc.includes(needle), `prior contract pin must remain verbatim: ${needle}`);
    }
  });

  it("D5: the documented rule constant is the exact string the runtime emits", () => {
    const doc = readContract();
    // The constant itself (runtime) — a self-contained re-assert so a rename or
    // whitespace edit inside the module is caught here too.
    assert.ok(
      SEED_VALIDATION_ARMING_RULE.startsWith("Seed-validation arming rule (Igor 2026-09-23, verbatim):"),
      "the shared rule constant keeps its verbatim prefix",
    );
    // The doc must quote that identical constant (substring, single line — a
    // wrapped/rewrapped rule would not match the full string).
    assert.ok(doc.includes(SEED_VALIDATION_ARMING_RULE), "the contract quotes the runtime constant verbatim");
  });
});