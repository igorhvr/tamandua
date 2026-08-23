// E3.C US-002 — Lifecycle probe_sequence declarations in tier1.jsonl.
//
// Campaign #7 (S3/S4) found the five lifecycle cases (W3.18-W3.22) never
// ran their probes: tt-controller only did launch->wait->(cap-stop)->snapshot
// and O16 was declared-but-missing. E3.C gives the controller something to
// execute: each lifecycle case carries a manifest-declared `probe_sequence`
// (schema'd in case.schema.json) matching spec 07-wave-3-harness-duel.md
// section C. This test pins:
//   * W3.18-W3.22 each carry a probe_sequence implementing their spec-07
//     section-C assertions — W3.20 declares TWO run groups (cancel
//     mid-implement, cancel during finalize_merge), W3.22 declares THREE
//     concurrent run groups (daemon restart mid-flight, all recover within
//     2 dispatch intervals, token flush preserved);
//   * each lifecycle case's caps.wall_min MATCHES the caps-calibration.md
//     table exactly (W3.18=148, W3.19=180, W3.20=138, W3.21=138,
//     W3.22=138) — a cap below its probe sequence duration (hold + run +
//     margin) is a defect (S8);
//   * all five lifecycle cases declare the O16 lifecycle oracle (W3.20 and
//     W3.22 added it — their cancel/restart expectations are O16 judgment
//     dimensions);
//   * W3.17b's chaos block is preserved unchanged (typed sigstop_sigcont,
//     trigger mid_round, hold 600, operator tt-chaos);
//   * the production controller's --validate-only still accepts the
//     manifest (28 cases).
//
// Confined to torture-test/. Zero tokens. No daemons, no launches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const calibrationDoc = path.join(ttRoot, "cases", "caps-calibration.md");
const controller = path.join(ttRoot, "bin", "tt-controller");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

// The caps-calibration.md table (E3.D S8b) values for the lifecycle cases —
// the manifest MUST match them exactly.
const EXPECTED_WALL_CAPS: Record<string, number> = {
  "W3.18-pause-no-drain": 148,
  "W3.19-pause-drain": 180,
  "W3.20-cancel": 138,
  "W3.21-fail-force-resume": 138,
  "W3.22-daemon-restart": 138,
};

function loadTier1(): Record<string, any>[] {
  return fs
    .readFileSync(tier1Manifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function caseById(id: string): Record<string, any> {
  const record = loadTier1().find((r) => r.id === id);
  assert.ok(record, `case ${id} must be in tier1.jsonl`);
  return record;
}

// Parse the calibration table's data rows for the lifecycle cases.
function calibrationRow(caseId: string, field: string): string | undefined {
  const doc = fs.readFileSync(calibrationDoc, "utf8");
  let inTable = false;
  for (const line of doc.split(/\r?\n/)) {
    if (line.startsWith("| Case | Field |")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    if (/^\|[- :|]+\|$/.test(line)) continue; // separator row
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;
    if (cells[0] === caseId && cells[1] === field) return cells[3];
  }
  return undefined;
}

function runValidate(): { status: number; stdout: string; stderr: string } {
  return spawnSync(controller, ["--manifest", tier1Manifest, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

describe("E3.C US-002 — lifecycle probe_sequence declarations (W3.18-W3.22)", () => {
  it("every lifecycle case carries a probe_sequence implementing its spec-07 section-C assertions", () => {
    // W3.18: pause (no drain) mid-implement -> hold 10m (600s) -> resume -> run completes.
    const w318 = caseById("W3.18-pause-no-drain");
    assert.deepEqual(w318.probe_sequence, [
      {
        run: 1,
        actions: [
          { op: "pause", when: "step:developer:running", hold_seconds: 600, expect: { no_rounds_during_hold: true } },
          { op: "resume", when: "now", expect: { run_completes: true } },
        ],
      },
    ], "W3.18 probe_sequence must pause mid-implement, hold 600s, resume, and expect the run to complete");

    // W3.19: pause --drain during an active story -> park without dispatching
    // the next story -> resume (awaits the drained run actually parking in
    // 'paused') -> next story dispatches.
    const w319 = caseById("W3.19-pause-drain");
    assert.deepEqual(w319.probe_sequence, [
      {
        run: 1,
        actions: [
          { op: "pause_drain", when: "step:developer:running", expect: { drain_waits_current: true, next_story_parked: true } },
          { op: "resume", when: { status: "paused", timeout_s: 120 }, expect: { run_completes: true } },
        ],
      },
    ], "W3.19 probe_sequence must pause_drain mid-story, park the next story, resume (awaiting 'paused'), and complete");

    // W3.20: TWO runs — run 1 cancel mid-implement; run 2 cancel during
    // finalize_merge; both assert the run.canceled terminal event lands.
    const w320 = caseById("W3.20-cancel");
    assert.deepEqual(w320.probe_sequence, [
      {
        run: 1,
        actions: [
          { op: "cancel", when: "step:developer:running", expect: { canceled_terminal_event: true } },
        ],
      },
      {
        run: 2,
        actions: [
          { op: "cancel", when: "step:finalize_merge:running", expect: { canceled_terminal_event: true } },
        ],
      },
    ], "W3.20 probe_sequence must declare TWO runs (cancel mid-implement + cancel during finalize_merge) with canceled_terminal_event expectations");

    // W3.21: fail --force mid-run -> resume (awaits the run's process-cleanup
    // / worker drain) -> SAME run id resumes and completes.
    const w321 = caseById("W3.21-fail-force-resume");
    assert.deepEqual(w321.probe_sequence, [
      {
        run: 1,
        actions: [
          { op: "fail_force", when: "step:developer:running" },
          { op: "resume", when: { event: "run.process_cleanup", timeout_s: 120 }, expect: { same_run_id_resumes: true, run_completes: true } },
        ],
      },
    ], "W3.21 probe_sequence must fail --force mid-run, resume (awaiting run.process_cleanup), and expect the SAME run id to resume and complete");

    // W3.22: THREE concurrent runs + contained-daemon restart mid-flight;
    // all three recover within 2 dispatch intervals, token flush preserved.
    const w322 = caseById("W3.22-daemon-restart");
    const restartGroup = {
      run: 1,
      actions: [
        { op: "restart_daemon", when: "step:developer:running", expect: { recovery_within_dispatch_intervals: 2, token_flush_preserved: true, run_completes: true } },
      ],
    };
    assert.equal(w322.probe_sequence.length, 3, "W3.22 probe_sequence must declare THREE concurrent run groups");
    for (const [index, group] of w322.probe_sequence.entries()) {
      assert.deepEqual(group, { ...restartGroup, run: index + 1 },
        `W3.22 run ${index + 1} group must declare restart_daemon with the recovery/token-flush expectations`);
    }
  });

  it("each lifecycle case's caps.wall_min matches caps-calibration.md exactly (148/180/138/138/138)", () => {
    for (const [id, expected] of Object.entries(EXPECTED_WALL_CAPS)) {
      const record = caseById(id);
      assert.equal(record.caps.wall_min, expected,
        `${id}: caps.wall_min must be ${expected} per caps-calibration.md (a cap below its probe sequence duration is a defect)`);
      // The calibration table must not drift from the manifest either.
      const tableValue = calibrationRow(id, "caps.wall_min");
      assert.equal(tableValue, String(expected),
        `${id}: caps-calibration.md table must state caps.wall_min ${expected}`);
    }
  });

  it("all five lifecycle cases declare the O16 lifecycle oracle", () => {
    for (const id of Object.keys(EXPECTED_WALL_CAPS)) {
      const record = caseById(id);
      assert.ok(record.oracles.includes("O16"), `${id} must declare O16 (its probe expectations are O16 judgment dimensions)`);
    }
  });

  it("W3.17b keeps its typed chaos block unchanged (sigstop_sigcont, mid_round, 600s, tt-chaos)", () => {
    const w317b = caseById("W3.17b-marathon-chaos");
    assert.deepEqual(w317b.chaos, {
      type: "sigstop_sigcont",
      target: "harness_process",
      trigger: "mid_round",
      hold_seconds: 600,
      operator: "tt-chaos",
    }, "W3.17b chaos block must be preserved unchanged");
    // The natural marathon must stay chaos-free so W3.17b genuinely differs.
    const w317a = caseById("W3.17a-marathon-natural");
    assert.equal(w317a.chaos, null, "W3.17a must stay chaos: null");
  });

  it("tt-controller --validate-only accepts the manifest with the probe_sequence declarations (28 cases)", () => {
    const res = runValidate();
    assert.equal(res.status, 0, `validate-only must pass:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});
