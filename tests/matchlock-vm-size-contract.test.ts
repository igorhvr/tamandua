/**
 * MTLK-VM-SIZE US-007 (bead tamandua-6sy.33.10.41) — deliverable regression for
 * the published MTLK-VM-SIZE contract file.
 *
 * The run deliverable `/home/kaladin/matchlock-work/matchlock-vm-size-contract.json`
 * lives OUTSIDE the repository on purpose (it is never committed). This file
 * carries the validator the story's acceptance criterion 5 asks for:
 * `validateMatchlockVmSizeContract(value, options?): string[]` parses the
 * contract as JSON and asserts it records the `--matchlock-*` size flags
 * (including the MTLK-ISO-SLICE1 `--matchlock-swap` row) and their syntax, the
 * `TAMANDUA_MATCHLOCK_*` env defaults (including `TAMANDUA_MATCHLOCK_SWAP_MB`),
 * the built-in defaults
 * (min(8, host CPUs) / min(16384 MB, 50% host RAM) / 20480 MB / swap 8192 MB),
 * the caps (16
 * vCPUs ALWAYS and host online CPUs; 75% host MemTotal; disk finite positive;
 * the 65536 MB matchlock swap cap), the explicit-flag/env clamping semantics,
 * the persisted policy field
 * (`ExecutionIsolation.resourceLimits`, policy version 3 after the coordinated
 * SHARED-V3 bump), the new opt-in `requires` wording, the launch
 * line and the workflow-status display, and the one-VM gate commands/exits
 * with the in-guest `nproc=4` / `MemTotal` evidence plus positive VM removal.
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

export const MTLK_VM_SIZE_FLAGS = [
  "--matchlock-cpus",
  "--matchlock-memory",
  "--matchlock-disk",
  "--matchlock-swap",
] as const;

/** The pre-MTLK-ISO-SLICE1 flag set (no swap row). */
export const MTLK_VM_SIZE_LEGACY_FLAGS = [
  "--matchlock-cpus",
  "--matchlock-memory",
  "--matchlock-disk",
] as const;

export const MTLK_VM_SIZE_ENV_VARS = [
  "TAMANDUA_MATCHLOCK_CPUS",
  "TAMANDUA_MATCHLOCK_MEMORY_MB",
  "TAMANDUA_MATCHLOCK_DISK_MB",
] as const;

/** The swap env default MTLK-ISO-SLICE1 adds to every v3 contract. */
export const MTLK_VM_SIZE_SWAP_ENV = "TAMANDUA_MATCHLOCK_SWAP_MB";

export const MTLK_VM_SIZE_POLICY_FIELD = "ExecutionIsolation.resourceLimits";
export const MTLK_VM_SIZE_POLICY_VERSION = 3;
/** The pre-MTLK-ISO-SLICE1 policy version (swap-off v2 records). */
export const MTLK_VM_SIZE_LEGACY_POLICY_VERSION = 2;
/** The MTLK-ISO-SLICE1 opt-in grammar every `requires` field must carry. */
export const MTLK_VM_SIZE_REQUIRES = "--matchlock or --matchlock-image <image>";
/** The retired opt-in grammar still read from a not-yet-refreshed host copy. */
export const MTLK_VM_SIZE_LEGACY_REQUIRES = "--matchlock <image>";
export const MTLK_VM_SIZE_LAUNCH_LINE =
  "matchlock: <image> cpus=<n> memory=<MB>MB disk=<MB>MB swap=<n>MB|off";
/**
 * The pre-MTLK-ISO-SLICE2 launch line (no swap segment). The tracked host copy
 * keeps it until the coordinator refreshes the contract after slice 3, so
 * legacyPreRefresh accepts it while a refreshed (v3) copy must carry the
 * combined swap grammar above.
 */
export const MTLK_VM_SIZE_LEGACY_LAUNCH_LINE =
  "matchlock: <image> cpus=<n> memory=<MB>MB disk=<MB>MB";

/**
 * Validate a tracked host contract. The committed validator is strict
 * (MTLK-ISO-SLICE1 policy version 3 + the swap row + the new opt-in grammar).
 * `legacyPreRefresh` validates the pre-refresh shape the coordinator has not
 * yet replaced; the real-file assertion opts into it only while the host copy
 * still records policy version 2 (it never weakens the pure validator tests).
 */
export interface MatchlockVmSizeContractOptions {
  legacyPreRefresh?: boolean;
}

/** The exact gate VM size (cpus=4 / 4096 MB / 20480 MB). */
export const MTLK_VM_SIZE_GATE_LIMITS = {
  cpus: 4,
  memory_mb: 4096,
  disk_size_mb: 20480,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function includesAll(haystack: string, needles: readonly string[]): boolean {
  return needles.every((needle) => haystack.includes(needle));
}

/**
 * Validate an already-parsed MTLK-VM-SIZE contract value. Returns a list of
 * human-readable problems; an empty list means the contract is complete.
 */
export function validateMatchlockVmSizeContract(
  value: unknown,
  options: MatchlockVmSizeContractOptions = {},
): string[] {
  const legacy = options.legacyPreRefresh === true;
  const expectedPolicyVersion = legacy
    ? MTLK_VM_SIZE_LEGACY_POLICY_VERSION
    : MTLK_VM_SIZE_POLICY_VERSION;
  const requiredFlags = legacy ? MTLK_VM_SIZE_LEGACY_FLAGS : MTLK_VM_SIZE_FLAGS;
  const requiredEnvVars = legacy
    ? MTLK_VM_SIZE_ENV_VARS
    : ([...MTLK_VM_SIZE_ENV_VARS, MTLK_VM_SIZE_SWAP_ENV] as const);
  const expectedRequires = legacy ? MTLK_VM_SIZE_LEGACY_REQUIRES : MTLK_VM_SIZE_REQUIRES;
  const expectedLaunchLine = legacy
    ? MTLK_VM_SIZE_LEGACY_LAUNCH_LINE
    : MTLK_VM_SIZE_LAUNCH_LINE;

  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["contract must be a JSON object"];
  }
  if (value.contract !== "MTLK-VM-SIZE") {
    errors.push("contract must be 'MTLK-VM-SIZE'");
  }

  // ── flags: one entry per --matchlock-* size flag with its syntax/caps ────
  if (!Array.isArray(value.flags)) {
    errors.push("flags must be an array");
  } else {
    const seen = new Set<string>();
    for (const [index, rawFlag] of value.flags.entries()) {
      if (!isRecord(rawFlag)) {
        errors.push(`flags[${index}] must be an object`);
        continue;
      }
      const flag = rawFlag.flag;
      if (!isNonEmptyString(flag)) {
        errors.push(`flags[${index}].flag must be a non-empty string`);
        continue;
      }
      if (seen.has(flag)) {
        errors.push(`duplicate flag '${flag}'`);
      }
      seen.add(flag);
      for (const field of ["syntax", "builtInDefault", "requires"] as const) {
        if (!isNonEmptyString(rawFlag[field])) {
          errors.push(`flag '${flag}'.${field} must be a non-empty string`);
        }
      }
      if (isNonEmptyString(rawFlag.requires) && rawFlag.requires !== expectedRequires) {
        errors.push(`flag '${flag}'.requires must be '${expectedRequires}'`);
      }
      if (!Array.isArray(rawFlag.caps) || rawFlag.caps.length === 0) {
        errors.push(`flag '${flag}'.caps must be a non-empty array`);
      } else if (!rawFlag.caps.every((cap) => isNonEmptyString(cap))) {
        errors.push(`flag '${flag}'.caps entries must be non-empty strings`);
      }
    }
    for (const required of requiredFlags) {
      if (!seen.has(required)) {
        errors.push(`missing flag '${required}'`);
      }
    }
  }

  // ── env defaults: one operator env var per field ────────────────────────
  if (!isRecord(value.envDefaults)) {
    errors.push("envDefaults must be an object");
  } else {
    for (const envVar of requiredEnvVars) {
      if (!isNonEmptyString(value.envDefaults[envVar])) {
        errors.push(`envDefaults.${envVar} must be a non-empty string`);
      }
    }
  }

  // ── built-in defaults: min(8, host CPUs) / min(16384, 50% host) / 20480 ──
  if (!isRecord(value.builtInDefaults)) {
    errors.push("builtInDefaults must be an object");
  } else {
    const d = value.builtInDefaults;
    const cpus = d.cpus;
    const memory = d.memory;
    const disk = d.disk;
    if (!isNonEmptyString(cpus) || !includesAll(cpus, ["min(8", "host"])) {
      errors.push("builtInDefaults.cpus must record min(8, host CPUs)");
    }
    if (!isNonEmptyString(memory) || !includesAll(memory, ["16384", "50%"])) {
      errors.push("builtInDefaults.memory must record min(16384 MB, 50% host)");
    }
    if (!isNonEmptyString(disk) || !disk.includes("20480")) {
      errors.push("builtInDefaults.disk must record 20480 MB");
    }
    if (!legacy) {
      const swap = d.swap;
      if (!isNonEmptyString(swap) || !swap.includes("8192")) {
        errors.push("builtInDefaults.swap must record 8192 MB");
      }
    }
  }

  // ── caps: 16 vCPUs always, host CPUs, 75% MemTotal, finite-positive disk ─
  if (!isRecord(value.caps)) {
    errors.push("caps must be an object");
  } else {
    const c = value.caps;
    if (!isNonEmptyString(c.cpus) || !includesAll(c.cpus, ["16", "host"])) {
      errors.push("caps.cpus must record the 16-vCPU ALWAYS and host-CPU caps");
    }
    if (!isNonEmptyString(c.memory) || !c.memory.includes("75%")) {
      errors.push("caps.memory must record the 75%-of-host-MemTotal cap");
    }
    if (!isNonEmptyString(c.disk) || !/finite positive/i.test(c.disk)) {
      errors.push("caps.disk must record the finite-positive disk cap");
    }
  }

  // ── clamping semantics: flag beats env, both are clamped ────────────────
  if (!isNonEmptyString(value.clamping)) {
    errors.push("clamping must be a non-empty string");
  } else if (!includesAll(value.clamping, ["flag", "env", "clamp"])) {
    errors.push("clamping must state that explicit flag AND env values are clamped (flag wins)");
  }

  // ── persisted policy field + version ────────────────────────────────────
  if (!isRecord(value.policy)) {
    errors.push("policy must be an object");
  } else {
    if (value.policy.field !== MTLK_VM_SIZE_POLICY_FIELD) {
      errors.push(`policy.field must be '${MTLK_VM_SIZE_POLICY_FIELD}'`);
    }
    if (value.policy.version !== expectedPolicyVersion) {
      errors.push(`policy.version must stay ${expectedPolicyVersion}`);
    }
  }

  // ── launch line + workflow status display ───────────────────────────────
  if (value.launchLine !== expectedLaunchLine) {
    errors.push(`launchLine must be '${expectedLaunchLine}'`);
  }
  if (!isNonEmptyString(value.statusDisplay)) {
    errors.push("statusDisplay must be a non-empty string");
  } else if (!includesAll(value.statusDisplay, ["workflow status", "matchlock:"])) {
    errors.push("statusDisplay must record that 'workflow status' shows the matchlock: line");
  }

  // ── gate commands/exits with in-guest evidence ──────────────────────────
  if (!isRecord(value.gate)) {
    errors.push("gate must be an object");
    return errors;
  }
  const gate = value.gate;
  if (!isNonEmptyString(gate.command) || !includesAll(gate.command, ["flock", "run-matchlock-vm-size-gate-e2e-test"])) {
    errors.push("gate.command must be the flock-wrapped ./run-matchlock-vm-size-gate-e2e-test invocation");
  }
  if (gate.exitCode !== 0) {
    errors.push("gate.exitCode must be 0 (the one-VM gate must pass)");
  }
  if (!isNonEmptyString(gate.evidenceDir)) {
    errors.push("gate.evidenceDir must be a non-empty string");
  }
  if (!isNonEmptyString(gate.logPath)) {
    errors.push("gate.logPath must be a non-empty string");
  }

  if (!isRecord(gate.createResources)) {
    errors.push("gate.createResources must be an object");
  } else {
    for (const [field, expected] of Object.entries(MTLK_VM_SIZE_GATE_LIMITS)) {
      if (gate.createResources[field] !== expected) {
        errors.push(`gate.createResources.${field} must be ${expected}`);
      }
    }
  }

  if (!isNonEmptyString(gate.vmId) || !/^vm-[0-9a-f]{8}$/.test(gate.vmId)) {
    errors.push("gate.vmId must be a matchlock VM id (vm-<8 hex>)");
  }
  if (gate.vmRemoved !== true) {
    errors.push("gate.vmRemoved must be true (the gate VM was positively removed)");
  }
  if (gate.noOwnedVmsRemain !== true) {
    errors.push("gate.noOwnedVmsRemain must be true (no owned VM from the gate remains)");
  }

  // ── in-guest nproc / MemTotal evidence ──────────────────────────────────
  if (gate.guestNproc !== 4) {
    errors.push("gate.guestNproc must be 4");
  }
  if (!isNonEmptyString(gate.guestNprocLine)) {
    errors.push("gate.guestNprocLine must be a non-empty string");
  }
  if (!isNonEmptyString(gate.guestMemTotalLine) || !/MemTotal:\s+\d+\s+kB/.test(gate.guestMemTotalLine)) {
    errors.push("gate.guestMemTotalLine must be a guest /proc/meminfo MemTotal line");
  }
  const memTotalKiB = gate.guestMemTotalKiB;
  if (typeof memTotalKiB !== "number" || !Number.isFinite(memTotalKiB)) {
    errors.push("gate.guestMemTotalKiB must be a number");
  } else if (
    memTotalKiB * 1024 <= 3.5 * 1024 ** 3 ||
    memTotalKiB * 1024 > 4.2 * 1024 ** 3
  ) {
    errors.push(
      `gate.guestMemTotalKiB must be consistent with 4096 MB (got ${memTotalKiB} kB)`,
    );
  }

  return errors;
}

/** Minimal contract shape that validateMatchlockVmSizeContract must accept. */
function buildMinimalValidContract(): Record<string, unknown> {
  return {
    contract: "MTLK-VM-SIZE",
    flags: [
      {
        flag: "--matchlock-cpus",
        syntax: "--matchlock-cpus <n>",
        builtInDefault: "min(8, host online CPUs)",
        caps: ["<= 16 ALWAYS", "<= host online CPUs"],
        requires: MTLK_VM_SIZE_REQUIRES,
      },
      {
        flag: "--matchlock-memory",
        syntax: "--matchlock-memory <MB|Ng>",
        builtInDefault: "min(16384 MB, 50% of host MemTotal)",
        caps: ["<= 75% of host MemTotal"],
        requires: MTLK_VM_SIZE_REQUIRES,
      },
      {
        flag: "--matchlock-disk",
        syntax: "--matchlock-disk <MB|Ng>",
        builtInDefault: "20480 MB",
        caps: ["finite positive"],
        requires: MTLK_VM_SIZE_REQUIRES,
      },
      {
        flag: "--matchlock-swap",
        syntax: "--matchlock-swap <MB|Ng>",
        builtInDefault: "8192 MB",
        caps: ["<= 65536 MB (matchlock cap)", "0 rejected; use --matchlock-no-swap"],
        requires: MTLK_VM_SIZE_REQUIRES,
      },
    ],
    envDefaults: {
      TAMANDUA_MATCHLOCK_CPUS: "cpus when --matchlock-cpus is absent",
      TAMANDUA_MATCHLOCK_MEMORY_MB: "memory when --matchlock-memory is absent",
      TAMANDUA_MATCHLOCK_DISK_MB: "disk when --matchlock-disk is absent",
      TAMANDUA_MATCHLOCK_SWAP_MB: "swap when --matchlock-swap is absent (a size or off)",
    },
    builtInDefaults: {
      cpus: "min(8, host online CPUs)",
      memory: "min(16384 MB, 50% of host MemTotal)",
      disk: "20480 MB",
      swap: "8192 MB",
    },
    caps: {
      cpus: "min(value, 16 ALWAYS, host online CPUs)",
      memory: "min(value, 75% of host MemTotal)",
      disk: "finite positive",
      swap: "min(value, 65536 MB matchlock cap); no host-derived clamp",
    },
    clamping: "flag > env > built-in default; explicit flag and env values are clamped",
    policy: { field: MTLK_VM_SIZE_POLICY_FIELD, version: MTLK_VM_SIZE_POLICY_VERSION },
    launchLine: MTLK_VM_SIZE_LAUNCH_LINE,
    statusDisplay: "tamandua workflow status prints the matchlock: line",
    gate: {
      command:
        "flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock ./run-matchlock-vm-size-gate-e2e-test",
      exitCode: 0,
      evidenceDir: "/home/kaladin/matchlock-work/evidence/vm-size-XXXXXX",
      logPath: "/home/kaladin/matchlock-work/evidence/vm-size-XXXXXX/gate-run.log",
      createResources: { ...MTLK_VM_SIZE_GATE_LIMITS },
      vmId: "vm-12345678",
      vmRemoved: true,
      noOwnedVmsRemain: true,
      guestNproc: 4,
      guestNprocLine: "4",
      guestMemTotalLine: "MemTotal:        3985944 kB",
      guestMemTotalKiB: 3985944,
    },
  };
}

const contractPath =
  process.env.MATCHLOCK_VM_SIZE_CONTRACT_PATH ??
  "/home/kaladin/matchlock-work/matchlock-vm-size-contract.json";

describe("MTLK-VM-SIZE contract validator (US-007)", () => {
  it("accepts a complete minimal contract", () => {
    assert.deepEqual(validateMatchlockVmSizeContract(buildMinimalValidContract()), []);
  });

  it("reports a missing swap flag row", () => {
    const contract = buildMinimalValidContract();
    (contract.flags as unknown[]).pop();
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes("missing flag '--matchlock-swap'")),
      `expected a missing-flag error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a retired --matchlock <image> requires wording", () => {
    const contract = buildMinimalValidContract();
    (contract.flags as Array<Record<string, unknown>>)[0].requires = MTLK_VM_SIZE_LEGACY_REQUIRES;
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) =>
        error.includes(`flag '--matchlock-cpus'.requires must be '${MTLK_VM_SIZE_REQUIRES}'`),
      ),
      `expected a requires-wording error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a missing env default", () => {
    const contract = buildMinimalValidContract();
    delete (contract.envDefaults as Record<string, unknown>).TAMANDUA_MATCHLOCK_CPUS;
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes("envDefaults.TAMANDUA_MATCHLOCK_CPUS")),
      `expected a missing-env error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a missing swap env default", () => {
    const contract = buildMinimalValidContract();
    delete (contract.envDefaults as Record<string, unknown>)[MTLK_VM_SIZE_SWAP_ENV];
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes(`envDefaults.${MTLK_VM_SIZE_SWAP_ENV}`)),
      `expected a missing-swap-env error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a policy version bump (v3 is the only accepted new version)", () => {
    const contract = buildMinimalValidContract();
    (contract.policy as Record<string, unknown>).version = 4;
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes("policy.version must stay 3")),
      `expected a policy-version error, got ${JSON.stringify(errors)}`,
    );
  });

  it("legacyPreRefresh accepts the pre-refresh v2 host shape (no swap row)", () => {
    const contract = buildMinimalValidContract();
    contract.flags = (contract.flags as Array<Record<string, unknown>>).filter(
      (flag) => flag.flag !== "--matchlock-swap",
    );
    for (const flag of contract.flags as Array<Record<string, unknown>>) {
      flag.requires = MTLK_VM_SIZE_LEGACY_REQUIRES;
    }
    delete (contract.envDefaults as Record<string, unknown>)[MTLK_VM_SIZE_SWAP_ENV];
    delete (contract.builtInDefaults as Record<string, unknown>).swap;
    delete (contract.caps as Record<string, unknown>).swap;
    (contract.policy as Record<string, unknown>).version = MTLK_VM_SIZE_LEGACY_POLICY_VERSION;
    contract.launchLine = MTLK_VM_SIZE_LEGACY_LAUNCH_LINE;
    assert.deepEqual(validateMatchlockVmSizeContract(contract, { legacyPreRefresh: true }), []);
    // The strict validator still refuses that same pre-refresh shape.
    assert.notDeepEqual(validateMatchlockVmSizeContract(contract), []);
  });

  it("reports a launch line that predates the combined swap grammar", () => {
    const contract = buildMinimalValidContract();
    contract.launchLine = MTLK_VM_SIZE_LEGACY_LAUNCH_LINE;
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes(`launchLine must be '${MTLK_VM_SIZE_LAUNCH_LINE}'`)),
      `expected a launchLine error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports create resources that do not carry cpus=4/memory_mb=4096", () => {
    const contract = buildMinimalValidContract();
    (contract.gate as Record<string, unknown>).createResources = {
      cpus: 2,
      memory_mb: 2048,
      disk_size_mb: 20480,
    };
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes("gate.createResources.cpus must be 4")),
      `expected a create-resources error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports guest nproc evidence that is not 4", () => {
    const contract = buildMinimalValidContract();
    (contract.gate as Record<string, unknown>).guestNproc = 2;
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes("gate.guestNproc must be 4")),
      `expected a guest-nproc error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a guest MemTotal inconsistent with 4096 MB", () => {
    const contract = buildMinimalValidContract();
    (contract.gate as Record<string, unknown>).guestMemTotalKiB = 2048 * 1024;
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes("consistent with 4096 MB")),
      `expected a MemTotal error, got ${JSON.stringify(errors)}`,
    );
  });

  it("reports a VM that was not confirmed removed", () => {
    const contract = buildMinimalValidContract();
    (contract.gate as Record<string, unknown>).vmRemoved = false;
    const errors = validateMatchlockVmSizeContract(contract);
    assert.ok(
      errors.some((error) => error.includes("gate.vmRemoved must be true")),
      `expected a vmRemoved error, got ${JSON.stringify(errors)}`,
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
      // The tracked host copy is refreshed by the coordinator AFTER this slice
      // lands. Until that refresh it still records the pre-MTLK-ISO-SLICE1
      // shape (policy version 2, no swap row, the retired requires wording), so
      // validate it in legacy mode while it is stale. A refreshed copy takes
      // the strict (v3 + swap) path.
      const storedVersion = isRecord(parsed) && isRecord(parsed.policy)
        ? parsed.policy.version
        : undefined;
      const legacyPreRefresh = storedVersion === MTLK_VM_SIZE_LEGACY_POLICY_VERSION;
      assert.deepEqual(validateMatchlockVmSizeContract(parsed, { legacyPreRefresh }), []);
    },
  );
});
