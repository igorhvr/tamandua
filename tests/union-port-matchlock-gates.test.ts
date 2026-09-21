/**
 * UNION-PORT US-011 (+ US-012) — deliverable validator for the real-VM
 * Matchlock gate evidence.
 *
 * The run deliverable
 * `/home/kaladin/matchlock-work/union-port-matchlock-gates.json`
 * lives OUTSIDE the repository on purpose (it is host state and VM evidence,
 * never committed, never placed in the worktree). This file carries the
 * validator the story asks for: a pure
 * `validateUnionPortMatchlockGates(value): string[]` plus always-on unit tests
 * covering the structural contract, and a real-file assertion that defaults to
 * the canonical deliverable path (overridable with
 * `UNION_PORT_MATCHLOCK_GATES_PATH`) and is skipped when that file is absent —
 * so the committed suite never hard-depends on host state.
 *
 * Rules enforced here:
 *   - the evidence is keyed by gate label and every entry records
 *     {name, command, exit, observedRounds, observedVmIds, evidenceDir,
 *      observedRoundsPath, gateRunLog, startedAt, endedAt} exactly as the
 *     story requires;
 *   - every gate exited 0 and observed observedRounds > 0 (the no-fake-green
 *     rule: a gate whose VM creation failed never counts as passing);
 *   - every observed VM id is a real `vm-<8 lowercase hex>` id and every gate
 *     positively closed its VMs (vmClosed true);
 *   - the whole family ran the SYSTEM matchlock resolved from PATH, never a
 *     pinned private runtime (buildIdentity.pinned === false and
 *     matchlockPath under the system prefix);
 *   - the lifecycle section records the before/after VM sets and the kill
 *     trace records either "none observed" or the observed sender.
 *
 * The real-file assertion additionally cross-checks each gate's retained
 * `observed-rounds.json`: its `gate` label must match the entry key and its
 * `observed_rounds` must equal the recorded count. That is what makes the
 * count impossible to fabricate.
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

/** Repo root, so a recorded runner can be proven to exist on disk. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The external deliverable published by US-011/US-012 (overridable for tests). */
export const DEFAULT_UNION_PORT_MATCHLOCK_GATES_PATH =
  "/home/kaladin/matchlock-work/union-port-matchlock-gates.json";

/** The canonical shared gate lock every real-VM gate runs under. */
export const UNION_PORT_GATE_LOCK = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/** The SYSTEM matchlock prefix: unpinned, resolved through PATH. */
export const SYSTEM_MATCHLOCK_PREFIX = "/usr/local/bin";

/** Gate labels US-011 must publish (the first half of the real-VM family). */
export const UNION_PORT_MATCHLOCK_BATCH_1_GATES = [
  "synthetic",
  "hermes-synthetic",
  "empty-output",
  "long-home",
] as const;

/** Gate labels US-012 appends (the second half; validated when present). */
export const UNION_PORT_MATCHLOCK_BATCH_2_GATES = [
  "dsh",
  "dsh-profile-overlay",
  "dsh-real-boot",
  "worktree-merge",
] as const;

/**
 * gate label -> the real top-level runner that executed it. This is the
 * anti-fabrication check: a recorded `name`/`command` must be the runner that
 * actually exists in the repo root, never a string invented from the label
 * (e.g. `run-synthetic-e2e-test`, which is NOT a file). Kept in sync with the
 * on-disk runner family pinned by
 * `tests/matchlock-gate-observation-wiring.test.ts` and with the host
 * assembler `union-port-gates/assemble-us011-gates.py`.
 */
export const UNION_PORT_MATCHLOCK_GATE_RUNNERS: Record<string, string> = {
  synthetic: "run-matchlock-synthetic-e2e-test",
  "hermes-synthetic": "run-hermes-synthetic-e2e-test",
  dsh: "run-matchlock-dsh-gate-e2e-test",
  "dsh-profile-overlay": "run-matchlock-dsh-profile-overlay-e2e-test",
  "dsh-real-boot": "run-matchlock-dsh-real-boot-gate-e2e-test",
  "dsh-real": "run-matchlock-dsh-real-gate-e2e-test",
  "empty-output": "run-matchlock-empty-output-e2e-test",
  "long-home": "run-matchlock-long-home-e2e-test",
  "worktree-merge": "run-matchlock-worktree-merge-e2e-test",
};

/** Shape every real Matchlock/hermes gate runner has at the repo root. */
const RUNNER_NAME_RE = /^run-[A-Za-z0-9._-]+-e2e-test$/;

/** A real Matchlock VM id: `vm-` + 8 lowercase hex characters. */
const VM_ID_RE = /^vm-[0-9a-f]{8}$/;

const REQUIRED_ROOT_FIELDS = ["runId", "branch", "commit", "lock"] as const;

const REQUIRED_GATE_STRING_FIELDS = [
  "name",
  "command",
  "evidenceDir",
  "observedRoundsPath",
  "gateRunLog",
  "startedAt",
  "endedAt",
] as const;

/**
 * US-012 documented-blocker contract. A gate may be recorded red ONLY when it
 * carries this object. That keeps the no-fake-green rule honest: an
 * undocumented non-zero exit still fails validation, while a pre-existing,
 * runtime-blocked gate (the synthetic dsh gate's nonstandard-image-PATH
 * positive, documented in docs/matchlock-dsh-qualification.md §5) is recorded
 * truthfully with its classification/evidence/citation instead of being
 * massaged into a green.
 */
const REQUIRED_BLOCKED_STRING_FIELDS = [
  "reason",
  "classification",
  "evidence",
  "docsCitation",
] as const;

/** A documented blocked gate: non-zero exit + a full `blocked` object. */
export function isDocumentedBlockedGate(entry: Record<string, unknown>): boolean {
  if (entry.exit === 0) return false;
  const blocked = entry.blocked;
  if (!isPlainObject(blocked)) return false;
  if (blocked.preExisting !== true) return false;
  return REQUIRED_BLOCKED_STRING_FIELDS.every((key) => isNonEmptyString(blocked[key]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate the parsed union-port Matchlock gate evidence. Returns a list of
 * human-readable errors; an empty list means the evidence is structurally the
 * one the story requires. Pure — never touches the filesystem.
 */
export function validateUnionPortMatchlockGates(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ["matchlock-gates evidence must be a JSON object"];
  }

  for (const key of REQUIRED_ROOT_FIELDS) {
    if (!isNonEmptyString(value[key])) {
      errors.push(`'${key}' must be a non-empty string`);
    }
  }

  // ── runtime identity: SYSTEM, unpinned ────────────────────────────────
  const buildIdentity = value.buildIdentity;
  if (!isPlainObject(buildIdentity)) {
    errors.push("'buildIdentity' must be an object");
  } else {
    if (!isNonEmptyString(buildIdentity.matchlockPath)) {
      errors.push("buildIdentity.matchlockPath must be a non-empty string");
    } else if (!buildIdentity.matchlockPath.startsWith(`${SYSTEM_MATCHLOCK_PREFIX}/`)) {
      errors.push(
        `buildIdentity.matchlockPath must resolve under ${SYSTEM_MATCHLOCK_PREFIX}/ (got ${buildIdentity.matchlockPath})`,
      );
    }
    if (!isNonEmptyString(buildIdentity.matchlockVersion)) {
      errors.push("buildIdentity.matchlockVersion must be a non-empty string");
    }
    if (buildIdentity.pinned !== false) {
      errors.push("buildIdentity.pinned must be false (the SYSTEM runtime is unpinned)");
    }
  }

  // ── gates keyed by label ──────────────────────────────────────────────
  if (!isPlainObject(value.gates)) {
    errors.push("'gates' must be an object keyed by gate label");
    return errors;
  }
  const gates = value.gates;
  const labels = Object.keys(gates);
  if (labels.length === 0) {
    errors.push("'gates' must contain at least one gate");
  }

  for (const label of labels) {
    const entry = gates[label];
    if (!isPlainObject(entry)) {
      errors.push(`gates['${label}'] must be an object`);
      continue;
    }
    if (entry.label !== label) {
      errors.push(`gates['${label}'].label must equal '${label}'`);
    }
    for (const key of REQUIRED_GATE_STRING_FIELDS) {
      if (!isNonEmptyString(entry[key])) {
        errors.push(`gates['${label}'].${key} must be a non-empty string`);
      }
    }
    // The recorded runner must be real, not derived from the label: the
    // command's basename must equal `name`, and a known label must resolve to
    // its actual runner (invented names like run-synthetic-e2e-test fail).
    if (isNonEmptyString(entry.name) && isNonEmptyString(entry.command)) {
      if (entry.command !== `./${entry.name}`) {
        errors.push(
          `gates['${label}'].command must be './' + name (got '${entry.command}' for name '${entry.name}')`,
        );
      }
      const expectedRunner = UNION_PORT_MATCHLOCK_GATE_RUNNERS[label];
      if (expectedRunner !== undefined) {
        if (entry.name !== expectedRunner) {
          errors.push(
            `gates['${label}'].name must be the real runner '${expectedRunner}' (got '${entry.name}')`,
          );
        }
      } else if (!RUNNER_NAME_RE.test(entry.name)) {
        errors.push(
          `gates['${label}'].name must be a run-*-e2e-test runner (got '${entry.name}')`,
        );
      }
    }
    if (!Number.isInteger(entry.exit)) {
      errors.push(`gates['${label}'].exit must be an integer`);
    } else if (entry.exit !== 0) {
      // US-012: a red gate is only acceptable when it is a DOCUMENTED
      // pre-existing blocker. Anything else is an undocumented failure.
      if (!isDocumentedBlockedGate(entry)) {
        errors.push(
          `gates['${label}'].exit must be 0 (got ${String(entry.exit)}) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}`,
        );
      } else {
        for (const key of REQUIRED_BLOCKED_STRING_FIELDS) {
          const blocked = entry.blocked as Record<string, unknown>;
          if (!isNonEmptyString(blocked[key])) {
            errors.push(`gates['${label}'].blocked.${key} must be a non-empty string`);
          }
        }
      }
    } else if (isPlainObject(entry.blocked)) {
      // A green gate must never carry a blocker (it would be contradictory).
      errors.push(
        `gates['${label}'].blocked must be absent when exit is 0`,
      );
    }
    if (
      !Number.isInteger(entry.observedRounds) ||
      (entry.observedRounds as number) < 1
    ) {
      errors.push(
        `gates['${label}'].observedRounds must be a positive integer (got ${String(entry.observedRounds)})`,
      );
    }
    if (!Array.isArray(entry.observedVmIds)) {
      errors.push(`gates['${label}'].observedVmIds must be an array`);
    } else {
      if (entry.observedVmIds.length === 0) {
        errors.push(`gates['${label}'].observedVmIds must be non-empty`);
      }
      entry.observedVmIds.forEach((id, index) => {
        if (typeof id !== "string" || !VM_ID_RE.test(id)) {
          errors.push(
            `gates['${label}'].observedVmIds[${index}] must be a vm-<8 lowercase hex> id`,
          );
        }
      });
    }
    if (entry.vmClosed !== true) {
      errors.push(`gates['${label}'].vmClosed must be true (positively closed)`);
    }
  }

  for (const required of UNION_PORT_MATCHLOCK_BATCH_1_GATES) {
    if (!labels.includes(required)) {
      errors.push(`missing required gate '${required}'`);
    }
  }

  // ── US-012: the real-boot gate must prove a real-layout home ──────────
  // The story REQUIRES the real-boot gate to run against the operator-shaped
  // real-layout DSH_HOME, never the older minimal synthetic form. Published
  // evidence therefore has to carry the staged home and its evidence file so
  // the real-file assertion can inspect the >=3-zstd-session-dir layout.
  const realBoot = gates["dsh-real-boot"];
  if (isPlainObject(realBoot)) {
    if (realBoot.realLayoutHome !== true) {
      errors.push(
        "gates['dsh-real-boot'].realLayoutHome must be true (the real-boot gate is REQUIRED to use a real-layout home)",
      );
    }
    if (!isNonEmptyString(realBoot.realLayoutHomeDir)) {
      errors.push("gates['dsh-real-boot'].realLayoutHomeDir must be a non-empty string");
    }
    if (!isNonEmptyString(realBoot.realLayoutHomeEvidence)) {
      errors.push("gates['dsh-real-boot'].realLayoutHomeEvidence must be a non-empty string");
    }
  }

  // ── VM lifecycle + kill trace ─────────────────────────────────────────
  if (!isPlainObject(value.vmLifecycle)) {
    errors.push("'vmLifecycle' must be an object");
  } else {
    for (const key of ["before", "after", "created", "removed"] as const) {
      if (!Array.isArray(value.vmLifecycle[key])) {
        errors.push(`vmLifecycle.${key} must be an array`);
      }
    }
    if (value.vmLifecycle.allGateVmsClosed !== true) {
      errors.push("vmLifecycle.allGateVmsClosed must be true");
    }
  }

  if (!isPlainObject(value.killTrace)) {
    errors.push("'killTrace' must be an object");
  } else {
    if (!isNonEmptyString(value.killTrace.sender)) {
      errors.push("killTrace.sender must be a non-empty string");
    }
    if (typeof value.killTrace.observed !== "boolean") {
      errors.push("killTrace.observed must be a boolean");
    }
  }

  return errors;
}

/** Minimal structurally valid evidence, reused across the error cases. */
export function buildMinimalValidMatchlockGates(): Record<string, unknown> {  const gates: Record<string, unknown> = {};
  for (const label of UNION_PORT_MATCHLOCK_BATCH_1_GATES) {
    const runner = UNION_PORT_MATCHLOCK_GATE_RUNNERS[label]!;
    gates[label] = {
      label,
      name: runner,
      command: `./${runner}`,
      exit: 0,
      observedRounds: 2,
      observedVmIds: ["vm-01234567", "vm-89abcdef"],
      evidenceDir: `/home/kaladin/matchlock-work/evidence/${label}-AAAAAA`,
      observedRoundsPath: `/home/kaladin/matchlock-work/evidence/${label}-AAAAAA/observed-rounds.json`,
      gateRunLog: `/home/kaladin/matchlock-work/union-port-gates/us011-gate-${label}.log`,
      startedAt: "2026-09-19T00:00:00Z",
      endedAt: "2026-09-19T00:00:01Z",
      vmClosed: true,
    };
  }
  return {
    runId: "run-25cb113c-e6e7-4d2e-99db-8ad0d1ec6d89",
    branch: "feature/union-port-matchlock-20260918",
    commit: "0123456789abcdef0123456789abcdef01234567",
    lock: UNION_PORT_GATE_LOCK,
    buildIdentity: {
      matchlockPath: `${SYSTEM_MATCHLOCK_PREFIX}/matchlock`,
      matchlockVersion: "matchlock version 0.2.17",
      pinned: false,
    },
    gates,
    vmLifecycle: {
      before: [],
      after: [],
      created: ["vm-01234567", "vm-89abcdef"],
      removed: ["vm-01234567", "vm-89abcdef"],
      allGateVmsClosed: true,
    },
    killTrace: {
      path: "/home/kaladin/matchlock-work/kill-trace.log",
      observed: false,
      sender: "none observed",
    },
  };
}

/**
 * US-012 second-batch fixture: the four real-VM gates published by the dsh /
 * worktree-merge story, including the REQUIRED real-layout real-boot entry.
 * `evidenceDir` values are synthetic (the real-file assertions against the
 * canonical deliverable are the ones that touch the host), but they carry the
 * fields the real-boot rule inspects.
 */
export function buildMinimalValidMatchlockGatesWithBatch2(): Record<string, unknown> {
  const value = buildMinimalValidMatchlockGates();
  const gates = value.gates as Record<string, Record<string, unknown>>;
  for (const label of UNION_PORT_MATCHLOCK_BATCH_2_GATES) {
    const runner = UNION_PORT_MATCHLOCK_GATE_RUNNERS[label]!;
    const dir = `/home/kaladin/matchlock-work/evidence/${label}-AAAAAA`;
    gates[label] = {
      label,
      name: runner,
      command: `./${runner}`,
      exit: 0,
      observedRounds: 2,
      observedVmIds: ["vm-01234567", "vm-89abcdef"],
      evidenceDir: dir,
      observedRoundsPath: `${dir}/observed-rounds.json`,
      gateRunLog: `${dir}/gate-run.log`,
      startedAt: "2026-09-19T00:00:00Z",
      endedAt: "2026-09-19T00:00:01Z",
      vmClosed: true,
    };
  }
  gates["dsh-real-boot"]!.realLayoutHome = true;
  gates["dsh-real-boot"]!.realLayoutHomeDir =
    "/home/kaladin/matchlock-work/evidence/dsh-real-boot-AAAAAA/dsh-home";
  gates["dsh-real-boot"]!.realLayoutHomeEvidence =
    "/home/kaladin/matchlock-work/evidence/dsh-real-boot-AAAAAA/dsh-real-boot-gate.json";
  return value;
}

/** Shallow-clone evidence with one gate entry replaced. */
function withGate(
  label: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const value = buildMinimalValidMatchlockGates();
  const gates = value.gates as Record<string, Record<string, unknown>>;
  gates[label] = { ...gates[label], ...patch };
  return value;
}

describe("UNION-PORT US-011/US-012 Matchlock gate evidence validator", () => {
  it("accepts the minimal valid evidence", () => {
    assert.deepEqual(validateUnionPortMatchlockGates(buildMinimalValidMatchlockGates()), []);
  });

  it("rejects non-object evidence", () => {
    assert.deepEqual(validateUnionPortMatchlockGates("nope"), [
      "matchlock-gates evidence must be a JSON object",
    ]);
    assert.deepEqual(validateUnionPortMatchlockGates(null), [
      "matchlock-gates evidence must be a JSON object",
    ]);
    assert.deepEqual(validateUnionPortMatchlockGates([buildMinimalValidMatchlockGates()]), [
      "matchlock-gates evidence must be a JSON object",
    ]);
  });

  it("requires the run metadata fields", () => {
    const value = buildMinimalValidMatchlockGates();
    delete value.commit;
    value.branch = "";
    const errors = validateUnionPortMatchlockGates(value);
    assert.ok(errors.includes("'commit' must be a non-empty string"));
    assert.ok(errors.includes("'branch' must be a non-empty string"));
  });

  it("requires the SYSTEM unpinned runtime identity", () => {
    const value = buildMinimalValidMatchlockGates();
    const identity = value.buildIdentity as Record<string, unknown>;
    identity.matchlockPath = "/opt/private/matchlock";
    identity.pinned = true;
    identity.matchlockVersion = "";
    const errors = validateUnionPortMatchlockGates(value);
    assert.ok(
      errors.includes(
        `buildIdentity.matchlockPath must resolve under ${SYSTEM_MATCHLOCK_PREFIX}/ (got /opt/private/matchlock)`,
      ),
    );
    assert.ok(
      errors.includes("buildIdentity.pinned must be false (the SYSTEM runtime is unpinned)"),
    );
    assert.ok(errors.includes("buildIdentity.matchlockVersion must be a non-empty string"));
  });

  it("requires a gates object keyed by label", () => {
    const value = buildMinimalValidMatchlockGates();
    delete value.gates;
    assert.deepEqual(validateUnionPortMatchlockGates(value), [
      "'gates' must be an object keyed by gate label",
    ]);
  });

  it("requires every per-gate field", () => {
    const value = withGate("synthetic", { command: "", evidenceDir: 42 });
    const errors = validateUnionPortMatchlockGates(value);
    assert.ok(errors.includes("gates['synthetic'].command must be a non-empty string"));
    assert.ok(errors.includes("gates['synthetic'].evidenceDir must be a non-empty string"));
  });

  it("requires the entry key to equal its label", () => {
    const value = withGate("synthetic", { label: "dsh" });
    assert.ok(
      validateUnionPortMatchlockGates(value).includes(
        "gates['synthetic'].label must equal 'synthetic'",
      ),
    );
  });

  it("rejects a non-integer or non-zero exit", () => {
    assert.ok(
      validateUnionPortMatchlockGates(withGate("synthetic", { exit: "0" })).includes(
        "gates['synthetic'].exit must be an integer",
      ),
    );
    assert.ok(
      validateUnionPortMatchlockGates(withGate("long-home", { exit: 92 })).includes(
        "gates['long-home'].exit must be 0 (got 92) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
      ),
    );
  });

  it("accepts a red gate only with a complete documented blocked object", () => {
    const blocked = {
      preExisting: true,
      reason: "guest-agent sandbox re-exec",
      classification: "pre-existing runtime blocker",
      evidence: "/home/kaladin/matchlock-work/evidence/dsh-exec-AAAA/nonstandard-path-invocation.json",
      docsCitation: "docs/matchlock-dsh-qualification.md#5",
    };
    const withBlockedDsh = (
      patch: Record<string, unknown>,
    ): Record<string, unknown> => {
      const value = buildMinimalValidMatchlockGatesWithBatch2();
      const gates = value.gates as Record<string, Record<string, unknown>>;
      gates["dsh"] = { ...gates["dsh"], ...patch };
      return value;
    };
    assert.deepEqual(
      validateUnionPortMatchlockGates(withBlockedDsh({ exit: 1, blocked })),
      [],
    );
    for (const key of ["reason", "classification", "evidence", "docsCitation"] as const) {
      const incomplete = { ...blocked, [key]: "" };
      assert.ok(
        validateUnionPortMatchlockGates(
          withBlockedDsh({ exit: 1, blocked: incomplete }),
        ).includes(
          "gates['dsh'].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
        ),
        `an incomplete blocked object missing '${key}' must be rejected`,
      );
    }
    assert.ok(
      validateUnionPortMatchlockGates(
        withBlockedDsh({ exit: 1, blocked: { ...blocked, preExisting: false } }),
      ).includes(
        "gates['dsh'].exit must be 0 (got 1) unless the gate records a documented blocked object {preExisting:true, reason, classification, evidence, docsCitation}",
      ),
    );
  });

  it("rejects a blocked object on a green gate", () => {
    const value = withGate("synthetic", {
      exit: 0,
      blocked: {
        preExisting: true,
        reason: "r",
        classification: "c",
        evidence: "e",
        docsCitation: "d",
      },
    });
    assert.ok(
      validateUnionPortMatchlockGates(value).includes(
        "gates['synthetic'].blocked must be absent when exit is 0",
      ),
    );
  });

  it("refuses a zero or negative observed round count", () => {
    for (const rounds of [0, -1, 1.5, "3"]) {
      const errors = validateUnionPortMatchlockGates(
        withGate("empty-output", { observedRounds: rounds }),
      );
      assert.ok(
        errors.includes(
          `gates['empty-output'].observedRounds must be a positive integer (got ${String(rounds)})`,
        ),
      );
    }
  });

  it("validates every observed VM id", () => {
    const value = withGate("hermes-synthetic", {
      observedVmIds: ["vm-01234567", "vm-NOTHEX", ""],
    });
    const errors = validateUnionPortMatchlockGates(value);
    assert.ok(
      errors.includes(
        "gates['hermes-synthetic'].observedVmIds[1] must be a vm-<8 lowercase hex> id",
      ),
    );
    assert.ok(
      errors.includes(
        "gates['hermes-synthetic'].observedVmIds[2] must be a vm-<8 lowercase hex> id",
      ),
    );
  });

  it("requires positive VM closure per gate", () => {
    assert.ok(
      validateUnionPortMatchlockGates(withGate("synthetic", { vmClosed: false })).includes(
        "gates['synthetic'].vmClosed must be true (positively closed)",
      ),
    );
  });

  it("requires all four first-batch gates", () => {
    const value = buildMinimalValidMatchlockGates();
    delete (value.gates as Record<string, unknown>)["long-home"];
    assert.ok(
      validateUnionPortMatchlockGates(value).includes("missing required gate 'long-home'"),
    );
  });

  it("requires the VM lifecycle and kill-trace sections", () => {
    const value = buildMinimalValidMatchlockGates();
    delete value.vmLifecycle;
    delete value.killTrace;
    const errors = validateUnionPortMatchlockGates(value);
    assert.ok(errors.includes("'vmLifecycle' must be an object"));
    assert.ok(errors.includes("'killTrace' must be an object"));
  });

  it("requires a truthful kill-trace sender and lifecycle closure flag", () => {
    const value = buildMinimalValidMatchlockGates();
    (value.vmLifecycle as Record<string, unknown>).allGateVmsClosed = false;
    (value.killTrace as Record<string, unknown>).sender = "";
    (value.killTrace as Record<string, unknown>).observed = "no";
    const errors = validateUnionPortMatchlockGates(value);
    assert.ok(errors.includes("vmLifecycle.allGateVmsClosed must be true"));
    assert.ok(errors.includes("killTrace.sender must be a non-empty string"));
    assert.ok(errors.includes("killTrace.observed must be a boolean"));
  });

  it("pins the batch-1 labels and the shared lock path", () => {
    assert.deepEqual(
      [...UNION_PORT_MATCHLOCK_BATCH_1_GATES],
      ["synthetic", "hermes-synthetic", "empty-output", "long-home"],
    );
    assert.equal(UNION_PORT_GATE_LOCK, "/home/kaladin/matchlock-work/vaivm-gate.lock");
  });

  it("rejects a runner name invented from the gate label", () => {
    // `run-synthetic-e2e-test` is NOT a real file: the runner is
    // `run-matchlock-synthetic-e2e-test`. The old fixture-derived name must
    // fail, otherwise a wrong command could pass unnoticed.
    const value = withGate("synthetic", {
      name: "run-synthetic-e2e-test",
      command: "./run-synthetic-e2e-test",
    });
    assert.ok(
      validateUnionPortMatchlockGates(value).includes(
        "gates['synthetic'].name must be the real runner 'run-matchlock-synthetic-e2e-test' (got 'run-synthetic-e2e-test')",
      ),
    );
  });

  it("requires command to be './' + name", () => {
    const value = withGate("synthetic", { command: "./run-matchlock-long-home-e2e-test" });
    assert.ok(
      validateUnionPortMatchlockGates(value).includes(
        "gates['synthetic'].command must be './' + name (got './run-matchlock-long-home-e2e-test' for name 'run-matchlock-synthetic-e2e-test')",
      ),
    );
  });

  it("pins the real runner for every batch-1 label", () => {
    for (const label of UNION_PORT_MATCHLOCK_BATCH_1_GATES) {
      assert.match(
        UNION_PORT_MATCHLOCK_GATE_RUNNERS[label]!,
        RUNNER_NAME_RE,
        `runner mapping for '${label}'`,
      );
    }
    assert.equal(
      UNION_PORT_MATCHLOCK_GATE_RUNNERS["empty-output"],
      "run-matchlock-empty-output-e2e-test",
    );
    assert.equal(
      UNION_PORT_MATCHLOCK_GATE_RUNNERS["long-home"],
      "run-matchlock-long-home-e2e-test",
    );
  });

  // ---- US-012: second batch (dsh / overlay / real-boot / worktree-merge) ----

  it("pins the batch-2 labels and the real runner for each", () => {
    assert.deepEqual(
      [...UNION_PORT_MATCHLOCK_BATCH_2_GATES],
      ["dsh", "dsh-profile-overlay", "dsh-real-boot", "worktree-merge"],
    );
    assert.equal(UNION_PORT_MATCHLOCK_GATE_RUNNERS["dsh"], "run-matchlock-dsh-gate-e2e-test");
    assert.equal(
      UNION_PORT_MATCHLOCK_GATE_RUNNERS["dsh-profile-overlay"],
      "run-matchlock-dsh-profile-overlay-e2e-test",
    );
    assert.equal(
      UNION_PORT_MATCHLOCK_GATE_RUNNERS["dsh-real-boot"],
      "run-matchlock-dsh-real-boot-gate-e2e-test",
    );
    assert.equal(
      UNION_PORT_MATCHLOCK_GATE_RUNNERS["worktree-merge"],
      "run-matchlock-worktree-merge-e2e-test",
    );
    for (const label of UNION_PORT_MATCHLOCK_BATCH_2_GATES) {
      assert.match(
        UNION_PORT_MATCHLOCK_GATE_RUNNERS[label]!,
        RUNNER_NAME_RE,
        `runner mapping for '${label}'`,
      );
    }
  });

  it("accepts batch-2 evidence including the real-layout real-boot entry", () => {
    assert.deepEqual(
      validateUnionPortMatchlockGates(buildMinimalValidMatchlockGatesWithBatch2()),
      [],
    );
  });

  it("requires the real-boot entry to prove a real-layout home", () => {
    const missing = buildMinimalValidMatchlockGatesWithBatch2();
    const missingGates = missing.gates as Record<string, Record<string, unknown>>;
    delete missingGates["dsh-real-boot"]!.realLayoutHome;
    assert.ok(
      validateUnionPortMatchlockGates(missing).includes(
        "gates['dsh-real-boot'].realLayoutHome must be true (the real-boot gate is REQUIRED to use a real-layout home)",
      ),
    );

    const minimal = withGate("dsh-real-boot", { realLayoutHome: false });
    assert.ok(
      validateUnionPortMatchlockGates(minimal).includes(
        "gates['dsh-real-boot'].realLayoutHome must be true (the real-boot gate is REQUIRED to use a real-layout home)",
      ),
    );
    assert.ok(
      validateUnionPortMatchlockGates(
        withGate("dsh-real-boot", { realLayoutHomeDir: "" }),
      ).includes("gates['dsh-real-boot'].realLayoutHomeDir must be a non-empty string"),
    );
    assert.ok(
      validateUnionPortMatchlockGates(
        withGate("dsh-real-boot", { realLayoutHomeEvidence: 7 }),
      ).includes("gates['dsh-real-boot'].realLayoutHomeEvidence must be a non-empty string"),
    );
  });

  // ---- real published deliverable ----

  function deliverablePath(): string {
    return process.env.UNION_PORT_MATCHLOCK_GATES_PATH ?? DEFAULT_UNION_PORT_MATCHLOCK_GATES_PATH;
  }

  it(
    "parses the published matchlock-gates deliverable as JSON and finds it structurally complete",
    {
      skip: (() => {
        const path = deliverablePath();
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const path = deliverablePath();
      const raw = readFileSync(path, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        assert.fail(
          `published matchlock-gates evidence is not valid JSON: ${(error as Error).message}`,
        );
      }
      assert.deepEqual(validateUnionPortMatchlockGates(parsed), []);
    },
  );

  it(
    "cross-checks every gate entry against its retained observed-rounds.json",
    {
      skip: (() => {
        const path = deliverablePath();
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const parsed = JSON.parse(readFileSync(deliverablePath(), "utf-8")) as {
        gates: Record<
          string,
          { observedRounds: number; observedVmIds: string[]; observedRoundsPath: string }
        >;
      };
      for (const [label, entry] of Object.entries(parsed.gates)) {
        assert.ok(
          existsSync(entry.observedRoundsPath),
          `gates['${label}'].observedRoundsPath must exist: ${entry.observedRoundsPath}`,
        );
        const evidence = JSON.parse(readFileSync(entry.observedRoundsPath, "utf-8")) as {
          gate: string;
          observed_rounds: number;
          observed_vm_ids: string[];
        };
        assert.equal(evidence.gate, label, `retained evidence gate label for '${label}'`);
        assert.equal(
          evidence.observed_rounds,
          entry.observedRounds,
          `retained observed_rounds for '${label}'`,
        );
        assert.deepEqual(
          [...evidence.observed_vm_ids].sort(),
          [...entry.observedVmIds].sort(),
          `retained observed_vm_ids for '${label}'`,
        );
      }
    },
  );

  it(
    "pins every recorded runner to a real script in the repo root",
    {
      skip: (() => {
        const path = deliverablePath();
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const parsed = JSON.parse(readFileSync(deliverablePath(), "utf-8")) as {
        gates: Record<string, { name: string; command: string }>;
      };
      const failures: string[] = [];
      for (const [label, entry] of Object.entries(parsed.gates)) {
        const runner = path.join(REPO_ROOT, entry.name);
        if (!existsSync(runner)) {
          failures.push(
            `gates['${label}'] runner '${entry.name}' does not exist in the repo root`,
          );
        }
        if (entry.command !== `./${entry.name}`) {
          failures.push(
            `gates['${label}'] command '${entry.command}' is not './${entry.name}'`,
          );
        }
      }
      assert.deepEqual(failures, []);
    },
  );

  it(
    "requires all four second-batch gates once any is published",
    {
      skip: (() => {
        const path = deliverablePath();
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const parsed = JSON.parse(readFileSync(deliverablePath(), "utf-8")) as {
        gates: Record<string, unknown>;
      };
      const present = UNION_PORT_MATCHLOCK_BATCH_2_GATES.filter(
        (label) => label in parsed.gates,
      );
      if (present.length === 0) {
        return;
      }
      assert.deepEqual(
        present.length,
        UNION_PORT_MATCHLOCK_BATCH_2_GATES.length,
        `batch 2 is all-or-nothing; published: ${present.join(", ")}`,
      );
    },
  );

  it(
    "proves the published real-boot gate used a real-layout home",
    {
      skip: (() => {
        const path = deliverablePath();
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const parsed = JSON.parse(readFileSync(deliverablePath(), "utf-8")) as {
        gates: Record<
          string,
          {
            realLayoutHome?: boolean;
            realLayoutHomeDir?: string;
            realLayoutHomeEvidence?: string;
          }
        >;
      };
      const entry = parsed.gates["dsh-real-boot"];
      if (entry === undefined) {
        return;
      }
      assert.equal(entry.realLayoutHome, true, "real-boot entry.realLayoutHome");
      assert.ok(
        typeof entry.realLayoutHomeDir === "string" && existsSync(entry.realLayoutHomeDir),
        `realLayoutHomeDir must exist: ${String(entry.realLayoutHomeDir)}`,
      );
      assert.ok(
        typeof entry.realLayoutHomeEvidence === "string" &&
          existsSync(entry.realLayoutHomeEvidence),
        `realLayoutHomeEvidence must exist: ${String(entry.realLayoutHomeEvidence)}`,
      );
      const evidence = JSON.parse(readFileSync(entry.realLayoutHomeEvidence!, "utf-8")) as {
        sourceDshHome?: string;
        realLayoutHome?: { sessionDirs?: number; storageRecordFiles?: number };
      };
      assert.ok(
        (evidence.realLayoutHome?.sessionDirs ?? 0) >= 3,
        "the real-layout home evidence must show >=3 zstd session dirs",
      );
      assert.ok(
        (evidence.realLayoutHome?.storageRecordFiles ?? 0) >= 1,
        "the real-layout home evidence must show storages projection records",
      );
      assert.ok(
        typeof evidence.sourceDshHome === "string" && evidence.sourceDshHome.length > 0,
        "the real-layout home evidence must record its operator source home",
      );
    },
  );

  it(
    "backs every published documented-blocked gate with real evidence and a citation",
    {
      skip: (() => {
        const path = deliverablePath();
        if (!existsSync(path)) {
          return `deliverable not found at ${path}`;
        }
        return false;
      })(),
    },
    () => {
      const parsed = JSON.parse(readFileSync(deliverablePath(), "utf-8")) as {
        gates: Record<
          string,
          {
            exit?: number;
            blocked?: {
              preExisting?: boolean;
              reason?: string;
              classification?: string;
              evidence?: string;
              docsCitation?: string;
            };
          }
        >;
      };
      for (const [label, entry] of Object.entries(parsed.gates)) {
        if (entry.blocked === undefined) {
          continue;
        }
        assert.equal(entry.exit === 0, false, `blocked gate '${label}' must be red`);
        const blocked = entry.blocked;
        assert.ok(
          typeof blocked.evidence === "string" && existsSync(blocked.evidence),
          `gates['${label}'].blocked.evidence must exist: ${String(blocked.evidence)}`,
        );
        const docPath = String(blocked.docsCitation ?? "").split("#")[0];
        assert.ok(
          docPath.length > 0 && existsSync(path.join(REPO_ROOT, docPath)),
          `gates['${label}'].blocked.docsCitation must name a repo doc: ${String(blocked.docsCitation)}`,
        );
      }
    },
  );
});
