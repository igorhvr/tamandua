/**
 * Unit tests for the matchlock swap support probe (MTLK-ISO-SLICE2, US-001 /
 * MTLK-INTERACTIVE US-004 GAP-02).
 *
 * The probe is exercised with an injected runner for every decision branch and,
 * for the default bounded `spawnSync` runner, against throwaway shell scripts so
 * the real spawn path is covered without needing an installed matchlock.
 *
 * The swap probe differs from the allow-private probe in one crucial way: it
 * requires the EXACT `--swap` token, never a substring, so a near-miss such as
 * `--swap-size` is reported unsupported — while `--swap=512` still counts.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";

import {
  MATCHLOCK_RPC_BIN_ENV,
  MATCHLOCK_SWAP_FLAG,
  MATCHLOCK_SWAP_PROBE_TIMEOUT_MS,
  MATCHLOCK_SWAP_UNSUPPORTED_CODE,
  helpListsMatchlockSwapFlag,
  probeMatchlockSwapSupport,
  resolveMatchlockSwapBinaryPath,
  type MatchlockSwapRunHelpResult,
} from "../../../dist/installer/matchlock/swap-support.js";


const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = tamanduaTempDir("tamandua-swap-support-");
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
  "Guest swap:",
  "  Swap is provisioned as a sparse backing file and enabled at boot.",
  "      --swap int   Guest swap size in MB (0 disables)",
].join("\n");

const NEAR_MISS_HELP = [
  "Run a command in a new sandbox.",
  "",
  "Flags:",
  "      --swap-size int   Guest swap size in MB",
].join("\n");

/** Write an executable shell script under `dir`. */
function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("probeMatchlockSwapSupport: injected runner", () => {
  it("reports supported when run --help lists the exact --swap token and passes through path/version", async () => {
    const result = await probeMatchlockSwapSupport({
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
    const result = await probeMatchlockSwapSupport({
      binaryPath: "/usr/local/bin/matchlock",
      runHelp: () => ({ exitCode: 0, output: "Flags:\n  --memory int\n", version: "0.1.0" }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "unsupported");
    assert.match(result.reason ?? "", /--swap/);
    assert.equal(result.binaryPath, "/usr/local/bin/matchlock");
    assert.equal(result.version, "0.1.0");
  });

  it("reports unsupported for a near-miss token such as --swap-size", async () => {
    const result = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: 0, output: NEAR_MISS_HELP }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "unsupported");
    assert.equal(result.binaryPath, "matchlock");
  });

  it("never matches a substring inside a longer token (foo--swap, --swapfoo)", async () => {
    for (const output of [
      "Flags:\n  --swapfoo int\n",
      "Flags:\n  foo--swap\n",
      "Flags:\n  --no-swap\n",
    ]) {
      const result = await probeMatchlockSwapSupport({
        binaryPath: "matchlock",
        runHelp: () => ({ exitCode: 0, output }),
      });
      assert.equal(result.supported, false, `should not match: ${JSON.stringify(output)}`);
      assert.equal(result.reasonCode, "unsupported");
    }
  });

  it("matches the token at the start and end of the help text", async () => {
    const atStart = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: 0, output: `${MATCHLOCK_SWAP_FLAG} int` }),
    });
    assert.equal(atStart.supported, true);

    const atEnd = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: 0, output: `Flags:\n      ${MATCHLOCK_SWAP_FLAG}` }),
    });
    assert.equal(atEnd.supported, true);
  });

  it("reports a missing binary with reasonCode missing_binary", async () => {
    const result = await probeMatchlockSwapSupport({
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
    assert.equal(result.binaryPath, "matchlock");
    assert.match(result.reason ?? "", /not found/);
  });

  it("classifies a non-ENOENT spawn error as probe_failed", async () => {
    const result = await probeMatchlockSwapSupport({
      binaryPath: "/usr/bin/false",
      runHelp: () => ({
        exitCode: null,
        output: "",
        error: 'failed to run "/usr/bin/false run --help": EACCES',
      }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.equal(result.binaryPath, "/usr/bin/false");
    assert.match(result.reason ?? "", /EACCES/);
  });

  it("classifies a non-zero exit as probe_failed and names the code", async () => {
    const result = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: 3, output: SUPPORTING_HELP }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /exited with code 3/);
  });

  it("classifies a killed/signal child (null exit code) as probe_failed", async () => {
    const result = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: null, output: "" }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /did not exit/);
  });

  it("classifies unparseable (empty) output as probe_failed", async () => {
    const result = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => ({ exitCode: 0, output: "   \n\t" }),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.equal(result.binaryPath, "matchlock");
    assert.match(result.reason ?? "", /no usable output/);
  });

  it("never throws when the injected runner rejects", async () => {
    const result = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => {
        throw new Error("runner exploded");
      },
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.equal(result.binaryPath, "matchlock");
    assert.match(result.reason ?? "", /runner exploded/);
  });

  it("supports an async injected runner", async () => {
    const result = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: async () => ({ exitCode: 0, output: SUPPORTING_HELP }),
    });
    assert.equal(result.supported, true);
  });

  it("honors the TAMANDUA_MATCHLOCK_RPC_BIN override when no binaryPath is passed", async () => {
    const result = await probeMatchlockSwapSupport({
      env: { [MATCHLOCK_RPC_BIN_ENV]: "/custom/matchlock", PATH: "" },
      runHelp: () => ({ exitCode: 0, output: SUPPORTING_HELP }),
    });
    assert.equal(result.supported, true);
    assert.equal(result.binaryPath, "/custom/matchlock");
  });
});

describe("resolveMatchlockSwapBinaryPath", () => {
  it("prefers the trimmed TAMANDUA_MATCHLOCK_RPC_BIN override", () => {
    const env = { [MATCHLOCK_RPC_BIN_ENV]: "  /opt/custom/matchlock  ", PATH: "/usr/bin" };
    assert.equal(resolveMatchlockSwapBinaryPath(env), "/opt/custom/matchlock");
  });

  it("resolves the first executable `matchlock` on PATH to an absolute path", () => {
    const dir = makeTempDir();
    const bin = writeScript(dir, "matchlock", "exit 0");
    const resolved = resolveMatchlockSwapBinaryPath({ PATH: dir });
    assert.equal(resolved, bin);
    assert.equal(path.isAbsolute(resolved), true);
  });

  it("skips a non-executable matchlock file and keeps searching PATH", () => {
    const first = makeTempDir();
    const second = makeTempDir();
    fs.writeFileSync(path.join(first, "matchlock"), "not executable", { mode: 0o644 });
    const bin = writeScript(second, "matchlock", "exit 0");
    assert.equal(
      resolveMatchlockSwapBinaryPath({ PATH: `${first}${path.delimiter}${second}` }),
      bin,
    );
  });

  it("falls back to the bare name when matchlock is not on PATH", () => {
    const empty = makeTempDir();
    assert.equal(resolveMatchlockSwapBinaryPath({ PATH: empty }), "matchlock");
    assert.equal(resolveMatchlockSwapBinaryPath({}), "matchlock");
  });

  it("treats an EMPTY PATH component as the current directory, exactly like spawn (F1)", () => {
    // MTLK-ISO2-CORRECTIVE: `spawn` searches the child's cwd for an empty PATH
    // component, so the resolver must bind to that SAME executable — not skip
    // the empty entry and qualify a later binary.
    const cwd = makeTempDir();
    const qualified = makeTempDir();
    const previous = process.cwd();
    try {
      const shadow = writeScript(cwd, "matchlock", "exit 0");
      const other = writeScript(qualified, "matchlock", "exit 0");
      process.chdir(cwd);
      const resolved = resolveMatchlockSwapBinaryPath({
        PATH: `${path.delimiter}${qualified}`,
      });
      assert.equal(resolved, shadow, "the empty component (cwd) wins over the later qualified dir");
      assert.notEqual(resolved, other);
    } finally {
      process.chdir(previous);
    }
  });

  it("returns an absolute path for a relative PATH override (F6)", () => {
    const env = { [MATCHLOCK_RPC_BIN_ENV]: "matchlock" };
    assert.equal(resolveMatchlockSwapBinaryPath(env), path.resolve("matchlock"));
  });
});

describe("probeMatchlockSwapSupport: default bounded runner", () => {
  it("probes a real supporting script and parses its version", async () => {
    const dir = makeTempDir();
    const bin = writeScript(
      dir,
      "matchlock",
      [
        'if [ "$1" = "--version" ]; then echo "matchlock version 9.9.9"; exit 0; fi',
        'echo "Run a command in a new sandbox."',
        'echo "      --swap int   Guest swap size in MB"',
        "exit 0",
      ].join("\n"),
    );
    const result = await probeMatchlockSwapSupport({ binaryPath: bin });
    assert.equal(result.supported, true);
    assert.equal(result.binaryPath, bin);
    assert.equal(result.version, "9.9.9");
  });

  it("probes a real script with only a near-miss flag and reports unsupported", async () => {
    const dir = makeTempDir();
    const bin = writeScript(
      dir,
      "matchlock",
      ['echo "Run a command in a new sandbox."', 'echo "      --swap-size int"', "exit 0"].join("\n"),
    );
    const result = await probeMatchlockSwapSupport({ binaryPath: bin });
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
    const result = await probeMatchlockSwapSupport({ binaryPath: bin });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.match(result.reason ?? "", /exited with code 7/);
  });

  it("reports probe_failed when the run --help subprocess times out", async () => {
    const dir = makeTempDir();
    const bin = writeScript(dir, "matchlock", "sleep 10; exit 0");
    const result = await probeMatchlockSwapSupport({ binaryPath: bin, timeoutMs: 200 });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "probe_failed");
    assert.equal(result.binaryPath, bin);
    assert.match(result.reason ?? "", /ETIMEDOUT|timed out/i);
  });

  it("reports missing_binary for a path that does not exist", async () => {
    const dir = makeTempDir();
    const result = await probeMatchlockSwapSupport({
      binaryPath: path.join(dir, "does-not-exist"),
    });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "missing_binary");
    assert.equal(result.binaryPath, path.join(dir, "does-not-exist"));
  });

  it("resolves the binary from env when none is passed explicitly", async () => {
    const dir = makeTempDir();
    const bin = writeScript(
      dir,
      "matchlock",
      ['echo "      --swap int"', "exit 0"].join("\n"),
    );
    const result = await probeMatchlockSwapSupport({
      env: { [MATCHLOCK_RPC_BIN_ENV]: bin, PATH: dir },
    });
    assert.equal(result.supported, true);
    assert.equal(result.binaryPath, bin);
  });
});

function result(overrides: Partial<MatchlockSwapRunHelpResult> = {}): MatchlockSwapRunHelpResult {
  return { exitCode: 0, output: "", ...overrides };
}

const SWAP_HELP = `
Usage:
  matchlock run [flags]

Flags:
  --cpus int      vCPUs
  --swap int      Swap device size in MB (0 = off)
`;

describe("helpListsMatchlockSwapFlag (full-token matcher)", () => {
  it("accepts the exact --swap token in help output", () => {
    assert.equal(helpListsMatchlockSwapFlag(SWAP_HELP), true);
    assert.equal(helpListsMatchlockSwapFlag("  --swap int  Swap device size in MB (0 = off)"), true);
    assert.equal(helpListsMatchlockSwapFlag("--swap=512"), true);
  });

  it("rejects a substring / unrelated token", () => {
    assert.equal(helpListsMatchlockSwapFlag("--matchlock-swap int"), false);
    assert.equal(helpListsMatchlockSwapFlag("--swap-limit int"), false);
    assert.equal(helpListsMatchlockSwapFlag("--noswap"), false);
    assert.equal(helpListsMatchlockSwapFlag(""), false);
  });
});

describe("probeMatchlockSwapSupport", () => {
  it("reports supported when run --help exits 0 and lists --swap", async () => {
    const seen: string[] = [];
    const support = await probeMatchlockSwapSupport({
      binaryPath: "/opt/fake/matchlock",
      runHelp: (bin) => {
        seen.push(bin);
        return result({ output: SWAP_HELP, version: "0.2.17" });
      },
    });
    assert.deepEqual(seen, ["/opt/fake/matchlock"]);
    assert.equal(support.supported, true);
    assert.equal(support.binaryPath, "/opt/fake/matchlock");
    assert.equal(support.version, "0.2.17");
  });

  it("reports unsupported (typed) when the flag is absent", async () => {
    const support = await probeMatchlockSwapSupport({
      binaryPath: "/opt/fake/matchlock",
      runHelp: () => result({ output: "Flags:\n  --cpus int\n" }),
    });
    assert.equal(support.supported, false);
    assert.equal(support.reasonCode, "unsupported");
    assert.match(support.reason ?? "", /--swap/);
  });

  it("reports missing_binary on an ENOENT launch failure", async () => {
    const support = await probeMatchlockSwapSupport({
      binaryPath: "/opt/fake/matchlock",
      runHelp: () =>
        result({
          exitCode: null,
          error: "matchlock binary not found: /opt/fake/matchlock",
          missingBinary: true,
        }),
    });
    assert.equal(support.supported, false);
    assert.equal(support.reasonCode, "missing_binary");
  });

  it("reports probe_failed on a non-zero exit, killed child and thrown runner", async () => {
    const nonZero = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => result({ exitCode: 2, output: SWAP_HELP }),
    });
    assert.equal(nonZero.reasonCode, "probe_failed");

    const killed = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => result({ exitCode: null }),
    });
    assert.equal(killed.reasonCode, "probe_failed");
    assert.match(killed.reason ?? "", /did not exit/);

    const threw = await probeMatchlockSwapSupport({
      binaryPath: "matchlock",
      runHelp: () => {
        throw new Error("boom");
      },
    });
    assert.equal(threw.reasonCode, "probe_failed");
    assert.match(threw.reason ?? "", /boom/);
  });

  it("resolves the binary from TAMANDUA_MATCHLOCK_RPC_BIN when no path is supplied", async () => {
    const seen: string[] = [];
    const support = await probeMatchlockSwapSupport({
      env: { [MATCHLOCK_RPC_BIN_ENV]: "  /custom/matchlock  " },
      runHelp: (bin) => {
        seen.push(bin);
        return result({ output: SWAP_HELP });
      },
    });
    assert.deepEqual(seen, ["/custom/matchlock"]);
    assert.equal(support.binaryPath, "/custom/matchlock");
  });

  it("exposes the bounded probe timeout and typed refusal code", () => {
    assert.equal(typeof MATCHLOCK_SWAP_PROBE_TIMEOUT_MS, "number");
    assert.equal(MATCHLOCK_SWAP_PROBE_TIMEOUT_MS, 10_000);
    assert.equal(MATCHLOCK_SWAP_FLAG, "--swap");
    assert.equal(MATCHLOCK_SWAP_UNSUPPORTED_CODE, "matchlock_swap_unsupported");
  });
});
