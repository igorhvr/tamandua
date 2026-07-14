import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  findHermesBinary,
  findPiBinary,
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

      // PATH has the fake zsh but NOT the hermes dir.
      // Do NOT append savedPath — the real ~/.local/bin/hermes is on
      // this machine's PATH and would be found before the login-shell fallback.
      process.env.PATH = fakeZshDir;

      const result = await findHermesBinary();
      // Resolves through login-shell fallback and realpath
      const expected = fs.realpathSync(hermesPath);
      assert.equal(result, expected);
      

    });

    it("resolves realpath to handle macOS /var → /private/var symlinks", async () => {
      // Create hermes inside a symlinked directory structure
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-symlink-");

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

      // Do NOT append savedPath — the real ~/.local/bin/hermes would
      // be found before the login-shell fallback.
      process.env.PATH = fakeZshDir;

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

      // Do NOT append savedPath — the real ~/.local/bin/hermes would
      // be found before the login-shell fallback.
      process.env.PATH = fakeZshDir;

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

      // Do NOT append savedPath — the real ~/.local/bin/hermes would
      // be found before the login-shell fallback.
      process.env.PATH = fakeZshDir;

      // Login shell found a path but it's not executable → treated as not found
      await assert.rejects(
        findHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("falls back gracefully when login shell returns empty output", async () => {
      // Fake zsh produces no output (hermes not in login shell PATH)
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-empty-");

      process.env.HOME = tmpDir;

      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(fakeZsh, "#!/bin/sh\n# no output\n", { mode: 0o755 });

      // Do NOT append savedPath — the real ~/.local/bin/hermes would
      // be found before the login-shell fallback.
      process.env.PATH = fakeZshDir;

      await assert.rejects(
        findHermesBinary(),
        /hermes binary not found in PATH/,
      );
    });

    it("prefers PATH over login shell", async () => {
      // PATH has a hermes AND login shell would find a different hermes.
      // PATH should win.
      const { root: tmpDir } = createTempHome("tamandua-test-hermes-pathfirst-");

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

  // ── Regression: destructive same-path scenario ─────────────────
  // When ~/.local/bin/hermes is a regular executable, the process
  // PATH excludes it, and login-shell discovery returns that exact path,
  // resolution must NOT mutate the file.

  it("does NOT destroy regular executable at ~/.local/bin/hermes when login shell discovers same path", async () => {
    const savedHermes = process.env.TAMANDUA_HERMES_BINARY;
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    delete process.env.TAMANDUA_HERMES_BINARY;
    try {
    const { root: tmpDir } = createTempHome("tamandua-test-regfile-samepath-");

    process.env.HOME = tmpDir;

    // Create ~/.local/bin/hermes as a regular executable
    const localBin = path.join(tmpDir, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    const existingHermes = path.join(localBin, "hermes");
    const originalContent = "#!/bin/sh\necho i am real hermes\n";
    fs.writeFileSync(existingHermes, originalContent, { mode: 0o755 });
    const originalMode = fs.statSync(existingHermes).mode;
    const originalSize = fs.statSync(existingHermes).size;

    // Fake zsh that returns the ~/.local/bin/hermes path
    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(
      fakeZsh,
      `#!/bin/sh\necho ${existingHermes}\n`,
      { mode: 0o755 },
    );

    // PATH has the fake zsh but NOT ~/.local/bin
    process.env.PATH = fakeZshDir;

    const result = await findHermesBinary();
    const expected = fs.realpathSync(existingHermes);
    assert.equal(result, expected);

    // The file MUST remain a regular executable with identical bytes
    assert.ok(fs.existsSync(existingHermes), "file must still exist");
    assert.ok(!fs.lstatSync(existingHermes).isSymbolicLink(), "must remain a regular file, not a symlink");
    assert.equal(fs.readFileSync(existingHermes, "utf-8"), originalContent, "file content must be unchanged");
    assert.equal(fs.statSync(existingHermes).size, originalSize, "file size must be unchanged");
    assert.equal(fs.statSync(existingHermes).mode, originalMode, "file mode must be unchanged");
    } finally {
      if (savedHermes === undefined) {
        delete process.env.TAMANDUA_HERMES_BINARY;
      } else {
        process.env.TAMANDUA_HERMES_BINARY = savedHermes;
      }
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
      if (savedHome !== undefined) {
        process.env.HOME = savedHome;
      }
    }
  });

  // ── Regression: unrelated ~/.local/bin/hermes stays untouched ──
  // When ~/.local/bin/hermes is a user regular file and login discovery
  // returns a DIFFERENT hermes elsewhere, the existing path must remain
  // untouched.

  it("does NOT touch regular file at ~/.local/bin/hermes when login shell discovers a different hermes", async () => {
    const savedHermes = process.env.TAMANDUA_HERMES_BINARY;
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    delete process.env.TAMANDUA_HERMES_BINARY;
    try {
    const { root: tmpDir } = createTempHome("tamandua-test-regfile-otherpath-");

    process.env.HOME = tmpDir;

    // Create ~/.local/bin/hermes as a regular file (NOT symlink-replaced)
    const localBin = path.join(tmpDir, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    const existingHermes = path.join(localBin, "hermes");
    const originalContent = "regular user file — should not be touched";
    fs.writeFileSync(existingHermes, originalContent);
    const originalMode = fs.statSync(existingHermes).mode;
    const originalSize = fs.statSync(existingHermes).size;

    // Create hermes in a DIFFERENT location (not ~/.local/bin)
    const hermesDir = path.join(tmpDir, "other-hermes-dir");
    fs.mkdirSync(hermesDir, { recursive: true });
    const discoveredHermes = path.join(hermesDir, "hermes");
    fs.writeFileSync(discoveredHermes, "#!/bin/sh\necho discovered hermes\n", { mode: 0o755 });

    // Fake zsh that returns the DIFFERENT hermes path
    const fakeZshDir = path.join(tmpDir, "fake-zsh");
    fs.mkdirSync(fakeZshDir, { recursive: true });
    const fakeZsh = path.join(fakeZshDir, "zsh");
    fs.writeFileSync(
      fakeZsh,
      `#!/bin/sh\necho ${discoveredHermes}\n`,
      { mode: 0o755 },
    );

    // PATH has fake zsh but NOT ~/.local/bin and NOT the other hermes dir
    process.env.PATH = fakeZshDir;

    const result = await findHermesBinary();
    const expected = fs.realpathSync(discoveredHermes);
    assert.equal(result, expected);

    // ~/.local/bin/hermes must be untouched
    assert.ok(fs.existsSync(existingHermes), "existing file must still exist");
    assert.ok(!fs.lstatSync(existingHermes).isSymbolicLink(), "must remain a regular file");
    assert.equal(fs.readFileSync(existingHermes, "utf-8"), originalContent, "file content must be unchanged");
    assert.equal(fs.statSync(existingHermes).size, originalSize, "file size must be unchanged");
    assert.equal(fs.statSync(existingHermes).mode, originalMode, "file mode must be unchanged");
    } finally {
      if (savedHermes === undefined) {
        delete process.env.TAMANDUA_HERMES_BINARY;
      } else {
        process.env.TAMANDUA_HERMES_BINARY = savedHermes;
      }
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
      if (savedHome !== undefined) {
        process.env.HOME = savedHome;
      }
    }
  });
