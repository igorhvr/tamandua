/**
 * UNION-FINAL US-011 (and the US-012/US-013 append) — deliverable validator for
 * the real-VM Matchlock gate battery evidence.
 *
 * The run deliverable
 * `/home/kaladin/matchlock-work/union-final-matchlock-gates.json` lives OUTSIDE
 * the repository on purpose (it is host state, never committed, never placed in
 * the worktree). This file carries the validator the story asks for: a pure
 * `validateUnionFinalMatchlockGates(value): string[]` plus always-on unit tests
 * covering the structural contract, and a real-file assertion that defaults to
 * the canonical deliverable path (overridable with
 * `UNION_FINAL_MATCHLOCK_GATES_PATH`) and is skipped when that file is absent —
 * so the committed suite never hard-depends on host state.
 *
 * US-011/US-012/US-013 rules enforced here:
 *   - one entry per gate, each recording {name, runner, command, exit,
 *     observed_rounds, observed_vm_ids, evidence_path, startedAt, endedAt,
 *     notes};
 *   - the five part-1 gates are present (synthetic, hermes-synthetic,
 *     empty-output, long-home, worktree-merge);
 *   - the four part-2 dsh gates are present (dsh, dsh-profile-overlay,
 *     dsh-real-boot, dsh-merge-worktree);
 *   - the three part-3 gates the three landings added are present
 *     (hermes-merge-worktree, vm-size, cleanup);
 *   - every gate exited 0 (a red gate is never evidence of a passing battery);
 *   - every gate observed at least one in-VM round (observed_rounds > 0) with a
 *     well-formed vm-<8 hex> id, so the no-fake-green guard could never have
 *     exited 92;
 *   - the runtime is the SYSTEM unpinned `/usr/local/bin/matchlock` (never a
 *     pinned/private copy and never an env pin override in the command);
 *   - no entry runs the native real e2e tier or the real-credential canaries;
 *   - when the real deliverable is present, every referenced evidence dir and
 *     its `observed-rounds.json` exists and agrees with the recorded counts.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The external deliverable published by the Matchlock gate stories. */
export const DEFAULT_UNION_FINAL_MATCHLOCK_GATES_PATH =
  "/home/kaladin/matchlock-work/union-final-matchlock-gates.json";

/** The canonical shared gate lock every Matchlock gate runs under. */
export const UNION_FINAL_GATE_LOCK = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/** The SYSTEM matchlock resolved from PATH, unpinned (never a private copy). */
export const SYSTEM_MATCHLOCK_PATH = "/usr/local/bin/matchlock";

/**
 * The five gates US-011 must run, in order. Names are stable machine keys so
 * the union-final contract can index them without parsing command text.
 */
export const UNION_FINAL_MATCHLOCK_PART1_GATES = [
  "synthetic",
  "hermes-synthetic",
  "empty-output",
  "long-home",
  "worktree-merge",
] as const;

/**
 * The four gates US-012 must run: the dsh family (synthetic whole-path, host
 * profile-overlay invariance, real-dsh boot over an operator-shaped home, and
 * the dsh merge-worktree whole-path gate). Names are the `observed-rounds.json`
 * gate labels each runner passes to the guard.
 */
export const UNION_FINAL_MATCHLOCK_PART2_GATES = [
  "dsh",
  "dsh-profile-overlay",
  "dsh-real-boot",
  "dsh-merge-worktree",
] as const;

/**
 * The three gates US-013 must run: the gates the three Matchlock-line landings
 * added (all-workflows hermes merge-worktree, configurable VM size, and the
 * post-harness cleanup/reaper policy). Names are the `observed-rounds.json`
 * gate labels each runner passes to the guard.
 */
export const UNION_FINAL_MATCHLOCK_PART3_GATES = [
  "hermes-merge-worktree",
  "vm-size",
  "cleanup",
] as const;

/**
 * The full twelve-gate family the union-final contract folds together
 * (US-011..US-013). The part-1/part-2/part-3 subsets are ALL REQUIRED by this
 * validator; the list is the canonical ordered index for the contract.
 */
export const UNION_FINAL_MATCHLOCK_ALL_GATES = [
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

/**
 * The `observed-rounds.json` gate label each gate key maps to. The runner
 * passes `--gate <label>` to `scripts/observed-rounds-guard.mjs`, so the label
 * must agree with the recorded key.
 */
export const UNION_FINAL_MATCHLOCK_GATE_LABELS: Record<string, string> = {
  synthetic: "synthetic",
  "hermes-synthetic": "hermes-synthetic",
  "empty-output": "empty-output",
  "long-home": "long-home",
  "worktree-merge": "worktree-merge",
  dsh: "dsh",
  "dsh-profile-overlay": "dsh-profile-overlay",
  "dsh-real-boot": "dsh-real-boot",
  "dsh-merge-worktree": "dsh-merge-worktree",
  "hermes-merge-worktree": "hermes-merge-worktree",
  "vm-size": "vm-size",
  cleanup: "cleanup",
};

/**
 * Gate commands that are invalid evidence: the native real-e2e tier and the
 * real-credential canaries (the coordinator certifies those), and any command
 * that pins a private matchlock through the env override instead of resolving
 * the SYSTEM binary from PATH.
 */
export const UNION_FINAL_MATCHLOCK_FORBIDDEN_COMMAND_PATTERNS = [
  "run-all-real-e2e-tests",
  "run-real-e2e-canary",
  "TAMANDUA_MATCHLOCK_RPC_BIN=",
] as const;

const REQUIRED_STRING_FIELDS = [
  "name",
  "runner",
  "command",
  "evidence_path",
  "startedAt",
  "endedAt",
] as const;

const REQUIRED_ROOT_FIELDS = ["runId", "branch", "commit", "lock"] as const;

/**
 * US-012 documented-blocker contract (ported from the union-port validator). A
 * gate may be recorded red ONLY when it carries this object. That keeps the
 * no-fake-green rule honest: an undocumented non-zero exit still fails
 * validation, while a pre-existing, runtime-blocked gate (the synthetic dsh
 * gate's nonstandard-image-PATH positive, documented in
 * docs/matchlock-dsh-qualification.md §5) is recorded truthfully with its
 * classification/evidence/citation instead of being massaged into a green.
 */
const REQUIRED_BLOCKED_STRING_FIELDS = [
  "reason",
  "classification",
  "evidence",
  "docsCitation",
] as const;

const VM_ID_RE = /^vm-[0-9a-f]{8}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
 * Validate the parsed union-final Matchlock gate battery evidence. Returns a
 * list of human-readable errors; an empty list means the evidence is
 * structurally the one the stories require. Pure — never touches the
 * filesystem.
 */
export function validateUnionFinalMatchlockGates(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ["matchlock-gates evidence must be a JSON object"];
  }

  for (const key of REQUIRED_ROOT_FIELDS) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
      errors.push(`'${key}' must be a non-empty string`);
    }
  }

  if (!isPlainObject(value.matchlock)) {
    errors.push("'matchlock' must be an object");
  } else {
    if (value.matchlock.path !== SYSTEM_MATCHLOCK_PATH) {
      errors.push(
        `matchlock.path must be the SYSTEM unpinned '${SYSTEM_MATCHLOCK_PATH}' (got ${JSON.stringify(
          value.matchlock.path,
        )})`,
      );
    }
    if (typeof value.matchlock.sha256 !== "string" || value.matchlock.sha256.length !== 64) {
      errors.push("matchlock.sha256 must be the 64-hex observed binary digest");
    }
  }

  if (!Array.isArray(value.gates)) {
    errors.push("'gates' must be an array");
    return errors;
  }

  const names: string[] = [];
  value.gates.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      errors.push(`gates[${index}] must be an object`);
      return;
    }
    for (const key of REQUIRED_STRING_FIELDS) {
      const field = entry[key];
      if (typeof field !== "string" || field.length === 0) {
        errors.push(`gates[${index}].${key} must be a non-empty string`);
      }
    }
    if (typeof entry.notes !== "string") {
      errors.push(`gates[${index}].notes must be a string`);
    }
    if (!Number.isInteger(entry.exit)) {
      errors.push(`gates[${index}].exit must be an integer`);
    } else if (entry.exit !== 0) {
      // US-012: a red gate is only acceptable when it is a DOCUMENTED
      // pre-existing blocker. Anything else is an undocumented failure.
      if (!isDocumentedBlockedGate(entry)) {
        errors.push(
          `gates[${index}].exit must be 0 (got ${String(entry.exit)}) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}`,
        );
      } else {
        const blocked = entry.blocked as Record<string, unknown>;
        for (const key of REQUIRED_BLOCKED_STRING_FIELDS) {
          if (!isNonEmptyString(blocked[key])) {
            errors.push(`gates[${index}].blocked.${key} must be a non-empty string`);
          }
        }
      }
    } else if (isPlainObject(entry.blocked)) {
      // A green gate must never carry a blocker (it would be contradictory).
      errors.push(`gates[${index}].blocked must be absent when exit is 0`);
    }
    // No fake green: a gate that observed no in-VM round is not evidence.
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
      if (entry.observed_vm_ids.length < 1) {
        errors.push(`gates[${index}].observed_vm_ids must not be empty`);
      }
      for (const id of entry.observed_vm_ids) {
        if (typeof id !== "string" || !VM_ID_RE.test(id)) {
          errors.push(
            `gates[${index}].observed_vm_ids contains an invalid VM id ${JSON.stringify(id)}`,
          );
        }
      }
      if (
        Number.isInteger(entry.observed_rounds) &&
        entry.observed_vm_ids.length > 0 &&
        entry.observed_rounds !== entry.observed_vm_ids.length
      ) {
        errors.push(
          `gates[${index}].observed_rounds must equal the distinct observed_vm_ids count`,
        );
      }
    }
    if (typeof entry.name === "string" && entry.name.length > 0) {
      names.push(entry.name);
      if (!Object.prototype.hasOwnProperty.call(UNION_FINAL_MATCHLOCK_GATE_LABELS, entry.name)) {
        errors.push(`gates[${index}].name '${entry.name}' is not a known Matchlock gate`);
      }
    }
    if (typeof entry.command === "string") {
      for (const pattern of UNION_FINAL_MATCHLOCK_FORBIDDEN_COMMAND_PATTERNS) {
        if (entry.command.includes(pattern)) {
          errors.push(
            `gates[${index}].command must not use a pinned/private matchlock or the real tiers (${pattern})`,
          );
        }
      }
    }
    // Timestamps, when present as strings, must be parseable instants.
    for (const key of ["startedAt", "endedAt"] as const) {
      const field = entry[key];
      if (typeof field === "string" && field.length > 0 && !isIsoInstant(field)) {
        errors.push(`gates[${index}].${key} must be a parseable instant`);
      }
    }
  });

  for (const required of [
    ...UNION_FINAL_MATCHLOCK_PART1_GATES,
    ...UNION_FINAL_MATCHLOCK_PART2_GATES,
    ...UNION_FINAL_MATCHLOCK_PART3_GATES,
  ]) {
    if (!names.includes(required)) {
      errors.push(`missing required Matchlock gate '${required}'`);
    }
  }
  for (const duplicate of new Set(names.filter((name, i) => names.indexOf(name) !== i))) {
    errors.push(`duplicate gate '${duplicate}'`);
  }

  return errors;
}

/** Minimal structurally valid evidence, reused across the error cases. */
export function buildMinimalValidMatchlockGates(): Record<string, unknown> {
  return {
    runId: "run-04763ce1-d1b1-4224-bd9a-47e2fa351f86",
    branch: "feature/union-final-matchlock-20260920",
    commit: "0123456789abcdef0123456789abcdef01234567",
    lock: UNION_FINAL_GATE_LOCK,
    matchlock: {
      path: SYSTEM_MATCHLOCK_PATH,
      version: "matchlock version 0.2.17",
      sha256: "a".repeat(64),
    },
    gates: [
      ...UNION_FINAL_MATCHLOCK_PART1_GATES,
      ...UNION_FINAL_MATCHLOCK_PART2_GATES,
      ...UNION_FINAL_MATCHLOCK_PART3_GATES,
    ].map((name, index) => ({
      name,
      runner: `run-${name}-e2e-test`,
      command: `./run-${name}-e2e-test`,
      exit: 0,
      observed_rounds: 1,
      observed_vm_ids: [`vm-${index.toString(16).padStart(8, "0")}`],
      evidence_path: `/home/kaladin/matchlock-work/evidence/${name}-fixture`,
      startedAt: "2026-09-21T00:00:00Z",
      endedAt: "2026-09-21T00:00:01Z",
      notes: "",
    })),
  };
}

/** Shallow-clone evidence with one gate entry replaced. */
function withGate(
  index: number,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const value = buildMinimalValidMatchlockGates();
  const gates = value.gates as Record<string, unknown>[];
  gates[index] = { ...gates[index], ...patch };
  return value;
}

/** The published deliverable path, honouring the test override. */
function publishedMatchlockGatesPath(): string {
  return (
    process.env.UNION_FINAL_MATCHLOCK_GATES_PATH ??
    DEFAULT_UNION_FINAL_MATCHLOCK_GATES_PATH
  );
}

describe("UNION-FINAL Matchlock gate battery evidence validator", () => {
  it("accepts the minimal valid evidence", () => {
    assert.deepEqual(validateUnionFinalMatchlockGates(buildMinimalValidMatchlockGates()), []);
  });

  it("rejects non-object evidence", () => {
    assert.deepEqual(validateUnionFinalMatchlockGates("nope"), [
      "matchlock-gates evidence must be a JSON object",
    ]);
    assert.deepEqual(validateUnionFinalMatchlockGates(null), [
      "matchlock-gates evidence must be a JSON object",
    ]);
    assert.deepEqual(validateUnionFinalMatchlockGates([buildMinimalValidMatchlockGates()]), [
      "matchlock-gates evidence must be a JSON object",
    ]);
  });

  it("requires the run metadata fields", () => {
    const value = buildMinimalValidMatchlockGates();
    delete value.commit;
    value.branch = "";
    const errors = validateUnionFinalMatchlockGates(value);
    assert.ok(errors.includes("'commit' must be a non-empty string"));
    assert.ok(errors.includes("'branch' must be a non-empty string"));
  });

  it("requires the SYSTEM unpinned matchlock and its observed digest", () => {
    const notSystem = buildMinimalValidMatchlockGates();
    (notSystem.matchlock as Record<string, unknown>).path =
      "/home/kaladin/matchlock-work/evidence/fuse-qual-refine-20260909T101655Z/bin/matchlock";
    assert.ok(
      validateUnionFinalMatchlockGates(notSystem).includes(
        `matchlock.path must be the SYSTEM unpinned '${SYSTEM_MATCHLOCK_PATH}' (got "/home/kaladin/matchlock-work/evidence/fuse-qual-refine-20260909T101655Z/bin/matchlock")`,
      ),
    );
    assert.ok(
      validateUnionFinalMatchlockGates(withGate(0, {})).length === 0,
      "a gate patch must not disturb the root matchlock block",
    );
    const badDigest = buildMinimalValidMatchlockGates();
    (badDigest.matchlock as Record<string, unknown>).sha256 = "short";
    assert.ok(
      validateUnionFinalMatchlockGates(badDigest).includes(
        "matchlock.sha256 must be the 64-hex observed binary digest",
      ),
    );
  });

  it("requires a gates array", () => {
    const value = buildMinimalValidMatchlockGates();
    delete value.gates;
    assert.deepEqual(validateUnionFinalMatchlockGates(value), ["'gates' must be an array"]);
  });

  it("requires every per-gate field", () => {
    const value = withGate(0, { command: "", notes: 42, runner: "" });
    const errors = validateUnionFinalMatchlockGates(value);
    assert.ok(errors.includes("gates[0].command must be a non-empty string"));
    assert.ok(errors.includes("gates[0].runner must be a non-empty string"));
    assert.ok(errors.includes("gates[0].notes must be a string"));
  });

  it("rejects a non-integer or non-zero exit", () => {
    assert.ok(
      validateUnionFinalMatchlockGates(withGate(0, { exit: "0" })).includes(
        "gates[0].exit must be an integer",
      ),
    );
    assert.ok(
      validateUnionFinalMatchlockGates(withGate(1, { exit: 1 })).includes(
        "gates[1].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
      ),
    );
  });

  const DOCUMENTED_BLOCKED = {
    preExisting: true,
    reason:
      "The synthetic dsh gate's NONSTANDARD image PATH positive fails in the guest-agent sandbox re-exec (the harness binary cannot be started); the host-side image PATH resolution is correct.",
    classification: "pre-existing runtime/sandbox blocker",
    evidence:
      "/home/kaladin/matchlock-work/evidence/dsh-exec-20260921T093055Z/nonstandard-path-invocation.json",
    docsCitation: "docs/matchlock-dsh-qualification.md#5",
  };

  it("accepts a red gate only with a complete documented blocked object", () => {
    // The dsh gate is the fifth part-2 entry (index 5): part-1 0..4.
    assert.deepEqual(
      validateUnionFinalMatchlockGates(
        withGate(5, { exit: 1, blocked: DOCUMENTED_BLOCKED }),
      ),
      [],
    );
    for (const key of REQUIRED_BLOCKED_STRING_FIELDS) {
      const incomplete = { ...DOCUMENTED_BLOCKED, [key]: "" };
      assert.ok(
        validateUnionFinalMatchlockGates(
          withGate(5, { exit: 1, blocked: incomplete }),
        ).includes(
          "gates[5].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
        ),
        `an incomplete blocked object missing '${key}' must be rejected`,
      );
    }
    assert.ok(
      validateUnionFinalMatchlockGates(
        withGate(5, { exit: 1, blocked: { ...DOCUMENTED_BLOCKED, preExisting: false } }),
      ).includes(
        "gates[5].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
      ),
    );
  });

  it("rejects a blocked object on a green gate", () => {
    assert.ok(
      validateUnionFinalMatchlockGates(withGate(0, { blocked: DOCUMENTED_BLOCKED })).includes(
        "gates[0].blocked must be absent when exit is 0",
      ),
    );
  });

  it("refuses a zero-round gate (no fake green)", () => {
    assert.ok(
      validateUnionFinalMatchlockGates(withGate(0, { observed_rounds: 0 })).includes(
        "gates[0].observed_rounds must be > 0 (got 0)",
      ),
    );
    assert.ok(
      validateUnionFinalMatchlockGates(
        withGate(0, { observed_rounds: 0, observed_vm_ids: [] }),
      ).includes("gates[0].observed_vm_ids must not be empty"),
    );
  });

  it("rejects malformed or mismatched observed VM ids", () => {
    assert.ok(
      validateUnionFinalMatchlockGates(
        withGate(0, { observed_rounds: 2, observed_vm_ids: ["vm-00000000"] }),
      ).includes("gates[0].observed_rounds must equal the distinct observed_vm_ids count"),
    );
    assert.ok(
      validateUnionFinalMatchlockGates(
        withGate(0, { observed_rounds: 1, observed_vm_ids: ["not-a-vm"] }),
      ).includes('gates[0].observed_vm_ids contains an invalid VM id "not-a-vm"'),
    );
  });

  it("rejects an unknown gate name", () => {
    assert.ok(
      validateUnionFinalMatchlockGates(withGate(0, { name: "totally-made-up" })).includes(
        "gates[0].name 'totally-made-up' is not a known Matchlock gate",
      ),
    );
  });

  it("rejects unparseable gate timestamps", () => {
    const errors = validateUnionFinalMatchlockGates(
      withGate(0, { startedAt: "not-a-date" }),
    );
    assert.ok(errors.includes("gates[0].startedAt must be a parseable instant"));
  });

  it("rejects a non-object gate entry", () => {
    const value = buildMinimalValidMatchlockGates();
    const gates = value.gates as unknown[];
    gates[2] = "not-an-object";
    const errors = validateUnionFinalMatchlockGates(value);
    assert.ok(errors.includes("gates[2] must be an object"));
    // A missing required gate is reported as well, never silently accepted.
    assert.ok(errors.includes("missing required Matchlock gate 'empty-output'"));
  });

  it("requires all five part-1 Matchlock gates", () => {
    const value = buildMinimalValidMatchlockGates();
    (value.gates as unknown[]).splice(4, 1);
    assert.ok(
      validateUnionFinalMatchlockGates(value).includes(
        "missing required Matchlock gate 'worktree-merge'",
      ),
    );
  });

  it("requires all four part-2 dsh Matchlock gates", () => {
    for (const missing of UNION_FINAL_MATCHLOCK_PART2_GATES) {
      const value = buildMinimalValidMatchlockGates();
      const gates = value.gates as Record<string, unknown>[];
      gates.splice(
        gates.findIndex((gate) => gate.name === missing),
        1,
      );
      assert.ok(
        validateUnionFinalMatchlockGates(value).includes(
          `missing required Matchlock gate '${missing}'`,
        ),
        `dropping '${missing}' must be reported as a missing required gate`,
      );
    }
  });

  it("requires all three part-3 landing Matchlock gates", () => {
    for (const missing of UNION_FINAL_MATCHLOCK_PART3_GATES) {
      const value = buildMinimalValidMatchlockGates();
      const gates = value.gates as Record<string, unknown>[];
      gates.splice(
        gates.findIndex((gate) => gate.name === missing),
        1,
      );
      assert.ok(
        validateUnionFinalMatchlockGates(value).includes(
          `missing required Matchlock gate '${missing}'`,
        ),
        `dropping '${missing}' must be reported as a missing required gate`,
      );
    }
  });

  it("rejects duplicate gate names", () => {
    const value = buildMinimalValidMatchlockGates();
    (value.gates as Record<string, unknown>[]).push({
      name: "synthetic",
      runner: "run-matchlock-synthetic-e2e-test",
      command: "./run-matchlock-synthetic-e2e-test",
      exit: 0,
      observed_rounds: 1,
      observed_vm_ids: ["vm-11111111"],
      evidence_path: "/home/kaladin/matchlock-work/evidence/pi-exec-again",
      startedAt: "2026-09-21T00:00:00Z",
      endedAt: "2026-09-21T00:00:01Z",
      notes: "",
    });
    assert.ok(validateUnionFinalMatchlockGates(value).includes("duplicate gate 'synthetic'"));
  });

  it("forbids pinned/private matchlock and the real tiers in every gate command", () => {
    for (const pattern of UNION_FINAL_MATCHLOCK_FORBIDDEN_COMMAND_PATTERNS) {
      const errors = validateUnionFinalMatchlockGates(
        withGate(0, { command: `env ${pattern}foo ./run-matchlock-synthetic-e2e-test` }),
      );
      assert.ok(
        errors.includes(
          `gates[0].command must not use a pinned/private matchlock or the real tiers (${pattern})`,
        ),
      );
    }
  });

  it("pins the five part-1 gates, the four part-2 dsh gates, the three part-3 landing gates, the twelve-gate family and the shared lock path", () => {
    assert.deepEqual(
      [...UNION_FINAL_MATCHLOCK_PART1_GATES],
      ["synthetic", "hermes-synthetic", "empty-output", "long-home", "worktree-merge"],
    );
    assert.deepEqual(
      [...UNION_FINAL_MATCHLOCK_PART2_GATES],
      ["dsh", "dsh-profile-overlay", "dsh-real-boot", "dsh-merge-worktree"],
    );
    assert.deepEqual(
      [...UNION_FINAL_MATCHLOCK_PART3_GATES],
      ["hermes-merge-worktree", "vm-size", "cleanup"],
    );
    assert.equal(UNION_FINAL_MATCHLOCK_ALL_GATES.length, 12);
    assert.equal(UNION_FINAL_GATE_LOCK, "/home/kaladin/matchlock-work/vaivm-gate.lock");
    assert.equal(SYSTEM_MATCHLOCK_PATH, "/usr/local/bin/matchlock");
  });

  // ---- real published deliverable ----

  it(
    "parses the published Matchlock gate deliverable and finds it structurally complete with existing evidence",
    {
      skip: (() => {
        const pathName = publishedMatchlockGatesPath();
        if (!existsSync(pathName)) {
          return `deliverable not found at ${pathName}`;
        }
        return false;
      })(),
    },
    () => {
      const pathName = publishedMatchlockGatesPath();
      const raw = readFileSync(pathName, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        assert.fail(
          `published Matchlock gate evidence is not valid JSON: ${(error as Error).message}`,
        );
      }
      assert.deepEqual(validateUnionFinalMatchlockGates(parsed), []);
      const value = parsed as Record<string, unknown>;
      assert.equal(value.lock, UNION_FINAL_GATE_LOCK);
      assert.equal(
        (value.matchlock as Record<string, unknown>).path,
        SYSTEM_MATCHLOCK_PATH,
      );
      const gates = value.gates as Record<string, unknown>[];
      for (const gate of gates) {
        const evidencePath = gate.evidence_path as string;
        assert.ok(
          existsSync(evidencePath),
          `gate '${String(gate.name)}' evidence dir does not exist: ${evidencePath}`,
        );
        const roundsFile = path.join(evidencePath, "observed-rounds.json");
        assert.ok(
          existsSync(roundsFile),
          `gate '${String(gate.name)}' observed-rounds.json does not exist: ${roundsFile}`,
        );
        const rounds = JSON.parse(readFileSync(roundsFile, "utf-8")) as Record<
          string,
          unknown
        >;
        assert.equal(
          rounds.gate,
          UNION_FINAL_MATCHLOCK_GATE_LABELS[gate.name as string],
          `gate '${String(gate.name)}' observed-rounds.json gate label mismatch`,
        );
        assert.equal(
          rounds.observed_rounds,
          gate.observed_rounds,
          `gate '${String(gate.name)}' observed-rounds.json count mismatch`,
        );
        assert.ok(
          (rounds.observed_rounds as number) > 0,
          `gate '${String(gate.name)}' observed_rounds must be > 0`,
        );
        // A red (documented-blocked) gate must be backed by a real raw-evidence
        // receipt and a repo doc citation, never a bare non-zero exit.
        if (gate.blocked !== undefined) {
          assert.equal(
            (gate.blocked as Record<string, unknown>).preExisting,
            true,
            `gate '${String(gate.name)}' blocked.preExisting must be true`,
          );
          const blockedEvidence = (gate.blocked as Record<string, unknown>)
            .evidence as string;
          assert.ok(
            existsSync(blockedEvidence),
            `gate '${String(gate.name)}' blocked.evidence does not exist: ${blockedEvidence}`,
          );
          const docsCitation = (gate.blocked as Record<string, unknown>)
            .docsCitation as string;
          const docsPath = path.join(
            process.cwd(),
            docsCitation.split("#")[0] ?? docsCitation,
          );
          assert.ok(
            existsSync(docsPath),
            `gate '${String(gate.name)}' blocked.docsCitation does not exist: ${docsPath}`,
          );
        }
      }
    },
  );
});
