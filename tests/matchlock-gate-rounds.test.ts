/**
 * Tests for the shared observed-rounds evidence + zero-round refusal helper
 * (TESTER-HONESTY items 3+4): `e2e-tests/helpers/matchlock-gate-rounds.ts` and
 * `scripts/observed-rounds-guard.mjs`.
 *
 * These are fast, deterministic file/spawn controls — no real VM, no daemon,
 * no matchlock runtime. They pin the contract every Matchlock gate relies on:
 * the round count is the number actually observed, a zero count refuses PASS
 * with the exact diagnostic line and the distinct exit code, and malformed
 * evidence is never treated as clean.
 *
 * This file spawns `node scripts/observed-rounds-guard.mjs` to observe the real
 * process exit codes, so it is classified into the serial lane (see
 * tests/serial-files.txt).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import { cleanChildEnv } from "./helpers/test-env.ts";
import {
  OBSERVED_ROUNDS_FILE,
  VM_ID_RE,
  ZERO_ROUND_EXIT_CODE,
  ZERO_ROUND_MESSAGE,
  assertObservedRoundsNonZero,
  normalizeObservedVmIds,
  observedRoundsFilePath,
  readObservedRoundsEvidence,
  writeObservedRoundsEvidence,
} from "../e2e-tests/helpers/matchlock-gate-rounds.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const GUARD_SCRIPT = path.join(REPO_ROOT, "scripts", "observed-rounds-guard.mjs");

const GATE = "unit-observed-rounds";
const VM_A = "vm-abcdef01";
const VM_B = "vm-12345678";

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, ...args], {
    encoding: "utf-8",
    // The guard script is pure Node core and needs no inherited environment;
    // cleanChildEnv keeps the spawn isolated (and satisfies the isolation
    // guard's ban on spreading process.env in test files).
    env: cleanChildEnv({
      TAMANDUA_PI_BINARY: "/usr/bin/false",
      TAMANDUA_DSH_BINARY: "/usr/bin/false",
    }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Write a raw evidence payload (bypasses the helper) to exercise the reader. */
function writeRawEvidence(dir: string, payload: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, OBSERVED_ROUNDS_FILE);
  fs.writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload), "utf-8");
  return file;
}

function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gate: GATE,
    observed_rounds: 2,
    observed_vm_ids: [VM_A, VM_B],
    observed_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchlock-gate-rounds helper", () => {
  let root = "";

  before(() => {
    root = tamanduaTempDir("mtlk-gate-rounds-");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("exports the pinned constants", () => {
    assert.equal(OBSERVED_ROUNDS_FILE, "observed-rounds.json");
    assert.equal(ZERO_ROUND_EXIT_CODE, 92);
    assert.equal(
      ZERO_ROUND_MESSAGE,
      "no VM round observed (VM creation or probe failed before any round)",
    );
    assert.ok(VM_ID_RE.test("vm-00ff00ff"));
    assert.ok(!VM_ID_RE.test("vm-00FF00FF"), "uppercase hex must not be accepted");
    assert.ok(!VM_ID_RE.test("vm-123"), "short ids must not be accepted");
    assert.equal(ZERO_ROUND_EXIT_CODE === 0 || ZERO_ROUND_EXIT_CODE === 1 || ZERO_ROUND_EXIT_CODE === 90, false);
  });

  it("write/read round-trip preserves the observed count and de-duplicates VM ids", () => {
    const dir = path.join(root, "roundtrip");
    const written = writeObservedRoundsEvidence(dir, {
      gate: GATE,
      observed_rounds: 3,
      observed_vm_ids: [VM_A, VM_B, VM_A],
      observed_at: "2026-09-17T12:00:00.000Z",
      detail: "three in-VM rounds",
    });

    assert.equal(written.observed_rounds, 3);
    assert.deepEqual(written.observed_vm_ids, [VM_A, VM_B], "duplicates are dropped");
    assert.equal(observedRoundsFilePath(dir), path.join(dir, OBSERVED_ROUNDS_FILE));
    assert.ok(fs.existsSync(path.join(dir, OBSERVED_ROUNDS_FILE)));

    const read = readObservedRoundsEvidence(dir);
    assert.equal(read.gate, GATE);
    assert.equal(read.observed_rounds, 3);
    assert.deepEqual(read.observed_vm_ids, [VM_A, VM_B]);
    assert.equal(read.observed_at, "2026-09-17T12:00:00.000Z");
    assert.equal(read.detail, "three in-VM rounds");
  });

  it("write fills observed_at when omitted and creates the directory", () => {
    const dir = path.join(root, "nested", "auto-timestamp");
    const before = Date.now();
    const written = writeObservedRoundsEvidence(dir, {
      gate: GATE,
      observed_rounds: 1,
      observed_vm_ids: [VM_A],
    });
    const parsed = Date.parse(written.observed_at);
    assert.ok(Number.isFinite(parsed), "observed_at must be a parseable timestamp");
    assert.ok(parsed >= before - 1000, "observed_at must be roughly now");
    assert.deepEqual(readObservedRoundsEvidence(dir).observed_vm_ids, [VM_A]);
  });

  it("read throws on a missing evidence file", () => {
    assert.throws(
      () => readObservedRoundsEvidence(path.join(root, "does-not-exist")),
      /missing\/unreadable/,
    );
  });

  it("read throws on malformed JSON", () => {
    const dir = path.join(root, "malformed-json");
    writeRawEvidence(dir, "{ not json at all");
    assert.throws(() => readObservedRoundsEvidence(dir), /malformed observed-rounds JSON/);
  });

  it("read throws on a malformed shape (wrong primitive types)", () => {
    const dir = path.join(root, "malformed-shape");
    writeRawEvidence(dir, validEvidence({ observed_rounds: "2" }));
    assert.throws(
      () => readObservedRoundsEvidence(dir),
      /observed_rounds must be a non-negative safe integer/,
    );

    const dir2 = path.join(root, "malformed-vmid");
    writeRawEvidence(dir2, validEvidence({ observed_vm_ids: ["not-a-vm"] }));
    assert.throws(() => readObservedRoundsEvidence(dir2), /invalid observed VM id/);

    const dir3 = path.join(root, "missing-gate");
    writeRawEvidence(dir3, validEvidence({ gate: "" }));
    assert.throws(() => readObservedRoundsEvidence(dir3), /gate must be a non-empty string/);
  });

  it("normalizeObservedVmIds validates and de-duplicates", () => {
    assert.deepEqual(normalizeObservedVmIds([VM_A, VM_A, VM_B]), [VM_A, VM_B]);
    assert.deepEqual(normalizeObservedVmIds([]), []);
    assert.throws(() => normalizeObservedVmIds(["vm-ABCDEF01"]), /invalid observed VM id/);
    assert.throws(() => normalizeObservedVmIds([undefined as unknown as string]), /invalid observed VM id/);
  });

  it("write refuses invalid VM ids instead of recording them", () => {
    const dir = path.join(root, "bad-write");
    assert.throws(
      () =>
        writeObservedRoundsEvidence(dir, {
          gate: GATE,
          observed_rounds: 1,
          observed_vm_ids: ["vm-not-hex"],
        }),
      /invalid observed VM id/,
    );
    assert.ok(!fs.existsSync(path.join(dir, OBSERVED_ROUNDS_FILE)));
  });

  it("assertObservedRoundsNonZero throws ZERO_ROUND_MESSAGE when the count is zero", () => {
    assert.throws(
      () => assertObservedRoundsNonZero(GATE, 0, []),
      (err: unknown) => err instanceof Error && err.message.includes(ZERO_ROUND_MESSAGE),
    );
    assert.throws(
      () => assertObservedRoundsNonZero(GATE, 0, [VM_A]),
      (err: unknown) => err instanceof Error && err.message.includes(ZERO_ROUND_MESSAGE),
    );
    assert.throws(
      () => assertObservedRoundsNonZero(GATE, -1, []),
      /non-negative safe integer/,
    );
  });

  it("assertObservedRoundsNonZero passes and returns de-duplicated ids when rounds > 0", () => {
    assert.deepEqual(assertObservedRoundsNonZero(GATE, 2, [VM_A, VM_B, VM_A]), [VM_A, VM_B]);
    assert.deepEqual(assertObservedRoundsNonZero(GATE, 1, [VM_A]), [VM_A]);
  });
});

describe("scripts/observed-rounds-guard.mjs exit codes", () => {
  let root = "";

  before(() => {
    root = tamanduaTempDir("mtlk-gate-rounds-guard-");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("the guard script exists", () => {
    assert.ok(fs.existsSync(GUARD_SCRIPT), "scripts/observed-rounds-guard.mjs must exist");
  });

  it("exits 0 and prints the count and VM ids when observed_rounds > 0", () => {
    const dir = path.join(root, "pass");
    writeObservedRoundsEvidence(dir, {
      gate: GATE,
      observed_rounds: 2,
      observed_vm_ids: [VM_A, VM_B],
    });
    const run = runGuard(["--dir", dir, "--gate", GATE]);
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}: ${run.stderr}`);
    assert.ok(run.stdout.includes("observed_rounds=2"), run.stdout);
    assert.ok(run.stdout.includes(VM_A) && run.stdout.includes(VM_B), run.stdout);
    assert.ok(!run.stderr.includes(ZERO_ROUND_MESSAGE), run.stderr);
  });

  it("exits 92 with the exact zero-round line when observed_rounds === 0", () => {
    const dir = path.join(root, "zero");
    writeObservedRoundsEvidence(dir, { gate: GATE, observed_rounds: 0, observed_vm_ids: [] });
    const run = runGuard(["--dir", dir, "--gate", GATE]);
    assert.equal(run.status, ZERO_ROUND_EXIT_CODE);
    assert.ok(
      run.stderr.split("\n").includes(ZERO_ROUND_MESSAGE),
      `stderr must carry the exact line; got:\n${run.stderr}`,
    );
  });

  it("exits 92 with the exact zero-round line when the evidence file is missing", () => {
    const dir = path.join(root, "missing");
    fs.mkdirSync(dir, { recursive: true });
    const run = runGuard(["--dir", dir, "--gate", GATE]);
    assert.equal(run.status, ZERO_ROUND_EXIT_CODE);
    assert.ok(run.stderr.split("\n").includes(ZERO_ROUND_MESSAGE), run.stderr);
  });

  it("exits 92 with the exact zero-round line when the evidence JSON is malformed", () => {
    const dir = path.join(root, "malformed");
    writeRawEvidence(dir, "{ definitely not json");
    const run = runGuard(["--dir", dir, "--gate", GATE]);
    assert.equal(run.status, ZERO_ROUND_EXIT_CODE);
    assert.ok(run.stderr.split("\n").includes(ZERO_ROUND_MESSAGE), run.stderr);
  });

  it("exits 92 when the shape is malformed rather than fabricating a pass", () => {
    const dir = path.join(root, "bad-shape");
    writeRawEvidence(dir, validEvidence({ observed_rounds: -3 }));
    const run = runGuard(["--dir", dir, "--gate", GATE]);
    assert.equal(run.status, ZERO_ROUND_EXIT_CODE);
    assert.ok(run.stderr.split("\n").includes(ZERO_ROUND_MESSAGE), run.stderr);
  });

  it("exits 2 (not 92) on missing arguments so usage errors stay distinguishable", () => {
    const run = runGuard(["--dir", path.join(root, "whatever")]);
    assert.equal(run.status, 2);
  });
});
