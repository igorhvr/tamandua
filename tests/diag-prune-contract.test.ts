/**
 * DIAG-PRUNE US-018 — tracked-contract regression for the two operator
 * commands `tamandua run diagnose` (read-only diagnostics bundle) and
 * `tamandua evidence prune` (manual, dry-run by default).
 *
 * The tracked engineering contract lives in the repository at
 * `torture-test/impl-tasks/diag-prune-contract.json`; an identical host copy
 * is written to the path the contract itself records in `hostContractCopy`
 * when that directory exists. This file pins the repo copy (exists, parses,
 * carries the four required top-level sections and the four gate commands)
 * and, when the recorded host copy is present, asserts it is byte-identical.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. No host-specific path is hardcoded here: the host copy path comes
 * from the contract, and an absent host copy is simply skipped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CONTRACT_PATH = resolve(REPO_ROOT, "torture-test/impl-tasks/diag-prune-contract.json");

/** The four top-level sections the contract must carry. */
export const DIAG_PRUNE_REQUIRED_SECTIONS = ["bundle", "prune", "tests", "gates"] as const;

/** The four gate commands the contract must record. */
export const DIAG_PRUNE_REQUIRED_GATE_KINDS = [
  "build",
  "new-tests",
  "full-suite",
  "e2e",
] as const;

/** The complete expected bundle file set. */
export const DIAG_PRUNE_BUNDLE_FILES = [
  "run.json",
  "steps.json",
  "stories.json",
  "story_abandonments.json",
  "run_worktrees.json",
  "events.jsonl",
  "daemon-log.txt",
  "session-paths.json",
  "evidence.json",
  "suite-ledger.json",
  "matchlock.json",
  "summary.json",
  "SUMMARY.md",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validate an already-parsed DIAG-PRUNE contract. Returns a list of
 * human-readable problems; an empty list means the contract is complete.
 */
export function validateDiagPruneContract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["contract must be a JSON object"];
  }
  if (!isNonEmptyString(value.schema) || !value.schema.startsWith("diag-prune-contract/")) {
    errors.push("schema must be a string starting with 'diag-prune-contract/'");
  }

  for (const section of DIAG_PRUNE_REQUIRED_SECTIONS) {
    if (!(section in value)) {
      errors.push(`missing required top-level section '${section}'`);
    }
  }

  const bundle = value.bundle;
  if (!isRecord(bundle)) {
    errors.push("bundle must be an object");
  } else {
    if (!isNonEmptyString(bundle.command)) {
      errors.push("bundle.command must be a non-empty string");
    }
    if (bundle.readOnly !== true) {
      errors.push("bundle.readOnly must be true");
    }
    if (bundle.startsOrTouchesDaemon !== false) {
      errors.push("bundle.startsOrTouchesDaemon must be false");
    }
    if (bundle.worksWhileDaemonRunning !== true) {
      errors.push("bundle.worksWhileDaemonRunning must be true");
    }
    if (!isNonEmptyString(bundle.defaultBundlePath) || !isNonEmptyString(bundle.outBundlePath)) {
      errors.push("bundle.defaultBundlePath and bundle.outBundlePath must be recorded");
    }
    if (!isStringArray(bundle.files)) {
      errors.push("bundle.files must be an array of strings");
    } else {
      for (const file of DIAG_PRUNE_BUNDLE_FILES) {
        if (!bundle.files.includes(file)) {
          errors.push(`bundle.files missing '${file}'`);
        }
      }
    }
    if (bundle.absentPolicy !== undefined && !isNonEmptyString(bundle.absentPolicy)) {
      errors.push("bundle.absentPolicy must be a non-empty string when present");
    }
    if (bundle.collectors !== undefined) {
      if (!Array.isArray(bundle.collectors) || bundle.collectors.length === 0) {
        errors.push("bundle.collectors must be a non-empty array when present");
      } else {
        for (const [index, collector] of bundle.collectors.entries()) {
          if (!isRecord(collector)) {
            errors.push(`bundle.collectors[${index}] must be an object`);
            continue;
          }
          for (const field of ["section", "module", "testFile"] as const) {
            if (!isNonEmptyString(collector[field])) {
              errors.push(`bundle.collectors[${index}].${field} must be a non-empty string`);
            }
          }
        }
      }
    }
  }

  const prune = value.prune;
  if (!isRecord(prune)) {
    errors.push("prune must be an object");
  } else {
    if (!isNonEmptyString(prune.command)) {
      errors.push("prune.command must be a non-empty string");
    }
    if (prune.manualOnly !== true) {
      errors.push("prune.manualOnly must be true");
    }
    if (prune.dryRunDefault !== true) {
      errors.push("prune.dryRunDefault must be true");
    }
    if (prune.executeFlag !== "--yes") {
      errors.push("prune.executeFlag must be '--yes'");
    }
    if (!isStringArray(prune.neverTouches) || prune.neverTouches.length === 0) {
      errors.push("prune.neverTouches must be a non-empty string array");
    }
    if (!Array.isArray(prune.refusals) || prune.refusals.length === 0) {
      errors.push("prune.refusals must be a non-empty array");
    }
    if (!Array.isArray(prune.scope) || prune.scope.length === 0) {
      errors.push("prune.scope must be a non-empty array");
    }
  }

  const tests = value.tests;
  if (!isRecord(tests)) {
    errors.push("tests must be an object");
  } else {
    if (!Array.isArray(tests.unit) || tests.unit.length === 0) {
      errors.push("tests.unit must be a non-empty array");
    } else {
      for (const [index, entry] of tests.unit.entries()) {
        if (!isRecord(entry) || !isNonEmptyString(entry.file)) {
          errors.push(`tests.unit[${index}].file must be a non-empty string`);
        }
      }
    }
    if (!Array.isArray(tests.e2e) || tests.e2e.length === 0) {
      errors.push("tests.e2e must be a non-empty array");
    } else {
      for (const [index, entry] of tests.e2e.entries()) {
        if (!isRecord(entry) || !isNonEmptyString(entry.file)) {
          errors.push(`tests.e2e[${index}].file must be a non-empty string`);
        }
      }
    }
  }

  if (!Array.isArray(value.gates) || value.gates.length === 0) {
    errors.push("gates must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const [index, gate] of value.gates.entries()) {
      if (!isRecord(gate)) {
        errors.push(`gates[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(gate.kind)) {
        errors.push(`gates[${index}].kind must be a non-empty string`);
      } else {
        if (seen.has(gate.kind)) {
          errors.push(`duplicate gates kind '${gate.kind}'`);
        }
        seen.add(gate.kind);
      }
      if (!isNonEmptyString(gate.command)) {
        errors.push(`gates[${index}].command must be a non-empty string`);
      }
      if (typeof gate.expectedExit !== "number" || !Number.isInteger(gate.expectedExit)) {
        errors.push(`gates[${index}].expectedExit must be an integer`);
      }
    }
    for (const kind of DIAG_PRUNE_REQUIRED_GATE_KINDS) {
      if (!seen.has(kind)) {
        errors.push(`gates missing the '${kind}' gate command`);
      }
    }
  }

  return errors;
}

/** Minimal complete contract that validateDiagPruneContract must accept. */
function buildMinimalValidContract(): Record<string, unknown> {
  return {
    schema: "diag-prune-contract/1",
    bundle: {
      command: "tamandua run diagnose <run-id|run-number> [--out <dir>] [--json]",
      readOnly: true,
      startsOrTouchesDaemon: false,
      worksWhileDaemonRunning: true,
      defaultBundlePath: "<state>/diagnostics/<bareRunId>-<ts>",
      outBundlePath: "<outRoot>/<bareRunId>",
      files: [...DIAG_PRUNE_BUNDLE_FILES],
      collectors: [{ section: "db-rows", module: "m.ts", testFile: "m.test.ts" }],
      absentPolicy: "absent, never throws",
    },
    prune: {
      command: "tamandua evidence prune --older-than <days> [--yes] [--json]",
      manualOnly: true,
      dryRunDefault: true,
      executeFlag: "--yes",
      scope: [{ kind: "evidence-dir" }],
      refusals: ["live run"],
      neverTouches: ["run/step/story rows"],
    },
    tests: {
      unit: [{ file: "src/diagnostics/prune-plan.test.ts" }],
      e2e: [{ file: "e2e-tests/evidence-prune.test.ts" }],
    },
    gates: DIAG_PRUNE_REQUIRED_GATE_KINDS.map((kind) => ({
      kind,
      command: `gate-${kind}`,
      expectedExit: 0,
    })),
  };
}

/** Collect every string value in a parsed JSON tree. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
  return out;
}

describe("DIAG-PRUNE contract validator (US-018)", () => {
  it("accepts a complete minimal contract", () => {
    assert.deepEqual(validateDiagPruneContract(buildMinimalValidContract()), []);
  });

  it("reports a missing required top-level section", () => {
    const contract = buildMinimalValidContract();
    delete contract.prune;
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("missing required top-level section 'prune'")),
      `expected a missing-prune error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a diagnose bundle that is not read-only", () => {
    const contract = buildMinimalValidContract();
    (contract.bundle as Record<string, unknown>).readOnly = false;
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("bundle.readOnly must be true")),
      `expected a readOnly error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a bundle missing an expected file", () => {
    const contract = buildMinimalValidContract();
    (contract.bundle as Record<string, unknown>).files = ["run.json", "summary.json"];
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("bundle.files missing 'matchlock.json'")),
      `expected a missing bundle-file error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a prune command that is not dry-run by default", () => {
    const contract = buildMinimalValidContract();
    (contract.prune as Record<string, unknown>).dryRunDefault = false;
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("prune.dryRunDefault must be true")),
      `expected a dry-run error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a prune command missing its execute flag", () => {
    const contract = buildMinimalValidContract();
    (contract.prune as Record<string, unknown>).executeFlag = "--force";
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("prune.executeFlag must be '--yes'")),
      `expected an execute-flag error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a missing gate command", () => {
    const contract = buildMinimalValidContract();
    contract.gates = (contract.gates as Array<Record<string, unknown>>).filter(
      (gate) => gate.kind !== "full-suite",
    );
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("gates missing the 'full-suite' gate command")),
      `expected a missing-gate error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a gate with no command", () => {
    const contract = buildMinimalValidContract();
    delete (contract.gates as Array<Record<string, unknown>>)[0].command;
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("gates[0].command must be a non-empty string")),
      `expected a missing-command error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a duplicate gate kind", () => {
    const contract = buildMinimalValidContract();
    (contract.gates as Array<Record<string, unknown>>).push({
      kind: "build",
      command: "npm run build",
      expectedExit: 0,
    });
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("duplicate gates kind 'build'")),
      `expected a duplicate-kind error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports an empty tests section", () => {
    const contract = buildMinimalValidContract();
    (contract.tests as Record<string, unknown>).unit = [];
    const errors = validateDiagPruneContract(contract);
    assert.ok(
      errors.some((error) => error.includes("tests.unit must be a non-empty array")),
      `expected an empty-unit error, got ${JSON.stringify(errors)}`,
    );
  });
});

describe("DIAG-PRUNE tracked contract artifact (US-018)", () => {
  it("exists in the repository and parses as JSON", () => {
    assert.ok(existsSync(CONTRACT_PATH), `tracked contract not found at ${CONTRACT_PATH}`);
    const raw = readFileSync(CONTRACT_PATH, "utf-8");
    assert.doesNotThrow(() => JSON.parse(raw), "tracked contract must be valid JSON");
  });

  it("validates: four required sections and the four gate commands", () => {
    const parsed: unknown = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8"));
    assert.deepEqual(validateDiagPruneContract(parsed), []);
    const contract = parsed as Record<string, unknown>;
    for (const section of DIAG_PRUNE_REQUIRED_SECTIONS) {
      assert.ok(
        isRecord(contract[section]) || Array.isArray(contract[section]),
        `contract section '${section}' must be present`,
      );
    }
    const kinds = new Set(
      (contract.gates as Array<Record<string, unknown>>).map((gate) => gate.kind),
    );
    for (const kind of DIAG_PRUNE_REQUIRED_GATE_KINDS) {
      assert.ok(kinds.has(kind), `contract gates must record the '${kind}' command`);
    }
  });

  it("records the exact build/full-suite/e2e commands from the task", () => {
    const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as Record<string, unknown>;
    const commands = new Map(
      (contract.gates as Array<Record<string, unknown>>).map((gate) => [gate.kind, gate.command]),
    );
    assert.equal(commands.get("build"), "npm run build");
    assert.ok(
      (commands.get("full-suite") as string).includes("npm test") &&
        (commands.get("full-suite") as string).includes("tamandua-test"),
      "full-suite gate must be the tamandua-test shim wrapping npm test",
    );
    assert.equal(commands.get("e2e"), "./run-all-e2e-tests");
  });

  it("does not embed host-specific absolute paths in the repo copy", () => {
    const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as Record<string, unknown>;
    const hostCopy = contract.hostContractCopy;
    const hostCopyValue = typeof hostCopy === "string" ? hostCopy : undefined;
    const offenders = collectStrings(contract).filter(
      (entry) => entry.startsWith("/home/") && entry !== hostCopyValue,
    );
    assert.deepEqual(
      offenders,
      [],
      "the repo copy may only name a host path in hostContractCopy",
    );
  });

  it("host copy, when present, is byte-identical to the repo copy", (t) => {
    const raw = readFileSync(CONTRACT_PATH, "utf-8");
    const contract = JSON.parse(raw) as Record<string, unknown>;
    const hostCopy = contract.hostContractCopy;
    if (typeof hostCopy !== "string" || !existsSync(hostCopy)) {
      t.skip(`host copy not present at ${String(hostCopy)}`);
      return;
    }
    assert.equal(
      readFileSync(hostCopy, "utf-8"),
      raw,
      "the host copy must be byte-identical to the tracked repo copy",
    );
  });
});