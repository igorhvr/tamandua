/**
 * Unit tests for the matchlock allow-private support probe (MTLK-ALLOW-PRIVATE,
 * US-007).
 *
 * The probe is exercised with an injected runner for every decision branch and,
 * for the default bounded `spawnSync` runner, against throwaway shell scripts so
 * the real spawn path is covered without needing an installed matchlock.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";

import {
  MATCHLOCK_ALLOW_PRIVATE_FLAG,
  MATCHLOCK_RPC_BIN_ENV,
  probeMatchlockAllowPrivateSupport,
  resolveMatchlockRpcBinary,
  resolveMatchlockRpcBinaryPath,
} from "../../../dist/installer/matchlock/allow-private-support.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = tamanduaTempDir("tamandua-allow-private-support-");
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const SUPPORTING_HELP = [
  "Run a command in a new sandbox.",
  "",
  "Private-IP exemptions with --allow-private:",
  "  Private, link-local, CGNAT and Yggdrasil destinations are blocked by default.",
  "      --allow-private stringArray        Allow an otherwise-blocked private destination",
].join("\n");

const UNSUPPORTING_HELP = [
  "Run a command in a new sandbox.",
  "",
  "Flags:",
  "      --allow-host stringArray   Allow a host",
].join("\n");

/** Write an executable shell script under `dir`. */
function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("probeMatchlockAllowPrivateSupport: injected runner", () => {
  it("reports supported when run --help lists --allow-private and passes through path/version", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "/opt/matchlock/bin/matchlock",
      runHelp: () => ({
        exitCode: 0,
        output: SUPPORTING_HELP,
        version: "0.2.17",
      }),
    });
    assert.equal(result.supported, true);
    assert.equal(result.binaryPath, "/opt/matchlock/bin/matchlock");
    assert.equal(result.version, "0.2.17");
    assert.equal(result.reason, undefined);
    assert.equal(result.reasonCode, undefined);
  });

  it("reports unsupported (without throwing) when run --help lacks the flag", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "/usr/local/bin/matchlock",
      runHelp: () => ({ exitCode: 0, output: UNSUPPORTING_HELP, version: "0.1.0" }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "unsupported");
    assert.match(result.reason ?? "", /--allow-private/);
    assert.equal(result.version, "0.1.0");
  });

  it("reports a missing binary with reasonCode missing_binary", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "matchlock",
      runHelp: () => ({
        exitCode: null,
        output: "",
        missingBinary: true,
        error: "matchlock binary not found: matchlock",
      }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "missing_binary");
    assert.match(result.reason ?? "", /not found/);
  });

  it("classifies a non-ENOENT spawn error as probe_failed", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "/usr/bin/false",
      runHelp: () => ({
        exitCode: null,
        output: "",
        error: 'failed to run "/usr/bin/false run --help": EACCES',
      }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /EACCES/);
  });

  it("classifies a non-zero exit as probe_failed and names the code", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: 3, output: SUPPORTING_HELP }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /exited with code 3/);
  });

  it("classifies a killed/signal child (null exit code) as probe_failed", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: null, output: "" }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /did not exit/);
  });

  it("never throws when the injected runner rejects", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "matchlock",
      runHelp: () => {
        throw new Error("runner exploded");
      },
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /runner exploded/);
  });

  it("supports an async injected runner", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "matchlock",
      runHelp: async () => ({ exitCode: 0, output: SUPPORTING_HELP }),
    });
    assert.equal(result.supported, true);
  });

  it("treats the literal flag token anywhere in the help text as support", async () => {
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: "matchlock",
      runHelp: () => ({
        exitCode: 0,
        output: `      ${MATCHLOCK_ALLOW_PRIVATE_FLAG} stringArray   Allow a private destination`,
      }),
    });
    assert.equal(result.supported, true);
  });
});

describe("resolveMatchlockRpcBinaryPath", () => {
  it("prefers the trimmed TAMANDUA_MATCHLOCK_RPC_BIN override", () => {
    const env = { [MATCHLOCK_RPC_BIN_ENV]: "  /opt/custom/matchlock  ", PATH: "/usr/bin" };
    assert.equal(resolveMatchlockRpcBinaryPath(env), "/opt/custom/matchlock");
  });

  it("resolves the first executable `matchlock` on PATH", () => {
    const dir = makeTempDir();
    const bin = writeScript(dir, "matchlock", "exit 0");
    assert.equal(resolveMatchlockRpcBinaryPath({ PATH: dir }), bin);
  });

  it("skips a non-executable matchlock file and keeps searching PATH", () => {
    const first = makeTempDir();
    const second = makeTempDir();
    fs.writeFileSync(path.join(first, "matchlock"), "not executable", { mode: 0o644 });
    const bin = writeScript(second, "matchlock", "exit 0");
    assert.equal(
      resolveMatchlockRpcBinaryPath({ PATH: `${first}${path.delimiter}${second}` }),
      bin,
    );
  });

  it("falls back to the bare name when matchlock is not on PATH", () => {
    const empty = makeTempDir();
    assert.equal(resolveMatchlockRpcBinaryPath({ PATH: empty }), "matchlock");
    assert.equal(resolveMatchlockRpcBinaryPath({}), "matchlock");
  });
});

describe("resolveMatchlockRpcBinary provenance (SETUP-S2 §0)", () => {
  it("reports override provenance and executability for a usable override", () => {
    const dir = makeTempDir();
    const bin = writeScript(dir, "matchlock", "exit 0");
    const resolved = resolveMatchlockRpcBinary({
      [MATCHLOCK_RPC_BIN_ENV]: `  ${bin}  `,
      PATH: "/usr/bin",
    });
    assert.equal(resolved.path, bin);
    assert.equal(resolved.source, "override");
    assert.equal(resolved.envOverrideSet, true);
    assert.equal(resolved.executable, true);
  });

  it("reports a set-but-missing override as override, not-executable", () => {
    const resolved = resolveMatchlockRpcBinary({
      [MATCHLOCK_RPC_BIN_ENV]: "/nonexistent/matchlock",
    });
    assert.equal(resolved.path, "/nonexistent/matchlock");
    assert.equal(resolved.source, "override");
    assert.equal(resolved.envOverrideSet, true);
    assert.equal(resolved.executable, false);
  });

  it("reports PATH provenance for an executable matchlock", () => {
    const dir = makeTempDir();
    const bin = writeScript(dir, "matchlock", "exit 0");
    const resolved = resolveMatchlockRpcBinary({ PATH: dir });
    assert.equal(resolved.path, bin);
    assert.equal(resolved.source, "path");
    assert.equal(resolved.executable, true);
    assert.equal(resolved.envOverrideSet, false);
  });

  it("reports path_unusable for a present-but-non-executable matchlock", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "matchlock");
    fs.writeFileSync(file, "not executable", { mode: 0o644 });
    const resolved = resolveMatchlockRpcBinary({ PATH: dir });
    assert.equal(resolved.path, file);
    assert.equal(resolved.source, "path_unusable");
    assert.equal(resolved.executable, false);
  });

  it("reports unresolved when nothing is found", () => {
    const empty = makeTempDir();
    const resolved = resolveMatchlockRpcBinary({ PATH: empty });
    assert.equal(resolved.path, "matchlock");
    assert.equal(resolved.source, "unresolved");
    assert.equal(resolved.envOverrideSet, false);
    assert.equal(resolved.executable, false);
  });

  it("keeps the string wrapper's historical contract for unusable/unresolved paths", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "matchlock"), "not executable", { mode: 0o644 });
    assert.equal(resolveMatchlockRpcBinaryPath({ PATH: dir }), "matchlock");
    assert.equal(resolveMatchlockRpcBinaryPath({}), "matchlock");
  });

  it("annotates probe results with the resolution provenance", async () => {
    const dir = makeTempDir();
    writeScript(
      dir,
      "matchlock",
      'echo "      --allow-private stringArray   Allow a private destination"',
    );
    const result = await probeMatchlockAllowPrivateSupport({ env: { PATH: dir } });
    assert.equal(result.supported, true);
    assert.equal(result.resolvedFrom, "path");
    assert.equal(result.envOverrideSet, false);
  });
});

describe("resolveMatchlockRpcBinary runner-launcher agreement (SETUP-S2 corrective)", () => {
  it("resolves a BARE override by searching PATH, matching the runner's OS spawn", () => {
    const dir = makeTempDir();
    const bin = writeScript(dir, "chosen", "exit 0");
    const resolved = resolveMatchlockRpcBinary({
      [MATCHLOCK_RPC_BIN_ENV]: "chosen",
      PATH: dir,
    });
    assert.equal(resolved.source, "override");
    assert.equal(resolved.envOverrideSet, true);
    assert.equal(resolved.executable, true);
    assert.equal(resolved.path, bin);
  });

  it("does NOT resolve a bare override against cwd when PATH cannot launch it", () => {
    // A cwd decoy named like the override must not fool the resolver: the
    // runner hands the bare name to spawn, which searches PATH only.
    const decoy = makeTempDir();
    writeScript(decoy, "chosen", "exit 0");
    const empty = makeTempDir();
    const resolved = resolveMatchlockRpcBinary({
      [MATCHLOCK_RPC_BIN_ENV]: "chosen",
      PATH: empty,
    });
    assert.equal(resolved.source, "override");
    assert.equal(resolved.executable, false);
    assert.equal(resolved.path, "chosen");
  });

  it("treats an empty PATH component as the current working directory", () => {
    const dir = makeTempDir();
    const bin = writeScript(dir, "matchlock", "exit 0");
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const resolved = resolveMatchlockRpcBinary({ PATH: `:${makeTempDir()}` });
      assert.equal(resolved.source, "path");
      assert.equal(resolved.executable, true);
      assert.equal(resolved.path, bin);
    } finally {
      process.chdir(previous);
    }
  });

  it("reports path_unusable for an executable file the OS cannot launch", () => {
    // X_OK passes but the shebang interpreter does not exist, so execve (and
    // the runner's real spawn) fails with ENOENT.
    const dir = makeTempDir();
    const file = path.join(dir, "matchlock");
    fs.writeFileSync(file, "#!/definitely-absent-s2-interpreter\n", { mode: 0o755 });
    const resolved = resolveMatchlockRpcBinary({ PATH: dir });
    assert.equal(resolved.source, "path_unusable");
    assert.equal(resolved.executable, false);
    assert.equal(resolved.path, file);
  });

  it("skips an unlaunchable PATH entry and uses a later launchable one", () => {
    const bad = makeTempDir();
    fs.writeFileSync(path.join(bad, "matchlock"), "#!/absent-s2-interp\n", { mode: 0o755 });
    const good = makeTempDir();
    const bin = writeScript(good, "matchlock", "exit 0");
    const resolved = resolveMatchlockRpcBinary({
      PATH: `${bad}${path.delimiter}${good}`,
    });
    assert.equal(resolved.source, "path");
    assert.equal(resolved.executable, true);
    assert.equal(resolved.path, bin);
  });
});

describe("probeMatchlockAllowPrivateSupport: default bounded runner", () => {
  it("probes a real supporting script and parses its version", async () => {
    const dir = makeTempDir();
    const bin = writeScript(
      dir,
      "matchlock",
      [
        'if [ "$1" = "--version" ]; then echo "matchlock version 9.9.9"; exit 0; fi',
        'echo "Run a command in a new sandbox."',
        'echo "      --allow-private stringArray   Allow a private destination"',
        "exit 0",
      ].join("\n"),
    );
    const result = await probeMatchlockAllowPrivateSupport({ binaryPath: bin });
    assert.equal(result.supported, true);
    assert.equal(result.binaryPath, bin);
    assert.equal(result.version, "9.9.9");
  });

  it("probes a real script without the flag and reports unsupported", async () => {
    const dir = makeTempDir();
    const bin = writeScript(
      dir,
      "matchlock",
      ['echo "Run a command in a new sandbox."', 'echo "      --allow-host stringArray"', "exit 0"].join("\n"),
    );
    const result = await probeMatchlockAllowPrivateSupport({ binaryPath: bin });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "unsupported");
  });

  it("reports probe_failed for a script that exits non-zero on run --help", async () => {
    const dir = makeTempDir();
    const bin = writeScript(
      dir,
      "matchlock",
      ['if [ "$1" = "run" ]; then echo "boom" 1>&2; exit 7; fi', "exit 0"].join("\n"),
    );
    const result = await probeMatchlockAllowPrivateSupport({ binaryPath: bin });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /exited with code 7/);
  });

  it("reports missing_binary for a path that does not exist", async () => {
    const dir = makeTempDir();
    const result = await probeMatchlockAllowPrivateSupport({
      binaryPath: path.join(dir, "does-not-exist"),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "missing_binary");
  });

  it("resolves the binary from env when none is passed explicitly", async () => {
    const dir = makeTempDir();
    const bin = writeScript(
      dir,
      "matchlock",
      ['echo "      --allow-private stringArray"', "exit 0"].join("\n"),
    );
    const result = await probeMatchlockAllowPrivateSupport({
      env: { [MATCHLOCK_RPC_BIN_ENV]: bin, PATH: dir },
    });
    assert.equal(result.supported, true);
    assert.equal(result.binaryPath, bin);
  });
});
