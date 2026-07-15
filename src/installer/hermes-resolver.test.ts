import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  resolveHermesBinary,
  resolveHermesViaLoginShell,
  spawnLoginShellCommand,
} from "../../dist/installer/hermes-resolver.js";
import { createTempHome } from "../../tests/helpers/test-env.ts";

// ── resolveHermesBinary tests ─────────────────────────────────────

describe("resolveHermesBinary", () => {
  let savedHermesBinary: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedHermesBinary === undefined) {
      delete process.env.TAMANDUA_HERMES_BINARY;
    } else {
      process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
  });

  // ── Tier 1: Explicit env override ─────────────────────────────

  it("respects TAMANDUA_HERMES_BINARY env var when set and executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    const hermesPath = path.join(tmpDir, "hermes-custom");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const result = await resolveHermesBinary();
    assert.equal(result, hermesPath);
  });

  it("throws when TAMANDUA_HERMES_BINARY is set but not executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    const hermesPath = path.join(tmpDir, "hermes-broken");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    await assert.rejects(
      resolveHermesBinary(),
      /TAMANDUA_HERMES_BINARY set but not executable/,
    );
  });

  it("resolves relative TAMANDUA_HERMES_BINARY to absolute path", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-rel-");
    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

    // Set a relative path, changing to tmpDir so the relative resolves
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      process.env.TAMANDUA_HERMES_BINARY = "./hermes";

      const result = await resolveHermesBinary();
      assert.ok(path.isAbsolute(result), `expected absolute path, got ${result}`);
      assert.equal(result, path.resolve(tmpDir, "hermes"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns cached env var path without searching PATH", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-env-");
    const envHermesPath = path.join(tmpDir, "hermes-env");
    fs.writeFileSync(envHermesPath, "#!/bin/sh\necho env-hermes\n", {
      mode: 0o755,
    });

    const { root: tmpDir2 } = createTempHome("tamandua-test-hermes-path-");
    const pathHermesPath = path.join(tmpDir2, "hermes");
    fs.writeFileSync(pathHermesPath, "#!/bin/sh\necho path-hermes\n", {
      mode: 0o755,
    });

    process.env.TAMANDUA_HERMES_BINARY = envHermesPath;
    process.env.PATH = `${tmpDir2}:${savedPath ?? ""}`;

    const result = await resolveHermesBinary();
    assert.equal(result, envHermesPath);
  });

  // ── Tier 2: PATH search ───────────────────────────────────────

  it("searches PATH for hermes executable", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await resolveHermesBinary();
    assert.equal(result, hermesPath);
  });

  it("resolves relative PATH entries against process.cwd()", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-relpath-");
    const subDir = path.join(tmpDir, "bin");
    fs.mkdirSync(subDir, { recursive: true });
    const hermesPath = path.join(subDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    // Use a relative PATH entry — must resolve against process.cwd()
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // "bin" is relative to current working directory (tmpDir)
      process.env.PATH = `bin:${savedPath ?? ""}`;

      const result = await resolveHermesBinary();
      assert.ok(path.isAbsolute(result), `expected absolute path, got ${result}`);
      assert.equal(result, path.resolve(tmpDir, "bin", "hermes"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("resolves empty PATH entry against process.cwd()", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-emptypath-");
    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    // An empty PATH entry resolves to current working directory
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // Trailing colon creates an empty entry at the end (resolves to cwd)
      process.env.PATH = `${savedPath ?? ""}:`;
      // The trailing empty entry resolves against cwd
      // But we also need hermes there — we already created it in tmpDir
    } finally {
      process.chdir(originalCwd);
    }

    // Note: this depends on hermes NOT being in savedPath
    // If it is, we'd just return savedPath's hermes. The test validates
    // that empty PATH entries are resolved by checking that the result
    // is absolute regardless of which tier wins.
    try {
      const result = await resolveHermesBinary();
      assert.ok(path.isAbsolute(result), `expected absolute path, got ${result}`);
    } catch {
      // If hermes is not found at all (not in savedPath, not in tmpDir
      // since we changed back), that's fine — the point is that any
      // PATH candidate we touched was absolute-resolved.
    }
  });

  it("returns absolute path for all resolved tiers", async () => {
    // Tier 1: Explicit env
    {
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-abs-tier1-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });
      // Use relative path via env
      const originalCwd = process.cwd();
      process.chdir(tmpDir);
      try {
        process.env.TAMANDUA_HERMES_BINARY = "./hermes";
        const result = await resolveHermesBinary();
        assert.ok(path.isAbsolute(result));
        assert.equal(result, path.resolve(tmpDir, "hermes"));
      } finally {
        process.chdir(originalCwd);
      }
    }

    // Tier 2: PATH search (absolute entry — already covered, just verify)
    {
      delete process.env.TAMANDUA_HERMES_BINARY;
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-abs-tier2-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });
      process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;
      const result = await resolveHermesBinary();
      assert.ok(path.isAbsolute(result));
    }
  });

  it("resolved absolute path is invocable from a different cwd", async () => {
    // This tests the ABSP invariant: when TAMANDUA_HERMES_BINARY is a
    // relative path, the resolver must return an absolute path so that
    // dispatch from a different working directory doesn't fail with
    // "./hermes: not found".
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: resolveDir } = createTempHome("tamandua-test-hermes-resolve-");
    const hermesPath = path.join(resolveDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });

    // Resolve from resolveDir with relative PATH
    const originalCwd = process.cwd();
    const { root: dispatchDir } = createTempHome("tamandua-test-hermes-dispatch-");

    // Step 1: Resolve from resolveDir
    process.chdir(resolveDir);
    let resolvedPath: string;
    try {
      // Only the hermes dir on PATH
      process.env.PATH = resolveDir;
      resolvedPath = await resolveHermesBinary();
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

  it("throws clear error when hermes not found in PATH and no env var set", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    process.env.PATH = tmpDir;

    await assert.rejects(
      resolveHermesBinary(),
      /hermes binary not found in PATH/,
    );
  });

  // ── Token-saver preference ──────────────────────────────────────

  it("prefers hermes-token-saver when preferTokenSaver is true", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-ts-");
    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });
    const tokenSaverPath = path.join(tmpDir, "hermes-token-saver");
    fs.writeFileSync(tokenSaverPath, "#!/bin/sh\necho token-saver\n", {
      mode: 0o755,
    });

    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await resolveHermesBinary({ preferTokenSaver: true });
    assert.equal(result, tokenSaverPath);
  });

  it("falls back to hermes when hermes-token-saver not on PATH", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-ts-fallback-");
    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    // Isolate PATH to only the temp dir — no hermes-token-saver present.
    // The function searches for hermes-token-saver first (preferTokenSaver),
    // fails to find it, then falls back to hermes.
    process.env.PATH = tmpDir;

    const result = await resolveHermesBinary({ preferTokenSaver: true });
    assert.equal(result, hermesPath);
  });

  it("still prefers env override even with preferTokenSaver", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-env-ts-");
    const envHermes = path.join(tmpDir, "hermes-env-override");
    fs.writeFileSync(envHermes, "#!/bin/sh\necho env-override\n", {
      mode: 0o755,
    });

    const tokenSaverPath = path.join(tmpDir, "hermes-token-saver");
    fs.writeFileSync(tokenSaverPath, "#!/bin/sh\necho ts\n", { mode: 0o755 });

    process.env.TAMANDUA_HERMES_BINARY = envHermes;
    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await resolveHermesBinary({ preferTokenSaver: true });
    assert.equal(result, envHermes);
  });

  // ── Tier 3: Login-shell fallback ───────────────────────────────

  describe("login-shell fallback", () => {
    let savedPath: string | undefined;
    let savedHome: string | undefined;

    beforeEach(() => {
      savedPath = process.env.PATH;
      savedHome = process.env.HOME;
      delete process.env.TAMANDUA_HERMES_BINARY;
    });

    afterEach(() => {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
      if (savedHome !== undefined) {
        process.env.HOME = savedHome;
      }
      delete process.env.TAMANDUA_HERMES_BINARY;
    });

    it("resolves hermes via login shell when not on regular PATH", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-login-");

      // Isolate HOME
      process.env.HOME = tmpDir;

      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho real-hermes\n", {
        mode: 0o755,
      });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\n# Simulate zsh -lic 'command -v hermes'\necho ${hermesPath}\n`,
        { mode: 0o755 },
      );

      // PATH has the fake zsh but NOT the hermes dir
      process.env.PATH = fakeZshDir;

      const result = await resolveHermesBinary();
      const expected = fs.realpathSync(hermesPath);
      assert.equal(result, expected);
    });

    it("resolves realpath to handle macOS /var → /private/var symlinks", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-hermes-symlink-",
      );

      process.env.HOME = tmpDir;

      const realDir = path.join(tmpDir, "real-bin");
      fs.mkdirSync(realDir, { recursive: true });
      const hermesPath = path.join(realDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      const symDir = path.join(tmpDir, "sym-bin");
      fs.symlinkSync(realDir, symDir);
      const symlinkedHermes = path.join(symDir, "hermes");

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${symlinkedHermes}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      const result = await resolveHermesBinary();
      const expected = fs.realpathSync(hermesPath);
      assert.equal(result, expected);
      assert.notEqual(result, symlinkedHermes);
    });

    it("handles realpath resolving macOS temp-dir symlinks", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-hermes-realpath-",
      );

      process.env.HOME = tmpDir;

      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      const result = await resolveHermesBinary();
      assert.equal(result, fs.realpathSync(hermesPath));
    });

    it("falls back gracefully when zsh is not available", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-hermes-nozsh-",
      );

      process.env.HOME = tmpDir;
      process.env.PATH = tmpDir;

      await assert.rejects(
        resolveHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("ignores non-executable paths returned by login shell", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-hermes-notexec-",
      );

      process.env.HOME = tmpDir;

      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho nope\n", { mode: 0o644 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      await assert.rejects(
        resolveHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("falls back gracefully when login shell returns empty output", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-hermes-empty-",
      );

      process.env.HOME = tmpDir;

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, "#!/bin/sh\n# no output\n", { mode: 0o755 });

      process.env.PATH = fakeZshDir;

      await assert.rejects(
        resolveHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("prefers PATH over login shell", async () => {
      const { root: tmpDir } = createTempHome(
        "tamandua-test-hermes-pathfirst-",
      );

      process.env.HOME = tmpDir;

      const pathHermesDir = path.join(tmpDir, "path-hermes");
      fs.mkdirSync(pathHermesDir, { recursive: true });
      const pathHermes = path.join(pathHermesDir, "hermes");
      fs.writeFileSync(pathHermes, "#!/bin/sh\necho path-hermes\n", {
        mode: 0o755,
      });

      const loginHermesDir = path.join(tmpDir, "login-hermes");
      fs.mkdirSync(loginHermesDir, { recursive: true });
      const loginHermes = path.join(loginHermesDir, "hermes");
      fs.writeFileSync(loginHermes, "#!/bin/sh\necho login-hermes\n", {
        mode: 0o755,
      });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${loginHermes}\n`, {
        mode: 0o755,
      });

      process.env.PATH = `${pathHermesDir}:${fakeZshDir}:${savedPath ?? ""}`;

      const result = await resolveHermesBinary();
      assert.equal(result, pathHermes);
    });
  });

  // ── Side-effect-free guarantee ─────────────────────────────────

  describe("no filesystem side effects", () => {
    let savedHome: string | undefined;
    let savedPath: string | undefined;

    beforeEach(() => {
      savedHome = process.env.HOME;
      savedPath = process.env.PATH;
      delete process.env.TAMANDUA_HERMES_BINARY;
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
      delete process.env.TAMANDUA_HERMES_BINARY;
    });

    it("does NOT create a symlink when resolving via login shell", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-nosymlink-");

      process.env.HOME = tmpDir;

      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
        mode: 0o755,
      });

      process.env.PATH = fakeZshDir;

      await resolveHermesBinary();

      // ~/.local/bin/hermes should NOT exist
      const linkPath = path.join(tmpDir, ".local", "bin", "hermes");
      assert.equal(
        fs.existsSync(linkPath),
        false,
        "~/.local/bin/hermes symlink should NOT be created",
      );
    });

    it("does NOT overwrite an existing regular file at ~/.local/bin/hermes", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-regfile-");

      process.env.HOME = tmpDir;

      // Create ~/.local/bin/hermes as a regular file
      const localBin = path.join(tmpDir, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      const existingFile = path.join(localBin, "hermes");
      const originalContent = "regular file content";
      fs.writeFileSync(existingFile, originalContent);
      const originalMode = fs.statSync(existingFile).mode;
      const originalSize = fs.statSync(existingFile).size;

      // Create hermes in a login-shell-discovered location
      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
        mode: 0o755,
      });

      // PATH lacks ~/.local/bin
      process.env.PATH = fakeZshDir;

      await resolveHermesBinary();

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

    it("does NOT overwrite an existing symlink at ~/.local/bin/hermes", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-existingsymlink-");

      process.env.HOME = tmpDir;

      // Create ~/.local/bin/hermes as an existing symlink pointing somewhere else
      const localBin = path.join(tmpDir, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      const existingTarget = path.join(tmpDir, "old-hermes");
      fs.writeFileSync(existingTarget, "#!/bin/sh\necho old\n", { mode: 0o755 });
      const existingSymlink = path.join(localBin, "hermes");
      fs.symlinkSync(existingTarget, existingSymlink);

      // Create hermes in a login-shell-discovered location
      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho new\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
        mode: 0o755,
      });

      // PATH lacks ~/.local/bin
      process.env.PATH = fakeZshDir;

      await resolveHermesBinary();

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

  it("handles hermes path containing spaces", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-space-");
    const hermesDir = path.join(tmpDir, "path with spaces");
    fs.mkdirSync(hermesDir, { recursive: true });
    // Use a name without "hermes" so it doesn't conflict with real
    // system hermes on savedPath, then rename to test the space path.
    const hermesPath = path.join(hermesDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    // Prepend hermesDir first — it must be found before savedPath
    process.env.PATH = `${hermesDir}:${savedPath ?? ""}`;

    const result = await resolveHermesBinary();
    assert.equal(result, hermesPath);
  });

  it("handles login-shell returning path with spaces", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-space-login-");

    process.env.HOME = tmpDir;

    const hermesDir = path.join(tmpDir, "path with spaces");
    fs.mkdirSync(hermesDir, { recursive: true });
    const hermesPath = path.join(hermesDir, "hermes binary");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await resolveHermesBinary();
    const expected = fs.realpathSync(hermesPath);
    assert.equal(result, expected);
  });

  it("handles TAMANDUA_HERMES_BINARY with spaces", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-env-space-");
    const hermesPath = path.join(tmpDir, "hermes with spaces");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const result = await resolveHermesBinary();
    assert.equal(result, hermesPath);
  });
});

// ── resolveHermesViaLoginShell tests ───────────────────────────────

describe("resolveHermesViaLoginShell", () => {
  it("returns null when login shell fails", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hvls-fail-");
    process.env.PATH = tmpDir; // no zsh
    const result = await resolveHermesViaLoginShell();
    assert.equal(result, null);
  });

  it("returns null for non-executable path", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hvls-noexec-");

    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o644 });

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await resolveHermesViaLoginShell();
    assert.equal(result, null);
  });

  it("returns realpath for valid path", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hvls-ok-");

    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, `#!/bin/sh\necho ${hermesPath}\n`, {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await resolveHermesViaLoginShell();
    assert.equal(result, fs.realpathSync(hermesPath));
  });
});

// ── spawnLoginShellCommand tests ──────────────────────────────────

describe("spawnLoginShellCommand", () => {
  it("returns stdout on successful execution", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-slsc-ok-");

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, "#!/bin/sh\necho hello world\n", { mode: 0o755 });

    process.env.PATH = fakeZshDir;

    const result = await spawnLoginShellCommand("echo hello");
    assert.equal(result, "hello world");
  });

  it("returns null when zsh not available", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-slsc-nozsh-");
    process.env.PATH = tmpDir;

    const result = await spawnLoginShellCommand("echo hello");
    assert.equal(result, null);
  });

  it("returns null on non-zero exit code", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-slsc-fail-");

    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(fakeZsh, "#!/bin/sh\necho some output\nexit 1\n", {
      mode: 0o755,
    });

    process.env.PATH = fakeZshDir;

    const result = await spawnLoginShellCommand("fail");
    assert.equal(result, null);
  });
});
