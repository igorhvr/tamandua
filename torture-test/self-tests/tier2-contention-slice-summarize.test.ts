// Tier-2 STORM-I US-003: tt-contention-slice `summarize` — honest contention
// summary of a persisted observation (STORM-I US-002 summary half).
//
// Gates (all hermetic; no daemons, no fixed ports, no real models; toy
// sample sets written under torture-test/var):
//  1. configured-vs-observed separation: the CONFIGURED case concurrency
//     (recorded controller argv --concurrency 4) is reported separately from
//     the OBSERVED claimed-step peak (recomputed, scoped, decoy-proof);
//  2. honest low-peak reporting: an observed peak below 3 says so explicitly
//     (observed_peak_below_three, reasons, verdict) and prints NO unqualified
//     passed-storm claim;
//  3. insufficient-evidence reporting: a late observer start (first sample
//     already all-terminal) and coverage gaps (missed intervals between
//     samples) are reported and forbid an unqualified claim;
//  4. decoy exclusion: a run id not recorded on any SELECTED case's attempts
//     never contributes to the peak, and a forged aggregate that would count
//     it is flagged as a data mismatch;
//  5. NOT_RUN/terminal counting: per-case executed/NOT_RUN/terminal
//     classification plus counts (a NOT_RUN case is never "executed");
//  6. corrupt/missing evidence: a corrupt sample line, a missing samples.jsonl,
//     or an all-corrupt samples file is reported explicitly (never silently
//     dropped) and a PARTIAL summary is still produced/preserved;
//  7. partial-observation summaries: an observer that recorded an error still
//     yields a summary that says evidence is not clean and never overclaims;
//  8. summarize writes summary.json + summary.txt INTO the observation
//     directory, never mutates the prep manifest/provenance, the samples, the
//     observer record, or a campaign DB placed next to them (hash before/
//     after), refuses to overwrite an existing summary.json, has no --db
//     option (it never opens a campaign DB), and refuses escaped paths before
//     any write;
//  9. no-argument/--help paths keep their no-side-effect behavior (covered by
//     the prepare gate; re-asserted here for the summarize usage text).
//
// Everything writes only under torture-test/var (git-ignored) in fresh temp
// fixtures owned by this file. The isolation guard is PRESERVED.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildContentionSummary,
  parseSamplesEvidence,
  renderSummaryText,
} from "../bin/tt-contention-slice-shared.mjs";

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
const CASE_A = SELECTED_IDS[0];
const CASE_B = SELECTED_IDS[1];
const CASE_C = SELECTED_IDS[2];
const CASE_D = SELECTED_IDS[3];

const R1 = "run-11111111-1111-4111-8111-111111111111";
const R2 = "run-22222222-2222-4222-8222-222222222222";
const R3 = "run-33333333-3333-4333-8333-333333333333";
const R4 = "run-44444444-4444-4444-8444-444444444444";
const DECOY = "run-99999999-9999-4999-8999-999999999999";

const T0 = "2026-09-06T00:00:00.000Z";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Guard propagation preserved: spawn env is the caller env (which may carry
// TAMANDUA_TEST_GUARD / NODE_TEST_CONTEXT) plus harmless harness pins.
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

function sha256File(abs: string): string {
  return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Atomically allocated fresh owned fixture root under torture-test/var
// (fs.mkdtempSync — exclusive, owned; a failed allocation is never cleaned).
function scratchDir(label: string): string {
  return fs.mkdtempSync(path.join(varRoot, `tier2-contention-summarize-${label}-`));
}

function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

fs.mkdirSync(varRoot, { recursive: true });

// ── Toy fixture builders ───────────────────────────────────────────

// A toy US-001 prepared directory (manifest.jsonl + provenance.json carrying
// the recorded controller argv with --concurrency 4 --stagger 10s).
function buildPrep(fixtureRoot: string): { prep: string; manifestSha256: string } {
  const prep = path.join(fixtureRoot, "prep");
  fs.mkdirSync(prep, { recursive: true });
  const manifest = SELECTED_IDS.map((id, index) => JSON.stringify({
    id,
    wave: index === 0 ? 3 : 4,
    workflow: "bug-fix-merge-worktree",
    harness: "pi",
    task: "cases/tasks/tier1/W3.03-bfmw-hermes-ts.md",
    caps: { tokens: 1, wall_min: 1 },
  })).join("\n");
  fs.writeFileSync(path.join(prep, "manifest.jsonl"), `${manifest}\n`);
  fs.writeFileSync(path.join(prep, "provenance.json"), `${JSON.stringify({
    tool: "tt-contention-slice",
    subcommand: "prepare",
    story: "STORM-I US-001",
    generated_at: T0,
    selection: SELECTED_IDS.map((id, index) => ({
      id,
      catalog: index === 0 ? "cases/tier1.jsonl" : "cases/tier2.jsonl",
      line: 19 + index,
    })),
    source: { commit: "c".repeat(40), tracked_tree_clean: true, pinned_clean_candidate: true },
    controller: {
      executable: path.join(ttRoot, "bin", "tt-controller"),
      cwd: ttRoot,
      concurrency: 4,
      stagger: "10s",
      argv: [
        path.join(ttRoot, "bin", "tt-controller"),
        "--manifest", path.join(prep, "manifest.jsonl"),
        "--concurrency", "4",
        "--stagger", "10s",
      ],
    },
  }, null, 2)}\n`);
  return { prep, manifestSha256: sha256File(path.join(prep, "manifest.jsonl")) };
}

// composeSample-shaped case entry.
function caseEntry(caseId: string, opts: {
  phase: string;
  outcome?: any;
  runIds?: string[];
  present?: boolean;
  attemptsTerminalPhase?: string;
}): any {
  const present = opts.present !== false;
  const runIds = opts.runIds ?? [];
  const phase = present ? opts.phase : "pending";
  const attempts = present
    ? runIds.map((runId, index) => ({
      attempt_id: `attempt-${index + 1}`,
      phase: opts.attemptsTerminalPhase ?? opts.phase,
      outcome: opts.outcome ?? null,
      terminal: (opts.attemptsTerminalPhase ?? opts.phase) === "terminal",
      run_id: runId,
      run_id_error: false,
      run_id_raw: runId,
      run_id_invalid: false,
    }))
    : [];
  return {
    case_id: caseId,
    present_in_state: present,
    phase: present ? opts.phase : null,
    terminal: present && opts.phase === "terminal",
    outcome: present ? (opts.outcome ?? null) : null,
    attempt_count: attempts.length,
    attempts,
    run_ids: present ? runIds : [],
    errors: present ? [] : ["case absent from campaign state"],
  };
}

// composeSample-shaped run entry.
function runEntry(runId: string, opts: {
  status?: string;
  terminal?: boolean;
  present?: boolean;
  missing?: boolean;
  claimed?: number;
  running?: number;
  error?: string | null;
  caseIds?: string[];
} = {}): any {
  const present = opts.present !== false && opts.missing !== true;
  const claimed = opts.claimed ?? 0;
  const running = opts.running ?? 0;
  return {
    case_ids: opts.caseIds ?? [],
    present,
    missing: opts.missing === true,
    status: present ? (opts.status ?? "running") : null,
    terminal: present ? (opts.terminal === true) : false,
    claimed_steps: present ? claimed : 0,
    running_steps: present ? running : 0,
    error: opts.error !== undefined ? opts.error : null,
  };
}

// Compose a full sample record whose aggregates are consistent with the case/
// run data it carries (what the real sampler writes). `prepSha` binds the
// sample to the prepared manifest when given.
function sampleRecord(index: number, at: string, opts: {
  cases: any[];
  runs: Record<string, any>;
  allTerminal?: boolean;
  observationErrors?: string[];
  unknownRunIds?: string[];
  unknownCases?: any[];
  missingCaseRecords?: string[];
  prepSha?: string | null;
  campaignStatePresent?: boolean;
  dbError?: string | null;
  sampleError?: string | null;
}): any {
  const cases = opts.cases;
  const runs = opts.runs;
  let claimedRunCount = 0;
  let claimedStepCount = 0;
  const scopedRunIds = new Set<string>();
  for (const c of cases) {
    for (const rid of c.run_ids ?? []) {
      if (typeof rid === "string") scopedRunIds.add(rid.startsWith("run-") ? rid : `run-${rid}`);
    }
  }
  for (const [key, entry] of Object.entries(runs)) {
    if (!scopedRunIds.has(key)) continue;
    const steps = (Number(entry.claimed_steps) || 0) + (Number(entry.running_steps) || 0);
    if (steps > 0) {
      claimedRunCount += 1;
      claimedStepCount += steps;
    }
  }
  const activeCases = cases.filter((c) => {
    if (c.phase !== "running" || c.present_in_state !== true) return false;
    return (c.run_ids ?? []).some((rid: string) => {
      const key = rid.startsWith("run-") ? rid : `run-${rid}`;
      const entry = runs[key];
      return entry !== undefined && entry.present === true && entry.terminal !== true && entry.error === null;
    });
  }).length;
  const terminalCases = cases.filter((c) => c.terminal === true).length;
  const activeRuns = Object.values(runs).filter((e: any) => e.present === true && e.terminal !== true && e.error === null).length;
  return {
    sample_index: index,
    sampled_at: at,
    selected_case_ids: [...SELECTED_IDS],
    prep: opts.prepSha !== null && opts.prepSha !== undefined ? { dir: "prep", manifest_sha256: opts.prepSha } : null,
    campaign: {
      dir: "campaign",
      state_present: opts.campaignStatePresent !== false,
      state_error: null,
      manifest_case_ids: [...SELECTED_IDS],
    },
    db: {
      path_present: true,
      opened: true,
      snapshot: "transaction",
      error: opts.dbError !== undefined ? opts.dbError : null,
    },
    cases,
    runs,
    aggregates: {
      selected_case_count: SELECTED_IDS.length,
      case_records_found: cases.filter((c) => c.present_in_state).length,
      terminal_cases: terminalCases,
      active_cases: activeCases,
      active_runs: activeRuns,
      claimed_run_count: claimedRunCount,
      claimed_step_count: claimedStepCount,
      unknown_run_ids: opts.unknownRunIds ?? [],
      unknown_cases: opts.unknownCases ?? [],
      missing_case_records: opts.missingCaseRecords ?? [],
      observation_errors: opts.observationErrors ?? [],
    },
    all_selected_cases_terminal: opts.allTerminal === true
      || (cases.length > 0 && cases.every((c) => c.terminal === true)),
    ...(opts.sampleError !== null && opts.sampleError !== undefined ? { error: opts.sampleError } : {}),
  };
}

function timestamp(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function defaultObserver(opts: Record<string, any> = {}): any {
  return {
    tool: "tt-contention-slice",
    subcommand: "sample",
    story: "STORM-I US-002",
    started_at: opts.started_at ?? T0,
    finished_at: opts.finished_at ?? timestamp(Date.parse(T0), 15000),
    observation_dir: "obs",
    samples_file: "samples.jsonl",
    sample_count: opts.sample_count ?? 1,
    interval_ms: opts.interval_ms ?? 15000,
    window_ms: opts.window_ms ?? null,
    selected_case_ids: [...SELECTED_IDS],
    first_sample_all_terminal: opts.first_sample_all_terminal ?? false,
    stop_reason: opts.stop_reason ?? "single-sample",
    stop_detail: opts.stop_detail ?? null,
    samples_with_read_errors: opts.samples_with_read_errors ?? 0,
    unknown_run_observations: opts.unknown_run_observations ?? 0,
    error: opts.error ?? null,
  };
}

function writeObservation(obsDir: string, opts: {
  samples: any[];
  observer?: any;
  rawSamplesText?: string | null;
  omitSamples?: boolean;
  omitObserver?: boolean;
}): void {
  fs.mkdirSync(obsDir, { recursive: true });
  if (opts.omitSamples !== true) {
    const text = opts.rawSamplesText !== null && opts.rawSamplesText !== undefined
      ? opts.rawSamplesText
      : opts.samples.map((s) => JSON.stringify(s)).join("\n");
    fs.writeFileSync(path.join(obsDir, "samples.jsonl"), text.endsWith("\n") ? text : `${text}\n`);
  }
  if (opts.omitObserver !== true) {
    fs.writeFileSync(path.join(obsDir, "observer.json"), `${JSON.stringify(opts.observer ?? defaultObserver(), null, 2)}\n`);
  }
}

function hashSet(files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) out[file] = fs.existsSync(file) ? sha256File(file) : "<absent>";
  return out;
}

// ── Pure helpers: shared export sanity ─────────────────────────────

describe("tier-2 STORM-I US-003 — tt-contention-slice summarize (honest summary)", () => {
  it("parseSamplesEvidence separates valid samples from corrupt lines (never silently dropped)", () => {
    const text = [
      JSON.stringify(sampleRecord(0, T0, { cases: [], runs: {} })),
      "this is { not json",
      "",
      JSON.stringify(sampleRecord(1, timestamp(Date.parse(T0), 15000), { cases: [], runs: {} })),
      "{ \"sample_index\": \"nope\" }", // structurally invalid record
    ].join("\n");
    const parsed = parseSamplesEvidence(text);
    assert.equal(parsed.samples.length, 2, "the two well-formed records are kept");
    assert.equal(parsed.samples[0].sample_index, 0);
    assert.equal(parsed.samples[1].sample_index, 1);
    assert.equal(parsed.corruptLines.length, 2, "both corrupt lines are reported");
    assert.equal(parsed.corruptLines[0].line, 2);
    assert.match(parsed.corruptLines[0].error, /not valid JSON/);
    assert.equal(parsed.corruptLines[1].line, 5);
    assert.match(parsed.corruptLines[1].error, /not a well-formed sample record/);
  });

  it("configured concurrency (controller argv 4) is reported separately from the observed claimed-step peak", () => {
    const at = timestamp(Date.parse(T0), 0);
    const runIdsByCase = [[R1], [R2], [R3]];
    const runningCases = [CASE_A, CASE_B, CASE_C].map((caseId, i) =>
      caseEntry(caseId, { phase: "running", runIds: runIdsByCase[i] }));
    const sample = sampleRecord(0, at, {
      cases: [...runningCases, caseEntry(CASE_D, { phase: "pending" })],
      runs: {
        [R1]: runEntry(R1, { claimed: 1 }),
        [R2]: runEntry(R2, { running: 1 }),
        [R3]: runEntry(R3, { claimed: 1 }),
      },
    });
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver({ sample_count: 1 }),
      samples: [sample],
    });
    // Configured vs observed live in separate fields.
    assert.equal(summary.configured.concurrency, 4);
    assert.equal(summary.configured.stagger, "10s");
    assert.equal(summary.configured.source, "recorded controller argv (--concurrency)");
    assert.equal(summary.observed.claimed_step_peak, 3, "observed step peak = 3 claimed/running steps across the scoped runs");
    assert.equal(summary.observed.claimed_run_peak, 3, "three scoped runs carry claimed work");
    assert.equal(summary.observed.peak_sample_index, 0);
    assert.equal(summary.observed.valid_sample_count, 1);
    assert.equal(summary.observed.corrupt_line_count, 0);
    assert.equal(summary.observed.late_observer_start, false);
    assert.equal(summary.observed.overlapped_active_work, true);
    assert.equal(summary.honesty.observed_peak_below_three, false);
    assert.equal(summary.honesty.evidence_insufficient, false);
    assert.equal(summary.honesty.storm_claim_supported, true);
    // Per-case history: three running cases executed, the pending one not.
    assert.equal(summary.per_case[CASE_A].executed, true);
    assert.equal(summary.per_case[CASE_A].final_phase, "running");
    assert.equal(summary.per_case[CASE_D].executed, false);
    assert.equal(summary.per_case[CASE_D].final_phase, "pending");
    assert.equal(summary.counts.executed_cases, 3);
    // The rendered text states both numbers separately.
    const text = renderSummaryText(summary);
    assert.match(text, /case concurrency: 4/);
    assert.match(text, /observed claimed-step peak: 3/);
  });

  it("honest low-peak reporting: a peak below 3 is stated explicitly with no unqualified passed-storm claim", () => {
    const sample = sampleRecord(0, T0, {
      cases: [
        caseEntry(CASE_A, { phase: "running", runIds: [R1] }),
        caseEntry(CASE_B, { phase: "running", runIds: [R2] }),
        caseEntry(CASE_C, { phase: "pending" }),
        caseEntry(CASE_D, { phase: "pending" }),
      ],
      runs: {
        [R1]: runEntry(R1, { claimed: 1 }),
        [R2]: runEntry(R2, { running: 1 }),
      },
    });
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver(),
      samples: [sample],
    });
    assert.equal(summary.observed.claimed_step_peak, 2, "peak 2 < 3");
    assert.equal(summary.honesty.observed_peak_below_three, true);
    assert.equal(summary.honesty.storm_claim_supported, false);
    assert.ok(summary.honesty.reasons.some((r: string) => r.includes("below 3")),
      `reasons must call out the low peak: ${summary.honesty.reasons.join(" | ")}`);
    assert.match(summary.honesty.verdict, /NO UNQUALIFIED PASSED-STORM CLAIM/);
    assert.doesNotMatch(summary.honesty.verdict, /OBSERVED CONTENTION SUPPORTED/);
    const text = renderSummaryText(summary);
    assert.match(text, /Honesty verdict: NO UNQUALIFIED PASSED-STORM CLAIM/);
  });

  it("insufficient evidence: a late observer start (first sample already terminal) cannot manufacture simultaneity proof", () => {
    const sample = sampleRecord(0, T0, {
      allTerminal: true,
      cases: [
        caseEntry(CASE_A, { phase: "terminal", outcome: "PASS", runIds: [R1], attemptsTerminalPhase: "terminal" }),
        caseEntry(CASE_B, { phase: "terminal", outcome: "PASS", runIds: [R2], attemptsTerminalPhase: "terminal" }),
        caseEntry(CASE_C, { phase: "terminal", outcome: "NOT_RUN" }),
        caseEntry(CASE_D, { phase: "terminal", outcome: "NOT_RUN" }),
      ],
      runs: {
        [R1]: runEntry(R1, { status: "completed", terminal: true }),
        [R2]: runEntry(R2, { status: "failed", terminal: true }),
      },
    });
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver({ stop_reason: "all-cases-terminal", first_sample_all_terminal: true, sample_count: 1 }),
      samples: [sample],
    });
    assert.equal(summary.observed.claimed_step_peak, 0);
    assert.equal(summary.observed.late_observer_start, true);
    assert.equal(summary.observed.overlapped_active_work, false);
    assert.equal(summary.honesty.storm_claim_supported, false);
    assert.ok(summary.honesty.reasons.some((r: string) => r.includes("started after the campaign was already terminal")),
      `late start must be a reason: ${summary.honesty.reasons.join(" | ")}`);
    assert.match(summary.honesty.verdict, /NO UNQUALIFIED PASSED-STORM CLAIM/);
    // Terminal/NOT_RUN counting on the same sample.
    assert.equal(summary.counts.terminal_cases, 4);
    assert.equal(summary.counts.not_run_cases, 2);
    assert.equal(summary.counts.executed_cases, 2);
    assert.equal(summary.per_case[CASE_A].terminal, true);
    assert.equal(summary.per_case[CASE_A].executed, true);
    assert.equal(summary.per_case[CASE_A].not_run, false);
    assert.equal(summary.per_case[CASE_C].terminal, true);
    assert.equal(summary.per_case[CASE_C].executed, false, "a NOT_RUN case is never executed");
    assert.equal(summary.per_case[CASE_C].not_run, true);
    assert.equal(summary.per_case[CASE_C].final_outcome, "NOT_RUN");
  });

  it("coverage gaps: a missed interval between samples is reported (late/wide sample cadence)", () => {
    const base = Date.parse(T0);
    const mk = (index: number, offsetMs: number, runningIds: string[]): any => sampleRecord(index, timestamp(base, offsetMs), {
      cases: [
        caseEntry(CASE_A, { phase: "running", runIds: [runningIds[0]] }),
        caseEntry(CASE_B, { phase: "running", runIds: [runningIds[1]] }),
        caseEntry(CASE_C, { phase: "pending" }),
        caseEntry(CASE_D, { phase: "pending" }),
      ],
      runs: {
        [runningIds[0]]: runEntry(runningIds[0], { claimed: 1 }),
        [runningIds[1]]: runEntry(runningIds[1], { running: 1 }),
      },
    });
    // t0, t0+15s (normal cadence), then a 40s gap (a missed 15s beat).
    const samples = [
      mk(0, 0, [R1, R2]),
      mk(1, 15_000, [R1, R2]),
      mk(2, 55_000, [R1, R2]),
    ];
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver({ sample_count: 3, stop_reason: "all-cases-terminal", first_sample_all_terminal: false }),
      samples,
    });
    assert.equal(summary.coverage.missed_intervals.length, 1, "one missed interval across the 40s gap");
    const missed = summary.coverage.missed_intervals[0];
    assert.equal(missed.from_sample_index, 1);
    assert.equal(missed.to_sample_index, 2);
    assert.equal(missed.expected_cadence_ms, 15000);
    assert.equal(summary.observed.claimed_step_peak, 2, "the gap never changes the observed peak (2 < 3)");
    assert.equal(summary.honesty.observed_peak_below_three, true);
    const text = renderSummaryText(summary);
    assert.match(text, /missed intervals: 1/);
  });

  it("decoy exclusion: an unrelated run id never contributes to the peak even when it carries claimed steps", () => {
    const sample = sampleRecord(0, T0, {
      cases: [
        caseEntry(CASE_A, { phase: "running", runIds: [R1] }),
        caseEntry(CASE_B, { phase: "running", runIds: [R2] }),
        caseEntry(CASE_C, { phase: "running", runIds: [R3] }),
        caseEntry(CASE_D, { phase: "pending" }),
      ],
      runs: {
        [R1]: runEntry(R1, { claimed: 1 }),
        [R2]: runEntry(R2, { running: 1 }),
        [R3]: runEntry(R3, { claimed: 1 }),
        // A forged/decoy entry NOT recorded on any selected case's attempts.
        [DECOY]: runEntry(DECOY, { claimed: 9, caseIds: ["some-unrelated-run"] }),
      },
    });
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver(),
      samples: [sample],
    });
    assert.equal(summary.observed.claimed_step_peak, 3, "the decoy's 9 steps are excluded");
    assert.equal(summary.observed.claimed_run_peak, 3);
    assert.equal(summary.evidence.decoy_run_ids_excluded.length, 1);
    assert.match(summary.evidence.decoy_run_ids_excluded[0].run_id, /9999/);
    assert.equal(summary.evidence.data_mismatches.length, 0,
      "a genuine sample carries consistent aggregates — no forged inflation");
    // Honest: tampered evidence can never support an unqualified claim.
    assert.equal(summary.honesty.storm_claim_supported, false);
    assert.ok(summary.honesty.reasons.some((r: string) => r.includes("decoy/unrelated run id")),
      `decoy exclusion must be a reason: ${summary.honesty.reasons.join(" | ")}`);
  });

  it("forged aggregate inflation is flagged as a data mismatch and never moves the peak", () => {
    const sample = sampleRecord(0, T0, {
      cases: [
        caseEntry(CASE_A, { phase: "running", runIds: [R1] }),
        caseEntry(CASE_B, { phase: "running", runIds: [R2] }),
        caseEntry(CASE_C, { phase: "pending" }),
        caseEntry(CASE_D, { phase: "pending" }),
      ],
      runs: {
        [R1]: runEntry(R1, { claimed: 1 }),
        [R2]: runEntry(R2, { running: 1 }),
        [DECOY]: runEntry(DECOY, { claimed: 9, caseIds: [] }),
      },
    });
    // Tamper: claim a much higher aggregate than the scoped runs support.
    sample.aggregates.claimed_step_count = 11;
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver(),
      samples: [sample],
    });
    assert.equal(summary.observed.claimed_step_peak, 2, "the peak comes from the recomputed scoped runs, never the forged aggregate");
    assert.equal(summary.evidence.decoy_run_ids_excluded.length, 1);
    assert.equal(summary.evidence.data_mismatches.length, 1);
    const mismatch = summary.evidence.data_mismatches[0];
    assert.equal(mismatch.field, "claimed_step_count");
    assert.equal(mismatch.aggregate_value, 11);
    assert.equal(mismatch.recomputed_value, 2);
    assert.equal(summary.honesty.storm_claim_supported, false);
    assert.ok(summary.honesty.reasons.some((r: string) => r.includes("disagree between recorded aggregates and recomputed scoped counts")));
  });

  it("partial-observation summaries: an observer that recorded an error still yields an honest, never-overclaiming summary", () => {
    const sample = sampleRecord(0, T0, {
      cases: [
        caseEntry(CASE_A, { phase: "running", runIds: [R1] }),
        caseEntry(CASE_B, { phase: "running", runIds: [R2] }),
        caseEntry(CASE_C, { phase: "pending" }),
        caseEntry(CASE_D, { phase: "pending" }),
      ],
      runs: {
        [R1]: runEntry(R1, { claimed: 1 }),
        [R2]: runEntry(R2, { running: 1 }),
      },
    });
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver({
        stop_reason: "observer-error",
        error: "sample observation failed after 1 sample(s)",
      }),
      samples: [sample],
    });
    assert.equal(summary.observed.valid_sample_count, 1, "partial evidence is preserved");
    assert.equal(summary.observed.claimed_step_peak, 2);
    assert.equal(summary.evidence.clean, false);
    assert.ok(summary.honesty.reasons.some((r: string) => r.includes("the observer recorded an error")),
      `observer error must forbid an unqualified claim: ${summary.honesty.reasons.join(" | ")}`);
    assert.equal(summary.honesty.storm_claim_supported, false);
    assert.match(summary.honesty.verdict, /NO UNQUALIFIED PASSED-STORM CLAIM/);
    const text = renderSummaryText(summary);
    assert.match(text, /Honesty verdict: NO UNQUALIFIED PASSED-STORM CLAIM/);
    assert.match(text, /clean: no/);
  });

  it("UNKNOWN run observations recorded in the samples forbid an unqualified claim", () => {
    const sample = sampleRecord(0, T0, {
      cases: [
        caseEntry(CASE_A, { phase: "running", runIds: [R1] }),
        caseEntry(CASE_B, { phase: "pending" }),
        caseEntry(CASE_C, { phase: "pending" }),
        caseEntry(CASE_D, { phase: "pending" }),
      ],
      runs: {
        // The scoped run row is missing from the DB: present false/missing.
        [R1]: runEntry(R1, { present: false, missing: true }),
      },
      unknownRunIds: [R1],
      observationErrors: ["run row missing for scoped run"],
    });
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver(),
      samples: [sample],
    });
    assert.equal(summary.observed.claimed_step_peak, 0);
    assert.equal(summary.evidence.clean, false);
    assert.equal(summary.evidence.unknown_run_sample_indices.length, 1);
    assert.equal(summary.honesty.storm_claim_supported, false);
    assert.ok(summary.honesty.reasons.some((r: string) => r.includes("UNKNOWN run observations")),
      `UNKNOWN runs must be a reason: ${summary.honesty.reasons.join(" | ")}`);
  });

  it("a sample that does not bind to the prepared manifest is evidence of tampering, never a clean pass", () => {
    const sample = sampleRecord(0, T0, {
      cases: [
        caseEntry(CASE_A, { phase: "running", runIds: [R1] }),
        caseEntry(CASE_B, { phase: "running", runIds: [R2] }),
        caseEntry(CASE_C, { phase: "running", runIds: [R3] }),
        caseEntry(CASE_D, { phase: "pending" }),
      ],
      runs: {
        [R1]: runEntry(R1, { claimed: 1 }),
        [R2]: runEntry(R2, { running: 1 }),
        [R3]: runEntry(R3, { claimed: 1 }),
      },
      prepSha: "deadbeef",
    });
    const summary = buildContentionSummary({
      selectedCaseIds: SELECTED_IDS,
      configured: { concurrency: 4, stagger: "10s", argv: ["tt-controller", "--concurrency", "4"], source: "recorded controller argv (--concurrency)" },
      observer: defaultObserver(),
      samples: [sample],
      prepManifestSha256: "f".repeat(64),
    });
    assert.equal(summary.evidence.prep_binding_mismatches.length, 1);
    assert.equal(summary.evidence.clean, false);
    assert.equal(summary.honesty.storm_claim_supported, false);
    assert.ok(summary.honesty.reasons.some((r: string) => r.includes("do not bind to the prepared manifest")));
  });

  // ── CLI-level gates ──────────────────────────────────────────────

  it("summarize consumes a prepared dir + observation dir, writes summary.json/.txt into the observation dir, and mutates nothing else", () => {
    const root = scratchDir("cli-ok");
    try {
      const { prep, manifestSha256 } = buildPrep(root);
      const obs = path.join(root, "obs");
      const base = Date.parse(T0);
      const mk = (index: number, offsetMs: number): any => sampleRecord(index, timestamp(base, offsetMs), {
        cases: [
          caseEntry(CASE_A, { phase: "running", runIds: [R1] }),
          caseEntry(CASE_B, { phase: "running", runIds: [R2] }),
          caseEntry(CASE_C, { phase: "running", runIds: [R3] }),
          caseEntry(CASE_D, { phase: "pending" }),
        ],
        runs: {
          [R1]: runEntry(R1, { claimed: 1 }),
          [R2]: runEntry(R2, { running: 1 }),
          [R3]: runEntry(R3, { claimed: 1 }),
        },
        prepSha: manifestSha256,
      });
      const samples = [
        mk(0, 0),
        mk(1, 15_000),
        mk(2, 30_000),
      ];
      writeObservation(obs, {
        samples,
        observer: defaultObserver({ sample_count: 3, stop_reason: "window-expired", window_ms: 45000 }),
      });
      // A campaign DB sits next to the observation (summarize never opens it).
      const dbPath = path.join(root, "tamandua.db");
      fs.writeFileSync(dbPath, "not-a-real-campaign-db-fixture");
      const files = [
        path.join(prep, "manifest.jsonl"),
        path.join(prep, "provenance.json"),
        path.join(obs, "samples.jsonl"),
        path.join(obs, "observer.json"),
        dbPath,
      ];
      const before = hashSet(files);
      const res = runCli(["summarize", "--prep", prep, "--obs", obs]);
      assert.equal(res.status, 0, `summarize must exit 0:\n${res.stdout}${res.stderr}`);
      // Output artifacts live in the observation directory.
      assert.ok(fs.existsSync(path.join(obs, "summary.json")), "summary.json written into the observation dir");
      assert.ok(fs.existsSync(path.join(obs, "summary.txt")), "summary.txt written into the observation dir");
      const summary = loadJson(path.join(obs, "summary.json"));
      assert.equal(summary.subcommand, "summarize");
      assert.equal(summary.configured.concurrency, 4);
      assert.equal(summary.observed.claimed_step_peak, 3);
      assert.equal(summary.honesty.storm_claim_supported, true, "peak 3 with clean evidence supports the interim simultaneity claim");
      const text = fs.readFileSync(path.join(obs, "summary.txt"), "utf8");
      assert.match(text, /OBSERVED CONTENTION SUPPORTED/);
      // Nothing outside the summary artifacts was touched.
      assert.deepEqual(hashSet(files), before, "prep/samples/observer/campaign-DB bytes must not change");
    } finally {
      rmrf(root);
    }
  });

  it("corrupt sample evidence is reported and a partial summary is still produced; an all-corrupt or missing samples file exits non-zero", () => {
    // (a) one corrupt line among valid samples: reported, summary exit 0.
    const rootA = scratchDir("cli-corrupt-line");
    try {
      const { prep } = buildPrep(rootA);
      const obs = path.join(rootA, "obs");
      const good = sampleRecord(0, T0, {
        cases: [caseEntry(CASE_A, { phase: "running", runIds: [R1] })],
        runs: { [R1]: runEntry(R1, { claimed: 1 }) },
      });
      writeObservation(obs, {
        samples: [good],
        rawSamplesText: `${JSON.stringify(good)}\nnot json at all\n`,
        observer: defaultObserver(),
      });
      const res = runCli(["summarize", "--prep", prep, "--obs", obs]);
      assert.equal(res.status, 0, "a corrupt line among valid samples is evidence, not a hard failure");
      const summary = loadJson(path.join(obs, "summary.json"));
      assert.equal(summary.observed.valid_sample_count, 1);
      assert.equal(summary.observed.corrupt_line_count, 1);
      assert.match(summary.evidence.corrupt_lines[0].error, /not valid JSON/);
      assert.equal(summary.evidence.clean, false);
      assert.equal(summary.honesty.storm_claim_supported, false);
      assert.ok(fs.existsSync(path.join(obs, "summary.txt")), "the partial summary text is preserved");
    } finally {
      rmrf(rootA);
    }

    // (b) missing samples.jsonl: partial summary + non-zero exit.
    const rootB = scratchDir("cli-missing-samples");
    try {
      const { prep } = buildPrep(rootB);
      const obs = path.join(rootB, "obs");
      writeObservation(obs, { samples: [], omitSamples: true, observer: defaultObserver() });
      const res = runCli(["summarize", "--prep", prep, "--obs", obs]);
      assert.notEqual(res.status, 0, "a missing samples file is an evidence failure");
      const summary = loadJson(path.join(obs, "summary.json"));
      assert.equal(summary.observed.samples_file_present, false);
      assert.equal(summary.observed.valid_sample_count, 0);
      assert.ok(summary.honesty.reasons.some((r: string) => r.includes("samples.jsonl is missing")));
      assert.equal(summary.honesty.storm_claim_supported, false);
      assert.match(summary.honesty.verdict, /NO UNQUALIFIED PASSED-STORM CLAIM/);
      assert.ok(fs.existsSync(path.join(obs, "summary.txt")), "the partial summary is preserved");
    } finally {
      rmrf(rootB);
    }

    // (c) an all-corrupt samples file: partial summary + non-zero exit.
    const rootC = scratchDir("cli-all-corrupt");
    try {
      const { prep } = buildPrep(rootC);
      const obs = path.join(rootC, "obs");
      writeObservation(obs, { samples: [], rawSamplesText: "{ broken\nstill broken\n", observer: defaultObserver() });
      const res = runCli(["summarize", "--prep", prep, "--obs", obs]);
      assert.notEqual(res.status, 0, "zero readable samples is an evidence failure");
      const summary = loadJson(path.join(obs, "summary.json"));
      assert.equal(summary.observed.corrupt_line_count, 2);
      assert.equal(summary.observed.valid_sample_count, 0);
      assert.equal(summary.honesty.storm_claim_supported, false);
      assert.ok(fs.existsSync(path.join(obs, "summary.txt")));
    } finally {
      rmrf(rootC);
    }
  });

  it("summarize never overwrites an existing summary.json and has no campaign-DB option", () => {
    const root = scratchDir("cli-nooverwrite");
    try {
      const { prep, manifestSha256 } = buildPrep(root);
      const obs = path.join(root, "obs");
      writeObservation(obs, {
        samples: [sampleRecord(0, T0, {
          cases: [caseEntry(CASE_A, { phase: "running", runIds: [R1] })],
          runs: { [R1]: runEntry(R1, { claimed: 1 }) },
          prepSha: manifestSha256,
        })],
        observer: defaultObserver(),
      });
      const summaryPath = path.join(obs, "summary.json");
      const txtPath = path.join(obs, "summary.txt");

      // First summarize succeeds.
      let res = runCli(["summarize", "--prep", prep, "--obs", obs]);
      assert.equal(res.status, 0, `first summarize:\n${res.stdout}${res.stderr}`);
      const samplesHash = sha256File(path.join(obs, "samples.jsonl"));
      const observerHash = sha256File(path.join(obs, "observer.json"));
      const summaryHash = sha256File(summaryPath);
      const txtHash = sha256File(txtPath);
      const existingSummary = fs.readFileSync(summaryPath, "utf8");

      // A second summarize refuses to overwrite the existing summary.
      res = runCli(["summarize", "--prep", prep, "--obs", obs]);
      assert.notEqual(res.status, 0, "an existing summary.json must be refused");
      assert.match(res.stderr, /refusing to overwrite an existing summary/);
      assert.equal(fs.readFileSync(summaryPath, "utf8"), existingSummary, "the existing summary bytes are untouched");
      assert.equal(sha256File(summaryPath), summaryHash, "the existing summary.json bytes are untouched");
      assert.equal(sha256File(txtPath), txtHash, "the existing summary.txt bytes are untouched");
      assert.equal(sha256File(path.join(obs, "samples.jsonl")), samplesHash);
      assert.equal(sha256File(path.join(obs, "observer.json")), observerHash);

      // No --db option exists: summarize cannot open/mutate a campaign DB.
      res = runCli(["summarize", "--prep", prep, "--obs", obs, "--db", path.join(root, "campaign.db")]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /unknown summarize option/);
      assert.equal(sha256File(summaryPath), summaryHash, "the refusal writes nothing");
      assert.equal(sha256File(txtPath), txtHash);
    } finally {
      rmrf(root);
    }
  });

  it("path escapes are refused BEFORE any write, and a non-observation dir is rejected", () => {
    const root = scratchDir("cli-escapes");
    try {
      const { prep, manifestSha256 } = buildPrep(root);
      const obs = path.join(root, "obs");
      writeObservation(obs, {
        samples: [sampleRecord(0, T0, {
          cases: [caseEntry(CASE_A, { phase: "running", runIds: [R1] })],
          runs: { [R1]: runEntry(R1, { claimed: 1 }) },
          prepSha: manifestSha256,
        })],
        observer: defaultObserver(),
      });
      const obsListing = fs.readdirSync(obs).sort();

      // (a) --obs outside torture-test/var.
      const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-sum-outside-")), "obs");
      fs.mkdirSync(outside, { recursive: true });
      let res = runCli(["summarize", "--prep", prep, "--obs", outside]);
      assert.notEqual(res.status, 0, "an observation dir outside var must be refused");
      assert.match(res.stderr, /outside the contained root/);
      assert.deepEqual(fs.readdirSync(outside), [], "nothing may be written outside var");
      rmrf(path.dirname(outside));

      // (b) --prep traversal.
      const traversal = `${prep}/../..//../../escape-${process.pid}-${Date.now()}`;
      res = runCli(["summarize", "--prep", traversal, "--obs", obs]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /path-traversal/);
      assert.deepEqual(fs.readdirSync(obs).sort(), obsListing, "no summary written on refusal");

      // (c) --obs through a symlink that escapes var.
      const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-sum-esc-"));
      const link = path.join(varRoot, `tier2-cs-sum-esclink-${process.pid}-${Date.now()}`);
      fs.symlinkSync(escapeTarget, link);
      res = runCli(["summarize", "--prep", prep, "--obs", path.join(link, "obs")]);
      assert.notEqual(res.status, 0, "a symlink-escape observation dir must be refused");
      assert.match(res.stderr, /symlink/);
      rmrf(link);
      rmrf(escapeTarget);

      // (d) missing --prep / --obs arguments are rejected.
      res = runCli(["summarize", "--prep", prep]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /requires --obs/);

      // (e) an observation dir with neither samples.jsonl nor observer.json is
      // not a US-002 output.
      const emptyObs = path.join(root, "empty-obs");
      fs.mkdirSync(emptyObs, { recursive: true });
      res = runCli(["summarize", "--prep", prep, "--obs", emptyObs]);
      assert.notEqual(res.status, 0, "an empty dir is not an observation output");
      assert.match(res.stderr, /carries neither samples\.jsonl nor observer\.json/);
      assert.deepEqual(fs.readdirSync(emptyObs).sort(), [], "nothing written into the rejected dir");

      // (f) a symlinked samples.jsonl / observer.json INSIDE the observation
      // dir is a symlink escape and is refused before any read/write.
      const evidenceTarget = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-sum-evidence-"));
      fs.writeFileSync(path.join(evidenceTarget, "samples.jsonl"), JSON.stringify(sampleRecord(0, T0, { cases: [], runs: {} })));
      const linkSamples = path.join(obs, "samples.jsonl");
      fs.renameSync(linkSamples, path.join(obs, "samples.jsonl.real"));
      fs.symlinkSync(path.join(evidenceTarget, "samples.jsonl"), linkSamples);
      try {
        res = runCli(["summarize", "--prep", prep, "--obs", obs]);
        assert.notEqual(res.status, 0, "a symlinked samples file must be refused");
        assert.match(res.stderr, /symlink/);
        assert.ok(!fs.existsSync(path.join(obs, "summary.json")), "no summary written through the escaping symlink");
      } finally {
        fs.unlinkSync(linkSamples);
        fs.renameSync(path.join(obs, "samples.jsonl.real"), linkSamples);
      }
      const observerPath = path.join(obs, "observer.json");
      const observerReal = `${observerPath}.real`;
      fs.renameSync(observerPath, observerReal);
      fs.symlinkSync(path.join(evidenceTarget, "samples.jsonl"), observerPath);
      try {
        res = runCli(["summarize", "--prep", prep, "--obs", obs]);
        assert.notEqual(res.status, 0, "a symlinked observer record must be refused");
        assert.match(res.stderr, /observer\.json is not a plain regular file/);
        assert.ok(!fs.existsSync(path.join(obs, "summary.json")), "no summary written through the escaping observer symlink");
      } finally {
        fs.unlinkSync(observerPath);
        fs.renameSync(observerReal, observerPath);
      }
      assert.deepEqual(fs.readdirSync(obs).sort(), obsListing, "the observation dir is back to its original listing");
      rmrf(evidenceTarget);
    } finally {
      rmrf(root);
    }
  });

  it("no-argument and --help keep their zero-side-effect behavior and usage mentions summarize options", () => {
    const noArgs = runCli([]);
    assert.equal(noArgs.status, 0);
    assert.match(noArgs.stdout, /summarize/);
    const help = runCli(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--obs <dir>/);
    assert.match(help.stdout, /summary\.json and\s*\n?\s*summary\.txt/);
    const subHelp = runCli(["summarize", "--help"]);
    assert.equal(subHelp.status, 0);
    assert.match(subHelp.stdout, /Commands:/);
    // Unknown summarize option is rejected.
    const unknown = runCli(["summarize", "--nope"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown summarize option/);
  });

  it("a late-start observation produced by the real sampler is summarized honestly end-to-end (observer already terminal)", () => {
    // Replays the sample test's all-terminal fixture shape through summarize:
    // the observer's first (only) sample is all-terminal — this can never
    // manufacture simultaneity proof.
    const root = scratchDir("cli-late");
    try {
      const { prep, manifestSha256 } = buildPrep(root);
      const obs = path.join(root, "obs");
      const sample = sampleRecord(0, T0, {
        allTerminal: true,
        cases: [
          caseEntry(CASE_A, { phase: "terminal", outcome: "PASS", runIds: [R1], attemptsTerminalPhase: "terminal" }),
          caseEntry(CASE_B, { phase: "terminal", outcome: "FAIL", runIds: [R2], attemptsTerminalPhase: "terminal" }),
          caseEntry(CASE_C, { phase: "terminal", outcome: "NOT_RUN" }),
          caseEntry(CASE_D, { phase: "terminal", outcome: "NOT_RUN" }),
        ],
        runs: {
          [R1]: runEntry(R1, { status: "completed", terminal: true }),
          [R2]: runEntry(R2, { status: "failed", terminal: true }),
        },
        prepSha: manifestSha256,
      });
      writeObservation(obs, {
        samples: [sample],
        observer: defaultObserver({ stop_reason: "all-cases-terminal", first_sample_all_terminal: true, sample_count: 1 }),
      });
      const res = runCli(["summarize", "--prep", prep, "--obs", obs]);
      assert.equal(res.status, 0, `summarize must exit 0:\n${res.stdout}${res.stderr}`);
      const summary = loadJson(path.join(obs, "summary.json"));
      assert.equal(summary.observed.late_observer_start, true);
      assert.equal(summary.observed.claimed_step_peak, 0);
      assert.equal(summary.honesty.storm_claim_supported, false);
      assert.equal(summary.counts.executed_cases, 2);
      assert.equal(summary.counts.not_run_cases, 2);
      assert.equal(summary.counts.terminal_cases, 4);
      const text = fs.readFileSync(path.join(obs, "summary.txt"), "utf8");
      assert.match(text, /NO UNQUALIFIED PASSED-STORM CLAIM/);
      assert.doesNotMatch(text, /OBSERVED CONTENTION SUPPORTED/);
    } finally {
      rmrf(root);
    }
  });
});
