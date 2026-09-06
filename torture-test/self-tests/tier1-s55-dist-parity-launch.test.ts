// S55 (US-012) — contained daemons MUST run the WORKTREE/checkout dist with
// version-parity evidence.
//
// Defect: daemon-control's launch script resolved `tamandua` through the
// reconstructed contained PATH. When the CALLER PATH did not carry the
// worktree's own bin/ first, the launch resolved the OPERATOR's installed
// build (a different checkout's dist) — the contained daemon silently ran
// the WRONG dist. tt-daemon-up's S15 parity guard (real kind only) caught
// the skew only AFTER the fact (and restarting through the same PATH-lookup
// launch never healed it); the scripted kind had NO guard at all, so a bare
// --tier1/--tier2 campaign could run its whole battery against a foreign
// dist with a green verdict.
//
// Fix (confined to torture-test/):
//   1. Every contained-daemon launch invokes the WORKTREE's OWN bin/tamandua
//      by ABSOLUTE path (resolve_tt_cli — TT_DC_TAMANDUA_BIN test seam or
//      $TT_REPO_ROOT/bin/tamandua). No PATH lookup anywhere in the launch
//      (bin/daemon-control launch_script + graceful CLI stops;
//      scenarios/lib/run-scripted-scenario already uses
//      TAMANDUA_CLI=$REPO_ROOT/bin/tamandua — pinned below).
//   2. cmd_start asserts dist/version parity between the launching CLI's
//      dist (TT_DC_EXPECTED_VERSION_FILE, default <TT_REPO_ROOT>/dist/
//      version) and the daemon's /control/health buildVersion; a mismatch or
//      an unverifiable health response stops the mismatched daemon and fails
//      closed as INFRA (never a product fault, no provenance written).
//   3. The provenance record (<TT_ROOT>/daemon-control/<kind>.json) carries
//      which dist ran: daemonVersion (the parity-observed health
//      buildVersion / the lifecycle.log daemon.start version), callerArgv
//      (the daemon entry argv from the daemon.start lifecycle journal —
//      node <TT_REPO_ROOT>/dist/server/daemon.js — naming the exact dist
//      that ran), and launchCli (the absolute CLI daemon-control launched).
//      tt-daemon-up prints TT_DAEMON_DIST_VERSION / TT_DAEMON_CLI /
//      TT_DAEMON_CALLER_ARGV machine lines on success, tt-controller
//      surfaces them as state.real_preflight.daemon, and the campaign report
//      (report.txt/json) renders a CONTAINED DAEMON (S55) section naming the
//      dist + caller argv.
//
// RED case (recorded in the progress log): against the pre-fix daemon-control
// (git show HEAD:torture-test/bin/daemon-control) the launch resolves
// `tamandua` by PATH — with the scratch checkout's own bin NOT on the
// contained PATH the launch cannot find the worktree CLI at all, every
// launch attempt fails, cmd_start exits non-zero after the bounded wait, and
// the structural arms below fail (no absolute launcher, no parity gate, no
// provenance dist evidence). Reproduce:
//
//   TMPD=$(mktemp -d)
//   mkdir -p "$TMPD/torture-test/bin" "$TMPD/torture-test/env"
//   git show HEAD:torture-test/bin/daemon-control \
//     > "$TMPD/torture-test/bin/daemon-control" && chmod +x "$TMPD/torture-test/bin/daemon-control"
//   cp torture-test/bin/tt-process-identity.mjs "$TMPD/torture-test/bin/"
//   mkdir -p "$TMPD/torture-test/lib"
//   cp torture-test/lib/port-probe.sh "$TMPD/torture-test/lib/"
//   TT_DC_TOOL="$TMPD/torture-test/bin/daemon-control" node --test \
//     torture-test/self-tests/tier1-s55-dist-parity-launch.test.ts
//
// Hermetic (linux-runnable, zero tokens, no product daemon, no operator
// state): the lifecycle arm copies the selected daemon-control into a
// scratch checkout whose dist/version is a DISTINCT value, models the
// worktree CLI with a fake `bin/tamandua` (reachable ONLY at
// <scratch>/bin/tamandua — never on the contained PATH) whose children bind
// the real shared scripted ports, serve /control/health buildVersion from
// the scratch dist/version, and journal a product-shaped lifecycle.log
// daemon.start entry — then drives a REAL `scripted start` end-to-end on
// the plain-background fallback path (TT_FORCE_NO_SYSTEMD=1) and asserts the
// daemon that came up reports the SCRATCH dist version (not the installed
// checkout's) and that the provenance records which dist ran. Only pids this
// test's own children/spawns are ever signalled. Nothing is written under
// torture-test/ (all state lives in the scratch checkout under the system
// temp dir).
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
// TT_DC_TOOL points the assertions at an alternate daemon-control tree
// (used to demonstrate the RED case against the pre-fix tool, see header).
const dcTool = process.env.TT_DC_TOOL ?? path.join(ttRoot, "bin", "daemon-control");
const dcText = fs.readFileSync(dcTool, "utf8");
const ttDaemonUpText = fs.readFileSync(path.join(ttRoot, "bin", "tt-daemon-up"), "utf8");
const runScriptedScenarioText = fs.readFileSync(path.join(ttRoot, "scenarios", "lib", "run-scripted-scenario"), "utf8");
const identityTool = path.join(ttRoot, "bin", "tt-process-identity.mjs");
const portProbe = path.join(ttRoot, "lib", "port-probe.sh");

const SCRIPTED_PORTS = [5334, 5338, 5339];
// A scratch dist version that differs from the installed checkout's real
// dist/version — the S55 worktree-skew shape.
const SCRATCH_VERSION = "9.9.9-s55dist";

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the daemon-control children operate inside scratch dirs and
 *  loopback ports only. */
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** `ps -p <pid> -o command=` — the portable full-command read (BSD ps and
 *  procps both support it); used to assert child argv without touching the
 *  procfs mount from this test (the daemon-control functions under test do
 *  the real procfs reads themselves). */
function cmdlineOf(pid: number): string {
  const res = run(["ps", "-p", String(pid), "-o", "command="], { timeoutMs: 10_000 });
  return res.stdout.trim();
}

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware) from a bash script, or null when the function is absent. */
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

// ── fixture ───────────────────────────────────────────────────────────

interface Fixture {
  checkoutRoot: string;
  toolTree: string;
  envScript: string;
  stateDir: string;
  provFile: string;
  versionFile: string;
  daemonJs: string;
  cli: string;
  childrenLog: string;
  fakeHome: string;
}

function buildFixture(selectedDcTool: string): Fixture {
  const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s55-"));
  const toolTree = path.join(checkoutRoot, "torture-test");
  const homeRoot = path.join(checkoutRoot, "torture-test", "var", "home-scripted");
  const stateDir = path.join(homeRoot, ".tamandua");
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const envScript = path.join(toolTree, "env", "s55-env-scripted.sh");
  const versionFile = path.join(checkoutRoot, "dist", "version");
  const daemonJs = path.join(checkoutRoot, "dist", "server", "daemon.js");
  const cli = path.join(checkoutRoot, "bin", "tamandua");
  const childrenLog = path.join(stateDir, "s55-children.log");

  fs.mkdirSync(path.join(toolTree, "bin"), { recursive: true });
  fs.mkdirSync(path.join(toolTree, "lib"), { recursive: true });
  fs.mkdirSync(path.join(toolTree, "env"), { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.mkdirSync(path.join(checkoutRoot, "dist", "server"), { recursive: true });
  fs.mkdirSync(path.join(checkoutRoot, "bin"), { recursive: true });
  fs.copyFileSync(selectedDcTool, path.join(toolTree, "bin", "daemon-control"));
  fs.copyFileSync(identityTool, path.join(toolTree, "bin", "tt-process-identity.mjs"));
  fs.copyFileSync(portProbe, path.join(toolTree, "lib", "port-probe.sh"));
  fs.chmodSync(path.join(toolTree, "bin", "daemon-control"), 0o755);

  // The scratch checkout's OWN dist/version — distinct from the installed
  // checkout's real dist/version (the S55 worktree-skew shape).
  fs.writeFileSync(versionFile, `${SCRATCH_VERSION}\n`, { encoding: "utf8" });

  // Fake contained daemon children: the CONTROL child binds the control port
  // and serves /control/health with buildVersion from the scratch dist/
  // version, journals a product-shaped lifecycle.log daemon.start entry
  // (version + callerArgv = its own argv `node <scratch>/dist/server/
  // daemon.js`), and writes the state-dir pidfile; the dashboard/MCP
  // children bind their ports as plain TCP servers.
  fs.writeFileSync(
    daemonJs,
    `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
const [, , role, portArg] = process.argv;
const port = Number(portArg);
const stateDir = process.env.TAMANDUA_STATE_DIR ?? "";
const log = process.env.TT_S55_LOG ?? "/dev/null";
const versionFile = process.env.TT_S55_VERSION_FILE ?? "";
function readVersion() {
  try { return fs.readFileSync(versionFile, "utf8").trim(); } catch (e) { return ""; }
}
function journal() {
  if (!stateDir) return;
  const entry = {
    ts: new Date().toISOString(),
    action: "daemon.start",
    targetPid: process.pid,
    callerPid: process.pid,
    callerPpid: process.ppid,
    callerArgv: ["node", process.argv[1]],
    callerCwd: process.cwd(),
    parentCmdline: "",
    version: readVersion(),
  };
  try { fs.appendFileSync(stateDir + "/lifecycle.log", JSON.stringify(entry) + "\\n"); } catch (e) { /* journal is best effort */ }
}
if (process.env.TT_S55_PIDFILE) {
  fs.writeFileSync(process.env.TT_S55_PIDFILE, String(process.pid) + "\\n");
}
if (log !== "/dev/null") {
  fs.appendFileSync(log, role + " " + String(process.pid) + "\\n");
}
if (role === "control") {
  const server = http.createServer((req, res) => {
    if (req.url === "/control/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: process.pid, timestamp: new Date().toISOString(), buildVersion: readVersion() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  journal();
  server.on("error", () => process.exit(2));
  server.listen(port, "127.0.0.1", () => {});
} else {
  const server = net.createServer();
  server.on("error", () => process.exit(2));
  server.listen(port, "127.0.0.1", () => {});
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  // Fake WORKTREE CLI at <checkoutRoot>/bin/tamandua — models the product
  // bin/tamandua wrapper. Reachable ONLY by absolute path: it is never on
  // the contained PATH, so a PATH-lookup launch (the pre-fix behavior)
  // cannot find it (RED) while the S55 absolute-path launch does (GREEN).
  fs.writeFileSync(
    cli,
    `#!/bin/bash
# S55 hermetic fake worktree CLI — models <checkout>/bin/tamandua. Spawns one
# child per lifecycle command under the checkout's OWN dist entry; dashboard/
# mcp stop terminate the recorded standalone children (the product CLI shape).
set -u
STATE="\${TAMANDUA_STATE_DIR:?}"
ROOT="\${TT_S55_REPO_ROOT:?}"
NODE_BIN="\${TT_S55_NODE_BIN:?}"
DAEMON_JS="$ROOT/dist/server/daemon.js"
LOG="\$STATE/s55-children.log"
spawn_child() {
  local role="$1" port="$2" pidfile="$3"
  TT_S55_PIDFILE="\$pidfile" TT_S55_LOG="\$LOG" TT_S55_VERSION_FILE="$ROOT/dist/version" \\
    nohup "\$NODE_BIN" "\$DAEMON_JS" "\$role" "\$port" >>"\$LOG" 2>&1 &
}
stop_child() {
  local pidfile="$1"
  local pid
  pid="\$(cat "\$pidfile" 2>/dev/null || true)"
  case "\$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  kill -TERM "\$pid" 2>/dev/null || true
}
case "\${1:-}" in
  daemon)
    [ "\${2:-}" = "start" ] && spawn_child control "\${TAMANDUA_CONTROL_PORT:-5339}" "\$STATE/tamandua.pid" ;;
  dashboard)
    case "\${2:-}" in
      start) spawn_child dashboard "\${4:-5334}" "\$STATE/dashboard.pid" ;;
      stop) stop_child "\$STATE/dashboard.pid" ;;
    esac ;;
  mcp)
    case "\${2:-}" in
      start) spawn_child mcp "\${4:-5338}" "\$STATE/mcp.pid" ;;
      stop) stop_child "\$STATE/mcp.pid" ;;
    esac ;;
esac
exit 0
`,
    { encoding: "utf8", mode: 0o755 },
  );

  // Contained scripted env for the scratch checkout (HOME + state under the
  // checkout's own var; node pinned absolutely; the scratch bin is NEVER on
  // this PATH — the S55 launcher must use the absolute path).
  fs.writeFileSync(
    envScript,
    `#!/usr/bin/env bash
# S55 hermetic contained scripted env (worktree-dist-skew fixture).
export TT_REPO_ROOT="${checkoutRoot}"
export TT_ROOT="${checkoutRoot}/torture-test/var"
export TT_SCRIPTED_HOME="${homeRoot}"
export HOME="${homeRoot}"
export TAMANDUA_STATE_DIR="${stateDir}"
export TAMANDUA_CONTROL_PORT=5339
export TAMANDUA_MCP_PORT=5338
export TAMANDUA_DASHBOARD_PORT=5334
export HERMES_HOME="${homeRoot}/.hermes"
export TT_S55_REPO_ROOT="${checkoutRoot}"
export TT_S55_NODE_BIN="${nodeBin}"
export TT_S55_NODE_BIN_DIR="${nodeDir}"
export TT_NODE_BIN="${nodeBin}"
export TT_NODE_BIN_DIR="${nodeDir}"
export PATH="${nodeDir}:/usr/bin:/bin"
if [ "\${1:-}" = "print" ]; then
  for v in TT_REPO_ROOT TT_ROOT TT_SCRIPTED_HOME HOME TAMANDUA_STATE_DIR TAMANDUA_CONTROL_PORT TAMANDUA_MCP_PORT TAMANDUA_DASHBOARD_PORT HERMES_HOME TT_S55_REPO_ROOT TT_S55_NODE_BIN TT_S55_NODE_BIN_DIR TT_NODE_BIN TT_NODE_BIN_DIR PATH; do
    printf '%s=%s\\n' "$v" "\${!v}"
  done
fi
`,
    { encoding: "utf8" },
  );

  return {
    checkoutRoot,
    toolTree,
    envScript,
    stateDir,
    provFile: path.join(checkoutRoot, "torture-test", "var", "daemon-control", "scripted.json"),
    versionFile,
    daemonJs,
    cli,
    childrenLog,
    fakeHome: fs.mkdtempSync(path.join(os.tmpdir(), "s55-op-home-")),
  };
}

function killFixtureChildren(fixture: Fixture): void {
  // The children log their own pids at spawn (the state-dir pidfile is NOT
  // authoritative — daemon-control removes tamandua.pid after a refused
  // candidate, so a RED/pre-fix start can leave a live control child with no
  // pidfile).
  try {
    const log = fs.readFileSync(fixture.childrenLog, "utf8");
    for (const line of log.split(/\r?\n/)) {
      const m = line.trim().match(/^(control|dashboard|mcp) ([0-9]+)$/);
      if (m) killPid(Number(m[2]));
    }
  } catch {
    /* no spawn log — nothing spawned */
  }
  for (const name of ["tamandua.pid", "dashboard.pid", "mcp.pid"]) {
    try {
      const raw = fs.readFileSync(path.join(fixture.stateDir, name), "utf8").trim();
      if (/^[0-9]+$/.test(raw)) killPid(Number(raw));
    } catch {
      /* pid file absent — nothing to kill */
    }
  }
}

/** Wait (bounded) for the shared scripted ports to free — our own teardown
 *  SIGKILLs release listeners nearly instantly, but a subsequent arm's
 *  preflight must not race a still-terminating child of THIS test. Returns
 *  true when all ports are free. */
async function waitScriptedPortsFree(timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let busy = false;
    for (const port of SCRIPTED_PORTS) {
      if (await portListening(port)) {
        busy = true;
        break;
      }
    }
    if (!busy) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** True when any shared scripted port is free to bind (a bounded settle so a
 *  just-torn-down arm of this same test is not misread as a foreign owner). */
async function scriptedPortsBindable(): Promise<boolean> {
  return waitScriptedPortsFree(8_000);
}

/** Run the REAL daemon-control (from the scratch toolTree) against the
 *  fixture scripted env. */
function runDc(fixture: Fixture, op: string, extraEnv: Record<string, string> = {}): CmdResult {
  return run(["bash", path.join(fixture.toolTree, "bin", "daemon-control"), "scripted", op], {
    cwd: fixture.checkoutRoot,
    env: cleanEnv({
      TT_DC_ENV_SCRIPTED: fixture.envScript,
      TT_FORCE_NO_SYSTEMD: "1",
      TT_DAEMON_PORT_WAIT_SECONDS: "10",
      // A MINIMAL caller PATH (node dir + system dirs only): the scratch
      // checkout's bin is NEVER on it, and the operator bin dirs (appended
      // last by contained_path_for_kind) are pinned to an EMPTY scratch home
      // via TT_DC_OPERATOR_HOME — so a PATH-lookup launch (the pre-fix RED
      // shape) can find NO tamandua anywhere on the reconstructed contained
      // PATH and fails deterministically instead of resolving the operator's
      // installed build.
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TT_DC_OPERATOR_HOME: fixture.fakeHome,
      ...extraEnv,
    }),
    timeoutMs: 120_000,
  });
}

describe("S55 — contained daemons run the worktree/checkout dist with version-parity evidence", () => {
  // ── 1. structural: the launcher is the worktree's own CLI by absolute
  //    path (never a PATH lookup) and the parity/provenance surface exists.

  it("cmd_start launches via resolve_tt_cli (TT_DC_TAMANDUA_BIN default \$TT_REPO_ROOT/bin/tamandua) — no bare PATH-lookup launch (structural)", () => {
    const cmdStart = extractFunction(dcText, "cmd_start");
    assert.ok(cmdStart, "daemon-control must define cmd_start()");
    assert.match(
      cmdStart,
      /tt_cli="\$\(resolve_tt_cli\)"/,
      "cmd_start must resolve the launcher CLI via resolve_tt_cli (S55)",
    );
    const resolveCli = extractFunction(dcText, "resolve_tt_cli");
    assert.ok(resolveCli, "daemon-control must define resolve_tt_cli()");
    assert.match(
      resolveCli,
      /TT_DC_TAMANDUA_BIN:-\$TT_REPO_ROOT\/bin\/tamandua/,
      "resolve_tt_cli must default to the worktree's own \$TT_REPO_ROOT/bin/tamandua (RED pre-fix: no launcher resolution)",
    );
    assert.match(
      cmdStart,
      /launch_script="\\"\$tt_cli\\" daemon start/,
      "the launch script must invoke the resolved CLI by absolute path (RED pre-fix: bare `tamandua daemon start` PATH lookup)",
    );
    assert.doesNotMatch(
      cmdStart,
      /launch_script="tamandua daemon start/,
      "cmd_start must NOT contain the bare PATH-lookup launch (RED pre-fix text)",
    );
    assert.match(
      cmdStart,
      /missing or not executable/,
      "cmd_start must fail closed when the resolved launcher is missing/not executable (never a PATH-lookup fallback)",
    );
    assert.match(
      cmdStart,
      /verify_launch_dist_parity/,
      "cmd_start must run the S55 dist/version parity gate after the launch (RED pre-fix: no parity gate)",
    );
    assert.match(
      cmdStart,
      /TT_DC_HEALTH_PARITY:-1/,
      "the parity gate must be on by default (TT_DC_HEALTH_PARITY:-1) — hermetic fake-CLI fixtures opt out",
    );
  });

  it("cmd_stop's graceful CLI stop uses the same resolved launcher (structural)", () => {
    const cmdStop = extractFunction(dcText, "cmd_stop");
    assert.ok(cmdStop, "cmd_stop must exist");
    assert.match(cmdStop, /tt_cli="\$\(resolve_tt_cli\)"/, "cmd_stop must resolve the launcher CLI via resolve_tt_cli");
    assert.doesNotMatch(
      cmdStop,
      /run_under_env "\$kind" tamandua dashboard stop/,
      "cmd_stop must not stop via a bare PATH-lookup `tamandua` (could stop a DIFFERENT checkout's daemon)",
    );
    assert.match(cmdStop, /run_under_env "\$kind" "\$tt_cli" dashboard stop/, "cmd_stop must stop via the resolved CLI");
  });

  it("write_provenance records which dist ran: daemonVersion / callerArgv / launchCli (structural)", () => {
    const wp = dcText.slice(dcText.indexOf("write_provenance()"));
    assert.ok(wp.includes('"daemonVersion"'), "provenance must record daemonVersion (the running dist version)");
    assert.ok(wp.includes('"callerArgv"'), "provenance must record callerArgv (the lifecycle daemon.start argv)");
    assert.ok(wp.includes('"launchCli"'), "provenance must record launchCli (the absolute launcher)");
  });

  it("tt-daemon-up surfaces which dist ran as TT_DAEMON_* machine lines on success (structural)", () => {
    assert.match(
      ttDaemonUpText,
      /TT_DAEMON_DIST_VERSION: \$dist_version/,
      "tt-daemon-up must print the parity-verified dist version",
    );
    assert.match(ttDaemonUpText, /TT_DAEMON_CLI: \$launch_cli/, "tt-daemon-up must print the launcher CLI");
    assert.match(
      ttDaemonUpText,
      /TT_DAEMON_CALLER_ARGV/,
      "tt-daemon-up must surface the lifecycle callerArgv when provenance records it",
    );
    // The campaign evidence writers consume these lines: tt-controller
    // persists them as state.real_preflight.daemon and the report renders
    // them (pinned behaviorally below).
    assert.match(ttDaemonUpText, /TT_DAEMON_DIST_VERSION/, "the usage tail must document the machine lines");
  });

  it("run-scripted-scenario resolves its CLI as the repo's own bin/tamandua by absolute path (structural)", () => {
    assert.match(
      runScriptedScenarioText,
      /TAMANDUA_CLI="\$REPO_ROOT\/bin\/tamandua"/,
      "run-scripted-scenario must default TAMANDUA_CLI to the repo's own bin/tamandua by absolute path",
    );
    assert.match(
      runScriptedScenarioText,
      /TT_SCENARIO_CLI/,
      "run-scripted-scenario must keep the TT_SCENARIO_CLI override seam",
    );
  });

  // ── 2. report surface: the campaign report renders a CONTAINED DAEMON
  //    (S55) section (which dist + caller argv) only when a real campaign's
  //    preflight recorded the evidence.

  it("the campaign report surfaces real_preflight.daemon (version + caller argv) and renders no S55 section otherwise", async () => {
    const { buildCampaignReport, renderCampaignReport } = await import(path.join(ttRoot, "bin", "tt-report.mjs"));
    const at = (seconds: number) => `2026-09-04T00:00:${String(seconds).padStart(2, "0")}.000Z`;
    const baseState: any = {
      version: 1,
      campaign_id: "s55-report",
      phase: "ready",
      created_at: at(0),
      updated_at: at(9),
      manifest: { path: "cases/s55.jsonl", sha256: "a".repeat(64), case_count: 1, case_ids: ["C"] },
      options: { concurrency: 1, stagger_ms: 0, token_poll_interval_ms: 300000 },
      spend: { tokens_observed: 0, observations: [] },
      cases: [{
        id: "C", wave: 1, workflow: "local", fixture: "none", harness: "local",
        class: "verification", phase: "terminal", outcome: "PASS", terminal_at: at(5),
        attempts: [{ id: "attempt-1", case_id: "C", kind: "local", phase: "terminal", started_at: at(1), terminal_at: at(3), outcome: "PASS" }],
        findings: [], oracle_results: [], spend: { tokens_observed: 0, observations: [] },
      }],
      discovered_runs: [],
      real_preflight: null,
    };
    // Without real_preflight.daemon the report renders byte-identically to
    // pre-S55 (no CONTAINED DAEMON section).
    const plain = renderCampaignReport(buildCampaignReport({ ...baseState }));
    assert.doesNotMatch(plain, /CONTAINED DAEMON/, "a state without daemon evidence must not render the S55 section");
    assert.match(plain, /SCENARIO OUTCOMES/, "the report structure must be unchanged otherwise");

    // With real_preflight.daemon (the tt-controller-persisted evidence) the
    // report surfaces which dist ran + the lifecycle caller argv.
    const withDaemon: any = {
      ...baseState,
      real_preflight: {
        engaged: true,
        ok: true,
        daemon: {
          version: SCRATCH_VERSION,
          cli: `${os.tmpdir()}/s55-checkout/bin/tamandua`,
          caller_argv: ["node", `${os.tmpdir()}/s55-checkout/dist/server/daemon.js`],
        },
      },
    };
    const report = buildCampaignReport(withDaemon);
    assert.equal(report.real_daemon.version, SCRATCH_VERSION, "report.real_daemon must carry the recorded dist version");
    const text = renderCampaignReport(report);
    assert.match(text, /CONTAINED DAEMON \(S55\)\nDaemon dist version: 9\.9\.9-s55dist/);
    assert.match(text, /Daemon launcher CLI: .*s55-checkout\/bin\/tamandua/);
    assert.match(text, /Daemon caller argv: node .*s55-checkout\/dist\/server\/daemon\.js/);
    const jsonReport = report as any;
    assert.equal(jsonReport.real_daemon.caller_argv[1].endsWith("dist/server/daemon.js"), true,
      "report.json must surface the lifecycle callerArgv naming the dist that ran");
  });

  it("tt-controller's real preflight persists the daemon-up evidence as state.real_preflight.daemon (structural)", () => {
    const controller = fs.readFileSync(path.join(ttRoot, "bin", "tt-controller"), "utf8");
    assert.ok(controller.includes("function parseDaemonUpEvidence"), "tt-controller must define parseDaemonUpEvidence");
    assert.ok(controller.includes("parseDaemonUpEvidence(daemonUpStdout)"),
      "runRealPreflight must parse the daemon-up leg stdout for the which-dist-ran evidence");
    assert.ok(controller.includes("daemon: daemonEvidence"),
      "the persisted preflight state must carry the daemon evidence");
    const runReal = controller.slice(controller.indexOf("function runRealPreflight"));
    assert.ok(runReal.includes("daemonUpStdout"), "runRealPreflight must capture the daemon-up leg stdout");
  });

  // ── 3. lifecycle (hermetic real daemon-control against the scratch
  //    checkout): a worktree whose dist/version differs from the installed
  //    checkout runs ITS OWN daemon.
  it("a scratch checkout whose dist/version differs from the installed checkout runs ITS OWN daemon (real daemon-control lifecycle; RED pre-fix: launch fails)", async (t) => {
    if (!(await scriptedPortsBindable())) {
      t.skip(`shared scripted ports ${SCRIPTED_PORTS.join("/")} are busy (a concurrent campaign/daemon owns them) — cannot run the S55 lifecycle arm`);
      return;
    }
    const fixture = buildFixture(dcTool);
    try {
      // ── GREEN/S55: the launch uses <scratch>/bin/tamandua by absolute path
      // ── (RED pre-fix: PATH lookup finds no tamandua -> INFRA exit 1).
      const start = runDc(fixture, "start");
      assert.equal(
        start.status,
        0,
        `daemon-control scripted start must succeed for the scratch worktree (RED pre-fix: PATH-lookup launch fails):\n${start.stdout}\n${start.stderr}`,
      );

      // The scratch CLI is the ONLY tamandua anywhere in the fixture and is
      // NOT on the contained PATH — a successful start PROVES the launch
      // invoked it by absolute path.
      assert.ok(fs.existsSync(fixture.cli), "fixture invariant: the scratch CLI must exist");
      assert.ok(
        runDc(fixture, "status", {}).stdout.includes("STATUS: RUNNING"),
        "the recorded daemon must report RUNNING",
      );

      // Provenance records which dist ran: the parity-observed version, the
      // lifecycle callerArgv (the daemon entry argv) and the launcher CLI.
      assert.ok(fs.existsSync(fixture.provFile), "provenance must be written after a successful start");
      const prov = JSON.parse(fs.readFileSync(fixture.provFile, "utf8"));
      assert.equal(prov.daemonVersion, SCRATCH_VERSION,
        `provenance must record the scratch dist version (the daemon's health buildVersion), got ${prov.daemonVersion}`);
      assert.equal(prov.launchCli, fixture.cli,
        "provenance must record the absolute launcher CLI (the scratch bin/tamandua)");
      assert.ok(Array.isArray(prov.callerArgv) && prov.callerArgv.length >= 2,
        "provenance must record the lifecycle daemon.start callerArgv");
      assert.equal(prov.callerArgv[0], "node", "callerArgv[0] must be node");
      assert.ok(
        prov.callerArgv[1].endsWith(path.join("dist", "server", "daemon.js")),
        `callerArgv[1] must be the daemon entry argv naming the dist that ran: ${JSON.stringify(prov.callerArgv)}`,
      );

      // The LIVE daemon's /control/health buildVersion equals the scratch
      // dist's version (its OWN dist, not the installed checkout's).
      const health = run(["node", "-e",
        `const p = 5339; const c = new AbortController(); const timer = setTimeout(() => c.abort(), 3000);\n`
        + `fetch(\`http://127.0.0.1:\${p}/control/health\`, { signal: c.signal })\n`
        + `.then((r) => r.json()).then((b) => process.stdout.write(String(b.buildVersion ?? "")))\n`
        + `.catch(() => {}).finally(() => clearTimeout(timer));`,
      ], { cwd: repoRoot, timeoutMs: 10_000 });
      assert.equal(health.stdout.trim(), SCRATCH_VERSION,
        `the running daemon must report the scratch dist version (its own dist, not the installed checkout's), got '${health.stdout}'`);

      // The running daemon child argv is the scratch checkout's own dist
      // entry — the runtime proof of which dist ran.
      const argv = cmdlineOf(prov.pid);
      assert.ok(
        argv.includes(path.join(fixture.checkoutRoot, "dist", "server", "daemon.js")),
        `the daemon argv must be the scratch checkout's own dist entry: ${argv}`,
      );
      assert.ok(pidAlive(prov.pid), "the recorded daemon pid must be alive");

      // The installed checkout's dist/version differs from the scratch
      // version (the S55 skew) — proving the scratch daemon is not the
      // installed build.
      const installedVersion = fs.readFileSync(path.join(repoRoot, "dist", "version"), "utf8").trim();
      assert.notEqual(installedVersion, SCRATCH_VERSION,
        "fixture invariant: the scratch dist version must differ from the installed checkout's");
    } finally {
      killFixtureChildren(fixture);
      fs.rmSync(fixture.checkoutRoot, { recursive: true, force: true });
      fs.rmSync(fixture.fakeHome, { recursive: true, force: true });
    }
  });

  // ── 4. the S55 parity gate fails closed: a daemon that reports a dist
  //    version DIFFERENT from the launching CLI's dist version is stopped
  //    and never recorded (INFRA).
  it("a daemon whose health buildVersion differs from the launching CLI dist is refused (parity gate; classified INFRA)", async (t) => {
    if (!(await scriptedPortsBindable())) {
      t.skip(`shared scripted ports ${SCRIPTED_PORTS.join("/")} are busy — cannot run the S55 parity-gate arm`);
      return;
    }
    const fixture = buildFixture(dcTool);
    try {
      // TT_DC_EXPECTED_VERSION_FILE points at a version that differs from
      // what the scratch daemon serves (SCRATCH_VERSION): the gate must stop
      // the mismatched daemon and fail closed as INFRA, writing no
      // provenance.
      const wrongVersionFile = path.join(fixture.checkoutRoot, "expected-version.txt");
      fs.writeFileSync(wrongVersionFile, "8.8.8-other-dist\n", { encoding: "utf8" });
      const start = runDc(fixture, "start", {
        TT_DC_EXPECTED_VERSION_FILE: wrongVersionFile,
        TT_DC_HEALTH_PARITY: "1",
      });
      assert.notEqual(start.status, 0, "a mismatched daemon dist must fail the start (fail closed)");
      assert.match(start.stderr, /dist\/version parity: MISMATCH/,
        "the failure must name the dist/version parity mismatch");
      assert.match(start.stderr, /classified as infrastructure/,
        "the parity failure must classify as infrastructure, never a product fault");
      assert.ok(!fs.existsSync(fixture.provFile),
        "no provenance may be written for a mismatched (never-recorded) daemon");
      // The mismatched daemon must have been stopped (not left running on
      // the shared ports).
      await new Promise((resolve) => setTimeout(resolve, 600));
      for (const port of SCRIPTED_PORTS) {
        assert.equal(await portListening(port), false, `port ${port} must be free after the parity refusal`);
      }
    } finally {
      killFixtureChildren(fixture);
      fs.rmSync(fixture.checkoutRoot, { recursive: true, force: true });
      fs.rmSync(fixture.fakeHome, { recursive: true, force: true });
    }
  });
});
