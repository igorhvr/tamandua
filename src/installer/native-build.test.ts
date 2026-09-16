/**
 * native-build.test.ts — optional native build integration tests (KHYG US-001).
 *
 * Drives scripts/build-native.mjs (the step `npm run build` runs after tsc)
 * against isolated temp out dirs and asserts the contract:
 *
 *  - with a working toolchain the build produces the STAMPED dist/native
 *    artifact (landlock-helper + stamp on Linux; seatbelt profile asset +
 *    stamp everywhere);
 *  - when compilation is impossible (real missing compiler via a scrubbed
 *    PATH, or the internal test hook forcing a reason) the build STILL exits 0
 *    and records an explicit unavailable-backend marker + machine-readable
 *    reason;
 *  - a stale prior artifact is never silently reused: every attempt clears
 *    and refreshes the artifact + stamp area;
 *  - unsupported platforms are an explicit unavailable backend, never a
 *    broken build;
 *  - the darwin proc-starttime helper (TZPI US-001) is compiled + stamped on
 *    a darwin host, obtained only via sysctl KERN_PROC_PID (never ps(1)),
 *    TZ-independent, and its build failures never write the
 *    signal-backend .unavailable.json marker;
 *  - no downloaded binaries / native-addon dependencies are introduced
 *    (the script only compiles the repo's own C source with cc/gcc).
 *
 * Honest capability gating: positive "helper is built" tests gate on the SAME
 * conditions build-native.mjs enforces (linux host + supported arch + working
 * compiler + a linux/landlock.h that defines LANDLOCK_SCOPE_SIGNAL). A
 * compiler answering `--version` is NOT sufficient — pre-SIGNAL UAPI headers
 * or an unsupported arch make the backend honestly unavailable, so those
 * tests skip with a capability reason instead of demanding a helper the
 * optional-build contract does not promise. A dedicated owned-fixture test
 * covers the compiler-present-but-old-headers unavailable path directly.
 *
 * Spawn-capable (subprocess + compiler): listed in tests/serial-files.txt.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-native.mjs");

interface BuildRun {
  status: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

function runBuild(overrides: Record<string, string | undefined>, outDir?: string): BuildRun {
  const targetOut = outDir ?? tamanduaTempDir("tamandua-nb-");
  const env = cleanChildEnv(overrides);
  const result = spawnSync(process.execPath, [BUILD_SCRIPT, targetOut], {
    encoding: "utf8",
    env,
    timeout: 60000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    outDir: targetOut,
  };
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function assertNoUnavailableMarker(outDir: string): void {
  assert.ok(
    !fs.existsSync(path.join(outDir, ".unavailable.json")),
    ".unavailable.json must be absent on a successful build",
  );
}

describe("native build integration (US-001)", () => {
  const isLinux = process.platform === "linux";

  // Arch gate build-native.mjs enforces before compiling the helper.
  const SUPPORTED_LINUX_ARCHES = new Set(["x64", "arm64"]);

  interface LinuxHelperCapability {
    buildable: boolean;
    /** Human-readable reason when not buildable (used as an honest skip). */
    reason: string;
  }

  /**
   * Probe the SAME conditions scripts/build-native.mjs enforces before it
   * compiles the helper: linux host + supported arch + working compiler + a
   * linux/landlock.h that defines LANDLOCK_SCOPE_SIGNAL. A compiler merely
   * answering `--version` is NOT enough (pre-SIGNAL UAPI headers make the
   * backend honestly unavailable), so positive build tests gate on this real
   * capability rather than assuming compiler-present implies a helper.
   */
  function probeLinuxHelperCapability(): LinuxHelperCapability {
    if (!isLinux) return { buildable: false, reason: "not a linux host" };
    if (!SUPPORTED_LINUX_ARCHES.has(process.arch)) {
      return {
        buildable: false,
        reason: `unsupported arch for the landlock helper (${process.arch})`,
      };
    }
    for (const candidate of ["cc", "gcc"]) {
      const versionProbe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      if (versionProbe.status !== 0) continue;
      // Same header preflight build-native.mjs runs (first-found compiler wins).
      const preflight = spawnSync(
        candidate,
        ["-dM", "-E", "-include", "linux/landlock.h", "-"],
        { encoding: "utf8", input: "" },
      );
      const defines = preflight.status === 0 ? `${preflight.stdout}\n${preflight.stderr}` : "";
      if (preflight.status !== 0 || !defines.includes("LANDLOCK_SCOPE_SIGNAL")) {
        return {
          buildable: false,
          reason: `${candidate} is present but linux/landlock.h does not define LANDLOCK_SCOPE_SIGNAL (pre-SIGNAL UAPI headers)`,
        };
      }
      return { buildable: true, reason: "" };
    }
    return { buildable: false, reason: "no usable compiler on PATH" };
  }

  const helperCapability = probeLinuxHelperCapability();
  const requireLinuxHelperBuildable = (t: TestContext): boolean => {
    if (helperCapability.buildable) return true;
    t.skip(`honest capability skip: ${helperCapability.reason}`);
    return false;
  };

  it("builds the stamped landlock-helper artifact on a supported linux host", { timeout: 120000 }, (t) => {
    if (!requireLinuxHelperBuildable(t)) return;

    const run = runBuild({});
    assert.equal(run.status, 0, `build-native must exit 0; stderr: ${run.stderr}`);

    const helper = path.join(run.outDir, "landlock-helper");
    assert.ok(fs.existsSync(helper), "landlock-helper artifact must be produced");
    const mode = fs.statSync(helper).mode;
    assert.ok((mode & 0o111) !== 0, "landlock-helper must be executable");

    const stamp = readJson(path.join(run.outDir, "landlock-helper.stamp.json"));
    assert.ok(stamp, "a stamp file must be written next to the artifact");
    assert.equal(stamp.artifact, "landlock-helper");
    assert.equal(stamp.backend, "landlock");
    assert.equal(stamp.platform, "linux");
    assert.ok(["x64", "arm64"].includes(String(stamp.arch)), `stamp arch: ${String(stamp.arch)}`);
    assert.ok(["cc", "gcc"].includes(String(stamp.toolchain)), `stamp toolchain: ${String(stamp.toolchain)}`);
    assert.equal(typeof stamp.sourceSha256, "string");
    assert.ok(String(stamp.sourceSha256).length >= 40);

    // Profile asset is packaged on every platform with its own stamp.
    assert.ok(fs.existsSync(path.join(run.outDir, "seatbelt-signal.sb")));
    assert.ok(fs.existsSync(path.join(run.outDir, "seatbelt-signal.sb.stamp.json")));
    assertNoUnavailableMarker(run.outDir);

    assert.match(run.stdout, /"backend":"landlock"/);
  });

  it("exits 0 and records an explicit unavailable marker when the compiler is missing", { timeout: 120000 }, (t) => {
    if (!isLinux) return t.skip("not a linux host");

    // Real missing-compiler scenario: scrub PATH so neither cc nor gcc resolve.
    const emptyPath = tamanduaTempDir("tamandua-nb-nopath-");
    const run = runBuild({ PATH: emptyPath, TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM: "linux" });
    assert.equal(run.status, 0, `build must still exit 0; stderr: ${run.stderr}`);

    const marker = readJson(path.join(run.outDir, ".unavailable.json"));
    assert.ok(marker, "an explicit unavailable marker must be recorded");
    assert.equal(marker.backend, "unavailable");
    assert.equal(marker.reason, "missing-compiler");
    assert.ok(
      !fs.existsSync(path.join(run.outDir, "landlock-helper")),
      "no helper artifact may exist when the compiler is missing",
    );
    assert.ok(
      !fs.existsSync(path.join(run.outDir, "landlock-helper.stamp.json")),
      "no stamp may exist when the build is unavailable",
    );
  });

  it("records an explicit unavailable marker when a compiler lacks SIGNAL UAPI headers", { timeout: 120000 }, (t) => {
    if (!SUPPORTED_LINUX_ARCHES.has(process.arch)) {
      return t.skip(`unsupported arch for the landlock helper (${process.arch})`);
    }

    // Owned fixture compiler: answers `--version` fine but exposes pre-SIGNAL
    // landlock.h macros (no LANDLOCK_SCOPE_SIGNAL). Compiler-present must NOT
    // imply a buildable helper — build-native.mjs itself gates on the header
    // and records an explicit unavailable marker (exit 0) BEFORE any compile.
    const fixtureBin = tamanduaTempDir("tamandua-nb-oldhdr-bin-");
    fs.writeFileSync(
      path.join(fixtureBin, "cc"),
      [
        "#!/bin/sh",
        "# Owned fixture: working compiler with pre-SIGNAL Landlock UAPI headers.",
        'case "$1" in',
        "  --version) printf '%s\\n' 'fixture cc (old headers)'; exit 0 ;;",
        "  -dM) printf '%s\\n' '#define LANDLOCK_CREATE_RULESET_VERSION 1'; exit 0 ;;",
        "  *) printf '%s\\n' 'unexpected compile: header gate should have stopped this' >&2; exit 99 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // PATH is replaced wholesale (cleanChildEnv copies base env then applies
    // overrides), so only the fixture compiler is visible to the build.
    const run = runBuild({ PATH: fixtureBin, TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM: "linux" });
    assert.equal(run.status, 0, `build must still exit 0; stderr: ${run.stderr}`);

    const marker = readJson(path.join(run.outDir, ".unavailable.json"));
    assert.ok(marker, "an explicit unavailable marker must be recorded");
    assert.equal(marker.backend, "unavailable");
    assert.equal(marker.reason, "missing-landlock-scope-signal-header");
    assert.ok(
      !fs.existsSync(path.join(run.outDir, "landlock-helper")),
      "no helper may be produced when the SIGNAL header is absent",
    );
    assert.ok(
      !fs.existsSync(path.join(run.outDir, "landlock-helper.stamp.json")),
      "no stamp may be written when the build is unavailable",
    );
  });

  it("never silently reuses a stale artifact when compilation is forced unavailable", { timeout: 120000 }, (t) => {
    if (!isLinux) return t.skip("not a linux host");

    const outDir = tamanduaTempDir("tamandua-nb-stale-");
    // Pre-seed a STALE helper artifact + stamp, as if from an older build.
    const staleHelper = path.join(outDir, "landlock-helper");
    fs.writeFileSync(staleHelper, "#!/bin/sh\necho stale\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(outDir, "landlock-helper.stamp.json"),
      JSON.stringify({ artifact: "landlock-helper", stale: true }),
    );

    const run = runBuild({ TAMANDUA_BUILD_NATIVE_FORCE_UNAVAILABLE: "compile-failed" }, outDir);
    assert.equal(run.status, 0, `build must still exit 0; stderr: ${run.stderr}`);

    const marker = readJson(path.join(outDir, ".unavailable.json"));
    assert.ok(marker, "an explicit unavailable marker must be recorded");
    assert.equal(marker.reason, "compile-failed");
    assert.ok(
      !fs.existsSync(staleHelper),
      "the stale prior artifact must be cleared, never silently reused",
    );
    assert.ok(
      !fs.existsSync(path.join(outDir, "landlock-helper.stamp.json")),
      "the stale prior stamp must be cleared",
    );
  });

  it("refreshes a stale unavailable marker on a later successful build", { timeout: 120000 }, (t) => {
    if (!requireLinuxHelperBuildable(t)) return;

    const outDir = tamanduaTempDir("tamandua-nb-refresh-");
    fs.writeFileSync(
      path.join(outDir, ".unavailable.json"),
      JSON.stringify({ backend: "unavailable", reason: "missing-compiler" }),
    );

    const run = runBuild({}, outDir);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.ok(fs.existsSync(path.join(outDir, "landlock-helper")));
    assertNoUnavailableMarker(outDir);
  });

  it("never deletes unrelated files in the output directory (sentinel preserved)", { timeout: 120000 }, () => {
    // Safety assertion: unrelated files must survive byte-for-byte on EVERY
    // host — including Mac and Linux hosts without a usable compiler. Only
    // the positive "the landlock helper was refreshed" assertions below need
    // a linux helper build (guarded by the capability probe, never skipped).
    const outDir = tamanduaTempDir("tamandua-nb-sentinel-");
    // Pre-seed an unrelated sentinel + a stale generated artifact.
    const sentinel = path.join(outDir, "unrelated-sentinel.txt");
    fs.writeFileSync(sentinel, "do-not-touch");
    const junk = path.join(outDir, "other-tool-output.bin");
    fs.writeFileSync(junk, "junk");
    fs.writeFileSync(path.join(outDir, "landlock-helper"), "stale", { mode: 0o755 });

    const run = runBuild({}, outDir);
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    // Unrelated entries survive byte-for-byte.
    assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-touch");
    assert.equal(fs.readFileSync(junk, "utf8"), "junk");
    if (!helperCapability.buildable) {
      // No linux helper build on this host (Mac / no compiler / old headers):
      // the build still exited 0, preserved the sentinel, and cleared the
      // stale generated artifact — never silently reused, never a crash.
      assert.ok(
        !fs.existsSync(path.join(outDir, "landlock-helper")),
        "a stale landlock helper must not survive when no helper is built",
      );
      assert.ok(
        !fs.existsSync(path.join(outDir, "landlock-helper.stamp.json")),
        "a stale landlock stamp must not survive when no helper is built",
      );
      return;
    }
    // The named generated artifact was refreshed by the successful build.
    assert.ok(fs.existsSync(path.join(outDir, "landlock-helper")));
    assert.ok(fs.existsSync(path.join(outDir, "landlock-helper.stamp.json")));
    assertNoUnavailableMarker(outDir);
  });

  it("drops an old seatbelt asset instead of reusing it when the source is absent", { timeout: 120000 }, () => {
    // Safety assertion: an old packaged seatbelt asset must be dropped when
    // the source is gone — on EVERY host (Mac or without a compiler), since
    // refreshArtifacts runs before any platform-specific compile decision.
    // Only the trailing "the landlock helper still builds" assertion needs a
    // linux helper build (guarded by the capability probe, never skipped).
    // Build an isolated "repo" copy: build-native.mjs resolves its repo root
    // from its own location, so place the script and the C source (but NO
    // seatbelt-signal.sb source) in a temp fixture repo.
    const fixtureRoot = tamanduaTempDir("tamandua-nb-fixture-");
    const fixtureScripts = path.join(fixtureRoot, "scripts");
    const fixtureNative = path.join(fixtureRoot, "native");
    fs.mkdirSync(fixtureScripts, { recursive: true });
    fs.mkdirSync(fixtureNative, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "build-native.mjs"), path.join(fixtureScripts, "build-native.mjs"));
    fs.copyFileSync(path.join(REPO_ROOT, "native", "landlock-helper.c"), path.join(fixtureNative, "landlock-helper.c"));

    const outDir = path.join(fixtureRoot, "dist", "native");
    fs.mkdirSync(outDir, { recursive: true });
    // Pre-seed an OLD seatbelt asset + stamp (as if from an earlier build on a
    // repo that still shipped the source).
    fs.writeFileSync(path.join(outDir, "seatbelt-signal.sb"), "(version 1) (allow default) (deny signal) (allow signal (target same-sandbox))\n");
    fs.writeFileSync(path.join(outDir, "seatbelt-signal.sb.stamp.json"), JSON.stringify({ artifact: "seatbelt-signal.sb", stale: true }));

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureScripts, "build-native.mjs"), outDir],
      { encoding: "utf8", env: cleanChildEnv({}), timeout: 60000 },
    );
    assert.equal(result.status, 0, `fixture build must exit 0; stderr: ${result.stderr}`);
    assert.ok(
      !fs.existsSync(path.join(outDir, "seatbelt-signal.sb")),
      "an old seatbelt asset must not be left/reused when the source is absent",
    );
    assert.ok(
      !fs.existsSync(path.join(outDir, "seatbelt-signal.sb.stamp.json")),
      "an old seatbelt stamp must not survive when the source is absent",
    );
    if (!helperCapability.buildable) return; // safety assertions above hold everywhere
    assert.ok(fs.existsSync(path.join(outDir, "landlock-helper")), "helper still builds");
  });

  it("records unsupported platforms as an explicit unavailable backend (exit 0)", { timeout: 120000 }, () => {
    const run = runBuild({ TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM: "win32" });
    assert.equal(run.status, 0, `build must still exit 0; stderr: ${run.stderr}`);
    const marker = readJson(path.join(run.outDir, ".unavailable.json"));
    assert.ok(marker, "an explicit unavailable marker must be recorded");
    assert.equal(marker.backend, "unavailable");
    assert.equal(marker.reason, "unsupported-platform");
    assert.ok(!fs.existsSync(path.join(run.outDir, "landlock-helper")));
    // The static seatbelt profile asset is still packaged for portability.
    assert.ok(fs.existsSync(path.join(run.outDir, "seatbelt-signal.sb")));
  });

  it("stamps the seatbelt profile on darwin and does not build the landlock helper", { timeout: 120000 }, () => {
    const run = runBuild({ TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM: "darwin" });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stdout, /"backend":"seatbelt"/);
    assert.ok(fs.existsSync(path.join(run.outDir, "seatbelt-signal.sb")));
    const stamp = readJson(path.join(run.outDir, "seatbelt-signal.sb.stamp.json"));
    assert.ok(stamp, "seatbelt availability stamp must be written");
    assert.equal(stamp.backend, "seatbelt");
    assert.equal(stamp.compiled, false);
    assert.ok(!fs.existsSync(path.join(run.outDir, "landlock-helper")));
    assertNoUnavailableMarker(run.outDir);
  });

  // ------------------------------------------------------------------
  // TZPI US-001: darwin proc-starttime native helper (sysctl KERN_PROC_PID)
  // ------------------------------------------------------------------

  // A darwin-forced build only ever compiles the sysctl helper on a real
  // darwin host; on any other host the compiler cannot consume the
  // Darwin-only headers, which must be a graceful exit 0. Build once and
  // reuse for the behavior tests below.
  let darwinForcedBuild: BuildRun | null = null;
  function buildDarwinProcStarttimeOnce(): BuildRun {
    if (darwinForcedBuild === null) {
      darwinForcedBuild = runBuild({ TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM: "darwin" });
    }
    return darwinForcedBuild;
  }

  it("proc-starttime source obtains the start time only via sysctl KERN_PROC_PID (never ps)", () => {
    const sourcePath = path.join(REPO_ROOT, "native", "proc-starttime.c");
    assert.ok(fs.existsSync(sourcePath), "native/proc-starttime.c must exist");
    const src = fs.readFileSync(sourcePath, "utf8");
    // The only permitted kernel source.
    assert.match(src, /KERN_PROC_PID/);
    assert.match(src, /p_starttime/);
    assert.match(src, /sysctl\s*\(/);
    // Strip C comments so documentation that NAMES ps(1)/bin/ps as the
    // rejected approach is not mistaken for a code invocation; then assert
    // the executable code never shells out to ps or any other binary.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!code.includes("/bin/ps"), "proc-starttime code must not reference /bin/ps");
    assert.ok(!/\bps\b/.test(code), "proc-starttime code must not invoke ps");
    assert.ok(
      !/\b(popen|system|fork|execlp|execvp|execve|posix_spawn)\s*\(/.test(code),
      "proc-starttime must not use an external-binary API",
    );
  });

  it("forced darwin build produces an executable, stamped proc-starttime helper", { timeout: 120000 }, () => {
    const run = buildDarwinProcStarttimeOnce();
    assert.equal(run.status, 0, `build-native must exit 0; stderr: ${run.stderr}`);

    const helper = path.join(run.outDir, "proc-starttime");
    const stampPath = path.join(run.outDir, "proc-starttime.stamp.json");

    if (process.platform !== "darwin") {
      // Forcing the darwin platform on a non-darwin host cannot compile the
      // sysctl source. Contract: graceful exit 0, NO helper/stamp, and
      // critically NO .unavailable.json (that marker governs the signal
      // backend, not process identity).
      assert.ok(!fs.existsSync(helper), "no proc-starttime helper on a non-darwin host");
      assert.ok(!fs.existsSync(stampPath), "no proc-starttime stamp on a non-darwin host");
      assertNoUnavailableMarker(run.outDir);
      assert.match(run.stdout, /"artifact":"proc-starttime"/);
      return;
    }

    assert.ok(fs.existsSync(helper), "proc-starttime artifact must be produced on darwin");
    assert.ok((fs.statSync(helper).mode & 0o111) !== 0, "proc-starttime must be executable");
    const stamp = readJson(stampPath);
    assert.ok(stamp, "a proc-starttime stamp file must be written next to the artifact");
    assert.equal(stamp.artifact, "proc-starttime");
    assert.equal(stamp.backend, "darwin-sysctl");
    assert.equal(stamp.platform, "darwin");
    assert.equal(stamp.source, "native/proc-starttime.c");
    assert.ok(["cc", "gcc"].includes(String(stamp.toolchain)), `stamp toolchain: ${String(stamp.toolchain)}`);
    assert.equal(typeof stamp.sourceSha256, "string");
    assert.ok(String(stamp.sourceSha256).length >= 40);
    assertNoUnavailableMarker(run.outDir);
    assert.match(run.stdout, /"backend":"darwin-sysctl"/);
  });

  it("darwin proc-starttime reports kernel start times for live pids", { timeout: 120000 }, (t) => {
    if (process.platform !== "darwin") {
      return t.skip("honest capability skip: the sysctl proc-starttime helper requires a darwin host");
    }
    const run = buildDarwinProcStarttimeOnce();
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const helper = path.join(run.outDir, "proc-starttime");
    assert.ok(fs.existsSync(helper));

    // This test process is definitely live.
    const self = spawnSync(helper, [String(process.pid)], { encoding: "utf8" });
    assert.equal(self.status, 0, `helper must exit 0 for a live pid; stderr: ${self.stderr}`);
    assert.match(self.stdout.trim(), /^\d+\.\d{6}$/, `expected '<sec>.<usec>'; got: ${self.stdout}`);
    const selfStart = Number(self.stdout.trim().split(".")[0]);
    assert.ok(selfStart > 0, "a live process must have a non-zero start epoch");

    // A second, distinct live process must yield its own start time.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      env: cleanChildEnv({}),
    });
    try {
      const childResult = spawnSync(helper, [String(child.pid)], { encoding: "utf8" });
      assert.equal(childResult.status, 0, `helper must exit 0 for a live child; stderr: ${childResult.stderr}`);
      assert.match(childResult.stdout.trim(), /^\d+\.\d{6}$/);
      assert.notEqual(
        childResult.stdout.trim(),
        self.stdout.trim(),
        "two distinct live processes must have distinct raw start times",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("darwin proc-starttime output is byte-identical across caller TZ", { timeout: 120000 }, (t) => {
    if (process.platform !== "darwin") {
      return t.skip("honest capability skip: the sysctl proc-starttime helper requires a darwin host");
    }
    const run = buildDarwinProcStarttimeOnce();
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const helper = path.join(run.outDir, "proc-starttime");

    const underUtc = spawnSync(helper, [String(process.pid)], {
      encoding: "utf8",
      env: cleanChildEnv({ TZ: "UTC" }),
    });
    const underLocal = spawnSync(helper, [String(process.pid)], {
      encoding: "utf8",
      env: cleanChildEnv({ TZ: "America/Los_Angeles" }),
    });
    assert.equal(underUtc.status, 0, `stderr: ${underUtc.stderr}`);
    assert.equal(underLocal.status, 0, `stderr: ${underLocal.stderr}`);
    assert.equal(underUtc.stdout, underLocal.stdout, "raw kernel start time must not depend on caller TZ");
  });

  it("darwin proc-starttime rejects bad usage and missing processes with documented codes", { timeout: 120000 }, (t) => {
    if (process.platform !== "darwin") {
      return t.skip("honest capability skip: the sysctl proc-starttime helper requires a darwin host");
    }
    const run = buildDarwinProcStarttimeOnce();
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const helper = path.join(run.outDir, "proc-starttime");

    // Usage error (missing / extra argv) -> 64, one diagnostic line.
    const noArg = spawnSync(helper, [], { encoding: "utf8" });
    assert.equal(noArg.status, 64, `missing pid must exit 64; got ${noArg.status}`);
    assert.ok(noArg.stderr.trim().length > 0, "a usage error must print a diagnostic");

    const extraArg = spawnSync(helper, [String(process.pid), "extra"], { encoding: "utf8" });
    assert.equal(extraArg.status, 64, `extra argv must exit 64; got ${extraArg.status}`);

    // Malformed / non-positive pid -> 64 (never treated as a lookup).
    for (const badPid of ["abc", "0", "-1", "1.5", "12abc", ""]) {
      const bad = spawnSync(helper, [badPid], { encoding: "utf8" });
      assert.equal(bad.status, 64, `pid ${JSON.stringify(badPid)} must exit 64; got ${bad.status} (stderr: ${bad.stderr})`);
      assert.ok(bad.stderr.trim().length > 0, `pid ${JSON.stringify(badPid)} must print a diagnostic`);
    }

    // Lookup failure for a pid that is not running -> 1.
    const missing = spawnSync(helper, ["999999"], { encoding: "utf8" });
    assert.equal(missing.status, 1, `a nonexistent pid must exit 1; got ${missing.status} (stderr: ${missing.stderr})`);
    assert.ok(missing.stderr.trim().length > 0, "a lookup failure must print a diagnostic");
  });

  it("darwin proc-starttime failure never writes .unavailable.json and clears stale artifacts", { timeout: 120000 }, () => {
    // Pre-seed a STALE helper + stamp, then force the darwin identity build to
    // fail by removing every compiler from PATH. Node itself runs from an
    // absolute execPath, so only cc/gcc resolution is affected.
    const outDir = tamanduaTempDir("tamandua-nb-procstale-");
    const staleHelper = path.join(outDir, "proc-starttime");
    fs.writeFileSync(staleHelper, "#!/bin/sh\necho stale\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(outDir, "proc-starttime.stamp.json"),
      JSON.stringify({ artifact: "proc-starttime", stale: true }),
    );
    const emptyPath = tamanduaTempDir("tamandua-nb-proc-nopath-");

    const run = runBuild(
      { PATH: emptyPath, TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM: "darwin" },
      outDir,
    );
    assert.equal(run.status, 0, `build must still exit 0; stderr: ${run.stderr}`);

    assert.ok(!fs.existsSync(staleHelper), "the stale proc-starttime artifact must be cleared");
    assert.ok(
      !fs.existsSync(path.join(outDir, "proc-starttime.stamp.json")),
      "the stale proc-starttime stamp must be cleared",
    );
    // The identity failure must NOT masquerade as a signal-backend outage.
    assertNoUnavailableMarker(outDir);
    assert.match(run.stdout, /"reason":"missing-compiler"/);
    assert.match(run.stdout, /"artifact":"proc-starttime"/);
    // The seatbelt profile asset is independent of the identity helper and
    // must still be packaged.
    assert.ok(fs.existsSync(path.join(outDir, "seatbelt-signal.sb")));
  });

  // ------------------------------------------------------------------
  // MPSX follow-on: darwin proc-info native helper (sysctl process table)
  // ------------------------------------------------------------------

  it("proc-info source reads process metadata only via sysctl (never ps)", () => {
    const sourcePath = path.join(REPO_ROOT, "native", "proc-info.c");
    assert.ok(fs.existsSync(sourcePath), "native/proc-info.c must exist");
    const src = fs.readFileSync(sourcePath, "utf8");
    assert.match(src, /KERN_PROC_ALL/);
    assert.match(src, /KERN_PROC_PID/);
    assert.match(src, /KERN_PROCARGS2/);
    assert.match(src, /sysctl\s*\(/);
    // The env subcommand must exist and be driven by the same KERN_PROCARGS2
    // read, not by ps or any environment dumper.
    assert.match(src, /write_environ\s*\(/);
    assert.match(src, /strcmp\s*\(\s*argv\[1\]\s*,\s*"env"\s*\)/);
    // Strip C comments so documentation that NAMES ps(1) as the rejected
    // approach is not mistaken for a code invocation; then assert the
    // executable code never shells out to ps or any other binary.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!code.includes("/bin/ps"), "proc-info code must not reference /bin/ps");
    assert.ok(!/\bps\b/.test(code), "proc-info code must not invoke ps");
    assert.ok(
      !/\b(popen|system|fork|execlp|execvp|execve|posix_spawn)\s*\(/.test(code),
      "proc-info must not use an external-binary API",
    );
  });

  it("forced darwin build produces an executable, stamped proc-info helper", { timeout: 120000 }, () => {
    const run = buildDarwinProcStarttimeOnce();
    assert.equal(run.status, 0, `build-native must exit 0; stderr: ${run.stderr}`);

    const helper = path.join(run.outDir, "proc-info");
    const stampPath = path.join(run.outDir, "proc-info.stamp.json");

    if (process.platform !== "darwin") {
      // Forcing darwin on a non-darwin host cannot compile the sysctl source.
      // Contract: graceful exit 0, NO helper/stamp, and NO .unavailable.json.
      assert.ok(!fs.existsSync(helper), "no proc-info helper on a non-darwin host");
      assert.ok(!fs.existsSync(stampPath), "no proc-info stamp on a non-darwin host");
      assertNoUnavailableMarker(run.outDir);
      assert.match(run.stdout, /"artifact":"proc-info"/);
      return;
    }

    assert.ok(fs.existsSync(helper), "proc-info artifact must be produced on darwin");
    assert.ok((fs.statSync(helper).mode & 0o111) !== 0, "proc-info must be executable");
    const stamp = readJson(stampPath);
    assert.ok(stamp, "a proc-info stamp file must be written next to the artifact");
    assert.equal(stamp.artifact, "proc-info");
    assert.equal(stamp.backend, "darwin-sysctl");
    assert.equal(stamp.platform, "darwin");
    assert.equal(stamp.source, "native/proc-info.c");
    assert.ok(["cc", "gcc"].includes(String(stamp.toolchain)), `stamp toolchain: ${String(stamp.toolchain)}`);
    assert.equal(typeof stamp.sourceSha256, "string");
    assert.ok(String(stamp.sourceSha256).length >= 40);
    assertNoUnavailableMarker(run.outDir);
    assert.match(run.stdout, /"artifact":"proc-info"/);
  });

  it("darwin proc-info reports the kernel process table without ps", { timeout: 120000 }, (t) => {
    if (process.platform !== "darwin") {
      return t.skip("honest capability skip: the sysctl proc-info helper requires a darwin host");
    }
    const run = buildDarwinProcStarttimeOnce();
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const helper = path.join(run.outDir, "proc-info");
    assert.ok(fs.existsSync(helper));

    // list: contains this process.
    const listed = spawnSync(helper, ["list"], { encoding: "utf8" });
    assert.equal(listed.status, 0, `list must exit 0; stderr: ${listed.stderr}`);
    const listedPids = listed.stdout.split("\n").map((l) => Number(l.trim())).filter((n) => n > 0);
    assert.ok(listedPids.includes(process.pid), "list must include the current pid");

    // pid: one TAB-separated record with a positive pgid and an argv.
    const self = spawnSync(helper, ["pid", String(process.pid)], { encoding: "utf8" });
    assert.equal(self.status, 0, `pid must exit 0; stderr: ${self.stderr}`);
    const fields = self.stdout.trim().split("\t");
    assert.equal(fields.length, 7, `expected 7 TAB fields; got: ${self.stdout}`);
    assert.equal(Number(fields[0]), process.pid);
    assert.ok(Number(fields[2]) > 0, "pgid must be positive");
    assert.ok(fields[6].includes("node"), "the current cmdline must contain node");

    // dump: every record is a complete, single-line row.
    const dump = spawnSync(helper, ["dump"], { encoding: "utf8" });
    assert.equal(dump.status, 0, `dump must exit 0; stderr: ${dump.stderr}`);
    const rows = dump.stdout.split("\n").filter((l) => l.length > 0);
    assert.ok(rows.length > 0, "dump must emit at least one record");
    for (const row of rows) {
      assert.ok(row.split("\t").length >= 7, `malformed dump row: ${row}`);
    }

    // Lookup failure for a pid that is not running -> 1.
    const missing = spawnSync(helper, ["pid", "999999"], { encoding: "utf8" });
    assert.equal(missing.status, 1, `a nonexistent pid must exit 1; got ${missing.status}`);
  });

  it("darwin proc-info reads a same-user process environment (env subcommand)", { timeout: 120000 }, (t) => {
    if (process.platform !== "darwin") {
      return t.skip("honest capability skip: the sysctl proc-info helper requires a darwin host");
    }
    const run = buildDarwinProcStarttimeOnce();
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const helper = path.join(run.outDir, "proc-info");
    assert.ok(fs.existsSync(helper));

    // sysctl KERN_PROCARGS2 returns the environ block for same-user processes
    // even though ps -E cannot see it. The test process is same-user/live.
    const selfEnv = spawnSync(helper, ["env", String(process.pid)], { encoding: "utf8" });
    assert.equal(selfEnv.status, 0, `env must exit 0 for a live same-user pid; stderr: ${selfEnv.stderr}`);
    const entries = selfEnv.stdout.split("\0").filter((e) => e.length > 0);
    assert.ok(entries.length > 0, "the environ block must not be empty");
    assert.ok(
      entries.includes(`HOME=${process.env.HOME ?? ""}`),
      "the environ block must contain the caller's HOME",
    );

    // Missing pid -> lookup failure (1); malformed / missing argv -> usage (64).
    const missing = spawnSync(helper, ["env", "999999"], { encoding: "utf8" });
    assert.equal(missing.status, 1, `a nonexistent pid must exit 1; got ${missing.status}`);
    assert.ok(missing.stderr.trim().length > 0, "a lookup failure must print a diagnostic");
    const noArg = spawnSync(helper, ["env"], { encoding: "utf8" });
    assert.equal(noArg.status, 64, `missing pid must exit 64; got ${noArg.status}`);
    const badPid = spawnSync(helper, ["env", "abc"], { encoding: "utf8" });
    assert.equal(badPid.status, 64, `a malformed pid must exit 64; got ${badPid.status}`);
  });

  it("no-op guard: only the repo's own C source is compiled (no downloads/addons)", () => {
    const script = fs.readFileSync(BUILD_SCRIPT, "utf8");
    assert.match(script, /spawnSync/);
    assert.ok(!script.includes("curl") && !script.includes("wget"), "no download in build-native");
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "native", "landlock-helper.c")),
      "the helper C source must exist in the repo",
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const forbidden of ["node-gyp", "bindings", "node-addon-api", "node-gyp-build"]) {
      assert.ok(!deps.includes(forbidden), `no native-addon dependency (${forbidden}) may be added`);
    }
  });
});
