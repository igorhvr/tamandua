/**
 * MATCHLOCK-UNION-4 US-014 (bead tamandua-6sy.33.10.37 SCHEMA-COLLISION,
 * tamandua-6sy.33.10.36 MTLK-UNPIN) — deliverable regression for the published
 * union4 contract file.
 *
 * The run deliverable `/home/kaladin/matchlock-work/matchlock-union4-contract.json`
 * lives OUTSIDE the repository on purpose (it is never committed, never placed
 * in the worktree). This file carries the validator the story asks for: a pure
 * `validateMatchlockUnion4Contract(value): string[]` plus always-on unit tests
 * covering the structural contract, and a real-file assertion that defaults to
 * the canonical deliverable path (overridable with
 * `MATCHLOCK_UNION4_CONTRACT_PATH`) and is skipped when that file is absent —
 * so the committed suite never hard-depends on host state.
 *
 * Union4-specific rules enforced here:
 *   - the merge names BOTH parents (main tip + the Matchlock ref) and records
 *     exactly the 65 conflicted files, each with a group and a resolution;
 *   - the single schema chain is v12 with the three guarded steps and the five
 *     starting-state tests (v9, v10 MAIN, v10 MATCHLOCK, v11, already-12);
 *   - the runtime identity is OBSERVED, never pinned: `pinned` must be false and
 *     every focused gate must carry the observed sha256 values it recorded;
 *   - the verdict can only be ready-to-install while every owned VM is
 *     positively closed and the squash hash is left to the merger (story
 *     hashes are never pinned).
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/** The external deliverable published by US-014 (overridable for tests). */
export const DEFAULT_UNION4_CONTRACT_PATH =
  "/home/kaladin/matchlock-work/matchlock-union4-contract.json";

/** The union's single schema chain terminates at v12 (SCHEMA-COLLISION). */
export const UNION4_SCHEMA_VERSION = 12;

/** The three guarded chain steps main + Matchlock collapsed into one chain. */
export const UNION4_SCHEMA_STEPS: readonly { from: number; to: number }[] = [
  { from: 9, to: 10 },
  { from: 10, to: 11 },
  { from: 11, to: 12 },
];

/** Every existing database shape migrate() must bring to v12. */
export const UNION4_STARTING_STATES = [
  "v9",
  "v10-main",
  "v10-matchlock",
  "v11",
  "already-12",
] as const;

/** The exact line every real-VM gate's cleanup ledger must end with. */
export const UNION4_CLEANUP_COMPLETE_LINE =
  "cleanup complete: no owned VM rows/state dirs remain";

/** The exact number of conflicted files `git merge` produced. */
export const UNION4_CONFLICT_COUNT = 65;

/**
 * The 65 conflicted files grouped by file group. Every path must appear in the
 * contract's `merge.conflicts` with its group and a non-empty resolution.
 */
export const REQUIRED_UNION4_CONFLICTS: Record<string, readonly string[]> = {
  docs: [
    "AGENTS.md",
    "README.md",
    "docs/creating-workflows.md",
    "docs/native-signal-isolation.md",
    "skills/tamandua-agents/SKILL.md",
    "tests/MOTOR-CONTRACT.md",
  ],
  schema: ["src/db.ts", "src/db.test.ts"],
  cli: [
    "src/cli/cli.ts",
    "src/cli/cli.test.ts",
    "src/cli/commands/logs.ts",
    "src/cli/commands/logs.test.ts",
    "src/cli/commands/step.test.ts",
    "src/cli/commands/workflow.ts",
    "src/cli/commands/workflow.test.ts",
    "src/cli/workflow-run-args.ts",
    "src/cli/workflow-run-args.test.ts",
  ],
  "scheduler-core": [
    "src/doctor.test.ts",
    "src/installer/agent-scheduler.ts",
    "src/installer/agent-scheduler.test.ts",
    "src/installer/merge-branch.ts",
    "src/installer/run.ts",
    "src/installer/run.test.ts",
    "src/installer/step-ops.ts",
    "src/installer/workflow-spec.test.ts",
  ],
  "harness-and-events": [
    "src/installer/dsh-usage.ts",
    "src/installer/dsh-usage.test.ts",
    "src/installer/events.ts",
    "src/installer/events-vocabulary.test.ts",
    "src/installer/harness-adapter.ts",
    "src/installer/harness-launch.ts",
    "src/installer/harness-launch.test.ts",
    "src/installer/harness-probe.ts",
    "src/installer/harness-probe.test.ts",
    "src/installer/logs-tail-format.ts",
    "src/installer/logs-tail-format.test.ts",
    "src/installer/native-build.test.ts",
  ],
  server: [
    "src/server/control-server.ts",
    "src/server/control-server-harness-workdir.test.ts",
    "src/server/daemonctl.ts",
    "src/server/dashboard.ts",
    "src/server/dashboard.test.ts",
    "src/server/dashboard-standalone.ts",
  ],
  "e2e-tests": [
    "e2e-tests/workflows-drain-verify-pause.test.ts",
    "e2e-tests/workflows-harness-probe.test.ts",
    "e2e-tests/workflows-hermes-canary-real.test.ts",
  ],
  scripts: [
    "run-all-e2e-tests",
    "run-all-scripted-e2e-tests",
    "scripts/build-native.mjs",
  ],
  "test-infra": [
    "tests/cli-workflow-run-working-directory.test.ts",
    "tests/fixtures/invocation-owned-runner.ts",
    "tests/helpers/invocation-owned-cleanup.ts",
    "tests/helpers/invocation-owned-cleanup.test.ts",
    "tests/helpers/test-env.ts",
    "tests/invocation-owned-lifecycle.test.ts",
    "tests/orphaned-step-recovery.test.ts",
    "tests/serial-files.txt",
    "tests/workdir-queue-admission.test.ts",
  ],
  "torture-test": [
    "torture-test/bin/daemon-control",
    "torture-test/bin/tt-process-identity.mjs",
    "torture-test/bin/tt-recorder",
    "torture-test/bin/tt-verify-environment",
    "torture-test/self-tests/tier0-macp5-gnu-ism-sweep.test.ts",
    "torture-test/self-tests/tier1-mcha-tt-chaos-darwin-kill-guard.test.ts",
    "torture-test/self-tests/tier1-tt-recorder-darwin-port-evidence.test.ts",
  ],
};

/** Flattened conflict paths (order-insensitive membership). */
export const REQUIRED_UNION4_CONFLICT_PATHS: readonly string[] =
  Object.values(REQUIRED_UNION4_CONFLICTS).flat();

/** The six focused real-VM gates that must appear under matchlockFocusedGates. */
export const REQUIRED_UNION4_FOCUSED_GATES = [
  "synthetic",
  "hermesSynthetic",
  "worktreeMerge",
  "longHome",
  "emptyOutput",
  "dshReal",
] as const;

/** Every gate label the contract must index: npmTest, e2e, then the six gates. */
export const REQUIRED_UNION4_GATE_LABELS = [
  "A",
  "B",
  "C-1",
  "C-2",
  "C-3",
  "D",
  "E",
  "F",
] as const;

/** The eight gate drivers MTLK-UNPIN stripped of runtime sha256 pins. */
export const REQUIRED_UNION4_UNPIN_DRIVERS = [
  "run-matchlock-synthetic-e2e-test",
  "run-matchlock-dsh-gate-e2e-test",
  "run-matchlock-worktree-merge-e2e-test",
  "run-hermes-synthetic-e2e-test",
  "run-matchlock-long-home-e2e-test",
  "run-matchlock-empty-output-e2e-test",
  "run-matchlock-dsh-real-gate-e2e-test",
  "run-matchlock-dsh-profile-overlay-e2e-test",
] as const;

/** The optional runtime overrides MTLK-UNPIN keeps (never required). */
export const REQUIRED_UNION4_UNPIN_ENV_OVERRIDES = [
  "TAMANDUA_MATCHLOCK_RPC_BIN",
  "MATCHLOCK_GUEST_INIT",
  "MATCHLOCK_GUEST_FUSED",
] as const;

/**
 * Required feature groups and the item names each must carry (acceptance
 * criterion 2/3): the full both-lines feature list now on the branch.
 */
export const REQUIRED_UNION4_FEATURE_GROUPS: Record<string, readonly string[]> = {
  "main-instant-contract": [
    "nowIso",
    "parseInstant",
    "formatInstant",
    "SQL_NOW_ISO",
    "monotonicNow",
    "instantGuard",
  ],
  "main-kernel-identity": [
    "stateDirScoping",
    "dpIdTakeover",
    "identitySocketAlias",
    "isProcfsPath",
  ],
  "main-worker-claims": [
    "workerPidClaim",
    "directModeSweep",
    "pausedKillAccounting",
    "targetMovedReroute",
    "workdirCollisionPolicy",
  ],
  "main-log-and-events": [
    "rerouteBudget",
    "boundedLsof",
    "atomicEventAppend",
    "boundedLogsTail",
  ],
  "matchlock-runner": [
    "matchlockController",
    "mountPlan",
    "guestSuiteTransport",
    "matchlockPolicy",
    "capabilityAdmission",
  ],
  "matchlock-harnesses": [
    "piUnderMatchlock",
    "hermesUnderMatchlock",
    "dshUnderMatchlock",
    "wholeHomeMount",
    "dshFarmSwap",
  ],
  "union4-schema-chain": [
    "schemaVersion12",
    "v9ToV12",
    "v10MainToV12",
    "v10MatchlockToV12",
    "v11ToV12",
    "idempotentGuards",
  ],
  "union4-unpin": [
    "mtlkUnpin",
    "observedRuntimeRecorded",
    "optionalOverrides",
    "noExpectedPins",
  ],
  "union4-merge": [
    "union4MergeCommit",
    "all65ConflictsResolved",
    "bothLinesPreserved",
  ],
  "union4-audit": ["noSessionUrls", "noPinnedStoryHashes", "finalContract"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isHex40(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/**
 * A gate may be pending (exitCode null while later stories run it) or settled
 * (non-"pending" status, which requires a numeric exitCode and non-empty
 * command/logPath). Fields must always be present.
 */
function validateGate(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const field of ["status", "command", "logPath", "exitCode"] as const) {
    if (!(field in value)) {
      errors.push(`${prefix} missing ${field}`);
    }
  }
  const status = value.status;
  if (!isNonEmptyString(status)) {
    errors.push(`${prefix}.status must be a non-empty string`);
    return;
  }
  if (status === "pending") return;
  if (!isNonEmptyString(value.command)) {
    errors.push(`${prefix}.command must be a non-empty string once settled`);
  }
  if (!isNonEmptyString(value.logPath)) {
    errors.push(`${prefix}.logPath must be a non-empty string once settled`);
  }
  if (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode)) {
    errors.push(`${prefix}.exitCode must be an integer once settled`);
  }
}

function validateGateIndex(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("gateIndex must be an array");
    return;
  }
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) {
      errors.push(`gateIndex[${index}] must be an object`);
      continue;
    }
    if (!isNonEmptyString(raw.label)) {
      errors.push(`gateIndex[${index}].label must be a non-empty string`);
      continue;
    }
    if (seen.has(raw.label)) {
      errors.push(`duplicate gateIndex label '${raw.label}'`);
    }
    seen.add(raw.label);
    for (const field of ["name", "key", "command", "logPath", "status"] as const) {
      if (!isNonEmptyString(raw[field])) {
        errors.push(`gateIndex '${raw.label}'.${field} must be a non-empty string`);
      }
    }
    if (typeof raw.exitCode !== "number" || !Number.isInteger(raw.exitCode)) {
      errors.push(`gateIndex '${raw.label}'.exitCode must be an integer`);
    }
  }
  for (const label of REQUIRED_UNION4_GATE_LABELS) {
    if (!seen.has(label)) {
      errors.push(`gateIndex missing required label '${label}'`);
    }
  }
}

/**
 * A settled focused gate must prove positive VM closure: real VMs were created,
 * every one was positively closed, and the cleanup ledger path is recorded.
 */
function validateFocusedGate(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) return;
  const status = value.status;
  if (status === "pending") return;
  if (!isPositiveInt(value.vmsCreated)) {
    errors.push(`${prefix}.vmsCreated must be a positive integer once settled`);
  }
  if (value.vmsPositivelyClosed !== value.vmsCreated) {
    errors.push(`${prefix}.vmsPositivelyClosed must equal vmsCreated`);
  }
  if (!isNonEmptyString(value.cleanupEvidencePath)) {
    errors.push(`${prefix}.cleanupEvidencePath must be a non-empty string`);
  }
  if (!isNonEmptyString(value.cleanupCompleteLine)) {
    errors.push(`${prefix}.cleanupCompleteLine must be non-empty`);
  } else if (!value.cleanupCompleteLine.endsWith(UNION4_CLEANUP_COMPLETE_LINE)) {
    errors.push(`${prefix}.cleanupCompleteLine must end with the canonical cleanup line`);
  }
}

/** MTLK-UNPIN: observed, never pinned. */
function validateRuntimeObservation(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("runtimeObservation must be an object");
    return;
  }
  if (value.pinned !== false) {
    errors.push("runtimeObservation.pinned must be false (MTLK-UNPIN: observed, never pinned)");
  }
  if (!isNonEmptyString(value.resolvedVia)) {
    errors.push("runtimeObservation.resolvedVia must be a non-empty string");
  }
  if (!isNonEmptyString(value.version)) {
    errors.push("runtimeObservation.version must be a non-empty string");
  }
  for (const field of ["matchlockSha256", "guestInitSha256", "guestFusedSha256"] as const) {
    if (!isHex64(value[field])) {
      errors.push(`runtimeObservation.${field} must be an observed 64-char hex digest`);
    }
  }
  if (!isNonEmptyString(value.hashFile)) {
    errors.push("runtimeObservation.hashFile must name the per-gate observed-runtime file");
  }
  if (!isPositiveInt(value.observedGateCount)) {
    errors.push("runtimeObservation.observedGateCount must be positive");
  }

  const perGate = value.perGate;
  if (!isRecord(perGate)) {
    errors.push("runtimeObservation.perGate must be an object");
    return;
  }
  for (const key of REQUIRED_UNION4_FOCUSED_GATES) {
    const gate = perGate[key];
    if (!isRecord(gate)) {
      errors.push(`runtimeObservation.perGate.${key} must be an object`);
      continue;
    }
    if (gate.pinned !== false) {
      errors.push(`runtimeObservation.perGate.${key}.pinned must be false`);
    }
    if (!isNonEmptyString(gate.evidenceDir)) {
      errors.push(`runtimeObservation.perGate.${key}.evidenceDir must be a non-empty string`);
    }
    if (gate.hashFile !== value.hashFile) {
      errors.push(`runtimeObservation.perGate.${key}.hashFile must match the observed hash file`);
    }
    for (const field of ["matchlockSha256", "guestInitSha256"] as const) {
      if (gate[field] !== value[field]) {
        errors.push(`runtimeObservation.perGate.${key}.${field} must equal the observed digest`);
      }
    }
  }
}

/** SCHEMA-COLLISION: one v12 chain with five starting-state tests. */
function validateSchemaChain(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("schemaChain must be an object");
    return;
  }
  if (value.version !== UNION4_SCHEMA_VERSION) {
    errors.push(`schemaChain.version must be ${UNION4_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.lineageDetection)) {
    errors.push("schemaChain.lineageDetection must be a non-empty string");
  }
  if (!isNonEmptyString(value.testFile)) {
    errors.push("schemaChain.testFile must be a non-empty string");
  }
  if (!isNonEmptyString(value.testCommand)) {
    errors.push("schemaChain.testCommand must be a non-empty string");
  }

  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length !== UNION4_SCHEMA_STEPS.length) {
    errors.push(`schemaChain.steps must list exactly ${UNION4_SCHEMA_STEPS.length} chain steps`);
  } else {
    for (const [index, expected] of UNION4_SCHEMA_STEPS.entries()) {
      const step = steps[index];
      if (!isRecord(step)) {
        errors.push(`schemaChain.steps[${index}] must be an object`);
        continue;
      }
      if (step.from !== expected.from || step.to !== expected.to) {
        errors.push(
          `schemaChain.steps[${index}] must be ${expected.from} -> ${expected.to}`,
        );
      }
      if (!isNonEmptyString(step.change)) {
        errors.push(`schemaChain.steps[${index}].change must be a non-empty string`);
      }
      if (!isNonEmptyString(step.guard)) {
        errors.push(`schemaChain.steps[${index}].guard must be a non-empty string`);
      }
    }
  }

  const states = value.startingStates;
  if (!Array.isArray(states)) {
    errors.push("schemaChain.startingStates must be an array");
  } else {
    const seen = new Set<string>();
    for (const [index, raw] of states.entries()) {
      if (!isRecord(raw)) {
        errors.push(`schemaChain.startingStates[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(raw.state)) {
        errors.push(`schemaChain.startingStates[${index}].state must be a non-empty string`);
        continue;
      }
      if (seen.has(raw.state)) {
        errors.push(`duplicate schemaChain.startingState '${raw.state}'`);
      }
      seen.add(raw.state);
      if (!isNonEmptyString(raw.testName)) {
        errors.push(`schemaChain.startingStates '${raw.state}' must name its test`);
      }
      if (!isNonEmptyString(raw.expectation)) {
        errors.push(`schemaChain.startingStates '${raw.state}' must state its expectation`);
      }
    }
    for (const state of UNION4_STARTING_STATES) {
      if (!seen.has(state)) {
        errors.push(`schemaChain.startingStates missing required state '${state}'`);
      }
    }
  }

  const result = value.testResult;
  if (!isRecord(result)) {
    errors.push("schemaChain.testResult must be an object");
  } else {
    if (!isPositiveInt(result.tests)) {
      errors.push("schemaChain.testResult.tests must be positive");
    }
    if (typeof result.pass !== "number" || result.pass !== result.tests) {
      errors.push("schemaChain.testResult.pass must equal tests");
    }
    if (result.fail !== 0) {
      errors.push("schemaChain.testResult.fail must be 0");
    }
  }
}

/** MTLK-UNPIN: the eight drivers and their optional overrides. */
function validateUnpin(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("unpin must be an object");
    return;
  }
  if (value.pinned !== false) {
    errors.push("unpin.pinned must be false");
  }
  if (!isNonEmptyString(value.contract)) {
    errors.push("unpin.contract must name the bead");
  }
  if (!isNonEmptyString(value.resolution)) {
    errors.push("unpin.resolution must describe PATH resolution");
  }
  if (value.observedFile !== "runtime-observed.txt") {
    errors.push('unpin.observedFile must be "runtime-observed.txt"');
  }

  const drivers = value.drivers;
  if (!isStringArray(drivers)) {
    errors.push("unpin.drivers must be an array of strings");
  } else {
    for (const driver of REQUIRED_UNION4_UNPIN_DRIVERS) {
      if (!drivers.includes(driver)) {
        errors.push(`unpin.drivers missing '${driver}'`);
      }
    }
  }

  const overrides = value.envOverrides;
  if (!isStringArray(overrides)) {
    errors.push("unpin.envOverrides must be an array of strings");
  } else {
    for (const name of REQUIRED_UNION4_UNPIN_ENV_OVERRIDES) {
      if (!overrides.includes(name)) {
        errors.push(`unpin.envOverrides missing '${name}'`);
      }
    }
  }

  const removed = value.removedConstants;
  if (!isStringArray(removed)) {
    errors.push("unpin.removedConstants must be an array of strings");
  } else {
    for (const constant of ["EXPECTED_MATCHLOCK", "EXPECTED_GUEST_INIT", "RUNTIME_DIR_DEFAULT"]) {
      if (!removed.includes(constant)) {
        errors.push(`unpin.removedConstants missing '${constant}'`);
      }
    }
  }

  const unpinResult = value.testResult;
  if (!isRecord(unpinResult) || !isPositiveInt(unpinResult.tests)) {
    errors.push("unpin.testResult.tests must be positive");
  }
}

/** VM lifecycle: every gate's owned VMs positively closed. */
function validateVmLifecycle(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("vmLifecycle must be an object");
    return;
  }
  if (value.allOwnedVmsClosed !== true) {
    errors.push("vmLifecycle.allOwnedVmsClosed must be true");
  }
  if (value.noOwnedVmsRemain !== true) {
    errors.push("vmLifecycle.noOwnedVmsRemain must be true");
  }
  const gates = value.gates;
  if (!isRecord(gates)) {
    errors.push("vmLifecycle.gates must be an object");
    return;
  }
  let totalCreated = 0;
  let totalClosed = 0;
  for (const key of REQUIRED_UNION4_FOCUSED_GATES) {
    const gate = gates[key];
    if (!isRecord(gate)) {
      errors.push(`vmLifecycle.gates.${key} must be an object`);
      continue;
    }
    if (!isPositiveInt(gate.vmsCreated)) {
      errors.push(`vmLifecycle.gates.${key}.vmsCreated must be positive`);
    }
    if (gate.vmsPositivelyClosed !== gate.vmsCreated) {
      errors.push(`vmLifecycle.gates.${key}.vmsPositivelyClosed must equal vmsCreated`);
    }
    if (!isNonEmptyString(gate.cleanupCompleteLine)) {
      errors.push(`vmLifecycle.gates.${key}.cleanupCompleteLine must be non-empty`);
    } else if (!gate.cleanupCompleteLine.endsWith(UNION4_CLEANUP_COMPLETE_LINE)) {
      errors.push(`vmLifecycle.gates.${key}.cleanupCompleteLine must end with the canonical line`);
    }
    if (!isNonEmptyString(gate.cleanupEvidencePath)) {
      errors.push(`vmLifecycle.gates.${key}.cleanupEvidencePath must be non-empty`);
    }
    if (isPositiveInt(gate.vmsCreated)) totalCreated += gate.vmsCreated;
    if (isPositiveInt(gate.vmsPositivelyClosed)) totalClosed += gate.vmsPositivelyClosed;
  }
  const totals = value.totals;
  if (!isRecord(totals)) {
    errors.push("vmLifecycle.totals must be an object");
  } else {
    if (totals.vmsCreated !== totalCreated) {
      errors.push("vmLifecycle.totals.vmsCreated must equal the per-gate sum");
    }
    if (totals.vmsPositivelyClosed !== totalClosed) {
      errors.push("vmLifecycle.totals.vmsPositivelyClosed must equal the per-gate sum");
    }
  }
}

/** The final both-lines audit. */
function validateAudit(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("audit must be an object");
    return;
  }
  if (!isNonEmptyString(value.command)) {
    errors.push("audit.command must be a non-empty string");
  }
  if (!isHex40(value.mergeCommitAudited)) {
    errors.push("audit.mergeCommitAudited must be the audited merge commit hash");
  }
  if (!isPositiveInt(value.storyCommitCount)) {
    errors.push("audit.storyCommitCount must be positive");
  }
  if (value.sessionUrlsFound !== false) {
    errors.push("audit.sessionUrlsFound must be false (no Claude/session URLs)");
  }
  if (!isStringArray(value.sessionUrlMatches) || value.sessionUrlMatches.length !== 0) {
    errors.push("audit.sessionUrlMatches must be an empty array");
  }
  if (value.pinnedStoryHashesFound !== false) {
    errors.push("audit.pinnedStoryHashesFound must be false (story hashes never pinned)");
  }
  if (!isStringArray(value.pinnedStoryHashMatches) || value.pinnedStoryHashMatches.length !== 0) {
    errors.push("audit.pinnedStoryHashMatches must be an empty array");
  }
  if (value.conflictMarkersInTrackedFiles !== false) {
    errors.push("audit.conflictMarkersInTrackedFiles must be false");
  }
  if (value.conflictedFileCount !== UNION4_CONFLICT_COUNT) {
    errors.push(`audit.conflictedFileCount must be ${UNION4_CONFLICT_COUNT}`);
  }
}

/**
 * Validate an already-parsed union4 contract value. Returns a list of
 * human-readable problems; an empty list means the contract is complete.
 */
export function validateMatchlockUnion4Contract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["contract must be a JSON object"];
  }
  if (!isNonEmptyString(value.schema) || !value.schema.startsWith("matchlock-union4-contract/")) {
    errors.push("schema must be a string starting with 'matchlock-union4-contract/'");
  }
  if (!isNonEmptyString(value.generatedAt)) {
    errors.push("generatedAt must be a non-empty string");
  }
  if (!isNonEmptyString(value.noFakeGreen)) {
    errors.push("noFakeGreen must be a non-empty string");
  }

  // ---- run ----
  const run = value.run;
  if (!isRecord(run)) {
    errors.push("run must be an object");
  } else {
    for (const field of [
      "runId",
      "repo",
      "branch",
      "headCommit",
      "integrationBranch",
      "baseCommit",
    ] as const) {
      if (!isNonEmptyString(run[field])) {
        errors.push(`run.${field} must be a non-empty string`);
      }
    }
  }

  // ---- merge (acceptance criterion 2) ----
  const merge = value.merge;
  if (!isRecord(merge)) {
    errors.push("merge must be an object");
  } else {
    for (const field of [
      "inputRef",
      "inputCommit",
      "matchlockCommit",
      "mergeBase",
      "mergeCommit",
      "mergeMessage",
    ] as const) {
      if (!isNonEmptyString(merge[field])) {
        errors.push(`merge.${field} must be a non-empty string`);
      }
    }
    if (!isStringArray(merge.parents) || merge.parents.length !== 2) {
      errors.push("merge.parents must be an array of exactly 2 non-empty strings");
    } else {
      if (!merge.parents.every((parent) => isNonEmptyString(parent))) {
        errors.push("merge.parents entries must be non-empty strings");
      }
      if (isNonEmptyString(merge.inputCommit) && !merge.parents.includes(merge.inputCommit)) {
        errors.push("merge.parents must include the main tip (inputCommit)");
      }
      if (
        isNonEmptyString(merge.matchlockCommit) &&
        !merge.parents.includes(merge.matchlockCommit)
      ) {
        errors.push("merge.parents must include the Matchlock tip (matchlockCommit)");
      }
    }
    if (merge.conflictCount !== UNION4_CONFLICT_COUNT) {
      errors.push(`merge.conflictCount must be ${UNION4_CONFLICT_COUNT}`);
    }

    if (!Array.isArray(merge.conflicts)) {
      errors.push("merge.conflicts must be an array");
    } else {
      const seen = new Set<string>();
      for (const [index, rawConflict] of merge.conflicts.entries()) {
        if (!isRecord(rawConflict)) {
          errors.push(`merge.conflicts[${index}] must be an object`);
          continue;
        }
        if (!isNonEmptyString(rawConflict.path)) {
          errors.push(`merge.conflicts[${index}].path must be a non-empty string`);
          continue;
        }
        const path = rawConflict.path;
        if (seen.has(path)) {
          errors.push(`duplicate conflict path '${path}'`);
        }
        seen.add(path);
        if (!isNonEmptyString(rawConflict.resolution)) {
          errors.push(`merge.conflicts '${path}' missing resolution text`);
        }
        const expectedGroup = requiredGroupForPath(path);
        if (expectedGroup === null) {
          errors.push(`merge.conflicts has unexpected path '${path}'`);
        } else if (rawConflict.group !== expectedGroup) {
          errors.push(
            `merge.conflicts '${path}' group must be '${expectedGroup}', got '${String(rawConflict.group)}'`,
          );
        }
      }
      if (seen.size !== UNION4_CONFLICT_COUNT) {
        errors.push(
          `merge.conflicts must list ${UNION4_CONFLICT_COUNT} distinct paths, got ${seen.size}`,
        );
      }
      for (const required of REQUIRED_UNION4_CONFLICT_PATHS) {
        if (!seen.has(required)) {
          errors.push(`merge.conflicts missing required path '${required}'`);
        }
      }
    }
  }

  // ---- schemaChain (acceptance criterion 2/3) ----
  validateSchemaChain(value.schemaChain, errors);

  // ---- unpin (acceptance criterion 2/3) ----
  validateUnpin(value.unpin, errors);

  // ---- features ----
  if (!Array.isArray(value.features)) {
    errors.push("features must be an array");
  } else {
    const groupItems = new Map<string, Set<string>>();
    for (const [index, rawGroup] of value.features.entries()) {
      if (!isRecord(rawGroup)) {
        errors.push(`features[${index}] must be an object`);
        continue;
      }
      const group = rawGroup.group;
      if (!isNonEmptyString(group)) {
        errors.push(`features[${index}].group must be a non-empty string`);
        continue;
      }
      if (groupItems.has(group)) {
        errors.push(`duplicate feature group '${group}'`);
      }
      const names = new Set<string>();
      if (!Array.isArray(rawGroup.items)) {
        errors.push(`feature group '${group}' items must be an array`);
      } else {
        for (const [itemIndex, rawItem] of rawGroup.items.entries()) {
          if (!isRecord(rawItem)) {
            errors.push(`feature group '${group}' item[${itemIndex}] must be an object`);
            continue;
          }
          if (!isNonEmptyString(rawItem.name)) {
            errors.push(`feature group '${group}' item[${itemIndex}].name must be non-empty`);
            continue;
          }
          if (!isNonEmptyString(rawItem.description)) {
            errors.push(
              `feature group '${group}' item '${rawItem.name}'.description must be non-empty`,
            );
          }
          if (names.has(rawItem.name)) {
            errors.push(`duplicate feature item '${rawItem.name}' in group '${group}'`);
          }
          names.add(rawItem.name);
        }
      }
      groupItems.set(group, names);
    }
    for (const [group, requiredItems] of Object.entries(REQUIRED_UNION4_FEATURE_GROUPS)) {
      const names = groupItems.get(group);
      if (!names) {
        errors.push(`features missing required group '${group}'`);
        continue;
      }
      for (const item of requiredItems) {
        if (!names.has(item)) {
          errors.push(`features group '${group}' missing item '${item}'`);
        }
      }
    }
  }

  // ---- gateIndex ----
  validateGateIndex(value.gateIndex, errors);

  // ---- gates ----
  const gates = value.gates;
  if (!isRecord(gates)) {
    errors.push("gates must be an object");
  } else {
    validateGate(gates.npmTest, "gates.npmTest", errors);
    validateGate(gates.runAllE2eTests, "gates.runAllE2eTests", errors);

    const runAll = gates.runAllE2eTests;
    if (isRecord(runAll) && runAll.status !== "pending") {
      if (!isStringArray(runAll.failingFiles) || runAll.failingFiles.length !== 0) {
        errors.push("gates.runAllE2eTests.failingFiles must be empty once settled green");
      }
      if (runAll.classification !== "green") {
        errors.push('gates.runAllE2eTests.classification must be "green"');
      }
    }

    const focused = gates.matchlockFocusedGates;
    if (!isRecord(focused)) {
      errors.push("gates.matchlockFocusedGates must be an object");
    } else {
      for (const key of REQUIRED_UNION4_FOCUSED_GATES) {
        validateGate(focused[key], `gates.matchlockFocusedGates.${key}`, errors);
        validateFocusedGate(focused[key], `gates.matchlockFocusedGates.${key}`, errors);
      }
      const dshReal = focused.dshReal;
      if (isRecord(dshReal) && dshReal.status !== "pending") {
        if (dshReal.runsTokensSpent !== dshReal.v3StoreTotal) {
          errors.push("gates.matchlockFocusedGates.dshReal token reconciliation must match");
        }
      }
    }
  }

  // ---- runtimeObservation (acceptance criterion 3: observed, not pinned) ----
  validateRuntimeObservation(value.runtimeObservation, errors);

  // ---- vmLifecycle (acceptance criterion 3) ----
  validateVmLifecycle(value.vmLifecycle, errors);

  // ---- audit (acceptance criterion 5) ----
  validateAudit(value.audit, errors);

  // ---- verdict ----
  const verdict = value.verdict;
  if (!isRecord(verdict)) {
    errors.push("verdict must be an object");
  } else {
    if (typeof verdict.readyToInstallOnVaimetal !== "boolean") {
      errors.push("verdict.readyToInstallOnVaimetal must be a boolean");
    }
    if (!isNonEmptyString(verdict.integrationBranch)) {
      errors.push("verdict.integrationBranch must be a non-empty string");
    }
    if (!isNonEmptyString(verdict.candidateHeadNote)) {
      errors.push("verdict.candidateHeadNote must be a non-empty string");
    }
    if (!isNonEmptyString(verdict.candidateHead)) {
      errors.push("verdict.candidateHead must be a non-empty string");
    }
    const squash = verdict.squash;
    if (!isRecord(squash)) {
      errors.push("verdict.squash must be an object");
    } else {
      if (squash.hash !== null && !isHex40(squash.hash)) {
        errors.push("verdict.squash.hash must be null at publish time or a 40-char hex squash");
      }
      if (squash.pinsStoryHashes !== false) {
        errors.push("verdict.squash.pinsStoryHashes must be false");
      }
      if (!isNonEmptyString(squash.subject)) {
        errors.push("verdict.squash.subject must be a non-empty string");
      }
      if (!isNonEmptyString(squash.author)) {
        errors.push("verdict.squash.author must be a non-empty string");
      }
      if (!isNonEmptyString(squash.capturedBy)) {
        errors.push("verdict.squash.capturedBy must name who records the final hash");
      }
    }
    if (verdict.readyToInstallOnVaimetal === true) {
      if (isRecord(value.vmLifecycle) && value.vmLifecycle.allOwnedVmsClosed !== true) {
        errors.push(
          "verdict.readyToInstallOnVaimetal cannot be true while vmLifecycle.allOwnedVmsClosed is not true",
        );
      }
    } else if (!isNonEmptyString(verdict.blockingGate)) {
      errors.push("verdict.blockingGate must name the blocking gate when not ready");
    }
  }

  return errors;
}

/** Find the group a required conflict path belongs to (null when unknown). */
export function requiredGroupForPath(path: string): string | null {
  for (const [group, paths] of Object.entries(REQUIRED_UNION4_CONFLICTS)) {
    if (paths.includes(path)) return group;
  }
  return null;
}

/** A settled gate object with no VM-lifecycle fields. */
function settledGateOnly(): Record<string, unknown> {
  return { status: "green", command: "c", logPath: "l", exitCode: 0 };
}

/** A settled focused real-VM gate carrying positive closure. */
function settledFocusedGate(key: string): Record<string, unknown> {
  return {
    ...settledGateOnly(),
    vmsCreated: 1,
    vmsPositivelyClosed: 1,
    cleanupEvidencePath: `/evidence/${key}/vm-cleanup-ledger.txt`,
    cleanupCompleteLine: UNION4_CLEANUP_COMPLETE_LINE,
  };
}

const OBSERVED_SHA = "fde4d1b1f701429d68f3dfaf783fb413e3ca6565f4c3aa18c5693825951ab3f0";
const GUEST_SHA = "20d1a57de015e69ef5d7bb0b219066a0912a7890f226b8adb23906b28e91af9f";

/** Minimal contract shape that validateMatchlockUnion4Contract must accept. */
function buildMinimalValidContract(): Record<string, unknown> {
  const featureGroups = Object.entries(REQUIRED_UNION4_FEATURE_GROUPS).map(
    ([group, items]) => ({
      group,
      items: items.map((name) => ({ name, description: `feature ${name}` })),
    }),
  );
  const gateIndex = REQUIRED_UNION4_GATE_LABELS.map((label) => ({
    label,
    name: `gate ${label}`,
    key: `gates.${label}`,
    command: `run gate ${label}`,
    exitCode: 0,
    logPath: `/evidence/${label}.log`,
    status: "green",
  }));
  const perGate = Object.fromEntries(
    REQUIRED_UNION4_FOCUSED_GATES.map((key) => [
      key,
      {
        pinned: false,
        evidenceDir: `/evidence/${key}`,
        hashFile: "runtime-observed.txt",
        matchlockSha256: OBSERVED_SHA,
        guestInitSha256: GUEST_SHA,
      },
    ]),
  );
  const mergeCommit = "c0ae3833053cc30fcfd21982b78dc4d08f8ba775";
  return {
    schema: "matchlock-union4-contract/1",
    generatedAt: "2026-09-17T00:00:00Z",
    noFakeGreen: "every gate was run for real; the observed runtime is recorded, never pinned",
    run: {
      runId: "r",
      repo: "/repo",
      branch: "b",
      headCommit: "c49b2041",
      integrationBranch: "integration/union-20260916",
      baseCommit: "5d307302",
    },
    merge: {
      inputRef: "refs/heads/integration/union-20260916",
      inputCommit: "5d307302df675e6a76b1bef9dffa9badbb22958f",
      matchlockCommit: "434771eb1aeadd0403968e6918e8c2c857f37c92",
      mergeBase: "12c53f59",
      mergeCommit,
      mergeMessage: "merge: Matchlock harness rounds union4 (434771eb) into main 5d307302",
      parents: ["5d307302df675e6a76b1bef9dffa9badbb22958f", "434771eb1aeadd0403968e6918e8c2c857f37c92"],
      conflictCount: UNION4_CONFLICT_COUNT,
      conflicts: REQUIRED_UNION4_CONFLICT_PATHS.map((path) => ({
        path,
        group: requiredGroupForPath(path),
        resolution: `resolved ${path}`,
      })),
    },
    schemaChain: {
      version: UNION4_SCHEMA_VERSION,
      lineageDetection: "PRAGMA table_info disambiguates v10 MAIN vs v10 MATCHLOCK",
      testFile: "src/db.test.ts",
      testCommand: "node --test src/db.test.ts",
      steps: UNION4_SCHEMA_STEPS.map((step, index) => ({
        from: step.from,
        to: step.to,
        change: `change ${index}`,
        guard: `guard ${index}`,
      })),
      startingStates: UNION4_STARTING_STATES.map((state) => ({
        state,
        testName: `test ${state}`,
        expectation: `expectation ${state}`,
      })),
      testResult: { tests: 110, pass: 110, fail: 0 },
    },
    unpin: {
      contract: "tamandua-6sy.33.10.36",
      pinned: false,
      resolution: "TAMANDUA_MATCHLOCK_RPC_BIN or command -v matchlock",
      observedFile: "runtime-observed.txt",
      drivers: [...REQUIRED_UNION4_UNPIN_DRIVERS],
      envOverrides: [...REQUIRED_UNION4_UNPIN_ENV_OVERRIDES],
      removedConstants: ["EXPECTED_MATCHLOCK", "EXPECTED_GUEST_INIT", "RUNTIME_DIR_DEFAULT"],
      testResult: { tests: 36, pass: 36, fail: 0 },
    },
    features: featureGroups,
    gateIndex,
    gates: {
      npmTest: { ...settledGateOnly(), classification: "green" },
      runAllE2eTests: { ...settledGateOnly(), classification: "green", failingFiles: [] },
      matchlockFocusedGates: Object.fromEntries(
        REQUIRED_UNION4_FOCUSED_GATES.map((key) => [
          key,
          { ...settledFocusedGate(key), runtimeObservedSha256: OBSERVED_SHA },
        ]),
      ),
    },
    runtimeObservation: {
      pinned: false,
      resolvedVia: "PATH (command -v matchlock)",
      version: "matchlock version 0.2.17",
      matchlockSha256: OBSERVED_SHA,
      guestInitSha256: GUEST_SHA,
      guestFusedSha256: GUEST_SHA,
      hashFile: "runtime-observed.txt",
      observedGateCount: REQUIRED_UNION4_FOCUSED_GATES.length,
      perGate,
    },
    vmLifecycle: {
      allOwnedVmsClosed: true,
      noOwnedVmsRemain: true,
      gates: Object.fromEntries(
        REQUIRED_UNION4_FOCUSED_GATES.map((key) => [
          key,
          {
            vmsCreated: 1,
            vmsPositivelyClosed: 1,
            cleanupEvidencePath: `/evidence/${key}/vm-cleanup-ledger.txt`,
            cleanupCompleteLine: UNION4_CLEANUP_COMPLETE_LINE,
          },
        ]),
      ),
      totals: { vmsCreated: REQUIRED_UNION4_FOCUSED_GATES.length, vmsPositivelyClosed: REQUIRED_UNION4_FOCUSED_GATES.length },
    },
    audit: {
      command: "git log --format=%B",
      mergeCommitAudited: mergeCommit,
      storyCommitCount: 1,
      sessionUrlsFound: false,
      sessionUrlMatches: [],
      pinnedStoryHashesFound: false,
      pinnedStoryHashMatches: [],
      conflictMarkersInTrackedFiles: false,
      conflictedFileCount: UNION4_CONFLICT_COUNT,
    },
    verdict: {
      readyToInstallOnVaimetal: true,
      candidateHead: mergeCommit,
      candidateHeadNote: "the merger squash hash is captured after finalize_merge; story hashes are never pinned",
      integrationBranch: "integration/union-20260916",
      squash: {
        hash: null,
        pinsStoryHashes: false,
        subject: "feat: Matchlock-backed harness rounds (pi/hermes/dsh in VMs) on main",
        author: "Tamandua <tamandua@tetradactyla.org>",
        capturedBy: "coordinator after finalize_merge",
      },
    },
  };
}

/** Deep clone via JSON so each test starts from a pristine contract. */
function cloneContract(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildMinimalValidContract())) as Record<string, unknown>;
}

describe("Matchlock union4 contract validator (US-014)", () => {
  it("accepts a complete minimal contract", () => {
    assert.deepEqual(validateMatchlockUnion4Contract(buildMinimalValidContract()), []);
  });

  it("rejects a non-object contract", () => {
    assert.deepEqual(validateMatchlockUnion4Contract("nope"), ["contract must be a JSON object"]);
  });

  it("rejects a wrong schema prefix", () => {
    const contract = cloneContract();
    contract.schema = "matchlock-union3-contract/1";
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("schema must be a string starting with")),
      `expected a schema error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires both merge parents and the main/Matchlock tips", () => {
    const contract = cloneContract();
    const merge = contract.merge as Record<string, unknown>;
    merge.parents = [merge.inputCommit];
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("exactly 2")),
      `expected a parents-length error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a wrong conflict count", () => {
    const contract = cloneContract();
    (contract.merge as Record<string, unknown>).conflictCount = 64;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes(`must be ${UNION4_CONFLICT_COUNT}`)),
      `expected a conflictCount error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a missing required conflict path", () => {
    const contract = cloneContract();
    const merge = contract.merge as Record<string, unknown>;
    merge.conflicts = (merge.conflicts as Array<Record<string, unknown>>).filter(
      (entry) => entry.path !== "src/db.ts",
    );
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("missing required path 'src/db.ts'")),
      `expected a missing-path error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a conflict with an empty resolution", () => {
    const contract = cloneContract();
    const merge = contract.merge as Record<string, unknown>;
    (merge.conflicts as Array<Record<string, unknown>>)[0].resolution = "";
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("missing resolution text")),
      `expected a resolution error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a conflict assigned to the wrong group", () => {
    const contract = cloneContract();
    const merge = contract.merge as Record<string, unknown>;
    (merge.conflicts as Array<Record<string, unknown>>)[0].group = "not-a-group";
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("group must be")),
      `expected a group error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a duplicate conflict path", () => {
    const contract = cloneContract();
    const merge = contract.merge as Record<string, unknown>;
    const conflicts = merge.conflicts as Array<Record<string, unknown>>;
    conflicts.push({ ...conflicts[0] });
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("duplicate conflict path")),
      `expected a duplicate error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires the v12 schema chain and all three guarded steps", () => {
    const contract = cloneContract();
    const chain = contract.schemaChain as Record<string, unknown>;
    chain.version = 11;
    chain.steps = (chain.steps as unknown[]).slice(0, 2);
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(errors.some((error) => error.includes("schemaChain.version must be 12")));
    assert.ok(errors.some((error) => error.includes("chain steps")));
  });

  it("requires the five starting-state migration tests", () => {
    const contract = cloneContract();
    const chain = contract.schemaChain as Record<string, unknown>;
    chain.startingStates = (chain.startingStates as unknown[]).filter(
      (entry) => (entry as Record<string, unknown>).state !== "v10-matchlock",
    );
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("missing required state 'v10-matchlock'")),
      `expected a starting-state error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires the unpinned resolution to remove the expected pins", () => {
    const contract = cloneContract();
    const unpin = contract.unpin as Record<string, unknown>;
    unpin.pinned = true;
    unpin.removedConstants = [];
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(errors.some((error) => error.includes("unpin.pinned must be false")));
    assert.ok(errors.some((error) => error.includes("missing 'EXPECTED_MATCHLOCK'")));
  });

  it("requires all eight unpin gate drivers and the three overrides", () => {
    const contract = cloneContract();
    const unpin = contract.unpin as Record<string, unknown>;
    unpin.drivers = ["run-matchlock-synthetic-e2e-test"];
    unpin.envOverrides = ["TAMANDUA_MATCHLOCK_RPC_BIN"];
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("unpin.drivers missing")),
      `expected a driver error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("unpin.envOverrides missing 'MATCHLOCK_GUEST_INIT'")),
      `expected an override error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a pinned runtime observation", () => {
    const contract = cloneContract();
    const observation = contract.runtimeObservation as Record<string, unknown>;
    observation.pinned = true;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("runtimeObservation.pinned must be false")),
      `expected a pinned error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a placeholder (non-hex) observed runtime digest", () => {
    const contract = cloneContract();
    const observation = contract.runtimeObservation as Record<string, unknown>;
    observation.matchlockSha256 = "PINNED";
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("matchlockSha256 must be an observed")),
      `expected a digest error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires every focused gate to carry its own observed hash", () => {
    const contract = cloneContract();
    const observation = contract.runtimeObservation as Record<string, unknown>;
    const perGate = observation.perGate as Record<string, Record<string, unknown>>;
    perGate.dshReal.guestInitSha256 = "deadbeef";
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("perGate.dshReal.guestInitSha256")),
      `expected a per-gate digest error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a focused gate that pins its runtime", () => {
    const contract = cloneContract();
    const observation = contract.runtimeObservation as Record<string, unknown>;
    const perGate = observation.perGate as Record<string, Record<string, unknown>>;
    perGate.synthetic.pinned = true;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("perGate.synthetic.pinned must be false")),
      `expected a per-gate pin error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires each gate label in the gate index", () => {
    const contract = cloneContract();
    contract.gateIndex = (contract.gateIndex as unknown[]).slice(0, 7);
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("gateIndex missing required label 'F'")),
      `expected a gateIndex error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires every focused gate to be settled", () => {
    const contract = cloneContract();
    const gates = contract.gates as Record<string, unknown>;
    const focused = gates.matchlockFocusedGates as Record<string, Record<string, unknown>>;
    focused.longHome.exitCode = null;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("gates.matchlockFocusedGates.longHome.exitCode")),
      `expected an exitCode error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires positive VM closure for every focused gate", () => {
    const contract = cloneContract();
    const gates = contract.gates as Record<string, unknown>;
    const focused = gates.matchlockFocusedGates as Record<string, Record<string, unknown>>;
    focused.emptyOutput.vmsPositivelyClosed = 1;
    focused.emptyOutput.vmsCreated = 2;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("emptyOutput.vmsPositivelyClosed must equal vmsCreated")),
      `expected a VM closure error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires the dsh real-gate token reconciliation", () => {
    const contract = cloneContract();
    const gates = contract.gates as Record<string, unknown>;
    const focused = gates.matchlockFocusedGates as Record<string, Record<string, unknown>>;
    focused.dshReal.runsTokensSpent = 1;
    focused.dshReal.v3StoreTotal = 2;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("dshReal token reconciliation")),
      `expected a token reconciliation error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires a non-empty failingFiles list to be cleared on the e2e gate", () => {
    const contract = cloneContract();
    const gates = contract.gates as Record<string, unknown>;
    (gates.runAllE2eTests as Record<string, unknown>).failingFiles = ["e2e-tests/x.test.ts"];
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("failingFiles must be empty")),
      `expected a failingFiles error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a missing feature group item", () => {
    const contract = cloneContract();
    const features = contract.features as Array<Record<string, unknown>>;
    const chainGroup = features.find((group) => group.group === "union4-schema-chain");
    assert.ok(chainGroup, "expected the union4-schema-chain group");
    chainGroup.items = (chainGroup.items as Array<Record<string, unknown>>).filter(
      (entry) => entry.name !== "v10MatchlockToV12",
    );
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("missing item 'v10MatchlockToV12'")),
      `expected a feature item error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a VM lifecycle that did not close every gate", () => {
    const contract = cloneContract();
    const lifecycle = contract.vmLifecycle as Record<string, unknown>;
    lifecycle.allOwnedVmsClosed = false;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("allOwnedVmsClosed must be true")),
      `expected a lifecycle error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("cannot be true while")),
      `expected a verdict/lifecycle conflict, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a non-canonical cleanup line", () => {
    const contract = cloneContract();
    const lifecycle = contract.vmLifecycle as Record<string, unknown>;
    const gates = lifecycle.gates as Record<string, Record<string, unknown>>;
    gates.synthetic.cleanupCompleteLine = "done";
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("synthetic.cleanupCompleteLine must end with")),
      `expected a cleanup-line error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects an audit that found session URLs", () => {
    const contract = cloneContract();
    const audit = contract.audit as Record<string, unknown>;
    audit.sessionUrlsFound = true;
    audit.sessionUrlMatches = ["https://example.invalid/session"];
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("sessionUrlsFound must be false")),
      `expected a session-URL error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects an audit that found pinned story hashes", () => {
    const contract = cloneContract();
    const audit = contract.audit as Record<string, unknown>;
    audit.pinnedStoryHashesFound = true;
    audit.pinnedStoryHashMatches = ["c49b2041"];
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("pinnedStoryHashesFound must be false")),
      `expected a pinned-hash error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a squash that pins story hashes", () => {
    const contract = cloneContract();
    const verdict = contract.verdict as Record<string, unknown>;
    (verdict.squash as Record<string, unknown>).pinsStoryHashes = true;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("pinsStoryHashes must be false")),
      `expected a squash pin error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a squash hash that is not null or a full 40-char commit", () => {
    const contract = cloneContract();
    const verdict = contract.verdict as Record<string, unknown>;
    (verdict.squash as Record<string, unknown>).hash = "c49b2041";
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("squash.hash must be null")),
      `expected a squash-hash error, got ${JSON.stringify(errors)}`,
    );
  });

  it("requires a blocking gate when the verdict is not ready", () => {
    const contract = cloneContract();
    const verdict = contract.verdict as Record<string, unknown>;
    verdict.readyToInstallOnVaimetal = false;
    const errors = validateMatchlockUnion4Contract(contract);
    assert.ok(
      errors.some((error) => error.includes("blockingGate must name the blocking gate")),
      `expected a blockingGate error, got ${JSON.stringify(errors)}`,
    );
  });

  it("resolves every required conflict path to exactly one group", () => {
    const seen = new Set<string>();
    for (const [group, paths] of Object.entries(REQUIRED_UNION4_CONFLICTS)) {
      for (const path of paths) {
        assert.ok(!seen.has(path), `path '${path}' must belong to exactly one group`);
        seen.add(path);
        assert.equal(requiredGroupForPath(path), group);
      }
    }
    assert.equal(seen.size, UNION4_CONFLICT_COUNT);
    assert.equal(REQUIRED_UNION4_CONFLICT_PATHS.length, UNION4_CONFLICT_COUNT);
    assert.equal(requiredGroupForPath("no/such/path.ts"), null);
  });

  // ---- real published deliverable ----

  it(
    "parses the published union4 deliverable as JSON and finds it structurally complete",
    {
      skip: (() => {
        const path = process.env.MATCHLOCK_UNION4_CONTRACT_PATH ?? DEFAULT_UNION4_CONTRACT_PATH;
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const path = process.env.MATCHLOCK_UNION4_CONTRACT_PATH ?? DEFAULT_UNION4_CONTRACT_PATH;
      const raw = readFileSync(path, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        assert.fail(`published contract is not valid JSON: ${(error as Error).message}`);
      }
      assert.deepEqual(validateMatchlockUnion4Contract(parsed), []);
    },
  );
});
