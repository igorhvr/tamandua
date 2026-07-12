import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findHermesBinary,
  findPiBinary,
  ensureHermesSymlink,
} from "../../dist/installer/agent-scheduler.js";
import { createTempHome } from "../../tests/helpers/test-env.ts";

describe("findHermesBinary", () => {
  let savedHermesBinary: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    // Save env vars we'll manipulate
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    // Restore env vars
    if (savedHermesBinary === undefined) {
      delete process.env.TAMANDUA_HERMES_BINARY;
    } else {
      process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
  });

  it("respects TAMANDUA_HERMES_BINARY env var when set and executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    const hermesPath = path.join(tmpDir, "hermes-custom");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const result = await findHermesBinary();
    assert.equal(result, hermesPath);
  });

  it("throws when TAMANDUA_HERMES_BINARY is set but not executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    const hermesPath = path.join(tmpDir, "hermes-broken");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    await assert.rejects(
      findHermesBinary(),
      /TAMANDUA_HERMES_BINARY set but not executable/
    );
  });

  it("searches PATH for hermes executable", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await findHermesBinary();
    assert.equal(result, hermesPath);
  });

  it("throws clear error when hermes not found in PATH and no env var set", async () => {
    delete process.env.TAMANDUA_HERMES_BINARY;

    // Set PATH to an empty temp dir so there's no hermes anywhere
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-");
    process.env.PATH = tmpDir;

    await assert.rejects(
      findHermesBinary(),
      /hermes binary not found in PATH/
    );
  });

  it("returns cached env var path without searching PATH", async () => {
    // Set TAMANDUA_HERMES_BINARY to a valid executable AND have PATH
    // contain a different hermes. The env var should win.
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

    const result = await findHermesBinary();
    assert.equal(result, envHermesPath);
  });

  // ── Login-shell fallback tests ────────────────────────────────

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
      // Place a hermes binary in a temp dir NOT on PATH, then
      // point PATH at a script that simulates zsh -lic output.
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-login-");

      // Isolate HOME to prevent ensureHermesSymlink from touching real ~/.local/bin
      process.env.HOME = tmpDir;

      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho real-hermes\n", {
        mode: 0o755,
      });

      // Create a fake zsh that outputs the hermes path when called
      // with -lic 'command -v hermes'
      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\n# Simulate zsh -lic 'command -v hermes'\necho ${hermesPath}\n`,
        { mode: 0o755 },
      );

      // PATH has the fake zsh but NOT the hermes dir
      process.env.PATH = `${fakeZshDir}:${savedPath ?? ""}`;

      const result = await findHermesBinary();
      // Resolves through login-shell fallback and realpath
      const expected = fs.realpathSync(hermesPath);
      assert.equal(result, expected);
      
      // Also verify the symlink was created at test HOME's ~/.local/bin
      const linkPath = path.join(tmpDir, ".local", "bin", "hermes");
      assert.ok(fs.existsSync(linkPath), "symlink should be created");
      assert.equal(fs.readlinkSync(linkPath), expected);
    });

    it("resolves realpath to handle macOS /var → /private/var symlinks", async () => {
      // Create hermes inside a symlinked directory structure
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-symlink-");

      // Isolate HOME to prevent ensureHermesSymlink from touching real ~/.local/bin
      process.env.HOME = tmpDir;

      const realDir = path.join(tmpDir, "real-bin");
      fs.mkdirSync(realDir, { recursive: true });
      const hermesPath = path.join(realDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      // Create symlink dir that points to realDir
      const symDir = path.join(tmpDir, "sym-bin");
      fs.symlinkSync(realDir, symDir);
      const symlinkedHermes = path.join(symDir, "hermes");

      // Fake zsh outputs the symlinked path
      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\necho ${symlinkedHermes}\n`,
        { mode: 0o755 },
      );

      process.env.PATH = `${fakeZshDir}:${savedPath ?? ""}`;

      const result = await findHermesBinary();
      // Should resolve to the real path, not the symlinked one
      const expected = fs.realpathSync(hermesPath);
      assert.equal(result, expected);
      // Assert it resolved past the symlink
      assert.notEqual(result, symlinkedHermes);
    });

    it("handles realpath resolving macOS temp-dir symlinks", async () => {
      // On macOS /tmp → /private/tmp, so realpathSync always resolves
      // even purely temporary paths. Verify the returned path is the
      // realpath form.
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-realpath-");

      // Isolate HOME to prevent ensureHermesSymlink from touching real ~/.local/bin
      process.env.HOME = tmpDir;

      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      // Output raw path
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\necho ${hermesPath}\n`,
        { mode: 0o755 },
      );

      process.env.PATH = `${fakeZshDir}:${savedPath ?? ""}`;

      const result = await findHermesBinary();
      // The result should be the realpath (which may differ from raw
      // on macOS where /tmp → /private/tmp)
      assert.equal(result, fs.realpathSync(hermesPath));
    });

    it("falls back gracefully when zsh is not available", async () => {
      // Point PATH at an empty dir with no zsh. Since hermes
      // is also not on PATH, this should produce the standard
      // "not found" error (login-shell fallback returns null,
      // then the error is thrown).
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-nozsh-");

      // Isolate HOME to prevent ensureHermesSymlink from touching real ~/.local/bin
      process.env.HOME = tmpDir;

      // Empty PATH — no zsh, no hermes
      process.env.PATH = tmpDir;

      await assert.rejects(
        findHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("ignores non-executable paths returned by login shell", async () => {
      // Fake zsh returns a path, but the file is not executable
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-notexec-");

      // Isolate HOME to prevent ensureHermesSymlink from touching real ~/.local/bin
      process.env.HOME = tmpDir;

      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho nope\n", { mode: 0o644 });

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\necho ${hermesPath}\n`,
        { mode: 0o755 },
      );

      process.env.PATH = `${fakeZshDir}:${savedPath ?? ""}`;

      // Login shell found a path but it's not executable → treated as not found
      await assert.rejects(
        findHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("falls back gracefully when login shell returns empty output", async () => {
      // Fake zsh produces no output (hermes not in login shell PATH)
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-empty-");

      // Isolate HOME to prevent ensureHermesSymlink from touching real ~/.local/bin
      process.env.HOME = tmpDir;

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, "#!/bin/sh\n# no output\n", { mode: 0o755 });

      process.env.PATH = `${fakeZshDir}:${savedPath ?? ""}`;

      await assert.rejects(
        findHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("prefers PATH over login shell", async () => {
      // PATH has a hermes AND login shell would find a different hermes.
      // PATH should win.
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-pathfirst-");

      // Isolate HOME to prevent ensureHermesSymlink from touching real ~/.local/bin
      process.env.HOME = tmpDir;

      const pathHermesDir = path.join(tmpDir, "path-hermes");
      fs.mkdirSync(pathHermesDir, { recursive: true });
      const pathHermes = path.join(pathHermesDir, "hermes");
      fs.writeFileSync(pathHermes, "#!/bin/sh\necho path-hermes\n", { mode: 0o755 });

      const loginHermesDir = path.join(tmpDir, "login-hermes");
      fs.mkdirSync(loginHermesDir, { recursive: true });
      const loginHermes = path.join(loginHermesDir, "hermes");
      fs.writeFileSync(loginHermes, "#!/bin/sh\necho login-hermes\n", { mode: 0o755 });

      // Fake zsh that outputs the login hermes
      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\necho ${loginHermes}\n`,
        { mode: 0o755 },
      );

      // PATH includes BOTH, so the path check finds it first
      process.env.PATH = `${pathHermesDir}:${fakeZshDir}:${savedPath ?? ""}`;

      const result = await findHermesBinary();
      assert.equal(result, pathHermes);
    });
  });
});

describe("findPiBinary", () => {
  let savedPiBinary: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPiBinary = process.env.TAMANDUA_PI_BINARY;
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) {
      delete process.env.TAMANDUA_PI_BINARY;
    } else {
      process.env.TAMANDUA_PI_BINARY = savedPiBinary;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
  });

  it("respects TAMANDUA_PI_BINARY env var when set and executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-pi-");
    const piPath = path.join(tmpDir, "pi");
    fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });

    process.env.TAMANDUA_PI_BINARY = piPath;

    const result = await findPiBinary();
    assert.equal(result, piPath);
  });

  it("throws when TAMANDUA_PI_BINARY is set but not executable", async () => {
    const { root: tmpDir } = createTempHome("tamandua-test-pi-");
    const piPath = path.join(tmpDir, "pi-broken");
    fs.writeFileSync(piPath, "#!/bin/sh\necho nope\n", { mode: 0o644 });

    process.env.TAMANDUA_PI_BINARY = piPath;

    await assert.rejects(
      () => findPiBinary(),
      /TAMANDUA_PI_BINARY set but not executable/
    );
  });

  it("throws clear error when pi not found in PATH and no env var set", async () => {
    delete process.env.TAMANDUA_PI_BINARY;

    const { root: tmpDir } = createTempHome("tamandua-test-pi-");
    process.env.PATH = tmpDir;

    await assert.rejects(
      () => findPiBinary(),
      /pi binary not found in PATH/
    );
  });
});

describe("ensureHermesSymlink", () => {
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
  });

  it("creates a symlink at ~/.local/bin/hermes when none exists", () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-sl-");
    const localBin = path.join(tmpDir, ".local", "bin");

    // Point HOME at tmpDir so ~/.local/bin/hermes resolves there
    process.env.HOME = tmpDir;

    // Create a hermes binary to symlink to
    const hermesPath = path.join(tmpDir, "hermes-bin", "hermes");
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    const linkPath = path.join(localBin, "hermes");
    // Should not exist yet
    assert.equal(fs.existsSync(linkPath), false);

    const result = ensureHermesSymlink(hermesPath);

    assert.equal(result, linkPath);
    assert.ok(fs.existsSync(linkPath), "symlink should be created");
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), "should be a symlink");
    assert.equal(fs.readlinkSync(linkPath), hermesPath, "should point to hermes binary");
  });

  it("is a no-op when symlink already points to the correct target", () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-noop-");
    const localBin = path.join(tmpDir, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });

    process.env.HOME = tmpDir;

    const hermesPath = path.join(tmpDir, "hermes-bin", "hermes");
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    // Create the symlink first
    const linkPath = path.join(localBin, "hermes");
    fs.symlinkSync(hermesPath, linkPath);
    const originalMtime = fs.lstatSync(linkPath).mtimeMs;

    // Call ensureHermesSymlink — should be a no-op
    const result = ensureHermesSymlink(hermesPath);

    assert.equal(result, linkPath);
    assert.equal(fs.readlinkSync(linkPath), hermesPath, "should still point to the same target");
    assert.equal(fs.lstatSync(linkPath).mtimeMs, originalMtime, "symlink should not be touched");
  });

  it("replaces symlink pointing to wrong target", () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-wrong-");
    const localBin = path.join(tmpDir, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });

    process.env.HOME = tmpDir;

    const wrongPath = path.join(tmpDir, "old-hermes", "hermes");
    fs.mkdirSync(path.dirname(wrongPath), { recursive: true });
    fs.writeFileSync(wrongPath, "#!/bin/sh\necho old\n", { mode: 0o755 });

    const correctPath = path.join(tmpDir, "new-hermes", "hermes");
    fs.mkdirSync(path.dirname(correctPath), { recursive: true });
    fs.writeFileSync(correctPath, "#!/bin/sh\necho new\n", { mode: 0o755 });

    // Create symlink pointing to wrong target
    const linkPath = path.join(localBin, "hermes");
    fs.symlinkSync(wrongPath, linkPath);
    assert.equal(fs.readlinkSync(linkPath), wrongPath);

    // ensureHermesSymlink should replace it
    const result = ensureHermesSymlink(correctPath);

    assert.equal(result, linkPath);
    assert.equal(fs.readlinkSync(linkPath), correctPath, "should now point to correct target");
  });

  it("replaces regular file at symlink path (EINVAL)", () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-einval-");
    const localBin = path.join(tmpDir, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });

    process.env.HOME = tmpDir;

    const hermesPath = path.join(tmpDir, "hermes-bin", "hermes");
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    // Create a regular file at the symlink path
    const linkPath = path.join(localBin, "hermes");
    fs.writeFileSync(linkPath, "regular file, not a symlink");
    assert.ok(!fs.lstatSync(linkPath).isSymbolicLink(), "should be a regular file");

    // ensureHermesSymlink should replace it with a symlink
    const result = ensureHermesSymlink(hermesPath);

    assert.equal(result, linkPath);
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), "should now be a symlink");
    assert.equal(fs.readlinkSync(linkPath), hermesPath);
  });

  it("creates .local/bin directory if it does not exist", () => {
    const { root: tmpDir } = createTempHome("tamandua-test-hermes-mkdir-");

    process.env.HOME = tmpDir;

    // .local/bin should NOT exist
    const localBin = path.join(tmpDir, ".local", "bin");
    assert.equal(fs.existsSync(localBin), false);

    const hermesPath = path.join(tmpDir, "hermes-bin", "hermes");
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    const result = ensureHermesSymlink(hermesPath);

    const linkPath = path.join(localBin, "hermes");
    assert.equal(result, linkPath);
    assert.ok(fs.existsSync(localBin), ".local/bin should be created");
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
  });

  // ── Integration: symlink created during hermes discovery ──────────

  describe("integration with findHermesBinary", () => {
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

    it("creates symlink when hermes is resolved via login shell", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-hs-integration-");
      process.env.HOME = tmpDir;

      // Place hermes in a dir not on PATH
      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      // Fake zsh that outputs the hermes path
      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\necho ${hermesPath}\n`,
        { mode: 0o755 },
      );

      // PATH has the fake zsh but NOT the hermes dir
      process.env.PATH = `${fakeZshDir}:${savedPath ?? ""}`;

      const result = await findHermesBinary();
      const expected = fs.realpathSync(hermesPath);
      assert.equal(result, expected);

      // Verify symlink was created
      const linkPath = path.join(tmpDir, ".local", "bin", "hermes");
      assert.ok(fs.existsSync(linkPath), "symlink should be created by findHermesBinary");
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
      assert.equal(fs.readlinkSync(linkPath), expected);
    });

    it("idempotent: repeated discovery does not touch existing correct symlink", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-hs-idem-");
      process.env.HOME = tmpDir;

      // Place hermes in a dir not on PATH
      const hermesDir = path.join(tmpDir, "hermes-bin");
      fs.mkdirSync(hermesDir, { recursive: true });
      const hermesPath = path.join(hermesDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      // Fake zsh
      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\necho ${hermesPath}\n`,
        { mode: 0o755 },
      );

      process.env.PATH = `${fakeZshDir}:${savedPath ?? ""}`;

      // First discovery
      await findHermesBinary();
      const linkPath = path.join(tmpDir, ".local", "bin", "hermes");
      assert.ok(fs.existsSync(linkPath));
      const mtimeAfterFirst = fs.lstatSync(linkPath).mtimeMs;

      // Second discovery — should be no-op
      await findHermesBinary();
      assert.equal(fs.lstatSync(linkPath).mtimeMs, mtimeAfterFirst, "symlink should not be touched");
      const expected = fs.realpathSync(hermesPath);
      assert.equal(fs.readlinkSync(linkPath), expected);
    });
  });
});
