// S56 (US-002) — scripted daemon stop must wait for listeners AND children
// to exit; start waits bounded (default >= 30s); 'ports still in use'
// classifies as INFRA with the holder pid/cmdline.
//
// Defect: daemon-control cmd_stop's terminal check was a SINGLE pass after a
// 0.5s settle — when the dashboard/mcp/control-plane children survived (they
// are NOT the recorded daemon pid, so cmd_stop's lingering-listener cleanup
// refuses to touch them on the plain-background path that Darwin always
// takes), cmd_stop printed a WARNING and RETURNED 0 while a listener was
// still bound. The next start then collided with EADDRINUSE on the shared
// scripted ports 5334/5338/5339 (the bare --tier0 33/33 gate; scenario
// stop->start barriers such as w4.12-port-squatter) — a silent race that a
// cell could never classify (never infra, never a clean failure).
//
// Fix (confined to torture-test/):
//   1. cmd_stop ends with a BOUNDED final gate (wait_stop_gate,
//      TT_DAEMON_STOP_WAIT_SECONDS, default 30s) that returns ONLY after all
//      three kind ports are free AND every recorded dashboard/mcp/control-
//      plane child has exited.
//   2. 'ports still in use' after the bound classifies as INFRA with the
//      holder pid AND cmdline in the reason (describe_port_holder), and the
//      stop exits non-zero — never a silent success.
//   3. cmd_start's bounded port-free wait default is >= 30s
//      (TT_DAEMON_PORT_WAIT_SECONDS), configurable as before.
//
// The RED case (recorded in the progress log): against the pre-fix
// daemon-control the STUCK arm below returns exit 0 ("WARNING — one or more
// ports still in use after stop") while a surviving fake dashboard/MCP child
// still holds 5334/5338, and the structural arms fail (no wait_stop_gate,
// cmd_start default 10 < 30).
//
// Hermetic model (linux-runnable, zero tokens, no product daemon, no
// operator state): the test builds a CONTAINED scripted env of its own under
// torture-test/var (TT_DC_ENV_SCRIPTED seam) whose `tamandua` is a FAKE shim
// (first on the reconstructed contained PATH) that models the product CLI
// surface daemon-control uses: `daemon start`/`dashboard start`/`mcp start`
// spawn three fake lifecycle children (node servers binding the REAL shared
// ports 5334/5338/5339, writing the state-dir pid files the product writes,
// with 'tamandua' in their argv and cwd under the repo root so
// daemon-control's identity/ownership gates pass), and `dashboard stop` /
// `mcp stop` either kill their child (healthy mode) or leave it alive
// (stuck mode — a product CLI that cannot reach its standalone). The REAL
// daemon-control start/stop then run end-to-end against that fake lifecycle
// on the plain-background fallback path (TT_FORCE_NO_SYSTEMD=1 — the path
// Darwin always takes and the one with no systemd scope teardown to mask a
// surviving child).
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit). Zero tokens; confined to torture-test/ (all writes under
// var/, gitignored); only pids this test's own fake shim spawned are ever
// signalled.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const dcTool = path.join(ttRoot, "bin", "daemon-control");
const dcText = fs.readFileSync(dcTool, "utf8");
const provFile = path.join(varRoot, "daemon-control", "scripted.json");

const SCRIPTED_PORTS = [5334, 5338, 5339];
const PID_FILES = ["tamandua.pid", "dashboard.pid", "mcp.pid"];

// ── shared fixture (built once per test file run) ────────────────────
const fixtureDir = fs.mkdtempSync(path.join(varRoot, "s56-stop-wait-"));
const homeDir = path.join(fixtureDir, "home");
const stateDir = path.join(fixtureDir, "state");
const fakeBin = path.join(fixtureDir, "fakebin");
const envScript = path.join(fixtureDir, "env-scripted.sh");
const fakeCli = path.join(fakeBin, "tamandua");
const childScript = path.join(fixtureDir, "fake-child.mjs");
const modeFile = path.join(stateDir, ".s56-stop-mode");

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the daemon-control children operate inside torture-test/var
 *  only. */
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): CmdResult {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? cleanEnv(),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/** Run the REAL daemon-control against the fixture scripted env. */
function runDc(
  op: string,
  opts: { stopWait?: string; portWait?: string } = {},
): CmdResult {
  const env = cleanEnv({
    TT_DC_ENV_SCRIPTED: envScript,
    TT_FORCE_NO_SYSTEMD: "1",
    // S55: point daemon-control's launcher at the fake CLI (the fake cannot
    // live at the real $TT_REPO_ROOT/bin/tamandua) and disable the S55
    // /control/health dist-parity gate (fake lifecycle children cannot serve
    // the health endpoint — a documented hermetic test seam).
    TT_DC_TAMANDUA_BIN: fakeCli,
    TT_DC_HEALTH_PARITY: "0",
  });
  if (opts.stopWait !== undefined) env.TT_DAEMON_STOP_WAIT_SECONDS = opts.stopWait;
  if (opts.portWait !== undefined) env.TT_DAEMON_PORT_WAIT_SECONDS = opts.portWait;
  return run(["bash", dcTool, "scripted", op], { env, timeoutMs: 120_000 });
}

function writeMode(mode: string): void {
  fs.writeFileSync(modeFile, `${mode}\n`, { encoding: "utf8" });
}

function readPidFile(name: string): string {
  try {
    const v = fs.readFileSync(path.join(stateDir, name), "utf8").trim();
    return /^[0-9]+$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

function pidAlive(pid: string): boolean {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/** All three scripted listeners must answer a TCP connect on 127.0.0.1. */
async function allPortsListening(): Promise<boolean> {
  for (const port of SCRIPTED_PORTS) {
    if (!(await portListening(port))) return false;
  }
  return true;
}

function portListening(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Kill (SIGKILL) the fake lifecycle children recorded in OUR state-dir
 *  pid files — every one of them was spawned by this test's own fake
 *  tamandua shim. */
function killFixtureChildren(): void {
  for (const name of PID_FILES) {
    const pid = readPidFile(name);
    if (pidAlive(pid)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function removePidFiles(): void {
  for (const name of PID_FILES) {
    fs.rmSync(path.join(stateDir, name), { force: true });
  }
}

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware) from the tool text, or null when the function is absent. */
function extractFunction(text: string, name: string): string | null {
  const start = text.indexOf(`${name}()`);
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── fixture construction ──────────────────────────────────────────────

function buildFixture(): void {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  writeMode("healthy");

  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);

  // The fake `tamandua`: first on the reconstructed contained PATH (the
  // env-script PATH is emitted before every other non-contained dir), so
  // every `tamandua ...` daemon-control runs under the spawn env resolves
  // HERE — including the launch script and the graceful dashboard/mcp stop.
  fs.writeFileSync(
    fakeCli,
    `#!/bin/bash
# S56 hermetic fake tamandua — models the product CLI surface daemon-control
# uses (daemon/dashboard/mcp start + stop) with fake lifecycle children that
# bind the real shared scripted ports and write the state-dir pid files.
set -u
STATE="\${TAMANDUA_STATE_DIR:?}"
CHILD_SCRIPT="\${TT_S56_CHILD_SCRIPT:?}"
NODE_BIN="\${TT_NODE_BIN:?}"
MODE="$(cat "$STATE/.s56-stop-mode" 2>/dev/null || echo healthy)"
spawn_child() {
  local role="$1" port="$2" pidfile="$3"
  S56_LOG="$STATE/s56-children.log" nohup "$NODE_BIN" "$CHILD_SCRIPT" "tamandua-$role" "$port" "$pidfile" >>"$STATE/s56-children.log" 2>&1 &
}
case "\${1:-}" in
  daemon)
    [ "\${2:-}" = "start" ] && spawn_child control "\${TAMANDUA_CONTROL_PORT:-5339}" "$STATE/tamandua.pid" ;;
  dashboard)
    case "\${2:-}" in
      start) spawn_child dashboard "\${4:-5334}" "$STATE/dashboard.pid" ;;
      stop)
        if [ "$MODE" = "stuck" ]; then exit 0; fi
        dp="$(cat "$STATE/dashboard.pid" 2>/dev/null || true)"
        [ -n "$dp" ] && kill -TERM "$dp" 2>/dev/null || true ;;
    esac ;;
  mcp)
    case "\${2:-}" in
      start) spawn_child mcp "\${4:-5338}" "$STATE/mcp.pid" ;;
      stop)
        if [ "$MODE" = "stuck" ]; then exit 0; fi
        mp="$(cat "$STATE/mcp.pid" 2>/dev/null || true)"
        [ -n "$mp" ] && kill -TERM "$mp" 2>/dev/null || true ;;
    esac ;;
esac
exit 0
`,
    { encoding: "utf8", mode: 0o755 },
  );

  fs.writeFileSync(
    childScript,
    `#!/usr/bin/env node
// S56 fake lifecycle child — binds one shared scripted port, writes its pid
// file, and dies on SIGTERM by default (the product standalone behavior the
// real stop relies on).
import fs from "node:fs";
import net from "node:net";
const [, , role, port, pidfile] = process.argv;
fs.writeFileSync(pidfile, String(process.pid) + "\\n");
const server = net.createServer();
server.on("error", () => process.exit(2));
server.listen(Number(port), "127.0.0.1", () => {
  fs.appendFileSync(process.env.S56_LOG ?? "/dev/null", role + " listening " + port + "\\n");
});
setInterval(() => {}, 1000);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  // Contained scripted env for the fixture: HOME + state strictly under
  // torture-test/var (guard_kind_containment), fixed shared scripted ports,
  // and the fake bin FIRST on the reconstructed contained PATH.
  fs.writeFileSync(
    envScript,
    `#!/usr/bin/env bash
# S56 hermetic contained scripted env (fake lifecycle fixture).
export TT_REPO_ROOT="${repoRoot}"
export TT_ROOT="${varRoot}"
export TT_SCRIPTED_HOME="${homeDir}"
export HOME="${homeDir}"
export TAMANDUA_STATE_DIR="${stateDir}"
export TAMANDUA_CONTROL_PORT=5339
export TAMANDUA_MCP_PORT=5338
export TAMANDUA_DASHBOARD_PORT=5334
export HERMES_HOME="${path.join(homeDir, ".hermes")}"
export TT_S56_CHILD_SCRIPT="${childScript}"
export TT_NODE_BIN="${nodeBin}"
export TT_NODE_BIN_DIR="${nodeDir}"
export PATH="${fakeBin}:${nodeDir}:/usr/bin:/bin"
if [ "\${1:-}" = "print" ]; then
  for v in TT_REPO_ROOT TT_ROOT TT_SCRIPTED_HOME HOME TAMANDUA_STATE_DIR TAMANDUA_CONTROL_PORT TAMANDUA_MCP_PORT TAMANDUA_DASHBOARD_PORT HERMES_HOME TT_S56_CHILD_SCRIPT TT_NODE_BIN TT_NODE_BIN_DIR PATH; do
    printf '%s=%s\\n' "$v" "\${!v}"
  done
fi
`,
    { encoding: "utf8" },
  );
}

// ── provenance backup/restore (var/daemon-control/scripted.json is shared
//    with the rest of the suite — leave it exactly as we found it) ──────
let provBackup: string | null = null;

function backupProvenance(): void {
  if (fs.existsSync(provFile)) {
    provBackup = fs.readFileSync(provFile, "utf8");
  }
}

function restoreProvenance(): void {
  if (provBackup !== null) {
    fs.writeFileSync(provFile, provBackup, { encoding: "utf8" });
  } else {
    fs.rmSync(provFile, { force: true });
  }
}

/** Teardown used by every behavioral arm: kill fixture children, restore
 *  healthy mode, remove our pid files, restore provenance. */
function teardownLifecycle(): void {
  writeMode("healthy");
  killFixtureChildren();
  removePidFiles();
  restoreProvenance();
}

// ── the guard ──────────────────────────────────────────────────────────

describe("S56 — daemon stop waits for listeners+children; start waits bounded; ports-still-in-use classifies INFRA", () => {
  before(() => {
    backupProvenance();
    buildFixture();
  });

  after(() => {
    teardownLifecycle();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  // ── structural pins (RED pre-fix: cmd_start default 10, no gate) ────
  it("cmd_start's bounded port-free wait defaults to >= 30s (configurable TT_DAEMON_PORT_WAIT_SECONDS)", () => {
    const cmdStart = extractFunction(dcText, "cmd_start");
    assert.ok(cmdStart, "cmd_start must exist");
    const m = cmdStart.match(/TT_DAEMON_PORT_WAIT_SECONDS:-\s*([0-9]+)/);
    assert.ok(m, "cmd_start must read TT_DAEMON_PORT_WAIT_SECONDS with a numeric default");
    const def = Number(m[1]);
    assert.ok(
      def >= 30,
      `cmd_start default port-free wait must be >= 30s (S56: start waits bounded, default >= 30s), got ${def}s`,
    );
  });

  it("cmd_stop ends with the S56 bounded stop gate (wait_stop_gate) and classifies residue as INFRA with holder evidence", () => {
    const cmdStop = extractFunction(dcText, "cmd_stop");
    assert.ok(cmdStop, "cmd_stop must exist");
    assert.match(
      cmdStop,
      /wait_stop_gate/,
      "cmd_stop must run the S56 bounded final gate (wait_stop_gate) before returning",
    );
    assert.doesNotMatch(
      cmdStop,
      /WARNING — one or more ports still in use after stop/,
      "cmd_stop must no longer end with the silent WARNING-and-return-0 single-shot check (S56)",
    );
    const gate = extractFunction(dcText, "wait_stop_gate");
    assert.ok(gate, "wait_stop_gate must exist");
    assert.match(gate, /TT_DAEMON_STOP_WAIT_SECONDS/, "wait_stop_gate must honor the TT_DAEMON_STOP_WAIT_SECONDS override");
    assert.match(gate, /INFRA/, "wait_stop_gate must classify residue as INFRA");
    assert.match(gate, /describe_port_holder/, "wait_stop_gate must name the holder via describe_port_holder");
    assert.match(gate, /kill -0/, "wait_stop_gate must wait for the captured children to exit (liveness probe only)");

    const holder = extractFunction(dcText, "describe_port_holder");
    assert.ok(holder, "describe_port_holder must exist");
    assert.match(holder, /pid/, "describe_port_holder must carry the holder pid");
    assert.match(holder, /cmdline/, "describe_port_holder must carry the holder cmdline");
  });

  // ── behavioral: healthy full lifecycle (start -> stop -> start) ─────
  it("start->stop->start: a healthy stop returns only after the three listeners are released AND the dashboard/mcp/control-plane children have exited; the immediate next start succeeds (no EADDRINUSE)", async (t) => {
    for (const port of SCRIPTED_PORTS) {
      if (await portListening(port)) {
        t.skip(`shared scripted port ${port} is busy (a concurrent campaign/daemon owns it) — cannot run the S56 lifecycle arm`);
        return;
      }
    }
    writeMode("healthy");
    try {
      // 1. start via the REAL daemon-control (fake lifecycle launch).
      const start1 = runDc("start");
      assert.equal(start1.status, 0, `daemon-control scripted start failed:\n${start1.stdout}\n${start1.stderr}`);
      await waitUntil(() => allPortsListening(), 15_000, "all three listeners after start");
      const controlPid = readPidFile("tamandua.pid");
      const dashPid = readPidFile("dashboard.pid");
      const mcpPid = readPidFile("mcp.pid");
      assert.ok(controlPid && dashPid && mcpPid, "fake lifecycle pid files must exist after start");
      assert.ok(pidAlive(controlPid) && pidAlive(dashPid) && pidAlive(mcpPid), "fake lifecycle children must be alive after start");

      // 2. stop (healthy mode: the fake dashboard/mcp stop TERMs its child;
      //    the recorded control child is TERM'd by the escalation).
      const stop = runDc("stop", { stopWait: "15" });
      assert.equal(stop.status, 0, `daemon-control scripted stop failed:\n${stop.stdout}\n${stop.stderr}`);

      // S56 contract: BEFORE the stop call returned, every listener was
      // released AND every dashboard/mcp/control-plane child exited — assert
      // it immediately after the call returns (no polling that would hide a
      // late release).
      for (const port of SCRIPTED_PORTS) {
        assert.equal(
          await portListening(port),
          false,
          `listener on port ${port} still bound after daemon-control stop returned 0 (S56)`,
        );
      }
      assert.equal(pidAlive(controlPid), false, "control-plane child still alive after stop returned");
      assert.equal(pidAlive(dashPid), false, "dashboard child still alive after stop returned");
      assert.equal(pidAlive(mcpPid), false, "mcp child still alive after stop returned");

      // 3. start AGAIN immediately after stop: the start's bounded port-free
      //    wait (default >= 30s) finds the ports already free and launches
      //    without EADDRINUSE.
      const start2 = runDc("start");
      assert.equal(start2.status, 0, `immediate re-start after stop failed (EADDRINUSE race?):\n${start2.stdout}\n${start2.stderr}`);
      await waitUntil(() => allPortsListening(), 15_000, "all three listeners after re-start");
      const control2 = readPidFile("tamandua.pid");
      const dash2 = readPidFile("dashboard.pid");
      const mcp2 = readPidFile("mcp.pid");
      assert.ok(control2 && dash2 && mcp2, "fake lifecycle pid files must exist after re-start");
      assert.ok(pidAlive(control2) && pidAlive(dash2) && pidAlive(mcp2), "fake lifecycle children must be alive after re-start");

      // Stop once more so the fixture is clean for the stuck arm.
      const stop2 = runDc("stop", { stopWait: "15" });
      assert.equal(stop2.status, 0, `final cleanup stop failed:\n${stop2.stdout}\n${stop2.stderr}`);
    } finally {
      teardownLifecycle();
    }
  });

  // ── behavioral: STUCK child — stop must classify INFRA with holder
  //    pid+cmdline and exit non-zero (RED pre-fix: silent exit 0). ─────
  it("a stop that cannot free a surviving dashboard/mcp child exits non-zero and classifies INFRA with the holder pid and cmdline in the reason", async (t) => {
    for (const port of SCRIPTED_PORTS) {
      if (await portListening(port)) {
        t.skip(`shared scripted port ${port} is busy (a concurrent campaign/daemon owns it) — cannot run the S56 stuck arm`);
        return;
      }
    }
    writeMode("healthy");
    try {
      // Build the lifecycle through the REAL start (children term on TERM),
      // then flip the fake CLI to STUCK mode: `dashboard stop` / `mcp stop`
      // become no-ops, so the dashboard (5334) and mcp (5338) standalone
      // children survive every stop action — only the recorded control child
      // (5339) can be stopped (identity-verified escalation). The recorded-
      // pid-only lingering cleanup REFUSES the survivors by design.
      const start = runDc("start");
      assert.equal(start.status, 0, `daemon-control scripted start failed:\n${start.stdout}\n${start.stderr}`);
      await waitUntil(() => allPortsListening(), 15_000, "all three listeners after start");
      const dashPid = readPidFile("dashboard.pid");
      const mcpPid = readPidFile("mcp.pid");
      assert.ok(dashPid && mcpPid, "fake lifecycle pid files must exist after start");

      writeMode("stuck");
      const stop = runDc("stop", { stopWait: "4" });
      writeMode("healthy");

      // S56: 'ports still in use' must be a FAILED stop classified INFRA
      // with the holder pid + cmdline — never a silent exit 0.
      assert.notEqual(
        stop.status,
        0,
        `stop must FAIL (exit non-zero) when a listener/child survives (RED pre-fix: silent exit 0):\n${stop.stdout}\n${stop.stderr}`,
      );
      assert.match(stop.stderr, /INFRA/, `stop must classify the residue as INFRA:\n${stop.stderr}`);
      assert.match(
        stop.stderr,
        new RegExp(String(dashPid)),
        `the INFRA reason must name the surviving dashboard child pid ${dashPid}:\n${stop.stderr}`,
      );
      assert.match(
        stop.stderr,
        /tamandua-dashboard/,
        `the INFRA reason must name the surviving holder's cmdline (tamandua-dashboard):\n${stop.stderr}`,
      );
      assert.match(stop.stderr, /port 5334/, `the INFRA reason must name the busy port 5334:\n${stop.stderr}`);

      // The surviving children genuinely survived the stop (they are why the
      // stop failed) — they must still be alive after it returns.
      assert.equal(pidAlive(dashPid), true, "the stuck dashboard child must still be alive after the failed stop");
      assert.equal(pidAlive(mcpPid), true, "the stuck mcp child must still be alive after the failed stop");
    } finally {
      teardownLifecycle();
    }
  });
});
