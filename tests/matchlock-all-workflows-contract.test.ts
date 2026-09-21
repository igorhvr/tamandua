/**
 * MTLK-ALL-WORKFLOWS US-014 — published contract regression.
 *
 * The run deliverable
 * `/home/kaladin/matchlock-work/matchlock-all-workflows-contract.json` lives
 * OUTSIDE the repository on purpose (it is never committed, never placed in
 * the worktree). This file carries the validator the story asks for: a pure
 * `validateAllWorkflowsContract(value): string[]` plus always-on unit tests
 * covering the structural contract, a catalog cross-check against the LIVE
 * `src/installer/matchlock/capabilities.ts`, a credential/session-URL leak
 * scan, and a real-file assertion that defaults to the canonical deliverable
 * path (overridable with `MATCHLOCK_ALL_WORKFLOWS_CONTRACT_PATH`) and is
 * skipped when that file is absent — so the committed suite never hard-depends
 * on host state.
 *
 * The policy the contract records (US-003/US-004): there is NO harness axis.
 * Every bundled workflow id is either admitted with an explicit capability
 * closure or refused with a precise code/reason; pi, hermes and dsh all carry
 * the same admitted set.
 *
 * Pure filesystem reads + one pure catalog import (no child_process, no daemon,
 * no VM, no network), so this file stays in the parallel lane and needs no
 * tests/serial-files.txt entry.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  MATCHLOCK_AVAILABLE_CAPABILITIES,
  MATCHLOCK_BUNDLED_WORKFLOW_IDS,
  MATCHLOCK_REFUSED_WORKFLOWS,
  MATCHLOCK_REFUSED_WORKFLOW_IDS,
  MATCHLOCK_SUPPORTED_WORKFLOW_IDS,
  MATCHLOCK_WORKFLOW_CAPABILITIES,
} from "../src/installer/matchlock/capabilities.ts";

/** The external deliverable published by US-014 (overridable for tests). */
export const DEFAULT_ALL_WORKFLOWS_CONTRACT_PATH =
  "/home/kaladin/matchlock-work/matchlock-all-workflows-contract.json";

/** The refusal codes the catalog may emit (mirrors MatchlockWorkflowRefusalCode). */
export const ALLOWED_REFUSAL_CODES = [
  "guest-github-cli",
  "browser-visual-verification",
  "child-workflow-dispatch",
  "unscoped-host-filesystem",
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

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A token-attribution block: numeric total plus an explicit availability status. */
function validateTokenAttribution(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!isNonNegativeInt(value.tokens_spent)) {
    errors.push(`${prefix}.tokens_spent must be a non-negative integer`);
  }
  if (typeof value.per_round_positive !== "boolean") {
    errors.push(`${prefix}.per_round_positive must be a boolean`);
  }
  if (!isNonEmptyString(value.status)) {
    errors.push(`${prefix}.status must be a non-empty string`);
  }
  if (!isNonEmptyString(value.classification)) {
    errors.push(`${prefix}.classification must be a non-empty string`);
  }
}

/**
 * Validate one recorded per-harness result (synthetic story run or real
 * canary). Acceptance criterion 2: `observed_rounds` is always present and
 * either > 0 or accompanied by an explicit honest `observed_rounds_status`
 * classification, and a token-attribution block always records either a
 * positive value or an explicit unavailable classification.
 */
function validateHarnessResult(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!isNonNegativeInt(value.observed_rounds)) {
    errors.push(`${prefix}.observed_rounds must be a non-negative integer`);
  }
  if (!isNonEmptyString(value.observed_rounds_status)) {
    errors.push(`${prefix}.observed_rounds_status must be a non-empty string`);
  }
  if (!isNonEmptyString(value.classification)) {
    errors.push(`${prefix}.classification must be a non-empty string`);
  }
  if (!isNonEmptyString(value.operatorCommand)) {
    errors.push(`${prefix}.operatorCommand must be a non-empty string`);
  }
  if (!isStringArray(value.roles) || value.roles.length < 6) {
    errors.push(`${prefix}.roles must list all six+ workflow roles`);
  }
  validateTokenAttribution(value.token_attribution, `${prefix}.token_attribution`, errors);
}

function validatePolicyChange(value: unknown, available: readonly string[], errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("policyChange must be an object");
    return;
  }
  if (value.harnessAxisRemoved !== true) {
    errors.push("policyChange.harnessAxisRemoved must be true (the harness axis is removed)");
  }
  if (value.piUnchanged !== true) {
    errors.push("policyChange.piUnchanged must be true (pi decisions are unchanged)");
  }
  if (!isStringArray(value.removedArtifacts) || value.removedArtifacts.length === 0) {
    errors.push("policyChange.removedArtifacts must be a non-empty string array");
  }
  if (!isNonEmptyString(value.replacement)) {
    errors.push("policyChange.replacement must be a non-empty string");
  }
  if (!isStringArray(value.capabilities) || value.capabilities.length === 0) {
    errors.push("policyChange.capabilities must be a non-empty string array");
  }
  if (!isStringArray(value.stories) || !value.stories.includes("US-003") || !value.stories.includes("US-004")) {
    errors.push("policyChange.stories must include US-003 and US-004");
  }
  if (isStringArray(value.capabilities)) {
    for (const capability of value.capabilities) {
      if (!available.includes(capability)) {
        errors.push(`policyChange.capabilities names unknown capability '${capability}'`);
      }
    }
  }
}

/**
 * The exact structural + catalog cross-check. Returns a list of human-readable
 * errors; an empty list means the contract is complete, honest and consistent
 * with the live capability catalog.
 */
export function validateAllWorkflowsContract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["contract must be a JSON object"];

  if (value.contract !== "MTLK-ALL-WORKFLOWS") {
    errors.push("contract must be 'MTLK-ALL-WORKFLOWS'");
  }
  if (value.decision !== "B") {
    errors.push("decision must be 'B'");
  }
  if (!isNonEmptyString(value.bead)) {
    errors.push("bead must be a non-empty string");
  }
  if (!isNonEmptyString(value.runId)) {
    errors.push("runId must be a non-empty string");
  }
  if (!isNonEmptyString(value.branch)) {
    errors.push("branch must be a non-empty string");
  }
  if (value.credentialsPrinted !== false) {
    errors.push("credentialsPrinted must be false");
  }
  if (value.sessionUrlsPrinted !== false) {
    errors.push("sessionUrlsPrinted must be false");
  }

  validatePolicyChange(value.policyChange, MATCHLOCK_AVAILABLE_CAPABILITIES, errors);

  // admittedClosureMap must equal the live catalog exactly.
  if (!isRecord(value.admittedClosureMap)) {
    errors.push("admittedClosureMap must be an object");
  } else {
    const map = value.admittedClosureMap;
    for (const id of MATCHLOCK_SUPPORTED_WORKFLOW_IDS) {
      if (!(id in map)) {
        errors.push(`admittedClosureMap missing admitted workflow '${id}'`);
        continue;
      }
      const closure = map[id];
      if (!isStringArray(closure)) {
        errors.push(`admittedClosureMap['${id}'] must be a string array`);
        continue;
      }
      const expected = [...MATCHLOCK_WORKFLOW_CAPABILITIES[id]].sort();
      const observed = [...closure].sort();
      if (JSON.stringify(observed) !== JSON.stringify(expected)) {
        errors.push(
          `admittedClosureMap['${id}'] drifted from capabilities.ts: [${observed}] != [${expected}]`,
        );
      }
    }
    for (const id of Object.keys(map)) {
      if (!MATCHLOCK_SUPPORTED_WORKFLOW_IDS.includes(id)) {
        errors.push(`admittedClosureMap names non-admitted workflow '${id}'`);
      }
    }
  }

  // refusals must carry every live refused id with the exact code+reason.
  if (!Array.isArray(value.refusals)) {
    errors.push("refusals must be an array");
  } else {
    const seen = new Set<string>();
    for (const [index, rawEntry] of value.refusals.entries()) {
      if (!isRecord(rawEntry)) {
        errors.push(`refusals[${index}] must be an object`);
        continue;
      }
      const id = rawEntry.workflowId;
      if (!isNonEmptyString(id)) {
        errors.push(`refusals[${index}].workflowId must be a non-empty string`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`refusals records '${id}' more than once`);
      }
      seen.add(id);
      const live = MATCHLOCK_REFUSED_WORKFLOWS[id];
      if (!live) {
        errors.push(`refusals names non-refused workflow '${id}'`);
        continue;
      }
      if (rawEntry.code !== live.code) {
        errors.push(`refusals['${id}'].code must be '${live.code}'`);
      }
      if (!isNonEmptyString(rawEntry.reason)) {
        errors.push(`refusals['${id}'].reason must be a non-empty string`);
      }
      if (isNonEmptyString(rawEntry.code) && !ALLOWED_REFUSAL_CODES.includes(rawEntry.code as never)) {
        errors.push(`refusals['${id}'].code '${rawEntry.code}' is not a known refusal class`);
      }
    }
    for (const id of MATCHLOCK_REFUSED_WORKFLOW_IDS) {
      if (!seen.has(id)) {
        errors.push(`refusals missing refused workflow '${id}'`);
      }
    }
  }

  if (!isStringArray(value.bundledWorkflowIds)) {
    errors.push("bundledWorkflowIds must be a string array");
  } else {
    const expected = [...MATCHLOCK_BUNDLED_WORKFLOW_IDS].sort();
    const observed = [...value.bundledWorkflowIds].sort();
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      errors.push("bundledWorkflowIds must equal the admitted set union the refused set");
    }
  }

  if (!isRecord(value.syntheticStoryRuns)) {
    errors.push("syntheticStoryRuns must be an object");
  } else {
    for (const harness of ["dsh", "hermes"] as const) {
      validateHarnessResult(value.syntheticStoryRuns[harness], `syntheticStoryRuns.${harness}`, errors);
    }
  }

  if (!isRecord(value.realCanaries)) {
    errors.push("realCanaries must be an object");
  } else {
    for (const harness of ["dsh", "hermes"] as const) {
      const prefix = `realCanaries.${harness}`;
      const canary = value.realCanaries[harness];
      validateHarnessResult(canary, prefix, errors);
      if (!isRecord(canary)) continue;
      if (!isNonNegativeInt(canary.tokens_spent)) {
        errors.push(`${prefix}.tokens_spent must be a non-negative integer`);
      }
      if (canary.landed_commit !== null && !isNonEmptyString(canary.landed_commit)) {
        errors.push(`${prefix}.landed_commit must be a string or null`);
      }
      if (!isNonEmptyString(canary.evidencePath)) {
        errors.push(`${prefix}.evidencePath must be a non-empty string`);
      }
    }
  }

  if (!isRecord(value.piGates)) {
    errors.push("piGates must be an object");
  } else if (value.piGates.admissionUnchanged !== true) {
    errors.push("piGates.admissionUnchanged must be true");
  }

  if (!isRecord(value.fastE2e)) {
    errors.push("fastE2e must be an object");
  } else {
    if (typeof value.fastE2e.smokeRc !== "number") {
      errors.push("fastE2e.smokeRc must be a number");
    }
    if (typeof value.fastE2e.scriptedRc !== "number") {
      errors.push("fastE2e.scriptedRc must be a number");
    }
    if (!isNonEmptyString(value.fastE2e.classification)) {
      errors.push("fastE2e.classification must be a non-empty string");
    }
  }

  if (!isRecord(value.fullNpmTest)) {
    errors.push("fullNpmTest must be an object");
  } else {
    const npm = value.fullNpmTest;
    if (!isRecord(npm.baseline) || !isNonNegativeInt(npm.baseline.uniqueTitles)) {
      errors.push("fullNpmTest.baseline.uniqueTitles must be a non-negative integer");
    }
    if (!isNonNegativeInt(npm.observedUniqueTitles)) {
      errors.push("fullNpmTest.observedUniqueTitles must be a non-negative integer");
    }
    if (npm.subsetOfBaseline !== true) {
      errors.push("fullNpmTest.subsetOfBaseline must be true");
    }
    if (!isStringArray(npm.newVsBaseline)) {
      errors.push("fullNpmTest.newVsBaseline must be a string array");
    }
    if (!isStringArray(npm.baselineOnly)) {
      errors.push("fullNpmTest.baselineOnly must be a string array");
    }
    if (!isNonEmptyString(npm.log)) {
      errors.push("fullNpmTest.log must be a non-empty string");
    }
  }

  return errors;
}

/**
 * Sensitive-value scan for the published file. Acceptance criterion 3: no
 * credential, secret or session URL may appear anywhere in the contract. The
 * scan is deliberately label-based (real secret shapes + any URL at all); the
 * legitimate word "token" in the token-attribution fields is not a secret.
 */
export function findSensitiveLeaks(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["openai-style key", /\bsk-[A-Za-z0-9_-]{16,}/],
    ["github pat", /\bghp_[A-Za-z0-9]{20,}/],
    ["github oauth", /\bgho_[A-Za-z0-9]{20,}/],
    ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
    ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["bearer header", /\bBearer\s+[A-Za-z0-9._-]{10,}/],
    ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    ["session url", /https?:\/\//],
  ];
  const leaks: string[] = [];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) leaks.push(label);
  }
  return leaks;
}

/** A structurally complete contract built from the LIVE catalog. */
function makeValidContract(): Record<string, unknown> {
  const admittedClosureMap: Record<string, string[]> = {};
  for (const id of MATCHLOCK_SUPPORTED_WORKFLOW_IDS) {
    admittedClosureMap[id] = [...MATCHLOCK_WORKFLOW_CAPABILITIES[id]];
  }
  const roles = ["planner", "setup", "developer", "tester", "verifier", "reviewer", "merger"];
  const tokenAttribution = {
    tokens_spent: 0,
    per_round_positive: false,
    status: "unavailable",
    classification: "ENVIRONMENT",
  };
  const harnessResult = {
    observed_rounds: 0,
    observed_rounds_status: "unavailable",
    classification: "ENVIRONMENT",
    operatorCommand: "flock --exclusive <lock> ./runner",
    roles,
    token_attribution: tokenAttribution,
  };
  return {
    contract: "MTLK-ALL-WORKFLOWS",
    decision: "B",
    bead: "tamandua-6sy.33.10.39",
    runId: "run-fixture",
    branch: "feature/matchlock-all-workflows",
    policyChange: {
      harnessAxisRemoved: true,
      piUnchanged: true,
      removedArtifacts: ["MATCHLOCK_HARNESS_WORKFLOW_IDS"],
      replacement: "capability closure",
      capabilities: [...MATCHLOCK_AVAILABLE_CAPABILITIES],
      stories: ["US-003", "US-004"],
    },
    admittedClosureMap,
    refusals: MATCHLOCK_REFUSED_WORKFLOW_IDS.map((id) => ({
      workflowId: id,
      code: MATCHLOCK_REFUSED_WORKFLOWS[id].code,
      reason: MATCHLOCK_REFUSED_WORKFLOWS[id].reason,
    })),
    bundledWorkflowIds: [...MATCHLOCK_BUNDLED_WORKFLOW_IDS],
    syntheticStoryRuns: { dsh: harnessResult, hermes: harnessResult },
    realCanaries: {
      dsh: { ...harnessResult, tokens_spent: 0, landed_commit: null, evidencePath: "/evidence/dsh" },
      hermes: { ...harnessResult, tokens_spent: 0, landed_commit: null, evidencePath: "/evidence/hermes" },
    },
    piGates: { admissionUnchanged: true },
    fastE2e: { smokeRc: 0, scriptedRc: 1, classification: "ENVIRONMENT" },
    fullNpmTest: {
      baseline: { uniqueTitles: 44 },
      observedUniqueTitles: 44,
      subsetOfBaseline: true,
      newVsBaseline: [],
      baselineOnly: [],
      log: "/evidence/testcmd.log",
    },
    credentialsPrinted: false,
    sessionUrlsPrinted: false,
  };
}

describe("validateAllWorkflowsContract (structural + catalog cross-check)", () => {
  it("accepts a complete contract built from the live catalog", () => {
    assert.deepEqual(validateAllWorkflowsContract(makeValidContract()), []);
  });

  it("rejects a missing top-level key", () => {
    const contract = makeValidContract();
    delete contract.fullNpmTest;
    assert.match(validateAllWorkflowsContract(contract).join("\n"), /fullNpmTest must be an object/);
  });

  it("rejects a contract that still claims a harness axis", () => {
    const contract = makeValidContract();
    (contract.policyChange as Record<string, unknown>).harnessAxisRemoved = false;
    assert.match(
      validateAllWorkflowsContract(contract).join("\n"),
      /harnessAxisRemoved must be true/,
    );
  });

  it("rejects an admitted closure that drifted from capabilities.ts", () => {
    const contract = makeValidContract();
    (contract.admittedClosureMap as Record<string, string[]>)[
      "feature-dev-merge-worktree"
    ] = ["guest-git"];
    assert.match(
      validateAllWorkflowsContract(contract).join("\n"),
      /admittedClosureMap\['feature-dev-merge-worktree'\] drifted/,
    );
  });

  it("rejects a missing refused workflow and a bad refusal code", () => {
    const dropped = makeValidContract();
    dropped.refusals = (dropped.refusals as unknown[]).slice(1);
    assert.match(
      validateAllWorkflowsContract(dropped).join("\n"),
      /refusals missing refused workflow/,
    );

    const badCode = makeValidContract();
    (badCode.refusals as Array<Record<string, unknown>>)[0].code = "not-a-real-code";
    assert.match(validateAllWorkflowsContract(badCode).join("\n"), /is not a known refusal class/);
  });

  it("rejects a record that hides an unavailable result instead of classifying it", () => {
    const contract = makeValidContract();
    delete (contract.realCanaries as Record<string, Record<string, unknown>>).dsh
      .observed_rounds_status;
    assert.match(
      validateAllWorkflowsContract(contract).join("\n"),
      /realCanaries\.dsh\.observed_rounds_status must be a non-empty string/,
    );
  });

  it("rejects a full-suite result that is not a baseline subset", () => {
    const contract = makeValidContract();
    (contract.fullNpmTest as Record<string, unknown>).subsetOfBaseline = false;
    assert.match(validateAllWorkflowsContract(contract).join("\n"), /subsetOfBaseline must be true/);
  });
});

describe("findSensitiveLeaks", () => {
  it("flags secret-shaped values and any session URL", () => {
    assert.deepEqual(findSensitiveLeaks("token_attribution tokens_spent 0"), []);
    assert.deepEqual(findSensitiveLeaks("a sk-abcdefghijklmnopqrstuv token"), ["openai-style key"]);
    assert.deepEqual(findSensitiveLeaks("see https://example.invalid/session/1"), ["session url"]);
    assert.deepEqual(findSensitiveLeaks("Authorization: Bearer abcdefghijklmno"), ["bearer header"]);
  });
});

describe("published MTLK-ALL-WORKFLOWS contract file", () => {
  it(
    "parses the published deliverable as JSON and finds it complete and leak-free",
    {
      skip: (() => {
        const path =
          process.env.MATCHLOCK_ALL_WORKFLOWS_CONTRACT_PATH ??
          DEFAULT_ALL_WORKFLOWS_CONTRACT_PATH;
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const path =
        process.env.MATCHLOCK_ALL_WORKFLOWS_CONTRACT_PATH ?? DEFAULT_ALL_WORKFLOWS_CONTRACT_PATH;
      const raw = readFileSync(path, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        assert.fail(`published contract is not valid JSON: ${(error as Error).message}`);
      }
      assert.deepEqual(validateAllWorkflowsContract(parsed), []);
      assert.deepEqual(findSensitiveLeaks(raw), []);
    },
  );
});
