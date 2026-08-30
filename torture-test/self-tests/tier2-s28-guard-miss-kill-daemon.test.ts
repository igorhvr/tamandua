// S28 (US-006) — kill-daemon target verification: accept the real contained
// daemon (exit-3 GUARD_MISS path, W4.48a-daemon-kill-mid-park).
//
// The tier-2 attempt-2 campaign (campaign-20260826T225744158Z-4bf26d7f) left
// W4.48a-daemon-kill-mid-park TEST_INFRA_FAIL 'chaos-invocation-failed' with
// `chaos operator 'tt-chaos' exited 3`. The chaos.log guard_miss entry
// (snapshots/W4.40-trailer-absent/attempt-1/chaos.log) pins the exact reason:
//
//   {"action":"kill-daemon","runId":"run-5437803d-...","phaseMarker":
//    "step:finalize_merge:running","phaseSatisfied":true,"target":"process",
//    "outcome":"guard_miss","error":"Process 4080359 cwd/cmdline does not
//    contain /home/igorhvr/idm/tamandua/torture-test/var",...}
//
// Root cause: verifyKillTarget's belt-and-suspenders provenance check
// (verifyProcessProvenance) required the resolved target's cwd to be under
// TT_ROOT AND its cmdline to carry the run id OR TT_ROOT. The REAL contained
// daemon (resolved from its pidfile) legitimately runs from a different cwd
// with a cmdline (`node .../dist/cli/cli.js daemon`) that contains NEITHER —
// so kill-daemon could never pass provenance against it and always
// GUARD_MISSed (exit 3), voiding the cell before the oracle could judge.
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   * kill-daemon targets (pidfile-resolved) verify identity — pid alive,
//     /proc start identity (tt-process-identity), ancestry/group
//     disjointness, pidfile-path-under-TT_ROOT containment — WITHOUT the
//     cwd/cmdline provenance requirement;
//   * harness targets (kill-harness / sigstop_sigcont) KEEP the strict
//     provenance check;
//   * an out-of-scope pidfile (not under TT_ROOT — could name the production
//     daemon) is refused at RESOLUTION with a precise one-line reason;
//   * a daemon whose process group is unreadable (a /proc-less host) or that
//     shares the caller's pgid refuses fail-closed.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC2): pins the campaign failure line + the exact guard_miss
//     message verbatim, and reproduces the pre-fix provenance criterion
//     inline against a daemon-like process (spawned OUTSIDE TT_ROOT cwd with
//     a cmdline containing neither TT_ROOT nor the run id) — the criterion
//     fails exactly as the campaign recorded (the pre-fix tt-chaos would
//     have exited 3 GUARD_MISS);
//   * GREEN-ARM (AC1/AC2): the FIXED tt-chaos kill-daemon accepts the same
//     daemon-like pidfile-resolved process (exit 0, SIGKILL fires, process
//     dead) — the W4.48a corridor;
//   * FAIL-CLOSED (AC3/AC4): an out-of-scope pidfile refuses at resolution
//     with the precise one-line reason (never a signal, never a scan), and a
//     same-group foreign pid in a TT_ROOT pidfile refuses via the group
//     gate; kill-harness against the same outside-cwd process still
//     GUARD_MISSes (strict provenance retained).
//
// Follows the tier2-*.test.ts self-test pattern (imports node builtins +
// repo-relative files only); picked up by self-tests/run.sh's tier2 glob.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const ttChaos = path.join(ttRoot, "bin", "tt-chaos");

// ── Pinned campaign evidence (campaign-20260826T225744158Z-4bf26d7f) ────
// report.txt INFRA FAILURE line for W4.48a, verbatim:
//   `W4.48a-daemon-kill-mid-park: chaos-invocation-failed (chaos operator
//    'tt-chaos' exited 3)`
// (the controller's pre-fix chaos-invocation-failed message: `chaos operator
// '<op>' exited <code>`).
const CAMPAIGN_CELL_LINE =
  "W4.48a-daemon-kill-mid-park: chaos-invocation-failed (chaos operator 'tt-chaos' exited 3)";

// The chaos.log guard_miss error string for the W4.48a kill-daemon
// invocation, verbatim (snapshots/W4.40-trailer-absent/attempt-1/chaos.log,
// ts 2026-08-27T02:47:39.505Z):
const CAMPAIGN_GUARD_MISS_ERROR =
  "Process 4080359 cwd/cmdline does not contain /home/igorhvr/idm/tamandua/torture-test/var";

// The failing run id + the operator argv shape the campaign captured: the
// operator was spawned with the FULL run id (`--run run-5437803d-...`) and
// the calibrated trigger `--when step:finalize_merge:running`.
const W4_48A_RUN_ID = "run-5437803d-a2a6-458d-bcaa-de627623aaf5";
const W4_48A_TRIGGER = "step:finalize_merge:running";

// The pre-fix kill-daemon guard_miss verdict message template — the operator
// printed `GUARD_MISS: <error>` to stderr and exited EXIT_GUARD_MISS (3).
// Reproduced inline (history-independent red-arm — tier0-history-independent-
// red-arms): the criterion is embedded here, not resolved from git.
function preFixProvenanceCheck(pid: number, ttRootPath: string, runId: string): { ok: boolean; reason: string } {
  const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  const ok = cwd.includes(ttRootPath) && (cmdline.includes(runId) || cmdline.includes(ttRootPath));
  return {
    ok,
    reason: ok ? "ok" : `Process ${pid} cwd/cmdline does not contain ${ttRootPath}`,
  };
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
  const dir = fs.mkdtempSync(path.join(varRoot, `s28-kd-${process.pid}-`));
  fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
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

// spawnDaemonLike: spawn a node process shaped like the REAL contained
// daemon — cwd OUTSIDE the given TT root, argv[0] = a cli.js path (cmdline
// contains NEITHER the TT root NOR the run id), in its OWN session/process
// group (detached — like daemon-control's setsid launch), so the identity
// gates (alive, group disjointness) pass while the pre-fix provenance
// criterion fails. Returns { child, pid }.
function spawnDaemonLike(outsideCwd: string, cliArgv0: string): { child: ReturnType<typeof spawn>; pid: number } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    cwd: outsideCwd,
    detached: true,
    argv0: cliArgv0,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid, "daemon-like child must have a pid");
  return { child, pid: child.pid };
}

describe("S28 (US-006) — kill-daemon exit-3 GUARD_MISS: target verification accepts the real contained daemon", () => {
  it("RED-ARM: pins the campaign failure line and the exact guard_miss message verbatim", () => {
    assert.equal(
      CAMPAIGN_CELL_LINE,
      "W4.48a-daemon-kill-mid-park: chaos-invocation-failed (chaos operator 'tt-chaos' exited 3)",
      "the campaign report line must be pinned exactly",
    );
    assert.match(CAMPAIGN_CELL_LINE, /^W4\.48a-daemon-kill-mid-park: chaos-invocation-failed \(chaos operator 'tt-chaos' exited 3\)$/);
    assert.match(
      CAMPAIGN_GUARD_MISS_ERROR,
      /^Process 4080359 cwd\/cmdline does not contain \/home\/igorhvr\/idm\/tamandua\/torture-test\/var$/,
      "the chaos.log guard_miss error must be pinned exactly",
    );
    assert.match(W4_48A_RUN_ID, /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(W4_48A_TRIGGER, "step:finalize_merge:running");
  });

  it("RED-ARM: the pre-fix provenance criterion fails a daemon-like process outside TT_ROOT with the EXACT campaign message", async () => {
    const dir = fakeTtVar([{ run_id: "run-s28-kd-redarm", status: "running", workflow_id: "test-wf" }]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s28-kd-outside-${process.pid}-`));
    const daemon = spawnDaemonLike(outside, path.join(outside, "tt-dist", "cli", "cli.js"));
    try {
      // MACP3 US-003: /proc/<pid>/cwd + cmdline are linux-only — on a
      // /proc-less (Darwin) host the reads fail and the assertion is SKIPPED
      // (the pre-fix code path would also refuse there — provenance degrades
      // to 'unproven').
      let verdict: { ok: boolean; reason: string } | null = null;
      try {
        verdict = preFixProvenanceCheck(daemon.pid, dir, "run-s28-kd-redarm");
      } catch {
        verdict = null;
      }
      if (verdict === null) {
        assert.ok(!fs.existsSync("/proc"), "provenance read must only fail on a /proc-less host (Darwin skip)");
      } else {
        assert.equal(verdict.ok, false,
          "pre-fix provenance must refuse a daemon whose cwd is outside TT_ROOT and whose cmdline carries neither TT_ROOT nor the run id");
        // The exact campaign message shape — `Process <pid> cwd/cmdline does
        // not contain <TT_ROOT>` (the chaos.log guard_miss error string).
        assert.equal(verdict.reason, `Process ${daemon.pid} cwd/cmdline does not contain ${dir}`);
        // The pre-fix operator printed `GUARD_MISS: <reason>` and exited
        // EXIT_GUARD_MISS (3) — the campaign's `chaos operator 'tt-chaos'
        // exited 3`.
        const preFixStderr = `GUARD_MISS: ${verdict.reason}`;
        assert.match(preFixStderr, /^GUARD_MISS: Process \d+ cwd\/cmdline does not contain .+$/);
      }
      // The daemon-like process is alive and its own group leader (the shape
      // the FIXED identity gates must accept).
      process.kill(daemon.pid, 0);
    } finally {
      try {
        if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC1/AC2): the FIXED kill-daemon accepts the pidfile-resolved daemon-like process outside TT_ROOT and fires", async () => {
    const dir = fakeTtVar([{ run_id: "run-s28-kd-green", status: "running", workflow_id: "test-wf" }]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s28-kd-outside-${process.pid}-`));
    const daemon = spawnDaemonLike(outside, path.join(outside, "tt-dist", "cli", "cli.js"));
    try {
      // Record the daemon in the contained pidfile (TAMANDUA_STATE_DIR under
      // TT_ROOT — the pidfile-path-under-TT_ROOT containment check passes).
      fs.writeFileSync(path.join(dir, "tamandua.pid"), `${daemon.pid}\n`);
      // Attach the exit listener BEFORE the fire so a prompt reap cannot race
      // the assertion (the child is SIGKILLed by tt-chaos; the exit event is
      // the authoritative termination signal — a SIGKILLed but unreaped child
      // lingers as a zombie that still answers kill(pid, 0)).
      const exitedPromise = Promise.race([
        new Promise<boolean>((resolve) => daemon.child.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      const res = run(ttChaos, [
        "kill-daemon",
        "--run", "run-s28-kd-green",
        "--when", "now",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 0, `kill-daemon must fire against the contained-daemon shape, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`SIGKILL sent to daemon PID ${daemon.pid} \\(run run-s28-kd-green\\)`),
        `kill-daemon must name the fired PID: ${res.stderr}`);
      assert.equal(await exitedPromise, true, "daemon-like process must terminate after kill-daemon fired");
    } finally {
      try {
        if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED (AC3): an out-of-scope pidfile (not under TT_ROOT) refuses at resolution with a precise one-line reason, never a signal", () => {
    const dir = fakeTtVar([{ run_id: "run-s28-kd-outside-pidfile", status: "running", workflow_id: "test-wf" }]);
    const outsideHome = fs.mkdtempSync(path.join(os.tmpdir(), `s28-kd-home-${process.pid}-`));
    fs.mkdirSync(path.join(outsideHome, ".tamandua"), { recursive: true });
    // A live foreign process recorded in an OUT-OF-SCOPE daemon.pid (the
    // shape a mis-pointed TT_HOME would produce — the production daemon
    // pidfile lives outside the contained var tree).
    const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(foreign.pid, "foreign child must have a pid");
    try {
      fs.writeFileSync(path.join(outsideHome, ".tamandua", "daemon.pid"), `${foreign.pid}\n`);
      // TAMANDUA_STATE_DIR stays inside TT_ROOT (run guard + DB resolve);
      // TT_HOME points OUTSIDE TT_ROOT so the only pidfile candidate is
      // out of scope.
      const res = run(ttChaos, [
        "kill-daemon",
        "--run", "run-s28-kd-outside-pidfile",
        "--when", "now",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: outsideHome,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 3, `out-of-scope pidfile must refuse with GUARD_MISS (3), got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, /GUARD_MISS: daemon pidfile .+ is not under .+ — refusing to resolve the daemon from an out-of-scope pidfile/,
        `the refusal must name the out-of-scope pidfile precisely: ${res.stderr}`);
      // The foreign process must survive — no signal, no silent scan fallback.
      process.kill(foreign.pid, 0);
    } finally {
      try {
        foreign.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outsideHome, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED (AC3): a same-group foreign pid in a TT_ROOT pidfile refuses via the group-disjointness gate", () => {
    const dir = fakeTtVar([{ run_id: "run-s28-kd-foreign", status: "running", workflow_id: "test-wf" }]);
    // NOT detached: the foreign process shares this test process's process
    // group, so kill-daemon's group-disjointness gate must refuse it
    // (on a /proc-less host the unreadable-pgid fail-closed gate refuses).
    const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(foreign.pid, "foreign child must have a pid");
    try {
      fs.writeFileSync(path.join(dir, "tamandua.pid"), `${foreign.pid}\n`);
      const res = run(ttChaos, [
        "kill-daemon",
        "--run", "run-s28-kd-foreign",
        "--when", "now",
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 3, `a same-group foreign pid must refuse with GUARD_MISS (3), got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, /GUARD_MISS: (target pid \d+ shares the caller's own pgid \d+ — refusing to signal own group|cannot read the process group of daemon pid \d+ \(no \/proc\))/,
        `the refusal must name the group gate precisely: ${res.stderr}`);
      // The foreign process must survive.
      process.kill(foreign.pid, 0);
    } finally {
      try {
        foreign.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED (AC4): kill-harness against the same outside-cwd process STILL refuses (strict provenance retained for harness targets)", () => {
    const dir = fakeTtVar([{ run_id: "run-s28-kd-harness-strict", status: "running", workflow_id: "test-wf" }]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s28-kd-outside-${process.pid}-`));
    const daemon = spawnDaemonLike(outside, path.join(outside, "tt-dist", "cli", "cli.js"));
    try {
      // The fix relaxes the cwd/cmdline provenance requirement ONLY for
      // pidfile-resolved daemon targets. kill-harness hands the SAME
      // outside-cwd process as an explicit --target-pid: the strict harness
      // provenance check must still refuse (never weakened).
      const res = run(ttChaos, [
        "kill-harness",
        "--run", "run-s28-kd-harness-strict",
        "--when", "now",
        "--target-pid", String(daemon.pid),
      ], {
        TAMANDUA_STATE_DIR: dir,
        TT_HOME: dir,
        TT_ROOT: dir,
      });
      assert.equal(res.status, 3, `kill-harness on an outside-cwd process must still GUARD_MISS (3), got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, /GUARD_MISS: Process \d+ cwd\/cmdline does not contain .+/,
        `the harness refusal must name the provenance failure: ${res.stderr}`);
      // The outside process must survive (kill-harness refused to signal it).
      process.kill(daemon.pid, 0);
    } finally {
      try {
        if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
