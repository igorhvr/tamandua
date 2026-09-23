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
