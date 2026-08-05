import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
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
