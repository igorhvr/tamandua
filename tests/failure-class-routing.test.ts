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

describe("failure-class motor routing", () => {
  let savedStateDir: string | undefined;
  let savedDbPath: string | undefined;
  let isolationDir: string;

  before(() => {
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedDbPath = process.env.TAMANDUA_DB_PATH;
    isolationDir = tamanduaTempDir("tamandua-failure-class-routing-");
    process.env.TAMANDUA_STATE_DIR = isolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(isolationDir, "tamandua.db");

    const workflowDir = path.join(isolationDir, "workflows", "test-failure-class-routing");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, "workflow.yml"), workflowYaml);
  });

  after(async () => {
    // failStep's rugpull check is fire-and-forget; let it finish while the
    // isolated state directory is still active.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = savedStateDir;
    if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = savedDbPath;
    fs.rmSync(isolationDir, { recursive: true, force: true });
  });

  async function insertRun(rerouteCount = 0, terminalRerouteCount = 0) {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerId = crypto.randomUUID();
    const consumerId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-failure-class-routing', 'task', 'running', '{}', ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps
       (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, reroute_count, terminal_reroute_count, type, output, created_at, updated_at)
       VALUES (?, ?, 'produce', 'producer', 0, 'Produce', 'STATUS: done', 'done',
        0, 0, 0, 0, 'single', 'STATUS: done', ?, ?)`,
    ).run(producerId, runId, now, now);
    db.prepare(
      `INSERT INTO steps
       (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, reroute_count, terminal_reroute_count, type, created_at, updated_at)
       VALUES (?, ?, 'consume', 'consumer', 1, 'Consume', 'STATUS: done', 'running',
        0, 0, ?, ?, 'single', ?, ?)`,
    ).run(consumerId, runId, rerouteCount, terminalRerouteCount, now, now);

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
    const reason = "Target changed while landing\nFAILURE_CLASS: target_moved\nPlease revalidate";

    const result = await failStep(consumerId, reason);

    assert.equal(result.status, "rerouted");
    const producer = db.prepare("SELECT output FROM steps WHERE id = ?").get(producerId) as {
      output: string;
    };
    assert.ok(producer.output.includes(reason), "reroute feedback must retain the complete reason");
  });

  it("uses legacy rerouting for a known nonterminal class not listed in retry_on", async () => {
    const { db, consumerId } = await insertRun();

    const result = await failStep(consumerId, "Conflict found\nFAILURE_CLASS: conflicts");

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
      "Uncommitted tracked changes\nFAILURE_CLASS: tree_dirty\nCommit or discard them",
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

    const result = await failStep(consumerId, "Odd failure\nFAILURE_CLASS: future_class");

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
      "Policy refuses this merge\nFAILURE_CLASS: refused_permanent\nManual intervention required",
    );

    assert.equal(result.status, "rerouted");
    const consumer = db.prepare(
      "SELECT status, reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { status: string; reroute_count: number; terminal_reroute_count: number };
    assert.equal(consumer.status, "waiting");
    assert.equal(consumer.reroute_count, 1);
    assert.equal(consumer.terminal_reroute_count, 1);
  });

  it("fails on the second refused_permanent failure and preserves the refusal verbatim", async () => {
    const { db, runId, consumerId } = await insertRun(1, 1);
    const reason = [
      "Landing refused by branch policy.",
      "FAILURE_CLASS: refused_permanent",
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
      (await failStep(consumerId, "Target moved\nFAILURE_CLASS: target_moved")).status,
      "rerouted",
    );
    let counts = db.prepare(
      "SELECT reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { reroute_count: number; terminal_reroute_count: number };
    assert.equal(counts.reroute_count, 1);
    assert.equal(counts.terminal_reroute_count, 0);

    prepareNextAttempt();
    assert.equal(
      (await failStep(consumerId, "First terminal refusal\nFAILURE_CLASS: refused_permanent")).status,
      "rerouted",
    );
    counts = db.prepare(
      "SELECT reroute_count, terminal_reroute_count FROM steps WHERE id = ?",
    ).get(consumerId) as { reroute_count: number; terminal_reroute_count: number };
    assert.equal(counts.reroute_count, 2);
    assert.equal(counts.terminal_reroute_count, 1);

    prepareNextAttempt();
    const reason = "Second terminal refusal\nFAILURE_CLASS: refused_permanent";
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
});
