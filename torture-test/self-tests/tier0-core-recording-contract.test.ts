// tier0-core-recording-contract.test.ts — CORE US-001 designated gate.
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.1, bounded slice CORE-1, story
// US-001: minimal versioned recording/adaptation contract module and its
// pure format/validation regression.
//
// What this gate proves (all pure, zero tokens, zero daemon/model/fs side
// effects — the module under test is a JSON-only pure ESM library):
//   1. Interface pin: the module exports EXACTLY RECORD_FORMAT_VERSION,
//      hashText, buildRecordingRecord and validateRecordingRecord, and the
//      module source stays pure (node builtins only; no eval / Function /
//      child_process constructs anywhere in the shipped file).
//   2. Positive record built by buildRecordingRecord validates, is
//      deep-frozen, and has a deterministic payloadSha256.
//   3. Corrupt payload hash is rejected with a corrupt-hash error that NAMES
//      the mismatch (computed vs declared); any fact edit without a hash
//      update is equally rejected.
//   4. A reference to an undeclared source locator is rejected as
//      missing-source.
//   5. Sections/locators that declare a runId different from the record's
//      single run are rejected as mixed-run.
//   6. Claims referencing evidence that is absent (operation.evidenceRefs ->
//      unknown observation, expectedOutcome.operationRef -> unknown
//      operation) are rejected as incomplete-claim.
//   7. Records that honestly declare unknown facts are ACCEPTED and the
//      unknowns are surfaced as labeled entries on the ok result — never
//      silently dropped, never promoted to fake certainties.
//   8. Shape/version misuse (wrong version, bad kind, bad unknown reason,
//      duplicate locator ids, non-array sections) fails closed with useful
//      diagnostics.
//
// Synthetic data only: every run id, case id, locator, hash and fact below
// is a fixture string; nothing is copied from the ORIGINAL source inventory
// (torture-test/var/review-logs/core-recording-source-ZFANtD/ lives in the
// ORIGINAL checkout outside this worktree; it was read only as a SHAPE
// reference for the vocabulary — run ids, case ids, locators, sha256 hex
// hashes, exit codes, event types — never into shipped files).
//
// Runs as its own `node --test torture-test/self-tests/tier0-core-recording-
// contract.test.ts` (designated focused gate; single file per invocation)
// and also passes under self-tests/run.sh's tier0 glob. Leaves the git
// working tree clean (no writes at all).
//
// Node >= 22 runs .ts directly; the .mjs module is loaded via dynamic import
// with pathToFileURL (no type-stripping edge cases, no static extension
// resolution needed).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const MODULE_PATH = path.join(repoRoot, "torture-test", "bin", "core-recording-contract.mjs");
const MODULE_URL = pathToFileURL(MODULE_PATH).href;

assert.ok(
  fs.existsSync(MODULE_PATH),
  `cannot find the contract module at ${MODULE_PATH} — run this test from the repo root`,
);

// Known sha256 of the ASCII string "abc" (standard test vector).
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

// ── synthetic fixtures (nothing from the ORIGINAL inventory) ──────────────
const RUN_A = "run-synth-a-00000000-0000-4000-8000-000000000000";
const RUN_B = "run-synth-b-00000000-0000-4000-8000-000000000000";

function synthSha256(label: string): string {
  return createHash("sha256").update(`synthetic:${label}`, "utf8").digest("hex");
}

const LOCATOR_L1 = Object.freeze({
  locatorId: "L1",
  runId: RUN_A,
  locator: {
    source_file: "synth-native-source-index.jsonl",
    row: 63,
    call_id: "call_synth_0001",
  },
  sha256: synthSha256("locator-L1"),
});

const LOCATOR_L2 = Object.freeze({
  locatorId: "L2",
  locator: { source_file: "synth-ledger.jsonl", row: 1528 },
  sha256: synthSha256("locator-L2"),
});

/** Build a fully-valid synthetic record (six sections). */
async function buildValidFixture(overrides: Record<string, unknown> = {}): Promise<any> {
  const mod = await loadContract();
  const sourceIdentity = {
    kind: "pi",
    runId: RUN_A,
    caseId: "SYNTH-CASE-US001",
    sourceRefs: [LOCATOR_L1, LOCATOR_L2],
    sourceSha256: synthSha256("source"),
  };
  const sections = {
    sourceIdentity,
    observations: [
      { id: "obs-1", fact: "ledger row 1528 records npm test exit 0", sourceRef: "L2" },
      { id: "obs-2", fact: { declared: "./run-all-tests", reported: "npm test", exit_code: 0 }, sourceRef: "L1" },
    ],
    transformations: [
      { step: "redact", input: "field X", output: "sanitized", sourceRef: "L2" },
    ],
    operations: [
      { id: "op-1", type: "compare.command_ledger", sourceRef: "L2", evidenceRefs: ["obs-1"] },
    ],
    expectedOutcomes: [
      { id: "oc-1", outcome: "ledger row for the executed command is present", sourceRef: "L2", operationRef: "op-1", evidenceRefs: ["obs-1", "obs-2"] },
    ],
    unknown: [
      { fact: "the single raw stdout byte of the dsh round is not retained", reason: "missing" },
    ],
  };
  const merged = { ...sections, ...overrides };
  return mod.buildRecordingRecord(merged);
}

let contractPromise: Promise<any> | null = null;
function loadContract(): Promise<any> {
  if (contractPromise === null) {
    contractPromise = import(MODULE_URL);
  }
  return contractPromise;
}

function clone(value: any): any {
  return JSON.parse(JSON.stringify(value));
}

async function loadModuleSource(): Promise<string> {
  return fs.readFileSync(MODULE_PATH, "utf8");
}

// ── tests ────────────────────────────────────────────────────────────────

describe("CORE US-001 recording contract module", () => {
  it("pins the exact module interface (RECORD_FORMAT_VERSION, hashText, buildRecordingRecord, validateRecordingRecord)", async () => {
    const mod = await loadContract();
    assert.deepEqual(Object.keys(mod).sort(), [
      "RECORD_FORMAT_VERSION",
      "buildRecordingRecord",
      "hashText",
      "validateRecordingRecord",
    ]);
    assert.equal(mod.RECORD_FORMAT_VERSION, 1);
    assert.equal(typeof mod.hashText, "function");
    assert.equal(typeof mod.buildRecordingRecord, "function");
    assert.equal(typeof mod.validateRecordingRecord, "function");
  });

  it("hashText returns the sha256 hex of the UTF-8 text", async () => {
    const mod = await loadContract();
    assert.equal(mod.hashText("abc"), SHA256_ABC);
    assert.equal(mod.hashText(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.throws(() => mod.hashText(42), TypeError);
  });

  it("module source stays pure: node builtins only, no eval/Function/child_process constructs", async () => {
    const source = await loadModuleSource();
    const importLines = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    assert.ok(importLines.length > 0, "module must have at least one import");
    for (const line of importLines) {
      const specifier = /from\s+["']([^"']+)["']/.exec(line);
      assert.ok(specifier, `cannot parse import specifier: ${line}`);
      assert.ok(
        specifier[1].startsWith("node:"),
        `import outside node builtins: ${specifier[1]} (${line.trim()})`,
      );
    }
    // The shipped module must never contain these constructs — not even in a
    // comment (a strict grep check per the acceptance criteria).
    const forbidden = [
      /\beval\b/,
      /\bnew\s+Function\b/,
      /\bFunction\s*\(/,
      /child_process/,
      /spawnSync|execSync|execFileSync|fork\s*\(/,
    ];
    for (const re of forbidden) {
      assert.equal(re.test(source), false, `module source matches forbidden construct ${re}`);
    }
  });

  it("buildRecordingRecord returns a deep-frozen versioned record with a deterministic payloadSha256", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture();
    assert.equal(record.recordFormatVersion, 1);
    assert.equal(typeof record.payloadSha256, "string");
    assert.match(record.payloadSha256, /^[0-9a-f]{64}$/);
    // Deep-frozen: top level and nested sections.
    assert.ok(Object.isFrozen(record));
    assert.ok(Object.isFrozen(record.sourceIdentity));
    assert.ok(Object.isFrozen(record.observations));
    assert.ok(Object.isFrozen(record.operations));
    assert.ok(Object.isFrozen(record.observations[0]));
    // Deterministic: rebuilding from structurally identical inputs yields the
    // same payload hash.
    const again = await buildValidFixture();
    assert.equal(again.payloadSha256, record.payloadSha256);
    assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(record)));
  });

  it("a positive record validates", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture();
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("a corrupt payload hash is rejected and the error names the mismatch", async () => {
    const mod = await loadContract();
    const record = clone(await buildValidFixture());
    const original = record.payloadSha256;
    // Flip one hex nibble in the declared hash.
    const flipped = original.startsWith("0") ? "f" + original.slice(1) : "0" + original.slice(1);
    record.payloadSha256 = flipped;
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    const err = result.errors.find((e: any) => e.code === "corrupt-hash");
    assert.ok(err, `expected corrupt-hash error, got ${JSON.stringify(result.errors)}`);
    assert.match(err.message, new RegExp(original));
    assert.match(err.message, new RegExp(flipped));
    assert.match(err.message, /mismatch/i);
  });

  it("a payload edit without a hash update is rejected as corrupt-hash", async () => {
    const mod = await loadContract();
    const record = clone(await buildValidFixture());
    record.observations[0].fact = "tampered public fact without hash update";
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e: any) => e.code === "corrupt-hash"), JSON.stringify(result.errors));
  });

  it("a missing-source reference is rejected", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      observations: [
        { id: "obs-1", fact: "ledger row 1528 records npm test exit 0", sourceRef: "L2" },
        { id: "obs-2", fact: "points at a locator that is never declared", sourceRef: "L-NOPE" },
      ],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    const err = result.errors.find((e: any) => e.code === "missing-source");
    assert.ok(err, `expected missing-source error, got ${JSON.stringify(result.errors)}`);
    assert.match(err.message, /L-NOPE/);
  });

  it("an observation with no sourceRef is rejected as missing-source", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      observations: [{ id: "obs-1", fact: "no declared source locator" }],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e: any) => e.code === "missing-source"), JSON.stringify(result.errors));
  });

  it("a mixed-run record (section runId differs from the record run) is rejected", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      observations: [
        { id: "obs-1", fact: "ledger row 1528 records npm test exit 0", sourceRef: "L2", runId: RUN_A },
        { id: "obs-2", fact: { exit_code: 127 }, sourceRef: "L1", runId: RUN_B },
      ],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    const err = result.errors.find((e: any) => e.code === "mixed-run");
    assert.ok(err, `expected mixed-run error, got ${JSON.stringify(result.errors)}`);
    assert.match(err.message, new RegExp(RUN_B));
    assert.match(err.message, new RegExp(RUN_A));
  });

  it("a mixed-run record (locator runId differs from the record run) is rejected", async () => {
    const mod = await loadContract();
    const foreignLocator = {
      locatorId: "L9",
      runId: RUN_B,
      locator: { source_file: "synth-other-run.jsonl", row: 1 },
    };
    const record = await buildValidFixture({
      sourceIdentity: {
        kind: "pi",
        runId: RUN_A,
        caseId: "SYNTH-CASE-US001",
        sourceRefs: [LOCATOR_L1, foreignLocator],
        sourceSha256: synthSha256("source"),
      },
      observations: [{ id: "obs-1", fact: "references the foreign locator", sourceRef: "L9" }],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    const err = result.errors.find((e: any) => e.code === "mixed-run");
    assert.ok(err, `expected mixed-run error, got ${JSON.stringify(result.errors)}`);
    assert.match(err.message, /L9/);
  });

  it("an incomplete claim (operation references an absent evidence observation) is rejected", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      operations: [
        { id: "op-1", type: "compare.command_ledger", sourceRef: "L2", evidenceRefs: ["obs-absent"] },
      ],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    const err = result.errors.find((e: any) => e.code === "incomplete-claim");
    assert.ok(err, `expected incomplete-claim error, got ${JSON.stringify(result.errors)}`);
    assert.match(err.message, /obs-absent/);
  });

  it("an incomplete claim (expectedOutcome references an absent operation) is rejected", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      operations: [],
      expectedOutcomes: [
        { id: "oc-1", outcome: "some outcome", sourceRef: "L2", operationRef: "op-absent" },
      ],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    const err = result.errors.find((e: any) => e.code === "incomplete-claim");
    assert.ok(err, `expected incomplete-claim error, got ${JSON.stringify(result.errors)}`);
    assert.match(err.message, /op-absent/);
  });

  it("an unknown-evidence record is ACCEPTED and the unknowns are surfaced as labeled entries", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      unknown: [
        { fact: "the single raw stdout byte of the dsh round is not retained", reason: "missing" },
        { fact: "native session file was truncated at byte 4096", reason: "truncated" },
        { fact: "exit code 127 vs 0 attribution is ambiguous without PATH context", reason: "ambiguous" },
      ],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.unknowns.length, 3);
    assert.deepEqual(result.unknowns.map((u: any) => u.reason).sort(), ["ambiguous", "missing", "truncated"].sort());
    for (const u of result.unknowns as any[]) {
      assert.equal(u.classification, "unknown");
      assert.equal(typeof u.fact, "string");
      assert.ok(u.fact.length > 0);
    }
  });

  it("a record with zero unknowns validates with exactly {ok:true} and no surfaced list", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({ unknown: [] });
    const result = mod.validateRecordingRecord(record);
    assert.deepEqual(result, { ok: true });
  });

  it("an unsupported record format version is rejected", async () => {
    const mod = await loadContract();
    const record = clone(await buildValidFixture());
    record.recordFormatVersion = 2;
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    const err = result.errors.find((e: any) => e.code === "version");
    assert.ok(err, `expected version error, got ${JSON.stringify(result.errors)}`);
    assert.match(err.message, /2/);
    assert.match(err.message, /1/);
  });

  it("an invalid sourceIdentity.kind is rejected", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      sourceIdentity: {
        kind: "claude",
        runId: RUN_A,
        sourceRefs: [LOCATOR_L1],
        sourceSha256: synthSha256("source"),
      },
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e: any) => e.code === "shape" && /kind/.test(e.path)), JSON.stringify(result.errors));
  });

  it("an unknown reason outside the closed set is rejected", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      unknown: [{ fact: "some unknown fact", reason: "invented" }],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e: any) => e.code === "shape" && /reason/.test(e.path)), JSON.stringify(result.errors));
  });

  it("duplicate sourceRef locator ids are rejected", async () => {
    const mod = await loadContract();
    const dupL1 = { ...clone(LOCATOR_L2), locatorId: "L1" };
    const record = await buildValidFixture({
      sourceIdentity: {
        kind: "pi",
        runId: RUN_A,
        sourceRefs: [LOCATOR_L1, dupL1],
        sourceSha256: synthSha256("source"),
      },
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e: any) => e.code === "shape" && /duplicate sourceRef/.test(e.message)), JSON.stringify(result.errors));
  });

  it("a non-array section is rejected as a shape error", async () => {
    const mod = await loadContract();
    const record = clone(await buildValidFixture());
    record.observations = "not-an-array";
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e: any) => e.code === "shape" && e.path === "$.observations"), JSON.stringify(result.errors));
  });

  it("an operation type that is generalized shell text is rejected", async () => {
    const mod = await loadContract();
    const record = await buildValidFixture({
      operations: [{ id: "op-1", type: "sh -c 'rm -rf /tmp/x'", sourceRef: "L2", evidenceRefs: ["obs-1"] }],
    });
    const result = mod.validateRecordingRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e: any) => e.code === "shape" && /typed op code/.test(e.message)), JSON.stringify(result.errors));
  });

  it("validateRecordingRecord fails closed on a non-object record", async () => {
    const mod = await loadContract();
    for (const bad of [null, 42, "record", [1, 2, 3]]) {
      const result = mod.validateRecordingRecord(bad);
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
      assert.ok(result.errors.some((e: any) => e.code === "shape"), JSON.stringify(result.errors));
    }
  });

  it("buildRecordingRecord throws TypeError on structural misuse", async () => {
    const mod = await loadContract();
    assert.throws(() => mod.buildRecordingRecord({}), TypeError);
    assert.throws(
      () => mod.buildRecordingRecord({ sourceIdentity: { kind: "pi" }, observations: "nope" }),
      TypeError,
    );
  });
});
