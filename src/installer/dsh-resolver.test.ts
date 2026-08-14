import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  resolveDshBinary,
  resolveDshViaLoginShell,
  spawnDshLoginShellCommand,
} from "../../dist/installer/dsh-resolver.js";
import { createTempHome } from "../../tests/helpers/test-env.ts";

// ── resolveDshBinary tests ─────────────────────────────────────────

describe("resolveDshBinary", () => {
  let savedDshBinary: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedDshBinary = process.env.TAMANDUA_DSH_BINARY;
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedDshBinary === undefined) {
      delete process.env.TAMANDUA_DSH_BINARY;
    } else {
      process.env.TAMANDUA_DSH_BINARY = savedDshBinary;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
  });

  // ── Tier 1: Explicit env override ─────────────────────────────

  it("respects TAMANDUA_DSH_BINARY env var when set and executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh-");
    const dshPath = path.join(tmpDir, "dsh-custom");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

    process.env.TAMANDUA_DSH_BINARY = dshPath;

    const result = await resolveDshBinary();
    assert.equal(result, dshPath);
  });

  it("throws when TAMANDUA_DSH_BINARY is set but not executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh-");
    const dshPath = path.join(tmpDir, "dsh-broken");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

    process.env.TAMANDUA_DSH_BINARY = dshPath;

    await assert.rejects(
      resolveDshBinary(),
      /TAMANDUA_DSH_BINARY set but not executable/,
    );
  });

  it("resolves relative TAMANDUA_DSH_BINARY to absolute path", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh-rel-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

    // Set a relative path, changing to tmpDir so the relative resolves
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      process.env.TAMANDUA_DSH_BINARY = "./dsh";

      const result = await resolveDshBinary();
      assert.ok(path.isAbsolute(result), `expected absolute path, got ${result}`);
      assert.equal(result, path.resolve(tmpDir, "dsh"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns env var path without searching PATH", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh-env-");
    const envDshPath = path.join(tmpDir, "dsh-env");
    fs.writeFileSync(envDshPath, "#!/bin/sh\necho env-dsh\n", {
      mode: 0o755,
    });

    const { root: tmpDir2 } = createTempHome("tamandua-test-dsh-path-");
    const pathDshPath = path.join(tmpDir2, "dsh");
    fs.writeFileSync(pathDshPath, "#!/bin/sh\necho path-dsh\n", {
      mode: 0o755,
    });

    process.env.TAMANDUA_DSH_BINARY = envDshPath;
    process.env.PATH = `${tmpDir2}:${savedPath ?? ""}`;

    const result = await resolveDshBinary();
    assert.equal(result, envDshPath);
  });

  // ── Tier 2: PATH search ───────────────────────────────────────

  it("searches PATH for dsh executable", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await resolveDshBinary();
    assert.equal(result, dshPath);
  });

  it("resolves relative PATH entries against process.cwd()", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-relpath-");
    const subDir = path.join(tmpDir, "bin");
    fs.mkdirSync(subDir, { recursive: true });
    const dshPath = path.join(subDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    // Use a relative PATH entry — must resolve against process.cwd()
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // "bin" is relative to current working directory (tmpDir)
      process.env.PATH = `bin:${savedPath ?? ""}`;

      const result = await resolveDshBinary();
      assert.ok(path.isAbsolute(result), `expected absolute path, got ${result}`);
      assert.equal(result, path.resolve(tmpDir, "bin", "dsh"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("resolves empty PATH entry against process.cwd()", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-emptypath-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    const originalCwd = process.cwd();
    const savedPath = process.env.PATH;
    const savedDshBinary = process.env.TAMANDUA_DSH_BINARY;
    try {
      // cwd must be the temp dir so empty PATH entries resolve there
      process.chdir(tmpDir);
      // Exactly one empty entry — no colon, no host PATH, no savedPath
      process.env.PATH = "";
      delete process.env.TAMANDUA_DSH_BINARY;

      const result = await resolveDshBinary();
      // Must resolve against cwd (tmpDir), giving the absolute path
      assert.ok(path.isAbsolute(result), `expected absolute path, got ${result}`);
      assert.equal(result, dshPath);
    } finally {
      process.chdir(originalCwd);
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      } else {
        delete process.env.PATH;
      }
      if (savedDshBinary !== undefined) {
        process.env.TAMANDUA_DSH_BINARY = savedDshBinary;
      } else {
        delete process.env.TAMANDUA_DSH_BINARY;
      }
    }
  });

  it("returns absolute path for all resolved tiers", async () => {
    // Tier 1: Explicit env
    {
      const { root: tmpDir } = createTempHome("tamandua-test-dsh-abs-tier1-");
      const dshPath = path.join(tmpDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });
      // Use relative path via env
      const originalCwd = process.cwd();
      process.chdir(tmpDir);
      try {
        process.env.TAMANDUA_DSH_BINARY = "./dsh";
        const result = await resolveDshBinary();
        assert.ok(path.isAbsolute(result));
        assert.equal(result, path.resolve(tmpDir, "dsh"));
      } finally {
        process.chdir(originalCwd);
      }
    }

    // Tier 2: PATH search (absolute entry — already covered, just verify)
    {
      delete process.env.TAMANDUA_DSH_BINARY;
      const { root: tmpDir } = createTempHome("tamandua-test-dsh-abs-tier2-");
      const dshPath = path.join(tmpDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });
      process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;
      const result = await resolveDshBinary();
      assert.ok(path.isAbsolute(result));
    }
  });

  it("resolved absolute path is invocable from a different cwd", async () => {
    // This tests the ABSP invariant: when TAMANDUA_DSH_BINARY is a
    // relative path, the resolver must return an absolute path so that
    // dispatch from a different working directory doesn't fail with
    // "./dsh: not found".
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: resolveDir } = createTempHome("tamandua-test-dsh-resolve-");
    const dshPath = path.join(resolveDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });

    // Resolve from resolveDir with relative PATH
    const originalCwd = process.cwd();
    const { root: dispatchDir } = createTempHome("tamandua-test-dsh-dispatch-");

    // Step 1: Resolve from resolveDir
    process.chdir(resolveDir);
    let resolvedPath: string;
    try {
      // Only the dsh dir on PATH
      process.env.PATH = resolveDir;
      resolvedPath = await resolveDshBinary();
      assert.ok(path.isAbsolute(resolvedPath));
    } finally {
      process.chdir(originalCwd);
    }

    // Step 2: Invoke from a completely different cwd (simulates dispatch)
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(resolvedPath, [], {
      cwd: dispatchDir,
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, `exit code ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "ok");
  });

  it("throws clear error when dsh not found in PATH and no env var set", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-");
    process.env.PATH = tmpDir;

    await assert.rejects(
      resolveDshBinary(),
      /dsh binary not found in PATH/,
    );
  });

  // ── Token-saver preference ──────────────────────────────────────

  it("prefers dsh-token-saver when preferTokenSaver is true", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-ts-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });
    const tokenSaverPath = path.join(tmpDir, "dsh-token-saver");
    fs.writeFileSync(tokenSaverPath, "#!/bin/sh\necho token-saver\n", {
      mode: 0o755,
    });

    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await resolveDshBinary({ preferTokenSaver: true });
    assert.equal(result, tokenSaverPath);
  });

  it("falls back to dsh when dsh-token-saver not on PATH", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-ts-fallback-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    // Isolate PATH to only the temp dir — no dsh-token-saver present.
    // The function searches for dsh-token-saver first (preferTokenSaver),
    // fails to find it, then falls back to dsh.
    process.env.PATH = tmpDir;

    const result = await resolveDshBinary({ preferTokenSaver: true });
    assert.equal(result, dshPath);
  });

  it("still prefers env override even with preferTokenSaver", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh-env-ts-");
    const envDsh = path.join(tmpDir, "dsh-env-override");
    fs.writeFileSync(envDsh, "#!/bin/sh\necho env-override\n", {
      mode: 0o755,
    });

    const tokenSaverPath = path.join(tmpDir, "dsh-token-saver");
    fs.writeFileSync(tokenSaverPath, "#!/bin/sh\necho ts\n", { mode: 0o755 });

    process.env.TAMANDUA_DSH_BINARY = envDsh;
    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await resolveDshBinary({ preferTokenSaver: true });
    assert.equal(result, envDsh);
  });

  // ── Tier 3: Login-shell fallback ───────────────────────────────

  describe("login-shell fallback", () => {
    let savedPath: string | undefined;
    let savedHome: string | undefined;

    beforeEach(() => {
      savedPath = process.env.PATH;
      savedHome = process.env.HOME;
      delete process.env.TAMANDUA_DSH_BINARY;
    });

    afterEach(() => {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
      if (savedHome !== undefined) {
        process.env.HOME = savedHome;
      }
      delete process.env.TAMANDUA_DSH_BINARY;
    });

    it("resolves dsh via login shell when not on regular PATH", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-dsh-login-");

      // Isolate HOME
      process.env.HOME = tmpDir;

      const dshDir = path.join(tmpDir, "dsh-bin");
      fs.mkdirSync(dshDir, { recursive: true });
      const dshPath = path.join(dshDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho real-dsh\n", {
        mode: 0o755,
      });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\n# Simulate zsh -lic 'command -v dsh'\necho ${dshPath}\n`,
        { mode: 0o755 },
      );

      // PATH has the fake zsh but NOT the dsh dir
      process.env.PATH = fakeZshDir;

      const result = await resolveDshBinary();
      const expected = fs.realpathSync(dshPath);
      assert.equal(result, expected);
    });

    it("resolves realpath to handle macOS /var → /private/var symlinks", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-dsh-symlink-",
      );

      process.env.HOME = tmpDir;

      const realDir = path.join(tmpDir, "real-bin");
      fs.mkdirSync(realDir, { recursive: true });
      const dshPath = path.join(realDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

      const symDir = path.join(tmpDir, "sym-bin");
      fs.symlinkSync(realDir, symDir);
      const symlinkedDsh = path.join(symDir, "dsh");

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${symlinkedDsh}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      const result = await resolveDshBinary();
      const expected = fs.realpathSync(dshPath);
      assert.equal(result, expected);
      assert.notEqual(result, symlinkedDsh);
    });

    it("handles realpath resolving macOS temp-dir symlinks", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-dsh-realpath-",
      );

      process.env.HOME = tmpDir;

      const dshDir = path.join(tmpDir, "dsh-bin");
      fs.mkdirSync(dshDir, { recursive: true });
      const dshPath = path.join(dshDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      const result = await resolveDshBinary();
      assert.equal(result, fs.realpathSync(dshPath));
    });

    it("falls back gracefully when zsh is not available", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-dsh-nozsh-",
      );

      process.env.HOME = tmpDir;
      process.env.PATH = tmpDir;

      await assert.rejects(
        resolveDshBinary(),
        /dsh binary not found in PATH/,
      );
    });

    it("ignores non-executable paths returned by login shell", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-dsh-notexec-",
      );

      process.env.HOME = tmpDir;

      const dshDir = path.join(tmpDir, "dsh-bin");
      fs.mkdirSync(dshDir, { recursive: true });
      const dshPath = path.join(dshDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho nope\n", { mode: 0o644 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      await assert.rejects(
        resolveDshBinary(),
        /dsh binary not found in PATH/,
      );
    });

    it("falls back gracefully when login shell returns empty output", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-dsh-empty-",
      );

      process.env.HOME = tmpDir;

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, "#!/bin/sh\n# no output\n", { mode: 0o755 });

      process.env.PATH = fakeZshDir;

      await assert.rejects(
        resolveDshBinary(),
        /dsh binary not found in PATH/,
      );
    });

    it("prefers PATH over login shell", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-dsh-pathfirst-",
      );

      process.env.HOME = tmpDir;

      const pathDshDir = path.join(tmpDir, "path-dsh");
      fs.mkdirSync(pathDshDir, { recursive: true });
      const pathDsh = path.join(pathDshDir, "dsh");
      fs.writeFileSync(pathDsh, "#!/bin/sh\necho path-dsh\n", {
        mode: 0o755,
      });

      const loginDshDir = path.join(tmpDir, "login-dsh");
      fs.mkdirSync(loginDshDir, { recursive: true });
      const loginDsh = path.join(loginDshDir, "dsh");
      fs.writeFileSync(loginDsh, "#!/bin/sh\necho login-dsh\n", {
        mode: 0o755,
      });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${loginDsh}\n`, {
        mode: 0o755,
      });

      process.env.PATH = `${pathDshDir}:${fakeZshDir}:${savedPath ?? ""}`;

      const result = await resolveDshBinary();
      assert.equal(result, pathDsh);
    });
  });

  // ── Side-effect-free guarantee ─────────────────────────────────

  describe("no filesystem side effects", () => {
    let savedHome: string | undefined;
    let savedPath: string | undefined;

    beforeEach(() => {
      savedHome = process.env.HOME;
      savedPath = process.env.PATH;
      delete process.env.TAMANDUA_DSH_BINARY;
    });

    afterEach(() => {
      if (savedHome !== undefined) {
        process.env.HOME = savedHome;
      } else {
        delete process.env.HOME;
      }
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
      delete process.env.TAMANDUA_DSH_BINARY;
    });

    it("temp dir contents are unchanged after resolution", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-dsh-snapshot-");

      process.env.HOME = tmpDir;

      const dshDir = path.join(tmpDir, "dsh-bin");
      fs.mkdirSync(dshDir, { recursive: true });
      const dshPath = path.join(dshDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      // Snapshot recursive listing before resolution
      const snapshot = listTree(tmpDir);
      await resolveDshBinary();

      assert.deepEqual(listTree(tmpDir), snapshot);
    });

    it("does NOT create a symlink when resolving via login shell", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-dsh-nosymlink-");

      process.env.HOME = tmpDir;

      const dshDir = path.join(tmpDir, "dsh-bin");
      fs.mkdirSync(dshDir, { recursive: true });
      const dshPath = path.join(dshDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      await resolveDshBinary();

      // ~/.local/bin/dsh should NOT exist
      const linkPath = path.join(tmpDir, ".local", "bin", "dsh");
      assert.equal(
        fs.existsSync(linkPath),
        false,
        "~/.local/bin/dsh symlink should NOT be created",
      );
    });

    it("does NOT overwrite an existing regular file at ~/.local/bin/dsh", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-dsh-regfile-");

      process.env.HOME = tmpDir;

      // Create ~/.local/bin/dsh as a regular file
      const localBin = path.join(tmpDir, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      const existingFile = path.join(localBin, "dsh");
      const originalContent = "regular file content";
      fs.writeFileSync(existingFile, originalContent);
      const originalMode = fs.statSync(existingFile).mode;
      const originalSize = fs.statSync(existingFile).size;

      // Create dsh in a login-shell-discovered location
      const dshDir = path.join(tmpDir, "dsh-bin");
      fs.mkdirSync(dshDir, { recursive: true });
      const dshPath = path.join(dshDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
        mode: 0o755,
      });

      // PATH lacks ~/.local/bin
      process.env.PATH = fakeZshDir;

      await resolveDshBinary();

      // The existing regular file should be untouched
      assert.ok(fs.existsSync(existingFile));
      assert.ok(
        !fs.lstatSync(existingFile).isSymbolicLink(),
        "should still be a regular file, not a symlink",
      );
      assert.equal(
        fs.readFileSync(existingFile, "utf-8"),
        originalContent,
        "file content should be unchanged",
      );
      assert.equal(
        fs.statSync(existingFile).size,
        originalSize,
        "file size should be unchanged",
      );
      assert.equal(
        fs.statSync(existingFile).mode,
        originalMode,
        "file mode should be unchanged",
      );
    });

    it("does NOT overwrite an existing symlink at ~/.local/bin/dsh", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-dsh-existingsymlink-");

      process.env.HOME = tmpDir;

      // Create ~/.local/bin/dsh as an existing symlink pointing somewhere else
      const localBin = path.join(tmpDir, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      const existingTarget = path.join(tmpDir, "old-dsh");
      fs.writeFileSync(existingTarget, "#!/bin/sh\necho old\n", { mode: 0o755 });
      const existingSymlink = path.join(localBin, "dsh");
      fs.symlinkSync(existingTarget, existingSymlink);

      // Create dsh in a login-shell-discovered location
      const dshDir = path.join(tmpDir, "dsh-bin");
      fs.mkdirSync(dshDir, { recursive: true });
      const dshPath = path.join(dshDir, "dsh");
      fs.writeFileSync(dshPath, "#!/bin/sh\necho new\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
        mode: 0o755,
      });

      // PATH lacks ~/.local/bin
      process.env.PATH = fakeZshDir;

      await resolveDshBinary();

      // The existing symlink should still point to the original target
      assert.ok(fs.lstatSync(existingSymlink).isSymbolicLink());
      assert.equal(
        fs.readlinkSync(existingSymlink),
        existingTarget,
        "symlink target should be unchanged",
      );
    });
  });

  // ── Paths with spaces ─────────────────────────────────────────

  it("handles dsh path containing spaces", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-space-");
    const dshDir = path.join(tmpDir, "path with spaces");
    fs.mkdirSync(dshDir, { recursive: true });
    // Use a name without "dsh" so it doesn't conflict with real
    // system dsh on savedPath, then rename to test the space path.
    const dshPath = path.join(dshDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    // Prepend dshDir first — it must be found before savedPath
    process.env.PATH = `${dshDir}:${savedPath ?? ""}`;

    const result = await resolveDshBinary();
    assert.equal(result, dshPath);
  });

  it("handles login-shell returning path with spaces", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh-space-login-");

    process.env.HOME = tmpDir;

    const dshDir = path.join(tmpDir, "path with spaces");
    fs.mkdirSync(dshDir, { recursive: true });
    const dshPath = path.join(dshDir, "dsh binary");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await resolveDshBinary();
    const expected = fs.realpathSync(dshPath);
    assert.equal(result, expected);
  });

  it("handles TAMANDUA_DSH_BINARY with spaces", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh-env-space-");
    const dshPath = path.join(tmpDir, "dsh with spaces");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    process.env.TAMANDUA_DSH_BINARY = dshPath;

    const result = await resolveDshBinary();
    assert.equal(result, dshPath);
  });
});

// ── resolveDshBinaryDetailed tests ────────────────────────────────

describe("resolveDshBinaryDetailed", () => {
  let savedDshBinary: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedDshBinary = process.env.TAMANDUA_DSH_BINARY;
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedDshBinary === undefined) {
      delete process.env.TAMANDUA_DSH_BINARY;
    } else {
      process.env.TAMANDUA_DSH_BINARY = savedDshBinary;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    } else {
      delete process.env.PATH;
    }
  });

  it("returns source='env' for TAMANDUA_DSH_BINARY override", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-detailed-env-");
    const dshPath = path.join(tmpDir, "dsh-custom");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

    process.env.TAMANDUA_DSH_BINARY = dshPath;

    const { resolveDshBinaryDetailed } = await import(
      "../../dist/installer/dsh-resolver.js"
    );
    const result = await resolveDshBinaryDetailed();
    assert.equal(result.path, dshPath);
    assert.equal(result.source, "env");
  });

  it("returns source='path' for PATH discovery", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-detailed-path-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const { resolveDshBinaryDetailed } = await import(
      "../../dist/installer/dsh-resolver.js"
    );
    const result = await resolveDshBinaryDetailed();
    assert.equal(result.path, dshPath);
    assert.equal(result.source, "path");
  });

  it("returns source='token-saver' when preferTokenSaver finds dsh-token-saver", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-detailed-ts-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });
    const tokenSaverPath = path.join(tmpDir, "dsh-token-saver");
    fs.writeFileSync(tokenSaverPath, "#!/bin/sh\necho token-saver\n", {
      mode: 0o755,
    });

    process.env.PATH = tmpDir;

    const { resolveDshBinaryDetailed } = await import(
      "../../dist/installer/dsh-resolver.js"
    );
    const result = await resolveDshBinaryDetailed({ preferTokenSaver: true });
    assert.equal(result.path, tokenSaverPath);
    assert.equal(result.source, "token-saver");
  });

  it("returns source='login-shell' for login-shell fallback", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-detailed-login-");

    const dshDir = path.join(tmpDir, "dsh-bin");
    fs.mkdirSync(dshDir, { recursive: true });
    const dshPath = path.join(dshDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho real-dsh\n", {
      mode: 0o755,
    });

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(
      fakeZsh,
      `#!/bin/sh\n# Simulate zsh -lic 'command -v dsh'\necho ${dshPath}\n`,
      { mode: 0o755 },
    );

    const savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.PATH = fakeZshDir;

    try {
      const { resolveDshBinaryDetailed } = await import(
        "../../dist/installer/dsh-resolver.js"
      );
      const result = await resolveDshBinaryDetailed();
      assert.equal(result.path, fs.realpathSync(dshPath));
      assert.equal(result.source, "login-shell");
    } finally {
      if (savedHome !== undefined) {
        process.env.HOME = savedHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("throws DshResolverError with code='invalid_env_binary' for non-executable env", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-detailed-invalid-");
    const dshPath = path.join(tmpDir, "dsh-broken");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

    process.env.TAMANDUA_DSH_BINARY = dshPath;

    const { resolveDshBinaryDetailed, DshResolverError } = await import(
      "../../dist/installer/dsh-resolver.js"
    );
    await assert.rejects(
      () => resolveDshBinaryDetailed(),
      (err: unknown) => {
        assert.ok(err instanceof DshResolverError);
        assert.equal((err as DshResolverError).code, "invalid_env_binary");
        assert.equal((err as DshResolverError).rawConfiguredValue, dshPath);
        return true;
      },
    );
  });

  it("throws DshResolverError with code='not_found' when dsh absent", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-detailed-notfound-");
    process.env.PATH = tmpDir;

    const { resolveDshBinaryDetailed, DshResolverError } = await import(
      "../../dist/installer/dsh-resolver.js"
    );
    await assert.rejects(
      () => resolveDshBinaryDetailed(),
      (err: unknown) => {
        assert.ok(err instanceof DshResolverError);
        assert.equal((err as DshResolverError).code, "not_found");
        return true;
      },
    );
  });

  it("old resolveDshBinary callers remain compatible", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-compat-");
    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    process.env.PATH = tmpDir;

    // Old API still returns a plain string
    const { resolveDshBinary } = await import(
      "../../dist/installer/dsh-resolver.js"
    );
    const result = await resolveDshBinary();
    assert.equal(typeof result, "string");
    assert.equal(result, dshPath);
  });

  it("detailed resolver returns source='path' and absolute path for relative PATH entry with isolated cwd", async () => {
    delete process.env.TAMANDUA_DSH_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-dsh3-detailed-relpath-");
    const subDir = path.join(tmpDir, "bin");
    fs.mkdirSync(subDir, { recursive: true });
    const dshPath = path.join(subDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      // Relative PATH entry — must resolve against cwd and return absolute path
      process.env.PATH = "bin";

      const { resolveDshBinaryDetailed } = await import(
        "../../dist/installer/dsh-resolver.js"
      );
      const result = await resolveDshBinaryDetailed();
      assert.equal(result.source, "path");
      assert.ok(path.isAbsolute(result.path), `expected absolute path, got ${result.path}`);
      assert.equal(result.path, dshPath);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// ── resolveDshViaLoginShell tests ─────────────────────────────────

describe("resolveDshViaLoginShell", () => {
  it("returns null when login shell fails", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dvls-fail-");
    process.env.PATH = tmpDir; // no zsh
    const result = await resolveDshViaLoginShell();
    assert.equal(result, null);
  });

  it("returns null for non-executable path", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dvls-noexec-");

    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o644 });

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await resolveDshViaLoginShell();
    assert.equal(result, null);
  });

  it("returns realpath for valid path", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dvls-ok-");

    const dshPath = path.join(tmpDir, "dsh");
    fs.writeFileSync(dshPath, "#!/bin/sh\necho dsh\n", { mode: 0o755 });

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${dshPath}\n`, {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await resolveDshViaLoginShell();
    assert.equal(result, fs.realpathSync(dshPath));
  });
});

// ── spawnDshLoginShellCommand tests ───────────────────────────────

describe("spawnDshLoginShellCommand", () => {
  it("returns stdout on successful execution", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dslsc-ok-");

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, "#!/bin/sh\necho hello world\n", { mode: 0o755 });

    process.env.PATH = fakeZshDir;

    const result = await spawnDshLoginShellCommand("echo hello");
    assert.equal(result, "hello world");
  });

  it("returns null when zsh not available", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dslsc-nozsh-");
    process.env.PATH = tmpDir;

    const result = await spawnDshLoginShellCommand("echo hello");
    assert.equal(result, null);
  });

  it("returns null on non-zero exit code", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-dslsc-fail-");

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, "#!/bin/sh\necho some output\nexit 1\n", {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await spawnDshLoginShellCommand("fail");
    assert.equal(result, null);
  });
});

// ── Helpers ────────────────────────────────────────────────────────

/** Recursive listing of a directory tree: relative path + type + mode. */
function listTree(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out.push(`d:${rel}`);
        walk(full);
      } else if (entry.isSymbolicLink()) {
        out.push(`l:${rel}->${fs.readlinkSync(full)}`);
      } else {
        out.push(`f:${rel}:${fs.statSync(full).mode}`);
      }
    }
  }
  walk(root);
  return out.sort();
}
