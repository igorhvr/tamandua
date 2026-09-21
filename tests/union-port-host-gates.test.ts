/**
 * UNION-PORT US-010 — deliverable validator for the host-level acceptance gate
 * evidence.
 *
 * The run deliverable `/home/kaladin/matchlock-work/union-port-host-gates.json`
 * lives OUTSIDE the repository on purpose (it is host state, never committed,
 * never placed in the worktree). This file carries the validator the story
 * asks for: a pure `validateUnionPortHostGates(value): string[]` plus always-on
 * unit tests covering the structural contract, and a real-file assertion that
 * defaults to the canonical deliverable path (overridable with
 * `UNION_PORT_HOST_GATES_PATH`) and is skipped when that file is absent — so
 * the committed suite never hard-depends on host state.
 *
 * US-010-specific rules enforced here:
 *   - one entry per host gate, each recording {name, command, exit, log,
 *     startedAt, endedAt, notes} exactly as the story requires;
 *   - the four required gates are present (build, db-test, testcmd, e2e);
 *   - every gate exited 0 (a red gate is never evidence of a passing host);
 *   - no entry runs the native real e2e tier (US-010 forbids it; the
 *     coordinator certifies that tier on both machines).
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/** The external deliverable published by US-010 (overridable for tests). */
export const DEFAULT_UNION_PORT_HOST_GATES_PATH =
  "/home/kaladin/matchlock-work/union-port-host-gates.json";

/** The canonical shared gate lock every host gate runs under. */
export const UNION_PORT_GATE_LOCK = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/**
 * The four host gates US-010 must run, in order. Names are stable machine keys
 * so the US-013 contract can index them without parsing the command text.
 */
export const UNION_PORT_REQUIRED_GATES = [
  "build",
  "db-test",
  "testcmd",
  "e2e",
] as const;

/**
 * Native real-e2e tier commands US-010 explicitly must NOT run. Any gate whose
 * recorded command contains one of these is invalid evidence.
 */
export const UNION_PORT_FORBIDDEN_GATE_COMMAND_PATTERNS = [
  "run-all-real-e2e-tests",
  "run-real-e2e-canary",
] as const;

const REQUIRED_STRING_FIELDS = [
  "name",
  "command",
  "log",
  "startedAt",
  "endedAt",
] as const;

const REQUIRED_ROOT_FIELDS = ["runId", "branch", "commit", "lock"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the parsed union-port host-gates evidence. Returns a list of
 * human-readable errors; an empty list means the evidence is structurally the
 * one US-010 requires. Pure — never touches the filesystem.
 */
export function validateUnionPortHostGates(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ["host-gates evidence must be a JSON object"];
  }

  for (const key of REQUIRED_ROOT_FIELDS) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
      errors.push(`'${key}' must be a non-empty string`);
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
      errors.push(`gates[${index}].exit must be 0 (got ${String(entry.exit)})`);
    }
    if (typeof entry.name === "string" && entry.name.length > 0) {
      names.push(entry.name);
    }
    if (typeof entry.command === "string") {
      for (const pattern of UNION_PORT_FORBIDDEN_GATE_COMMAND_PATTERNS) {
        if (entry.command.includes(pattern)) {
          errors.push(
            `gates[${index}].command must not run the native real-e2e tier (${pattern})`,
          );
        }
      }
    }
  });

  for (const required of UNION_PORT_REQUIRED_GATES) {
    if (!names.includes(required)) {
      errors.push(`missing required gate '${required}'`);
    }
  }
  for (const duplicate of new Set(names.filter((name, i) => names.indexOf(name) !== i))) {
    errors.push(`duplicate gate '${duplicate}'`);
  }

  return errors;
}

/** Minimal structurally valid evidence, reused across the error cases. */
export function buildMinimalValidHostGates(): Record<string, unknown> {
  return {
    runId: "run-25cb113c-e6e7-4d2e-99db-8ad0d1ec6d89",
    branch: "feature/union-port-matchlock-20260918",
    commit: "0123456789abcdef0123456789abcdef01234567",
    lock: UNION_PORT_GATE_LOCK,
    gates: UNION_PORT_REQUIRED_GATES.map((name) => ({
      name,
      command: `gate ${name}`,
      exit: 0,
      log: `/home/kaladin/matchlock-work/union-port-gates/${name}.log`,
      startedAt: "2026-09-19T00:00:00Z",
      endedAt: "2026-09-19T00:00:01Z",
      notes: "",
    })),
  };
}

/** Shallow-clone evidence with one gate entry replaced. */
function withGate(
  index: number,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const value = buildMinimalValidHostGates();
  const gates = value.gates as Record<string, unknown>[];
  gates[index] = { ...gates[index], ...patch };
  return value;
}

describe("UNION-PORT US-010 host-gate evidence validator", () => {
  it("accepts the minimal valid evidence", () => {
    assert.deepEqual(validateUnionPortHostGates(buildMinimalValidHostGates()), []);
  });

  it("rejects non-object evidence", () => {
    assert.deepEqual(validateUnionPortHostGates("nope"), [
      "host-gates evidence must be a JSON object",
    ]);
    assert.deepEqual(validateUnionPortHostGates(null), [
      "host-gates evidence must be a JSON object",
    ]);
    assert.deepEqual(validateUnionPortHostGates([buildMinimalValidHostGates()]), [
      "host-gates evidence must be a JSON object",
    ]);
  });

  it("requires the run metadata fields", () => {
    const value = buildMinimalValidHostGates();
    delete value.commit;
    value.branch = "";
    const errors = validateUnionPortHostGates(value);
    assert.ok(errors.includes("'commit' must be a non-empty string"));
    assert.ok(errors.includes("'branch' must be a non-empty string"));
  });

  it("requires a gates array", () => {
    const value = buildMinimalValidHostGates();
    delete value.gates;
    assert.deepEqual(validateUnionPortHostGates(value), ["'gates' must be an array"]);
  });

  it("requires every per-gate field", () => {
    const value = withGate(0, { command: "", notes: 42 });
    const errors = validateUnionPortHostGates(value);
    assert.ok(errors.includes("gates[0].command must be a non-empty string"));
    assert.ok(errors.includes("gates[0].notes must be a string"));
  });

  it("rejects a non-integer or non-zero exit", () => {
    assert.ok(
      validateUnionPortHostGates(withGate(0, { exit: "0" })).includes(
        "gates[0].exit must be an integer",
      ),
    );
    assert.ok(
      validateUnionPortHostGates(withGate(1, { exit: 1 })).includes(
        "gates[1].exit must be 0 (got 1)",
      ),
    );
  });

  it("rejects a non-object gate entry", () => {
    const value = buildMinimalValidHostGates();
    const gates = value.gates as unknown[];
    gates[2] = "not-an-object";
    const errors = validateUnionPortHostGates(value);
    assert.ok(errors.includes("gates[2] must be an object"));
    // A missing required gate is reported as well, never silently accepted.
    assert.ok(errors.includes("missing required gate 'testcmd'"));
  });

  it("requires all four host gates", () => {
    const value = buildMinimalValidHostGates();
    (value.gates as unknown[]).splice(3, 1);
    assert.ok(
      validateUnionPortHostGates(value).includes("missing required gate 'e2e'"),
    );
  });

  it("rejects duplicate gate names", () => {
    const value = buildMinimalValidHostGates();
    (value.gates as Record<string, unknown>[]).push({
      name: "build",
      command: "npm run build",
      exit: 0,
      log: "/home/kaladin/matchlock-work/union-port-gates/again.log",
      startedAt: "2026-09-19T00:00:00Z",
      endedAt: "2026-09-19T00:00:01Z",
      notes: "",
    });
    assert.ok(validateUnionPortHostGates(value).includes("duplicate gate 'build'"));
  });

  it("forbids the native real-e2e tier in every gate command", () => {
    for (const pattern of UNION_PORT_FORBIDDEN_GATE_COMMAND_PATTERNS) {
      const errors = validateUnionPortHostGates(
        withGate(0, { command: `./${pattern} --from=gate` }),
      );
      assert.ok(
        errors.includes(
          `gates[0].command must not run the native real-e2e tier (${pattern})`,
        ),
      );
    }
  });

  it("pins the exact four required gates and the shared lock path", () => {
    assert.deepEqual(
      [...UNION_PORT_REQUIRED_GATES],
      ["build", "db-test", "testcmd", "e2e"],
    );
    assert.equal(UNION_PORT_GATE_LOCK, "/home/kaladin/matchlock-work/vaivm-gate.lock");
  });

  // ---- real published deliverable ----

  it(
    "parses the published host-gates deliverable as JSON and finds it structurally complete",
    {
      skip: (() => {
        const path =
          process.env.UNION_PORT_HOST_GATES_PATH ?? DEFAULT_UNION_PORT_HOST_GATES_PATH;
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const path =
        process.env.UNION_PORT_HOST_GATES_PATH ?? DEFAULT_UNION_PORT_HOST_GATES_PATH;
      const raw = readFileSync(path, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        assert.fail(`published host-gates evidence is not valid JSON: ${(error as Error).message}`);
      }
      assert.deepEqual(validateUnionPortHostGates(parsed), []);
    },
  );
});
