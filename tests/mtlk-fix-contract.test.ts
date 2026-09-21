/**
 * MTLK-FIX US-010 (tamandua-6sy.33.10) — deliverable regression for the
 * published MTLK-FIX contract file.
 *
 * The run deliverable `/root/matchlock-work/mtlk-fix-contract.json` lives
 * OUTSIDE the repository on purpose (it is never committed). This file carries
 * the validator that the story's acceptance criterion 5 asks for: it parses
 * the contract as JSON and asserts it contains one entry per task item with
 * the required root-cause / fix / tests / focused-gate fields, records the
 * tester-owned full-suite gates as tester-owned, and keeps the native findings
 * F2/F3/D2/D3 recorded but not fixed.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. When the deliverable is absent (e.g. a checkout that never produced
 * it) the real-file assertion is skipped so the committed suite never depends
 * on host state; the pure validator assertions below always run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

export const MTLK_FIX_CONTRACT_ITEM_KEYS = [
  "short-home-alias-preflight",
  "f4-error-surfacing",
  "h1-d1-empty-output",
  "h2-h3-hermes-usage-metadata",
  "probe-cost-docs",
] as const;

const REQUIRED_NATIVE_FINDINGS = ["F2", "F3", "D2", "D3"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateGate(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const field of ["command", "logPath", "exitCode"] as const) {
    if (!(field in value)) {
      errors.push(`${prefix} missing ${field}`);
    }
  }
  if ("command" in value && !isNonEmptyString(value.command)) {
    errors.push(`${prefix}.command must be a non-empty string`);
  }
  if ("logPath" in value && !isNonEmptyString(value.logPath)) {
    errors.push(`${prefix}.logPath must be a non-empty string`);
  }
  if ("exitCode" in value && typeof value.exitCode !== "number") {
    errors.push(`${prefix}.exitCode must be a number`);
  }
}

/**
 * Validate an already-parsed MTLK-FIX contract value. Returns a list of
 * human-readable problems; an empty list means the contract is complete.
 */
export function validateMtlkFixContract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["contract must be a JSON object"];
  }
  if (!isNonEmptyString(value.schema) || !value.schema.startsWith("mtlk-fix-contract/")) {
    errors.push("schema must be a string starting with 'mtlk-fix-contract/'");
  }

  if (!Array.isArray(value.items)) {
    errors.push("items must be an array");
    return errors;
  }

  const seen = new Set<string>();
  for (const [index, rawItem] of value.items.entries()) {
    if (!isRecord(rawItem)) {
      errors.push(`items[${index}] must be an object`);
      continue;
    }
    const key = rawItem.key;
    if (!isNonEmptyString(key)) {
      errors.push(`items[${index}].key must be a non-empty string`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`duplicate item key '${key}'`);
    }
    seen.add(key);
    for (const field of ["title", "rootCause", "fix", "tests"] as const) {
      if (!(field in rawItem)) {
        errors.push(`item '${key}' missing ${field}`);
      }
    }
    if (!("focusedGate" in rawItem)) {
      errors.push(`item '${key}' missing focusedGate`);
    } else {
      validateGate(rawItem.focusedGate, `item '${key}'.focusedGate`, errors);
    }
  }

  for (const required of MTLK_FIX_CONTRACT_ITEM_KEYS) {
    if (!seen.has(required)) {
      errors.push(`missing item key '${required}'`);
    }
  }

  const findings = value.nativeFindingsRecorded;
  if (!isRecord(findings)) {
    errors.push("nativeFindingsRecorded must be an object");
  } else {
    for (const id of REQUIRED_NATIVE_FINDINGS) {
      const finding = findings[id];
      if (!isRecord(finding)) {
        errors.push(`nativeFindingsRecorded.${id} must be an object`);
        continue;
      }
      if (finding.fixed !== false) {
        errors.push(`nativeFindingsRecorded.${id}.fixed must be false (recorded, not fixed)`);
      }
      if (!isNonEmptyString(finding.detail)) {
        errors.push(`nativeFindingsRecorded.${id}.detail must be a non-empty string`);
      }
    }
  }

  const baseline = value.baselineComparison;
  if (!isRecord(baseline)) {
    errors.push("baselineComparison must be an object");
  } else {
    for (const gate of ["npmTest", "runAllE2eTests"] as const) {
      const entry = baseline[gate];
      if (!isRecord(entry)) {
        errors.push(`baselineComparison.${gate} must be an object`);
        continue;
      }
      if (entry.owner !== "tester") {
        errors.push(`baselineComparison.${gate}.owner must be 'tester' (tester-owned full-suite gate)`);
      }
    }
  }

  return errors;
}

/** Minimal contract shape that validateMtlkFixContract must accept. */
function buildMinimalValidContract(): Record<string, unknown> {
  const item = {
    key: "",
    title: "t",
    rootCause: "rc",
    fix: { summary: "f", files: [], commits: [] },
    tests: [],
    focusedGate: { command: "c", logPath: "l", exitCode: 0 },
  };
  return {
    schema: "mtlk-fix-contract/1",
    items: MTLK_FIX_CONTRACT_ITEM_KEYS.map((key) => ({ ...item, key })),
    nativeFindingsRecorded: Object.fromEntries(
      REQUIRED_NATIVE_FINDINGS.map((id) => [id, { fixed: false, detail: "recorded" }]),
    ),
    baselineComparison: {
      npmTest: { owner: "tester" },
      runAllE2eTests: { owner: "tester" },
    },
  };
}

const contractPath =
  process.env.MTLK_FIX_CONTRACT_PATH ?? "/root/matchlock-work/mtlk-fix-contract.json";

describe("MTLK-FIX contract validator (US-010)", () => {
  it("accepts a complete minimal contract", () => {
    assert.deepEqual(validateMtlkFixContract(buildMinimalValidContract()), []);
  });

  it("reports a missing required item key", () => {
    const contract = buildMinimalValidContract();
    (contract.items as unknown[]).pop();
    const errors = validateMtlkFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("missing item key 'probe-cost-docs'")),
      `expected a missing-key error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a focused gate missing its command/log/exit fields", () => {
    const contract = buildMinimalValidContract();
    (contract.items as Array<Record<string, unknown>>)[0].focusedGate = { command: "c" };
    const errors = validateMtlkFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("focusedGate missing logPath")),
      `expected a gate error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a native finding that claims to be fixed", () => {
    const contract = buildMinimalValidContract();
    (contract.nativeFindingsRecorded as Record<string, Record<string, unknown>>).F2.fixed = true;
    const errors = validateMtlkFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("F2.fixed must be false")),
      `expected a not-fixed error, got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a tester-owned baseline gate not marked tester-owned", () => {
    const contract = buildMinimalValidContract();
    (contract.baselineComparison as Record<string, Record<string, unknown>>).npmTest.owner =
      "developer";
    const errors = validateMtlkFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("baselineComparison.npmTest.owner must be 'tester'")),
      `expected a tester-owned error, got ${JSON.stringify(errors)}`,
    );
  });

  it(
    "parses the published deliverable as JSON and contains every item key",
    { skip: existsSync(contractPath) ? false : `deliverable not found at ${contractPath}` },
    () => {
      const raw = readFileSync(contractPath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        assert.fail(`published contract is not valid JSON: ${(error as Error).message}`);
      }
      assert.deepEqual(validateMtlkFixContract(parsed), []);
    },
  );
});
