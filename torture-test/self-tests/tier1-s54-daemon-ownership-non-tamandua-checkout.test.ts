// S54 (US-011) — daemon-control ownership accepts a contained daemon from a
// checkout whose directory name does not contain 'tamandua'; launch/infra
// failures classify as infrastructure, never as a product fault.
//
// Defect: verify_process_tt_owned (and the ownership/cmdline arms it feeds —
// verify_launched_daemon_pid, cmd_status, stop_cli_auto_daemon,
// gate_children_for_state) required the LITERAL 'tamandua' in the process
// cmdline on top of the cwd-under-TT_REPO_ROOT check. The real daemon's argv
// is `node <TT_REPO_ROOT>/dist/server/daemon.js` (product daemonctl.ts
// startDaemon), and under a checkout named e.g. by run id that argv carries
// no 'tamandua' at all — so a perfectly good contained daemon was refused as
// "not TT-owned", every launch attempt was treated as failed, and the launch
// failure it produced was consumed as a product/daemon fault instead of the
// infrastructure condition it is.
//
// Fix (confined to torture-test/):
//   1. verify_process_tt_owned accepts the cmdline when it contains the
//      literal 'tamandua' (CLI wrapper argv + fake scripted shims — the
//      pre-S54 arm, unchanged) OR references THIS repo's built product
//      ($TT_REPO_ROOT/dist/server/ — daemon.js / dashboard-standalone.js /
//      mcp-standalone.js / control-standalone.js). cmd_status's RUNNING
//      cmdline check uses the same two arms.
//   2. The launch/infra failure diagnostics cmd_start emits (pidfile
//      candidate refused, deadline expiry with no identity-verified pid,
//      identity read failure after acceptance) classify as INFRA /
//      "classified as infrastructure (… never a product fault)" — so no
//      consumer can read a launch failure as a product finding.
//
// RED case (recorded in the progress log): against the pre-fix
// daemon-control the same child (cwd under a non-'tamandua' checkout root,
// argv `node <root>/dist/server/daemon.js`) is refused by
// verify_process_tt_owned (rc=1), cmd_status reports UNKNOWN, and a
// cmd_start lifecycle from that checkout fails (exit non-zero). Reproduce:
//
//   TMPD=$(mktemp -d)
//   mkdir -p "$TMPD/torture-test/bin" "$TMPD/torture-test/env"
//   git show HEAD:torture-test/bin/daemon-control \
//     > "$TMPD/torture-test/bin/daemon-control" && chmod +x "$TMPD/torture-test/bin/daemon-control"
//   cp torture-test/bin/tt-process-identity.mjs "$TMPD/torture-test/bin/"
//   mkdir -p "$TMPD/torture-test/lib"
//   cp torture-test/lib/port-probe.sh "$TMPD/torture-test/lib/"
//   TT_DC_TOOL="$TMPD/torture-test/bin/daemon-control" node --test \
//     torture-test/self-tests/tier1-s54-daemon-ownership-non-tamandua-checkout.test.ts
//
// Hermetic (linux-runnable, zero tokens, no product daemon, no operator
// state): the ownership arms spawn THIS test's own node children under a
// scratch checkout root named without 'tamandua' and run the extracted
// daemon-control functions against their real pids (the linux procfs
// evidence branch); the lifecycle arm copies the selected daemon-control
// into a scratch tree named by a run-id-style checkout, models the product
// CLI with a fake `tamandua` shim whose children bind the real shared
// scripted ports (preflight-skipped when any is busy), and drives a REAL
// `scripted start` end-to-end on the plain-background fallback path
// (TT_FORCE_NO_SYSTEMD=1). Only pids this test's own children/spawns are
// ever signalled; nothing is written under torture-test/.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const repoDcTool = path.join(ttRoot, "bin", "daemon-control");

// TT_DC_TOOL points the assertions at an alternate daemon-control tree
// (used to demonstrate the RED case against the pre-fix tool, see header).
const dcTool = process.env.TT_DC_TOOL ?? repoDcTool;
const dcText = fs.readFileSync(dcTool, "utf8");
const identityTool = path.join(ttRoot, "bin", "tt-process-identity.mjs");
const portProbe = path.join(ttRoot, "lib", "port-probe.sh");

const SCRIPTED_PORTS = [5334, 5338, 5339];

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

/** Run extracted bash functions in a temp file (with a prologue) and
 *  return the result. `prologue` runs BEFORE the function definitions
 *  (e.g. TT_REPO_ROOT setup); `invocation` runs after them. */
function runExtracted(
  fnTexts: string[],
  prologue: string,
  invocation: string,
  env?: NodeJS.ProcessEnv,
): CmdResult {
  const fnFile = path.join(os.tmpdir(), `dc-s54-fn-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  try {
    fs.writeFileSync(
      fnFile,
      `#!/usr/bin/env bash\nset -euo pipefail\n${prologue}\n${fnTexts.join("\n")}\n${invocation}\n`,
    );
    return run(["bash", fnFile], { env, timeoutMs: 30_000 });
  } finally {
    fs.rmSync(fnFile, { force: true });
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

// ── the guard ──────────────────────────────────────────────────────────

describe("S54 — daemon-control ownership accepts non-'tamandua' checkout paths; launch failures classify infra", () => {
  // ── 1. structural: the cmdline arms carry the repo-anchored acceptance ─

  it("verify_process_tt_owned accepts the literal-'tamandua' argv OR this repo's built daemon entry (structural)", () => {
    const fn = extractFunction(dcText, "verify_process_tt_owned");
    assert.ok(fn, "daemon-control must define verify_process_tt_owned()");
    // The pre-S54 arm is preserved (CLI wrapper argv / fake scripted shims).
    assert.match(fn, /grep -q 'tamandua'/, "the literal-'tamandua' cmdline arm must be preserved");
    // S54: the real daemon argv (`node <TT_REPO_ROOT>/dist/server/daemon.js`)
    // must be accepted regardless of the checkout directory name.
    assert.ok(
      fn.includes(`grep -Fq "$TT_REPO_ROOT/dist/server/"`),
      "verify_process_tt_owned must accept a cmdline referencing $TT_REPO_ROOT/dist/server/ (the built daemon entry) — RED pre-fix (no such arm)",
    );
    // The old-only refusal text must be gone (replaced by the two-arm check).
    assert.doesNotMatch(
      fn,
      /cmdline doesn't contain tamandua — refuse/,
      "the literal-'tamandua'-only refusal must be replaced by the two-arm acceptance",
    );
    // Fail-closed unchanged: unavailable cmdline evidence still refuses.
    assert.match(fn, /cannot read cmdline — refuse/, "unavailable cmdline evidence must still refuse");
  });

  it("cmd_status's RUNNING cmdline check uses the same two arms (structural)", () => {
    const fn = extractFunction(dcText, "cmd_status");
    assert.ok(fn, "cmd_status must exist");
    assert.match(fn, /grep -q 'tamandua'/, "cmd_status must keep the literal-'tamandua' arm");
    assert.ok(
      fn.includes(`grep -Fq "$TT_REPO_ROOT/dist/server/"`),
      "cmd_status must accept a cmdline referencing $TT_REPO_ROOT/dist/server/ — RED pre-fix (no such arm)",
    );
    assert.match(fn, /STATUS: UNKNOWN/, "unverifiable cmdlines must still report UNKNOWN (fail-closed)");
  });

  it("cmd_start's launch/infra failure diagnostics classify as infrastructure, never a product fault (structural)", () => {
    const cs = extractFunction(dcText, "cmd_start");
    assert.ok(cs, "cmd_start must exist");
    // Deadline expiry with no identity-verified daemon pid: INFRA + explicit
    // infrastructure classification (never a product-fault reading).
    assert.match(
      cs,
      /INFRA — \$kind daemon did not start within/,
      "the launch-deadline diagnostic must classify as INFRA",
    );
    assert.match(
      cs,
      /classified as infrastructure \(a launch\/infra failure, never a product fault\)/,
      "the launch-deadline diagnostic must name the infrastructure classification explicitly",
    );
    assert.match(
      cs,
      /no identity-verified daemon pid appeared/,
      "the launch-deadline diagnostic must keep the unverifiable-pid reason",
    );
    // A refused/unverifiable pidfile candidate mid-launch is also infra.
    assert.match(
      cs,
      /classified as infrastructure: an unverifiable\/foreign pidfile candidate is a launch\/infra condition, never a product fault/,
      "the refused-pidfile-candidate diagnostic must classify as infrastructure",
    );
    // daemon-control never emits product-fault vocabulary on a launch path.
    assert.doesNotMatch(cs, /PRODUCT_FAIL/, "cmd_start must never emit PRODUCT_FAIL vocabulary");
  });

  // ── 2. behavioral (real pid, real linux procfs evidence) ──────────────

  it("a daemon whose argv is <root>/dist/server/daemon.js under a checkout named without 'tamandua' is TT-owned (real pid; RED pre-fix: refused)", async (t) => {
    if (process.platform === "darwin") {
      t.skip("real-pid arm uses the linux procfs evidence branch (the Darwin branch is seam-tested elsewhere)");
      return;
    }
    const fn = extractFunction(dcText, "verify_process_tt_owned");
    assert.ok(fn, "verify_process_tt_owned must exist");

    // A scratch checkout root whose name never contains 'tamandua' (run-id
    // style), with a real daemon-shaped child: argv `node <root>/dist/server/
    // daemon.js`, cwd under the root — the contained-daemon shape of S54.
    const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-s54-"));
    const stateDir = path.join(checkoutRoot, "state");
    fs.mkdirSync(path.join(checkoutRoot, "dist", "server"), { recursive: true });
    const daemonJs = path.join(checkoutRoot, "dist", "server", "daemon.js");
    fs.writeFileSync(daemonJs, "setInterval(() => {}, 1000);\n", { encoding: "utf8" });
    assert.doesNotMatch(checkoutRoot, /tamandua/i, "the scratch checkout name must not contain 'tamandua'");

    let daemonChild: ReturnType<typeof spawn> | null = null;
    let foreignChild: ReturnType<typeof spawn> | null = null;
    try {
      daemonChild = spawn(process.execPath, [daemonJs], {
        cwd: checkoutRoot,
        detached: true,
        stdio: "ignore",
        env: cleanEnv(),
      });
      daemonChild.unref();
      const daemonPid = daemonChild.pid;
      assert.ok(daemonPid && pidAlive(daemonPid), "the daemon-shaped child must be alive");

      // The child's real argv must be exactly the repo daemon entry (no
      // 'tamandua' anywhere) — the S54 defect shape.
      const argv = cmdlineOf(daemonPid);
      assert.ok(
        argv.includes(path.join(checkoutRoot, "dist", "server", "daemon.js")),
        `child argv must name the checkout's dist daemon entry: ${argv}`,
      );
      assert.doesNotMatch(argv, /tamandua/i, `the daemon child argv must carry no 'tamandua': ${argv}`);

      const runOwned = (env: NodeJS.ProcessEnv, pid: number): CmdResult =>
        runExtracted(
          [fn],
          `TT_REPO_ROOT="${checkoutRoot}"`,
          `if verify_process_tt_owned ${pid} "${stateDir}"; then echo "rc=0"; else echo "rc=$?"; fi`,
          env,
        );

      // GREEN (S54): cwd under TT_REPO_ROOT + argv = <root>/dist/server/
      // daemon.js proves TT-ownership whatever the checkout is named.
      const ok = runOwned(cleanEnv(), daemonPid);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(
        ok.stdout,
        /rc=0/,
        `the repo daemon child must be TT-owned (S54). stdout: ${ok.stdout}\nargv: ${argv}`,
      );

      // Fail-closed unchanged: a FOREIGN cmdline (not tamandua, not this
      // repo's dist) with cwd under the root is still refused.
      foreignChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        cwd: checkoutRoot,
        detached: true,
        stdio: "ignore",
        env: cleanEnv(),
      });
      foreignChild.unref();
      const foreignPid = foreignChild.pid;
      assert.ok(foreignPid && pidAlive(foreignPid), "the foreign child must be alive");
      const foreign = runOwned(cleanEnv(), foreignPid);
      assert.equal(foreign.status, 0, foreign.stderr);
      assert.match(
        foreign.stdout,
        /rc=1/,
        `a foreign cmdline (not tamandua, not this repo's dist) must still be refused. stdout: ${foreign.stdout}`,
      );
    } finally {
      if (daemonChild?.pid) killPid(daemonChild.pid);
      if (foreignChild?.pid) killPid(foreignChild.pid);
      fs.rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("cmd_status reports RUNNING for the repo dist daemon and UNKNOWN for a foreign argv (real pid; RED pre-fix: UNKNOWN)", async (t) => {
    if (process.platform === "darwin") {
      t.skip("real-pid arm uses the linux procfs evidence branch");
      return;
    }
    const statusFn = extractFunction(dcText, "cmd_status");
    assert.ok(statusFn, "cmd_status must exist");

    const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-s54-"));
    const stateDir = path.join(checkoutRoot, "state");
    fs.mkdirSync(path.join(checkoutRoot, "dist", "server"), { recursive: true });
    const daemonJs = path.join(checkoutRoot, "dist", "server", "daemon.js");
    fs.writeFileSync(daemonJs, "setInterval(() => {}, 1000);\n", { encoding: "utf8" });

    // Stubs for cmd_status's callees (never production; ports faked via
    // TT_FAKE_LISTENING_PORTS — liveness + cmdline are REAL via the child).
    const stubs = `
is_production_port() { return 1; }
refuse_production() { echo "REFUSED: $1" >&2; exit 1; }
is_production_cwd() { return 1; }
is_port_listening() {
  local port="$1"
  local p
  for p in \${TT_FAKE_LISTENING_PORTS:-}; do
    [ "$p" = "$port" ] && return 0
  done
  return 1
}
`;
    const provDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-s54-prov-"));
    const provJson =
      '{"pid": %s, "ports": [25001], "startedAt": "2026-09-04T00:00:00Z", "cmdline": "tamandua daemon start", "cwd": "%s", "startTime": "proc:1"}';
    const runStatus = (env: NodeJS.ProcessEnv, pid: number, cwd: string): CmdResult =>
      runExtracted(
        [statusFn],
        `${stubs}\nPROV_DIR="${provDir}"\nTT_REPO_ROOT="${checkoutRoot}"`,
        `printf '${provJson}' ${pid} "${cwd}" > "$PROV_DIR/scripted.json"\ncmd_status scripted`,
        env,
      );

    let daemonChild: ReturnType<typeof spawn> | null = null;
    let foreignChild: ReturnType<typeof spawn> | null = null;
    try {
      daemonChild = spawn(process.execPath, [daemonJs], {
        cwd: checkoutRoot,
        detached: true,
        stdio: "ignore",
        env: cleanEnv(),
      });
      daemonChild.unref();
      const daemonPid = daemonChild.pid;
      assert.ok(daemonPid && pidAlive(daemonPid), "the daemon-shaped child must be alive");
      assert.doesNotMatch(cmdlineOf(daemonPid), /tamandua/i, "daemon argv must carry no 'tamandua'");

      // RUNNING: live pid + repo dist daemon argv + a listening port.
      const running = runStatus(
        cleanEnv({ TT_FAKE_LISTENING_PORTS: "25001" }),
        daemonPid,
        stateDir,
      );
      assert.equal(running.status, 0, running.stderr);
      assert.match(
        running.stdout,
        /STATUS: RUNNING/,
        `a live repo dist daemon must report RUNNING regardless of the checkout name (S54). stdout: ${running.stdout}`,
      );

      // UNKNOWN: live pid + foreign argv (no tamandua, no repo dist) + port.
      foreignChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        cwd: checkoutRoot,
        detached: true,
        stdio: "ignore",
        env: cleanEnv(),
      });
      foreignChild.unref();
      const foreignPid = foreignChild.pid;
      assert.ok(foreignPid && pidAlive(foreignPid), "the foreign child must be alive");
      const unknown = runStatus(
        cleanEnv({ TT_FAKE_LISTENING_PORTS: "25001" }),
        foreignPid,
        stateDir,
      );
      assert.equal(unknown.status, 0, unknown.stderr);
      assert.match(
        unknown.stdout,
        /STATUS: UNKNOWN/,
        `a foreign cmdline must still be UNKNOWN (fail-closed unchanged). stdout: ${unknown.stdout}`,
      );
    } finally {
      if (daemonChild?.pid) killPid(daemonChild.pid);
      if (foreignChild?.pid) killPid(foreignChild.pid);
      fs.rmSync(checkoutRoot, { recursive: true, force: true });
      fs.rmSync(provDir, { recursive: true, force: true });
    }
  });

  // ── 3. full lifecycle: daemon-control start from a non-'tamandua' ─────
  //    checkout (the selected tool is copied into a scratch run-id-style
  //    checkout; GREEN in-battery against the fixed tool, RED when
  //    TT_DC_TOOL points at the pre-fix tool — see header repro).
  it("a contained daemon launched from a run-id-named checkout starts and is accepted (real daemon-control lifecycle)", async (t) => {
    for (const port of SCRIPTED_PORTS) {
      if (await portListening(port)) {
        t.skip(`shared scripted port ${port} is busy (a concurrent campaign/daemon owns it) — cannot run the S54 lifecycle arm`);
        return;
      }
    }
    // Scratch checkout root named like a run-id worktree (never 'tamandua').
    const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
    assert.doesNotMatch(checkoutRoot, /tamandua/i, "the scratch checkout name must not contain 'tamandua'");
    const toolTree = path.join(checkoutRoot, "torture-test");
    const nodeBin = process.execPath;
    const nodeDir = path.dirname(nodeBin);
    const envScript = path.join(toolTree, "env", "s54-env-scripted.sh");
    const stateDir = path.join(checkoutRoot, "torture-test", "var", "home-scripted", ".tamandua");
    const provFile = path.join(checkoutRoot, "torture-test", "var", "daemon-control", "scripted.json");
    const fakeCli = path.join(checkoutRoot, "torture-test", "var", "adapters-bin", "tamandua");

    try {
      // Copy the selected daemon-control + its runtime deps into the scratch
      // checkout so TT_REPO_ROOT resolves to the non-'tamandua' root.
      fs.mkdirSync(path.join(toolTree, "bin"), { recursive: true });
      fs.mkdirSync(path.join(toolTree, "lib"), { recursive: true });
      fs.mkdirSync(path.join(toolTree, "env"), { recursive: true });
      fs.copyFileSync(dcTool, path.join(toolTree, "bin", "daemon-control"));
      fs.copyFileSync(identityTool, path.join(toolTree, "bin", "tt-process-identity.mjs"));
      fs.copyFileSync(portProbe, path.join(toolTree, "lib", "port-probe.sh"));
      fs.chmodSync(path.join(toolTree, "bin", "daemon-control"), 0o755);

      // The checkout's OWN built daemon entry — the child the fake CLI
      // spawns, argv `node <checkout>/dist/server/daemon.js <role> <port>`.
      fs.mkdirSync(path.join(checkoutRoot, "dist", "server"), { recursive: true });
      const daemonJs = path.join(checkoutRoot, "dist", "server", "daemon.js");
      fs.writeFileSync(
        daemonJs,
        `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
const [, , role, portArg] = process.argv;
const port = Number(portArg);
if (process.env.TT_S54_PIDFILE) {
  fs.writeFileSync(process.env.TT_S54_PIDFILE, String(process.pid) + "\\n");
}
if (process.env.TT_S54_LOG) {
  fs.appendFileSync(process.env.TT_S54_LOG, role + " " + String(process.pid) + "\\n");
}
const server = net.createServer();
server.on("error", () => process.exit(2));
server.listen(port, "127.0.0.1", () => {});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        { encoding: "utf8", mode: 0o755 },
      );

      // Fake product CLI: `daemon start` / `dashboard start` / `mcp start`
      // spawn one net-binding child each under the checkout's own dist
      // (pidfiles written by the child via env — the pidfile path never
      // enters argv, so the child argv stays `node <root>/dist/server/
      // daemon.js <role> <port>` with no 'tamandua' anywhere).
      fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
      fs.writeFileSync(
        fakeCli,
        `#!/bin/bash
# S54 hermetic fake tamandua — models the product CLI surface daemon-control
# uses (daemon/dashboard/mcp start) with children whose argv is the checkout's
# OWN dist daemon entry (no 'tamandua' literal — the S54 defect shape).
set -u
STATE="\${TAMANDUA_STATE_DIR:?}"
ROOT="\${TT_S54_REPO_ROOT:?}"
NODE_BIN="\${TT_NODE_BIN:?}"
DAEMON_JS="$ROOT/dist/server/daemon.js"
LOG="\$STATE/s54-children.log"
spawn_child() {
  local role="$1" port="$2" pidfile="$3"
  TT_S54_PIDFILE="\$pidfile" TT_S54_LOG="\$LOG" nohup "\$NODE_BIN" "\$DAEMON_JS" "\$role" "\$port" >>"\$LOG" 2>&1 &
}
case "\${1:-}" in
  daemon)
    [ "\${2:-}" = "start" ] && spawn_child control "\${TAMANDUA_CONTROL_PORT:-5339}" "\$STATE/tamandua.pid" ;;
  dashboard)
    [ "\${2:-}" = "start" ] && spawn_child dashboard "\${4:-5334}" "\$STATE/dashboard.pid" ;;
  mcp)
    [ "\${2:-}" = "start" ] && spawn_child mcp "\${4:-5338}" "\$STATE/mcp.pid" ;;
esac
exit 0
`,
        { encoding: "utf8", mode: 0o755 },
      );

      // Contained scripted env for the scratch checkout (HOME + state under
      // the checkout's own var; fake CLI first on the contained PATH via
      // adapters-bin; node pinned absolutely).
      fs.writeFileSync(
        envScript,
        `#!/usr/bin/env bash
# S54 hermetic contained scripted env (non-'tamandua' checkout fixture).
export TT_REPO_ROOT="${checkoutRoot}"
export TT_ROOT="${checkoutRoot}/torture-test/var"
export TT_SCRIPTED_HOME="${checkoutRoot}/torture-test/var/home-scripted"
export HOME="${checkoutRoot}/torture-test/var/home-scripted"
export TAMANDUA_STATE_DIR="${stateDir}"
export TAMANDUA_CONTROL_PORT=5339
export TAMANDUA_MCP_PORT=5338
export TAMANDUA_DASHBOARD_PORT=5334
export HERMES_HOME="${checkoutRoot}/torture-test/var/home-scripted/.hermes"
export TT_S54_REPO_ROOT="${checkoutRoot}"
export TT_NODE_BIN="${nodeBin}"
export TT_NODE_BIN_DIR="${nodeDir}"
export PATH="${nodeDir}:/usr/bin:/bin"
if [ "\${1:-}" = "print" ]; then
  for v in TT_REPO_ROOT TT_ROOT TT_SCRIPTED_HOME HOME TAMANDUA_STATE_DIR TAMANDUA_CONTROL_PORT TAMANDUA_MCP_PORT TAMANDUA_DASHBOARD_PORT HERMES_HOME TT_S54_REPO_ROOT TT_NODE_BIN TT_NODE_BIN_DIR PATH; do
    printf '%s=%s\\n' "$v" "\${!v}"
  done
fi
`,
        { encoding: "utf8" },
      );

      const runDc = (op: string): CmdResult =>
        run(["bash", path.join(toolTree, "bin", "daemon-control"), "scripted", op], {
          cwd: checkoutRoot,
          env: cleanEnv({
            TT_DC_ENV_SCRIPTED: envScript,
            TT_FORCE_NO_SYSTEMD: "1",
            TT_DAEMON_PORT_WAIT_SECONDS: "20",
            // S55: the fake CLI lives in the scratch checkout's own
            // adapters-bin (never at <checkoutRoot>/bin/tamandua, which does
            // not exist) — daemon-control launches the daemon via
            // TT_DC_TAMANDUA_BIN by absolute path. The fake daemon children
            // cannot serve /control/health, so the S55 dist-parity gate is
            // disabled (documented hermetic test seam).
            TT_DC_TAMANDUA_BIN: fakeCli,
            TT_DC_HEALTH_PARITY: "0",
          }),
          timeoutMs: 120_000,
        });

      // ── GREEN/S54: the daemon from the run-id-named checkout is accepted
      // ── (RED pre-fix: refused -> start exits non-zero).
      const start = runDc("start");
      assert.equal(
        start.status,
        0,
        `daemon-control scripted start must succeed for the non-'tamandua' checkout (RED pre-fix: refused/misclassified):\n${start.stdout}\n${start.stderr}`,
      );

      // Provenance recorded: the accepted daemon pid is live, and its argv
      // is the checkout's own dist daemon entry (no 'tamandua').
      assert.ok(fs.existsSync(provFile), "provenance must be written after a successful start");
      const prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
      assert.ok(prov.pid > 0, `provenance must record the daemon pid: ${JSON.stringify(prov)}`);
      assert.equal(pidAlive(prov.pid), true, "the recorded daemon pid must be alive");
      const argv = cmdlineOf(prov.pid);
      assert.ok(
        argv.includes(path.join(checkoutRoot, "dist", "server", "daemon.js")),
        `the running daemon's argv must be the checkout's own dist daemon entry: ${argv}`,
      );
      assert.doesNotMatch(argv, /tamandua/i, `the daemon argv must carry no 'tamandua': ${argv}`);
      assert.doesNotMatch(checkoutRoot, /tamandua/i, "the checkout directory name must not contain 'tamandua'");

      // The status verifier agrees the recorded daemon is RUNNING.
      const status = runDc("status");
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /STATUS: RUNNING/, `the recorded daemon must report RUNNING:\n${status.stdout}`);
    } finally {
      // Teardown: kill ONLY this fixture's own children. The children log
      // their own pids at spawn (the state-dir pidfile is NOT authoritative —
      // daemon-control removes tamandua.pid after a refused candidate, so a
      // RED/pre-fix start can leave a live control child with no pidfile).
      try {
        const log = fs.readFileSync(path.join(stateDir, "s54-children.log"), "utf8");
        for (const line of log.split(/\r?\n/)) {
          const m = line.trim().match(/^(control|dashboard|mcp) ([0-9]+)$/);
          if (m) killPid(Number(m[2]));
        }
      } catch {
        /* no spawn log — nothing spawned */
      }
      for (const name of ["tamandua.pid", "dashboard.pid", "mcp.pid"]) {
        try {
          const raw = fs.readFileSync(path.join(stateDir, name), "utf8").trim();
          if (/^[0-9]+$/.test(raw)) killPid(Number(raw));
        } catch {
          /* pid file absent — nothing to kill */
        }
      }
      fs.rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });
});
