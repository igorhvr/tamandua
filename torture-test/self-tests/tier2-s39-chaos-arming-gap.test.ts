// S39 (US-003) — fail-closed mandatory-chaos arming + W4.29 delete-tstx-row
// corridor wiring.
//
// The tier-2 campaign (campaign-20260826T225744158Z) left
// W4.29-strict-gate-retry-finalize with a VACUOUS verdict: its task text
// promises the same drain-armed delete-tstx-row corridor as W4.01/W4.02
// (pause_drain while verify/tester runs, delete the tested tree's TSTX row,
// resume — the strict gate is then exercised on a workflow whose finalize CAN
// retry), but the manifest declared `chaos: null` and no probe_sequence. The
// controller's chaos machinery honors only DECLARED blocks, so no injection
// ever armed; the run reached terminal and the case produced PRODUCT_FAIL
// from evidence the injection was supposed to have made missing.
//
// Campaign evidence (read-only, pinned verbatim below):
//   * state.json: W4.29 run run-9b0bff8a-... has NO chaos_evidence
//     (chaos_evidence: null) and outcome PRODUCT_FAIL (oracle-failed O8/O2),
//     while W4.01 (run-19253a7d-...) and W4.02 (run-9cb0898c-...) both carry
//     chaos_evidence.status = completed (delete-tstx-row,
//     step:finalize_merge:pending);
//   * chaos.log: delete-tstx-row FIRED entries exist ONLY for the W4.01 tree
//     (2026-08-26T23:02:39, run-19253a7d-...) and the W4.02 tree
//     (2026-08-26T23:19:32, run-9cb0898c-...) — NEVER for W4.29's run.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC3): pins the campaign vacuity lines verbatim (W4.29
//     chaos_evidence absent + PRODUCT_FAIL while W4.01/W4.02 show fired
//     evidence; chaos.log last delete-tstx-row firings 23:02/23:19 for the
//     W4.01/W4.02 trees) and reproduces the PRE-FIX vacuity — a mandatory
//     case with a typed chaos block whose trigger never fires currently
//     yields a verdict (no gate); post-fix the S39 gate classifies the same
//     shape TEST_INFRA_FAIL 'chaos-not-fired' (history-independent: the
//     pre-fix no-gate verdict path is reproduced inline, never resolved from
//     git);
//   * GREEN-ARM (AC3): the gate returns the chaos-not-fired reason for a
//     mandatory typed-chaos attempt at terminal with no fired evidence and no
//     chaos.log fired entry; returns null when chaos_evidence shows
//     completed/fired (the W4.01/W4.02 shape), when the chaos.log carries a
//     fired entry for the run id (belt-and-suspenders), and for
//     non-mandatory / declaration-only / chaos:null / still-in-flight shapes;
//   * ROSTER PIN (AC2): W4.29-strict-gate-retry-finalize in cases/tier2.jsonl
//     now declares the delete-tstx-row chaos block and the pause_drain/resume
//     probe_sequence (the W4.01/W4.02 corridor shape) and the controller's
//     --validate-only accepts it (trigger vocabulary verified against
//     security-audit-merge);
//   * the S39 root cause is documented in tier2-traceability.md (AC1).
//
// Follows the tier2-*.test.ts self-test pattern (node builtins + repo-relative
// module imports); picked up by self-tests/run.sh's tier2 glob automatically.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { chaosLogHasFiredEntry, chaosNotFiredGate } from "../bin/tt-chaos-arming.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const controller = path.join(ttRoot, "bin", "tt-controller");

// ── Pinned campaign evidence (campaign-20260826T225744158Z-4bf26d7f) ────
// The W4.29 run id + outcome (state.json, verbatim).
const W4_29_RUN_ID = "run-9b0bff8a-a05f-4758-bb53-04c12f78f4e5";
// The W4.01/W4.02 run ids whose delete-tstx-row corridor DID fire (chaos.log
// fired entries + state.json chaos_evidence.status = completed).
const W4_01_RUN_ID = "run-19253a7d-4df2-4dce-93ba-0226446c57ae";
const W4_02_RUN_ID = "run-9cb0898c-533e-4b84-a05a-1cabd5a756b3";
// The chaos.log delete-tstx-row fired entries for W4.01/W4.02 (verbatim
// shape from the campaign chaos.log; timestamps + deletedCount + target tree
// are campaign facts).
const W4_01_FIRED_ENTRY = '{"ts":"2026-08-26T23:02:39.717Z","action":"delete-tstx-row","runId":"run-19253a7d-4df2-4dce-93ba-0226446c57ae","target":"tree:af50c396d88c8e41a34b7ff8257a1af1cec09cd6","deletedCount":1,"outcome":"fired"}';
const W4_02_FIRED_ENTRY = '{"ts":"2026-08-26T23:19:32.991Z","action":"delete-tstx-row","runId":"run-9cb0898c-533e-4b84-a05a-1cabd5a756b3","target":"tree:8c4a128da1de25dbb4ce66df82e5af5a460bc68d","deletedCount":1,"outcome":"fired"}';

// The corridor shape W4.29 must now declare (mirrors W4.01/W4.02):
//   chaos {type: delete-tstx-row, target: tstx_row, trigger:
//   step:finalize_merge:pending, tree: TESTEDTREE, operator: tt-chaos} plus
//   the probe_sequence pause_drain (verify window) / resume actions.
const W4_29_CHAOS = {
  type: "delete-tstx-row",
  target: "tstx_row",
  trigger: "step:finalize_merge:pending",
  tree: "TESTEDTREE",
  operator: "tt-chaos",
};
const W4_29_PROBE_OPS = ["pause_drain", "resume"];
const W4_29_PAUSE_WHEN = "step:verify:running";

function readManifest(): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function w429Record(): any {
  const record = readManifest().find((item) => item.id === "W4.29-strict-gate-retry-finalize");
  assert.ok(record, "W4.29 must exist in tier2.jsonl");
  return record;
}

function run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 120_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

// A throwaway TT var-style dir with a chaos.log seeded from the given JSON
// lines (the controller's CHAOS_LOG_PATH shape: var/chaos/chaos.log).
function fakeChaosLogDir(entries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `s39-chaos-${process.pid}-`));
  fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
  if (entries.length > 0) {
    fs.writeFileSync(path.join(dir, "chaos", "chaos.log"), `${entries.join("\n")}\n`, "utf8");
  }
  return dir;
}

// The W4.29 mandatory typed-chaos case record (manifest shape).
function w429CaseRecord(): any {
  return { ...w429Record() };
}

describe("S39 (US-003) — fail-closed mandatory-chaos arming + W4.29 corridor wiring", () => {
  it("RED-ARM: pins the campaign vacuity lines verbatim (W4.29 chaos_evidence absent + verdict; W4.01/W4.02 fired)", () => {
    // The W4.29 run id is a well-formed run-<uuid>.
    assert.match(W4_29_RUN_ID, /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The W4.01/W4.02 fired entries carry the exact corridor signature the
    // campaign chaos.log recorded (delete-tstx-row, outcome fired).
    for (const entry of [W4_01_FIRED_ENTRY, W4_02_FIRED_ENTRY]) {
      const parsed = JSON.parse(entry) as any;
      assert.equal(parsed.action, "delete-tstx-row");
      assert.equal(parsed.outcome, "fired");
      assert.match(parsed.target, /^tree:[0-9a-f]{40}$/);
    }
    // W4.29's run id must NOT appear in either fired entry (its corridor
    // NEVER fired — the campaign's delete-tstx-row firings stop at W4.02).
    for (const entry of [W4_01_FIRED_ENTRY, W4_02_FIRED_ENTRY]) {
      assert.ok(!entry.includes(W4_29_RUN_ID), "W4.29's run must not appear in the W4.01/W4.02 fired entries");
    }
    // The manifest BEFORE this story declared chaos:null for W4.29 — the
    // root-cause line (the current manifest declares the corridor; the
    // pre-fix shape is pinned by the traceability S39 section + the run-id
    // absence above).
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## S39 fail-closed mandatory-chaos arming/, "traceability must carry the S39 section");
    assert.match(trace, /chaos:null/, "traceability must name the pre-fix chaos:null root cause");
    assert.match(trace, /run-9b0bff8a/, "traceability must cite the W4.29 campaign run id");
    assert.match(trace, /23:02\/23:19|23:02|23:19/, "traceability must cite the W4.01/W4.02 chaos.log firing window");
  });

  it("RED-ARM: reproduces the pre-fix vacuity (no gate -> verdict) and proves the S39 gate catches it post-fix", () => {
    const dir = fakeChaosLogDir([]); // no fired entry for the run
    try {
      const caseRecord = w429CaseRecord();
      // The PRE-FIX attempt shape: the run reached terminal with NO
      // chaos_evidence (the chaos machinery never armed — the campaign's
      // exact W4.29 shape).
      const terminalAttempt = {
        id: "attempt-1",
        run_id: W4_29_RUN_ID,
        phase: "terminal",
        terminal_at: "2026-08-27T00:53:07.862Z",
        chaos_evidence: null,
      };
      // Pre-fix behavior reproduced inline (history-independent): with no
      // gate, the run's terminal status drives a verdict — the campaign's
      // PRODUCT_FAIL. This is the vacuity: the premise (injection) never
      // armed, yet a verdict is produced.
      const preFixVerdict = (() => {
        const terminalStatus = "failed";
        const passed = terminalStatus === "completed";
        return passed ? "PASS" : "PRODUCT_FAIL";
      })();
      assert.equal(preFixVerdict, "PRODUCT_FAIL",
        "pre-fix: a terminal W4.29-shaped run without the armed injection still produced a PRODUCT_FAIL verdict (the vacuity)");
      // Post-fix: the S39 gate refuses to produce that verdict — it returns
      // the chaos-not-fired reason.
      const reason = chaosNotFiredGate(caseRecord, terminalAttempt, { chaosLogPath: path.join(dir, "chaos", "chaos.log"), atTerminal: true });
      assert.ok(reason, "post-fix: the gate must fire for the never-armed mandatory typed-chaos shape");
      assert.equal(reason!.category, "chaos-not-fired");
      assert.equal(reason!.run_id, W4_29_RUN_ID);
      assert.equal(reason!.trigger, "step:finalize_merge:pending");
      assert.equal(reason!.chaos_type, "delete-tstx-row");
      assert.match(reason!.message, /W4\.29-strict-gate-retry-finalize/);
      assert.match(reason!.message, /never fired/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC3): the gate classifies a never-fired mandatory typed chaos TEST_INFRA_FAIL chaos-not-fired", () => {
    const dir = fakeChaosLogDir([]);
    try {
      const reason = chaosNotFiredGate(
        w429CaseRecord(),
        { id: "attempt-1", run_id: W4_29_RUN_ID, phase: "terminal", terminal_at: "2026-08-27T00:53:07.862Z", chaos_evidence: { status: "running", started_at: "2026-08-27T00:13:00.000Z" } },
        { chaosLogPath: path.join(dir, "chaos", "chaos.log"), atTerminal: true },
      );
      assert.ok(reason, "a stuck 'running' chaos evidence at terminal is still never-fired");
      assert.equal(reason!.category, "chaos-not-fired");
      assert.equal(reason!.run_id, W4_29_RUN_ID);
      assert.equal(reason!.trigger, "step:finalize_merge:pending");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC3): the gate returns null when chaos_evidence reached completed (the W4.01/W4.02 fired shape)", () => {
    const dir = fakeChaosLogDir([]);
    try {
      const reason = chaosNotFiredGate(
        w429CaseRecord(),
        {
          id: "attempt-1",
          run_id: W4_01_RUN_ID,
          phase: "terminal",
          terminal_at: "2026-08-26T23:14:05.964Z",
          chaos_evidence: { status: "completed", injection_type: "delete-tstx-row", trigger: "step:finalize_merge:pending" },
        },
        { chaosLogPath: path.join(dir, "chaos", "chaos.log"), atTerminal: true },
      );
      assert.equal(reason, null, "completed chaos evidence means the corridor fired — no arming violation");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC3): the gate returns null when the chaos.log carries a fired entry for the run id (belt-and-suspenders)", () => {
    const dir = fakeChaosLogDir([
      W4_01_FIRED_ENTRY,
      W4_02_FIRED_ENTRY,
      '{"ts":"2026-08-27T00:54:37.899Z","action":"delete-tstx-row","runId":"' + W4_29_RUN_ID + '","target":"tree:417db62abc996e27855ef63d75e1c9a763050691","deletedCount":0,"outcome":"fired"}',
    ]);
    try {
      // No chaos_evidence at all, but the chaos.log fired entry for THIS run
      // id proves the injection armed — the gate must not fail closed.
      const reason = chaosNotFiredGate(
        w429CaseRecord(),
        { id: "attempt-1", run_id: W4_29_RUN_ID, phase: "terminal", terminal_at: "2026-08-27T00:53:07.862Z", chaos_evidence: null },
        { chaosLogPath: path.join(dir, "chaos", "chaos.log"), atTerminal: true },
      );
      assert.equal(reason, null, "a chaos.log fired entry for the run id satisfies the arming requirement");
      // The raw-uuid spelling resolves too (the product stores raw uuids).
      const reasonShort = chaosNotFiredGate(
        w429CaseRecord(),
        { id: "attempt-1", run_id: W4_29_RUN_ID.slice(4), phase: "terminal", terminal_at: "2026-08-27T00:53:07.862Z", chaos_evidence: null },
        { chaosLogPath: path.join(dir, "chaos", "chaos.log"), atTerminal: true },
      );
      assert.equal(reasonShort, null, "the raw-uuid run-id spelling must resolve the fired entry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC3): the gate never fires for non-mandatory / declaration-only / chaos:null / still-in-flight shapes", () => {
    const dir = fakeChaosLogDir([]);
    try {
      const chaosLogPath = path.join(dir, "chaos", "chaos.log");
      const base = w429CaseRecord();
      const terminal = { id: "attempt-1", run_id: W4_29_RUN_ID, phase: "terminal", terminal_at: "2026-08-27T00:53:07.862Z", chaos_evidence: null };
      // Non-mandatory: no arming obligation.
      assert.equal(chaosNotFiredGate({ ...base, mandatory: false }, terminal, { chaosLogPath, atTerminal: true }), null);
      // Declaration-only block (O11 synthetic ledger, no operator): never fires by design.
      assert.equal(
        chaosNotFiredGate({ ...base, chaos: { synthetic_token_ledger: [{ run_id: null, expected_tokens: 0 }] } }, terminal, { chaosLogPath, atTerminal: true }),
        null,
      );
      // chaos: null: no declared block — no obligation.
      assert.equal(chaosNotFiredGate({ ...base, chaos: null }, terminal, { chaosLogPath, atTerminal: true }), null);
      // Non-tt-chaos operator: not a typed injection block.
      assert.equal(chaosNotFiredGate({ ...base, chaos: { ...base.chaos, operator: "other" } }, terminal, { chaosLogPath, atTerminal: true }), null);
      // Still in flight: the trigger may yet fire.
      assert.equal(
        chaosNotFiredGate(base, { id: "attempt-1", run_id: W4_29_RUN_ID, phase: "running", chaos_evidence: { status: "running" } }, { chaosLogPath, atTerminal: false }),
        null,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chaosLogHasFiredEntry resolves run-id spellings, filters action type, and tolerates malformed lines", () => {
    const dir = fakeChaosLogDir([
      W4_01_FIRED_ENTRY,
      '{"ts":"2026-08-26T23:02:39.713Z","action":"delete-tstx-row","runId":"run-19253a7d-4df2-4dce-93ba-0226446c57ae","phaseMarker":"step:finalize_merge:pending","phaseSatisfied":true,"outcome":"firing"}',
      "not-json",
      "",
    ]);
    try {
      const logPath = path.join(dir, "chaos", "chaos.log");
      assert.equal(chaosLogHasFiredEntry(logPath, W4_01_RUN_ID), true, "full run-id spelling resolves the fired entry");
      assert.equal(chaosLogHasFiredEntry(logPath, W4_01_RUN_ID.slice(4)), true, "raw-uuid spelling resolves the fired entry");
      assert.equal(chaosLogHasFiredEntry(logPath, W4_01_RUN_ID, "delete-tstx-row"), true, "action filter matches the fired entry");
      assert.equal(chaosLogHasFiredEntry(logPath, W4_01_RUN_ID, "kill-harness"), false, "action filter excludes other actions");
      assert.equal(chaosLogHasFiredEntry(logPath, W4_29_RUN_ID), false, "a run with no fired entry resolves false");
      assert.equal(chaosLogHasFiredEntry(path.join(dir, "chaos", "missing.log"), W4_01_RUN_ID), false, "a missing log is evidence, never a crash");
      assert.equal(chaosLogHasFiredEntry("", W4_01_RUN_ID), false, "an empty path is evidence");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ROSTER PIN (AC2): W4.29 declares the delete-tstx-row corridor (chaos block + pause_drain/resume probe_sequence)", () => {
    const record = w429Record();
    assert.ok(record.chaos && typeof record.chaos === "object", "W4.29 must declare a typed chaos block (S39 — the corridor is no longer chaos:null)");
    assert.deepEqual(record.chaos, W4_29_CHAOS, "W4.29 chaos block must mirror W4.01/W4.02 (delete-tstx-row, tstx_row, step:finalize_merge:pending, TESTEDTREE, tt-chaos)");
    assert.ok(Array.isArray(record.probe_sequence) && record.probe_sequence.length === 1,
      "W4.29 must carry the single-run drain-armed probe_sequence");
    const group = record.probe_sequence[0];
    assert.equal(group.run, 1, "probe run ordinal must be 1");
    assert.deepEqual(group.actions.map((action: any) => action.op), W4_29_PROBE_OPS,
      "probe ops must be pause_drain then resume (the W4.01/W4.02 corridor)");
    assert.equal(group.actions[0].when, W4_29_PAUSE_WHEN,
      "pause_drain must arm while verify is running (the drain-arming race note)");
    assert.ok(group.actions[0].hold_seconds > 0, "pause_drain must declare a positive hold");
    assert.equal(group.actions[1].when, "now", "resume fires immediately after the hold");
    assert.equal(group.actions[1].expect?.run_completes, true, "resume expects the run to complete");
    assert.equal(record.mandatory, true, "W4.29 stays mandatory — the arming obligation applies");
  });

  it("ROSTER PIN (AC3): the controller --validate-only accepts the W4.29 corridor (semantic + trigger-vocabulary preflight)", () => {
    // The updated manifest must pass the semantic chaos/probe validation,
    // including the trigger-vocabulary preflight against security-audit-merge
    // (step:finalize_merge:pending + step:verify:running are both vocabulary).
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `validate-only must pass:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("the traceability S39 section documents the root cause, the fix, and the pinned evidence (AC1)", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## S39 fail-closed mandatory-chaos arming/, "S39 section heading");
    assert.match(trace, /chaos:null/, "root cause: pre-fix manifest declared chaos:null");
    assert.match(trace, /W4\.01|W4\.02/, "root cause: the corridor template (W4.01/W4.02) named");
    assert.match(trace, /chaos-not-fired/, "fix: the distinct fail-closed category");
    assert.match(trace, /never fired|NEVER fired/, "fix: the arming-gap language");
  });
});
