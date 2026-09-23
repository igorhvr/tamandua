/**
 * MTLK-ALLOW-PRIVATE US-010 (bead tamandua-6sy.33.10.45) — deliverable
 * regression for the published allow-private run contract.
 *
 * The run deliverable
 * `/home/kaladin/matchlock-work/matchlock-allow-private-contract.json` lives
 * OUTSIDE the repository on purpose (it is never committed). This file carries
 * the committed validator the story's acceptance criteria ask for: it parses
 * the contract as JSON and asserts it records
 *
 *   - `schema`: an `allow-private-contract/<version>` identity.
 *   - `flag`: the repeatable `--matchlock-allow-private <entry>` flag, its
 *     `requires --matchlock` rule and the shape-only entry grammar (accepted /
 *     rejected examples are checked against the SAME `isAllowPrivateEntryShape`
 *     the CLI, policy and admission share, so the contract cannot document a
 *     grammar the implementation no longer accepts).
 *   - `env`: the comma-separated `TAMANDUA_MATCHLOCK_ALLOW_PRIVATE` default,
 *     used only when the flag is absent (and never for a native run).
 *   - `policy`: the persisted `networkAllowPrivate` field,
 *     `networkPolicyVersion 2`, omitted-when-empty, persisted at admission and
 *     inherited by replacements/retries/resumes, mapped to
 *     `network.allow_private` in the create params.
 *   - `doctor`: the `matchlock run --help` probe and its
 *     supported/unsupported/absent states.
 *   - `admission`: the typed `matchlock_allow_private_unsupported` refusal.
 *   - `fastGates`: one entry per fast gate (command, logPath, exitCode), with
 *     the recorded exit codes.
 *   - `realGates`: the real-VM allow-private gate driver/evidence/exit plus
 *     either an observed positive round count with owned `vm-<8hex>` ids, or
 *     (when the agent sandbox cannot boot a VM) explicit ENVIRONMENT evidence
 *     with the exact operator command and the tester re-run requirement.
 *
 * Pure filesystem reads + the shared shape validator (node:net only — no
 * child_process, no daemon, no VM, no network), so this file stays in the
 * parallel lane and needs no tests/serial-files.txt entry. When the deliverable
 * is absent (e.g. a checkout that never produced it, or another machine) the
 * real-file assertion is skipped so the committed suite never depends on host
 * state; the pure validator assertions below always run.
 *
 * It never reads or writes `TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE`; the
 * contract's `tempExemption.dependsOn` flag is asserted false instead.
 *
 * Mirrors the shape of tests/alias-fix-contract.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAllowPrivateEntryShape } from "../dist/installer/matchlock/allow-private.js";

/** Prefix every allow-private contract schema version must carry. */
export const ALLOW_PRIVATE_CONTRACT_SCHEMA_PREFIX = "allow-private-contract/";

/** Required top-level sections of the published contract. */
export const ALLOW_PRIVATE_REQUIRED_SECTIONS = [
  "schema",
  "flag",
  "env",
  "policy",
  "doctor",
  "admission",
  "fastGates",
  "realGates",
] as const;

/** Fast-gate labels the hardware-free gate set must record. */
export const ALLOW_PRIVATE_REQUIRED_FAST_GATES = [
  "build",
  "allow-private-units",
  "npm-test",
  "run-all-e2e-tests",
] as const;

/** The one real-VM gate this story publishes. */
export const ALLOW_PRIVATE_GATE_LABEL = "allow-private";

/** The CLI flag the contract documents. */
export const ALLOW_PRIVATE_FLAG_NAME = "--matchlock-allow-private";

/** The env default the contract documents. */
export const ALLOW_PRIVATE_ENV_NAME = "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE";

/** The persisted policy field the contract documents. */
export const ALLOW_PRIVATE_POLICY_FIELD = "networkAllowPrivate";

/** The current Matchlock network policy version. */
export const ALLOW_PRIVATE_NETWORK_POLICY_VERSION = 2;

/** The typed admission refusal the contract documents. */
export const ALLOW_PRIVATE_TYPED_REFUSAL = "matchlock_allow_private_unsupported";

/** An owned in-VM round VM id: `vm-<8 lowercase hex>`. */
export const ALLOW_PRIVATE_VM_ID_PATTERN = /^vm-[0-9a-f]{8}$/;

/** The doctor probe subcommand every documented probe command must carry. */
export const ALLOW_PRIVATE_DOCTOR_PROBE_SUBCOMMAND = "run --help";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function requireTrueFlag(value: unknown, prefix: string, errors: string[]): void {
  if (value !== true) errors.push(`${prefix} must be true`);
}

function validateExamples(
  value: unknown,
  prefix: string,
  expected: boolean,
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${prefix} must be a non-empty array`);
    return;
  }
  for (const [index, example] of value.entries()) {
    if (typeof example !== "string") {
      errors.push(`${prefix}[${index}] must be a string`);
      continue;
    }
    if (expected && example.trim() === "") {
      errors.push(`${prefix}[${index}] must be a non-empty string`);
      continue;
    }
    const accepted = isAllowPrivateEntryShape(example);
    if (accepted !== expected) {
      errors.push(
        `${prefix}[${index}] (${JSON.stringify(example)}) must be ${
          expected ? "accepted" : "rejected"
        } by the shared allow-private shape validator`,
      );
    }
  }
}

function validateFlagSection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("flag must be an object");
    return;
  }
  if (value.name !== ALLOW_PRIVATE_FLAG_NAME) {
    errors.push(`flag.name must be '${ALLOW_PRIVATE_FLAG_NAME}'`);
  }
  requireTrueFlag(value.repeatable, "flag.repeatable", errors);
  if (value.requiresFlag !== "--matchlock") {
    errors.push("flag.requiresFlag must be '--matchlock'");
  }
  if (!isNonEmptyString(value.argument)) {
    errors.push("flag.argument must be a non-empty string (the <entry> placeholder)");
  }
  if (!isNonEmptyString(value.inlineForm)) {
    errors.push("flag.inlineForm must be a non-empty string");
  }
  if (!isNonEmptyString(value.grammar)) {
    errors.push("flag.grammar must be a non-empty string");
  } else {
    for (const token of ["host name", "IPv4", "IPv6", "CIDR", ":port", "[addr]:port"]) {
      if (!value.grammar.includes(token)) {
        errors.push(`flag.grammar must mention '${token}'`);
      }
    }
  }
  validateExamples(value.acceptedExamples, "flag.acceptedExamples", true, errors);
  validateExamples(value.rejectedExamples, "flag.rejectedExamples", false, errors);
}

function validateEnvSection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("env must be an object");
    return;
  }
  if (value.name !== ALLOW_PRIVATE_ENV_NAME) {
    errors.push(`env.name must be '${ALLOW_PRIVATE_ENV_NAME}'`);
  }
  if (value.format !== "comma-separated") {
    errors.push("env.format must be 'comma-separated'");
  }
  requireTrueFlag(value.usedOnlyWhenFlagAbsent, "env.usedOnlyWhenFlagAbsent", errors);
  requireTrueFlag(value.requiresMatchlock, "env.requiresMatchlock", errors);
  requireTrueFlag(value.ignoredForNativeRuns, "env.ignoredForNativeRuns", errors);
}

function validatePolicySection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("policy must be an object");
    return;
  }
  if (value.field !== ALLOW_PRIVATE_POLICY_FIELD) {
    errors.push(`policy.field must be '${ALLOW_PRIVATE_POLICY_FIELD}'`);
  }
  if (value.networkPolicyVersion !== ALLOW_PRIVATE_NETWORK_POLICY_VERSION) {
    errors.push(
      `policy.networkPolicyVersion must be ${ALLOW_PRIVATE_NETWORK_POLICY_VERSION}`,
    );
  }
  if (value.createParam !== "network.allow_private") {
    errors.push("policy.createParam must be 'network.allow_private'");
  }
  for (const field of [
    "omittedWhenEmpty",
    "persistedAtAdmission",
    "inheritedByReplacements",
    "inheritedByRetries",
    "inheritedByResumes",
    "createParamOmittedWhenEmpty",
    "blockPrivateIps",
    "intercept",
  ] as const) {
    requireTrueFlag(value[field], `policy.${field}`, errors);
  }
}

function validateDoctorSection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("doctor must be an object");
    return;
  }
  if (!isNonEmptyString(value.checkName)) {
    errors.push("doctor.checkName must be a non-empty string");
  }
  if (!isNonEmptyString(value.probeCommand)) {
    errors.push("doctor.probeCommand must be a non-empty string");
  } else if (!value.probeCommand.includes(ALLOW_PRIVATE_DOCTOR_PROBE_SUBCOMMAND)) {
    errors.push(
      `doctor.probeCommand must probe '<matchlock> ${ALLOW_PRIVATE_DOCTOR_PROBE_SUBCOMMAND}'`,
    );
  }
  for (const state of ["supported", "unsupported", "absent"] as const) {
    if (!isNonEmptyString(value[state])) {
      errors.push(`doctor.${state} must be a non-empty string`);
    }
  }
  if (!isNonEmptyString(value.upgradeRemedy)) {
    errors.push("doctor.upgradeRemedy must be a non-empty string");
  }
}

function validateAdmissionSection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("admission must be an object");
    return;
  }
  if (value.refusalCode !== ALLOW_PRIVATE_TYPED_REFUSAL) {
    errors.push(`admission.refusalCode must be '${ALLOW_PRIVATE_TYPED_REFUSAL}'`);
  }
  for (const field of [
    "actionable",
    "namesBinary",
    "namesEntries",
    "failsClosed",
    "noSilentDrop",
    "noPolicyOnRefusal",
  ] as const) {
    requireTrueFlag(value[field], `admission.${field}`, errors);
  }
}

function validateFastGate(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const field of ["gate", "command", "logPath"] as const) {
    if (!(field in value)) errors.push(`${prefix} missing ${field}`);
    else if (!isNonEmptyString(value[field])) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
    }
  }
  if (!("exitCode" in value)) errors.push(`${prefix} missing exitCode`);
  else if (typeof value.exitCode !== "number") {
    errors.push(`${prefix}.exitCode must be a number`);
  }
}

/**
 * The ENVIRONMENT block a real gate records when the agent sandbox cannot boot
 * a VM. It is the honest alternative to a positive observed-round count.
 */
function validateRealGateEnvironment(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!isNonEmptyString(value.reasonCode)) {
    errors.push(`${prefix}.reasonCode must be a non-empty string`);
  }
  if (!isNonEmptyString(value.capEff)) {
    errors.push(`${prefix}.capEff must be a non-empty string`);
  }
  if (!isNonEmptyString(value.noNewPrivs)) {
    errors.push(`${prefix}.noNewPrivs must be a non-empty string`);
  }
  if (!isNonEmptyString(value.tunTapFailure)) {
    errors.push(`${prefix}.tunTapFailure must be a non-empty string`);
  }
  if (!isNonEmptyString(value.evidence)) {
    errors.push(`${prefix}.evidence must be a non-empty string`);
  }
}

/**
 * Validate one recorded real-VM gate. A gate with observed rounds must exit 0
 * and carry at least one owned `vm-<8hex>` id. A gate the sandbox could not run
 * must instead carry explicit ENVIRONMENT evidence, the exact operator command
 * and `testerRerunRequired: true`; only then is `observed_rounds === 0`
 * accepted. Anything else (a hollow green with no rounds and no environment
 * disclosure) fails.
 */
function validateRealGate(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const field of ["gate", "driver", "evidenceDir", "logPath"] as const) {
    if (!(field in value)) errors.push(`${prefix} missing ${field}`);
    else if (!isNonEmptyString(value[field])) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
    }
  }

  const observedRounds = value.observed_rounds;
  if (isPositiveInt(observedRounds)) {
    if (!("exitCode" in value)) errors.push(`${prefix} missing exitCode`);
    else if (!Number.isInteger(value.exitCode)) {
      errors.push(`${prefix}.exitCode must be an integer`);
    } else if (value.exitCode !== 0) {
      errors.push(`${prefix}.exitCode must be 0 (got ${value.exitCode})`);
    }
    if (!Array.isArray(value.observed_vm_ids)) {
      errors.push(`${prefix}.observed_vm_ids must be an array`);
    } else {
      if (value.observed_vm_ids.length === 0) {
        errors.push(`${prefix}.observed_vm_ids must record at least one owned VM id`);
      }
      for (const [index, vmId] of value.observed_vm_ids.entries()) {
        if (typeof vmId !== "string" || !ALLOW_PRIVATE_VM_ID_PATTERN.test(vmId)) {
          errors.push(`${prefix}.observed_vm_ids[${index}] must match vm-<8 lowercase hex>`);
        }
      }
    }
    return;
  }

  // No positive round count: only the explicit sandbox-environment disclosure
  // is accepted, and it must be complete enough to be actionable.
  if (!isRecord(value.environment)) {
    errors.push(
      `${prefix}.observed_rounds must be a positive integer (> 0) unless explicit environment evidence is recorded`,
    );
    return;
  }
  if (observedRounds !== undefined && observedRounds !== 0) {
    errors.push(
      `${prefix}.observed_rounds must be a positive integer (> 0), or exactly 0 with explicit environment evidence`,
    );
  }
  if (value.exitCode !== null && value.exitCode !== undefined) {
    errors.push(
      `${prefix}.exitCode must be null when the gate could not run (got ${JSON.stringify(value.exitCode)})`,
    );
  }
  if (!isNonEmptyString(value.operatorCommand)) {
    errors.push(
      `${prefix}.operatorCommand must be the exact command the tester re-runs under the shared gate lock`,
    );
  }
  requireTrueFlag(value.testerRerunRequired, `${prefix}.testerRerunRequired`, errors);
  validateRealGateEnvironment(value.environment, `${prefix}.environment`, errors);
}

/**
 * Validate an already-parsed allow-private contract value. Returns a list of
 * human-readable problems; an empty list means the contract is complete.
 */
export function validateAllowPrivateContract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["contract must be a JSON object"];
  }
  if (
    !isNonEmptyString(value.schema) ||
    !value.schema.startsWith(ALLOW_PRIVATE_CONTRACT_SCHEMA_PREFIX)
  ) {
    errors.push(
      `schema must be a string starting with '${ALLOW_PRIVATE_CONTRACT_SCHEMA_PREFIX}'`,
    );
  }
  for (const section of ALLOW_PRIVATE_REQUIRED_SECTIONS) {
    if (section === "schema") continue;
    if (!(section in value)) errors.push(`missing required section '${section}'`);
  }

  validateFlagSection(value.flag, errors);
  validateEnvSection(value.env, errors);
  validatePolicySection(value.policy, errors);
  validateDoctorSection(value.doctor, errors);
  validateAdmissionSection(value.admission, errors);

  // The contract must never depend on the temporary host exemption. A present
  // tempExemption block simply documents the key and must declare no dependency
  // (absent is fine too).
  if (value.tempExemption !== undefined) {
    if (!isRecord(value.tempExemption)) {
      errors.push("tempExemption must be an object when present");
    } else if (value.tempExemption.dependsOn !== false) {
      errors.push("tempExemption.dependsOn must be false");
    }
  }

  if (!Array.isArray(value.fastGates) || value.fastGates.length === 0) {
    errors.push("fastGates must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const [index, rawGate] of value.fastGates.entries()) {
      validateFastGate(rawGate, `fastGates[${index}]`, errors);
      if (isRecord(rawGate) && isNonEmptyString(rawGate.gate)) {
        if (seen.has(rawGate.gate)) {
          errors.push(`duplicate fastGates gate '${rawGate.gate}'`);
        }
        seen.add(rawGate.gate);
      }
    }
    for (const required of ALLOW_PRIVATE_REQUIRED_FAST_GATES) {
      if (!seen.has(required)) {
        errors.push(`fastGates is missing the required '${required}' gate`);
      }
    }
  }

  if (!Array.isArray(value.realGates) || value.realGates.length === 0) {
    errors.push("realGates must be a non-empty array");
  } else {
    const seenReal = new Set<string>();
    for (const [index, rawGate] of value.realGates.entries()) {
      validateRealGate(rawGate, `realGates[${index}]`, errors);
      if (isRecord(rawGate) && isNonEmptyString(rawGate.gate)) {
        if (seenReal.has(rawGate.gate)) {
          errors.push(`duplicate realGates gate '${rawGate.gate}'`);
        }
        seenReal.add(rawGate.gate);
      }
    }
    if (!seenReal.has(ALLOW_PRIVATE_GATE_LABEL)) {
      errors.push(`realGates is missing the '${ALLOW_PRIVATE_GATE_LABEL}' gate`);
    }
  }

  if (value.existingRealGates !== undefined) {
    if (!Array.isArray(value.existingRealGates)) {
      errors.push("existingRealGates must be an array when present");
    } else {
      for (const [index, rawGate] of value.existingRealGates.entries()) {
        const prefix = `existingRealGates[${index}]`;
        if (!isRecord(rawGate)) {
          errors.push(`${prefix} must be an object`);
          continue;
        }
        if (!isNonEmptyString(rawGate.gate)) errors.push(`${prefix}.gate must be a non-empty string`);
        if (!isNonEmptyString(rawGate.driver)) {
          errors.push(`${prefix}.driver must be a non-empty string`);
        }
        if (rawGate.unchanged !== true) {
          errors.push(`${prefix}.unchanged must be true (the change must not alter these gates)`);
        }
      }
    }
  }

  return errors;
}

/** The sandbox ENVIRONMENT block used by the minimal realGates entry. */
function buildMinimalEnvironment(): Record<string, unknown> {
  return {
    reasonCode: "sandbox_no_vm_capability",
    capEff: "0000000000000000",
    noNewPrivs: "1",
    tunTapFailure: "TUNSETIFF failed: Operation not permitted",
    evidence: "capability + unshare probe transcript",
  };
}

/** Minimal contract shape that validateAllowPrivateContract must accept. */
function buildMinimalValidContract(): Record<string, unknown> {
  return {
    schema: "allow-private-contract/1",
    flag: {
      name: ALLOW_PRIVATE_FLAG_NAME,
      repeatable: true,
      requiresFlag: "--matchlock",
      argument: "<entry>",
      inlineForm: "--matchlock-allow-private=<entry>",
      grammar:
        "a host name, an IPv4/IPv6 literal or CIDR, optionally suffixed with :port " +
        "(a bracketed IPv6 destination uses [addr]:port; a bare IPv6 literal carries no port)",
      acceptedExamples: [
        "192.168.107.74:8888",
        "box.internal",
        "10.0.0.0/8",
        "[2001:db8::1]:443",
        "fe80::1",
      ],
      rejectedExamples: ["", "10.0.0.0/99", "host:0", "[fe80::1]", "a b"],
    },
    env: {
      name: ALLOW_PRIVATE_ENV_NAME,
      format: "comma-separated",
      usedOnlyWhenFlagAbsent: true,
      requiresMatchlock: true,
      ignoredForNativeRuns: true,
    },
    policy: {
      field: ALLOW_PRIVATE_POLICY_FIELD,
      networkPolicyVersion: ALLOW_PRIVATE_NETWORK_POLICY_VERSION,
      createParam: "network.allow_private",
      omittedWhenEmpty: true,
      persistedAtAdmission: true,
      inheritedByReplacements: true,
      inheritedByRetries: true,
      inheritedByResumes: true,
      createParamOmittedWhenEmpty: true,
      blockPrivateIps: true,
      intercept: true,
    },
    doctor: {
      checkName: "Matchlock allow_private support",
      probeCommand: "matchlock run --help",
      supported: "pass: the installed matchlock lists --allow-private",
      unsupported: "warn: the installed matchlock lacks --allow-private",
      absent: "info: no matchlock binary found",
      upgradeRemedy: "upgrade matchlock; allow-private runs will be refused",
    },
    admission: {
      refusalCode: ALLOW_PRIVATE_TYPED_REFUSAL,
      actionable: true,
      namesBinary: true,
      namesEntries: true,
      failsClosed: true,
      noSilentDrop: true,
      noPolicyOnRefusal: true,
    },
    tempExemption: {
      env: "TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE",
      dependsOn: false,
    },
    fastGates: [
      { gate: "build", command: "npm run build", logPath: "/x/build.log", exitCode: 0 },
      {
        gate: "allow-private-units",
        command: "node --test ...",
        logPath: "/x/units.log",
        exitCode: 0,
      },
      { gate: "npm-test", command: "tamandua-test ...", logPath: "/x/npm-test.log", exitCode: 0 },
      {
        gate: "run-all-e2e-tests",
        command: "./run-all-e2e-tests",
        logPath: "/x/e2e.log",
        exitCode: 0,
      },
    ],
    realGates: [
      {
        gate: ALLOW_PRIVATE_GATE_LABEL,
        driver: "run-matchlock-allow-private-e2e-test",
        evidenceDir: "/x/evidence/allow-private-000000",
        logPath: "/x/logs/gate-allow-private.log",
        exitCode: null,
        observed_rounds: 0,
        operatorCommand: "./run-matchlock-allow-private-e2e-test",
        testerRerunRequired: true,
        environment: buildMinimalEnvironment(),
      },
    ],
  };
}

/** Minimal observed-rounds realGates entry that the validator must accept. */
function buildMinimalValidObservedRealGate(): Record<string, unknown> {
  return {
    gate: ALLOW_PRIVATE_GATE_LABEL,
    driver: "run-matchlock-allow-private-e2e-test",
    evidenceDir: "/x/evidence/allow-private-000000",
    logPath: "/x/logs/gate-allow-private.log",
    exitCode: 0,
    observed_rounds: 4,
    observed_vm_ids: ["vm-12c3129b", "vm-00aa11bb"],
  };
}

const contractPath =
  process.env.ALLOW_PRIVATE_CONTRACT_PATH ??
  "/home/kaladin/matchlock-work/matchlock-allow-private-contract.json";

describe("allow-private contract validator (US-010)", () => {
  it("accepts a complete minimal contract", () => {
    assert.deepEqual(validateAllowPrivateContract(buildMinimalValidContract()), []);
  });

  it("reports a wrong schema prefix", () => {
    const contract = buildMinimalValidContract();
    contract.schema = "something-else/1";
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes("schema must be a string starting with")),
      `expected a schema error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports every missing required section", () => {
    for (const section of ALLOW_PRIVATE_REQUIRED_SECTIONS) {
      if (section === "schema") continue;
      const contract = buildMinimalValidContract();
      delete contract[section];
      const errors = validateAllowPrivateContract(contract);
      assert.ok(
        errors.some((error) => error.includes(`missing required section '${section}'`)),
        `expected a missing '${section}' error, got ${JSON.stringify(errors)}`,
      );
    }
  });

  it("reports a flag missing repeatability or the --matchlock rule", () => {
    const contract = buildMinimalValidContract();
    (contract.flag as Record<string, unknown>).repeatable = false;
    (contract.flag as Record<string, unknown>).requiresFlag = "nothing";
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes("flag.repeatable must be true")),
      `expected a repeatable error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("flag.requiresFlag must be '--matchlock'")),
      `expected a requires-flag error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a documented grammar that no longer matches the shared validator", () => {
    const contract = buildMinimalValidContract();
    (contract.flag as Record<string, unknown>).grammar = "just a host name";
    (contract.flag as Record<string, unknown>).acceptedExamples = ["host:0"];
    (contract.flag as Record<string, unknown>).rejectedExamples = ["box.internal"];
    const errors = validateAllowPrivateContract(contract);
    for (const token of ["IPv4", "IPv6", "CIDR", ":port", "[addr]:port"]) {
      assert.ok(
        errors.some((error) => error.includes(`flag.grammar must mention '${token}'`)),
        `expected a grammar-token error for '${token}', got ${JSON.stringify(errors)}`,
      );
    }
    assert.ok(
      errors.some((error) => error.includes('"host:0"') && error.includes("must be accepted")),
      `expected a rejected-example error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes('"box.internal"') && error.includes("must be rejected")),
      `expected an accepted-example error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a wrong env default contract", () => {
    const contract = buildMinimalValidContract();
    const env = contract.env as Record<string, unknown>;
    env.name = "SOME_OTHER_VAR";
    env.format = "space separated";
    env.usedOnlyWhenFlagAbsent = false;
    const errors = validateAllowPrivateContract(contract);
    assert.ok(errors.some((error) => error.includes(`env.name must be '${ALLOW_PRIVATE_ENV_NAME}'`)));
    assert.ok(errors.some((error) => error.includes("env.format must be 'comma-separated'")));
    assert.ok(errors.some((error) => error.includes("env.usedOnlyWhenFlagAbsent must be true")));
  });

  it("reports a policy field/version/create-param drift", () => {
    const contract = buildMinimalValidContract();
    const policy = contract.policy as Record<string, unknown>;
    policy.field = "allowPrivate";
    policy.networkPolicyVersion = 1;
    policy.createParam = "network.allowPrivate";
    policy.omittedWhenEmpty = false;
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes(`policy.field must be '${ALLOW_PRIVATE_POLICY_FIELD}'`)),
    );
    assert.ok(
      errors.some((error) =>
        error.includes(`policy.networkPolicyVersion must be ${ALLOW_PRIVATE_NETWORK_POLICY_VERSION}`),
      ),
    );
    assert.ok(errors.some((error) => error.includes("policy.createParam must be 'network.allow_private'")));
    assert.ok(errors.some((error) => error.includes("policy.omittedWhenEmpty must be true")));
  });

  it("reports a doctor probe that does not probe run --help", () => {
    const contract = buildMinimalValidContract();
    (contract.doctor as Record<string, unknown>).probeCommand = "matchlock --version";
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) =>
        error.includes(`doctor.probeCommand must probe '<matchlock> ${ALLOW_PRIVATE_DOCTOR_PROBE_SUBCOMMAND}'`),
      ),
      `expected a probe error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports the wrong typed admission refusal", () => {
    const contract = buildMinimalValidContract();
    const admission = contract.admission as Record<string, unknown>;
    admission.refusalCode = "something_else";
    admission.noSilentDrop = false;
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) =>
        error.includes(`admission.refusalCode must be '${ALLOW_PRIVATE_TYPED_REFUSAL}'`),
      ),
    );
    assert.ok(errors.some((error) => error.includes("admission.noSilentDrop must be true")));
  });

  it("reports a contract that depends on the temporary host exemption", () => {
    const contract = buildMinimalValidContract();
    (contract.tempExemption as Record<string, unknown>).dependsOn = true;
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes("tempExemption.dependsOn must be false")),
      `expected a temp-exemption dependency error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports fast gates missing command/log/exit fields or labels", () => {
    const contract = buildMinimalValidContract();
    (contract.fastGates as Array<Record<string, unknown>>)[0] = {
      gate: "build",
      command: "npm run build",
    };
    contract.fastGates = (contract.fastGates as Array<Record<string, unknown>>).filter(
      (gate) => gate.gate !== "npm-test",
    );
    const errors = validateAllowPrivateContract(contract);
    assert.ok(errors.some((error) => error.includes("fastGates[0] missing logPath")));
    assert.ok(errors.some((error) => error.includes("fastGates[0] missing exitCode")));
    assert.ok(
      errors.some((error) => error.includes("fastGates is missing the required 'npm-test' gate")),
      `expected a missing npm-test gate error, got ${JSON.stringify(errors)}`,
    );
  });

  it("accepts an observed-rounds realGates entry with owned vm-<8hex> ids", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [buildMinimalValidObservedRealGate()];
    assert.deepEqual(validateAllowPrivateContract(contract), []);
  });

  it("reports a hollow green (zero rounds, no environment evidence)", () => {
    const contract = buildMinimalValidContract();
    const gate = buildMinimalValidContract().realGates as Array<Record<string, unknown>>;
    delete (gate[0] as Record<string, unknown>).environment;
    contract.realGates = gate;
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes("realGates[0].observed_rounds must be a positive integer")),
      `expected a zero-round error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports an environment-blocked gate missing the operator command or re-run flag", () => {
    const contract = buildMinimalValidContract();
    const gate = (contract.realGates as Array<Record<string, unknown>>)[0];
    delete gate.operatorCommand;
    delete gate.testerRerunRequired;
    gate.exitCode = 1;
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes("realGates[0].operatorCommand must be the exact command")),
      `expected an operator-command error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("realGates[0].testerRerunRequired must be true")),
      `expected a tester-rerun error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("realGates[0].exitCode must be null")),
      `expected an exit-code error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports an incomplete environment evidence block", () => {
    const contract = buildMinimalValidContract();
    const gate = (contract.realGates as Array<Record<string, unknown>>)[0];
    gate.environment = { reasonCode: "x" };
    const errors = validateAllowPrivateContract(contract);
    assert.ok(errors.some((error) => error.includes("realGates[0].environment.capEff must be")));
    assert.ok(
      errors.some((error) => error.includes("realGates[0].environment.tunTapFailure must be")),
    );
  });

  it("reports observed VM ids that are not owned vm-<8hex> ids", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [
      { ...buildMinimalValidObservedRealGate(), observed_vm_ids: ["vm-NOTHEX", "1234"] },
    ];
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) =>
        error.includes("realGates[0].observed_vm_ids[0] must match vm-<8 lowercase hex>"),
      ),
    );
    assert.ok(
      errors.some((error) =>
        error.includes("realGates[0].observed_vm_ids[1] must match vm-<8 lowercase hex>"),
      ),
    );
  });

  it("reports a realGates battery without the allow-private gate", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [{ ...buildMinimalValidObservedRealGate(), gate: "synthetic" }];
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes("realGates is missing the 'allow-private' gate")),
      `expected a missing allow-private gate error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports an existingRealGates entry that claims a behaviour change", () => {
    const contract = buildMinimalValidContract();
    contract.existingRealGates = [{ gate: "synthetic", driver: "run-matchlock-synthetic-e2e-test", unchanged: false }];
    const errors = validateAllowPrivateContract(contract);
    assert.ok(
      errors.some((error) => error.includes("existingRealGates[0].unchanged must be true")),
      `expected an unchanged error, got ${JSON.stringify(errors)}`,
    );
  });

  it(
    "parses the published deliverable as JSON and validates it",
    { skip: existsSync(contractPath) ? false : `deliverable not found at ${contractPath}` },
    () => {
      const raw = readFileSync(contractPath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        assert.fail(`published contract is not valid JSON: ${(error as Error).message}`);
      }
      assert.deepEqual(validateAllowPrivateContract(parsed), []);
    },
  );
});
