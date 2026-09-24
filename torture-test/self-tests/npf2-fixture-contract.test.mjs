#!/usr/bin/env node

// npf2-fixture-contract.test.mjs — focused tests for the NPF-2 fixture
// contract machinery (US-013).
//
// Unit-tests the pure parsers/builders/validator and, when the retained gate
// artifacts are present, drives the REAL publisher end-to-end into a unique
// temp output (never the canonical path), validates the shaped contract and
// checks the tamper-detection arms.
//
// It never writes into torture-test/var, never spawns a daemon, never acquires
// the flock and never executes a rehearsal/storm.  It is a `.mjs` self-test and
// therefore NOT part of `npm test`; run it alone with:
//   node --test torture-test/self-tests/npf2-fixture-contract.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CONTRACT_KIND,
  CONTRACT_OUTPUT_PATH,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_SECTIONS,
  CONTENT_PIN_CONSTANT,
  EVIDENCE_COMMAND_CONSTANT,
  EVIDENCE_SOURCE_REL,
  FINAL_SQUASH_NOTE,
  NPF2_BEAD,
  NPF2_TASK,
  PIN_SOURCE_REL,
  buildEvidenceHalf,
  buildFinalSquash,
  classifyRetainedPin,
  parseContentPaths,
  parseObservedFieldsFromStdout,
  parseRetainedDirFromStdout,
  parseSingleQuotedConstant,
  summarizeMergeEvents,
  validateContract,
} from "./npf2-fixture-contract.mjs";
import { main as publishContract } from "./publish-npf2-fixture-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const READINESS_PATH = path.join(REPO_ROOT, "torture-test", "storm-seed-readiness.json");

const EVIDENCE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, EVIDENCE_SOURCE_REL), "utf8");
const PIN_SOURCE = fs.readFileSync(path.join(REPO_ROOT, PIN_SOURCE_REL), "utf8");
// The LIVE pin source: every pin/provenance assertion below is fed from the
// aged validator's own constants (never a retyped literal), so a re-pin moves
// these assertions with it and a stale literal can never keep a test green.
const LIVE_PIN = await import(new URL("../aged/validate.mjs", import.meta.url).href);

const GATE_RESULTS_BASE = "/home/kaladin/matchlock-work/npf2-gate-71af02c8/torture-test/var/results";

/** Candidate results bases, most specific first. */
function candidateResultsBases() {
  const bases = [];
  if (process.env.TAMANDUA_NPF2_RESULTS_BASE) bases.push(process.env.TAMANDUA_NPF2_RESULTS_BASE);
  bases.push(path.join(REPO_ROOT, "torture-test", "var", "results"), GATE_RESULTS_BASE);
  return bases;
}

function hasValidSelfTestsAlone(base) {
  if (!fs.existsSync(base)) return false;
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith("self-tests-alone-")) continue;
    const summaryPath = path.join(base, name, "self-tests-alone-summary.json");
    if (!fs.existsSync(summaryPath)) continue;
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      if (summary.verdict === "PASS" && summary.environment?.guard_safe_repo_root === true) return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

const RESULTS_BASE = candidateResultsBases().find(hasValidSelfTestsAlone) ?? null;

test("the contract requires the five named sections", () => {
  assert.deepEqual([...CONTRACT_SECTIONS], ["design", "evidence", "new_pin", "gates", "final_squash"]);
  assert.equal(CONTRACT_KIND, "npf2-fixture-contract");
  assert.equal(CONTRACT_SCHEMA_VERSION, 1);
  assert.equal(NPF2_TASK, "NPF-2");
  assert.equal(NPF2_BEAD, "tamandua-6sy.58");
});

test("the design command is parsed from the rehearsal engine, never retyped", () => {
  const command = parseSingleQuotedConstant(EVIDENCE_SOURCE, EVIDENCE_COMMAND_CONSTANT);
  assert.equal(command, "{{input.TEST_CMD}}");
  assert.equal(parseSingleQuotedConstant("export const X = 'y';", "MISSING"), null);
});

test("the content-pin paths are parsed from the aged validator, never retyped", () => {
  const paths = parseContentPaths(PIN_SOURCE);
  assert.ok(paths.length >= 9, `expected the documented O12 set, got ${paths.length}`);
  assert.ok(paths.includes("torture-test/oracles/lib/o12.mjs"));
  assert.ok(paths.includes("torture-test/oracles/O12-CONTRACT.md"));
  assert.deepEqual(parseContentPaths("no array here"), []);
});

test("classifyRetainedPin anchors the declared pre-port report to the live pin and rejects anything else", () => {
  const live = {
    content_sha256: "a".repeat(64),
    provenance_commit: "b".repeat(40),
    provenance_subject: "current subject",
    acceptance: "ROOT_ACCEPTED",
  };
  const legacyHash = "c".repeat(64);
  const legacyReport = {
    content_sha256: legacyHash,
    provenance_commit: "d".repeat(40),
    provenance_subject: "pre-port subject",
    acceptance: "ROOT_ACCEPTED",
  };

  const current = classifyRetainedPin({ reportPin: live, validatorPin: live, legacyContentSha256: legacyHash });
  assert.equal(current.ok, true);
  assert.equal(current.kind, "current");

  const legacy = classifyRetainedPin({ reportPin: legacyReport, validatorPin: live, legacyContentSha256: legacyHash });
  assert.equal(legacy.ok, true, legacy.problems.join("; "));
  assert.equal(legacy.kind, "legacy_pre_port");

  // An undeclared pin is not silently accepted.
  const unknown = classifyRetainedPin({
    reportPin: { ...legacyReport, content_sha256: "e".repeat(64) },
    validatorPin: live,
    legacyContentSha256: legacyHash,
  });
  assert.equal(unknown.ok, false);

  // A report claiming the CURRENT pin must agree on every comparable field.
  const drifted = classifyRetainedPin({
    reportPin: { ...live, provenance_commit: "f".repeat(40) },
    validatorPin: live,
    legacyContentSha256: legacyHash,
  });
  assert.equal(drifted.ok, false);

  // A non-64-hex report pin is rejected.
  assert.equal(
    classifyRetainedPin({
      reportPin: { ...legacyReport, content_sha256: "99958d11" },
      validatorPin: live,
      legacyContentSha256: legacyHash,
    }).ok,
    false,
  );
});

test("parseRetainedDirFromStdout / parseObservedFieldsFromStdout read the self-test log", () => {
  const stdout = [
    "US-003 observed: run=run-abc finalize=done reroute=0 landedTree=deadbeef greenRows=1 terminal=completed since=2026-01-01T00:00:00Z",
    "US-003 diagnostics retained at /tmp/owned/suite-ledger-e2e-1",
  ].join("\n");
  assert.equal(parseRetainedDirFromStdout(stdout), "/tmp/owned/suite-ledger-e2e-1");
  const parsed = parseObservedFieldsFromStdout(stdout);
  assert.equal(parsed.fields.run, "run-abc");
  assert.equal(parsed.fields.reroute, "0");
  assert.equal(parsed.fields.landedTree, "deadbeef");
  assert.match(parsed.line, /finalize=done/);
  assert.equal(parseRetainedDirFromStdout("nothing here"), null);
  assert.deepEqual(parseObservedFieldsFromStdout("nothing here"), { line: null, fields: {} });
});

test("summarizeMergeEvents distinguishes first-attempt landing from the refusal corridor", () => {
  const positive = summarizeMergeEvents([
    { event: "run.completed" },
    { event: "merge.landed", stepId: "finalize_merge" },
  ]);
  assert.equal(positive.finalize_merge_rerouted, false);
  assert.equal(positive.ledger_evidence_missing, false);
  assert.equal(positive.landed_without_suite_evidence, false);
  assert.equal(positive.merge_landed, true);

  const negative = summarizeMergeEvents([
    {
      event: "step.rerouted",
      stepId: "finalize_merge",
      ts: "2026-01-01T00:00:00Z",
      detail: "FAILURE_CLASS: refused_permanent\nLedger gate refused finalize_merge: no matching TSTX suite execution exists.\nLEDGER_EVIDENCE: missing",
    },
    { event: "merge.landed_without_suite_evidence", gateMode: "default", treeHash: "abc" },
    { event: "merge.landed" },
  ]);
  assert.equal(negative.finalize_merge_reroute_count, 1);
  assert.equal(negative.finalize_merge_rerouted, true);
  assert.equal(negative.ledger_evidence_missing, true);
  assert.equal(negative.ledger_refusal_failure_class, "refused_permanent");
  assert.equal(negative.landed_without_suite_evidence, true);
  assert.equal(negative.landed_without_suite_evidence_events[0].gateMode, "default");
});

test("buildEvidenceHalf reads the run/tree/suite rows from the retained summary", () => {
  const half = buildEvidenceHalf({
    half: "positive",
    selfTestEntry: { name: "npf2-positive", rel: "x.test.ts", group: "npf2", exit_code: 0, pass: true, totals: { tests: 2, pass: 2, fail: 0 } },
    observedLine: "US-003 observed: run=run-abc finalize=done reroute=0",
    retainedDir: "/tmp/owned/dir",
    runSummary: {
      label: "P1-success",
      observedAt: "2026-01-01T00:00:00Z",
      run: "abc",
      workflowId: "feature-dev-merge-worktree",
      runRow: { status: "completed", context: JSON.stringify({ tested_tree: "tree1", merged_tree: "tree1", merged_commit: "c1" }) },
      finalizeMergeStep: { status: "done", reroute_count: 0, terminal_reroute_count: 0, ledger_concession_count: 0 },
      testStep: { step_id: "test", status: "done" },
      suiteResults: [{ id: 1, exit_code: 0, tree_hash: "tree1", run_id: "abc", step_id: "test", cmd_display: "true" }],
    },
    events: [{ event: "merge.landed", stepId: "finalize_merge" }],
  });
  assert.equal(half.run_status, "completed");
  assert.equal(half.finalize_merge.reroute_count, 0);
  assert.equal(half.green_suite_result_count, 1);
  assert.equal(half.suite_result_tree_matches_landed, true);
  assert.equal(half.tested_tree, "tree1");
});

test("buildFinalSquash records final_squash_hash:null with the content-pin anchor", () => {
  const finalSquash = buildFinalSquash({
    provenanceCommit: "a".repeat(40),
    provenanceSubject: "squash subject",
    contentSha256: "b".repeat(64),
  });
  assert.ok(Object.prototype.hasOwnProperty.call(finalSquash, "final_squash_hash"));
  assert.equal(finalSquash.final_squash_hash, null);
  assert.equal(finalSquash.story_commits_survive_squash, false);
  assert.equal(finalSquash.durable_anchor.kind, "content_sha256");
  assert.equal(finalSquash.durable_anchor.value, "b".repeat(64));
  assert.match(finalSquash.note, /squash/i);
  assert.match(finalSquash.note, /content-addressed/i);
  assert.equal(finalSquash.note, FINAL_SQUASH_NOTE);
});

test("the publisher validates before publishing and never retypes the pin", () => {
  const publisher = fs.readFileSync(path.join(HERE, "publish-npf2-fixture-contract.mjs"), "utf8");
  assert.match(publisher, /const validation = validateContract\(contract\)/);
  assert.match(publisher, /if \(!validation\.ok\)/);
  // The pin is anchored to the validator's parsed constants and the retained
  // report is classified (current vs declared pre-port legacy) before use
  // (fail closed), never retyped.
  assert.match(publisher, /const pinResolution = classifyRetainedPin\(\{/);
  assert.match(publisher, /if \(!pinResolution\.ok\)/);
  assert.match(publisher, /const newPin = buildNewPin\(\{\s*\n\s*pin,/);
  assert.doesNotMatch(publisher, /new_pin\.commit/);
});

test("end-to-end: the publisher writes + validates the contract from retained evidence", async (t) => {
  if (!RESULTS_BASE) return t.skip("no retained self-tests-alone artifacts on this host");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "npf2-contract-us013."));
  const out = path.join(outDir, "npf2-fixture-contract.json");
  try {
    const code = await publishContract([
      "--repo", REPO_ROOT,
      "--results-base", RESULTS_BASE,
      "--readiness", READINESS_PATH,
      "--out", out,
      "--run-id", "us013-test",
    ]);
    assert.equal(code, 0, "publisher must exit 0");
    assert.ok(fs.existsSync(out), "contract file written");
    const contract = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(contract.kind, CONTRACT_KIND);
    assert.equal(contract.schema_version, CONTRACT_SCHEMA_VERSION);
    for (const section of CONTRACT_SECTIONS) assert.ok(section in contract, section);
    assert.equal(contract.design.evidence_command.command, "{{input.TEST_CMD}}");
    assert.equal(contract.new_pin.content_sha256.length, 64);
    assert.equal(contract.new_pin.content_sha256, LIVE_PIN.O12_PINNED_CONTENT_SHA256);
    assert.equal(contract.new_pin.provenance_commit, LIVE_PIN.O12_PINNED_PROVENANCE_COMMIT);
    assert.equal(contract.new_pin.provenance_subject, LIVE_PIN.O12_PINNED_PROVENANCE_SUBJECT);
    assert.equal(contract.new_pin.acceptance, "ROOT_ACCEPTED");
    assert.equal(contract.final_squash.final_squash_hash, null);
    assert.equal(contract.gates.self_tests_alone.verdict, "PASS");
    assert.equal(contract.gates.storm_chain.file_count_observed, 49);
    const validation = validateContract(contract);
    assert.equal(validation.ok, true, validation.problems.join("; "));

    // Red arms: the validator must reject tampering with the load-bearing facts.
    const redArms = [];
    const push = (label, mutate) => {
      const copy = JSON.parse(JSON.stringify(contract));
      mutate(copy);
      redArms.push([label, copy]);
    };
    push("missing section", (c) => delete c.final_squash);
    push("positive rerouted", (c) => {
      c.evidence.positive.finalize_merge.reroute_count = 1;
      c.evidence.positive.events.finalize_merge_rerouted = true;
      c.evidence.positive.events.finalize_merge_reroute_count = 1;
    });
    push("negative has rows", (c) => {
      c.evidence.negative.suite_result_count = 1;
      c.evidence.negative.suite_results = [{ id: 1, exit_code: 0, tree_hash: "t" }];
    });
    push("final hash fabricated", (c) => {
      c.final_squash.final_squash_hash = "a".repeat(40);
    });
    push("content pin truncated", (c) => {
      c.new_pin.content_sha256 = LIVE_PIN.O12_PINNED_CONTENT_SHA256.slice(0, 12);
    });
    push("content pin diverges from anchor", (c) => {
      c.final_squash.durable_anchor.value = "0".repeat(64);
    });
    push("provenance not a full sha", (c) => {
      c.new_pin.provenance_commit = LIVE_PIN.O12_PINNED_PROVENANCE_COMMIT.slice(0, 8);
    });
    push("not root accepted", (c) => {
      c.new_pin.acceptance = "NOT_ROOT_ACCEPTED";
    });
    push("storm chain red", (c) => {
      c.gates.storm_chain.red_file_count = 1;
    });
    push("npf2 group red", (c) => {
      c.gates.self_tests_alone.by_group.npf2 = { total: 2, passed: 1, failed: 1, verdict: "FAIL" };
    });
    push("evidence command drifted", (c) => {
      c.design.evidence_command.command = "npm test";
    });
    for (const [label, tampered] of redArms) {
      const result = validateContract(tampered);
      assert.equal(result.ok, false, `red-arm must be rejected: ${label}`);
    }
    assert.equal(validateContract(null).ok, false, "null contract must be rejected");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("published contract (when present) validates against the live source pin", (t) => {
  if (!fs.existsSync(CONTRACT_OUTPUT_PATH)) {
    return t.skip(`contract not yet published at ${CONTRACT_OUTPUT_PATH}`);
  }
  const contract = JSON.parse(fs.readFileSync(CONTRACT_OUTPUT_PATH, "utf8"));
  // TORTURE-PORT US-006: the host contract at CONTRACT_OUTPUT_PATH was published
  // by the pre-port run under the schema-10 content set.  The schema-9..13
  // re-pin superseded it and the seed is regenerated on this product (out of
  // port scope), so a contract carrying the DECLARED pre-port pin is not
  // evidence about the current pin; it is republished by the regeneration run.
  if (contract?.new_pin?.content_sha256 === LIVE_PIN.O12_PRE_PORT_CONTENT_SHA256) {
    return t.skip(
      `published contract carries the declared pre-port content pin ${LIVE_PIN.O12_PRE_PORT_CONTENT_SHA256.slice(0, 12)}; `
      + "republished on this product by the seed-regeneration run",
    );
  }
  const validation = validateContract(contract);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  const paths = parseContentPaths(PIN_SOURCE);
  assert.deepEqual(contract.new_pin.content_paths, paths);
  assert.equal(contract.new_pin.content_sha256.length, 64);
  assert.equal(contract.new_pin.content_sha256, LIVE_PIN.O12_PINNED_CONTENT_SHA256);
  assert.equal(contract.new_pin.provenance_commit, LIVE_PIN.O12_PINNED_PROVENANCE_COMMIT);
  assert.equal(contract.design.evidence_command.command, "{{input.TEST_CMD}}");
  assert.equal(contract.final_squash.final_squash_hash, null);
  assert.equal(contract.gates.self_tests_alone.verdict, "PASS");
  assert.equal(contract.gates.storm_chain.verdict, "PASS");
  assert.equal(contract.gates.storm_chain.file_count_observed, 49);
});
