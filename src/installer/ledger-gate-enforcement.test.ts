import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { closeDb, getDb } from "../../dist/db.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { claimStep, completeStep, failStep, isAlreadyLanded } from "../../dist/installer/step-ops.js";
import { loadWorkflowSpecSync } from "../../dist/installer/workflow-spec.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import { computeCmdHash, getOriginRepo } from "../../dist/suite/tree-hash.js";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";

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

  function writeWorkflow(yaml: string): void {
    fs.writeFileSync(
      path.join(process.env.TAMANDUA_STATE_DIR!, "workflows", WORKFLOW_ID, "workflow.yml"),
      yaml,
    );
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

  it("default missing evidence reroutes once, then lands with merge.landed_without_suite_evidence annotation", () => {
    const seeded = seedRun("default", "missing");

    // First merger claim: missing evidence → refused, rerouted to tester.
    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterFirst = seeded.db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(afterFirst.status, "waiting");
    assert.equal(afterFirst.reroute_count, 1);
    assert.equal(afterFirst.terminal_reroute_count, 1);

    // Stale completion is still blocked before the tester rerun.
    assert.equal(
      completeStep(seeded.finalizeId, "STATUS: done").status,
      "blocked",
      "a stale merger completion must not land before the tester rerun",
    );
    assert.equal(
      (seeded.db.prepare("SELECT status FROM steps WHERE id = ?").get(seeded.finalizeId) as { status: string }).status,
      "waiting",
    );

    // Tester reruns.
    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");

    // Second merger claim: concession valve consumed → claim succeeds, step lands.
    assert.equal(claimStep("merger", seeded.runId).found, true);
    assert.equal(completeStep(seeded.finalizeId, "STATUS: done").status, "completed");

    // merge.landed_without_suite_evidence event emitted.
    const landingEvents = getRunEvents(seeded.runId).filter(
      (event) => event.event === "merge.landed_without_suite_evidence",
    );
    assert.equal(landingEvents.length, 1);
    assert.equal(landingEvents[0].runId, seeded.runId);
    assert.equal(landingEvents[0].gateMode, "default");

    // Run completed successfully (not failed).
    const run = seeded.db.prepare("SELECT status FROM runs WHERE id = ?").get(seeded.runId) as { status: string };
    assert.equal(run.status, "completed");
  });

  it("serializes duplicate claim-time missing-evidence refusals", async () => {
    const seeded = seedRun("default", "missing");
    const startFile = path.join(stateRoot, "release-claimers");
    const claimantScript = `
      import fs from "node:fs";
      import { claimStep } from ${JSON.stringify(new URL("../../dist/installer/step-ops.js", import.meta.url).href)};
      process.stdout.write("READY\\n");
      while (!fs.existsSync(${JSON.stringify(startFile)})) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      process.stdout.write(JSON.stringify(claimStep("merger", ${JSON.stringify(seeded.runId)})) + "\\n");
    `;

    const launchClaimant = () => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", claimantScript], {
        env: cleanChildEnv({
          HOME: process.env.HOME,
          TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
          TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY\n")) readyResolve();
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      return { ready, done };
    };

    const claimants = [launchClaimant(), launchClaimant()];
    await Promise.all(claimants.map((claimant) => claimant.ready));
    fs.writeFileSync(startFile, "go");
    const results = await Promise.all(claimants.map((claimant) => claimant.done));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), { found: false });
    }

    const finalize = seeded.db.prepare(
      `SELECT status, reroute_count, terminal_reroute_count, ledger_concession_count
       FROM steps WHERE id = ?`,
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
      ledger_concession_count: number;
    };
    assert.deepEqual({ ...finalize }, {
      status: "waiting",
      reroute_count: 1,
      terminal_reroute_count: 1,
      ledger_concession_count: 1,
    });
    const tester = seeded.db.prepare(
      "SELECT status, claim_invalidated_by FROM steps WHERE id = ?",
    ).get(seeded.testerId) as { status: string; claim_invalidated_by: string | null };
    assert.deepEqual({ ...tester }, { status: "pending", claim_invalidated_by: "reroute" });
    const rerouteEvents = getRunEvents(seeded.runId).filter(
      (event) => event.event === "step.rerouted",
    );
    assert.equal(rerouteEvents.length, 1);
    assert.match(
      rerouteEvents[0].detail ?? "",
      /Ledger gate refused finalize_merge: no matching TSTX suite execution exists/,
    );
  });

  it("recovers an already-landed merge before claim-time gating without spending its concession", () => {
    const seeded = seedRun("default", "missing");
    const targetBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    const mergedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    const run = seeded.db.prepare("SELECT context FROM runs WHERE id = ?").get(seeded.runId) as {
      context: string;
    };
    seeded.db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(
      JSON.stringify({ ...JSON.parse(run.context), original_branch: targetBranch }),
      seeded.runId,
    );
    const landedOutput = `STATUS: done\nMERGED_COMMIT: ${mergedCommit}`;
    seeded.db.prepare("UPDATE steps SET output = ? WHERE id = ?").run(landedOutput, seeded.finalizeId);

    const claim = claimStep("merger", seeded.runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, seeded.finalizeId);
    const counters = seeded.db.prepare(
      `SELECT reroute_count, terminal_reroute_count, ledger_concession_count
       FROM steps WHERE id = ?`,
    ).get(seeded.finalizeId) as {
      reroute_count: number;
      terminal_reroute_count: number;
      ledger_concession_count: number;
    };
    assert.equal(counters.reroute_count, 0);
    assert.equal(counters.terminal_reroute_count, 0);
    assert.equal(counters.ledger_concession_count, 0);
    assert.equal(claimStep("tester", seeded.runId).found, false);
    assert.equal(
      getRunEvents(seeded.runId).filter((event) => event.event === "step.rerouted").length,
      0,
    );

    assert.equal(completeStep(seeded.finalizeId, landedOutput).status, "completed");
    assert.equal(
      getRunEvents(seeded.runId).filter(
        (event) => event.event === "merge.landed_without_suite_evidence",
      ).length,
      1,
      "an already-landed missing-evidence completion must be annotated with an unspent concession",
    );
  });

  it("uses the one-shot terminal allowance after the shared reroute budget is exhausted", () => {
    const seeded = seedRun("default", "missing");
    seeded.db.prepare(
      "UPDATE steps SET reroute_count = 8, terminal_reroute_count = 0 WHERE id = ?",
    ).run(seeded.finalizeId);

    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterRefusal = seeded.db.prepare(
      `SELECT status, reroute_count, terminal_reroute_count, ledger_concession_count
       FROM steps WHERE id = ?`,
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
      ledger_concession_count: number;
    };
    assert.equal(afterRefusal.status, "waiting");
    assert.equal(afterRefusal.reroute_count, 8, "terminal allowance must not charge the shared budget");
    assert.equal(afterRefusal.terminal_reroute_count, 1);
    assert.equal(afterRefusal.ledger_concession_count, 1);

    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");
    assert.equal(claimStep("merger", seeded.runId).found, true, "the one-shot concession must prevent a loop");
  });

  for (const [label, workflowYaml] of [
    ["no retry_step", WORKFLOW_YAML.replace(/    on_fail:\n(?:      .*\n){3}/, "")],
    ["an invalid retry target", WORKFLOW_YAML.replace("retry_step: test", "retry_step: missing_test_step")],
  ] as const) {
    it(`concedes default missing evidence with ${label}`, () => {
      writeWorkflow(workflowYaml);
      const seeded = seedRun("default", "missing");

      const claim = claimStep("merger", seeded.runId);
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, seeded.finalizeId);
      assert.equal(completeStep(seeded.finalizeId, "STATUS: done").status, "completed");
      assert.equal(
        getRunEvents(seeded.runId).filter(
          (event) => event.event === "merge.landed_without_suite_evidence",
        ).length,
        1,
      );
      const counters = seeded.db.prepare(
        `SELECT reroute_count, terminal_reroute_count, ledger_concession_count
         FROM steps WHERE id = ?`,
      ).get(seeded.finalizeId) as {
        reroute_count: number;
        terminal_reroute_count: number;
        ledger_concession_count: number;
      };
      assert.equal(counters.reroute_count, 0);
      assert.equal(counters.terminal_reroute_count, 0);
      assert.equal(counters.ledger_concession_count, 0);
    });
  }

  for (const mode of ["green", "fail_missing"] as const) {
    it(`keeps ${mode} missing evidence strict when retry_step is unavailable`, () => {
      writeWorkflow(WORKFLOW_YAML.replace(/    on_fail:\n(?:      .*\n){3}/, ""));
      const seeded = seedRun(mode === "green" ? "green" : "default", "missing");
      if (mode === "fail_missing") {
        const run = seeded.db.prepare("SELECT context FROM runs WHERE id = ?").get(seeded.runId) as { context: string };
        seeded.db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(
          JSON.stringify({ ...JSON.parse(run.context), fail_missing: "1" }),
          seeded.runId,
        );
      }

      assert.equal(claimStep("merger", seeded.runId).found, false);
      assert.equal(
        (seeded.db.prepare("SELECT status FROM runs WHERE id = ?").get(seeded.runId) as { status: string }).status,
        "failed",
      );
      assert.equal(
        getRunEvents(seeded.runId).filter(
          (event) => event.event === "merge.landed_without_suite_evidence",
        ).length,
        0,
      );
    });
  }

  it("keeps the ledger concession available after an unrelated terminal reroute", async () => {
    const seeded = seedRun("default", "missing");
    seeded.db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(seeded.finalizeId);

    assert.equal(
      (await failStep(
        seeded.finalizeId,
        "FAILURE_CLASS: refused_permanent\nmerge-branch exited 1 for an operational failure",
      )).status,
      "rerouted",
    );
    const afterOperationalFailure = seeded.db.prepare(
      "SELECT reroute_count, terminal_reroute_count, ledger_concession_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      reroute_count: number;
      terminal_reroute_count: number;
      ledger_concession_count: number;
    };
    assert.equal(afterOperationalFailure.reroute_count, 1);
    assert.equal(afterOperationalFailure.terminal_reroute_count, 1);
    assert.equal(afterOperationalFailure.ledger_concession_count, 0);

    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");

    assert.equal(
      claimStep("merger", seeded.runId).found,
      false,
      "missing evidence must still receive its gate-owned refusal",
    );
    const afterGateRefusal = seeded.db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count, ledger_concession_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
      ledger_concession_count: number;
    };
    assert.equal(afterGateRefusal.status, "waiting");
    assert.equal(afterGateRefusal.reroute_count, 2);
    assert.equal(afterGateRefusal.terminal_reroute_count, 2);
    assert.equal(afterGateRefusal.ledger_concession_count, 1);
    const gateReroute = getRunEvents(seeded.runId)
      .filter((event) => event.event === "step.rerouted")
      .at(-1);
    assert.match(gateReroute?.detail ?? "", /ACTION: Run the EXACT shim-wrapped test command/);

    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");
    assert.equal(claimStep("merger", seeded.runId).found, true);
  });

  it("fail_missing=1 refuses default missing evidence permanently with no concession", () => {
    const seeded = seedRun("default", "missing");

    // Inject fail_missing=1 into the run context.
    const run = seeded.db.prepare("SELECT context FROM runs WHERE id = ?").get(seeded.runId) as { context: string };
    const ctx = JSON.parse(run.context);
    ctx.fail_missing = "1";
    seeded.db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(JSON.stringify(ctx), seeded.runId);

    // First merger claim: missing evidence → refused, rerouted to tester.
    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterFirst = seeded.db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(afterFirst.status, "waiting");
    assert.equal(afterFirst.reroute_count, 1);
    assert.equal(afterFirst.terminal_reroute_count, 1);

    // Tester reruns.
    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");

    // Second merger claim: fail_missing=1 → strict-missing, refuses permanently.
    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterSecond = seeded.db.prepare(
      "SELECT status, output, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      output: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(afterSecond.status, "failed");
    assert.equal(afterSecond.reroute_count, 1);
    assert.equal(afterSecond.terminal_reroute_count, 1);
    assert.match(afterSecond.output, /^FAILURE_CLASS: refused_permanent$/m);
    assert.match(afterSecond.output, /^LEDGER_EVIDENCE: missing$/m);

    const failedRun = seeded.db.prepare("SELECT status FROM runs WHERE id = ?").get(seeded.runId) as { status: string };
    assert.equal(failedRun.status, "failed");

    // No merge.landed_without_suite_evidence event was ever emitted.
    assert.equal(
      getRunEvents(seeded.runId).filter(
        (event) => event.event === "merge.landed_without_suite_evidence",
      ).length,
      0,
    );
  });

  it("fail_missing=1 with green mode both refuse missing evidence permanently (combined strict)", () => {
    // When both fail_missing=1 AND merge_gate=green are active, the
    // combined strict-missing behavior must still refuse permanently —
    // no concession, no landing, just like either alone.
    const seeded = seedRun("green", "missing");

    // Inject fail_missing=1 into the run context on top of green mode.
    const run = seeded.db.prepare("SELECT context FROM runs WHERE id = ?").get(seeded.runId) as { context: string };
    const ctx = JSON.parse(run.context);
    ctx.fail_missing = "1";
    seeded.db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(JSON.stringify(ctx), seeded.runId);

    // First merger claim: missing evidence → refused, rerouted to tester.
    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterFirst = seeded.db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(afterFirst.status, "waiting");
    assert.equal(afterFirst.reroute_count, 1);
    assert.equal(afterFirst.terminal_reroute_count, 1);

    // Tester reruns.
    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");

    // Second merger claim: green + fail_missing=1 → strict-missing, refuses permanently.
    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterSecond = seeded.db.prepare(
      "SELECT status, output, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      output: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(afterSecond.status, "failed");
    assert.equal(afterSecond.reroute_count, 1);
    assert.equal(afterSecond.terminal_reroute_count, 1);
    assert.match(afterSecond.output, /^FAILURE_CLASS: refused_permanent$/m);
    assert.match(afterSecond.output, /^LEDGER_EVIDENCE: missing$/m);

    const failedRun = seeded.db.prepare("SELECT status FROM runs WHERE id = ?").get(seeded.runId) as { status: string };
    assert.equal(failedRun.status, "failed");

    // No merge.landed_without_suite_evidence event was ever emitted.
    assert.equal(
      getRunEvents(seeded.runId).filter(
        (event) => event.event === "merge.landed_without_suite_evidence",
      ).length,
      0,
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

  it("grants a motor-generated terminal concession after a prior transient reroute", () => {
    const seeded = seedRun("green", "red");
    seeded.db.prepare(
      "UPDATE steps SET reroute_count = 1, terminal_reroute_count = 0 WHERE id = ?",
    ).run(seeded.finalizeId);

    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterFirst = seeded.db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(afterFirst.status, "waiting");
    assert.equal(afterFirst.reroute_count, 2);
    assert.equal(afterFirst.terminal_reroute_count, 1);

    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");
    assert.equal(claimStep("merger", seeded.runId).found, false);
    const afterSecond = seeded.db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(seeded.finalizeId) as {
      status: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(afterSecond.status, "failed");
    assert.equal(afterSecond.reroute_count, 2);
    assert.equal(afterSecond.terminal_reroute_count, 1);
  });

  // ─── Already-Landed Guard Tests (US-006) ────────────────────────────

  it("isAlreadyLanded returns true when target tip matches MERGED_COMMIT", () => {
    const db = getDb();
    const suffix = Math.random().toString(16).slice(2);
    const runId = `lgat-landed-unit-${suffix}`;
    const finalizeId = `finalize-${suffix}`;
    const testerId = `tester-${suffix}`;
    const targetBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    const mainTip = execFileSync("git", ["rev-parse", `refs/heads/${targetBranch}`], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 42, ?, 'task', 'running', ?, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(runId, WORKFLOW_ID, JSON.stringify({
      repo,
      original_branch: targetBranch,
      worktree_origin_repository: repo,
      test_cmd: TEST_CMD,
    }));
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          output, type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'test', 'tester', 0, 'Test', 'STATUS: done', 'done',
          ?, 'single', 0, 0, 0, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(testerId, runId, TESTER_OUTPUT);
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', 'merger', 1, 'Merge', 'STATUS: done', 'pending',
          'single', 0, 0, 0, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(finalizeId, runId);

    const outputMatching = `STATUS: done\nMERGED_COMMIT: ${mainTip}\nTARGET: refs/heads/${targetBranch}`;
    assert.equal(isAlreadyLanded(finalizeId, outputMatching), true);
  });

  it("isAlreadyLanded treats shell metacharacters in the target branch as ref text", () => {
    const db = getDb();
    const suffix = Math.random().toString(16).slice(2);
    const runId = `lgat-landed-shell-safe-${suffix}`;
    const finalizeId = `finalize-${suffix}`;
    const sentinel = path.join(stateRoot, `rev-parse-sentinel-${suffix}`);
    const targetBranch = `missing;touch ${sentinel}`;

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 42, ?, 'task', 'running', ?, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(runId, WORKFLOW_ID, JSON.stringify({
      repo,
      original_branch: targetBranch,
      worktree_origin_repository: repo,
      test_cmd: TEST_CMD,
    }));
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', 'merger', 1, 'Merge', 'STATUS: done', 'pending',
          'single', 0, 0, 0, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(finalizeId, runId);

    assert.equal(
      isAlreadyLanded(finalizeId, "STATUS: done\nMERGED_COMMIT: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
      false,
    );
    assert.equal(fs.existsSync(sentinel), false, "target ref text must never be interpreted by a shell");
  });

  it("isAlreadyLanded returns false when MERGED_COMMIT does not match target tip", () => {
    const db = getDb();
    const suffix = Math.random().toString(16).slice(2);
    const runId = `lgat-landed-unit-${suffix}`;
    const finalizeId = `finalize-${suffix}`;
    const testerId = `tester-${suffix}`;
    const targetBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 42, ?, 'task', 'running', ?, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(runId, WORKFLOW_ID, JSON.stringify({
      repo,
      original_branch: targetBranch,
      worktree_origin_repository: repo,
      test_cmd: TEST_CMD,
    }));
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          output, type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'test', 'tester', 0, 'Test', 'STATUS: done', 'done',
          ?, 'single', 0, 0, 0, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(testerId, runId, TESTER_OUTPUT);
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', 'merger', 1, 'Merge', 'STATUS: done', 'pending',
          'single', 0, 0, 0, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(finalizeId, runId);

    const fakeCommit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const outputNonMatching = `STATUS: done\nMERGED_COMMIT: ${fakeCommit}\nTARGET: refs/heads/${targetBranch}`;
    assert.equal(isAlreadyLanded(finalizeId, outputNonMatching), false);
  });

  it("isAlreadyLanded returns false when output has no MERGED_COMMIT", () => {
    const db = getDb();
    const suffix = Math.random().toString(16).slice(2);
    const runId = `lgat-landed-unit-${suffix}`;
    const finalizeId = `finalize-${suffix}`;
    const testerId = `tester-${suffix}`;
    const targetBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 42, ?, 'task', 'running', ?, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(runId, WORKFLOW_ID, JSON.stringify({
      repo,
      original_branch: targetBranch,
      worktree_origin_repository: repo,
      test_cmd: TEST_CMD,
    }));
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          output, type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'test', 'tester', 0, 'Test', 'STATUS: done', 'done',
          ?, 'single', 0, 0, 0, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(testerId, runId, TESTER_OUTPUT);
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', 'merger', 1, 'Merge', 'STATUS: done', 'pending',
          'single', 0, 0, 0, '2026-07-26T12:34:56.000Z', '2026-07-26T12:34:56.000Z')`,
    ).run(finalizeId, runId);

    assert.equal(isAlreadyLanded(finalizeId, "STATUS: done"), false);
  });

  function seedAlreadyLandedRun() {
    const db = getDb();
    const suffix = Math.random().toString(16).slice(2);
    const runId = `lgat-landed-${suffix}`;
    const testerId = `tester-${suffix}`;
    const finalizeId = `finalize-${suffix}`;
    const targetBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    const context: Record<string, string> = {
      repo,
      original_branch: targetBranch,
      worktree_origin_repository: repo,
      test_cmd: TEST_CMD,
      launch_actor: "integration-test",
      merge_gate: "green",
    };
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
    ).run(testerId, runId, TESTER_OUTPUT, createdAt, createdAt);
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          type, retry_count, max_retries, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', 'merger', 1, 'Merge', 'STATUS: done', 'pending',
          'single', 0, 0, 0, ?, ?)`,
    ).run(finalizeId, runId, createdAt, createdAt);

    // Insert GREEN suite evidence so the claim-time gate does not refuse.
    const rowCreatedAt = "2026-07-26T12:35:00.000Z";
    const inserted = db.prepare(
      `INSERT INTO suite_results
         (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms,
          log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 0, 321, 'ledger log tail', 'writer-run', 'writer-step', ?)`,
    ).run(getOriginRepo(repo), TESTED_TREE, computeCmdHash(TEST_CMD), TEST_CMD, rowCreatedAt);
    const row = { id: Number(inserted.lastInsertRowid), exitCode: 0, createdAt: rowCreatedAt };

    return { db, runId, testerId, finalizeId, targetBranch, row };
  }

  it("skips acceptance gate refusal when target ref already at attested MERGED_COMMIT", () => {
    const seeded = seedAlreadyLandedRun();

    // Claim succeeds because the gate sees green evidence (green+green = no refusal).
    const claim = claimStep("merger", seeded.runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, seeded.finalizeId);

    // Between claim and completion: change suite evidence to red so the
    // acceptance-time gate re-evaluation would normally refuse (green+red).
    seeded.db.prepare("UPDATE suite_results SET exit_code = 1 WHERE id = ?").run(seeded.row.id);

    const mainTip = execFileSync("git", ["rev-parse", `refs/heads/${seeded.targetBranch}`], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();

    // Complete with MERGED_COMMIT matching the current target tip — the
    // acceptance gate should normally refuse (green+red), but the
    // already-landed guard should skip the refusal.
    const completionOutput = `STATUS: done\nMERGED_COMMIT: ${mainTip}\nMERGED_TREE: abc123\nTARGET: refs/heads/${seeded.targetBranch}`;
    const result = completeStep(seeded.finalizeId, completionOutput);
    assert.equal(result.status, "completed", "already-landed guard should skip refusal");

    // Verify the annotation event was emitted
    const annotations = getRunEvents(seeded.runId).filter(
      (event) => event.event === "merge.accepted_already_landed",
    );
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].runId, seeded.runId);
    assert.equal(annotations[0].workflowId, WORKFLOW_ID);
    assert.equal(annotations[0].stepId, "finalize_merge");
  });

  it("does not skip acceptance gate refusal when MERGED_COMMIT does not match target tip", () => {
    const seeded = seedAlreadyLandedRun();

    const claim = claimStep("merger", seeded.runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, seeded.finalizeId);

    // Change evidence to red so acceptance gate would refuse.
    seeded.db.prepare("UPDATE suite_results SET exit_code = 1 WHERE id = ?").run(seeded.row.id);

    // Use a non-matching commit hash
    const fakeCommit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const completionOutput = `STATUS: done\nMERGED_COMMIT: ${fakeCommit}\nMERGED_TREE: abc123\nTARGET: refs/heads/${seeded.targetBranch}`;
    const result = completeStep(seeded.finalizeId, completionOutput);
    assert.equal(result.status, "rerouted", "non-matching commit should trigger acceptance gate refusal + reroute");

    // Verify no already-landed annotation
    const annotations = getRunEvents(seeded.runId).filter(
      (event) => event.event === "merge.accepted_already_landed",
    );
    assert.equal(annotations.length, 0);
  });

  it("does not skip acceptance gate refusal when no MERGED_COMMIT in output", () => {
    const seeded = seedAlreadyLandedRun();

    const claim = claimStep("merger", seeded.runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, seeded.finalizeId);

    // Change evidence to red so acceptance gate would refuse.
    seeded.db.prepare("UPDATE suite_results SET exit_code = 1 WHERE id = ?").run(seeded.row.id);

    // Output without MERGED_COMMIT
    const result = completeStep(seeded.finalizeId, "STATUS: done\nCHANGES: stuff");
    assert.equal(result.status, "rerouted", "missing MERGED_COMMIT should trigger acceptance gate refusal + reroute");
  });

  it("normal non-already-landed paths unaffected (green mode, red evidence, default scenario)", () => {
    // Use the default seedRun which does NOT set original_branch —
    // isAlreadyLanded returns false because there's no target branch.
    // The claim-time gate blocks (green+red) as usual.
    const seeded = seedRun("green", "red");

    const firstClaim = claimStep("merger", seeded.runId);
    assert.equal(firstClaim.found, false, "hard refusal with green mode, red evidence");

    // After the reroute, the step is waiting. Tester claims and completes.
    assert.equal(claimStep("tester", seeded.runId).found, true);
    assert.equal(completeStep(seeded.testerId, TESTER_OUTPUT).status, "advanced");

    // Second claim also fails (run fails).
    assert.equal(claimStep("merger", seeded.runId).found, false);
    const run = seeded.db.prepare("SELECT status FROM runs WHERE id = ?").get(seeded.runId) as {
      status: string;
    };
    assert.equal(run.status, "failed");
  });
});
