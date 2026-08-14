// Tier-1 integration gate (US-005, S9 controller): REPLAY same-origin
// provisioning + sequencing guard.
//
// E3.D S9: a REPLAY case (`context.replay_of`) must reuse its PAIR's work
// clone — same origin_repo, same committed tree (TSTX's origin-scoped
// contract; a fresh clone/re-provision would normalize to a different origin
// identity and the cross-run cache HIT would be unreachable) — and must never
// launch before its pair is terminal (the pair's post-harvest state — clone,
// ledger — is the replay's input). This suite pins the controller wiring:
//
//   - dry-run launch argv for W1.REPLAY-python/ts points
//     --working-directory-for-harness at the PAIR's clone
//     (var/fixtures/work/W1.L2-<lang>/tt-<fixture>);
//   - a replay attempt performs NO wipe/re-clone/provision of its own (pair
//     clone contents preserved, proven with a sentinel file);
//   - a terminal pair's clone is KEPT at teardown (REPLAY_PAIR_KEEP +
//     keep_reason replay-pair-clone-shared) so the replay's input survives;
//   - a replay whose pair is not terminal does not launch and reports the
//     distinct replay-pair-not-terminal category;
//   - a terminal pair whose shared clone is missing fails closed with
//     replay-pair-clone-missing;
//   - a filtered manifest without the pair fails closed replay-pair-missing;
//   - replay_of is never passed as a product --context flag.
//
// Zero-token: the argv/provenance gate uses TT_DRY_RUN_REAL_LAUNCH (no model
// spawned); the sequencing gates short-circuit before any launch, with a
// throwaway `tamandua` PATH stub as the half-launch tripwire. Files only
// inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const varRoot = path.join(ttRoot, "var");
const goldenDir = path.join(varRoot, "fixtures", "golden");
const workRoot = path.join(varRoot, "fixtures", "work");
const resultsRoot = path.join(varRoot, "results");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Strip the tamandua test-isolation guard vars from a spawn env: the guard
// auto-activates whenever NODE_TEST_CONTEXT is set (node:test sets it in every
// test process), and the controller's contained children (the `bin/tamandua`
// CLI the local-case token-ledger baseline spawns) would trip it — this
// worktree lives under ~/.tamandua/worktrees/, which the guard's state-path
// isolation false-positives on. The controller strips TAMANDUA_* itself but
// passes NODE_TEST_CONTEXT through. Same pattern as tier1-case-filter /
// tt-poly-end-to-end-verification / build-golden tests; the controller's own
// containment layer (assertContainedHome on every spawn) stays fully active.
function cleanSpellEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, HOME: os.homedir() };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  return env;
}

function runTt(script: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: { ...cleanSpellEnv(process.env), ...extraEnv },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadJsonLines(file: string): any[] {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// Ensure a golden bare exists (ensureGoldenBare rebuilds a missing one
// deterministically). Provisioning is exercised by several tests here.
function ensureGolden(fixture: string): void {
  const bare = path.join(goldenDir, `${fixture}.git`);
  if (fs.existsSync(bare)) return;
  const res = spawnSync(process.execPath, [path.join(binDir, "tt-golden-bootstrap.mjs"), "--fixture", fixture], {
    cwd: ttRoot, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(res.status, 0, `golden bootstrap failed:\n${res.stderr}`);
}

function writeManifest(records: any[]): string {
  const name = `US005S9-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return manifestPath;
}

function tier1Record(id: string): any {
  const record = loadJsonLines(path.join(ttRoot, "cases", "tier1.jsonl")).find((c: any) => c.id === id);
  assert.ok(record, `tier1.jsonl must contain ${id}`);
  return JSON.parse(JSON.stringify(record));
}

function normPath(p: string): string {
  return path.normalize(path.resolve(p));
}

function pairClonePath(pairId: string, fixture: string): string {
  return path.join(workRoot, pairId, fixture);
}

// A throwaway `tamandua` PATH stub that records every invocation. Any
// invocation of it during the sequencing gates is a half-launch tripwire.
function installTamanduaTripwire(): { stubBin: string; marker: string; read: () => string[] } {
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us005s9-stub-"));
  const marker = path.join(stubBin, "tamandua-invoked.log");
  const stub = path.join(stubBin, "tamandua");
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "TAMANDUA-LAUNCHED: $*" >> "${marker}"\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  return {
    stubBin,
    marker,
    read: () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split(/\r?\n/).filter((l) => l.length > 0) : []),
  };
}

describe("REPLAY same-origin provisioning + sequencing guard (US-005, S9 controller)", () => {
  it("dry-run REPLAY argv points at the PAIR's clone; pair clone kept; no own provisioning; replay_of never in --context (AC1, AC2, AC4)", () => {
    ensureGolden("tt-python");
    ensureGolden("tt-ts");
    const pairs = [
      { pairId: "W1.L2-python", replayId: "W1.REPLAY-python", fixture: "tt-python" },
      { pairId: "W1.L2-ts", replayId: "W1.REPLAY-ts", fixture: "tt-ts" },
    ];
    const records = pairs.flatMap((p) => [tier1Record(p.pairId), tier1Record(p.replayId)]);
    const manifestPath = writeManifest(records);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us005s9-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    for (const p of pairs) {
      fs.rmSync(pairClonePath(p.pairId, p.fixture), { recursive: true, force: true });
      fs.rmSync(pairClonePath(p.replayId, p.fixture), { recursive: true, force: true });
    }

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);
      assert.equal(res.status, 0, `dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      assert.equal(state.spend.tokens_observed, 0, "dry-run must spend zero tokens");

      const argvLines = loadJsonLines(outPath);
      const argvByCase = new Map(argvLines.map((r: any) => [r.case_id, r]));

      for (const { pairId, replayId, fixture } of pairs) {
        const pairClone = pairClonePath(pairId, fixture);

        // PAIR: PASS, and its clone is KEPT (REPLAY_PAIR_KEEP) so the replay's
        // input survives terminalization.
        const pairState = state.cases.find((c: any) => c.id === pairId);
        assert.equal(pairState.outcome, "PASS", `${pairId}: pair must PASS in dry-run`);
        const pairTeardown = pairState.teardown;
        assert.ok(pairTeardown, `${pairId}: pair must record a teardown decision`);
        assert.equal(pairTeardown.action, "keep", `${pairId}: replay pair clone must be kept, not pruned`);
        assert.equal(pairTeardown.outcome, "REPLAY_PAIR_KEEP");
        assert.equal(pairTeardown.keep_reason, "replay-pair-clone-shared");
        assert.ok(fs.existsSync(pairClone), `${pairId}: kept clone must exist on disk after the campaign`);

        // REPLAY: reuses the pair's clone, skips provisioning, records provenance.
        const replayState = state.cases.find((c: any) => c.id === replayId);
        assert.equal(replayState.outcome, "PASS", `${replayId}: dry-run replay must PASS`);
        const attempt = replayState.attempts.find((a: any) => a.dry_run_launch === true);
        assert.ok(attempt, `${replayId}: dry-run attempt must be recorded`);
        assert.equal(attempt.fixture_work_clone, pairClone,
          `${replayId}: attempt must bind to the pair's clone`);
        assert.deepEqual(attempt.replay_provenance, {
          replay_of: pairId,
          pair_clone_path: pairClone,
          pair_terminal: true,
          pair_terminal_at: pairState.terminal_at,
          pair_outcome: "PASS",
          provision_skipped: true,
        }, `${replayId}: provenance evidence must record pair id, clone path, pair terminal status`);
        assert.equal(attempt.fixture_provision_record, undefined,
          `${replayId}: replay attempt must NOT run its own provisioning (AC2)`);
        assert.equal(replayState.teardown, undefined,
          `${replayId}: the replay must never touch the pair's clone at teardown`);
        assert.ok(!fs.existsSync(pairClonePath(replayId, fixture)),
          `${replayId}: no own work clone may ever be created`);

        // ARGV: --working-directory-for-harness is the PAIR's clone path, and
        // replay_of never appears in the product --context passthrough (AC4).
        const argvRec = argvByCase.get(replayId);
        assert.ok(argvRec, `${replayId}: argv record must exist`);
        const argv: string[] = argvRec.argv;
        assert.ok(!argv.some((arg) => arg.includes("replay_of")),
          `${replayId}: replay_of must never appear in the launch argv (--context exclusion)`);
        const wdIdx = argv.indexOf("--working-directory-for-harness");
        assert.ok(wdIdx >= 0, `${replayId}: argv must carry --working-directory-for-harness`);
        assert.equal(normPath(argv[wdIdx + 1]), normPath(pairClone),
          `${replayId}: argv working directory must be the pair's clone path (AC1)`);
        const contextValues = argv.filter((arg, idx) => idx > 0 && argv[idx - 1] === "--context");
        for (const value of contextValues) {
          assert.ok(!value.includes("replay_of"),
            `${replayId}: no --context value may carry replay_of (got ${value})`);
        }
        assert.equal(argvRec.work_clone.existed, true,
          `${replayId}: pair clone must physically exist at argv capture time`);
        assert.equal(normPath(argvRec.work_clone.path), normPath(pairClone));
      }
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      for (const p of pairs) {
        fs.rmSync(pairClonePath(p.pairId, p.fixture), { recursive: true, force: true });
        fs.rmSync(pairClonePath(p.replayId, p.fixture), { recursive: true, force: true });
      }
    }
  });

  it("a replay attempt leaves the pair's clone byte-preserved: no wipe/re-clone of its own (AC2)", () => {
    ensureGolden("tt-python");
    const sentinel = path.join(varRoot, `us005s9-sentinel-${Date.now()}-${process.pid}.txt`);
    const sentinelText = "pair-post-harvest-sentinel";
    const pairClone = pairClonePath("W1.L2-python", "tt-python");
    fs.rmSync(pairClone, { recursive: true, force: true });
    fs.rmSync(sentinel, { force: true });

    // The pair is a local case whose command provisions its OWN shared clone
    // (exactly where the controller's provisioning stage would put it) and
    // plants a sentinel AFTER provisioning — the pair's post-harvest state.
    // If the replay wiped/re-provisioned the pair's tree, the sentinel would
    // be gone (provisionWorkClone always wipes before re-cloning).
    const pairRecord = {
      id: "W1.L2-python", wave: 0, workflow: "local", fixture: "tt-python", harness: "local",
      task: "cases/tasks/tier1/W1.L2-python.md", context: { execution_mode: "scripted" },
      caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [], forbidden: [],
      oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true, class: "verification",
      command: {
        executable: "node",
        args: [
          "-e",
          [
            "const {spawnSync}=require('node:child_process');",
            "const r=spawnSync(process.execPath,['bin/tt-fixture-provision.mjs','--fixture','tt-python','--case-id','W1.L2-python','--json'],{encoding:'utf8'});",
            "if(r.status!==0){console.error(r.stderr);process.exit(1);}",
            "require('node:fs').writeFileSync(process.argv[1], process.argv[2]);",
          ].join(" "),
          sentinel,
          sentinelText,
        ],
        cwd: ".",
      },
    };
    const replayRecord = tier1Record("W1.REPLAY-python");
    const manifestPath = writeManifest([pairRecord, replayRecord]);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us005s9-noswipe-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);
      assert.equal(res.status, 0, `campaign must exit 0:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const pairState = state.cases.find((c: any) => c.id === "W1.L2-python");
      const replayState = state.cases.find((c: any) => c.id === "W1.REPLAY-python");
      assert.equal(pairState.outcome, "PASS");
      assert.equal(replayState.outcome, "PASS");
      const attempt = replayState.attempts.find((a: any) => a.dry_run_launch === true);
      assert.ok(attempt, "replay dry-run attempt must be recorded");
      assert.equal(attempt.replay_provenance.provision_skipped, true);
      assert.equal(attempt.fixture_provision_record, undefined);

      // AC2: pair clone contents preserved — the sentinel planted during the
      // pair's post-provision state survives the replay attempt byte-for-byte.
      assert.ok(fs.existsSync(sentinel), "pair clone sentinel must survive the replay attempt");
      assert.equal(fs.readFileSync(sentinel, "utf8"), sentinelText,
        "pair clone sentinel content must be byte-identical after the replay (no wipe/re-clone)");

      // The replay's argv record embeds the lstat proof over the SHARED clone.
      const argvRec = loadJsonLines(outPath).find((r: any) => r.case_id === "W1.REPLAY-python");
      assert.ok(argvRec, "replay argv record must exist");
      assert.equal(normPath(argvRec.work_clone.path), normPath(pairClone));
      assert.equal(argvRec.work_clone.existed, true);
      const wdIdx = argvRec.argv.indexOf("--working-directory-for-harness");
      assert.equal(normPath(argvRec.argv[wdIdx + 1]), normPath(pairClone));
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(pairClone, { recursive: true, force: true });
      fs.rmSync(sentinel, { force: true });
    }
  });

  it("a replay whose pair is NOT terminal does not launch and reports replay-pair-not-terminal (AC3)", () => {
    // Pair: a local case that stays active ~4s; replay executes concurrently
    // (concurrency 2, no stagger) and must hit the non-terminal guard.
    const pairRecord = {
      id: "W1.L2-python", wave: 0, workflow: "local", fixture: "tt-python", harness: "local",
      task: "cases/tasks/tier1/W1.L2-python.md", context: { execution_mode: "scripted" },
      caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [], forbidden: [],
      oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true, class: "verification",
      command: { executable: "node", args: ["-e", "setTimeout(()=>{}, 4000)"], cwd: "." },
    };
    const replayRecord = tier1Record("W1.REPLAY-python");
    const manifestPath = writeManifest([pairRecord, replayRecord]);
    const rel = path.relative(ttRoot, manifestPath);
    const tripwire = installTamanduaTripwire();

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel, "--concurrency", "2", "--stagger", "0s"], {
        PATH: `${tripwire.stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
        TT_CONTROLLER_REPLAY_PAIR_WAIT_MS: "0",
      });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const replayState = state.cases.find((c: any) => c.id === "W1.REPLAY-python");
      assert.equal(replayState.outcome, "TEST_INFRA_FAIL",
        "replay with a non-terminal pair must fail closed, never launch");
      assert.equal(replayState.reason?.category, "replay-pair-not-terminal",
        "the distinct replay-pair-not-terminal category must be reported (AC3)");
      const attempt = replayState.attempts.at(-1);
      assert.ok(attempt, "the fail-closed guard must record an attempt");
      assert.equal(attempt.classification_reason?.category ?? attempt.reason?.category,
        "replay-pair-not-terminal");
      assert.equal(attempt.reason?.pair_phase ?? attempt.classification_reason?.pair_phase, "running",
        "the evidence must record the pair's non-terminal phase");
      assert.equal(attempt.launch, undefined, "the replay must never reach the launch stage");

      // Half-launch tripwire: tamandua was never invoked for the replay (the
      // local pair never invokes it either).
      assert.equal(tripwire.read().length, 0, "no tamandua launch may occur for a non-terminal pair");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(tripwire.stubBin, { recursive: true, force: true });
    }
  });

  it("a terminal pair whose shared clone is missing fails closed with replay-pair-clone-missing", () => {
    // Same shapes, but concurrency 1: the pair completes FIRST (terminal), and
    // its clone was never provisioned (a local pair provisions no clone) — the
    // replay must fail closed on the missing shared clone, never launch.
    const pairRecord = {
      id: "W1.L2-python", wave: 0, workflow: "local", fixture: "tt-python", harness: "local",
      task: "cases/tasks/tier1/W1.L2-python.md", context: { execution_mode: "scripted" },
      caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [], forbidden: [],
      oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true, class: "verification",
      command: { executable: "node", args: ["-e", "setTimeout(()=>{}, 500)"], cwd: "." },
    };
    const replayRecord = tier1Record("W1.REPLAY-python");
    const manifestPath = writeManifest([pairRecord, replayRecord]);
    const rel = path.relative(ttRoot, manifestPath);
    const tripwire = installTamanduaTripwire();

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel, "--stagger", "0s"], {
        PATH: `${tripwire.stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
        TT_CONTROLLER_REPLAY_PAIR_WAIT_MS: "0",
      });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const replayState = state.cases.find((c: any) => c.id === "W1.REPLAY-python");
      assert.equal(replayState.outcome, "TEST_INFRA_FAIL");
      assert.equal(replayState.reason?.category, "replay-pair-clone-missing",
        "a terminal pair without its shared clone must fail closed with replay-pair-clone-missing");
      const attempt = replayState.attempts.at(-1);
      assert.equal(attempt.classification_reason?.category ?? attempt.reason?.category,
        "replay-pair-clone-missing");
      assert.equal(attempt.launch, undefined, "the replay must never reach the launch stage");
      assert.equal(tripwire.read().length, 0, "no tamandua launch may occur without the shared clone");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(tripwire.stubBin, { recursive: true, force: true });
    }
  });

  it("a filtered manifest without the pair fails closed with replay-pair-missing (never a half-launch)", () => {
    const replayRecord = tier1Record("W1.REPLAY-python");
    const manifestPath = writeManifest([replayRecord]);
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us005s9-filtered-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });

    let campaignId: string | null = null;
    try {
      const res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `no campaign created:\n${res.stdout}${res.stderr}`);

      const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
      const replayState = state.cases.find((c: any) => c.id === "W1.REPLAY-python");
      assert.equal(replayState.outcome, "TEST_INFRA_FAIL");
      assert.equal(replayState.reason?.category, "replay-pair-missing",
        "a replay without its pair in campaign state must fail closed with replay-pair-missing");
      const attempt = replayState.attempts.at(-1);
      assert.equal(attempt.classification_reason?.category ?? attempt.reason?.category,
        "replay-pair-missing");
      assert.equal(attempt.dry_run_launch, undefined,
        "the dry-run launch must not be reached without a pair");
      assert.equal(attempt.launch, undefined, "the replay must never reach the launch stage");
      assert.ok(!fs.existsSync(outPath),
        "no argv may be recorded without a pair (the guard fails closed before the dry-run capture)");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(outPath, { force: true });
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  });
});
