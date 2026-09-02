// MJAV US-002 — tt-java golden builder / e2e validator JDK resolver wiring.
//
// build-golden.sh and validate-e2e.sh must source the shared resolver
// (torture-test/lib/jdk-discovery.sh) and export the resolved JAVA_HOME before
// EVERY ./mvnw invocation, so the golden build succeeds on darwin where PATH
// `java` is Apple's stub (exits non-zero) while nix maven bundles a Zulu JDK
// exposed via the `runtime:` line of `mvn -v`.
//
// Tests (always on — picked up by self-tests/run.sh's tier0-* glob):
//   * grep audit: both scripts reference + source the resolver before their
//     first (and every) ./mvnw invocation
//   * bash -n passes for both scripts
//   * red-arm: a full tt-java build-golden.sh run into an isolated temp git
//     repo with a stub PATH java (exits non-zero), a fake mvn -v reporting a
//     fake JDK dir, and a recording ./mvnw stub — the recording stub must see
//     the mvn-reported JDK as JAVA_HOME on every invocation. No maven download,
//     zero tokens, portable on darwin and linux.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const fixturesSrc = path.join(repoRoot, "torture-test", "fixtures-src");

const SCRIPTS = ["tt-java/build-golden.sh", "tt-java/validate-e2e.sh"] as const;

// Strip test-runner environment knobs that are irrelevant to spawned bash
// builders (NODE_TEST_CONTEXT can make spawned node-based fixtures skip their
// tests; TAMANDUA_TEST_GUARD is tamandua state isolation we don't need).
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k === "TAMANDUA_TEST_GUARD") continue;
    env[k] = v;
  }
  return env;
})();

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

/** A fake `mvn` that reports Maven's banner with `runtime: <jdk>`. */
function makeMvnScript(jdk: string): string {
  return [
    "#!/bin/sh",
    "echo 'Apache Maven 3.9.16 (fake)'",
    "echo 'Maven home: /nix/store/fake-maven'",
    `echo 'Java version: 21.0.11, vendor: Azul Systems, Inc., runtime: ${jdk}'`,
    "echo 'Default locale: en_US, platform encoding: UTF-8'",
    "exit 0",
  ].join("\n") + "\n";
}

/** Recording ./mvnw stub: capture the JAVA_HOME the builder exported, then
 *  simulate a green test run (create target/ for the junk probe, exit 0). */
const STUB_MVNW = [
  "#!/usr/bin/env bash",
  'if [ -n "${TT_JDK_RECORD:-}" ]; then',
  "  printf '%s\\n' \"${JAVA_HOME:-<unset>}\" >> \"$TT_JDK_RECORD\"",
  "fi",
  "mkdir -p target",
  "exit 0",
].join("\n") + "\n";

// ── AC1 + AC2: static wiring audit ────────────────────────────────────────

describe("tt-java JDK resolver wiring (MJAV US-002)", () => {
  for (const rel of SCRIPTS) {
    const file = path.join(fixturesSrc, rel);

    it(`${rel}: sources the shared resolver before every ./mvnw invocation`, () => {
      const lines = fs.readFileSync(file, "utf8").split("\n");

      assert.ok(
        lines.some((l) =>
          l.includes('JDK_DISCOVERY="$REPO_ROOT/torture-test/lib/jdk-discovery.sh"'),
        ),
        `${rel} must reference the shared resolver`,
      );

      const sourceIdx = lines.findIndex((l) => l.includes('"$JDK_DISCOVERY"'));
      assert.notEqual(sourceIdx, -1, `${rel} must source $JDK_DISCOVERY`);

      // Real ./mvnw invocations only — skip comment lines (the scripts'
      // documentation mentions ./mvnw).
      const mvnwIdxs = lines
        .map((l, i) => (!l.trimStart().startsWith("#") && l.includes("./mvnw") ? i : -1))
        .filter((i) => i !== -1);
      assert.ok(mvnwIdxs.length > 0, `${rel} must invoke ./mvnw`);

      for (const idx of mvnwIdxs) {
        assert.ok(
          idx > sourceIdx,
          `${rel}: ./mvnw at line ${idx + 1} precedes the resolver source at line ${sourceIdx + 1}`,
        );
      }
    });

    it(`${rel}: passes bash -n`, () => {
      const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
      assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
    });
  }

  // ── AC3: red-arm — the builder exports the mvn-reported JDK ─────────────

  it("red-arm: build-golden.sh exports the mvn-reported JDK to a stubbed mvnw (no maven download)", function () {
    this.timeout = 120_000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-java-wiring-"));
    try {
      // Isolated git repo so build-golden.sh's `git rev-parse --show-toplevel`
      // resolves to the temp root (empty repo is enough for that probe).
      const gitInit = spawnSync("git", ["init", "-q"], { cwd: root, env: CLEAN_ENV, encoding: "utf8" });
      assert.equal(gitInit.status, 0, `git init failed: ${gitInit.stderr}`);

      // Copy the shared resolver + the tt-java fixture source into the temp repo.
      const dstLib = path.join(root, "torture-test", "lib");
      fs.mkdirSync(dstLib, { recursive: true });
      fs.copyFileSync(
        path.join(repoRoot, "torture-test", "lib", "jdk-discovery.sh"),
        path.join(dstLib, "jdk-discovery.sh"),
      );
      fs.chmodSync(path.join(dstLib, "jdk-discovery.sh"), 0o755);

      const dstFixture = path.join(root, "torture-test", "fixtures-src", "tt-java");
      fs.cpSync(path.join(fixturesSrc, "tt-java"), dstFixture, { recursive: true });

      // Replace ./mvnw with the recording stub (the builder invokes ./mvnw
      // from scratch clones, so a PATH stub cannot intercept it).
      writeExecutable(path.join(dstFixture, "mvnw"), STUB_MVNW);

      // Stub PATH java (Apple-style stub, exits non-zero) + fake mvn that
      // reports a fake working JDK on its runtime: line.
      const stubBin = path.join(root, "stub-bin");
      fs.mkdirSync(stubBin, { recursive: true });
      const jdk = path.join(root, "fake-jdk");
      fs.mkdirSync(path.join(jdk, "bin"), { recursive: true });
      writeExecutable(path.join(jdk, "bin", "java"), "#!/bin/sh\nexit 0\n");
      writeExecutable(
        path.join(stubBin, "java"),
        "#!/bin/sh\necho 'Unable to locate a Java Runtime.' >&2\nexit 1\n",
      );
      writeExecutable(path.join(stubBin, "mvn"), makeMvnScript(jdk));

      const record = path.join(root, "recorded-java-home.log");
      const goldenDir = path.join(root, "golden");

      const env: NodeJS.ProcessEnv = { ...CLEAN_ENV };
      delete env.JAVA_HOME; // force resolution through mvn, not a host JAVA_HOME
      env.PATH = `${stubBin}:${process.env.PATH ?? ""}`;
      env.TT_JDK_RECORD = record;
      env.TORTURE_GOLDEN_DIR = goldenDir;

      const result = spawnSync("bash", [path.join(dstFixture, "build-golden.sh")], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });

      // The stub always reports GREEN, so the builder is expected to abort at
      // the first BRK seed ("UNEXPECTED GREEN"). The JDK-export proof is the
      // recording the stub made on every ./mvnw invocation before that abort.
      const recorded = fs.existsSync(record)
        ? fs.readFileSync(record, "utf8").trim().split(/\r?\n/).filter(Boolean)
        : [];
      assert.ok(
        recorded.length > 0,
        `stubbed mvnw was never invoked; status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      for (const line of recorded) {
        assert.equal(
          line,
          jdk,
          `mvnw must receive the mvn-reported JDK; got "${line}" (expected "${jdk}")`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
