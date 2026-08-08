// Tier-0 doc-integrity gate: the single canonical host-adaptation contract.
//
// Regression net for E2.2: case predicates and the W0.0 host-profile schema
// were never integration-tested against each other, so --include-real was
// vacuously GREEN with every real case blocked. This file pins the DOCUMENTED
// contract so the resolver (US-002) and profile producer (US-003) have one
// authoritative target and can never silently drift again.
//
// The canonical contract (single representation, never diverge):
//   - A toolchain predicate is satisfied iff host-profile.json records
//     `toolchains.<name>.present === true` (Boolean leaf) using the profile's
//     real key names (python3, node, go, rust/cargo, java+maven).
//   - requires.capabilities entries pi/hermes map to harness presence recorded
//     in the host profile (harness.<name>.present).
//   - An honestly-missing capability gates the case NOT_RUN (predicate) with
//     expected/observed evidence; it is never silently skipped, never a failure.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

const SCHEMA = path.join(ttRoot, "cases", "case.schema.json");
const SPEC = path.join(ttRoot, "tamandua-torture-test-spec", "01-environment-and-isolation.md");
const CONTRACT = path.join(ttRoot, "oracles", "CONTRACT.md");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("Host-adaptation contract documentation (US-001)", () => {
  it("case.schema.json documents the canonical boolean-leaf toolchain contract", () => {
    const schema = read(SCHEMA);
    assert.match(schema, /toolchains\.<name>\.present === true/,
      "schema must document toolchains.<name>.present === true as the satisfaction rule");
    assert.match(schema, /using the profile's real key names/i,
      "schema must state the profile's REAL key names");
    assert.match(schema, /rust\/cargo/,
      "schema must reference the profile's real key name rust/cargo");
    assert.match(schema, /buildPassed\/testPassed.*null.*NOT required/i,
      "schema must make clear buildPassed/testPassed are not required for satisfaction");
  });

  it("case.schema.json documents the pi/hermes => harness-presence mapping and NOT_RUN(predicate)", () => {
    const schema = read(SCHEMA);
    assert.match(schema, /harness\.<name>\.present/,
      "schema must map capabilities to harness.<name>.present presence");
    assert.match(schema, /pi.*hermes/i,
      "schema must name pi and hermes as the harness capabilities");
    assert.match(schema, /NOT_RUN\s*\(predicate\)/,
      "schema must state honestly-missing capabilities gate NOT_RUN (predicate)");
    assert.match(schema, /never silently skipped/,
      "schema must state predicates are never silently skipped");
  });

  it("01-environment-and-isolation.md states the single canonical boolean-leaf contract and harness presence recording", () => {
    const spec = read(SPEC);
    assert.match(spec, /CANONICAL host-profile\/predicate contract/,
      "spec must declare a single canonical host-profile/predicate contract");
    assert.match(spec, /toolchains\.<name>\.present === true/,
      "spec must state the boolean-leaf toolchain rule");
    assert.match(spec, /harness\.<name>\.present/,
      "spec must document harness presence recording");
    assert.match(spec, /never installs/i,
      "spec must state W0.0 records presence, never installs");
    assert.match(spec, /NOT_RUN\s*\(predicate\)/,
      "spec must state honest gating to NOT_RUN (predicate)");
  });

  it("oracles/CONTRACT.md references the single canonical contract and forbids divergence", () => {
    const contract = read(CONTRACT);
    assert.match(contract, /Host adaptation \(predicates \/ host profile\)/,
      "CONTRACT.md must carry a host-adaptation section");
    assert.match(contract, /single canonical host-adaptation representation/,
      "CONTRACT.md must declare a single canonical representation");
    assert.match(contract, /forbids any divergent one/,
      "CONTRACT.md must forbid divergent representations");
    assert.match(contract, /toolchains\.<name>\.present === true/,
      "CONTRACT.md must point to the boolean-leaf toolchain rule");
  });

  it("no contract text asserts the old conflicting flat-boolean representation as a valid rule", () => {
    // The E2.2 bug description (impl-tasks/) legitimately quotes the OLD
    // representation as the defect being fixed. Authoritative contract text in
    // the schema and spec must never assert the old form; CONTRACT.md may only
    // quote it in a forbidding/divergent context.
    const oldForm = /toolchains\.(python3|node|go|rust\/cargo|java\+maven)\s*==\s*true/;
    for (const file of [SCHEMA, SPEC]) {
      assert.ok(!oldForm.test(read(file)),
        `${path.relative(ttRoot, file)} must not assert the old flat-boolean representation as a rule`);
    }
    const contract = read(CONTRACT);
    if (oldForm.test(contract)) {
      assert.match(contract, /forbid[s]?.*toolchains\.python3\s*==\s*true|toolchains\.python3\s*==\s*true.*diverges/i,
        "CONTRACT.md may quote the old form only as a forbidden/divergent example");
    }
  });
});
