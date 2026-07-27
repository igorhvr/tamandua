import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { closeDb, getDb } from "../../dist/db.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { claimStep, completeStep } from "../../dist/installer/step-ops.js";
import { loadWorkflowSpecSync } from "../../dist/installer/workflow-spec.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import { computeCmdHash, getOriginRepo } from "../../dist/suite/tree-hash.js";

const WORKFLOW_ID = "test-ledger-gate-enforcement";
const TEST_CMD = "npm test -- --runInBand ";
const TESTED_TREE = "0123456789abcdef0123456789abcdef01234567";
const TESTER_OUTPUT = `STATUS: done\nTESTED_TREE: ${TESTED_TREE}`;
const WORKFLOW_YAML = `
id: ${WORKFLOW_ID}
agents:
  - id: tester
    workspace:
      baseDir: .
      files: {}
  - id: merger
    workspace:
      baseDir: .
      files: {}
steps:
  - id: test
    agent: tester
    input: Test
    expects: "STATUS: done"
  - id: finalize_merge
    agent: merger
    input: Merge
    expects: "STATUS: done"
    max_retries: 0
    on_fail:
      retry_step: test
      max_reroutes: 8
      retry_on: [target_moved, conflicts]
`;

type GateMode = "default" | "green" | "off";
type Evidence = "green" | "red" | "missing";

describe("finalize_merge ledger gate enforcement", () => {
  let fixtureRoot: string;
  let repo: string;
  let stateRoot: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  before(() => {
    fixtureRoot = tamanduaTempDir("tamandua-ledger-enforcement-repo-");
    repo = path.join(fixtureRoot, "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ledger-gate@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Ledger Gate Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  });

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateRoot = tamanduaTempDir("tamandua-ledger-enforcement-state-");
    process.env.HOME = stateRoot;
    process.env.TAMANDUA_STATE_DIR = path.join(stateRoot, ".tamandua");
    process.env.TAMANDUA_DB_PATH = path.join(stateRoot, ".tamandua", "tamandua.db");
    assertStatePathIsolation(process.env.TAMANDUA_STATE_DIR, "ledger gate enforcement test state");
    assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "ledger gate enforcement test database");
    fs.mkdirSync(path.join(process.env.TAMANDUA_STATE_DIR, "workflows", WORKFLOW_ID), { recursive: true });
    fs.writeFileSync(
      path.join(process.env.TAMANDUA_STATE_DIR, "workflows", WORKFLOW_ID, "workflow.yml"),
      WORKFLOW_YAML,
    );
    assert.equal(
      loadWorkflowSpecSync(path.join(process.env.TAMANDUA_STATE_DIR, "workflows", WORKFLOW_ID)).id,
      WORKFLOW_ID,
    );
    closeDb();
    getDb();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function seedRun(
    mode: GateMode,
    evidence: Evidence,
    options: { attested?: boolean; wrappedTestCmd?: boolean } = {},
  ) {
    const db = getDb();
    const suffix = Math.random().toString(16).slice(2);
    const runId = `lgat-${suffix}`;
    const testerId = `tester-${suffix}`;
    const finalizeId = `finalize-${suffix}`;
    const context: Record<string, string> = {
      repo,
      test_cmd: options.wrappedTestCmd ? `tamandua-test -- '${TEST_CMD}'` : TEST_CMD,
      launch_actor: "integration-test",
    };
    if (options.wrappedTestCmd) context.test_cmd_raw = TEST_CMD;
    if (mode !== "default") context.merge_gate = mode;
    const createdAt = "2026-07-26T12:34:56.000Z";

    db.prepare(
      `INSERT INTO runs
         (id, run_number, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 42, ?, 'task', 'running', ?, ?, ?)`,
    ).run(runId, WORKFLOW_ID, JSON.stringify(context), createdAt, createdAt);
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          output, type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'test', 'tester', 0, 'Test', 'STATUS: done', 'done', ?, 'single', 0, 0, 0, ?, ?)`,
    ).run(testerId, runId, options.attested === false ? "STATUS: done" : TESTER_OUTPUT, createdAt, createdAt);
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', 'merger', 1, 'Merge', 'STATUS: done', 'pending',
          'single', 0, 0, 0, ?, ?)`,
    ).run(finalizeId, runId, createdAt, createdAt);

    let row: { id: number; exitCode: number; createdAt: string } | null = null;
    if (evidence !== "missing") {
      const exitCode = evidence === "green" ? 0 : 17;
      const rowCreatedAt = "2026-07-26T12:35:00.000Z";
      const inserted = db.prepare(
        `INSERT INTO suite_results
           (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms,
            log_tail, run_id, step_id, created_at)
         VALUES (?, ?, ?, ?, ?, 321, 'ledger log tail', 'writer-run', 'writer-step', ?)`,
      ).run(getOriginRepo(repo), TESTED_TREE, computeCmdHash(TEST_CMD), TEST_CMD, exitCode, rowCreatedAt);
      row = { id: Number(inserted.lastInsertRowid), exitCode, createdAt: rowCreatedAt };
    }

    return { db, runId, testerId, finalizeId, createdAt, row };
  }

  it("keeps green and ineligible finalize_merge claims unchanged and unannotated", () => {
    const green = seedRun("default", "green");
    const greenClaim = claimStep("merger", green.runId);
    assert.equal(greenClaim.found, true);
    assert.equal(greenClaim.stepId, green.finalizeId);
    assert.equal(completeStep(green.finalizeId, "STATUS: done").status, "completed");
    assert.deepEqual(
      getRunEvents(green.runId).filter((event) => event.event.startsWith("merge.")),
      [],
    );

    const inert = seedRun("green", "red", { attested: false });
    const inertClaim = claimStep("merger", inert.runId);
    assert.equal(inertClaim.found, true);
    assert.equal(inertClaim.stepId, inert.finalizeId);
    assert.equal(completeStep(inert.finalizeId, "STATUS: done").status, "completed");
    assert.deepEqual(
      getRunEvents(inert.runId).filter((event) => event.event.startsWith("merge.")),
      [],
    );
  });

  it("matches shim evidence against test_cmd_raw after the runnable command is wrapped", () => {
    const seeded = seedRun("green", "green", { wrappedTestCmd: true });

    const claim = claimStep("merger", seeded.runId);

    assert.equal(claim.found, true);
    assert.equal(claim.stepId, seeded.finalizeId);
  });

  it("allows default red evidence and emits exactly one run-scoped annotation", () => {
    const seeded = seedRun("default", "red");
    assert.ok(seeded.row);

    const claim = claimStep("merger", seeded.runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, seeded.finalizeId);
    assert.equal(completeStep(seeded.finalizeId, "STATUS: done").status, "completed");

    const annotations = getRunEvents(seeded.runId).filter(
      (event) => event.event === "merge.landed_over_red_suite",
    );
    assert.equal(annotations.length, 1);
    const annotation = annotations[0];
    assert.equal(annotation.ledgerRowId, seeded.row.id);
    assert.equal(annotation.exitCode, seeded.row.exitCode);
    assert.equal(annotation.ledgerCreatedAt, seeded.row.createdAt);
    assert.equal(completeStep(seeded.finalizeId, "STATUS: done").status, "blocked");
    assert.equal(
      getRunEvents(seeded.runId).filter((event) => event.event === "merge.landed_over_red_suite").length,
      1,
    );
  });

  it("allows all merge_gate=off ledger states and emits attributed overrides", () => {
    for (const evidence of ["green", "red", "missing"] as const) {
      const seeded = seedRun("off", evidence);

      const claim = claimStep("merger", seeded.runId);
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, seeded.finalizeId);

      const overrides = getRunEvents(seeded.runId).filter(
        (event) => event.event === "merge.gate_overridden",
      );
      assert.equal(overrides.length, 1);
      const override = overrides[0];
      assert.equal(override.runId, seeded.runId);
      assert.equal(override.workflowId, WORKFLOW_ID);
      assert.equal(override.stepId, "finalize_merge");
      assert.equal(override.gateMode, "off");
      assert.equal(override.runNumber, 42);
      assert.equal(override.launchTs, seeded.createdAt);
    }
  });

  for (const [mode, evidence] of [
    ["default", "missing"],
    ["green", "missing"],
    ["green", "red"],
  ] as const) {
    it(`reroutes ${evidence}/${mode} once, then fails with verbatim evidence before merger claim`, () => {
      const seeded = seedRun(mode, evidence);

      const firstClaim = claimStep("merger", seeded.runId);
      assert.equal(firstClaim.found, false, "the merger must not receive obstructed work");
      const afterFirst = seeded.db.prepare(
        "SELECT status, output, reroute_count FROM steps WHERE id = ?",
      ).get(seeded.finalizeId) as { status: string; output: string | null; reroute_count: number };
      assert.equal(afterFirst.status, "waiting");
      assert.equal(afterFirst.output, null);
      assert.equal(afterFirst.reroute_count, 1);

      const testerClaim = claimStep("tester", seeded.runId);
      assert.equal(testerClaim.found, true);
      assert.equal(testerClaim.stepId, seeded.testerId);
      assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");

      const secondClaim = claimStep("merger", seeded.runId);
      assert.equal(secondClaim.found, false, "a repeated refusal must not launch another merger");
      const failedStep = seeded.db.prepare(
        "SELECT status, output, reroute_count FROM steps WHERE id = ?",
      ).get(seeded.finalizeId) as { status: string; output: string; reroute_count: number };
      assert.equal(failedStep.status, "failed");
      assert.equal(failedStep.reroute_count, 1);
      assert.match(failedStep.output, /^FAILURE_CLASS: refused_permanent$/m);
      assert.match(failedStep.output, new RegExp(`^TREE_HASH: ${TESTED_TREE}$`, "m"));
      assert.match(failedStep.output, new RegExp(`^CMD_HASH: ${computeCmdHash(TEST_CMD)}$`, "m"));
      assert.ok(failedStep.output.includes(`TEST_CMD: ${TEST_CMD}`));
      if (seeded.row) {
        assert.match(failedStep.output, new RegExp(`^LEDGER_ROW_ID: ${seeded.row.id}$`, "m"));
        assert.match(failedStep.output, new RegExp(`^EXIT_CODE: ${seeded.row.exitCode}$`, "m"));
        assert.match(failedStep.output, new RegExp(`^TIMESTAMP: ${seeded.row.createdAt}$`, "m"));
      } else {
        assert.match(failedStep.output, /^LEDGER_EVIDENCE: missing$/m);
      }

      const run = seeded.db.prepare("SELECT status FROM runs WHERE id = ?").get(seeded.runId) as {
        status: string;
      };
      assert.equal(run.status, "failed");
      const events = getRunEvents(seeded.runId);
      const rerouted = events.filter((event) => event.event === "step.rerouted");
      assert.equal(rerouted.length, 1);
      assert.ok(
        rerouted[0].detail?.includes(failedStep.output),
        "terminal ledger refusal evidence must survive the RAMP reroute verbatim",
      );
      const stepFailed = events.find((event) => event.event === "step.failed");
      const runFailed = events.find((event) => event.event === "run.failed");
      assert.equal(stepFailed?.detail, failedStep.output);
      assert.equal(runFailed?.detail, failedStep.output);
    });
  }
});
