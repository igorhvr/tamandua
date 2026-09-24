// tier0-core-recording-replay-adapter-conformance.test.ts — CORE US-003
// designated gate (safety/adapter slice).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.2, authorized torture-only slice
// "CORE-REPLAY". This gate conformance-tests the replay ADAPTER of US-003:
//   torture-test/bin/core-recording-replay-adapter.mjs
// which consumes the existing validated immutable recording contract
// (core-recording-contract.mjs), validates a COMPLETE replay plan BEFORE any
// side effect, and maps reviewed typed fixture actions / preserved public
// outputs onto the EXISTING frozen scripted runtimes and the real
// step-protocol/motor tooling as an exact recorded-call contract.
//
// ── What this gate proves (recording-only; zero tokens; zero children) ──
//   (a) Interface pin + purity: the adapter exports EXACTLY
//       REPLAY_ADAPTER_VERSION, SUPPORTED_RUNTIMES, EXECUTOR_ACTION_TYPES,
//       EXACT_RUNTIME_PATHS, STEP_CLI_ARGV, PROBE_CONTRACT, BEHAVIOR_ENV,
//       DSH_UNSUPPORTED_DIAGNOSTIC, checkOwnedRelativePath,
//       isResolvedPathInside, observationToText,
//       preservedPayloadSemanticErrors, validateReplayPlan,
//       validateCleanupPhase and materializeRuntimeSeed; its only import is
//       the US-001 contract module (no node:fs, node:path, node:child_process,
//       no eval/Function, no write/remove/spawn/kill construct anywhere).
//   (b) Probe-contract / runtime parity conformance: the adapter's
//       STEP_CLI_ARGV templates and PROBE_CONTRACT marker/prompt mirror the
//       ACTUAL frozen scripted runtime (torture-test/scripted-runtimes/
//       runtime-shared.mjs) literal-for-literal; the exact supported runtime
//       paths exist on disk; dsh is refused with a precise diagnostic and no
//       dsh path is claimed anywhere in the adapter surface.
//   (c) Positive legitimate plans: a fully attributed record (claim_complete
//       + claim_fail + unclaimed_exit + idle_dispatch) validates for BOTH
//       supported runtimes (pi and hermes); the plan carries the exact real
//       entrypoints the later isolated-motor run would issue (step-CLI argv
//       arrays per runtime-shared.mjs claimStep/completeStep/failStep, the
//       launch-time harness probe prompt, canned-behavior seeds), all with
//       executed:false; token accounting is zero; the actual motor run is
//       marked NOT YET EXECUTED.
//   (d) Format-vs-executor layering: a type-shaped replay op the US-001
//       FORMAT accepts (validateRecordingRecord ok) is still REFUSED by the
//       EXECUTOR when it is not in the closed vocabulary (unknown-type).
//   (e) Negative containment/safety (every refusal happens with NO plan and
//       therefore ZERO motor calls): unknown action type, mixed run identity,
//       missing attribution (absent runId/operationId/unresolvable outputRef),
//       unattributed outcome, missing preserved output, absolute / traversing
//       fixture paths, symlinked root/ancestor substitution, symlink escape
//       of a fixture candidate, corrupt payload hash, and verified-success
//       claims over declared UNKNOWN evidence (global and operation-scoped
//       gaps); cleanup-phase identity loss (wrong run, wrong root, changed
//       realpath between the plan phase and the cleanup phase) refuses before
//       any removal; duplicate coverage of one replay-namespaced record
//       operation (the exactly-one invariant); non-integer / negative /
//       out-of-range replay.unclaimed_exit exitCode values (refused at plan
//       time so the recorded descriptor and canned-behavior seed cannot
//       disagree).
//   (f) No invention of missing raw bytes: a gapped claim_complete MUST be
//       re-declared as verdict "synthetic-adaptation" with an explicit
//       adaptationNote to validate; verified is refused over gaps. The
//       unknown-gap policy is ASYMMETRIC (documented): it blocks only
//       verified-success assertions, while failure-shape replays
//       (claim_fail / unclaimed_exit) validate under a declared gap without
//       a synthetic-adaptation declaration (pinned below).
//   (g) CORE-REPLAY-CLOSE hardening (adapter v3, root-observed
//       counterexamples — exact negative AND positive controls):
//       (g1) sparse per-agent work-invocation indices are refused
//       (noncontiguous-round-indices) so materializeRuntimeSeed can never
//       invent unrecorded "STATUS: done" successes for missing indices;
//       idle_dispatch is NOT a harness invocation — it never occupies or
//       justifies a work-invocation index ([idle@0, claim@0] on one agent is
//       legitimate and seeds exactly ONE entry; [idle@0, claim@2] and a lone
//       claim@2 are refused); the seed throws rather than fabricate a filler;
//       (g2) die-before-claim preserved public stdout is carried VERBATIM on
//       the seed AND the mapped runtime path: behavior.preservedStdout holds
//       the exact bytes (empty / no-final-newline kept) identically to the
//       recorded descriptor, and a documented KNOB region in BOTH pi and
//       hermes die-before-claim branches writes fs.writeSync(1,
//       behavior.preservedStdout) before exit — statically pinned here, no
//       runtime spawned (actual frozen-runtime execution is the next
//       root-reviewed gate); (g3) owned-root admission binds to the
//       INDEPENDENTLY CAPTURED trusted object identity
//       (ownedRoot.admissionIdentity + injected objectIdentity adapter):
//       combined base+root realpath substitution into a foreign tree and a
//       same-path root replacement are refused (root-identity-mismatch),
//       missing capture/adapter is refused fail-closed
//       (missing-root-identity / adapter-shape), and a legitimate canonical
//       alias (macOS /tmp -> /private/tmp) still validates with identity
//       pinned on the host-resolved object; (g4) validateCleanupPhase
//       re-proves the held-root filesystem object identity (root AND base)
//       before proposing removals and re-checks plan-admitted fixture
//       candidates: replaced root / replaced base-ancestor / replaced
//       candidate and missing identity are all refused
//       (object-identity-changed / cleanup-candidate-replaced / identity-loss)
//       while legitimate cleanup descriptors are preserved with candidate +
//       admission identities and the executorRecheckRequired obligation
//       carried explicitly (a pure plan/validation-time check never closes
//       the executor's later check/use race).
//
// ── Recording-only adapters ──────────────────────────────────────────
// Every host-reality dependency is injected and recording:
//   * recordingFsAdapter: a virtual realpath() over an owned synthetic path
//     tree (identity map unless a case overrides it, e.g. to simulate a
//     symlinked root/ancestor or a symlink escape), journaling every call so
//     the gate can prove the adapter re-resolves identities at each phase.
//   * recordingMotorAdapter: journals the materialized entrypoints that the
//     later isolated-motor run would issue; refuses executed:true
//     descriptors; the gate asserts refused plans yield zero entrypoints, so
//     no call can ever reach the motor after a refusal.
// No real child/daemon/port/removal/signal/process is ever created by this
// gate or by the module under test. The ONLY host filesystem reads are the
// gate's sanctioned reads of the tracked torture sources it conformance-checks
// against (runtime-shared.mjs and the adapter module file itself).
//
// Synthetic corpus only: every run id, agent id, observation and path below
// is a fixture string; nothing is copied from the ORIGINAL source inventory
// (torture-test/var/review-logs/core-recording-source-ZFANtD/ lives in the
// ORIGINAL checkout outside this worktree).
//
// Runs as its own `node --test torture-test/self-tests/tier0-core-recording-
// replay-adapter-conformance.test.ts` (designated focused gate; single file
// per invocation) and also passes under self-tests/run.sh's tier0 glob.
// Node >= 22 runs .ts directly; the .mjs modules are loaded via dynamic
// import with pathToFileURL. Leaves the git working tree clean (no writes).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ADAPTER_PATH = path.join(repoRoot, "torture-test", "bin", "core-recording-replay-adapter.mjs");
const CONTRACT_PATH = path.join(repoRoot, "torture-test", "bin", "core-recording-contract.mjs");
const RUNTIME_SHARED_PATH = path.join(repoRoot, "torture-test", "scripted-runtimes", "runtime-shared.mjs");
const ADAPTER_URL = pathToFileURL(ADAPTER_PATH).href;
const CONTRACT_URL = pathToFileURL(CONTRACT_PATH).href;

assert.ok(fs.existsSync(ADAPTER_PATH), `cannot find the adapter module at ${ADAPTER_PATH}`);
assert.ok(fs.existsSync(CONTRACT_PATH), `cannot find the US-001 contract module at ${CONTRACT_PATH}`);
assert.ok(fs.existsSync(RUNTIME_SHARED_PATH), `cannot find the frozen runtime-shared at ${RUNTIME_SHARED_PATH}`);

// ── synthetic fixture vocabulary (nothing from the ORIGINAL inventory) ─────
const RUN = "run-synth-cr-00000000-0000-4000-8000-000000000000";
const OTHER_RUN = "run-synth-cr-11111111-2222-4333-8444-555555555555";
const AGENT_DOER = "wcr_doer";
const AGENT_REVIEWER = "wcr_reviewer";
const FIXTURE_BASE = "/tmp/synth-cr-owner";
const FIXTURE_ROOT = "/tmp/synth-cr-owner/wcr-fixture-root-7f3a";
const FIXTURE_REL = "fixtures/wcr-run/notes.json";

// Trusted owned-root object identities: the executor independently captures
// these at ownership admission (fixture creation). {dev, ino} snapshots —
// never bare strings, which are not filesystem object identity. A same-path
// replacement (dev1/ino101 -> dev1/ino202) keeps every pathname string equal
// and MUST still be caught by the object-identity recheck.
const ADM_BASE_ID = Object.freeze({ dev: 7, ino: 100 });
const ADM_ROOT_ID = Object.freeze({ dev: 7, ino: 101 });

function synthSha256(label: string): string {
  return createHash("sha256").update(`synthetic:${label}`, "utf8").digest("hex");
}

function locator(locatorId: string): any {
  return {
    locatorId,
    runId: RUN,
    locator: { source_file: `synth-${locatorId}.jsonl`, row: 7 },
    sha256: synthSha256(`locator-${locatorId}`),
  };
}

// ── recording (virtual) filesystem adapters ──────────────────────────────
// Two injected adapters model host reality for the module under test:
//   * realpath(p)   — canonical path resolution over an owned synthetic tree
//     (identity map unless a case overrides it, e.g. to simulate a symlinked
//     root/ancestor, a combined base+root substitution into a foreign tree,
//     or a canonical alias such as macOS /tmp).
//   * identity(p)   — the CURRENT stable filesystem object-identity snapshot
//     (objectIdentity adapter) for an ALREADY-RESOLVED real path. Defaults
//     are deterministic per path and pre-seeded for the owned base/root with
//     ADM_BASE_ID/ADM_ROOT_ID; replaceObject(path, newIdentity) simulates a
//     SAME-PATH object replacement (the pathname string does not change).
// Both journal every call so the gate can prove re-resolution at each phase.
interface RecordingFsAdapter {
  realpath(p: string): string;
  identity(realPath: string): { dev: number; ino: number };
  identityOf(realPath: string): { dev: number; ino: number };
  journal: string[];
  override(entry: string, resolved: string): void;
  overrideError(entry: string, message: string): void;
  replaceObject(realPath: string, newIdentity: { dev: number; ino: number }): void;
}

/** Deterministic per-path default object identity (stable across calls). */
function defaultIdentityFor(realPath: string): { dev: number; ino: number } {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < realPath.length; i += 1) {
    h ^= realPath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return { dev: 7, ino: h >>> 0 };
}

/**
 * Recording (virtual) filesystem adapter. `canonicalBasePrefix`, when given,
 * is the HOST-RESOLVED canonical directory for FIXTURE_BASE (modelling a
 * canonical alias such as macOS /tmp -> /private/tmp): realpath maps the
 * lexical owned tree under FIXTURE_BASE onto the canonical tree under
 * canonicalBasePrefix, and the trusted identities live at the canonical
 * keys (identity is pinned on the host-resolved object, never on lexical
 * equality).
 */
function createRecordingFsAdapter(canonicalBasePrefix: string | null = null): RecordingFsAdapter {
  const journal: string[] = [];
  const overrides = new Map<string, string>();
  const overridesError = new Map<string, string>();
  const identityMap = new Map<string, { dev: number; ino: number }>();
  if (canonicalBasePrefix !== null) {
    // Canonical (host-resolved) owned base/root carry the trusted identities.
    identityMap.set(canonicalBasePrefix, { ...ADM_BASE_ID });
    identityMap.set(`${canonicalBasePrefix}/wcr-fixture-root-7f3a`, { ...ADM_ROOT_ID });
  } else {
    // Default tree: lexical == canonical.
    identityMap.set(FIXTURE_BASE, { ...ADM_BASE_ID });
    identityMap.set(FIXTURE_ROOT, { ...ADM_ROOT_ID });
  }
  const resolveReal = (p: string): string => {
    if (overridesError.has(p)) throw new Error(overridesError.get(p));
    if (overrides.has(p)) return overrides.get(p) as string;
    if (canonicalBasePrefix !== null && p.startsWith(FIXTURE_BASE)) {
      return p === FIXTURE_BASE ? canonicalBasePrefix : canonicalBasePrefix + p.slice(FIXTURE_BASE.length);
    }
    if (!p.startsWith(FIXTURE_BASE)) {
      throw new Error(`recording fs: unregistered path ${p}`);
    }
    return p;
  };
  const adapter: RecordingFsAdapter = {
    journal,
    realpath(p: string): string {
      journal.push(p);
      return resolveReal(p);
    },
    identity(realPath: string): { dev: number; ino: number } {
      journal.push(`identity:${realPath}`);
      const found = identityMap.get(realPath);
      return found ? { ...found } : defaultIdentityFor(realPath);
    },
    identityOf(realPath: string): { dev: number; ino: number } {
      const found = identityMap.get(realPath);
      return found ? { ...found } : defaultIdentityFor(realPath);
    },
    override(entry: string, resolved: string) {
      overrides.set(entry, resolved);
    },
    overrideError(entry: string, message: string) {
      overridesError.set(entry, message);
    },
    replaceObject(realPath: string, newIdentity: { dev: number; ino: number }) {
      // Same canonical path, DIFFERENT object: models a same-path virtual
      // root/ancestor/candidate replacement (e.g. dev1/ino101 -> dev1/ino202).
      identityMap.set(realPath, { ...newIdentity });
    },
  };
  return adapter;
}

/**
 * The standard owned-root object for the synthetic tree: id/path/base plus
 * the TRUSTED admission-time object-identity capture (ADM_BASE_ID/ADM_ROOT_ID
 * — the identities the executor recorded when it created the owned fixture).
 */
function fixtureOwnedRoot(): any {
  return {
    id: "fixtures",
    path: FIXTURE_ROOT,
    base: FIXTURE_BASE,
    admissionIdentity: { base: { ...ADM_BASE_ID }, root: { ...ADM_ROOT_ID } },
  };
}

// ── recording motor adapter ──────────────────────────────────────────────
// The stand-in for the real isolated daemon/scheduler/step-CLI motor of a
// later execution story. It can only RECORD materialized entrypoints; it
// refuses any descriptor that claims to have executed. Refused plans carry
// no plan object at all, so nothing is ever fed to the motor after a
// refusal — asserted by every negative case below.
interface RecordingMotor {
  calls: any[];
  feed(entrypoints: any[]): void;
}

function createRecordingMotor(): RecordingMotor {
  const calls: any[] = [];
  return {
    calls,
    feed(entrypoints: any[]) {
      for (const ep of entrypoints) {
        assert.equal(ep.executed, false, "a recording motor must never see an executed entrypoint");
        calls.push({
          kind: ep.kind,
          argv: ep.argv ?? null,
          input: ep.input ?? null,
          behaviorMode: ep.behaviorMode ?? null,
          exitCode: ep.exitCode ?? null,
          spawn: ep.spawn ?? null,
          peekResult: ep.peekResult ?? null,
        });
      }
    },
  };
}

// ── module loading helpers ────────────────────────────────────────────────

let contractPromise: Promise<any> | null = null;
function loadContract(): Promise<any> {
  if (contractPromise === null) contractPromise = import(CONTRACT_URL);
  return contractPromise;
}

let adapterPromise: Promise<any> | null = null;
function loadAdapter(): Promise<any> {
  if (adapterPromise === null) adapterPromise = import(ADAPTER_URL);
  return adapterPromise;
}

function clone(value: any): any {
  return JSON.parse(JSON.stringify(value));
}

// ── synthetic record builders ─────────────────────────────────────────────

interface OpSpec {
  id: string;
  type: string;
  evidenceRefs?: string[];
}

/**
 * Build a deep-frozen valid US-001 record over the given replay ops,
 * observations and expected outcomes (all synthetic).
 */
async function buildRecordImpl({
  ops,
  observations,
  outcomes,
  unknown = [],
  runId = RUN,
}: {
  ops: OpSpec[];
  observations: any[];
  outcomes: any[];
  unknown?: any[];
  runId?: string;
}): Promise<any> {
  const mod = await loadContract();
  const record = mod.buildRecordingRecord({
    sourceIdentity: {
      kind: "pi",
      runId,
      caseId: "SYNTH-CASE-CR-US003",
      sourceRefs: [locator("L1"), locator("L2")],
      sourceSha256: synthSha256("source"),
    },
    observations,
    transformations: [{ step: "adapt.synthetic_fixture", note: "entire corpus is synthetic", sourceRef: "L1" }],
    operations: ops.map((op) => ({ id: op.id, type: op.type, sourceRef: "L1", ...(op.evidenceRefs ? { evidenceRefs: op.evidenceRefs } : {}) })),
    expectedOutcomes: outcomes,
    unknown,
  });
  return record;
}

// The 4-op legitimate replay record used by the positive cases.
async function buildFullRecord(): Promise<any> {
  return buildRecordImpl({
    ops: [
      { id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
      { id: "op-fail", type: "replay.claim_fail", evidenceRefs: ["obs-fail"] },
      { id: "op-exit", type: "replay.unclaimed_exit" },
      { id: "op-idle", type: "replay.idle_dispatch" },
    ],
    observations: [
      { id: "obs-done", fact: { kind: "public-output", text: "STATUS: done\nCHANGES: synthetic completed round\nKEY: cell-ok" }, sourceRef: "L1" },
      { id: "obs-fail", fact: { kind: "public-output", text: "MISSING_CREDENTIAL synthetic refusal reason" }, sourceRef: "L1" },
    ],
    outcomes: [
      { id: "oc-claim", outcome: { description: "claim_complete round completes the step" }, sourceRef: "L1", operationRef: "op-claim", evidenceRefs: ["obs-done"] },
      { id: "oc-fail", outcome: { description: "claim_fail round fails the step" }, sourceRef: "L1", operationRef: "op-fail", evidenceRefs: ["obs-fail"] },
      { id: "oc-exit", outcome: { description: "round exits unclaimed" }, sourceRef: "L1", operationRef: "op-exit" },
      { id: "oc-idle", outcome: { description: "dispatch tick is idle" }, sourceRef: "L1", operationRef: "op-idle" },
    ],
  });
}

// The four legitimate plan actions mirroring the full record.
function fullPlanActions(): any[] {
  return [
    {
      id: "a-claim",
      type: "replay.claim_complete",
      runId: RUN,
      operationId: "op-claim",
      agentId: AGENT_DOER,
      roundIndex: 0,
      outputRefs: ["obs-done"],
      verdict: "verified",
      fixturePath: FIXTURE_REL,
    },
    {
      id: "a-fail",
      type: "replay.claim_fail",
      runId: RUN,
      operationId: "op-fail",
      agentId: AGENT_DOER,
      roundIndex: 1,
      outputRefs: ["obs-fail"],
    },
    {
      id: "a-exit",
      type: "replay.unclaimed_exit",
      runId: RUN,
      operationId: "op-exit",
      agentId: AGENT_DOER,
      roundIndex: 2,
      exitCode: 3,
    },
    {
      id: "a-idle",
      type: "replay.idle_dispatch",
      runId: RUN,
      operationId: "op-idle",
      agentId: AGENT_REVIEWER,
      roundIndex: 0,
    },
  ];
}

function cleanFsAdapter(): RecordingFsAdapter {
  return createRecordingFsAdapter();
}

// Find an error by code in a refusal result.
function findError(res: any, code: string): any {
  assert.equal(res.ok, false, `expected refusal with ${code}, but plan validated: ${JSON.stringify(res)}`);
  const found = (res.errors ?? []).find((e: any) => e.code === code);
  assert.ok(found, `expected error code ${code}, got ${JSON.stringify(res.errors)}`);
  return found;
}

// Assert a refusal leaves NOTHING to feed a motor (no plan object at all).
function assertRefusalProducesNoPlan(res: any): void {
  assert.equal(res.ok, false);
  assert.equal(res.plan, undefined, "a refused plan must never materialize a plan object");
  const motor = createRecordingMotor();
  assert.equal(motor.calls.length, 0, "refusals must leave the motor with zero calls");
}

// ── tests ────────────────────────────────────────────────────────────────

describe("CORE US-003 replay adapter (safety/adapter slice)", () => {
  it("pins the exact module interface and purity", async () => {
    const mod = await loadAdapter();
    assert.deepEqual(Object.keys(mod).sort(), [
      "BEHAVIOR_ENV",
      "DSH_UNSUPPORTED_DIAGNOSTIC",
      "EXACT_RUNTIME_PATHS",
      "EXECUTOR_ACTION_TYPES",
      "PROBE_CONTRACT",
      "REPLAY_ADAPTER_VERSION",
      "STEP_CLI_ARGV",
      "SUPPORTED_RUNTIMES",
      "checkOwnedRelativePath",
      "isResolvedPathInside",
      "materializeRuntimeSeed",
      "observationToText",
      "preservedPayloadSemanticErrors",
      "validateCleanupPhase",
      "validateReplayPlan",
    ]);
    assert.equal(mod.REPLAY_ADAPTER_VERSION, 3);
    // Purity: the only import is the US-001 contract module (node builtins
    // beneath it). The forbidden-construct scan runs over the module's CODE
    // (comments stripped) so the header prose can document the boundary
    // without itself being a construct; no runtime host-reality construct may
    // exist in the shipped code.
    const source = fs.readFileSync(ADAPTER_PATH, "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    assert.equal(importLines.length, 1, `expected exactly one import (the US-001 contract), got: ${importLines.join("|")}`);
    assert.match(importLines[0], /from\s+["']\.\/core-recording-contract\.mjs["']/);
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
      .replace(/(^|[^:"'A-Za-z0-9_])\/\/[^\n]*/g, "$1"); // line comments
    const forbidden = [
      /node:fs/,
      /node:path/,
      /node:child_process/,
      /\beval\b/,
      /\bnew\s+Function\b/,
      /writeFile/,
      /unlink/,
      /rmSync|rmdir/,
      /\bspawn(Sync)?\s*\(|exec(File|Sync)?\s*\(/,
      /\bfork\s*\(/,
      /\bkill\s*\(/,
      /\bsignal\b/,
      /process\.exit/,
    ];
    for (const re of forbidden) {
      assert.equal(re.test(codeOnly), false, `adapter module code matches forbidden construct ${re}`);
    }
  });

  it("probe-contract and step-CLI conformance against the frozen runtime", async () => {
    const mod = await loadAdapter();
    const runtimeSource = fs.readFileSync(RUNTIME_SHARED_PATH, "utf8");

    // Exact supported runtime paths exist on disk (read-only stat).
    for (const p of Object.values(mod.EXACT_RUNTIME_PATHS)) {
      assert.ok(fs.existsSync(path.join(repoRoot, p)), `supported runtime path missing: ${p}`);
    }
    // Supported runtimes are exactly pi and hermes; no dsh executable.
    assert.deepEqual([...mod.SUPPORTED_RUNTIMES].sort(), ["hermes", "pi"]);
    assert.match(mod.DSH_UNSUPPORTED_DIAGNOSTIC, /no dsh executable/);
    assert.match(mod.DSH_UNSUPPORTED_DIAGNOSTIC, /does not claim dsh-path replay coverage/);
    for (const p of Object.values(mod.EXACT_RUNTIME_PATHS)) {
      assert.ok(!p.includes("dsh"), `no dsh path may be claimed in the adapter surface, got ${p}`);
    }

    // Step-CLI argv templates mirror runtime-shared.mjs literal-for-literal.
    const claimSrc = 'cli(["step", "claim", agentId, "--run-id", runId])';
    const peekSrc = 'cli(["step", "peek", agentId, "--run-id", runId])';
    const completeSrc = 'cli(["step", "complete", stepId], outputText)';
    const failSrc = 'cli(["step", "fail", stepId, reason])';
    assert.ok(runtimeSource.includes(claimSrc), "runtime-shared claimStep drifted");
    assert.ok(runtimeSource.includes(peekSrc), "runtime-shared peekStep drifted");
    assert.ok(runtimeSource.includes(completeSrc), "runtime-shared completeStep drifted");
    assert.ok(runtimeSource.includes(failSrc), "runtime-shared failStep drifted");
    assert.deepEqual([...mod.STEP_CLI_ARGV.claim], ["step", "claim", "{agent}", "--run-id", "{runId}"]);
    assert.deepEqual([...mod.STEP_CLI_ARGV.peek], ["step", "peek", "{agent}", "--run-id", "{runId}"]);
    assert.deepEqual([...mod.STEP_CLI_ARGV.complete], ["step", "complete", "{stepId}"]);
    assert.deepEqual([...mod.STEP_CLI_ARGV.fail], ["step", "fail", "{stepId}", "{reason}"]);

    // Probe marker/prompt mirror runtime-shared.mjs (IFLB contract).
    assert.ok(
      runtimeSource.includes('HARNESS_PROBE_MARKER = "TAMANDUA_HARNESS_PROBE: skill-path"'),
      "runtime-shared probe marker drifted",
    );
    assert.ok(
      runtimeSource.includes(
        'Run the exact command "([^"]+)" and reply with the PATH and nothing else\\.',
      ),
      "runtime-shared probe prompt regex drifted",
    );
    assert.equal(mod.PROBE_CONTRACT.marker, "TAMANDUA_HARNESS_PROBE: skill-path");
    assert.match(mod.PROBE_CONTRACT.prompt, /^Run the exact command "<launcher> skill-path" and reply with the PATH and nothing else\.$/);
    assert.equal(mod.PROBE_CONTRACT.envVar, "TAMANDUA_HARNESS_PROBE");
    assert.deepEqual([...Object.keys(mod.BEHAVIOR_ENV)].sort(), ["behaviors", "state"]);

    // Frozen fork bookkeeping exists (FROZEN_SHA is a 40-hex commit; KNOB
    // regions doc present) — the runtimes the adapter maps onto stay frozen.
    const frozenSha = fs.readFileSync(path.join(repoRoot, mod.EXACT_RUNTIME_PATHS.frozenSha), "utf8").trim();
    assert.match(frozenSha, /^[0-9a-f]{40}$/, "FROZEN_SHA must be a 40-hex commit");
    assert.ok(fs.existsSync(path.join(repoRoot, mod.EXACT_RUNTIME_PATHS.knobRegions)));
  });

  it("validates a full legitimate plan for pi AND hermes with exact real entrypoints (NOT YET EXECUTED)", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();
    const fsAdapter = cleanFsAdapter();
    for (const runtime of ["pi", "hermes"]) {
      const res = mod.validateReplayPlan({
        record,
        runtime,
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      const plan = res.plan;

      // Not-yet-executed contract.
      assert.equal(plan.execution.executed, false);
      assert.equal(plan.execution.scope, "validation-only");
      assert.match(plan.execution.note, /NOT YET EXECUTED/);
      assert.equal(plan.launch.executed, false);
      assert.equal(plan.launch.kind, "harness-probe");
      assert.equal(plan.launch.marker, "TAMANDUA_HARNESS_PROBE: skill-path");
      assert.equal(plan.zeroToken, true);

      // Identity binding.
      assert.equal(plan.admittedRunId, RUN);
      assert.equal(plan.recordRunId, RUN);
      assert.equal(plan.recordPayloadSha256, record.payloadSha256);
      assert.deepEqual(
        { rootId: plan.rootIdentity.rootId, rootReal: plan.rootIdentity.rootReal, baseReal: plan.rootIdentity.baseReal },
        { rootId: "fixtures", rootReal: FIXTURE_ROOT, baseReal: FIXTURE_BASE },
      );

      // Actions + exact real entrypoints (executed:false, zero token).
      assert.equal(plan.actions.length, 4);
      const byId = new Map(plan.actions.map((a: any) => [a.id, a]));
      const claim = byId.get("a-claim");
      assert.deepEqual(claim.entrypoints[0], {
        kind: "step-cli.claim",
        argv: ["step", "claim", AGENT_DOER, "--run-id", RUN],
        executable: "<cli>",
        input: null,
        contract: "torture-test/scripted-runtimes/runtime-shared.mjs claimStep",
        zeroToken: true,
        executed: false,
        bindsStepId: true,
      });
      assert.equal(claim.entrypoints[1].kind, "step-cli.complete");
      assert.equal(claim.entrypoints[1].input, "STATUS: done\nCHANGES: synthetic completed round\nKEY: cell-ok");
      assert.deepEqual(claim.entrypoints[1].argv, ["step", "complete", "<stepId>"]);
      assert.equal(claim.entrypoints[1].executed, false);
      assert.equal(claim.verdict, "verified");
      assert.equal(claim.fixturePath, FIXTURE_REL);

      const fail = byId.get("a-fail");
      assert.deepEqual(fail.entrypoints[0].argv, ["step", "claim", AGENT_DOER, "--run-id", RUN]);
      assert.equal(fail.entrypoints[1].kind, "step-cli.fail");
      assert.equal(fail.entrypoints[1].argv[2], "<stepId>");
      assert.equal(fail.entrypoints[1].argv[3], "MISSING_CREDENTIAL synthetic refusal reason");

      const exit = byId.get("a-exit");
      assert.equal(exit.entrypoints[0].kind, "runtime.exit-unclaimed");
      assert.equal(exit.entrypoints[0].behaviorMode, "die-before-claim");
      assert.equal(exit.entrypoints[0].exitCode, 3);
      assert.equal(exit.entrypoints[0].executed, false);

      const idle = byId.get("a-idle");
      assert.equal(idle.entrypoints[0].kind, "dispatch.idle");
      assert.equal(idle.entrypoints[0].peekResult, "NO_WORK_AVAILABLE");
      assert.equal(idle.entrypoints[0].spawn, false);
      assert.equal(idle.entrypoints[0].zeroToken, true);

      // Feed everything into the recording motor: the recorded call
      // sequence is exactly the step protocol of the frozen runtime.
      const motor = createRecordingMotor();
      for (const a of plan.actions) motor.feed(a.entrypoints);
      const kinds = motor.calls.map((c) => c.kind);
      assert.deepEqual(
        kinds,
        ["step-cli.claim", "step-cli.complete", "step-cli.claim", "step-cli.fail", "runtime.exit-unclaimed", "dispatch.idle"],
      );
      const cliCalls = motor.calls.filter((c) => c.kind.startsWith("step-cli"));
      for (const c of cliCalls) assert.ok(c.argv.some((part: string) => part.includes(RUN) || part === "<stepId>"));
      // Zero token spend by construction.
      for (const a of plan.actions) for (const ep of a.entrypoints) assert.equal(ep.zeroToken, true);
      // The realpath adapter was consulted for root/base/fixture containment.
      assert.ok(fsAdapter.journal.some((p) => p === FIXTURE_ROOT));
      assert.ok(fsAdapter.journal.some((p) => p === FIXTURE_BASE));
      assert.ok(fsAdapter.journal.some((p) => p.startsWith(`${FIXTURE_ROOT}/${FIXTURE_REL}`)));

      // Materialized runtime seed: canned behaviors keyed by agent, laid out
      // per roundIndex, with the preserved outputs and zero token accounting.
      const seed = mod.materializeRuntimeSeed(plan);
      assert.equal(seed.runtime, runtime);
      assert.equal(seed.executed, false);
      assert.equal(seed.behaviorsConfig.heartbeatTokens, 0);
      assert.equal(seed.behaviorsConfig.defaultTokens, 0);
      const doer = seed.behaviorsConfig.agents[AGENT_DOER];
      assert.equal(doer.length, 3);
      assert.equal(doer[0].output, "STATUS: done\nCHANGES: synthetic completed round\nKEY: cell-ok");
      assert.equal(doer[0].mode, "work");
      assert.equal(doer[1].stepAction, "fail");
      assert.equal(doer[1].failReason, "MISSING_CREDENTIAL synthetic refusal reason");
      assert.equal(doer[2].mode, "die-before-claim");
      assert.equal(doer[2].exitCode, 3);
      // idle_dispatch seeds nothing (observed, not scripted).
      assert.equal(seed.behaviorsConfig.agents[AGENT_REVIEWER], undefined);
      assert.equal(seed.env.runtimeBinaryVar, runtime === "pi" ? "TAMANDUA_PI_BINARY" : "TAMANDUA_HERMES_BINARY");
    }
  });

  it("validates the identity-verified cleanup phase and produces zero executed removals", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();
    const fsAdapter = cleanFsAdapter();
    const res = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: fullPlanActions(),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    assert.equal(res.ok, true, JSON.stringify(res.errors));

    const cleanup = mod.validateCleanupPhase({
      plan: res.plan,
      cleanup: { runId: RUN, rootId: "fixtures", paths: [FIXTURE_REL] },
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    assert.equal(cleanup.ok, true, JSON.stringify(cleanup.errors));
    assert.equal(cleanup.removals.length, 1);
    assert.equal(cleanup.removals[0].runId, RUN);
    assert.equal(cleanup.removals[0].rootId, "fixtures");
    assert.equal(cleanup.removals[0].realPath, `${FIXTURE_ROOT}/${FIXTURE_REL}`);
    assert.equal(cleanup.removals[0].executed, false);
    assert.equal(cleanup.cleanup.identityRevalidated, true);
    assert.equal(cleanup.cleanup.executed, false);
    // The cleanup phase re-resolved the current root identity through the
    // adapter (admission journal + cleanup re-resolution journal).
    const rootResolutions = fsAdapter.journal.filter((p) => p === FIXTURE_ROOT);
    assert.ok(rootResolutions.length >= 2, `expected re-resolution of the root at cleanup time, got ${JSON.stringify(fsAdapter.journal)}`);
  });

  it("refuses dsh with the precise diagnostic and no partial plan", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();
    const fsAdapter = cleanFsAdapter();
    const res = mod.validateReplayPlan({
      record,
      runtime: "dsh",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: fullPlanActions(),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    const e = findError(res, "runtime-unsupported");
    assert.equal(e.path, "$.runtime");
    assert.match(e.message, /no dsh executable/);
    assert.match(e.message, /does not claim dsh-path replay coverage/);
    assertRefusalProducesNoPlan(res);
  });

  it("lays the executor closed vocabulary over the FORMAT: type-shaped replay ops the FORMAT accepts are refused by the executor", async () => {
    const mod = await loadAdapter();
    const contract = await loadContract();
    // (1) The FORMAT ACCEPTS a replay-namespaced op code that is NOT in the
    //     executor vocabulary (type-shaped, no shell text).
    const record = await buildRecordImpl({
      ops: [{ id: "op-x", type: "replay.self_modify" }],
      observations: [{ id: "obs-x", fact: { kind: "public-output", text: "synthetic" }, sourceRef: "L1" }],
      outcomes: [{ id: "oc-x", outcome: { description: "x" }, sourceRef: "L1", operationRef: "op-x", evidenceRefs: ["obs-x"] }],
    });
    assert.equal(contract.validateRecordingRecord(record).ok, true, "the FORMAT must accept this type-shaped op");
    const fsAdapter = cleanFsAdapter();
    const action = {
      id: "a-x",
      type: "replay.self_modify",
      runId: RUN,
      operationId: "op-x",
      agentId: AGENT_DOER,
      roundIndex: 0,
      outputRefs: ["obs-x"],
      verdict: "verified",
    };
    const res = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [action],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    const e = findError(res, "unknown-type");
    assert.equal(e.path, "$.actions[0].type");
    assert.match(e.message, /closed executor vocabulary/);
    // The uncovered replay-namespaced op is also refused at the record level.
    assert.ok((res.errors ?? []).some((x: any) => x.code === "unknown-type" && x.path.startsWith("$.record.operations")));
    assertRefusalProducesNoPlan(res);

    // (2) An arbitrary non-vocabulary action type is refused the same way
    //     (never reaches any step CLI).
    const res2 = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [{ ...action, type: "sh -c 'rm -rf /tmp/x'" }],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    findError(res2, "unknown-type");
    assertRefusalProducesNoPlan(res2);
  });

  it("refuses an empty plan and mixed run identities", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();
    const fsAdapter = cleanFsAdapter();
    const baseOptions = {
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: fullPlanActions(),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    };

    // Empty plan.
    const empty = mod.validateReplayPlan({ ...baseOptions, actions: [] });
    findError(empty, "incomplete-plan");
    assertRefusalProducesNoPlan(empty);

    // Admitted run differs from the record run -> identity-mismatch.
    const mismatch = mod.validateReplayPlan({ ...baseOptions, admittedRunId: OTHER_RUN });
    const im = findError(mismatch, "identity-mismatch");
    assert.match(im.message, new RegExp(OTHER_RUN));
    assert.match(im.message, new RegExp(RUN));
    assertRefusalProducesNoPlan(mismatch);

    // Action binds a different run -> mixed-run.
    const mixed = mod.validateReplayPlan({
      ...baseOptions,
      actions: fullPlanActions().map((a, i) => (i === 0 ? { ...a, runId: OTHER_RUN } : a)),
    });
    const mr = findError(mixed, "mixed-run");
    assert.match(mr.message, new RegExp(OTHER_RUN));
    assertRefusalProducesNoPlan(mixed);
  });

  it("refuses missing attribution (runId, operationId, outputRef) and unattributed outcomes", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();
    const fsAdapter = cleanFsAdapter();
    const baseOptions = {
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    };
    const actions = fullPlanActions();

    // Missing action.runId.
    const noRun = mod.validateReplayPlan({
      ...baseOptions,
      actions: actions.map((a, i) => (i === 0 ? { ...a, runId: undefined } : a)),
    });
    findError(noRun, "missing-attribution");
    assertRefusalProducesNoPlan(noRun);

    // Missing action.operationId.
    const noOp = mod.validateReplayPlan({
      ...baseOptions,
      actions: actions.map((a, i) => (i === 0 ? { ...a, operationId: undefined } : a)),
    });
    findError(noOp, "missing-attribution");
    assertRefusalProducesNoPlan(noOp);

    // outputRef pointing at an absent observation.
    const badRef = mod.validateReplayPlan({
      ...baseOptions,
      actions: actions.map((a, i) => (i === 0 ? { ...a, outputRefs: ["obs-absent"] } : a)),
    });
    findError(badRef, "missing-attribution");
    assertRefusalProducesNoPlan(badRef);

    // Unattributed expected outcome (no operationRef) is a FORMAT-legal but
    // executor-refused outcome claim.
    const noOpRefRecord = await buildRecordImpl({
      ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
      outcomes: [{ id: "oc-orphan", outcome: { description: "no operation binding" }, sourceRef: "L1", evidenceRefs: ["obs-done"] }],
    });
    const orphanOutcome = mod.validateReplayPlan({
      record: noOpRefRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [{
        id: "a-claim",
        type: "replay.claim_complete",
        runId: RUN,
        operationId: "op-claim",
        agentId: AGENT_DOER,
        roundIndex: 0,
        outputRefs: ["obs-done"],
        verdict: "verified",
      }],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    findError(orphanOutcome, "unattributed-outcome");
    assertRefusalProducesNoPlan(orphanOutcome);

    // claim_complete with no preserved output: the executor refuses to
    // invent bytes.
    const noOutput = mod.validateReplayPlan({
      ...baseOptions,
      actions: actions.map((a, i) => (i === 0 ? { ...a, outputRefs: [] } : a)),
    });
    findError(noOutput, "missing-preserved-output");
    assertRefusalProducesNoPlan(noOutput);
  });

  it("refuses absolute and traversing fixture paths before any action", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();
    const fsAdapter = cleanFsAdapter();
    const actions = fullPlanActions();
    const badPaths = [
      "/etc/passwd", // absolute
      "//etc/passwd", // absolute (double slash)
      "C:\\windows\\evil", // drive-prefixed
      "\\server\\share", // windows-rooted
      "a/../../b", // upward traversal
      "../escape",
      "fixtures/..\\escape", // backslash traversal
      "fixtures/x\u0000y", // NUL byte
    ];
    for (const fixturePath of badPaths) {
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: actions.map((a, i) => (i === 0 ? { ...a, fixturePath } : a)),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "path-escape");
      assert.equal(e.path, "$.actions[0].fixturePath");
      assertRefusalProducesNoPlan(res);
    }
  });

  it("refuses symlinked root/ancestor substitution and fixture-candidate symlink escapes", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();

    // Ancestor-substitution race: the root's realpath lands OUTSIDE its
    // owned base (an ancestor symlink redirected it).
    {
      const fsAdapter = cleanFsAdapter();
      fsAdapter.override(FIXTURE_ROOT, "/var/elsewhere/stolen-root");
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "root-substitution");
      assert.match(e.message, /NOT inside its owned base/);
      assert.match(e.message, /stolen-root/);
      assertRefusalProducesNoPlan(res);
    }

    // Root is fine but a fixture candidate inside the root is a symlink that
    // escapes the root (resolves outside).
    {
      const fsAdapter = cleanFsAdapter();
      fsAdapter.override(`${FIXTURE_ROOT}/${FIXTURE_REL}`, "/etc/hostile-target");
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "containment-escape");
      assert.match(e.message, /hostile-target/);
      assertRefusalProducesNoPlan(res);
    }

    // An unresolvable root (vanished between admission and validation) is
    // refused, not silently skipped.
    {
      const fsAdapter = cleanFsAdapter();
      fsAdapter.overrideError(FIXTURE_ROOT, "ENOENT: vanished before validation");
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      findError(res, "root-unresolvable");
      assertRefusalProducesNoPlan(res);
    }
  });

  it("refuses cleanup-phase identity loss before any removal", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord();

    // Wrong cleanup run.
    {
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      const cleanup = mod.validateCleanupPhase({
        plan: res.plan,
        cleanup: { runId: OTHER_RUN, rootId: "fixtures", paths: [FIXTURE_REL] },
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(cleanup, "identity-loss");
      assert.match(e.message, /another run/);
      assert.equal(cleanup.removals, undefined);
    }

    // Wrong cleanup root.
    {
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      const cleanup = mod.validateCleanupPhase({
        plan: res.plan,
        cleanup: { runId: RUN, rootId: "someone-elses-root", paths: [FIXTURE_REL] },
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      findError(cleanup, "identity-loss");
      assert.equal(cleanup.removals, undefined);
    }

    // Missing run identity entirely.
    {
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const cleanup = mod.validateCleanupPhase({
        plan: res.plan,
        cleanup: { rootId: "fixtures", paths: [FIXTURE_REL] },
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(cleanup, "identity-loss");
      assert.match(e.message, /lost the admitted-run identity/);
      assert.equal(cleanup.removals, undefined);
    }

    // Root identity changed BETWEEN the plan phase and the cleanup phase
    // (symlink substitution or path reuse): re-resolution differs from the
    // admission-time realpath, so cleanup refuses before any removal.
    {
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      const resolutionsBefore = fsAdapter.journal.filter((p) => p === FIXTURE_ROOT).length;
      // A hostile actor swaps the root path to a symlink pointing elsewhere.
      fsAdapter.override(FIXTURE_ROOT, "/var/elsewhere/reused-root");
      const cleanup = mod.validateCleanupPhase({
        plan: res.plan,
        cleanup: { runId: RUN, rootId: "fixtures", paths: [FIXTURE_REL] },
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(cleanup, "identity-loss-between-phases");
      assert.match(e.message, /reused-root/);
      assert.match(e.message, /changed between phases/);
      assert.equal(cleanup.removals, undefined);
      const resolutionsAfter = fsAdapter.journal.filter((p) => p === FIXTURE_ROOT).length;
      assert.ok(
        resolutionsAfter > resolutionsBefore,
        "cleanup must re-resolve the current root identity through the adapter",
      );
    }
  });

  it("refuses corrupt payload/source and verified claims over declared UNKNOWN evidence", async () => {
    const mod = await loadAdapter();

    // Corrupt payload hash -> record-level refusal.
    {
      const record = clone(await buildFullRecord());
      const original = record.payloadSha256;
      const flipped = original.startsWith("0") ? `f${original.slice(1)}` : `0${original.slice(1)}`;
      record.payloadSha256 = flipped;
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "record:corrupt-hash");
      assert.match(e.message, /payloadSha256 mismatch/);
      assertRefusalProducesNoPlan(res);
    }

    // An op whose evidence observation is absent is an incomplete claim the
    // FORMAT rejects -> the adapter carries it as record:incomplete-claim.
    {
      const record = await buildRecordImpl({
        ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-ghost"] }],
        observations: [],
        outcomes: [],
      });
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [{
          id: "a-claim",
          type: "replay.claim_complete",
          runId: RUN,
          operationId: "op-claim",
          agentId: AGENT_DOER,
          roundIndex: 0,
          outputRefs: [],
          verdict: "verified",
        }],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      findError(res, "record:incomplete-claim");
      assertRefusalProducesNoPlan(res);
    }

    // Verified claim over a GLOBAL unknown gap is refused (never convert
    // UNKNOWN evidence into success).
    {
      const record = await buildRecordImpl({
        ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
        observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
        outcomes: [{ id: "oc-claim", outcome: { description: "done" }, sourceRef: "L1", operationRef: "op-claim", evidenceRefs: ["obs-done"] }],
        unknown: [{ fact: "the single raw stdout byte of the round is not retained", reason: "missing" }],
      });
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [{
          id: "a-claim",
          type: "replay.claim_complete",
          runId: RUN,
          operationId: "op-claim",
          agentId: AGENT_DOER,
          roundIndex: 0,
          outputRefs: ["obs-done"],
          verdict: "verified",
        }],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "unknown-evidence-verified");
      assert.match(e.message, /never converts UNKNOWN evidence into success/);
      assertRefusalProducesNoPlan(res);
    }

    // Operation-scoped gap: blocks only the actions replaying that op.
    {
      const record = await buildRecordImpl({
        ops: [
          { id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
          { id: "op-other", type: "replay.claim_complete", evidenceRefs: ["obs-other"] },
        ],
        observations: [
          { id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" },
          { id: "obs-other", fact: { kind: "public-output", text: "STATUS: done\nKEY: other" }, sourceRef: "L1" },
        ],
        outcomes: [],
        unknown: [{ fact: "bytes for op-claim are unknown", reason: "missing", affectedOperationIds: ["op-claim"] }],
      });
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [
          {
            id: "a-claim",
            type: "replay.claim_complete",
            runId: RUN,
            operationId: "op-claim",
            agentId: AGENT_DOER,
            roundIndex: 0,
            outputRefs: ["obs-done"],
            verdict: "verified",
          },
          {
            id: "a-other",
            type: "replay.claim_complete",
            runId: RUN,
            operationId: "op-other",
            agentId: AGENT_DOER,
            roundIndex: 1,
            outputRefs: ["obs-other"],
            verdict: "verified",
          },
        ],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      findError(res, "unknown-evidence-verified");
      const scoped = (res.errors ?? []).filter((x: any) => x.code === "unknown-evidence-verified");
      assert.equal(scoped.length, 1, `only op-claim should be blocked by the scoped gap: ${JSON.stringify(res.errors)}`);
      assert.equal(scoped[0].path, "$.actions[0].verdict");
      assertRefusalProducesNoPlan(res);
    }

    // The honest fix: re-declare the gapped action as a declared synthetic
    // adaptation (explicit adaptationNote), never as verified success.
    {
      const record = await buildRecordImpl({
        ops: [
          { id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
          { id: "op-other", type: "replay.claim_complete", evidenceRefs: ["obs-other"] },
        ],
        observations: [
          { id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" },
          { id: "obs-other", fact: { kind: "public-output", text: "STATUS: done\nKEY: other" }, sourceRef: "L1" },
        ],
        outcomes: [],
        unknown: [{ fact: "bytes for op-claim are unknown", reason: "missing", affectedOperationIds: ["op-claim"] }],
      });
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [
          {
            id: "a-claim",
            type: "replay.claim_complete",
            runId: RUN,
            operationId: "op-claim",
            agentId: AGENT_DOER,
            roundIndex: 0,
            outputRefs: ["obs-done"],
            verdict: "synthetic-adaptation",
            adaptationNote: "declared synthetic stand-in for the unretained stdout byte (BRUN-shaped gap)",
          },
          {
            id: "a-other",
            type: "replay.claim_complete",
            runId: RUN,
            operationId: "op-other",
            agentId: AGENT_DOER,
            roundIndex: 1,
            outputRefs: ["obs-other"],
            verdict: "verified",
          },
        ],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      const plan = res.plan;
      assert.equal(plan.unknownGaps.length, 1);
      assert.equal(plan.unknownGaps[0].scope, "scoped");
      const claim = plan.actions.find((a: any) => a.id === "a-claim");
      assert.equal(claim.verdict, "synthetic-adaptation");
      assert.match(claim.adaptationNote, /declared synthetic stand-in/);
      const other = plan.actions.find((a: any) => a.id === "a-other");
      assert.equal(other.verdict, "verified");
      assert.equal(plan.execution.executed, false);
    }

    // A synthetic-adaptation claim without an explicit note is refused.
    {
      const record = await buildRecordImpl({
        ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
        observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
        outcomes: [],
        unknown: [{ fact: "bytes unknown", reason: "missing", affectedOperationIds: ["op-claim"] }],
      });
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [{
          id: "a-claim",
          type: "replay.claim_complete",
          runId: RUN,
          operationId: "op-claim",
          agentId: AGENT_DOER,
          roundIndex: 0,
          outputRefs: ["obs-done"],
          verdict: "synthetic-adaptation",
        }],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      findError(res, "plan-shape");
      assertRefusalProducesNoPlan(res);
    }
  });

  it("refuses records with a foreign run claim and operation/action type mismatches", async () => {
    const mod = await loadAdapter();
    // Record-level mixed-run (locator declares another run) is refused via
    // the format pass; the adapter surfaces it as record:mixed-run.
    const mixedRecord = await buildRecordImpl({
      ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
      outcomes: [{ id: "oc-claim", outcome: { description: "done" }, sourceRef: "L1", operationRef: "op-claim", evidenceRefs: ["obs-done"] }],
    });
    // Patch a locator to a foreign run (cloned, so the frozen record can be
    // tampered for the negative case).
    const tampered = clone(mixedRecord);
    tampered.sourceIdentity.sourceRefs[1].runId = OTHER_RUN;
    const fsAdapter = cleanFsAdapter();
    const res = mod.validateReplayPlan({
      record: tampered,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [{
        id: "a-claim",
        type: "replay.claim_complete",
        runId: RUN,
        operationId: "op-claim",
        agentId: AGENT_DOER,
        roundIndex: 0,
        outputRefs: ["obs-done"],
        verdict: "verified",
      }],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    const e = findError(res, "record:mixed-run");
    assert.match(e.message, new RegExp(OTHER_RUN));
    assertRefusalProducesNoPlan(res);

    // Action type not equal to its reviewed record operation type.
    const okRecord = await buildRecordImpl({
      ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
      outcomes: [],
    });
    const fs2 = cleanFsAdapter();
    const res2 = mod.validateReplayPlan({
      record: okRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [{
        id: "a-claim",
        type: "replay.idle_dispatch",
        runId: RUN,
        operationId: "op-claim",
        agentId: AGENT_DOER,
        roundIndex: 0,
      }],
      realpath: fs2.realpath.bind(fs2),
      objectIdentity: fs2.identity.bind(fs2),
    });
    findError(res2, "operation-type-mismatch");
    assertRefusalProducesNoPlan(res2);
  });

  it("refuses duplicate coverage: every replay-namespaced record operation maps to EXACTLY ONE action", async () => {
    const mod = await loadAdapter();
    // One replay operation reviewed once; two DISTINCT actions (different
    // ids and roundIndex) both replay it. Each action alone is legitimate —
    // the refusal is the duplicate coverage, which a later executor would
    // otherwise double-execute as two real motor rounds for one reviewed op.
    const record = await buildRecordImpl({
      ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
      outcomes: [{ id: "oc-claim", outcome: { description: "done" }, sourceRef: "L1", operationRef: "op-claim", evidenceRefs: ["obs-done"] }],
    });
    const fsAdapter = cleanFsAdapter();
    const res = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [
        {
          id: "a1",
          type: "replay.claim_complete",
          runId: RUN,
          operationId: "op-claim",
          agentId: AGENT_DOER,
          roundIndex: 0,
          outputRefs: ["obs-done"],
          verdict: "verified",
        },
        {
          id: "a2",
          type: "replay.claim_complete",
          runId: RUN,
          operationId: "op-claim",
          agentId: AGENT_DOER,
          roundIndex: 1,
          outputRefs: ["obs-done"],
          verdict: "verified",
        },
      ],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    const e = findError(res, "duplicate-coverage");
    assert.equal(e.path, "$.actions[1].operationId");
    assert.match(e.message, /EXACTLY ONE action/);
    assertRefusalProducesNoPlan(res);
  });

  it("validates replay.unclaimed_exit exitCode at plan time (integer 0..255, single materialized surface)", async () => {
    const mod = await loadAdapter();
    const record = await buildRecordImpl({
      ops: [{ id: "op-exit", type: "replay.unclaimed_exit" }],
      observations: [],
      outcomes: [{ id: "oc-exit", outcome: { description: "round exits unclaimed" }, sourceRef: "L1", operationRef: "op-exit" }],
    });
    const fsAdapter = cleanFsAdapter();
    const actionBase = {
      id: "a-exit",
      type: "replay.unclaimed_exit",
      runId: RUN,
      operationId: "op-exit",
      agentId: AGENT_DOER,
      roundIndex: 0,
    };
    const validate = (patch: any) =>
      mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [{ ...actionBase, ...patch }],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });

    // Fractional, negative and out-of-range values are refused at plan time
    // (previously accepted by validation, then silently dropped by the seed
    // while the recorded entrypoint descriptor preserved them).
    for (const bad of [0.5, -1, 255.5, 256]) {
      const res = validate({ exitCode: bad });
      const e = findError(res, "invalid-exit-code");
      assert.equal(e.path, "$.actions[0].exitCode");
      assertRefusalProducesNoPlan(res);
    }

    // Absent exitCode stays legitimate (the frozen runtime's die-before-claim
    // default exit is 3).
    const absent = validate({});
    assert.equal(absent.ok, true, JSON.stringify(absent.errors));
    const absentSeed = mod.materializeRuntimeSeed(absent.plan);
    assert.deepEqual(absentSeed.behaviorsConfig.agents[AGENT_DOER][0], { mode: "die-before-claim" });

    // An in-range integer validates and surfaces IDENTICALLY on both
    // materialized surfaces: the recorded entrypoint descriptor and the
    // canned-behavior seed consumed by the frozen runtime.
    const ok = validate({ exitCode: 3 });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    const exitAction = ok.plan.actions[0];
    assert.equal(exitAction.exitCode, 3);
    assert.equal(exitAction.entrypoints[0].exitCode, 3);
    assert.equal(exitAction.entrypoints[0].behaviorMode, "die-before-claim");
    const seed = mod.materializeRuntimeSeed(ok.plan);
    assert.deepEqual(seed.behaviorsConfig.agents[AGENT_DOER][0], { mode: "die-before-claim", exitCode: 3 });

    // exitCode on a non-unclaimed_exit action is meaningless (those actions
    // complete/fail via the step CLI, never by exiting) and refused.
    const fullRecord = await buildFullRecord();
    const wrongType = mod.validateReplayPlan({
      record: fullRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: fullPlanActions().map((a, i) => (i === 0 ? { ...a, exitCode: 5 } : a)),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    const wt = findError(wrongType, "invalid-exit-code");
    assert.equal(wt.path, "$.actions[0].exitCode");
    assert.match(wt.message, /only meaningful for replay\.unclaimed_exit/);
    assertRefusalProducesNoPlan(wrongType);
  });

  it("documents and pins the unknown-gap asymmetry (only verified success claims are gap-blocked)", async () => {
    const mod = await loadAdapter();
    const source = fs.readFileSync(ADAPTER_PATH, "utf8");
    // The module header states the rationale explicitly: gap-blocking is
    // verified-success-only; failure-shape replays replay gapped evidence
    // without a synthetic-adaptation declaration because they assert no
    // success (a later BRUN-shaped story inherits this documented rule).
    assert.match(source, /unknown-gap policy is deliberately ASYMMETRIC/);
    assert.match(source, /Failure-shape replays/);
    assert.match(source, /assert NO verified success/);

    // Contrast, pinned: the SAME declared global gap refuses a "verified"
    // replay.claim_complete (never convert UNKNOWN evidence into success)...
    const claimRecord = await buildRecordImpl({
      ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
      outcomes: [],
      unknown: [{ fact: "the single raw stdout byte of the round is not retained", reason: "missing" }],
    });
    const fsAdapter = cleanFsAdapter();
    const claimRes = mod.validateReplayPlan({
      record: claimRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [{
        id: "a-claim",
        type: "replay.claim_complete",
        runId: RUN,
        operationId: "op-claim",
        agentId: AGENT_DOER,
        roundIndex: 0,
        outputRefs: ["obs-done"],
        verdict: "verified",
      }],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    findError(claimRes, "unknown-evidence-verified");
    assertRefusalProducesNoPlan(claimRes);

    // ...while a failure-shape replay (replay.claim_fail) under the SAME
    // global gap validates with no verdict/adaptationNote — it asserts a
    // refusal, not a verified success.
    const failRecord = await buildRecordImpl({
      ops: [{ id: "op-fail", type: "replay.claim_fail", evidenceRefs: ["obs-fail"] }],
      observations: [{ id: "obs-fail", fact: { kind: "public-output", text: "MISSING_CREDENTIAL synthetic refusal reason" }, sourceRef: "L1" }],
      outcomes: [],
      unknown: [{ fact: "the single raw stdout byte of the round is not retained", reason: "missing" }],
    });
    const failRes = mod.validateReplayPlan({
      record: failRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [{
        id: "a-fail",
        type: "replay.claim_fail",
        runId: RUN,
        operationId: "op-fail",
        agentId: AGENT_DOER,
        roundIndex: 0,
        outputRefs: ["obs-fail"],
      }],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    assert.equal(failRes.ok, true, JSON.stringify(failRes.errors));
    assert.equal(failRes.plan.actions[0].verdict, undefined);
    assert.equal(failRes.plan.actions[0].adaptationNote, undefined);

    // And a die-before-claim replay (replay.unclaimed_exit) under the same
    // global gap validates as well.
    const exitRecord = await buildRecordImpl({
      ops: [{ id: "op-exit", type: "replay.unclaimed_exit" }],
      observations: [],
      outcomes: [],
      unknown: [{ fact: "the single raw stdout byte of the round is not retained", reason: "missing" }],
    });
    const exitRes = mod.validateReplayPlan({
      record: exitRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [{
        id: "a-exit",
        type: "replay.unclaimed_exit",
        runId: RUN,
        operationId: "op-exit",
        agentId: AGENT_DOER,
        roundIndex: 0,
        exitCode: 1,
      }],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    assert.equal(exitRes.ok, true, JSON.stringify(exitRes.errors));
    assert.equal(exitRes.plan.actions[0].verdict, undefined);
  });

  it("exposes the adapter module header notes and helper contract (safety vocabulary)", async () => {
    const mod = await loadAdapter();
    const source = fs.readFileSync(ADAPTER_PATH, "utf8");
    // The module documents the FORMAT-vs-EXECUTOR authority boundary.
    assert.match(source, /Capture\/import is DATA, not executable authority/);
    // Duplicate-round / duplicate-id plan misuse is refused.
    const fsAdapter = cleanFsAdapter();
    const record = await buildFullRecord();
    const dup = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: fullPlanActions().map((a, i) => (i === 3 ? { ...a, id: "a-claim" } : a)),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    findError(dup, "plan-shape");
    assertRefusalProducesNoPlan(dup);

    // Duplicate roundIndex for the same agent is refused.
    const dupRound = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: fullPlanActions().map((a, i) => (i === 1 ? { ...a, roundIndex: 0 } : a)),
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    findError(dupRound, "plan-shape");
    assertRefusalProducesNoPlan(dupRound);

    // checkOwnedRelativePath helper refuses absolute/traversal/NUL/backslash.
    assert.equal(mod.checkOwnedRelativePath("ok/relative/path.json").ok, true);
    for (const bad of ["/abs", "a/../b", "a\\..\\b", "a\u0000b", "../up", "C:\\x"]) {
      assert.equal(mod.checkOwnedRelativePath(bad).ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    }
    // isResolvedPathInside helper semantics.
    assert.equal(mod.isResolvedPathInside("/a/b/c", "/a/b"), true);
    assert.equal(mod.isResolvedPathInside("/a/b", "/a/b"), true);
    assert.equal(mod.isResolvedPathInside("/a/bee", "/a/b"), false); // prefix component boundary
    assert.equal(mod.isResolvedPathInside("/a", "/a/b"), false);
    // observationToText escapes only string facts / {text} facts.
    assert.equal(mod.observationToText({ id: "x", fact: "raw text" }), "raw text");
    assert.equal(mod.observationToText({ id: "x", fact: { text: "obj text" } }), "obj text");
    assert.equal(mod.observationToText({ id: "x", fact: { exitCode: 3 } }), null);
  });

  it("refuses sparse per-agent work-invocation indices — no invented STATUS: done successes; idle observations never justify a gap", async () => {
    const mod = await loadAdapter();
    const record = await buildRecordImpl({
      ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done\nCHANGES: synthetic" }, sourceRef: "L1" }],
      outcomes: [],
    });
    const fsAdapter = cleanFsAdapter();
    const claimAt = (roundIndex: number, extra: any = {}) => ({
      id: "a-claim",
      type: "replay.claim_complete",
      runId: RUN,
      operationId: "op-claim",
      agentId: AGENT_DOER,
      roundIndex,
      outputRefs: ["obs-done"],
      verdict: "verified",
      ...extra,
    });

    // ROOT-OBSERVED COUNTEREXAMPLE 1: a SOLE reviewed claim_complete at
    // roundIndex 2 must NOT validate — materializeRuntimeSeed would otherwise
    // invent two unrecorded "STATUS: done" successes for indices 0/1.
    const sparse = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [claimAt(2)],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    const e = findError(sparse, "noncontiguous-round-indices");
    assert.match(e.message, /contiguous from 0/);
    assert.match(e.message, /never occupy or justify a work-invocation index/);
    assertRefusalProducesNoPlan(sparse);

    // A gap BETWEEN two work invocations (claim at 0, exit at 2) is refused.
    const gapRecord = await buildRecordImpl({
      ops: [
        { id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
        { id: "op-exit", type: "replay.unclaimed_exit" },
      ],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
      outcomes: [],
    });
    const gap = mod.validateReplayPlan({
      record: gapRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [
        claimAt(0, { id: "a1" }),
        { id: "a2", type: "replay.unclaimed_exit", runId: RUN, operationId: "op-exit", agentId: AGENT_DOER, roundIndex: 2 },
      ],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    findError(gap, "noncontiguous-round-indices");
    assertRefusalProducesNoPlan(gap);

    // idle_dispatch is NOT a harness invocation: an idle observation at index
    // 0 on the SAME agent does NOT make a claim at index 2 legitimate (the
    // claim would still be a sparse second work invocation with a missing
    // first).
    const idleRecord = await buildRecordImpl({
      ops: [
        { id: "op-idle", type: "replay.idle_dispatch" },
        { id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] },
      ],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done\nCHANGES: synthetic" }, sourceRef: "L1" }],
      outcomes: [],
    });
    const idleJustifies = mod.validateReplayPlan({
      record: idleRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [
        { id: "a-idle", type: "replay.idle_dispatch", runId: RUN, operationId: "op-idle", agentId: AGENT_DOER, roundIndex: 0 },
        claimAt(2, { id: "a-claim" }),
      ],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    findError(idleJustifies, "noncontiguous-round-indices");
    assertRefusalProducesNoPlan(idleJustifies);

    // Defense in depth: materializeRuntimeSeed THROWS on a hand-built sparse
    // plan instead of fabricating "STATUS: done" fillers for missing indices.
    const sparsePlan = {
      adapterVersion: mod.REPLAY_ADAPTER_VERSION,
      runtime: "pi",
      actions: [{
        id: "a-claim",
        type: "replay.claim_complete",
        runId: RUN,
        operationId: "op-claim",
        agentId: AGENT_DOER,
        roundIndex: 2,
        preservedOutputTexts: [{ observationId: "obs-done", text: "STATUS: done" }],
      }],
    };
    assert.throws(
      () => mod.materializeRuntimeSeed(sparsePlan),
      /refuses to invent an unrecorded work round/,
    );

    // Idle and work live in DIFFERENT index spaces: [idle@0, claim@0] on the
    // SAME agent is LEGITIMATE — the idle tick spawns nothing, so the claim
    // is still the agent's FIRST work invocation (index 0), and the seed has
    // exactly ONE entry with no fabricated filler.
    const idleOk = mod.validateReplayPlan({
      record: idleRecord,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [
        { id: "a-idle", type: "replay.idle_dispatch", runId: RUN, operationId: "op-idle", agentId: AGENT_DOER, roundIndex: 0 },
        claimAt(0, { id: "a-claim" }),
      ],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    assert.equal(idleOk.ok, true, JSON.stringify(idleOk.errors));
    const idleSeed = mod.materializeRuntimeSeed(idleOk.plan);
    assert.equal(idleSeed.behaviorsConfig.agents[AGENT_DOER].length, 1);
    assert.equal(idleSeed.behaviorsConfig.agents[AGENT_DOER][0].mode, "work");
    assert.equal(
      idleSeed.behaviorsConfig.agents[AGENT_DOER][0].output,
      "STATUS: done\nCHANGES: synthetic",
    );

    // Positive control: a single contiguous claim at index 0 seeds exactly one
    // entry (contiguous pi/Hermes mapping preserved).
    const singleOk = mod.validateReplayPlan({
      record,
      runtime: "pi",
      admittedRunId: RUN,
      ownedRoot: fixtureOwnedRoot(),
      actions: [claimAt(0)],
      realpath: fsAdapter.realpath.bind(fsAdapter),
      objectIdentity: fsAdapter.identity.bind(fsAdapter),
    });
    assert.equal(singleOk.ok, true, JSON.stringify(singleOk.errors));
    assert.equal(mod.materializeRuntimeSeed(singleOk.plan).behaviorsConfig.agents[AGENT_DOER].length, 1);
  });

  it("preserves exact die-before-claim public stdout bytes on the seed AND the mapped runtime path (empty / no-final-newline verbatim)", async () => {
    const mod = await loadAdapter();
    const validateExit = async (obsText: string | null) => {
      const record = await buildRecordImpl({
        ops: [{ id: "op-exit", type: "replay.unclaimed_exit" }],
        observations:
          obsText === null ? [] : [{ id: "obs-out", fact: { kind: "public-output", text: obsText }, sourceRef: "L1" }],
        outcomes: [],
      });
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [{
          id: "a-exit",
          type: "replay.unclaimed_exit",
          runId: RUN,
          operationId: "op-exit",
          agentId: AGENT_DOER,
          roundIndex: 0,
          ...(obsText === null ? {} : { outputRefs: ["obs-out"] }),
          exitCode: 3,
        }],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      const descriptor = res.plan.actions[0].entrypoints[0];
      const seedBehavior = mod.materializeRuntimeSeed(res.plan).behaviorsConfig.agents[AGENT_DOER][0];
      return { descriptor, seedBehavior };
    };

    // Trailing newline preserved EXACTLY (nothing appended, nothing trimmed).
    {
      const { descriptor, seedBehavior } = await validateExit("synthetic preserved stdout\n");
      assert.equal(descriptor.preservedStdout, "synthetic preserved stdout\n");
      assert.equal(seedBehavior.preservedStdout, "synthetic preserved stdout\n");
      assert.equal(seedBehavior.mode, "die-before-claim");
      assert.equal(seedBehavior.exitCode, 3);
      assert.equal(descriptor.preservedStdout, seedBehavior.preservedStdout, "descriptor and seed must carry the SAME exact bytes");
    }
    // No-final-newline payload preserved WITHOUT a newline being appended.
    {
      const { descriptor, seedBehavior } = await validateExit("no trailing newline");
      assert.equal(descriptor.preservedStdout, "no trailing newline");
      assert.equal(seedBehavior.preservedStdout, "no trailing newline");
      assert.equal(seedBehavior.preservedStdout.endsWith("\n"), false);
      assert.equal(descriptor.preservedStdout, seedBehavior.preservedStdout);
    }
    // Empty payload: preservedStdout is the empty string (verbatim), not null.
    {
      const { descriptor, seedBehavior } = await validateExit("");
      assert.equal(descriptor.preservedStdout, "");
      assert.equal(seedBehavior.preservedStdout, "");
      assert.equal(typeof seedBehavior.preservedStdout, "string");
      assert.equal(descriptor.preservedStdout, seedBehavior.preservedStdout);
    }
    // No outputRefs: original zero-byte die-before-claim shape — the seed has
    // NO preservedStdout field at all.
    {
      const { descriptor, seedBehavior } = await validateExit(null);
      assert.equal(descriptor.preservedStdout, null);
      assert.equal("preservedStdout" in seedBehavior, false);
      assert.deepEqual(seedBehavior, { mode: "die-before-claim", exitCode: 3 });
    }

    // Static/recorded function-conformance of the NARROW RUNTIME KNOB (both
    // pi and hermes die-before-claim paths): the frozen runtimes are never
    // spawned here — actual frozen-runtime/motor execution is the next
    // root-reviewed gate — but the byte-exact write path is pinned from the
    // actual runtime source.
    const runtimesSource = ["runtime-pi.mjs", "runtime-hermes.mjs"].map((f) =>
      fs.readFileSync(path.join(repoRoot, "torture-test", "scripted-runtimes", f), "utf8"),
    );
    for (const src of runtimesSource) {
      const beginMarker = "KNOB-REGION-BEGIN — CORE-REPLAY die-before-claim preserved stdout";
      const endMarker = "KNOB-REGION-END — CORE-REPLAY die-before-claim preserved stdout";
      const begin = src.indexOf(beginMarker);
      const end = src.indexOf(endMarker);
      assert.ok(begin >= 0, `runtime must carry the CORE-REPLAY die-before-claim KNOB region: ${beginMarker}`);
      assert.ok(end > begin, "runtime CORE-REPLAY knob region must be closed");
      const region = src.slice(begin, end);
      assert.ok(region.includes('if (typeof behavior.preservedStdout === "string")'), "knob guards preservedStdout by type");
      // Byte-exact write must be SYNCHRONOUS: an async process.stdout.write
      // followed by process.exit can drop queued bytes on a pipe, so the knob
      // uses fs.writeSync(1, ...) (node:fs imported in both runtimes). Pinned
      // in lockstep with the runtime edit — never regress to the async form.
      assert.ok(region.includes("fs.writeSync(1, behavior.preservedStdout);"), "knob writes preserved bytes synchronously (fs.writeSync(1, ...))");
      assert.ok(!region.includes("process.stdout.write(behavior.preservedStdout)"), "preserved-stdout knob must not use the async process.stdout.write form (pipe-drop hazard on immediate exit)");
      assert.ok(src.includes('import fs from "node:fs";'), "runtime must import node:fs for the fs.writeSync knob write");
      assert.ok(!region.includes(".endsWith("), "the preserved-stdout knob must never newline-normalize: exact bytes incl. empty/no-final-newline");
      // The write precedes the exit (region is inside the die-before-claim
      // branch, before process.exit(behavior.exitCode ?? 3)).
      assert.ok(src.includes('logInvocation({ ...work, note: "exiting before claim" });'), "die-before-claim branch retained");
    }
    // KNOB-REGIONS.md documents the new region in BOTH runtimes.
    const knobDocs = fs.readFileSync(path.join(repoRoot, "torture-test", "scripted-runtimes", "KNOB-REGIONS.md"), "utf8");
    assert.ok(knobDocs.includes("CORE-REPLAY"), "KNOB-REGIONS.md must document the CORE-REPLAY knob");
    assert.ok(knobDocs.includes("runtime-pi.mjs") && knobDocs.includes("runtime-hermes.mjs"));
    // The live probe blocks remain byte-identical first-class citizens (the
    // IFLB probe dispatch is untouched by the knob region; fork-parity-check
    // keeps the whole file pinned to FROZEN_SHA outside knob regions).
    for (const src of runtimesSource) {
      assert.ok(src.includes("isHarnessProbePrompt(prompt)"), "runtime probe dispatch must be retained");
    }
  });

  it("binds owned-root admission to the trusted object identity — combined base+root substitution and same-path replacement refused; canonical alias preserved", async () => {
    const mod = await loadAdapter();
    // A single claim action WITHOUT fixturePath keeps the root checks in focus.
    const record = await buildRecordImpl({
      ops: [{ id: "op-claim", type: "replay.claim_complete", evidenceRefs: ["obs-done"] }],
      observations: [{ id: "obs-done", fact: { kind: "public-output", text: "STATUS: done" }, sourceRef: "L1" }],
      outcomes: [],
    });
    const claim = {
      id: "a-claim",
      type: "replay.claim_complete",
      runId: RUN,
      operationId: "op-claim",
      agentId: AGENT_DOER,
      roundIndex: 0,
      outputRefs: ["obs-done"],
      verdict: "verified",
    };

    // ROOT-OBSERVED COUNTEREXAMPLE 3a: BOTH ownedRoot.base and ownedRoot.path
    // resolve into a foreign tree TOGETHER (containment still nests) — the
    // old containment check alone accepted this. Now refused: the object
    // identity at the resolved foreign paths differs from the trusted
    // admission capture.
    {
      const fsAdapter = cleanFsAdapter();
      fsAdapter.override(FIXTURE_BASE, "/foreign/tree/synth-owner");
      fsAdapter.override(FIXTURE_ROOT, "/foreign/tree/synth-owner/wcr-fixture-root-7f3a");
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [claim],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "root-identity-mismatch");
      assert.match(e.message, /trusted ownership admission captured/);
      assertRefusalProducesNoPlan(res);
    }

    // ROOT-OBSERVED COUNTEREXAMPLE 3b: same-path ROOT replacement BEFORE plan
    // validation (pathname unchanged, object replaced: dev1/ino101 ->
    // dev1/ino202). Strings alone cannot see it; the object identity recheck
    // refuses admission.
    {
      const fsAdapter = cleanFsAdapter();
      fsAdapter.replaceObject(FIXTURE_ROOT, { dev: 7, ino: 202 });
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [claim],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "root-identity-mismatch");
      assert.match(e.message, /containment alone is not proof of the pre-admitted root/);
      assertRefusalProducesNoPlan(res);
    }

    // Missing trusted admission identity is refused (fail-closed: containment
    // alone never admits a root).
    {
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: { id: "fixtures", path: FIXTURE_ROOT, base: FIXTURE_BASE },
        actions: [claim],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(res, "missing-root-identity");
      assert.match(e.message, /not filesystem object identity/);
      assertRefusalProducesNoPlan(res);
    }

    // Missing objectIdentity adapter is refused (the module will not admit on
    // containment alone).
    {
      const fsAdapter = cleanFsAdapter();
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [claim],
        realpath: fsAdapter.realpath.bind(fsAdapter),
      });
      const e = findError(res, "adapter-shape");
      assert.equal(e.path, "$.objectIdentity");
      assert.match(e.message, /not filesystem object identity/);
      assertRefusalProducesNoPlan(res);
    }

    // Positive canonical-alias control (macOS /tmp semantics): the lexical
    // owned tree resolves to a canonical tree (/private/...), and identity is
    // pinned on the HOST-RESOLVED object — the plan VALIDATES and the alias is
    // preserved (no blanket lexical==realpath rule).
    {
      const fsAdapter = createRecordingFsAdapter("/private/tmp/synth-cr-owner");
      const res = mod.validateReplayPlan({
        record,
        runtime: "hermes",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: [claim],
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      assert.equal(res.plan.rootIdentity.rootReal, "/private/tmp/synth-cr-owner/wcr-fixture-root-7f3a");
      assert.equal(res.plan.rootIdentity.baseReal, "/private/tmp/synth-cr-owner");
      assert.deepEqual(res.plan.rootIdentity.identity.root, { dev: 7, ino: 101 });
      assert.deepEqual(res.plan.rootIdentity.identity.base, { dev: 7, ino: 100 });
    }
  });

  it("cleanup re-proves the held-root filesystem object identity — replaced root/ancestor/candidate and missing identity refused; legitimate cleanup preserved", async () => {
    const mod = await loadAdapter();
    const record = await buildFullRecord(); // a-claim declares fixturePath FIXTURE_REL
    const cleanupReq = { runId: RUN, rootId: "fixtures", paths: [FIXTURE_REL] };
    const planFor = (fsAdapter: RecordingFsAdapter) => {
      const res = mod.validateReplayPlan({
        record,
        runtime: "pi",
        admittedRunId: RUN,
        ownedRoot: fixtureOwnedRoot(),
        actions: fullPlanActions(),
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      assert.equal(res.ok, true, JSON.stringify(res.errors));
      return res.plan;
    };
    const cleanupFor = (fsAdapter: RecordingFsAdapter, plan: any) =>
      mod.validateCleanupPhase({
        plan,
        cleanup: cleanupReq,
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });

    // ROOT-OBSERVED COUNTEREXAMPLE 4: the same-path virtual root was replaced
    // between plan admission and cleanup (dev1/ino101 -> dev1/ino202). Every
    // pathname string is unchanged; only the object-identity recheck sees the
    // replacement, and cleanup refuses BEFORE proposing any removal.
    {
      const fsAdapter = cleanFsAdapter();
      const plan = planFor(fsAdapter);
      fsAdapter.replaceObject(FIXTURE_ROOT, { dev: 7, ino: 202 });
      const cleanup = cleanupFor(fsAdapter, plan);
      const e = findError(cleanup, "object-identity-changed");
      assert.equal(e.path, "$.cleanup.root");
      assert.match(e.message, /was replaced between plan admission and cleanup time/);
      assert.match(e.message, /check\/use race/);
      assert.equal(cleanup.removals, undefined);
      // The cleanup phase re-derived the current object identity (identity
      // journal), not just the realpath string.
      assert.ok(fsAdapter.journal.includes(`identity:${FIXTURE_ROOT}`));
    }

    // Replaced BASE/ancestor object at the same pathname is refused the same
    // way (the base pins the owned base of the pre-admitted root).
    {
      const fsAdapter = cleanFsAdapter();
      const plan = planFor(fsAdapter);
      fsAdapter.replaceObject(FIXTURE_BASE, { dev: 7, ino: 900 });
      const cleanup = cleanupFor(fsAdapter, plan);
      const e = findError(cleanup, "object-identity-changed");
      assert.equal(e.path, "$.cleanup.base");
      assert.equal(cleanup.removals, undefined);
    }

    // Replaced CANDIDATE: a cleanup path matching a plan-admitted fixture
    // whose object changed since admission is refused.
    {
      const fsAdapter = cleanFsAdapter();
      const plan = planFor(fsAdapter);
      fsAdapter.replaceObject(`${FIXTURE_ROOT}/${FIXTURE_REL}`, { dev: 7, ino: 555 });
      const cleanup = cleanupFor(fsAdapter, plan);
      const e = findError(cleanup, "cleanup-candidate-replaced");
      assert.match(e.message, /object identity changed since admission/);
      assert.equal(cleanup.removals, undefined);
    }

    // Missing identity: a plan that stored only pathname strings (no trusted
    // object identity) can never re-prove ownership and is refused.
    {
      const fsAdapter = cleanFsAdapter();
      const forged = {
        adapterVersion: mod.REPLAY_ADAPTER_VERSION,
        rootIdentity: {
          rootId: "fixtures",
          admittedRunId: RUN,
          rootReal: FIXTURE_ROOT,
          baseReal: FIXTURE_BASE,
          // NOTE: no identity — strings/runId/rootId are not object identity.
        },
      };
      const cleanup = mod.validateCleanupPhase({
        plan: forged,
        cleanup: cleanupReq,
        realpath: fsAdapter.realpath.bind(fsAdapter),
        objectIdentity: fsAdapter.identity.bind(fsAdapter),
      });
      const e = findError(cleanup, "identity-loss");
      assert.match(e.message, /strings, runId and rootId alone are not filesystem object identity/);
      assert.equal(cleanup.removals, undefined);
    }

    // Missing objectIdentity adapter at cleanup time is refused.
    {
      const fsAdapter = cleanFsAdapter();
      const plan = planFor(fsAdapter);
      const cleanup = mod.validateCleanupPhase({
        plan,
        cleanup: cleanupReq,
        realpath: fsAdapter.realpath.bind(fsAdapter),
      });
      const e = findError(cleanup, "adapter-shape");
      assert.equal(e.path, "$.objectIdentity");
      assert.equal(cleanup.removals, undefined);
    }

    // Positive legitimate cleanup descriptor preserved: identity re-proven,
    // removal carries the candidate's current + admission identities, and the
    // held-root authority is exposed for the executor.
    {
      const fsAdapter = cleanFsAdapter();
      const plan = planFor(fsAdapter);
      const cleanup = cleanupFor(fsAdapter, plan);
      assert.equal(cleanup.ok, true, JSON.stringify(cleanup.errors));
      assert.equal(cleanup.removals.length, 1);
      const removal = cleanup.removals[0];
      assert.equal(removal.runId, RUN);
      assert.equal(removal.rootId, "fixtures");
      assert.equal(removal.relativePath, FIXTURE_REL);
      assert.equal(removal.realPath, `${FIXTURE_ROOT}/${FIXTURE_REL}`);
      assert.equal(removal.executorRecheckRequired, true);
      assert.equal(removal.executed, false);
      assert.ok(removal.identity && typeof removal.identity === "object", "removal must carry the candidate object identity");
      assert.ok(removal.admissionIdentity, "removal must carry the plan-admitted fixture identity");
      assert.deepEqual(removal.identity, removal.admissionIdentity);
      assert.equal(cleanup.cleanup.identityRevalidated, true);
      assert.equal(cleanup.cleanup.executed, false);
      assert.deepEqual(cleanup.cleanup.heldRootAuthority.rootIdentity, { dev: 7, ino: 101 });
      assert.deepEqual(cleanup.cleanup.heldRootAuthority.baseIdentity, { dev: 7, ino: 100 });
      // The cleanup phase re-derived BOTH the realpath AND the object identity
      // of the root at cleanup time.
      const rootResolutions = fsAdapter.journal.filter((j) => j === FIXTURE_ROOT);
      assert.ok(rootResolutions.length >= 2, `expected root realpath re-resolution, got ${JSON.stringify(fsAdapter.journal)}`);
      assert.ok(fsAdapter.journal.includes(`identity:${FIXTURE_ROOT}`), "cleanup must re-prove the root object identity");
    }
  });
});
