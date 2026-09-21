/**
 * UNION-PORT US-013 — deliverable validator for the run delivery contract.
 *
 * The contract `/home/kaladin/matchlock-work/union-port-contract.json` lives
 * OUTSIDE the repository on purpose (it is host delivery state, never
 * committed and never placed in the worktree). This file carries the validator
 * the story asks for: a pure `validateUnionPortContract(value): string[]` plus
 * always-on unit tests covering the structural contract, and a real-file
 * assertion that defaults to the canonical contract path (overridable with
 * `UNION_PORT_CONTRACT_PATH`) and is skipped when that file is absent — so the
 * committed suite never hard-depends on host state.
 *
 * The real-file assertions additionally cross-check the contract against the
 * three evidence files it is assembled from:
 *   - /home/kaladin/matchlock-work/union-port-conflicts.json
 *   - /home/kaladin/matchlock-work/union-port-host-gates.json
 *   - /home/kaladin/matchlock-work/union-port-matchlock-gates.json
 *
 * so a contract that names a gate/round count/VM set the evidence does not
 * support fails instead of passing as a summary with false green.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The external delivery contract published by US-013 (overridable for tests). */
export const DEFAULT_UNION_PORT_CONTRACT_PATH =
  "/home/kaladin/matchlock-work/union-port-contract.json";

/** The sibling host-side evidence files the contract is assembled from. */
export const UNION_PORT_CONFLICTS_PATH =
  "/home/kaladin/matchlock-work/union-port-conflicts.json";
export const UNION_PORT_HOST_GATES_PATH =
  "/home/kaladin/matchlock-work/union-port-host-gates.json";
export const UNION_PORT_MATCHLOCK_GATES_PATH =
  "/home/kaladin/matchlock-work/union-port-matchlock-gates.json";

/** The canonical shared gate lock every host/VM gate runs under. */
export const UNION_PORT_GATE_LOCK = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/** The combined schema version and the single documented chain. */
export const UNION_PORT_SCHEMA_VERSION = 13;
export const UNION_PORT_SCHEMA_CHAIN = "9->10->11->12->13";

/** The four content conflicts US-001 had to resolve. */
export const UNION_PORT_CONFLICT_PATHS = [
  "run-all-e2e-tests",
  "src/cli/commands/workflow.ts",
  "src/db.ts",
  "src/db.test.ts",
] as const;

/** The four host gates US-010 ran (host commands have no in-VM rounds). */
export const UNION_PORT_HOST_GATE_NAMES = ["build", "db-test", "testcmd", "e2e"] as const;

/** The eight Matchlock VM gates (the ones that observe rounds). */
export const UNION_PORT_MATCHLOCK_GATE_KEYS = [
  "synthetic",
  "hermes-synthetic",
  "empty-output",
  "long-home",
  "dsh",
  "dsh-profile-overlay",
  "dsh-real-boot",
  "worktree-merge",
] as const;

/** The SYSTEM matchlock prefix: unpinned, resolved through PATH. */
export const SYSTEM_MATCHLOCK_PREFIX = "/usr/local/bin";

/** A real Matchlock VM id: `vm-` + 8 lowercase hex characters. */
const VM_ID_RE = /^vm-[0-9a-f]{8}$/;

const REQUIRED_ROOT_KEYS = [
  "schema",
  "contract",
  "conflictGroups",
  "schemaChain",
  "tests",
  "gates",
  "vmLifecycle",
  "killTrace",
  "buildIdentity",
] as const;

const REQUIRED_BLOCKED_STRING_FIELDS = [
  "reason",
  "classification",
  "evidence",
  "docsCitation",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A documented blocked gate: non-zero exit + a complete `blocked` object. */
export function isDocumentedBlockedGate(entry: Record<string, unknown>): boolean {
  if (entry.exit === 0) return false;
  const blocked = entry.blocked;
  if (!isPlainObject(blocked)) return false;
  if (blocked.preExisting !== true) return false;
  return REQUIRED_BLOCKED_STRING_FIELDS.every((key) => isNonEmptyString(blocked[key]));
}

/**
 * Validate the parsed union-port delivery contract. Returns a list of
 * human-readable errors; an empty list means the contract is structurally the
 * one US-013 requires. Pure — never touches the filesystem.
 */
export function validateUnionPortContract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ["union-port contract must be a JSON object"];
  }

  for (const key of REQUIRED_ROOT_KEYS) {
    if (!(key in value)) {
      errors.push(`missing required key '${key}'`);
    }
  }

  // ── the landing identity is filled by the coordinator, never pinned ───
  if (value.finalSquashHash !== null && value.finalSquashHash !== undefined) {
    errors.push(
      "finalSquashHash must be null (the coordinator fills it after landing; story hashes are never pinned)",
    );
  }
  if (!isNonEmptyString(value.finalSquashNote)) {
    errors.push("finalSquashNote must be a non-empty string");
  }

  // ── conflict groups: all four resolved paths, each with both sides ────
  if (!Array.isArray(value.conflictGroups)) {
    errors.push("'conflictGroups' must be an array");
  } else {
    const paths: string[] = [];
    value.conflictGroups.forEach((group, index) => {
      if (!isPlainObject(group)) {
        errors.push(`conflictGroups[${index}] must be an object`);
        return;
      }
      for (const key of ["path", "mainSide", "unionSide", "resolution"] as const) {
        if (!isNonEmptyString(group[key])) {
          errors.push(`conflictGroups[${index}].${key} must be a non-empty string`);
        }
      }
      if (isNonEmptyString(group.path)) paths.push(group.path);
    });
    for (const required of UNION_PORT_CONFLICT_PATHS) {
      if (!paths.includes(required)) {
        errors.push(`conflictGroups is missing the conflicted path '${required}'`);
      }
    }
    for (const duplicate of new Set(paths.filter((p, i) => paths.indexOf(p) !== i))) {
      errors.push(`duplicate conflict group '${duplicate}'`);
    }
  }

  // ── schema chain: v13 and the single 9->10->11->12->13 chain ──────────
  const schema = value.schemaChain;
  if (!isPlainObject(schema)) {
    errors.push("'schemaChain' must be an object");
  } else {
    if (schema.version !== UNION_PORT_SCHEMA_VERSION) {
      errors.push(
        `schemaChain.version must be ${UNION_PORT_SCHEMA_VERSION} (got ${String(schema.version)})`,
      );
    }
    if (schema.chain !== UNION_PORT_SCHEMA_CHAIN) {
      errors.push(
        `schemaChain.chain must be '${UNION_PORT_SCHEMA_CHAIN}' (got ${String(schema.chain)})`,
      );
    }
    if (!Array.isArray(schema.steps) || schema.steps.length !== 4) {
      errors.push("schemaChain.steps must be the four 9->10->11->12->13 steps");
    } else {
      const edges = schema.steps.map((step, index) => {
        if (!isPlainObject(step)) {
          errors.push(`schemaChain.steps[${index}] must be an object`);
          return "";
        }
        for (const key of ["from", "to", "change", "guard"] as const) {
          if (!(key in step)) {
            errors.push(`schemaChain.steps[${index}].${key} is required`);
          }
        }
        return `${String(step.from)}->${String(step.to)}`;
      });
      checkChainEdges(edges, errors);
    }
    const detector = schema.lineageDetector;
    if (!isPlainObject(detector)) {
      errors.push("schemaChain.lineageDetector must be an object");
    } else {
      if (!isNonEmptyString(detector.name)) {
        errors.push("schemaChain.lineageDetector.name must be a non-empty string");
      }
      if (!isNonEmptyString(detector.mechanism)) {
        errors.push("schemaChain.lineageDetector.mechanism must be a non-empty string");
      }
      if (
        isNonEmptyString(detector.mechanism) &&
        !detector.mechanism.includes("PRAGMA table_info")
      ) {
        errors.push(
          "schemaChain.lineageDetector.mechanism must say it reads PRAGMA table_info",
        );
      }
    }
    if (!isNonEmptyString(schema.testFile)) {
      errors.push("schemaChain.testFile must be a non-empty string");
    }
    const result = schema.testResult;
    if (!isPlainObject(result)) {
      errors.push("schemaChain.testResult must be an object");
    } else {
      if (result.fail !== 0) {
        errors.push("schemaChain.testResult.fail must be 0");
      }
      if (result.status !== "green") {
        errors.push("schemaChain.testResult.status must be 'green'");
      }
      if (!Number.isInteger(result.tests) || (result.tests as number) < 1) {
        errors.push("schemaChain.testResult.tests must be a positive integer");
      }
      if (result.tests !== result.pass) {
        errors.push("schemaChain.testResult.pass must equal tests");
      }
    }
    if (!Array.isArray(schema.testNames) || schema.testNames.length < 6) {
      errors.push("schemaChain.testNames must list the migration test cases");
    }
  }

  // ── host gates live under `tests` ─────────────────────────────────────
  const tests = value.tests;
  if (!isPlainObject(tests)) {
    errors.push("'tests' must be an object");
  } else if (!Array.isArray(tests.hostGates)) {
    errors.push("tests.hostGates must be an array");
  } else {
    const names: string[] = [];
    tests.hostGates.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        errors.push(`tests.hostGates[${index}] must be an object`);
        return;
      }
      for (const key of ["name", "command", "evidence_path"] as const) {
        if (!isNonEmptyString(entry[key])) {
          errors.push(`tests.hostGates[${index}].${key} must be a non-empty string`);
        }
      }
      if (!Number.isInteger(entry.exit)) {
        errors.push(`tests.hostGates[${index}].exit must be an integer`);
      } else if (entry.exit !== 0) {
        errors.push(`tests.hostGates[${index}].exit must be 0 (got ${String(entry.exit)})`);
      }
      if (entry.evidence_exists !== true) {
        errors.push(`tests.hostGates[${index}].evidence_exists must be true`);
      }
      if (isNonEmptyString(entry.name)) names.push(entry.name);
    });
    for (const required of UNION_PORT_HOST_GATE_NAMES) {
      if (!names.includes(required)) {
        errors.push(`missing required host gate '${required}'`);
      }
    }
  }

  // ── Matchlock VM gates: every required gate with rounds > 0 ───────────
  if (!Array.isArray(value.gates)) {
    errors.push("'gates' must be an array of the Matchlock VM gates");
  } else {
    const keys: string[] = [];
    value.gates.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        errors.push(`gates[${index}] must be an object`);
        return;
      }
      for (const key of ["key", "name", "command", "evidence_path"] as const) {
        if (!isNonEmptyString(entry[key])) {
          errors.push(`gates[${index}].${key} must be a non-empty string`);
        }
      }
      if (isNonEmptyString(entry.key)) keys.push(entry.key);
      if (!Number.isInteger(entry.exit)) {
        errors.push(`gates[${index}].exit must be an integer`);
      } else if (entry.exit !== 0 && !isDocumentedBlockedGate(entry)) {
        errors.push(
          `gates[${index}].exit must be 0 (got ${String(entry.exit)}) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}`,
        );
      } else if (entry.exit === 0 && isPlainObject(entry.blocked)) {
        errors.push(`gates[${index}].blocked must be absent when exit is 0`);
      }
      if (!Number.isInteger(entry.observed_rounds) || (entry.observed_rounds as number) < 1) {
        errors.push(
          `gates[${index}].observed_rounds must be a positive integer (got ${String(entry.observed_rounds)})`,
        );
      }
      if (!isNonEmptyString(entry.observed_rounds_path)) {
        errors.push(`gates[${index}].observed_rounds_path must be a non-empty string`);
      }
      if (entry.observed_rounds_path_exists !== true || entry.evidence_exists !== true) {
        errors.push(`gates[${index}] evidence files must exist`);
      }
      if (!Array.isArray(entry.observed_vm_ids) || entry.observed_vm_ids.length === 0) {
        errors.push(`gates[${index}].observed_vm_ids must be a non-empty array`);
      } else {
        entry.observed_vm_ids.forEach((id, vmIndex) => {
          if (typeof id !== "string" || !VM_ID_RE.test(id)) {
            errors.push(
              `gates[${index}].observed_vm_ids[${vmIndex}] must be a vm-<8 lowercase hex> id`,
            );
          }
        });
      }
      if (entry.vm_closed !== true) {
        errors.push(`gates[${index}].vm_closed must be true`);
      }
    });
    for (const required of UNION_PORT_MATCHLOCK_GATE_KEYS) {
      if (!keys.includes(required)) {
        errors.push(`missing required Matchlock gate '${required}'`);
      }
    }
  }

  // ── VM lifecycle: every created VM removed, closure proven ────────────
  const lifecycle = value.vmLifecycle;
  if (!isPlainObject(lifecycle)) {
    errors.push("'vmLifecycle' must be an object");
  } else {
    for (const key of ["before", "after", "created", "removed"] as const) {
      if (!Array.isArray(lifecycle[key])) {
        errors.push(`vmLifecycle.${key} must be an array`);
      }
    }
    if (lifecycle.all_gate_vms_closed !== true) {
      errors.push("vmLifecycle.all_gate_vms_closed must be true");
    }
    if (lifecycle.every_created_vm_removed !== true) {
      errors.push("vmLifecycle.every_created_vm_removed must be true");
    }
    if (lifecycle.before_equals_after !== true) {
      errors.push("vmLifecycle.before_equals_after must be true");
    }
    if (!isPlainObject(lifecycle.per_gate)) {
      errors.push("vmLifecycle.per_gate must be an object");
    } else {
      for (const [key, entry] of Object.entries(lifecycle.per_gate)) {
        if (!isPlainObject(entry)) {
          errors.push(`vmLifecycle.per_gate['${key}'] must be an object`);
          continue;
        }
        if (entry.vm_closed !== true) {
          errors.push(`vmLifecycle.per_gate['${key}'].vm_closed must be true`);
        }
        if (entry.private_vm_list_empty !== true) {
          errors.push(`vmLifecycle.per_gate['${key}'].private_vm_list_empty must be true`);
        }
        if (
          !isNonEmptyString(entry.cleanup_complete_line) ||
          !String(entry.cleanup_complete_line).includes(
            "cleanup complete: no owned VM rows/state dirs remain",
          )
        ) {
          errors.push(
            `vmLifecycle.per_gate['${key}'].cleanup_complete_line must record the cleanup completion`,
          );
        }
      }
    }
  }

  // ── kill trace: sender present, or explicitly none observed ───────────
  const killTrace = value.killTrace;
  if (!isPlainObject(killTrace)) {
    errors.push("'killTrace' must be an object");
  } else {
    if (!isNonEmptyString(killTrace.sender)) {
      errors.push("killTrace.sender must be a non-empty string");
    }
    if (typeof killTrace.observed !== "boolean") {
      errors.push("killTrace.observed must be a boolean");
    }
  }

  // ── build identity: SYSTEM matchlock, unpinned ────────────────────────
  const identity = value.buildIdentity;
  if (!isPlainObject(identity)) {
    errors.push("'buildIdentity' must be an object");
  } else {
    if (!isNonEmptyString(identity.matchlockPath)) {
      errors.push("buildIdentity.matchlockPath must be a non-empty string");
    } else if (!identity.matchlockPath.startsWith(`${SYSTEM_MATCHLOCK_PREFIX}/`)) {
      errors.push(
        `buildIdentity.matchlockPath must resolve under ${SYSTEM_MATCHLOCK_PREFIX}/ (got ${identity.matchlockPath})`,
      );
    }
    if (!isNonEmptyString(identity.matchlockVersion)) {
      errors.push("buildIdentity.matchlockVersion must be a non-empty string");
    }
    if (identity.pinned !== false) {
      errors.push("buildIdentity.pinned must be false (the SYSTEM runtime is unpinned)");
    }
  }

  return errors;
}

/** Assert the four schema steps form the exact 9->10->11->12->13 chain. */
function checkChainEdges(edges: string[], errors: string[]): void {
  const expected = ["9->10", "10->11", "11->12", "12->13"];
  if (edges.join("|") !== expected.join("|")) {
    errors.push(`schemaChain.steps must form ${UNION_PORT_SCHEMA_CHAIN}`);
  }
}

/** Minimal structurally valid contract, reused across the error cases. */
export function buildMinimalValidContract(): Record<string, unknown> {
  return {
    schema: "union-port-contract/1",
    contract: "UNION-PORT",
    finalSquashHash: null,
    finalSquashNote: "coordinator fills after landing",
    conflictGroups: UNION_PORT_CONFLICT_PATHS.map((p) => ({
      path: p,
      mainSide: "main side",
      unionSide: "union side",
      resolution: "kept both behaviors",
    })),
    schemaChain: {
      version: 13,
      chain: "9->10->11->12->13",
      steps: [
        { from: 9, to: 10, change: "instants", guard: "unconditional" },
        { from: 10, to: 11, change: "target_moved", guard: "pragma" },
        { from: 11, to: 12, change: "preclaim", guard: "pragma" },
        { from: 12, to: 13, change: "matchlock_policy", guard: "pragma" },
      ],
      lineageDetector: {
        name: "detectSchemaLineage",
        mechanism: "PRAGMA table_info, never user_version",
      },
      testFile: "src/db.test.ts",
      testResult: { tests: 117, pass: 117, fail: 0, status: "green" },
      testNames: ["a", "b", "c", "d", "e", "f"],
    },
    tests: {
      hostGates: UNION_PORT_HOST_GATE_NAMES.map((name) => ({
        name,
        command: `gate ${name}`,
        exit: 0,
        evidence_path: `/home/kaladin/matchlock-work/union-port-gates/${name}.log`,
        evidence_exists: true,
      })),
    },
    gates: UNION_PORT_MATCHLOCK_GATE_KEYS.map((key) => ({
      key,
      name: `run-matchlock-${key}-e2e-test`,
      command: `./run-matchlock-${key}-e2e-test`,
      exit: 0,
      observed_rounds: 2,
      observed_rounds_path: `/home/kaladin/matchlock-work/evidence/${key}-AAAAAA/observed-rounds.json`,
      observed_rounds_path_exists: true,
      evidence_path: `/home/kaladin/matchlock-work/evidence/${key}-AAAAAA`,
      evidence_exists: true,
      observed_vm_ids: ["vm-01234567", "vm-89abcdef"],
      vm_closed: true,
    })),
    vmLifecycle: {
      before: [],
      after: [],
      created: ["vm-01234567", "vm-89abcdef"],
      removed: ["vm-01234567", "vm-89abcdef"],
      all_gate_vms_closed: true,
      every_created_vm_removed: true,
      before_equals_after: true,
      per_gate: Object.fromEntries(
        UNION_PORT_MATCHLOCK_GATE_KEYS.map((key) => [
          key,
          {
            vm_closed: true,
            private_vm_list_empty: true,
            cleanup_complete_line:
              "2026-09-19T00:00:01Z cleanup complete: no owned VM rows/state dirs remain",
          },
        ]),
      ),
    },
    killTrace: { sender: "none observed", observed: false },
    buildIdentity: {
      matchlockPath: `${SYSTEM_MATCHLOCK_PREFIX}/matchlock`,
      matchlockVersion: "matchlock version 0.2.17",
      pinned: false,
    },
  };
}

describe("UNION-PORT US-013 delivery-contract validator", () => {
  it("accepts the minimal valid contract", () => {
    assert.deepEqual(validateUnionPortContract(buildMinimalValidContract()), []);
  });

  it("rejects non-object input", () => {
    assert.deepEqual(validateUnionPortContract("nope"), [
      "union-port contract must be a JSON object",
    ]);
    assert.deepEqual(validateUnionPortContract(null), [
      "union-port contract must be a JSON object",
    ]);
    assert.deepEqual(validateUnionPortContract([buildMinimalValidContract()]), [
      "union-port contract must be a JSON object",
    ]);
  });

  it("requires the root keys", () => {
    const value = buildMinimalValidContract();
    delete value.killTrace;
    const errors = validateUnionPortContract(value);
    assert.ok(errors.includes("missing required key 'killTrace'"));
  });

  it("refuses to pin a story hash in finalSquashHash", () => {
    const value = buildMinimalValidContract();
    value.finalSquashHash = "ed0012a3be9d83835b18ff50e66d9ddf091de898";
    assert.ok(
      validateUnionPortContract(value).includes(
        "finalSquashHash must be null (the coordinator fills it after landing; story hashes are never pinned)",
      ),
    );
  });

  it("requires all four conflicted paths with both sides and a resolution", () => {
    const value = buildMinimalValidContract();
    (value.conflictGroups as unknown[]).splice(1, 1);
    const errors = validateUnionPortContract(value);
    assert.ok(
      errors.includes(
        "conflictGroups is missing the conflicted path 'src/cli/commands/workflow.ts'",
      ),
    );

    const incomplete = buildMinimalValidContract();
    (incomplete.conflictGroups as Record<string, unknown>[])[0].unionSide = "";
    assert.ok(
      validateUnionPortContract(incomplete).includes(
        "conflictGroups[0].unionSide must be a non-empty string",
      ),
    );
  });

  it("pins SCHEMA_VERSION 13 and the 9->10->11->12->13 chain", () => {
    const wrongVersion = buildMinimalValidContract();
    (wrongVersion.schemaChain as Record<string, unknown>).version = 12;
    assert.ok(
      validateUnionPortContract(wrongVersion).includes(
        "schemaChain.version must be 13 (got 12)",
      ),
    );

    const wrongChain = buildMinimalValidContract();
    (wrongChain.schemaChain as Record<string, unknown>).chain = "9->10->11->12";
    assert.ok(
      validateUnionPortContract(wrongChain).includes(
        "schemaChain.chain must be '9->10->11->12->13' (got 9->10->11->12)",
      ),
    );

    const wrongSteps = buildMinimalValidContract();
    const steps = (wrongSteps.schemaChain as Record<string, unknown>).steps as unknown[];
    steps.splice(1, 1);
    assert.ok(
      validateUnionPortContract(wrongSteps).includes(
        "schemaChain.steps must be the four 9->10->11->12->13 steps",
      ),
    );
  });

  it("requires the PRAGMA table_info lineage detector and a green migration run", () => {
    const value = buildMinimalValidContract();
    const schema = value.schemaChain as Record<string, unknown>;
    (schema.lineageDetector as Record<string, unknown>).mechanism = "guessed";
    (schema.testResult as Record<string, unknown>).fail = 1;
    (schema.testResult as Record<string, unknown>).status = "red";
    const errors = validateUnionPortContract(value);
    assert.ok(
      errors.includes("schemaChain.lineageDetector.mechanism must say it reads PRAGMA table_info"),
    );
    assert.ok(errors.includes("schemaChain.testResult.fail must be 0"));
    assert.ok(errors.includes("schemaChain.testResult.status must be 'green'"));
  });

  it("requires all four host gates", () => {
    const value = buildMinimalValidContract();
    const hostGates = (value.tests as Record<string, unknown>).hostGates as unknown[];
    hostGates.splice(2, 1);
    assert.ok(
      validateUnionPortContract(value).includes("missing required host gate 'testcmd'"),
    );
  });

  it("requires all eight Matchlock gates with positive observed rounds", () => {
    const missing = buildMinimalValidContract();
    const gates = missing.gates as Record<string, unknown>[];
    gates.splice(4, 1);
    assert.ok(validateUnionPortContract(missing).includes("missing required Matchlock gate 'dsh'"));

    for (const rounds of [0, -1, 1.5, "3"]) {
      const value = buildMinimalValidContract();
      (value.gates as Record<string, unknown>[])[0].observed_rounds = rounds;
      assert.ok(
        validateUnionPortContract(value).includes(
          `gates[0].observed_rounds must be a positive integer (got ${String(rounds)})`,
        ),
      );
    }
  });

  it("accepts a red Matchlock gate only with a complete documented blocked object", () => {
    const blocked = {
      preExisting: true,
      reason: "guest sandbox re-exec",
      classification: "pre-existing runtime blocker",
      evidence: "/home/kaladin/matchlock-work/evidence/dsh-exec-AAAA/nonstandard-path-invocation.json",
      docsCitation: "docs/matchlock-dsh-qualification.md#5",
    };
    const withBlockedDsh = (patch: Record<string, unknown>): Record<string, unknown> => {
      const value = buildMinimalValidContract();
      const gates = value.gates as Record<string, unknown>[];
      gates[4] = { ...gates[4], ...patch };
      return value;
    };
    assert.deepEqual(validateUnionPortContract(withBlockedDsh({ exit: 1, blocked })), []);
    for (const key of ["reason", "classification", "evidence", "docsCitation"] as const) {
      const incomplete = { ...blocked, [key]: "" };
      assert.ok(
        validateUnionPortContract(withBlockedDsh({ exit: 1, blocked: incomplete })).includes(
          "gates[4].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
        ),
        `an incomplete blocked object missing '${key}' must be rejected`,
      );
    }
  });

  it("requires VM closure for every gate and the global lifecycle flags", () => {
    const value = buildMinimalValidContract();
    const lifecycle = value.vmLifecycle as Record<string, unknown>;
    lifecycle.all_gate_vms_closed = false;
    lifecycle.every_created_vm_removed = false;
    lifecycle.before_equals_after = false;
    const perGate = lifecycle.per_gate as Record<string, Record<string, unknown>>;
    perGate.synthetic.vm_closed = false;
    perGate.synthetic.private_vm_list_empty = false;
    perGate.synthetic.cleanup_complete_line = "still running";
    const errors = validateUnionPortContract(value);
    assert.ok(errors.includes("vmLifecycle.all_gate_vms_closed must be true"));
    assert.ok(errors.includes("vmLifecycle.every_created_vm_removed must be true"));
    assert.ok(errors.includes("vmLifecycle.before_equals_after must be true"));
    assert.ok(errors.includes("vmLifecycle.per_gate['synthetic'].vm_closed must be true"));
    assert.ok(
      errors.includes("vmLifecycle.per_gate['synthetic'].private_vm_list_empty must be true"),
    );
    assert.ok(
      errors.includes(
        "vmLifecycle.per_gate['synthetic'].cleanup_complete_line must record the cleanup completion",
      ),
    );
  });

  it("requires a truthful kill-trace sender and the SYSTEM unpinned runtime", () => {
    const value = buildMinimalValidContract();
    (value.killTrace as Record<string, unknown>).sender = "";
    (value.killTrace as Record<string, unknown>).observed = "no";
    (value.buildIdentity as Record<string, unknown>).matchlockPath = "/opt/private/matchlock";
    (value.buildIdentity as Record<string, unknown>).pinned = true;
    const errors = validateUnionPortContract(value);
    assert.ok(errors.includes("killTrace.sender must be a non-empty string"));
    assert.ok(errors.includes("killTrace.observed must be a boolean"));
    assert.ok(
      errors.includes(
        "buildIdentity.matchlockPath must resolve under /usr/local/bin/ (got /opt/private/matchlock)",
      ),
    );
    assert.ok(errors.includes("buildIdentity.pinned must be false (the SYSTEM runtime is unpinned)"));
  });

  it("pins the required gate/rounding constants", () => {
    assert.equal(UNION_PORT_SCHEMA_VERSION, 13);
    assert.equal(UNION_PORT_SCHEMA_CHAIN, "9->10->11->12->13");
    assert.deepEqual([...UNION_PORT_CONFLICT_PATHS], [
      "run-all-e2e-tests",
      "src/cli/commands/workflow.ts",
      "src/db.ts",
      "src/db.test.ts",
    ]);
    assert.deepEqual([...UNION_PORT_HOST_GATE_NAMES], ["build", "db-test", "testcmd", "e2e"]);
    assert.deepEqual([...UNION_PORT_MATCHLOCK_GATE_KEYS], [
      "synthetic",
      "hermes-synthetic",
      "empty-output",
      "long-home",
      "dsh",
      "dsh-profile-overlay",
      "dsh-real-boot",
      "worktree-merge",
    ]);
    assert.equal(UNION_PORT_GATE_LOCK, "/home/kaladin/matchlock-work/vaivm-gate.lock");
  });

  // ---- real published deliverable + cross-checked evidence ----

  function contractPath(): string {
    return process.env.UNION_PORT_CONTRACT_PATH ?? DEFAULT_UNION_PORT_CONTRACT_PATH;
  }

  function skipUnlessContract(): string | false {
    const file = contractPath();
    if (!existsSync(file)) {
      return `contract not found at ${file}`;
    }
    return false;
  }

  function readJson(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  }

  it(
    "parses the published contract as JSON and finds it structurally complete",
    { skip: skipUnlessContract() },
    () => {
      const parsed = readJson(contractPath());
      assert.deepEqual(validateUnionPortContract(parsed), []);
    },
  );

  it(
    "cross-checks the conflict groups against union-port-conflicts.json",
    { skip: skipUnlessContract() },
    () => {
      const parsed = readJson(contractPath());
      const evidencePath = process.env.UNION_PORT_CONFLICTS_PATH ?? UNION_PORT_CONFLICTS_PATH;
      assert.ok(existsSync(evidencePath), `conflicts evidence must exist: ${evidencePath}`);
      const evidence = readJson(evidencePath);
      const evidenceGroups = evidence.conflict_groups as Array<Record<string, unknown>>;
      const evidencePaths = evidenceGroups.map((group) => String(group.path)).sort();
      const contractPaths = (parsed.conflictGroups as Array<Record<string, unknown>>)
        .map((group) => String(group.path))
        .sort();
      assert.deepEqual(contractPaths, evidencePaths);
      // The resolution the contract publishes must be the one recorded on disk.
      for (const group of parsed.conflictGroups as Array<Record<string, unknown>>) {
        const match = evidenceGroups.find((candidate) => candidate.path === group.path);
        assert.ok(match, `evidence for conflict '${String(group.path)}'`);
        assert.equal(group.resolution, match!.resolution, `resolution for '${String(group.path)}'`);
      }
    },
  );

  it(
    "cross-checks every host gate against union-port-host-gates.json and its retained log",
    { skip: skipUnlessContract() },
    () => {
      const parsed = readJson(contractPath());
      const evidencePath = process.env.UNION_PORT_HOST_GATES_PATH ?? UNION_PORT_HOST_GATES_PATH;
      assert.ok(existsSync(evidencePath), `host-gates evidence must exist: ${evidencePath}`);
      const evidence = readJson(evidencePath);
      const evidenceGates = evidence.gates as Array<Record<string, unknown>>;
      const contractGates = (parsed.tests as Record<string, unknown>).hostGates as Array<
        Record<string, unknown>
      >;
      assert.deepEqual(
        contractGates.map((gate) => gate.name).sort(),
        evidenceGates.map((gate) => gate.name).sort(),
      );
      for (const gate of contractGates) {
        const match = evidenceGates.find((candidate) => candidate.name === gate.name);
        assert.ok(match, `host-gates entry for '${String(gate.name)}'`);
        assert.equal(gate.command, match!.command, `command for '${String(gate.name)}'`);
        assert.equal(gate.exit, match!.exit, `exit for '${String(gate.name)}'`);
        assert.equal(gate.evidence_path, match!.log, `log for '${String(gate.name)}'`);
        assert.ok(existsSync(String(gate.evidence_path)), `host log exists: ${String(gate.evidence_path)}`);
      }
    },
  );

  it(
    "cross-checks every Matchlock gate, round count and VM id against its retained evidence",
    { skip: skipUnlessContract() },
    () => {
      const parsed = readJson(contractPath());
      const evidencePath =
        process.env.UNION_PORT_MATCHLOCK_GATES_PATH ?? UNION_PORT_MATCHLOCK_GATES_PATH;
      assert.ok(existsSync(evidencePath), `matchlock-gates evidence must exist: ${evidencePath}`);
      const evidence = readJson(evidencePath);
      const evidenceGates = evidence.gates as Record<string, Record<string, unknown>>;
      const gates = parsed.gates as Array<Record<string, unknown>>;
      assert.deepEqual(
        gates.map((gate) => gate.key).sort(),
        Object.keys(evidenceGates).sort(),
      );
      for (const gate of gates) {
        const key = String(gate.key);
        const match = evidenceGates[key];
        assert.ok(match, `matchlock-gates entry for '${key}'`);
        assert.equal(gate.name, match!.name, `runner for '${key}'`);
        assert.equal(gate.command, match!.command, `command for '${key}'`);
        assert.equal(gate.exit, match!.exit, `exit for '${key}'`);
        assert.equal(gate.observed_rounds, match!.observedRounds, `rounds for '${key}'`);
        assert.deepEqual(
          [...(gate.observed_vm_ids as string[])].sort(),
          [...(match!.observedVmIds as string[])].sort(),
          `VM ids for '${key}'`,
        );
        // The retained observed-rounds.json is the ground truth no summary can fake.
        assert.ok(
          existsSync(String(gate.observed_rounds_path)),
          `observed-rounds.json for '${key}'`,
        );
        const rounds = JSON.parse(readFileSync(String(gate.observed_rounds_path), "utf-8")) as {
          gate: string;
          observed_rounds: number;
          observed_vm_ids: string[];
        };
        assert.equal(rounds.gate, key, `retained gate label for '${key}'`);
        assert.equal(rounds.observed_rounds, gate.observed_rounds, `retained rounds for '${key}'`);
        assert.deepEqual(
          [...rounds.observed_vm_ids].sort(),
          [...(gate.observed_vm_ids as string[])].sort(),
          `retained VM ids for '${key}'`,
        );
      }
    },
  );

  it(
    "cross-checks the VM lifecycle against the evidence and each gate's cleanup ledger",
    { skip: skipUnlessContract() },
    () => {
      const parsed = readJson(contractPath());
      const evidencePath =
        process.env.UNION_PORT_MATCHLOCK_GATES_PATH ?? UNION_PORT_MATCHLOCK_GATES_PATH;
      assert.ok(existsSync(evidencePath), `matchlock-gates evidence must exist: ${evidencePath}`);
      const evidence = readJson(evidencePath);
      const lifecycle = parsed.vmLifecycle as Record<string, unknown>;
      const evidenceLifecycle = evidence.vmLifecycle as Record<string, unknown>;
      assert.deepEqual(lifecycle.before, evidenceLifecycle.before, "before VM set");
      assert.deepEqual(lifecycle.after, evidenceLifecycle.after, "after VM set");
      assert.deepEqual(lifecycle.created, evidenceLifecycle.created, "created VM set");
      assert.deepEqual(lifecycle.removed, evidenceLifecycle.removed, "removed VM set");
      assert.ok(
        (lifecycle.created as string[]).every((vm) => (lifecycle.removed as string[]).includes(vm)),
        "every created VM must also be removed",
      );
      assert.deepEqual(lifecycle.before, lifecycle.after, "the host's global VM set is unchanged");

      const perGate = lifecycle.per_gate as Record<string, Record<string, unknown>>;
      const evidenceGates = evidence.gates as Record<string, Record<string, unknown>>;
      for (const [key, gate] of Object.entries(perGate)) {
        const raw = evidenceGates[key];
        assert.ok(raw, `evidence closure for '${key}'`);
        assert.equal(gate.cleanup_ledger_path, raw!.cleanupLedgerPath, `ledger for '${key}'`);
        assert.ok(existsSync(String(gate.cleanup_ledger_path)), `ledger exists for '${key}'`);
        const ledger = readFileSync(String(gate.cleanup_ledger_path), "utf-8")
          .trim()
          .split("\n");
        assert.equal(
          ledger[ledger.length - 1],
          gate.cleanup_complete_line,
          `ledger completion line for '${key}'`,
        );
        assert.ok(
          String(gate.cleanup_complete_line).includes(
            "cleanup complete: no owned VM rows/state dirs remain",
          ),
          `positive closure for '${key}'`,
        );
        assert.equal(gate.private_vm_list_path, raw!.privateVmListPath, `private list for '${key}'`);
        assert.ok(
          existsSync(String(gate.private_vm_list_path)),
          `private VM list exists for '${key}'`,
        );
      }
    },
  );

  it(
    "cross-checks the build identity against the SYSTEM matchlock evidence",
    { skip: skipUnlessContract() },
    () => {
      const parsed = readJson(contractPath());
      const evidencePath =
        process.env.UNION_PORT_MATCHLOCK_GATES_PATH ?? UNION_PORT_MATCHLOCK_GATES_PATH;
      assert.ok(existsSync(evidencePath), `matchlock-gates evidence must exist: ${evidencePath}`);
      const evidence = readJson(evidencePath);
      assert.deepEqual(parsed.buildIdentity, evidence.buildIdentity);
    },
  );

  it(
    "records a truthful kill trace",
    { skip: skipUnlessContract() },
    () => {
      const parsed = readJson(contractPath());
      const killTrace = parsed.killTrace as Record<string, unknown>;
      assert.ok(isNonEmptyString(killTrace.sender), "killTrace.sender");
      assert.equal(typeof killTrace.observed, "boolean", "killTrace.observed");
      if (killTrace.observed === false) {
        assert.equal(killTrace.sender, "none observed");
      }
    },
  );

  it(
    "pins every recorded Matchlock runner to a real script in the repo root",
    { skip: skipUnlessContract() },
    () => {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const parsed = readJson(contractPath());
      const failures: string[] = [];
      for (const gate of parsed.gates as Array<Record<string, unknown>>) {
        const runner = path.join(repoRoot, String(gate.name));
        if (!existsSync(runner)) {
          failures.push(`gates['${String(gate.key)}'] runner '${String(gate.name)}' does not exist`);
        }
        if (gate.command !== `./${String(gate.name)}`) {
          failures.push(
            `gates['${String(gate.key)}'] command '${String(gate.command)}' is not './${String(gate.name)}'`,
          );
        }
      }
      assert.deepEqual(failures, []);
    },
  );
});
