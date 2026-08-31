// US-006 — S36 W4.33d real-run diagnosis pin: why `event:run.failed` never
// fired (the diagnosis section of impl-tasks/S32-37-rerun-residue.md).
//
// The 2026-08-30 rerun campaign (campaign-20260830T085340743Z-cc2c9a15-
// caea-4803-8d24-62e10e2164a3) left W4.33d-reroute-exhaustion-resume
// TEST_INFRA_FAIL 'probe-trigger-unreached'. The captured evidence pins the
// shape (read-only, never modified):
//
//   report.txt INFRA FAILURES: - W4.33d-reroute-exhaustion-resume:
//     probe-trigger-unreached (probe action 'resume' armed on
//     'event:run.failed' never fired before the run reached
//     terminal/deadline (waited 543720ms))
//   probe-evidence.json: run_terminal_status "completed", waited_ms 543720
//   chaos_evidence: move-branch ref refs/heads/seed/BUG-T4 repeat 60
//     interval_s 60 wait_timeout_s 4200, status completed, exit 0
//   run's own event stream (578cf681-e4d1-4ea6-8962-fd757c63f9d6.jsonl,
//   64 events): step.rerouted x1, merge.landed x1, run.completed x1;
//     run.failed x0, merge.target_moved x0, step.reroute_budget_exhausted x0
//   var/chaos/chaos.log: marker satisfied 08:59:49, budget_armed,
//     move 1 08:59:49 a9419b6a->44284996, move 2 09:00:49
//     44284996->9fe82aff, move 3 09:01:49 9fe82aff->0ad7f97a,
//     stand_down 09:02:49 (run terminal)
//
// Root cause (diagnosed in the impl-task doc): the typed move-branch
// injection's cadence is a FREE-RUNNING 60s clock gated ONCE at the first
// `step:finalize_merge:running` marker — it never re-arms per finalize
// attempt. Only move 1 landed inside a finalize window (attempt 1 -> one
// reroute, 1/8); moves 2-3 landed during the verify re-run where the
// empty-diff budget (unchanged tree) makes them inert; attempt 2 landed
// between move 3 and move 4 -> run.completed -> event:run.failed never
// fired. The reroute machinery is not the defect (the max_reroutes: 8
// budget was never approached). DECISION: REDESIGN (US-007) — per-attempt
// deterministic moves; NOT a FINDING (the scripted corridor proves the
// product CAN genuinely fail + resume via this vector).
//
// This test pins the LANDED DIAGNOSIS (zero tokens, read-only — no campaign
// machinery, no launches, no evidence files touched): the S36 section of
// impl-tasks/S32-37-rerun-residue.md exists, cites the campaign id + run id,
// states the root cause, and records the decision. The pinned evidence
// strings below are copied from the campaign (verbatim); the test never
// reads var/ (the campaign evidence lives in the operator's live checkout,
// not the worktree — self-tests must be self-contained).
//
// Fast + read-only so it stays in self-tests/run.sh's bounded tier2 glob.
// Zero tokens. Follows the tier2-s34-caps-recalibration /
// tier2-s35-o9-detached-head pin-test pattern.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const implTaskDoc = path.join(ttRoot, "impl-tasks", "S32-37-rerun-residue.md");

// ── Pinned campaign evidence (campaign-20260830T085340743Z-cc2c9a15) ────
// The campaign id + run id the diagnosis must cite (full forms).
const CAMPAIGN_ID = "campaign-20260830T085340743Z-cc2c9a15-caea-4803-8d24-62e10e2164a3";
const RUN_ID = "run-578cf681-e4d1-4ea6-8962-fd757c63f9d6";
const SHORT_RUN_ID = "578cf681-e4d1-4ea6-8962-fd757c63f9d6";

// report.txt INFRA FAILURES line, verbatim.
const CAMPAIGN_INFRA_FAILURE_LINE =
  "W4.33d-reroute-exhaustion-resume: probe-trigger-unreached (probe action 'resume' armed on 'event:run.failed' never fired before the run reached terminal/deadline (waited 543720ms))";

// probe-evidence.json failure (verbatim message + terminal status).
const PROBE_FAILURE_MESSAGE =
  "probe action 'resume' armed on 'event:run.failed' never fired before the run reached terminal/deadline (waited 543720ms)";
const PROBE_RUN_TERMINAL_STATUS = "completed";
const PROBE_WAITED_MS = 543720;

// chaos_evidence params (verbatim).
const CHAOS_REF = "refs/heads/seed/BUG-T4";
const CHAOS_REPEAT = 60;
const CHAOS_INTERVAL_S = 60;

// The run's own event-stream counts (verbatim counts from the run's event
// stream — the finalize_merge expected-tip corridor).
const REROUTED_COUNT = 1;
const MERGE_LANDED_COUNT = 1;
const RUN_COMPLETED_COUNT = 1;
const RUN_FAILED_COUNT = 0;
const TARGET_MOVED_COUNT = 0;
const BUDGET_EXHAUSTED_COUNT = 0;

// The move-1 target the first finalize attempt observed (reroute detail
// "had moved to EXPECT_TIP=44284996243ca65652b71a925a30b3d3625e8ffc").
const MOVE1_TARGET = "44284996243ca65652b71a925a30b3d3625e8ffc";
// The merge.landed expectedTip of attempt 2 (move 3's target).
const MOVE3_TARGET = "0ad7f97a0eafd782cff6cc1a9e5ea80284ffd233";

function docText(): string {
  assert.ok(fs.existsSync(implTaskDoc), `impl-task doc must exist: ${implTaskDoc}`);
  return fs.readFileSync(implTaskDoc, "utf8");
}

// The doc wraps markdown lines, so exact verbatim substrings break across
// newlines. Normalize every whitespace run to a single space on BOTH sides
// before matching — the prose/evidence content is what is pinned, not the
// wrap points.
function normalized(text: string): string {
  return text.replace(/\s+/g, " ");
}

function docContains(needle: string): boolean {
  return normalized(docText()).includes(normalized(needle));
}

describe("Tier-2 S36 W4.33d real-run diagnosis (US-006)", () => {
  it("the S36 diagnosis section exists in impl-tasks/S32-37-rerun-residue.md and is no longer 'remaining'", () => {
    const doc = docText();
    // The S36 item is the 4th defect class; the US-006 landed block must be
    // present under it (the doc pattern for landed stories).
    assert.ok(doc.includes("US-006 (landed): real-run diagnosis"),
      "S36 diagnosis section must carry the US-006 (landed) marker");
    assert.ok(doc.includes("S36 W4.33d premise still unfired in real runs"),
      "the S36 defect heading must remain");
    // The diagnosis must state a root cause and a decision (not just repeat
    // the defect).
    assert.ok(/ROOT CAUSE/i.test(doc), "the S36 section must state a root cause");
    assert.ok(/DECISION/i.test(doc), "the S36 section must record a decision");
  });

  it("the diagnosis cites the campaign id and the run id (full forms)", () => {
    const doc = docText();
    assert.ok(docContains(CAMPAIGN_ID),
      `the S36 section must cite the rerun campaign id ${CAMPAIGN_ID}`);
    assert.ok(docContains(RUN_ID),
      `the S36 section must cite the run id ${RUN_ID}`);
    assert.ok(docContains(SHORT_RUN_ID),
      `the S36 section must cite the run's event-stream file ${SHORT_RUN_ID}`);
  });

  it("the diagnosis cites the probe + chaos evidence verbatim (report line, waited 543720ms, completed, repeat 60 / interval 60 / ref)", () => {
    const doc = docText();
    assert.ok(docContains(PROBE_FAILURE_MESSAGE),
      "the diagnosis must cite the probe failure message verbatim (waited 543720ms)");
    assert.ok(docContains(PROBE_RUN_TERMINAL_STATUS),
      "the diagnosis must cite run_terminal_status 'completed'");
    assert.ok(docContains(String(PROBE_WAITED_MS)),
      "the diagnosis must cite waited_ms 543720");
    assert.ok(docContains(CHAOS_REF),
      `the diagnosis must cite the chaos ref ${CHAOS_REF}`);
    assert.ok(docContains(`repeat ${CHAOS_REPEAT}`) && docContains(`interval_s ${CHAOS_INTERVAL_S}`),
      `the diagnosis must cite the chaos cadence (repeat ${CHAOS_REPEAT}, interval_s ${CHAOS_INTERVAL_S})`);
    // The report.txt INFRA FAILURES line is pinned verbatim in the S36 block.
    assert.ok(docContains(CAMPAIGN_INFRA_FAILURE_LINE),
      "the diagnosis must carry the report.txt INFRA FAILURES line verbatim");
  });

  it("the diagnosis cites the run's OWN event-stream evidence (step.rerouted x1, merge.landed x1, run.completed x1; run.failed x0, merge.target_moved x0, budget-exhausted x0)", () => {
    const doc = docText();
    assert.ok(docContains("step.rerouted ×1") || docContains("step.rerouted x1"),
      "the diagnosis must count step.rerouted = 1");
    assert.ok(docContains("merge.landed ×1") || docContains("merge.landed x1"),
      "the diagnosis must count merge.landed = 1");
    assert.ok(docContains("run.completed ×1") || docContains("run.completed x1"),
      "the diagnosis must count run.completed = 1");
    assert.ok(docContains("run.failed ×0") || docContains("run.failed x0"),
      "the diagnosis must count run.failed = 0");
    assert.ok(docContains("merge.target_moved ×0") || docContains("merge.target_moved x0"),
      "the diagnosis must count merge.target_moved = 0");
    assert.ok(docContains("step.reroute_budget_exhausted ×0") || docContains("step.reroute_budget_exhausted x0"),
      "the diagnosis must count step.reroute_budget_exhausted = 0");
  });

  it("the diagnosis records the finalize_merge expected-tip corridor (EXPECT_TIP = move-1 target; merge.landed expectedTip = move-3 target)", () => {
    const doc = docText();
    assert.ok(docContains(MOVE1_TARGET),
      `the diagnosis must cite the attempt-1 observed moved tip ${MOVE1_TARGET}`);
    assert.ok(docContains(MOVE3_TARGET),
      `the diagnosis must cite the attempt-2 merge.landed expectedTip ${MOVE3_TARGET}`);
    assert.ok(/1\/8/.test(normalized(docText())),
      "the diagnosis must record the reroute count 1/8 (max_reroutes: 8 never approached)");
    assert.ok(/rerouteCount: 1/.test(normalized(docText())) || /rerouteCount 1/.test(normalized(docText())),
      "the diagnosis must record the finalize_merge rerouteCount = 1");
  });

  it("the diagnosis states the root cause (injection cadence race — a free-running 60s clock, not the reroute machinery)", () => {
    const doc = docText();
    const flat = normalized(docText());
    assert.ok(/cadence/i.test(flat), "the root cause must name the move cadence");
    assert.ok(/free-running/i.test(flat),
      "the root cause must identify the free-running (non re-armed) move loop");
    assert.ok(/never re-arms per finalize attempt/i.test(flat),
      "the root cause must state that the loop never re-arms per finalize attempt");
    assert.ok(/machinery is NOT the defect/i.test(flat) || /machinery is not the defect/i.test(flat),
      "the root cause must exonerate the reroute machinery explicitly");
  });

  it("the diagnosis records the decision: REDESIGN (US-007), NOT a FINDING, with the per-attempt spec + evidence that the vector is reachable", () => {
    const doc = docText();
    const flat = normalized(docText());
    assert.ok(/REDESIGN \(US-007\)/.test(flat),
      "the decision must name the REDESIGN (US-007) path");
    assert.ok(/NOT a FINDING/.test(flat),
      "the decision must explicitly rule out the FINDING path");
    assert.ok(/RE-ARM/.test(flat) || /re-arm/.test(flat),
      "the redesign spec must describe the per-attempt re-arm mode");
    assert.ok(flat.includes("tier2-s29-premise-redesign-corridor.test.ts"),
      "the decision must cite the scripted corridor proof that the vector is reachable");
    assert.ok(/O16/.test(flat) && /run_completes/.test(flat),
      "the decision must name the O16 run_completes end-state");
  });
});
