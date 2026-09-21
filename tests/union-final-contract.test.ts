/**
 * UNION-FINAL US-014 — deliverable validator for the union-final contract.
 *
 * The run deliverable `/home/kaladin/matchlock-work/union-final-contract.json`
 * lives OUTSIDE the repository on purpose (it is host state, never committed,
 * never placed in the worktree). This file carries the validator the story
 * asks for: a pure `validateUnionFinalContract(value): string[]` plus always-on
 * unit tests covering the structural contract, and a real-file assertion that
 * defaults to the canonical deliverable path (overridable with
 * `UNION_FINAL_CONTRACT_PATH`) and is skipped when that file is absent — so the
 * committed suite never hard-depends on host state.
 *
 * US-014 rules enforced here:
 *   - the contract records what every source contributed (the union-port squash,
 *     the all-workflows/VM-size/cleanup landings and the SKILL-UX base);
 *   - conflictGroups covers every conflicted path from all four cherry-picks,
 *     each with the source-side and union-side contribution and the rationale;
 *   - schemaChain records SCHEMA_VERSION 13, the 9->10->11->12->13 chain, the
 *     detectSchemaLineage detector and a green src/db.test.ts result;
 *   - the launch-output fusion and the observation-4 log fix are described with
 *     their files and tests;
 *   - requiredGates lists the four host gates and all twelve Matchlock gates
 *     with command and exit, and every Matchlock gate has observed_rounds > 0;
 *   - every referenced gate/host evidence file exists and agrees with the
 *     published union-final-host-gates.json / union-final-matchlock-gates.json
 *     deliverables (the "matches the contract" half of the story);
 *   - vmLifecycle shows every gate VM closed/removed and killTrace records the
 *     sender or "none observed";
 *   - finalSquashHash is explicitly null / coordinator-filled and no story hash
 *     is pinned (verdict.squash.pinsStoryHashes === false).
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The external deliverable published by US-014 (overridable for tests). */
export const DEFAULT_UNION_FINAL_CONTRACT_PATH =
  "/home/kaladin/matchlock-work/union-final-contract.json";

/** The evidence deliverables the contract folds together. */
export const DEFAULT_UNION_FINAL_HOST_GATES_PATH =
  "/home/kaladin/matchlock-work/union-final-host-gates.json";
export const DEFAULT_UNION_FINAL_MATCHLOCK_GATES_PATH =
  "/home/kaladin/matchlock-work/union-final-matchlock-gates.json";

/** The four cherry-pick conflict records the contract cross-references. */
export const UNION_FINAL_CONFLICT_RECORDS = [
  "/home/kaladin/matchlock-work/union-final-conflicts.json",
  "/home/kaladin/matchlock-work/union-final-conflicts-us002.json",
  "/home/kaladin/matchlock-work/union-final-conflicts-us003.json",
  "/home/kaladin/matchlock-work/union-final-conflicts-us004.json",
] as const;

/** The four host gates US-010 ran, in order. */
export const UNION_FINAL_REQUIRED_HOST_GATES = [
  "build",
  "db-test",
  "testcmd",
  "e2e",
] as const;

/** The twelve Matchlock gates US-011..US-013 ran, in order. */
export const UNION_FINAL_REQUIRED_MATCHLOCK_GATES = [
  "synthetic",
  "hermes-synthetic",
  "empty-output",
  "long-home",
  "worktree-merge",
  "dsh",
  "dsh-profile-overlay",
  "dsh-real-boot",
  "dsh-merge-worktree",
  "hermes-merge-worktree",
  "vm-size",
  "cleanup",
] as const;

/** The five sources the contract must record a contribution for. */
export const UNION_FINAL_CONTRIBUTION_KEYS = [
  "skill-ux-base",
  "union-port",
  "all-workflows",
  "vm-size",
  "cleanup",
] as const;

/** The SYSTEM unpinned matchlock the battery resolved from PATH. */
export const SYSTEM_MATCHLOCK_PATH = "/usr/local/bin/matchlock";

const REQUIRED_BLOCKED_STRING_FIELDS = [
  "reason",
  "classification",
  "evidence",
  "docsCitation",
] as const;

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const VM_ID_RE = /^vm-[0-9a-f]{8}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** A documented blocked gate: non-zero exit + a full `blocked` object. */
export function isDocumentedBlockedGate(entry: Record<string, unknown>): boolean {
  if (entry.exit === 0) return false;
  const blocked = entry.blocked;
  if (!isPlainObject(blocked)) return false;
  if (blocked.preExisting !== true) return false;
  return REQUIRED_BLOCKED_STRING_FIELDS.every((key) => isNonEmptyString(blocked[key]));
}

/**
 * Validate the parsed union-final contract. Returns a list of human-readable
 * errors; an empty list means the contract is structurally the one US-014
 * requires. Pure — never touches the filesystem.
 */
export function validateUnionFinalContract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ["union-final contract must be a JSON object"];
  }

  for (const key of ["schema", "contract", "generatedAt"] as const) {
    if (!isNonEmptyString(value[key])) {
      errors.push(`'${key}' must be a non-empty string`);
    }
  }

  // finalSquashHash must be explicitly null (coordinator-filled later).
  if (!Object.prototype.hasOwnProperty.call(value, "finalSquashHash")) {
    errors.push("'finalSquashHash' must be present and explicitly null");
  } else if (value.finalSquashHash !== null) {
    errors.push(
      "'finalSquashHash' must be null (the coordinator fills it after landing; no story hash may be pinned)",
    );
  }

  if (!isPlainObject(value.run)) {
    errors.push("'run' must be an object");
  } else {
    for (const key of [
      "runId",
      "branch",
      "integrationBranch",
      "integrationBase",
      "headCommit",
      "headTree",
    ] as const) {
      if (!isNonEmptyString(value.run[key])) {
        errors.push(`run.${key} must be a non-empty string`);
      }
    }
  }

  if (!isPlainObject(value.buildIdentity)) {
    errors.push("'buildIdentity' must be an object");
  } else {
    if (value.buildIdentity.matchlockPath !== SYSTEM_MATCHLOCK_PATH) {
      errors.push(
        `buildIdentity.matchlockPath must be the SYSTEM unpinned '${SYSTEM_MATCHLOCK_PATH}'`,
      );
    }
    if (value.buildIdentity.pinned !== false) {
      errors.push("buildIdentity.pinned must be false (never a pinned/private copy)");
    }
    if (!HEX64_RE.test(String(value.buildIdentity.matchlockSha256 ?? ""))) {
      errors.push("buildIdentity.matchlockSha256 must be the 64-hex observed binary digest");
    }
  }

  // ---- schemaChain ---------------------------------------------------------
  if (!isPlainObject(value.schemaChain)) {
    errors.push("'schemaChain' must be an object");
  } else {
    const chain = value.schemaChain;
    if (chain.version !== 13) {
      errors.push(`schemaChain.version must be 13 (got ${String(chain.version)})`);
    }
    if (chain.chain !== "9->10->11->12->13") {
      errors.push("schemaChain.chain must be '9->10->11->12->13'");
    }
    if (!isPlainObject(chain.lineageDetector)) {
      errors.push("schemaChain.lineageDetector must be an object");
    } else if (chain.lineageDetector.name !== "detectSchemaLineage") {
      errors.push("schemaChain.lineageDetector.name must be 'detectSchemaLineage'");
    }
    if (!isPlainObject(chain.testResult)) {
      errors.push("schemaChain.testResult must be an object");
    } else {
      const result = chain.testResult;
      if (result.status !== "green") {
        errors.push("schemaChain.testResult.status must be 'green'");
      }
      if (result.fail !== 0) {
        errors.push(`schemaChain.testResult.fail must be 0 (got ${String(result.fail)})`);
      }
      if (!Number.isInteger(result.tests) || (result.tests as number) < 1) {
        errors.push("schemaChain.testResult.tests must be a positive integer");
      }
    }
  }

  // ---- contributions -------------------------------------------------------
  if (!Array.isArray(value.contributions)) {
    errors.push("'contributions' must be an array");
  } else {
    const keys = value.contributions
      .filter(isPlainObject)
      .map((entry) => entry.key as string);
    for (const required of UNION_FINAL_CONTRIBUTION_KEYS) {
      if (!keys.includes(required)) {
        errors.push(`missing contribution for source '${required}'`);
      }
    }
    value.contributions.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        errors.push(`contributions[${index}] must be an object`);
        return;
      }
      for (const key of ["key", "commit", "subject", "contribution"] as const) {
        if (!isNonEmptyString(entry[key])) {
          errors.push(`contributions[${index}].${key} must be a non-empty string`);
        }
      }
    });
  }

  // ---- conflictGroups ------------------------------------------------------
  if (!Array.isArray(value.conflictGroups)) {
    errors.push("'conflictGroups' must be an array");
  } else {
    value.conflictGroups.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        errors.push(`conflictGroups[${index}] must be an object`);
        return;
      }
      if (!HEX40_RE.test(String(entry.source ?? ""))) {
        errors.push(`conflictGroups[${index}].source must be a 40-hex commit`);
      }
      for (const key of [
        "path",
        "sourceSide",
        "unionSide",
        "resolution",
        "rationale",
        "conflictRecord",
      ] as const) {
        if (!isNonEmptyString(entry[key])) {
          errors.push(`conflictGroups[${index}].${key} must be a non-empty string`);
        }
      }
    });
  }

  // ---- launch fusion + observation-4 log fix -------------------------------
  for (const section of ["launchOutputFusion", "observation4LogFix"] as const) {
    const block = value[section];
    if (!isPlainObject(block)) {
      errors.push(`'${section}' must be an object`);
      continue;
    }
    if (!isNonEmptyString(block.description)) {
      errors.push(`${section}.description must be a non-empty string`);
    }
    for (const key of ["files", "tests"] as const) {
      if (!Array.isArray(block[key]) || block[key].length < 1) {
        errors.push(`${section}.${key} must be a non-empty array`);
      }
    }
  }
  if (isPlainObject(value.observation4LogFix) && !isNonEmptyString(value.observation4LogFix.bead)) {
    errors.push("observation4LogFix.bead must be a non-empty string");
  }

  // ---- host gates ----------------------------------------------------------
  if (!isPlainObject(value.tests) || !Array.isArray(value.tests.hostGates)) {
    errors.push("tests.hostGates must be an array");
  } else {
    const names: string[] = [];
    value.tests.hostGates.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        errors.push(`tests.hostGates[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(entry.name)) {
        errors.push(`tests.hostGates[${index}].name must be a non-empty string`);
      } else {
        names.push(entry.name);
      }
      if (!isNonEmptyString(entry.command)) {
        errors.push(`tests.hostGates[${index}].command must be a non-empty string`);
      }
      if (!isNonEmptyString(entry.evidence_path)) {
        errors.push(`tests.hostGates[${index}].evidence_path must be a non-empty string`);
      }
      if (entry.exit !== 0) {
        errors.push(`tests.hostGates[${index}].exit must be 0 (got ${String(entry.exit)})`);
      }
      for (const key of ["startedAt", "endedAt"] as const) {
        if (isNonEmptyString(entry[key]) && !isIsoInstant(entry[key] as string)) {
          errors.push(`tests.hostGates[${index}].${key} must be a parseable instant`);
        }
      }
    });
    for (const required of UNION_FINAL_REQUIRED_HOST_GATES) {
      if (!names.includes(required)) {
        errors.push(`missing required host gate '${required}'`);
      }
    }
    if (names.length !== UNION_FINAL_REQUIRED_HOST_GATES.length) {
      errors.push(
        `tests.hostGates must have exactly ${UNION_FINAL_REQUIRED_HOST_GATES.length} entries (got ${names.length})`,
      );
    }
  }

  // ---- Matchlock gates -----------------------------------------------------
  if (!Array.isArray(value.gates)) {
    errors.push("'gates' must be an array");
  } else {
    const names: string[] = [];
    value.gates.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        errors.push(`gates[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(entry.name)) {
        errors.push(`gates[${index}].name must be a non-empty string`);
      } else {
        names.push(entry.name);
        if (!(UNION_FINAL_REQUIRED_MATCHLOCK_GATES as readonly string[]).includes(entry.name)) {
          errors.push(`gates[${index}].name '${entry.name}' is not a known Matchlock gate`);
        }
      }
      if (!isNonEmptyString(entry.command)) {
        errors.push(`gates[${index}].command must be a non-empty string`);
      }
      for (const key of ["evidence_path", "observed_rounds_path"] as const) {
        if (!isNonEmptyString(entry[key])) {
          errors.push(`gates[${index}].${key} must be a non-empty string`);
        }
      }
      if (!Number.isInteger(entry.exit)) {
        errors.push(`gates[${index}].exit must be an integer`);
      } else if (entry.exit !== 0 && !isDocumentedBlockedGate(entry)) {
        errors.push(
          `gates[${index}].exit must be 0 (got ${String(entry.exit)}) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}`,
        );
      }
      if (!Number.isInteger(entry.observed_rounds)) {
        errors.push(`gates[${index}].observed_rounds must be an integer`);
      } else if ((entry.observed_rounds as number) < 1) {
        errors.push(
          `gates[${index}].observed_rounds must be > 0 (got ${String(entry.observed_rounds)})`,
        );
      }
      if (!Array.isArray(entry.observed_vm_ids)) {
        errors.push(`gates[${index}].observed_vm_ids must be an array`);
      } else {
        for (const id of entry.observed_vm_ids) {
          if (typeof id !== "string" || !VM_ID_RE.test(id)) {
            errors.push(
              `gates[${index}].observed_vm_ids contains an invalid VM id ${JSON.stringify(id)}`,
            );
          }
        }
        if (
          Number.isInteger(entry.observed_rounds) &&
          entry.observed_vm_ids.length !== entry.observed_rounds
        ) {
          errors.push(
            `gates[${index}].observed_rounds must equal the distinct observed_vm_ids count`,
          );
        }
      }
      if (!isPlainObject(entry.vmLifecycle)) {
        errors.push(`gates[${index}].vmLifecycle must be an object`);
      } else if (!isNonEmptyString(entry.vmLifecycle.cleanupLedger)) {
        errors.push(`gates[${index}].vmLifecycle.cleanupLedger must be a non-empty string`);
      }
    });
    for (const required of UNION_FINAL_REQUIRED_MATCHLOCK_GATES) {
      if (!names.includes(required)) {
        errors.push(`missing required Matchlock gate '${required}'`);
      }
    }
    if (names.length !== UNION_FINAL_REQUIRED_MATCHLOCK_GATES.length) {
      errors.push(
        `gates must have exactly ${UNION_FINAL_REQUIRED_MATCHLOCK_GATES.length} entries (got ${names.length})`,
      );
    }
  }

  // ---- requiredGates -------------------------------------------------------
  if (!Array.isArray(value.requiredGates)) {
    errors.push("'requiredGates' must be an array");
  } else {
    const index = new Map<string, Record<string, unknown>>();
    value.requiredGates.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(`requiredGates[${i}] must be an object`);
        return;
      }
      if (!isNonEmptyString(entry.key)) {
        errors.push(`requiredGates[${i}].key must be a non-empty string`);
        return;
      }
      index.set(entry.key, entry);
      if (!isNonEmptyString(entry.command)) {
        errors.push(`requiredGates[${i}].command must be a non-empty string`);
      }
      if (entry.kind === "host") {
        if (entry.rounds_applicable !== false) {
          errors.push(`requiredGates[${i}].rounds_applicable must be false for a host gate`);
        }
        if (entry.exit !== 0) {
          errors.push(`requiredGates[${i}].exit must be 0 (got ${String(entry.exit)})`);
        }
      } else if (entry.kind === "matchlock") {
        if (entry.rounds_applicable !== true) {
          errors.push(
            `requiredGates[${i}].rounds_applicable must be true for a Matchlock gate`,
          );
        }
        if (!Number.isInteger(entry.observed_rounds) || (entry.observed_rounds as number) < 1) {
          errors.push(`requiredGates[${i}].observed_rounds must be > 0`);
        }
      } else {
        errors.push(`requiredGates[${i}].kind must be 'host' or 'matchlock'`);
      }
    });
    for (const key of UNION_FINAL_REQUIRED_HOST_GATES) {
      if (!index.has(key)) {
        errors.push(`requiredGates is missing host gate '${key}'`);
      }
    }
    for (const key of UNION_FINAL_REQUIRED_MATCHLOCK_GATES) {
      const entry = index.get(key);
      if (!entry) {
        errors.push(`requiredGates is missing Matchlock gate '${key}'`);
      } else if (entry.kind !== "matchlock") {
        errors.push(`requiredGates['${key}'].kind must be 'matchlock'`);
      }
    }
    if (index.size !== UNION_FINAL_REQUIRED_HOST_GATES.length + UNION_FINAL_REQUIRED_MATCHLOCK_GATES.length) {
      errors.push(
        `requiredGates must list exactly ${UNION_FINAL_REQUIRED_HOST_GATES.length + UNION_FINAL_REQUIRED_MATCHLOCK_GATES.length} gates (got ${index.size})`,
      );
    }
  }

  // ---- vmLifecycle ---------------------------------------------------------
  if (!isPlainObject(value.vmLifecycle)) {
    errors.push("'vmLifecycle' must be an object");
  } else {
    const lifecycle = value.vmLifecycle;
    if (lifecycle.operatorUnchanged !== true) {
      errors.push("vmLifecycle.operatorUnchanged must be true");
    }
    if (lifecycle.everyGatePrivateStoreEmpty !== true) {
      errors.push("vmLifecycle.everyGatePrivateStoreEmpty must be true");
    }
    if (lifecycle.all_gate_vms_closed !== true) {
      errors.push("vmLifecycle.all_gate_vms_closed must be true");
    }
    if (!isPlainObject(lifecycle.per_gate)) {
      errors.push("vmLifecycle.per_gate must be an object");
    } else {
      for (const gate of UNION_FINAL_REQUIRED_MATCHLOCK_GATES) {
        const entry = lifecycle.per_gate[gate];
        if (!isPlainObject(entry)) {
          errors.push(`vmLifecycle.per_gate['${gate}'] must be an object`);
          continue;
        }
        if (entry.cleanupComplete !== true) {
          errors.push(`vmLifecycle.per_gate['${gate}'].cleanupComplete must be true`);
        }
        if (!isNonEmptyString(entry.cleanupLedger)) {
          errors.push(`vmLifecycle.per_gate['${gate}'].cleanupLedger must be a non-empty string`);
        }
      }
    }
  }

  // ---- killTrace -----------------------------------------------------------
  if (!isPlainObject(value.killTrace)) {
    errors.push("'killTrace' must be an object");
  } else {
    if (!isNonEmptyString(value.killTrace.sender)) {
      errors.push("killTrace.sender must be a non-empty string (a sender or 'none observed')");
    }
    if (typeof value.killTrace.observed !== "boolean") {
      errors.push("killTrace.observed must be a boolean");
    }
    if (!isNonEmptyString(value.killTrace.path)) {
      errors.push("killTrace.path must be a non-empty string");
    }
  }

  // ---- verdict -------------------------------------------------------------
  if (!isPlainObject(value.verdict)) {
    errors.push("'verdict' must be an object");
  } else {
    if (value.verdict.readyToLand !== true) {
      errors.push("verdict.readyToLand must be true");
    }
    if (!isPlainObject(value.verdict.squash)) {
      errors.push("verdict.squash must be an object");
    } else {
      if (value.verdict.squash.pinsStoryHashes !== false) {
        errors.push("verdict.squash.pinsStoryHashes must be false");
      }
      if (value.verdict.squash.hash !== null) {
        errors.push("verdict.squash.hash must be null (filled by the coordinator)");
      }
      if (!isNonEmptyString(value.verdict.squash.subject)) {
        errors.push("verdict.squash.subject must be a non-empty string");
      }
      if (!isNonEmptyString(value.verdict.squash.targetBranch)) {
        errors.push("verdict.squash.targetBranch must be a non-empty string");
      }
    }
  }

  return errors;
}

/** Minimal structurally valid contract, reused across the error cases. */
export function buildMinimalValidContract(): Record<string, unknown> {
  const hostGates = UNION_FINAL_REQUIRED_HOST_GATES.map((name) => ({
    name,
    command: `gate ${name}`,
    exit: 0,
    evidence_path: `/home/kaladin/matchlock-work/union-final-gates/${name}.log`,
    startedAt: "2026-09-21T00:00:00Z",
    endedAt: "2026-09-21T00:00:01Z",
    notes: "",
  }));
  const matchlockGates = UNION_FINAL_REQUIRED_MATCHLOCK_GATES.map((name, index) => ({
    name,
    command: `./run-${name}-e2e-test`,
    exit: 0,
    observed_rounds: 1,
    observed_vm_ids: [`vm-${index.toString(16).padStart(8, "0")}`],
    evidence_path: `/home/kaladin/matchlock-work/evidence/${name}-fixture`,
    observed_rounds_path: `/home/kaladin/matchlock-work/evidence/${name}-fixture/observed-rounds.json`,
    vmLifecycle: {
      cleanupLedger: `/home/kaladin/matchlock-work/evidence/${name}-fixture/vm-cleanup-ledger.txt`,
      cleanupComplete: true,
    },
    notes: "",
  }));
  const requiredGates = [
    ...hostGates.map((gate) => ({
      kind: "host",
      key: gate.name,
      section: "tests.hostGates",
      command: gate.command,
      exit: gate.exit,
      observed_rounds: null,
      rounds_applicable: false,
      evidence_path: gate.evidence_path,
    })),
    ...matchlockGates.map((gate) => ({
      kind: "matchlock",
      key: gate.name,
      section: "gates",
      command: gate.command,
      exit: gate.exit,
      observed_rounds: gate.observed_rounds,
      rounds_applicable: true,
      evidence_path: gate.evidence_path,
    })),
  ];
  const perGate: Record<string, unknown> = {};
  for (const gate of matchlockGates) {
    perGate[gate.name] = {
      observed_vm_ids: gate.observed_vm_ids,
      observed_rounds: gate.observed_rounds,
      vm_closed: true,
      cleanupLedger: gate.vmLifecycle.cleanupLedger,
      cleanupComplete: true,
    };
  }
  return {
    schema: "union-final-contract/1",
    contract: "UNION-FINAL",
    generatedAt: "2026-09-21T00:00:00Z",
    run: {
      runId: "run-04763ce1-d1b1-4224-bd9a-47e2fa351f86",
      branch: "feature/union-final-matchlock-20260920",
      integrationBranch: "integration/union-final",
      integrationBase: "e16e82f34b5e7c59cfdd110398724a4f68b0986d",
      headCommit: "d54d3d67da81369c59c11369560aa2297dbb8a10",
      headTree: "db29cf885d5e21f04d0d0c7b9dd4b42a74c533ff",
    },
    finalSquashHash: null,
    contributions: UNION_FINAL_CONTRIBUTION_KEYS.map((key) => ({
      key,
      commit: "0123456789abcdef0123456789abcdef01234567",
      subject: key,
      contribution: `${key} contribution`,
    })),
    conflictGroups: [
      {
        source: "0456ed9c442902ee8284eb6ea87d84940478b968",
        sourceShort: "0456ed9c",
        path: "src/cli/commands/workflow.ts",
        kind: "content",
        sourceSide: "source side",
        unionSide: "union side",
        resolution: "kept both",
        rationale: "both additive",
        conflictRecord: UNION_FINAL_CONFLICT_RECORDS[0],
      },
    ],
    schemaChain: {
      version: 13,
      chain: "9->10->11->12->13",
      lineageDetector: { name: "detectSchemaLineage" },
      testResult: { tests: 117, pass: 117, fail: 0, skipped: 0, status: "green" },
    },
    launchOutputFusion: {
      description: "fused launch line",
      fields: ["image", "cpus", "memoryMB", "diskSizeMB"],
      files: ["src/installer/workflow-run-resolution.ts"],
      tests: ["src/cli/commands/workflow.test.ts"],
    },
    observation4LogFix: {
      description: "admission logged once per started round",
      bead: "tamandua-6sy.33.38 observation 4",
      files: ["src/installer/agent-scheduler.ts"],
      tests: ["src/installer/agent-scheduler.test.ts"],
    },
    tests: { hostGates },
    gates: matchlockGates,
    requiredGates,
    vmLifecycle: {
      operatorUnchanged: true,
      everyGatePrivateStoreEmpty: true,
      all_gate_vms_closed: true,
      per_gate: perGate,
    },
    killTrace: {
      path: "/home/kaladin/matchlock-work/kill-trace.log",
      sender: "none observed",
      observed: false,
    },
    buildIdentity: {
      matchlockPath: SYSTEM_MATCHLOCK_PATH,
      matchlockVersion: "matchlock version 0.2.17",
      matchlockSha256: "a".repeat(64),
      pinned: false,
    },
    verdict: {
      readyToLand: true,
      blockingGate: null,
      documentedBlockedGates: ["dsh", "dsh-merge-worktree"],
      squash: {
        hash: null,
        pinsStoryHashes: false,
        subject: "feat: Matchlock-backed harness rounds (pi/hermes/dsh in VMs)",
        targetBranch: "integration/union-final",
        capturedBy: "coordinator after landing",
      },
    },
  };
}

/** Deep-clone the fixture and apply a destructive mutation via `mutate`. */
function mutated(mutate: (value: Record<string, unknown>) => void): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(buildMinimalValidContract())) as Record<
    string,
    unknown
  >;
  mutate(value);
  return value;
}

function gateByName(
  value: Record<string, unknown>,
  section: "gates" | "hostGates",
  name: string,
): Record<string, unknown> {
  const list =
    section === "gates"
      ? (value.gates as Record<string, unknown>[])
      : ((value.tests as Record<string, unknown>).hostGates as Record<string, unknown>[]);
  return list.find((gate) => gate.name === name) as Record<string, unknown>;
}

describe("UNION-FINAL US-014 union-final contract validator", () => {
  it("accepts the minimal valid contract", () => {
    assert.deepEqual(validateUnionFinalContract(buildMinimalValidContract()), []);
  });

  it("rejects non-object evidence", () => {
    assert.deepEqual(validateUnionFinalContract("nope"), [
      "union-final contract must be a JSON object",
    ]);
    assert.deepEqual(validateUnionFinalContract(null), [
      "union-final contract must be a JSON object",
    ]);
  });

  it("requires a null finalSquashHash", () => {
    assert.ok(
      validateUnionFinalContract(
        mutated((value) => {
          value.finalSquashHash = "d54d3d67";
        }),
      ).includes(
        "'finalSquashHash' must be null (the coordinator fills it after landing; no story hash may be pinned)",
      ),
    );
    assert.ok(
      validateUnionFinalContract(
        mutated((value) => {
          delete value.finalSquashHash;
        }),
      ).includes("'finalSquashHash' must be present and explicitly null"),
    );
  });

  it("requires the SYSTEM unpinned matchlock identity", () => {
    const notSystem = mutated((value) => {
      (value.buildIdentity as Record<string, unknown>).matchlockPath =
        "/home/kaladin/matchlock-work/private/matchlock";
    });
    assert.ok(
      validateUnionFinalContract(notSystem).includes(
        `buildIdentity.matchlockPath must be the SYSTEM unpinned '${SYSTEM_MATCHLOCK_PATH}'`,
      ),
    );
    const pinned = mutated((value) => {
      (value.buildIdentity as Record<string, unknown>).pinned = true;
    });
    assert.ok(
      validateUnionFinalContract(pinned).includes(
        "buildIdentity.pinned must be false (never a pinned/private copy)",
      ),
    );
    const badDigest = mutated((value) => {
      (value.buildIdentity as Record<string, unknown>).matchlockSha256 = "short";
    });
    assert.ok(
      validateUnionFinalContract(badDigest).includes(
        "buildIdentity.matchlockSha256 must be the 64-hex observed binary digest",
      ),
    );
  });

  it("requires SCHEMA_VERSION 13, the lineage chain and the lineage detector", () => {
    const value = mutated((v) => {
      const chain = v.schemaChain as Record<string, unknown>;
      chain.version = 12;
      chain.chain = "9->12";
      (chain.lineageDetector as Record<string, unknown>).name = "user_version";
      (chain.testResult as Record<string, unknown>).fail = 1;
      (chain.testResult as Record<string, unknown>).status = "red";
    });
    const errors = validateUnionFinalContract(value);
    assert.ok(errors.includes("schemaChain.version must be 13 (got 12)"));
    assert.ok(errors.includes("schemaChain.chain must be '9->10->11->12->13'"));
    assert.ok(errors.includes("schemaChain.lineageDetector.name must be 'detectSchemaLineage'"));
    assert.ok(errors.includes("schemaChain.testResult.status must be 'green'"));
    assert.ok(errors.includes("schemaChain.testResult.fail must be 0 (got 1)"));
  });

  it("requires a contribution for every source", () => {
    const value = mutated((v) => {
      v.contributions = (v.contributions as Record<string, unknown>[]).filter(
        (entry) => entry.key !== "cleanup",
      );
    });
    assert.ok(
      validateUnionFinalContract(value).includes("missing contribution for source 'cleanup'"),
    );
  });

  it("requires every conflict group to carry both sides and the rationale", () => {
    const value = mutated((v) => {
      const group = (v.conflictGroups as Record<string, unknown>[])[0];
      group.sourceSide = "";
      group.unionSide = "";
      group.rationale = "";
      group.source = "nope";
    });
    const errors = validateUnionFinalContract(value);
    assert.ok(errors.includes("conflictGroups[0].source must be a 40-hex commit"));
    assert.ok(errors.includes("conflictGroups[0].sourceSide must be a non-empty string"));
    assert.ok(errors.includes("conflictGroups[0].unionSide must be a non-empty string"));
    assert.ok(errors.includes("conflictGroups[0].rationale must be a non-empty string"));
  });

  it("requires the launch fusion and the observation-4 fix descriptions", () => {
    const value = mutated((v) => {
      (v.launchOutputFusion as Record<string, unknown>).description = "";
      (v.launchOutputFusion as Record<string, unknown>).tests = [];
      (v.observation4LogFix as Record<string, unknown>).bead = "";
      (v.observation4LogFix as Record<string, unknown>).files = [];
    });
    const errors = validateUnionFinalContract(value);
    assert.ok(errors.includes("launchOutputFusion.description must be a non-empty string"));
    assert.ok(errors.includes("launchOutputFusion.tests must be a non-empty array"));
    assert.ok(errors.includes("observation4LogFix.bead must be a non-empty string"));
    assert.ok(errors.includes("observation4LogFix.files must be a non-empty array"));
  });

  it("requires all four host gates at exit 0", () => {
    const value = mutated((v) => {
      gateByName(v, "hostGates", "e2e").exit = 1;
    });
    assert.ok(
      validateUnionFinalContract(value).includes("tests.hostGates[3].exit must be 0 (got 1)"),
    );

    const missing = mutated((v) => {
      const gates = (v.tests as Record<string, unknown>).hostGates as Record<string, unknown>[];
      gates.splice(3, 1);
    });
    const errors = validateUnionFinalContract(missing);
    assert.ok(errors.includes("missing required host gate 'e2e'"));
    assert.ok(errors.includes("tests.hostGates must have exactly 4 entries (got 3)"));
  });

  it("requires all twelve Matchlock gates with observed_rounds > 0", () => {
    const zero = mutated((v) => {
      const gate = gateByName(v, "gates", "synthetic");
      gate.observed_rounds = 0;
      gate.observed_vm_ids = [];
    });
    assert.ok(
      validateUnionFinalContract(zero).includes("gates[0].observed_rounds must be > 0 (got 0)"),
    );

    const missing = mutated((v) => {
      const gates = v.gates as Record<string, unknown>[];
      gates.splice(
        gates.findIndex((gate) => gate.name === "cleanup"),
        1,
      );
    });
    const errors = validateUnionFinalContract(missing);
    assert.ok(errors.includes("missing required Matchlock gate 'cleanup'"));
    assert.ok(errors.includes("gates must have exactly 12 entries (got 11)"));
  });

  it("accepts a red Matchlock gate only with a documented blocked object", () => {
    const blocked = {
      preExisting: true,
      reason: "documented pre-existing blocker",
      classification: "pre-existing runtime/sandbox blocker",
      evidence: "/home/kaladin/matchlock-work/evidence/dsh/nonstandard-path-invocation.json",
      docsCitation: "docs/matchlock-dsh-qualification.md#5",
    };
    const red = mutated((v) => {
      const gate = gateByName(v, "gates", "dsh");
      gate.exit = 1;
      gate.blocked = blocked;
    });
    assert.deepEqual(validateUnionFinalContract(red), []);

    const undocumented = mutated((v) => {
      const gate = gateByName(v, "gates", "dsh");
      gate.exit = 1;
    });
    assert.ok(
      validateUnionFinalContract(undocumented).includes(
        "gates[5].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
      ),
    );

    const incomplete = mutated((v) => {
      const gate = gateByName(v, "gates", "dsh");
      gate.exit = 1;
      gate.blocked = { ...blocked, docsCitation: "" };
    });
    assert.ok(
      validateUnionFinalContract(incomplete).includes(
        "gates[5].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
      ),
    );
  });

  it("requires every Matchlock gate to carry a cleanup ledger and observed VM ids", () => {
    const value = mutated((v) => {
      const gate = gateByName(v, "gates", "vm-size");
      gate.observed_vm_ids = ["not-a-vm"];
      gate.observed_rounds = 2;
      gate.vmLifecycle = {};
    });
    const errors = validateUnionFinalContract(value);
    assert.ok(errors.includes('gates[10].observed_vm_ids contains an invalid VM id "not-a-vm"'));
    assert.ok(errors.includes("gates[10].observed_rounds must equal the distinct observed_vm_ids count"));
    assert.ok(errors.includes("gates[10].vmLifecycle.cleanupLedger must be a non-empty string"));
  });

  it("requires requiredGates to list all sixteen gates", () => {
    const missing = mutated((v) => {
      v.requiredGates = (v.requiredGates as Record<string, unknown>[]).filter(
        (entry) => entry.key !== "vm-size",
      );
    });
    const errors = validateUnionFinalContract(missing);
    assert.ok(errors.includes("requiredGates is missing Matchlock gate 'vm-size'"));
    assert.ok(errors.includes("requiredGates must list exactly 16 gates (got 15)"));

    const wrongKind = mutated((v) => {
      const entry = (v.requiredGates as Record<string, unknown>[]).find(
        (candidate) => candidate.key === "dsh",
      ) as Record<string, unknown>;
      entry.kind = "host";
    });
    const wrongKindErrors = validateUnionFinalContract(wrongKind);
    assert.ok(wrongKindErrors.includes("requiredGates['dsh'].kind must be 'matchlock'"));
    assert.ok(
      wrongKindErrors.some((error) =>
        error.endsWith("rounds_applicable must be false for a host gate"),
      ),
    );
  });

  it("requires every gate VM to be closed and the operator set unchanged", () => {
    const value = mutated((v) => {
      const lifecycle = v.vmLifecycle as Record<string, unknown>;
      lifecycle.operatorUnchanged = false;
      lifecycle.all_gate_vms_closed = false;
      (lifecycle.per_gate as Record<string, unknown>).cleanup = {
        cleanupComplete: false,
        cleanupLedger: "",
      };
    });
    const errors = validateUnionFinalContract(value);
    assert.ok(errors.includes("vmLifecycle.operatorUnchanged must be true"));
    assert.ok(errors.includes("vmLifecycle.all_gate_vms_closed must be true"));
    assert.ok(errors.includes("vmLifecycle.per_gate['cleanup'].cleanupComplete must be true"));
    assert.ok(
      errors.includes("vmLifecycle.per_gate['cleanup'].cleanupLedger must be a non-empty string"),
    );
  });

  it("requires killTrace to record a sender (or 'none observed') and the verdict to pin no hash", () => {
    const value = mutated((v) => {
      (v.killTrace as Record<string, unknown>).sender = "";
      const verdict = v.verdict as Record<string, unknown>;
      verdict.readyToLand = false;
      (verdict.squash as Record<string, unknown>).pinsStoryHashes = true;
    });
    const errors = validateUnionFinalContract(value);
    assert.ok(errors.includes("killTrace.sender must be a non-empty string (a sender or 'none observed')"));
    assert.ok(errors.includes("verdict.readyToLand must be true"));
    assert.ok(errors.includes("verdict.squash.pinsStoryHashes must be false"));
  });

  // ---- real published deliverable ----

  it(
    "parses the published union-final contract and finds every referenced evidence file existing and matching the source deliverables",
    {
      skip: (() => {
        const pathName =
          process.env.UNION_FINAL_CONTRACT_PATH ?? DEFAULT_UNION_FINAL_CONTRACT_PATH;
        if (!existsSync(pathName)) {
          return `deliverable not found at ${pathName}`;
        }
        return false;
      })(),
    },
    () => {
      const pathName =
        process.env.UNION_FINAL_CONTRACT_PATH ?? DEFAULT_UNION_FINAL_CONTRACT_PATH;
      const parsed = JSON.parse(readFileSync(pathName, "utf-8")) as Record<string, unknown>;
      assert.deepEqual(validateUnionFinalContract(parsed), []);
      assert.equal(parsed.finalSquashHash, null);

      const contract = parsed as {
        tests: { hostGates: Record<string, unknown>[] };
        gates: Record<string, unknown>[];
        conflictGroups: Record<string, unknown>[];
        contributions: Record<string, unknown>[];
        vmLifecycle: { per_gate: Record<string, Record<string, unknown>> };
        killTrace: Record<string, unknown>;
        schemaChain: { testResult: Record<string, unknown> };
      };

      // Every referenced gate/host evidence file exists.
      for (const gate of contract.tests.hostGates) {
        assert.ok(
          existsSync(gate.evidence_path as string),
          `host gate '${String(gate.name)}' evidence does not exist: ${String(gate.evidence_path)}`,
        );
      }
      for (const gate of contract.gates) {
        assert.ok(
          existsSync(gate.evidence_path as string),
          `gate '${String(gate.name)}' evidence dir does not exist`,
        );
        assert.ok(
          existsSync(gate.observed_rounds_path as string),
          `gate '${String(gate.name)}' observed-rounds.json does not exist`,
        );
        assert.ok(
          existsSync(gate.gate_run_log as string),
          `gate '${String(gate.name)}' gate-run log does not exist`,
        );
        const lifecycle = gate.vmLifecycle as Record<string, unknown>;
        assert.ok(
          existsSync(lifecycle.cleanupLedger as string),
          `gate '${String(gate.name)}' cleanup ledger does not exist`,
        );
        if (isPlainObject(gate.blocked)) {
          assert.ok(
            existsSync(gate.blocked.evidence as string),
            `gate '${String(gate.name)}' blocked.evidence does not exist`,
          );
        }
      }
      for (const [name, entry] of Object.entries(contract.vmLifecycle.per_gate)) {
        assert.ok(
          existsSync(entry.cleanupLedger as string),
          `vmLifecycle.per_gate['${name}'].cleanupLedger does not exist`,
        );
      }
      assert.ok(existsSync(contract.killTrace.path as string), "killTrace.path does not exist");
      assert.ok(
        existsSync(contract.schemaChain.testResult.evidence as string),
        "schemaChain.testResult.evidence does not exist",
      );

      // conflictGroups covers every conflicted path from all four picks.
      const expected: string[] = [];
      for (const recordPath of UNION_FINAL_CONFLICT_RECORDS) {
        assert.ok(existsSync(recordPath), `conflict record does not exist: ${recordPath}`);
        const record = JSON.parse(readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
        const source =
          (record.cherryPick as Record<string, unknown> | undefined)?.source ??
          record.sourceCommit;
        assert.equal(typeof source, "string", `conflict record '${recordPath}' has no source`);
        const groups = record.conflictGroups as Record<string, unknown>[];
        for (const group of groups) {
          expected.push(`${String(source).slice(0, 8)}:${String(group.path)}`);
        }
      }
      const actual = contract.conflictGroups.map(
        (group) => `${String(group.sourceShort)}:${String(group.path)}`,
      );
      assert.deepEqual(
        [...actual].sort(),
        [...expected].sort(),
        "conflictGroups must cover exactly every conflicted path from all four cherry-picks",
      );

      // Contributions cover the five sources.
      const contributionKeys = contract.contributions.map((entry) => entry.key);
      for (const required of UNION_FINAL_CONTRIBUTION_KEYS) {
        assert.ok(
          contributionKeys.includes(required),
          `contract is missing a contribution for '${required}'`,
        );
      }

      // The contract's gates match the source deliverables (command/exit/rounds).
      const hostSource = JSON.parse(
        readFileSync(DEFAULT_UNION_FINAL_HOST_GATES_PATH, "utf-8"),
      ) as Record<string, unknown>;
      const hostSourceGates = hostSource.gates as Record<string, unknown>[];
      assert.deepEqual(
        contract.tests.hostGates.map((gate) => gate.name),
        hostSourceGates.map((gate) => gate.name),
        "host gate order must match the source deliverable",
      );
      for (const gate of contract.tests.hostGates) {
        const source = hostSourceGates.find((entry) => entry.name === gate.name);
        assert.ok(source, `host gate '${String(gate.name)}' is not in the source deliverable`);
        assert.equal(gate.command, source.command, `host gate '${String(gate.name)}' command mismatch`);
        assert.equal(gate.exit, source.exit, `host gate '${String(gate.name)}' exit mismatch`);
      }

      const mtlkSource = JSON.parse(
        readFileSync(DEFAULT_UNION_FINAL_MATCHLOCK_GATES_PATH, "utf-8"),
      ) as Record<string, unknown>;
      const mtlkSourceGates = mtlkSource.gates as Record<string, unknown>[];
      assert.deepEqual(
        contract.gates.map((gate) => gate.name),
        mtlkSourceGates.map((gate) => gate.name),
        "Matchlock gate order must match the source deliverable",
      );
      for (const gate of contract.gates) {
        const source = mtlkSourceGates.find((entry) => entry.name === gate.name);
        assert.ok(source, `Matchlock gate '${String(gate.name)}' is not in the source deliverable`);
        assert.equal(gate.command, source.command, `gate '${String(gate.name)}' command mismatch`);
        assert.equal(gate.exit, source.exit, `gate '${String(gate.name)}' exit mismatch`);
        assert.equal(
          gate.observed_rounds,
          source.observed_rounds,
          `gate '${String(gate.name)}' observed_rounds mismatch`,
        );
        assert.equal(
          gate.evidence_path,
          source.evidence_path,
          `gate '${String(gate.name)}' evidence_path mismatch`,
        );
        assert.equal(
          gate.observed_rounds_path,
          source.observed_rounds_path,
          `gate '${String(gate.name)}' observed_rounds_path mismatch`,
        );
        const rounds = JSON.parse(
          readFileSync(gate.observed_rounds_path as string, "utf-8"),
        ) as Record<string, unknown>;
        assert.equal(
          rounds.observed_rounds,
          gate.observed_rounds,
          `gate '${String(gate.name)}' observed-rounds.json count mismatch`,
        );
        assert.ok(
          (rounds.observed_rounds as number) > 0,
          `gate '${String(gate.name)}' observed_rounds must be > 0`,
        );
      }

      // The doc citation for a blocked gate must exist in this repo.
      for (const gate of contract.gates) {
        if (!isPlainObject(gate.blocked)) continue;
        const citation = gate.blocked.docsCitation as string;
        const docsPath = path.join(process.cwd(), citation.split("#")[0] ?? citation);
        assert.ok(
          existsSync(docsPath),
          `gate '${String(gate.name)}' blocked.docsCitation does not exist: ${docsPath}`,
        );
      }
    },
  );
});
