// Tier-1 / tier0 gate (US-006): `--case <id>` single-case filter.
//
// Adds a `--case <id>` option to tt-controller (and wires it through tt-run)
// that selects exactly ONE manifest case id for focused reruns. The filter is
// applied right after manifest load (validate-only, new campaign, and resume
// paths), so every downstream stage — host-profile selection, campaign state,
// execution, and reports — operates only on the focused case.
//
// Contract under test (AC1-AC4):
//   1. --case selects exactly the matching case id from the manifest.
//   2. An unknown --case id fails fast (exit 2) with a clear error message
//      that lists available ids.
//   3. --case is allowed with --scripted-only AND with the default
//      (include-real) execution selection — both combinations run.
//   4. usage()/help documents --case.
//   5. Tests for --case filter pass; typecheck passes.
//
// This gate is ZERO-TOKEN and hermetic: it drives the controller's validate-only
// and real-campaign paths with local/scripted cases that never touch pi/hermes,
// and throws away its scratch manifests under torture-test/var (gitignored).
// Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const ttRun = path.join(binDir, "tt-run");
const varRoot = path.join(ttRoot, "var");

function runTt(script: string, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(script, args, {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    // Strip the tamandua test-isolation guard vars: the guard auto-activates
    // whenever NODE_TEST_CONTEXT is set (node:test sets it in every test
    // process) and the controller's local-case commands shell out to the real
    // tamandua daemon + contained token ledger, which would trip the guard.
    // Same pattern as tt-poly-end-to-end-verification / build-golden tests.
    env: cleanSpellEnv(process.env),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

// Build a child env without the tamandua test-isolation guard triggers.
function cleanSpellEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, HOME: os.homedir() };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  return env;
}

// Write a scratch multi-case manifest under var/ (gitignored, escapes never).
function writeManifest(records: any[]): string {
  const name = `US006-${Date.now()}-${process.pid}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

const BASE_RECORD: any = {
  wave: 5,
  workflow: "local",
  fixture: "none",
  harness: "local",
  task: "tamandua-torture-test-spec/04-wave-0-preflight.md",
  context: { execution_mode: "scripted" },
  caps: { tokens: 0, wall_min: 1 },
  requires: {},
  boundary_files: ["bin/tt-verify-environment"],
  forbidden: [],
  oracles: ["O3z"],
  gates: ["TIER0", "W0"],
  command: { executable: "bin/tt-verify-environment", args: ["--fast", "--json"], cwd: "." },
  chaos: null,
  shed_ok: false,
  mandatory: true,
  class: "verification",
};

function recordWithId(id: string): any {
  return { ...BASE_RECORD, id };
}

// Returns the CIDs of campaigns created during this test so we can drop them.
const createdCampaigns: string[] = [];
after(() => {
  for (const cid of createdCampaigns) fs.rmSync(path.join(varRoot, "results", cid), { recursive: true, force: true });
});

function captureCampaign(stdout: string): string | null {
  const match = /^Campaign:\s+(campaign-[^\s]+)$/m.exec(stdout);
  if (match) createdCampaigns.push(match[1]);
  return match ? match[1] : null;
}

describe("tt-controller --case single-case filter (US-006)", () => {
  it("AC1: --case selects exactly the matching case id (validate-only reports 1 case)", () => {
    const manifestPath = writeManifest([
      recordWithId("A.one"),
      recordWithId("B.two"),
      recordWithId("C.three"),
    ]);
    const res = runTt(controller, ["--manifest", manifestPath, "--validate-only", "--case", "B.two"]);
    assert.equal(res.status, 0, `expected success:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
    assert.match(res.stdout, /Validated 1 case\(s\)/);
    // A real campaign on the same selection must create exactly one pending case.
    const camp = runTt(controller, ["--manifest", manifestPath, "--case", "A.one"]);
    assert.equal(camp.status, 0, `campaign failed:\n${camp.stdout}\n${camp.stderr}`);
    assert.match(camp.stdout, /Validated 1 case\(s\)/);
    captureCampaign(camp.stdout);
  });

  it("AC1: --case on the real tier1 manifest selects exactly W1.L1-python (1 of 28)", () => {
    const res = runTt(controller, [
      "--manifest", path.join(ttRoot, "cases", "tier1.jsonl"),
      "--validate-only", "--case", "W1.L1-python",
    ]);
    assert.equal(res.status, 0, `expected success:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 1 case\(s\)/);
  });

  it("AC2: unknown --case id fails fast with a clear message listing available ids", () => {
    const manifestPath = writeManifest([recordWithId("A.one"), recordWithId("B.two")]);
    const res = runTt(controller, ["--manifest", manifestPath, "--validate-only", "--case", "NO.SUCH.CASE"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown --case id 'NO\.SUCH\.CASE'/);
    assert.match(res.stderr, /available ids: A\.one, B\.two/);
    // Also on the real tier1 manifest.
    const res2 = runTt(controller, [
      "--manifest", path.join(ttRoot, "cases", "tier1.jsonl"),
      "--validate-only", "--case", "W9.NOPE",
    ]);
    assert.equal(res2.status, 2);
    assert.match(res2.stderr, /unknown --case id 'W9\.NOPE'/);
  });

  it("AC3: --case is allowed with --scripted-only and with include-real (default all)", () => {
    const manifestPath = writeManifest([recordWithId("S.scr"), recordWithId("S.scr2")]);
    // --scripted-only combination: both records are local/scripted, must run.
    const scr = runTt(controller, ["--manifest", manifestPath, "--case", "S.scr", "--scripted-only"]);
    assert.equal(scr.status, 0, `scripted-only combo failed:\n${scr.stdout}\n${scr.stderr}`);
    assert.match(scr.stdout, /Validated 1 case\(s\)/);
    captureCampaign(scr.stdout);
    // include-real (default 'all') combination.
    const all = runTt(controller, ["--manifest", manifestPath, "--case", "S.scr2"]);
    assert.equal(all.status, 0, `include-real combo failed:\n${all.stdout}\n${all.stderr}`);
    assert.match(all.stdout, /Validated 1 case\(s\)/);
    captureCampaign(all.stdout);
  });

  it("AC4: usage()/help documents --case", () => {
    const res = runTt(controller, ["--help"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /--case <id>/);
    assert.match(res.stdout, /focused rerun/);
  });

  it("wiring: tt-run --tier0 --case selects one case (scripted-only via tt-run)", () => {
    const res = runTt(ttRun, ["--tier0", "--case", "W0.0-fast"]);
    assert.equal(res.status, 0, `tt-run combo failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 1 case\(s\)/);
    captureCampaign(res.stdout);
  });

  it("wiring: tt-run --tier0 --include-real --case runs and unknown id is fail-fast", () => {
    const res = runTt(ttRun, ["--tier0", "--include-real", "--case", "W0.0-fast"]);
    assert.equal(res.status, 0, `tt-run include-real combo failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 1 case\(s\)/);
    captureCampaign(res.stdout);
    const bad = runTt(ttRun, ["--tier0", "--case", "NOPE"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown --case id 'NOPE'/);
    // tt-run refuses a case id without a tier flag (usage error 4).
    const noTier = runTt(ttRun, ["--case", "W0.0-fast"]);
    assert.equal(noTier.status, 4);
    const noTierDoc = runTt(ttRun, ["--help"]);
    assert.equal(noTierDoc.status, 0);
    assert.match(noTierDoc.stdout, /--case <id>/);
  });
});
