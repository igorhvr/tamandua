// Tier-2 MDSH (R4a US-016): dsh functional boot predicate — the roster must
// know whether dsh can BOOT under the contained daemon's spawn environment
// (PATH/HOME as that daemon sees them) BEFORE any real dsh cell launches, and
// mark dsh-requiring cells NOT_RUN (reason recorded) when it cannot — never
// launch them into INCONCLUSIVE idling.
//
// The W4.dsh-* cells ran on the mac although dsh cannot boot under the
// contained daemon there ("dsh: plugin tree failed t...", while `dsh --profile
// headless --help` works under the interactive shell with the contained HOME),
// so each idled to its cap as INCONCLUSIVE.
//
// Zero-token by construction: the dsh binaries under test are FAKE scripts
// (deterministic exit codes; a boot-level `--profile headless --help` shape —
// never a model call), controller runs use TT_DRY_RUN_REAL_LAUNCH (records the
// launch argv, marks the case PASS, never spawns a model-backed run — the
// tier2-dsh-launch-argv pattern), and the host profiles are synthesized under
// var/w0 (the honest W0.0 profile is restored in `finally`).
//
// RED-ARM (pre-change behavior, recorded in the run's progress log 2026-09-04):
// the pre-change controller (HEAD be3da696) evaluated the dsh capability from
// harness.dsh.present alone — a real dsh cell (harness dsh, requires
// capabilities [dsh]) with a boot-failing fake dsh sailed through the roster
// (dry-run launch recorded, outcome PASS, expected_executable counted) — the
// exact "cells execute" shape that idled W4.dsh-* INCONCLUSIVE on the mac. The
// history-independent replica below pins that pre-change predicate logic
// (presence-only, no boot consult) returning NO gating for the same evidence.
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
const authProbe = path.join(binDir, "tt-harness-auth-probe");
const verifyEnv = path.join(binDir, "tt-verify-environment");
const varRoot = path.join(ttRoot, "var");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");
const realEnv = path.join(ttRoot, "env", "tt-env.sh");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;
const GATED_ID = "W4.dsh-do-now";
const LAUNCHER_ID = "T2-MDSH-LAUNCHER";

// The long stderr line the failed dsh boot smoke emits — comfortably beyond
// the product log preview's truncation point, so a truncated capture could
// never contain its tail.
const LONG_STDERR_TAIL = "MDSH-FULL-STDERR-TAIL-MARKER-9876543210";
const FAIL_STDERR = [
  "dsh: plugin tree failed to load under the contained env",
  `dsh: ${"x".repeat(700)}${LONG_STDERR_TAIL}`,
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env, TAMANDUA_TEST_GUARD: "0" };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runBash(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync("bash", [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 180_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function runTt(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 240_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// envScriptHome: the HOME the contained daemon env script prints — the HOME
// the boot smoke must run under.
function envScriptHome(): string {
  const res = spawnSync("bash", [realEnv, "print"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(res.status, 0, `env/tt-env.sh print failed:\n${res.stderr}`);
  const line = String(res.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("HOME="));
  assert.ok(line, "env script must print HOME=");
  return (line as string).slice("HOME=".length);
}

function manifestRows(): any[] {
  return fs
    .readFileSync(path.join(ttRoot, "cases", "tier2.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// A VERBATIM real dsh row from cases/tier2.jsonl: harness dsh, requires
// capabilities [dsh] — the cell the boot smoke gates.
function gatedDshRow(): any {
  const row = manifestRows().find((r: any) => r.id === GATED_ID);
  assert.ok(row, `${GATED_ID} must exist in tier2.jsonl`);
  return row;
}

// A real dsh row WITHOUT the dsh capability requirement — never smoke-gated
// (nothing requires the predicate) — so the dry-run campaign still records a
// real launch and the zero-real-launch fail-closed guard never fires on the
// gating arms.
function launcherDshRow(): any {
  return {
    id: LAUNCHER_ID,
    wave: 4,
    workflow: "do-now",
    fixture: "tt-ts",
    harness: "dsh",
    task: "cases/tasks/tier2/W4.dsh-do-now.md",
    context: { execution_mode: "real", test_cmd: "npm test" },
    caps: { tokens: 0, wall_min: 5 },
    requires: {},
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2", "W4"],
    chaos: null,
    shed_ok: false,
    mandatory: false,
    class: "verification",
    spec_ref: "08-wave-4-fault-injection.md#W4.37",
    production_duration_floor_ms: 60_000,
  };
}

function writeSynthesizedProfile(dshPresent: boolean): void {
  const profile = {
    platform: { os: "linux", arch: "arm64", release: "0.0.0", label: "linux" },
    containment: { systemdUserScope: true },
    toolchains: {
      node: { present: true, buildPassed: null, testPassed: null, evidence: "synthesized" },
    },
    capabilities: { "node-runtimes-2": true },
    nodeRuntimes: [{ version: "v24.0.0", major: 24, minor: 0, patch: 0, sqliteAvailable: true }],
    harness: {
      pi: { present: true, authenticated: null, skipReason: "synthesized" },
      hermes: { present: true, authenticated: null, skipReason: "synthesized" },
      dsh: { present: dshPresent, authenticated: null, skipReason: dshPresent ? "synthesized" : "synthesized-absent" },
    },
  };
  fs.writeFileSync(hostProfilePath, `${JSON.stringify(profile, null, 2)}\n`);
}

function restoreHonestProfile(): void {
  const res = runTt(verifyEnv, ["--fast", "--json"]);
  assert.equal(res.status, 0, `honest host-profile regeneration failed:\n${res.stderr}`);
}

let scratchCounter = 0;
function writeManifest(records: any[]): string {
  scratchCounter += 1;
  const manifestPath = path.join(varRoot, `MDSH-${Date.now()}-${process.pid}-${scratchCounter}.jsonl`);
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

function campaignIdOf(res: RunResult): string | null {
  const m = CAMPAIGN_LINE.exec(res.stdout);
  return m === null ? null : m[1];
}

// A scratch fake-dsh binary. `exitCode` 0 boots OK; non-zero carries the MDSH
// defect-shaped stderr lines (FAIL_STDERR). When `envLog` is set, the fake
// records its own HOME and PATH (the environment it actually ran under) to
// that file before exiting.
function makeFakeDsh(exitCode: number, envLog?: string): string {
  const dir = fs.mkdtempSync(path.join(varRoot, `mdsh-fakedsh-${process.pid}-`));
  const dshPath = path.join(dir, "dsh");
  const stderrLiteral = FAIL_STDERR.map((l) => `printf '%s\\n' ${JSON.stringify(l)} >&2`).join("\n");
  const envRecord = envLog === undefined
    ? ""
    : `printf 'HOME=%s\\nPATH=%s\\n' "\$HOME" "\$PATH" > ${JSON.stringify(envLog)}\n`;
  fs.writeFileSync(
    dshPath,
    `#!/usr/bin/env bash\n${envRecord}${stderrLiteral}\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return dshPath;
}

// makePathFirst: a scratch bin dir whose fake `dsh` shadows any real dsh on
// PATH (the harness resolver searches PATH in order, so the fake wins). The
// controller strips TAMANDUA_* pins from its spawn env by design
// (operatorEnvironmentWithoutRuntimeRouting), so the PATH-first placement is
// how the smoke resolves the harness under test — exactly how a real dsh would
// be resolved from the contained env.
function fakeDshDir(fakeDsh: string): string {
  const dir = fs.mkdtempSync(path.join(varRoot, `mdsh-path-${process.pid}-`));
  fs.symlinkSync(fakeDsh, path.join(dir, "dsh"));
  return dir;
}

function removeScratch(...paths: string[]): void {
  for (const p of paths) {
    if (p === undefined || p === null || p === "") continue;
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// ── RED-ARM replica (history-independent): the PRE-MDSH roster predicate ──
//
// The pre-change controller evaluated the dsh capability from
// harness.dsh.present alone (observedCapability returned the presence leaf and
// evaluateRequirements never consulted a boot smoke). This frozen replica
// reproduces that logic; the assertion pins that for the SAME evidence that
// now gates the cell (present=true, boot smoke failed, real dsh launch with
// requires capabilities [dsh]) the pre-change predicate returns ZERO failures
// — the cell sailed through the roster ("cells execute and idle INCONCLUSIVE",
// the mac W4.dsh-* defect). The whole-tool arms below prove the post-fix
// controller marks the same cell NOT_RUN.
function preChangeObservedCapability(profile: any, name: string): any {
  if (name === "procfs") return profile.containment?.procfs ?? profile.capabilities?.procfs ?? null;
  if (name === "dsh" || name === "pi" || name === "hermes") {
    const harness = profile.harness?.[name];
    if (harness === null || typeof harness !== "object") return null;
    if (typeof harness.present === "boolean") return harness.present;
    if (typeof harness.authenticated === "boolean") return harness.authenticated;
    return null;
  }
  if (Object.hasOwn(profile.capabilities ?? {}, name)) return profile.capabilities[name];
  return null;
}

function preChangeEvaluateRequirements(requires: any, profile: any): any[] {
  const failures: any[] = [];
  for (const name of requires.capabilities ?? []) {
    const observed = preChangeObservedCapability(profile, name);
    if (observed !== true) failures.push({ predicate: `capabilities.${name}`, expected: true, observed });
  }
  return failures;
}

describe("Tier-2 MDSH dsh functional boot predicate (US-016)", () => {
  after(() => {
    // Restore the honest W0.0 profile so sibling tests see truth (the
    // standard one-file-per-invocation host-profile pattern).
    restoreHonestProfile();
  });

  it("tt-harness-auth-probe --dsh-smoke runs the boot smoke under the contained daemon env (contained HOME + reconstructed PATH: adapters-bin first, operator dirs moved last)", () => {
    const envLog = path.join(varRoot, `mdsh-envlog-${Date.now()}-${process.pid}.txt`);
    const fakeDsh = makeFakeDsh(0, envLog);
    fs.rmSync(envLog, { force: true });
    try {
      const res = runBash(authProbe, ["--dsh-smoke", "dsh"], { TAMANDUA_DSH_BINARY: fakeDsh });
      assert.equal(res.status, 0, `probe --dsh-smoke with a booting fake must exit 0:\n${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /DSH_SMOKE: ok/, "stdout must report DSH_SMOKE: ok");
      assert.match(res.stdout, /DSH_SMOKE_EXIT: 0/, "stdout must report DSH_SMOKE_EXIT: 0");

      // The smoke ran under the daemon env: HOME is the env script's contained
      // home and PATH starts with var/adapters-bin (the S24/US-006 contained
      // reconstruction), with the operator's personal bin dir NOT first.
      assert.ok(fs.existsSync(envLog), `fake dsh did not run (no env log): ${envLog}`);
      const recorded = fs.readFileSync(envLog, "utf8");
      const recordedHome = /^HOME=(.*)$/m.exec(recorded)?.[1] ?? "";
      const recordedPath = /^PATH=(.*)$/m.exec(recorded)?.[1] ?? "";
      assert.equal(recordedHome, envScriptHome(), "smoke must run with the contained daemon HOME");
      const adaptersBin = path.join(ttRoot, "var", "adapters-bin");
      assert.ok(recordedPath.startsWith(`${adaptersBin}:`),
        `smoke PATH must lead with var/adapters-bin (got: ${recordedPath.slice(0, 120)}...)`);
      assert.ok(!recordedPath.startsWith(path.join(os.homedir(), ".local")),
        "operator bin dirs must NOT precede the contained dirs on the smoke PATH");
      assert.ok(recordedPath.includes(path.join(os.homedir(), ".local", "bin")),
        "operator bin dirs must still be present (moved last) on the smoke PATH");
    } finally {
      removeScratch(fakeDsh);
      fs.rmSync(envLog, { force: true });
    }
  });

  it("a failed dsh boot smoke fails closed with the distinct harness-boot-failed reason and the FULL harness stderr in the DSH_SMOKE_STDERR evidence block (never a truncated preview)", () => {
    const fakeDsh = makeFakeDsh(3);
    try {
      const res = runBash(authProbe, ["--dsh-smoke", "dsh"], { TAMANDUA_DSH_BINARY: fakeDsh });
      assert.notEqual(res.status, 0, "a failed boot smoke must exit non-zero");
      assert.match(res.stderr, /REASON: harness-boot-failed: dsh/,
        "the distinct reason must name harness-boot-failed: dsh");
      assert.match(res.stdout, /DSH_SMOKE: fail/, "stdout must report DSH_SMOKE: fail");
      assert.match(res.stdout, /DSH_SMOKE_EXIT: 3/, "stdout must report DSH_SMOKE_EXIT: 3");
      const begin = res.stdout.indexOf("DSH_SMOKE_STDERR_BEGIN");
      const end = res.stdout.indexOf("DSH_SMOKE_STDERR_END");
      assert.ok(begin !== -1 && end !== -1 && end > begin,
        "the DSH_SMOKE_STDERR evidence block must be present");
      const block = res.stdout.slice(begin, end);
      assert.ok(block.includes("plugin tree failed to load"),
        "the smoke stderr must be captured in the evidence block");
      assert.ok(block.includes(LONG_STDERR_TAIL),
        "the FULL stderr must be captured — the tail beyond the product preview truncation point must survive");
    } finally {
      removeScratch(fakeDsh);
    }
  });

  it("--dsh-smoke with a wrong harness selection is a caller error (exit 2, never a silent half-probe)", () => {
    const fakeDsh = makeFakeDsh(0);
    try {
      const res = runBash(authProbe, ["--dsh-smoke", "pi"], { TAMANDUA_PI_BINARY: fakeDsh });
      assert.equal(res.status, 2, "--dsh-smoke requires exactly dsh");
    } finally {
      removeScratch(fakeDsh);
    }
  });

  it("RED-ARM replica: the PRE-MDSH presence-only predicate returns NO gating for a present-but-boot-failing dsh (the 'cells execute' defect shape)", () => {
    const profile = {
      harness: { dsh: { present: true, authenticated: null } },
      capabilities: {},
    };
    const requires = { capabilities: ["dsh"] };
    const failures = preChangeEvaluateRequirements(requires, profile);
    assert.deepEqual(failures, [],
      "pre-change predicate (presence-only) must NOT gate a present-but-boot-failing dsh — the W4.dsh-* cells executed and idled INCONCLUSIVE");
  });

  it("GREEN arm (whole tool): a boot-failing dsh gates the dsh-requiring real cell NOT_RUN(predicate) with the recorded reason + full smoke stderr; an unaffected real dsh cell still dry-run-launches (the campaign never goes vacuous)", () => {
    const fakeDsh = makeFakeDsh(3);
    const fakeDir = fakeDshDir(fakeDsh);
    const manifestPath = writeManifest([gatedDshRow(), launcherDshRow()]);
    const outPath = path.join(varRoot, `mdsh-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    const campaignIds: string[] = [];
    try {
      writeSynthesizedProfile(true);
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath)], {
        PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      removeScratch(fakeDsh, fakeDir);
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0,
      `the gated dry-run campaign must exit 0 (not a vacuous-GREEN infra — a real launch is recorded):\n${res.stdout}${res.stderr}`);
    const state = loadJson(path.join(varRoot, "results", campaignId!, "state.json"));
    campaignIds.push(campaignId!);
    const gated = state.cases.find((c: any) => c.id === GATED_ID);
    assert.ok(gated, `${GATED_ID} missing from campaign state`);
    assert.equal(gated.outcome, "NOT_RUN",
      "a boot-failing dsh must gate the dsh-requiring cell NOT_RUN — never executed into INCONCLUSIVE idling");
    assert.equal(gated.reason?.category, "predicate",
      "the gated cell must carry reason category=predicate");
    const evidence = gated.reason?.evidence ?? [];
    const dshEntry = evidence.find((e: any) => String(e?.predicate) === "capabilities.dsh");
    assert.ok(dshEntry, `evidence must name capabilities.dsh (got ${JSON.stringify(evidence)})`);
    assert.equal(dshEntry.observed, false, "the observed capability must be false");
    const functional = dshEntry.functional;
    assert.ok(functional, "the gated evidence must carry the functional detail");
    assert.equal(functional.check, "dsh-boot-smoke");
    assert.equal(functional.ok, false);
    assert.equal(functional.exit_code, 3);
    assert.ok(typeof functional.stderr === "string" && functional.stderr.includes(LONG_STDERR_TAIL),
      "the recorded reason must carry the FULL smoke stderr (untruncated)");
    // The unaffected real dsh cell (no dsh capability requirement) still
    // dry-run launches: the roster never gated it and a real launch is
    // recorded, so the campaign is a genuine partial (not vacuous).
    const launcher = state.cases.find((c: any) => c.id === LAUNCHER_ID);
    assert.ok(launcher, `${LAUNCHER_ID} missing from campaign state`);
    assert.equal(launcher.outcome, "PASS", "the unaffected real dsh cell must still dry-run-launch (PASS)");
    const expected = state.expected_executable;
    assert.equal(expected?.count, 1, "only the launcher cell is expected-executable");
    assert.deepEqual(expected?.ids, [LAUNCHER_ID]);
    assert.equal(state.spend.tokens_observed, 0, "the dry-run campaign must spend zero tokens");
    // Clean up the campaign dir (before the finally restore) and the argv out.
    removeScratch(path.join(varRoot, "results", campaignId!), outPath);
  });

  it("GREEN arm (whole tool): when the dsh boot smoke PASSES, the dsh-requiring real cell runs exactly as before (dry-run launch recorded, PASS)", () => {
    const fakeDsh = makeFakeDsh(0);
    const fakeDir = fakeDshDir(fakeDsh);
    const manifestPath = writeManifest([gatedDshRow(), launcherDshRow()]);
    const outPath = path.join(varRoot, `mdsh-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      writeSynthesizedProfile(true);
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath)], {
        PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      removeScratch(fakeDsh, fakeDir);
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `the booting-dsh dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);
    const state = loadJson(path.join(varRoot, "results", campaignId!, "state.json"));
    const gated = state.cases.find((c: any) => c.id === GATED_ID);
    assert.ok(gated, `${GATED_ID} missing from campaign state`);
    assert.equal(gated.outcome, "PASS",
      "a booting dsh must NOT be gated — the dsh-requiring cell runs as before (dry-run launch)");
    const attempt = gated.attempts?.[0];
    assert.equal(attempt?.dry_run_launch, true, "the dsh cell must dry-run-launch");
    assert.equal(state.spend.tokens_observed, 0, "the dry-run campaign must spend zero tokens");
    removeScratch(path.join(varRoot, "results", campaignId!), outPath);
  });

  it("an include-real campaign whose EVERY real dsh cell is smoke-gated fails closed INFRA (exit 2, zero-real-launches) — never a vacuous GREEN", () => {
    const fakeDsh = makeFakeDsh(3);
    const fakeDir = fakeDshDir(fakeDsh);
    const manifestPath = writeManifest([gatedDshRow()]);
    const outPath = path.join(varRoot, `mdsh-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      writeSynthesizedProfile(true);
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath)], {
        PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      removeScratch(fakeDsh, fakeDir);
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 2,
      "an include-real campaign with zero real launches must fail closed (INFRA), never a vacuous GREEN");
    const state = loadJson(path.join(varRoot, "results", campaignId!, "state.json"));
    const gated = state.cases.find((c: any) => c.id === GATED_ID);
    assert.equal(gated?.outcome, "NOT_RUN", "the smoke-gated cell is NOT_RUN with its recorded reason");
    assert.equal(gated?.reason?.category, "predicate");
    const report = loadJson(path.join(varRoot, "results", campaignId!, "report.json"));
    assert.equal(report.fail_closed?.triggered, true, "the zero-real-launch guard must trigger");
    removeScratch(path.join(varRoot, "results", campaignId!), outPath);
  });

  it("host profile with dsh ABSENT keeps the presence gate (no smoke needed): dsh-requiring cells NOT_RUN(predicate) naming capabilities.dsh", () => {
    const fakeDsh = makeFakeDsh(0);
    const fakeDir = fakeDshDir(fakeDsh);
    const manifestPath = writeManifest([gatedDshRow(), launcherDshRow()]);
    const outPath = path.join(varRoot, `mdsh-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      writeSynthesizedProfile(false);
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath)], {
        PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      removeScratch(fakeDsh, fakeDir);
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `absent-dsh dry-run campaign must exit 0 (launcher cell records a real launch):\n${res.stdout}${res.stderr}`);
    const state = loadJson(path.join(varRoot, "results", campaignId!, "state.json"));
    const gated = state.cases.find((c: any) => c.id === GATED_ID);
    assert.equal(gated?.outcome, "NOT_RUN");
    assert.equal(gated?.reason?.category, "predicate");
    const evidence = JSON.stringify(gated?.reason?.evidence ?? []);
    assert.ok(evidence.includes("capabilities.dsh"), `evidence must name capabilities.dsh (got ${evidence})`);
    const launcher = state.cases.find((c: any) => c.id === LAUNCHER_ID);
    assert.equal(launcher?.outcome, "PASS", "the launcher cell still dry-run-launches (dsh absent does not block a no-requires real dsh dry-run)");
    assert.equal(state.spend.tokens_observed, 0, "the dry-run campaign must spend zero tokens");
    removeScratch(path.join(varRoot, "results", campaignId!), outPath);
  });
});
