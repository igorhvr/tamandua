#!/usr/bin/env node
/*
 * build-native.mjs — optional native signal-isolation build step (KHYG US-001).
 *
 * Run as part of `npm run build` (after tsc has populated dist/). It produces
 * the per-host native artifacts under dist/native/:
 *
 *   dist/native/seatbelt-signal.sb        macOS Seatbelt profile asset (always
 *                                         copied; it is a static repo asset)
 *   dist/native/seatbelt-signal.sb.stamp.json
 *   dist/native/landlock-helper           Linux Landlock startup helper
 *                                         (compiled from native/landlock-helper.c)
 *   dist/native/landlock-helper.stamp.json
 *   dist/native/proc-starttime            macOS sysctl kernel process
 *                                         start-time probe (compiled from
 *                                         native/proc-starttime.c; TZPI US-001)
 *   dist/native/proc-starttime.stamp.json
 *   dist/native/proc-info                macOS sysctl process-metadata probe
 *                                         (pgid/cmdline/state; compiled from
 *                                         native/proc-info.c; MPSX follow-on)
 *   dist/native/proc-info.stamp.json
 *   dist/native/.unavailable.json         explicit unavailable-backend marker
 *                                         (machine readable reason) when the
 *                                         native helper cannot be built
 *
 * Contract (from the KHYG task):
 *  - Compile ONLY when a working compiler, a linux/landlock.h UAPI header that
 *    defines LANDLOCK_SCOPE_SIGNAL, and a supported Linux arch are present.
 *  - When compilation is impossible or fails, the build STILL exits 0 and
 *    records an explicit unavailable-backend marker + reason — never a broken
 *    Tamandua installation.
 *  - Never silently reuse a stale artifact: every build attempt clears and
 *    refreshes dist/native artifacts + stamps.
 *  - No downloaded binaries. No Node native-addon dependency.
 *  - macOS needs no compile (profile asset only) but still stamps availability.
 *
 * Usage:  node scripts/build-native.mjs [outDir]
 *   outDir defaults to <repoRoot>/dist/native. Tests pass a temp fixture dir.
 *
 * Internal test-only env hooks (build-time only, never user-facing knobs):
 *   TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM=<platform>  simulate another host OS
 *   TAMANDUA_BUILD_NATIVE_FORCE_UNAVAILABLE=<reason> force the explicit
 *       unavailable path with the given machine-readable reason
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_SOURCE = path.join(REPO_ROOT, "native", "landlock-helper.c");
const SEATBELT_SOURCE = path.join(REPO_ROOT, "native", "seatbelt-signal.sb");
const PROC_STARTTIME_SOURCE = path.join(REPO_ROOT, "native", "proc-starttime.c");
const PROC_INFO_SOURCE = path.join(REPO_ROOT, "native", "proc-info.c");

// Only these Linux architectures are considered supported for the native
// helper. The C is portable, but the gate stays explicit (KHYG US-001).
const SUPPORTED_LINUX_ARCHES = new Set(["x64", "arm64"]);

function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function effectivePlatform() {
  const forced = process.env.TAMANDUA_BUILD_NATIVE_FORCE_PLATFORM;
  return forced && forced.trim() !== "" ? forced.trim() : process.platform;
}

function findCompiler() {
  for (const candidate of ["cc", "gcc"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      const firstLine = (probe.stdout || probe.stderr || "").split("\n")[0] || "";
      return { name: candidate, version: firstLine.trim() };
    }
  }
  return null;
}

function removeIfExists(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* best effort */
  }
}

// Feature-owned generated artifacts: the ONLY entries this build step ever
// deletes. Unknown/unrelated files in the output directory are never touched.
const GENERATED_ARTIFACTS = [
  "landlock-helper",
  "landlock-helper.stamp.json",
  ".unavailable.json",
  "seatbelt-signal.sb",
  "seatbelt-signal.sb.stamp.json",
  "proc-starttime",
  "proc-starttime.stamp.json",
  "proc-info",
  "proc-info.stamp.json",
];

/**
 * Start a fresh attempt: remove only the named generated artifacts owned by
 * this feature (never unknown files), then (re)write the static Seatbelt
 * profile asset + stamp when its source is present. When the source is
 * absent, any previously copied asset is removed instead of being silently
 * reused.
 */
function refreshArtifacts(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of GENERATED_ARTIFACTS) {
    removeIfExists(path.join(outDir, name));
  }
  if (fs.existsSync(SEATBELT_SOURCE)) {
    fs.copyFileSync(SEATBELT_SOURCE, path.join(outDir, "seatbelt-signal.sb"));
    writeStamp(outDir, "seatbelt-signal.sb.stamp.json", {
      artifact: "seatbelt-signal.sb",
      backend: "seatbelt",
      platform: effectivePlatform(),
      arch: process.arch,
      source: "native/seatbelt-signal.sb",
      sourceSha256: sha256File(SEATBELT_SOURCE),
      compiled: false,
    });
  }
}

function writeUnavailable(outDir, reason, extra = {}) {
  const marker = {
    backend: "unavailable",
    reason,
    platform: effectivePlatform(),
    arch: process.arch,
    attemptedAtUtc: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(
    path.join(outDir, ".unavailable.json"),
    JSON.stringify(marker, null, 2) + "\n",
  );
  return marker;
}

function writeStamp(outDir, name, stamp) {
  fs.writeFileSync(
    path.join(outDir, name),
    JSON.stringify({ ...stamp, writtenAtUtc: new Date().toISOString() }, null, 2) + "\n",
  );
}

/** Linux: compile native/landlock-helper.c into outDir/landlock-helper. */
function buildLinuxHelper(outDir, compiler) {
  const sourceHash = sha256File(HELPER_SOURCE);
  const preflight = spawnSync(
    compiler.name,
    ["-dM", "-E", "-include", "linux/landlock.h", "-"],
    { input: "", encoding: "utf8" },
  );
  const defines = preflight.status === 0 ? `${preflight.stdout}\n${preflight.stderr}` : "";
  if (preflight.status !== 0 || !defines.includes("LANDLOCK_SCOPE_SIGNAL")) {
    writeUnavailable(outDir, "missing-landlock-scope-signal-header", {
      compiler: compiler.name,
    });
    console.log(
      JSON.stringify({
        backend: "unavailable",
        reason: "missing-landlock-scope-signal-header",
        artifact: "landlock-helper",
      }),
    );
    return;
  }

  const artifactPath = path.join(outDir, "landlock-helper");
  const result = spawnSync(
    compiler.name,
    ["-O2", "-Wall", "-Wextra", "-o", artifactPath, HELPER_SOURCE],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    // Compilation failed (e.g. toolchain broke): exit 0 with an explicit
    // unavailable marker and reason; never leave a stale binary around.
    removeIfExists(artifactPath);
    removeIfExists(path.join(outDir, "landlock-helper.stamp.json"));
    const tail = (result.stderr || result.stdout || "unknown compiler error")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-5)
      .join(" | ")
      .slice(0, 400);
    writeUnavailable(outDir, "compile-failed", { compiler: compiler.name, detail: tail });
    console.log(
      JSON.stringify({ backend: "unavailable", reason: "compile-failed", artifact: "landlock-helper" }),
    );
    return;
  }

  fs.chmodSync(artifactPath, 0o755);
  writeStamp(outDir, "landlock-helper.stamp.json", {
    artifact: "landlock-helper",
    backend: "landlock",
    platform: effectivePlatform(),
    arch: process.arch,
    source: "native/landlock-helper.c",
    sourceSha256: sourceHash,
    toolchain: compiler.name,
    compilerVersion: compiler.version,
  });
  removeIfExists(path.join(outDir, ".unavailable.json"));
  console.log(
    JSON.stringify({
      backend: "landlock",
      artifact: "landlock-helper",
      path: path.relative(REPO_ROOT, artifactPath),
    }),
  );
}

/**
 * Darwin: compile native/proc-starttime.c into outDir/proc-starttime.
 *
 * This helper reports `sysctl KERN_PROC_PID` start timevals (the v2 process
 * identity source on macOS) and is independent of the Landlock signal
 * backend: a failure here must NOT write/modify the signal-backend
 * `.unavailable.json` marker, it only drops the helper + its stamp and exits
 * 0 with a JSON reason line. Linux does not compile this helper — Linux
 * identity reads procfs.
 */
function buildDarwinProcStarttime(outDir) {
  const artifactPath = path.join(outDir, "proc-starttime");
  const stampPath = path.join(outDir, "proc-starttime.stamp.json");

  const missingCompilerOrSource = (reason, extra = {}) => {
    removeIfExists(artifactPath);
    removeIfExists(stampPath);
    console.log(
      JSON.stringify({ backend: "unavailable", reason, artifact: "proc-starttime", ...extra }),
    );
  };

  if (!fs.existsSync(PROC_STARTTIME_SOURCE)) {
    missingCompilerOrSource("missing-source");
    return;
  }

  const compiler = findCompiler();
  if (!compiler) {
    missingCompilerOrSource("missing-compiler");
    return;
  }

  const result = spawnSync(
    compiler.name,
    ["-O2", "-Wall", "-Wextra", "-o", artifactPath, PROC_STARTTIME_SOURCE],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "unknown compiler error")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-5)
      .join(" | ")
      .slice(0, 400);
    missingCompilerOrSource("compile-failed", { compiler: compiler.name, detail: tail });
    return;
  }

  fs.chmodSync(artifactPath, 0o755);
  writeStamp(outDir, "proc-starttime.stamp.json", {
    artifact: "proc-starttime",
    backend: "darwin-sysctl",
    platform: effectivePlatform(),
    arch: process.arch,
    source: "native/proc-starttime.c",
    sourceSha256: sha256File(PROC_STARTTIME_SOURCE),
    toolchain: compiler.name,
    compilerVersion: compiler.version,
  });
  console.log(
    JSON.stringify({
      backend: "darwin-sysctl",
      artifact: "proc-starttime",
      path: path.relative(REPO_ROOT, artifactPath),
    }),
  );
}

/**
 * Darwin: compile native/proc-info.c into outDir/proc-info.
 *
 * This helper exposes pgid/cmdline/state/pid listings via sysctl(2) so the
 * product and its tests can read process metadata inside the Seatbelt signal
 * sandbox, where /bin/ps is EPERM. Like proc-starttime, a build failure only
 * drops this helper + stamp and exits 0 with a JSON reason line — it must
 * never create/modify the signal-backend `.unavailable.json` marker.
 */
function buildDarwinProcInfo(outDir) {
  const artifactPath = path.join(outDir, "proc-info");
  const stampPath = path.join(outDir, "proc-info.stamp.json");

  const missingCompilerOrSource = (reason, extra = {}) => {
    removeIfExists(artifactPath);
    removeIfExists(stampPath);
    console.log(
      JSON.stringify({ backend: "unavailable", reason, artifact: "proc-info", ...extra }),
    );
  };

  if (!fs.existsSync(PROC_INFO_SOURCE)) {
    missingCompilerOrSource("missing-source");
    return;
  }

  const compiler = findCompiler();
  if (!compiler) {
    missingCompilerOrSource("missing-compiler");
    return;
  }

  const result = spawnSync(
    compiler.name,
    ["-O2", "-Wall", "-Wextra", "-o", artifactPath, PROC_INFO_SOURCE],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "unknown compiler error")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-5)
      .join(" | ")
      .slice(0, 400);
    missingCompilerOrSource("compile-failed", { compiler: compiler.name, detail: tail });
    return;
  }

  fs.chmodSync(artifactPath, 0o755);
  writeStamp(outDir, "proc-info.stamp.json", {
    artifact: "proc-info",
    backend: "darwin-sysctl",
    platform: effectivePlatform(),
    arch: process.arch,
    source: "native/proc-info.c",
    sourceSha256: sha256File(PROC_INFO_SOURCE),
    toolchain: compiler.name,
    compilerVersion: compiler.version,
  });
  console.log(
    JSON.stringify({
      backend: "darwin-sysctl",
      artifact: "proc-info",
      path: path.relative(REPO_ROOT, artifactPath),
    }),
  );
}

function main() {
  const forcedUnavailable = process.env.TAMANDUA_BUILD_NATIVE_FORCE_UNAVAILABLE;
  const outDir = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "dist", "native"));
  const platform = effectivePlatform();

  // Every attempt starts from a fresh artifact area (no stale reuse): only
  // the named generated artifacts are cleared, and the static Seatbelt
  // profile asset is re-copied (or dropped) based on its current source.
  refreshArtifacts(outDir);

  if (forcedUnavailable !== undefined && forcedUnavailable !== "") {
    writeUnavailable(outDir, forcedUnavailable);
    console.log(
      JSON.stringify({ backend: "unavailable", reason: forcedUnavailable, artifact: "landlock-helper" }),
    );
    return;
  }

  if (platform === "linux") {
    if (!SUPPORTED_LINUX_ARCHES.has(process.arch)) {
      writeUnavailable(outDir, "unsupported-arch", { arch: process.arch });
      console.log(
        JSON.stringify({ backend: "unavailable", reason: "unsupported-arch", artifact: "landlock-helper" }),
      );
      return;
    }
    const compiler = findCompiler();
    if (!compiler) {
      writeUnavailable(outDir, "missing-compiler");
      console.log(
        JSON.stringify({ backend: "unavailable", reason: "missing-compiler", artifact: "landlock-helper" }),
      );
      return;
    }
    buildLinuxHelper(outDir, compiler);
    return;
  }

  if (platform === "darwin") {
    // The Seatbelt profile asset is already stamped above; runtime
    // availability additionally requires /usr/bin/sandbox-exec, which the
    // runtime backend module checks. Also compile the proc-starttime helper
    // (the v2 process-start identity source on macOS); a failure there only
    // drops that helper and its stamp — it never writes the signal-backend
    // .unavailable.json marker.
    removeIfExists(path.join(outDir, ".unavailable.json"));
    buildDarwinProcStarttime(outDir);
    buildDarwinProcInfo(outDir);
    console.log(JSON.stringify({ backend: "seatbelt", artifact: "seatbelt-signal.sb" }));
    return;
  }

  writeUnavailable(outDir, "unsupported-platform");
  console.log(
    JSON.stringify({ backend: "unavailable", reason: "unsupported-platform", artifact: "landlock-helper" }),
  );
}

try {
  main();
} catch (err) {
  // Unexpected internal error (not a documented unavailable-backend case):
  // fail the build loudly — never silently ship a half-built artifact.
  console.error(`build-native: internal error: ${err?.stack ?? String(err)}`);
  process.exit(1);
}
