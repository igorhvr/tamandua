/**
 * MTLK-INTERACTIVE-SUITE US-011 — one-command entrypoint behavioral controls.
 *
 * `scripts/tests/matchlock/run-interactive-suite.sh` is the suite's single
 * documented entrypoint. These controls drive the REAL script with a fake
 * `tamandua`/`matchlock` on PATH and, where a VM tier would boot, a stub
 * `run-cases.sh`:
 *
 *   - a T1-only request runs the no-VM T1 controls, writes fail=0 evidence into
 *     a fresh evidence dir, takes NO gate lock and needs NO image digest;
 *   - a requested VM tier with an unavailable capability refuses with exit 3
 *     and the exact `MTLK-CAPABILITY-UNAVAILABLE` line (never a fake pass);
 *   - a VM tier that produced no observed round makes the entrypoint invoke the
 *     shared observed-rounds guard and exit 92;
 *   - a VM tier that produced an observed round passes the guard and propagates
 *     the component exit code (a failing component with observed rounds is not
 *     masked).
 *
 * The T1 behavioral control runs the real (frozen) driver self-test plus the
 * fixture controls, so it is intentionally slower than the stub controls.
 *
 * This file spawns `bash` (node:child_process) and is therefore classified in
 * the serial lane; it is registered exactly once in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const suiteDir = path.join(repoRoot, "scripts", "tests", "matchlock");
const entrypointPath = path.join(suiteDir, "run-interactive-suite.sh");
const validatorPath = path.join(suiteDir, "validator", "validate-receipts.sh");

/** A well-formed expected image digest (identity evidence only; no VM runs). */
const DIGEST = "sha256:3304d29190fcb84a1e302c10531916e2541483077c06d0beadb366da66bb2e64";

/** Single-quote a string for safe interpolation into a `bash -c` script. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Write an executable stub into `dir` and return its path. */
function writeStub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body, "utf-8");
  chmodSync(file, 0o755);
  return file;
}

/** Create a stub bin dir with executable `tamandua` and `matchlock`. */
function writeStubBin(root: string): string {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeStub(bin, "tamandua", "#!/bin/sh\nexit 0\n");
  writeStub(bin, "matchlock", "#!/bin/sh\necho 'matchlock 0.2.17 (commit: 2afbca3)'\n");
  return bin;
}

/** Populate a minimal (but usable) fabricated operator image store. */
function writeOperatorStore(root: string): string {
  const op = path.join(root, "operator-cache");
  mkdirSync(path.join(op, "images"), { recursive: true });
  mkdirSync(path.join(op, "kernels"), { recursive: true });
  writeFileSync(path.join(op, "images", "metadata.db"), "operator-images-metadata\n");
  writeFileSync(path.join(op, "kernels", "k1"), "kernel-bytes\n");
  return op;
}

/** A bash preamble that clears ambient MTLK_* state so each control is deterministic. */
const RESET = [
  "unset MTLK_COMMON_SOURCED MTLK_MANIFEST_SOURCED MTLK_LOCK_SOURCED MTLK_IMAGE_STORE_SOURCED",
  "unset MTLK_MODE MTLK_EXPECT_DIGEST MTLK_GATE_LOCK MTLK_OPERATOR_CACHE",
  "unset MTLK_MATCHLOCK_RPC_BIN MTLK_GUEST_INIT MTLK_TAMANDUA_BIN MTLK_TAMANDUA_SHA",
  "unset MTLK_REQUIRE_KVM MTLK_KVM_DEVICE MTLK_REQUIRE_GUEST_INIT MTLK_SKIP_BUILD",
  "unset MTLK_RUN_CASES_SH MTLK_T1_FIXTURES_SH MTLK_OBSERVED_ROUNDS_GUARD",
  "unset MTLK_T3_ENABLED MTLK_MODEL_API_KEY TAMANDUA_MODEL_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY",
].join("\n");

interface RunResult {
  status: number | null;
  output: string;
}

/** Spawn `bash -c <script>` with the ambient environment (no env object). */
function runBash(script: string, timeout = 120_000): RunResult {
  const result = spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(
    result.error,
    undefined,
    `failed to spawn the control: ${result.error?.message ?? "unknown"}`,
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("Matchlock interactive entrypoint (MTLK-INTERACTIVE-SUITE US-011)", () => {
  it("runs a T1-only request green, writes fail=0 evidence, and takes no lock", () => {
    const tmp = tamanduaTempDir("mtlk-entrypoint-t1-");
    try {
      const bin = writeStubBin(tmp);
      const ev = path.join(tmp, "evidence");
      const lockDir = path.join(tmp, "lockdir");
      mkdirSync(lockDir, { recursive: true });
      const lock = path.join(lockDir, "gate.lock");

      const script = [
        RESET,
        `export PATH=${shQuote(bin)}:"$PATH"`,
        `export MTLK_GATE_LOCK=${shQuote(lock)}`,
        `exec bash ${shQuote(entrypointPath)} --tier t1 --mode installed ` +
          `--expect-digest ${shQuote(DIGEST)} --evidence-dir ${shQuote(ev)}`,
      ].join("\n");
      const result = runBash(script, 400_000);

      assert.equal(result.status, 0, `T1 entrypoint must exit 0:\n${result.output}`);
      assert.match(result.output, /T1 FIXTURES RESULT: pass=\d+ fail=0/);
      assert.match(result.output, /PTY-SELFTEST-SUMMARY pass=\d+ fail=0/);
      assert.match(result.output, /RUN-CASE FIXTURES RESULT: pass=\d+ fail=0/);
      assert.match(result.output, /VALIDATOR FIXTURES RESULT: pass=\d+ fail=0/);

      for (const log of ["pty-selftest.log", "fixtures-test.log", "fixtures-validator.log"]) {
        const full = path.join(ev, "T1", log);
        assert.ok(existsSync(full), `missing T1 evidence ${full}`);
        assert.match(readFileSync(full, "utf-8"), /pass=\d+ fail=0/);
      }
      const summary = JSON.parse(readFileSync(path.join(ev, "T1", "case-summary.json"), "utf-8"));
      assert.equal(summary.verdict, "PASS");

      // T1-only takes no lock and boots no VM.
      assert.ok(!existsSync(lock), "a T1-only request must not create/take the gate lock");
      assert.ok(!existsSync(path.join(ev, "home")), "a T1-only request must not isolate HOME");

      // The recorded T1 scope is a valid receipt (read from evidence files only).
      const validation = runBash(`exec bash ${shQuote(validatorPath)} ${shQuote(ev)} ${shQuote(DIGEST)}`);
      assert.equal(validation.status, 0, `T1 receipt must validate:\n${validation.output}`);
      assert.match(validation.output, /^VALIDATION-OK /m);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts a T1-only request without an expected digest (no VM, no image store)", () => {
    const tmp = tamanduaTempDir("mtlk-entrypoint-nodigest-");
    try {
      const bin = writeStubBin(tmp);
      const ev = path.join(tmp, "evidence");
      const stub = writeStub(
        tmp,
        "t1-stub.sh",
        [
          "#!/usr/bin/env bash",
          "set -u",
          'ev="$1"',
          'mkdir -p "$ev/T1" "$ev/matrix"',
          'printf \'{"case":"T1","verdict":"PASS","fail_reasons":[],"unowned_new_vms":[]}\\n\' > "$ev/T1/case-summary.json"',
          'printf \'T1 FIXTURES RESULT: pass=1 fail=0\\n\'',
          "exit 0",
          "",
        ].join("\n"),
      );

      const script = [
        RESET,
        `export PATH=${shQuote(bin)}:"$PATH"`,
        `export MTLK_T1_FIXTURES_SH=${shQuote(stub)}`,
        `exec bash ${shQuote(entrypointPath)} --tier t1 --mode installed --evidence-dir ${shQuote(ev)}`,
      ].join("\n");
      const result = runBash(script);
      assert.equal(result.status, 0, `T1-only with no digest must exit 0:\n${result.output}`);

      const identity = readFileSync(path.join(ev, "identity.txt"), "utf-8");
      assert.match(identity, /^mode=installed$/m);
      assert.match(identity, /^expect_digest=$/m, "no digest was provided, so identity records none");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a requested VM tier with exit 3 and MTLK-CAPABILITY-UNAVAILABLE", () => {
    const tmp = tamanduaTempDir("mtlk-entrypoint-cap-");
    try {
      const bin = writeStubBin(tmp);
      const ev = path.join(tmp, "evidence");
      const missingKvm = path.join(tmp, "no-such-kvm");

      const script = [
        RESET,
        `export PATH=${shQuote(bin)}:"$PATH"`,
        "export MTLK_REQUIRE_KVM=1",
        `export MTLK_KVM_DEVICE=${shQuote(missingKvm)}`,
        `exec bash ${shQuote(entrypointPath)} --tier t2 --mode installed ` +
          `--expect-digest ${shQuote(DIGEST)} --evidence-dir ${shQuote(ev)}`,
      ].join("\n");
      const result = runBash(script);
      assert.equal(result.status, 3, `capability refusal must exit 3:\n${result.output}`);
      assert.ok(
        result.output.includes(`MTLK-CAPABILITY-UNAVAILABLE kvm-device-missing:${missingKvm}`),
        `expected the exact capability-unavailable line:\n${result.output}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("invokes the observed-rounds guard after a VM tier and exits 92 on zero rounds", () => {
    const tmp = tamanduaTempDir("mtlk-entrypoint-92-");
    try {
      const bin = writeStubBin(tmp);
      const op = writeOperatorStore(tmp);
      const lockDir = path.join(tmp, "lockdir");
      mkdirSync(lockDir, { recursive: true });
      const lock = path.join(lockDir, "gate.lock");
      const ev = path.join(tmp, "evidence");
      const stub = writeStub(
        tmp,
        "run-cases-zero.sh",
        [
          "#!/usr/bin/env bash",
          "set -u",
          'ev="$1"',
          'mkdir -p "$ev/matrix"',
          ': > "$ev/matrix/run-cases.log"',
          "exit 0",
          "",
        ].join("\n"),
      );

      const script = [
        RESET,
        `export PATH=${shQuote(bin)}:"$PATH"`,
        "export MTLK_REQUIRE_KVM=0 MTLK_REQUIRE_GUEST_INIT=0",
        `export MTLK_OPERATOR_CACHE=${shQuote(op)}`,
        `export MTLK_GATE_LOCK=${shQuote(lock)}`,
        `export MTLK_RUN_CASES_SH=${shQuote(stub)}`,
        `exec bash ${shQuote(entrypointPath)} --tier t2 --mode installed ` +
          `--expect-digest ${shQuote(DIGEST)} --evidence-dir ${shQuote(ev)}`,
      ].join("\n");
      const result = runBash(script);

      assert.equal(result.status, 92, `zero-round PASS must exit 92:\n${result.output}`);
      assert.match(result.output, /no VM round observed/);
      assert.match(readFileSync(path.join(ev, "guard.log"), "utf-8"), /no VM round observed/);
      const rounds = JSON.parse(readFileSync(path.join(ev, "observed-rounds.json"), "utf-8"));
      assert.equal(rounds.observed_rounds, 0);
      assert.deepEqual(rounds.observed_vm_ids, []);
      // Exactly one lock acquisition, at this layer.
      assert.match(readFileSync(path.join(ev, "lock.txt"), "utf-8"), /^HELD /m);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes the guard when a round was observed and propagates the component rc", () => {
    const tmp = tamanduaTempDir("mtlk-entrypoint-rounds-");
    try {
      const bin = writeStubBin(tmp);
      const op = writeOperatorStore(tmp);
      const lockDir = path.join(tmp, "lockdir");
      mkdirSync(lockDir, { recursive: true });
      const lock = path.join(lockDir, "gate.lock");
      const ev = path.join(tmp, "evidence");
      const okStub = writeStub(
        tmp,
        "run-cases-ok.sh",
        [
          "#!/usr/bin/env bash",
          "set -u",
          'ev="$1"',
          'mkdir -p "$ev/matrix" "$ev/t2"',
          'printf \'{"case":"M1","verdict":"PASS","fail_reasons":[],"unowned_new_vms":[],"owned_new_vms":["vm-aaaaaaaa"],"vm_ids_seen":["vm-aaaaaaaa"]}\\n\' > "$ev/t2/case-summary.json"',
          'printf \'MATRIX-PHASE-DONE fake\\n\' > "$ev/matrix/run-cases.log"',
          "exit 0",
          "",
        ].join("\n"),
      );

      const envLines = [
        `export PATH=${shQuote(bin)}:"$PATH"`,
        "export MTLK_REQUIRE_KVM=0 MTLK_REQUIRE_GUEST_INIT=0",
        `export MTLK_OPERATOR_CACHE=${shQuote(op)}`,
        `export MTLK_GATE_LOCK=${shQuote(lock)}`,
      ];
      const ok = runBash(
        [
          RESET,
          ...envLines,
          `export MTLK_RUN_CASES_SH=${shQuote(okStub)}`,
          `exec bash ${shQuote(entrypointPath)} --tier t2 --mode installed ` +
            `--expect-digest ${shQuote(DIGEST)} --evidence-dir ${shQuote(ev)}`,
        ].join("\n"),
      );
      assert.equal(ok.status, 0, `observed round must pass the guard:\n${ok.output}`);
      const rounds = JSON.parse(readFileSync(path.join(ev, "observed-rounds.json"), "utf-8"));
      assert.equal(rounds.observed_rounds, 1);
      assert.deepEqual(rounds.observed_vm_ids, ["vm-aaaaaaaa"]);
      assert.match(readFileSync(path.join(ev, "guard.log"), "utf-8"), /observed-rounds-guard: PASS/);

      // A failing component WITH an observed round is not masked by the guard.
      const ev2 = path.join(tmp, "evidence-fail");
      const failStub = writeStub(
        tmp,
        "run-cases-fail.sh",
        [
          "#!/usr/bin/env bash",
          "set -u",
          'ev="$1"',
          'mkdir -p "$ev/matrix" "$ev/t2"',
          'printf \'{"case":"M1","verdict":"FAIL","fail_reasons":[],"unowned_new_vms":[],"owned_new_vms":["vm-bbbbbbbb"]}\\n\' > "$ev/t2/case-summary.json"',
          ': > "$ev/matrix/run-cases.log"',
          "exit 7",
          "",
        ].join("\n"),
      );
      const fail = runBash(
        [
          RESET,
          ...envLines,
          `export MTLK_RUN_CASES_SH=${shQuote(failStub)}`,
          `exec bash ${shQuote(entrypointPath)} --tier t2 --mode installed ` +
            `--expect-digest ${shQuote(DIGEST)} --evidence-dir ${shQuote(ev2)}`,
        ].join("\n"),
      );
      assert.equal(fail.status, 7, `the failing component rc must propagate:\n${fail.output}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
