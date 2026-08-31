// S34 (US-002) — deadline-sweep grace contract: never void a terminal-reached
// attempt (race red/green).
//
// The 2026-08-30 targeted re-run (single-case campaigns, one per cell) left
// three cells TEST_INFRA_FAIL 'deadline-expired' on a sub-5s margin — the
// attempt deadline and the independent deadline sweep (US-005,
// sweepDeadlineExpiredAttempts) raced within seconds and the sweep voided the
// attempt even though the run had genuinely reached terminal just past its
// deadline:
//   * W4.10-kill-daemon     campaign-20260830T065151712Z-37c54c06:
//     `attempt deadline 2026-08-30T07:46:57.458Z expired 4s before the
//     independent deadline sweep observed it (observed_at
//     2026-08-30T07:47:02.230Z)`
//   * W4.48a-daemon-kill-mid-park campaign-20260830T090310754Z-6d67693d:
//     `... expired 3s before ... (observed_at 2026-08-30T09:58:19.604Z)`
//   * W4.37-keyline-spoof-repo-content campaign-20260830T111549750Z-ac1e0b86:
//     `... expired 0s before ... (observed_at 2026-08-30T11:20:55.663Z)`
//
// Root cause: the pre-fix sweep voided ANY workflow attempt whose deadline_at
// was in the past and whose outcome was not yet recorded — with NO
// terminal-evidence check. A run that completed 0-4s past its deadline was
// therefore voided TEST_INFRA_FAIL before the in-flight monitor could settle
// the honest PASS / PRODUCT_FAIL outcome.
//
// Fix (US-002, files ONLY under torture-test/): before voiding an expired
// attempt, sweepDeadlineExpiredAttempts checks whether the attempt reached
// terminal within the documented grace window after its deadline_at (new
// option deadline_grace_ms, env TT_CONTROLLER_DEADLINE_GRACE_MS, default
// 30000; 0 disables — wired through options validation + state.options
// exactly like deadline_sweep_interval_ms). Terminal evidence is (a) an
// attempt already carrying terminal evidence, or (b) a run whose status is
// terminal via the existing terminal-evidence status leg. Terminal-within-
// grace attempts are NOT swept — the in-flight monitor settles the honest
// outcome. A genuinely-hung attempt (no terminal evidence within grace) is
// still swept fail-closed exactly as before, preserving the deadline-expired
// evidence fields (deadline_at, expired_for_seconds, run_id, observed_at) and
// the best-effort workflow stop. Unprovable evidence (no run id, spawn-env
// failure, status-query failure) is NOT a deferral — the grace skip is a
// positive proof of terminal-within-grace, never a weakening of the sweep.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC1): pins the campaign evidence lines verbatim and reproduces
//     the PRE-FIX sweep criterion inline (history-independent — embedded
//     here, never resolved from git) against the terminal-reached fixture
//     shape (deadline 4s past, status 'completed'): the pre-fix sweep VOIDS
//     it — the exact S34 race;
//   * GREEN-ARM (AC2): the FIXED controller, resumed on the same fixture with
//     a stub `tamandua workflow status` reporting terminal 'completed' just
//     after the deadline, does NOT void the attempt — it classifies with the
//     monitor's honest terminal outcome (PASS, recovery reconciled), and no
//     best-effort `workflow stop` was ever issued;
//   * GREEN-ARM: the SAME fixture with the grace window DISABLED
//     (deadline_grace_ms: 0) is still voided deadline-expired — the live
//     pre-fix race (a terminal-reached attempt voided) reproduced through the
//     post-fix controller;
//   * GREEN-ARM (AC3): a genuinely-hung attempt (stub status keeps 'running')
//     is still swept TEST_INFRA_FAIL 'deadline-expired' with the full
//     evidence fields and the best-effort stop;
//   * FAIL-CLOSED (AC4): an attempt whose deadline is OUTSIDE the grace
//     window (10 min past) is still swept even when the stub status would
//     report 'completed' — and the sweep provably never queried the status
//     (the grace gate short-circuits once the window has elapsed);
//   * VALIDATION: a persisted deadline_grace_ms of -1 rejects the resume
//     (campaign options are missing or invalid);
//   * WIRING: a fresh campaign created with TT_CONTROLLER_DEADLINE_GRACE_MS
//     persists it into state.options.deadline_grace_ms exactly like
//     deadline_sweep_interval_ms.
//
// The controller runs with TT_CONTROLLER_PREFLIGHT_DISABLED=1 and the
// S32 hermeticity seam TT_CONTROLLER_SPAWN_HOME_OVERRIDE pointing at a
// per-test temp contained home (empty runs table) — the SHARED
// var/home/.tamandua is never read or written (asserted byte/mtime-identical
// before vs after).
//
// Follows the tier2-s28-*.test.ts self-test pattern (imports node builtins +
// repo-relative files only); picked up by self-tests/run.sh's tier2 glob.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(ttRoot, "bin", "tt-controller");

// ── Pinned rerun evidence (read-only, campaign-20260830T* single-case reruns) ──
// The deadline-expired report messages, verbatim (report.txt):
const W4_10_CAMPAIGN = "campaign-20260830T065151712Z-37c54c06-b903-40d4-affc-c52939362479";
const W4_10_MESSAGE =
  "attempt deadline 2026-08-30T07:46:57.458Z expired 4s before the independent deadline sweep observed it (observed_at 2026-08-30T07:47:02.230Z)";
const W4_48A_CAMPAIGN = "campaign-20260830T090310754Z-6d67693d-c123-4a1d-9cdf-41303a1cc44c";
const W4_48A_MESSAGE =
  "attempt deadline 2026-08-30T09:58:15.991Z expired 3s before the independent deadline sweep observed it (observed_at 2026-08-30T09:58:19.604Z)";
const W4_37_CAMPAIGN = "campaign-20260830T111549750Z-ac1e0b86-34ce-43e0-b026-75b7e3e50fd1";
const W4_37_MESSAGE =
  "attempt deadline 2026-08-30T11:20:55.385Z expired 0s before the independent deadline sweep observed it (observed_at 2026-08-30T11:20:55.663Z)";

// The message TEMPLATE the controller emits (unchanged by the fix), so the
// pinned evidence lines can be asserted to be instances of it:
const DEADLINE_EXPIRED_TEMPLATE =
  /^attempt deadline .+Z expired \d+s before the independent deadline sweep observed it \(observed_at .+Z\)$/;

// ── Pre-fix sweep criterion, reproduced INLINE (history-independent red-arm) ──
// The pre-fix sweepDeadlineExpiredAttempts voided any WORKFLOW attempt whose
// deadline_at was in the past and whose outcome was not yet recorded — with
// NO terminal-evidence check. A run that genuinely reached terminal just past
// its deadline was therefore still voided TEST_INFRA_FAIL 'deadline-expired'
// (the S34 sub-5s race). The criterion is embedded here, never resolved from
// git (tier0-history-independent-red-arms).
function preFixSweepVoidsExpiredAttempt(
  attempt: { kind: string; outcome?: unknown; deadline_at: string },
  nowMs: number,
): boolean {
  if (attempt.kind !== "workflow") return false;
  if (attempt.outcome !== undefined) return false;
  const deadlineMs = new Date(attempt.deadline_at).valueOf();
  if (Number.isNaN(deadlineMs)) return false;
  return deadlineMs < nowMs;
}

// ── Test scaffolding ─────────────────────────────────────────────────────────
function run(
  file: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 180_000,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface FixtureOptions {
  caseId: string;
  // How far in the past the attempt deadline_at is (the S34 sub-5s race
  // shape: seconds past).
  deadlineOffsetMs: number;
  // Persisted options.deadline_grace_ms in the fixture state. 0 disables the
  // grace window (live pre-fix race reproduction).
  graceMs: number;
  // The stub `tamandua workflow status` / `workflow wait` terminal status.
  status: "completed" | "running";
}

const FIXTURE_RUN_ID = `run-${randomUUID()}`;

// Build a resume-able fixture campaign under var/results: state.json with a
// case phase 'running' carrying a workflow attempt whose deadline is
// `deadlineOffsetMs` in the past (the exact crashed-controller leftover shape
// the resume sweep reconciles), plus the manifest it points at. All test
// scratch (manifest, stub, temp contained home) lives under a per-test temp
// dir strictly inside torture-test/var (gitignored); the campaign dir is
// returned and tracked for cleanup.
function buildFixtureCampaign(fx: FixtureOptions, scratchDir: string): string {
  fs.mkdirSync(resultsRoot, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const campaignId = `campaign-s34-grace-${nonce}`;
  const campaignDir = path.join(resultsRoot, campaignId);
  fs.mkdirSync(campaignDir, { recursive: true });

  const manifestPath = path.join(scratchDir, "manifests", `${fx.caseId}.jsonl`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifestRecord = {
    id: fx.caseId,
    wave: 0,
    workflow: "bug-fix-merge-worktree",
    fixture: "tt-ts",
    harness: "hermes",
    task: "tasks/W3.22.md",
    context: {},
    caps: { tokens: 4_000_000, wall_min: 240 },
    requires: {},
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: [],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifestRecord)}\n`);
  const manifestSha = sha256Hex(fs.readFileSync(manifestPath, "utf8"));
  const manifestRel = path.relative(ttRoot, manifestPath).split(path.sep).join("/");

  const startedAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const deadlineAt = new Date(Date.now() - fx.deadlineOffsetMs).toISOString();
  const state = {
    version: 1,
    campaign_id: campaignId,
    phase: "ready",
    created_at: startedAt,
    updated_at: startedAt,
    resume_count: 0,
    resumed_at: [],
    real_preflight: null,
    options: {
      concurrency: 1,
      stagger_ms: 0,
      token_poll_interval_ms: 20,
      cap_check_interval_ms: 20,
      provider_retry_backoff_ms: 0,
      deadline_sweep_interval_ms: 100,
      deadline_grace_ms: fx.graceMs,
      execution_selection: "all",
    },
    spend: { tokens_observed: 0, observations: [] },
    discovered_runs: [],
    manifest: {
      path: manifestRel,
      sha256: manifestSha,
      case_count: 1,
      case_ids: [fx.caseId],
    },
    cases: [
      {
        id: fx.caseId,
        wave: 0,
        workflow: "bug-fix-merge-worktree",
        fixture: "tt-ts",
        harness: "hermes",
        class: "verification",
        replay_of: null,
        production_duration_floor_ms: null,
        expected_fast_failure: false,
        phase: "running",
        attempts: [
          {
            id: "attempt-1",
            case_id: fx.caseId,
            kind: "workflow",
            phase: "running",
            execution_mode: "real",
            launch_intent_at: startedAt,
            started_at: startedAt,
            deadline_at: deadlineAt,
            run_id: FIXTURE_RUN_ID,
          },
        ],
        findings: [],
        oracle_results: [],
        spend: { tokens_observed: 0, observations: [] },
      },
    ],
  };
  fs.writeFileSync(path.join(campaignDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return campaignDir;
}

// Write the deterministic `tamandua` stub (zero tokens): `workflow status` /
// `workflow wait` answer with the given terminal status, `workflow stop` is a
// no-op success. EVERY invocation is appended to `<stubDir>/calls.log` (one
// argv per line) so the test can prove what the sweep/recovery actually
// invoked (e.g. that the outside-grace sweep NEVER queried status).
function writeStub(stubDir: string, status: "completed" | "running"): void {
  fs.mkdirSync(stubDir, { recursive: true });
  const callsLog = path.join(stubDir, "calls.log");
  const stub = `#!/usr/bin/env bash
set -uo pipefail
{
  printf '%s ' "$(date +%s%N)"
  printf '%q ' "$@"
  printf '\\n'
} >> ${JSON.stringify(callsLog)}
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "status" ]; then
  printf '{"runId":"%s","status":"%s","tokensSpent":0,"steps":[]}\\n' "\${3:-}" "${status}"
  exit 0
fi
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "wait" ]; then
  printf '{"runId":"%s","status":"%s","tokensSpent":0,"steps":[]}\\n' "\${3:-}" "${status}"
  exit 0
fi
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "stop" ]; then
  exit 0
fi
exit 0
`;
  fs.writeFileSync(path.join(stubDir, "tamandua"), stub, { mode: 0o755 });
}

// Seed an EMPTY runs table in the temp contained home so the resume's
// discovered-run reconciliation (queryWorkflowRuns) reads a valid contained
// database instead of failing on a missing inventory.
function seedContainedHome(homeDir: string): void {
  const stateDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(stateDir, { recursive: true });
  const database = new DatabaseSync(path.join(stateDir, "tamandua.db"), { open: true });
  database.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
    status TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}',
    tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  database.close();
}

function resumeController(campaignDir: string, stubDir: string, homeDir: string): { status: number | null; stdout: string; stderr: string } {
  return run(controller, ["--resume", path.basename(campaignDir)], {
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
    TT_CONTROLLER_DEADLINE_SWEEP_INTERVAL_MS: "100",
    TT_CONTROLLER_TOKEN_SETTLE_MS: "200",
    TT_CONTROLLER_TRUTH_RECHECK_MS: "20",
    TT_CONTROLLER_SPAWN_HOME_OVERRIDE: homeDir,
  });
}

function loadState(campaignDir: string): any {
  return JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
}

function readCalls(stubDir: string): string[] {
  const callsLog = path.join(stubDir, "calls.log");
  try {
    return fs.readFileSync(callsLog, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function callKinds(stubDir: string): string[] {
  return readCalls(stubDir).map((line) => {
    const tokens = line.trim().split(/\s+/);
    // calls.log line shape: "<ns> workflow <verb> [args...]"
    return tokens[1] === "workflow" ? (tokens[2] ?? "other") : "other";
  });
}

function listCampaigns(): Set<string> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(resultsRoot).filter((name) => name.startsWith("campaign-"));
  } catch {
    // results root absent — no campaigns yet
  }
  return new Set(names);
}

function snapshotSharedHomeDb(): { exists: boolean; bytes: number | null; mtimeMs: number | null } {
  const dbPath = path.join(varRoot, "home", ".tamandua", "tamandua.db");
  try {
    const details = fs.statSync(dbPath);
    return { exists: true, bytes: details.size, mtimeMs: details.mtimeMs };
  } catch {
    return { exists: false, bytes: null, mtimeMs: null };
  }
}

describe("S34 (US-002) — deadline-sweep grace contract: never void a terminal-reached attempt", () => {
  let scratchDir: string;
  let homeDir: string;
  const campaignDirs: string[] = [];
  let sharedHomeDbBefore: { exists: boolean; bytes: number | null; mtimeMs: number | null };

  before(() => {
    fs.mkdirSync(varRoot, { recursive: true });
    scratchDir = fs.mkdtempSync(path.join(varRoot, `s34-grace-${process.pid}-`));
    homeDir = path.join(scratchDir, "contained-home");
    seedContainedHome(homeDir);
    sharedHomeDbBefore = snapshotSharedHomeDb();
    // The wiring arm's fresh campaign provisions a work clone from the tt-ts
    // golden — ensure the golden exists (deterministic, zero tokens, local
    // fixtures-src build) exactly like the deadline-sweep bash battery does.
    const ttTsGolden = path.join(varRoot, "fixtures", "golden", "tt-ts.git");
    if (!fs.existsSync(ttTsGolden)) {
      const boot = run(path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs"), ["--fixture", "tt-ts"]);
      assert.equal(boot.status, 0,
        `tt-golden-bootstrap --fixture tt-ts failed: ${boot.stderr ?? boot.stdout}`);
    }
  });

  after(() => {
    for (const campaignDir of campaignDirs) {
      try {
        fs.rmSync(campaignDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    // The shared var/home/.tamandua DB must be byte/mtime-identical (or both
    // absent) — the S32 hermeticity discipline holds for this test too.
    const afterDb = snapshotSharedHomeDb();
    assert.equal(afterDb.exists, sharedHomeDbBefore.exists,
      "shared var/home/.tamandua/tamandua.db appeared/disappeared — the test must be hermetic");
    if (sharedHomeDbBefore.exists) {
      assert.equal(afterDb.bytes, sharedHomeDbBefore.bytes,
        "shared var/home/.tamandua/tamandua.db content changed — the test must be hermetic");
      assert.equal(afterDb.mtimeMs, sharedHomeDbBefore.mtimeMs,
        "shared var/home/.tamandua/tamandua.db mtime changed — the test must be hermetic");
    }
  });

  it("RED-ARM (AC1): pins the campaign evidence verbatim and reproduces the PRE-FIX sweep criterion inline — it VOIDS a terminal-reached attempt", () => {
    // Pin the three rerun report lines verbatim + their template.
    for (const message of [W4_10_MESSAGE, W4_48A_MESSAGE, W4_37_MESSAGE]) {
      assert.match(message, DEADLINE_EXPIRED_TEMPLATE,
        `the pinned deadline-expired message must match the controller template: ${message}`);
    }
    assert.match(W4_10_MESSAGE, /expired 4s before/);
    assert.match(W4_48A_MESSAGE, /expired 3s before/);
    assert.match(W4_37_MESSAGE, /expired 0s before/);
    assert.match(W4_10_CAMPAIGN, /^campaign-20260830T\d{9}Z-[0-9a-f-]{36}$/);
    assert.match(W4_48A_CAMPAIGN, /^campaign-20260830T\d{9}Z-[0-9a-f-]{36}$/);
    assert.match(W4_37_CAMPAIGN, /^campaign-20260830T\d{9}Z-[0-9a-f-]{36}$/);

    // The terminal-reached fixture shape: deadline 4s in the past, the run
    // completed 'just after the deadline' (the stub status reports
    // 'completed'), outcome not yet recorded — the exact W4.10/W4.48a/W4.37
    // race.
    const terminalReachedAttempt = {
      kind: "workflow",
      outcome: undefined,
      deadline_at: new Date(Date.now() - 4_000).toISOString(),
    };
    // The PRE-FIX sweep criterion (embedded inline above) VOIDS it — the S34
    // defect.
    assert.equal(
      preFixSweepVoidsExpiredAttempt(terminalReachedAttempt, Date.now()),
      true,
      "the pre-fix sweep must void a terminal-reached attempt whose deadline is 4s in the past (the S34 race)",
    );
    // Sanity: an attempt whose deadline is in the FUTURE is not voided even by
    // the pre-fix criterion.
    assert.equal(
      preFixSweepVoidsExpiredAttempt(
        { kind: "workflow", outcome: undefined, deadline_at: new Date(Date.now() + 60_000).toISOString() },
        Date.now(),
      ),
      false,
    );
  });

  it("GREEN-ARM (AC2): the FIXED controller does NOT void a terminal-reached attempt within grace — it classifies with the monitor's honest terminal outcome (PASS)", () => {
    const fx: FixtureOptions = {
      caseId: "S34-GRACE-TERMINAL",
      deadlineOffsetMs: 4_000,
      graceMs: 30_000,
      status: "completed",
    };
    const campaignDir = buildFixtureCampaign(fx, scratchDir);
    campaignDirs.push(campaignDir);
    const stubDir = path.join(scratchDir, "stubs", fx.caseId);
    writeStub(stubDir, fx.status);

    const res = resumeController(campaignDir, stubDir, homeDir);
    assert.equal(res.status, 0,
      `resume of the terminal-reached fixture must exit 0 (GREEN), got ${res.status}:\n${res.stdout}\n${res.stderr}`);

    const state = loadState(campaignDir);
    const item = state.cases.find((c: any) => c.id === fx.caseId);
    assert.ok(item, "the fixture case must be present in the resumed state");
    assert.equal(item.phase, "terminal");
    assert.equal(item.outcome, "PASS",
      `the terminal-reached attempt must classify with the honest PASS outcome, got ${JSON.stringify(item)}`);
    const attempt = item.attempts.at(-1);
    assert.equal(attempt.outcome, "PASS");
    assert.equal(attempt.terminal_status, "completed");
    assert.equal(attempt.recovery?.status, "reconciled",
      "the resumed attempt must have been reattached and settled by the recovery path (not swept)");
    assert.notEqual(attempt.classification_reason?.category, "deadline-expired");
    assert.ok(!JSON.stringify(item).includes("deadline-expired"),
      "a terminal-within-grace attempt must never carry the deadline-expired category");
    // The sweep deferred: the best-effort `workflow stop` was NEVER issued.
    const stopCalls = callKinds(stubDir).filter((kind) => kind === "stop");
    assert.equal(stopCalls.length, 0,
      `a deferred attempt must not receive a best-effort workflow stop: ${JSON.stringify(readCalls(stubDir))}`);
    // The recovery genuinely reattached: status AND wait were consulted.
    const kinds = callKinds(stubDir);
    assert.ok(kinds.includes("status"), `recovery must query workflow status: ${JSON.stringify(readCalls(stubDir))}`);
    assert.ok(kinds.includes("wait"), `recovery must reattach via workflow wait: ${JSON.stringify(readCalls(stubDir))}`);
  });

  it("GREEN-ARM: with the grace window DISABLED (deadline_grace_ms: 0) the SAME terminal-reached fixture is still voided — the live pre-fix race", () => {
    const fx: FixtureOptions = {
      caseId: "S34-GRACE-ZERO",
      deadlineOffsetMs: 4_000,
      graceMs: 0,
      status: "completed",
    };
    const campaignDir = buildFixtureCampaign(fx, scratchDir);
    campaignDirs.push(campaignDir);
    const stubDir = path.join(scratchDir, "stubs", fx.caseId);
    writeStub(stubDir, fx.status);

    const res = resumeController(campaignDir, stubDir, homeDir);
    assert.equal(res.status, 2,
      `resume of the grace-disabled fixture must exit 2 (INFRA_FAILURE), got ${res.status}:\n${res.stdout}\n${res.stderr}`);

    const state = loadState(campaignDir);
    const item = state.cases.find((c: any) => c.id === fx.caseId);
    assert.equal(item.outcome, "TEST_INFRA_FAIL");
    assert.equal(item.reason?.category, "deadline-expired",
      `the grace-disabled sweep must void exactly like the pre-fix controller: ${JSON.stringify(item.reason)}`);
  });

  it("GREEN-ARM (AC3): a genuinely-hung attempt (stub status keeps 'running') is still swept TEST_INFRA_FAIL deadline-expired with the full evidence fields", () => {
    const fx: FixtureOptions = {
      caseId: "S34-GRACE-HUNG",
      deadlineOffsetMs: 4_000,
      graceMs: 30_000,
      status: "running",
    };
    const campaignDir = buildFixtureCampaign(fx, scratchDir);
    campaignDirs.push(campaignDir);
    const stubDir = path.join(scratchDir, "stubs", fx.caseId);
    writeStub(stubDir, fx.status);

    const res = resumeController(campaignDir, stubDir, homeDir);
    assert.equal(res.status, 2,
      `resume of the hung fixture must exit 2 (INFRA_FAILURE), got ${res.status}:\n${res.stdout}\n${res.stderr}`);

    const state = loadState(campaignDir);
    const item = state.cases.find((c: any) => c.id === fx.caseId);
    assert.ok(item, "the hung fixture case must be present");
    assert.equal(item.phase, "terminal");
    assert.equal(item.outcome, "TEST_INFRA_FAIL");
    assert.equal(item.reason?.category, "deadline-expired");
    const reason = item.reason;
    // Full deadline-expired evidence fields preserved (US-005 contract).
    assert.ok(typeof reason.deadline_at === "string" && reason.deadline_at.endsWith("Z"),
      `deadline-expired evidence must carry deadline_at: ${JSON.stringify(reason)}`);
    assert.ok(Number.isSafeInteger(reason.expired_for_seconds) && reason.expired_for_seconds >= 1,
      `deadline-expired evidence must carry a positive integer expired_for_seconds: ${JSON.stringify(reason)}`);
    assert.equal(reason.run_id, FIXTURE_RUN_ID,
      `deadline-expired evidence must carry the run_id: ${JSON.stringify(reason)}`);
    assert.ok(typeof reason.observed_at === "string" && reason.observed_at.endsWith("Z"),
      `deadline-expired evidence must carry observed_at: ${JSON.stringify(reason)}`);
    const attempt = item.attempts.at(-1);
    assert.equal(attempt.outcome, "TEST_INFRA_FAIL");
    assert.equal(attempt.classification_reason?.category, "deadline-expired");
    // The grace status leg DID query the run (and found 'running' — not
    // terminal), then the best-effort stop was attempted.
    const kinds = callKinds(stubDir);
    assert.ok(kinds.includes("status"), `the grace leg must query the run status: ${JSON.stringify(readCalls(stubDir))}`);
    assert.ok(kinds.includes("stop"), `the sweep must issue the best-effort workflow stop: ${JSON.stringify(readCalls(stubDir))}`);
  });

  it("FAIL-CLOSED (AC4): an attempt OUTSIDE the grace window (10 min past) is still swept even when the stub status would report 'completed' — and the sweep provably never queried status", () => {
    const fx: FixtureOptions = {
      caseId: "S34-GRACE-OUTSIDE",
      deadlineOffsetMs: 10 * 60_000,
      graceMs: 30_000,
      status: "completed",
    };
    const campaignDir = buildFixtureCampaign(fx, scratchDir);
    campaignDirs.push(campaignDir);
    const stubDir = path.join(scratchDir, "stubs", fx.caseId);
    writeStub(stubDir, fx.status);

    const res = resumeController(campaignDir, stubDir, homeDir);
    assert.equal(res.status, 2,
      `resume of the outside-grace fixture must exit 2 (INFRA_FAILURE), got ${res.status}:\n${res.stdout}\n${res.stderr}`);

    const state = loadState(campaignDir);
    const item = state.cases.find((c: any) => c.id === fx.caseId);
    assert.equal(item.outcome, "TEST_INFRA_FAIL");
    assert.equal(item.reason?.category, "deadline-expired",
      `outside the grace window the fail-closed sweep must void even a terminal run: ${JSON.stringify(item.reason)}`);
    // The grace gate short-circuited once the window elapsed — the status leg
    // was NEVER consulted (a terminal stub status must not matter beyond the
    // window; the sweep stays fail-closed).
    const kinds = callKinds(stubDir);
    assert.ok(!kinds.includes("status"),
      `outside the grace window the sweep must NOT query the run status: ${JSON.stringify(readCalls(stubDir))}`);
  });

  it("VALIDATION: a persisted deadline_grace_ms of -1 rejects the resume (campaign options are missing or invalid)", () => {
    const fx: FixtureOptions = {
      caseId: "S34-GRACE-INVALID",
      deadlineOffsetMs: 4_000,
      graceMs: -1,
      status: "completed",
    };
    const campaignDir = buildFixtureCampaign(fx, scratchDir);
    campaignDirs.push(campaignDir);
    const stubDir = path.join(scratchDir, "stubs", fx.caseId);
    writeStub(stubDir, fx.status);

    const res = resumeController(campaignDir, stubDir, homeDir);
    assert.equal(res.status, 2,
      `an invalid deadline_grace_ms must reject the resume, got ${res.status}:\n${res.stdout}\n${res.stderr}`);
    assert.match(`${res.stdout}\n${res.stderr}`, /campaign options are missing or invalid/,
      "the rejection must name the invalid campaign options");
  });

  it("WIRING: TT_CONTROLLER_DEADLINE_GRACE_MS persists into state.options.deadline_grace_ms exactly like deadline_sweep_interval_ms", () => {
    // A fresh campaign (zero-token dry-run real launch: no model, no launch)
    // created with the grace env set must persist it into state.options —
    // the resume path then consumes the PERSISTED value (proven by the
    // fixture arms above, which never set the env var).
    const caseId = "S34-GRACE-WIRING";
    const manifestPath = path.join(scratchDir, "manifests", `${caseId}.jsonl`);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const record = {
      id: caseId,
      wave: 0,
      workflow: "bug-fix-merge-worktree",
      fixture: "tt-ts",
      harness: "hermes",
      task: "tasks/W3.22.md",
      context: {},
      caps: { tokens: 4_000_000, wall_min: 240 },
      requires: {},
      boundary_files: [],
      forbidden: [],
      oracles: [],
      gates: [],
      chaos: null,
      shed_ok: false,
      mandatory: true,
      class: "verification",
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(record)}\n`);
    const dryRunOut = path.join(scratchDir, "dryrun-argv.jsonl");
    const stubDir = path.join(scratchDir, "stubs", caseId);
    writeStub(stubDir, "completed");

    const before = listCampaigns();
    const res = run(controller, ["--manifest", manifestPath], {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      TT_DRY_RUN_REAL_LAUNCH: dryRunOut,
      TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
      TT_CONTROLLER_DEADLINE_GRACE_MS: "5000",
      TT_CONTROLLER_DEADLINE_SWEEP_INTERVAL_MS: "1234",
      TT_CONTROLLER_POLL_INTERVAL_MS: "20",
      TT_CONTROLLER_CAP_CHECK_INTERVAL_MS: "20",
      TT_CONTROLLER_SPAWN_HOME_OVERRIDE: homeDir,
    });
    assert.equal(res.status, 0,
      `the dry-run wiring campaign must exit 0 (GREEN), got ${res.status}:\n${res.stdout}\n${res.stderr}`);
    const after = listCampaigns();
    const newCampaigns = [...after].filter((name) => !before.has(name));
    assert.equal(newCampaigns.length, 1,
      `exactly one new campaign must be created: ${JSON.stringify([...after])}`);
    const campaignDir = path.join(resultsRoot, newCampaigns[0]);
    campaignDirs.push(campaignDir);
    const state = loadState(campaignDir);
    assert.equal(state.options.deadline_grace_ms, 5_000,
      `TT_CONTROLLER_DEADLINE_GRACE_MS must persist into state.options.deadline_grace_ms: ${JSON.stringify(state.options)}`);
    assert.equal(state.options.deadline_sweep_interval_ms, 1_234,
      "the sibling deadline_sweep_interval_ms must persist too (parity)");
    // The dry-run case itself completed PASS (zero tokens — recorded argv).
    const item = state.cases.find((c: any) => c.id === caseId);
    assert.equal(item?.outcome, "PASS", `the dry-run wiring case must PASS: ${JSON.stringify(item)}`);
    assert.ok(fs.existsSync(dryRunOut), "the dry-run argv evidence must be recorded");
  });
});
