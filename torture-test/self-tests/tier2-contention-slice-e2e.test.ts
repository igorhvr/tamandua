// Tier-2 STORM-I US-004: operator recipe + hermetic end-to-end acceptance
// (STORM-I US-003). The real tt-contention-slice prepare → sample → summarize
// chain exercised end-to-end on toy fixtures under torture-test/var, plus the
// help/argument-contract checks and the operator-recipe doc gate.
//
// Gates (all hermetic; no daemons, no fixed ports, no real models, no real
// campaign; the ONLY child spawned anywhere is the real tt-controller
// --validate-only that `prepare` itself runs):
//  1. no-argument invocation and --help/-h exit 0 with usage and NO
//     filesystem/daemon/model side effects under var; unknown subcommands and
//     unknown subcommand options exit non-zero;
//  2. the operator-recipe document exists under torture-test/impl-tasks/ and
//     documents the required safe sequence (pinned build/catalog + functional
//     harness verification, host exclusivity, prepare, the recorded controller
//     argv --concurrency 4 --stagger 10s, the read-only observer, report/log
//     retention, controller-owns-lifecycle, tokens vs no-tokens, W5 pending);
//  3. NOMINAL END-TO-END CHAIN: real `prepare` (reads the CURRENT catalogs,
//     writes a fresh unique var dir, passes the real controller
//     --validate-only) → real `sample --once` against a toy contained campaign
//     state + toy DB (3 overlapping claimed runs + one NOT_RUN case) → real
//     `summarize`; asserts the recorded provenance/argv, the observed
//     aggregates and honest summary (configured concurrency 4 reported
//     SEPARATELY from the observed claimed-step peak 3; executed 3 of 4,
//     1 NOT_RUN), and ZERO side effects: sha256 of the toy DB/state/prep
//     files unchanged across sample AND summarize, campaign dir listing
//     unchanged, no -wal/-shm sidecars, samples/observer never rewritten, a
//     spawn-sentinel harness binary is never executed (no model spawn) and no
//     port/pid/socket files appear anywhere (no listener binding);
//  4. HONESTY END-TO-END: on a toy campaign that is ALREADY terminal when the
//     observer starts, the real chain reports the observed peak 0 and prints
//     "NO UNQUALIFIED PASSED-STORM CLAIM" — an observer started after
//     completion cannot manufacture simultaneity proof.
//
// Everything writes only under torture-test/var (git-ignored) in fresh temp
// fixtures owned by this file (atomically allocated with fs.mkdtempSync). The
// isolation guard is PRESERVED.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const cli = path.join(ttRoot, "bin", "tt-contention-slice");
const controller = path.join(ttRoot, "bin", "tt-controller");
const recipeDoc = path.join(ttRoot, "impl-tasks", "STORM-I-contention-slice-operator-recipe.md");

const SELECTED_IDS = [
  "W3.03-bfmw-hermes-ts",
  "W4.06-colleague-rebase",
  "W4.09-pi-kill-harness",
  "W4.dsh-bfmw",
];
const CASE_A = SELECTED_IDS[0];
const CASE_B = SELECTED_IDS[1];
const CASE_C = SELECTED_IDS[2];
const CASE_D = SELECTED_IDS[3];

const R1 = "run-11111111-1111-4111-8111-111111111111";
const R2 = "run-22222222-2222-4222-8222-222222222222";
const R3 = "run-33333333-3333-4333-8333-333333333333";
const R4 = "run-44444444-4444-4444-8444-444444444444";
const R1_BARE = "11111111-1111-4111-8111-111111111111";
const R2_BARE = "22222222-2222-4222-8222-222222222222";
const R3_BARE = "33333333-3333-4333-8333-333333333333";
const R4_BARE = "44444444-4444-4444-8444-444444444444";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Guard propagation preserved: spawn env is the caller env (which may carry
// TAMANDUA_TEST_GUARD / NODE_TEST_CONTEXT) plus harmless harness pins. A
// spawn-sentinel harness binary is used below so any attempted model/harness
// spawn writes a marker file instead of launching anything real.
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    TAMANDUA_PI_BINARY: "/bin/false",
    TAMANDUA_HERMES_BINARY: "/bin/false",
    TAMANDUA_DSH_BINARY: "/bin/false",
  };
  return { ...env, ...extra };
}

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function runGit(args: string[]): string {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${String(res.stderr ?? "")}`);
  return String(res.stdout ?? "").trim();
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(abs: string): string {
  return sha256(fs.readFileSync(abs));
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hashSet(files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) out[file] = fs.existsSync(file) ? sha256File(file) : "<absent>";
  return out;
}

function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

// Atomically allocated fresh owned fixture root under torture-test/var
// (fs.mkdtempSync — exclusive, owned; a failed allocation is never cleaned).
function scratchDir(label: string): string {
  return fs.mkdtempSync(path.join(varRoot, `tier2-contention-e2e-${label}-`));
}

fs.mkdirSync(varRoot, { recursive: true });

// A run row for the toy contained DB: { id (bare <uuid>), status, steps }.
interface ToyRun {
  id: string;
  status: string;
  steps?: Array<{ id: string; status: string }>;
}

// A toy campaign case (controller state.json shape): id/phase/outcome plus
// attempts [{ id, phase, outcome?, run_id }].
interface ToyAttempt {
  id: string;
  phase: string;
  outcome?: any;
  run_id?: string;
}
interface ToyCase {
  id: string;
  phase: string;
  outcome?: any;
  attempts: ToyAttempt[];
}

function buildToyDb(dbPath: string, runs: ToyRun[]): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
    tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE steps (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    step_index INTEGER NOT NULL, input_template TEXT NOT NULL, expects TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4,
    type TEXT NOT NULL DEFAULT 'single', current_story_id TEXT, abandoned_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const now = new Date().toISOString();
  const insRun = db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 't', ?, 0, ?, ?)",
  );
  const insStep = db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, 'agent', 0, 'in', '{}', ?, ?, ?)",
  );
  for (const run of runs) {
    insRun.run(run.id, run.status, now, now);
    for (const step of run.steps ?? []) {
      insStep.run(step.id, run.id, `step-${step.id}`, step.status, now, now);
    }
  }
  db.close();
}

// Build a toy campaign directory (state.json) + contained toy DB under a
// fresh fixture root (both strictly inside torture-test/var).
function buildToyCampaign(root: string, opts: {
  cases: ToyCase[];
  dbRuns?: ToyRun[];
}): { campaign: string; db: string } {
  const campaign = path.join(root, "campaign");
  fs.mkdirSync(campaign, { recursive: true });
  const state = {
    version: 1,
    campaign_id: `campaign-e2e-${path.basename(root)}`,
    phase: "running",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    manifest: { case_ids: [...SELECTED_IDS] },
    cases: opts.cases,
  };
  fs.writeFileSync(path.join(campaign, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  const db = path.join(campaign, "tamandua.db");
  buildToyDb(db, opts.dbRuns ?? []);
  return { campaign, db };
}

// Recursive relative-path inventory of a directory (sorted). Used to prove a
// directory gains no files (no DB sidecars, no daemon/port/pid/socket files).
function inventory(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const entry of fs.readdirSync(current).sort()) {
      const abs = path.join(current, entry);
      const childRel = rel === "" ? entry : `${rel}/${entry}`;
      const details = fs.lstatSync(abs);
      if (details.isDirectory() && !details.isSymbolicLink()) walk(abs, childRel);
      else out.push(childRel);
    }
  };
  walk(dir, "");
  return out;
}

function runningCase(id: string, runId: string): ToyCase {
  return {
    id,
    phase: "running",
    attempts: [{ id: "attempt-1", phase: "running", run_id: runId }],
  };
}

function terminalCase(id: string, outcome: string, runId: string): ToyCase {
  return {
    id,
    phase: "terminal",
    outcome,
    attempts: [{ id: "attempt-1", phase: "terminal", outcome, run_id: runId }],
  };
}

function notRunCase(id: string): ToyCase {
  return { id, phase: "terminal", outcome: "NOT_RUN", attempts: [] };
}

describe("tier-2 STORM-I US-004 — operator recipe + hermetic e2e acceptance", () => {
  it("no-argument invocation and --help/-h exit 0 with usage and NO filesystem side effects; unknown subcommand/option exits non-zero", () => {
    const baseline = fs.readdirSync(varRoot).sort();
    for (const args of [[], ["--help"], ["-h"]]) {
      const res = runCli(args);
      assert.equal(res.status, 0, `args ${JSON.stringify(args)} must exit 0`);
      assert.match(res.stdout, /Usage: tt-contention-slice <command> \[options\]/,
        `args ${JSON.stringify(args)} must print usage`);
      for (const word of ["prepare", "sample", "summarize"]) {
        assert.ok(res.stdout.includes(word), `usage must name the ${word} subcommand`);
      }
    }
    const after = fs.readdirSync(varRoot).sort();
    assert.deepEqual(after, baseline,
      "help/no-argument invocations must have no filesystem side effects under var");

    // Unknown subcommand and unknown subcommand options exit non-zero.
    const unknown = runCli(["frobnicate"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown command: frobnicate/);
    for (const args of [["prepare", "--bogus"], ["sample", "--bogus"], ["summarize", "--bogus"]]) {
      const res = runCli(args);
      assert.notEqual(res.status, 0, `${args.join(" ")} must exit non-zero`);
      assert.match(res.stderr, /unknown (prepare|sample|summarize) option: --bogus/);
    }
    // A no-argument / help request must never reach a model or a daemon: the
    // spawn-sentinel below is only armed for the chain tests, but the CLI code
    // path for usage/help performs no spawns and no writes by construction.
  });

  it("the operator-recipe document exists under torture-test/ and documents the required safe sequence", () => {
    assert.ok(fs.existsSync(recipeDoc), `operator recipe must exist: ${recipeDoc}`);
    const text = fs.readFileSync(recipeDoc, "utf8");
    // The required safe sequence elements (STORM-I US-003).
    assert.match(text, /pinned build\/catalog and functional harnesses/);
    assert.ok(text.includes("tt-verify-environment"), "recipe must reference host/harness verification");
    assert.ok(text.includes("torture-test/bin/tt-contention-slice prepare"), "recipe must document prepare");
    assert.ok(text.includes("--manifest"), "recipe must show the controller launch with --manifest");
    assert.ok(text.includes("--concurrency 4"), "recipe must show the recorded --concurrency 4");
    assert.ok(text.includes("--stagger 10s"), "recipe must show the recorded --stagger 10s");
    assert.ok(text.includes("tt-controller"), "recipe must launch the EXISTING controller");
    assert.match(text, /read-only|read-only observer/i);
    assert.ok(text.includes("tt-contention-slice sample"), "recipe must document the observer attach step");
    assert.ok(text.includes("tt-contention-slice summarize"), "recipe must document the summary step");
    assert.match(text, /owns its ordinary\s+case\s+lifecycle/i,
      "recipe must state the controller owns the case lifecycle");
    assert.match(text, /spends tokens/);
    assert.match(text, /NOT_RUN/);
    assert.ok(/W5|two-round/.test(text), "recipe must state the full W5 / two-round campaign remains pending");
  });

  it("NOMINAL chain: real prepare -> real sample --once -> real summarize on toy fixtures, honest summary, zero side effects", () => {
    const root = scratchDir("chain");
    const markerPath = path.join(root, "spawn-marker.txt");
    const sentinel = path.join(root, "spawn-sentinel.js");
    fs.writeFileSync(
      sentinel,
      "#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.TT_SPAWN_MARKER, process.argv.slice(1).join(' ') + '\\n');\nprocess.exit(99);\n",
    );
    fs.chmodSync(sentinel, 0o755);
    const sentinelEnv = {
      TAMANDUA_PI_BINARY: sentinel,
      TAMANDUA_HERMES_BINARY: sentinel,
      TAMANDUA_DSH_BINARY: sentinel,
      TT_SPAWN_MARKER: markerPath,
    };

    // The preparation directory is auto-allocated by `prepare` under var
    // (parsed from its stdout); it is owned by this test and removed in the
    // finally block below alongside the atomically-allocated fixture root.
    let prepDir = "";

    try {
      // ── Step 1: real prepare (reads the CURRENT catalogs; auto-allocates a
      // fresh unique var dir; hands the manifest to the real controller
      // --validate-only). ──
      const prep = runCli(["prepare"], sentinelEnv);
      assert.equal(prep.status, 0, `prepare must exit 0:\n${prep.stdout}${prep.stderr}`);
      const manifestPath = /^Prepared manifest: (.+)$/m.exec(prep.stdout)?.[1];
      assert.ok(manifestPath, "prepare stdout must name the generated manifest");
      prepDir = path.dirname(manifestPath);
      assert.ok(prepDir.startsWith(`${varRoot}${path.sep}`), "the preparation dir must live under var");
      assert.match(prep.stdout, /Controller launch argv/);
      assert.ok(prep.stdout.includes("--concurrency 4") && prep.stdout.includes("--stagger 10s"),
        "the recorded argv must be printed legibly");
      const prov = loadJson(path.join(prepDir, "provenance.json"));
      assert.deepEqual(prov.selection.map((s: any) => s.id), SELECTED_IDS,
        "provenance must record the canonical selection in order");
      assert.equal(prov.controller.executable, controller);
      assert.equal(prov.controller.concurrency, 4);
      assert.equal(prov.controller.stagger, "10s");
      assert.ok(prov.controller.argv.includes("--concurrency") && prov.controller.argv.includes("4"));
      assert.ok(prov.controller.argv.includes("--stagger") && prov.controller.argv.includes("10s"));
      assert.equal(prov.validation.ok, true, "the manifest must pass the real controller --validate-only");
      assert.equal(prov.source.commit, runGit(["rev-parse", "HEAD"]));
      const porcelain = runGit(["status", "--porcelain"]);
      assert.equal(prov.source.pinned_clean_candidate, porcelain === "",
        "pinned_clean_candidate must reflect the actual tracked-tree state");

      // ── Toy campaign: three overlapping claimed runs + one NOT_RUN case. ──
      const toy = buildToyCampaign(root, {
        cases: [
          runningCase(CASE_A, R1),
          runningCase(CASE_B, R2),
          notRunCase(CASE_C),
          runningCase(CASE_D, R3),
        ],
        dbRuns: [
          { id: R1_BARE, status: "running", steps: [{ id: "s1", status: "claimed" }] },
          { id: R2_BARE, status: "running", steps: [{ id: "s2", status: "running" }] },
          { id: R3_BARE, status: "running", steps: [{ id: "s3", status: "claimed" }] },
        ],
      });
      const campaignFiles = [toy.db, path.join(toy.campaign, "state.json")];
      const prepFiles = [manifestPath, path.join(prepDir, "provenance.json")];
      const beforeCampaign = hashSet(campaignFiles);
      const beforePrep = hashSet(prepFiles);
      const campaignListing = inventory(toy.campaign);

      // ── Step 2: real sample --once (strictly read-only). ──
      const obs = path.join(root, "obs");
      const sample = runCli([
        "sample", "--prep", prepDir, "--campaign", toy.campaign, "--db", toy.db,
        "--out", obs, "--once",
      ], sentinelEnv);
      assert.equal(sample.status, 0, `sample must exit 0:\n${sample.stdout}${sample.stderr}`);
      const samplesPath = path.join(obs, "samples.jsonl");
      const observerPath = path.join(obs, "observer.json");
      const sampleLinesText = fs.readFileSync(samplesPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(sampleLinesText.length, 1, "single-sample mode records exactly one sample");
      const rec = JSON.parse(sampleLinesText[0]);
      assert.deepEqual(rec.selected_case_ids, SELECTED_IDS);
      assert.equal(rec.db.opened, true);
      assert.equal(rec.db.snapshot, "transaction", "reads should use one read-only snapshot");
      const agg = rec.aggregates;
      assert.equal(agg.case_records_found, 4);
      assert.equal(agg.claimed_run_count, 3, "three scoped runs carry claimed/running steps");
      assert.equal(agg.claimed_step_count, 3);
      assert.equal(agg.active_cases, 3, "three running cases are active");
      assert.equal(agg.terminal_cases, 1, "the NOT_RUN case is terminal");
      assert.equal(agg.unknown_run_ids.length, 0);
      assert.equal(agg.observation_errors.length, 0);
      assert.equal(rec.all_selected_cases_terminal, false);
      const observer = loadJson(observerPath);
      assert.equal(observer.sample_count, 1);
      assert.equal(observer.stop_reason, "single-sample");

      // No mutation by sample: DB/state/prep bytes unchanged, campaign dir
      // gains no files, no -wal/-shm sidecars, no sentinel spawn.
      assert.deepEqual(hashSet(campaignFiles), beforeCampaign, "sample must not mutate the toy DB/state");
      assert.deepEqual(hashSet(prepFiles), beforePrep, "sample must not mutate the preparation");
      assert.deepEqual(inventory(toy.campaign), campaignListing, "the campaign dir must gain no files");
      assert.ok(!fs.existsSync(`${toy.db}-wal`) && !fs.existsSync(`${toy.db}-shm`),
        "a read-only open must not create WAL/SHM sidecars");
      assert.ok(!fs.existsSync(markerPath), "sample must never spawn a model/harness (sentinel marker absent)");

      // ── Step 3: real summarize (writes only INTO the observation dir). ──
      const samplesBefore = hashSet([samplesPath, observerPath]);
      const summary = runCli(["summarize", "--prep", prepDir, "--obs", obs], sentinelEnv);
      assert.equal(summary.status, 0, `summarize must exit 0:\n${summary.stdout}${summary.stderr}`);
      const summaryJsonPath = path.join(obs, "summary.json");
      const summaryTxtPath = path.join(obs, "summary.txt");
      assert.ok(fs.existsSync(summaryJsonPath), "summary.json must be written into the observation dir");
      assert.ok(fs.existsSync(summaryTxtPath), "summary.txt must be written into the observation dir");
      const report = loadJson(summaryJsonPath);
      assert.equal(report.subcommand, "summarize");
      // Configured (recorded controller argv) SEPARATE from observed peak.
      assert.equal(report.configured.concurrency, 4, "configured concurrency comes from the recorded argv");
      assert.equal(report.configured.stagger, "10s");
      assert.match(report.configured.source, /recorded controller argv/);
      assert.ok(report.configured.argv.includes("--concurrency") && report.configured.argv.includes("4"));
      assert.equal(report.observed.valid_sample_count, 1);
      assert.equal(report.observed.claimed_step_peak, 3, "observed peak = 3 scoped claimed steps");
      assert.equal(report.observed.claimed_run_peak, 3);
      assert.equal(report.observed.overlapped_active_work, true);
      assert.equal(report.observed.late_observer_start, false);
      assert.equal(report.counts.executed_cases, 3, "three cases executed");
      assert.equal(report.counts.not_run_cases, 1, "one case NOT_RUN — never counted executed");
      assert.equal(report.counts.terminal_cases, 1);
      assert.equal(report.per_case[CASE_C].not_run, true);
      assert.equal(report.per_case[CASE_C].executed, false);
      assert.equal(report.honesty.storm_claim_supported, true);
      assert.match(report.honesty.verdict, /OBSERVED CONTENTION SUPPORTED/);
      assert.match(report.honesty.verdict, /only 3 of 4 selected cases executed \(1 NOT_RUN/);
      assert.equal(report.evidence.clean, true);
      assert.equal(report.evidence.prep_binding_mismatches.length, 0);
      const reportText = fs.readFileSync(summaryTxtPath, "utf8");
      assert.match(reportText, /case concurrency: 4/);
      assert.match(reportText, /Honesty verdict: OBSERVED CONTENTION SUPPORTED/);
      assert.ok(summary.stdout.includes(reportText.trim().split("\n")[0]),
        "the summarize stdout must carry the report");

      // Zero side effects across the whole chain.
      assert.deepEqual(hashSet(campaignFiles), beforeCampaign, "summarize must not mutate the toy DB/state");
      assert.deepEqual(hashSet(prepFiles), beforePrep, "summarize must not mutate the preparation");
      assert.deepEqual(hashSet([samplesPath, observerPath]), samplesBefore,
        "summarize must never rewrite the samples/observer evidence");
      assert.deepEqual(inventory(toy.campaign), campaignListing,
        "the campaign dir must still gain no files after summarize");
      assert.ok(!fs.existsSync(`${toy.db}-wal`) && !fs.existsSync(`${toy.db}-shm`));
      const obsFiles = inventory(obs);
      assert.deepEqual(obsFiles.sort(), ["observer.json", "samples.jsonl", "summary.json", "summary.txt"].sort(),
        "the observation dir must contain exactly the observer evidence plus the summary");
      assert.ok(!fs.existsSync(markerPath),
        "no model/harness was ever spawned anywhere in the chain (sentinel marker absent)");
      // No listener binding / daemon artifacts: nothing outside the declared
      // outputs, and no pid/port/socket/lock files anywhere in the fixture.
      const rootFiles = inventory(root);
      assert.ok(!rootFiles.some((name) => /\.(pid|sock|lock)$/.test(name) || name.includes("port")),
        "no pid/port/socket/lock files may appear anywhere (no listener binding)");
    } finally {
      if (prepDir !== "") rmrf(prepDir);
      rmrf(root);
    }
  });

  it("HONESTY chain: an observer started after the campaign is already terminal cannot manufacture simultaneity proof", () => {
    const root = scratchDir("honest");
    const markerPath = path.join(root, "spawn-marker.txt");
    const sentinel = path.join(root, "spawn-sentinel.js");
    fs.writeFileSync(
      sentinel,
      "#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.TT_SPAWN_MARKER, process.argv.slice(1).join(' ') + '\\n');\nprocess.exit(99);\n",
    );
    fs.chmodSync(sentinel, 0o755);
    const sentinelEnv = {
      TAMANDUA_PI_BINARY: sentinel,
      TAMANDUA_HERMES_BINARY: sentinel,
      TAMANDUA_DSH_BINARY: sentinel,
      TT_SPAWN_MARKER: markerPath,
    };

    let prepDir = "";

    try {
      const prep = runCli(["prepare"], sentinelEnv);
      assert.equal(prep.status, 0, `prepare must exit 0:\n${prep.stdout}${prep.stderr}`);
      const manifestPath = /^Prepared manifest: (.+)$/m.exec(prep.stdout)?.[1];
      assert.ok(manifestPath, "prepare stdout must name the generated manifest");
      prepDir = path.dirname(manifestPath);

      // The campaign is ALREADY terminal (4 terminal cases, one NOT_RUN) with
      // no claimed steps anywhere: nothing active remains to observe.
      const toy = buildToyCampaign(root, {
        cases: [
          terminalCase(CASE_A, "PASS", R1),
          terminalCase(CASE_B, "PASS", R2),
          notRunCase(CASE_C),
          terminalCase(CASE_D, "PASS", R3),
        ],
        dbRuns: [
          { id: R1_BARE, status: "completed" },
          { id: R2_BARE, status: "completed" },
          { id: R3_BARE, status: "failed" },
        ],
      });
      const campaignFiles = [toy.db, path.join(toy.campaign, "state.json")];
      const beforeCampaign = hashSet(campaignFiles);
      const campaignListing = inventory(toy.campaign);

      const obs = path.join(root, "obs");
      const sample = runCli([
        "sample", "--prep", prepDir, "--campaign", toy.campaign, "--db", toy.db,
        "--out", obs, "--once",
      ], sentinelEnv);
      assert.equal(sample.status, 0, `sample must exit 0:\n${sample.stdout}${sample.stderr}`);
      const rec = JSON.parse(fs.readFileSync(path.join(obs, "samples.jsonl"), "utf8").trim().split("\n")[0]);
      assert.equal(rec.all_selected_cases_terminal, true);
      assert.equal(rec.aggregates.terminal_cases, 4);
      assert.equal(rec.aggregates.claimed_step_count, 0);
      const observer = loadJson(path.join(obs, "observer.json"));
      assert.equal(observer.first_sample_all_terminal, true,
        "the observer must record that it started after the campaign was terminal");

      const summary = runCli(["summarize", "--prep", prepDir, "--obs", obs], sentinelEnv);
      assert.equal(summary.status, 0, `summarize must exit 0:\n${summary.stdout}${summary.stderr}`);
      const report = loadJson(path.join(obs, "summary.json"));
      assert.equal(report.observed.claimed_step_peak, 0);
      assert.equal(report.observed.late_observer_start, true);
      assert.equal(report.honesty.storm_claim_supported, false,
        "a late observer must never manufacture simultaneity proof");
      assert.match(report.honesty.verdict, /NO UNQUALIFIED PASSED-STORM CLAIM/);
      assert.match(report.honesty.verdict, /below 3/);
      assert.match(report.honesty.verdict, /did not overlap any active campaign work/);
      assert.match(report.honesty.verdict, /observer started after the campaign was already terminal/);
      assert.ok(!report.honesty.verdict.includes("OBSERVED CONTENTION SUPPORTED"),
        "no supported verdict may be printed for a late observer");
      const reportText = fs.readFileSync(path.join(obs, "summary.txt"), "utf8");
      assert.match(reportText, /Honesty verdict: NO UNQUALIFIED PASSED-STORM CLAIM/);
      assert.equal(report.counts.executed_cases, 3, "the NOT_RUN case is never counted executed");
      assert.equal(report.counts.not_run_cases, 1);

      // Still zero side effects and no model spawn.
      assert.deepEqual(hashSet(campaignFiles), beforeCampaign, "the toy DB/state must be untouched");
      assert.deepEqual(inventory(toy.campaign), campaignListing, "the campaign dir must gain no files");
      assert.ok(!fs.existsSync(markerPath), "no model/harness was ever spawned (sentinel marker absent)");
    } finally {
      if (prepDir !== "") rmrf(prepDir);
      rmrf(root);
    }
  });
});
