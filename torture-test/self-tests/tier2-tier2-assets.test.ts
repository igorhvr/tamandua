// Tier-2 assets + --tier2 ladder rung acceptance (US-015).
//
// Pins the US-015 authoring layer:
//   * bin/tt-tier2-assets validates cases/tier2.jsonl the way tt-tier1-assets
//     validates tier1 (task files resolve and stay inside torture-test/,
//     probe refs exist, requires keys/shapes valid, manifest under cases/)
//     AND adds the Tier-2 authoring contracts: every `seed` field exists in
//     the fixture's SEEDS.md catalog (E3.A S2 arm) and requires.capabilities
//     entries (incl. `dsh`) are well-formed (AC1);
//   * tt-run --tier2 routes to tt-controller --scripted-only by default and
//     without it under --include-real; --include-real is accepted with
//     --tier2; tier_available tier2 flips available (AC2/AC3);
//   * usage() documents the --tier2 pending-real default and --include-real
//     full campaign (AC3).
//
// The E2.2 fail-closed exit-2 proof (AC4) lives in bin/tt-run.test.sh (it
// drives the REAL tt-run + REAL tt-controller against a manifest copy with an
// impossible predicate); this file keeps the fast, hermetic, zero-token pins
// of the same surface.
//
// Confined to torture-test/ (scratch under gitignored var/ and a cleaned-up
// tmp dir under cases/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const assetsValidator = path.join(binDir, "tt-tier2-assets");
const ttRun = path.join(binDir, "tt-run");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Spawn env: strip NODE_TEST_CONTEXT (node:test sets it; it would auto-arm
// the tamandua TEST ISOLATION guard inside spawned children) and disable the
// guard explicitly; pin harness binaries to /bin/false so an accidental real
// launch can never spend tokens.
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    TAMANDUA_TEST_GUARD: "0",
    TAMANDUA_PI_BINARY: "/bin/false",
    TAMANDUA_HERMES_BINARY: "/bin/false",
    TAMANDUA_DSH_BINARY: "/bin/false",
  };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(script, args, {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

// A valid manifest row shape for scratch manifests (a real tt-ts task path
// resolved against TT_ROOT via the containment check).
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "T2-ASSETS-SCRATCH",
    wave: 4,
    workflow: "bug-fix-merge-worktree",
    fixture: "tt-ts",
    seed: "BUG-T1",
    harness: "pi",
    task: "var/tier2-assets-scratch-task.md",
    context: { execution_mode: "real" },
    caps: { tokens: 0, wall_min: 1 },
    requires: {},
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: [],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
    ...overrides,
  };
}

let scratchCounter = 0;
function scratchManifest(records: Array<Record<string, unknown>>, taskContent = "# scratch task"): string {
  scratchCounter += 1;
  const taskPath = path.join(ttRoot, "var", "tier2-assets-scratch-task.md");
  fs.writeFileSync(taskPath, taskContent);
  const casesTmp = fs.mkdtempSync(path.join(ttRoot, "cases", `tier2-assets-test-${process.pid}-${scratchCounter}-`));
  const manifestPath = path.join(casesTmp, "scratch.jsonl");
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

function cleanupScratch(manifestPath: string): void {
  const dir = path.dirname(manifestPath);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(ttRoot, "var", "tier2-assets-scratch-task.md"), { force: true });
}

describe("Tier-2 assets + --tier2 ladder rung (US-015)", () => {
  it("AC1: tt-tier2-assets validates cases/tier2.jsonl (task files, requires incl. dsh capability, seeds vs fixture SEEDS.md catalogs) and exits 0", () => {
    const res = run(assetsValidator, [manifestPath]);
    assert.equal(res.status, 0, `tt-tier2-assets must exit 0:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 70 Tier-2 case asset set\(s\)/,
      `expected the 70-case tier2 roster to validate: ${res.stdout}`);
    // The dsh lane's seed rows validate against the SEEDS.md catalogs
    // (E3.A S2 arm) — the 4 dsh rows carry seeds BUG-T2/BUG-T3 or probes.
    const records = fs
      .readFileSync(manifestPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const dshRows = records.filter((r) => r.requires?.capabilities?.includes("dsh"));
    assert.ok(dshRows.length >= 4, `expected the dsh-lane rows, got ${dshRows.length}`);
  });

  it("AC1: a seed missing from the fixture SEEDS.md catalog fails closed naming the seed", () => {
    const manifest = scratchManifest([
      row({ id: "T2-BAD-SEED", seed: "BUG-ZZ-NOT-A-SEED" }),
    ]);
    try {
      const res = run(assetsValidator, [manifest]);
      assert.notEqual(res.status, 0, "a phantom seed must fail closed");
      assert.match(res.stderr, /BUG-ZZ-NOT-A-SEED/, "the failure must name the missing seed");
      assert.match(res.stderr, /SEEDS\.md catalog/, "the failure must name the catalog contract");
    } finally {
      cleanupScratch(manifest);
    }
  });

  it("AC1: a seed on a fixture-less (none) row fails closed", () => {
    const manifest = scratchManifest([
      row({ id: "T2-NONE-SEED", fixture: "none", workflow: "local", harness: "local", context: { execution_mode: "scripted" } }),
    ]);
    try {
      const res = run(assetsValidator, [manifest]);
      assert.notEqual(res.status, 0, "a seed without a fixture must fail closed");
      assert.match(res.stderr, /requires a fixture with a SEEDS\.md catalog/);
    } finally {
      cleanupScratch(manifest);
    }
  });

  it("AC1: well-formed seeds + capabilities (incl. dsh) pass; malformed capability entries fail closed", () => {
    const good = scratchManifest([
      row({ id: "T2-GOOD-1", fixture: "tt-ts", seed: "BUG-T1", harness: "dsh", requires: { capabilities: ["dsh"], node_min: 22 } }),
      row({ id: "T2-GOOD-2", fixture: "tt-poly-lite", seed: "storm", harness: "pi", requires: { toolchains: ["node", "python3"] } }),
    ]);
    try {
      const res = run(assetsValidator, [good]);
      assert.equal(res.status, 0, `valid seeds/capabilities must pass:\n${res.stdout}\n${res.stderr}`);
    } finally {
      cleanupScratch(good);
    }

    const badCap = scratchManifest([
      row({ id: "T2-BAD-CAP", requires: { capabilities: ["bad cap!"] } }),
    ]);
    try {
      const res = run(assetsValidator, [badCap]);
      assert.notEqual(res.status, 0, "a malformed capability must fail closed");
      assert.match(res.stderr, /bad cap!/, "the failure must name the offending capability");
      assert.match(res.stderr, /well-formed/, "the failure must cite the well-formedness contract");
    } finally {
      cleanupScratch(badCap);
    }

    const emptyCap = scratchManifest([
      row({ id: "T2-EMPTY-CAP", requires: { capabilities: [""] } }),
    ]);
    try {
      const res = run(assetsValidator, [emptyCap]);
      assert.notEqual(res.status, 0, "an empty capability must fail closed");
    } finally {
      cleanupScratch(emptyCap);
    }
  });

  it("AC2/AC3: tt-run --help documents --tier2 pending-real default and --include-real full campaign", () => {
    const res = run(ttRun, ["--help"]);
    assert.equal(res.status, 0, `tt-run --help must exit 0:\n${res.stderr}`);
    assert.match(res.stdout, /--tier2 reports \+ validates Tier-2 cases as pending-real \(zero tokens\)/,
      "usage must document the --tier2 zero-token pending-real default");
    assert.match(res.stdout, /--tier2 --include-real executes the full Tier-2 campaign/,
      "usage must document --tier2 --include-real");
    assert.match(res.stdout, /WARNING: --include-real launches real pi, Hermes, and dsh work/,
      "usage warning must cover the dsh lane");
  });

  it("AC2/AC3: tt-run tier2 routing + availability via the sourced functions (hermetic fake tree)", () => {
    // Build the standalone functions file exactly like bin/tt-run.test.sh.
    const functionsFile = path.join(os.tmpdir(), `tt-run-fns-${process.pid}-${scratchCounter}.sh`);
    const awkScript = `
      /^if \\[ "\\$#"/ { exit }
      { print }
    `;
    const awk = spawnSync("awk", [awkScript, ttRun], { encoding: "utf8" });
    assert.equal(awk.status, 0, awk.stderr);
    fs.writeFileSync(functionsFile, `${awk.stdout}\n: dummy end-of-functions\n`);

    // Fake tree: a RECORDING tt-controller stub (real exec semantics — the
    // stub writes its argv to a record file and exits 0, so run_tier's exec
    // is genuinely terminal) + a tt-tier2-assets stub + a minimal manifest,
    // so tier_available tier2 flips available and run_tier routing is
    // observable through the record.
    const fakeHome = fs.mkdtempSync(path.join(ttRoot, "var", `tier2-ladder-${process.pid}-`));
    const recordPath = path.join(fakeHome, "controller-args.txt");
    try {
      const fakeBin = path.join(fakeHome, "bin");
      const fakeCases = path.join(fakeHome, "cases");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(fakeCases, { recursive: true });
      fs.writeFileSync(path.join(fakeCases, "tier2.jsonl"), '{"id":"dummy"}\n');
      fs.writeFileSync(path.join(fakeBin, "tt-controller"),
        "#!/usr/bin/env bash\necho \"$*\" > \"${TT_CONTROLLER_RECORD:?}\"\nexit 0\n");
      fs.chmodSync(path.join(fakeBin, "tt-controller"), 0o755);
      fs.writeFileSync(path.join(fakeBin, "tt-tier2-assets"), "#!/usr/bin/env bash\nexit 0\n");
      fs.chmodSync(path.join(fakeBin, "tt-tier2-assets"), 0o755);

      const runIn = (body: string): string => {
        const res = spawnSync("bash", ["-c", `
          set -euo pipefail
          . '${functionsFile}'
          TT_BIN_DIR='${fakeBin}'
          TT_DIR='${fakeHome}'
          export TT_BIN_DIR TT_DIR
          export PATH="\$TT_BIN_DIR:\$PATH"
          export TT_CONTROLLER_RECORD='${recordPath}'
          ${body}
        `], { encoding: "utf8", env: childEnv() });
        return `${String(res.stdout ?? "")}${String(res.stderr ?? "")}`;
      };
      const lastRecord = (): string =>
        fs.existsSync(recordPath) ? fs.readFileSync(recordPath, "utf8").trim() : "";

      const avail = runIn("if tier_available tier2; then echo TIER2_AVAILABLE; fi");
      assert.match(avail, /TIER2_AVAILABLE/, "tier_available tier2 must flip available with the tier2 assets present");

      const max = runIn("max_available_tier");
      assert.match(max, /^tier2$/m, "max_available_tier must pick tier2 first when available");

      runIn("rm -f '$recordPath'; run_tier tier2 false");
      assert.match(lastRecord(), /--scripted-only/, "bare --tier2 must route to --scripted-only");
      assert.match(lastRecord(), /cases\/tier2\.jsonl/, "bare --tier2 must pass the tier2 manifest");

      runIn("rm -f '$recordPath'; run_tier tier2 true");
      assert.doesNotMatch(lastRecord(), /--scripted-only/, "--tier2 --include-real must NOT route to --scripted-only");
      assert.match(lastRecord(), /cases\/tier2\.jsonl/, "--tier2 --include-real must pass the tier2 manifest");
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(functionsFile, { force: true });
    }
  });
});
