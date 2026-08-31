// S33 (US-004) — kill-harness identity evidence chain accepts the REAL pi
// worker (never weakens the guard).
//
// The tier-2 re-run campaign (campaign-20260830T063409637Z-2d03967a-2441-
// 4abf-92a7-e852f934580a) left W4.09-pi-kill-harness TEST_INFRA_FAIL
// 'chaos-invocation-failed' with the chaos.log/process_tree guard_miss
// evidence pinning the exact reason:
//
//   report.txt: W4.09-pi-kill-harness: chaos-invocation-failed (chaos
//     operator 'tt-chaos' exited 3: GUARD_MISS: Process 2074648 cwd/cmdline
//     does not contain /home/igorhvr/idm/tamandua/torture-test/var)
//   process_tree.txt: Target record: {"pid":2074648,"pgid":2074648,
//     "startTime":"proc:442043503"}; "Verification: refused — Process
//     2074648 cwd/cmdline does not contain .../torture-test/var";
//     "Cmdline: pi" — the REAL pi worker's argv is scrubbed to the binary
//     name (the daemon log shows the launch: `pi launched {"pid":2074648,
//     "pgid":2074648,...}` at 2026-08-30T06:36:46Z), so the strict
//     belt-and-suspenders cwd/cmdline provenance check (verifyProcessProvenance)
//     can never pass for a legitimate kill.
//
// Root cause: verifyKillTarget's harness branch required the resolved
// target's cwd to be under TT_ROOT AND its cmdline to carry the run id OR
// TT_ROOT. The real pi worker shape satisfies NEITHER (cwd outside the
// contained tree, cmdline scrubbed) — so kill-harness always GUARD_MISSed
// (exit 3), voiding the cell before the oracle could judge.
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   * harness targets whose STRICT cwd/cmdline provenance check fails fall
//     back to a POSITIVE tt-ownership evidence chain built on EXPLICIT
//     RECORDED identity only (never a /proc cwd/cmdline sweep):
//       1. verifyRecordedTarget MUST pass (pid alive + recorded
//          --target-start-time ABA match + ancestry/group disjointness);
//       2. plus at least ONE positive tt-ownership proof:
//          (a) pid equals the steps-table claim_pgid harness group for the
//              run (resolveFromStepsTable — the product's own claim record);
//          (b) the parent-chain walk (getProcessParent ppid walk) reaches an
//              ancestor whose cwd/cmdline IS under TT_ROOT (the contained
//              daemon/harness that spawned the worker);
//          (c) open-fd evidence: /proc/<pid>/fd resolves a descriptor into
//              TT_ROOT/var (linux-only — unreadable degrades to unproven,
//              never to proven).
//   * any record with NO positive chain proof still GUARD_MISSes (exit 3)
//     with the precise provenance reason annotated with the chain miss;
//   * the kill-daemon daemon-kind path (S28 US-006) is UNCHANGED.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC2): pins the campaign failure line + the process_tree
//     evidence verbatim, and reproduces the pre-fix provenance criterion
//     inline against a pi-shaped process (spawned OUTSIDE TT_ROOT cwd with a
//     cmdline containing neither TT_ROOT nor the run id) — the criterion
//     fails exactly as the campaign recorded (the pre-fix tt-chaos would
//     have exited 3 GUARD_MISS);
//   * GREEN-ARM (AC1): the FIXED tt-chaos kill-harness ACCEPTS the same
//     pi-shaped process (exit 0, SIGKILL fires, process dead) via each of
//     the three positive proofs — (a) steps claim row, (b) parent chain to a
//     TT_ROOT-owned ancestor, (c) open fd into var;
//   * FAIL-CLOSED (AC2): a pi-shaped FOREIGN process with NO positive chain
//     proof still refuses exit 3 GUARD_MISS with the precise one-line reason
//     and SURVIVES.
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
const ttProcessIdentity = path.join(ttRoot, "bin", "tt-process-identity.mjs");

// ── Pinned campaign evidence (campaign-20260830T063409637Z-2d03967a) ────
// report.txt INFRA FAILURE line for W4.09, verbatim:
const CAMPAIGN_CELL_LINE =
  "W4.09-pi-kill-harness: chaos-invocation-failed (chaos operator 'tt-chaos' exited 3: GUARD_MISS: Process 2074648 cwd/cmdline does not contain /home/igorhvr/idm/tamandua/torture-test/var)";

// The chaos evidence dir's process_tree.txt (evidence/W4.09-pi-kill-harness,
// chaos dir 2026-08-30T06-36-49-420Z-kill-harness), verbatim lines:
const CAMPAIGN_TARGET_RECORD = 'Target record: {"pid":2074648,"pgid":2074648,"startTime":"proc:442043503"}';
const CAMPAIGN_VERIFICATION_LINE =
  "Verification: refused — Process 2074648 cwd/cmdline does not contain /home/igorhvr/idm/tamandua/torture-test/var";
const CAMPAIGN_CMDLINE_LINE = "Cmdline: pi";

// The failing run id (from the launch evidence) + the daemon-log launch
// shape that proves the target was the REAL pi harness (own group leader).
const W4_09_RUN_ID = "run-7f897d2b-b13f-4696-8a66-39a01624d0fe";
const W4_09_PI_PID = 2074648;

// The pre-fix harness provenance criterion — the exact verifyProcessProvenance
// semantics at the time of the campaign (cwd under TT_ROOT AND cmdline
// carrying the run id or TT_ROOT). Reproduced inline (history-independent
// red-arm — tier0-history-independent-red-arms), never resolved from git.
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

// Build a throwaway TT var directory with a fake contained DB carrying the
// given run rows and (optionally) a steps claim row (claim_pid/claim_pgid —
// the product's explicit worker-ownership record). Returns the dir (the
// caller removes it).
function fakeTtVar(
  runRows: Array<{ run_id: string; status: string; workflow_id?: string }>,
  stepsRow?: { run_id: string; step_id: string; claim_pid: number; claim_pgid: number },
): string {
  const dir = fs.mkdtempSync(path.join(varRoot, `s33-pi-${process.pid}-`));
  fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "tamandua.db"), { open: true });
  db.exec(`CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    workflow_id TEXT,
    created_at TEXT
  );
  CREATE TABLE steps (
    run_id TEXT,
    step_id TEXT PRIMARY KEY,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'waiting',
    claim_pid INTEGER,
    claim_pgid INTEGER
  );`);
  for (const row of runRows) {
    db.prepare("INSERT OR REPLACE INTO runs (run_id, status, workflow_id) VALUES (?, ?, ?)")
      .run(row.run_id, row.status, row.workflow_id ?? null);
  }
  if (stepsRow) {
    db.prepare("INSERT OR REPLACE INTO steps (run_id, step_id, status, claim_pid, claim_pgid) VALUES (?, ?, 'running', ?, ?)")
      .run(stepsRow.run_id, stepsRow.step_id, stepsRow.claim_pid, stepsRow.claim_pgid);
  }
  db.close();
  return dir;
}

// spawnPiShaped: spawn a process shaped like the REAL pi worker — cwd
// OUTSIDE the given TT root, cmdline containing NEITHER the TT root NOR the
// run id (argv[0] = 'pi', the scrubbed binary-name shape the W4.09 campaign
// recorded: `Cmdline: pi`), in its OWN session/process group (detached —
// the pi harness is its own group leader, `pi launched {"pid":..,"pgid":..}`
// with pid == pgid). Returns { child, pid }.
function spawnPiShaped(outsideCwd: string, argv0 = "pi"): { child: ReturnType<typeof spawn>; pid: number } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    cwd: outsideCwd,
    detached: true,
    argv0,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid, "pi-shaped child must have a pid");
  return { child, pid: child.pid };
}

// startIdentityOf: the process-start identity of a pid via the shared
// tt-process-identity --get CLI ('proc:<starttime>' on linux; on a
// /proc-less host the ps-lstart darwin identity — 1-second granularity).
// The controller passes the RAW number (proc:-stripped) as
// --target-start-time; tt-chaos re-prefixes it. Returns null when the
// identity cannot be read (a /proc-less host where ps also fails).
function startIdentityOf(pid: number): string | null {
  const res = spawnSync(process.execPath, [ttProcessIdentity, "--get", String(pid)], {
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  if (res.status !== 0) return null;
  const raw = String(res.stdout ?? "").trim();
  if (raw === "") return null;
  // 'proc:<n>' -> raw '<n>' (what buildChaosArgv hands tt-chaos); a darwin
  // identity ('darwin:<lstart>') is passed through untouched by the same
  // stripping rule (only a leading 'proc:' is stripped).
  return raw.startsWith("proc:") ? raw.slice("proc:".length) : raw;
}

// ── killHarness helper: run tt-chaos kill-harness against a pi-shaped
// target with the explicit recorded identity args (the controller's argv
// shape), returning the spawn result.
function killHarness(
  ttVarDir: string,
  runId: string,
  targetPid: number,
  targetStart?: string | null,
): { status: number | null; stdout: string; stderr: string } {
  const args = ["kill-harness", "--run", runId, "--when", "now", "--target-pid", String(targetPid)];
  if (targetStart) args.push("--target-start-time", targetStart);
  return run(ttChaos, args, {
    TAMANDUA_STATE_DIR: ttVarDir,
    TT_HOME: ttVarDir,
    TT_ROOT: ttVarDir,
  });
}

describe("S33 (US-004) — kill-harness identity evidence chain accepts the real pi worker (never weakens the guard)", () => {
  it("RED-ARM: pins the campaign failure line and the process_tree guard_miss evidence verbatim", () => {
    assert.equal(
      CAMPAIGN_CELL_LINE,
      "W4.09-pi-kill-harness: chaos-invocation-failed (chaos operator 'tt-chaos' exited 3: GUARD_MISS: Process 2074648 cwd/cmdline does not contain /home/igorhvr/idm/tamandua/torture-test/var)",
      "the campaign report line must be pinned exactly",
    );
    assert.match(CAMPAIGN_CELL_LINE, /^W4\.09-pi-kill-harness: chaos-invocation-failed \(chaos operator 'tt-chaos' exited 3: GUARD_MISS: Process 2074648 cwd\/cmdline does not contain \/home\/igorhvr\/idm\/tamandua\/torture-test\/var\)$/);
    assert.equal(CAMPAIGN_TARGET_RECORD, 'Target record: {"pid":2074648,"pgid":2074648,"startTime":"proc:442043503"}');
    assert.match(
      CAMPAIGN_VERIFICATION_LINE,
      /^Verification: refused — Process 2074648 cwd\/cmdline does not contain \/home\/igorhvr\/idm\/tamandua\/torture-test\/var$/,
    );
    // The scrubbed binary-name cmdline shape — the root of the S33 defect.
    assert.equal(CAMPAIGN_CMDLINE_LINE, "Cmdline: pi");
    // The daemon-log launch shape: the pi harness is its own group leader.
    assert.match(W4_09_RUN_ID, /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(Number.isInteger(W4_09_PI_PID) && W4_09_PI_PID > 0);
  });

  it("RED-ARM: the pre-fix provenance criterion fails a pi-shaped process with the EXACT campaign message", async () => {
    const dir = fakeTtVar([{ run_id: "run-s33-pi-redarm", status: "running", workflow_id: "test-wf" }]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s33-pi-outside-${process.pid}-`));
    const pi = spawnPiShaped(outside);
    try {
      // MACP3 US-003: /proc/<pid>/cwd + cmdline are linux-only — on a
      // /proc-less (Darwin) host the reads fail and the assertion is SKIPPED
      // (the pre-fix code path would also refuse there — provenance degrades
      // to 'unproven').
      let verdict: { ok: boolean; reason: string } | null = null;
      try {
        verdict = preFixProvenanceCheck(pi.pid, dir, "run-s33-pi-redarm");
      } catch {
        verdict = null;
      }
      if (verdict === null) {
        assert.ok(!fs.existsSync("/proc"), "provenance read must only fail on a /proc-less host (Darwin skip)");
      } else {
        assert.equal(verdict.ok, false,
          "pre-fix provenance must refuse a pi-shaped process whose cwd is outside TT_ROOT and whose cmdline carries neither TT_ROOT nor the run id");
        // The exact campaign message shape — `Process <pid> cwd/cmdline does
        // not contain <TT_ROOT>` (the chaos.log guard_miss error string).
        assert.equal(verdict.reason, `Process ${pi.pid} cwd/cmdline does not contain ${dir}`);
        // The pre-fix operator printed `GUARD_MISS: <reason>` and exited
        // EXIT_GUARD_MISS (3) — the campaign's `chaos operator 'tt-chaos'
        // exited 3`.
        const preFixStderr = `GUARD_MISS: ${verdict.reason}`;
        assert.match(preFixStderr, /^GUARD_MISS: Process \d+ cwd\/cmdline does not contain .+$/);
      }
      // The pi-shaped process is alive and its own group leader (the shape
      // the FIXED identity gates must accept).
      process.kill(pi.pid, 0);
    } finally {
      try {
        if (pi.child.exitCode === null && pi.child.signalCode === null) pi.child.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC1, proof a): a pi-shaped process whose pid equals the steps-table claim_pgid is accepted and signalled", async () => {
    const runId = "run-s33-pi-green-a";
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s33-pi-outside-${process.pid}-`));
    const pi = spawnPiShaped(outside);
    const start = startIdentityOf(pi.pid);
    // The steps claim row records the harness process group (claim_pgid) —
    // the product's own explicit worker-ownership record. For the detached
    // pi harness the group leader pid == pgid (the daemon-log shape).
    const dir = fakeTtVar(
      [{ run_id: runId, status: "running", workflow_id: "test-wf" }],
      { run_id: runId, step_id: "fix", claim_pid: 999999, claim_pgid: pi.pid },
    );
    try {
      // Attach the exit listener BEFORE the fire so a prompt reap cannot race
      // the assertion (the child is SIGKILLed by tt-chaos; the exit event is
      // the authoritative termination signal — a SIGKILLed but unreaped child
      // lingers as a zombie that still answers kill(pid, 0)).
      const exitedPromise = Promise.race([
        new Promise<boolean>((resolve) => pi.child.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      const res = killHarness(dir, runId, pi.pid, start);
      assert.equal(res.status, 0, `kill-harness must fire via the steps-claim-row proof, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`SIGKILL sent to harness PID ${pi.pid} \\(run ${runId}\\)`),
        `kill-harness must name the fired PID: ${res.stderr}`);
      assert.match(res.stderr, /positive tt-ownership chain proof: steps claim row claim_pgid \d+ matches target pid \d+/,
        `the verdict must name the steps-claim-row proof: ${res.stderr}`);
      assert.equal(await exitedPromise, true, "pi-shaped process must terminate after kill-harness fired");
    } finally {
      try {
        if (pi.child.exitCode === null && pi.child.signalCode === null) pi.child.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC1, proof b): a pi-shaped process whose parent chain reaches a TT_ROOT-owned ancestor is accepted and signalled", async () => {
    // MACP3 US-003: the parent-chain proof walks /proc ppid + cwd/cmdline —
    // linux-only. On a /proc-less host the proof degrades to unproven and
    // this arm is a pass-by-note skip (the steps-claim-row arm covers the
    // chain on every host).
    if (!fs.existsSync("/proc")) {
      assert.ok(!fs.existsSync("/proc"), "parent-chain proof is linux-only (Darwin skip)");
      return;
    }
    const runId = "run-s33-pi-green-b";
    const dir = fakeTtVar([{ run_id: runId, status: "running", workflow_id: "test-wf" }]);
    // A "contained daemon" process whose CWD is under TT_ROOT (the contained
    // state dir — the shape that spawns real workers). It spawns the
    // pi-shaped grandchild with cwd OUTSIDE TT_ROOT and a scrubbed 'pi'
    // cmdline, then writes the grandchild pid to a pidfile and waits.
    const daemonHome = path.join(dir, "home", ".tamandua");
    fs.mkdirSync(daemonHome, { recursive: true });
    const grandchildPidFile = path.join(dir, "grandchild.pid");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s33-pi-outside-${process.pid}-`));
    const daemon = spawn(process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const pidFile = ${JSON.stringify(grandchildPidFile)};
      const outsideCwd = ${JSON.stringify(outside)};
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
        cwd: outsideCwd,
        detached: true,
        argv0: 'pi',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      fs.writeFileSync(pidFile, String(child.pid));
      setTimeout(() => {}, 120000);
    `], {
      cwd: daemonHome,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(daemon.pid, "contained daemon must have a pid");
    try {
      // Wait for the pi-shaped grandchild to exist (the daemon writes its pid).
      let grandchildPid = 0;
      for (let i = 0; i < 100; i += 1) {
        try {
          const raw = fs.readFileSync(grandchildPidFile, "utf8").trim();
          if (raw !== "") {
            grandchildPid = Number(raw);
            break;
          }
        } catch {
          // not yet written
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(grandchildPid > 0, "contained daemon must spawn the pi-shaped grandchild");
      const start = startIdentityOf(grandchildPid);
      // The grandchild's OWN cwd is outside TT_ROOT and its cmdline carries
      // neither TT_ROOT nor the run id — the W4.09 shape — but its parent
      // chain reaches the contained daemon whose cwd IS under TT_ROOT.
      try {
        const grandchildCwd = fs.readlinkSync(`/proc/${grandchildPid}/cwd`);
        assert.ok(!grandchildCwd.includes(dir), "test setup: grandchild cwd must be outside TT_ROOT");
        const grandchildCmdline = fs.readFileSync(`/proc/${grandchildPid}/cmdline`, "utf8").replace(/\0/g, " ");
        assert.ok(!grandchildCmdline.includes(dir) && !grandchildCmdline.includes(runId),
          "test setup: grandchild cmdline must carry neither TT_ROOT nor the run id");
      } catch {
        // /proc races — the fire below is the authoritative assertion
      }
      // We don't hold the grandchild's handle — poll for its death instead
      // (a SIGKILLed but unreaped child lingers as a zombie that still
      // answers kill(pid, 0), so the poll must observe the exit event).
      const piChildExit = Promise.race([
        new Promise<boolean>((resolve) => {
          const poll = () => {
            try {
              process.kill(grandchildPid, 0);
              setTimeout(poll, 100);
            } catch {
              resolve(true);
            }
          };
          setTimeout(poll, 100);
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      const res = killHarness(dir, runId, grandchildPid, start);
      assert.equal(res.status, 0, `kill-harness must fire via the parent-chain proof, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`SIGKILL sent to harness PID ${grandchildPid} \\(run ${runId}\\)`),
        `kill-harness must name the fired PID: ${res.stderr}`);
      assert.match(res.stderr, /positive tt-ownership chain proof: ancestor pid \d+ cwd\/cmdline is under /,
        `the verdict must name the parent-chain proof: ${res.stderr}`);
      assert.equal(await piChildExit, true, "pi-shaped grandchild must terminate after kill-harness fired");
    } finally {
      try {
        if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC1, proof c): a pi-shaped process holding an open fd into var is accepted and signalled", async () => {
    // MACP3 US-003: the open-fd proof reads /proc/<pid>/fd — linux-only. On
    // a /proc-less host the proof degrades to unproven and this arm is a
    // pass-by-note skip (the steps-claim-row arm covers the chain on every
    // host).
    if (!fs.existsSync("/proc")) {
      assert.ok(!fs.existsSync("/proc"), "open-fd proof is linux-only (Darwin skip)");
      return;
    }
    const runId = "run-s33-pi-green-c";
    const dir = fakeTtVar([{ run_id: runId, status: "running", workflow_id: "test-wf" }]);
    // A file inside the contained var tree that the pi-shaped worker keeps
    // open (fd evidence — a worker holding a descriptor into var is
    // positively tt-owned).
    const markerFile = path.join(dir, "chaos", "s33-fd-marker.txt");
    fs.writeFileSync(markerFile, "x");
    const readyFile = path.join(dir, "chaos", "s33-fd-ready.txt");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s33-pi-outside-${process.pid}-`));
    const pi = spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      const fd = fs.openSync(${JSON.stringify(markerFile)}, 'r');
      fs.writeFileSync(${JSON.stringify(readyFile)}, String(fd));
      setTimeout(() => {}, 120000);
    `], {
      cwd: outside,
      detached: true,
      argv0: "pi",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(pi.pid, "fd-holding pi-shaped child must have a pid");
    try {
      // Wait until the child has opened the fd (ready file written).
      let ready = false;
      for (let i = 0; i < 100; i += 1) {
        if (fs.existsSync(readyFile)) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, "pi-shaped child must open the var fd before the fire");
      const start = startIdentityOf(pi.pid);
      const exitedPromise = Promise.race([
        new Promise<boolean>((resolve) => pi.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      const res = killHarness(dir, runId, pi.pid, start);
      assert.equal(res.status, 0, `kill-harness must fire via the open-fd proof, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`SIGKILL sent to harness PID ${pi.pid} \\(run ${runId}\\)`),
        `kill-harness must name the fired PID: ${res.stderr}`);
      assert.match(res.stderr, /positive tt-ownership chain proof: open fd \d+ resolves to .+ under /,
        `the verdict must name the open-fd proof: ${res.stderr}`);
      assert.equal(await exitedPromise, true, "fd-holding pi-shaped process must terminate after kill-harness fired");
    } finally {
      try {
        if (pi.exitCode === null && pi.signalCode === null) pi.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED (AC2): a pi-shaped FOREIGN process with no positive chain proof refuses exit 3 GUARD_MISS and survives", async () => {
    const runId = "run-s33-pi-red";
    // No steps claim row for this run (the fake DB has no steps rows at
    // all), no TT_ROOT-owned ancestor, no open fd into var.
    const dir = fakeTtVar([{ run_id: runId, status: "running", workflow_id: "test-wf" }]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `s33-pi-outside-${process.pid}-`));
    const foreign = spawnPiShaped(outside);
    const start = startIdentityOf(foreign.pid);
    try {
      const res = killHarness(dir, runId, foreign.pid, start);
      assert.equal(res.status, 3, `a foreign pi-shaped process must refuse with GUARD_MISS (3), got ${res.status}: ${res.stderr}`);
      // The precise one-line reason: the strict provenance failure annotated
      // with the chain miss (never a silent fallback to a scan).
      assert.match(res.stderr, /GUARD_MISS: Process \d+ cwd\/cmdline does not contain .+ — no positive tt-ownership chain proof \(/,
        `the refusal must name the provenance failure + chain miss: ${res.stderr}`);
      assert.match(res.stderr, /no steps claim row for the run/,
        `the chain miss must name the absent steps claim row: ${res.stderr}`);
      // The foreign process must survive — no signal, no silent scan fallback.
      process.kill(foreign.pid, 0);
    } finally {
      try {
        if (foreign.child.exitCode === null && foreign.child.signalCode === null) foreign.child.kill("SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
