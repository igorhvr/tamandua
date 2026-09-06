/**
 * native-signal-backend.test.ts — pure backend-probing / argv-construction
 * tests for the KHYG US-001 native signal-isolation backends.
 *
 * This file is PURE (no child_process import, no spawns) and runs in the
 * PARALLEL lane. It exercises the dist/native artifacts produced by the
 * optional native build step plus the backend module's host decisions and
 * launcher-argv construction, using only temp fixture directories.
 *
 * Spawn-capable behavior (the compiled helper, real signal boundaries, the
 * native build subprocess) lives in the SERIAL-lane files:
 *   src/installer/landlock-helper.test.ts
 *   src/installer/native-build.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HELPER_EXIT_EXEC_FAILURE,
  HELPER_EXIT_SETUP_FAILURE,
  HELPER_EXIT_USAGE,
  LANDLOCK_CONTROL_FD,
  LANDLOCK_MIN_ABI,
  SANDBOX_EXEC_PATH,
  SEATBELT_PROFILE_BASENAME,
  SEATBELT_PROFILE_TEXT,
  UNAVAILABLE_MARKER_BASENAME,
  buildProtectedLaunchArgv,
  defaultHelperPath,
  defaultProfilePath,
  nativeArtifactsDir,
  probeBackend,
} from "../../dist/installer/native-signal-backend.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Create an isolated fixture artifact dir with an executable fake helper. */
function fixtureArtifactDir(withHelper: boolean): string {
  const dir = tamanduaTempDir("tamandua-nsb-");
  if (withHelper) {
    const helperPath = path.join(dir, "landlock-helper");
    fs.writeFileSync(helperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, SEATBELT_PROFILE_BASENAME), SEATBELT_PROFILE_TEXT + "\n");
  return dir;
}

describe("native-signal-backend (US-001)", () => {
  it("ships the Linux helper C source in the repo", () => {
    const source = path.join(REPO_ROOT, "native", "landlock-helper.c");
    assert.ok(fs.existsSync(source), "native/landlock-helper.c must exist");
    const content = fs.readFileSync(source, "utf8");
    assert.match(content, /LANDLOCK_SCOPE_SIGNAL/);
    assert.match(content, /LANDLOCK_ACCESS_FS_REFER/);
    assert.match(content, /PR_SET_NO_NEW_PRIVS/);
  });

  it("ships the exact tested Seatbelt profile asset", () => {
    const asset = path.join(REPO_ROOT, "native", "seatbelt-signal.sb");
    const normalized = fs.readFileSync(asset, "utf8").trim().replace(/\s+/g, " ");
    assert.equal(normalized, SEATBELT_PROFILE_TEXT);
    assert.equal(
      SEATBELT_PROFILE_TEXT,
      "(version 1) (allow default) (deny signal) (allow signal (target same-sandbox))",
    );
  });

  it("documents the ABI floor and distinct helper exit codes", () => {
    assert.equal(LANDLOCK_MIN_ABI, 6);
    assert.equal(HELPER_EXIT_USAGE, 124);
    assert.equal(HELPER_EXIT_SETUP_FAILURE, 125);
    assert.equal(HELPER_EXIT_EXEC_FAILURE, 126);
    assert.equal(LANDLOCK_CONTROL_FD, 3);
    assert.equal(SANDBOX_EXEC_PATH, "/usr/bin/sandbox-exec");
  });

  it("probes landlock on linux when the compiled helper exists", () => {
    const dir = fixtureArtifactDir(true);
    const backend = probeBackend({ platform: "linux", artifactDir: dir });
    assert.equal(backend.kind, "landlock");
    assert.equal(backend.helperPath, defaultHelperPath(dir));
  });

  it("probes unavailable on linux with a reason when the helper is not built", () => {
    const dir = fixtureArtifactDir(false);
    const backend = probeBackend({ platform: "linux", artifactDir: dir });
    assert.equal(backend.kind, "unavailable");
    assert.equal(backend.reason, "landlock-helper-not-built");
  });

  it("surfaces the build's machine-readable unavailable marker reason", () => {
    const dir = fixtureArtifactDir(false);
    fs.writeFileSync(
      path.join(dir, UNAVAILABLE_MARKER_BASENAME),
      JSON.stringify({ backend: "unavailable", reason: "missing-compiler" }),
    );
    const backend = probeBackend({ platform: "linux", artifactDir: dir });
    assert.equal(backend.kind, "unavailable");
    assert.equal(backend.reason, "missing-compiler");
  });

  it("treats an explicit unavailable marker as authoritative over a stale executable helper", () => {
    // A failed artifact refresh must never select stale executable output:
    // even when an (old) executable helper is still present, the marker from
    // the last build attempt wins.
    const dir = fixtureArtifactDir(true);
    fs.writeFileSync(
      path.join(dir, UNAVAILABLE_MARKER_BASENAME),
      JSON.stringify({ backend: "unavailable", reason: "compile-failed" }),
    );
    const backend = probeBackend({ platform: "linux", artifactDir: dir });
    assert.equal(backend.kind, "unavailable");
    assert.equal(backend.reason, "compile-failed");
  });

  it("reports sandbox-exec absence on darwin as unavailable, not a crash", () => {
    const dir = fixtureArtifactDir(true);
    const backend = probeBackend({
      platform: "darwin",
      artifactDir: dir,
      sandboxExecPath: path.join(dir, "no-such-sandbox-exec"),
    });
    assert.equal(backend.kind, "unavailable");
    assert.equal(backend.reason, "sandbox-exec-missing");
  });

  it("reports a missing seatbelt profile on darwin as unavailable", () => {
    const dir = tamanduaTempDir("tamandua-nsb-");
    fs.writeFileSync(path.join(dir, "sandbox-exec"), "#!/bin/sh\n", { mode: 0o755 });
    const backend = probeBackend({
      platform: "darwin",
      artifactDir: dir,
      sandboxExecPath: path.join(dir, "sandbox-exec"),
    });
    assert.equal(backend.kind, "unavailable");
    assert.equal(backend.reason, "seatbelt-profile-missing");
  });

  it("probes seatbelt on darwin when sandbox-exec and the profile exist", () => {
    const dir = fixtureArtifactDir(false);
    const sandboxExec = path.join(dir, "sandbox-exec");
    fs.writeFileSync(sandboxExec, "#!/bin/sh\n", { mode: 0o755 });
    const backend = probeBackend({
      platform: "darwin",
      artifactDir: dir,
      sandboxExecPath: sandboxExec,
    });
    assert.equal(backend.kind, "seatbelt");
    assert.equal(backend.sandboxExec, sandboxExec);
    assert.equal(backend.profilePath, defaultProfilePath(dir));
  });

  it("reports unsupported platforms as unavailable", () => {
    const dir = fixtureArtifactDir(true);
    for (const platform of ["win32", "freebsd", "sunos"]) {
      const backend = probeBackend({ platform, artifactDir: dir });
      assert.equal(backend.kind, "unavailable", platform);
      assert.equal(backend.reason, "unsupported-platform", platform);
    }
  });

  it("builds landlock launcher argv around the given command", () => {
    const dir = fixtureArtifactDir(true);
    const result = buildProtectedLaunchArgv(["/bin/echo", "hello world"], {
      backend: { kind: "landlock", helperPath: defaultHelperPath(dir) },
      controlFd: 3,
    });
    assert.ok(result, "landlock backend should produce a launch spec");
    assert.equal(result.spec.kind, "landlock");
    assert.deepEqual(result.spec.argv, [
      defaultHelperPath(dir),
      "--control-fd",
      "3",
      "--",
      "/bin/echo",
      "hello world",
    ]);
  });

  it("builds seatbelt launcher argv as sandbox-exec -p <profile> <command>", () => {
    const dir = fixtureArtifactDir(false);
    const sandboxExec = path.join(dir, "sandbox-exec");
    const result = buildProtectedLaunchArgv(["/bin/echo", "x"], {
      backend: {
        kind: "seatbelt",
        sandboxExec,
        profilePath: defaultProfilePath(dir),
      },
    });
    assert.ok(result, "seatbelt backend should produce a launch spec");
    assert.equal(result.spec.kind, "seatbelt");
    assert.deepEqual(result.spec.argv, [
      sandboxExec,
      "-p",
      SEATBELT_PROFILE_TEXT,
      "/bin/echo",
      "x",
    ]);
  });

  it("returns null for argv construction when no backend is available", () => {
    const dir = fixtureArtifactDir(false);
    const backend = probeBackend({ platform: "linux", artifactDir: dir });
    assert.equal(backend.kind, "unavailable");
    const result = buildProtectedLaunchArgv(["/bin/echo"], { probe: { platform: "linux", artifactDir: dir } });
    assert.equal(result, null);
  });

  it("refuses to build argv for an empty command", () => {
    const dir = fixtureArtifactDir(true);
    const result = buildProtectedLaunchArgv([], {
      backend: { kind: "landlock", helperPath: defaultHelperPath(dir) },
    });
    assert.equal(result, null);
  });

  it("reflects the optional-build availability of dist/native honestly (landlock host)", () => {
    // npm test builds dist first. The optional-build contract does NOT promise
    // a compiled helper on every Linux host: pre-SIGNAL headers / a missing
    // compiler / an unsupported arch legitimately produce NO helper while the
    // build exits 0 and records an explicit .unavailable.json marker. Assert
    // the actual artifact state consistently with probeBackend — never demand
    // a helper the contract does not guarantee.
    const artifactDir = nativeArtifactsDir();
    const markerPath = path.join(artifactDir, UNAVAILABLE_MARKER_BASENAME);

    // The static Seatbelt profile asset is packaged on every platform.
    assert.ok(
      fs.existsSync(defaultProfilePath(artifactDir)),
      "dist/native/seatbelt-signal.sb missing after build",
    );

    if (process.platform !== "linux") return;

    const backend = probeBackend({ platform: "linux", artifactDir });
    if (backend.kind === "landlock") {
      assert.ok(
        fs.existsSync(defaultHelperPath(artifactDir)),
        "probe reports landlock so the compiled helper must be present",
      );
      assert.ok(
        !fs.existsSync(markerPath),
        "a landlock backend must not coexist with an unavailable marker",
      );
      return;
    }

    // Honest unavailable state on Linux: no helper, and either the last build
    // recorded an explicit marker (authoritative reason) or nothing was built.
    assert.equal(backend.kind, "unavailable");
    assert.ok(
      !fs.existsSync(defaultHelperPath(artifactDir)),
      "no helper may be present when the backend reports unavailable",
    );
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
        backend?: unknown;
        reason?: unknown;
      };
      assert.equal(marker.backend, "unavailable");
      assert.equal(
        marker.reason,
        backend.reason,
        "the unavailable marker's reason must drive the probe result",
      );
    } else {
      assert.equal(
        backend.reason,
        "landlock-helper-not-built",
        "without a marker the backend must report landlock-helper-not-built",
      );
    }
  });
});
