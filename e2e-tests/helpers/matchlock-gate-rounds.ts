/**
 * matchlock-gate-rounds.ts — shared, no-fake-green evidence helper for the
 * real-VM Matchlock gates (TESTER-HONESTY items 3+4).
 *
 * Every Matchlock gate must record the in-VM rounds it ACTUALLY observed and
 * refuse to report PASS when that count is zero. A gate whose VM creation
 * fails (e.g. TUNSETIFF under a sandbox, a missing KVM device, a probe error)
 * must fail loudly with the distinct zero-round exit code instead of letting a
 * vacuous round-rejection assertion stand in for a green run.
 *
 * Design rules:
 *   - the count is always the number of in-VM rounds actually observed, never
 *     an assumed/expected constant;
 *   - observed VM ids are validated against `vm-<8 lowercase hex>` and
 *     de-duplicated — an invalid id THROWS rather than being silently kept;
 *   - malformed/missing JSON THROWS from the reader (never fabricates clean);
 *   - this module is Node-core only and stays outside the tsc `dist` build
 *     (e2e-tests helpers run directly under `node --test`).
 */

import fs from "node:fs";
import path from "node:path";

/** Evidence file written into each gate's evidence directory. */
export const OBSERVED_ROUNDS_FILE = "observed-rounds.json";

/**
 * Distinct exit code for "the gate observed no VM round". Chosen to be
 * distinct from 0 (PASS), 1 (test failure) and 90 (the runner's FATAL).
 */
export const ZERO_ROUND_EXIT_CODE = 92;

/**
 * The exact diagnostic line a zero-round gate refuses with. The guard script
 * (`scripts/observed-rounds-guard.mjs`) prints this line verbatim; the
 * in-process assertion throws an Error whose message contains it.
 */
export const ZERO_ROUND_MESSAGE =
  "no VM round observed (VM creation or probe failed before any round)";

/** A real Matchlock VM id: `vm-` + 8 lowercase hex characters. */
export const VM_ID_RE = /^vm-[0-9a-f]{8}$/;

export interface ObservedRoundsEvidence {
  /** Gate label, e.g. `dsh-real-boot` or `synthetic`. */
  gate: string;
  /** Number of in-VM rounds actually observed (never assumed). */
  observed_rounds: number;
  /** Distinct observed `vm-<8hex>` ids, first-seen order. */
  observed_vm_ids: string[];
  /** ISO-8601 timestamp of the observation. */
  observed_at: string;
  /** Optional bounded human detail. */
  detail?: string;
}

/** Input accepted by {@link writeObservedRoundsEvidence}; `observed_at` defaults to now. */
export interface ObservedRoundsEvidenceInput {
  gate: string;
  observed_rounds: number;
  observed_vm_ids: readonly string[];
  observed_at?: string;
  detail?: string;
}

/** Absolute path of the evidence file inside `dir`. */
export function observedRoundsFilePath(dir: string): string {
  if (typeof dir !== "string" || dir === "") {
    throw new Error("observed-rounds evidence dir must be a non-empty string");
  }
  return path.join(dir, OBSERVED_ROUNDS_FILE);
}

/**
 * Validate and de-duplicate observed VM ids. Throws on any entry that is not a
 * `vm-<8 lowercase hex>` string, so a gate can never record a fabricated or
 * mistyped VM identity.
 */
export function normalizeObservedVmIds(vmIds: readonly string[]): string[] {
  if (!Array.isArray(vmIds)) {
    throw new Error(
      `observed_vm_ids must be an array of vm-<8hex> strings, got ${JSON.stringify(vmIds)}`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of vmIds) {
    if (typeof id !== "string" || !VM_ID_RE.test(id)) {
      throw new Error(
        `invalid observed VM id ${JSON.stringify(id)}: expected vm-<8 lowercase hex> (never fabricate a count)`,
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function assertNonNegativeIntegerRounds(rounds: unknown): asserts rounds is number {
  if (typeof rounds !== "number" || !Number.isSafeInteger(rounds) || rounds < 0) {
    throw new Error(
      `observed_rounds must be a non-negative safe integer, got ${JSON.stringify(rounds)}`,
    );
  }
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value === "" || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${label} must be a non-empty ISO-8601 timestamp string, got ${JSON.stringify(value)}`,
    );
  }
}

function validateEvidenceShape(value: unknown, source: string): ObservedRoundsEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `malformed observed-rounds evidence at ${source}: expected a JSON object, got ${
        Array.isArray(value) ? "array" : typeof value
      }`,
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.gate !== "string" || record.gate === "") {
    throw new Error(
      `malformed observed-rounds evidence at ${source}: gate must be a non-empty string`,
    );
  }
  assertNonNegativeIntegerRounds(record.observed_rounds);
  if (!Array.isArray(record.observed_vm_ids)) {
    throw new Error(
      `malformed observed-rounds evidence at ${source}: observed_vm_ids must be an array`,
    );
  }
  const observed_vm_ids = normalizeObservedVmIds(record.observed_vm_ids as string[]);
  assertIsoTimestamp(record.observed_at, `observed_at in ${source}`);
  if (record.detail !== undefined && typeof record.detail !== "string") {
    throw new Error(
      `malformed observed-rounds evidence at ${source}: detail must be a string when present`,
    );
  }
  const evidence: ObservedRoundsEvidence = {
    gate: record.gate,
    observed_rounds: record.observed_rounds,
    observed_vm_ids,
    observed_at: record.observed_at,
  };
  if (record.detail !== undefined) evidence.detail = record.detail;
  return evidence;
}

/**
 * Write the gate's observed-rounds evidence into `dir` (created if needed).
 * Returns the normalized record that was written. Never invents a count: the
 * caller must pass the number of in-VM rounds it actually observed.
 */
export function writeObservedRoundsEvidence(
  dir: string,
  evidence: ObservedRoundsEvidenceInput,
): ObservedRoundsEvidence {
  if (typeof dir !== "string" || dir === "") {
    throw new Error("observed-rounds evidence dir must be a non-empty string");
  }
  if (evidence === null || typeof evidence !== "object") {
    throw new Error("observed-rounds evidence must be an object");
  }
  if (typeof evidence.gate !== "string" || evidence.gate === "") {
    throw new Error("observed-rounds evidence gate must be a non-empty string");
  }
  assertNonNegativeIntegerRounds(evidence.observed_rounds);
  const observed_vm_ids = normalizeObservedVmIds(evidence.observed_vm_ids);
  const observed_at =
    evidence.observed_at === undefined ? new Date().toISOString() : evidence.observed_at;
  assertIsoTimestamp(observed_at, "observed_at");
  if (evidence.detail !== undefined && typeof evidence.detail !== "string") {
    throw new Error("observed-rounds evidence detail must be a string when present");
  }

  const written: ObservedRoundsEvidence = {
    gate: evidence.gate,
    observed_rounds: evidence.observed_rounds,
    observed_vm_ids,
    observed_at,
  };
  if (evidence.detail !== undefined) written.detail = evidence.detail;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    observedRoundsFilePath(dir),
    `${JSON.stringify(written, null, 2)}\n`,
    "utf-8",
  );
  return written;
}

/**
 * Read and strictly validate the observed-rounds evidence in `dir`. Throws on
 * a missing/unreadable file, malformed JSON, or a malformed shape — an absent
 * or corrupt evidence file is never treated as clean.
 */
export function readObservedRoundsEvidence(dir: string): ObservedRoundsEvidence {
  const file = observedRoundsFilePath(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `observed-rounds evidence missing/unreadable at ${file}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `malformed observed-rounds JSON at ${file}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return validateEvidenceShape(parsed, file);
}

/**
 * Prove a gate observed at least one in-VM round. Throws an Error whose
 * message contains {@link ZERO_ROUND_MESSAGE} when `rounds < 1`. Returns the
 * validated, de-duplicated VM ids otherwise.
 */
export function assertObservedRoundsNonZero(
  gate: string,
  rounds: number,
  vmIds: readonly string[],
): string[] {
  if (typeof gate !== "string" || gate === "") {
    throw new Error("observed-rounds gate label must be a non-empty string");
  }
  assertNonNegativeIntegerRounds(rounds);
  if (rounds < 1) {
    throw new Error(`${ZERO_ROUND_MESSAGE} (gate ${gate})`);
  }
  return normalizeObservedVmIds(vmIds);
}
