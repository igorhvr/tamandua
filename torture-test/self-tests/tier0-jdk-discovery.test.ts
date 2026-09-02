// MJAV US-001 — shared JDK discovery resolver red-arm self-test.
//
// torture-test/lib/jdk-discovery.sh is the ONE helper both the environment
// gate and every mvnw-driven fixture builder use to resolve a working JDK on
// darwin and linux. Its resolution order is:
//   1. JAVA_HOME (when $JAVA_HOME/bin/java -version exits 0)
//   2. the JDK `mvn -v` reports on its `runtime:` line (verified via its
//      bin/java) — this is how nix maven's bundled Zulu JDK is found on
//      darwin, where PATH `java` is Apple's stub
//   3. `java` on PATH (only when `java -version` exits 0)
// and it fails closed with a remedy naming JAVA_HOME and nix when none work.
//
// These arms are portable red-arms: fake `java`/`mvn` executables are created
// in a temp dir and prepended to PATH, so no real JDK/maven install is needed
// and the test is deterministic on any host (darwin or linux). Zero tokens;
// confined to torture-test/. Picked up by self-tests/run.sh's `tier0-*.test.ts`
// glob — no run.sh edit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const RESOLVER = path.join(repoRoot, "torture-test", "lib", "jdk-discovery.sh");

// Strip test-runner environment knobs that are irrelevant to a pure bash
// resolver (NODE_TEST_CONTEXT can make spawned node-based fixtures skip their
// tests; TAMANDUA_TEST_GUARD is tamandua state isolation we don't need).
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k === "TAMANDUA_TEST_GUARD") continue;
    env[k] = v;
  }
  return env;
})();

// ── fixture builders ──────────────────────────────────────────────────────

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

/** Create `<parent>/<name>/bin/java` — a working JDK (exit 0) or an
 *  Apple-style stub (exit non-zero). Returns the JDK dir. */
function makeJdk(parent: string, name: string, working: boolean): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  const script = working
    ? "#!/bin/sh\nexit 0\n"
    : "#!/bin/sh\necho 'The operation could not be completed. Unable to locate a Java Runtime.' >&2\nexit 1\n";
  writeExecutable(path.join(dir, "bin", "java"), script);
  return dir;
}

/** Write a fake `mvn` into `dir`. With `runtime` it prints Maven's version
 *  banner including `runtime: <runtime>`; without it the banner carries no
 *  runtime line (so JDK discovery must fall through). */
function makeMvn(dir: string, runtime?: string): void {
  const lines = [
    "#!/bin/sh",
    "echo 'Apache Maven 3.9.16 (fake)'",
    "echo 'Maven home: /nix/store/fake-maven'",
  ];
  if (runtime) {
    lines.push(`echo 'Java version: 21.0.11, vendor: Azul Systems, Inc., runtime: ${runtime}'`);
  } else {
    lines.push("echo 'Java version: 21.0.11, vendor: Azul Systems, Inc.'");
  }
  lines.push("echo 'Default locale: en_US, platform encoding: UTF-8'");
  lines.push("exit 0");
  writeExecutable(path.join(dir, "mvn"), `${lines.join("\n")}\n`);
}

/** Source the resolver in a fresh bash and capture the exported JAVA_HOME,
 *  the resolution-source line, status, and stderr. */
function sourceResolver(env: NodeJS.ProcessEnv): {
  status: number;
  stdout: string;
  stderr: string;
  source: string;
  javaHome: string;
} {
  const marker = "RESOLVED_JAVA_HOME=";
  const script = `. "$1"\nprintf '${marker}%s\\n' "\${JAVA_HOME:-}"\n`;
  const result = spawnSync("bash", ["-c", script, "bash", RESOLVER], {
    cwd: repoRoot,
    env: { ...CLEAN_ENV, ...env },
    encoding: "utf8",
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  let source = "";
  let javaHome = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "source=java_home" || line === "source=mvn" || line === "source=path") {
      source = line;
    } else if (line.startsWith(marker)) {
      javaHome = line.slice(marker.length);
    }
  }
  return { status: result.status ?? -1, stdout, stderr, source, javaHome };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("torture-test/lib/jdk-discovery.sh (MJAV US-001)", () => {
  it("exists, is executable, and passes bash -n", () => {
    assert.ok(fs.existsSync(RESOLVER), "resolver must exist");
    const mode = fs.statSync(RESOLVER).mode;
    assert.ok((mode & 0o111) !== 0, "resolver must have an executable bit");
    const lint = spawnSync("bash", ["-n", RESOLVER], { encoding: "utf8" });
    assert.equal(lint.status, 0, `bash -n failed: ${lint.stderr}`);
  });

  it("sources with a working JAVA_HOME: exports it and reports source=java_home", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jdkd-java-home-"));
    try {
      const jdk = makeJdk(tmp, "java-home", true);
      const r = sourceResolver({ JAVA_HOME: jdk });
      assert.equal(r.status, 0, `resolver failed: ${r.stderr}`);
      assert.equal(r.source, "source=java_home");
      assert.equal(r.javaHome, jdk);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores a non-working JAVA_HOME and falls through (fail closed if nothing else works)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jdkd-bad-home-"));
    try {
      const stubJdk = makeJdk(tmp, "stub", false); // bin/java exits non-zero
      const bin = path.join(stubJdk, "bin");
      makeMvn(bin); // mvn present but reports no runtime
      const r = sourceResolver({ JAVA_HOME: stubJdk, PATH: `${bin}:${process.env.PATH}` });
      assert.notEqual(r.status, 0, "resolver must fail closed when no JDK works");
      assert.match(r.stderr, /JAVA_HOME/, "remedy must name JAVA_HOME");
      assert.match(r.stderr, /nix/, "remedy must name nix");
      assert.equal(r.javaHome, "", "JAVA_HOME must not be exported on failure");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("with JAVA_HOME unset, a stub PATH java, and a fake mvn runtime: exports the mvn-reported JDK (source=mvn)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jdkd-mvn-"));
    try {
      const stubJdk = makeJdk(tmp, "stub", false); // PATH java = Apple-style stub
      const mvnJdk = makeJdk(tmp, "mvn-jdk", true); // working JDK reported by mvn
      const bin = path.join(stubJdk, "bin");
      makeMvn(bin, mvnJdk);
      const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}` };
      delete env.JAVA_HOME;
      const r = sourceResolver(env);
      assert.equal(r.status, 0, `resolver failed: ${r.stderr}`);
      assert.equal(r.source, "source=mvn");
      assert.equal(r.javaHome, mvnJdk);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("with JAVA_HOME unset and a working PATH java: exports that JDK and reports source=path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jdkd-path-"));
    try {
      const pathJdk = makeJdk(tmp, "path-jdk", true);
      const bin = path.join(pathJdk, "bin");
      makeMvn(bin); // mvn present but reports no runtime -> must fall through to java
      const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}` };
      delete env.JAVA_HOME;
      const r = sourceResolver(env);
      assert.equal(r.status, 0, `resolver failed: ${r.stderr}`);
      assert.equal(r.source, "source=path");
      assert.equal(r.javaHome, pathJdk);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed (non-zero + remedy naming JAVA_HOME/nix) when no JDK works", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jdkd-fail-"));
    try {
      const stubJdk = makeJdk(tmp, "stub", false);
      const bin = path.join(stubJdk, "bin");
      makeMvn(bin); // no runtime
      const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}` };
      delete env.JAVA_HOME;
      const r = sourceResolver(env);
      assert.notEqual(r.status, 0, "resolver must exit non-zero");
      assert.match(r.stderr, /JAVA_HOME/, "remedy must name JAVA_HOME");
      assert.match(r.stderr, /nix/, "remedy must name nix");
      assert.equal(r.source, "");
      assert.equal(r.javaHome, "");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
