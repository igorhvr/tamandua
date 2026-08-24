// Hermetic scripted-scenario harness tests, incl. the MACP4 US-003
// Darwin-capability pins. The /proc literals here are linux-only
// documentation/assertion prose (MACP3 US-004 harness convention) — the
// Darwin portability proofs are simulated via injectable seams and the
// portable ps arms; no runtime procfs access in this test.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const validator = path.join(ttRoot, "scenarios", "lib", "validate-scenario.mjs");
const harness = path.join(ttRoot, "scenarios", "lib", "run-scripted-scenario");
const daemonControlTool = path.join(ttRoot, "bin", "daemon-control");
const created: string[] = [];

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function makeFixture(commandBody = "exit 0", includeBehaviorPreamble = true): {
  root: string;
  scenario: string;
  env: NodeJS.ProcessEnv;
  calls: string;
  invocations: string;
} {
  const root = path.join(varRoot, `scenario-harness-test-${crypto.randomUUID()}`);
  const scenario = path.join(root, "scenario");
  const tools = path.join(root, "tools");
  const stateDir = path.join(root, "home-scripted", ".tamandua");
  const calls = path.join(root, "daemon-calls.log");
  const invocations = path.join(root, "invocations.log");
  fs.mkdirSync(scenario, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  created.push(root);

  fs.writeFileSync(path.join(scenario, "scenario.json"), JSON.stringify({
    schema_version: 1,
    id: "self-test",
    workflow_base: "do-now",
    behaviors: "behaviors.json",
    command: "run.sh",
    expected_outcome: "completed",
    oracles: ["O1", "O3z", "O11"],
  }, null, 2));
  fs.writeFileSync(path.join(scenario, "behaviors.json"), JSON.stringify({
    agents: {
      doer: {
        output: "STATUS: done\nREPORT: scripted scenario self-test",
        tokens: 0,
      },
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  }, null, 2));
  const behaviorPreamble = includeBehaviorPreamble ? `node - "$TAMANDUA_SCRIPTED_BEHAVIORS" "$TAMANDUA_SCRIPTED_STATE" "$TT_SCENARIO_WORKFLOW_ID" "$TT_SCENARIO_INVOCATION_ID" "$TT_TEST_INVOCATIONS" <<'NODE'
const fs = require('node:fs');
const [behaviorsPath, statePath, workflowId, invocationId, record] = process.argv.slice(2);
const behavior = JSON.parse(fs.readFileSync(behaviorsPath, 'utf8'));
const keys = Object.keys(behavior.agents);
if (keys.length !== 1 || keys[0] !== workflowId + '_doer') throw new Error('behavior key is not fully qualified: ' + keys);
if (!statePath.includes('/torture-test/var/')) throw new Error('state escaped torture-test/var: ' + statePath);
fs.appendFileSync(record, invocationId + '|' + workflowId + '|' + statePath + '\\n');
NODE
` : "";
  writeExecutable(path.join(scenario, "run.sh"), `#!/usr/bin/env bash
set -euo pipefail
${behaviorPreamble}
${commandBody}
`);

  const envScript = path.join(tools, "tt-env-scripted.sh");
  writeExecutable(envScript, `#!/usr/bin/env bash
export TT_REPO_ROOT='${repoRoot}'
export TT_ROOT='${root}'
export TT_SCRIPTED_HOME='${root}/home-scripted'
export HOME="$TT_SCRIPTED_HOME"
export TAMANDUA_STATE_DIR='${stateDir}'
export TAMANDUA_CONTROL_PORT=5339
export TAMANDUA_MCP_PORT=5338
export TAMANDUA_DASHBOARD_PORT=5334
export PATH='${process.env.PATH ?? "/usr/bin:/bin"}'
printf '%s\\n' \\
  'TT_REPO_ROOT=${repoRoot}' \\
  'TT_ROOT=${root}' \\
  'TT_SCRIPTED_HOME=${root}/home-scripted' \\
  'HOME=${root}/home-scripted' \\
  'TAMANDUA_STATE_DIR=${stateDir}' \\
  'TAMANDUA_CONTROL_PORT=5339' \\
  'TAMANDUA_MCP_PORT=5338' \\
  'TAMANDUA_DASHBOARD_PORT=5334' \\
  'PATH=${process.env.PATH ?? "/usr/bin:/bin"}'
`);

  const daemon = path.join(tools, "daemon-control");
  writeExecutable(daemon, `#!/usr/bin/env bash
set -eu
[ "$1" = scripted ] || { echo 'non-scripted daemon kind' >&2; exit 91; }
printf '%s|%s|%s|%s\\n' "$1" "$2" "\${TAMANDUA_SCRIPTED_BEHAVIORS:-}" "$HOME" >>"${calls}"
case "$2" in
  start|restart|stop) exit 0 ;;
  status) echo 'STATUS: RUNNING'; exit 0 ;;
  *) exit 92 ;;
esac
`);

  const installer = path.join(tools, "install-scenario-workflows");
  writeExecutable(installer, `#!/usr/bin/env bash
set -euo pipefail
base="$1"; invocation="$2"
dst="$TAMANDUA_STATE_DIR/workflows/$base-$invocation"
mkdir -p "$dst"
printf 'id: %s-%s\\nagents:\\n  - id: doer\\n' "$base" "$invocation" >"$dst/workflow.yml"
printf '{"%s-%s_doer":{}}\\n' "$base" "$invocation"
`);

  const cli = path.join(tools, "tamandua");
  writeExecutable(cli, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = 'workflow install' ]; then
  src='${repoRoot}/workflows/'"$3"
  dst="$TAMANDUA_STATE_DIR/workflows/$3"
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
  exit 0
fi
exit 93
`);

  return {
    root,
    scenario,
    calls,
    invocations,
    env: {
      ...process.env,
      TT_SCENARIO_TEST_MODE: "1",
      TT_SCENARIO_DAEMON_CONTROL: daemon,
      TT_SCENARIO_INSTALLER: installer,
      TT_SCENARIO_ENV: envScript,
      TT_SCENARIO_CLI: cli,
      TT_SCENARIO_VAR_ROOT: path.join(root, "scenario-state"),
      TT_TEST_INVOCATIONS: invocations,
    },
  };
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(file, args, { cwd: repoRoot, env, encoding: "utf8" });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function assertNoResidue(fixture: ReturnType<typeof makeFixture>): void {
  const stateRoot = fixture.env.TT_SCENARIO_VAR_ROOT as string;
  if (fs.existsSync(stateRoot)) {
    const residue = fs.readdirSync(stateRoot, { recursive: true });
    assert.deepEqual(residue, [], `scenario state residue: ${residue.join(", ")}`);
  }
  const workflowRoot = path.join(fixture.root, "home-scripted", ".tamandua", "workflows");
  const copies = fs.existsSync(workflowRoot)
    ? fs.readdirSync(workflowRoot).filter((entry) => entry.startsWith("do-now-self-test-"))
    : [];
  assert.deepEqual(copies, [], `scenario workflow copies leaked: ${copies.join(", ")}`);
}

async function assertPortsFree(): Promise<void> {
  for (const port of [5334, 5338, 5339]) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
    });
  }
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(file), `timed out waiting for ${file}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertSurvivingDescendantCleaned(
  commandStatus: number,
  expectedHarnessStatus: number,
): Promise<void> {
  const fixture = makeFixture(`
sleep 300 </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" >"$TT_TEST_DESCENDANT_PID"
exit ${commandStatus}
`);
  const descendantPidFile = path.join(fixture.root, "descendant.pid");
  fixture.env.TT_TEST_DESCENDANT_PID = descendantPidFile;

  const result = run(harness, [fixture.scenario], fixture.env);
  assert.equal(result.status, expectedHarnessStatus, `${result.stdout}\n${result.stderr}`);
  assert.ok(fs.existsSync(descendantPidFile), "scenario command did not record its descendant");
  const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processAlive(descendantPid), false, `scenario-owned descendant ${descendantPid} survived`);
  assert.match(fs.readFileSync(fixture.calls, "utf8"), /^scripted\|stop\|/m);
  assertNoResidue(fixture);
  await assertPortsFree();
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hermetic scripted scenario harness", () => {
  it("validates metadata, behavior agents, workflow base, outcome, and oracle executables", () => {
    const fixture = makeFixture();
    const valid = run(process.execPath, [validator, fixture.scenario], fixture.env);
    assert.equal(valid.status, 0, valid.stderr);
    const summary = JSON.parse(valid.stdout);
    assert.deepEqual(summary.agent_ids, ["doer"]);
    assert.deepEqual(summary.oracles, ["O1", "O3z", "O11"]);

    const metadataPath = path.join(fixture.scenario, "scenario.json");
    const validMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const invalidCases = [
      ["workflow_base", "missing-workflow", "workflow base"],
      ["expected_outcome", "surprise", "expected_outcome"],
      ["oracles", ["O404"], "oracle"],
    ] as const;
    for (const [field, value, expected] of invalidCases) {
      const metadata = structuredClone(validMetadata);
      metadata[field] = value;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      const result = run(process.execPath, [validator, fixture.scenario], fixture.env);
      assert.notEqual(result.status, 0, `${field} should be rejected`);
      assert.match(result.stderr, new RegExp(expected, "i"));
    }

    fs.writeFileSync(metadataPath, JSON.stringify({ ...validMetadata, oracles: ["O3z"] }));
    fs.writeFileSync(path.join(fixture.scenario, "behaviors.json"), '{"agents":{"wrong":{}},"heartbeatTokens":0,"defaultTokens":0}');
    const badBehavior = run(process.execPath, [validator, fixture.scenario], fixture.env);
    assert.notEqual(badBehavior.status, 0);
    assert.match(badBehavior.stderr, /behavior.*agent|agent.*behavior/i);
    assert.equal(fs.existsSync(fixture.calls), false, "validation must happen before daemon control");

    fs.writeFileSync(metadataPath, JSON.stringify(validMetadata));
    fs.writeFileSync(path.join(fixture.scenario, "behaviors.json"), JSON.stringify({
      agents: { doer: "STATUS: done" },
      heartbeatTokens: 0,
      defaultTokens: 0,
    }));
    const stringBehavior = run(process.execPath, [validator, fixture.scenario], fixture.env);
    assert.notEqual(stringBehavior.status, 0, "runtime-incompatible string behavior must be rejected");
    assert.match(stringBehavior.stderr, /behavior object/i);
  });

  it("uses unique workflow IDs and isolated behavior counters on repeated runs", () => {
    const fixture = makeFixture();
    for (let i = 0; i < 2; i++) {
      const result = run(harness, [fixture.scenario], fixture.env);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assertNoResidue(fixture);
    }
    const rows = fs.readFileSync(fixture.invocations, "utf8").trim().split("\n").map((line) => line.split("|"));
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0][0], rows[1][0], "invocation IDs must be unique");
    assert.notEqual(rows[0][1], rows[1][1], "workflow IDs must be unique");
    assert.notEqual(rows[0][2], rows[1][2], "counter state paths must be unique");
    assert.equal(
      fs.readFileSync(path.join(fixture.root, "home-scripted", ".pi", "agent", "settings.json"), "utf8"),
      "{}\n",
      "scripted workflow installation should receive a credential-free pi config shape",
    );
    const daemonCalls = fs.readFileSync(fixture.calls, "utf8");
    assert.doesNotMatch(daemonCalls, /(^|[^0-9])33(?:34|38|39)([^0-9]|$)/);
    assert.match(daemonCalls, /^scripted\|stop\|/m);
    assert.match(daemonCalls, /^scripted\|start\|.*behaviors\.json\|.*$/m);
    assert.match(daemonCalls, /^scripted\|status\|/m);

  });

  it("restores the account home for daemon-control when the controller parent uses scripted HOME", () => {
    const fixture = makeFixture();
    const scriptedHome = path.join(fixture.root, "home-scripted");
    fixture.env.HOME = scriptedHome;
    const result = run(harness, [fixture.scenario], fixture.env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const daemonHomes = fs.readFileSync(fixture.calls, "utf8").trim().split("\n")
      .map((line) => line.split("|")[3]);
    assert.ok(daemonHomes.length > 0);
    assert.ok(daemonHomes.every((home) => home !== scriptedHome), "daemon-control inherited scripted HOME");
    assertNoResidue(fixture);
  });

  it("cleans daemon, workflow, lock, and work-count state after command failure", async () => {
    await assertSurvivingDescendantCleaned(17, 17);
  });

  it("cleans a surviving command descendant and all owned state after success", async () => {
    await assertSurvivingDescendantCleaned(0, 0);
  });

  it("does not release a fast-exit command before proving its process group", async () => {
    const fixture = makeFixture(`
[ "\${TT_SCENARIO_COMMAND_GROUP_PROVEN:-}" = 1 ] || exit 98
sleep 300 </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" >"$TT_TEST_DESCENDANT_PID"
exit 0
`, false);
    const descendantPidFile = path.join(fixture.root, "fast-descendant.pid");
    fixture.env.TT_TEST_DESCENDANT_PID = descendantPidFile;

    const result = run(harness, [fixture.scenario], fixture.env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(descendantPidFile), "fast command did not record its descendant");
    const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processAlive(descendantPid), false, `fast command descendant ${descendantPid} survived`);
    assertNoResidue(fixture);
    await assertPortsFree();
  });

  it("kills its provenanced command group and cleans all owned state on SIGINT", async () => {
    const fixture = makeFixture(`
marker="$TT_SCENARIO_STATE_DIR/command-ready"
sleep 300 &
printf '%s\\n' "$!" >"$TT_SCENARIO_STATE_DIR/descendant.pid"
touch "$marker"
wait
`);
    const child = spawn(harness, [fixture.scenario], {
      cwd: repoRoot,
      env: fixture.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });

    const stateRoot = fixture.env.TT_SCENARIO_VAR_ROOT as string;
    const deadline = Date.now() + 5000;
    let invocationDir = "";
    while (Date.now() < deadline) {
      const entries = fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot).filter((entry) => entry !== ".scripted-daemon.lock") : [];
      if (entries.length > 0) {
        invocationDir = path.join(stateRoot, entries[0]);
        if (fs.existsSync(path.join(invocationDir, "command-ready"))) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(invocationDir, `scenario did not start: ${output}`);
    await waitForFile(path.join(invocationDir, "descendant.pid"));
    const descendantPid = Number(fs.readFileSync(path.join(invocationDir, "descendant.pid"), "utf8").trim());
    process.kill(child.pid!, "SIGINT");
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, 130, `unexpected exit ${JSON.stringify(result)}: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processAlive(descendantPid), false, `scenario-owned descendant ${descendantPid} survived`);
    assertNoResidue(fixture);
    await assertPortsFree();
  });

  it("hard-codes only the sanctioned scripted lifecycle and contained paths", () => {
    const source = fs.readFileSync(harness, "utf8");
    const daemonSource = fs.readFileSync(daemonControlTool, "utf8");
    assert.match(source, /daemon-control/);
    assert.doesNotMatch(source, /\b(?:3334|3338|3339)\b/);
    assert.doesNotMatch(source, /(?:^|["'])~\/\.tamandua/);
    assert.match(source, /start\|status\|restart\|stop/);
    assert.match(source, /"\$DAEMON_CONTROL" scripted "\$operation"/);
    assert.match(daemonSource, /systemctl --user stop "\$\{prov_scope%\.scope\}\.scope"/);
    assert.match(daemonSource, /systemctl --user stop "\$\{scope_unit%\.scope\}\.scope"/);
  });
});

// ── MACP4 US-003 helpers ─────────────────────────────────────────────────

/** Env for extracted-snippet runs: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the snippets operate on temp dirs only. */
function cleanEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware) from shell text, or null when the function is absent. */
function extractShellFunction(text: string, name: string): string | null {
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

/** Run extracted bash functions in a temp file (with a prologue before the
 *  definitions and an invocation after them). */
function runExtracted(
  fnTexts: string[],
  prologue: string,
  invocation: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const file = path.join(os.tmpdir(), `tt-scenario-darwin-${process.pid}-${crypto.randomUUID()}.sh`);
  try {
    fs.writeFileSync(
      file,
      `#!/usr/bin/env bash\nset -euo pipefail\n${prologue}\n${fnTexts.join("\n")}\n${invocation}\n`,
      { mode: 0o755 },
    );
    return run("bash", [file], env);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Create an executable shim named `name` in `dir` running `body`. */
function makeShim(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  writeExecutable(p, `#!/bin/sh\n${body}\n`);
  return p;
}

/** Create the Darwin-simulation PATH seam: a failing session-leader binary
 *  (macOS lacks it), a failing getent (absent on macOS), and a date that
 *  rejects the GNU-only nanosecond format but forwards everything else. */
function makeDarwinSeam(root: string): string {
  const seam = path.join(root, "seam");
  fs.mkdirSync(seam, { recursive: true });
  makeShim(seam, "setsid", `echo "setsid: command not found" >&2\nexit 127`);
  makeShim(seam, "getent", "exit 1");
  makeShim(seam, "date", `case "$*" in *%N*) echo "date: illegal time format" >&2; exit 1 ;; esac\nexec /bin/date "$@"`);
  return seam;
}

/** The REAL operator home (passwd db — the chain's getent step on linux). */
function realOperatorHome(): string {
  const res = spawnSync("getent", ["passwd", String(process.getuid())], { encoding: "utf8" });
  if (res.status === 0) {
    const home = String(res.stdout).split(":")[5];
    if (home) return home;
  }
  return os.homedir();
}

// The pre-fix (setsid-dependent) spawn+proof tail — the mac defect this
// story removes. The RED arm reconstructs the pre-fix harness by splicing
// this tail back in and proves it FAILS when the session-leader binary is
// hidden (setsid: command not found).
const PRE_FIX_TAIL = [
  `  exec setsid "$BASH_BIN" -c '`,
  `    set -euo pipefail`,
  `    source "\${TT_SCENARIO_CONTAINMENT_GUARD:?}"`,
  `    ready_file=$1`,
  `    release_file=$2`,
  `    command_path=$3`,
  `    : >"\$ready_file"`,
  `    while [ ! -f "\$release_file" ]; do sleep 0.01; done`,
  `    export TT_SCENARIO_COMMAND_GROUP_PROVEN=1`,
  `    exec "\$command_path"`,
  `  ' scripted-scenario-command "\$COMMAND_READY_FILE" "\$COMMAND_RELEASE_FILE" "\$COMMAND_PATH"`,
  `) &`,
  `COMMAND_PID=$!`,
  `COMMAND_STARTTIME="\$(process_starttime "\$COMMAND_PID" 2>/dev/null || true)"`,
  `for _attempt in \$(seq 1 500); do`,
  `  if [ -z "\$COMMAND_STARTTIME" ]; then`,
  `    COMMAND_STARTTIME="\$(process_starttime "\$COMMAND_PID" 2>/dev/null || true)"`,
  `  fi`,
  `  if [ -f "\$COMMAND_READY_FILE" ]; then`,
  `    COMMAND_GROUP="\$(process_group "\$COMMAND_PID" 2>/dev/null || true)"`,
  `    if [ -n "\$COMMAND_STARTTIME" ] && [ "\$COMMAND_GROUP" = "\$COMMAND_PID" ]; then`,
  `      COMMAND_GROUP_PROVEN=1`,
  `      break`,
  `    fi`,
  `  fi`,
  `  kill -0 "\$COMMAND_PID" 2>/dev/null || break`,
  `  sleep 0.01`,
  `done`,
  `if [ "\$COMMAND_GROUP_PROVEN" != "1" ]; then`,
  `  stop_unreleased_command`,
  `  fail "could not prove the scenario command process group before release"`,
  `fi`,
  `: >"\$COMMAND_RELEASE_FILE"`,
  `wait "\$COMMAND_PID"`,
  `COMMAND_STATUS=$?`,
  `exit "\$COMMAND_STATUS"`,
].join("\n");

// ── MACP4 US-003 — Darwin-capable scenario harness ──────────────────────

describe("MACP4 US-003 — portable session-leader spawn, operator home, and UUID fallback", () => {
  it("run-scripted-scenario carries no linux-only session-leader-binary dependency and uses the portable spawn + pid-file mechanism (structural)", () => {
    const source = fs.readFileSync(harness, "utf8");
    const wrapper = fs.readFileSync(path.join(ttRoot, "scenarios", "lib", "session-leader-spawn.mjs"), "utf8");
    // 1. No setsid(1) dependency anywhere in the harness (macOS lacks it;
    //    the wrapper's detached spawn calls the setsid(2) syscall in the
    //    child — a different, portable mechanism).
    assert.doesNotMatch(source, /setsid/, "run-scripted-scenario must not reference the linux-only session-leader binary");
    // 2. No GNU-only nanosecond date in the UUID fallback (BSD date has no %N).
    assert.doesNotMatch(source, /date \+%s%N/, "the UUID fallback must not use the GNU-only nanosecond date format");
    // 3. No Linux-ism operator-home fallback.
    assert.doesNotMatch(source, /\/home\/\$\(id -un\)/, "ACCOUNT_HOME must not fall back to the Linux-ism /home/$(id -un)");
    // The portable mechanism is wired in: the wrapper + the leader pid file.
    assert.match(source, /session-leader-spawn\.mjs/, "the harness must launch the command via session-leader-spawn.mjs");
    assert.match(source, /COMMAND_LEADER_PID_FILE/, "the harness must read the REAL leader pid from the wrapper's pid file");
    assert.match(source, /exec "\$NODE_BIN" "\$SESSION_LEADER_SPAWN"/, "the child subshell must exec the portable spawn wrapper");
    assert.match(wrapper, /detached: true/, "the wrapper must spawn detached (new session/group leader on POSIX)");
    assert.match(wrapper, /writeFileSync\(pidFile/, "the wrapper must publish the leader pid to the pid file");
    // The operator-home chain and the portable UUID source are wired in.
    assert.match(source, /resolve_operator_home/, "the harness must define resolve_operator_home()");
    assert.match(source, /portable_uuid_suffix/, "the harness must define portable_uuid_suffix()");
    assert.match(source, /getent passwd/, "chain step 1 must be getent passwd (linux passwd db)");
    assert.match(source, /dscl \. -read/, "chain step 2 must be dscl . -read (macOS NFSHomeDirectory)");
    assert.match(source, /eval echo ~/, "chain step 3 must be the shell tilde expansion (eval echo ~<user>)");
    // The /proc guards (MACP3 US-003) are preserved, now with portable ps
    // fallback arms so the group proof works on a /proc-less host too.
    assert.match(source, /\[ -r "\/proc\/\$pid\/stat" \]/, "the linux /proc reads must stay guarded");
    assert.match(source, /ps -p "\$pid" -o lstart=/, "process_starttime must fall back to the portable ps lstart arm");
    assert.match(source, /ps -p "\$pid" -o pgid=/, "process_group must fall back to the portable ps pgid arm");
    assert.match(source, /MACP3 US-003/, "the /proc guards must keep their MACP3 US-003 markers");
  });

  it("session-leader-spawn.mjs makes the scenario command a proven session/group leader (pgid == pid, own session) and propagates its status", () => {
    const wrapper = path.join(ttRoot, "scenarios", "lib", "session-leader-spawn.mjs");
    const root = path.join(varRoot, `session-leader-spawn-test-${crypto.randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    created.push(root);
    const pidFile = path.join(root, "leader.pid");
    // The child records its own pid/pgid/sid and exits 7.
    const result = run(process.execPath, [wrapper, pidFile, "bash", "-c", 'echo "pid=$$"; ps -p $$ -o pgid= -o sid=; exit 7'], cleanEnv());
    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(pidFile), "the wrapper must write the leader pid file");
    const leaderPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(leaderPid > 0, "leader pid must be a positive integer");
    const pid = Number(/pid=(\d+)/.exec(result.stdout)?.[1]);
    assert.equal(pid, leaderPid, "the wrapper's published pid must be the child's own pid");
    const [pgid, sid] = result.stdout.trim().split("\n")[1]?.trim().split(/\s+/).map(Number) ?? [];
    assert.equal(pgid, leaderPid, "child must be its own process-group leader (pgid == pid — the COMMAND_GROUP_PROVEN proof)");
    assert.equal(sid, leaderPid, "child must be its own session leader (new session on POSIX)");
    // Failure modes: missing command -> exit 1; usage -> exit 2.
    const missing = run(process.execPath, [wrapper, path.join(root, "missing.pid"), "/nonexistent-tt-xyz-999"], cleanEnv());
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /cannot spawn/);
    const usage = run(process.execPath, [wrapper], cleanEnv());
    assert.equal(usage.status, 2, usage.stderr);
  });

  it("process_starttime/process_group prove identity/group via portable ps evidence when /proc is unavailable (Darwin-simulated)", () => {
    const source = fs.readFileSync(harness, "utf8");
    const starttimeFn = extractShellFunction(source, "process_starttime");
    const groupFn = extractShellFunction(source, "process_group");
    assert.ok(starttimeFn && groupFn, "the harness must define process_starttime/process_group");
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-darwin-ps-"));
    try {
      const fakeLstart = "Sun Aug 23 18:20:05 2026";
      makeShim(shimDir, "ps", `if [ -n "\${TT_FAKE_PS_FAIL:-}" ]; then exit 1; fi\nif [ -n "\${TT_FAKE_PS_PGID:-}" ]; then printf '%s\\n' "\$TT_FAKE_PS_PGID"; exit 0; fi\nprintf '%s\\n' "${fakeLstart}"`);
      // A pid with no /proc entry (99999999 > pid_max) forces the ps arm.
      const env = cleanEnv({ PATH: `${shimDir}:${process.env.PATH ?? ""}` });
      const okStart = runExtracted([starttimeFn], "", `if process_starttime 99999999; then echo START_OK; else echo START_FAIL; fi`, env);
      assert.equal(okStart.status, 0, okStart.stderr);
      assert.match(okStart.stdout, new RegExp(fakeLstart), "the ps lstart arm must yield the start identity on a /proc-less host");
      assert.match(okStart.stdout, /START_OK/, "a readable pid must succeed via the portable arm");
      const okGroup = runExtracted([groupFn], "", `if process_group 99999999; then echo GROUP_OK; else echo GROUP_FAIL; fi`, cleanEnv({ ...env, TT_FAKE_PS_PGID: "424242" }));
      assert.match(okGroup.stdout, /424242/, "the ps pgid arm must yield the process group");
      assert.match(okGroup.stdout, /GROUP_OK/, "a readable group must succeed via the portable arm");
      // Fail-closed: unreadable pid (ps fails) -> non-zero, no value.
      const failStart = runExtracted([starttimeFn], "", `if process_starttime 99999999; then echo START_OK; else echo START_FAIL; fi`, cleanEnv({ ...env, TT_FAKE_PS_FAIL: "1" }));
      assert.match(failStart.stdout, /START_FAIL/, "an unreadable pid must refuse (empty -> conservative) via the ps arm");
      const failGroup = runExtracted([groupFn], "", `if process_group 99999999; then echo GROUP_OK; else echo GROUP_FAIL; fi`, cleanEnv({ ...env, TT_FAKE_PS_FAIL: "1" }));
      assert.match(failGroup.stdout, /GROUP_FAIL/, "an unreadable group must refuse (empty -> plain positive-pid kill fallback)");
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("resolve_operator_home resolves the operator home via getent -> dscl -> tilde -> $HOME (never the Linux-ism fallback)", () => {
    const source = fs.readFileSync(harness, "utf8");
    const fn = extractShellFunction(source, "resolve_operator_home");
    assert.ok(fn, "the harness must define resolve_operator_home()");
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-darwin-home-"));
    try {
      makeShim(shimDir, "getent", "exit 1");
      makeShim(shimDir, "dscl", `printf 'NFSHomeDirectory: /Users/fakehome\\n'`);
      const runHome = (env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } =>
        runExtracted([fn], "", `resolve_operator_home; echo`, env);
      // Step 1 (getent): real PATH — returns the real passwd home.
      const getentHome = runHome(cleanEnv());
      assert.equal(getentHome.status, 0, getentHome.stderr);
      assert.match(getentHome.stdout.trim(), /^\//, `getent must yield an absolute operator home: ${getentHome.stdout}`);
      // Step 2 (dscl): getent absent -> dscl NFSHomeDirectory.
      const dsclHome = runHome(cleanEnv({ PATH: `${shimDir}:${process.env.PATH ?? ""}` }));
      assert.equal(dsclHome.status, 0, dsclHome.stderr);
      assert.equal(dsclHome.stdout.trim(), "/Users/fakehome", `dscl must resolve the macOS home: ${dsclHome.stdout}`);
      // Step 3 (shell tilde): getent AND dscl absent -> eval echo ~<user>
      // (libc passwd lookup — ignores a contained/wrong $HOME).
      const tildeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-darwin-tilde-"));
      try {
        makeShim(tildeDir, "getent", "exit 1");
        makeShim(tildeDir, "dscl", "exit 1");
        const tilde = runHome(cleanEnv({ PATH: `${tildeDir}:${process.env.PATH ?? ""}`, HOME: "/tmp/contained-home" }));
        assert.equal(tilde.status, 0, tilde.stderr);
        assert.match(tilde.stdout.trim(), /^\//, `shell tilde must yield an absolute home: ${tilde.stdout}`);
        assert.notEqual(tilde.stdout.trim(), "/tmp/contained-home", "the tilde step must ignore a contained/wrong $HOME");
        assert.equal(tilde.stdout.trim(), getentHome.stdout.trim(), "tilde expansion must equal the passwd home");
      } finally {
        fs.rmSync(tildeDir, { recursive: true, force: true });
      }
      // Step 4 ($HOME): getent/dscl absent AND an unknown user (tilde stays
      // literal) -> $HOME last resort.
      const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-darwin-fb-"));
      try {
        makeShim(fallbackDir, "getent", "exit 1");
        makeShim(fallbackDir, "dscl", "exit 1");
        makeShim(fallbackDir, "id", `if [ "$1" = "-un" ]; then printf 'nosuchuser999\\n'; else printf '99999\\n'; fi`);
        const fb = runHome(cleanEnv({ PATH: `${fallbackDir}:${process.env.PATH ?? ""}`, HOME: "/contained/fallback-home" }));
        assert.equal(fb.status, 0, fb.stderr);
        assert.equal(fb.stdout.trim(), "/contained/fallback-home", `$HOME must be the last-resort home: ${fb.stdout}`);
      } finally {
        fs.rmSync(fallbackDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("portable_uuid_suffix is unique and needs neither /proc nor the GNU nanosecond date", () => {
    const source = fs.readFileSync(harness, "utf8");
    const fn = extractShellFunction(source, "portable_uuid_suffix");
    assert.ok(fn, "the harness must define portable_uuid_suffix()");
    const runSuffix = (env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } =>
      runExtracted([fn], `NODE_BIN="${process.execPath}"`, `portable_uuid_suffix; echo`, env);
    // Primary arm: node crypto.randomUUID -> a 12-char hex suffix, unique per call.
    const a = runSuffix(cleanEnv());
    const b = runSuffix(cleanEnv());
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout.trim(), /^[0-9a-f]{12}$/, `expected a 12-char hex suffix: ${a.stdout}`);
    assert.notEqual(a.stdout.trim(), b.stdout.trim(), "two suffixes must differ");
    // Last resort: node unavailable AND a date that rejects the GNU %N
    // format (simulating BSD date on Darwin) -> the $$-$(date +%s) shell
    // fallback still yields a unique suffix without ever using %N.
    const seamDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-darwin-uuid-"));
    try {
      makeShim(seamDir, "node", "exit 1");
      makeShim(seamDir, "date", `case "$*" in *%N*) echo "date: illegal time format" >&2; exit 1 ;; esac\nprintf '1700000000\\n'`);
      const fb = runExtracted(
        [fn],
        `NODE_BIN="${seamDir}/node"`,
        `portable_uuid_suffix; echo`,
        cleanEnv({ PATH: `${seamDir}:${process.env.PATH ?? ""}` }),
      );
      assert.equal(fb.status, 0, fb.stderr);
      assert.match(fb.stdout.trim(), /^\d+-\d+$/, `expected the $$-$(date +%s) last resort: ${fb.stdout}`);
    } finally {
      fs.rmSync(seamDir, { recursive: true, force: true });
    }
  });

  it("RED-GREEN: with setsid/getent/%N hidden the harness proves the group and runs the scenario; the pre-fix setsid-dependent harness fails", () => {
    const source = fs.readFileSync(harness, "utf8");
    const fixture = makeFixture(`
[ "\${TT_SCENARIO_COMMAND_GROUP_PROVEN:-}" = 1 ] || exit 98
printf '%s\\n' ran >"$TT_TEST_GREEN_MARKER"
exit 0
`, false);
    const greenMarker = path.join(fixture.root, "green-marker");
    fixture.env.TT_TEST_GREEN_MARKER = greenMarker;
    const seam = makeDarwinSeam(fixture.root);
    const fakeHome = path.join(fixture.root, "fake-operator-home");
    fixture.env.PATH = `${seam}:${process.env.PATH ?? ""}`;
    fixture.env.HOME = fakeHome;
    // The fixture's env script RESETS PATH inside every child (including the
    // subshell that execs the spawn), so the seam must be prepended THERE
    // too — otherwise this linux host's real session-leader binary would be
    // found instead of the failing shim (a real mac has no such binary at
    // all, so the seam IS the mac).
    const envScriptPath = path.join(fixture.root, "tools", "tt-env-scripted.sh");
    const envScriptContent = fs.readFileSync(envScriptPath, "utf8");
    const seamPath = `${seam}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    fs.writeFileSync(
      envScriptPath,
      envScriptContent
        .replace(/export PATH='[^']*'/, `export PATH='${seamPath}'`)
        .replace(/'PATH=[^']*'/, `'PATH=${seamPath}'`),
    );

    // ── RED arm first: reconstruct the pre-fix (setsid-dependent) harness
    // and run it under the Darwin seam — the session-leader binary is
    // unavailable, so the pre-fix spawn fails exactly like on the mac.
    const spawnStart = source.indexOf('  exec "$NODE_BIN" "$SESSION_LEADER_SPAWN"');
    assert.ok(spawnStart > 0, "the post-fix spawn block must be present in the harness");
    const preFix = source.slice(0, spawnStart) + PRE_FIX_TAIL;
    assert.ok(preFix.includes("exec setsid"), "the pre-fix reconstruction must restore the setsid spawn");
    // The pre-fix copy lives in the fixture root (cleaned by afterEach), so
    // patch its LIB_DIR to the REAL scenarios/lib — otherwise the validator/
    // materializer/guard resolution (relative to BASH_SOURCE) would break.
    const libDir = path.join(ttRoot, "scenarios", "lib");
    const patchedPreFix = preFix.replace(
      'LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      `LIB_DIR="${libDir}"`,
    );
    assert.ok(patchedPreFix.includes(`LIB_DIR="${libDir}"`), "the pre-fix LIB_DIR patch must apply");
    const redHarness = path.join(fixture.root, "run-scripted-scenario-prefix");
    fs.writeFileSync(redHarness, patchedPreFix, { mode: 0o755 });
    const red = run(redHarness, [fixture.scenario], fixture.env);
    assert.notEqual(red.status, 0, `pre-fix harness must fail without the session-leader binary:\n${red.stdout}\n${red.stderr}`);
    assert.match(red.stderr, /setsid/, "the failure must be the session-leader-binary dependency (setsid: command not found)");
    assert.equal(fs.existsSync(greenMarker), false, "the pre-fix harness must never run the scenario command");
    assertNoResidue(fixture);

    // ── GREEN arm: the post-fix harness needs no session-leader binary, no
    // getent, and no GNU nanosecond date — the scenario command still runs
    // in a PROVEN process group and daemon-control still receives the REAL
    // operator home (the tilde step ignores the fake $HOME).
    const green = run(harness, [fixture.scenario], fixture.env);
    assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
    assert.ok(fs.existsSync(greenMarker), "the scenario command must have executed after the group was proven");
    const daemonHomes = fs.readFileSync(fixture.calls, "utf8").trim().split("\n")
      .map((line) => line.split("|")[3]);
    const opHome = realOperatorHome();
    assert.ok(daemonHomes.length > 0);
    assert.ok(
      daemonHomes.every((home) => home === opHome),
      `daemon-control must receive the REAL operator home on the fallback chain (got ${daemonHomes.join(",")}, expected ${opHome})`,
    );
    assert.ok(
      daemonHomes.every((home) => home !== fakeHome && home !== path.join(fixture.root, "home-scripted")),
      "the fake/scripted homes must never reach daemon-control",
    );
    assertNoResidue(fixture);
  });
});
