import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it, before } from "node:test";

const repoRoot = process.cwd();
const binDir = path.join(
  repoRoot,
  "torture-test",
  "scripted-runtimes",
  "bin",
);

describe("scripted wrapper scripts (US-002)", () => {
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

  // AC 2: Both scripts use absolute node path
  it("scripted-pi uses absolute node path (no relative node or PATH-dependent node)", () => {
    const content = fs.readFileSync(
      path.join(binDir, "scripted-pi"),
      "utf-8",
    );
    // The exec line must use $NODE_BIN (a variable holding an absolute path),
    // not bare "node" as a PATH-dependent command.
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

  // AC 3: env -i PATH=/usr/bin:/bin ./bin/scripted-pi exits with error
  // message (no "command not found")
  it("env -i PATH=/usr/bin:/bin scripted-pi exits with error message, not 'command not found'", () => {
    try {
      execSync(
        `env -i PATH=/usr/bin:/bin ${path.join(binDir, "scripted-pi")}`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
        },
      );
    } catch (e) {
      // Non-zero exit is expected (runtime can't parse the prompt)
      const stderr: string = (e as any).stderr ?? "";
      assert.ok(
        !stderr.toLowerCase().includes("command not found"),
        "Must not produce 'command not found' (absolute node path is working)",
      );
      assert.ok(
        stderr.includes("could not parse") || stderr.includes("scripted"),
        `Must produce a scripted-runtime error (node was found and executed). Got: ${stderr.slice(0, 200)}`,
      );
      return;
    }
    // If execSync doesn't throw, the output should still not be "command not found"
    assert.fail("expected non-zero exit from runtime");
  });

  it("env -i PATH=/usr/bin:/bin scripted-hermes exits with error message, not 'command not found'", () => {
    try {
      execSync(
        `env -i PATH=/usr/bin:/bin ${path.join(binDir, "scripted-hermes")}`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
        },
      );
    } catch (e) {
      const stderr: string = (e as any).stderr ?? "";
      assert.ok(
        !stderr.toLowerCase().includes("command not found"),
        "Must not produce 'command not found' (absolute node path is working)",
      );
      assert.ok(
        stderr.includes("could not parse") || stderr.includes("scripted"),
        `Must produce a scripted-runtime error (node was found and executed). Got: ${stderr.slice(0, 200)}`,
      );
      return;
    }
    assert.fail("expected non-zero exit from runtime");
  });

  // AC 5: Scripts pass the correct arguments through to the runtime
  it("scripted-pi passes arguments through to the runtime", () => {
    // The runtime uses process.argv[last] as the prompt. Passing a known
    // unique string as the prompt verifies argument forwarding.
    // Runtime exits non-zero when prompt can't be parsed, but the prompt
    // text itself appears in the error output — proving args were forwarded.
    const uniquePrompt = "US002_ARG_TEST_pi_8472";
    try {
      execSync(
        `env -i PATH=/usr/bin:/bin ${path.join(binDir, "scripted-pi")} --print --mode json '${uniquePrompt}'`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
        },
      );
    } catch (e) {
      const stderr: string = (e as any).stderr ?? "";
      assert.ok(
        stderr.includes(uniquePrompt),
        `scripted-pi must forward the prompt argument. Got stderr: ${stderr.slice(0, 200)}`,
      );
      return;
    }
    assert.fail("expected non-zero exit from runtime");
  });

  it("scripted-hermes passes arguments through to the runtime", () => {
    const uniquePrompt = "US002_ARG_TEST_hermes_2938";
    try {
      execSync(
        `env -i PATH=/usr/bin:/bin ${path.join(binDir, "scripted-hermes")} --print '${uniquePrompt}'`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
        },
      );
    } catch (e) {
      const stderr: string = (e as any).stderr ?? "";
      assert.ok(
        stderr.includes(uniquePrompt),
        `scripted-hermes must forward the prompt argument. Got stderr: ${stderr.slice(0, 200)}`,
      );
      return;
    }
    assert.fail("expected non-zero exit from runtime");
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

  // TT_NODE_BIN override
  it("scripted-pi respects TT_NODE_BIN override", () => {
    // When TT_NODE_BIN points to a nonexistent binary, the wrapper should
    // catch it and fail with its own error (not bash's "command not found")
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
