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

    assert.throws(
      () => findHermesBinary(),
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

    assert.throws(
      () => findHermesBinary(),
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
