import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import { failStep } from "../dist/installer/step-ops.js";
import { getRunEvents } from "../dist/installer/events.js";

const workflowYaml = `
id: test-failure-class-routing
agents:
  - id: producer
    workspace:
      baseDir: .
      files: {}
  - id: consumer
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: producer
    input: Produce
    expects: "STATUS: done"
  - id: consume
    agent: consumer
    input: Consume
    expects: "STATUS: done"
    max_retries: 0
    on_fail:
      retry_step: produce
      max_reroutes: 4
      retry_on: [target_moved]
`;

// REROUTE-BUDGET (NPF-3) fixture: a deliberately tiny shared budget (1) with a
// larger target-moved budget (3), so a stale-tip reroute can be shown to cross
// an exhausted shared budget without charging it.
const budgetWorkflowYaml = `
id: test-failure-class-routing-budget
agents:
  - id: producer
    workspace:
      baseDir: .
      files: {}
  - id: consumer
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: producer
    input: Produce
    expects: "STATUS: done"
  - id: consume
    agent: consumer
    input: Consume
    expects: "STATUS: done"
    max_retries: 0
    on_fail:
      retry_step: produce
      max_reroutes: 1
      max_target_moved_reroutes: 3
      retry_on: [target_moved, conflicts]
`;

describe("failure-class motor routing", () => {
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;
  let savedDbPath: string | undefined;
  let savedControlPort: string | undefined;
  let isolationDir: string;

  before(() => {
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedDbPath = process.env.TAMANDUA_DB_PATH;
    savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
    isolationDir = tamanduaTempDir("tamandua-failure-class-routing-");
    // HOME is required too: failStep's fire-and-forget rugpull relaunch
    // (relaunchRunAfterRugpull → runWorkflow) goes through controlRequest,
    // which resolves the daemon secret at HOME/.tamandua/daemon-secret when
    // TAMANDUA_CONTROL_PORT is set — with the real HOME that trips the
    // guard. Point HOME at the temp isolation dir and drop the ambient
    // control port so the daemon can never be reached.
    process.env.HOME = path.join(isolationDir, "home");
    process.env.TAMANDUA_STATE_DIR = isolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(isolationDir, "tamandua.db");
    delete process.env.TAMANDUA_CONTROL_PORT;

    const workflowDir = path.join(isolationDir, "workflows", "test-failure-class-routing");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, "workflow.yml"), workflowYaml);

    const budgetWorkflowDir = path.join(isolationDir, "workflows", "test-failure-class-routing-budget");
    fs.mkdirSync(budgetWorkflowDir, { recursive: true });
    fs.writeFileSync(path.join(budgetWorkflowDir, "workflow.yml"), budgetWorkflowYaml);
  });

  after(async () => {
    // failStep's rugpull check is fire-and-forget; let it finish while the
    // isolated state directory is still active.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("HOME", savedHome);
    restore("TAMANDUA_STATE_DIR", savedStateDir);
    restore("TAMANDUA_DB_PATH", savedDbPath);
    restore("TAMANDUA_CONTROL_PORT", savedControlPort);
    fs.rmSync(isolationDir, { recursive: true, force: true });
  });

  async function insertRun(
    rerouteCount = 0,
    terminalRerouteCount = 0,
    targetMovedRerouteCount = 0,
    workflowId = "test-failure-class-routing",
  ) {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerId = crypto.randomUUID();
    const consumerId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, 'task', 'running', '{}', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.prepare(
      `INSERT INTO steps
       (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, reroute_count, terminal_reroute_count, target_moved_reroute_count, type, output, created_at, updated_at)
       VALUES (?, ?, 'produce', 'producer', 0, 'Produce', 'STATUS: done', 'done',
        0, 0, 0, 0, 0, 'single', 'STATUS: done', ?, ?)`,
    ).run(producerId, runId, now, now);
    db.prepare(
      `INSERT INTO steps
       (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, reroute_count, terminal_reroute_count, target_moved_reroute_count, type, created_at, updated_at)
       VALUES (?, ?, 'consume', 'consumer', 1, 'Consume', 'STATUS: done', 'running',
        0, 0, ?, ?, ?, 'single', ?, ?)`,
    ).run(consumerId, runId, rerouteCount, terminalRerouteCount, targetMovedRerouteCount, now, now);

    return { db, runId, producerId, consumerId };
  }

  it("preserves legacy rerouting for a reason with no failure class", async () => {
    const { db, consumerId } = await insertRun(3);
    const reason = "legacy unclassified refusal";

    const result = await failStep(consumerId, reason);

    assert.equal(result.status, "rerouted");
    const consumer = db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { status: string; reroute_count: number; terminal_reroute_count: number };
    assert.equal(consumer.status, "waiting");
    assert.equal(consumer.reroute_count, 4);
    assert.equal(consumer.terminal_reroute_count, 0);
  });

  it("reroutes a multiline reason whose failure class matches retry_on", async () => {
    const { db, producerId, consumerId } = await insertRun();
    const reason = "FAILURE_CLASS: target_moved\nTarget changed while landing\nPlease revalidate";

    const result = await failStep(consumerId, reason);

    assert.equal(result.status, "rerouted");
    const producer = db.prepare("SELECT output FROM steps WHERE id = ?").get(producerId) as {
      output: string;
    };
    assert.ok(producer.output.includes(reason), "reroute feedback must retain the complete reason");
  });

  it("uses legacy rerouting for a known nonterminal class not listed in retry_on", async () => {
    const { db, consumerId } = await insertRun();

    const result = await failStep(consumerId, "FAILURE_CLASS: conflicts\nConflict found");

    assert.equal(result.status, "rerouted");
    const consumer = db.prepare("SELECT reroute_count, terminal_reroute_count FROM steps WHERE id = ?").get(consumerId) as {
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(consumer.reroute_count, 1);
    assert.equal(consumer.terminal_reroute_count, 0);
  });

  it("routes tree_dirty as transient without consuming the terminal concession", async () => {
    const { db, consumerId } = await insertRun();

    const result = await failStep(
      consumerId,
      "FAILURE_CLASS: tree_dirty\nUncommitted tracked changes\nCommit or discard them",
    );

    assert.equal(result.status, "rerouted");
    const consumer = db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { status: string; reroute_count: number; terminal_reroute_count: number };
    assert.equal(consumer.status, "waiting");
    assert.equal(consumer.reroute_count, 1);
    assert.equal(consumer.terminal_reroute_count, 0);
  });

  it("uses legacy rerouting for an unknown failure class", async () => {
    const { db, consumerId } = await insertRun(2);

    const result = await failStep(consumerId, "FAILURE_CLASS: future_class\nOdd failure");

    assert.equal(result.status, "rerouted");
    const consumer = db.prepare("SELECT reroute_count, terminal_reroute_count FROM steps WHERE id = ?").get(consumerId) as {
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(consumer.reroute_count, 3);
    assert.equal(consumer.terminal_reroute_count, 0);
  });

  it("allows the first refused_permanent failure to reroute", async () => {
    const { db, consumerId } = await insertRun();

    const result = await failStep(
      consumerId,
      "FAILURE_CLASS: refused_permanent\nPolicy refuses this merge\nManual intervention required",
    );

    assert.equal(result.status, "rerouted");
    const consumer = db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { status: string; reroute_count: number; terminal_reroute_count: number };
    assert.equal(consumer.status, "waiting");
    assert.equal(consumer.reroute_count, 1);
    assert.equal(consumer.terminal_reroute_count, 1);
  });

  it("ignores a quoted terminal marker after the first line", async () => {
    const { db, consumerId } = await insertRun();

    const result = await failStep(
      consumerId,
      "Operational failure while invoking merge-branch\nFAILURE_CLASS: refused_permanent\nRetry normally",
    );

    assert.equal(result.status, "rerouted");
    const consumer = db.prepare(
      "SELECT reroute_count, terminal_reroute_count, ledger_concession_count FROM steps WHERE id = ?",
    ).get(consumerId) as {
      reroute_count: number;
      terminal_reroute_count: number;
      ledger_concession_count: number;
    };
    assert.equal(consumer.reroute_count, 1);
    assert.equal(consumer.terminal_reroute_count, 0);
    assert.equal(consumer.ledger_concession_count, 0);
  });

  it("fails on the second refused_permanent failure and preserves the refusal verbatim", async () => {
    const { db, runId, consumerId } = await insertRun(1, 1);
    const reason = [
      "FAILURE_CLASS: refused_permanent",
      "Landing refused by branch policy.",
      "Required approval is absent; no automated repair is allowed.",
    ].join("\n");

    const result = await failStep(consumerId, reason);

    assert.equal(result.status, "failed");
    const step = db.prepare(
      "SELECT status, output, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { status: string; output: string; reroute_count: number; terminal_reroute_count: number };
    assert.equal(step.status, "failed");
    assert.equal(step.output, reason);
    assert.equal(step.reroute_count, 1);
    assert.equal(step.terminal_reroute_count, 1);
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");

    const events = getRunEvents(runId);
    const stepFailed = events.find((event) => event.event === "step.failed");
    const runFailed = events.find((event) => event.event === "run.failed");
    assert.equal(stepFailed?.detail, reason);
    assert.equal(runFailed?.detail, reason);
    assert.equal(events.filter((event) => event.event === "step.rerouted").length, 0);
  });

  it("preserves one terminal concession after a transient reroute", async () => {
    const { db, runId, producerId, consumerId } = await insertRun();
    const prepareNextAttempt = () => {
      db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done' WHERE id = ?").run(producerId);
      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(consumerId);
    };

    assert.equal(
      (await failStep(consumerId, "FAILURE_CLASS: target_moved\nTarget moved")).status,
      "rerouted",
    );
    let counts = db.prepare(
      "SELECT reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { reroute_count: number; terminal_reroute_count: number };
    assert.equal(counts.reroute_count, 1);
    assert.equal(counts.terminal_reroute_count, 0);

    prepareNextAttempt();
    assert.equal(
      (await failStep(consumerId, "FAILURE_CLASS: refused_permanent\nFirst terminal refusal")).status,
      "rerouted",
    );
    counts = db.prepare(
      "SELECT reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { reroute_count: number; terminal_reroute_count: number };
    assert.equal(counts.reroute_count, 2);
    assert.equal(counts.terminal_reroute_count, 1);

    prepareNextAttempt();
    const reason = "FAILURE_CLASS: refused_permanent\nSecond terminal refusal";
    assert.equal((await failStep(consumerId, reason)).status, "failed");
    const terminal = db.prepare(
      "SELECT status, output, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as {
      status: string;
      output: string;
      reroute_count: number;
      terminal_reroute_count: number;
    };
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.output, reason);
    assert.equal(terminal.reroute_count, 2);
    assert.equal(terminal.terminal_reroute_count, 1);
    assert.equal(
      (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status,
      "failed",
    );
  });

  // ── REROUTE-BUDGET (NPF-3): target_moved gets its own budget ──
  // The budget fixture declares max_reroutes: 1 and max_target_moved_reroutes: 3,
  // so stale-tip reroutes can be shown to cross an exhausted shared budget
  // without charging it.

  const readCounts = (
    db: Awaited<ReturnType<typeof insertRun>>["db"],
    consumerId: string,
  ) => db.prepare(
    "SELECT reroute_count, terminal_reroute_count, target_moved_reroute_count FROM steps WHERE id = ?",
  ).get(consumerId) as {
    reroute_count: number;
    terminal_reroute_count: number;
    target_moved_reroute_count: number;
  };

  it("REROUTE-BUDGET: consecutive target_moved reroutes keep the shared budget at 0 and reconcile against the event stream", async () => {
    const { db, runId, producerId, consumerId } = await insertRun(0, 0, 0, "test-failure-class-routing-budget");
    const prepareNextAttempt = () => {
      db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done' WHERE id = ?").run(producerId);
      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(consumerId);
    };

    // N=3 is exactly the declared target_moved cap; every one must reroute even
    // though the shared budget is only 1.
    for (let i = 1; i <= 3; i++) {
      const result = await failStep(consumerId, `FAILURE_CLASS: target_moved\nStale tip attempt ${i}`);
      assert.equal(result.status, "rerouted", `target_moved reroute ${i}/3 must reroute`);
      const counts = readCounts(db, consumerId);
      assert.equal(counts.reroute_count, i, "reroute_count is the TOTAL reroute counter");
      assert.equal(counts.target_moved_reroute_count, i, "target_moved_reroute_count increments per stale-tip reroute");
      assert.equal(counts.terminal_reroute_count, 0, "target_moved reroutes are not terminal-class");
      assert.equal(
        counts.reroute_count - counts.target_moved_reroute_count,
        0,
        "shared-budget consumption (reroute_count - target_moved_reroute_count) stays at 0",
      );
      prepareNextAttempt();
    }

    const counts = readCounts(db, consumerId);
    assert.equal(counts.reroute_count, 3);
    assert.equal(counts.target_moved_reroute_count, 3);

    // AC5: the emitted stream carries failureClass + the target-moved count/budget
    // and reconciles reroute_count == count(step.rerouted).
    const rerouteEvents = getRunEvents(runId).filter((event) => event.event === "step.rerouted");
    assert.equal(rerouteEvents.length, 3);
    assert.equal(rerouteEvents.length, counts.reroute_count, "reroute_count == count(step.rerouted)");
    assert.equal(
      rerouteEvents.filter((event) => event.failureClass === "target_moved").length,
      counts.target_moved_reroute_count,
      "target_moved_reroute_count == count(step.rerouted where failureClass === 'target_moved')",
    );
    assert.deepEqual(
      rerouteEvents.map((event) => event.targetMovedRerouteCount),
      [1, 2, 3],
      "every step.rerouted event carries the post-reroute target-moved count",
    );
    for (const event of rerouteEvents) {
      assert.equal(event.failureClass, "target_moved");
      assert.equal(event.targetMovedBudget, 3, "the declared max_target_moved_reroutes cap is reported");
    }

    // The 4th stale-tip refusal exceeds the target_moved cap and fails the run
    // (the shared budget was still untouched at 1 by the target_moved corridor).
    const exhausted = await failStep(consumerId, "FAILURE_CLASS: target_moved\nStale tip 4");
    assert.equal(exhausted.status, "failed");
    const afterExhaustion = readCounts(db, consumerId);
    assert.equal(afterExhaustion.reroute_count, 3, "the exhausted refusal does not increment reroute_count");
    assert.equal(afterExhaustion.target_moved_reroute_count, 3);
    const events = getRunEvents(runId);
    const targetMovedExhausted = events.filter((event) => event.event === "step.target_moved_reroute_exhausted");
    assert.equal(targetMovedExhausted.length, 1, "exactly one target_moved exhaustion event");
    assert.equal(targetMovedExhausted[0].targetMovedRerouteCount, 3);
    assert.equal(targetMovedExhausted[0].targetMovedBudget, 3);
    assert.equal(targetMovedExhausted[0].failureClass, "target_moved");
    assert.equal(
      events.filter((event) => event.event === "step.reroute_budget_exhausted").length,
      0,
      "target_moved exhaustion must not emit the shared-budget exhaustion event",
    );
  });

  it("REROUTE-BUDGET: a target_moved reroute crosses an already-exhausted shared budget", async () => {
    // Seed the shared budget AT its cap (reroute_count 1 == max_reroutes 1) with
    // no stale-tip reroutes yet, so a target_moved failure would be refused if
    // it still consulted max_reroutes.
    const { db, runId, consumerId } = await insertRun(1, 0, 0, "test-failure-class-routing-budget");

    const result = await failStep(consumerId, "FAILURE_CLASS: target_moved\nStale tip while shared budget is full");

    assert.equal(result.status, "rerouted", "target_moved reroutes regardless of shared-budget consumption");
    const counts = readCounts(db, consumerId);
    assert.equal(counts.reroute_count, 2);
    assert.equal(counts.target_moved_reroute_count, 1);
    assert.equal(
      counts.reroute_count - counts.target_moved_reroute_count,
      1,
      "shared-budget consumption is unchanged by the target_moved reroute",
    );
    const rerouteEvents = getRunEvents(runId).filter((event) => event.event === "step.rerouted");
    assert.equal(rerouteEvents.length, 1);
    assert.equal(rerouteEvents[0].failureClass, "target_moved");
    assert.equal(rerouteEvents[0].targetMovedRerouteCount, 1);
    assert.equal(rerouteEvents[0].targetMovedBudget, 3);
  });

  it("REROUTE-BUDGET: a conflicts refusal still charges the shared budget and exhausts it", async () => {
    const { db, runId, producerId, consumerId } = await insertRun(3, 0, 3, "test-failure-class-routing-budget");
    const prepareNextAttempt = () => {
      db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done' WHERE id = ?").run(producerId);
      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(consumerId);
    };

    // Shared consumption starts at 0 (3 total - 3 target_moved) while the tiny
    // shared budget is 1; one conflicts reroute fits, the next does not.
    assert.equal(
      (await failStep(consumerId, "FAILURE_CLASS: conflicts\nConflict 1")).status,
      "rerouted",
    );
    let counts = readCounts(db, consumerId);
    assert.equal(counts.reroute_count, 4);
    assert.equal(counts.target_moved_reroute_count, 3, "a non-target_moved reroute must not touch the target-moved counter");
    assert.equal(counts.reroute_count - counts.target_moved_reroute_count, 1, "conflicts charges the shared budget");

    prepareNextAttempt();
    assert.equal(
      (await failStep(consumerId, "FAILURE_CLASS: conflicts\nConflict 2")).status,
      "failed",
    );
    counts = readCounts(db, consumerId);
    assert.equal(counts.reroute_count, 4, "the refused conflicts reroute does not increment reroute_count");
    assert.equal(counts.target_moved_reroute_count, 3);

    const events = getRunEvents(runId);
    const budgetExhausted = events.filter((event) => event.event === "step.reroute_budget_exhausted");
    assert.equal(budgetExhausted.length, 1, "exactly one shared-budget exhaustion event");
    assert.equal(budgetExhausted[0].failureClass, "conflicts");
    assert.equal(budgetExhausted[0].targetMovedRerouteCount, 3);
    assert.equal(budgetExhausted[0].targetMovedBudget, 3);
    assert.equal(
      events.filter((event) => event.event === "step.target_moved_reroute_exhausted").length,
      0,
      "shared-budget exhaustion must not emit the target-moved exhaustion event",
    );
  });

  // ── US-004: target_moved exhaustion must fail LEGIBLY ──

  it("REROUTE-BUDGET: target_moved exhaustion fails the run with a greppable FAILURE_CLASS line", async () => {
    const { db, runId, producerId, consumerId } = await insertRun(0, 0, 0, "test-failure-class-routing-budget");
    const prepareNextAttempt = () => {
      db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done' WHERE id = ?").run(producerId);
      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(consumerId);
    };

    // Spend the declared cap (3) with three stale-tip refusals.
    for (let i = 1; i <= 3; i++) {
      assert.equal(
        (await failStep(consumerId, `FAILURE_CLASS: target_moved\nStale tip attempt ${i}`)).status,
        "rerouted",
      );
      prepareNextAttempt();
    }

    const result = await failStep(consumerId, "FAILURE_CLASS: target_moved\nStale tip 4");
    assert.equal(result.status, "failed");

    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(consumerId) as {
      status: string;
      output: string;
    };
    assert.equal(step.status, "failed");
    assert.equal(
      step.output.split("\n")[0],
      "FAILURE_CLASS: target_moved_exhausted",
      "the step output's first line is the distinct exhaustion class",
    );
    assert.match(step.output, /3\/3/, "the reason names the consumed count and the cap");
    assert.match(step.output, /produce/, "the reason names the target step");
    assert.match(step.output, /Stale tip 4/, "the reason keeps the consumer failure");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");

    const events = getRunEvents(runId);
    assert.equal(
      events.filter((event) => event.event === "step.target_moved_reroute_exhausted").length,
      1,
      "exactly one target_moved exhaustion event",
    );
    assert.equal(
      events.filter((event) => event.event === "step.reroute_budget_exhausted").length,
      0,
      "target_moved exhaustion must not emit the shared-budget exhaustion event",
    );

    const stepFailed = events.filter((event) => event.event === "step.failed");
    assert.equal(stepFailed.length, 1, "no step.failed event is emitted while the run is rerouting");
    assert.equal(stepFailed[0].detail, step.output, "step.failed carries the target_moved_exhausted reason");
    const runFailed = events.filter((event) => event.event === "run.failed");
    assert.equal(runFailed.length, 1);
    assert.equal(runFailed[0].detail, step.output, "run.failed carries the target_moved_exhausted reason");
  });

  it("REROUTE-BUDGET: an undeclared max_target_moved_reroutes defaults to a cap of 16", async () => {
    // The base fixture declares retry_on: [target_moved] but no
    // max_target_moved_reroutes, so the runtime default (16) governs. Seeding
    // the counter at 15 keeps the test to two failures: the 16th reroute is
    // the last allowed, the 17th exhausts.
    const { db, producerId, consumerId } = await insertRun(15, 0, 15, "test-failure-class-routing");
    const prepareNextAttempt = () => {
      db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done' WHERE id = ?").run(producerId);
      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(consumerId);
    };

    const sixteenth = await failStep(consumerId, "FAILURE_CLASS: target_moved\nStale tip 16");
    assert.equal(sixteenth.status, "rerouted", "the 16th target_moved reroute is still allowed");
    let counts = readCounts(db, consumerId);
    assert.equal(counts.target_moved_reroute_count, 16);

    prepareNextAttempt();
    const seventeenth = await failStep(consumerId, "FAILURE_CLASS: target_moved\nStale tip 17");
    assert.equal(seventeenth.status, "failed", "the 17th target_moved reroute exhausts the default cap");
    counts = readCounts(db, consumerId);
    assert.equal(
      counts.target_moved_reroute_count,
      16,
      "the exhausted refusal does not increment the target-moved counter",
    );

    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(consumerId) as { output: string };
    assert.equal(step.output.split("\n")[0], "FAILURE_CLASS: target_moved_exhausted");
    assert.match(step.output, /16\/16/, "the reason names the default cap");
  });
});
