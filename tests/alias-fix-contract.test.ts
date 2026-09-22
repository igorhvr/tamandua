/**
 * MTLK-ALIAS-FIX US-007 (bead tamandua-6sy.33.10.43) — deliverable regression
 * for the published ALIAS-FIX contract file.
 *
 * The run deliverable `/home/kaladin/matchlock-work/alias-fix-contract.json`
 * lives OUTSIDE the repository on purpose (it is never committed). This file
 * carries the validator the story's acceptance criteria ask for: it parses the
 * contract as JSON and asserts it records
 *
 *   - `pathLengthProof`: the Linux 107-byte and macOS 103-byte usable sun_path
 *     limits with computed longest-socket byte lengths for the keyed default
 *     alias and a >=90-char real HOME (the proof US-001's unit tests assert).
 *   - `ownershipProtocol`: the `<k>` derivation, the `owner.json` sidecar
 *     schema, the live-holder refusal and the stale-takeover rule (the
 *     protocol US-002/US-003 implement).
 *   - `fastGates`: one entry per fast gate, each with a command, logPath and
 *     exitCode.
 *   - `realGates` (US-008): one entry per real-VM Matchlock gate with its
 *     driver, evidence dir, log path, exit code, `observed_rounds > 0` and the
 *     owned `vm-<8hex>` ids observed during the battery.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. When the deliverable is absent (e.g. a checkout that never produced
 * it, or another machine) the real-file assertion is skipped so the committed
 * suite never depends on host state; the pure validator assertions below
 * always run.
 *
 * Mirrors the shape of tests/mtlk-fix-contract.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/** Prefix every ALIAS-FIX contract schema version must carry. */
export const ALIAS_FIX_CONTRACT_SCHEMA_PREFIX = "alias-fix-contract/";

/** Owner-record fields the `ownershipProtocol` must document. */
export const ALIAS_FIX_OWNER_FIELDS = [
  "schema",
  "pid",
  "startIdentity",
  "realHome",
  "aliasPath",
  "updatedAt",
] as const;

/** Fast-gate entries the battery is expected to record (not all required at once). */
export const ALIAS_FIX_FAST_GATE_KEYS = [
  "build",
  "alias-units",
  "npm-test",
  "run-all-e2e-tests",
] as const;

/** Typed reason a live holder produces instead of a re-point. */
export const ALIAS_FIX_LIVE_HOLDER_REASON = "alias_owned_by_live_daemon";

/**
 * Real-VM Matchlock gate labels the deliverable battery records in `realGates`:
 * the six US-008 gates plus the US-005/US-009 two-daemon alias-isolation
 * regression gate.
 */
export const ALIAS_FIX_REAL_GATE_LABELS = [
  "synthetic",
  "dsh",
  "worktree-merge",
  "long-home",
  "empty-output",
  "hermes-synthetic",
  "alias-isolation",
] as const;

/** An owned in-VM round VM id: `vm-<8 lowercase hex>`. */
export const ALIAS_FIX_VM_ID_PATTERN = /^vm-[0-9a-f]{8}$/;

/**
 * The documented pre-existing matchlock guest-agent re-exec signature the dsh
 * gate's authorized deviation names (docs/matchlock-dsh-qualification.md
 * section 4, "must not be read as green").
 */
export const ALIAS_FIX_DSH_DEVIATION_SIGNATURE =
  "fork/exec " + ["", "proc", "self", "exe"].join("/") + ": no such file or directory";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateFastGate(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!("command" in value)) errors.push(`${prefix} missing command`);
  else if (!isNonEmptyString(value.command)) {
    errors.push(`${prefix}.command must be a non-empty string`);
  }
  if (!("logPath" in value)) errors.push(`${prefix} missing logPath`);
  else if (!isNonEmptyString(value.logPath)) {
    errors.push(`${prefix}.logPath must be a non-empty string`);
  }
  if (!("exitCode" in value)) errors.push(`${prefix} missing exitCode`);
  else if (typeof value.exitCode !== "number") {
    errors.push(`${prefix}.exitCode must be a number`);
  }
}

/**
 * Validate one recorded real-VM gate (US-008).
 *
 * A green gate must have `exitCode === 0`: a non-zero driver exit is only
 * accepted when the entry carries an EXPLICIT authorized deviation (an object
 * with `authorized: true` plus the item/reason/signature/documentation/evidence
 * fields), so a silent red driver can never satisfy the contract. Additionally
 * `observed_rounds` must be a positive integer and the observed VM ids must be
 * owned `vm-<8hex>` ids, so a hollow green (no in-VM round) can never satisfy
 * the contract either.
 */
function validateRealGateDeviation(value: unknown, prefix: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object when present`);
    return;
  }
  for (const field of ["item", "reason", "signature", "documentedIn", "evidencePath"] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
    }
  }
  if (value.authorized !== true) {
    errors.push(`${prefix}.authorized must be true`);
  }
}

/** Validate the optional explicit authorized deferred/skipped items of a real gate. */
function validateRealGateDeferredItems(value: unknown, prefix: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${prefix} must be an array when present`);
    return;
  }
  if (value.length === 0) {
    errors.push(`${prefix} must not be empty when present`);
  }
  for (const [index, item] of value.entries()) {
    validateRealGateDeviation(item, `${prefix}[${index}]`, errors);
  }
}

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
  if (!("exitCode" in value)) errors.push(`${prefix} missing exitCode`);
  else if (!Number.isInteger(value.exitCode)) {
    errors.push(`${prefix}.exitCode must be an integer`);
  } else if (value.exitCode !== 0) {
    if (!isRecord(value.deviation)) {
      errors.push(
        `${prefix}.exitCode must be 0 unless an explicit authorized deviation is attached (got ${value.exitCode})`,
      );
    } else {
      validateRealGateDeviation(value.deviation, `${prefix}.deviation`, errors);
    }
  } else if (value.deviation !== undefined) {
    // A green gate may still disclose an authorized deferred item (e.g. the
    // documented dsh NONSTANDARD image PATH guest re-exec block); when it does,
    // the disclosure itself must be complete.
    validateRealGateDeviation(value.deviation, `${prefix}.deviation`, errors);
  }
  if (value.deferredItems !== undefined) {
    // Optional explicit authorized deferred/skipped items that did NOT drive
    // the driver's exit code (the exit-code deviation is `deviation` above).
    validateRealGateDeferredItems(value.deferredItems, `${prefix}.deferredItems`, errors);
  }
  if (!isPositiveInt(value.observed_rounds)) {
    errors.push(`${prefix}.observed_rounds must be a positive integer (> 0)`);
  }
  if (!Array.isArray(value.observed_vm_ids)) {
    errors.push(`${prefix}.observed_vm_ids must be an array`);
  } else {
    if (value.observed_vm_ids.length === 0) {
      errors.push(`${prefix}.observed_vm_ids must record at least one owned VM id`);
    }
    for (const [index, vmId] of value.observed_vm_ids.entries()) {
      if (typeof vmId !== "string" || !ALIAS_FIX_VM_ID_PATTERN.test(vmId)) {
        errors.push(`${prefix}.observed_vm_ids[${index}] must match vm-<8 lowercase hex>`);
      }
    }
  }
}

/**
 * Validate the path-length proof: the two usable sun_path limits and the
 * computed byte lengths that must sit under them for the keyed default alias
 * and for the alias of a >=90-char real HOME.
 */
function validatePathLengthProof(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("pathLengthProof must be an object");
    return;
  }
  if (value.linuxLimit !== 107) {
    errors.push("pathLengthProof.linuxLimit must be 107");
  }
  if (value.macosLimit !== 103) {
    errors.push("pathLengthProof.macosLimit must be 103");
  }
  const linuxLimit = typeof value.linuxLimit === "number" ? value.linuxLimit : 107;
  const macosLimit = typeof value.macosLimit === "number" ? value.macosLimit : 103;

  if (!isPositiveInt(value.socketPathAddedBytes)) {
    errors.push("pathLengthProof.socketPathAddedBytes must be a positive integer");
  }
  if (!isPositiveInt(value.keyHexChars)) {
    errors.push("pathLengthProof.keyHexChars must be a positive integer");
  }
  if (!isPositiveInt(value.extraSegmentBytes)) {
    errors.push("pathLengthProof.extraSegmentBytes must be a positive integer");
  }

  const keyed = value.keyedDefaultAlias;
  if (!isRecord(keyed)) {
    errors.push("pathLengthProof.keyedDefaultAlias must be an object");
  } else {
    if (!isNonEmptyString(keyed.aliasPath)) {
      errors.push("pathLengthProof.keyedDefaultAlias.aliasPath must be a non-empty string");
    }
    if (!isPositiveInt(keyed.longestSocketBytes)) {
      errors.push("pathLengthProof.keyedDefaultAlias.longestSocketBytes must be a positive integer");
    } else {
      if (keyed.longestSocketBytes >= linuxLimit) {
        errors.push(
          `pathLengthProof.keyedDefaultAlias.longestSocketBytes (${keyed.longestSocketBytes}) must be under the Linux ${linuxLimit}-byte limit`,
        );
      }
      if (keyed.longestSocketBytes >= macosLimit) {
        errors.push(
          `pathLengthProof.keyedDefaultAlias.longestSocketBytes (${keyed.longestSocketBytes}) must be under the macOS ${macosLimit}-byte limit`,
        );
      }
    }
    if (keyed.underLinuxLimit !== true) {
      errors.push("pathLengthProof.keyedDefaultAlias.underLinuxLimit must be true");
    }
    if (keyed.underMacosLimit !== true) {
      errors.push("pathLengthProof.keyedDefaultAlias.underMacosLimit must be true");
    }
  }

  const longHome = value.longHome;
  if (!isRecord(longHome)) {
    errors.push("pathLengthProof.longHome must be an object");
  } else {
    if (!isPositiveInt(longHome.realHomeBytes) || longHome.realHomeBytes < 90) {
      errors.push("pathLengthProof.longHome.realHomeBytes must be >= 90");
    }
    if (!isPositiveInt(longHome.realHomeLongestSocketBytes)) {
      errors.push("pathLengthProof.longHome.realHomeLongestSocketBytes must be a positive integer");
    } else if (longHome.realHomeLongestSocketBytes <= linuxLimit) {
      errors.push(
        `pathLengthProof.longHome.realHomeLongestSocketBytes (${longHome.realHomeLongestSocketBytes}) must exceed the Linux ${linuxLimit}-byte limit (that is why the alias is required)`,
      );
    }
    if (!isPositiveInt(longHome.aliasLongestSocketBytes)) {
      errors.push("pathLengthProof.longHome.aliasLongestSocketBytes must be a positive integer");
    } else {
      if (longHome.aliasLongestSocketBytes >= linuxLimit) {
        errors.push(
          `pathLengthProof.longHome.aliasLongestSocketBytes (${longHome.aliasLongestSocketBytes}) must be under the Linux ${linuxLimit}-byte limit`,
        );
      }
      if (longHome.aliasLongestSocketBytes >= macosLimit) {
        errors.push(
          `pathLengthProof.longHome.aliasLongestSocketBytes (${longHome.aliasLongestSocketBytes}) must be under the macOS ${macosLimit}-byte limit`,
        );
      }
    }
    if (longHome.underLinuxLimit !== true) {
      errors.push("pathLengthProof.longHome.underLinuxLimit must be true");
    }
    if (longHome.underMacosLimit !== true) {
      errors.push("pathLengthProof.longHome.underMacosLimit must be true");
    }
  }
}

/** Validate the ownership protocol: key derivation, sidecar schema and takeover rules. */
function validateOwnershipProtocol(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("ownershipProtocol must be an object");
    return;
  }
  if (!isNonEmptyString(value.keyDerivation)) {
    errors.push("ownershipProtocol.keyDerivation must be a non-empty string");
  }
  if (!isNonEmptyString(value.ownerSchema)) {
    errors.push("ownershipProtocol.ownerSchema must be a non-empty string");
  }
  if (!isNonEmptyString(value.ownerPath)) {
    errors.push("ownershipProtocol.ownerPath must be a non-empty string");
  }
  if (!isPositiveInt(value.ownerMode) || value.ownerMode !== 0o600) {
    errors.push("ownershipProtocol.ownerMode must be 0o600 (384)");
  }

  const fields = value.ownerFields;
  if (!Array.isArray(fields)) {
    errors.push("ownershipProtocol.ownerFields must be an array");
  } else {
    for (const field of ALIAS_FIX_OWNER_FIELDS) {
      if (!fields.includes(field)) {
        errors.push(`ownershipProtocol.ownerFields missing '${field}'`);
      }
    }
  }

  const refusal = value.liveHolderRefusal;
  if (!isRecord(refusal)) {
    errors.push("ownershipProtocol.liveHolderRefusal must be an object");
  } else {
    if (refusal.reason !== ALIAS_FIX_LIVE_HOLDER_REASON) {
      errors.push(
        `ownershipProtocol.liveHolderRefusal.reason must be '${ALIAS_FIX_LIVE_HOLDER_REASON}'`,
      );
    }
    if (refusal.neverRepoints !== true) {
      errors.push("ownershipProtocol.liveHolderRefusal.neverRepoints must be true");
    }
    if (!isNonEmptyString(refusal.namesHolder)) {
      errors.push(
        "ownershipProtocol.liveHolderRefusal.namesHolder must describe pid/startIdentity/realHome/aliasPath",
      );
    }
  }

  if (!isNonEmptyString(value.staleTakeoverRule)) {
    errors.push("ownershipProtocol.staleTakeoverRule must be a non-empty string");
  }
  if (!isNonEmptyString(value.legacyHMigration)) {
    errors.push("ownershipProtocol.legacyHMigration must be a non-empty string");
  }
  if (!isNonEmptyString(value.otherKeysUntouched)) {
    errors.push("ownershipProtocol.otherKeysUntouched must be a non-empty string");
  }
}

/**
 * Validate an already-parsed ALIAS-FIX contract value. Returns a list of
 * human-readable problems; an empty list means the contract is complete.
 */
export function validateAliasFixContract(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["contract must be a JSON object"];
  }
  if (!isNonEmptyString(value.schema) || !value.schema.startsWith(ALIAS_FIX_CONTRACT_SCHEMA_PREFIX)) {
    errors.push(`schema must be a string starting with '${ALIAS_FIX_CONTRACT_SCHEMA_PREFIX}'`);
  }

  validatePathLengthProof(value.pathLengthProof, errors);
  validateOwnershipProtocol(value.ownershipProtocol, errors);

  if (!Array.isArray(value.fastGates) || value.fastGates.length === 0) {
    errors.push("fastGates must be a non-empty array");
    return errors;
  }
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

  if (value.realGates !== undefined) {
    if (!Array.isArray(value.realGates)) {
      errors.push("realGates must be an array when present");
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
    }
  }

  return errors;
}

/** Minimal contract shape that validateAliasFixContract must accept. */
function buildMinimalValidContract(): Record<string, unknown> {
  return {
    schema: "alias-fix-contract/1",
    pathLengthProof: {
      linuxLimit: 107,
      macosLimit: 103,
      socketPathAddedBytes: 43,
      keyHexChars: 8,
      extraSegmentBytes: 9,
      keyedDefaultAlias: {
        aliasPath: "/x/tamandua/1000/00000000/h",
        longestSocketBytes: 78,
        underLinuxLimit: true,
        underMacosLimit: true,
      },
      longHome: {
        realHomeBytes: 90,
        realHomeLongestSocketBytes: 133,
        aliasLongestSocketBytes: 78,
        underLinuxLimit: true,
        underMacosLimit: true,
      },
    },
    ownershipProtocol: {
      keyDerivation: "sha256(realHome)[0..8]",
      ownerSchema: "tamandua.matchlock.home-alias-owner.v1",
      ownerPath: "<aliasDir>/owner.json",
      ownerMode: 0o600,
      ownerFields: [...ALIAS_FIX_OWNER_FIELDS],
      liveHolderRefusal: {
        reason: ALIAS_FIX_LIVE_HOLDER_REASON,
        neverRepoints: true,
        namesHolder: "names pid, startIdentity, realHome and aliasPath",
      },
      staleTakeoverRule: "compare start identities; a different owner is dead and is taken over",
      legacyHMigration: "legacy h symlinks are ignored and never deleted",
      otherKeysUntouched: "a daemon only touches its own key",
    },
    fastGates: [
      { gate: "build", command: "npm run build", logPath: "/x/build.log", exitCode: 0 },
      { gate: "alias-units", command: "node --test ...", logPath: "/x/alias.log", exitCode: 0 },
    ],
  };
}

/** Minimal realGates entry that validateAliasFixContract must accept. */
function buildMinimalValidRealGate(): Record<string, unknown> {
  return {
    gate: "synthetic",
    driver: "run-matchlock-synthetic-e2e-test",
    evidenceDir: "/x/evidence/pi-exec-000000",
    logPath: "/x/logs/gate-synthetic.log",
    exitCode: 0,
    observed_rounds: 7,
    observed_vm_ids: ["vm-12c3129b"],
  };
}

const contractPath =
  process.env.ALIAS_FIX_CONTRACT_PATH ?? "/home/kaladin/matchlock-work/alias-fix-contract.json";

describe("ALIAS-FIX contract validator (US-007)", () => {
  it("accepts a complete minimal contract", () => {
    assert.deepEqual(validateAliasFixContract(buildMinimalValidContract()), []);
  });

  it("reports a wrong schema prefix", () => {
    const contract = buildMinimalValidContract();
    contract.schema = "something-else/1";
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("schema must be a string starting with")),
      `expected a schema error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a missing macOS limit", () => {
    const contract = buildMinimalValidContract();
    delete (contract.pathLengthProof as Record<string, unknown>).macosLimit;
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("pathLengthProof.macosLimit must be 103")),
      `expected a macOS-limit error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a keyed default alias that is not under the limits", () => {
    const contract = buildMinimalValidContract();
    (
      (contract.pathLengthProof as Record<string, unknown>).keyedDefaultAlias as Record<
        string,
        unknown
      >
    ).longestSocketBytes = 120;
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("must be under the Linux 107-byte limit")),
      `expected an over-limit error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports an ownership protocol missing the stale-takeover rule", () => {
    const contract = buildMinimalValidContract();
    delete (contract.ownershipProtocol as Record<string, unknown>).staleTakeoverRule;
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("staleTakeoverRule must be a non-empty string")),
      `expected a stale-takeover error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports an owner sidecar schema missing a required field", () => {
    const contract = buildMinimalValidContract();
    (contract.ownershipProtocol as Record<string, unknown>).ownerFields = ["pid", "realHome"];
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("ownerFields missing 'startIdentity'")),
      `expected an owner-field error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a live-holder refusal with the wrong reason", () => {
    const contract = buildMinimalValidContract();
    (
      (contract.ownershipProtocol as Record<string, unknown>).liveHolderRefusal as Record<
        string,
        unknown
      >
    ).reason = "whatever";
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) =>
        error.includes(`liveHolderRefusal.reason must be '${ALIAS_FIX_LIVE_HOLDER_REASON}'`),
      ),
      `expected a refusal-reason error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a fast gate missing command/log/exit fields", () => {
    const contract = buildMinimalValidContract();
    (contract.fastGates as Array<Record<string, unknown>>)[0] = { gate: "build", command: "npm run build" };
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("fastGates[0] missing logPath")),
      `expected a gate error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("fastGates[0] missing exitCode")),
      `expected an exitCode gate error, got ${JSON.stringify(errors)}`,
    );
  });

  it("accepts a complete minimal contract carrying a realGates battery entry", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [buildMinimalValidRealGate()];
    assert.deepEqual(validateAliasFixContract(contract), []);
  });

  it("reports a real gate with zero observed rounds (a hollow green)", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [{ ...buildMinimalValidRealGate(), observed_rounds: 0 }];
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("realGates[0].observed_rounds must be a positive integer")),
      `expected a zero-round error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a real gate whose observed VM ids are not owned vm-<8hex> ids", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [{ ...buildMinimalValidRealGate(), observed_vm_ids: ["vm-NOTHEX", "1234"] }];
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("realGates[0].observed_vm_ids[0] must match vm-<8 lowercase hex>")),
      `expected a VM-id error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("realGates[0].observed_vm_ids[1] must match vm-<8 lowercase hex>")),
      `expected a second VM-id error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a real gate with no observed VM ids", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [{ ...buildMinimalValidRealGate(), observed_vm_ids: [] }];
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("observed_vm_ids must record at least one owned VM id")),
      `expected an empty-VM-id error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a real gate missing its evidence metadata", () => {
    const contract = buildMinimalValidContract();
    const gate = buildMinimalValidRealGate();
    delete gate.evidenceDir;
    delete gate.logPath;
    contract.realGates = [gate];
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) => error.includes("realGates[0] missing evidenceDir")),
      `expected a missing-evidenceDir error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("realGates[0] missing logPath")),
      `expected a missing-logPath error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a real gate with a non-zero exit and no authorized deviation", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [{ ...buildMinimalValidRealGate(), exitCode: 1 }];
    const errors = validateAliasFixContract(contract);
    assert.ok(
      errors.some((error) =>
        error.includes("realGates[0].exitCode must be 0 unless an explicit authorized deviation is attached"),
      ),
      `expected a non-zero-exit error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a real gate whose authorized deviation is incomplete or unauthorized", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [
      {
        ...buildMinimalValidRealGate(),
        exitCode: 1,
        deviation: { item: "x", authorized: false, signature: "sig" },
      },
    ];
    const errors = validateAliasFixContract(contract);
    for (const expected of [
      "realGates[0].deviation.reason must be a non-empty string",
      "realGates[0].deviation.documentedIn must be a non-empty string",
      "realGates[0].deviation.evidencePath must be a non-empty string",
      "realGates[0].deviation.authorized must be true",
    ]) {
      assert.ok(
        errors.some((error) => error.includes(expected)),
        `expected '${expected}' in ${JSON.stringify(errors)}`,
      );
    }
  });

  it("accepts a real gate with a non-zero exit and a complete authorized deviation", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [
      {
        ...buildMinimalValidRealGate(),
        exitCode: 1,
        deviation: {
          item: "documented blocked item",
          reason: "environment-side block",
          signature: ALIAS_FIX_DSH_DEVIATION_SIGNATURE,
          documentedIn: "docs/example.md section 4",
          evidencePath: "/x/evidence/deviation.json",
          authorized: true,
        },
      },
    ];
    assert.deepEqual(validateAliasFixContract(contract), []);
  });

  it("accepts a green real gate that explicitly discloses a deferred item", () => {
    const contract = buildMinimalValidContract();
    contract.realGates = [
      {
        ...buildMinimalValidRealGate(),
        deviation: {
          item: "NONSTANDARD image PATH",
          reason: "documented guest-agent block",
          signature: ALIAS_FIX_DSH_DEVIATION_SIGNATURE,
          documentedIn: "docs/matchlock-dsh-qualification.md section 4",
          evidencePath: "/x/evidence/deviation.json",
          authorized: true,
        },
      },
    ];
    assert.deepEqual(validateAliasFixContract(contract), []);
  });

  it("validates an optional deferredItems disclosure on a real gate", () => {
    const valid = buildMinimalValidContract();
    valid.realGates = [
      {
        ...buildMinimalValidRealGate(),
        deferredItems: [
          {
            item: "NONSTANDARD image PATH",
            reason: "documented guest-agent block",
            signature: ALIAS_FIX_DSH_DEVIATION_SIGNATURE,
            documentedIn: "docs/matchlock-dsh-qualification.md section 4",
            evidencePath: "/x/evidence/deviation.json",
            authorized: true,
          },
        ],
      },
    ];
    assert.deepEqual(validateAliasFixContract(valid), []);

    const invalid = buildMinimalValidContract();
    invalid.realGates = [
      {
        ...buildMinimalValidRealGate(),
        deferredItems: [{ item: "x", authorized: false }],
      },
    ];
    const errors = validateAliasFixContract(invalid);
    assert.ok(
      errors.some((error) => error.includes("realGates[0].deferredItems[0].signature must be a non-empty string")),
      `expected a deferredItems signature error, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => error.includes("realGates[0].deferredItems[0].authorized must be true")),
      `expected a deferredItems authorization error, got ${JSON.stringify(errors)}`,
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
      assert.deepEqual(validateAliasFixContract(parsed), []);

      // When a realGates battery has been recorded, it must cover every
      // US-008 real-VM gate with a positive observed-round count. An empty or
      // absent realGates stays valid (the pre-US-008 deliverable), so the
      // committed suite never fails merely because no battery ran on the host.
      const realGates = isRecord(parsed) ? parsed.realGates : undefined;
      if (Array.isArray(realGates) && realGates.length > 0) {
        const labels = new Set(
          realGates
            .filter(isRecord)
            .map((gate) => gate.gate)
            .filter(isNonEmptyString),
        );
        for (const label of ALIAS_FIX_REAL_GATE_LABELS) {
          assert.ok(labels.has(label), `published realGates is missing the US-008 gate '${label}'`);
        }

        // The repository's own qualification doc records the NONSTANDARD image
        // PATH guest re-exec block as "must not be read as green". The published
        // dsh gate therefore may not hide it: when the battery is recorded, the
        // dsh entry must disclose the exact documented signature as an explicit
        // authorized deviation or deferred item (never a silent green), and a
        // non-zero dsh exit additionally requires a complete authorized
        // deviation (enforced generically by validateAliasFixContract above).
        const dshGate = realGates.filter(isRecord).find((gate) => gate.gate === "dsh");
        if (dshGate) {
          const disclosures: Array<Record<string, unknown>> = [];
          if (isRecord(dshGate.deviation)) disclosures.push(dshGate.deviation);
          if (Array.isArray(dshGate.deferredItems)) {
            for (const item of dshGate.deferredItems) {
              if (isRecord(item)) disclosures.push(item);
            }
          }
          assert.ok(
            disclosures.some(
              (item) =>
                item.authorized === true && item.signature === ALIAS_FIX_DSH_DEVIATION_SIGNATURE,
            ),
            "published dsh realGates entry must disclose the documented NONSTANDARD image PATH guest-agent re-exec signature as an authorized deviation/deferred item",
          );
        }
      }
    },
  );
});
