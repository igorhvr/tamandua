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
import { spawnSync } from "node:child_process";
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

  it("stamps the seatbelt profile on darwin without compiling anything", { timeout: 120000 }, () => {
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
