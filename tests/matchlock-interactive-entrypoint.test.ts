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
 *   - a VM tier that produced an observed round passes the guard, then the t3
 *     per-case attribution audit requires every REQUESTED t3 case to show its
 *     own observed round (missing/duplicate summaries and cross-case reuse
 *     refuse with exit 93), and the component exit code is propagated (a
 *     failing component with observed rounds is not masked).
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
  symlinkSync,
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
  "unset PROBE_EVIDENCE_ID PROBE_EVIDENCE_ID2 PROBE_EVIDENCE_MODE PROBE_CLAIM_ID PROBE_CLAIM_ID2 PROBE_SKIP_CASE2 PROBE_DUP_M6 PROBE_TAMPER PROBE_MARK_M6 PROBE_NOTRUN",
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

  it("counts genuinely fresh case-owned retained evidence and still refuses stale session dirs", () => {
    // Decisive regression for the E7 t3 halt (zero observed rounds): the TUI
    // cases REMOVE their own matchlock row at close (Rider CLEANUP-1) and never
    // print the raw vm id, so the ONLY identity surface is the retained
    // evidence the close path copies to
    // `<TAMANDUA_STATE_DIR>/matchlock/interactive-sessions/<vmId>/` BEFORE the
    // removal. This control drives the REAL per-case wrapper with a fake
    // driver + fake matchlock (no VM) and the REAL entrypoint derive + guard.
    const tmp = tamanduaTempDir("mtlk-entrypoint-evidence-");
    try {
      const bin = writeStubBin(tmp);
      const op = writeOperatorStore(tmp);
      const lockDir = path.join(tmp, "lockdir");
      mkdirSync(lockDir, { recursive: true });
      const lock = path.join(lockDir, "gate.lock");
      const ev = path.join(tmp, "evidence");
      const suite = path.join(repoRoot, "scripts", "tests", "matchlock");
      const runnerDir = path.join(suite, "runner");

      // Fake matchlock: a valid (empty) inventory and a no-op rm. The VM is
      // already gone by the wrapper's AFTER inventory — exactly the field
      // behaviour — so the registry channels stay empty.
      const ml = writeStub(
        tmp,
        "fake-matchlock.sh",
        [
          "#!/usr/bin/env bash",
          'case "${1:-}" in',
          '  list) printf \'ID  STATUS  IMAGE  CREATED  PID\\n\' ;;',
          '  rm) echo "fake-rm ${2:-}" ;;',
          "  *) exit 0 ;;",
          "esac",
          "",
        ].join("\n"),
      );

      // Fake PTY driver: PASS verdict with NO vm ids in the captured text
      // (the TUI blind spot) and a REAL retained-evidence payload copy. The
      // shape follows PROBE_EVIDENCE_MODE: `payload` (Linux: config.json +
      // logs/) or `logs-only` (macOS/VZ: logs/ only).
      const driver = writeStub(
        tmp,
        "fake-driver.py",
        [
          "#!/usr/bin/env python3",
          "import json, os, sys",
          "case = json.load(open(sys.argv[1])); out = sys.argv[2]",
          "os.makedirs(out, exist_ok=True)",
          "if os.environ.get('PROBE_EVIDENCE_ID'):",
          "    root = os.environ['MTLK_INTERACTIVE_EVIDENCE_ROOT']",
          "    d = os.path.join(root, os.environ['PROBE_EVIDENCE_ID'])",
          "    os.makedirs(os.path.join(d, 'logs'), exist_ok=True)",
          "    open(os.path.join(d, 'logs', 'vm.log'), 'w').write('boot ok\\n')",
          "    if os.environ.get('PROBE_EVIDENCE_MODE', 'payload') == 'payload':",
          "        open(os.path.join(d, 'config.json'), 'w').write('{\"boot-source\": {}}\\n')",
          "claim = os.environ.get('PROBE_CLAIM_ID')",
          "json.dump({'name': case['name'], 'verdict': 'PASS',",
          "           'vm_ids_seen': [claim] if claim else []},",
          "          open(os.path.join(out, case['name'] + '.json'), 'w'))",
          "sys.exit(0)",
          "",
        ].join("\n"),
      );

      const caseJsonA = path.join(tmp, "probe-case-M5.json");
      writeFileSync(
        caseJsonA,
        JSON.stringify({ name: "M5-evidence-probe", argv: ["true"], events: [] }),
      );
      const caseJsonB = path.join(tmp, "probe-case-M6.json");
      writeFileSync(
        caseJsonB,
        JSON.stringify({ name: "M6-evidence-probe", argv: ["true"], events: [] }),
      );

      // Stub run-cases: drives the REAL per-case wrapper in place TWICE, in
      // one suite run, sharing one private evidence root — the field M5→M6
      // sequence. Case 1 (Linux payload shape) takes its id from
      // PROBE_EVIDENCE_ID; case 2 (macOS logs-only shape) from
      // PROBE_EVIDENCE_ID2 (unset => the case observes nothing).
      // A genuine M1-shaped case JSON for the combined-tier fixture (the
      // t2-side execution models the real M1 evidence location).
      const caseJsonM1 = path.join(tmp, "probe-case-M1.json");
      writeFileSync(
        caseJsonM1,
        JSON.stringify({ name: "M1-evidence-probe", argv: ["true"], events: [] }),
      );

      // Second stub: a COMBINED t2+t3 request where t3 is DECLARED NOTRUN
      // (no credentials) while t2 executes - the established NOTRUN semantics
      // must survive (the per-case audit skips the not-run tier, never judges
      // it as an observation).
      const notrunCases = writeStub(
        tmp,
        "run-cases-notrun.sh",
        [
          "#!/usr/bin/env bash",
          "set -u",
          'ev="$1"',
          'mkdir -p "$ev/matrix" "$ev/t2"',
          `. ${shQuote(path.join(suite, "lib", "manifest.sh"))}`,
          'mtlk_manifest_init "$ev" || exit 2',
          'mtlk_manifest_request_tier "$ev" t2 || exit 2',
          'mtlk_manifest_request_tier "$ev" t3 || exit 2',
          'mtlk_manifest_add_case "$ev" t2 M1 1 t2/M1 || exit 2',
          'mtlk_manifest_freeze "$ev" || exit 2',
          `PROBE_EVIDENCE_ID="\${PROBE_EVIDENCE_ID:-}" MTLK_DRIVER=${shQuote(driver)} ` +
            `bash ${shQuote(path.join(runnerDir, "run-case.sh"))} ` +
            `${shQuote(caseJsonM1)} "$ev/t2/M1" ${shQuote(ml)} >> "$ev/matrix/run-case.log" 2>&1`,
          "rc=$?",
          '[ "$rc" = 0 ] || exit "$rc"',
          'mtlk_manifest_mark "$ev" t2 M1 PASS || exit 2',
          'mtlk_manifest_mark "$ev" t2 - PASS || exit 2',
          'mtlk_manifest_mark "$ev" t3 - NOTRUN || exit 2',
          'printf "MATRIX-PHASE-DONE notrun\\n" >> "$ev/matrix/run-cases.log"',
          'exit 0',
          "",
        ].join("\n"),
      );
      const runCases = writeStub(
        tmp,
        "run-cases-evidence.sh",
        [
          "#!/usr/bin/env bash",
          "set -u",
          'ev="$1"',
          'mkdir -p "$ev/matrix" "$ev/t3"',
          `. ${shQuote(path.join(suite, "lib", "manifest.sh"))}`,
          'mtlk_manifest_init "$ev" || exit 2',
          'mtlk_manifest_request_tier "$ev" t3 || exit 2',
          'mtlk_manifest_add_case "$ev" t3 M5 0 t3/M5 || exit 2',
          'mtlk_manifest_add_case "$ev" t3 M6 0 t3/M6 || exit 2',
          'mtlk_manifest_freeze "$ev" || exit 2',
          `PROBE_EVIDENCE_ID="\${PROBE_EVIDENCE_ID:-}" MTLK_DRIVER=${shQuote(driver)} ` +
            `bash ${shQuote(path.join(runnerDir, "run-case.sh"))} ` +
            `${shQuote(caseJsonA)} "$ev/t3/M5" ${shQuote(ml)} >> "$ev/matrix/run-case.log" 2>&1`,
          "rc1=$?",
          'if [ "${PROBE_SKIP_CASE2:-}" = 1 ]; then',
          "  rc2=0",
          "else",
          `  PROBE_EVIDENCE_ID="\${PROBE_EVIDENCE_ID2:-}" PROBE_EVIDENCE_MODE=logs-only ` +
            `PROBE_CLAIM_ID="\${PROBE_CLAIM_ID2:-}" MTLK_DRIVER=${shQuote(driver)} ` +
            `bash ${shQuote(path.join(runnerDir, "run-case.sh"))} ` +
            `${shQuote(caseJsonB)} "$ev/t3/M6" ${shQuote(ml)} >> "$ev/matrix/run-case.log" 2>&1`,
          "  rc2=$?",
          "fi",
          'if [ "${PROBE_DUP_M6:-}" = 1 ]; then mkdir -p "$ev/t3/extra/M6" && cp "$ev/t3/M6/case-summary.json" "$ev/t3/extra/M6/case-summary.json"; fi',
          'if [ "$rc1" = 0 ]; then mtlk_manifest_mark "$ev" t3 M5 PASS || exit 2; fi',
          'if [ "$rc2" = 0 ]; then mtlk_manifest_mark "$ev" t3 M6 "${PROBE_MARK_M6:-PASS}" || exit 2; fi',
          'if [ "$rc1" = 0 ] && [ "$rc2" = 0 ]; then mtlk_manifest_mark "$ev" t3 - PASS || exit 2; fi',
          'if [ "${PROBE_NOTRUN:-}" = 1 ]; then mtlk_manifest_mark "$ev" t3 - NOTRUN || exit 2; fi',
          'case "${PROBE_TAMPER:-}" in',
          '  malform) printf "garbage-row\\n" >> "$ev/manifest/requested.tsv" ;;',
          '  drop_case) TAB=$(printf "\\t"); grep -v "${TAB}M6${TAB}" "$ev/manifest/requested.tsv" > "$ev/manifest/requested.tmp" && mv "$ev/manifest/requested.tmp" "$ev/manifest/requested.tsv" ;;',
          '  no_scope) rm -f "$ev/manifest/scope.count" ;;',
          '  empty_scope) grep -v "^case" "$ev/manifest/requested.tsv" > "$ev/manifest/requested.tmp" && mv "$ev/manifest/requested.tmp" "$ev/manifest/requested.tsv" && printf "scope=1\\n" > "$ev/manifest/scope.count" ;;',
          'esac',
          'printf "MATRIX-PHASE-DONE two-case\\n" >> "$ev/matrix/run-cases.log"',
          '[ "$rc1" = 0 ] || exit "$rc1"',
          'exit "$rc2"',
          "",
        ].join("\n"),
      );

      const envLines = [
        `export PATH=${shQuote(bin)}:"$PATH"`,
        "export MTLK_REQUIRE_KVM=0 MTLK_REQUIRE_GUEST_INIT=0",
        `export MTLK_OPERATOR_CACHE=${shQuote(op)}`,
        `export MTLK_GATE_LOCK=${shQuote(lock)}`,
        `export MTLK_RUN_CASES_SH=${shQuote(runCases)}`,
        `unset MTLK_INTERACTIVE_EVIDENCE_ROOT`,
      ];
      const entrypoint = (evidenceDir: string): string =>
        `exec bash ${shQuote(entrypointPath)} --tier t3 --mode installed ` +
        `--expect-digest ${shQuote(DIGEST)} --evidence-dir ${shQuote(evidenceDir)}`;

      // Seeded configuration (the leg's `seed_hermes_home` precedent) is an
      // INPUT, not an observation: admission must accept it.
      mkdirSync(path.join(ev, "home", ".hermes"), { recursive: true });
      writeFileSync(path.join(ev, "home", ".hermes", "config.yaml"), "model: fixture-only\n");

      // (1) GENUINELY FRESH case-owned evidence across TWO sequential cases in
      // ONE suite run — the field M5→M6 sequence. Each case must observe ONLY
      // its own new retained dir: case 2 runs after case 1, so case 1's dir is
      // in case 2's baseline and must NOT be re-attributed. Case 2 uses the
      // macOS/VZ logs-only shape (no config.json). The derived count is the
      // distinct union of both cases' observations, so the guard sees 2 rounds.
      const fresh = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "export PROBE_EVIDENCE_ID=vm-a1b2c3d4 PROBE_EVIDENCE_ID2=vm-c6d7e8f9",
          entrypoint(ev),
        ].join("\n"),
      );
      assert.equal(fresh.status, 0, `fresh evidence must pass the guard:\n${fresh.output}`);
      const freshRounds = JSON.parse(
        readFileSync(path.join(ev, "observed-rounds.json"), "utf-8"),
      );
      assert.equal(freshRounds.observed_rounds, 2);
      assert.deepEqual(freshRounds.observed_vm_ids, ["vm-a1b2c3d4", "vm-c6d7e8f9"]);
      assert.match(
        readFileSync(path.join(ev, "guard.log"), "utf-8"),
        /observed-rounds-guard: PASS/,
      );
      // The per-case attribution audit passed: BOTH requested cases have their
      // own observed round and neither id is claimed twice.
      assert.match(
        readFileSync(path.join(ev, "attribution.log"), "utf-8"),
        /t3-attribution: OK cases=M5,M6 ids=vm-a1b2c3d4,vm-c6d7e8f9/,
      );
      // Case 1 (Linux payload shape) ran to completion (driver PASS, no
      // unrelated failures) and recorded its id as case-owned observation,
      // NOT as cleanup authority. Both legacy channels stayed empty — the id
      // came from the retained evidence channel alone (the E7-t3 blind spot).
      const freshSummary = JSON.parse(
        readFileSync(path.join(ev, "t3", "M5", "case-summary.json"), "utf-8"),
      );
      assert.equal(freshSummary.verdict, "PASS", `wrapper must complete cleanly:\n${fresh.output}`);
      assert.equal(freshSummary.driver_rc, 0);
      assert.deepEqual(freshSummary.fail_reasons, []);
      assert.deepEqual(freshSummary.interactive_evidence_new_vms, ["vm-a1b2c3d4"]);
      assert.deepEqual(freshSummary.vm_ids_seen, []);
      assert.deepEqual(freshSummary.owned_new_vms, []);

      // Case 2: its baseline contained case 1's dir (excluded by the diff) and
      // it reports ONLY its own new dir — no re-attribution.
      const freshSummaryB = JSON.parse(
        readFileSync(path.join(ev, "t3", "M6", "case-summary.json"), "utf-8"),
      );
      assert.equal(freshSummaryB.verdict, "PASS");
      assert.equal(freshSummaryB.driver_rc, 0);
      assert.deepEqual(freshSummaryB.fail_reasons, []);
      assert.deepEqual(
        freshSummaryB.interactive_evidence_new_vms,
        ["vm-c6d7e8f9"],
        "the second case must claim only its own new dir, never the first case's",
      );
      assert.deepEqual(freshSummaryB.vm_ids_seen, []);
      assert.deepEqual(freshSummaryB.owned_new_vms, []);
      const beforeB = JSON.parse(
        readFileSync(path.join(ev, "t3", "M6", "interactive-evidence-before.json"), "utf-8"),
      );
      assert.equal(beforeB.status, "ok");
      assert.ok(
        beforeB.names.includes("vm-a1b2c3d4"),
        "case 2's baseline must contain case 1's retained dir (it is excluded by the diff)",
      );
      // Both host shapes are real on disk: case 1 has config.json + logs/,
      // case 2 (logs-only) has NO config.json.
      const evRoot = path.join(ev, "state", "matchlock", "interactive-sessions");
      assert.ok(existsSync(path.join(evRoot, "vm-a1b2c3d4", "config.json")));
      assert.ok(existsSync(path.join(evRoot, "vm-a1b2c3d4", "logs", "vm.log")));
      assert.ok(!existsSync(path.join(evRoot, "vm-c6d7e8f9", "config.json")));
      assert.ok(existsSync(path.join(evRoot, "vm-c6d7e8f9", "logs", "vm.log")));

      // (2) MIXED stale + fresh: a dir present at the baseline is excluded
      // even while the case legitimately observes its own new id — only the
      // fresh id counts ("historical ids are never re-attributed"). The
      // run-level guard passes on that one fresh round, but the per-case
      // attribution audit REFUSES: M6's requested case observed no round of
      // its own, and a roundless case must never ride on its sibling's round.
      const evMixed = path.join(tmp, "evidence-mixed");
      const staleMixed = path.join(
        evMixed, "state", "matchlock", "interactive-sessions", "vm-0badc0de", "logs",
      );
      mkdirSync(staleMixed, { recursive: true });
      writeFileSync(path.join(staleMixed, "vm.log"), "stale\n");
      const mixed = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "export PROBE_EVIDENCE_ID=vm-cafe0123",
          entrypoint(evMixed),
        ].join("\n"),
      );
      assert.equal(
        mixed.status,
        93,
        `mixed stale+fresh must count only the fresh id and refuse the roundless sibling:\n${mixed.output}`,
      );
      assert.match(readFileSync(path.join(evMixed, "guard.log"), "utf-8"), /observed-rounds-guard: PASS/);
      assert.match(
        readFileSync(path.join(evMixed, "attribution.log"), "utf-8"),
        /M6: no observed VM round/,
      );
      const mixedRounds = JSON.parse(
        readFileSync(path.join(evMixed, "observed-rounds.json"), "utf-8"),
      );
      assert.deepEqual(mixedRounds.observed_vm_ids, ["vm-cafe0123"]);
      const mixedSummary = JSON.parse(
        readFileSync(path.join(evMixed, "t3", "M5", "case-summary.json"), "utf-8"),
      );
      assert.deepEqual(mixedSummary.interactive_evidence_new_vms, ["vm-cafe0123"]);
      // Case 2 saw the stale dir AND case 1's dir in its baseline and observed
      // nothing new: its list must be empty and the union must not gain ids.
      const mixedSummaryB = JSON.parse(
        readFileSync(path.join(evMixed, "t3", "M6", "case-summary.json"), "utf-8"),
      );
      assert.equal(mixedSummaryB.verdict, "PASS");
      assert.deepEqual(mixedSummaryB.interactive_evidence_new_vms, []);

      // (2b) CROSS-CASE REUSE: case 2's captured text claims case 1's freshly
      // observed id while case 2 also has its own - one VM id attributed to
      // two cases is ambiguous and the per-case audit refuses (93).
      const evReuse = path.join(tmp, "evidence-reuse");
      const reuse = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "export PROBE_EVIDENCE_ID=vm-a1b2c3d4 PROBE_EVIDENCE_ID2=vm-c6d7e8f9 PROBE_CLAIM_ID2=vm-a1b2c3d4",
          entrypoint(evReuse),
        ].join("\n"),
      );
      assert.equal(reuse.status, 93, `a cross-case id claim must refuse: ${reuse.output}`);
      assert.match(readFileSync(path.join(evReuse, "attribution.log"), "utf-8"), /ambiguous-attribution: vm-a1b2c3d4 claimed by M5 and M6/);
      assert.match(readFileSync(path.join(evReuse, "guard.log"), "utf-8"), /observed-rounds-guard: PASS/);

      // (2c) MISSING SUMMARY: the run reports the tier green but case 2 left no
      // case-summary at its recorded evidence path - refuse (93).
      const evMissing = path.join(tmp, "evidence-missing");
      const missing = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "export PROBE_EVIDENCE_ID=vm-a1b2c3d4 PROBE_SKIP_CASE2=1",
          entrypoint(evMissing),
        ].join("\n"),
      );
      assert.equal(missing.status, 93, `a missing case summary must refuse: ${missing.output}`);
      assert.match(readFileSync(path.join(evMissing, "attribution.log"), "utf-8"), /M6: missing-summary/);

      // (2d) DUPLICATE SUMMARY: a second case-summary.json for the same case
      // (a tier copy) is ambiguous - refuse (93).
      const evDup = path.join(tmp, "evidence-dup");
      const dup = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "export PROBE_EVIDENCE_ID=vm-a1b2c3d4 PROBE_EVIDENCE_ID2=vm-c6d7e8f9 PROBE_DUP_M6=1",
          entrypoint(evDup),
        ].join("\n"),
      );
      assert.equal(dup.status, 93, `a duplicate case summary must refuse: ${dup.output}`);
      assert.match(readFileSync(path.join(evDup, "attribution.log"), "utf-8"), /M6: duplicate-summaries/);

      // (2e) PLACEHOLDER-ONLY: case 2's only candidate is matchlock's
      // vm-00000000 placeholder - never a real round, refuse (93).
      const evPlaceholder = path.join(tmp, "evidence-placeholder");
      const placeholder = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "export PROBE_EVIDENCE_ID=vm-a1b2c3d4 PROBE_EVIDENCE_ID2=vm-00000000",
          entrypoint(evPlaceholder),
        ].join("\n"),
      );
      assert.equal(placeholder.status, 93, `a placeholder-only case must refuse: ${placeholder.output}`);
      assert.match(readFileSync(path.join(evPlaceholder, "attribution.log"), "utf-8"), /M6: no observed VM round/);

      // (2f) MANIFEST TAMPER: a manifest whose scope drifted after freeze (a
      // requested row dropped, the frozen snapshot removed, or a malformed
      // row injected) must refuse (93) - the audit's obligations can never
      // be silently shrunk.
      for (const [label, want, extraEnv] of [
        ["malform", /malformed-manifest-rows/, "export PROBE_TAMPER=malform"],
        ["drop_case", /manifest-scope-mismatch/, "export PROBE_TAMPER=drop_case"],
        ["no_scope", /manifest-scope-unreadable/, "export PROBE_TAMPER=no_scope"],
        ["fail_case", /manifest-case-status=FAIL/, "export PROBE_MARK_M6=FAIL"],
        ["notrun_conflict", /tier-NOTRUN-with-case-records/, "export PROBE_NOTRUN=1"],
        ["empty_scope", /tier-executed-but-no-requested-case-rows/, "export PROBE_TAMPER=empty_scope"],
      ] as const) {
        const evT = path.join(tmp, `evidence-tamper-${label}`);
        const t = runBash(
          [
            RESET,
            ...envLines,
            "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
            "export PROBE_EVIDENCE_ID=vm-a1b2c3d4 PROBE_EVIDENCE_ID2=vm-c6d7e8f9",
            extraEnv,
            entrypoint(evT),
          ].join("\n"),
        );
        assert.equal(t.status, 93, `tampered manifest (${label}) must refuse: ${t.output}`);
        assert.match(readFileSync(path.join(evT, "attribution.log"), "utf-8"), want);
      }

      // (2g) TERMINAL-TEXT-ONLY: a case whose only identity comes from the
      // captured terminal text is NOT sufficient proof of its own fresh VM
      // round - the per-case audit refuses (93) even though the run-level
      // guard accepts the text-listed id.
      const evTextOnly = path.join(tmp, "evidence-text-only");
      const textOnly = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "export PROBE_EVIDENCE_ID=vm-a1b2c3d4 PROBE_CLAIM_ID2=vm-c6d7e8f9",
          entrypoint(evTextOnly),
        ].join("\n"),
      );
      assert.equal(textOnly.status, 93, `text-only attribution must refuse: ${textOnly.output}`);
      assert.match(readFileSync(path.join(evTextOnly, "guard.log"), "utf-8"), /observed-rounds-guard: PASS/);
      assert.match(
        readFileSync(path.join(evTextOnly, "attribution.log"), "utf-8"),
        /M6: no fresh retained-evidence or case-scoped ownership observation/,
      );

      // (3) STALE pre-existing session dirs (present at the case's baseline,
      // so excluded by name) must NOT be counted — the guard still refuses.
      // The wrapper itself still completes cleanly (driver PASS, no fail
      // reasons): the refusal is the run-level guard's, exactly as designed.
      const ev2 = path.join(tmp, "evidence-stale");
      const staleRoot = path.join(ev2, "state", "matchlock", "interactive-sessions", "vm-0badc0de", "logs");
      mkdirSync(staleRoot, { recursive: true });
      writeFileSync(path.join(staleRoot, "vm.log"), "stale\n");
      const stale = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "unset PROBE_EVIDENCE_ID",
          entrypoint(ev2),
        ].join("\n"),
      );
      assert.equal(stale.status, 92, `stale-only evidence must still refuse:\n${stale.output}`);
      const staleRounds = JSON.parse(
        readFileSync(path.join(ev2, "observed-rounds.json"), "utf-8"),
      );
      assert.equal(staleRounds.observed_rounds, 0);
      assert.deepEqual(staleRounds.observed_vm_ids, []);
      const staleSummary = JSON.parse(
        readFileSync(path.join(ev2, "t3", "M5", "case-summary.json"), "utf-8"),
      );
      assert.equal(staleSummary.driver_rc, 0, "the case itself must complete (refusal is the guard's)");
      assert.equal(staleSummary.verdict, "PASS", "the case must pass; the guard is what refuses");
      assert.deepEqual(staleSummary.fail_reasons, []);
      assert.deepEqual(
        staleSummary.interactive_evidence_new_vms,
        [],
        "a stale session dir must not be recorded as a new case-owned round",
      );
      const staleSummaryB = JSON.parse(
        readFileSync(path.join(ev2, "t3", "M6", "case-summary.json"), "utf-8"),
      );
      assert.equal(staleSummaryB.verdict, "PASS");
      assert.deepEqual(staleSummaryB.interactive_evidence_new_vms, []);
      // The stale dir is still on disk (observed but never counted).
      assert.ok(existsSync(path.join(staleRoot, "vm.log")), "the stale dir must never be consumed");
      assert.doesNotMatch(stale.output, /T3-ATTRIBUTION REFUSAL/);
      assert.ok(
        !existsSync(path.join(ev2, "attribution.log")),
        "the per-case audit must not run after a stale-only refusal",
      );
      assert.match(readFileSync(path.join(ev2, "guard.log"), "utf-8"), /no VM round observed/);

      // (4) GENUINELY-ZERO rounds (no session dirs at all) must still refuse.
      const ev3 = path.join(tmp, "evidence-zero");
      const zero = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "unset PROBE_EVIDENCE_ID",
          entrypoint(ev3),
        ].join("\n"),
      );
      assert.equal(zero.status, 92, `zero rounds must still refuse:\n${zero.output}`);
      assert.equal(
        JSON.parse(readFileSync(path.join(ev3, "observed-rounds.json"), "utf-8")).observed_rounds,
        0,
      );
      // Causal check (same as the stale scenario): the refusal must not mask a
      // broken wrapper — BOTH cases ran, their drivers passed, and each case
      // observed nothing.
      const zeroSummaryA = JSON.parse(
        readFileSync(path.join(ev3, "t3", "M5", "case-summary.json"), "utf-8"),
      );
      assert.equal(zeroSummaryA.driver_rc, 0);
      assert.equal(zeroSummaryA.verdict, "PASS");
      assert.deepEqual(zeroSummaryA.interactive_evidence_new_vms, []);
      const zeroSummaryB = JSON.parse(
        readFileSync(path.join(ev3, "t3", "M6", "case-summary.json"), "utf-8"),
      );
      assert.equal(zeroSummaryB.driver_rc, 0);
      assert.equal(zeroSummaryB.verdict, "PASS");
      assert.deepEqual(zeroSummaryB.interactive_evidence_new_vms, []);
      assert.match(readFileSync(path.join(ev3, "guard.log"), "utf-8"), /no VM round observed/);
      assert.doesNotMatch(zero.output, /T3-ATTRIBUTION REFUSAL/);
      assert.ok(
        !existsSync(path.join(ev3, "attribution.log")),
        "the per-case audit must not run after a zero-round refusal",
      );

      // (5) A reused dir containing a SYMLINKED directory cannot be proven
      // fresh (the derive's trailing-`**` glob would follow it): refused.
      // NOTE: this is a deliberate compatibility restriction for reused
      // evidence dirs; genuine runs never contain directory symlinks.
      const ev6 = path.join(tmp, "evidence-symlinked-dir");
      const realDir = path.join(ev6, "state", "real");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, path.join(ev6, "state", "alias"));
      const symlinked = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "unset PROBE_EVIDENCE_ID",
          entrypoint(ev6),
        ].join("\n"),
      );
      assert.equal(
        symlinked.status,
        2,
        `a symlinked evidence subdir must refuse admission:\n${symlinked.output}`,
      );
      assert.match(symlinked.output, /MTLK-ABORT evidence-dir-not-fresh/);
      assert.match(symlinked.output, /symlinked directory/);

      // (6) A reused dir holding the M7 spot-run log (a third derive input)
      // is refused the same way.
      const ev7 = path.join(tmp, "evidence-stale-m7");
      mkdirSync(path.join(ev7, "M7"), { recursive: true });
      writeFileSync(path.join(ev7, "M7", "m7.log"), "owned=[vm-deadbeef]\n");
      const staleM7 = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "unset PROBE_EVIDENCE_ID",
          entrypoint(ev7),
        ].join("\n"),
      );
      assert.equal(staleM7.status, 2, `a stale M7 log must refuse admission:\n${staleM7.output}`);
      assert.match(staleM7.output, /MTLK-ABORT evidence-dir-not-fresh/);

      // (7) A reused evidence dir holding a PREVIOUS run's OBSERVATION outputs
      // (observed-rounds.json / case summaries) is refused at admission: the
      // derive step would otherwise re-consume them and let this run report
      // rounds it never observed. Stale session dirs (an INPUT) are allowed;
      // stale observations are not.
      const ev4 = path.join(tmp, "evidence-stale-receipt");
      mkdirSync(ev4, { recursive: true });
      writeFileSync(
        path.join(ev4, "observed-rounds.json"),
        JSON.stringify({ gate: "interactive", observed_rounds: 3, observed_vm_ids: ["vm-deadbeef"] }),
      );
      const staleReceipt = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "unset PROBE_EVIDENCE_ID",
          entrypoint(ev4),
        ].join("\n"),
      );
      assert.equal(staleReceipt.status, 2, `a stale rounds receipt must refuse admission:\n${staleReceipt.output}`);
      assert.match(staleReceipt.output, /MTLK-ABORT evidence-dir-not-fresh/);
      assert.ok(
        !existsSync(path.join(ev4, "guard.log")),
        "the guard must never run against a stale receipt",
      );
      assert.equal(
        JSON.parse(readFileSync(path.join(ev4, "observed-rounds.json"), "utf-8")).observed_rounds,
        3,
        "the stale receipt must be left untouched (refused, not rewritten)",
      );

      // (8) Same for a reused dir holding a previous run's case summary.
      const ev5 = path.join(tmp, "evidence-stale-summary");
      mkdirSync(path.join(ev5, "t3", "M5"), { recursive: true });
      writeFileSync(
        path.join(ev5, "t3", "M5", "case-summary.json"),
        JSON.stringify({ case: "M5", verdict: "PASS", owned_new_vms: ["vm-deadbeef"] }),
      );
      const staleSummaryRefusal = runBash(
        [
          RESET,
          ...envLines,
          "export MTLK_T3_ENABLED=1 MTLK_MODEL_API_KEY=fixture-only",
          "unset PROBE_EVIDENCE_ID",
          entrypoint(ev5),
        ].join("\n"),
      );
      assert.equal(
        staleSummaryRefusal.status,
        2,
        `a stale case summary must refuse admission:\n${staleSummaryRefusal.output}`,
      );
      assert.match(staleSummaryRefusal.output, /MTLK-ABORT evidence-dir-not-fresh/);

      // (9) COMBINED t2+t3 with t3 DECLARED NOTRUN: the established NOTRUN
      // semantics survive - the per-case audit skips the not-run tier (a
      // declared non-success is never judged as an observation of evidence)
      // and the run stays green on t2's genuine round.
      const evNotrun = path.join(tmp, "evidence-notrun");
      const notrun = runBash(
        [
          RESET,
          ...envLines,
          `export MTLK_RUN_CASES_SH=${shQuote(notrunCases)}`,
          "export PROBE_EVIDENCE_ID=vm-11112222",
          `exec bash ${shQuote(entrypointPath)} --tier t2 --tier t3 --mode installed ` +
            `--expect-digest ${shQuote(DIGEST)} --evidence-dir ${shQuote(evNotrun)}`,
        ].join("\n"),
      );
      assert.equal(notrun.status, 0, `a declared-NOTRUN t3 must not manufacture an attribution failure: ${notrun.output}`);
      assert.match(readFileSync(path.join(evNotrun, "attribution.log"), "utf-8"), /SKIP t3 declared NOTRUN/);
      assert.match(readFileSync(path.join(evNotrun, "guard.log"), "utf-8"), /observed-rounds-guard: PASS/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
