// Tier-2 STORM-REAL US-002 — REAL harness binary resolution, runtime pins and
// missing-harness refusal (pure resolver + in-process prepare; NO daemon, NO
// model, NO real tokens).
//
// A REAL campaign runs the operator's real pi/hermes/dsh harnesses, so
// `tt-storm prepare --profile REAL` must resolve EVERY roster harness exactly
// the way the product does (TAMANDUA_PI_BINARY/HERMES/DSH absolute override,
// else PATH), pin what it resolved (absolute path + --version output + sha256)
// into descriptor.runtime_pins, and REFUSE the whole prepare with
// TT_UNRESOLVED_BINARY when any roster harness is missing/unresolvable — with
// no campaign dir left behind. SCRIPTED_REHEARSAL keeps its frozen
// scripted-runtime pins untouched.
//
// Everything here runs against owned temp fixtures with injected env/runner
// seams, so the tests never depend on the operator's installed toolchain and
// never touch the live daemon.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { buildPrivateExecContext, persistableExecIdentity } from "../bin/tt-storm-real.mjs";
import { stormPrepare } from "../bin/tt-storm-engine.mjs";
import {
  HARNESS_BINARY_ENV,
  HARNESS_NAMES,
  harnessNamesForRoster,
  pinHarness,
  resolveHarnessExecutable,
  resolveRosterHarnessPins,
} from "../bin/tt-storm-harness-pins.mjs";
import { REAL, SCRIPTED_REHEARSAL } from "../bin/tt-storm-profile.mjs";
import {
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  REHEARSAL_LABEL,
  computeGateHashes,
} from "../bin/tt-storm-rehearsal.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-harness-pins-${label}-`));
}

// Write an owned fake executable that answers `--version` deterministically.
function writeFakeHarness(dir: string, name: string, versionText: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho '${versionText}'\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function makeRealGitAdapter() {
  return {
    run: async (cwd: string, args: string[], { env = {} }: { env?: Record<string, string> } = {}) => {
      return spawnCapture(["git", ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
        mergeParentEnv: false,
        timeoutMs: 120_000,
      });
    },
  };
}

// Build the SAME ctx the CLI wires for prepare, with an explicit profile and
// injected REAL harness env/version seams (hermetic — never the operator's
// installed toolchain).
function inProcessCtx(
  scratch: string,
  profile: string | undefined,
  harnessEnv: Record<string, string> = {},
): any {
  const varRoot = path.join(scratch, "var");
  fs.mkdirSync(varRoot, { recursive: true });
  const installedRoot = path.join(varRoot, "home", ".tamandua", "workflows");
  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
  return {
    fs: REAL_FS,
    clock: {
      nowMs: () => Date.now(),
      nowUtc: () => new Date().toISOString(),
      sleep: async () => {},
    },
    proc: { spawn: async () => { throw new Error("no proc"); }, daemonControl: async () => { throw new Error("no proc"); }, harness: async () => { throw new Error("no proc"); } },
    db: null,
    git: makeRealGitAdapter(),
    varRoot,
    campaignDir: null,
    opts: {
      rehearsalPrepare: true,
      installedCatalogRoot: installedRoot,
      bundledCatalogRoot: BUNDLED_WORKFLOWS,
      sourceCommit: "c".repeat(40),
      sourceTree: "t".repeat(40),
      sourceTreeDirty: false,
      execIdentity: persistableExecIdentity(execCtx),
      gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(scratch, "git-home") },
      gateHashes: computeGateHashes(),
      coordinatorApprovalFile: DEFAULT_COORDINATOR_APPROVAL_FILE,
      harnessEnv,
      harnessPath: "",
      harnessVersionRunner: async (binaryPath: string) => ({
        stdout: `fake ${path.basename(binaryPath)} 9.9.9`,
        stderr: "",
        exitCode: 0,
      }),
      // The frozen scripted runtimes the SCRIPTED_REHEARSAL path pins (the CLI
      // passes the same two paths). Unused on the REAL path.
      scriptedRuntimes: {
        pi: path.join(TT_DIR, "scripted-runtimes", "bin", "scripted-pi"),
        hermes: path.join(TT_DIR, "scripted-runtimes", "bin", "scripted-hermes"),
      },
      ...(profile === undefined ? {} : { profile }),
      // STORM-REAL US-006: a REAL prepare requires a hard spend cap; this
      // harness-pin test injects one so the REAL prepare reaches the harness
      // resolution it is exercising (the cap itself is covered by
      // tier2-storm-real-spend-cap.test.ts).
      ...(profile === REAL ? { spendCapTokens: "100000000" } : {}),
    },
    argv: profile === undefined ? ["prepare"] : ["prepare", "--profile", profile],
  };
}

describe("STORM-REAL US-002 harness binary resolution + pins", () => {
  it("H1: env overrides win for pi/hermes/dsh and record their provenance", () => {
    const scratch = ownedScratch("env");
    try {
      assert.deepEqual([...HARNESS_NAMES], ["pi", "hermes", "dsh"]);
      assert.equal(HARNESS_BINARY_ENV.pi, "TAMANDUA_PI_BINARY");
      assert.equal(HARNESS_BINARY_ENV.hermes, "TAMANDUA_HERMES_BINARY");
      assert.equal(HARNESS_BINARY_ENV.dsh, "TAMANDUA_DSH_BINARY");
      for (const name of HARNESS_NAMES) {
        const bin = writeFakeHarness(scratch, name, `${name} 1.2.3`);
        const env = { [HARNESS_BINARY_ENV[name]]: bin };
        const resolved = resolveHarnessExecutable(name, { env, pathEnv: "" });
        assert.equal(resolved.path, bin, `${name} env override is honored`);
        assert.equal(resolved.resolved_from, `env:${HARNESS_BINARY_ENV[name]}`);
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H2: a relative override or an absent/foreign override refuses TT_UNRESOLVED_BINARY", () => {
    const scratch = ownedScratch("refuse-env");
    try {
      assert.throws(
        () => resolveHarnessExecutable("pi", { env: { TAMANDUA_PI_BINARY: "pi" }, pathEnv: "" }),
        (e: any) => e.code === "TT_UNRESOLVED_BINARY" && /absolute/.test(e.message),
        "a relative override must refuse",
      );
      const absent = path.join(scratch, "does-not-exist");
      assert.throws(
        () => resolveHarnessExecutable("pi", { env: { TAMANDUA_PI_BINARY: absent }, pathEnv: "" }),
        (e: any) => e.code === "TT_UNRESOLVED_BINARY" && /not an existing executable/.test(e.message),
        "an absent override must refuse",
      );
      // A directory is not an executable harness.
      assert.throws(
        () => resolveHarnessExecutable("hermes", { env: { TAMANDUA_HERMES_BINARY: scratch }, pathEnv: "" }),
        (e: any) => e.code === "TT_UNRESOLVED_BINARY",
        "a directory override must refuse",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H3: PATH fallback resolves an executable named after the harness; an empty PATH refuses", () => {
    const scratch = ownedScratch("path");
    try {
      const pi = writeFakeHarness(scratch, "pi", "pi 4.5.6");
      const resolved = resolveHarnessExecutable("pi", { env: {}, pathEnv: scratch });
      assert.equal(resolved.path, pi, "PATH fallback finds the named executable");
      assert.match(resolved.resolved_from, /^path:/);

      const empty = fs.mkdtempSync(path.join(scratch, "empty-"));
      assert.throws(
        () => resolveHarnessExecutable("pi", { env: {}, pathEnv: empty }),
        (e: any) => e.code === "TT_UNRESOLVED_BINARY" && /on PATH/.test(e.message),
        "no candidate on PATH refuses",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H4: pinHarness records absolute path, sha256 and the --version output (non-zero exit reported, not fatal)", async () => {
    const scratch = ownedScratch("pin");
    try {
      const pi = writeFakeHarness(scratch, "pi", "pi 7.8.9");
      const expectedSha = createHash("sha256").update(fs.readFileSync(pi)).digest("hex");
      const pin = await pinHarness("pi", {
        env: { TAMANDUA_PI_BINARY: pi },
        pathEnv: "",
        runner: async () => ({ stdout: "pi 7.8.9\n", stderr: "", exitCode: 0 }),
      });
      assert.equal(pin.harness, "pi");
      assert.equal(pin.path, pi);
      assert.equal(pin.resolved_from, "env:TAMANDUA_PI_BINARY");
      assert.equal(pin.sha256, expectedSha);
      assert.match(pin.sha256, /^[0-9a-f]{64}$/);
      assert.equal(pin.version, "pi 7.8.9");
      assert.equal(pin.version_exit_code, 0);

      // A non-zero --version is recorded honestly, never a resolution refusal.
      const odd = await pinHarness("hermes", {
        env: { TAMANDUA_HERMES_BINARY: writeFakeHarness(scratch, "hermes", "hermes 1.0") },
        pathEnv: "",
        runner: async () => ({ stdout: "", stderr: "hermes unknown flag", exitCode: 3 }),
      });
      assert.equal(odd.version, "hermes unknown flag");
      assert.equal(odd.version_exit_code, 3);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H5: resolveRosterHarnessPins pins every roster harness and refuses if any is missing", async () => {
    const scratch = ownedScratch("roster");
    try {
      const pi = writeFakeHarness(scratch, "pi", "pi 1.0.0");
      const hermes = writeFakeHarness(scratch, "hermes", "hermes 2.0.0");
      const pins = await resolveRosterHarnessPins(["pi", "hermes"], {
        env: { TAMANDUA_PI_BINARY: pi, TAMANDUA_HERMES_BINARY: hermes },
        pathEnv: "",
        runner: async (binaryPath: string) => ({ stdout: `v ${path.basename(binaryPath)}`, stderr: "", exitCode: 0 }),
      });
      assert.deepEqual(Object.keys(pins), ["pi", "hermes"]);
      for (const name of ["pi", "hermes"]) {
        assert.equal(pins[name].path, name === "pi" ? pi : hermes);
        assert.match(pins[name].sha256, /^[0-9a-f]{64}$/);
        assert.match(pins[name].version, new RegExp(name));
      }

      // hermes unresolvable -> the WHOLE call refuses.
      await assert.rejects(
        () => resolveRosterHarnessPins(["pi", "hermes"], { env: { TAMANDUA_PI_BINARY: pi }, pathEnv: "" }),
        (e: any) => e.code === "TT_UNRESOLVED_BINARY",
        "a missing roster harness refuses the whole pin set",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H6: harnessNamesForRoster derives the distinct harness names in first-appearance order", () => {
    assert.deepEqual(
      harnessNamesForRoster([
        { harness: "pi" },
        { harness: "hermes" },
        { harness: "pi" },
        { harness: "dsh" },
        {},
        { harness: "" },
      ]),
      ["pi", "hermes", "dsh"],
    );
    assert.deepEqual(harnessNamesForRoster([]), []);
  });

  it("H7: a REAL prepare records the real harness pins (path+version+sha256) and no scripted_runtimes block", async () => {
    const scratch = ownedScratch("real-prepare");
    try {
      const pi = writeFakeHarness(scratch, "pi", "pi 3.1.4");
      const hermes = writeFakeHarness(scratch, "hermes", "hermes 5.9.2");
      const ctx = inProcessCtx(scratch, REAL, {
        TAMANDUA_PI_BINARY: pi,
        TAMANDUA_HERMES_BINARY: hermes,
      });
      const res: any = await stormPrepare(ctx);
      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.equal(desc.profile, REAL);
      assert.equal(desc.runtime_pins.scripted_runtimes, undefined, "REAL pins carry no scripted_runtimes block");
      assert.deepEqual(Object.keys(desc.runtime_pins.harnesses), ["pi", "hermes"]);
      assert.equal(desc.runtime_pins.harnesses.pi.path, pi);
      assert.equal(desc.runtime_pins.harnesses.pi.version, "fake pi 9.9.9");
      assert.equal(desc.runtime_pins.harnesses.pi.version_exit_code, 0);
      assert.equal(desc.runtime_pins.harnesses.pi.resolved_from, "env:TAMANDUA_PI_BINARY");
      assert.match(desc.runtime_pins.harnesses.pi.sha256, /^[0-9a-f]{64}$/);
      assert.equal(desc.runtime_pins.harnesses.hermes.path, hermes);
      assert.deepEqual(desc.runtime_pins.harness_resolution.roster_harnesses, ["pi", "hermes"]);
      assert.equal(desc.runtime_pins.harness_resolution.profile, REAL);
      // Mirrored into state.rehearsal.runtime_pins.
      assert.equal(res.state.rehearsal.runtime_pins.harnesses.pi.path, pi);
      assert.equal(res.state.rehearsal.runtime_pins.scripted_runtimes, undefined);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H8: a REAL prepare refuses a missing roster harness with TT_UNRESOLVED_BINARY before any campaign dir exists", async () => {
    const scratch = ownedScratch("missing");
    try {
      const pi = writeFakeHarness(scratch, "pi", "pi 1.0.0");
      const ctx = inProcessCtx(scratch, REAL, { TAMANDUA_PI_BINARY: pi });
      const target = path.join(scratch, "var", "results", "storm-must-not-exist");
      ctx.campaignDir = target;
      await assert.rejects(
        () => stormPrepare(ctx),
        (e: any) => e.code === "TT_UNRESOLVED_BINARY" && /hermes/.test(e.message),
        "the missing hermes harness must refuse the REAL prepare",
      );
      assert.equal(fs.existsSync(target), false, "the refusal left NO campaign dir behind");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H9: SCRIPTED_REHEARSAL is unaffected (frozen scripted_runtime pins, no real harnesses block)", async () => {
    const scratch = ownedScratch("scripted");
    try {
      const ctx = inProcessCtx(scratch, undefined, {});
      const res: any = await stormPrepare(ctx);
      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.equal(desc.profile, SCRIPTED_REHEARSAL);
      assert.equal(desc.label, REHEARSAL_LABEL);
      assert.equal(desc.runtime_pins.harnesses, undefined, "scripted pins carry no real harnesses block");
      assert.ok(desc.runtime_pins.scripted_runtimes?.pi?.present === true, "scripted pi runtime pinned");
      assert.ok(desc.runtime_pins.scripted_runtimes?.hermes?.present === true, "scripted hermes runtime pinned");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("H10: defaultHarnessVersionRunner follows the harness --version contract against a real owned executable", async () => {
    const scratch = ownedScratch("version-runner");
    try {
      const fake = writeFakeHarness(scratch, "pi", "pi 42.0");
      const pin = await pinHarness("pi", { env: { TAMANDUA_PI_BINARY: fake }, pathEnv: "" });
      assert.equal(pin.version, "pi 42.0");
      assert.equal(pin.version_exit_code, 0);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});