// S28 (US-005) — chaos-invocation exit-null (SIGKILL) red-arm + fail-closed
// green.
//
// The tier-2 attempt-2 campaign (campaign-20260826T225744158Z-4bf26d7f) left
// W4.09-pi-kill-harness, W4.09-hermes-kill-harness and W4.10-kill-daemon
// TEST_INFRA_FAIL 'chaos-invocation-failed' with the message
// `chaos operator 'tt-chaos' exited null` — the operator was SIGKILLed
// (state.json: exit_code null, signal SIGKILL, argv `--run run-<uuid>
// --when step:developer:running`). Root-cause chain, confirmed against the
// campaign evidence (report.txt + state.json + the contained runs/steps
// tables):
//   1. the chaos trigger never fires (`step:developer:running` on
//      bug-fix-merge-worktree — no developer step/agent; the US-002/003
//      vocabulary calibration);
//   2. waitForHarnessTargetRecord polls until the run is TERMINAL, then the
//      controller spawns tt-chaos anyway with the run id in its argv;
//   3. the contained daemon's post-run leak-guard sweep
//      (src/installer/run-cleanup.ts sweepRunProcesses —
//      matchRunEvidence: `cmdline.includes(runId)`) SIGKILLs the lingering
//      operator before it can act → the controller records `exited null`
//      with signal SIGKILL.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC4): pins the three campaign failure lines verbatim and
//     reproduces the pre-fix chain faithfully — spawn a lingering
//     "tt-chaos"-shaped process whose argv carries the run id (exactly what
//     the pre-fix controller spawned), assert the leak-guard matcher's
//     cmdline-contains-runId criterion matches it (the sweep would SIGKILL
//     it), SIGKILL it, and assert the controller's spawn result records
//     { status: null, signal: SIGKILL } — which formats to the campaign line
//     `chaos operator 'tt-chaos' exited null` (the fixed message then names
//     the signal: `exited null (signal SIGKILL)`);
//   * GREEN-ARM (AC2): bin/tt-chaos spawned directly against an
//     already-terminal run fast-fails at STARTUP (exit EXIT_RUN_TERMINAL=2)
//     with the precise one-line `chaos-refused: run <id> already terminal
//     (<status>) before trigger <marker> (<action>)` reason — promptly, never
//     lingering to be swept.
//
// Follows the tier2-*.test.ts self-test pattern; picked up by
// self-tests/run.sh's tier2 glob automatically.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const ttChaos = path.join(ttRoot, "bin", "tt-chaos");

// ── Pinned campaign evidence (campaign-20260826T225744158Z-4bf26d7f) ────
// report.txt INFRA FAILURES lines, verbatim (the exact one-line failure the
// campaign recorded per cell). Each is
// `<id>: chaos-invocation-failed (<message>)` where <message> is the
// controller's chaos-invocation-failed message (pre-fix format:
// `chaos operator '<operator>' exited <status>` — with a SIGKILL death the
// status is null → `exited null`).
const CAMPAIGN_LINES: Record<string, string> = {
  "W4.09-pi-kill-harness":
    "W4.09-pi-kill-harness: chaos-invocation-failed (chaos operator 'tt-chaos' exited null)",
  "W4.09-hermes-kill-harness":
    "W4.09-hermes-kill-harness: chaos-invocation-failed (chaos operator 'tt-chaos' exited null)",
  "W4.10-kill-daemon":
    "W4.10-kill-daemon: chaos-invocation-failed (chaos operator 'tt-chaos' exited null)",
};

// The failing run ids + the operator argv shape the campaign captured
// (evidence/W4.09-pi-kill-harness/attempt-1/state.json chaos_evidence):
// the operator was spawned with the FULL run id in its argv (`--run
// run-4dc27143-...`) and `--when step:developer:running` — the argv the
// post-run leak-guard sweep's cmdline-contains-runId matcher matched.
const S28_CELLS = [
  {
    id: "W4.09-pi-kill-harness",
    runId: "run-4dc27143-224b-47f0-9dec-51b5aa90f669",
    trigger: "step:developer:running",
    signal: "SIGKILL",
  },
  {
    id: "W4.09-hermes-kill-harness",
    runId: "run-ad651d45-1254-4dee-9e9b-ed558b98e1b3",
    trigger: "step:developer:running",
    signal: "SIGKILL",
  },
  {
    id: "W4.10-kill-daemon",
    runId: "run-5437803d-a2a6-458d-bcaa-de627623aaf5",
    trigger: "step:developer:running",
    signal: "SIGKILL",
  },
];

// The leak-guard sweep matcher criterion (src/installer/run-cleanup.ts
// matchRunEvidence channel (d)): a process whose cmdline contains the run id
// is a "leaked" process and gets SIGKILLed. Reproduced inline — a red-arm
// must be history-independent (tier0-history-independent-red-arms), so the
// criterion is embedded here, not resolved from git.
function sweepCmdlineMatches(cmdline: string, runId: string): boolean {
  return cmdline.includes(runId);
}

// The controller's spawnSync result for a child killed by a signal: status
// null + signal set. Reproduced inline from node's spawnSync semantics.
type SpawnLikeResult = { status: number | null; signal: NodeJS.Signals | null };

// ── S28 (US-005) controller-side message format (fixed) ────────────────
// Mirrors tt-controller's chaosOperatorExitDescription: `exited <code>`
// normally; `exited null (signal <SIG>)` when killed by a signal; the
// operator's own first stderr line is appended when present. Kept inline so
// the red-arm can assert the fixed message still carries the campaign line
// as a prefix while adding the death-signal context (AC3 continuity).
function fixedExitDescription(result: SpawnLikeResult, stderr: string): string {
  let statusPart: string;
  if (result.status !== null && result.status !== undefined) {
    statusPart = `exited ${result.status}`;
  } else if (result.signal !== null && result.signal !== undefined) {
    statusPart = `exited null (signal ${result.signal})`;
  } else {
    statusPart = "exited null";
  }
  const stderrLine = String(stderr).split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return stderrLine !== undefined ? `${statusPart}: ${stderrLine}` : statusPart;
}

function run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 60_000): { status: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null } {
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
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

// Build a throwaway TT var directory with a fake contained DB whose runs
// table carries the given run rows (run_id spelling). Returns the dir (the
// caller removes it).
function fakeTtVar(runRows: Array<{ run_id: string; status: string; workflow_id?: string }>): string {
  const dir = fs.mkdtempSync(path.join(varRoot, `s28-tt-chaos-${process.pid}-`));
  fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
  // `open: true` creates a missing DB file (node:sqlite); the runs table
  // keys on run_id (the tt-chaos test-fixture spelling).
  const db = new DatabaseSync(path.join(dir, "tamandua.db"), { open: true });
  db.exec(`CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    workflow_id TEXT,
    created_at TEXT
  );`);
  for (const row of runRows) {
    db.prepare("INSERT OR REPLACE INTO runs (run_id, status, workflow_id) VALUES (?, ?, ?)")
      .run(row.run_id, row.status, row.workflow_id ?? null);
  }
  db.close();
  return dir;
}

describe("S28 (US-005) — chaos-invocation exit-null (SIGKILL) red-arm + fail-closed green", () => {
  it("RED-ARM: pins the three campaign exit-null lines verbatim", () => {
    for (const cell of S28_CELLS) {
      const line = CAMPAIGN_LINES[cell.id];
      assert.ok(line, `campaign line for ${cell.id} must be pinned`);
      assert.match(line, /^[A-Za-z0-9.-]+: chaos-invocation-failed \(chaos operator 'tt-chaos' exited null\)$/);
    }
  });

  it("RED-ARM: the pre-fix chain — a lingering tt-chaos carrying the run id is sweep-matched, SIGKILLed, and the controller records `exited null`", async () => {
    const cell = S28_CELLS[0]; // W4.09-pi-kill-harness (representative)
    const dir = fs.mkdtempSync(path.join(varRoot, `s28-redarm-${process.pid}-`));
    try {
      // The pre-fix operator: a LINGERING process (it would be polling a
      // marker that can never fire against a terminal run — the pre-US-004
      // tt-chaos had no run-terminal early-exit), spawned with the exact argv
      // shape the campaign captured (--run <full run id> --when
      // step:developer:running).
      const lingerStub = path.join(dir, "tt-chaos-linger");
      fs.writeFileSync(lingerStub, "#!/usr/bin/env node\nsetTimeout(() => {}, 120000);\n", { mode: 0o755 });
      const child = spawn(lingerStub, ["kill-harness", "--run", cell.runId, "--when", cell.trigger, "--signal", cell.signal], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        // (a) The leak-guard sweep matcher matches the lingering operator:
        // its cmdline contains the run id (the `--run run-<uuid>` argv) —
        // the sweep's matchRunEvidence channel (d) criterion.
        // MACP3 US-003: /proc/<pid>/cmdline is linux-only process
        // introspection — on a /proc-less (Darwin) host the read fails and
        // the assertion is SKIPPED (the SIGKILL + message assertions below
        // are platform-independent and still prove the chain).
        let cmdlineMatched = false;
        try {
          const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, "utf8").replace(/\0/g, " ");
          cmdlineMatched = sweepCmdlineMatches(cmdline, cell.runId);
        } catch {
          cmdlineMatched = false;
        }
        if (!cmdlineMatched) {
          assert.ok(!fs.existsSync("/proc"), "cmdline match must only fail on a /proc-less host (Darwin skip)");
        }
        // (b) The sweep SIGKILLs it. The controller's spawnSync then returns
        // status null + signal SIGKILL — never a numeric exit code.
        assert.ok(child.pid, "spawned child must have a pid");
        process.kill(child.pid, "SIGKILL");
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code, signal) => resolve({ code, signal }));
        });
        assert.equal(outcome.code, null, "a SIGKILLed operator must report a null exit code");
        assert.equal(outcome.signal, "SIGKILL", "a SIGKILLed operator must report signal SIGKILL");
        // (c) The pre-fix controller message template (`chaos operator '<op>'
        // exited <status>`) renders the EXACT campaign line.
        const prefixedMessage = `chaos operator 'tt-chaos' exited ${outcome.code}`;
        assert.equal(prefixedMessage, "chaos operator 'tt-chaos' exited null",
          "pre-fix message format must reproduce the campaign line verbatim");
        assert.equal(CAMPAIGN_LINES[cell.id].includes(prefixedMessage), true,
          "the campaign line must be exactly the pre-fix message");
        // (d) The FIXED message still carries the campaign line as a prefix
        // and adds the death-signal context (AC3 — never a bare `exited null`
        // without the reason).
        const fixedMessage = `chaos operator 'tt-chaos' ${fixedExitDescription({ status: outcome.code, signal: outcome.signal }, "")}`;
        assert.match(fixedMessage, /^chaos operator 'tt-chaos' exited null \(signal SIGKILL\)$/,
          `fixed message must name the signal: ${fixedMessage}`);
      } finally {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("RED-ARM: all three cells carry the same exit-null signature in the pinned evidence", () => {
    for (const cell of S28_CELLS) {
      assert.match(CAMPAIGN_LINES[cell.id], /exited null\)$/);
      assert.match(cell.runId, /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(cell.trigger, "step:developer:running", `${cell.id} trigger was the uncalibrated marker`);
    }
  });

  it("GREEN-ARM (AC2): tt-chaos spawned against an already-terminal run fast-fails at startup with chaos-refused (exit 2), never lingering", () => {
    const dir = fakeTtVar([
      { run_id: "run-s28-terminal", status: "completed", workflow_id: "test-wf" },
    ]);
    try {
      const started = Date.now();
      const res = run(ttChaos, [
        "kill-harness",
        "--run", "run-s28-terminal",
        "--when", "step:fixer:running",
        "--timeout", "30",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      const elapsedMs = Date.now() - started;
      assert.equal(res.status, 2, `terminal-run startup refusal must exit 2 (EXIT_RUN_TERMINAL), got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, /chaos-refused: run run-s28-terminal already terminal \(completed\) before trigger step:fixer:running \(kill-harness\) — refusing to wait/,
        `startup refusal must name the run, status, trigger and action precisely: ${res.stderr}`);
      assert.ok(elapsedMs < 5000, `startup refusal must be prompt (took ${elapsedMs}ms — never a poll window against a dead run)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): kill-daemon against an already-terminal run fast-fails the same way", () => {
    const dir = fakeTtVar([
      { run_id: "run-s28-terminal-daemon", status: "failed", workflow_id: "test-wf" },
    ]);
    try {
      const res = run(ttChaos, [
        "kill-daemon",
        "--run", "run-s28-terminal-daemon",
        "--when", "step:finalize_merge:running",
        "--timeout", "30",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 2, `kill-daemon on a terminal run must exit 2, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, /chaos-refused: run run-s28-terminal-daemon already terminal \(failed\) before trigger step:finalize_merge:running \(kill-daemon\) — refusing to wait/,
        `kill-daemon refusal must name the run, status, trigger and action: ${res.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): a RUNNING run is NOT refused at startup (the refusal is terminal-only)", () => {
    const dir = fakeTtVar([
      { run_id: "run-s28-running", status: "running", workflow_id: "test-wf" },
    ]);
    try {
      // A running run proceeds past the startup guard into phaseWait — with a
      // 1s timeout and no steps row, it times out with exit 2
      // TRIGGER_NEVER (NOT a chaos-refused startup refusal), proving the
      // startup guard does not over-refuse live runs.
      const res = run(ttChaos, [
        "kill-harness",
        "--run", "run-s28-running",
        "--when", "step:fixer:running",
        "--timeout", "1",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 2);
      assert.doesNotMatch(res.stderr, /chaos-refused/,
        "a running run must not hit the startup terminal refusal: " + res.stderr);
      assert.match(res.stderr, /TRIGGER_NEVER_MATERIALIZED/,
        "a running run with an unfired marker must time out via phaseWait: " + res.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
