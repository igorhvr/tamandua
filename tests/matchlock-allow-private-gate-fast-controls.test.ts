/**
 * MTLK-ALLOW-PRIVATE US-009 — fast, pure-filesystem, NO-VM controls for the
 * on-demand real-VM allow-private gate (run-matchlock-allow-private-e2e-test +
 * e2e-tests/matchlock-allow-private-gate.test.ts).
 *
 * These controls never boot a VM, spawn a daemon or touch matchlock:
 *
 *   1. the runner exists, is executable, builds first, takes the SHARED gate
 *      lock, launches the gate via `node --test`, propagates the exit code and
 *      refuses a zero-round pass through scripts/observed-rounds-guard.mjs;
 *   2. the gate file carries the opt-in header, records both the with-flag
 *      (curl exit 0) and without-flag (curl refused) rounds, and asserts the
 *      daemon env excludes TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE;
 *   3. the gate's argument/evidence logic (run args, curl-probe marker parsing,
 *      daemon-env sanitation, observed-rounds evidence) behaves correctly;
 *   4. the new gate is NOT wired into any default fast lane, and the synthetic
 *      pi in-guest curl probe stays DEFAULT-OFF.
 *
 * Pure filesystem + pure-logic reads (no child_process, no dist source
 * dependency) -> parallel lane, no tests/serial-files.txt entry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../dist/lib/temp-dir.js";
import {
  ALLOW_PRIVATE_ENV,
  ALLOW_PRIVATE_FLAG,
  ALLOW_PRIVATE_GATE_LABEL,
  ALLOW_PRIVATE_PROBE_URL,
  CURL_PROBE_ENV,
  PROBE_MARKER_DIR,
  PROBE_MARKER_FILE,
  TEMP_ALLOW_PRIVATE_ENV,
  assertCurlProbeReached,
  assertCurlProbeRefused,
  buildDoNowRunArgs,
  curlProbeMarkerPath,
  daemonEnvLeaksTempExemption,
  parseCurlProbeMarker,
  readCurlProbeMarker,
  withoutTempAllowPrivate,
} from "../e2e-tests/helpers/matchlock-allow-private-probe.ts";
import {
  assertObservedRoundsNonZero,
  readObservedRoundsEvidence,
  writeObservedRoundsEvidence,
} from "../e2e-tests/helpers/matchlock-gate-rounds.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

const RUNNER = "run-matchlock-allow-private-e2e-test";
const GATE = "e2e-tests/matchlock-allow-private-gate.test.ts";
const PROBE_HELPER = "e2e-tests/helpers/matchlock-allow-private-probe.ts";
const SYNTHETIC_PI = "e2e-tests/matchlock-fixture/synthetic-pi.mjs";
const SYNTHETIC_DOCKERFILE = "e2e-tests/matchlock-fixture/Dockerfile.synthetic-pi";

const FAST_LANES = [
  "run-all-e2e-tests",
  "run-all-smoke-e2e-tests",
  "run-all-scripted-e2e-tests",
] as const;

const NOT_A_FAST_LANE_HEADER = "NOT part of any default fast lane";
const SHARED_GATE_LOCK = "/home/kaladin/matchlock-work/vaivm-gate.lock";

function read(relativePath: string): string {
  const absolute = path.join(repoRoot, relativePath);
  assert.ok(fs.existsSync(absolute), `${relativePath} must exist`);
  return fs.readFileSync(absolute, "utf-8");
}

describe("US-009 allow-private gate: runner wiring (no VM)", () => {
  it("ships an executable runner and the gate driver", () => {
    const runnerPath = path.join(repoRoot, RUNNER);
    assert.ok(fs.existsSync(runnerPath), `${RUNNER} must exist`);
    fs.accessSync(runnerPath, fs.constants.X_OK);
    const script = read(RUNNER);
    assert.match(script, /^#!\/usr\/bin\/env bash/, "the runner must be a bash script");
    assert.ok(fs.existsSync(path.join(repoRoot, GATE)), `${GATE} must exist`);
  });

  it("builds first and takes the shared gate lock", () => {
    const script = read(RUNNER);
    assert.ok(script.includes("npm run build"), "the runner must build before the gate");
    assert.ok(script.includes("flock --exclusive"), "the runner must take the shared gate lock");
    assert.ok(
      script.includes(SHARED_GATE_LOCK),
      "the runner must default to the canonical shared gate lock",
    );
  });

  it("launches exactly the gate via node --test and propagates its exit code", () => {
    const script = read(RUNNER);
    assert.ok(
      script.includes(`node --test --test-force-exit ${GATE}`),
      `the runner must launch exactly ${GATE} via node --test`,
    );
    assert.ok(script.includes("PIPESTATUS[0]"), "the runner must capture the producer exit code");
    assert.match(script, /exit "\$RC"/, "the runner must propagate the gate exit code");
  });

  it("allocates a fresh mktemp evidence dir and a private HOME/TMPDIR", () => {
    const script = read(RUNNER);
    assert.ok(script.includes("mktemp -d"), "the runner must allocate a fresh evidence dir");
    assert.match(script, /export HOME=/, "the runner must export a private HOME");
    assert.match(script, /export TMPDIR=/, "the runner must export a private TMPDIR");
    assert.ok(script.includes("TAMANDUA_GATE_OPERATOR_CACHE"), "the runner must pass the operator cache");
  });

  it("unsets the temporary host exemption before launching the gate", () => {
    const script = read(RUNNER);
    assert.ok(
      script.includes(`unset ${TEMP_ALLOW_PRIVATE_ENV}`),
      `the runner must unset ${TEMP_ALLOW_PRIVATE_ENV} so the daemon cannot inherit it`,
    );
  });

  it("refuses a zero-round PASS through the shared guard after node --test", () => {
    const script = read(RUNNER);
    const testAt = script.indexOf("node --test");
    const guardAt = script.indexOf("scripts/observed-rounds-guard.mjs");
    assert.ok(testAt >= 0, "the runner must run node --test");
    assert.ok(guardAt > testAt, "the observed-rounds guard must run AFTER node --test");
    assert.ok(script.includes('--dir "$EV"'), "the guard must read the runner's own evidence dir");
    assert.ok(
      script.includes(`--gate ${ALLOW_PRIVATE_GATE_LABEL}`),
      `the guard must be labelled ${ALLOW_PRIVATE_GATE_LABEL}`,
    );
    assert.match(script, /exit 92/, "the runner must exit 92 on a zero-round refusal");
  });

  it("resolves the system runtime (unpinned) and records observed evidence", () => {
    const script = read(RUNNER);
    assert.match(script, /command -v matchlock/, "the runner must resolve matchlock from PATH");
    for (const envName of ["TAMANDUA_MATCHLOCK_RPC_BIN", "MATCHLOCK_GUEST_INIT", "MATCHLOCK_GUEST_FUSED"]) {
      assert.ok(script.includes(envName), `the runner must honor ${envName}`);
    }
    assert.ok(script.includes("--version"), "the runner must record matchlock --version");
    assert.ok(script.includes("runtime-observed.txt"), "the runner must write runtime-observed.txt");
    assert.doesNotMatch(script, /\b[0-9a-f]{40}\b/, "the runner must not pin a 40-hex commit");
    assert.doesNotMatch(script, /\b[0-9a-f]{64}\b/, "the runner must not pin a 64-hex digest");
  });
});

describe("US-009 allow-private gate: driver contract (no VM)", () => {
  const gate = read(GATE);

  it("carries the opt-in header and the allow-private gate label", () => {
    assert.ok(gate.includes(NOT_A_FAST_LANE_HEADER), `${GATE} must document that it is opt-in`);
    assert.ok(
      gate.includes(`GATE_LABEL = "${ALLOW_PRIVATE_GATE_LABEL}"`),
      `the driver must define the ${ALLOW_PRIVATE_GATE_LABEL} gate label`,
    );
    assert.ok(gate.includes("run-matchlock-allow-private-e2e-test"), "the driver must name its runner");
  });

  it("records the with-flag AND without-flag rounds (curl reached / refused)", () => {
    assert.ok(gate.includes("assertCurlProbeReached("), "the driver must assert the reachable round");
    assert.ok(gate.includes("assertCurlProbeRefused("), "the driver must assert the refused round");
    assert.ok(
      gate.includes("buildDoNowRunArgs("),
      "the driver must build both do-now runs through the shared argv helper",
    );
    assert.ok(
      gate.includes("allowPrivate: [ALLOW_PRIVATE_PROBE_URL]"),
      "run A must pass the allow-private endpoint",
    );
  });

  it("asserts the daemon env excludes the temporary host exemption", () => {
    assert.ok(
      gate.includes(TEMP_ALLOW_PRIVATE_ENV),
      "the driver must name the temporary exemption it forbids",
    );
    assert.ok(
      gate.includes("daemonEnvLeaksTempExemption("),
      "the driver must assert the daemon env has no temporary exemption",
    );
    assert.ok(
      gate.includes("withoutTempAllowPrivate("),
      "the driver must defensively strip the temporary exemption before starting the daemon",
    );
  });

  it("uses the shared observed-rounds helper with the distinct observed count", () => {
    assert.ok(
      gate.includes('from "./helpers/matchlock-gate-rounds.ts"'),
      "the driver must import the shared observed-rounds helper",
    );
    assert.ok(gate.includes("writeObservedRoundsEvidence("), "the driver must write the evidence");
    assert.ok(
      gate.includes("assertObservedRoundsNonZero("),
      "the driver must refuse a zero-round in-process result",
    );
    assert.match(gate, /new Set\(observedVmIds\)\.size/, "rounds must be the distinct VM-id count");
    assert.match(gate, /observed_rounds:\s*observedRounds/, "the evidence must carry the observed count");
  });

  it("asserts fresh distinct VM ids and positive exact-owned teardown", () => {
    assert.ok(gate.includes("readRunnerVmEvidenceIds("), "the driver must read the runner's VM evidence");
    assert.ok(
      gate.includes("cleanupOwnedVms("),
      "the driver must positively dispose every owned VM by exact id",
    );
    assert.ok(gate.includes("assertNoOwnedVms("), "the driver must assert no owned VM remains");
    assert.ok(gate.includes("vm-cleanup-ledger.txt"), "the driver must retain the cleanup ledger");
  });
});

describe("US-009 allow-private gate: argument + evidence logic (no VM)", () => {
  it("builds the exact do-now argv with a repeatable --matchlock-allow-private pair", () => {
    const args = buildDoNowRunArgs({
      workDir: "/work/wd",
      prompt: "do it",
      imageTag: "fixture:tag",
      allowPrivate: [ALLOW_PRIVATE_PROBE_URL],
    });
    assert.deepEqual(args, [
      "workflow",
      "run",
      "do-now",
      "do it",
      "--working-directory-for-harness",
      "/work/wd",
      "--matchlock",
      "fixture:tag",
      ALLOW_PRIVATE_FLAG,
      ALLOW_PRIVATE_PROBE_URL,
    ]);
    const without = buildDoNowRunArgs({
      workDir: "/work/wd",
      prompt: "do it",
      imageTag: "fixture:tag",
    });
    assert.ok(!without.includes(ALLOW_PRIVATE_FLAG), "no flag may be emitted for an empty list");
  });

  it("keeps the vocabulary coherent", () => {
    assert.equal(ALLOW_PRIVATE_ENV, "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE");
    assert.equal(ALLOW_PRIVATE_GATE_LABEL, "allow-private");
    assert.equal(CURL_PROBE_ENV, "TAMANDUA_SYNTHETIC_PI_CURL_URL");
    assert.equal(TEMP_ALLOW_PRIVATE_ENV, "TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE");
    assert.equal(PROBE_MARKER_DIR, ".matchlock-synthetic-pi");
    assert.equal(PROBE_MARKER_FILE, "curl-probe.json");
  });

  it("strictly parses a curl-probe marker and rejects malformed shapes", () => {
    const ok = parseCurlProbeMarker(
      JSON.stringify({ url: ALLOW_PRIVATE_PROBE_URL, exitCode: 0, stdout: "hello" }),
    );
    assert.deepEqual(ok, { url: ALLOW_PRIVATE_PROBE_URL, exitCode: 0, stdout: "hello" });
    assert.throws(() => parseCurlProbeMarker("not json"), /malformed curl-probe marker JSON/);
    assert.throws(() => parseCurlProbeMarker("[]"), /expected a JSON object/);
    assert.throws(
      () => parseCurlProbeMarker(JSON.stringify({ url: "", exitCode: 0, stdout: "" })),
      /url must be a non-empty string/,
    );
    assert.throws(
      () => parseCurlProbeMarker(JSON.stringify({ url: "x", exitCode: 0.5, stdout: "" })),
      /exitCode must be a safe integer/,
    );
    assert.throws(
      () => parseCurlProbeMarker(JSON.stringify({ url: "x", exitCode: 0, stdout: 4 })),
      /stdout must be a string/,
    );
  });

  it("asserts reached (exit 0 + body) and refused (nonzero) rounds", () => {
    assert.doesNotThrow(() =>
      assertCurlProbeReached({ url: ALLOW_PRIVATE_PROBE_URL, exitCode: 0, stdout: "pong" }),
    );
    assert.throws(
      () => assertCurlProbeReached({ url: ALLOW_PRIVATE_PROBE_URL, exitCode: 7, stdout: "" }),
      /must exit 0, got 7/,
    );
    assert.throws(
      () => assertCurlProbeReached({ url: ALLOW_PRIVATE_PROBE_URL, exitCode: 0, stdout: "   " }),
      /recorded no response body/,
    );
    assert.doesNotThrow(() => assertCurlProbeRefused({ url: ALLOW_PRIVATE_PROBE_URL, exitCode: 7, stdout: "" }));
    assert.throws(
      () => assertCurlProbeRefused({ url: ALLOW_PRIVATE_PROBE_URL, exitCode: 0, stdout: "should not happen" }),
      /must fail \(refusal\)/,
    );
  });

  it("reads a marker from a mounted working directory", () => {
    const workDir = tamanduaTempDir("tamandua-allow-private-probe-");
    try {
      fs.mkdirSync(path.join(workDir, PROBE_MARKER_DIR), { recursive: true });
      fs.writeFileSync(
        curlProbeMarkerPath(workDir),
        `${JSON.stringify({ url: ALLOW_PRIVATE_PROBE_URL, exitCode: 0, stdout: "pong" })}\n`,
        "utf-8",
      );
      assert.deepEqual(readCurlProbeMarker(workDir), {
        url: ALLOW_PRIVATE_PROBE_URL,
        exitCode: 0,
        stdout: "pong",
      });
      assert.throws(
        () => readCurlProbeMarker(path.join(workDir, "missing")),
        /curl-probe marker missing/,
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("strips + detects the temporary host exemption in a daemon env", () => {
    const env = { HOME: "/home/x", [TEMP_ALLOW_PRIVATE_ENV]: "1" };
    assert.equal(daemonEnvLeaksTempExemption(env), true);
    const stripped = withoutTempAllowPrivate(env);
    assert.equal(daemonEnvLeaksTempExemption(stripped), false);
    assert.ok(!(TEMP_ALLOW_PRIVATE_ENV in stripped), "the key must be absent, not undefined");
    assert.equal(stripped.HOME, "/home/x", "unrelated keys must survive");
  });

  it("writes and reads observed-rounds evidence; zero rounds refuse", () => {
    const dir = tamanduaTempDir("tamandua-allow-private-rounds-");
    try {
      const written = writeObservedRoundsEvidence(dir, {
        gate: ALLOW_PRIVATE_GATE_LABEL,
        observed_rounds: 4,
        observed_vm_ids: ["vm-11223344", "vm-55667788", "vm-99aabbcc", "vm-deadbeef"],
      });
      assert.equal(written.observed_rounds, 4);
      const readBack = readObservedRoundsEvidence(dir);
      assert.equal(readBack.gate, ALLOW_PRIVATE_GATE_LABEL);
      assert.equal(readBack.observed_rounds, 4);
      assert.equal(readBack.observed_vm_ids.length, 4);
      assert.doesNotThrow(() =>
        assertObservedRoundsNonZero(ALLOW_PRIVATE_GATE_LABEL, 4, readBack.observed_vm_ids),
      );
      assert.throws(
        () => assertObservedRoundsNonZero(ALLOW_PRIVATE_GATE_LABEL, 0, []),
        /no VM round observed/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("US-009 allow-private gate: not in the fast lanes", () => {
  it("is absent from run-all-e2e-tests / run-all-smoke-e2e-tests / run-all-scripted-e2e-tests", () => {
    for (const lane of FAST_LANES) {
      const content = read(lane);
      assert.ok(!content.includes(RUNNER), `${lane} must not run ${RUNNER}`);
      assert.ok(!content.includes(GATE), `${lane} must not run ${GATE}`);
      assert.ok(
        !/matchlock-[a-z-]*-gate\.test\.ts/.test(content),
        `${lane} must remain smoke + scripted (zero real-VM gates)`,
      );
    }
  });
});

describe("US-009 allow-private gate: the in-guest curl probe stays DEFAULT-OFF", () => {
  it("gates the synthetic-pi probe on TAMANDUA_SYNTHETIC_PI_CURL_URL", () => {
    const fixture = read(SYNTHETIC_PI);
    assert.ok(fixture.includes("TAMANDUA_SYNTHETIC_PI_CURL_URL"), "the fixture must read the probe env");
    assert.ok(fixture.includes("CURL_PROBE_URL"), "the fixture must keep the parsed probe URL");
    assert.ok(
      fixture.includes("if (CURL_PROBE_URL.length > 0)"),
      "the curl probe must run ONLY when a URL is provided (default-off)",
    );
    assert.ok(
      fixture.includes("curl-probe.json"),
      "the fixture must record the probe result as curl-probe.json",
    );
  });

  it("defaults the fixture-image build arg to empty and installs curl", () => {
    const dockerfile = read(SYNTHETIC_DOCKERFILE);
    assert.ok(
      dockerfile.includes("ARG TAMANDUA_SYNTHETIC_PI_CURL_URL="),
      "the fixture image must declare the build arg with an empty default",
    );
    assert.ok(
      dockerfile.includes("ENV TAMANDUA_SYNTHETIC_PI_CURL_URL="),
      "the fixture image must forward the build arg as image config env",
    );
    assert.match(dockerfile, /\bcurl\b/, "the fixture image must install curl");
  });

  it("pins the shared probe helper vocabulary the gate relies on", () => {
    const helper = read(PROBE_HELPER);
    assert.ok(helper.includes(ALLOW_PRIVATE_PROBE_URL), "the helper must name the gate endpoint");
    assert.ok(helper.includes(ALLOW_PRIVATE_FLAG), "the helper must name the repeatable flag");
    assert.ok(helper.includes(ALLOW_PRIVATE_ENV), "the helper must name the env default");
  });
});
