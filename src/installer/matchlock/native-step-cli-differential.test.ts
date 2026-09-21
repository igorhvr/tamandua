/**
 * Native differential: REAL isolated native CLI vs NativeStepServices (serial
 * lane; spawns the real built CLI binary).
 *
 * For every scenario, two byte-identical seeded DBs are driven to the same
 * transition — once through the REAL worker CLI subprocess (`node
 * dist/cli/cli.js step claim/complete`, isolated env, host worker ownership
 * env) and once through the production adapter (NativeStepServices
 * claim/validate/submit with the real event stream). Final DB state and the
 * run-scoped event stream must match IN RECORDED ORDER (volatile ts/
 * recordId fields aside), proving the adapter reproduces native step
 * semantics — including event ordering, empty-output, retry verdicts and
 * exhaustion — rather than inventing its own success model.
 */

import assert from "node:assert/strict";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, afterEach, describe, it } from "node:test";
import { closeDb, getDb } from "../../../dist/db.js";
import { NativeStepServices } from "../../../dist/installer/matchlock/native-step-services.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import {
  AGENT,
  JOB_ID,
  RUN,
  applyEnv,
  bindingFor,
  snapshotEnv,
} from "../../../dist/installer/matchlock/native-step-test-utils.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "dist", "cli", "cli.js");
const INV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STEP1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface Scenario {
  name: string;
  step: {
    expects: string;
    retryCount?: number;
    maxRetries?: number;
  };
  output: string;
}

const SCENARIOS: Scenario[] = [
  { name: "normal-done", step: { expects: "STATUS: done\nCHANGES:" }, output: "STATUS: done\nCHANGES: implemented" },
  { name: "empty-output-with-expects", step: { expects: "STATUS: done", maxRetries: 2 }, output: "" },
  { name: "retry-verdict-not-exhausted", step: { expects: "regex:^STATUS:\\s*(done|retry)\\s*$", maxRetries: 2 }, output: "STATUS: retry\nREASON: more work needed" },
  { name: "retry-verdict-exhausted", step: { expects: "regex:^STATUS:\\s*(done|retry)\\s*$", retryCount: 2, maxRetries: 2 }, output: "STATUS: retry\nREASON: exhausted" },
  { name: "no-expects-plain-done", step: { expects: "" }, output: "STATUS: done\nCHANGES: ok" },
];

interface Fixture {
  root: string;
  stateDir: string;
  dbPath: string;
}

function makeFixture(tag: string): Fixture {
  const root = tamanduaTempDir(`diff-${tag}-`);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, dbPath: path.join(stateDir, "tamandua.db") };
}

function applyFixture(fx: Fixture): void {
  process.env.HOME = path.join(fx.root, "home");
  process.env.TAMANDUA_STATE_DIR = fx.stateDir;
  process.env.TAMANDUA_DB_PATH = fx.dbPath;
}

function seedStep(scenario: Scenario): void {
  getDb().prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
  ).run(RUN, "diff", "t", "running", "{}");
  getDb().prepare(
    `INSERT INTO steps (
       id, run_id, step_id, agent_id, step_index, input_template, expects, status,
       output, retry_count, max_retries, type, loop_config, current_story_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    STEP1, RUN, "plan", AGENT, 0, "plain task text", scenario.step.expects, "pending",
    null, scenario.step.retryCount ?? 0, scenario.step.maxRetries ?? 4, "single", null, null,
  );
}

function stepStateSummary(): Record<string, unknown> {
  // claim_pgid is host process-identity metadata and legitimately differs
  // between the two paths: the native CLI self-detects its own process group
  // at claim time while the adapter records only host-supplied ownership
  // (production supplies the scheduler pgid). Everything semantic is compared.
  const s = getDb().prepare(
    "SELECT status, retry_count, max_retries, output, claim_job_id, claim_pid, claim_invalidated_by FROM steps WHERE id = ?",
  ).get(STEP1) as Record<string, unknown>;
  const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(RUN) as { status: string };
  return { step: s, runStatus: run.status };
}

function normalizedEvents(): Array<Record<string, unknown>> {
  const file = path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`);
  if (!fs.existsSync(file)) return [];
  // NOTE: deliberately NOT sorted. Both paths emit in the same program order
  // (claim -> transition-machinery events -> adapter/CLI accepted
  // expects-validated record), so the caller's comparison asserts exact
  // stream ORDER as well as payload equality — a stronger parity claim than
  // set equality. If a future ordering delta is introduced, it must be
  // understood and documented here, not hidden behind a sort.
  const drop = new Set(["ts", "recordId", "claim_updated_at", "updated_at"]);
  return fs.readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const e = JSON.parse(l) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e)) {
        if (!drop.has(k)) out[k] = v;
      }
      return out;
    });
}

/** Drive the REAL native CLI to the transition on the given fixture. */
function runNativeCli(fx: Fixture, scenario: Scenario): void {
  // Explicit child env (never a spread of the ambient environment) so the
  // real CLI can only ever see the isolated fixture state.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(fx.root, "home"),
    TAMANDUA_STATE_DIR: fx.stateDir,
    TAMANDUA_DB_PATH: fx.dbPath,
    TAMANDUA_WORKER_JOB_ID: JOB_ID,
    TAMANDUA_WORKER_PID: "424242",
  };
  const claim = spawnSync(process.execPath, [CLI, "step", "claim", AGENT, "--run-id", `run-${RUN}`], {
    env,
    cwd: fx.root,
    encoding: "utf-8",
    timeout: 60_000,
  });
  assert.equal(claim.status, 0, `native claim failed: ${claim.stdout} ${claim.stderr}`);
  const claimJson = JSON.parse(claim.stdout.trim());
  assert.equal(claimJson.stepId, `step-${STEP1}`);

  const reportFile = path.join(fx.root, "report.txt");
  fs.writeFileSync(reportFile, scenario.output, "utf-8");
  const complete = spawnSync(
    process.execPath,
    [CLI, "step", "complete", claimJson.stepId, "--file", reportFile],
    { env, cwd: fx.root, encoding: "utf-8", timeout: 60_000 },
  );
  assert.equal(complete.status, 0, `native complete failed: ${complete.stdout} ${complete.stderr}`);
}

/** Drive the production adapter to the same transition on the given fixture. */
async function runAdapter(fx: Fixture, scenario: Scenario): Promise<void> {
  applyFixture(fx);
  getDb(); // ensure migrated + env wired
  const registry = new HostInvocationRegistry();
  const binding = bindingFor(INV);
  // Host admission of the invocation identity before any adapter op.
  const admitted = registry.admitInvocation({
    invocationId: binding.invocationId,
    runId: binding.runId,
    agentId: binding.agentId,
    jobId: binding.jobId,
  });
  assert.equal(admitted.ok, true);
  // Default event sink: adapter parity records land in the real event
  // stream exactly like the native CLI's, so the streams are comparable.
  const svc = new NativeStepServices({
    binding,
    registry,
    workerOwnership: { jobId: JOB_ID, pid: 424242 },
  });
  const claim = await svc.claim(binding);
  assert.equal(claim.found, true);
  assert.equal(claim.stepId, STEP1);
  const held = await svc.readClaim(binding);
  assert.ok(held);
  const diag = await svc.validateCompletion(binding, STEP1, scenario.output);
  assert.equal(diag.verdict, "accept");
  const outcome = await svc.submitCompletion(binding, held!.claimId, STEP1, scenario.output);
  assert.notEqual(outcome.status, "blocked", "adapter transition must not be blocked on its own claim");
}

const cleanups: Array<{ root: string }> = [];

function cleanupFx(fx: Fixture): void {
  cleanups.push({ root: fx.root });
}

afterEach(() => {
  // The per-scenario fixtures are intentionally removed only in after()
  // because the last scenario's late teardown continuations must still run
  // against temp state (sticky env below).
  applyEnv(stickyEnv);
});

const sticky = makeFixture("diff-sticky");
applyFixture(sticky);
getDb();
const stickyEnv = snapshotEnv();

after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  for (const c of cleanups.splice(0)) {
    try {
      fs.rmSync(c.root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of our own fixtures */
    }
  }
  applyEnv(stickyEnv);
});

describe("native CLI differential (real subprocess vs adapter)", () => {
  for (const scenario of SCENARIOS) {
    it(`matches the native CLI for ${scenario.name}`, async () => {
      // Byte-identical seeds.
      const cliFx = makeFixture("cli");
      applyFixture(cliFx);
      getDb();
      seedStep(scenario);
      cleanupFx(cliFx);

      const adapterFx = makeFixture("adapter");
      applyFixture(adapterFx);
      getDb();
      seedStep(scenario);
      cleanupFx(adapterFx);

      runNativeCli(cliFx, scenario);
      const cliState = (() => {
        applyFixture(cliFx);
        const summary = stepStateSummary();
        const events = normalizedEvents();
        closeDb();
        return { summary, events };
      })();

      await runAdapter(adapterFx, scenario);
      const adapterState = (() => {
        applyFixture(adapterFx);
        const summary = stepStateSummary();
        const events = normalizedEvents();
        closeDb();
        return { summary, events };
      })();

      assert.deepEqual(adapterState.summary, cliState.summary);
      assert.deepEqual(
        adapterState.events.map((e) => e.event),
        cliState.events.map((e) => e.event),
        `event streams differ for ${scenario.name}`,
      );
      // The payloads of the shared validation events must be field-identical.
      const stripForCompare = (es: Array<Record<string, unknown>>) =>
        es.map((e) => {
          const { event, ...rest } = e;
          return { event, ...rest };
        });
      assert.deepEqual(stripForCompare(adapterState.events), stripForCompare(cliState.events));
    });
  }
});

void AGENT;
void os;
void assert;
