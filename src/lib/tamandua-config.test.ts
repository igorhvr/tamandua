/**
 * Unit tests for src/lib/tamandua-config.ts — the single effective
 * state-dir / home resolver shared by daemonctl and daemon-identity.
 *
 * Pure path resolution: no processes, no sockets, no production state. All
 * paths come from tamanduaTempDir() (the project's temp-root helper), so the
 * test-isolation guard (auto-active under node:test) stays satisfied and the
 * temp-dir guard sees no hardcoded system temp paths.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tamanduaTempDir } from "./temp-dir.ts";
import {
  resolveStateDir,
  resolveEffectiveHomeDir,
} from "../../dist/lib/tamandua-config.js";

let savedHome: string | undefined;
let savedStateDir: string | undefined;
let tempRoot: string;
let homeDir: string;
let stateDir: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  tempRoot = tamanduaTempDir("tamandua-config-");
  homeDir = path.join(tempRoot, "home");
  stateDir = path.join(tempRoot, "state");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = savedStateDir;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("resolveStateDir", () => {
  it("returns <homeDir>/.tamandua for an explicit homeDir option", () => {
    assert.equal(
      resolveStateDir({ homeDir }),
      path.join(homeDir, ".tamandua"),
    );
  });

  it("lets the explicit homeDir option win over both env overrides", () => {
    process.env.HOME = path.join(tempRoot, "env-home");
    process.env.TAMANDUA_STATE_DIR = stateDir;
    assert.equal(
      resolveStateDir({ homeDir }),
      path.join(homeDir, ".tamandua"),
    );
  });

  it("honors TAMANDUA_STATE_DIR when no homeDir option is given", () => {
    process.env.HOME = path.join(tempRoot, "env-home");
    process.env.TAMANDUA_STATE_DIR = stateDir;
    assert.equal(resolveStateDir(), stateDir);
  });

  it("trims and path.resolves a TAMANDUA_STATE_DIR override", () => {
    process.env.TAMANDUA_STATE_DIR = "  relative-state-dir  ";
    assert.equal(resolveStateDir(), path.resolve("relative-state-dir"));
  });

  it("ignores a blank TAMANDUA_STATE_DIR", () => {
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = "   ";
    assert.equal(resolveStateDir(), path.join(homeDir, ".tamandua"));
  });

  it("falls back to <HOME>/.tamandua when neither override is set", () => {
    process.env.HOME = homeDir;
    delete process.env.TAMANDUA_STATE_DIR;
    assert.equal(resolveStateDir(), path.join(homeDir, ".tamandua"));
  });

  it("falls back to os.homedir() when HOME is empty", () => {
    process.env.HOME = "";
    delete process.env.TAMANDUA_STATE_DIR;
    assert.equal(resolveStateDir(), path.join(os.homedir(), ".tamandua"));
  });
});

describe("resolveEffectiveHomeDir", () => {
  it("returns the explicit homeDir option", () => {
    assert.equal(resolveEffectiveHomeDir({ homeDir }), homeDir);
  });

  it("returns the parent of a TAMANDUA_STATE_DIR named .tamandua", () => {
    const parent = path.join(tempRoot, "state-parent");
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = path.join(parent, ".tamandua");
    assert.equal(resolveEffectiveHomeDir(), parent);
  });

  it("falls back to HOME when TAMANDUA_STATE_DIR is not named .tamandua", () => {
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    assert.equal(resolveEffectiveHomeDir(), homeDir);
  });

  it("falls back to HOME when no override is set", () => {
    process.env.HOME = homeDir;
    delete process.env.TAMANDUA_STATE_DIR;
    assert.equal(resolveEffectiveHomeDir(), homeDir);
  });

  it("falls back to os.homedir() when HOME is empty", () => {
    process.env.HOME = "";
    delete process.env.TAMANDUA_STATE_DIR;
    assert.equal(resolveEffectiveHomeDir(), os.homedir());
  });
});
