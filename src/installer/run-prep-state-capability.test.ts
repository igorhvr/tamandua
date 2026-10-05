/**
 * run-prep-state-capability.test.ts — MTLK-ISO2-CORRECTIVE Finding D
 * (D-enforce) behavioral proof.
 *
 * A pre-PREP-STATE daemon treats an isolation-intent row as natively
 * schedulable, so the NEW control client must refuse to create or resume such
 * a run against a daemon that does not advertise the capability token. These
 * tests exercise the REAL entry points (`runWorkflow`, `resumeWorkflow`) — not
 * the capability helper directly — so the file is baseline-compatible: on the
 * unmodified base there is no guard at all, the run is created / resumed, and
 * both assertions are red (the fresh launch inserts the intent row; the failed
 * resume transitions to running). No capability-only test helper is imported.
 *
 * Serial lane: this file spawns processes through the run/daemon path (the
 * repository classification rules), so it is listed in tests/serial-files.txt.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

import { runWorkflow, resumeWorkflow } from "../../dist/installer/run.js";
import { buildMatchlockPolicy, serializeMatchlockPolicy } from "../../dist/installer/matchlock/policy.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { removeTestTempDirWithDiagnostics } from "../../tests/helpers/test-env.ts";

const PREP_STATE_CAPABILITY = "MTLK-ISO-SLICE2-PREP-STATE";

describe("MTLK-ISO2-CORRECTIVE D: control client refuses a pre-PREP-STATE daemon", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;
  let saved: Record<string, string | undefined>;

  before(() => {
    saved = {};
    for (const key of ["HOME", "TAMANDUA_STATE_DIR", "TAMANDUA_DB_PATH", "TAMANDUA_CONTROL_PORT", "TAMANDUA_WORKTREE_ROOT"]) {
      saved[key] = process.env[key];
    }
    tempHome = tamanduaTempDir("tamandua-d-cap-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_WORKTREE_ROOT = path.join(stateDir, "worktrees");
  });

  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTestTempDirWithDiagnostics(tempHome);
  });

  /** A reachable daemon that deliberately omits the capability token. */
  async function startPrePrepStateControlPlane(): Promise<{
    port: number;
    requests: string[];
    close: () => Promise<void>;
  }> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        // NO prepStateCapability: this is a pre-PREP-STATE binary.
        res.end(JSON.stringify({ ok: true, status: "ok" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    return {
      port: addr.port,
      requests,
      close: async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  function writeMinimalWorkflow(workflowId: string): string {
    const workflowDir = path.join(stateDir, "workflows", workflowId);
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "workflow.yml"),
      [
        `id: ${workflowId}`,
        `run:`,
        `  workspace: direct`,
        `agents:`,
        `  - id: dev`,
        `    model: fake`,
        `    workspace:`,
        `      baseDir: .`,
        `steps:`,
        `  - id: implement`,
        `    agent: dev`,
        `    type: single`,
        `    input: Implement the task`,
        `    expects: STATUS, CHANGES, TESTS`,
      ].join("\n"),
      "utf-8",
    );
    return workflowDir;
  }

  function buildPolicy(): string {
    return serializeMatchlockPolicy(
      buildMatchlockPolicy({
        requestedImage: "igorhvr/tamandua:latest",
        requestedImageSource: "standard",
        identity: {
          digest: `sha256:${"a".repeat(64)}`,
          config_digest: `sha256:${"b".repeat(64)}`,
          tag: "igorhvr/tamandua:latest",
        },
        harness: "pi",
        workingDirectory: tempHome,
        originalRepositoryRoot: tempHome,
        workMounts: [{ hostPath: tempHome, hostRealPath: tempHome, guestPath: tempHome }],
        gitMetadataRoots: [],
        resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 8192 },
        rootUsageConsent: true,
      }),
    );
  }

  it("a fresh opted-in launch refuses BEFORE the intent INSERT against a pre-PREP-STATE daemon", async () => {
    const workflowId = `d-cap-launch-${crypto.randomUUID().slice(0, 8)}`;
    writeMinimalWorkflow(workflowId);
    const repoDir = path.join(tempHome, `${workflowId}-repo`);
    fs.mkdirSync(repoDir, { recursive: true });
    const fake = await startPrePrepStateControlPlane();
    const prevPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = String(fake.port);
    try {
      await assert.rejects(
        () =>
          runWorkflow({
            workflowId,
            taskTitle: "D capability refusal",
            workingDirectoryForHarness: repoDir,
            matchlockImage: "igorhvr/tamandua:latest",
            matchlockSwapSupportProbe: (binaryPath) => ({ supported: true, binaryPath }),
          }),
        (err: unknown) =>
          err instanceof Error && new RegExp(PREP_STATE_CAPABILITY).test(err.message),
        "a pre-PREP-STATE daemon must be refused",
      );
      const { getDb } = await import("../../dist/db.js");
      const row = getDb()
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?")
        .get(workflowId) as { n: number };
      assert.equal(row.n, 0, "the intent-only row must never be inserted");
      assert.equal(
        fake.requests.some((r) => r.includes("register-run")),
        false,
        "the client must not register against the older daemon",
      );
    } finally {
      if (prevPort !== undefined) process.env.TAMANDUA_CONTROL_PORT = prevPort;
      else delete process.env.TAMANDUA_CONTROL_PORT;
      await fake.close();
    }
  });

  it("a failed-run resume refuses before any state write against a pre-PREP-STATE daemon", async () => {
    const workflowId = `d-cap-resume-${crypto.randomUUID().slice(0, 8)}`;
    const runId = crypto.randomUUID();
    const harnessDir = path.join(tempHome, `${workflowId}-harness`);
    fs.mkdirSync(harnessDir, { recursive: true });
    const policy = buildPolicy();
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at, matchlock_policy, isolation_intent)
       VALUES (?, ?, ?, 'D resume', 'failed', ?, ?, ?, ?, 'true')`,
    ).run(
      runId,
      9090,
      workflowId,
      JSON.stringify({ working_directory_for_harness: path.resolve(harnessDir) }),
      now,
      now,
      policy,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
       VALUES (?, ?, 'implement', 'dev', 0, 'input', 'STATUS, CHANGES, TESTS', 'failed', 'single', ?, ?)`,
    ).run(crypto.randomUUID(), runId, now, now);

    const fake = await startPrePrepStateControlPlane();
    const prevPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = String(fake.port);
    try {
      const result = await resumeWorkflow(runId, {
        matchlockSwapSupportProbe: (binaryPath) => ({ supported: true, binaryPath }),
        // Unknown on the base (ignored there); used by the fixed tree so no
        // real image resolve/RPC runs.
        matchlockInheritedImageVerifier: async () => {},
      } as never);
      assert.equal(result.status, "refused", "the older daemon must be refused");
      assert.equal(
        (result as { matchlockRefused?: { code?: string } }).matchlockRefused?.code,
        "matchlock_daemon_prep_state_unsupported",
        "typed capability refusal",
      );
      const row = db
        .prepare("SELECT status, scheduling_status, matchlock_policy FROM runs WHERE id = ?")
        .get(runId) as { status: string; scheduling_status: string | null; matchlock_policy: string | null };
      assert.equal(row.status, "failed", "no running resurrection");
      assert.equal(row.scheduling_status, null, "no scheduling transition");
      assert.equal(row.matchlock_policy, policy, "no consent/state write");
      assert.equal(
        fake.requests.some((r) => r.includes("register-run")),
        false,
        "the client must not register against the older daemon",
      );
    } finally {
      if (prevPort !== undefined) process.env.TAMANDUA_CONTROL_PORT = prevPort;
      else delete process.env.TAMANDUA_CONTROL_PORT;
      await fake.close();
    }
  });

  it("a nudge after a restart onto a pre-PREP-STATE daemon is marker-held, never dispatched natively", async () => {
    // MTLK-ISO2-MEND (Family D): the mixed-version exclusion is STRUCTURAL. A
    // new client recorded an isolation-intent row carrying the legacy-honored
    // pause_drain hold; after the host restarts onto a pre-PREP-STATE daemon the
    // client nudge is deliberately NOT globally capability-gated (native-only
    // behavior unchanged). It is the marker that makes the older daemon's
    // handleRegisterRun / nudge loop return the typed drain state without
    // admission, and the legacy reconciler never selects it.
    const workflowId = `d-cap-nudge-${crypto.randomUUID().slice(0, 8)}`;
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();
    const {
      initialRunIsolationState,
      PAUSE_DRAIN_CONTEXT_KEY,
      DRAINING_PAUSE_SCHEDULING_STATUS,
      readIsolationState,
    } = await import("../../dist/installer/matchlock/prep-state.js");
    const held = initialRunIsolationState(true, now);
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, scheduling_status, context, created_at, updated_at, matchlock_policy, isolation_intent)
       VALUES (?, 9091, ?, 'D nudge restart', 'running', ?, ?, ?, ?, NULL, 'true')`,
    ).run(runId, workflowId, held.schedulingStatus, JSON.stringify(held.contextSeed), now, now);

    const fake = await startPrePrepStateControlPlane();
    const prevPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = String(fake.port);
    try {
      const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
      const response = await nudgeWithDaemon(2000);
      assert.equal(response?.status, 200, "the scoped nudge must still reach a non-capability peer");
      assert.equal(
        fake.requests.some((r) => r.includes("/control/nudge")),
        true,
        "the nudge is not short-circuited by a global capability gate",
      );
      const row = db
        .prepare(
          "SELECT status, scheduling_status, isolation_intent, matchlock_policy, context FROM runs WHERE id = ?",
        )
        .get(runId) as {
        status: string;
        scheduling_status: string | null;
        isolation_intent: string | null;
        matchlock_policy: string | null;
        context: string;
      };
      assert.equal(row.status, "running", "the held row is not transitioned natively");
      assert.equal(
        row.scheduling_status,
        DRAINING_PAUSE_SCHEDULING_STATUS,
        "the legacy-honored hold survives",
      );
      assert.equal(row.isolation_intent, "true", "the intent marker survives");
      assert.equal(row.matchlock_policy, null, "no native policy write");
      assert.equal(readIsolationState(row), "preparing", "new binaries still classify it as preparing");
      // The EXACT pre-PREP-STATE guard and reconciler predicate (provenance:
      // 9f167705 handleRegisterRun and reconcileOnce).
      const legacyContext = JSON.parse(row.context) as Record<string, string>;
      assert.equal(
        row.scheduling_status === "draining_pause" ||
          legacyContext[PAUSE_DRAIN_CONTEXT_KEY] === "true",
        true,
        "the legacy register/nudge guard holds the intent-only row",
      );
      const legacySelected = db
        .prepare(
          `SELECT id FROM runs
            WHERE status IN ('running')
              AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register','active','error','waiting'))`,
        )
        .all() as Array<{ id: string }>;
      assert.equal(
        legacySelected.some((r) => r.id === runId),
        false,
        "the legacy reconciler never selects the held row",
      );
    } finally {
      if (prevPort !== undefined) process.env.TAMANDUA_CONTROL_PORT = prevPort;
      else delete process.env.TAMANDUA_CONTROL_PORT;
      await fake.close();
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});
