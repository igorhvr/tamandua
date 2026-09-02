// MJAV US-003 — tt-poly run-all-tests java-suite JDK resolver wiring.
//
// tt-poly/run-all-tests must source the shared resolver
// (torture-test/lib/jdk-discovery.sh) and export the resolved JAVA_HOME before
// running `./mvnw -q -B test`, so the java module builds on darwin where PATH
// `java` is Apple's stub (exits non-zero) while nix maven bundles a Zulu JDK
// exposed via the `runtime:` line of `mvn -v`.
//
// Tests (always on — picked up by self-tests/run.sh's tier0-* glob):
//   * grep audit: run-all-tests references + sources the shared resolver before
//     its ./mvnw invocation and keeps maven.repo.local under torture-test/var
//   * bash -n passes
//   * red-arm: a full `run-all-tests` execution in an isolated temp git repo
//     with stub python/ts/go/rust suites, a stub PATH java (exits non-zero), a
//     fake mvn -v reporting a fake JDK dir, and a recording ./mvnw stub — the
//     recording stub must see the mvn-reported JDK as JAVA_HOME. No maven
//     download, zero tokens, portable on darwin and linux.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const fixturesSrc = path.join(repoRoot, "torture-test", "fixtures-src");
const runAllTests = path.join(fixturesSrc, "tt-poly", "run-all-tests");

// Strip test-runner environment knobs that are irrelevant to spawned bash
// scripts (NODE_TEST_CONTEXT can make spawned node-based fixtures skip their
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

/** Recording ./mvnw stub: capture the JAVA_HOME run-all-tests exported, then
 *  simulate a green java test run (exit 0). */
const STUB_MVNW = [
  "#!/usr/bin/env bash",
  'if [ -n "${TT_JDK_RECORD:-}" ]; then',
  "  printf '%s\\n' \"${JAVA_HOME:-<unset>}\" >> \"$TT_JDK_RECORD\"",
  "fi",
  "exit 0",
].join("\n") + "\n";

// ── AC1 + AC2: static wiring audit ────────────────────────────────────────

describe("tt-poly run-all-tests JDK resolver wiring (MJAV US-003)", () => {
  const content = fs.readFileSync(runAllTests, "utf8");
  const lines = content.split("\n");

  it("sources the shared resolver before its ./mvnw invocation", () => {
    assert.ok(
      lines.some((l) =>
        l.includes('JDK_DISCOVERY="$REPO_ROOT/torture-test/lib/jdk-discovery.sh"'),
      ),
      "run-all-tests must reference the shared resolver",
    );

    const sourceIdx = lines.findIndex((l) => l.includes('"$JDK_DISCOVERY"'));
    assert.notEqual(sourceIdx, -1, "run-all-tests must source $JDK_DISCOVERY");

    // Real ./mvnw invocations only — skip comment lines.
    const mvnwIdxs = lines
      .map((l, i) => (!l.trimStart().startsWith("#") && l.includes("./mvnw") ? i : -1))
      .filter((i) => i !== -1);
    assert.ok(mvnwIdxs.length > 0, "run-all-tests must invoke ./mvnw");

    for (const idx of mvnwIdxs) {
      assert.ok(
        idx > sourceIdx,
        `./mvnw at line ${idx + 1} precedes the resolver source at line ${sourceIdx + 1}`,
      );
    }
  });

  it("keeps maven.repo.local under torture-test/var and uses the resolved JAVA_HOME", () => {
    assert.ok(
      content.includes('MAVEN_REPO_LOCAL="$REPO_ROOT/torture-test/var/m2-repository"'),
      "maven.repo.local must stay under torture-test/var",
    );
    assert.ok(
      content.includes('if (cd "$ROOT_DIR/java" && ./mvnw -q -B -Dmaven.repo.local="$MAVEN_REPO_LOCAL" test)'),
      "the java suite must run ./mvnw -q -B test with the resolved JAVA_HOME exported",
    );
  });

  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", runAllTests], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
  });

  // ── AC3: red-arm — the java suite exports the mvn-reported JDK ─────────

  it("red-arm: run-all-tests exports the mvn-reported JDK to a stubbed mvnw (no maven download)", function () {
    this.timeout = 120_000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-poly-jdk-wiring-"));
    try {
      // Isolated git repo so run-all-tests' `git rev-parse --show-toplevel`
      // resolves to the temp root.
      const gitInit = spawnSync("git", ["init", "-q"], { cwd: root, env: CLEAN_ENV, encoding: "utf8" });
      assert.equal(gitInit.status, 0, `git init failed: ${gitInit.stderr}`);

      // Copy the shared resolver + the tt-poly fixture source into the temp repo.
      const dstLib = path.join(root, "torture-test", "lib");
      fs.mkdirSync(dstLib, { recursive: true });
      fs.copyFileSync(
        path.join(repoRoot, "torture-test", "lib", "jdk-discovery.sh"),
        path.join(dstLib, "jdk-discovery.sh"),
      );
      fs.chmodSync(path.join(dstLib, "jdk-discovery.sh"), 0o755);

      const dstFixture = path.join(root, "torture-test", "fixtures-src", "tt-poly");
      fs.cpSync(path.join(fixturesSrc, "tt-poly"), dstFixture, { recursive: true });

      // Replace ./mvnw with the recording stub (the script invokes ./mvnw
      // relative to the fixture tree, so a PATH stub cannot intercept it).
      writeExecutable(path.join(dstFixture, "java", "mvnw"), STUB_MVNW);

      // Stub the other four suites so the full run-all-tests completes
      // quickly and deterministically without touching real toolchains.
      //   python: pre-create .venv (skips bootstrap) + a green pytest stub
      //   ts:     pre-create node_modules (skips npm install) + a green npm
      //   go/rust: green `go` / `cargo` stubs on PATH
      fs.mkdirSync(path.join(dstFixture, "python", ".venv", "bin"), { recursive: true });
      writeExecutable(path.join(dstFixture, "python", ".venv", "bin", "pytest"), "#!/bin/sh\nexit 0\n");
      fs.mkdirSync(path.join(dstFixture, "ts", "node_modules"), { recursive: true });

      const stubBin = path.join(root, "stub-bin");
      fs.mkdirSync(stubBin, { recursive: true });
      writeExecutable(path.join(stubBin, "npm"), "#!/bin/sh\nexit 0\n");
      writeExecutable(path.join(stubBin, "go"), "#!/bin/sh\nexit 0\n");
      writeExecutable(path.join(stubBin, "cargo"), "#!/bin/sh\nexit 0\n");

      // Stub PATH java (Apple-style stub, exits non-zero) + fake mvn that
      // reports a fake working JDK on its runtime: line.
      const jdk = path.join(root, "fake-jdk");
      fs.mkdirSync(path.join(jdk, "bin"), { recursive: true });
      writeExecutable(path.join(jdk, "bin", "java"), "#!/bin/sh\nexit 0\n");
      writeExecutable(
        path.join(stubBin, "java"),
        "#!/bin/sh\necho 'Unable to locate a Java Runtime.' >&2\nexit 1\n",
      );
      writeExecutable(path.join(stubBin, "mvn"), makeMvnScript(jdk));

      const record = path.join(root, "recorded-java-home.log");

      const env: NodeJS.ProcessEnv = { ...CLEAN_ENV };
      delete env.JAVA_HOME; // force resolution through mvn, not a host JAVA_HOME
      env.PATH = `${stubBin}:${process.env.PATH ?? ""}`;
      env.TT_JDK_RECORD = record;

      const result = spawnSync("bash", [path.join(dstFixture, "run-all-tests")], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });

      assert.equal(
        result.status,
        0,
        `run-all-tests should pass with all suites stubbed green; status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );

      const recorded = fs.existsSync(record)
        ? fs.readFileSync(record, "utf8").trim().split(/\r?\n/).filter(Boolean)
        : [];
      assert.ok(
        recorded.length > 0,
        `stubbed mvnw was never invoked; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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
