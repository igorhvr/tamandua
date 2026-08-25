import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const binDir = path.join(
  repoRoot,
  "torture-test",
  "scripted-runtimes",
  "bin",
);

// ── Helpers for the portable node-resolution cases ───────────────────

// The host's real node binary (volta / nix / PATH — wherever `command -v
// node` finds it on the machine running the tests).
const hostNode = (() => {
  try {
    return execSync("command -v node", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
})();

const hostBash = (() => {
  try {
    return execSync("command -v bash", { encoding: "utf-8" }).trim();
  } catch {
    return "/bin/bash";
  }
})();

const hostDirname = (() => {
  try {
    return execSync("command -v dirname", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/bin/dirname";
  }
})();

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// runShim: invoke a shim under a fully controlled env -i environment and
// return the thrown error (the shim always exits non-zero in these tests —
// either via the runtime's parse rejection or via fail-closed node error).
function runShimExpectFailure(
  shimName: string,
  pathEnv: string,
  extraArgs: string[],
): { status: number | null; stderr: string; stdout: string } {
  const shim = path.join(binDir, shimName);
  try {
    execSync(
      `env -i PATH=${pathEnv} ${shim} ${extraArgs.join(" ")}`,
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      },
    );
  } catch (e) {
    const err = e as any;
    return {
      status: typeof err.status === "number" ? err.status : null,
      stderr: err.stderr ?? "",
      stdout: err.stdout ?? "",
    };
  }
  throw new Error(`expected non-zero exit from ${shimName}`);
}

// A controlled PATH that contains ONLY the shim's own dependencies (bash +
// dirname) and NO node anywhere — pins the fail-closed branch.
function nodeFreePath(): { pathEnv: string; cleanup: () => void } {
  const dir = tmpDir("tt-shim-nobin-");
  fs.symlinkSync(hostBash, path.join(dir, "bash"));
  fs.symlinkSync(hostDirname, path.join(dir, "dirname"));
  return { pathEnv: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A controlled PATH whose FIRST entry holds a wrapper named `node` that
// records its own invocation path to a proof file and then execs the host's
// real node — proves the shim resolved node via `command -v` on ITS PATH
// (the wrapper), not via TT_NODE_BIN or any hardcoded path.
function nodeWrapperPath(): {
  pathEnv: string;
  wrapperPath: string;
  proofFile: string;
  cleanup: () => void;
} {
  const dir = tmpDir("tt-shim-node-");
  const wrapperPath = path.join(dir, "node");
  const proofFile = path.join(dir, "node-invoked.proof");
  const wrapper = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$0" > "${proofFile}"`,
    `exec "${hostNode}" "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  return {
    pathEnv: `${dir}:/usr/bin:/bin`,
    wrapperPath,
    proofFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("scripted wrapper scripts (US-001)", () => {
  it("bin/ directory exists", () => {
    assert.ok(
      fs.statSync(binDir).isDirectory(),
      "torture-test/scripted-runtimes/bin/ must be a directory",
    );
  });

  it("bin/scripted-pi exists and is executable", () => {
    const p = path.join(binDir, "scripted-pi");
    assert.ok(fs.existsSync(p), "scripted-pi must exist");
    fs.accessSync(p, fs.constants.X_OK);
  });

  it("bin/scripted-hermes exists and is executable", () => {
    const p = path.join(binDir, "scripted-hermes");
    assert.ok(fs.existsSync(p), "scripted-hermes must exist");
    fs.accessSync(p, fs.constants.X_OK);
  });

  // AC 2: Both scripts exec via $NODE_BIN (a variable holding an absolute
  // path), never a bare PATH-dependent "node" command.
  it("scripted-pi uses absolute node path (no relative node or PATH-dependent node)", () => {
    const content = fs.readFileSync(
      path.join(binDir, "scripted-pi"),
      "utf-8",
    );
    const codeLines = content
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && l.trim() !== "")
      .filter((l) => l.includes("exec"));
    assert.ok(codeLines.length > 0, "scripted-pi must have an exec line");
    for (const line of codeLines) {
      assert.ok(
        line.includes("\"$NODE_BIN\""),
        `scripted-pi exec line must use "$NODE_BIN" (absolute path variable): ${line}`,
      );
    }
  });

  it("scripted-hermes uses absolute node path (no relative node or PATH-dependent node)", () => {
    const content = fs.readFileSync(
      path.join(binDir, "scripted-hermes"),
      "utf-8",
    );
    const codeLines = content
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && l.trim() !== "")
      .filter((l) => l.includes("exec"));
    assert.ok(codeLines.length > 0, "scripted-hermes must have an exec line");
    for (const line of codeLines) {
      assert.ok(
        line.includes("\"$NODE_BIN\""),
        `scripted-hermes exec line must use "$NODE_BIN" (absolute path variable): ${line}`,
      );
    }
  });

  // AC 1: no machine-specific home literal may remain in the shims.
  it("scripted-pi and scripted-hermes contain no /home/ or /Users/ literals", () => {
    for (const shim of ["scripted-pi", "scripted-hermes"]) {
      const content = fs.readFileSync(path.join(binDir, shim), "utf-8");
      assert.ok(
        !content.includes("/home/") && !content.includes("/Users/"),
        `${shim} must not contain a machine-specific home literal`,
      );
    }
  });

  // AC 3 (fail-closed): with NO node resolvable on PATH and TT_NODE_BIN
  // unset, the shim emits its own clear error and exits 1 — never bash's
  // "command not found".
  it("scripted-pi is fail-closed: no node resolvable -> clear error, never 'command not found'", () => {
    const { pathEnv, cleanup } = nodeFreePath();
    try {
      const { status, stderr } = runShimExpectFailure("scripted-pi", pathEnv, []);
      assert.strictEqual(status, 1, "fail-closed exit must be 1");
      assert.ok(
        stderr.includes("node binary not found"),
        `Must emit the preserved clear error. Got: ${stderr.slice(0, 300)}`,
      );
      assert.ok(
        stderr.includes("Set TT_NODE_BIN to the absolute path of the node binary."),
        `Must keep the TT_NODE_BIN guidance line. Got: ${stderr.slice(0, 300)}`,
      );
      assert.ok(
        !stderr.toLowerCase().includes("command not found"),
        `Must never emit 'command not found'. Got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("scripted-hermes is fail-closed: no node resolvable -> clear error, never 'command not found'", () => {
    const { pathEnv, cleanup } = nodeFreePath();
    try {
      const { status, stderr } = runShimExpectFailure("scripted-hermes", pathEnv, []);
      assert.strictEqual(status, 1, "fail-closed exit must be 1");
      assert.ok(
        stderr.includes("node binary not found"),
        `Must emit the preserved clear error. Got: ${stderr.slice(0, 300)}`,
      );
      assert.ok(
        stderr.includes("Set TT_NODE_BIN to the absolute path of the node binary."),
        `Must keep the TT_NODE_BIN guidance line. Got: ${stderr.slice(0, 300)}`,
      );
      assert.ok(
        !stderr.toLowerCase().includes("command not found"),
        `Must never emit 'command not found'. Got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      cleanup();
    }
  });

  // AC 2 (command -v fallback): TT_NODE_BIN unset + a node first on PATH ->
  // the shim resolves node via `command -v node` and execs the runtime with
  // it. The wrapper records that it (the PATH-resolved node) was invoked.
  it("scripted-pi resolves node via 'command -v node' when TT_NODE_BIN is unset (fallback)", () => {
    const { pathEnv, wrapperPath, proofFile, cleanup } = nodeWrapperPath();
    try {
      const uniquePrompt = "US001_FALLBACK_pi_1845";
      const { stderr } = runShimExpectFailure("scripted-pi", pathEnv, [
        "--print",
        "--mode",
        "json",
        `'${uniquePrompt}'`,
      ]);
      // The PATH-resolved node wrapper must have been the one invoked.
      assert.strictEqual(
        fs.readFileSync(proofFile, "utf-8").trim(),
        wrapperPath,
        "the shim must exec the node resolved from its own PATH",
      );
      // ... and the runtime must have executed (parse rejection echoes the prompt).
      assert.ok(
        stderr.includes("could not parse"),
        `Runtime must execute via the PATH-resolved node. Got: ${stderr.slice(0, 300)}`,
      );
      assert.ok(
        stderr.includes(uniquePrompt),
        `Prompt must reach the runtime. Got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("scripted-hermes resolves node via 'command -v node' when TT_NODE_BIN is unset (fallback)", () => {
    const { pathEnv, wrapperPath, proofFile, cleanup } = nodeWrapperPath();
    try {
      const uniquePrompt = "US001_FALLBACK_hermes_2917";
      const { stderr } = runShimExpectFailure("scripted-hermes", pathEnv, [
        "--print",
        `'${uniquePrompt}'`,
      ]);
      assert.strictEqual(
        fs.readFileSync(proofFile, "utf-8").trim(),
        wrapperPath,
        "the shim must exec the node resolved from its own PATH",
      );
      assert.ok(
        stderr.includes("could not parse"),
        `Runtime must execute via the PATH-resolved node. Got: ${stderr.slice(0, 300)}`,
      );
      assert.ok(
        stderr.includes(uniquePrompt),
        `Prompt must reach the runtime. Got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      cleanup();
    }
  });

  // AC 5: Scripts pass the correct arguments through to the runtime. Uses a
  // node-on-PATH environment (portable) so it works on hosts without
  // /usr/bin/node (mac).
  it("scripted-pi passes arguments through to the runtime", () => {
    // The runtime uses process.argv[last] as the prompt. Passing a known
    // unique string as the prompt verifies argument forwarding.
    // Runtime exits non-zero when prompt can't be parsed, but the prompt
    // text itself appears in the error output — proving args were forwarded.
    const { pathEnv, cleanup } = nodeWrapperPath();
    try {
      const uniquePrompt = "US001_ARG_TEST_pi_8472";
      const { stderr } = runShimExpectFailure("scripted-pi", pathEnv, [
        "--print",
        "--mode",
        "json",
        `'${uniquePrompt}'`,
      ]);
      assert.ok(
        stderr.includes(uniquePrompt),
        `scripted-pi must forward the prompt argument. Got stderr: ${stderr.slice(0, 300)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("scripted-hermes passes arguments through to the runtime", () => {
    const { pathEnv, cleanup } = nodeWrapperPath();
    try {
      const uniquePrompt = "US001_ARG_TEST_hermes_2938";
      const { stderr } = runShimExpectFailure("scripted-hermes", pathEnv, [
        "--print",
        `'${uniquePrompt}'`,
      ]);
      assert.ok(
        stderr.includes(uniquePrompt),
        `scripted-hermes must forward the prompt argument. Got stderr: ${stderr.slice(0, 300)}`,
      );
    } finally {
      cleanup();
    }
  });

  // Shebang must be #!/usr/bin/env bash
  it("scripted-pi has correct shebang", () => {
    const content = fs.readFileSync(
      path.join(binDir, "scripted-pi"),
      "utf-8",
    );
    assert.match(
      content.split("\n")[0],
      /^#!\/usr\/bin\/env\s+bash/,
      "scripted-pi must use #!/usr/bin/env bash shebang",
    );
  });

  it("scripted-hermes has correct shebang", () => {
    const content = fs.readFileSync(
      path.join(binDir, "scripted-hermes"),
      "utf-8",
    );
    assert.match(
      content.split("\n")[0],
      /^#!\/usr\/bin\/env\s+bash/,
      "scripted-hermes must use #!/usr/bin/env bash shebang",
    );
  });

  // TT_NODE_BIN override (contract unchanged): a TT_NODE_BIN pointing at a
  // nonexistent binary must fail with the shim's own clear error — not
  // bash's "command not found".
  it("scripted-pi respects TT_NODE_BIN override", () => {
    try {
      execSync(
        `env -i TT_NODE_BIN=/nonexistent/node/path PATH=/usr/bin:/bin ${path.join(binDir, "scripted-pi")}`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
        },
      );
      assert.fail("should have thrown due to non-zero exit");
    } catch (e) {
      const stderr: string = (e as any).stderr ?? "";
      assert.ok(
        stderr.includes("node binary not found"),
        `TT_NODE_BIN override: should show clear error. Got: ${stderr}`,
      );
    }
  });

  it("scripted-hermes respects TT_NODE_BIN override", () => {
    try {
      execSync(
        `env -i TT_NODE_BIN=/nonexistent/node/path PATH=/usr/bin:/bin ${path.join(binDir, "scripted-hermes")}`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
        },
      );
      assert.fail("should have thrown due to non-zero exit");
    } catch (e) {
      const stderr: string = (e as any).stderr ?? "";
      assert.ok(
        stderr.includes("node binary not found"),
        `TT_NODE_BIN override: should show clear error. Got: ${stderr}`,
      );
    }
  });

  // Verify the wrappers reference the correct runtime files
  it("scripted-pi targets runtime-pi.mjs", () => {
    const content = fs.readFileSync(
      path.join(binDir, "scripted-pi"),
      "utf-8",
    );
    assert.ok(
      content.includes("runtime-pi.mjs"),
      "scripted-pi must reference runtime-pi.mjs",
    );
  });

  it("scripted-hermes targets runtime-hermes.mjs", () => {
    const content = fs.readFileSync(
      path.join(binDir, "scripted-hermes"),
      "utf-8",
    );
    assert.ok(
      content.includes("runtime-hermes.mjs"),
      "scripted-hermes must reference runtime-hermes.mjs",
    );
  });
});

// ── env/tt-env-scripted.sh TT_NODE_BIN export (US-002) ────────────────
//
// The contained scripted daemon's spawn env comes from
// `bash torture-test/env/tt-env-scripted.sh print` (daemon-control
// env_for_kind('scripted')), so the env script must export TT_NODE_BIN
// resolved from the launching host's real node — the shims then always
// have an absolute, executable node path even when the daemon's
// reconstructed PATH cannot resolve node.

const envScript = path.join(repoRoot, "torture-test", "env", "tt-env-scripted.sh");

// A controlled PATH whose FIRST entry holds a `node` (symlink to the host's
// real node) and which contains NO volta anywhere — the "volta masked from
// PATH, PATH-only node" shape. Returns the PATH and the exact node path
// `command -v node` must resolve.
function voltaMaskedNodePath(): {
  pathEnv: string;
  nodePath: string;
  cleanup: () => void;
} {
  const dir = tmpDir("tt-env-node-");
  const nodePath = path.join(dir, "node");
  fs.symlinkSync(hostNode, nodePath);
  return {
    pathEnv: `${dir}:/usr/bin:/bin`,
    nodePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// parseEnvPrint: extract the value of $1 from `tt-env-scripted.sh print`
// output (KEY=VALUE lines, one per var).
function envPrintValue(out: string, key: string): string {
  const m = out.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1] : "";
}

describe("env/tt-env-scripted.sh TT_NODE_BIN export (US-002)", () => {
  it("env script exists", () => {
    assert.ok(
      fs.existsSync(envScript),
      "torture-test/env/tt-env-scripted.sh must exist",
    );
  });

  // AC 1: `bash torture-test/env/tt-env-scripted.sh print` emits a
  // TT_NODE_BIN=<absolute path> line whose path exists and is executable.
  it("print emits TT_NODE_BIN=<absolute executable path>", () => {
    const out = execSync(`bash ${envScript} print`, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15000,
    });
    const bin = envPrintValue(out, "TT_NODE_BIN");
    assert.ok(bin, `print must emit TT_NODE_BIN. Got:\n${out}`);
    assert.ok(
      bin.startsWith("/"),
      `TT_NODE_BIN must be an absolute path. Got: ${bin}`,
    );
    assert.ok(
      fs.existsSync(bin),
      `TT_NODE_BIN must exist on the host. Got: ${bin}`,
    );
    fs.accessSync(bin, fs.constants.X_OK);
  });

  // AC 2: with volta masked from PATH (no volta anywhere) and TT_NODE_BIN
  // unset (env -i), the env script still emits an executable TT_NODE_BIN —
  // resolved via `command -v node` on its own PATH (the PATH-only node),
  // never a hardcoded volta path.
  it("print emits executable TT_NODE_BIN with volta masked and TT_NODE_BIN unset (command -v fallback)", () => {
    const { pathEnv, nodePath, cleanup } = voltaMaskedNodePath();
    try {
      const out = execSync(
        `env -i HOME= PATH=${pathEnv} bash ${envScript} print`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 15000,
        },
      );
      const bin = envPrintValue(out, "TT_NODE_BIN");
      assert.ok(bin, `must emit TT_NODE_BIN with volta masked. Got:\n${out}`);
      assert.strictEqual(
        bin,
        nodePath,
        "must resolve node via command -v on the env script's own PATH (volta masked)",
      );
      fs.accessSync(bin, fs.constants.X_OK);
    } finally {
      cleanup();
    }
  });

  // The env script must never fabricate TT_NODE_BIN from a hardcoded home
  // literal — the tracked tree already bans those (US-003), and the shims
  // are the fail-closed backstop for a truly node-less host: with no node
  // resolvable the print output must NOT claim an executable TT_NODE_BIN.
  it("print emits no TT_NODE_BIN value when no node is resolvable (fail-closed)", () => {
    const { pathEnv, cleanup } = nodeFreePath();
    try {
      const out = execSync(
        `env -i HOME= PATH=${pathEnv} bash ${envScript} print`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 15000,
        },
      );
      const bin = envPrintValue(out, "TT_NODE_BIN");
      assert.ok(
        bin === "" || !fs.existsSync(bin),
        `no-node host must not yield an existing TT_NODE_BIN. Got: ${bin}`,
      );
    } finally {
      cleanup();
    }
  });
});
