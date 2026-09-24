// core-recording-replay-adapter.mjs — CORE US-003 safe deterministic replay
// adapter (safety/adapter slice; pure ESM, zero product coupling).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.2 (authorized torture-only CORE
// slice "CORE-REPLAY"). This module implements the SAFETY/ADAPTER portion of
// US-003 only. It consumes the existing validated immutable recording
// contract (./core-recording-contract.mjs — the US-001 format module),
// validates a COMPLETE replay plan BEFORE any side effect, and maps reviewed
// typed fixture actions / preserved public outputs onto the EXISTING frozen
// scripted runtimes and the real step-protocol/motor tooling as an exact
// recorded-call contract. It does NOT execute anything: no child/daemon/
// port/process/removal/daemon signal is ever issued by this module, and the
// real isolated-motor zero-token replay run is explicitly NOT YET EXECUTED
// (the coordinator must independently accept the committed recording proof
// before any later execution story may run it).
//
// ── Scope / honesty contract ─────────────────────────────────────────
//   * Capture/import is DATA, not executable authority. A record that the
//     US-001 FORMAT accepts is still only evidence: the EXECUTOR here keeps
//     its own small closed action vocabulary (EXECUTOR_ACTION_TYPES) and
//     REFUSES anything outside it — including type-shaped strings that the
//     record format would happily accept (the format checks the *shape* of
//     typed op codes; this adapter checks whether the executor will *run*
//     them).
//   * No generalized shell evaluator, no arbitrary historical command
//     replay, no manual database lifecycle transitions, and no alternative
//     state machine. The adapter only validates plans and materializes the
//     exact real entrypoints (step-CLI argv shapes per
//     scripted-runtimes/runtime-shared.mjs, the launch-time harness probe
//     contract, canned-behavior seeds for the frozen runtimes) that a LATER,
//     coordinator-approved, isolated-motor run would issue. Every
//     materialized call carries executed:false.
//   * Bind every action/result to the admitted run and to owned fixture
//     roots; refuse before writes/signals: unknown operations, mixed
//     identities, escaping paths, symlinked root/ancestor substitutions,
//     and unattributed/incomplete outcomes.
//   * Never invent missing raw bytes and never convert UNKNOWN historical
//     evidence into success: an expected "verified" outcome whose evidence
//     an unknown entry marks as gapped is refused unless the action is an
//     explicitly declared synthetic adaptation.
//   * The unknown-gap policy is deliberately ASYMMETRIC and blocks only
//     verified-success assertions. A declared unknown gap (global or
//     operation-scoped) refuses a "verified" replay.claim_complete — the
//     ONLY action type that asserts a reviewed success carried by preserved
//     public output bytes. Failure-shape replays (replay.claim_fail and
//     replay.unclaimed_exit) assert NO verified success — a fail
//     reproduces a refusal and an unclaimed exit reproduces a
//     die-before-claim round — so they validate under a declared gap
//     WITHOUT a synthetic-adaptation declaration. The BRUN-shaped US-005
//     story replays failure evidence whose raw bytes are unknown; it
//     inherits this documented rule and must not treat a gapped fail as a
//     verified success either.
//   * Work-invocation index semantics (v3): roundIndex is the per-agent
//     WORK-INVOCATION index — every harness spawn consumes exactly one.
//     replay.idle_dispatch is NOT a harness invocation (an idle dispatch
//     tick peeks NO_WORK and spawns nothing), so it never occupies or
//     justifies a work-invocation index. For each agent the work-invoking
//     actions (claim_complete / claim_fail / unclaimed_exit) must carry
//     EXACTLY CONTIGUOUS indices 0..n-1: a sparse plan (e.g. a single
//     claim_complete at roundIndex 2) would otherwise make the runtime seed
//     fabricate unrecorded "STATUS: done" successes for the missing
//     indices. Sparse work-invocation indices are REFUSED at plan time
//     (noncontiguous-round-indices); the seed never fills a gap.
//   * Die-before-claim preserved public stdout (v3): replay.unclaimed_exit
//     may carry outputRefs whose text is the exact public stdout bytes of
//     the reviewed die-before-claim round. Those bytes (including an empty
//     payload or a payload with no final newline) are preserved VERBATIM on
//     the canned-behavior seed (behavior.preservedStdout) AND reproduced by
//     the mapped runtime path: a small documented torture-fork knob in the
//     pi and hermes die-before-claim branches writes
//     fs.writeSync(1, behavior.preservedStdout) before exiting
//     (KNOB-REGION "CORE-REPLAY die-before-claim preserved stdout"; see
//     torture-test/scripted-runtimes/KNOB-REGIONS.md). Never just metadata:
//     the exact specified public bytes reach the observable round stdout.
//   * Filesystem object identity (v3): strings, runId and rootId alone are
//     NOT filesystem object identity. Ownership admission binds to an
//     independently captured trusted object-identity snapshot
//     (ownedRoot.admissionIdentity = { root, base }, e.g. {dev, ino})
//     taken at fixture creation, and re-proves it through the injected
//     objectIdentity adapter (a) at plan admission (combined base+root
//     realpath substitution or a same-path replacement is refused BEFORE
//     any plan object materializes) and (b) at cleanup time before any
//     removal is proposed (a same-path virtual root replacement can never
//     revalidate). Legitimate canonical aliases (macOS /tmp) remain valid:
//     identity is pinned on the HOST-RESOLVED (realpath'd) object — this
//     is not a blanket lexical==realpath rule.
//   * No dsh executable is invented in this first adapter slice. Supported
//     runtimes are exactly pi and hermes (the frozen torture
//     scripted-runtimes copies); dsh replay coverage is NOT claimed here and
//     is refused with a precise diagnostic.
//
// ── Purity / injection ───────────────────────────────────────────────
//   * Imports only the US-001 contract module (node builtins beneath it).
//     No node:fs, node:path, node:child_process, no network, no writes, no
//     eval/Function. All host reality (realpath resolution, filesystem
//     object identity, later CLI execution) is reached through INJECTED
//     adapters — realpath(p) for canonical path resolution and
//     objectIdentity(realPath) for the stable object-identity snapshot of
//     the object at an already-resolved real path — so the designated
//     conformance gate can run the adapter against recording (virtual)
//     filesystem/process/motor adapters with zero host effects, and the
//     future isolated-motor executor can pass the REAL adapters (realpath
//     sync + lstat/stat dev+ino) without any change to this module.
//
// ── Real-future entrypoint surface (recorded, not executed) ──────────
//   The materialized per-action entrypoints mirror byte-for-byte the calls
//   the frozen runtimes issue through runtime-shared.mjs:
//     peek:   <cli> step peek <agentId> --run-id <runId>
//     claim:  <cli> step claim <agentId> --run-id <runId>
//     complete: <cli> step complete <stepId>            (input = report text)
//     fail:   <cli> step fail <stepId> <reason>
//   plus the launch-time harness probe contract
//     prompt: TAMANDUA_HARNESS_PROBE: skill-path
//             Run the exact command "<launcher> skill-path" and reply with
//             the PATH and nothing else.
//   and canned-behavior seeds (behaviors JSON consumed by the frozen
//   runtimes via TAMANDUA_SCRIPTED_BEHAVIORS / TAMANDUA_SCRIPTED_STATE).
//   Preserved output text is fed to `step complete` EXACTLY as recorded
//   (sanitized/synthetic public observations) — never shell-interpreted.

import { validateRecordingRecord } from "./core-recording-contract.mjs";

// Adapter/plan contract version. Bumped to 3 by the CORE-REPLAY-CLOSE
// round (root-observed counterexample hardening):
//   v2 (commit 89f28e81): duplicate coverage refused (duplicate-coverage);
//     replay.unclaimed_exit exitCode validated at plan time as integer 0..255
//     (invalid-exit-code); unknown-gap asymmetry documented + pinned.
//   v3 (this round): (1) sparse per-agent work-invocation indices refused
//     (noncontiguous-round-indices) so a seed can never invent unrecorded
//     "STATUS: done" successes for missing indices; (2) die-before-claim
//     preserved public stdout is carried VERBATIM (empty / no-final-newline
//     included) on the canned-behavior seed and reproduced by the mapped
//     runtime path through a documented torture-fork knob in BOTH pi/hermes
//     die-before-claim paths — not just metadata on the descriptor;
//     (3) owned-root admission binds to an INDEPENDENTLY CAPTURED trusted
//     filesystem object identity (ownedRoot.admissionIdentity) re-proven via
//     the injected objectIdentity adapter, so a combined base+root realpath
//     substitution (containment alone is not proof of the pre-admitted root)
//     and a same-path replacement are both refused (missing-root-identity /
//     root-identity-mismatch); canonical aliases (e.g. macOS /tmp) stay
//     legitimate because identity is pinned on the HOST-RESOLVED object, not
//     lexical==realpath equality; (4) validateCleanupPhase re-proves the
//     held-root object identity (root AND base) before proposing any
//     removal and re-checks plan-admitted fixture candidates
//     (object-identity-changed / cleanup-candidate-replaced); strings,
//     runId and rootId alone are never treated as filesystem object
//     identity. Stricter validation semantics on the same plan shape (plus
//     ownedRoot.admissionIdentity and the objectIdentity adapter inputs).
export const REPLAY_ADAPTER_VERSION = 3;

// ── Supported runtimes (exact paths; NO dsh executable in this slice) ──
export const SUPPORTED_RUNTIMES = Object.freeze(["pi", "hermes"]);

/** Exact supported runtime/contract paths (repo-root relative) that the
 *  adapter maps onto. The pi/hermes runtimes are the FROZEN torture forks
 *  (fork-parity-check pins their non-knob regions to FROZEN_SHA). */
export const EXACT_RUNTIME_PATHS = Object.freeze({
  shared: "torture-test/scripted-runtimes/runtime-shared.mjs",
  pi: "torture-test/scripted-runtimes/runtime-pi.mjs",
  hermes: "torture-test/scripted-runtimes/runtime-hermes.mjs",
  database: "torture-test/scripted-runtimes/database.mjs",
  frozenSha: "torture-test/scripted-runtimes/FROZEN_SHA",
  knobRegions: "torture-test/scripted-runtimes/KNOB-REGIONS.md",
});

/** Precise refusal for the dsh runtime: this adapter slice does NOT invent
 *  a dsh executable and does NOT claim dsh replay coverage. */
export const DSH_UNSUPPORTED_DIAGNOSTIC =
  "runtime \"dsh\" is not supported by this adapter slice: the frozen " +
  "scripted-runtimes fork has pi and hermes runtimes only, no dsh executable " +
  "exists to replay through, and US-003's first adapter slice does not claim " +
  "dsh-path replay coverage (a suite-owned dsh adaptation is a later, " +
  "explicitly separate decision).";

// ── Step-protocol argv contract (mirrors scripted-runtimes/runtime-shared.mjs) ──
// {agent} / {runId} / {stepId} / {reason} are bound at materialization time
// from the plan (runId/agentId) or at execution time from the claim result
// (stepId). "<cli>" is the tamandua CLI path that the real work prompt
// quotes; the runtimes spawn it via createCli.
export const STEP_CLI_ARGV = Object.freeze({
  peek: Object.freeze(["step", "peek", "{agent}", "--run-id", "{runId}"]),
  claim: Object.freeze(["step", "claim", "{agent}", "--run-id", "{runId}"]),
  complete: Object.freeze(["step", "complete", "{stepId}"]),
  fail: Object.freeze(["step", "fail", "{stepId}", "{reason}"]),
});

// ── Launch-time harness probe contract (IFLB) ─────────────────────────
// The dispatch motor probes the harness once per run at its FIRST real
// dispatch: prompt first line is the marker; the harness must run the exact
// quoted `<launcher> skill-path` command and reply with the PATH. Zero-token,
// never journaled, never consuming a canned-behavior index. The conformance
// gate re-derives these strings from the live frozen runtime source so the
// adapter cannot drift from the runtime contract silently.
export const PROBE_CONTRACT = Object.freeze({
  marker: "TAMANDUA_HARNESS_PROBE: skill-path",
  prompt: 'Run the exact command "<launcher> skill-path" and reply with the PATH and nothing else.',
  envVar: "TAMANDUA_HARNESS_PROBE",
});

// Behaviors-file env names consumed by the frozen runtimes.
export const BEHAVIOR_ENV = Object.freeze({
  behaviors: "TAMANDUA_SCRIPTED_BEHAVIORS",
  state: "TAMANDUA_SCRIPTED_STATE",
});

// ── Executor closed action vocabulary ────────────────────────────────
// The ONLY action types this executor will ever map to real motor
// entrypoints. Each maps to a canned-behavior seed consumed by the frozen
// runtime plus the exact step-protocol calls the runtime will issue. The
// record FORMAT accepts any typed op code ([a-z][a-z0-9_.-]*); the EXECUTOR
// accepts only this closed set — any other replay-namespaced operation, or
// any action carrying a type outside this set, is refused (unknown-type).
//
// Naming convention: replay-namespaced op codes. Non-executor record
// operations (observation-time comparisons such as a later cell's
// `compare.*` assertions) are reviewed DATA, not executor actions: they are
// never mapped to motor entrypoints by this adapter.
export const EXECUTOR_ACTION_TYPES = Object.freeze([
  "replay.claim_complete", // claim the admitted run's step; complete with preserved output
  "replay.claim_fail", // claim the admitted run's step; fail with a preserved reason
  "replay.unclaimed_exit", // exit the work round WITHOUT claiming (die-before-claim; preserved exit code/stdout)
  "replay.idle_dispatch", // assert one dispatch tick is idle: peek yields no work, no harness spawn, zero tokens
]);

// ── Action type contract metadata ────────────────────────────────────
// {behaviorMode, issuesStepCalls, tokenCategory}: tokenCategory is always
// "zero" in this slice — every seeded behavior is scripted, so a real run
// would spend zero model tokens by construction.
const ACTION_TYPE_CONTRACT = Object.freeze({
  "replay.claim_complete": Object.freeze({
    behaviorMode: "work",
    issuesStepCalls: true,
    tokenCategory: "zero",
  }),
  "replay.claim_fail": Object.freeze({
    behaviorMode: "work",
    issuesStepCalls: true,
    tokenCategory: "zero",
  }),
  "replay.unclaimed_exit": Object.freeze({
    behaviorMode: "die-before-claim",
    issuesStepCalls: false,
    tokenCategory: "zero",
  }),
  "replay.idle_dispatch": Object.freeze({
    behaviorMode: "none",
    issuesStepCalls: false,
    tokenCategory: "zero",
  }),
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

function err(errors, code, path, message) {
  errors.push({ code, path, message });
}

/**
 * Lexical containment check for an owned-relative fixture path (PURE — no
 * filesystem access). A path must be relative, contain no NUL, no drive
 * prefix, no leading separator (on either "/" or "\\"), and no ".." segment
 * on either separator. Windows-style separators are refused entirely so no
 * future Windows/junction interpretation can smuggle a traversal in.
 * Returns { ok:true } or { ok:false, reason }.
 */
export function checkOwnedRelativePath(fixturePath) {
  if (typeof fixturePath !== "string" || fixturePath.length === 0) {
    return { ok: false, reason: "fixture path must be a non-empty string" };
  }
  if (fixturePath.includes("\u0000")) {
    return { ok: false, reason: "fixture path contains a NUL byte" };
  }
  if (
    fixturePath.startsWith("/") ||
    fixturePath.startsWith("\\") ||
    /^[A-Za-z]:/.test(fixturePath) ||
    fixturePath.startsWith("//")
  ) {
    return { ok: false, reason: `fixture path must be relative, got ${JSON.stringify(fixturePath)}` };
  }
  if (fixturePath.includes("\\")) {
    return {
      ok: false,
      reason: `fixture path uses a backslash separator (${JSON.stringify(fixturePath)}); backslash paths are refused`,
    };
  }
  for (const segment of fixturePath.split("/")) {
    if (segment === "..") {
      return { ok: false, reason: `fixture path traverses upward via '..' (${JSON.stringify(fixturePath)})` };
    }
  }
  return { ok: true };
}

/**
 * Pure "is inside" comparison on ALREADY-RESOLVED real paths. Both must be
 * absolute and lexically clean; containment is a prefix check on the
 * component boundary.
 */
export function isResolvedPathInside(candidate, container) {
  if (
    !isNonEmptyString(candidate) ||
    !isNonEmptyString(container) ||
    !candidate.startsWith("/") ||
    !container.startsWith("/")
  ) {
    return false;
  }
  const containerNorm = container.replace(/\/+$/, "");
  if (candidate === containerNorm) return true;
  return candidate.startsWith(`${containerNorm}/`);
}

/**
 * Stable string form of an identity snapshot (deterministic regardless of
 * object key order): recursively sorts keys. Identity snapshots are plain
 * JSON-able values (e.g. {dev, ino}); comparing the stable form is how the
 * module decides two snapshots name the SAME filesystem object.
 */
function stableIdentityString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableIdentityString).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableIdentityString(value[k])}`).join(",")}}`;
}

/** Do two filesystem object-identity snapshots name the same object? */
function sameObjectIdentity(a, b) {
  return stableIdentityString(a) === stableIdentityString(b);
}

/**
 * A filesystem object-identity snapshot must be a non-empty plain object —
 * never a bare string and never an empty object. Strings/realpaths alone are
 * NOT filesystem object identity (a same-path replacement keeps the string);
 * an empty capture proves nothing.
 */
function isIdentitySnapshot(value) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length > 0 &&
    !Object.values(value).some((v) => v === undefined)
  );
}

/** Freeze an identity snapshot deeply enough to embed in a frozen plan. */
function freezeIdentitySnapshot(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeIdentitySnapshot));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = freezeIdentitySnapshot(v);
  return Object.freeze(out);
}

/**
 * Join preserved public-output observation texts into the exact byte string
 * both the recorded entrypoint descriptor and the canned-behavior seed carry
 * (single-surface invariant: one join function, so the two surfaces can
 * never disagree about the preserved bytes — including an empty payload or a
 * payload with no final newline).
 */
function joinedPreservedText(outputTexts) {
  return outputTexts
    .map((o) => o.text)
    .filter((t) => typeof t === "string")
    .join("\n");
}

// ---------------------------------------------------------------------------
// validateReplayPlan — the complete pre-side-effect plan validation
// ---------------------------------------------------------------------------

/**
 * Validate a COMPLETE replay plan BEFORE any side effect.
 *
 * @param {object} options
 * @param {object} options.record      deep-frozen US-001 recording record
 *                                     (the immutable reviewed evidence).
 * @param {string} options.runtime     "pi" | "hermes" (dsh refused).
 * @param {string} options.admittedRunId  the run the executor is admitted to
 *                                     drive; MUST equal record runId.
 * @param {object} options.ownedRoot   { id, path, base, admissionIdentity }
 *                                     — the run-owned fixture root. `path`
 *                                     (absolute) is the root dir, `base`
 *                                     (absolute) its owned base; both
 *                                     resolved through the realpath adapter to
 *                                     prove no symlinked root/ancestor
 *                                     substitution. `admissionIdentity`
 *                                     ({ root, base }) is the TRUSTED
 *                                     filesystem object-identity snapshot
 *                                     (e.g. {dev, ino}) independently captured
 *                                     at ownership admission (fixture
 *                                     creation) — never bare strings:
 *                                     strings/realpaths alone are not object
 *                                     identity. Containment is never proof of
 *                                     the pre-admitted root; the current
 *                                     object identity at each resolved real
 *                                     path must still equal this trusted
 *                                     capture.
 * @param {Array}  options.actions     ordered executor actions (see schema
 *                                     below) — the complete plan.
 * @param {(p:string)=>string} options.realpath  injected realpath adapter
 *                                     (recording/virtual in the gate; the
 *                                     real node:fs realpathSync-based adapter
 *                                     in the future isolated executor).
 * @param {(realPath:string)=>object} options.objectIdentity  injected
 *                                     filesystem object-identity adapter:
 *                                     given an ALREADY-RESOLVED real path,
 *                                     returns the CURRENT stable identity
 *                                     snapshot of the object at that path
 *                                     (real executor: lstat/stat dev+ino).
 *                                     Required: without it the module cannot
 *                                     bind the trusted admission identity and
 *                                     refuses admission.
 * @returns {{ok:true, plan:object}|{ok:false, errors:Array}}
 *
 * Action schema (validated strictly):
 *   { id, type, runId, operationId, agentId, roundIndex,
 *     outputRefs?: string[], fixturePath?: string,
 *     verdict?: "verified"|"synthetic-adaptation",
 *     adaptationNote?: string, exitCode?: number }  // exitCode: replay.unclaimed_exit only; integer 0..255
 *
 * Checks, in order:
 *   1. record integrity: US-001 validateRecordingRecord (corrupt payload,
 *      missing source, mixed run, incomplete claims, shape/version).
 *   2. runtime support (dsh refused with the precise diagnostic).
 *   3. admitted run identity === record run (identity mismatch refused).
 *   4. owned root: lexical sanity, resolvable through realpath, real root
 *      INSIDE real base (symlinked root/ancestor substitution refused), and
 *      the resolved identity captured for the later cleanup phase.
 *   4b. owned root object identity: admission REQUIRES the trusted
 *      ownedRoot.admissionIdentity capture and the injected objectIdentity
 *      adapter; the current object identity at the resolved base/root real
 *      path must equal the trusted capture (missing-root-identity if absent;
 *      root-identity-mismatch when a combined base+root realpath
 *      substitution or a same-path replacement changed the object —
 *      containment alone never proves the pre-admitted root). Identity is
 *      pinned on the HOST-RESOLVED object, so canonical aliases (macOS
 *      /tmp) stay legitimate — this is not a blanket lexical==realpath
 *      rule.
 *   5. per action: shape, closed executor vocabulary (unknown-type), owner
 *      binding (mixed-run / missing-attribution), attribution to a reviewed
 *      record operation of the SAME type, outputRefs that resolve to record
 *      observations that are text-escapeable (output-not-text refused),
 *      containment of fixturePath (absolute/traversing paths refused
 *      lexically; symlink escapes refused via realpath), verdict policy
 *      (verified refused over gapped evidence — see 6), roundIndex/agentId
 *      sanity.
 *   5b. per-agent work-invocation contiguity: the work-invoking actions
 *      (claim_complete / claim_fail / unclaimed_exit) of each agent must
 *      carry EXACTLY CONTIGUOUS roundIndex 0..n-1 (noncontiguous-round-
 *      indices refused). idle_dispatch is NOT a harness invocation: it never
 *      occupies or justifies a work-invocation index, so it cannot make a
 *      sparse work sequence legitimate and the seed never fills a gap with
 *      an invented "STATUS: done" success.
 *   6. unknown-evidence policy (asymmetric, verified-success-only): an
 *      unknown entry without a structured affectedOperations scope is
 *      GLOBAL and blocks every "verified" claim_complete; an unknown scoped
 *      via `affectedOperationIds` blocks only the actions replaying those
 *      operations. A blocked action MUST declare verdict
 *      "synthetic-adaptation" (+ adaptationNote) — the executor NEVER
 *      converts unknown evidence into verified success and NEVER invents
 *      missing raw bytes. Failure-shape replays (replay.claim_fail,
 *      replay.unclaimed_exit) assert no verified success and are NOT
 *      blocked by declared gaps — rationale in the module header.
 *   7. completeness: every record operation in the replay namespace
 *      (type starts with "replay.") must be covered by exactly one action
 *      of the same type (nothing in the replay namespace silently drops);
 *      duplicate action ids / duplicate coverage refused.
 */
export function validateReplayPlan({
  record,
  runtime,
  admittedRunId,
  ownedRoot,
  actions,
  realpath,
  objectIdentity,
} = {}) {
  const errors = [];

  // -- 1. record integrity (US-001 format validation) -------------------
  if (!isPlainObject(record)) {
    err(errors, "record:shape", "$", "record must be a JSON object");
    return { ok: false, errors };
  }
  const format = validateRecordingRecord(record);
  if (!format.ok) {
    for (const e of format.errors) {
      err(errors, `record:${e.code}`, e.path, e.message);
    }
    return { ok: false, errors };
  }
  const recordRunId = record.sourceIdentity.runId;

  // -- 1b. outcomes: executor refuses unattributed outcome claims ----------
  // The US-001 FORMAT tolerates an expectedOutcome without an operationRef
  // (an unbound expectation is not a format violation). The EXECUTOR does
  // not: every outcome claim a replay plan carries must bind to a reviewed
  // operation, otherwise it is an unattributed outcome and is refused
  // before any side effect.
  if (Array.isArray(record.expectedOutcomes)) {
    for (const [oi, outcome] of record.expectedOutcomes.entries()) {
      if (!isPlainObject(outcome)) continue; // shape already rejected by the format pass above
      if (typeof outcome.operationRef !== "string" || outcome.operationRef.length === 0) {
        err(
          errors,
          "unattributed-outcome",
          `$.expectedOutcomes[${oi}].operationRef`,
          `expectedOutcome ${JSON.stringify(outcome.id)} has no operationRef; the executor refuses unattributed outcome claims before any side effect`,
        );
      }
    }
  }

  // -- 2. runtime support ------------------------------------------------
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    const message =
      runtime === "dsh"
        ? DSH_UNSUPPORTED_DIAGNOSTIC
        : `runtime ${JSON.stringify(runtime)} is not supported; supported runtimes are ${SUPPORTED_RUNTIMES.join("|")}`;
    err(errors, "runtime-unsupported", "$.runtime", message);
  }

  // -- 3. admitted run identity ------------------------------------------
  if (!isNonEmptyString(admittedRunId)) {
    err(errors, "missing-attribution", "$.admittedRunId", "admittedRunId must be a non-empty string");
  } else if (admittedRunId !== recordRunId) {
    err(
      errors,
      "identity-mismatch",
      "$.admittedRunId",
      `admitted run ${admittedRunId} does not match the record's single run ${recordRunId}; every action/result must bind to the admitted run`,
    );
  }

  // -- 4. owned fixture root ----------------------------------------------
  let rootIdentity = null;
  const rootPath = "$.ownedRoot";
  if (!isPlainObject(ownedRoot)) {
    err(errors, "root-shape", rootPath, "ownedRoot must be an object { id, path, base, admissionIdentity }");
  } else {
    const { id, path: rootPathStr, base } = ownedRoot;
    if (!isNonEmptyString(id)) {
      err(errors, "root-shape", `${rootPath}.id`, "ownedRoot.id must be a non-empty string");
    }
    for (const [label, p] of [["path", rootPathStr], ["base", base]]) {
      if (!isNonEmptyString(p)) {
        err(errors, "root-shape", `${rootPath}.${label}`, `ownedRoot.${label} must be a non-empty string`);
      } else if (!p.startsWith("/")) {
        err(errors, "root-shape", `${rootPath}.${label}`, `ownedRoot.${label} must be absolute (a caller-owned temp root), got ${JSON.stringify(p)}`);
      }
    }
    if (typeof realpath !== "function") {
      err(errors, "adapter-shape", "$.realpath", "a realpath adapter function must be injected");
    } else if (typeof objectIdentity !== "function") {
      err(
        errors,
        "adapter-shape",
        "$.objectIdentity",
        "an objectIdentity adapter function must be injected: the module refuses to admit an owned root on containment alone — strings/realpaths are not filesystem object identity",
      );
    } else if (isNonEmptyString(rootPathStr) && isNonEmptyString(base)) {
      // Resolve root + base through the adapter. The resolved ROOT must stay
      // inside the resolved BASE: an ancestor symlink that points the root
      // (or any of its ancestors) outside the owned base is a symlinked
      // root/ancestor substitution and is refused BEFORE anything else.
      let rootReal = null;
      let baseReal = null;
      let rootUnresolvable = null;
      let baseUnresolvable = null;
      try {
        rootReal = realpath(rootPathStr);
      } catch (e) {
        rootUnresolvable = e instanceof Error ? e.message : String(e);
      }
      try {
        baseReal = realpath(base);
      } catch (e) {
        baseUnresolvable = e instanceof Error ? e.message : String(e);
      }
      if (rootUnresolvable !== null || baseUnresolvable !== null) {
        err(
          errors,
          "root-unresolvable",
          rootPath,
          `owned root could not be resolved through the realpath adapter (root: ${rootUnresolvable ?? "ok"}, base: ${baseUnresolvable ?? "ok"})`,
        );
      } else if (!isResolvedPathInside(rootReal, baseReal)) {
        err(
          errors,
          "root-substitution",
          rootPath,
          `owned root resolves to ${rootReal} which is NOT inside its owned base ${baseReal}; a symlinked root/ancestor substitution (or an unattributed root) is refused before any action`,
        );
      } else {
        // 4b. Bind to the INDEPENDENTLY CAPTURED TRUSTED object identity.
        // Containment above only proves the CURRENT resolution is nested; it
        // never proves this is the PRE-ADMITTED owned root. The trusted
        // capture taken at ownership admission (ownedRoot.admissionIdentity)
        // is the authority; the current object identity at each resolved
        // real path (through the injected objectIdentity adapter, applied to
        // the HOST-RESOLVED path so canonical aliases stay legitimate) must
        // still equal it. A combined base+root realpath substitution (both
        // resolving into a foreign tree together) or a same-path replacement
        // changes the object identity and is refused BEFORE any plan object
        // materializes.
        const admission = isPlainObject(ownedRoot.admissionIdentity)
          ? ownedRoot.admissionIdentity
          : null;
        const admissionBase = admission && isIdentitySnapshot(admission.base) ? admission.base : null;
        const admissionRoot = admission && isIdentitySnapshot(admission.root) ? admission.root : null;
        if (admission === null || admissionBase === null || admissionRoot === null) {
          err(
            errors,
            "missing-root-identity",
            `${rootPath}.admissionIdentity`,
            "ownedRoot.admissionIdentity { root, base } is required: the trusted filesystem object-identity snapshot captured at ownership admission (e.g. {dev, ino}). Strings, runId and rootId alone are not filesystem object identity, and the executor refuses to admit a root on containment alone",
          );
        } else {
          let currentBase = null;
          let currentRoot = null;
          let identityError = null;
          try {
            currentBase = objectIdentity(baseReal);
            currentRoot = objectIdentity(rootReal);
          } catch (e) {
            identityError = e instanceof Error ? e.message : String(e);
          }
          if (identityError !== null) {
            err(
              errors,
              "root-identity-unresolvable",
              rootPath,
              `the object identity of the owned root/base could not be resolved through the objectIdentity adapter (${identityError}); refusing admission`,
            );
          } else if (!sameObjectIdentity(currentBase, admissionBase)) {
            err(
              errors,
              "root-identity-mismatch",
              `${rootPath}.admissionIdentity.base`,
              `the owned base object at resolved real path ${baseReal} currently has identity ${stableIdentityString(currentBase)} but the trusted ownership admission captured ${stableIdentityString(admissionBase)}; the base was substituted or replaced (a combined base+root realpath substitution or same-path replacement is never the pre-admitted root) — refused before any action`,
            );
          } else if (!sameObjectIdentity(currentRoot, admissionRoot)) {
            err(
              errors,
              "root-identity-mismatch",
              `${rootPath}.admissionIdentity.root`,
              `the owned root object at resolved real path ${rootReal} currently has identity ${stableIdentityString(currentRoot)} but the trusted ownership admission captured ${stableIdentityString(admissionRoot)}; the root was substituted or replaced (containment alone is not proof of the pre-admitted root) — refused before any action`,
            );
          } else {
            rootIdentity = Object.freeze({
              rootId: id,
              admittedRunId,
              rootReal,
              baseReal,
              identity: Object.freeze({
                root: freezeIdentitySnapshot(admissionRoot),
                base: freezeIdentitySnapshot(admissionBase),
              }),
            });
          }
        }
      }
    }
  }

  // -- 5./6./7. actions ---------------------------------------------------
  const coveredOperationIds = new Set();
  const coverageByOperation = new Map(); // operationId -> number of actions covering it
  const seenActionIds = new Set();
  const seenAgentRounds = new Map(); // agentId -> Set(roundIndex)
  const fixtureIdentityByActionId = new Map(); // actionId -> frozen object-identity snapshot of the admitted fixture
  const workRoundsByAgent = new Map(); // agentId -> [{roundIndex, path}] for work-invoking actions

  // Global unknown gaps: an unknown entry with no structured scope.
  const recordUnknown = Array.isArray(record.unknown) ? record.unknown : [];
  const globalGaps = recordUnknown.filter((u) => !Array.isArray(u.affectedOperationIds));
  const scopedGapsByOp = new Map();
  for (const u of recordUnknown) {
    if (!Array.isArray(u.affectedOperationIds)) continue;
    for (const opId of u.affectedOperationIds) {
      if (!scopedGapsByOp.has(opId)) scopedGapsByOp.set(opId, []);
      scopedGapsByOp.get(opId).push(u);
    }
  }

  const recordOpIds = new Set((record.operations ?? []).map((op) => op.id));
  const observationById = new Map((record.observations ?? []).map((obs) => [obs.id, obs]));

  // Every replay-namespaced record op must be covered by an action.
  const replayOpsToCover = (record.operations ?? []).filter((op) =>
    typeof op.type === "string" && op.type.startsWith("replay."),
  );

  const actionsArr = Array.isArray(actions) ? actions : [];
  if (!Array.isArray(actions)) {
    err(errors, "plan-shape", "$.actions", "actions must be an array");
  } else if (actionsArr.length === 0) {
    err(errors, "incomplete-plan", "$.actions", "a replay plan must contain at least one executor action (nothing to execute)");
  }

  for (const [index, action] of actionsArr.entries()) {
    const aPath = `$.actions[${index}]`;
    if (!isPlainObject(action)) {
      err(errors, "plan-shape", aPath, "each action must be an object");
      continue;
    }

    // -- id / type --------------------------------------------------------
    if (!isNonEmptyString(action.id)) {
      err(errors, "plan-shape", `${aPath}.id`, "action needs a non-empty id");
    } else if (seenActionIds.has(action.id)) {
      err(errors, "plan-shape", `${aPath}.id`, `duplicate action id ${action.id}`);
    } else {
      seenActionIds.add(action.id);
    }

    // THE executor closed-vocabulary refusal: type outside
    // EXECUTOR_ACTION_TYPES is refused even though the record FORMAT would
    // accept its type-shaped spelling.
    if (!EXECUTOR_ACTION_TYPES.includes(action.type)) {
      err(
        errors,
        "unknown-type",
        `${aPath}.type`,
        `executor refuses action type ${JSON.stringify(action.type)}; the closed executor vocabulary is [${EXECUTOR_ACTION_TYPES.join(", ")}]`,
      );
    }

    // -- owner binding ----------------------------------------------------
    if (!isNonEmptyString(action.runId)) {
      err(errors, "missing-attribution", `${aPath}.runId`, "action.runId (the admitted run the action binds to) is required");
    } else if (isNonEmptyString(admittedRunId) && action.runId !== admittedRunId) {
      err(
        errors,
        "mixed-run",
        `${aPath}.runId`,
        `action ${JSON.stringify(action.id)} binds run ${action.runId} but the admitted run is ${admittedRunId}`,
      );
    }

    // -- attribution to a reviewed record operation -----------------------
    if (!isNonEmptyString(action.operationId)) {
      err(errors, "missing-attribution", `${aPath}.operationId`, "action.operationId (the reviewed record operation it replays) is required");
    } else if (!recordOpIds.has(action.operationId)) {
      err(
        errors,
        "missing-attribution",
        `${aPath}.operationId`,
        `action references record operation ${action.operationId} that is absent from the record`,
      );
    } else {
      const op = (record.operations ?? []).find((o) => o.id === action.operationId);
      if (typeof action.type === "string" && op.type !== action.type) {
        err(
          errors,
          "operation-type-mismatch",
          `${aPath}.operationId`,
          `action type ${action.type} does not match its reviewed record operation ${action.operationId} (record op type ${op.type})`,
        );
      } else {
        coveredOperationIds.add(action.operationId);
        const coveredSoFar = coverageByOperation.get(action.operationId) ?? 0;
        coverageByOperation.set(action.operationId, coveredSoFar + 1);
        if (coveredSoFar > 0) {
          err(
            errors,
            "duplicate-coverage",
            `${aPath}.operationId`,
            `record operation ${action.operationId} is already covered by another plan action; every replay-namespaced record operation must be covered by EXACTLY ONE action — duplicate coverage would make a later executor double-execute one reviewed operation`,
          );
        }
      }
    }

    // -- agentId / roundIndex ----------------------------------------------
    if (!isNonEmptyString(action.agentId)) {
      err(errors, "missing-attribution", `${aPath}.agentId`, "action.agentId (the scripted-runtime agent key that performs the round) is required");
    }
    if (!Number.isInteger(action.roundIndex) || action.roundIndex < 0) {
      err(errors, "plan-shape", `${aPath}.roundIndex`, "action.roundIndex must be a non-negative integer (the per-agent work-invocation index)");
    } else if (isNonEmptyString(action.agentId)) {
      if (
        EXECUTOR_ACTION_TYPES.includes(action.type) &&
        action.type !== "replay.idle_dispatch"
      ) {
        // Work-INVOKING actions share one per-agent work-invocation index
        // namespace: duplicates are refused here and contiguity (0..n-1) is
        // enforced after the loop.
        if (!seenAgentRounds.has(action.agentId)) seenAgentRounds.set(action.agentId, new Set());
        const rounds = seenAgentRounds.get(action.agentId);
        if (rounds.has(action.roundIndex)) {
          err(errors, "plan-shape", `${aPath}.roundIndex`, `duplicate roundIndex ${action.roundIndex} for agent ${action.agentId}`);
        }
        rounds.add(action.roundIndex);
        if (!workRoundsByAgent.has(action.agentId)) workRoundsByAgent.set(action.agentId, []);
        workRoundsByAgent.get(action.agentId).push({ roundIndex: action.roundIndex, path: aPath });
      }
      // replay.idle_dispatch is NOT a harness invocation (an idle dispatch
      // tick peeks NO_WORK and spawns nothing), so it never occupies — or
      // justifies — a work-invocation index and shares NO namespace with the
      // agent's work invocations. Its roundIndex is purely descriptive
      // (ordering of the observed idle tick in the plan); it seeds nothing.
    }

    // -- exitCode: replay.unclaimed_exit only, integer 0..255 ---------------
    // The frozen runtime's die-before-claim path exits with
    // process.exit(behavior.exitCode ?? 3); a parent process observes an
    // exit STATUS in 0..255 only (waitpid yields the low 8 bits). Plan-time
    // validation enforces that bound so the recorded entrypoint descriptor
    // and the canned-behavior seed can never disagree about the same
    // action's exit code (a fractional/negative/oversized value was
    // previously accepted by validation, then silently dropped by the seed
    // while the descriptor preserved it).
    if (action.exitCode !== undefined && action.exitCode !== null) {
      if (action.type !== "replay.unclaimed_exit") {
        err(
          errors,
          "invalid-exit-code",
          `${aPath}.exitCode`,
          `exitCode is only meaningful for replay.unclaimed_exit actions; ${JSON.stringify(action.type)} actions complete/fail via the step CLI or spawn nothing and never exit with a preserved code`,
        );
      } else if (!Number.isInteger(action.exitCode) || action.exitCode < 0 || action.exitCode > 255) {
        err(
          errors,
          "invalid-exit-code",
          `${aPath}.exitCode`,
          `replay.unclaimed_exit exitCode must be an integer in 0..255 (the observable process-exit status range; the frozen runtime's die-before-claim path exits with behavior.exitCode ?? 3), got ${JSON.stringify(action.exitCode)}`,
        );
      }
    }

    // -- outputRefs resolve to text-escapeable observations -----------------
    const needsPreservedOutput =
      action.type === "replay.claim_complete" || action.type === "replay.claim_fail";
    if (action.outputRefs === undefined || action.outputRefs === null) {
      if (needsPreservedOutput) {
        err(
          errors,
          "missing-preserved-output",
          `${aPath}.outputRefs`,
          `${action.type} actions need at least one outputRef (preserved public output the real step ` +
            "complete/fail would carry); the executor never invents preserved output bytes",
        );
      }
    } else if (!Array.isArray(action.outputRefs)) {
      err(errors, "plan-shape", `${aPath}.outputRefs`, "action.outputRefs must be an array of observation ids when present");
    } else {
      if (needsPreservedOutput && action.outputRefs.length === 0) {
        err(
          errors,
          "missing-preserved-output",
          `${aPath}.outputRefs`,
          `${action.type} actions need at least one outputRef (preserved public output the real step ` +
            "complete/fail would carry); the executor never invents preserved output bytes",
        );
      }
        for (const [ri, ref] of action.outputRefs.entries()) {
          const refPath = `${aPath}.outputRefs[${ri}]`;
          if (!isNonEmptyString(ref)) {
            err(errors, "plan-shape", refPath, "outputRef entries must be non-empty strings");
            continue;
          }
          if (!observationById.has(ref)) {
            err(
              errors,
              "missing-attribution",
              refPath,
              `action outputRef ${ref} does not resolve to any record observation (unattributed preserved output)`,
            );
            continue;
          }
          const text = observationToText(observationById.get(ref));
          if (text === null) {
            err(
              errors,
              "output-not-text",
              refPath,
              `observation ${ref} cannot be escaped to the preserved output text that ` +
                "`step complete` would receive (fact must be a string or an object with a string text field)",
            );
          }
        }
      }

    // -- containment: fixturePath -------------------------------------------
    // A declared fixturePath is an owned-relative fixture the run will create
    // or touch. It is checked lexically, re-resolved through the SAME
    // realpath adapter snapshot as the root (symlink escapes refused), and —
    // when the owned root is identity-bound — its CURRENT filesystem object
    // identity is captured onto the plan action so the cleanup phase can
    // re-prove the SAME fixture object before proposing its removal.
    if (action.fixturePath !== undefined && action.fixturePath !== null) {
      const lex = checkOwnedRelativePath(action.fixturePath);
      if (!lex.ok) {
        err(errors, "path-escape", `${aPath}.fixturePath`, lex.reason);
      } else if (rootIdentity !== null && typeof realpath === "function") {
        // Re-resolve the joined candidate through the SAME adapter snapshot
        // as the root so a symlink INSIDE the root that points outside is
        // caught before any action could touch it.
        const joined = `${rootIdentity.rootReal}/${action.fixturePath}`;
        let candidateReal = null;
        let candidateError = null;
        try {
          candidateReal = realpath(joined);
        } catch (e) {
          candidateError = e instanceof Error ? e.message : String(e);
        }
        if (candidateError !== null) {
          err(
            errors,
            "containment-unresolvable",
            `${aPath}.fixturePath`,
            `fixture candidate ${joined} could not be resolved: ${candidateError}`,
          );
        } else if (!isResolvedPathInside(candidateReal, rootIdentity.rootReal)) {
          err(
            errors,
            "containment-escape",
            `${aPath}.fixturePath`,
            `fixture path resolves to ${candidateReal} which escapes the owned root ${rootIdentity.rootReal} (symlink escape or root substitution); refused`,
          );
        } else if (typeof objectIdentity === "function") {
          let candidateIdentity = null;
          let candidateIdentityError = null;
          try {
            candidateIdentity = objectIdentity(candidateReal);
          } catch (e) {
            candidateIdentityError = e instanceof Error ? e.message : String(e);
          }
          if (candidateIdentityError !== null) {
            err(
              errors,
              "containment-unresolvable",
              `${aPath}.fixturePath`,
              `fixture candidate ${joined} resolved but its object identity could not be captured (${candidateIdentityError}); the plan cannot later prove the same fixture object at cleanup time`,
            );
          } else if (!isIdentitySnapshot(candidateIdentity)) {
            err(
              errors,
              "containment-unresolvable",
              `${aPath}.fixturePath`,
              `fixture candidate ${joined} resolved to a non-identity ${JSON.stringify(candidateIdentity)}; a filesystem object-identity snapshot is required`,
            );
          } else {
            fixtureIdentityByActionId.set(action.id, freezeIdentitySnapshot(candidateIdentity));
          }
        }
      }
    }

    // -- verdict / unknown-evidence policy ---------------------------------
    // Asymmetric by design: the gap-block applies ONLY to the
    // replay.claim_complete "verified" verdict — the one action asserting a
    // reviewed success from preserved bytes. Failure-shape replays
    // (replay.claim_fail / replay.unclaimed_exit) assert no verified
    // success and validate under declared gaps without a synthetic-
    // adaptation declaration; see the module header for the rationale.
    const blocksVerified = actionGapReasons(action, globalGaps, scopedGapsByOp);
    if (action.type === "replay.claim_complete") {
      if (action.verdict !== "verified" && action.verdict !== "synthetic-adaptation") {
        err(
          errors,
          "plan-shape",
          `${aPath}.verdict`,
          'claim_complete actions need verdict "verified" or "synthetic-adaptation"',
        );
      } else if (action.verdict === "verified" && blocksVerified.length > 0) {
        err(
          errors,
          "unknown-evidence-verified",
          `${aPath}.verdict`,
          `action ${JSON.stringify(action.id)} claims verified success but its evidence is gapped by declared unknown(s): ` +
            `${blocksVerified.map((u) => JSON.stringify(u.fact)).join("; ")}. ` +
            "The executor never converts UNKNOWN evidence into success and never invents missing raw bytes: " +
            're-declare the action with verdict "synthetic-adaptation" and an explicit adaptationNote, or remove the gap.',
        );
      } else if (action.verdict === "synthetic-adaptation" && !isNonEmptyString(action.adaptationNote)) {
        err(
          errors,
          "plan-shape",
          `${aPath}.adaptationNote`,
          "synthetic-adaptation actions need an explicit adaptationNote describing exactly what stands in for the unretained evidence",
        );
      }
    }
  }

  // -- 5b. per-agent work-invocation index contiguity ----------------------
  // The seed is consumed one entry per WORK INVOCATION (the runtime repeats
  // the last entry on relaunch overrun); an agent's work-invoking actions
  // must therefore carry EXACTLY CONTIGUOUS indices 0..n-1. A sparse plan
  // (e.g. one claim_complete at roundIndex 2) would otherwise make the seed
  // fabricate unrecorded "STATUS: done" successes for the missing indices.
  // Idle-dispatch observations are NOT harness invocations: they never fill
  // a gap or make a sparse sequence legitimate. Legitimate contiguous
  // pi/Hermes mapping is unchanged.
  for (const [agentId, rounds] of workRoundsByAgent) {
    rounds.sort((a, b) => a.roundIndex - b.roundIndex);
    for (let i = 0; i < rounds.length; i += 1) {
      if (rounds[i].roundIndex !== i) {
        const seen = rounds.map((r) => r.roundIndex).join(",");
        err(
          errors,
          "noncontiguous-round-indices",
          rounds[i].path,
          `agent ${agentId} has work-invoking roundIndex values [${seen}] which are NOT contiguous from 0 (work-invocation ${i} at ${rounds[i].path} has index ${rounds[i].roundIndex}); a sparse plan would make the runtime seed invent unrecorded "STATUS: done" successes for the missing indices — refused. replay.idle_dispatch observations are NOT harness invocations and never occupy or justify a work-invocation index. Record every missing invocation as its own reviewed work action with honest provenance, or remove the gap`,
        );
      }
    }
  }

  // -- 7. completeness: replay-namespace coverage --------------------------
  for (const op of replayOpsToCover) {
    if (!coveredOperationIds.has(op.id)) {
      err(
        errors,
        "incomplete-plan",
        `$.record.operations.${op.id}`,
        `record operation ${op.id} (type ${op.type}) is in the replay namespace but no plan action replays it`,
      );
    }
    if (!EXECUTOR_ACTION_TYPES.includes(op.type)) {
      err(
        errors,
        "unknown-type",
        `$.record.operations.${op.id}.type`,
        `record operation ${op.id} is replay-namespaced but its type ${JSON.stringify(op.type)} is not in the executor's closed vocabulary [${EXECUTOR_ACTION_TYPES.join(", ")}]; refused`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // -- Assemble the validated plan (deep-frozen, execution:false) ----------
  const unknownGaps = recordUnknown.map((u) => ({
    fact: u.fact,
    reason: u.reason,
    scope: Array.isArray(u.affectedOperationIds) ? "scoped" : "global",
    affectedOperationIds: Array.isArray(u.affectedOperationIds) ? [...u.affectedOperationIds] : undefined,
  }));

  const planActions = actionsArr.map((action) =>
    buildPlanAction(action, observationById, fixtureIdentityByActionId.get(action.id) ?? null),
  );
  const plan = Object.freeze({
    adapterVersion: REPLAY_ADAPTER_VERSION,
    runtime,
    admittedRunId,
    recordRunId,
    recordPayloadSha256: record.payloadSha256,
    zeroToken: true, // every seeded behavior is scripted; a real run spends zero model tokens
    rootIdentity,
    actions: Object.freeze(planActions),
    unknownGaps: Object.freeze(unknownGaps),
    launch: Object.freeze({
      kind: "harness-probe",
      marker: PROBE_CONTRACT.marker,
      command: '<launcher> skill-path',
      prompt: PROBE_CONTRACT.prompt,
      answeredByRuntime: true,
      executed: false,
    }),
    execution: Object.freeze({
      executed: false,
      scope: "validation-only",
      note:
        "US-003 adapter slice: the replay plan is VALIDATED and its exact real entrypoints are " +
        "materialized, but the real isolated daemon/scheduler/step-protocol motor run is NOT YET " +
        "EXECUTED. It requires the coordinator's independent acceptance of the committed recording " +
        "proof before any later execution story may run it.",
    }),
  });
  return { ok: true, plan };
}

/**
 * Which declared unknown gaps block a "verified" verdict for the action:
 * a global gap (unknown with no structured scope) blocks everything; a
 * scoped gap blocks only actions replaying the affected operation.
 */
function actionGapReasons(action, globalGaps, scopedGapsByOp) {
  const gaps = [...globalGaps];
  if (action.operationId !== undefined && scopedGapsByOp.has(action.operationId)) {
    gaps.push(...scopedGapsByOp.get(action.operationId));
  }
  return gaps;
}

/** Escape a record observation's fact to the preserved output TEXT that the
 *  real `step complete` would receive. Strings pass through; objects with a
 *  string `text` field pass through; everything else is not text-escapeable
 *  (null) and is refused by plan validation. */
export function observationToText(observation) {
  if (!isPlainObject(observation)) return null;
  const fact = observation.fact;
  if (typeof fact === "string") return fact;
  if (isPlainObject(fact) && typeof fact.text === "string") return fact.text;
  return null;
}

/**
 * Structured semantic errors for ONE plan action's preserved public-text
 * payload — the COMPLETE semantic payload consumed by materializeRuntimeSeed
 * (canned-behavior bytes) and by the executor (step complete/fail input and
 * the expected final output join). Every claimed public text must be PRESENT
 * and STRING-TYPED; missing or non-string data can never be converted into
 * invented bytes (a join of non-strings, or a silent filter that drops an
 * entry, would both fabricate a byte shape the record never claimed).
 *
 * Rules (shared by plan validation and the seed so the two surfaces can never
 * disagree about an action's preserved bytes):
 *  - replay.claim_complete / replay.claim_fail MUST carry preservedOutputTexts
 *    as a NON-EMPTY array of { observationId, text } entries whose `text` is a
 *    string (missing/empty → `missing-preserved-output`; non-array →
 *    `preserved-output-shape`; non-string text → `preserved-text-not-string`).
 *    claim actions without preserved output would force the seed/executor to
 *    invent the report bytes a real step would store — refused.
 *  - replay.unclaimed_exit MAY carry preservedOutputTexts (the exact public
 *    stdout bytes of the die-before-claim round); a missing/empty payload is
 *    the legitimate zero-byte shape (nothing is invented). When present the
 *    entries are validated identically (string-typed text; an empty array is
 *    treated as the zero-byte shape).
 *  - replay.idle_dispatch seeds nothing and consumes no bytes.
 *
 * @param {object} action  a plan action object.
 * @returns {Array<{code,path,message}>} empty when the payload is semantically
 *   sound for the action's type.
 */
export function preservedPayloadSemanticErrors(action) {
  const errors = [];
  if (!isPlainObject(action)) return errors;
  const at = "$.preservedOutputTexts";
  const claimType = action.type === "replay.claim_complete" || action.type === "replay.claim_fail";
  const unclaimedExit = action.type === "replay.unclaimed_exit";
  const payload = action.preservedOutputTexts;

  if (claimType) {
    if (payload === undefined || payload === null) {
      errors.push({
        code: "missing-preserved-output",
        path: at,
        message:
          `${action.type} actions must carry preservedOutputTexts (the preserved public output the real step ` +
          "complete/fail would carry); the executor never invents preserved output bytes",
      });
    } else if (!Array.isArray(payload)) {
      errors.push({
        code: "preserved-output-shape",
        path: at,
        message: "preservedOutputTexts must be an array of { observationId, text } entries",
      });
    } else if (payload.length === 0) {
      errors.push({
        code: "missing-preserved-output",
        path: at,
        message:
          `${action.type} actions need at least one preserved public text; the executor never invents ` +
          "preserved output bytes",
      });
    }
  } else if (unclaimedExit) {
    if (payload !== undefined && payload !== null && !Array.isArray(payload)) {
      errors.push({
        code: "preserved-output-shape",
        path: at,
        message: "preservedOutputTexts must be an array of { observationId, text } entries when present",
      });
    }
  }
  // An unclaimed_exit with payload === [] is the zero-byte shape: nothing was
  // claimed, nothing is invented — no error.
  if (Array.isArray(payload)) {
    for (const [i, entry] of payload.entries()) {
      const entryPath = `${at}[${i}]`;
      if (!isPlainObject(entry)) {
        errors.push({
          code: "preserved-output-shape",
          path: entryPath,
          message: "each preservedOutputTexts entry must be an object { observationId, text }",
        });
        continue;
      }
      if (typeof entry.text !== "string") {
        errors.push({
          code: "preserved-text-not-string",
          path: `${entryPath}.text`,
          message:
            `preserved public text must be a string, got ${JSON.stringify(entry.text)} — a non-string can never be ` +
            "turned into the preserved bytes a real step would receive",
        });
      }
      if (entry.observationId !== undefined && !isNonEmptyString(entry.observationId)) {
        errors.push({
          code: "plan-format",
          path: `${entryPath}.observationId`,
          message: "observationId must be a non-empty string when present",
        });
      }
    }
  }
  return errors;
}

/**
 * Build the materialized (recorded, executed:false) action for the plan.
 * @param {object} action           the validated input action.
 * @param {Map}    observationById  record observation id -> observation.
 * @param {object|null} fixtureIdentity  frozen filesystem object-identity
 *        snapshot of the admitted fixture candidate (null when the action
 *        declares no fixturePath or none was resolved).
 */
function buildPlanAction(action, observationById, fixtureIdentity) {
  const typeContract = ACTION_TYPE_CONTRACT[action.type] ?? {};
  const outputTexts = (action.outputRefs ?? []).map((ref) => {
    const obs = observationById.get(ref);
    return { observationId: ref, text: obs ? observationToText(obs) : null };
  });
  // ONE join function for every preserved-bytes surface (the recorded
  // descriptor AND the canned-behavior seed) so the two can never disagree
  // about the exact bytes — including empty or no-final-newline payloads.
  const joinedText = joinedPreservedText(outputTexts);
  const entrypoints = [];

  if (action.type === "replay.claim_complete" || action.type === "replay.claim_fail") {
    entrypoints.push(
      Object.freeze({
        kind: "step-cli.claim",
        argv: fillArgv(STEP_CLI_ARGV.claim, { agent: action.agentId, runId: action.runId }),
        executable: "<cli>",
        input: null,
        contract: `${EXACT_RUNTIME_PATHS.shared} claimStep`,
        zeroToken: true,
        executed: false,
        bindsStepId: true, // the stepId returned by claim is bound to the complete/fail argv at execution time
      }),
    );
    if (action.type === "replay.claim_complete") {
      entrypoints.push(
        Object.freeze({
          kind: "step-cli.complete",
          argv: fillArgv(STEP_CLI_ARGV.complete, { stepId: "<stepId>" }),
          executable: "<cli>",
          input: joinedText,
          contract: `${EXACT_RUNTIME_PATHS.shared} completeStep`,
          zeroToken: true,
          executed: false,
        }),
      );
    } else {
      entrypoints.push(
        Object.freeze({
          kind: "step-cli.fail",
          argv: fillArgv(STEP_CLI_ARGV.fail, { stepId: "<stepId>", reason: joinedText }),
          executable: "<cli>",
          input: null,
          contract: `${EXACT_RUNTIME_PATHS.shared} failStep`,
          zeroToken: true,
          executed: false,
        }),
      );
    }
  } else if (action.type === "replay.unclaimed_exit") {
    entrypoints.push(
      Object.freeze({
        kind: "runtime.exit-unclaimed",
        behaviorMode: "die-before-claim",
        exitCode: action.exitCode ?? null,
        preservedStdout: outputTexts.length > 0 ? joinedText : null,
        zeroToken: true,
        executed: false,
      }),
    );
  } else if (action.type === "replay.idle_dispatch") {
    entrypoints.push(
      Object.freeze({
        kind: "dispatch.idle",
        peekResult: "NO_WORK_AVAILABLE",
        spawn: false,
        zeroToken: true,
        executed: false,
      }),
    );
  }

  const planAction = {
    id: action.id,
    type: action.type,
    runId: action.runId,
    operationId: action.operationId,
    agentId: action.agentId,
    roundIndex: action.roundIndex,
    behaviorMode: typeContract.behaviorMode ?? "none",
    entrypoints: Object.freeze(entrypoints),
  };
  if (action.fixturePath !== undefined) planAction.fixturePath = action.fixturePath;
  if (fixtureIdentity !== null && action.fixturePath !== undefined) {
    planAction.fixtureIdentity = fixtureIdentity;
  }
  if (action.outputRefs !== undefined) planAction.outputRefs = Object.freeze([...action.outputRefs]);
  if (action.verdict !== undefined) planAction.verdict = action.verdict;
  if (action.adaptationNote !== undefined) planAction.adaptationNote = action.adaptationNote;
  if (action.exitCode !== undefined) planAction.exitCode = action.exitCode;
  if (outputTexts.length > 0) {
    planAction.preservedOutputTexts = Object.freeze(outputTexts);
  }
  return Object.freeze(planAction);
}

/** Fill {agent}/{runId}/{stepId}/{reason} placeholders in a step-cli argv. */
function fillArgv(template, bindings) {
  return template.map((part) => {
    if (typeof part !== "string") return part;
    return part.replace(/\{(\w+)\}/g, (_, key) =>
      Object.prototype.hasOwnProperty.call(bindings, key) ? String(bindings[key]) : `{${key}}`,
    );
  });
}

// ---------------------------------------------------------------------------
// validateCleanupPhase — identity-verified owned-fixture cleanup validation
// ---------------------------------------------------------------------------

/**
 * Validate the post-run cleanup of the run's OWNED fixture root(s) WITHOUT
 * removing anything. The cleanup phase must re-prove ownership against the
 * HOLD-ROOT AUTHORITY captured at plan admission: the same admitted run, the
 * same root id, the SAME resolved realpath through the (injected) realpath
 * adapter AND the SAME filesystem OBJECT IDENTITY (root AND base) through the
 * injected objectIdentity adapter. Pathname strings are not object identity:
 * a same-path virtual root replacement (e.g. dev1/ino101 -> dev1/ino202)
 * keeps every string equal but changes the object, and is REFUSED here
 * before any removal is proposed.
 *
 * Plan-admitted fixture candidates (actions that declared a fixturePath) are
 * re-proven against the object identity captured at plan admission: a
 * cleanup path matching an admitted fixture whose object was replaced since
 * admission is refused (cleanup-candidate-replaced).
 *
 * This is a VALIDATION-TIME re-proof. The real executor that later performs
 * the removals MUST re-run the same held-root authority + per-candidate
 * object-identity re-check immediately before every proposed removal and
 * refuse on any change: a pure plan/validation-time check does NOT solve the
 * executor's later check/use race — that requirement is carried explicitly
 * on every removal descriptor below (identity snapshots included) and is an
 * executor-story obligation, not a claim this module removes anything.
 *
 * @param {object} options.plan      the validated plan from validateReplayPlan.
 * @param {object} options.cleanup   { runId, rootId, paths: string[] } where
 *                                   paths are owned-relative subpaths to
 *                                   remove plus the root itself is implied.
 * @param {(p:string)=>string} options.realpath  injected realpath adapter
 *                                   (must be the SAME snapshot semantics as
 *                                   admission — in the future executor the
 *                                   check runs immediately before each
 *                                   removal).
 * @param {(realPath:string)=>object} options.objectIdentity  injected
 *                                   filesystem object-identity adapter (same
 *                                   semantics as plan admission); required —
 *                                   without it the cleanup phase cannot
 *                                   re-prove the held-root object identity.
 * @returns {{ok:true, removals:Array}|{ok:false, errors:Array}}
 */
export function validateCleanupPhase({ plan, cleanup, realpath, objectIdentity } = {}) {
  const errors = [];
  if (!isPlainObject(plan) || !isPlainObject(plan.rootIdentity)) {
    err(errors, "identity-loss", "$.plan", "cleanup requires a validated plan carrying a rootIdentity");
    return { ok: false, errors };
  }
  const identity = plan.rootIdentity;
  // The held-root authority must carry the trusted object-identity snapshots
  // captured at admission. A plan that only stored pathname strings cannot
  // re-prove object identity: strings/runId/rootId alone are NOT filesystem
  // object identity.
  if (
    !isPlainObject(identity.identity) ||
    !isIdentitySnapshot(identity.identity.root) ||
    !isIdentitySnapshot(identity.identity.base)
  ) {
    err(
      errors,
      "identity-loss",
      "$.plan.rootIdentity.identity",
      "the validated plan carries no trusted filesystem object-identity snapshot for the owned root/base (admission-time {dev, ino}-style capture is required); refusing any removal — strings, runId and rootId alone are not filesystem object identity",
    );
    return { ok: false, errors };
  }
  if (typeof realpath !== "function") {
    err(errors, "adapter-shape", "$.realpath", "a realpath adapter function must be injected");
    return { ok: false, errors };
  }
  if (typeof objectIdentity !== "function") {
    err(
      errors,
      "adapter-shape",
      "$.objectIdentity",
      "an objectIdentity adapter function must be injected so the cleanup phase can re-prove the held-root filesystem object identity before proposing any removal",
    );
    return { ok: false, errors };
  }

  if (!isPlainObject(cleanup)) {
    err(errors, "cleanup-shape", "$.cleanup", "cleanup must be an object { runId, rootId, paths }");
    return { ok: false, errors };
  }
  // -- identity re-proof: run + root must match the admission identity -----
  if (!isNonEmptyString(cleanup.runId)) {
    err(errors, "identity-loss", "$.cleanup.runId", "cleanup.runId is missing: the cleanup phase lost the admitted-run identity");
  } else if (cleanup.runId !== identity.admittedRunId) {
    err(
      errors,
      "identity-loss",
      "$.cleanup.runId",
      `cleanup.runId ${cleanup.runId} differs from the admitted run ${identity.admittedRunId}; refusing cleanup of fixtures owned by another run`,
    );
  }
  if (!isNonEmptyString(cleanup.rootId)) {
    err(errors, "identity-loss", "$.cleanup.rootId", "cleanup.rootId is missing: the cleanup phase lost the owned-root identity");
  } else if (cleanup.rootId !== identity.rootId) {
    err(
      errors,
      "identity-loss",
      "$.cleanup.rootId",
      `cleanup.rootId ${cleanup.rootId} does not match the plan's owned root ${identity.rootId}; refusing cleanup of an unattributed root`,
    );
  }

  // -- current realpath must STILL equal the admission-time realpath --------
  let currentReal = null;
  let currentError = null;
  try {
    currentReal = realpath(identity.rootReal);
  } catch (e) {
    currentError = e instanceof Error ? e.message : String(e);
  }
  if (currentError !== null) {
    err(
      errors,
      "identity-loss-between-phases",
      "$.cleanup.root",
      `the owned root ${identity.rootReal} is no longer resolvable at cleanup time (${currentError}); refusing any removal — the root identity was lost between the plan phase and the cleanup phase`,
    );
  } else if (currentReal !== identity.rootReal) {
    err(
      errors,
      "identity-loss-between-phases",
      "$.cleanup.root",
      `the owned root now resolves to ${currentReal} but was admitted as ${identity.rootReal}; the root identity changed between phases (symlink substitution or path reuse) — refusing any removal`,
    );
  }

  // -- current OBJECT identity must still equal the admission capture --------
  // A same-path replacement (the directory was removed and recreated by
  // another actor, e.g. dev1/ino101 -> dev1/ino202 at the SAME pathname)
  // keeps every realpath string equal: only the injected object-identity
  // recheck can see it. Re-prove BOTH the root object and the base/ancestor
  // object (the base identity is what pins the owned base of the pre-admitted
  // root) before proposing any removal.
  let currentRootObject = null;
  let currentBaseObject = null;
  let currentObjectError = null;
  try {
    currentRootObject = objectIdentity(identity.rootReal);
    currentBaseObject = objectIdentity(identity.baseReal);
  } catch (e) {
    currentObjectError = e instanceof Error ? e.message : String(e);
  }
  if (currentObjectError !== null) {
    err(
      errors,
      "identity-loss-between-phases",
      "$.cleanup.root",
      `the filesystem object identity of the owned root/base could not be resolved at cleanup time (${currentObjectError}); refusing any removal`,
    );
  } else {
    if (!sameObjectIdentity(currentRootObject, identity.identity.root)) {
      err(
        errors,
        "object-identity-changed",
        "$.cleanup.root",
        `the owned root OBJECT at real path ${identity.rootReal} was replaced between plan admission and cleanup time (admitted ${stableIdentityString(identity.identity.root)}, now ${stableIdentityString(currentRootObject)}); the pathname is unchanged but it is NOT the same filesystem object — refusing any removal. A pure plan-time check does not solve the executor's later check/use race; the executor must re-prove this identity immediately before every removal`,
      );
    }
    if (!sameObjectIdentity(currentBaseObject, identity.identity.base)) {
      err(
        errors,
        "object-identity-changed",
        "$.cleanup.base",
        `the owned base/ancestor OBJECT at real path ${identity.baseReal} was replaced between plan admission and cleanup time (admitted ${stableIdentityString(identity.identity.base)}, now ${stableIdentityString(currentBaseObject)}); refusing any removal of fixtures under a substituted base`,
      );
    }
  }

  // -- plan-admitted fixture identities (relative path -> admission snapshot)
  const admittedFixtureByRelPath = new Map();
  for (const action of Array.isArray(plan.actions) ? plan.actions : []) {
    if (
      typeof action.fixturePath === "string" &&
      action.fixturePath.length > 0 &&
      isIdentitySnapshot(action.fixtureIdentity) &&
      !admittedFixtureByRelPath.has(action.fixturePath)
    ) {
      admittedFixtureByRelPath.set(action.fixturePath, action.fixtureIdentity);
    }
  }

  // -- per-path containment + candidate object re-proof (exact, owned-relative)
  const cleanupPaths = Array.isArray(cleanup.paths) ? cleanup.paths : [];
  if (!Array.isArray(cleanup.paths)) {
    err(errors, "cleanup-shape", "$.cleanup.paths", "cleanup.paths must be an array of owned-relative paths");
  }
  const removals = [];
  if (currentError === null && currentReal === identity.rootReal && currentObjectError === null) {
    for (const [pi, p] of cleanupPaths.entries()) {
      const pPath = `$.cleanup.paths[${pi}]`;
      const lex = checkOwnedRelativePath(p);
      if (!lex.ok) {
        err(errors, "path-escape", pPath, lex.reason);
        continue;
      }
      const joined = `${identity.rootReal}/${p}`;
      let candidateReal = null;
      let candidateError = null;
      try {
        candidateReal = realpath(joined);
      } catch (e) {
        candidateError = e instanceof Error ? e.message : String(e);
      }
      if (candidateError !== null) {
        err(errors, "containment-unresolvable", pPath, `cleanup candidate ${joined} could not be resolved: ${candidateError}`);
        continue;
      }
      if (!isResolvedPathInside(candidateReal, identity.rootReal)) {
        err(
          errors,
          "containment-escape",
          pPath,
          `cleanup candidate resolves to ${candidateReal} which escapes the owned root ${identity.rootReal}; refusing removal`,
        );
        continue;
      }
      let candidateIdentity = null;
      let candidateIdentityError = null;
      try {
        candidateIdentity = objectIdentity(candidateReal);
      } catch (e) {
        candidateIdentityError = e instanceof Error ? e.message : String(e);
      }
      if (candidateIdentityError !== null) {
        err(
          errors,
          "cleanup-candidate-unresolvable",
          pPath,
          `cleanup candidate ${joined} resolved but its object identity could not be re-proven (${candidateIdentityError}); refusing removal`,
        );
        continue;
      }
      // A cleanup path that matches a plan-ADMITTED fixture must still be the
      // SAME object the plan saw at admission (replaced candidate refused).
      const admittedSnapshot = admittedFixtureByRelPath.get(p);
      if (admittedSnapshot !== undefined && !sameObjectIdentity(candidateIdentity, admittedSnapshot)) {
        err(
          errors,
          "cleanup-candidate-replaced",
          pPath,
          `cleanup candidate ${joined} matches plan-admitted fixture "${p}" but its object identity changed since admission (admitted ${stableIdentityString(admittedSnapshot)}, now ${stableIdentityString(candidateIdentity)}); the same relative path is not the same filesystem object — refusing removal`,
        );
        continue;
      }
      removals.push(
        Object.freeze({
          rootId: identity.rootId,
          runId: identity.admittedRunId,
          relativePath: p,
          realPath: candidateReal,
          identity: freezeIdentitySnapshot(candidateIdentity),
          admissionIdentity:
            admittedSnapshot !== undefined ? freezeIdentitySnapshot(admittedSnapshot) : undefined,
          // Executor obligation (recorded, not satisfied here): re-prove the
          // held-root authority AND this candidate's object identity
          // immediately before the actual removal; refuse on any change — a
          // validation-time re-check does not close the executor's later
          // check/use race.
          executorRecheckRequired: true,
          executed: false,
        }),
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    removals: Object.freeze(removals),
    cleanup: Object.freeze({
      rootId: identity.rootId,
      runId: identity.admittedRunId,
      identityRevalidated: true,
      heldRootAuthority: Object.freeze({
        rootReal: identity.rootReal,
        baseReal: identity.baseReal,
        rootIdentity: freezeIdentitySnapshot(identity.identity.root),
        baseIdentity: freezeIdentitySnapshot(identity.identity.base),
      }),
      executed: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// materializeRuntimeSeed — canned-behavior seed for the frozen runtimes
// ---------------------------------------------------------------------------

/**
 * Materialize the behaviors-file seed that the LATER isolated-motor run would
 * hand to the frozen runtime via TAMANDUA_SCRIPTED_BEHAVIORS. The seed is
 * keyed by the action agentId; per-agent entries are laid out one per WORK
 * INVOCATION at their CONTIGUOUS roundIndex (validated plans are contiguous
 * 0..n-1 by construction; an array is consumed one entry per work
 * invocation, last entry repeating on a relaunch overrun). Every entry is a
 * canned scripted behavior that emits the PRESERVED public output text —
 * never shell text, never an evaluated command.
 *
 * The seed NEVER invents an unrecorded work round: validateReplayPlan
 * refuses noncontiguous work-invocation indices, and this function throws
 * rather than fabricate a "STATUS: done" filler for a sparse index (a
 * hand-built plan that bypassed validation gets a loud refusal, not invented
 * successes). `idle_dispatch` actions seed nothing (an idle tick is
 * observed, not scripted). All token accounting is zero.
 *
 * replay.unclaimed_exit behaviors carry the EXACT preserved public stdout
 * bytes as behavior.preservedStdout (including an empty payload or a payload
 * with no final newline); the frozen runtimes' die-before-claim knob writes
 * those bytes verbatim before exiting (see KNOB-REGIONS.md), so the exact
 * specified public bytes reach the observable round stdout — not just the
 * metadata on the recorded descriptor.
 *
 * @param {object} plan  a validated plan (validateReplayPlan ok result).
 * @returns {object} behaviors config + env notes (pure data, executed:false).
 */
export function materializeRuntimeSeed(plan) {
  if (!isPlainObject(plan) || plan.adapterVersion !== REPLAY_ADAPTER_VERSION || !Array.isArray(plan.actions)) {
    throw new TypeError("materializeRuntimeSeed requires a validated replay plan");
  }
  // Work-invoking actions per agent, in roundIndex order. Idle dispatches are
  // observed, not scripted, and never occupy a work-invocation index.
  const byAgent = new Map();
  for (const action of plan.actions) {
    if (action.type === "replay.idle_dispatch") continue; // observed, not scripted
    if (!byAgent.has(action.agentId)) byAgent.set(action.agentId, []);
    byAgent.get(action.agentId).push(action);
  }
  const agents = {};
  for (const [agentId, workActions] of byAgent) {
    workActions.sort((a, b) => a.roundIndex - b.roundIndex);
    const list = [];
    for (let i = 0; i < workActions.length; i += 1) {
      const action = workActions[i];
      if (action.roundIndex !== i) {
        // Defense in depth: validateReplayPlan already refuses noncontiguous
        // indices; a hand-built plan that slipped through must NEVER make the
        // seed fabricate an unrecorded "STATUS: done" success for a gap.
        throw new TypeError(
          `materializeRuntimeSeed refuses to invent an unrecorded work round: agent ${agentId} has ` +
            `noncontiguous roundIndex (expected ${i} at position ${i}, got ${action.roundIndex}); ` +
            "validate the plan with validateReplayPlan first (it refuses noncontiguous work-invocation indices)",
        );
      }
      list.push(seedBehaviorForAction(action));
    }
    agents[agentId] = Object.freeze(list);
  }
  return Object.freeze({
    adapterVersion: REPLAY_ADAPTER_VERSION,
    behaviorsConfig: Object.freeze({ agents: Object.freeze(agents), heartbeatTokens: 0, defaultTokens: 0 }),
    env: Object.freeze({
      behaviorsVar: BEHAVIOR_ENV.behaviors,
      stateVar: BEHAVIOR_ENV.state,
      runtimeBinaryVar: plan.runtime === "pi" ? "TAMANDUA_PI_BINARY" : "TAMANDUA_HERMES_BINARY",
    }),
    runtime: plan.runtime,
    executed: false,
  });
}

/**
 * The canned runtime behavior for one validated work action. Preserved output
 * bytes use the SAME join as the recorded entrypoint descriptor
 * (joinedPreservedText), so the seed can never disagree with the descriptor
 * about the exact bytes. The executor never invents preserved output bytes:
 * a claim action without any preserved observation text is a loud refusal.
 *
 * Semantic-payload trust (US-001): BEFORE any behavior bytes are shaped, the
 * action's preservedOutputTexts payload is validated by
 * preservedPayloadSemanticErrors — every claimed public text must be present
 * and string-typed. A missing or non-string entry is a loud TypeError here
 * (pure materialization; nothing has been written yet), never a silent
 * filter that would fabricate a different byte shape in the canned behavior.
 */
function seedBehaviorForAction(action) {
  const semantic = preservedPayloadSemanticErrors(action);
  if (semantic.length > 0) {
    throw new TypeError(
      `materializeRuntimeSeed refuses a semantically invalid preserved-output payload for ${action.type} action ` +
        `${JSON.stringify(action.id)}: ${semantic.map((e) => `${e.code}@${e.path}`).join(", ")} — ` +
        "validated plans always carry string-typed preservedOutputTexts for claim actions",
    );
  }
  if (action.type === "replay.unclaimed_exit") {
    const behavior = { mode: "die-before-claim" };
    // exitCode was plan-validated as an integer in 0..255 for validated
    // plans; the Number.isInteger guard here is defensive only, so the seed
    // can never diverge from the recorded entrypoint descriptor.
    if (Number.isInteger(action.exitCode)) behavior.exitCode = action.exitCode;
    // Exact preserved public stdout bytes (empty / no-final-newline kept
    // verbatim). The runtime die-before-claim knob writes them to stdout
    // before exiting.
    if (action.preservedOutputTexts && action.preservedOutputTexts.length > 0) {
      behavior.preservedStdout = joinedPreservedText(action.preservedOutputTexts);
    }
    return Object.freeze(behavior);
  }
  if (!action.preservedOutputTexts || action.preservedOutputTexts.length === 0) {
    throw new TypeError(
      `materializeRuntimeSeed refuses to invent preserved output bytes for ${action.type} action ${JSON.stringify(action.id)}; validated plans always carry outputRefs for claim actions`,
    );
  }
  const text = joinedPreservedText(action.preservedOutputTexts);
  if (action.type === "replay.claim_fail") {
    return Object.freeze({
      mode: "work",
      output: `STATUS: failed\nREASON: ${text}`,
      stepAction: "fail",
      failReason: text,
    });
  }
  // replay.claim_complete
  return Object.freeze({ mode: "work", output: text });
}
