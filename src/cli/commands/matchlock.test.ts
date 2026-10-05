/**
 * Tests for the `tamandua matchlock` CLI surface (MTLK-SETUP, US-014).
 *
 * Covers the group/setup help content, the top-level registration
 * (`isTopLevelGroup`/`KNOWN_TOP_LEVEL`), the global usage line and the
 * spawn-based `--help` dispatch. The subset that spawns the real CLI wrapper
 * uses the serial lane (`tests/serial-files.txt`) because this file imports
 * `node:child_process` directly.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { cleanChildEnv, createTempHome } from "../../../tests/helpers/test-env.ts";

import {
  getMatchlockHelp,
  getMatchlockSetupHelp,
  handleMatchlock,
} from "../../../dist/cli/commands/matchlock.js";
import { createDefaultMatchlockSetupDeps } from "../../../dist/installer/matchlock-setup-runner.js";
import { KNOWN_TOP_LEVEL, isTopLevelGroup } from "../../../dist/cli/shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WRAPPER_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "tamandua");

/** Exact global usage line required by spec §4.1. */
const USAGE_LINE =
  "tamandua matchlock setup          Provision matchlock: binaries, host setup, standard image";

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const testEnv = createTempHome("tamandua-matchlock-cli-test-");
  const result = spawnSync("/bin/sh", [WRAPPER_PATH, ...args], {
    encoding: "utf8",
    env: cleanChildEnv({ HOME: testEnv.homeDir }),
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("matchlock command module", () => {
  it("is backed by a source module", () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), "src/cli/commands/matchlock.ts")), true);
  });

  it("exports the group help", () => {
    const help = getMatchlockHelp();
    assert.match(help, /tamandua matchlock/);
    assert.match(help, /setup/);
    assert.match(help, /matchlock setup --help/);
  });

  it("documents the four phases", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /Phases \(in order\)/);
    assert.match(help, /1\. Binaries/);
    assert.match(help, /2\. Host setup/);
    assert.match(help, /3\. Boot assets/);
    assert.match(help, /4\. Verify/);
  });

  it("documents every flag", () => {
    const help = getMatchlockSetupHelp();
    for (const flag of [
      "--latest",
      "--ref <sha|tag|branch>",
      "--prefix <dir>",
      "--refresh-image",
      "--allow-low-disk-space",
      "--no-host-setup",
      "--no-image",
      "--force",
      "--smoke",
      "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
    ]) {
      assert.ok(help.includes(flag), `setup help should document ${flag}`);
    }
  });

  it("documents platform notes", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /Linux \(amd64\/arm64\)/);
    assert.match(help, /macOS \(Apple Silicon\)/);
    assert.match(help, /\/opt\/homebrew\/bin/);
    assert.match(help, /SDKROOT=MacOSX26\.5\.sdk/);
  });

  it("documents the re-login caveat", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /RE-LOGIN CAVEAT/);
    assert.match(help, /log out and back in/);
    assert.match(help, /refuses --smoke/);
  });

  it("documents the admission-refusal relationship", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /Provision this host with: tamandua matchlock setup/);
    assert.match(help, /never pulls or builds an image\s+at launch/);
  });

  it("documents the kernel-warm / offline (R11) contract", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /kernel pull/);
    assert.match(help, /assets: offline-ready/);
    assert.match(help, /no\s+public-internet access/);
  });

  it("declines command groups owned by other handlers", async () => {
    assert.equal(await handleMatchlock("workflow", ["workflow", "status"]), false);
    assert.equal(await handleMatchlock("dashboard", ["dashboard", "status"]), false);
    assert.equal(await handleMatchlock("setup", ["setup"]), false);
  });
});

describe("matchlock CLI registration", () => {
  it("registers matchlock as a known top-level group", () => {
    assert.equal(isTopLevelGroup("matchlock"), true);
    assert.ok(KNOWN_TOP_LEVEL.includes("matchlock"));
  });

  it("exposes the spawn-capable default deps factory", () => {
    const deps = createDefaultMatchlockSetupDeps();
    assert.equal(typeof deps.runCommand, "function");
    assert.equal(typeof deps.fs.isExecutable, "function");
    assert.equal(typeof deps.resolveStoredImage, "function");
    assert.equal(typeof deps.accountHomeResolver, "function");
    assert.equal(deps.platform, process.platform);
    assert.equal(deps.arch, process.arch);
  });

  it("global usage contains the new matchlock setup line", () => {
    const result = cli(["--help"]);
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes(USAGE_LINE),
      `global usage should contain:\n${USAGE_LINE}\n--- actual ---\n${result.stdout}`,
    );
  });

  it("`matchlock --help` prints the group help", () => {
    const result = cli(["matchlock", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /tamandua matchlock/);
    assert.match(result.stdout, /matchlock setup --help/);
    // Group help is not the detailed setup help.
    assert.doesNotMatch(result.stdout, /Phases \(in order\)/);
  });

  it("`matchlock setup --help` prints the setup help", () => {
    const result = cli(["matchlock", "setup", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Phases \(in order\)/);
    assert.match(result.stdout, /1\. Binaries/);
    assert.match(result.stdout, /--refresh-image/);
    assert.match(result.stdout, /Provision this host with: tamandua matchlock setup/);
  });

  it("`matchlock setup -h` dispatches to the setup help too", () => {
    const result = cli(["matchlock", "setup", "-h"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Phases \(in order\)/);
  });

  it("`matchlock --help` does not execute the command", () => {
    const result = cli(["matchlock", "--help"]);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /refusing to run as root/);
    assert.equal(result.stderr, "");
  });

  it("an unknown matchlock action fails with usage guidance", () => {
    const result = cli(["matchlock", "frobnicate"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown matchlock action: frobnicate/);
    assert.match(result.stderr, /tamandua matchlock setup \[flags\]/);
  });

  it("a missing matchlock subcommand fails with usage guidance", () => {
    const result = cli(["matchlock"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing matchlock subcommand/);
    assert.match(result.stderr, /tamandua matchlock setup \[flags\]/);
  });
});
