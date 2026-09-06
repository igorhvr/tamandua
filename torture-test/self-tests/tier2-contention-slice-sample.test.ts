// Tier-2 STORM-I US-002: tt-contention-slice `sample` — strictly read-only
// simultaneity observer.
//
// Gates (all hermetic; no daemons, no fixed ports, no real models; toy
// campaign state + toy contained DB fixtures under torture-test/var):
//  1. single-sample mode (--once) writes exactly one timestamped sample +
//     an observer record into a fresh observation directory, touches nothing
//     in the campaign/prep fixtures, and exits 0;
//  2. overlapping active states: two scoped runs with claimed/running steps
//     yield claimed_run_count 2 / claimed_step_count 3 / active_cases 2;
//  3. serial active state: only one scoped run has claimed/running steps at
//     the sample instant;
//  4. a DECOY run in the DB (not referenced by any selected attempt) is never
//     queried or counted — even when it has claimed steps;
//  5. replacement-attempt mapping: a case whose attempt-1 run is terminal and
//     attempt-2 (replacement) run is active maps BOTH recorded run ids;
//  6. missing/corrupt/escaped evidence: missing state.json, corrupt
//     state.json, a missing DB file, and a corrupt DB file are all recorded
//     as UNKNOWN evidence (never zero active work), with samples preserved;
//     path escapes (outside var, traversal, symlink) are refused BEFORE
//     anything is opened or written;
//  7. no mutation: sha256 of the input DB, state.json, manifest and
//     provenance are identical before/after; the campaign directory gains no
//     files (no -wal/-shm sidecars), and a missing DB is never created;
//  8. interval/window loop: with a fast --interval-ms and a bounded
//     --window-ms the observer records multiple samples and stops with
//     window-expired; an all-terminal campaign stops after the first sample
//     with all-cases-terminal and never sleeps;
//  9. identification-failure arms: an ACTIVE attempt whose run id could not be
//     identified — run_id_error recorded, an invalid run id, or an id not yet
//     acquired — is UNKNOWN coverage (unknown_cases + observation error), never
//     a clean zero; genuinely not-started pending cases and terminal NOT_RUN
//     stay clean; a decoy DB run is never scoped;
// 10. pure timer contract (sampleDelayMs): a bounded window caps the sleep at
//     the window boundary (a 1s window never sleeps a 15s interval), with an
//     end-to-end windowed run proving no overshoot through the interval;
// 11. fixture roots are atomically allocated owned directories under
//     torture-test/var (fs.mkdtempSync), never PID/time-derived mkdir, and a
//     failed allocation is never cleaned.
//
// Everything writes only under torture-test/var (git-ignored) in fresh temp
// fixtures owned by this file. The isolation guard is PRESERVED.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { sampleDelayMs } from "../bin/tt-contention-slice-shared.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const cli = path.join(ttRoot, "bin", "tt-contention-slice");

const SELECTED_IDS = [
  "W3.03-bfmw-hermes-ts",
  "W4.06-colleague-rebase",
  "W4.09-pi-kill-harness",
  "W4.dsh-bfmw",
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

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
    timeout: 120_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sha256File(abs: string): string {
  return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sampleLines(samplesPath: string): any[] {
  return fs.readFileSync(samplesPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Atomically allocated fresh owned fixture root under torture-test/var.
// fs.mkdtempSync creates the directory EXCLUSIVELY (never a PID/time-derived
// mkdir that could collide or silently reuse a stale sibling), so every root
// returned here is verifiably owned by this process and safe to remove in a
// finally block. If allocation fails, mkdtempSync throws BEFORE any root is
// returned, so an unallocated root is never cleaned.
function scratchDir(label: string): string {
  return fs.mkdtempSync(path.join(varRoot, `tier2-contention-sample-${label}-`));
}

function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

fs.mkdirSync(varRoot, { recursive: true });

// ── Toy fixture builders ───────────────────────────────────────────

// A run row: { id (run-<uuid> or <uuid>), status } plus optional steps:
// [{ id, status }] (statuses 'claimed'/'running'/'done'/...).
interface ToyRun {
  id: string;
  status: string;
  steps?: Array<{ id: string; status: string }>;
}

// A toy case: { id, phase, attempts: [{ attempt_id, phase, run_id?, run_id_error? }] }.
interface ToyAttempt {
  attempt_id: string;
  phase: string;
  outcome?: any;
  run_id?: string;
  run_id_error?: any;
}
interface ToyCase {
  id: string;
  phase: string;
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

function buildToyCampaign(fixtureRoot: string, opts: {
  cases: ToyCase[];
  dbRuns?: ToyRun[];
  writeDb?: boolean;
  stateText?: string | null; // explicit raw state.json text (null = default JSON)
}): { prep: string; campaign: string; db: string } {
  const prep = path.join(fixtureRoot, "prep");
  const campaign = path.join(fixtureRoot, "campaign");
  fs.mkdirSync(prep, { recursive: true });
  fs.mkdirSync(campaign, { recursive: true });
  // Prepared manifest/provenance (US-001 output shape).
  const manifest = SELECTED_IDS.map((id, index) => JSON.stringify({
    id,
    wave: index === 0 ? 3 : 4,
    workflow: "bug-fix-merge-worktree",
    fixture: "tt-ts",
    harness: "pi",
    task: "cases/tasks/tier1/W3.03-bfmw-hermes-ts.md",
    caps: { tokens: 1, wall_min: 1 },
    class: "verification",
  })).join("\n");
  fs.writeFileSync(path.join(prep, "manifest.jsonl"), `${manifest}\n`);
  fs.writeFileSync(path.join(prep, "provenance.json"), `${JSON.stringify({
    tool: "tt-contention-slice",
    subcommand: "prepare",
    story: "STORM-I US-001",
    selection: SELECTED_IDS.map((id, index) => ({
      id,
      catalog: index === 0 ? "cases/tier1.jsonl" : "cases/tier2.jsonl",
      line: 19 + index,
    })),
  }, null, 2)}\n`);
  if (opts.stateText !== undefined && opts.stateText !== null) {
    fs.writeFileSync(path.join(campaign, "state.json"), opts.stateText);
  } else {
    const state = {
      version: 1,
      campaign_id: "campaign-toy",
      phase: "running",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      manifest: { case_ids: [...SELECTED_IDS] },
      cases: opts.cases,
    };
    fs.writeFileSync(path.join(campaign, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }
  const db = path.join(campaign, "tamandua.db");
  if (opts.writeDb !== false) {
    if (opts.dbRuns !== undefined && opts.dbRuns !== null) buildToyDb(db, opts.dbRuns);
    else buildToyDb(db, []);
  }
  return { prep, campaign, db };
}

const R1 = "run-11111111-1111-4111-8111-111111111111";
const R1_BARE = "11111111-1111-4111-8111-111111111111";
const R2 = "run-22222222-2222-4222-8222-222222222222";
const R2_BARE = "22222222-2222-4222-8222-222222222222";
const R3 = "run-33333333-3333-4333-8333-333333333333";
const R3_BARE = "33333333-3333-4333-8333-333333333333";
const R4 = "run-44444444-4444-4444-8444-444444444444";
const R4_BARE = "44444444-4444-4444-8444-444444444444";
const DECOY = "run-99999999-9999-4999-8999-999999999999";
const DECOY_BARE = "99999999-9999-4999-8999-999999999999";

const CASE_A = "W3.03-bfmw-hermes-ts";
const CASE_B = "W4.06-colleague-rebase";
const CASE_C = "W4.09-pi-kill-harness";
const CASE_D = "W4.dsh-bfmw";

function hashSet(files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) out[file] = fs.existsSync(file) ? sha256File(file) : "<absent>";
  return out;
}

describe("tier-2 STORM-I US-002 — tt-contention-slice sample (read-only observer)", () => {
  it("single-sample mode writes exactly one sample plus an observer record and never touches the campaign/prep fixtures", () => {
    const root = scratchDir("once");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R2 }] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [
          { id: R1_BARE, status: "running", steps: [{ id: "s1", status: "claimed" }] },
          { id: R2_BARE, status: "running" },
        ],
      });
      const before = hashSet([fixture.db, path.join(fixture.campaign, "state.json"),
        path.join(fixture.prep, "manifest.jsonl"), path.join(fixture.prep, "provenance.json")]);
      const campaignListing = fs.readdirSync(fixture.campaign).sort();
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, `sample --once must exit 0:\n${res.stdout}${res.stderr}`);
      const samples = sampleLines(path.join(out, "samples.jsonl"));
      assert.equal(samples.length, 1, "exactly one sample line in single-sample mode");
      assert.equal(samples[0].sample_index, 0);
      assert.ok(typeof samples[0].sampled_at === "string" && !Number.isNaN(Date.parse(samples[0].sampled_at)),
        "samples must be timestamped");
      assert.deepEqual(samples[0].selected_case_ids, SELECTED_IDS);
      const observer = loadJson(path.join(out, "observer.json"));
      assert.equal(observer.sample_count, 1);
      assert.equal(observer.stop_reason, "single-sample");
      assert.equal(observer.window_ms, null);
      // No mutation anywhere in the fixtures.
      const after = hashSet([fixture.db, path.join(fixture.campaign, "state.json"),
        path.join(fixture.prep, "manifest.jsonl"), path.join(fixture.prep, "provenance.json")]);
      assert.deepEqual(after, before, "input DB/state/manifest/provenance bytes must not change");
      assert.deepEqual(fs.readdirSync(fixture.campaign).sort(), campaignListing,
        "the campaign directory must gain no files (no DB sidecars, no observer output)");
      assert.ok(!fs.existsSync(`${fixture.db}-wal`) && !fs.existsSync(`${fixture.db}-shm`),
        "a read-only open must not create WAL/SHM sidecars");
    } finally {
      rmrf(root);
    }
  });

  it("overlapping active states: two scoped runs with claimed/running steps are observed simultaneously; decoy excluded", () => {
    const root = scratchDir("overlap");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R2 }] },
          { id: CASE_C, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R3 }] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [
          { id: R1_BARE, status: "running", steps: [
            { id: "s1", status: "claimed" },
            { id: "s2", status: "running" },
          ] },
          { id: R2_BARE, status: "running", steps: [{ id: "s3", status: "running" }] },
          // R3 has NO claimed/running steps at this instant (serial between steps).
          { id: R3_BARE, status: "running" },
          // Decoy: an unrelated background run with a claimed step. It must be
          // excluded from every observation and count.
          { id: DECOY_BARE, status: "running", steps: [{ id: "sd", status: "claimed" }] },
        ],
      });
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      const agg = sample.aggregates;
      assert.equal(agg.active_cases, 3, "three cases with present non-terminal runs");
      assert.equal(agg.active_runs, 3);
      assert.equal(agg.claimed_run_count, 2, "only R1+R2 have claimed/running steps");
      assert.equal(agg.claimed_step_count, 3, "two steps on R1 + one step on R2");
      assert.equal(agg.unknown_run_ids.length, 0);
      assert.equal(agg.missing_case_records.length, 0);
      const runKeys = Object.keys(sample.runs);
      assert.ok(runKeys.includes(R1) && runKeys.includes(R2) && runKeys.includes(R3),
        "scoped runs must be observed");
      assert.ok(!runKeys.some((key) => key.includes("9999")), "the decoy run must never appear in samples");
      assert.equal(sample.runs[R1].claimed_steps, 1);
      assert.equal(sample.runs[R1].running_steps, 1);
      assert.equal(sample.runs[R2].running_steps, 1);
      assert.equal(sample.runs[R3].present, true);
      assert.equal(sample.runs[R3].claimed_steps + sample.runs[R3].running_steps, 0);
      assert.equal(sample.campaign.manifest_case_ids.length, 4);
      assert.equal(sample.db.opened, true);
      assert.equal(sample.db.snapshot, "transaction", "reads should use a single read-only snapshot");
    } finally {
      rmrf(root);
    }
  });

  it("serial state: only one run has claimed/running steps at the sample instant", () => {
    const root = scratchDir("serial");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R2 }] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [
          { id: R1_BARE, status: "running", steps: [{ id: "s1", status: "running" }] },
          // R2 already terminal (its case finished first — serial).
          { id: R2_BARE, status: "completed", steps: [{ id: "s2", status: "done" }] },
        ],
      });
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      const agg = sample.aggregates;
      assert.equal(agg.claimed_run_count, 1);
      assert.equal(agg.claimed_step_count, 1);
      assert.equal(agg.active_cases, 1, "only the non-terminal case counts active");
      assert.equal(sample.runs[R2].terminal, true);
      assert.equal(sample.runs[R2].status, "completed");
    } finally {
      rmrf(root);
    }
  });

  it("replacement-attempt mapping: both recorded run ids are scoped; the replacement run drives active work", () => {
    const root = scratchDir("replacement");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_C, phase: "running", attempts: [
            // attempt-1 was replaced (terminal, its run completed).
            { attempt_id: "attempt-1", phase: "terminal", outcome: "AGENT_FLAKE", run_id: R3 },
            // attempt-2 is the replacement, still running.
            { attempt_id: "attempt-2", phase: "running", run_id: R4 },
          ] },
        ].concat(
          [CASE_A, CASE_B, CASE_D].map((id) => ({ id, phase: "pending", attempts: [] as ToyAttempt[] })),
        ),
        dbRuns: [
          { id: R3_BARE, status: "completed", steps: [{ id: "s3", status: "done" }] },
          { id: R4_BARE, status: "running", steps: [{ id: "s4", status: "claimed" }] },
        ],
      });
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      const caseC = sample.cases.find((c: any) => c.case_id === CASE_C);
      assert.deepEqual(caseC.run_ids, [R3, R4], "replacement attempt mapping must carry BOTH run ids");
      assert.equal(caseC.attempts.length, 2);
      assert.equal(caseC.attempts[0].terminal, true);
      assert.equal(caseC.attempts[1].run_id, R4);
      const agg = sample.aggregates;
      assert.equal(agg.claimed_run_count, 1, "only the replacement run has a claimed step");
      assert.equal(agg.claimed_step_count, 1);
      assert.equal(sample.runs[R3].terminal, true, "the replaced run is observed terminal");
      assert.equal(sample.runs[R4].present, true);
      assert.equal(sample.runs[R4].claimed_steps, 1);
    } finally {
      rmrf(root);
    }
  });

  it("missing/corrupt evidence is UNKNOWN, never zero active work, and samples are preserved", () => {
    // (a) missing state.json.
    const rootA = scratchDir("nostate");
    try {
      const fixture = buildToyCampaign(rootA, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [{ id: R1_BARE, status: "running" }],
      });
      fs.rmSync(path.join(fixture.campaign, "state.json"));
      const out = path.join(rootA, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, "a missing state file is evidence, not an observer failure");
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      assert.equal(sample.campaign.state_present, false);
      assert.match(sample.campaign.state_error, /does not exist/);
      assert.ok(sample.aggregates.observation_errors.length > 0);
    } finally {
      rmrf(rootA);
    }

    // (b) corrupt state.json.
    const rootB = scratchDir("badstate");
    try {
      const fixture = buildToyCampaign(rootB, {
        cases: [{ id: CASE_A, phase: "pending", attempts: [] }],
        dbRuns: [],
        stateText: "{ this is not valid json",
      });
      const out = path.join(rootB, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0);
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      assert.equal(sample.campaign.state_present, false);
      assert.match(sample.campaign.state_error, /cannot read campaign state|Unexpected token/);
      assert.ok(sample.aggregates.observation_errors.length > 0, "corrupt state must be reported");
    } finally {
      rmrf(rootB);
    }

    // (c) missing DB file: never created, every scoped run UNKNOWN.
    const rootC = scratchDir("nodbfile");
    try {
      const fixture = buildToyCampaign(rootC, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        writeDb: false,
      });
      const out = path.join(rootC, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, "a missing DB is evidence (UNKNOWN), not an observer failure");
      assert.ok(!fs.existsSync(fixture.db), "the observer must never create the DB");
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      assert.equal(sample.db.path_present, false);
      assert.equal(sample.db.opened, false);
      assert.ok(sample.db.error !== null, "the DB open failure must be recorded");
      assert.ok(sample.aggregates.unknown_run_ids.includes(R1),
        "a run whose DB is unreadable is UNKNOWN, never zero active work");
      assert.ok(sample.aggregates.observation_errors.length > 0);
      assert.equal(sample.aggregates.active_cases, 0);
      assert.ok(sample.aggregates.unknown_cases.some((c: any) => c.case_id === CASE_A),
        "the non-terminal case with an unreadable DB is UNKNOWN, not inactive");
    } finally {
      rmrf(rootC);
    }

    // (d) corrupt DB file: open failure is UNKNOWN evidence, samples preserved.
    const rootD = scratchDir("baddb");
    try {
      const fixture = buildToyCampaign(rootD, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        writeDb: false,
      });
      fs.writeFileSync(fixture.db, "this is not a sqlite database");
      const before = sha256File(fixture.db);
      const out = path.join(rootD, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, "a corrupt DB is evidence (UNKNOWN), not an observer failure");
      assert.equal(sha256File(fixture.db), before, "the corrupt DB bytes must be untouched");
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      assert.equal(sample.db.path_present, true);
      assert.equal(sample.db.opened, false);
      assert.match(sample.db.error, /not readable as SQLite|cannot open the campaign DB read-only/);
      assert.ok(sample.aggregates.unknown_run_ids.includes(R1));
    } finally {
      rmrf(rootD);
    }

    // (e) DB under a not-yet-provisioned campaign home: intermediate dirs
    // missing is evidence, not a path error — the observer must accept the
    // contained path and record UNKNOWN rather than refuse to start.
    const rootE = scratchDir("deephome");
    try {
      const fixture = buildToyCampaign(rootE, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        writeDb: false,
      });
      const deepDb = path.join(rootE, "campaign", ".tamandua", "tamandua.db");
      const out = path.join(rootE, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", deepDb, "--out", out, "--once"]);
      assert.equal(res.status, 0, "a DB path whose parent dirs are not provisioned yet is evidence, not an error");
      assert.ok(!fs.existsSync(deepDb), "the observer must never create the DB or its parents");
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      assert.equal(sample.db.path_present, false);
      assert.equal(sample.db.opened, false);
      assert.ok(sample.aggregates.unknown_run_ids.includes(R1));
    } finally {
      rmrf(rootE);
    }
  });

  it("path escapes are refused BEFORE anything is opened or written", () => {
    const root = scratchDir("escapes");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [{ id: CASE_A, phase: "pending", attempts: [] }],
        dbRuns: [],
      });

      // (a) --db outside torture-test/var (OS temp).
      const outsideDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-db-")), "tamandua.db");
      let out = path.join(root, "obs-a");
      let res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", outsideDb, "--out", out, "--once"]);
      assert.notEqual(res.status, 0, "a DB outside var must be refused");
      assert.match(res.stderr, /campaign database is outside the contained root|outside the contained root/);
      assert.ok(!fs.existsSync(out), "no observation dir may be created");
      rmrf(path.dirname(outsideDb));

      // (b) --prep path traversal.
      out = path.join(root, "obs-b");
      const traversal = `${fixture.prep}/../..//../../escape-${process.pid}-${Date.now()}`;
      res = runCli(["sample", "--prep", traversal, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.notEqual(res.status, 0, "a traversal preparation path must be refused");
      assert.match(res.stderr, /path-traversal/);
      assert.ok(!fs.existsSync(out));

      // (c) --campaign through a symlink that escapes var (into the OS temp).
      const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-esctarget-"));
      const link = path.join(varRoot, `tier2-cs-esclink-${process.pid}-${Date.now()}`);
      fs.symlinkSync(escapeTarget, link);
      out = path.join(root, "obs-c");
      res = runCli(["sample", "--prep", fixture.prep, "--campaign", path.join(link, "campaign"), "--db", fixture.db, "--out", out, "--once"]);
      assert.notEqual(res.status, 0, "a symlink-escape campaign path must be refused");
      assert.match(res.stderr, /symlink/);
      assert.ok(!fs.existsSync(out));
      rmrf(link);
      rmrf(escapeTarget);

      // (d) missing --prep / --campaign / --db arguments are rejected.
      res = runCli(["sample", "--campaign", fixture.campaign, "--db", fixture.db]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /requires --prep/);

      // (e) --out refusals are validated BEFORE mkdir: an existing dir, an
      // outside-var destination, and a symlink-escape destination produce no
      // writes anywhere.
      const existingOut = scratchDir("obs-existing");
      fs.mkdirSync(existingOut, { recursive: true });
      const keep = path.join(existingOut, "keep.txt");
      fs.writeFileSync(keep, "previous");
      res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", existingOut, "--once"]);
      assert.notEqual(res.status, 0, "an existing --out directory must be refused");
      assert.match(res.stderr, /already exists/);
      assert.ok(fs.existsSync(keep), "the existing --out directory must be untouched");
      rmrf(existingOut);

      const outsideOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-outout-")), "obs");
      res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", outsideOut, "--once"]);
      assert.notEqual(res.status, 0, "an --out outside var must be refused");
      assert.match(res.stderr, /outside torture-test\/var/);
      assert.ok(!fs.existsSync(outsideOut));
      rmrf(path.dirname(outsideOut));

      const escOutTarget = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-esc-out-"));
      const escOutLink = path.join(varRoot, `tier2-cs-esc-out-${process.pid}-${Date.now()}`);
      fs.symlinkSync(escOutTarget, escOutLink);
      res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", path.join(escOutLink, "obs"), "--once"]);
      assert.notEqual(res.status, 0, "an --out through a symlink escape must be refused");
      assert.match(res.stderr, /symlink/);
      assert.deepEqual(fs.readdirSync(escOutTarget), [], "nothing may be created through the escaping symlink");
      rmrf(escOutLink);
      rmrf(escOutTarget);
    } finally {
      rmrf(root);
    }
  });

  it("no mutation of input DB/files across a windowed observation run (hash before/after)", () => {
    const root = scratchDir("nomutate");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R2 }] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [
          { id: R1_BARE, status: "running", steps: [{ id: "s1", status: "running" }] },
          { id: R2_BARE, status: "running" },
        ],
      });
      const files = [fixture.db, path.join(fixture.campaign, "state.json"),
        path.join(fixture.prep, "manifest.jsonl"), path.join(fixture.prep, "provenance.json")];
      const before = hashSet(files);
      const campaignListing = fs.readdirSync(fixture.campaign).sort();
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db,
        "--out", out, "--interval-ms", "30", "--window-ms", "150"]);
      assert.equal(res.status, 0, `windowed sample must exit 0:\n${res.stdout}${res.stderr}`);
      const samples = sampleLines(path.join(out, "samples.jsonl"));
      assert.ok(samples.length >= 2, `expected multiple samples, got ${samples.length}`);
      const observer = loadJson(path.join(out, "observer.json"));
      assert.equal(observer.stop_reason, "window-expired");
      assert.equal(observer.sample_count, samples.length);
      assert.deepEqual(hashSet(files), before, "input DB/state/manifest/provenance bytes must not change");
      assert.deepEqual(fs.readdirSync(fixture.campaign).sort(), campaignListing,
        "the campaign directory must gain no files");
      // All samples share the same scoped run id set (decoy-free).
      for (const sample of samples) {
        assert.ok(!Object.keys(sample.runs).some((key) => key.includes("9999")));
      }
    } finally {
      rmrf(root);
    }
  });

  it("an already-terminal campaign stops after the first sample with all-cases-terminal and never waits", () => {
    const root = scratchDir("terminal");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "terminal", outcome: "PASS", attempts: [{ attempt_id: "attempt-1", phase: "terminal", outcome: "PASS", run_id: R1 }] },
          { id: CASE_B, phase: "terminal", outcome: "PASS", attempts: [{ attempt_id: "attempt-1", phase: "terminal", outcome: "PASS", run_id: R2 }] },
          { id: CASE_C, phase: "terminal", outcome: "NOT_RUN", attempts: [] },
          { id: CASE_D, phase: "terminal", outcome: "NOT_RUN", attempts: [] },
        ],
        dbRuns: [
          { id: R1_BARE, status: "completed" },
          { id: R2_BARE, status: "failed" },
        ],
      });
      const startedMs = Date.now();
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out]);
      const elapsed = Date.now() - startedMs;
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      assert.ok(elapsed < 5000, "an all-terminal campaign must stop immediately (no 15s sleep)");
      const samples = sampleLines(path.join(out, "samples.jsonl"));
      assert.equal(samples.length, 1);
      assert.equal(samples[0].all_selected_cases_terminal, true);
      const observer = loadJson(path.join(out, "observer.json"));
      assert.equal(observer.stop_reason, "all-cases-terminal");
      assert.equal(observer.first_sample_all_terminal, true);
      const agg = samples[0].aggregates;
      assert.equal(agg.terminal_cases, 4);
      assert.equal(agg.active_cases, 0);
      assert.equal(agg.claimed_run_count, 0);
    } finally {
      rmrf(root);
    }
  });

  it("a campaign whose state never carries the selected cases stops with cases-absent-from-campaign (honest, never infinite)", () => {
    const root = scratchDir("absent");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
        ],
        dbRuns: [{ id: R1_BARE, status: "running" }],
      });
      // Remove EVERY selected case from the campaign state: none can ever
      // become terminal, so continuing to sample would be an infinite loop.
      const statePath = path.join(fixture.campaign, "state.json");
      const state = loadJson(statePath);
      state.cases = [];
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      const out = path.join(root, "obs");
      const startedMs = Date.now();
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out]);
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      assert.ok(Date.now() - startedMs < 5000, "a permanently unobservable case must stop promptly");
      const observer = loadJson(path.join(out, "observer.json"));
      assert.equal(observer.stop_reason, "cases-absent-from-campaign");
      const samples = sampleLines(path.join(out, "samples.jsonl"));
      assert.ok(samples.length >= 1);
      const agg = samples[0].aggregates;
      assert.ok(agg.missing_case_records.length >= 4, "all absent selected cases must be reported");
      assert.ok(agg.observation_errors.some((e: string) => e.includes("absent from the campaign state")));
    } finally {
      rmrf(root);
    }
  });

  it("an interruption while sleeping settles the observer: retained samples, observer record, non-zero exit, campaign untouched", async () => {
    const root = scratchDir("interrupt");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [{ id: R1_BARE, status: "running", steps: [{ id: "s1", status: "running" }] }],
      });
      const files = [fixture.db, path.join(fixture.campaign, "state.json"),
        path.join(fixture.prep, "manifest.jsonl"), path.join(fixture.prep, "provenance.json")];
      const before = hashSet(files);
      const campaignListing = fs.readdirSync(fixture.campaign).sort();
      const out = path.join(root, "obs");
      // Owned child observer with a long interval: after the first sample it
      // sleeps; SIGINT must settle the loop promptly.
      const child = spawn(process.execPath, [
        cli, "sample",
        "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db,
        "--out", out, "--interval-ms", "600000",
      ], { cwd: ttRoot, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += String(d); });
      try {
        await waitFor(() => {
          try {
            return sampleLines(path.join(out, "samples.jsonl")).length >= 1;
          } catch {
            return false;
          }
        }, 15_000);
        const codePromise = new Promise<number | null>((resolve) => {
          child.on("exit", (code) => resolve(code));
        });
        child.kill("SIGINT");
        const code = await Promise.race([
          codePromise,
          new Promise<number | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), 15_000);
            timer.unref?.();
          }),
        ]);
        assert.notEqual(code, null, `observer must settle after SIGINT (stderr: ${stderr})`);
        assert.equal(code, 130, `interrupted observer must exit 128+SIGINT (stderr: ${stderr})`);
        const samples = sampleLines(path.join(out, "samples.jsonl"));
        assert.equal(samples.length, 1, "the single recorded sample must be preserved");
        assert.equal(samples[0].db.opened, true);
        const observer = loadJson(path.join(out, "observer.json"));
        assert.equal(observer.stop_reason, "interrupted");
        assert.match(observer.stop_detail ?? "", /SIGINT/);
        assert.equal(observer.error, null);
        assert.equal(observer.sample_count, 1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL"); // owned-child cleanup only if still alive
        }
      }
      // The observed campaign and its DB were never touched.
      assert.deepEqual(hashSet(files), before, "input DB/state/manifest/provenance bytes must not change");
      assert.deepEqual(fs.readdirSync(fixture.campaign).sort(), campaignListing,
        "the campaign directory must gain no files");
    } finally {
      rmrf(root);
    }
  });

  it("an active attempt with run_id_error and no scoped run id is UNKNOWN coverage (never a clean zero)", () => {
    const root = scratchDir("runiderror");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          // CASE_A is running but its in-flight attempt carries run_id_error and
          // no usable run id: identification itself failed.
          { id: CASE_A, phase: "running", attempts: [
            { attempt_id: "attempt-1", phase: "running", run_id_error: { category: "workflow-run-identification" } },
          ] },
          // Genuinely not-started pending cases stay clean.
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [],
      });
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      const agg = sample.aggregates;
      // Identification failure must never look like a fully-observed clean zero.
      assert.equal(agg.active_cases, 0, "no scoped run is observable for an unidentified attempt");
      assert.ok(agg.unknown_cases.some((c: any) => c.case_id === CASE_A),
        "the running case with run_id_error must be listed as UNKNOWN coverage");
      const caseAUnknown = agg.unknown_cases.find((c: any) => c.case_id === CASE_A);
      assert.match(caseAUnknown.reason, /run_id_error/);
      assert.ok(agg.observation_errors.some((e: string) => e.includes(CASE_A) && e.includes("run_id_error")),
        "the attempt's run_id_error must surface as an observation error");
      assert.equal(agg.unknown_run_ids.length, 0, "no run id exists to list as unknown");
      // The attempt detail carries the flag even at the case level.
      const caseA = sample.cases.find((c: any) => c.case_id === CASE_A);
      assert.equal(caseA.attempts[0].run_id_error, true);
      assert.equal(caseA.attempts[0].run_id, null);
      // Pending (not-started) cases are NOT unknown and not active.
      for (const pendingId of [CASE_B, CASE_C, CASE_D]) {
        assert.ok(!agg.unknown_cases.some((c: any) => c.case_id === pendingId),
          `not-started pending case ${pendingId} must stay clean`);
        const pending = sample.cases.find((c: any) => c.case_id === pendingId);
        assert.equal(pending.present_in_state, true);
        assert.equal(pending.phase, "pending");
      }
    } finally {
      rmrf(root);
    }
  });

  it("a running attempt that has not yet acquired a run id is UNKNOWN coverage; pending/NOT_RUN controls stay clean", () => {
    const root = scratchDir("noacquired");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          // CASE_A running attempt exists but has not yet acquired a valid run
          // id (no run_id, no run_id_error yet).
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running" }] },
          // CASE_B: genuinely not-started pending.
          { id: CASE_B, phase: "pending", attempts: [] },
          // CASE_C + CASE_D: terminal NOT_RUN — never ran, not unknown.
          { id: CASE_C, phase: "terminal", outcome: "NOT_RUN", attempts: [] },
          { id: CASE_D, phase: "terminal", outcome: "NOT_RUN", attempts: [] },
        ],
        dbRuns: [],
      });
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      const agg = sample.aggregates;
      assert.equal(agg.active_cases, 0);
      assert.ok(agg.unknown_cases.some((c: any) => c.case_id === CASE_A),
        "a running attempt with no run id yet is UNKNOWN coverage");
      const caseAUnknown = agg.unknown_cases.find((c: any) => c.case_id === CASE_A);
      assert.match(caseAUnknown.reason, /has not yet acquired/);
      assert.ok(!agg.unknown_cases.some((c: any) => c.case_id === CASE_B),
        "a genuinely not-started pending case is not unknown");
      assert.ok(!agg.unknown_cases.some((c: any) => c.case_id === CASE_C || c.case_id === CASE_D),
        "terminal NOT_RUN cases are not unknown");
      assert.equal(agg.terminal_cases, 2, "the two NOT_RUN cases are terminal");
      assert.equal(sample.all_selected_cases_terminal, false,
        "the running-unidentified case keeps the campaign non-terminal (observer keeps sampling)");
      // The attempt detail marks the missing id explicitly.
      const caseA = sample.cases.find((c: any) => c.case_id === CASE_A);
      assert.equal(caseA.attempts[0].terminal, false);
      assert.equal(caseA.attempts[0].run_id, null);
    } finally {
      rmrf(root);
    }
  });

  it("a running case with an invalid (non-uuid) recorded run id is UNKNOWN coverage, and a decoy DB run is never counted", () => {
    const root = scratchDir("invalidid");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [
            { attempt_id: "attempt-1", phase: "running", run_id: "not-a-real-run-id" },
          ] },
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        // Decoy run in the DB with claimed steps: never scoped, never counted.
        dbRuns: [{ id: DECOY_BARE, status: "running", steps: [{ id: "sd", status: "claimed" }] }],
      });
      const out = path.join(root, "obs");
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db, "--out", out, "--once"]);
      assert.equal(res.status, 0, `sample must exit 0:\n${res.stdout}${res.stderr}`);
      const sample = sampleLines(path.join(out, "samples.jsonl"))[0];
      const agg = sample.aggregates;
      assert.ok(agg.unknown_cases.some((c: any) => c.case_id === CASE_A),
        "a case whose attempt records an invalid run id is UNKNOWN coverage");
      assert.match(agg.unknown_cases.find((c: any) => c.case_id === CASE_A).reason, /invalid run id/);
      assert.equal(agg.claimed_run_count, 0, "the decoy's claimed step must never be counted");
      assert.equal(agg.active_runs, 0);
      assert.ok(!Object.keys(sample.runs).some((key) => key.includes("9999")),
        "the decoy run must never appear in the observation");
    } finally {
      rmrf(root);
    }
  });

  it("sampleDelayMs (pure timer contract): a bounded window caps the sleep at the window boundary and never overshoots", () => {
    const startedMs = 1_000_000;
    // interval 15000, window 1000: at the very start the next due sample is
    // 15000ms away but the window ends in 1000ms → sleep is capped to ~1000ms.
    assert.equal(sampleDelayMs({
      startedMs, nowMs: startedMs, sampleIndex: 1, intervalMs: 15000, windowMs: 1000,
    }), 1000, "a 1s window must cap a 15s-cadence sleep to the remaining window");
    // Mid-window: remaining window shrinks, cap follows it (never the interval).
    assert.equal(sampleDelayMs({
      startedMs, nowMs: startedMs + 500, sampleIndex: 1, intervalMs: 15000, windowMs: 1000,
    }), 500);
    // At/past the window boundary there is no delay at all.
    assert.equal(sampleDelayMs({
      startedMs, nowMs: startedMs + 1000, sampleIndex: 1, intervalMs: 15000, windowMs: 1000,
    }), 0, "no sleep past the window boundary");
    assert.equal(sampleDelayMs({
      startedMs, nowMs: startedMs + 2500, sampleIndex: 1, intervalMs: 15000, windowMs: 1000,
    }), 0);
    // Without a window the pure interval cadence applies.
    assert.equal(sampleDelayMs({
      startedMs, nowMs: startedMs, sampleIndex: 1, intervalMs: 15000, windowMs: null,
    }), 15000);
    // A window longer than the interval keeps the interval cadence.
    assert.equal(sampleDelayMs({
      startedMs, nowMs: startedMs, sampleIndex: 1, intervalMs: 15000, windowMs: 60000,
    }), 15000);
    // Skipped/due samples: already-past due returns 0 under a window.
    assert.equal(sampleDelayMs({
      startedMs, nowMs: startedMs + 20000, sampleIndex: 1, intervalMs: 15000, windowMs: 60000,
    }), 0);
    // Invalid inputs refuse loudly.
    assert.throws(() => sampleDelayMs({
      startedMs, nowMs: startedMs, sampleIndex: 1, intervalMs: 0, windowMs: null,
    }), /positive integer intervalMs/);
    assert.throws(() => sampleDelayMs({
      startedMs, nowMs: startedMs, sampleIndex: 1, intervalMs: 15000, windowMs: 0,
    }), /positive integer windowMs/);
  });

  it("a 1-second observation window does not overshoot through a 15-second interval sleep (end-to-end)", () => {
    const root = scratchDir("windowcap");
    try {
      const fixture = buildToyCampaign(root, {
        cases: [
          { id: CASE_A, phase: "running", attempts: [{ attempt_id: "attempt-1", phase: "running", run_id: R1 }] },
          { id: CASE_B, phase: "pending", attempts: [] },
          { id: CASE_C, phase: "pending", attempts: [] },
          { id: CASE_D, phase: "pending", attempts: [] },
        ],
        dbRuns: [{ id: R1_BARE, status: "running" }],
      });
      const files = [fixture.db, path.join(fixture.campaign, "state.json"),
        path.join(fixture.prep, "manifest.jsonl"), path.join(fixture.prep, "provenance.json")];
      const before = hashSet(files);
      const out = path.join(root, "obs");
      // interval=15000 (default cadence) but window=1000: the observer must stop
      // at the ~1s boundary, NOT sleep a whole 15s interval first.
      const startedMs = Date.now();
      const res = runCli(["sample", "--prep", fixture.prep, "--campaign", fixture.campaign, "--db", fixture.db,
        "--out", out, "--interval-ms", "15000", "--window-ms", "1000"]);
      const elapsed = Date.now() - startedMs;
      assert.equal(res.status, 0, `windowed sample must exit 0:\n${res.stdout}${res.stderr}`);
      assert.ok(elapsed < 8000, `the observer must stop at the ~1s window boundary, not sleep 15s (elapsed ${elapsed}ms)`);
      const samples = sampleLines(path.join(out, "samples.jsonl"));
      assert.ok(samples.length >= 1, "at least the first sample is recorded");
      assert.ok(samples.length < 3, `a 1s window with a 15s cadence must not emit a full interval of samples (got ${samples.length})`);
      const observer = loadJson(path.join(out, "observer.json"));
      assert.equal(observer.stop_reason, "window-expired");
      assert.equal(observer.sample_count, samples.length);
      assert.deepEqual(hashSet(files), before, "input DB/state/manifest/provenance bytes must not change");
    } finally {
      rmrf(root);
    }
  });

  it("fixture roots are atomically allocated owned directories under torture-test/var (never PID/time-derived)", () => {
    const first = scratchDir("atomic-a");
    const second = scratchDir("atomic-b");
    try {
      assert.notEqual(first, second, "each allocation is a fresh unique directory");
      for (const dir of [first, second]) {
        assert.ok(dir.startsWith(varRoot), `fixture root must live under varRoot: ${dir}`);
        const details = fs.lstatSync(dir);
        assert.ok(details.isDirectory(), "allocated root is a directory");
        assert.ok(!details.isSymbolicLink(), "allocated root is not a symlink");
      }
      // The allocated roots are owned by this test: creating and removing them
      // must not touch anything else under var.
      const listingBefore = fs.readdirSync(varRoot).sort();
      fs.writeFileSync(path.join(first, "owned.txt"), "owned by this test");
      assert.ok(fs.existsSync(path.join(first, "owned.txt")));
      rmrf(first);
      rmrf(second);
      const listingAfter = fs.readdirSync(varRoot).sort();
      // Only the two atomically-allocated names disappeared.
      const removed = listingBefore.filter((name) => !listingAfter.includes(name));
      assert.ok(removed.length >= 2, `the two owned roots must be removable (removed: ${removed.join(", ")})`);
      assert.ok(removed.every((name) => name.startsWith("tier2-contention-sample-")),
        "only this test's own allocated roots were removed");
    } finally {
      // Cleanup of the successfully allocated roots (allocation happened above,
      // outside the try, so a failed allocation is never cleaned here).
      rmrf(first);
      rmrf(second);
    }
  });
});
