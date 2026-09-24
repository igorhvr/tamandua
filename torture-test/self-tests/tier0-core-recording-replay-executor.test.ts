/**
 * CORE-MOTOR US-003 execution-binding/executor regression (pure, focused).
 *
 * Exercises the REAL execution-binding and evidence-verification code paths of
 * torture-test/bin/core-recording-replay-executor.mjs with VIRTUAL fixtures:
 * no daemon, no real child process, no port, no DB, no token spend, no write.
 * This file is picked up by self-tests/run.sh's tier0 glob and also runs as its
 * own `node --test torture-test/self-tests/tier0-core-recording-replay-executor.test.ts`.
 *
 * Coverage:
 *   1. planExpectedFinalStatus for the corridor plan shapes.
 *   2. buildExecutionBinding positives: source id preserved, fresh ids come
 *      from the launch receipt, per-action work bindings with the fresh run.
 *   3. buildExecutionBinding negatives: equal source/fresh identity refused
 *      (no historical uuid reuse / no DB patch), missing receipts refused,
 *      runtime mismatch refused, out-of-corridor agent refused.
 *   4. verifyExecutionEvidence positives and negatives against fabricated
 *      receipts (cross-run negative tripwires, probe counts, token ledger,
 *      heartbeat tripwire, workcount, step output bytes).
 *   5. CORE-MOTOR-CLOSE regressions (root-reproduced gaps):
 *      - the four root receipt mutations (foreign-run work/result,
 *        completion bound to a foreign step-row uuid, duplicated completion
 *        result, added foreign-run event) are each REJECTED while the
 *        unchanged positive still verifies;
 *      - exact work/result cardinality and step-row identity from the actual
 *        DB step-row ids (steps.id) instead of the shared display step_id;
 *      - collectReceipts-style diagnostics: malformed/truncated journal input
 *        is refused, never silently dropped; a missing run row is not a
 *        zero-proof;
 *      - stopExactChild: already-terminal-by-code/signal handles are
 *        recognized immediately WITHOUT re-signaling; live handles are
 *        signaled exactly once and awaited; a child that never exits yields a
 *        bounded stopError (cleanup failure), never an indefinite wait;
 *      - attachRunCliLifecycle: Run:-receipt positive path, premature exit
 *        before Run:, spawn error and launch timeout all follow the real code
 *        path with injected recording child handles (no OS signals);
 *      - daemon spawn error (review refine): a daemon handle whose child
 *        emitted 'error' (never spawned) must make executeReplayCase record
 *        spawnError with ZERO re-signal / no stopError / no probe and NO
 *        ~8s bounded-settle stall (mirror of the launcher short-circuit);
 *      - events-empty (review refine): an EMPTY per-run events stream is an
 *        explicit verifyExecutionEvidence FAILURE (events-non-empty), never a
 *        vacuous every() pass whose own message claims empty cannot prove;
 *      - validateExecutablePlan / executeReplayCase pre-effect trust
 *        boundary: invalid/foreign/malformed/unknown/executed plans are
 *        refused on the ACTUAL entry path with ZERO recorded effect calls and
 *        no sandbox created (recording host over the executor's own named
 *        OS-effect functions).
 *   6. Interface pinning: module exports + corridor constants (focused).
 */

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const EXECUTOR_PATH = path.join(repoRoot, "torture-test", "bin", "core-recording-replay-executor.mjs");
const EXECUTOR_URL = pathToFileURL(EXECUTOR_PATH).href;

let executorPromise = null;
function loadExecutor() {
  if (executorPromise === null) executorPromise = import(EXECUTOR_URL);
  return executorPromise;
}

// ── Synthetic corridor fixtures (nothing historical) ─────────────────

const SOURCE_RUN = "run-src-motor-test-00000000-0000-4000-8000-000000000000";
const FRESH_RUN = "f1d6a4b2-0000-4000-8000-000000000001";
const AGENT = "do-now_doer";
/** The actual DB step-row id (bare uuid) the fabricated native receipts bind. */
const STEP_ROW_ID = "e7c1a1b2-1111-4111-8111-0000000000aa";

/** A minimal validated-plan-shaped object (adapterVersion 3) for binding. */
function corridorPlan({ actions, runtime = "pi" } = {}) {
  return Object.freeze({
    adapterVersion: 3,
    runtime,
    admittedRunId: SOURCE_RUN,
    recordRunId: SOURCE_RUN,
    recordPayloadSha256: "abc123".repeat(8),
    zeroToken: true,
    actions: Object.freeze(
      actions.map((a) =>
        Object.freeze({
          id: a.id,
          type: a.type,
          runId: SOURCE_RUN,
          operationId: `op-${a.id}`,
          agentId: AGENT,
          roundIndex: a.roundIndex,
          ...(a.type === "replay.claim_complete" || a.type === "replay.claim_fail"
            ? { preservedOutputTexts: Object.freeze([{ observationId: `obs-${a.id}`, text: a.text ?? "STATUS: done\n" }]) }
            : {}),
          ...(a.exitCode !== undefined ? { exitCode: a.exitCode } : {}),
        }),
      ),
    ),
  });
}

const RETRY_PLAN = corridorPlan({
  actions: [
    { id: "fail", type: "replay.claim_fail", roundIndex: 0 },
    { id: "done", type: "replay.claim_complete", roundIndex: 1, text: "STATUS: done\nCHANGES: ok\n" },
    { id: "idle", type: "replay.idle_dispatch", roundIndex: 0 },
  ],
});

function launchReceipt(over = {}) {
  return {
    freshRunId: FRESH_RUN,
    workflowId: "do-now",
    workdir: "/virt/workdir",
    launchedAtUtc: "2026-09-09T00:00:00.000Z",
    harnessType: "pi",
    ...over,
  };
}

/**
 * Fabricated receipts that WOULD be observed for a successful fresh run,
 * shaped exactly like the real collector: steps rows carry their actual DB
 * row `id`, and journal work/result rows carry the native claim stepId
 * (`step-<row id>` — the same row across retries) plus the fresh runId.
 */
function okReceipts(over = {}) {
  const invocations = [
    {
      phase: "work",
      workIndex: 0,
      mode: "work",
      agentId: AGENT,
      runId: `run-${FRESH_RUN}`,
      stepId: `step-${STEP_ROW_ID}`,
      note: "claimed",
    },
    {
      phase: "result",
      workIndex: 0,
      mode: "work",
      agentId: AGENT,
      runId: `run-${FRESH_RUN}`,
      stepId: `step-${STEP_ROW_ID}`,
      ok: false,
      note: "scripted step fail",
    },
    {
      phase: "work",
      workIndex: 1,
      mode: "work",
      agentId: AGENT,
      runId: `run-${FRESH_RUN}`,
      stepId: `step-${STEP_ROW_ID}`,
      note: "claimed",
    },
    {
      phase: "result",
      workIndex: 1,
      mode: "work",
      agentId: AGENT,
      runId: `run-${FRESH_RUN}`,
      stepId: `step-${STEP_ROW_ID}`,
      ok: true,
      note: "reporting step complete",
    },
  ];
  return {
    runStatus: "completed",
    probes: { ok: 1, failed: 0, harness: "pi" },
    tokens: { runs: 0, system: 0 },
    steps: [
      {
        id: STEP_ROW_ID,
        step_id: "execute",
        agent_id: AGENT,
        run_id: FRESH_RUN,
        status: "done",
        retry_count: 1,
        output: "STATUS: done\nCHANGES: ok\n",
      },
    ],
    events: [
      { ts: "2026-09-09T00:00:01.000Z", event: "run.started", runId: FRESH_RUN, workflowId: "do-now" },
      { ts: "2026-09-09T00:00:01.500Z", event: "run.harness_probe_ok", runId: FRESH_RUN, harness: "pi", tokens: 0 },
    ],
    invocations,
    workcounts: { [AGENT]: 2 },
    collectDiagnostics: {
      runsRowFound: true,
      eventsFilePresent: true,
      invocationsFilePresent: true,
      workcountFilePresent: true,
      malformedEventLines: [],
      malformedInvocationLines: [],
    },
    expectedFinalStatus: "completed",
    expectedFinalOutput: "STATUS: done\nCHANGES: ok\n",
    ...over,
  };
}

/** Minimal recording child handle: an EventEmitter with runtimes' fields. */
function fakeChild(over = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return Object.assign(child, over);
}

/** Recording host seam: journals every OS-effect call made through it. */
function recordingHost() {
  const calls = [];
  const wrap = (name) => (...args) => {
    calls.push(name);
    return undefined;
  };
  return {
    calls,
    host: {
      createSandbox: wrap("createSandbox"),
      reserveRandomPort: wrap("reserveRandomPort"),
      materializeBehaviorsFile: wrap("materializeBehaviorsFile"),
      materializeRuntimeWrapper: wrap("materializeRuntimeWrapper"),
      installCorridorWorkflow: wrap("installCorridorWorkflow"),
      spawnIsolatedDaemon: wrap("spawnIsolatedDaemon"),
      launchWorkflowRun: wrap("launchWorkflowRun"),
      resolveFullRunId: wrap("resolveFullRunId"),
      pollRunToTerminal: wrap("pollRunToTerminal"),
      collectReceipts: wrap("collectReceipts"),
      stopExactChild: wrap("stopExactChild"),
      probePortClosed: wrap("probePortClosed"),
    },
  };
}

describe("CORE-MOTOR US-003 execution binding + evidence verification (pure)", () => {
  it("pins the executor module interface and corridor constants", async () => {
    const mod = await loadExecutor();
    assert.equal(mod.EXECUTOR_VERSION, 1);
    assert.equal(mod.EXECUTION_BINDING_VERSION, 1);
    assert.equal(mod.REPLAY_CORRIDOR_WORKFLOW, "do-now");
    assert.equal(mod.REPLAY_CORRIDOR_AGENT, "do-now_doer");
    assert.equal(mod.REPLAY_CORRIDOR_STEP, "execute");
    for (const fn of [
      "buildExecutionBinding",
      "verifyExecutionEvidence",
      "createRealAdapters",
      "describeError",
      "planExpectedFinalStatus",
      "executeReplayCase",
      "validateExecutablePlan",
      "stopExactChild",
      "attachRunCliLifecycle",
      "launchWorkflowRun",
      "probePortClosed",
    ]) {
      assert.equal(typeof mod[fn], "function", `executor must export ${fn}`);
    }
    const adapters = mod.createRealAdapters();
    assert.equal(typeof adapters.realpath, "function");
    assert.equal(typeof adapters.objectIdentity, "function");
  });

  it("shapes a caught value into the case-report error WITHOUT an undeclared-variable crash", async () => {
    const mod = await loadExecutor();
    const boom = new Error("primary failure payload");
    const shaped = mod.describeError(boom);
    assert.equal(shaped.message, "primary failure payload", "the primary error message must be preserved verbatim");
    assert.ok(typeof shaped.stack === "string" && shaped.stack.includes("primary failure payload"),
      "the primary error stack must be preserved");
    const raw = mod.describeError("plain string throw");
    assert.equal(raw.message, "plain string throw");
    assert.equal(raw.stack, undefined);
  });

  it("executor catch path records the caught error, never a second undeclared-variable error", async () => {
    // Static focused regression for the CORE-MOTOR refine issue: the failure
    // report builder must be fed the ACTUAL caught error (`e`), and the catch
    // must not reference any other undeclared identifier that would replace
    // the primary error with a ReferenceError on a genuine case failure.
    const fs = await import("node:fs");
    const src = fs.readFileSync(EXECUTOR_PATH, "utf-8");
    assert.ok(!/\bcaseErr\b/.test(src), "no undeclared `caseErr` reference may remain in the executor");
    assert.ok(/error: describeError\(e\)/.test(src), "the ok:false report must carry describeError(e) — the primary caught error");
    // Target executeReplayCase's error-recording catch: the `describeError(e)`
    // line must sit between a `} catch (e) {` and the following `} finally {`.
    const errIdx = src.indexOf("error: describeError(e)");
    assert.ok(errIdx >= 0, "describeError(e) must appear in the executor source");
    const catchIdx = src.lastIndexOf("} catch (e) {", errIdx);
    const finallyIdx = src.indexOf("} finally {", errIdx);
    assert.ok(catchIdx >= 0 && catchIdx < errIdx && finallyIdx > errIdx,
      "describeError(e) must be inside the catch(e) block of executeReplayCase (catch then finally around it)");
  });

  it("derives the expected terminal run status from the plan shape", async () => {
    const mod = await loadExecutor();
    assert.equal(mod.planExpectedFinalStatus(RETRY_PLAN), "completed");
    const failLast = corridorPlan({
      actions: [
        { id: "fail", type: "replay.claim_fail", roundIndex: 0 },
        { id: "fail2", type: "replay.claim_fail", roundIndex: 1 },
      ],
    });
    assert.equal(mod.planExpectedFinalStatus(failLast), "failed");
    assert.throws(() => mod.planExpectedFinalStatus({}), /validated plan/);
  });

  it("builds a binding whose fresh ids come from the launch receipt and preserves the source id", async () => {
    const mod = await loadExecutor();
    const res = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    const b = res.binding;
    assert.equal(b.bindingVersion, 1);
    assert.equal(b.source.sourceRunId, SOURCE_RUN, "immutable source run id preserved separately");
    assert.equal(b.execution.freshRunId, FRESH_RUN, "fresh run id comes from the launch receipt");
    assert.notEqual(b.execution.freshRunId, SOURCE_RUN, "source and fresh identities are distinct");
    assert.equal(b.execution.executed, false, "binding starts executed:false");
    const work = b.actionBindings.filter((x) => x.kind === "work");
    assert.equal(work.length, 2);
    assert.deepEqual(
      work.map((x) => [x.actionId, x.workIndex]),
      [
        ["fail", 0],
        ["done", 1],
      ],
      "per-agent work bindings map plan roundIndex to fresh work index",
    );
    for (const x of work) assert.equal(x.runId, FRESH_RUN, "every scheduled work action binds the fresh run");
    const idle = b.actionBindings.find((x) => x.kind === "idle-observed");
    assert.ok(idle, "idle actions are observed, never scheduled");
  });

  it("refuses an execution binding that would reuse the historical source uuid as the live run", async () => {
    const mod = await loadExecutor();
    const res = mod.buildExecutionBinding({
      plan: RETRY_PLAN,
      launchReceipt: launchReceipt({ freshRunId: SOURCE_RUN }),
    });
    assert.equal(res.ok, false);
    assert.ok(
      res.errors.some((e) => e.code === "binding-equal-identity"),
      `expected binding-equal-identity, got ${JSON.stringify(res.errors)}`,
    );
  });

  it("refuses missing/foreign receipts, runtime mismatches and out-of-corridor agents", async () => {
    const mod = await loadExecutor();
    const missing = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt({ freshRunId: "" }) });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.code === "binding-missing-run"));

    const runtimeMismatch = mod.buildExecutionBinding({
      plan: RETRY_PLAN,
      launchReceipt: launchReceipt({ harnessType: "hermes" }),
    });
    assert.equal(runtimeMismatch.ok, false);
    assert.ok(runtimeMismatch.errors.some((e) => e.code === "binding-runtime-mismatch"));

    const agentMismatch = corridorPlan({
      actions: [{ id: "done", type: "replay.claim_complete", roundIndex: 0 }],
    });
    const badAgentPlan = Object.freeze({
      ...agentMismatch,
      actions: Object.freeze([
        Object.freeze({ ...agentMismatch.actions[0], agentId: "other_agent" }),
      ]),
    });
    const res = mod.buildExecutionBinding({ plan: badAgentPlan, launchReceipt: launchReceipt() });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "binding-agent-mismatch"));
  });

  it("verifies positive execution evidence for a successful fail-then-complete replay", async () => {
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;
    const v = mod.verifyExecutionEvidence({ binding, receipts: okReceipts() });
    assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.pass)));
    const names = new Set(v.checks.map((c) => c.name));
    for (const expected of [
      "cross-run-negative",
      "no-foreign-identities",
      "events-non-empty",
      "events-bound-to-fresh-run",
      "evidence-malformed-none",
      "evidence-run-row-found",
      "fresh-run-receipts",
      "terminal-status",
      "probe-ok-once",
      "probe-not-journaled",
      "run-tokens-zero",
      "system-tokens-zero",
      "zero-heartbeat-spawns",
      "work-evidence-fail",
      "work-evidence-done",
      "step-row-identity-evidenced",
      "work-cardinality",
      "result-cardinality",
      "no-unexplained-extra-work",
      "no-unexplained-extra-result",
      "work-result-fresh-bound",
      "step-done",
      "step-output-bytes",
      "step-retry-count",
      "workcount",
    ]) {
      assert.ok(names.has(expected), `expected evidence check ${expected}`);
    }
  });

  it("flags cross-run contamination: any receipt bound to the source run id fails", async () => {
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;
    const contaminated = okReceipts({
      invocations: [
        {
          phase: "work",
          workIndex: 0,
          mode: "work",
          agentId: AGENT,
          runId: `run-${SOURCE_RUN.replace(/^run-/, "")}`, // a scheduled round bound to the SOURCE id
          stepId: `step-${STEP_ROW_ID}`,
          note: "claimed",
        },
        ...okReceipts().invocations.slice(1),
      ],
    });
    const v = mod.verifyExecutionEvidence({ binding, receipts: contaminated });
    assert.equal(v.ok, false);
    const neg = v.checks.find((c) => c.name === "cross-run-negative");
    assert.ok(neg && !neg.pass, "cross-run negative must trip on source-id contamination");
  });

  it("flags token spend, heartbeat spawns, probe failures and missing work receipts", async () => {
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;
    const cases = [
      okReceipts({ tokens: { runs: 5, system: 0 } }),
      okReceipts({ tokens: { runs: 0, system: 3 } }),
      okReceipts({
        invocations: [
          ...okReceipts().invocations,
          { phase: "heartbeat", workIndex: null, note: "spawned without pending work" },
        ],
      }),
      okReceipts({ probes: { ok: 0, failed: 1, harness: "pi" } }),
      okReceipts({ invocations: okReceipts().invocations.filter((i) => i.phase !== "result") }),
    ];
    for (const receipts of cases) {
      const v = mod.verifyExecutionEvidence({ binding, receipts });
      assert.equal(v.ok, false, `receipts must fail verification: ${JSON.stringify(receipts)}`);
    }
  });

  it("flags a missing/incorrect final output byte match on the step", async () => {
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;
    const v = mod.verifyExecutionEvidence({
      binding,
      receipts: okReceipts({
        steps: [
          {
            id: STEP_ROW_ID,
            step_id: "execute",
            agent_id: AGENT,
            run_id: FRESH_RUN,
            status: "done",
            retry_count: 1,
            output: "STATUS: done\nCHANGES: DIFFERENT bytes\n", // not the preserved report
          },
        ],
      }),
    });
    assert.equal(v.ok, false);
    const out = v.checks.find((c) => c.name === "step-output-bytes");
    assert.ok(out && !out.pass, "preserved report bytes must match the stored step output exactly");
  });

  it("flags a missing run row and malformed journal/event lines as failed evidence, never silent drops", async () => {
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;
    const missingRow = okReceipts({
      collectDiagnostics: { ...okReceipts().collectDiagnostics, runsRowFound: false },
      tokens: { runs: null, system: null },
    });
    const v1 = mod.verifyExecutionEvidence({ binding, receipts: missingRow });
    assert.equal(v1.ok, false);
    const row = v1.checks.find((c) => c.name === "evidence-run-row-found");
    assert.ok(row && !row.pass, "a missing run row must fail closed (never proof of zero)");
    const malformed = okReceipts({
      collectDiagnostics: {
        ...okReceipts().collectDiagnostics,
        malformedInvocationLines: [{ lineNumber: 3, error: "Unexpected end of JSON input", file: "invocations.jsonl" }],
      },
    });
    const v2 = mod.verifyExecutionEvidence({ binding, receipts: malformed });
    assert.equal(v2.ok, false);
    const mal = v2.checks.find((c) => c.name === "evidence-malformed-none");
    assert.ok(mal && !mal.pass, "malformed journal input must be diagnosed and refused");
  });

  it("an EMPTY events stream is an explicit FAILURE, never a vacuous every() pass", async () => {
    // Review refine: events-bound-to-fresh-run used events.every(...), which is
    // vacuously true on an empty stream while its failure message claimed an
    // empty stream cannot prove terminal/probe evidence. The concern is now
    // split: events-non-empty FAILS an empty stream explicitly.
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;
    const noEvents = okReceipts({ events: [] });
    const v = mod.verifyExecutionEvidence({ binding, receipts: noEvents });
    assert.equal(v.ok, false, "executed evidence with ZERO events must FAIL (empty stream proves nothing)");
    const nonEmpty = v.checks.find((c) => c.name === "events-non-empty");
    assert.ok(nonEmpty && !nonEmpty.pass, "events-non-empty must fail on an empty event stream");
  });

  it("REJECTS the four root receipt mutations while the unchanged positive still verifies", async () => {
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;

    // Unchanged control still PASSES.
    assert.equal(mod.verifyExecutionEvidence({ binding, receipts: okReceipts() }).ok, true, "unchanged positive must verify");

    const trials = [
      {
        name: "round-one-work-and-result-belong-to-foreign-run",
        checkName: "work-evidence-done",
        mutate: (r) => {
          for (const row of r.invocations) if (row.workIndex === 1) row.runId = "run-11111111-2222-4333-8444-555555555555";
        },
      },
      {
        name: "completion-result-binds-foreign-step-row",
        checkName: "work-evidence-done",
        mutate: (r) => {
          r.invocations.find((row) => row.phase === "result" && row.workIndex === 1).stepId = "step-11111111-2222-4333-8444-555555555555";
        },
      },
      {
        name: "duplicate-completion-result",
        checkName: "result-cardinality",
        mutate: (r) => {
          r.invocations.push(structuredClone(r.invocations.find((row) => row.phase === "result" && row.workIndex === 1)));
        },
      },
      {
        name: "extra-foreign-run-event",
        checkName: "events-bound-to-fresh-run",
        mutate: (r) => {
          r.events.push({ ts: "2026-09-09T00:00:09.000Z", event: "run.completed", runId: "11111111-2222-4333-8444-555555555555" });
        },
      },
    ];
    for (const trial of trials) {
      const receipts = okReceipts();
      trial.mutate(receipts);
      const v = mod.verifyExecutionEvidence({ binding, receipts });
      assert.equal(v.ok, false, `mutation [${trial.name}] must be REJECTED`);
      const bad = v.checks.find((c) => c.name === trial.checkName);
      assert.ok(bad && !bad.pass, `mutation [${trial.name}] must trip the ${trial.checkName} check`);
    }
  });

  it("REJECTS duplicate/extra work rows and step rows that are not actual fresh-run rows", async () => {
    const mod = await loadExecutor();
    const binding = mod.buildExecutionBinding({ plan: RETRY_PLAN, launchReceipt: launchReceipt() }).binding;
    // Duplicated WORK row (not just result) — unexplained extra work.
    const dupWork = okReceipts();
    dupWork.invocations.push(structuredClone(dupWork.invocations.find((row) => row.phase === "work" && row.workIndex === 0)));
    const v1 = mod.verifyExecutionEvidence({ binding, receipts: dupWork });
    assert.equal(v1.ok, false, "duplicate work row must fail (work-cardinality / per-action exactly-one)");
    // A result bound to a step row id that is NOT an actual fresh-run DB row.
    const foreignRow = okReceipts();
    for (const row of foreignRow.invocations) if (row.phase === "work" || row.phase === "result") row.stepId = "step-99999999-9999-4999-8999-999999999999";
    const v2 = mod.verifyExecutionEvidence({ binding, receipts: foreignRow });
    assert.equal(v2.ok, false, "journal rows must bind an ACTUAL fresh-run step row id (steps.id)");
    const bind = v2.checks.find((c) => c.name === "work-evidence-fail" || c.name === "work-evidence-done");
    assert.ok(bind && !bind.pass, "actual step-row identity binding must fail on a non-existent row id");
  });

  it("stopExactChild recognizes terminal handles immediately without re-signaling", async () => {
    const mod = await loadExecutor();
    // Already terminal BY SIGNAL (exitCode null, signalCode SIGTERM): the
    // exact root-probe scenario — must settle immediately with no kill call.
    const bySignal = fakeChild({ exitCode: null, signalCode: "SIGTERM" });
    const r1 = await mod.stopExactChild(bySignal);
    assert.equal(r1.exitObserved, true);
    assert.equal(r1.signal, "SIGTERM");
    assert.equal(r1.stopSignaled, false, "a terminal-by-signal handle must never be re-signaled");
    assert.deepEqual(bySignal.killCalls, [], "no SIGTERM may be sent to an already-terminal handle");
    // Already terminal BY CODE.
    const byCode = fakeChild({ exitCode: 7, signalCode: null });
    const r2 = await mod.stopExactChild(byCode);
    assert.equal(r2.exitObserved, true);
    assert.equal(r2.code, 7);
    assert.deepEqual(byCode.killCalls, [], "no signal for a terminal-by-code handle");
  });

  it("stopExactChild signals a live handle exactly once and awaits its exit", async () => {
    const mod = await loadExecutor();
    const live = fakeChild();
    const stopP = mod.stopExactChild(live, { sigkillAfterMs: 300, settleAfterSigkillMs: 200 });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(live.killCalls, ["SIGTERM"], "live handle gets exactly one SIGTERM");
    let settled = false;
    stopP.then(() => {
      settled = true;
    });
    assert.equal(settled, false, "stop must await the exit event, not resolve on the signal");
    live.emit("exit", null, "SIGTERM");
    const rec = await stopP;
    assert.equal(rec.exitObserved, true);
    assert.equal(rec.signal, "SIGTERM");
    assert.equal(rec.stopSignaled, true);
  });

  it("stopExactChild is bounded: a child that never exits yields a surfaced stopError, never an indefinite wait", async () => {
    const mod = await loadExecutor();
    const zombie = fakeChild();
    const rec = await mod.stopExactChild(zombie, { sigkillAfterMs: 150, settleAfterSigkillMs: 150 });
    assert.equal(rec.exitObserved, false);
    assert.equal(rec.stopSignaled, true);
    assert.ok(typeof rec.stopError === "string" && rec.stopError.length > 0,
      "an unexitable child must surface a cleanup stopError within bounds");
  });

  it("attachRunCliLifecycle: Run: receipt positive path reaps a naturally-exiting child", async () => {
    const mod = await loadExecutor();
    const child = fakeChild();
    const lc = mod.attachRunCliLifecycle({ child, readyTimeoutMs: 5000, naturalExitGraceMs: 300 });
    child.stdout.emit("data", "run #1 (abc123) created; preparing workspace...\nRun: run-abc12345-def0-4000-8000-000000000001\nWorkflow: do-now\n");
    const info = await lc.ready;
    assert.equal(info.prefix, "abc12345", "the Run: prefix is the hex run prefix the executor resolves by");
    assert.ok(info.stdout.includes("Run: run-abc12345"));
    // The CLI exits on its own right after Run: (code 0).
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const stopRec = await lc.stop();
    assert.equal(stopRec.exitObserved, true);
    assert.equal(stopRec.code, 0);
    assert.equal(stopRec.stopSignaled, false, "natural exit needs no signal");
    assert.deepEqual(child.killCalls, [], "a naturally-exiting child must not be signaled");
  });

  it("attachRunCliLifecycle: premature exit before Run: rejects ready but still owns the child", async () => {
    const mod = await loadExecutor();
    const child = fakeChild();
    const lc = mod.attachRunCliLifecycle({ child, readyTimeoutMs: 5000 });
    const readyP = lc.ready.then(
      () => null,
      (e) => e.message,
    );
    child.stdout.emit("data", "some stdout without Run:\n");
    child.exitCode = 3;
    child.emit("exit", 3, null);
    child.emit("close", 3, null);
    const msg = await readyP;
    assert.ok(typeof msg === "string" && msg.includes("exited before printing Run:"), `unexpected: ${msg}`);
    const stopRec = await lc.stop();
    assert.equal(stopRec.exitObserved, true);
    assert.equal(stopRec.code, 3);
    assert.deepEqual(child.killCalls, [], "prematurely-exited child needs no signal");
  });

  it("attachRunCliLifecycle: spawn error rejects ready with the spawn error and stop() is a no-op", async () => {
    const mod = await loadExecutor();
    const child = fakeChild();
    const lc = mod.attachRunCliLifecycle({ child, readyTimeoutMs: 5000 });
    const readyP = lc.ready.then(
      () => null,
      (e) => e.message,
    );
    child.emit("error", new Error("ENOENT: spawn node ENOENT"));
    const msg = await readyP;
    assert.ok(typeof msg === "string" && msg.includes("ENOENT"), `unexpected: ${msg}`);
    const stopRec = await lc.stop();
    assert.equal(stopRec.spawnError, "ENOENT: spawn node ENOENT");
    assert.equal(stopRec.stopError, null, "a spawn failure has no child to stop — not a cleanup failure");
    assert.deepEqual(child.killCalls, [], "no kill on a child that never spawned");
  });

  it("attachRunCliLifecycle: launch timeout rejects ready and stop() still attempts exact cleanup", async () => {
    const mod = await loadExecutor();
    const child = fakeChild();
    const lc = mod.attachRunCliLifecycle({ child, readyTimeoutMs: 60, naturalExitGraceMs: 0, sigkillAfterMs: 120, settleAfterSigkillMs: 100 });
    const readyP = lc.ready.then(
      () => null,
      (e) => e.message,
    );
    const msg = await readyP;
    assert.ok(typeof msg === "string" && msg.includes("launch timeout"), `unexpected: ${msg}`);
    // Child never prints Run: and never exits: stop() attempts SIGTERM and
    // surfaces the bounded cleanup failure instead of hanging.
    const stopRec = await lc.stop();
    assert.equal(stopRec.stopSignaled, true);
    assert.equal(stopRec.exitObserved, false);
    assert.ok(typeof stopRec.stopError === "string", "never-exiting launcher must surface stopError");
  });

  it("validateExecutablePlan refuses invalid/foreign/malformed/unknown/executed plans", async () => {
    const mod = await loadExecutor();
    const base = RETRY_PLAN;
    // US-001 residual-boundary negatives: the two root-probe payload
    // corruptions on the otherwise-valid plan — a claim_complete action whose
    // preservedOutputTexts is MISSING and one whose preserved text entry is a
    // NON-STRING — plus the exit-code shape rule (exitCode on a claim action).
    const claimCompleteAt = base.actions.findIndex((a) => a.type === "replay.claim_complete");
    const cloneWithoutPreserved = (plan, at) => ({
      ...plan,
      actions: plan.actions.map((a, i) => {
        if (i !== at) return a;
        const { preservedOutputTexts, ...rest } = a;
        return rest;
      }),
    });
    const cloneWithNonStringText = (plan, at) => ({
      ...plan,
      actions: plan.actions.map((a, i) =>
        i !== at
          ? a
          : { ...a, preservedOutputTexts: a.preservedOutputTexts.map((entry, ei) => (ei === 0 ? { ...entry, text: { not: "a string" } } : entry)) },
      ),
    });
    const negatives = [
      { name: "not-an-object", plan: null },
      { name: "wrong-adapter-version", plan: { ...base, adapterVersion: 2 } },
      { name: "unsupported-runtime", plan: { ...base, runtime: "dsh" } },
      { name: "foreign-admitted-run", plan: { ...base, admittedRunId: "run-src-other-00000000-0000-4000-8000-000000000099" } },
      { name: "zero-token-violation", plan: { ...base, zeroToken: false } },
      { name: "missing-record-run", plan: { ...(({ recordRunId, ...rest }) => rest)(base) } },
      { name: "unknown-action-type", plan: { ...base, actions: base.actions.map((a, i) => (i === 0 ? { ...a, type: "replay.self_modify" } : a)) } },
      { name: "action-foreign-run", plan: { ...base, actions: base.actions.map((a, i) => (i === 0 ? { ...a, runId: "run-src-other-00000000-0000-4000-8000-000000000099" } : a)) } },
      { name: "out-of-corridor-agent", plan: { ...base, actions: base.actions.map((a, i) => (i === 0 ? { ...a, agentId: "other_agent" } : a)) } },
      { name: "noncontiguous-indices", plan: { ...base, actions: base.actions.map((a) => ({ ...a, roundIndex: a.roundIndex === 1 ? 3 : a.roundIndex })) } },
      { name: "duplicate-action-id", plan: { ...base, actions: base.actions.map((a, i) => ({ ...a, id: i === 1 ? "fail" : a.id })) } },
      { name: "already-executed", plan: { ...base, execution: { executed: true } } },
      { name: "no-actions", plan: { ...base, actions: [] } },
      { name: "missing-preserved-claim-output", plan: cloneWithoutPreserved(base, claimCompleteAt), expectCode: "missing-preserved-output" },
      { name: "nonstring-preserved-claim-output", plan: cloneWithNonStringText(base, claimCompleteAt), expectCode: "preserved-text-not-string" },
      { name: "missing-preserved-fail-output", plan: cloneWithoutPreserved(base, 0), expectCode: "missing-preserved-output" },
      {
        name: "exit-code-on-claim-action",
        plan: { ...base, actions: base.actions.map((a, i) => (i === claimCompleteAt ? { ...a, exitCode: 7 } : a)) },
        expectCode: "invalid-exit-code",
      },
      {
        name: "oversized-unclaimed-exit-code",
        plan: corridorPlan({ actions: [{ id: "exit", type: "replay.unclaimed_exit", roundIndex: 0, exitCode: 300 }] }),
        expectCode: "invalid-exit-code",
      },
    ];
    for (const n of negatives) {
      const res = mod.validateExecutablePlan(n.plan);
      assert.equal(res.ok, false, `plan [${n.name}] must be refused`);
      assert.ok(Array.isArray(res.errors) && res.errors.length > 0, `plan [${n.name}] must carry refusal errors`);
      if (n.expectCode) {
        assert.ok(
          res.errors.some((e) => e.code === n.expectCode),
          `plan [${n.name}] refusal errors must include ${n.expectCode} (got ${res.errors.map((e) => e.code).join(",")})`,
        );
      }
    }
    const positive = mod.validateExecutablePlan(base);
    assert.equal(positive.ok, true, JSON.stringify(positive.errors));
  });

  it("executeReplayCase refuses invalid plans on the ACTUAL path with ZERO effect calls and no sandbox", async () => {
    const mod = await loadExecutor();
    const fs = await import("node:fs");
    const os = await import("node:os");
    const base = RETRY_PLAN;
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tier0-evidence-"));
    const claimCompleteAt = base.actions.findIndex((a) => a.type === "replay.claim_complete");
    // US-001: the two root-probe malformed preserved-output payloads on the
    // otherwise-valid plan — missing preservedOutputTexts and a non-string
    // preserved text entry.
    const missingOutputPlan = {
      ...base,
      actions: base.actions.map((a, i) => {
        if (i !== claimCompleteAt) return a;
        const { preservedOutputTexts, ...rest } = a;
        return rest;
      }),
    };
    const nonStringOutputPlan = {
      ...base,
      actions: base.actions.map((a, i) =>
        i !== claimCompleteAt
          ? a
          : { ...a, preservedOutputTexts: a.preservedOutputTexts.map((entry, ei) => (ei === 0 ? { ...entry, text: { not: "a string" } } : entry)) },
      ),
    };
    const cases = [
      { name: "malformed", plan: null },
      { name: "foreign", plan: { ...base, admittedRunId: "run-src-other-00000000-0000-4000-8000-000000000099" } },
      { name: "unknown-type", plan: { ...base, actions: base.actions.map((a, i) => (i === 0 ? { ...a, type: "replay.self_modify" } : a)) } },
      { name: "unsupported-runtime", plan: { ...base, runtime: "dsh" } },
      { name: "noncontiguous", plan: { ...base, actions: base.actions.map((a) => ({ ...a, roundIndex: a.roundIndex === 1 ? 3 : a.roundIndex })) } },
      { name: "executed-plan", plan: { ...base, execution: { executed: true } } },
      { name: "missing-preserved-claim-output", plan: missingOutputPlan, expectCode: "missing-preserved-output" },
      { name: "nonstring-preserved-claim-output", plan: nonStringOutputPlan, expectCode: "preserved-text-not-string" },
    ];
    for (const c of cases) {
      const rec = recordingHost();
      const before = fs.readdirSync(evidenceRoot).sort();
      const report = await mod.executeReplayCase({
        plan: c.plan,
        repoRoot: repoRoot,
        evidenceRoot,
        taskText: "refusal task",
        caseId: `refuse-${c.name}`,
        host: rec.host,
      });
      const after = fs.readdirSync(evidenceRoot).sort();
      assert.equal(report.ok, false, `executeReplayCase must refuse [${c.name}]`);
      assert.equal(report.executed, false, `[${c.name}] must never execute`);
      assert.equal(report.refused, true, `[${c.name}] must be a structured refusal`);
      assert.equal(report.sandbox, null, `[${c.name}] must create no sandbox`);
      assert.equal(report.daemonStop, null, `[${c.name}] must not stop any daemon`);
      assert.equal(report.launchStop, null, `[${c.name}] must not stop any launcher`);
      assert.deepEqual(rec.calls, [], `[${c.name}] must make ZERO recorded effect calls (got ${rec.calls.join(",")})`);
      assert.deepEqual(before, after, `[${c.name}] must not create anything under the evidence root`);
      if (c.expectCode) {
        assert.ok(
          (report.refusalErrors ?? []).some((e) => e.code === c.expectCode),
          `[${c.name}] refusalErrors must include ${c.expectCode} (got ${(report.refusalErrors ?? []).map((e) => e.code).join(",")})`,
        );
      }
    }
    // The scratch evidence root under os.tmpdir() is left for the OS to
    // reclaim — never deleted here (no-actual-removal rule) and never inside
    // the repository.
  });

  it("daemon spawn error: executeReplayCase records spawnError with ZERO re-signal, no stopError, no ~8s stall", async () => {
    // Review Issue 3: if spawnIsolatedDaemon's child emits 'error' (the daemon
    // process NEVER spawned), executeReplayCase's finally used to call
    // stopExactChild on that child — SIGTERM on a nonexistent process and the
    // full bounded settle window (~8s) producing a spurious stopError/cleanup
    // failure. The daemon stop path must now short-circuit on the recorded
    // spawnError exactly like attachRunCliLifecycle does for the launcher.
    const mod = await loadExecutor();
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { EventEmitter } = await import("node:events");
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tier0-spawnerr-evidence-"));

    const spawnErrorMessage = "ENOENT: spawn daemon ENOENT (recording, no real process)";
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    const killCalls = [];
    child.kill = (signal) => {
      killCalls.push(signal);
      return false;
    };
    const stopCalls = [];
    const probeCalls = [];
    const sandboxStub = {
      root: "/virt/root",
      homeDir: "/virt/home",
      tamanduaDir: "/virt/home/.tamandua",
      workdir: "/virt/workdir",
      stateDir: "/virt/state",
      binDir: "/virt/bin",
      hermesHome: "/virt/hermes-home",
      dbPath: "/virt/home/.tamandua/tamandua.db",
    };
    const host = {
      createSandbox: () => sandboxStub,
      reserveRandomPort: () => 43210,
      materializeBehaviorsFile: () => ({ behaviorsPath: "/virt/behaviors.json", seed: { behaviorsConfig: {} } }),
      materializeRuntimeWrapper: () => "/virt/scripted-pi",
      installCorridorWorkflow: () => "",
      // A daemon handle whose child emitted 'error' at spawn: no process was
      // created, ready rejects with the spawn error, and the handle records it
      // exactly like the real spawnIsolatedDaemon does.
      spawnIsolatedDaemon: () => ({
        child,
        ready: Promise.reject(new Error(spawnErrorMessage)),
        spawnError: () => spawnErrorMessage,
        transcript: () => "",
      }),
      stopExactChild: async (...args) => {
        stopCalls.push(args);
        return { code: null, signal: null, exitObserved: false, stopSignaled: false, stopError: null };
      },
      probePortClosed: async () => {
        probeCalls.push(1);
        return { state: "released", detail: "should not be called for a never-spawned daemon" };
      },
    };

    const report = await mod.executeReplayCase({
      plan: RETRY_PLAN,
      repoRoot,
      evidenceRoot,
      taskText: "daemon spawn error",
      caseId: "daemon-spawn-error",
      host,
    });

    assert.equal(report.ok, false, "a daemon spawn error must fail the case");
    assert.equal(report.executed, true, "the case attempted execution (failed at daemon spawn)");
    assert.ok(
      report.error && report.error.message.includes("ENOENT"),
      `the PRIMARY spawn error must be preserved, got ${JSON.stringify(report.error)}`,
    );
    assert.ok(report.daemonStop, "daemonStop record must exist");
    assert.equal(report.daemonStop.spawnError, spawnErrorMessage, "spawn error recorded on daemonStop");
    assert.equal(report.daemonStop.stopError, null, "a never-spawned child must NOT produce a spurious stopError");
    assert.equal(report.daemonStop.stopSignaled, false, "a never-spawned child must never be signaled");
    assert.equal(report.daemonStop.exitObserved, false, "no exit event can exist for a never-spawned process");
    assert.deepEqual(killCalls, [], "ZERO kill calls on a child that never spawned");
    assert.deepEqual(stopCalls, [], "stopExactChild must not be invoked for a never-spawned daemon (no ~8s stall)");
    assert.deepEqual(probeCalls, [], "control-port probe not required: no listener ever existed");
    assert.equal(report.cleanup?.clean, true, "no spurious cleanup failure for a process that never existed");
    assert.equal(report.launchStop, null, "no launcher was created");
  });

  it("materializeRuntimeSeed refuses a semantically invalid preserved-output payload (US-001 seed trust)", async () => {
    // US-001 acceptance 3: materializeRuntimeSeed — the pure producer of the
    // canned-behavior bytes handed to the frozen runtimes — must validate the
    // COMPLETE semantic payload of every work action it shapes into bytes.
    // Missing preserved output on a claim action must already throw (never
    // invent bytes), and a NON-STRING preserved text entry must now ALSO throw
    // loudly instead of being silently filtered out of the joined bytes (a
    // silent filter would fabricate a byte shape the record never claimed).
    const fs = await import("node:fs");
    const adapterPath = path.join(repoRoot, "torture-test", "bin", "core-recording-replay-adapter.mjs");
    const adapter = await import(pathToFileURL(adapterPath).href);
    const base = RETRY_PLAN;
    const claimCompleteAt = base.actions.findIndex((a) => a.type === "replay.claim_complete");

    const missingOutputPlan = {
      ...base,
      actions: base.actions.map((a, i) => {
        if (i !== claimCompleteAt) return a;
        const { preservedOutputTexts, ...rest } = a;
        return rest;
      }),
    };
    const nonStringOutputPlan = {
      ...base,
      actions: base.actions.map((a, i) =>
        i !== claimCompleteAt
          ? a
          : { ...a, preservedOutputTexts: a.preservedOutputTexts.map((entry, ei) => (ei === 0 ? { ...entry, text: { not: "a string" } } : entry)) },
      ),
    };
    const nonStringUnclaimedPlan = {
      adapterVersion: 3,
      runtime: "pi",
      admittedRunId: SOURCE_RUN,
      recordRunId: SOURCE_RUN,
      recordPayloadSha256: "abc123".repeat(8),
      zeroToken: true,
      actions: [
        Object.freeze({
          id: "exit",
          type: "replay.unclaimed_exit",
          runId: SOURCE_RUN,
          operationId: "op-exit",
          agentId: AGENT,
          roundIndex: 0,
          exitCode: 3,
          preservedOutputTexts: Object.freeze([{ observationId: "obs-exit", text: { not: "a string" } }]),
        }),
      ],
    };

    for (const [label, plan] of [
      ["missing-preserved-claim-output", missingOutputPlan],
      ["nonstring-preserved-claim-output", nonStringOutputPlan],
      ["nonstring-preserved-unclaimed-stdout", nonStringUnclaimedPlan],
    ]) {
      assert.throws(
        () => adapter.materializeRuntimeSeed(plan),
        (e) => e instanceof TypeError && /materializeRuntimeSeed refuses/.test(e.message),
        `materializeRuntimeSeed must refuse [${label}] before shaping any bytes`,
      );
    }
    // The unchanged valid plan still materializes a byte-joined seed.
    const okSeed = adapter.materializeRuntimeSeed(base);
    const doneBehavior = okSeed.behaviorsConfig.agents[AGENT].find((b) => String(b.output ?? "").includes("CHANGES: ok"));
    assert.ok(doneBehavior, "valid claim_complete behavior must materialize");
    assert.equal(doneBehavior.output, "STATUS: done\nCHANGES: ok\n");
  });
});
