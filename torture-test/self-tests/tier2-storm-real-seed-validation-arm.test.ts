// Tier-2 STORM-REAL US-010 — seed-validation arming rule and blocking
// classification (NO daemon/harness/model, NO real tokens).
//
// `tt-storm arm seed-validation` runs the seed tooling's validation routing
// matrix + O12 over the INSTALLED adopted campaign state and applies Igor's
// 2026-09-23 rule. This file pins:
//
//   * the verbatim rule text (a single shared constant) and its presence in
//     the arming output + receipt;
//   * the row classifier (seed-integrity / policy-class / not_run /
//     not_evaluable), including the O12 leg split (R3 timestamp = policy-class
//     product finding; R1/R2/R4/R5 = seed-integrity);
//   * the gate: blocks ONLY on seed-integrity FAIL rows; policy-class FAIL
//     rows are recorded with counts and do NOT block; NOT_RUN/NOT_EVALUABLE
//     rows are carried;
//   * the integration: `runAdoptedSeedValidation` builds the routing matrix
//     over the installed DB (or an injected matrix/O12 seam) and never
//     fabricates an O12 result;
//   * the real CLI: refusal without a prior aged-state adoption, the default
//     routing run over the installed adopted state, the offline
//     `--seed-validation-matrix` replay, and the blocked exit code.
//
// Everything runs under fresh owned temp roots; the only subprocesses are the
// product CLI (prepare) and LOCAL git. Tests remove only their own scratch
// dirs in finally.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  CLASS_NOT_EVALUABLE,
  CLASS_NOT_RUN,
  CLASS_POLICY,
  CLASS_SEED_INTEGRITY,
  SEED_VALIDATION_ARMING_RULE,
  buildSeedValidationArmReceipt,
  buildSeedValidationClassification,
  classifyValidationRow,
  evaluateSeedValidationGate,
  readSeedValidationArmReceipt,
  runAdoptedSeedValidation,
  seedValidationArmReceiptPath,
  sha256File,
  writeSeedValidationArmReceipt,
} from "../bin/tt-storm-seed-validation.mjs";
import { allocateSeedRoot, loadManifest, saveManifest } from "../aged/manifest.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-seedval-${label}-`));
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function childEnvForCli(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runCli(args: string[], varRoot: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 600_000,
    env: childEnvForCli({ TT_VAR: varRoot }),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function preparedCampaign(varRoot: string): { campaignDir: string; state: any } {
  const prepared = runCli(["prepare"], varRoot);
  assert.equal(prepared.status, 0, `scripted prepare must succeed:\n${prepared.stdout}\n${prepared.stderr}`);
  const resultsDir = path.join(varRoot, "results");
  const campaignDir = fs.readdirSync(resultsDir)
    .map((n) => path.join(resultsDir, n))
    .find((p) => fs.existsSync(path.join(p, "state.json")));
  assert.ok(campaignDir, "a prepared campaign dir exists");
  return { campaignDir: campaignDir!, state: loadJson(path.join(campaignDir!, "state.json")) };
}

// Build an owned seed root whose immutable DB snapshot is a COPY of the
// prepared campaign's real product-schema DB (so the routing matrix runs over
// a valid schema once adopted). No baseline sidecar → the O12 leg is honestly
// NOT_EVALUABLE/carried in the fast CLI path.
function makeSeedFromPrepared(scratch: string, preparedDbPath: string) {
  const root = allocateSeedRoot({ baseDir: path.join(scratch, "seeds"), kind: "full", runId: "us010-test" });
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const snapshot = path.join(evidenceDir, "db-full-post-test.sqlite");
  fs.copyFileSync(preparedDbPath, snapshot);
  fs.chmodSync(snapshot, 0o444);
  const eventsDir = path.join(evidenceDir, "events-full-post");
  fs.mkdirSync(eventsDir, { recursive: true });
  const all = path.join(eventsDir, "all.jsonl");
  fs.writeFileSync(all, '{"event":"run.completed"}\n', "utf8");
  const manifest = loadManifest(root);
  manifest.snapshot = {
    db: { file: snapshot, sha256: sha256File(snapshot), sizeBytes: fs.statSync(snapshot).size, mode: 0o444, userVersion: 14 },
    events: { dir: eventsDir, copied: [{ name: "all.jsonl", sha256: sha256File(all) }] },
  };
  saveManifest(root, manifest);
  return { root, snapshot };
}

function minimalInstalledDb(scratch: string): string {
  const dir = path.join(scratch, "installed");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "tamandua.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sentinel (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO sentinel (id) VALUES ('adopted')").run();
  db.close();
  return dbPath;
}

describe("STORM-REAL US-010 seed-validation arming rule and blocking classification", () => {
  it("C1: the Igor 2026-09-23 rule is a single verbatim constant", () => {
    assert.equal(
      SEED_VALIDATION_ARMING_RULE,
      "Seed-validation arming rule (Igor 2026-09-23, verbatim): the gate blocks ONLY on FAIL rows of seed-integrity class (referential breakage, orphaned rows, unreadable events); NOT_RUN/NOT_EVALUABLE rows are carried into the campaign; policy-class product findings (e.g. O12 timestamp legs) are recorded with counts and do not block.",
    );
    for (const needle of ["Igor 2026-09-23", "seed-integrity", "referential breakage", "orphaned rows", "unreadable events", "NOT_RUN/NOT_EVALUABLE", "carried into the campaign", "policy-class", "O12 timestamp legs", "recorded with counts and do not block"]) {
      assert.ok(SEED_VALIDATION_ARMING_RULE.includes(needle), `rule must contain ${needle}`);
    }
  });

  it("C2: classification maps rows to seed-integrity, policy-class or not_run/not_evaluable", () => {
    // Structural oracles' FAIL is seed-integrity and blocks.
    for (const oracle of ["O1", "O4", "O6", "O7"]) {
      const row = classifyValidationRow({ oracle, status: "FAIL", findings: ["x"] });
      assert.equal(row.class, CLASS_SEED_INTEGRITY, `${oracle} FAIL is seed-integrity`);
      assert.equal(row.blocking, true, `${oracle} FAIL blocks`);
    }
    // Structural oracles' PASS is seed-integrity but does not block.
    const ok = classifyValidationRow({ oracle: "O7", status: "PASS" });
    assert.equal(ok.class, CLASS_SEED_INTEGRITY);
    assert.equal(ok.blocking, false);
    // Per-run campaign oracles and O3z arrive NOT_RUN and are carried.
    for (const oracle of ["O2", "O3z", "O8", "O9", "O10", "O11", "O16"]) {
      const row = classifyValidationRow({ oracle, status: "NOT_RUN" });
      assert.equal(row.class, CLASS_NOT_RUN, `${oracle} NOT_RUN is carried`);
      assert.equal(row.blocking, false);
    }
    // O5 needs the recorder layer: NOT_EVALUABLE carried.
    const o5 = classifyValidationRow({ oracle: "O5", status: "NOT_EVALUABLE" });
    assert.equal(o5.class, CLASS_NOT_EVALUABLE);
    assert.equal(o5.blocking, false);
    // O12 structural leg failure is seed-integrity and blocks.
    const o12Structural = classifyValidationRow({ oracle: "O12", status: "FAIL" }, { o12Legs: { R1: "FAIL", R2: "PASS", R3: "PASS", R4: "PASS", R5: "PASS", R6: "FAIL" } });
    assert.equal(o12Structural.class, CLASS_SEED_INTEGRITY);
    assert.equal(o12Structural.blocking, true);
    assert.deepEqual(o12Structural.detail.failing_legs, ["R1"]);
    // O12 timestamp-only failure is policy-class and does NOT block.
    const o12Policy = classifyValidationRow({ oracle: "O12", status: "FAIL" }, { o12Legs: { R1: "PASS", R2: "PASS", R3: "FAIL", R4: "PASS", R5: "PASS", R6: "FAIL" } });
    assert.equal(o12Policy.class, CLASS_POLICY);
    assert.equal(o12Policy.blocking, false);
    assert.deepEqual(o12Policy.detail.policy_legs, ["R3"]);
    // O12 could not execute → carried, never fabricated.
    const o12Error = classifyValidationRow({ oracle: "O12", status: "ERROR" });
    assert.equal(o12Error.class, CLASS_NOT_EVALUABLE);
    assert.equal(o12Error.blocking, false);
    // Unknown oracle FAIL is fail-closed seed-integrity.
    const unknown = classifyValidationRow({ oracle: "O99", status: "FAIL" });
    assert.equal(unknown.class, CLASS_SEED_INTEGRITY);
    assert.equal(unknown.blocking, true);
  });

  it("C3: the gate blocks only on seed-integrity FAIL rows", () => {
    const rows = [
      { oracle: "O1", status: "FAIL", findings: ["O1_GROUP_NONTERMINAL_STEPS_ON_COMPLETED: 3"] },
      { oracle: "O4", status: "PASS" },
      { oracle: "O6", status: "FAIL", findings: ["O6_MISSING_DIRS: 2"] },
      { oracle: "O7", status: "PASS" },
      { oracle: "O2", status: "NOT_RUN" },
      { oracle: "O5", status: "NOT_EVALUABLE" },
      { oracle: "O12", status: "FAIL", findings: ["R3 timestamp uniformity"], leg_results: { R1: "PASS", R3: "FAIL" }, o12_failing_legs: ["R3"] },
    ];
    const classification = buildSeedValidationClassification({ rows });
    assert.equal(classification.blocked, true);
    assert.deepEqual(classification.blocking.map((r: any) => r.oracle).sort(), ["O1", "O6"]);
    assert.equal(classification.tally.seed_integrity.fail, 2);
    assert.equal(classification.tally.seed_integrity.blocking, 2);
    assert.equal(classification.tally.policy_class.fail, 1);
    assert.equal(classification.tally.policy_class.findings, 1);
    assert.equal(classification.tally.not_run, 1);
    assert.equal(classification.tally.not_evaluable, 1);
    assert.equal(classification.carried.length, 2);
    const gate = evaluateSeedValidationGate(classification);
    assert.equal(gate.blocked, true);
    assert.deepEqual(gate.blocked_oracles.sort(), ["O1", "O6"]);
    assert.equal(gate.carried_count, 2);
    assert.equal(gate.policy_finding_count, 1);
    // No structural FAIL → not blocked even with a policy FAIL + carried rows.
    const benign = buildSeedValidationClassification({
      rows: [
        { oracle: "O1", status: "PASS" },
        { oracle: "O12", status: "FAIL", o12_failing_legs: ["R3"] },
        { oracle: "O2", status: "NOT_RUN" },
      ],
    });
    assert.equal(benign.blocked, false);
    assert.equal(evaluateSeedValidationGate(benign).blocked, false);
    assert.equal(benign.carried.length, 1);
  });

  it("C4: a receipt records the verbatim rule, the full matrix and the gate", () => {
    const classification = buildSeedValidationClassification({
      rows: [{ oracle: "O1", status: "FAIL", findings: ["orphaned rows"] }, { oracle: "O5", status: "NOT_EVALUABLE" }],
    });
    const receipt = buildSeedValidationArmReceipt({
      campaignDir: "/tmp/campaign",
      sourceRoot: "/tmp/seed",
      installedDbPath: "/tmp/campaign/db",
      installedDbSha256: "a".repeat(64),
      snapshotSha256: "a".repeat(64),
      classification,
      o12: { result: "NOT_EVALUABLE", failing_legs: null, evidence_dir: null },
      at: "2026-09-23T00:00:00.000Z",
    });
    assert.equal(receipt.kind, "seed-validation");
    assert.equal(receipt.armed, true);
    assert.equal(receipt.launch_free, true);
    assert.equal(receipt.rule, SEED_VALIDATION_ARMING_RULE);
    assert.equal(receipt.gate.blocked, true);
    assert.deepEqual(receipt.gate.blocking_oracles, ["O1"]);
    assert.equal(receipt.classification.rows.length, 2);
    assert.equal(receipt.classification.carried.length, 1);

    // Round-trip through the real writer/reader.
    const scratch = ownedScratch("receipt");
    try {
      const campaignDir = path.join(scratch, "campaign");
      fs.mkdirSync(campaignDir, { recursive: true });
      const written = writeSeedValidationArmReceipt({ campaignDir, receipt });
      assert.equal(written.file, seedValidationArmReceiptPath(campaignDir));
      const read = readSeedValidationArmReceipt({ campaignDir });
      assert.equal(read.rule, SEED_VALIDATION_ARMING_RULE);
      assert.equal(read.gate.blocked, true);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("C5: runAdoptedSeedValidation classifies an injected matrix + O12 legs", async () => {
    const scratch = ownedScratch("inject");
    try {
      const campaignDir = path.join(scratch, "campaign");
      fs.mkdirSync(campaignDir, { recursive: true });
      const dbPath = minimalInstalledDb(scratch);
      const matrix = { rows: [{ oracle: "O1", status: "PASS" }, { oracle: "O2", status: "NOT_RUN" }] };
      const run = await runAdoptedSeedValidation({
        campaignDir,
        execCtx: { db_path: dbPath, state_root: path.join(scratch, "installed") },
        sourceRoot: null,
        matrix,
        o12Legs: { R1: "FAIL", R2: "PASS", R3: "PASS", R4: "PASS", R5: "PASS", R6: "FAIL" },
      });
      assert.equal(run.classification.blocked, true);
      assert.deepEqual(run.classification.blocking.map((r: any) => r.oracle), ["O12"]);
      assert.equal(run.o12.result, "FAIL");
      assert.deepEqual(run.o12.failing_legs, ["R1"]);
      // The O12 row was appended from the O12 legs, not taken from the matrix.
      assert.equal(run.classification.rows.filter((r: any) => r.oracle === "O12").length, 1);

      // skipO12 with an injected matrix records O12 NOT_EVALUABLE/carried.
      const skip = await runAdoptedSeedValidation({
        campaignDir,
        execCtx: { db_path: dbPath, state_root: path.join(scratch, "installed") },
        matrix: { rows: [{ oracle: "O1", status: "PASS" }] },
        skipO12: true,
      });
      assert.equal(skip.classification.blocked, false);
      const o12 = skip.classification.rows.find((r: any) => r.oracle === "O12");
      assert.equal(o12.class, CLASS_NOT_EVALUABLE);
      assert.equal(o12.status, "NOT_EVALUABLE");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("C6: runAdoptedSeedValidation builds the routing matrix over the installed DB", async () => {
    const scratch = ownedScratch("build");
    try {
      const campaignDir = path.join(scratch, "campaign");
      fs.mkdirSync(campaignDir, { recursive: true });
      const dbPath = minimalInstalledDb(scratch);
      let seenSentinel: string | null = null;
      const run = await runAdoptedSeedValidation({
        campaignDir,
        execCtx: { db_path: dbPath, state_root: path.join(scratch, "installed") },
        skipO12: true,
        buildValidationMatrixFn: ({ db }: any) => {
          seenSentinel = db.prepare("SELECT id FROM sentinel").get().id;
          return { rows: [{ oracle: "O1", status: "PASS" }] };
        },
      });
      assert.equal(seenSentinel, "adopted", "the builder must receive the installed DB handle");
      assert.equal(run.classification.blocked, false);
      assert.equal(run.installedDbPath, dbPath);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("C7: the CLI refuses seed-validation without a prior aged-state adoption", () => {
    const scratch = ownedScratch("cli-refuse");
    const varRoot = path.join(scratch, "var");
    try {
      const { campaignDir } = preparedCampaign(varRoot);
      const res = runCli(["arm", "seed-validation", "--campaign", campaignDir], varRoot);
      assert.equal(res.status, 3, `exit 3:\n${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr, /requires a prior .arm aged-state. adoption/);
      assert.equal(fs.existsSync(seedValidationArmReceiptPath(campaignDir)), false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("C8: the CLI runs the routing matrix over the installed adopted state and emits the rule verbatim", () => {
    const scratch = ownedScratch("cli-default");
    const varRoot = path.join(scratch, "var");
    try {
      const { campaignDir, state } = preparedCampaign(varRoot);
      const seed = makeSeedFromPrepared(scratch, state.exec_identity.db_path);
      const armed = runCli(["arm", "aged-state", "--campaign", campaignDir, "--seed-root", seed.root], varRoot);
      assert.equal(armed.status, 0, `arm aged-state exit 0:\n${armed.stdout}\n${armed.stderr}`);

      const res = runCli(["arm", "seed-validation", "--campaign", campaignDir], varRoot);
      assert.equal(res.status, 0, `arm seed-validation exit 0:\n${res.stdout}\n${res.stderr}`);
      assert.ok(res.stdout.includes(`Rule: ${SEED_VALIDATION_ARMING_RULE}`), "the rule is emitted verbatim");
      assert.match(res.stdout, /Seed-integrity: pass=\d+ fail=\d+ blocking=0/);
      assert.match(res.stdout, /Launch-free seed-validation/);
      const receipt = readSeedValidationArmReceipt({ campaignDir });
      assert.equal(receipt.rule, SEED_VALIDATION_ARMING_RULE);
      assert.equal(receipt.gate.blocked, false);
      assert.equal(receipt.installed_db_sha256, sha256File(state.exec_identity.db_path));
      const stateAfter = loadJson(path.join(campaignDir, "state.json"));
      assert.equal(stateAfter.mode, "prepared");
      assert.equal(stateAfter.qualification.real_launch_allowed, false);
      assert.equal(stateAfter.arming["seed-validation"].gate.blocked, false);
      // O12 had no baseline sidecar in this fixture: honestly carried.
      const o12 = receipt.classification.rows.find((r: any) => r.oracle === "O12");
      assert.equal(o12.class, CLASS_NOT_EVALUABLE);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("C9: the CLI --seed-validation-matrix replay blocks a seed-integrity FAIL and records policy findings", () => {
    const scratch = ownedScratch("cli-matrix");
    const varRoot = path.join(scratch, "var");
    try {
      const { campaignDir, state } = preparedCampaign(varRoot);
      const seed = makeSeedFromPrepared(scratch, state.exec_identity.db_path);
      const armed = runCli(["arm", "aged-state", "--campaign", campaignDir, "--seed-root", seed.root], varRoot);
      assert.equal(armed.status, 0, `arm aged-state exit 0:\n${armed.stdout}\n${armed.stderr}`);

      // A seed-integrity FAIL (orphaned rows) blocks with exit 3 and a receipt.
      const blockingFile = path.join(scratch, "blocking-matrix.json");
      fs.writeFileSync(blockingFile, JSON.stringify({ rows: [
        { oracle: "O1", status: "FAIL", findings: ["O1_GROUP_NONTERMINAL_STEPS_ON_COMPLETED: 7"] },
        { oracle: "O5", status: "NOT_EVALUABLE" },
      ] }, null, 2));
      const blocked = runCli(["arm", "seed-validation", "--campaign", campaignDir, "--seed-validation-matrix", blockingFile], varRoot);
      assert.equal(blocked.status, 3, `blocked exit 3:\n${blocked.stdout}\n${blocked.stderr}`);
      assert.match(blocked.stdout, /BLOCKED/);
      assert.ok(blocked.stdout.includes(`Rule: ${SEED_VALIDATION_ARMING_RULE}`));
      const blockedReceipt = readSeedValidationArmReceipt({ campaignDir });
      assert.equal(blockedReceipt.gate.blocked, true);
      assert.deepEqual(blockedReceipt.gate.blocking_oracles, ["O1"]);
      // O5 NOT_EVALUABLE + the appended O12 NOT_EVALUABLE (offline replay skips
      // the oracle) are carried, never fabricated into failures.
      assert.equal(blockedReceipt.classification.carried.length, 2);

      // A policy-class O12 timestamp FAIL does NOT block; the finding is counted.
      const policyFile = path.join(scratch, "policy-matrix.json");
      fs.writeFileSync(policyFile, JSON.stringify({ rows: [
        { oracle: "O1", status: "PASS" },
        { oracle: "O12", status: "FAIL", findings: [{ id: "O12_TIME_MIXED_NATIVE_FORMAT" }], o12_failing_legs: ["R3"] },
        { oracle: "O2", status: "NOT_RUN" },
      ] }, null, 2));
      const policy = runCli(["arm", "seed-validation", "--campaign", campaignDir, "--seed-validation-matrix", policyFile], varRoot);
      assert.equal(policy.status, 0, `policy exit 0:\n${policy.stdout}\n${policy.stderr}`);
      assert.match(policy.stdout, /Policy-class: pass=\d+ fail=1 findings=1/);
      assert.match(policy.stdout, /Carried \(NOT_RUN\/NOT_EVALUABLE\): 1/);
      const policyReceipt = readSeedValidationArmReceipt({ campaignDir });
      assert.equal(policyReceipt.gate.blocked, false);
      assert.equal(policyReceipt.tally.policy_class.fail, 1);
      assert.equal(policyReceipt.classification.carried.length, 1);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});