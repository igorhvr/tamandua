#!/usr/bin/env node
// core-recording-motor-gate.mjs — CORE-MOTOR designated conformance gate
// (US-003 REAL isolated-motor execution qualification; torture-only).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.3, authorized bounded REAL SCRIPTED
// motor slice "CORE-MOTOR". ONE focused executable regression entrypoint with
// staged safety preflight then actual isolated execution:
//
//   Stage 0 — preflight: checkout/dist/frozen-runtime presence, git source
//       hash snapshot, source-hash revalidation bookkeeping, no live-HOME use.
//   Stage 1 — staged safety preflight (recorded/injected OS adapters): the
//       REAL validateReplayPlan / materializeRuntimeSeed /
//       buildExecutionBinding / verifyExecutionEvidence code paths run against
//       virtual (recording) filesystem/motor adapters. Every negative input
//       (unknown type, sparse indices, path escape, root substitution,
//       identity mismatch, equal-identity binding, gapped verified success,
//       and the US-001 malformed preserved-output payloads — a claim_complete
//       with preservedOutputTexts MISSING or a NON-STRING preserved text)
//       must be REFUSED with ZERO plan product — the refusal-path journals
//       are inspected per refusal and must carry ZERO effect-class entries
//       (only pure realpath/identity consults), so the "zero effects on
//       refusal" claim is measured, not assumed. The END-TO-END proof that a
//       refused plan never reaches executeReplayCase (and never spawns a
//       daemon) is the stage-2 refused-plan negative leg.
//   Stage 1P — spawnDiePipe pipe-lifetime negatives (US-001, recording child
//       handles only, BEFORE any actual child leg): the REAL spawnDiePipe code
//       path driven through an injected recording `spawn` proves a timeout
//       never resolves before the child's exit/close and never upgrades to
//       success, the SIGKILL handshake failure is reported separately
//       (cleanupError) with a bounded settle, spawn-error settles once with
//       zero signals, and natural exit/close settles once ok:true with
//       byte-complete stdout. Zero real processes, zero OS signals.
//   Stage 2 — actual pi AND hermes runs through the REAL
//       daemon/scheduler→probe→frozen runtime→claim/complete/fail protocol on
//       explicit SYNTHETIC recordings, with mechanical DB/event/process
//       receipts, cross-run negatives, PRE-RUN idle observation (daemon up,
//       no run created yet: real nudges spawn zero harness work), post-
//       terminal idle observation, and run/system token accounting exactly
//       zero. Two negative legs run here too: a refused-plan leg (hostile
//       plan on real adapters → refused before effects, zero sandbox/daemon)
//       and a forced-failure leg (injected launch failure → the executor's
//       REAL error path returns an ok:false case report carrying the ORIGINAL
//       error, with exact child shutdown evidenced).
//   Stage 3 — first actual byte-exact die-before-claim pipe test on BOTH
//       frozen runtimes: empty, newline, no-final-newline, UTF-8 and two
//       payloads larger than a pipe buffer; producer exit/status and complete
//       stdout bytes preserved (Buffer-equal), not a preview.
//   Stage 4 — real filesystem root/base/candidate replacement refusal and a
//       canonical-alias positive control in fresh owned fixtures (real
//       realpath/lstat identity); no foreign/operator path mutation and no
//       actual removal — everything exact rename/mkdir/unlink on owned files,
//       original objects restored, fixtures RETAINED.
//   Stage 5 — per-case report + evidence + contract JSON + honest remaining
//       CORE work.
//
// Usage (repo root, dist built, single invocation — never concurrently with
// another torture self-test file):
//   node torture-test/bin/core-recording-motor-gate.mjs \
//       [--evidence-dir <abs path>] [--task-suffix <label>]
//
// Exit code 0 only when every leg passes; missing/failed legs are never
// hidden as skipped/PASS. All evidence lands under the retained evidence dir
// (default <repo>/torture-test/var/review-logs/core-motor-<UTC>Z/).

import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateRecordingRecord } from "./core-recording-contract.mjs";
import {
  REPLAY_ADAPTER_VERSION,
  validateReplayPlan,
  validateCleanupPhase,
  materializeRuntimeSeed,
} from "./core-recording-replay-adapter.mjs";
import {
  REPLAY_CORRIDOR_AGENT,
  REPLAY_CORRIDOR_STEP,
  REPLAY_CORRIDOR_WORKFLOW,
  buildExecutionBinding,
  verifyExecutionEvidence,
  createRealAdapters,
  executeReplayCase,
  attachRunCliLifecycle,
  stopExactChild,
  runCliSync,
} from "./core-recording-replay-executor.mjs";

// ── CLI / paths ────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli", "cli.js");
const DAEMON = path.join(REPO_ROOT, "dist", "server", "daemon.js");
const RUNTIME_PI = path.join(REPO_ROOT, "torture-test", "scripted-runtimes", "runtime-pi.mjs");
const RUNTIME_HERMES = path.join(REPO_ROOT, "torture-test", "scripted-runtimes", "runtime-hermes.mjs");

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const TASK_SUFFIX = argValue("--task-suffix") ?? "core-motor";

// ── Evidence dir ───────────────────────────────────────────────────

const nowUtc = new Date().toISOString().replace(/[:.]/g, "-");
const EVIDENCE_DIR =
  argValue("--evidence-dir") ??
  path.join(REPO_ROOT, "torture-test", "var", "review-logs", `core-motor-${nowUtc}Z`);
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ── Tiny reporter ─────────────────────────────────────────────────

let failures = 0;
let passes = 0;
const stageLines = [];
function note(stage, text) {
  stageLines.push({ stage, text });
  console.log(`[${stage}] ${text}`);
}
function ok(stage, text) {
  passes += 1;
  note(stage, `PASS ${text}`);
}
function bad(stage, text) {
  failures += 1;
  note(stage, `FAIL ${text}`);
}
function check(stage, cond, text) {
  if (cond) ok(stage, text);
  else bad(stage, text);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fileSha = (p) => sha256(fs.readFileSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Real adapters for the adapter module's injected slots. */
function realAdapters() {
  return createRealAdapters();
}

// ── Synthetic record + plan builders (explicitly synthetic) ────────

// A synthetic record declares exactly one locator (scoped per record), so a
// stable locatorId per record is correct and referential integrity holds.
function locatorFor(runId) {
  return {
    locatorId: "SL1",
    runId,
    locator: { source_file: `synthetic-${TASK_SUFFIX}.jsonl`, row: 7 },
    sha256: sha256(`synthetic-locator:${runId}`),
  };
}
function synthSourceSha(label) {
  return sha256(`synthetic-source:${label}`);
}

/**
 * Build a deep-frozen, fully synthetic US-001 recording record for a case.
 * Nothing is imported from the historical source inventory; every run id,
 * agent id, locator, observation and byte is a declared synthetic fixture.
 */
async function buildSyntheticRecord({
  kind,
  runId,
  caseId,
  ops,
  observations,
  outcomes,
  unknown = [],
}) {
  const mod = await import("./core-recording-contract.mjs");
  const record = mod.buildRecordingRecord({
    sourceIdentity: {
      kind,
      runId,
      caseId: `SYNTH-${caseId}`,
      sourceRefs: [locatorFor(runId)],
      sourceSha256: synthSourceSha(caseId),
    },
    observations,
    transformations: [
      {
        step: "adapt.synthetic_fixture",
        note: `entire ${caseId} corpus is synthetic (CORE-MOTOR infrastructure gate); no historical specimen is claimed`,
        sourceRef: "SL1",
      },
    ],
    operations: ops.map((op) => ({
      id: op.id,
      type: op.type,
      sourceRef: "SL1",
      ...(op.evidenceRefs ? { evidenceRefs: op.evidenceRefs } : {}),
      ...(op.exitCode !== undefined ? { exitCode: op.exitCode } : {}),
    })),
    expectedOutcomes: outcomes,
    unknown,
  });
  const fmt = validateRecordingRecord(record);
  if (!fmt.ok) throw new Error(`synthetic record failed format: ${JSON.stringify(fmt.errors)}`);
  return record;
}

const CORRIDOR_RUN_ID_PREFIX = "run-src-motor";

// Case specifications (actions mirror the corridor agent do-now_doer).
const CASES = [
  {
    caseId: "pi-retry",
    runtime: "pi",
    kind: "pi",
    taskText:
      `CORE-MOTOR synthetic pi-retry: replay a reviewed claim_fail followed by ` +
      `claim_complete through the real isolated motor. No real model, no shell. ` +
      `Source identity is synthetic (${TASK_SUFFIX}); bind every step to the fresh run.`,
    ops: [
      { id: "op-fail", type: "replay.claim_fail", evidenceRefs: ["obs-fail"] },
      { id: "op-done", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
      { id: "op-idle", type: "replay.idle_dispatch" },
    ],
    observations: [
      {
        id: "obs-fail",
        fact: { kind: "public-output", text: "synthetic pi-retry refusal reason (source-backed)" },
        sourceRef: "SL1",
      },
      {
        id: "obs-done",
        fact: {
          kind: "public-output",
          text: "STATUS: done\nCHANGES: pi-retry replayed through real isolated motor\nREPORT: claim_fail@0 then claim_complete@1 on the fresh run\nKEY: core-motor-pi-retry",
        },
        sourceRef: "SL1",
      },
    ],
    actions: [
      {
        id: "a-fail",
        type: "replay.claim_fail",
        runId: null, // filled below with the source run id
        operationId: "op-fail",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 0,
        outputRefs: ["obs-fail"],
      },
      {
        id: "a-done",
        type: "replay.claim_complete",
        runId: null,
        operationId: "op-done",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 1,
        outputRefs: ["obs-done"],
        verdict: "verified",
      },
      {
        id: "a-idle",
        type: "replay.idle_dispatch",
        runId: null,
        operationId: "op-idle",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 0,
      },
    ],
  },
  {
    caseId: "pi-unclaimed",
    runtime: "pi",
    kind: "pi",
    taskText:
      `CORE-MOTOR synthetic pi-unclaimed: replay a die-before-claim round (exit 3, ` +
      `preserved stdout) followed by claim_complete through the real isolated motor.`,
    ops: [
      { id: "op-exit", type: "replay.unclaimed_exit", evidenceRefs: ["obs-exit"] },
      { id: "op-done", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
    ],
    observations: [
      {
        id: "obs-exit",
        fact: { kind: "public-output", text: "synthetic pi unclaimed-round payload\n" },
        sourceRef: "SL1",
      },
      {
        id: "obs-done",
        fact: {
          kind: "public-output",
          text: "STATUS: done\nCHANGES: pi-unclaimed completed after die-before-claim\nKEY: core-motor-pi-unclaimed",
        },
        sourceRef: "SL1",
      },
    ],
    actions: [
      {
        id: "a-exit",
        type: "replay.unclaimed_exit",
        runId: null,
        operationId: "op-exit",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 0,
        exitCode: 3,
        outputRefs: ["obs-exit"],
      },
      {
        id: "a-done",
        type: "replay.claim_complete",
        runId: null,
        operationId: "op-done",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 1,
        outputRefs: ["obs-done"],
        verdict: "verified",
      },
    ],
  },
  {
    caseId: "hermes-all",
    runtime: "hermes",
    kind: "hermes",
    taskText:
      `CORE-MOTOR synthetic hermes-all: replay die-before-claim@0 (exit 7, preserved ` +
      `UTF-8 stdout), claim_fail@1 and claim_complete@2 on the hermes frozen runtime ` +
      `through the real isolated motor. No dsh coverage is claimed.`,
    ops: [
      { id: "op-exit", type: "replay.unclaimed_exit", evidenceRefs: ["obs-exit"] },
      { id: "op-fail", type: "replay.claim_fail", evidenceRefs: ["obs-fail"] },
      { id: "op-done", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
      { id: "op-idle", type: "replay.idle_dispatch" },
    ],
    observations: [
      {
        id: "obs-exit",
        fact: { kind: "public-output", text: "hermes unclaimed ✓ bytes — wörld\n" },
        sourceRef: "SL1",
      },
      {
        id: "obs-fail",
        fact: { kind: "public-output", text: "synthetic hermes refusal reason" },
        sourceRef: "SL1",
      },
      {
        id: "obs-done",
        fact: {
          kind: "public-output",
          text: "STATUS: done\nCHANGES: hermes-all completed all work actions\nKEY: core-motor-hermes-all",
        },
        sourceRef: "SL1",
      },
    ],
    actions: [
      {
        id: "a-exit",
        type: "replay.unclaimed_exit",
        runId: null,
        operationId: "op-exit",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 0,
        exitCode: 7,
        outputRefs: ["obs-exit"],
      },
      {
        id: "a-fail",
        type: "replay.claim_fail",
        runId: null,
        operationId: "op-fail",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 1,
        outputRefs: ["obs-fail"],
      },
      {
        id: "a-done",
        type: "replay.claim_complete",
        runId: null,
        operationId: "op-done",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 2,
        outputRefs: ["obs-done"],
        verdict: "verified",
      },
      {
        id: "a-idle",
        type: "replay.idle_dispatch",
        runId: null,
        operationId: "op-idle",
        agentId: REPLAY_CORRIDOR_AGENT,
        roundIndex: 0,
      },
    ],
  },
];

/**
 * Full concrete outcome list mirroring the case ops (each outcome carries the
 * operationRef the executor requires — no unattributed outcome claims).
 */
function outcomesFor(caseSpec) {
  return caseSpec.ops.map((op, i) => ({
    id: `oc-${i}`,
    outcome: { description: `${op.type} executed and receipted on the fresh run` },
    sourceRef: "SL1",
    operationRef: op.id,
    ...(op.evidenceRefs ? { evidenceRefs: op.evidenceRefs } : {}),
  }));
}

async function buildCasePlan(caseSpec, sourceRunId) {
  const record = await buildSyntheticRecord({
    kind: caseSpec.kind,
    runId: sourceRunId,
    caseId: caseSpec.caseId,
    ops: caseSpec.ops,
    observations: caseSpec.observations,
    outcomes: outcomesFor(caseSpec),
  });
  const actions = caseSpec.actions.map((a) => ({ ...a, runId: sourceRunId }));
  return { record, actions };
}

/** A real owned plan-root fixture inside the evidence dir (created fresh). */
function createPlanFixtureRoots(caseId) {
  const base = path.join(EVIDENCE_DIR, "plan-fixtures", caseId, "base");
  const root = path.join(base, "fixture-root");
  fs.mkdirSync(root, { recursive: true });
  const adapters = realAdapters();
  const baseReal = adapters.realpath(base);
  const rootReal = adapters.realpath(root);
  return {
    ownedRoot: {
      id: `plan-root-${caseId}`,
      path: rootReal,
      base: baseReal,
      admissionIdentity: {
        root: adapters.objectIdentity(rootReal),
        base: adapters.objectIdentity(baseReal),
      },
    },
    rootReal,
    baseReal,
    adapters,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Stage 0 — preflight
// ═══════════════════════════════════════════════════════════════════

async function stage0() {
  note("S0", `evidence dir: ${EVIDENCE_DIR}`);
  check("S0", fs.existsSync(path.join(REPO_ROOT, "dist", "cli", "cli.js")), `dist build present (${CLI})`);
  check("S0", fs.existsSync(DAEMON), `daemon script present (${DAEMON})`);
  check("S0", fs.existsSync(RUNTIME_PI) && fs.existsSync(RUNTIME_HERMES), "frozen runtimes present");
  check("S0", fs.existsSync(path.join(REPO_ROOT, "torture-test", "scripted-runtimes", "runtime-shared.mjs")), "frozen runtime-shared present");
  // Source hashes snapshot (revalidated at the end of stage 5). The list
  // includes every source file the gate's own evidence depends on — the
  // executor, the gate itself, the pure adapter/contract modules, the frozen
  // runtime files AND the focused executor regression file that exercises the
  // pure binding/verification paths (added per review: a mid-gate edit to the
  // regression test must also trip sourceStable).
  const sourceFiles = [
    "torture-test/bin/core-recording-replay-executor.mjs",
    "torture-test/bin/core-recording-motor-gate.mjs",
    "torture-test/bin/core-recording-replay-adapter.mjs",
    "torture-test/bin/core-recording-contract.mjs",
    "torture-test/scripted-runtimes/runtime-pi.mjs",
    "torture-test/scripted-runtimes/runtime-hermes.mjs",
    "torture-test/scripted-runtimes/runtime-shared.mjs",
    "torture-test/scripted-runtimes/KNOB-REGIONS.md",
    "torture-test/self-tests/tier0-core-recording-replay-executor.test.ts",
  ];
  const shaOut = {};
  for (const rel of sourceFiles) {
    const abs = path.join(REPO_ROOT, rel);
    shaOut[rel] = fs.existsSync(abs) ? fileSha(abs) : null;
  }
  return { sourceShas: shaOut, gitHead: gitHead(), gitTree: gitTree(), gitStatusShort: gitStatusShort() };
}

function gitHead() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "(no git)";
}

/** Tree hash of the current HEAD (the commit the gate's tree will become). */
function gitTree() {
  const r = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "(no git)";
}

/**
 * Short porcelain status of the tracked torture source files this gate hashes.
 * Non-empty means the gate is running on an UNCOMMITTED tree: gitHead is the
 * parent commit and the tested bytes are the working-tree bytes recorded in
 * sourceShasStart/End (attribution note on gate-report.json explains this).
 */
function gitStatusShort() {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "(no git)";
}

// ═══════════════════════════════════════════════════════════════════
// Stage 1 — staged safety preflight (recording adapters; zero effects)
// ═══════════════════════════════════════════════════════════════════

/**
 * Recording (virtual) filesystem adapter: journals every realpath/identity
 * call; refuses nothing (pure). Used ONLY here, in stage 1, to prove the real
 * validation code path refuses hostile plans with zero host effects.
 */
function createRecordingFsAdapter(journal) {
  const identityMap = new Map();
  const overrides = new Map();
  const errors = new Map();
  return {
    realpath(p) {
      journal.push(`realpath:${p}`);
      if (errors.has(p)) throw new Error(errors.get(p));
      if (overrides.has(p)) return overrides.get(p);
      return p;
    },
    identity(p) {
      journal.push(`identity:${p}`);
      const found = identityMap.get(p);
      return found ? { ...found } : { dev: 7, ino: hashIno(p) };
    },
    setIdentity(p, id) {
      identityMap.set(p, { ...id });
    },
    override(p, to) {
      overrides.set(p, to);
    },
    overrideError(p, msg) {
      errors.set(p, msg);
    },
  };
}
function hashIno(p) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < p.length; i += 1) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const REC_FIXTURE_BASE = "/virt/synth-owner";
const REC_FIXTURE_ROOT = "/virt/synth-owner/fixture-root";
const REC_FIXTURE_REL = "fixtures/notes.json";
const REC_AGENT = REPLAY_CORRIDOR_AGENT;
const REC_RUN = `${CORRIDOR_RUN_ID_PREFIX}-00000000-0000-4000-8000-000000000000`;
const REC_OTHER_RUN = `${CORRIDOR_RUN_ID_PREFIX}-11111111-2222-4333-8444-555555555555`;

async function stage1() {
  // Instrumented refusal-path evidence (see the battery below): every
  // negative must return ok:false with NO plan product, and the injected
  // recording adapters' journals must contain ONLY pure realpath/identity
  // consult entries — zero effect-class entries. These are measured from the
  // journals themselves, not from a self-referential counter.
  let effectClassEntries = 0;
  let negativeCount = 0;
  let noPlanRefusals = 0;
  const spec = CASES[0]; // pi-retry shape is the canonical full-vocabulary record
  const { record, actions } = await buildCasePlan(spec, REC_RUN);

  // Positive control on recording adapters: complete-plan validation produces
  // a plan whose recorded entrypoints + seed are exact.
  {
    const journal = [];
    const fsAdapter = createRecordingFsAdapter(journal);
    fsAdapter.setIdentity(REC_FIXTURE_BASE, { dev: 7, ino: 100 });
    fsAdapter.setIdentity(REC_FIXTURE_ROOT, { dev: 7, ino: 101 });
    const res = validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: REC_RUN,
      ownedRoot: {
        id: "fixtures",
        path: REC_FIXTURE_ROOT,
        base: REC_FIXTURE_BASE,
        admissionIdentity: { root: { dev: 7, ino: 101 }, base: { dev: 7, ino: 100 } },
      },
      actions,
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    check("S1", res.ok === true, `positive plan validates (recording adapters): ${res.ok ? "ok" : JSON.stringify(res.errors)}`);
    if (res.ok) {
      check("S1", res.plan.execution.executed === false && res.plan.execution.scope === "validation-only", "adapter plan stays executed:false (validation product)");
      check("S1", res.plan.zeroToken === true, "plan zeroToken");
      const seed = materializeRuntimeSeed(res.plan);
      const doer = seed.behaviorsConfig.agents[REC_AGENT];
      check("S1", Array.isArray(doer) && doer.length === 2, "seed carries exactly 2 pi-retry work behaviors");
      check("S1", doer[0].mode === "work" && doer[0].stepAction === "fail", "seed[0] is the fail behavior");
      check("S1", doer[1].output.startsWith("STATUS: done"), "seed[1] preserves the report bytes");
      check("S1", seed.behaviorsConfig.heartbeatTokens === 0 && seed.behaviorsConfig.defaultTokens === 0, "seed token knobs zero");
      const entrypointKinds = res.plan.actions.map((a) => a.entrypoints.map((e) => e.kind)).flat();
      check(
        "S1",
        JSON.stringify(entrypointKinds) ===
          JSON.stringify(["step-cli.claim", "step-cli.fail", "step-cli.claim", "step-cli.complete", "dispatch.idle"]),
        `recorded entrypoint kinds exact: ${entrypointKinds.join(",")}`,
      );
    }
  }

  // Negative battery — every refusal must leave ZERO plan/effects. Each
  // refusal's adapter journal is inspected: effect-class entries would be any
  // journal line that is not a pure realpath/identity consult.
  const negativeBattery = [
    {
      name: "unknown action type (closed vocabulary)",
      expect: "unknown-type",
      actionsFor: () => [{ ...actions[0], id: "a-x", type: "replay.self_modify" }],
    },
    {
      name: "sparse work-invocation indices (would invent unrecorded successes)",
      expect: "noncontiguous-round-indices",
      actionsFor: () => [{ ...actions[0], id: "a-sparse", roundIndex: 2 }],
    },
    {
      name: "path escape (absolute fixture path)",
      expect: "path-escape",
      actionsFor: () => [{ ...actions[0], fixturePath: "/etc/hostile-target" }],
    },
    {
      name: "mixed run identity in an action",
      expect: "mixed-run",
      actionsFor: () => [{ ...actions[0], id: "a-other", runId: REC_OTHER_RUN }],
    },
    {
      name: "admitted run mismatch (identity-mismatch)",
      expect: "identity-mismatch",
      admittedRunId: REC_OTHER_RUN,
      actionsFor: () => actions,
    },
    {
      name: "verified success over a declared global unknown gap",
      expect: "unknown-evidence-verified",
      gapped: true,
      actionsFor: () => actions,
    },
    {
      name: "symlinked root substitution via realpath override",
      expect: "root-substitution",
      rootOverride: "/var/elsewhere/stolen-root",
      actionsFor: () => actions,
    },
  ];
  for (const item of negativeBattery) {
    const journal = [];
    const fsAdapter = createRecordingFsAdapter(journal);
    fsAdapter.setIdentity(REC_FIXTURE_BASE, { dev: 7, ino: 100 });
    fsAdapter.setIdentity(REC_FIXTURE_ROOT, { dev: 7, ino: 101 });
    if (item.rootOverride) fsAdapter.override(REC_FIXTURE_ROOT, item.rootOverride);
    const recordForCase = item.gapped
      ? await buildSyntheticRecord({
          kind: spec.kind,
          runId: REC_RUN,
          caseId: `${spec.caseId}-gapped`,
          ops: spec.ops,
          observations: spec.observations,
          outcomes: outcomesFor(spec),
          unknown: [{ fact: "preserved bytes for op-done are not retained", reason: "missing" }],
        })
      : record;
    const res = validateReplayPlan({
      record: recordForCase,
      runtime: "pi",
      admittedRunId: item.admittedRunId ?? REC_RUN,
      ownedRoot: {
        id: "fixtures",
        path: REC_FIXTURE_ROOT,
        base: REC_FIXTURE_BASE,
        admissionIdentity: { root: { dev: 7, ino: 101 }, base: { dev: 7, ino: 100 } },
      },
      actions: item.actionsFor(),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    const found = (res.errors ?? []).some((e) => e.code === item.expect);
    const noPlan = res.ok === false && res.plan === undefined;
    const journalEffectLines = journal.filter((line) => !line.startsWith("realpath:") && !line.startsWith("identity:"));
    effectClassEntries += journalEffectLines.length;
    negativeCount += 1;
    if (noPlan) noPlanRefusals += 1;
    check("S1", res.ok === false && found && noPlan, `negative [${item.name}] refused with ${item.expect}, no plan product (${journalEffectLines.length} effect-class journal lines)`);
  }
  check("S1", effectClassEntries === 0, `refusal journals carry ZERO effect-class entries across ${negativeCount} negatives (only pure realpath/identity consults)`);
  check("S1", noPlanRefusals === negativeCount, `every one of ${negativeCount} negatives returned ok:false with no plan object (refusal happens before any plan materializes)`);

  // Execution-binding negatives (pure, before any launch).
  {
    const res = buildExecutionBinding({
      plan: {
        adapterVersion: REPLAY_ADAPTER_VERSION,
        recordRunId: REC_RUN,
        recordPayloadSha256: sha256("x"),
        runtime: "pi",
        zeroToken: true,
        actions: [],
      },
      launchReceipt: {
        freshRunId: REC_RUN, // must NEVER equal the source run id
        workflowId: REPLAY_CORRIDOR_WORKFLOW,
        workdir: "/virt/workdir",
        launchedAtUtc: "2026-09-09T00:00:00.000Z",
        harnessType: "pi",
      },
    });
    check("S1", res.ok === false && res.errors.some((e) => e.code === "binding-equal-identity"), "binding refuses source==fresh identity (no historical uuid reuse)");
  }

  // ── S1 (CORE-MOTOR-CLOSE B): the ACTUAL executeReplayCase entry path must
  // refuse invalid/foreign/malformed/unknown plans BEFORE any effect. A
  // recording host over the executor's own OS-effect functions (createSandbox,
  // install, daemon spawn, run launch, …) proves ZERO effect calls, and the
  // evidence root is unchanged (no sandbox directory appears).
  {
    const fsAdapter = createRecordingFsAdapter([]);
    fsAdapter.setIdentity(REC_FIXTURE_BASE, { dev: 7, ino: 100 });
    fsAdapter.setIdentity(REC_FIXTURE_ROOT, { dev: 7, ino: 101 });
    const evidenceRoot = path.join(EVIDENCE_DIR, "s1-refusal-root");
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const refuseRootEntries = fs.readdirSync(evidenceRoot).sort();
    const rec = { calls: [] };
    const wrap = (name) => (...args) => {
      rec.calls.push(name);
      return undefined;
    };
    const host = {
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
    };
    const positivePlanRes = validateReplayPlan({
      record,
      runtime: spec.runtime,
      admittedRunId: REC_RUN,
      ownedRoot: {
        id: "fixtures",
        path: REC_FIXTURE_ROOT,
        base: REC_FIXTURE_BASE,
        admissionIdentity: { root: { dev: 7, ino: 101 }, base: { dev: 7, ino: 100 } },
      },
      actions,
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    check("S1", positivePlanRes.ok === true, "S1 positive plan (recording adapters) validates for the entry-path refusal battery");
    const validatedPlan = positivePlanRes.plan;
    // US-001 residual-boundary negatives: malformed preserved-output payloads
    // on an otherwise authentic validated-plan shape. These mirror the root
    // probe cases exactly — a claim_complete action whose preservedOutputTexts
    // is MISSING, and one whose preserved text entry is a NON-STRING — and must
    // be refused by validateExecutablePlan on the ACTUAL entry path BEFORE
    // createSandbox with ZERO effect calls.
    const claimCompleteIdx = validatedPlan.actions.findIndex((a) => a.type === "replay.claim_complete");
    const malformedPayloadPlans = [];
    if (claimCompleteIdx >= 0) {
      malformedPayloadPlans.push({
        name: "missing-preserved-claim-output",
        expect: "missing-preserved-output",
        plan: {
          ...validatedPlan,
          actions: validatedPlan.actions.map((a, i) => {
            if (i !== claimCompleteIdx) return a;
            const { preservedOutputTexts, ...rest } = a;
            return rest;
          }),
        },
      });
      malformedPayloadPlans.push({
        name: "nonstring-preserved-claim-output",
        expect: "preserved-text-not-string",
        plan: {
          ...validatedPlan,
          actions: validatedPlan.actions.map((a, i) =>
            i !== claimCompleteIdx
              ? a
              : {
                  ...a,
                  preservedOutputTexts: a.preservedOutputTexts.map((entry, ei) =>
                    ei === 0 ? { ...entry, text: { not: "a string" } } : entry,
                  ),
                },
          ),
        },
      });
    }
    const hostilePlans = [
      {
        name: "malformed-plan (not an object)",
        expect: "plan-shape",
        plan: null,
      },
      {
        name: "foreign-admitted-run",
        expect: "identity-mismatch",
        plan: { ...validatedPlan, admittedRunId: REC_OTHER_RUN },
      },
      {
        name: "unknown-action-type",
        expect: "unknown-type",
        plan: {
          ...validatedPlan,
          actions: validatedPlan.actions.map((a, i) => (i === 0 ? { ...a, id: "a-hostile", type: "replay.self_modify" } : a)),
        },
      },
      {
        name: "unsupported-runtime",
        expect: "runtime-unsupported",
        plan: { ...validatedPlan, runtime: "dsh" },
      },
      {
        name: "action-foreign-run",
        expect: "mixed-run",
        plan: {
          ...validatedPlan,
          actions: validatedPlan.actions.map((a, i) => (i === 0 ? { ...a, runId: REC_OTHER_RUN } : a)),
        },
      },
      {
        name: "noncontiguous-round-indices",
        expect: "noncontiguous-round-indices",
        plan: {
          ...validatedPlan,
          actions: validatedPlan.actions.map((a) => ({ ...a, roundIndex: a.roundIndex === 1 ? 3 : a.roundIndex })),
        },
      },
      {
        name: "already-executed-plan",
        expect: "plan-format",
        plan: { ...validatedPlan, execution: { executed: true } },
      },
      ...malformedPayloadPlans,
    ];
    for (const h of hostilePlans) {
      rec.calls.length = 0;
      const report = await executeReplayCase({
        plan: h.plan,
        repoRoot: REPO_ROOT,
        evidenceRoot,
        taskText: `S1 refusal battery: ${h.name}`,
        caseId: `s1-refuse-${h.name.slice(0, 12)}`,
        host,
      });
      const codes = (report.refusalErrors ?? []).map((e) => e.code);
      const okRefusal =
        report.ok === false && report.executed === false && report.refused === true && report.sandbox === null &&
        report.daemonStop === null && report.launchStop === null && codes.includes(h.expect);
      const rootEntriesAfter = fs.readdirSync(evidenceRoot).sort();
      check("S1", okRefusal, `entry-path refusal [${h.name}] refused with ${h.expect} before any effect (codes ${codes.join(",")})`);
      check("S1", rec.calls.length === 0, `entry-path refusal [${h.name}] made ZERO recorded effect calls (got ${rec.calls.join(",")})`);
      check("S1", JSON.stringify(rootEntriesAfter) === JSON.stringify(refuseRootEntries), `entry-path refusal [${h.name}] created no sandbox under the evidence root`);
    }
  }

  // Measured stage-1 host-effect claim: the refusal path is pure validation
  // on injected adapters (zero effect-class journal entries above, every
  // refusal a no-plan product). The END-TO-END proof that a refused plan
  // never reaches executeReplayCase and never spawns a daemon is the stage-2
  // refused-plan leg (real adapters, real owned fixture roots) — see S2.
  return { effectClassEntries, negativeCount, noPlanRefusals, refusalsProven: true };
}

// ═══════════════════════════════════════════════════════════════════
// Stage 1P — spawnDiePipe pipe-lifetime negatives (recording children)
// ═══════════════════════════════════════════════════════════════════

/**
 * Recording child handle for the pipe-lifetime negatives: an EventEmitter
 * with the child fields spawnDiePipe touches (stdout/stderr emitters, kill,
 * exitCode/signalCode). No process, no OS signal, no real spawn ever occurs.
 */
function recordingPipeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signalCalls = [];
  child.kill = (signal) => {
    child.signalCalls.push(signal);
    return true;
  };
  return child;
}

/**
 * US-001 pipe-lifetime legs: the REAL spawnDiePipe code path is driven with
 * injected recording `spawn` + tiny bounded windows so the exact-child
 * timeout/spawn-error/exit/close settlement contract is proven with ZERO real
 * OS signals, before any actual child leg runs:
 *   P1 timeout never resolves before the child's exit/close and never
 *      upgrades to success (a later close keeps the record a timeout failure,
 *      settled once).
 *   P2 a SIGKILLed child that never exits/close settles the bounded settle
 *      window with the cleanup failure reported SEPARATELY (never an
 *      indefinite wait, never a hidden PASS).
 *   P3 spawn-error settles once immediately as a failed producer with zero
 *      signals.
 *   P4 natural exit/close settles once ok:true with complete stdout bytes.
 */
async function stagePipeLifetime() {
  const startedUtc = new Date().toISOString();
  const outcome = { legs: [] };
  const resolvedFlag = (p) => {
    let value = "PENDING";
    const tracked = p.then((r) => {
      value = r;
      return r;
    });
    return { tracked, isPending: () => value === "PENDING", value: () => value };
  };

  // ── P1: timeout settles ONLY after child exit/close, once, as a FAILED
  //    producer; a later close never upgrades the timeout to success.
  {
    const child = recordingPipeChild();
    const t0 = Date.now();
    const { tracked, isPending } = resolvedFlag(
      spawnDiePipe("/recording/runtime", [], {}, Buffer.alloc(0), 3, 120, {
        spawn: () => child,
        sigkillSettleMs: 4000,
      }),
    );
    await sleep(400); // well past the 120 ms timeout; SIGKILL must be recorded
    const resolvedBeforeChildExit = !isPending();
    const killCallsBeforeExit = [...child.signalCalls];
    // Now the SIGKILLed child exits/closes: bounded positive settlement.
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    const rec = await tracked;
    const settledAt = Date.now() - t0;
    const p1Ok =
      resolvedBeforeChildExit === false &&
      JSON.stringify(killCallsBeforeExit) === JSON.stringify(["SIGKILL"]) &&
      rec.ok === false &&
      rec.reason === "timeout" &&
      rec.settledBy === "timeout-after-sigkill-exit" &&
      rec.signal === "SIGKILL" &&
      rec.cleanupError === undefined;
    check("S1P", p1Ok,
      `[pipe-lifetime P1] timeout does NOT resolve before the child exit/close (resolvedEarly=${resolvedBeforeChildExit}); once closed it settles EXACTLY ONCE ok:false reason=timeout, never upgraded (settled in ${settledAt} ms)`);
    // A later extra close can never re-settle or upgrade: the record is fixed.
    const settledOnceValue = rec;
    child.emit("close", 0, null);
    await sleep(20);
    outcome.legs.push({
      leg: "P1-timeout-positive-settlement",
      ok: p1Ok,
      resolvedBeforeChildExit,
      killCallsBeforeExit,
      record: settledOnceValue,
    });
  }

  // ── P2: cleanup failure reported separately when the SIGKILLed child never
  //    exits/closes — the promise still settles within the bounded window.
  {
    const child = recordingPipeChild();
    const t0 = Date.now();
    const rec = await spawnDiePipe("/recording/runtime", [], {}, Buffer.alloc(0), 3, 60, {
      spawn: () => child,
      sigkillSettleMs: 250,
    });
    const elapsedMs = Date.now() - t0;
    const p2Ok =
      rec.ok === false &&
      rec.reason === "timeout" &&
      rec.settledBy === "cleanup-failure" &&
      typeof rec.cleanupError === "string" &&
      rec.cleanupError.includes("did not exit/close") &&
      rec.stopSignaled === true &&
      JSON.stringify(child.signalCalls) === JSON.stringify(["SIGKILL"]) &&
      elapsedMs < 5000;
    check("S1P", p2Ok,
      `[pipe-lifetime P2] never-exiting SIGKILLed child settles the bounded window with the cleanup failure reported separately (settledBy=cleanup-failure, elapsed=${elapsedMs} ms, cleanupError=${JSON.stringify(rec.cleanupError)})`);
    outcome.legs.push({ leg: "P2-cleanup-failure-separate", ok: p2Ok, elapsedMs, record: rec });
  }

  // ── P3: spawn-error settles once immediately as a failed producer with
  //    zero signals (no process was ever created — no exit/close can arrive).
  {
    const child = recordingPipeChild();
    const boom = new Error("ENOENT: spawn boom (recording, no real process)");
    const { tracked } = resolvedFlag(
      spawnDiePipe("/recording/runtime", [], {}, Buffer.alloc(0), 3, 5000, {
        spawn: () => child,
        sigkillSettleMs: 4000,
      }),
    );
    child.emit("error", boom);
    const rec = await tracked;
    const p3Ok =
      rec.ok === false &&
      typeof rec.reason === "string" &&
      rec.reason.includes("ENOENT") &&
      child.signalCalls.length === 0;
    check("S1P", p3Ok,
      `[pipe-lifetime P3] spawn-error settles once as a FAILED producer with ZERO signals (reason=${JSON.stringify(rec.reason)})`);
    // Extra late close after the spawn-error settlement must not re-settle.
    child.emit("close", null, null);
    await sleep(20);
    outcome.legs.push({ leg: "P3-spawn-error", ok: p3Ok, record: rec });
  }

  // ── P4: natural exit/close settles once ok:true with complete stdout bytes
  //    (positive control; the byte-exact capture path still works).
  {
    const child = recordingPipeChild();
    const payload = Buffer.from("preserved die-before-claim stdout\n");
    const { tracked } = resolvedFlag(
      spawnDiePipe("/recording/runtime", [], {}, payload, 17, 5000, {
        spawn: () => child,
        sigkillSettleMs: 4000,
      }),
    );
    child.stdout.emit("data", payload);
    child.emit("exit", 17, null);
    child.emit("close", 17, null);
    const rec = await tracked;
    const p4Ok =
      rec.ok === true &&
      rec.reason === null &&
      rec.code === 17 &&
      rec.signal === null &&
      Buffer.isBuffer(rec.stdout) &&
      rec.stdout.equals(payload);
    check("S1P", p4Ok,
      `[pipe-lifetime P4] natural exit/close settles once ok:true code=17 with byte-complete stdout (${rec.stdout?.length} bytes)`);
    outcome.legs.push({ leg: "P4-natural-exit-positive", ok: p4Ok, record: rec });
  }

  outcome.ok = outcome.legs.every((l) => l.ok);
  outcome.startedUtc = startedUtc;
  outcome.timestampUtc = new Date().toISOString();
  outcome.note = "recording EventEmitter child handles only; zero real processes, zero OS signals, zero real pipe buffers";
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "stage-pipe-lifetime.json"),
    JSON.stringify(outcome, null, 2),
    "utf-8",
  );
  return outcome;
}

// ═══════════════════════════════════════════════════════════════════
// Stage 2 — actual isolated pi + hermes motor runs
// ═══════════════════════════════════════════════════════════════════

async function runStage2Case(caseSpec) {
  const sourceRunId = `${CORRIDOR_RUN_ID_PREFIX}-${caseSpec.caseId}-${sha256(caseSpec.caseId).slice(0, 12)}`;
  const { record, actions } = await buildCasePlan(caseSpec, sourceRunId);
  const fixture = createPlanFixtureRoots(caseSpec.caseId);

  // Validate the complete plan on the REAL adapters against a REAL owned
  // fixture root (admission identity captured at allocation) BEFORE effects.
  const planRes = validateReplayPlan({
    record,
    runtime: caseSpec.runtime,
    admittedRunId: sourceRunId,
    ownedRoot: fixture.ownedRoot,
    actions,
    realpath: fixture.adapters.realpath.bind(fixture.adapters),
    objectIdentity: fixture.adapters.objectIdentity.bind(fixture.adapters),
  });
  if (!planRes.ok) {
    return {
      caseId: caseSpec.caseId,
      ok: false,
      error: `plan validation refused before any effect: ${JSON.stringify(planRes.errors)}`,
      record,
    };
  }
  const plan = planRes.plan;

  // Pre-run idle observation: the daemon is up and NO run has been created
  // yet. Real nudge cycles during this window must spawn zero harness work
  // (the deterministic motor's idle property — MOTOR N1/N2), before the run
  // below is launched.
  const onDaemonReady = async ({ repoRoot, env, sandbox }) => {
    const invPath = path.join(sandbox.stateDir, "invocations.jsonl");
    const wcPath = path.join(sandbox.stateDir, `${REPLAY_CORRIDOR_AGENT}.workcount`);
    const len = () => {
      if (!fs.existsSync(invPath)) return 0;
      return fs.readFileSync(invPath, "utf-8").split("\n").filter(Boolean).length;
    };
    const wc = () => (fs.existsSync(wcPath) ? parseInt(fs.readFileSync(wcPath, "utf-8").trim(), 10) || 0 : 0);
    const before = { invocations: len(), workcount: wc() };
    for (let i = 0; i < 3; i += 1) {
      runCliSync(process.execPath, [path.join(repoRoot, "dist", "cli", "cli.js"), "nudge"], { env });
      await sleep(500);
    }
    const after = { invocations: len(), workcount: wc() };
    return {
      before,
      after,
      idleSpawnsDelta: after.invocations - before.invocations,
      idleWorkcountDelta: after.workcount - before.workcount,
    };
  };

  // Post-terminal idle observation: several real nudge cycles after the run
  // is terminal must spawn NOTHING (no new work invocations/heartbeats).
  const sandboxRootForIdle = path.join(EVIDENCE_DIR, "sandboxes", caseSpec.caseId);
  fs.mkdirSync(sandboxRootForIdle, { recursive: true });
  const onTerminal = async ({ repoRoot, env, runId, sandbox }) => {
    const invPath = path.join(sandbox.stateDir, "invocations.jsonl");
    const wcPath = path.join(sandbox.stateDir, `${REPLAY_CORRIDOR_AGENT}.workcount`);
    const len = () => {
      let n = 0;
      if (fs.existsSync(invPath)) n = fs.readFileSync(invPath, "utf-8").split("\n").filter(Boolean).length;
      return n;
    };
    const wc = () => (fs.existsSync(wcPath) ? parseInt(fs.readFileSync(wcPath, "utf-8").trim(), 10) || 0 : 0);
    const before = { invocations: len(), workcount: wc() };
    for (let i = 0; i < 5; i += 1) {
      runCliSync(process.execPath, [path.join(repoRoot, "dist", "cli", "cli.js"), "nudge"], { env });
      await sleep(700);
    }
    const after = { invocations: len(), workcount: wc() };
    return { before, after, idleSpawnsDelta: after.invocations - before.invocations, idleWorkcountDelta: after.workcount - before.workcount };
  };

  const caseReport = await executeReplayCase({
    plan,
    repoRoot: REPO_ROOT,
    evidenceRoot: path.join(EVIDENCE_DIR, "sandboxes"),
    taskText: caseSpec.taskText,
    caseId: caseSpec.caseId,
    onDaemonReady,
    onTerminal,
  });

  // Evidence verification (pure) against the actual fresh-run receipts.
  let verify = null;
  if (caseReport.ok && caseReport.binding) {
    const finalComplete = [...plan.actions].reverse().find((a) => a.type === "replay.claim_complete");
    const expectedFinalOutput =
      finalComplete && Array.isArray(finalComplete.preservedOutputTexts)
        ? finalComplete.preservedOutputTexts.map((o) => o.text).join("\n")
        : null;
    verify = verifyExecutionEvidence({
      binding: caseReport.binding,
      receipts: {
        ...caseReport.receipts,
        expectedFinalStatus: caseSpec.runtime === "pi" ? "completed" : "completed",
        expectedFinalOutput,
      },
    });
  }

  // Additional motor-level receipts: step.running counts + die round presence.
  const extras = {};
  if (caseReport.receipts) {
    const ev = caseReport.receipts.events ?? [];
    extras.stepRunningCount = ev.filter((e) => e.event === "step.running").length;
    extras.stepDoneCount = ev.filter((e) => e.event === "step.done").length;
    extras.stepFailedEvents = ev.filter((e) => e.event === "step.failed").length;
    extras.tokenUpdateEvents = caseReport.receipts.tokens?.tokenUpdateEvents ?? 0;
    extras.workInvocations = (caseReport.receipts.invocations ?? []).filter((i) => i.phase === "work").length;
    extras.heartbeats = (caseReport.receipts.invocations ?? []).filter((i) => i.phase === "heartbeat").length;
  }

  const verdict = {
    caseId: caseSpec.caseId,
    runtime: caseSpec.runtime,
    sourceRunId,
    sourcePayloadSha256: record.payloadSha256,
    ok: Boolean(caseReport.ok && verify && verify.ok),
    caseReportOk: Boolean(caseReport.ok),
    verifyOk: Boolean(verify?.ok),
    verifyChecks: verify?.checks ?? [],
    verifyErrors: verify?.errors ?? [],
    freshRunId: caseReport.freshRunId ?? null,
    runStatus: caseReport.receipts?.runStatus ?? null,
    daemonStop: caseReport.daemonStop ?? null,
    launchStop: caseReport.launchStop ?? null,
    cleanup: caseReport.cleanup ?? null,
    sandbox: caseReport.sandbox ?? null,
    preRunIdle: caseReport.preRunIdle ?? null,
    postTerminal: caseReport.postTerminal ?? null,
    extras,
  };
  return { verdict, plan, record, caseReport, fixture, verify };
}

/**
 * CORE-MOTOR-CLOSE B end-to-end refused-plan leg: hostile plans are handed
 * DIRECTLY to executeReplayCase (the ACTUAL entry path — no caller-side
 * validateReplayPlan gate in front) with a recording host over the executor's
 * own OS-effect functions. The validated-plan trust boundary inside
 * executeReplayCase must refuse every hostile plan BEFORE any effect:
 * executed:false, sandbox null, ZERO recorded effect calls, and no sandbox
 * directory appears under the evidence root (so no isolated daemon was ever
 * spawned). A positive-control hostile plan (authentic validated-plan shape,
 * one work action turned into an unknown executor type) plus a
 * foreign-admitted-run clone are both exercised.
 */
async function runStage2RefusedPlanLeg() {
  const spec = CASES[0]; // pi-retry shape (full vocabulary)
  const sourceRunId = `${CORRIDOR_RUN_ID_PREFIX}-refused-leg-${sha256("refused-plan-leg").slice(0, 12)}`;
  const { record, actions } = await buildCasePlan(spec, sourceRunId);
  const fixture = createPlanFixtureRoots("refused-plan-leg");
  const sandboxesRoot = path.join(EVIDENCE_DIR, "sandboxes");
  fs.mkdirSync(sandboxesRoot, { recursive: true });

  // Build an authentic validated-plan product on the REAL adapters, then hand
  // hostile clones of it straight to executeReplayCase (no caller-side gate).
  const positivePlanRes = validateReplayPlan({
    record,
    runtime: spec.runtime,
    admittedRunId: sourceRunId,
    ownedRoot: fixture.ownedRoot,
    actions,
    realpath: fixture.adapters.realpath.bind(fixture.adapters),
    objectIdentity: fixture.adapters.objectIdentity.bind(fixture.adapters),
  });
  if (!positivePlanRes.ok) {
    return { verdict: { leg: "refused-plan", ok: false, error: `positive plan failed to validate: ${JSON.stringify(positivePlanRes.errors)}` }, positivePlanRes };
  }
  const validated = positivePlanRes.plan;
  // US-001 residual-boundary negatives (end-to-end refused-plan leg): a
  // claim_complete whose preservedOutputTexts is missing and one whose
  // preserved text is a non-string are handed DIRECTLY to executeReplayCase
  // and must be refused before any effect — the exact two root-probe cases.
  const claimCompleteIdx = validated.actions.findIndex((a) => a.type === "replay.claim_complete");
  const payloadNegatives = [];
  if (claimCompleteIdx >= 0) {
    payloadNegatives.push({
      name: "missing-preserved-claim-output",
      expect: "missing-preserved-output",
      plan: {
        ...validated,
        actions: validated.actions.map((a, i) => {
          if (i !== claimCompleteIdx) return a;
          const { preservedOutputTexts, ...rest } = a;
          return rest;
        }),
      },
    });
    payloadNegatives.push({
      name: "nonstring-preserved-claim-output",
      expect: "preserved-text-not-string",
      plan: {
        ...validated,
        actions: validated.actions.map((a, i) =>
          i !== claimCompleteIdx
            ? a
            : {
                ...a,
                preservedOutputTexts: a.preservedOutputTexts.map((entry, ei) =>
                  ei === 0 ? { ...entry, text: { not: "a string" } } : entry,
                ),
              },
        ),
      },
    });
  }
  const hostilePlans = [
    {
      name: "unknown-type-on-validated-shape",
      expect: "unknown-type",
      plan: {
        ...validated,
        actions: validated.actions.map((a, i) => (i === 0 ? { ...a, id: "a-hostile", type: "replay.self_modify" } : a)),
      },
    },
    {
      name: "foreign-admitted-run-on-validated-shape",
      expect: "identity-mismatch",
      plan: { ...validated, admittedRunId: `${CORRIDOR_RUN_ID_PREFIX}-other-00000000-0000-4000-8000-0000000000ff` },
    },
    {
      name: "malformed-plan-object",
      expect: "plan-format",
      plan: { type: "replay.claim_complete" },
    },
    ...payloadNegatives,
  ];

  const rec = { calls: [] };
  const wrap = (name) => (...args) => {
    rec.calls.push(name);
    return undefined;
  };
  const host = {
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
  };
  const reports = [];
  for (const h of hostilePlans) {
    const sandboxEntriesBefore = fs.readdirSync(sandboxesRoot).sort();
    rec.calls.length = 0;
    const report = await executeReplayCase({
      plan: h.plan,
      repoRoot: REPO_ROOT,
      evidenceRoot: sandboxesRoot,
      taskText: `S2 refused-plan leg: ${h.name}`,
      caseId: `refused-${h.name.slice(0, 10)}`,
      host,
    });
    const sandboxEntriesAfter = fs.readdirSync(sandboxesRoot).sort();
    const codes = (report.refusalErrors ?? []).map((e) => e.code);
    reports.push({
      name: h.name,
      refused: Boolean(report.ok === false && report.executed === false && report.refused === true && codes.includes(h.expect)),
      refusalCodes: codes,
      executed: report.executed,
      sandbox: report.sandbox,
      effectCalls: rec.calls,
      zeroSandboxCreated: JSON.stringify(sandboxEntriesBefore) === JSON.stringify(sandboxEntriesAfter),
    });
  }
  const verdict = {
    leg: "refused-plan",
    ok: reports.every((r) => r.refused && r.zeroSandboxCreated && r.effectCalls.length === 0),
    refusedPlans: reports,
    sourceRunId,
    executed: false,
    note: "hostile plans were handed DIRECTLY to executeReplayCase (actual entry path) with a recording host; zero effect calls and zero sandbox dirs prove the pre-effect validated-plan boundary",
  };
  // Persist the negative-leg evidence.
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "case-refused-plan-leg.json"),
    JSON.stringify({ verdict, sourceRunId, record, positivePlanValidated: true }, null, 2),
    "utf-8",
  );
  return verdict;
}

/**
 * CORE-MOTOR-CLOSE C end-to-end bounded actual owned-launcher failure leg:
 * the workflow-run launcher child FAILS on the real spawn path (spawns a
 * real `node -e` process that exits 3 without printing `Run:`) through an
 * injected launchWorkflowRun host slot. executeReplayCase's catch path must
 * record the primary premature-exit error AND still own/stop the launcher
 * and daemon children exactly, with clean shutdown evidence. No real model,
 * no provider, no historical command, no live daemon fault.
 */
async function runStage2LauncherFailureLeg() {
  const spec = CASES[0];
  const sourceRunId = `${CORRIDOR_RUN_ID_PREFIX}-launch-fail-${sha256("launcher-failure").slice(0, 12)}`;
  const { record, actions } = await buildCasePlan(spec, sourceRunId);
  const fixture = createPlanFixtureRoots("launcher-failure-leg");
  const planRes = validateReplayPlan({
    record,
    runtime: spec.runtime,
    admittedRunId: sourceRunId,
    ownedRoot: fixture.ownedRoot,
    actions,
    realpath: fixture.adapters.realpath.bind(fixture.adapters),
    objectIdentity: fixture.adapters.objectIdentity.bind(fixture.adapters),
  });
  if (!planRes.ok) {
    return { verdict: { leg: "launcher-failure", ok: false, error: `plan validation refused: ${JSON.stringify(planRes.errors)}` }, planRes };
  }
  const host = {
    // A REAL bounded child that exits 3 immediately without printing Run: —
    // the actual owned-launcher early-failure path inside executeReplayCase.
    launchWorkflowRun: ({ env }) => {
      const child = spawn(process.execPath, ["-e", "process.stderr.write('boom before Run:'); process.exit(3);"], { env });
      return attachRunCliLifecycle({ child, readyTimeoutMs: 15000, naturalExitGraceMs: 200 });
    },
  };
  const caseReport = await executeReplayCase({
    plan: planRes.plan,
    repoRoot: REPO_ROOT,
    evidenceRoot: path.join(EVIDENCE_DIR, "sandboxes"),
    taskText: spec.taskText,
    caseId: "launcher-failure",
    host,
  });
  const primaryErrorPreserved =
    caseReport.ok === false &&
    caseReport.executed === true &&
    caseReport.error !== undefined &&
    /exited before printing Run:/.test(caseReport.error.message);
  const daemonCleaned =
    caseReport.daemonStop !== undefined &&
    caseReport.daemonStop.exitObserved === true &&
    !caseReport.daemonStop.stopError &&
    caseReport.daemonStop.controlPortReleased === true;
  const launcherCleaned =
    caseReport.launchStop !== undefined &&
    caseReport.launchStop.exitObserved === true &&
    !caseReport.launchStop.stopError &&
    caseReport.launchStop.code === 3;
  const verdict = {
    leg: "launcher-failure",
    ok: Boolean(primaryErrorPreserved && daemonCleaned && launcherCleaned),
    caseReportOk: caseReport.ok,
    primaryErrorPreserved,
    daemonCleaned,
    launcherCleaned,
    errorMessage: caseReport.error?.message ?? null,
    launchStop: caseReport.launchStop ?? null,
    daemonStop: caseReport.daemonStop ?? null,
    freshRunId: caseReport.freshRunId ?? null,
    sourceRunId,
    sandbox: caseReport.sandbox ?? null,
  };
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "case-launcher-failure.json"),
    JSON.stringify({ verdict, record, plan: planRes.plan, caseReport }, null, 2),
    "utf-8",
  );
  return verdict;
}

/**
 * CORE-MOTOR-CLOSE A: the four root receipt mutations applied to the REAL
 * collected receipts of the pi-retry case (native runtime evidence, not
 * self-generated counters) must each be REJECTED by verifyExecutionEvidence
 * while the unchanged positive still verifies. This mirrors the root probe
 * against actual evidence and inspects the implementation path.
 */
async function runReceiptMutationBattery(binding, realReceipts) {
  const trial = (name, checkName, mutate) => {
    const receipts = structuredClone(realReceipts);
    mutate(receipts);
    const v = verifyExecutionEvidence({ binding, receipts });
    const bad = (v.checks ?? []).find((c) => c.name === checkName);
    return { name, rejected: v.ok === false, tripped: Boolean(bad && !bad.pass), checkName, failedChecks: (v.checks ?? []).filter((c) => !c.pass).map((c) => c.name) };
  };
  const unchanged = verifyExecutionEvidence({ binding, receipts: realReceipts });
  return {
    unchangedOk: unchanged.ok === true,
    trials: [
      trial("round-one-work-and-result-belong-to-foreign-run", "work-evidence-a-done", (r) => {
        for (const row of r.invocations) if (row.workIndex === 1) row.runId = "run-11111111-2222-4333-8444-555555555555";
      }),
      trial("completion-result-binds-foreign-step-row", "work-evidence-a-done", (r) => {
        r.invocations.find((row) => row.phase === "result" && row.workIndex === 1).stepId = "step-11111111-2222-4333-8444-555555555555";
      }),
      trial("duplicate-completion-result", "result-cardinality", (r) => {
        r.invocations.push(structuredClone(r.invocations.find((row) => row.phase === "result" && row.workIndex === 1)));
      }),
      trial("extra-foreign-run-event", "events-bound-to-fresh-run", (r) => {
        r.events.push({ ts: "2026-09-09T19:21:38.116Z", event: "run.completed", runId: "11111111-2222-4333-8444-555555555555" });
      }),
    ],
  };
}

/**
 * CORE-MOTOR-CLOSE C pure leg: a recording-only already-terminal-by-signal
 * child handle (exitCode null, signalCode SIGTERM — the exact root-probe
 * shape, no real process, no OS signal) must be recognized IMMEDIATELY by
 * stopExactChild with ZERO kill calls and no wait for a second exit event.
 */
async function runTerminalSignalHandleLeg() {
  const { EventEmitter } = await import("node:events");
  const fake = new EventEmitter();
  fake.exitCode = null;
  fake.signalCode = "SIGTERM";
  const signalCalls = [];
  fake.kill = (signal) => {
    signalCalls.push(signal);
    return false;
  };
  let settled = false;
  const closing = stopExactChild(fake).then((r) => {
    settled = true;
    return r;
  });
  await sleep(30);
  const settledBeforeSyntheticExit = settled;
  const rec = await closing;
  const verdict = {
    leg: "terminal-signal-handle",
    ok: Boolean(settledBeforeSyntheticExit === true && signalCalls.length === 0 && rec.exitObserved === true && rec.signal === "SIGTERM"),
    simulated: true,
    actualOsSignals: 0,
    settledBeforeSyntheticExit,
    signalCalls,
    record: rec,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, "case-terminal-signal-handle.json"), JSON.stringify({ verdict }, null, 2), "utf-8");
  return verdict;
}

/**
 * Issue-1 forced-failure regression: the executor's REAL error-recording path
 * (catch → ok:false case report carrying the primary error → exact child
 * shutdown) is exercised at runtime with an injected launch-step failure.
 * Before the `caseErr` fix this path threw ReferenceError and produced no
 * structured ok:false report; this leg must now see the ok:false report with
 * the ORIGINAL injected error preserved.
 */
async function runStage2ForcedFailureLeg() {
  const spec = CASES[0]; // pi-retry plan shape (validated, then launch fails)
  const sourceRunId = `${CORRIDOR_RUN_ID_PREFIX}-forced-failure-${sha256("forced-failure").slice(0, 12)}`;
  const { record, actions } = await buildCasePlan(spec, sourceRunId);
  const fixture = createPlanFixtureRoots("forced-failure-leg");

  const planRes = validateReplayPlan({
    record,
    runtime: spec.runtime,
    admittedRunId: sourceRunId,
    ownedRoot: fixture.ownedRoot,
    actions,
    realpath: fixture.adapters.realpath.bind(fixture.adapters),
    objectIdentity: fixture.adapters.objectIdentity.bind(fixture.adapters),
  });
  if (!planRes.ok) {
    return { verdict: { leg: "forced-failure", ok: false, error: `plan validation refused: ${JSON.stringify(planRes.errors)}` }, planRes };
  }

  const injectedMessage = `CORE-MOTOR forced-failure: injected launch step failure (${new Date().toISOString()})`;
  const caseReport = await executeReplayCase({
    plan: planRes.plan,
    repoRoot: REPO_ROOT,
    evidenceRoot: path.join(EVIDENCE_DIR, "sandboxes"),
    taskText: spec.taskText,
    caseId: "forced-failure",
    fault: { stage: "launch", message: injectedMessage },
  });

  const errorPreserved =
    caseReport.ok === false &&
    caseReport.error !== undefined &&
    caseReport.error.message === injectedMessage &&
    typeof caseReport.error.stack === "string" &&
    caseReport.error.stack.includes(injectedMessage) &&
    !String(caseReport.error.stack).includes("caseErr is not defined");
  const cleanShutdown =
    caseReport.daemonStop !== undefined &&
    caseReport.daemonStop.code === 0 &&
    caseReport.daemonStop.exitObserved === true &&
    !caseReport.daemonStop.stopError &&
    caseReport.daemonStop.controlPortReleased === true &&
    caseReport.daemonStop.controlPortState === "released";
  const verdict = {
    leg: "forced-failure",
    ok: Boolean(errorPreserved && cleanShutdown && caseReport.executed === true && caseReport.freshRunId === null),
    caseReportOk: caseReport.ok,
    executed: caseReport.executed,
    errorPreserved,
    cleanShutdown,
    errorMessage: caseReport.error?.message ?? null,
    freshRunId: caseReport.freshRunId ?? null,
    daemonStop: caseReport.daemonStop ?? null,
    sourceRunId,
    sandbox: caseReport.sandbox ?? null,
    preRunIdle: caseReport.preRunIdle ?? null,
  };
  // Persist the forced-failure leg evidence (ok:false report + error + cleanup).
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "case-forced-failure.json"),
    JSON.stringify({ verdict, record, plan: planRes.plan, caseReport }, null, 2),
    "utf-8",
  );
  return verdict;
}

async function stage2() {
  const results = [];
  let receiptMutationBattery = null;
  for (const caseSpec of CASES) {
    const out = await runStage2Case(caseSpec);
    const v = out.verdict;
    results.push(v);
    check("S2", v.caseReportOk, `[${v.caseId}] real isolated run executed (status ${v.runStatus})`);
    if (v.caseReportOk) {
      check("S2", v.verifyOk, `[${v.caseId}] execution evidence verified against the plan (${v.verifyErrors.length} errors)`);
      check("S2", v.daemonStop && v.daemonStop.code === 0 && !v.daemonStop.stopError && v.daemonStop.controlPortReleased === true && v.daemonStop.controlPortState === "released",
        `[${v.caseId}] exact daemon child stopped with observed clean exit + control listener positively released (${JSON.stringify(v.daemonStop)})`);
      check("S2", v.launchStop && v.launchStop.exitObserved === true && !v.launchStop.stopError,
        `[${v.caseId}] workflow-run launcher child owned and its exit observed (${JSON.stringify(v.launchStop)})`);
      check("S2", v.cleanup && v.cleanup.clean === true,
        `[${v.caseId}] every required child/listener shutdown is clean and evidenced (failures: ${JSON.stringify(v.cleanup?.failures ?? [])})`);
      if (!v.verifyOk) {
        for (const err of v.verifyErrors.slice(0, 10)) note("S2", `  verify error: ${err.message ?? JSON.stringify(err)}`);
        for (const c of (v.verifyChecks ?? []).filter((x) => !x.pass)) note("S2", `  failed check: ${c.name}: ${c.message}`);
      }
      check("S2", v.postTerminal && v.postTerminal.idleSpawnsDelta === 0 && v.postTerminal.idleWorkcountDelta === 0,
        `[${v.caseId}] post-terminal idle nudges spawn nothing (${JSON.stringify(v.postTerminal)})`);
      check("S2", v.preRunIdle && v.preRunIdle.idleSpawnsDelta === 0 && v.preRunIdle.idleWorkcountDelta === 0,
        `[${v.caseId}] pre-run idle (daemon up, no run created yet) nudges spawn nothing (${JSON.stringify(v.preRunIdle)})`);
      check("S2", v.extras.tokenUpdateEvents === 0, `[${v.caseId}] zero run.tokens.updated events (${v.extras.tokenUpdateEvents})`);
      check("S2", v.extras.heartbeats === 0, `[${v.caseId}] zero idle heartbeat spawns across the whole run (N2)`);
      // Per-runtime expected motor event counts (mechanical receipts).
      if (v.caseId === "pi-retry") {
        check("S2", v.extras.stepRunningCount === 2 && v.extras.stepDoneCount === 1,
          `[pi-retry] two claim rounds, one final done (running=${v.extras.stepRunningCount}, done=${v.extras.stepDoneCount})`);
        // CORE-MOTOR-CLOSE A: the four root receipt mutations on the REAL
        // collected receipts (native runtime evidence) must all be rejected.
        if (v.caseReportOk && v.verifyOk && out.caseReport.binding && out.caseReport.receipts) {
          receiptMutationBattery = await runReceiptMutationBattery(out.caseReport.binding, out.caseReport.receipts);
          check("S2", receiptMutationBattery.unchangedOk, "[receipt-mutations] unchanged REAL pi-retry receipts still verify (control PASS)");
          for (const t of receiptMutationBattery.trials) {
            check("S2", t.rejected && t.tripped,
              `[receipt-mutations] ${t.name} REJECTED by verifyExecutionEvidence (tripped ${t.checkName}; failed: ${t.failedChecks.join(",")})`);
          }
        }
      } else if (v.caseId === "pi-unclaimed") {
        check("S2", v.extras.stepRunningCount === 1 && v.extras.stepDoneCount === 1,
          `[pi-unclaimed] die-before-claim round never claims; one running + one done (running=${v.extras.stepRunningCount}, done=${v.extras.stepDoneCount})`);
      } else if (v.caseId === "hermes-all") {
        check("S2", v.extras.stepRunningCount === 2 && v.extras.stepDoneCount === 1,
          `[hermes-all] die@0 (no claim) + fail@1 + done@2 (running=${v.extras.stepRunningCount}, done=${v.extras.stepDoneCount})`);
      }
    } else {
      note("S2", `  case error: ${v.error ?? "(none)"}`);
      for (const c of (v.verifyChecks ?? []).filter((x) => !x.pass)) note("S2", `  failed check: ${c.name}: ${c.message}`);
    }
    // Persist per-case evidence.
    const reportPath = path.join(EVIDENCE_DIR, `case-${v.caseId}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          verdict: v,
          record: out.record,
          plan: out.plan,
          caseReport: {
            ok: out.caseReport.ok,
            freshRunId: out.caseReport.freshRunId,
            runStatus: out.caseReport.receipts?.runStatus,
            sandbox: out.caseReport.sandbox,
            daemonStop: out.caseReport.daemonStop,
            launchStop: out.caseReport.launchStop ?? null,
            cleanup: out.caseReport.cleanup ?? null,
            artifacts: out.caseReport.artifacts,
            launchReceipt: out.caseReport.launchReceipt,
            receipts: out.caseReport.receipts,
            postTerminal: out.caseReport.postTerminal,
            preRunIdle: out.caseReport.preRunIdle,
            error: out.caseReport.error ?? null,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  // Negative legs (expected outcomes, checked as PASS when they behave):
  const refusedPlanLeg = await runStage2RefusedPlanLeg();
  check("S2", refusedPlanLeg.ok,
    `[refused-plan leg] hostile plans handed DIRECTLY to executeReplayCase refused before any effect with zero recorded effect calls and zero sandbox dirs (${JSON.stringify(refusedPlanLeg.refusedPlans)})`);
  const launcherFailureLeg = await runStage2LauncherFailureLeg();
  check("S2", launcherFailureLeg.ok,
    `[launcher-failure leg] real owned launcher early failure preserves the primary error and cleans the launcher + daemon exactly (${JSON.stringify(launcherFailureLeg)})`);
  const terminalSignalLeg = await runTerminalSignalHandleLeg();
  check("S2", terminalSignalLeg.ok,
    `[terminal-signal-handle leg] already-terminal-by-signal handle recognized immediately with ZERO re-signals (${JSON.stringify(terminalSignalLeg)})`);
  const forcedFailureLeg = await runStage2ForcedFailureLeg();
  check("S2", forcedFailureLeg.ok,
    `[forced-failure leg] injected launch failure yields ok:false report carrying the ORIGINAL error (errorPreserved=${forcedFailureLeg.errorPreserved}, cleanShutdown=${forcedFailureLeg.cleanShutdown}, error=${JSON.stringify(forcedFailureLeg.errorMessage)})`);
  if (!forcedFailureLeg.ok) {
    note("S2", `  forced-failure verdict: ${JSON.stringify(forcedFailureLeg)}`);
  }
  return { results, refusedPlanLeg, launcherFailureLeg, terminalSignalLeg, forcedFailureLeg, receiptMutationBattery };
}

// ═══════════════════════════════════════════════════════════════════
// Stage 3 — byte-exact die-before-claim pipe tests (both runtimes)
// ═══════════════════════════════════════════════════════════════════

function makeMockCli(tmpDir) {
  const cliPath = path.join(tmpDir, "bin", "tamandua");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env bash
case "$1:$2" in
  step:peek) echo "HAS_WORK"; exit 0 ;;
  step:claim) echo '{"stepId":"step-00000000-0000-0000-0000-000000000001","runId":"run-fresh00000000000000000000000000001","input":"TASK: x\\n"}' ; exit 0 ;;
  step:complete|step:fail) exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

function buildDiePrompt(cliPath, runId) {
  return (
    `You are agent "doer" for workflow "${REPLAY_CORRIDOR_WORKFLOW}", agent "${REPLAY_CORRIDOR_AGENT}", run "${runId}".\n\n` +
    `CLAIM:\n"${cliPath}" step claim "${REPLAY_CORRIDOR_AGENT}" --run-id "${runId}"\n`
  );
}

/**
 * Spawn one runtime with a die-before-claim behavior; capture raw stdout bytes.
 *
 * Pipe-lifetime contract (US-001 residual-boundary fix): the promise settles
 * EXACTLY ONCE per outcome, and every outcome carries bounded positive
 * settlement tied to the EXACT child's exit/close:
 *
 *   - spawn error  -> the process never started, so no exit/close will ever
 *     arrive: settle once immediately as a FAILED producer
 *     { ok:false, reason:<error text> } with zero signals.
 *   - exit/close before the timeout -> settle once { ok:true, code, signal,
 *     stdout, stderr }: positive settlement IS the observed exit/close.
 *   - timeout       -> ALWAYS a failed producer: the child is SIGKILLed once,
 *     and the record resolves ONLY AFTER the child's exit/close is positively
 *     observed within a bounded settle window
 *     (settles as { ok:false, reason:"timeout", ... } with the observed
 *     code/signal). A close that arrives after the timeout decision NEVER
 *     upgrades the record to success — the failed decision is committed when
 *     the timer fires. If the child never exits/closes within the bounded
 *     settle window after SIGKILL, the record still resolves (never an
 *     indefinite wait) with the cleanup failure reported SEPARATELY
 *     ({ cleanupError, settledBy:"cleanup-failure" }) — a cleanup failure is
 *     never silently dropped and never turns the producer green.
 *
 * The recording-negative gate legs drive this exact function through an
 * injected `spawn` (opts.spawn) that returns an EventEmitter recording child:
 * no real OS signal, no real process, no real timer dependency beyond tiny
 * bounded windows.
 *
 * @param {string} runtimePath  frozen runtime file.
 * @param {string[]} argv       runtime argv.
 * @param {object} env          explicit child env.
 * @param {Buffer} payload      preserved byte payload (bytes come from the
 *   behaviors file; kept for signature compatibility).
 * @param {number} exitCode     expected producer exit code (kept for
 *   signature compatibility; the behaviors file already encodes it).
 * @param {number} [timeoutMs=30000]  producer timeout before SIGKILL.
 * @param {object} [opts]       { spawn, sigkillSettleMs } — recording seams.
 */
function spawnDiePipe(runtimePath, argv, env, payload, exitCode, timeoutMs = 30000, opts = {}) {
  return new Promise((resolve) => {
    const spawnFn = typeof opts.spawn === "function" ? opts.spawn : spawn;
    const sigkillSettleMs =
      Number.isInteger(opts.sigkillSettleMs) && opts.sigkillSettleMs > 0 ? opts.sigkillSettleMs : 5000;
    const child = spawnFn(process.execPath, [runtimePath, ...argv], {
      cwd: path.dirname(runtimePath),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(Buffer.from(c)));
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString(); });

    // ── Settlement state ─────────────────────────────────────────────
    // `outcome` is committed BEFORE the record resolves: "exit" (a natural
    // exit/close before the timeout) or "timeout" (decided when the timeout
    // timer fires; final). `settled` guards the single resolution — a later
    // exit/close can never re-settle and can never upgrade a timeout to a
    // success. A natural success settles on 'close' (all stdio drained), so
    // the captured stdout is byte-complete.
    let settled = false;
    let outcome = "exit";
    let exitSeen = false;
    let observedCode = null;
    let observedSignal = null;
    let stopSignaled = false;
    let cleanupError = null;
    let timeoutTimer = null;
    let settleTimer = null;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      const record = {
        ok: outcome === "exit",
        reason: outcome === "exit" ? null : outcome,
        code: observedCode,
        signal: observedSignal,
        stdout: Buffer.concat(chunks),
        stderr: stderr.slice(0, 500),
      };
      if (outcome === "timeout") {
        record.stopSignaled = stopSignaled;
        record.settledBy = cleanupError === null ? "timeout-after-sigkill-exit" : "cleanup-failure";
        if (cleanupError !== null) record.cleanupError = cleanupError;
      } else if (outcome === "spawn-error") {
        record.reason = cleanupError; // the spawn error text (failed producer)
      }
      resolve(record);
    };

    child.on("error", (e) => {
      if (settled) return;
      // The process never started: no exit/close will ever arrive and there
      // is nothing to signal. Settle once immediately as a failed producer.
      outcome = "spawn-error";
      cleanupError = e instanceof Error ? e.message : String(e);
      stopSignaled = false;
      settle();
    });
    child.on("exit", (code, signal) => {
      exitSeen = true;
      if (observedCode === null) observedCode = code ?? null;
      if (observedSignal === null) observedSignal = signal ?? null;
      if (settled) return;
      if (outcome === "timeout") {
        // Bounded positive settlement of the FAILED timeout decision: the
        // SIGKILLed child has exited. The record stays a timeout failure —
        // this exit never upgrades it to success.
        settle();
      }
      // A natural exit is not settled here: wait for 'close' so stdout is
      // fully drained before the record can become ok:true.
    });
    child.on("close", (code, signal) => {
      if (observedCode === null) observedCode = code ?? null;
      if (observedSignal === null) observedSignal = signal ?? null;
      if (settled) return;
      if (outcome === "timeout") {
        // Later close after the timeout decision: bounded positive settlement
        // of the failure — never an upgrade to success.
        settle();
        return;
      }
      outcome = "exit";
      settle();
    });

    timeoutTimer = setTimeout(() => {
      if (settled) return; // never re-settle a decided outcome
      // Commit the failed-producer decision NOW: any later exit/close
      // completes the bounded settlement evidence but can never turn this
      // into success.
      outcome = "timeout";
      cleanupError = null;
      try {
        child.kill("SIGKILL");
        stopSignaled = true;
      } catch (e) {
        cleanupError = `SIGKILL delivery failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (settled) return; // child exited between the timer and the kill
      // Bounded positive settlement: resolve only once the child's exit/close
      // is observed OR the settle window elapses (cleanup failure reported
      // separately). Never an indefinite wait.
      settleTimer = setTimeout(() => {
        if (settled) return;
        if (cleanupError === null) {
          cleanupError = `child did not exit/close within ${sigkillSettleMs} ms of SIGKILL; producer is failed (timeout) but the kill/close handshake is unconfirmed`;
        }
        settle();
      }, sigkillSettleMs);
    }, timeoutMs);
  });
}

const PIPE_PAYLOADS = [
  ["empty", Buffer.alloc(0)],
  ["newline", Buffer.from("\n")],
  ["no-final-newline", Buffer.from("abc")],
  ["utf8", Buffer.from("héllo✓ wörld — 段階\n")],
  ["big-no-final-newline", Buffer.from("y".repeat(70 * 1024))],
  ["big-with-final-newline", Buffer.from("z".repeat(70 * 1024) + "\n")],
];

async function stage3() {
  const stageDir = path.join(EVIDENCE_DIR, "stage3-pipe");
  fs.mkdirSync(stageDir, { recursive: true });
  const runtimes = [
    { runtime: "pi", file: RUNTIME_PI, argv: ["--print", "--mode", "json"] },
    { runtime: "hermes", file: RUNTIME_HERMES, argv: ["chat", "--max-turns", "8192", "--yolo", "-Q", "-q"] },
  ];
  for (const rt of runtimes) {
    for (const [name, payload] of PIPE_PAYLOADS) {
      const dir = path.join(stageDir, `${rt.runtime}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      const cliPath = makeMockCli(dir);
      const stateDir = path.join(dir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const behaviorsPath = path.join(dir, "behaviors.json");
      fs.writeFileSync(
        behaviorsPath,
        JSON.stringify({
          agents: { [REPLAY_CORRIDOR_AGENT]: [{ mode: "die-before-claim", exitCode: 17, preservedStdout: payload.toString("utf-8") }] },
          heartbeatTokens: 0,
          defaultTokens: 0,
        }),
        "utf-8",
      );
      const env = {
        PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
        TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
        TAMANDUA_SCRIPTED_STATE: stateDir,
        TAMANDUA_TEST_GUARD: "1",
      };
      const runId = `run-fresh-${sha256(`${rt.runtime}-${name}`).slice(0, 12)}`;
      const prompt = buildDiePrompt(cliPath, runId);
      const out = await spawnDiePipe(rt.file, [...rt.argv, prompt], env, payload, 17);
      const bytesOk = out.ok && out.stdout.equals(payload);
      check(
        "S3",
        out.ok && out.code === 17 && out.signal === null,
        `[${rt.runtime}/${name}] producer exit code 17 preserved (got code=${out.code}, signal=${out.signal})`,
      );
      check(
        "S3",
        bytesOk,
        `[${rt.runtime}/${name}] complete stdout bytes Buffer-equal to preserved payload (${payload.length} bytes; got ${out.stdout.length})`,
      );
      if (!bytesOk) note("S3", `  payload head: ${JSON.stringify(payload.slice(0, 40).toString())}; got head: ${JSON.stringify(out.stdout.slice(0, 40).toString())}; stderr: ${out.stderr.slice(0, 300)}`);
      // Retain raw evidence for the byte-exact claim.
      fs.writeFileSync(path.join(dir, "observed.stdout.bin"), out.stdout);
      fs.writeFileSync(path.join(dir, "payload.bin"), payload);
    }
  }
  // Absent preservedStdout keeps the original zero-byte die-before-claim shape.
  {
    const dir = path.join(stageDir, "pi-no-preserved");
    fs.mkdirSync(dir, { recursive: true });
    const cliPath = makeMockCli(dir);
    const stateDir = path.join(dir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const behaviorsPath = path.join(dir, "behaviors.json");
    fs.writeFileSync(
      behaviorsPath,
      JSON.stringify({ agents: { [REPLAY_CORRIDOR_AGENT]: [{ mode: "die-before-claim", exitCode: 3 }] }, heartbeatTokens: 0, defaultTokens: 0 }),
      "utf-8",
    );
    const out = await spawnDiePipe(
      RUNTIME_PI,
      ["--print", "--mode", "json", buildDiePrompt(cliPath, "run-fresh-00000000000000000000000000000000")],
      { PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`, TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath, TAMANDUA_SCRIPTED_STATE: stateDir, TAMANDUA_TEST_GUARD: "1" },
      Buffer.alloc(0),
      3,
    );
    check("S3", out.ok && out.code === 3 && out.stdout.length === 0, "[pi/no-preserved] zero-byte die-before-claim shape retained (no newline invented)");
  }
}

// ═══════════════════════════════════════════════════════════════════
// Stage 4 — real filesystem identity refusal + canonical-alias control
// ═══════════════════════════════════════════════════════════════════

/**
 * Build one INDEPENDENT fresh identity fixture set (base/root/fixtures/
 * candidate) and validate a plan against it on the REAL adapters. Every
 * fixture set is created under its own mkdtemp root and is NEVER removed by
 * the gate — replacement/refusal scenarios below use exact retained-sibling
 * renames only (no unlink/rmdir/recursive removal of any object).
 */
async function buildIdentityFixture(stageDir, label, candidateText) {
  const dir = fs.mkdtempSync(path.join(stageDir, `${label}-`));
  const base = path.join(dir, "base");
  const root = path.join(base, "root");
  const fixturesDir = path.join(root, "fixtures");
  const candidate = path.join(fixturesDir, "candidate.txt");
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(candidate, candidateText, "utf-8");
  const adapters = realAdapters();
  const baseReal = adapters.realpath(base);
  const rootReal = adapters.realpath(root);
  const candidateReal = adapters.realpath(candidate);
  const admission = {
    root: adapters.objectIdentity(rootReal),
    base: adapters.objectIdentity(baseReal),
    candidate: adapters.objectIdentity(candidateReal),
  };
  const ownedRoot = {
    id: `fixtures-${label}`,
    path: rootReal,
    base: baseReal,
    admissionIdentity: { root: { ...admission.root }, base: { ...admission.base } },
  };
  const runId = `${CORRIDOR_RUN_ID_PREFIX}-identity-${label}-${sha256(dir).slice(0, 12)}`;
  const record = await buildSyntheticRecord({
    kind: "pi",
    runId,
    caseId: `identity-${label}`,
    ops: [{ id: "op-done", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
    observations: [
      {
        id: "obs-done",
        fact: { kind: "public-output", text: `STATUS: done\nCHANGES: identity gate ${label}\nKEY: identity-${label}` },
        sourceRef: "SL1",
      },
    ],
    outcomes: [{ id: "oc-0", outcome: { description: "claim completes" }, sourceRef: "SL1", operationRef: "op-done", evidenceRefs: ["obs-done"] }],
  });
  const actions = [
    {
      id: "a-done",
      type: "replay.claim_complete",
      runId,
      operationId: "op-done",
      agentId: REPLAY_CORRIDOR_AGENT,
      roundIndex: 0,
      outputRefs: ["obs-done"],
      verdict: "verified",
      fixturePath: "fixtures/candidate.txt",
    },
  ];
  const planRes = validateReplayPlan({
    record,
    runtime: "pi",
    admittedRunId: runId,
    ownedRoot,
    actions,
    realpath: adapters.realpath.bind(adapters),
    objectIdentity: adapters.objectIdentity.bind(adapters),
  });
  return {
    dir,
    base,
    root,
    fixturesDir,
    candidate,
    candidateReal,
    baseReal,
    rootReal,
    admission,
    ownedRoot,
    adapters,
    record,
    actions,
    planRes,
    plan: planRes.ok ? planRes.plan : null,
    runId,
    rootId: `fixtures-${label}`,
    label,
    candidateText,
  };
}

function cleanupValidate(f) {
  return validateCleanupPhase({
    plan: f.plan,
    cleanup: { runId: f.runId, rootId: f.rootId, paths: ["fixtures/candidate.txt"] },
    realpath: f.adapters.realpath.bind(f.adapters),
    objectIdentity: f.adapters.objectIdentity.bind(f.adapters),
  });
}

async function stage4() {
  // Fresh mkdtemp root per gate run; failed/partial predecessors are never
  // deleted and this dir is retained (reported path below).
  const stageDir = fs.mkdtempSync(path.join(EVIDENCE_DIR, "stage4-identity-"));
  const adapters = realAdapters();
  const checksDone = { aliasesRetained: 0, replacedSiblingsRetained: 0 };

  // ── 4.1 Positive cleanup + canonical-alias positive control (independent
  //    fixture, everything RETAINED — including the alias symlink).
  const f1 = await buildIdentityFixture(stageDir, "pos", "owned fixture content — identity pinned\n");
  check("S4", f1.planRes.ok === true, `real owned-root plan validates (admission identity ${JSON.stringify(f1.admission.root)})`);
  if (!f1.planRes.ok) {
    note("S4", JSON.stringify(f1.planRes.errors));
    return { stageDir, checksDone, skipped: true };
  }
  const plan1 = f1.plan;
  check("S4", plan1.rootIdentity.rootReal === f1.rootReal && plan1.rootIdentity.baseReal === f1.baseReal, "plan binds identity on the HOST-RESOLVED real paths");
  const action1 = plan1.actions[0];
  check("S4", action1.fixturePath === "fixtures/candidate.txt" && action1.fixtureIdentity && action1.fixtureIdentity.ino === f1.admission.candidate.ino,
    "plan captured the candidate's real filesystem identity at admission");

  const okCleanup = cleanupValidate(f1);
  check("S4", okCleanup.ok === true && okCleanup.removals.length === 1, "cleanup revalidates the held-root identity and proposes exactly one removal (executed:false, retained)");
  check("S4", okCleanup.removals[0].realPath === f1.candidateReal && okCleanup.removals[0].executed === false && okCleanup.removals[0].executorRecheckRequired === true,
    "removal descriptor carries the real candidate path, executed:false and the executor recheck obligation");

  const aliasPath = path.join(f1.base, "root-alias");
  fs.symlinkSync(f1.rootReal, aliasPath, "dir");
  const aliasRes = validateReplayPlan({
    record: f1.record,
    runtime: "pi",
    admittedRunId: f1.runId,
    ownedRoot: {
      id: `fixtures-pos`,
      path: aliasPath,
      base: f1.baseReal,
      admissionIdentity: { root: { ...f1.admission.root }, base: { ...f1.admission.base } },
    },
    actions: f1.actions,
    realpath: adapters.realpath.bind(adapters),
    objectIdentity: adapters.objectIdentity.bind(adapters),
  });
  check("S4", aliasRes.ok === true && aliasRes.plan.rootIdentity.rootReal === f1.rootReal,
    "canonical alias (symlink) validates: identity pinned on the host-resolved real object, not lexical equality");
  // The alias symlink is RETAINED (never unlinked) as evidence; the fixture
  // below it is never moved/removed because every replacement scenario uses
  // its own INDEPENDENT fixture root.
  checksDone.aliasesRetained += 1;
  check("S4", fs.lstatSync(aliasPath).isSymbolicLink() && fs.existsSync(f1.candidateReal),
    "canonical alias symlink retained (no actual removal) with its target fixture intact");

  // ── 4.2 Same-path ROOT replacement refusal + restore (independent fixture;
  //    exact retained-sibling renames only — no rmdir/unlink).
  const f2 = await buildIdentityFixture(stageDir, "root-repl", "owned root-replacement fixture — identity pinned\n");
  check("S4", f2.planRes.ok === true, "[root-replacement] independent fixture plan validates");
  const replacedRootCleanup = (() => {
    const movedRoot = path.join(f2.base, "root.original-retained");
    fs.renameSync(f2.rootReal, movedRoot); // original root RETAINED under a sibling name
    fs.mkdirSync(f2.rootReal, { recursive: true }); // NEW empty object at the SAME path
    const refusal = cleanupValidate(f2);
    // Restore WITHOUT removal: move the replacement aside (retained sibling)
    // and rename the original back to its admitted path.
    fs.renameSync(f2.rootReal, path.join(f2.base, "root.replaced-retained"));
    fs.renameSync(movedRoot, f2.rootReal);
    checksDone.replacedSiblingsRetained += 1;
    const restored = cleanupValidate(f2);
    return { refusal, restored };
  })();
  check("S4", replacedRootCleanup.refusal.ok === false && replacedRootCleanup.refusal.errors.some((e) => e.code === "object-identity-changed"),
    "same-path root replacement refused at cleanup (object-identity-changed); no removal proposed");
  check("S4", replacedRootCleanup.restored.ok === true, "after retained-sibling rename restore the original root object revalidates");

  // ── 4.3 Same-path BASE replacement refusal + restore (independent fixture).
  const f3 = await buildIdentityFixture(stageDir, "base-repl", "owned base-replacement fixture — identity pinned\n");
  check("S4", f3.planRes.ok === true, "[base-replacement] independent fixture plan validates");
  const replacedBaseCleanup = (() => {
    const movedBase = path.join(f3.dir, "base.original-retained");
    fs.renameSync(f3.baseReal, movedBase); // original base RETAINED (root still inside it)
    fs.mkdirSync(f3.baseReal, { recursive: true }); // NEW base at the same path
    fs.renameSync(path.join(movedBase, "root"), path.join(f3.baseReal, "root")); // root moved under the NEW base
    const refusal = cleanupValidate(f3);
    // Restore without removal.
    fs.renameSync(path.join(f3.baseReal, "root"), path.join(movedBase, "root"));
    fs.renameSync(f3.baseReal, path.join(f3.dir, "base.replaced-retained"));
    fs.renameSync(movedBase, f3.baseReal);
    checksDone.replacedSiblingsRetained += 1;
    const restored = cleanupValidate(f3);
    return { refusal, restored };
  })();
  check("S4", replacedBaseCleanup.refusal.ok === false && replacedBaseCleanup.refusal.errors.some((e) => e.code === "object-identity-changed"),
    "same-path base/ancestor replacement refused at cleanup (object-identity-changed)");
  check("S4", replacedBaseCleanup.restored.ok === true, "after retained-sibling rename restore the original base object revalidates");

  // ── 4.4 Same-path CANDIDATE replacement refusal + restore (independent
  //    fixture). The REPLACED candidate is retained as a sibling file and the
  //    ORIGINAL candidate is renamed back — no unlink anywhere.
  const f4 = await buildIdentityFixture(stageDir, "cand-repl", "owned candidate-replacement fixture — identity pinned\n");
  check("S4", f4.planRes.ok === true, "[candidate-replacement] independent fixture plan validates");
  const replacedCandidateCleanup = (() => {
    const movedOriginal = path.join(f4.fixturesDir, "candidate.original-retained");
    fs.renameSync(f4.candidateReal, movedOriginal);
    fs.writeFileSync(f4.candidateReal, "REPLACED object content\n", "utf-8"); // NEW inode at the SAME path
    const refusal = cleanupValidate(f4);
    // Restore without removal: move the replacement aside (retained sibling)
    // and rename the ORIGINAL candidate object back.
    fs.renameSync(f4.candidateReal, path.join(f4.fixturesDir, "candidate.replaced-retained"));
    fs.renameSync(movedOriginal, f4.candidateReal);
    checksDone.replacedSiblingsRetained += 1;
    const restored = cleanupValidate(f4);
    return { refusal, restored };
  })();
  check("S4", replacedCandidateCleanup.refusal.ok === false && replacedCandidateCleanup.refusal.errors.some((e) => e.code === "cleanup-candidate-replaced"),
    "same-path fixture candidate replacement refused at cleanup (cleanup-candidate-replaced)");
  check("S4", replacedCandidateCleanup.restored.ok === true, "after retained-sibling rename restore the original candidate object revalidates");

  // ── Retention evidence: original fixture objects all still exist byte-
  //    identical, and every replaced/aliased sibling is RETAINED on disk.
  for (const [label, f, needle] of [
    ["pos", f1, "identity pinned"],
    ["root-repl", f2, "root-replacement fixture"],
    ["base-repl", f3, "base-replacement fixture"],
    ["cand-repl", f4, "candidate-replacement fixture"],
  ]) {
    check("S4", fs.existsSync(f.candidateReal) && fs.readFileSync(f.candidateReal, "utf-8").includes(needle),
      `[${label}] original fixture candidate retained byte-identical after every refusal control`);
  }
  const retainedSiblings = [];
  for (const dir of fs.readdirSync(stageDir)) {
    const walk = (p) => {
      retainedSiblings.push(p);
      for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
        const child = path.join(p, ent.name);
        if (ent.isDirectory()) walk(child);
        else retainedSiblings.push(child);
      }
    };
    walk(path.join(stageDir, dir));
  }
  const retainedReplacementOrAlias = retainedSiblings.filter((p) => /(replaced-retained|original-retained|root-alias)/.test(p));
  check("S4", checksDone.aliasesRetained >= 1 && checksDone.replacedSiblingsRetained >= 3 && retainedReplacementOrAlias.length >= 4,
    `replacement/alias evidence objects retained as siblings (aliases=${checksDone.aliasesRetained}, replaced-siblings=${checksDone.replacedSiblingsRetained}, retained objects=${retainedReplacementOrAlias.length})`);
  return { stageDir, checksDone, retainedSiblings };
}

// ═══════════════════════════════════════════════════════════════════
// Stage 5 — report + contract
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log(`CORE-MOTOR conformance gate — repo ${REPO_ROOT}`);
  console.log(`evidence dir: ${EVIDENCE_DIR}`);
  const s0 = await stage0();
  const s1 = await stage1();
  const s1p = await stagePipeLifetime();
  const s2 = await stage2();
  const s3 = await stage3();
  const s4 = await stage4();

  // Revalidate the final source hashes (source was not edited during the gate;
  // the committed files must be byte-identical to what the gate ran against).
  const finalShas = {};
  let sourceStable = true;
  for (const [rel, h] of Object.entries(s0.sourceShas)) {
    const abs = path.join(REPO_ROOT, rel);
    const now = fs.existsSync(abs) ? fileSha(abs) : null;
    finalShas[rel] = now;
    if (now !== h) sourceStable = false;
  }
  check("S5", sourceStable, "source files byte-stable across the whole gate (start hashes == end hashes)");

  const summary = {
    contractVersion: "core-motor-1",
    timestampUtc: new Date().toISOString(),
    gitHead: s0.gitHead,
    gitTree: s0.gitTree,
    gitTreeDirty: s0.gitStatusShort.length > 0,
    // Attribution (review Issue 4): when the gate ran on a CLEAN committed
    // tree, gitHead/gitTree ARE the tested commit/tree and sourceShasStart/End
    // equal the committed file bytes. When gitTreeDirty is true the gate ran
    // on an uncommitted tree: gitHead is the parent and the tested bytes are
    // the working-tree bytes recorded in sourceShasStart/sourceShasEnd (the
    // follow-up commit is recorded in core-motor-close-contract.json).
    repoRoot: REPO_ROOT,
    taskSuffix: TASK_SUFFIX,
    sourceShasStart: s0.sourceShas,
    sourceShasEnd: finalShas,
    sourceStable,
    stage1: {
      instrumentedRefusalPath: {
        effectClassEntries: s1.effectClassEntries,
        negativeCount: s1.negativeCount,
        noPlanRefusals: s1.noPlanRefusals,
        refusalsProven: s1.refusalsProven,
      },
    },
    stage1pPipeLifetime: {
      ok: s1p.ok,
      note: s1p.note,
      legs: s1p.legs.map((l) => ({ leg: l.leg, ok: l.ok, ...(l.elapsedMs !== undefined ? { elapsedMs: l.elapsedMs } : {}) })),
    },
    cases: s2.results.map((v) => ({
      caseId: v.caseId,
      runtime: v.runtime,
      ok: v.ok,
      sourceRunId: v.sourceRunId,
      freshRunId: v.freshRunId,
      runStatus: v.runStatus,
      verifyOk: v.verifyOk,
      failedChecks: (v.verifyChecks ?? []).filter((c) => !c.pass).map((c) => c.name),
      daemonStop: v.daemonStop,
      launchStop: v.launchStop,
      cleanup: v.cleanup,
      preRunIdle: v.preRunIdle,
      postTerminalIdle: v.postTerminal,
      sandbox: v.sandbox,
    })),
    receiptMutationBattery: s2.receiptMutationBattery,
    negativeLegs: {
      refusedPlan: s2.refusedPlanLeg,
      launcherFailure: s2.launcherFailureLeg,
      terminalSignalHandle: s2.terminalSignalLeg,
      forcedFailure: s2.forcedFailureLeg,
    },
    stage3Pipe: { runtimes: ["pi", "hermes"], payloads: PIPE_PAYLOADS.map(([n]) => n), producerExitCode: 17 },
    stage4: { identityRefusals: ["object-identity-changed", "cleanup-candidate-replaced"], canonicalAliasPositive: true, retained: true, retainedRoot: s4.stageDir },
    failures,
    passes,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, "gate-report.json"), JSON.stringify(summary, null, 2), "utf-8");
  note("S5", `gate-report.json written (${EVIDENCE_DIR})`);
  console.log(`\nCORE-MOTOR gate result: ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} (${passes} checks)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("CORE-MOTOR gate crashed:", e);
  process.exitCode = 2;
});
