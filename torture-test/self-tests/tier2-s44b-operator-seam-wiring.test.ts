// S44b (US-010) — operator-seam CELL WIRING pins (fast, zero tokens).
//
// US-009 (S44a) built the four first-class operator-seam probe ops
// (restart_contained_daemon, update_contained_install, invalidate_credentials,
// restore_credentials) with per-action evidence + fail-closed categories.
// US-010 (this story) wires them into the five operator-seam CELLS' manifests
// and task texts (W4.10-kill-daemon, W4.48a-daemon-kill-mid-park,
// W4.33a-daemon-restart-resume, W4.33b-update-under-it-resume,
// W4.47-auth-expiry-copy) so the cells are honestly re-runnable instead of
// vacuous/stalled (campaign-20260826T225744158Z: 'operator action in the
// task text' with no machinery; the S32-37 US-003 stall diagnosis — no
// daemon restart until sweep teardown).
//
// This file pins the DECLARATIONS (fast, runs in the normal battery):
//   * each of the five cells declares its probe_sequence exactly as
//     tabulated in the traceability S44b section;
//   * W4.10/W4.48a KEEP their typed kill-daemon chaos blocks (the
//     kill-daemon-then-restart corridor is chaos + restart, not a trim);
//   * W4.33a/W4.33b declare the during_hold action after a hold-capable
//     pause (the W4.33a/W4.33b 'act during the pause hold' shape);
//   * W4.47 declares invalidate_credentials (now) + restore_credentials
//     (event:step.retry) in one run group (restore after invalidate);
//   * the task texts describe the WIRED actions (the pre-S44a 'machinery
//     delta — operator action in the task text' language is gone from the
//     operator-seam paragraphs);
//   * the traceability S44b section exists and tabulates the declarations;
//   * tt-controller --validate-only stays green on the full 70-row manifest.
//
// The EXECUTION proofs (each action provably fires at its declared trigger
// against the CONTAINED scripted daemon, evidence lands, recovery shapes)
// live in self-tests/tier2-s44-operator-seam-corridors.test.ts (HEAVY,
// isolated like tier2-s29-fired-trigger-corridor).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const tier2Path = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const controller = path.join(ttRoot, "bin", "tt-controller");

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

const OPERATOR_SEAM_CELLS = [
  "W4.10-kill-daemon",
  "W4.48a-daemon-kill-mid-park",
  "W4.33a-daemon-restart-resume",
  "W4.33b-update-under-it-resume",
  "W4.47-auth-expiry-copy",
];

function tier2Rows(): Record<string, any>[] {
  return fs.readFileSync(tier2Path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function row(id: string): Record<string, any> {
  const found = tier2Rows().find((r) => r.id === id);
  assert.ok(found, `${id} must exist in tier2.jsonl`);
  return found;
}

describe("S44b — operator-seam cell wiring (US-010)", () => {
  it("W4.10-kill-daemon keeps the kill-daemon chaos block and declares restart_contained_daemon armed on step:fixer:running", () => {
    const r = row("W4.10-kill-daemon");
    assert.deepEqual(r.chaos, {
      type: "kill-daemon",
      target: "daemon_process",
      trigger: "step:fixer:running",
      signal: "SIGKILL",
      operator: "tt-chaos",
    }, "W4.10 must keep its typed kill-daemon chaos block");
    assert.deepEqual(r.probe_sequence, [{
      run: 1,
      actions: [
        { op: "restart_contained_daemon", when: "step:fixer:running", expect: { run_completes: true } },
      ],
    }], "W4.10 must declare the single-run restart_contained_daemon corridor on the chaos trigger");
  });

  it("W4.48a-daemon-kill-mid-park keeps the kill-daemon chaos block and declares restart_contained_daemon armed on step:finalize_merge:running", () => {
    const r = row("W4.48a-daemon-kill-mid-park");
    assert.deepEqual(r.chaos, {
      type: "kill-daemon",
      target: "daemon_process",
      trigger: "step:finalize_merge:running",
      signal: "SIGKILL",
      operator: "tt-chaos",
    }, "W4.48a must keep its typed kill-daemon chaos block");
    assert.deepEqual(r.probe_sequence, [{
      run: 1,
      actions: [
        { op: "restart_contained_daemon", when: "step:finalize_merge:running", expect: { run_completes: true } },
      ],
    }], "W4.48a must declare the single-run restart_contained_daemon corridor on the chaos trigger");
  });

  it("W4.33a-daemon-restart-resume declares restart_contained_daemon with during_hold between pause_drain and resume", () => {
    const r = row("W4.33a-daemon-restart-resume");
    assert.equal(r.chaos, null, "W4.33a has no chaos block");
    const actions = r.probe_sequence[0].actions;
    assert.equal(actions.length, 3, "W4.33a must carry pause_drain -> restart_contained_daemon(during_hold) -> resume");
    assert.equal(actions[0].op, "pause_drain");
    assert.equal(actions[0].when, "step:fixer:running");
    assert.ok(actions[0].hold_seconds > 0, "the holder must carry hold_seconds > 0 (the during_hold requirement)");
    assert.deepEqual(actions[1], { op: "restart_contained_daemon", when: "now", during_hold: true },
      "W4.33a must declare restart_contained_daemon with during_hold: true (fires concurrently with the pause hold)");
    assert.equal(actions[2].op, "resume");
  });

  it("W4.33b-update-under-it-resume declares update_contained_install with during_hold between pause and resume", () => {
    const r = row("W4.33b-update-under-it-resume");
    assert.equal(r.chaos, null, "W4.33b has no chaos block");
    const actions = r.probe_sequence[0].actions;
    assert.equal(actions.length, 3, "W4.33b must carry pause -> update_contained_install(during_hold) -> resume");
    assert.equal(actions[0].op, "pause");
    assert.equal(actions[0].when, "step:fixer:running");
    assert.ok(actions[0].hold_seconds > 0, "the holder must carry hold_seconds > 0 (the during_hold requirement)");
    assert.deepEqual(actions[1], { op: "update_contained_install", when: "now", during_hold: true },
      "W4.33b must declare update_contained_install with during_hold: true (fires concurrently with the pause hold)");
    assert.equal(actions[2].op, "resume");
  });

  it("W4.47-auth-expiry-copy declares invalidate_credentials (now) + restore_credentials (event:step.running) in one run group", () => {
    const r = row("W4.47-auth-expiry-copy");
    assert.equal(r.chaos, null, "W4.47 has no chaos block");
    assert.equal(r.workflow, "do-now", "W4.47 is the do-now cell");
    const actions = r.probe_sequence[0].actions;
    assert.equal(actions.length, 2, "W4.47 must carry invalidate_credentials -> restore_credentials");
    assert.equal(actions[0].op, "invalidate_credentials");
    assert.equal(actions[0].when, "now", "the invalidate fires as the run id resolves — before the first dispatch round");
    assert.equal(actions[1].op, "restore_credentials");
    assert.equal(actions[1].when, "event:step.running", "the restore fires at the RETRIED round's dispatch (the relaunch) — the invalidated first round exits before claiming (provider-error instant-fail), so the first step.running in the run is the relaunch's (the machinery 'restore the copy, launch again')");
    assert.deepEqual(actions[1].expect, { run_completes: true });
  });

  it("the operator-seam task texts describe the WIRED actions (no 'machinery delta — operator action' gap remains)", () => {
    const expectations: Record<string, RegExp> = {
      "W4.10-kill-daemon": /restart_contained_daemon/,
      "W4.48a-daemon-kill-mid-park": /restart_contained_daemon/,
      "W4.33a-daemon-restart-resume": /during_hold/,
      "W4.33b-update-under-it-resume": /update_contained_install/,
      "W4.47-auth-expiry-copy": /invalidate_credentials/,
    };
    for (const [id, needle] of Object.entries(expectations)) {
      const r = row(id);
      const taskText = fs.readFileSync(path.join(ttRoot, r.task), "utf8");
      assert.match(taskText, needle, `${id} task text must describe the wired action (${needle})`);
    }
  });

  it("tier2-traceability.md has the S44b section tabulating the wired action declarations", () => {
    const doc = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(doc, /## S44b Operator-seam cell wiring \+ scripted corridors \(US-010, 2026-08-31\)/,
      "traceability must have the S44b section");
    assert.match(doc, /restart_contained_daemon/, "S44b must name restart_contained_daemon");
    assert.match(doc, /update_contained_install/, "S44b must name update_contained_install");
    assert.match(doc, /invalidate_credentials/, "S44b must name invalidate_credentials");
    assert.match(doc, /restore_credentials/, "S44b must name restore_credentials");
    assert.match(doc, /during_hold/, "S44b must name the during_hold concurrency marker");
    // The per-cell machinery-delta rows must have been REPLACED by the wired
    // action declarations (the 'operator choreography (machinery delta)'
    // language is gone from the operator-seam rows).
    assert.ok(!/W4\.47.*no controller op for corrupting the copy/.test(doc),
      "the W4.47 machinery-delta row must be replaced by the wired action declaration");
    assert.ok(!/single-run pause→restart→resume corridor cannot use it\. The daemon restart is an OPERATOR action/.test(doc),
      "the W4.33a/W4.48a machinery-delta row must be replaced by the wired restart_contained_daemon declaration");
  });

  it("tt-controller --validate-only stays green on the full 70-row manifest with the wired probe_sequences", () => {
    const res = spawnSync(controller, ["--manifest", tier2Path, "--validate-only"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `validate-only must stay green:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/, `validate-only must validate all 70 cases: ${res.stdout}`);
  });
});
