#!/usr/bin/env node
/**
 * observed-rounds-guard.mjs — the run-level no-fake-green gate for the
 * Matchlock real-VM gates (TESTER-HONESTY items 3+4).
 *
 * Every `run-matchlock-*-e2e-test` runner invokes this AFTER `node --test` so a
 * run that never created a VM (or whose probe failed before any round) can
 * never be reported as PASS. It reads the gate's
 * `<evidenceDir>/observed-rounds.json`, written by the gate driver via
 * `e2e-tests/helpers/matchlock-gate-rounds.ts`.
 *
 *   node scripts/observed-rounds-guard.mjs --dir <evidenceDir> --gate <label>
 *
 * Contract:
 *   - evidence file missing/unreadable/malformed OR observed_rounds === 0:
 *       print the exact line
 *         no VM round observed (VM creation or probe failed before any round)
 *       plus a bounded summary to stderr and exit ZERO_ROUND_EXIT_CODE (92);
 *   - observed_rounds > 0: print the observed count and distinct VM ids to
 *     stdout and exit 0.
 *
 * The count is ALWAYS read from the evidence file — this guard never
 * fabricates, defaults or infers a round count. Plain Node core, no deps.
 */

import fs from "node:fs";
import path from "node:path";

export const OBSERVED_ROUNDS_FILE = "observed-rounds.json";
export const ZERO_ROUND_EXIT_CODE = 92;
export const ZERO_ROUND_MESSAGE =
  "no VM round observed (VM creation or probe failed before any round)";

const VM_ID_RE = /^vm-[0-9a-f]{8}$/;
const MAX_SUMMARY_CHARS = 300;

/** Bound a value for the diagnostic summary so a hostile path can't flood stderr. */
function bounded(value) {
  const text = typeof value === "string" ? value : String(value);
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS)}… (truncated)`;
}

/** Parse `--dir <dir> --gate <label>`; returns an error string when invalid. */
function parseArgs(argv) {
  let dir = "";
  let gate = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      dir = argv[++i] ?? "";
    } else if (arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg === "--gate") {
      gate = argv[++i] ?? "";
    } else if (arg.startsWith("--gate=")) {
      gate = arg.slice("--gate=".length);
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `unknown argument: ${bounded(arg)}` };
    }
  }
  if (!dir) return { error: "missing required --dir <evidenceDir>" };
  if (!gate) return { error: "missing required --gate <label>" };
  return { dir, gate };
}

/**
 * Read the evidence file STRICTLY. Any missing file, malformed JSON or
 * malformed shape is an error — never coerced into a clean/zero result.
 */
function readEvidence(dir) {
  const file = path.join(dir, OBSERVED_ROUNDS_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err && err.code ? err.code : bounded(err.message)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`malformed JSON in ${file}: ${bounded(err.message)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`malformed evidence shape in ${file}: expected a JSON object`);
  }
  if (typeof parsed.gate !== "string" || parsed.gate === "") {
    throw new Error(`malformed evidence shape in ${file}: gate must be a non-empty string`);
  }
  if (
    typeof parsed.observed_rounds !== "number" ||
    !Number.isSafeInteger(parsed.observed_rounds) ||
    parsed.observed_rounds < 0
  ) {
    throw new Error(
      `malformed evidence shape in ${file}: observed_rounds must be a non-negative safe integer`,
    );
  }
  if (!Array.isArray(parsed.observed_vm_ids)) {
    throw new Error(`malformed evidence shape in ${file}: observed_vm_ids must be an array`);
  }
  const seen = new Set();
  for (const id of parsed.observed_vm_ids) {
    if (typeof id !== "string" || !VM_ID_RE.test(id)) {
      throw new Error(
        `malformed evidence shape in ${file}: invalid VM id ${JSON.stringify(id)} (expected vm-<8 lowercase hex>)`,
      );
    }
    seen.add(id);
  }
  return {
    gate: parsed.gate,
    observed_rounds: parsed.observed_rounds,
    observed_vm_ids: [...seen],
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      "usage: node scripts/observed-rounds-guard.mjs --dir <evidenceDir> --gate <label>\n",
    );
    process.exit(0);
  }
  if (args.error) {
    process.stderr.write(`observed-rounds-guard: ${args.error}\n`);
    process.stderr.write(
      "usage: node scripts/observed-rounds-guard.mjs --dir <evidenceDir> --gate <label>\n",
    );
    process.exit(2);
  }

  const { dir, gate } = args;
  let evidence;
  try {
    evidence = readEvidence(dir);
  } catch (err) {
    process.stderr.write(`${ZERO_ROUND_MESSAGE}\n`);
    process.stderr.write(
      `observed-rounds-guard: refusing PASS gate=${bounded(gate)} dir=${bounded(dir)}: ${bounded(
        err.message,
      )}\n`,
    );
    process.exit(ZERO_ROUND_EXIT_CODE);
  }

  if (evidence.observed_rounds < 1) {
    process.stderr.write(`${ZERO_ROUND_MESSAGE}\n`);
    process.stderr.write(
      `observed-rounds-guard: refusing PASS gate=${bounded(gate)} dir=${bounded(
        dir,
      )}: evidence gate=${bounded(evidence.gate)} observed_rounds=0 observed_vm_ids=${
        evidence.observed_vm_ids.join(",") || "(none)"
      }\n`,
    );
    process.exit(ZERO_ROUND_EXIT_CODE);
  }

  process.stdout.write(
    `observed-rounds-guard: PASS gate=${bounded(gate)} observed_rounds=${
      evidence.observed_rounds
    } observed_vm_ids=${evidence.observed_vm_ids.join(",") || "(none)"} dir=${bounded(dir)}\n`,
  );
  process.exit(0);
}

main(process.argv.slice(2));
