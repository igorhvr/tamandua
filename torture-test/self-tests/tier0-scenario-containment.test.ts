// FIX10 US-004 gate: scenario setup scripts and daemon-control containment.
//
// Regression net for the 2026-08-05 breach: a torture-test hook ran a
// --global git-config write with the REAL operator HOME in effect, rewriting
// the operator's ~/.gitconfig. US-001 identified the writer; US-002 made the
// hooks refuse; US-003 made the controller + tt-hook-runner fail closed.
// US-004 closes the SCENARIO + daemon-control side:
//   - every scenarios/*/run.sh and the run-scripted-scenario command child
//     source scenarios/lib/scenario-containment-guard.sh, which refuses
//     (exit 2) when $HOME is not strictly inside torture-test/var — a
//     scenario invoked directly with the operator HOME fails closed instead
//     of running against the real home.
//   - run-scripted-scenario fails a scenario whose env script resolves HOME
//     outside torture-test/var BEFORE any command/daemon work.
//   - daemon-control guard_kind_containment refuses to operate a kind whose
//     resolved HOME or TAMANDUA_STATE_DIR escapes torture-test/var.
//   - daemon_control()'s real-HOME handoff to daemon-control is documented
//     as safe (daemon-control uses the operator HOME only for its
//     production-guard derivation; every child it spawns gets the contained
//     env via env -i env_for_kind; daemon-control itself has no git writes).
//
// Confined to torture-test/. Zero tokens: no daemon is started; the real
// ~/.gitconfig is only ever READ (sha256 snapshot) and asserted unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const GUARD = path.join(ttRoot, "scenarios", "lib", "scenario-containment-guard.sh");
const HARNESS = path.join(ttRoot, "scenarios", "lib", "run-scripted-scenario");
const DAEMON_CONTROL = path.join(ttRoot, "bin", "daemon-control");
const operatorHome = os.homedir();
const realGitconfig = path.join(operatorHome, ".gitconfig");
const created: string[] = [];

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

type CommandResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
}

// ── scenario guard unit harness ───────────────────────────────────────

// Runs the guard inside bash with the given HOME, returning {rc, output}.
function guardRun(home: string | undefined): CommandResult {
  const script = [
    `source "${GUARD}"`,
    'echo "GUARD_PASSED"',
  ].join("\n");
  const env: NodeJS.ProcessEnv = { ...baseEnv() };
  if (home === undefined) delete env.HOME;
  else env.HOME = home;
  return run("bash", ["-c", script], env);
}

// ── run-scripted-scenario fixture (mirrors scripted-scenario-harness) ─

function makeHarnessFixture(homeValue: string, recordCommand = true): {
  root: string;
  scenario: string;
  env: NodeJS.ProcessEnv;
  calls: string;
  commandMarker: string;
} {
  const root = path.join(varRoot, `scenario-containment-test-${crypto.randomUUID()}`);
  const scenario = path.join(root, "scenario");
  const tools = path.join(root, "tools");
  const stateDir = path.join(root, "state", ".tamandua");
  const calls = path.join(root, "daemon-calls.log");
  const commandMarker = path.join(root, "command-ran.marker");
  fs.mkdirSync(scenario, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  fs.mkdirSync(path.dirname(stateDir), { recursive: true });
  created.push(root);

  fs.writeFileSync(path.join(scenario, "scenario.json"), JSON.stringify({
    schema_version: 1,
    id: "containment-self-test",
    workflow_base: "do-now",
    behaviors: "behaviors.json",
    command: "run.sh",
    expected_outcome: "completed",
    oracles: ["O1", "O3z"],
  }, null, 2));
  fs.writeFileSync(path.join(scenario, "behaviors.json"), JSON.stringify({
    agents: { doer: { output: "STATUS: done", tokens: 0 } },
    heartbeatTokens: 0,
    defaultTokens: 0,
  }, null, 2));
  const commandBody = recordCommand
    ? `touch "${commandMarker}"\nexit 0\n`
    : "exit 0\n";
  writeExecutable(path.join(scenario, "run.sh"), `#!/usr/bin/env bash
set -euo pipefail
${commandBody}
`);

  const envScript = path.join(tools, "tt-env-scripted.sh");
  writeExecutable(envScript, `#!/usr/bin/env bash
export TT_REPO_ROOT='${repoRoot}'
export TT_ROOT='${root}'
export TT_SCRIPTED_HOME='${root}/home-scripted'
export HOME='${homeValue}'
export TAMANDUA_STATE_DIR='${stateDir}'
export TAMANDUA_CONTROL_PORT=5339
export TAMANDUA_MCP_PORT=5338
export TAMANDUA_DASHBOARD_PORT=5334
export PATH='${process.env.PATH ?? "/usr/bin:/bin"}'
printf '%s\\n' \\
  'TT_REPO_ROOT=${repoRoot}' \\
  'TT_ROOT=${root}' \\
  'TT_SCRIPTED_HOME=${root}/home-scripted' \\
  'HOME=${homeValue}' \\
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
printf '%s|%s|%s\\n' "$1" "$2" "$HOME" >>"${calls}"
case "$2" in
  start|restart|stop) exit 0 ;;
  status) echo 'STATUS: RUNNING'; exit 0 ;;
  reset-state)
    # MACP7 US-002: the hermetic fixture stub records the call and performs
    # the removal, so the harness's per-cell reset works in these tests too.
    rm -rf -- '${stateDir}'
    mkdir -p '${stateDir}'
    echo 'STATUS: RESET_STATE_OK'
    exit 0 ;;
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
  if [ "$3" = '--all' ]; then
    # T2.2 US-005: the harness installs the FULL bundled catalog per cell.
    src_root="\${TAMANDUA_WORKFLOWS_SRC:-${repoRoot}/workflows}"
    for wf_dir in "$src_root"/*/; do
      [ -d "$wf_dir" ] || continue
      [ -f "$wf_dir/workflow.yml" ] || continue
      base="$(basename "$wf_dir")"
      dst="$TAMANDUA_STATE_DIR/workflows/$base"
      mkdir -p "$(dirname "$dst")"
      cp -a "$wf_dir" "$dst"
    done
    exit 0
  fi
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
    commandMarker,
    env: {
      ...baseEnv(),
      TT_SCENARIO_TEST_MODE: "1",
      TT_SCENARIO_DAEMON_CONTROL: daemon,
      TT_SCENARIO_INSTALLER: installer,
      TT_SCENARIO_ENV: envScript,
      TT_SCENARIO_CLI: cli,
      TT_SCENARIO_VAR_ROOT: path.join(root, "scenario-state"),
    },
  };
}

// ── daemon-control function extraction (mirrors daemon-control.test.sh) ─

function extractFunctions(source: string, names: string[]): string {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  for (const name of names) {
    const decl = new RegExp(`^${name}\\(\\)`); // shell function: name() {
    let start = lines.findIndex((line) => decl.test(line));
    assert.ok(start >= 0, `function ${name} not found in daemon-control`);
    let depth = 0;
    let end = -1;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i];
      // Count literal { and } characters. Shell ${...} expansions are
      // balanced on their own line, so they never move the net depth.
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      depth += opens - closes;
      if (depth <= 0 && i > start) { end = i + 1; break; }
    }
    assert.ok(end > start, `could not slice ${name}`);
    out.push(lines.slice(start, end).join("\n"));
  }
  return out.join("\n");
}

// Stub environment used to exercise guard_kind_containment in isolation.
function containmentProbe(envForKind: string, expectRefuse: boolean): CommandResult {
  const functions = extractFunctions(fs.readFileSync(DAEMON_CONTROL, "utf8"),
    ["resolve_contained_dir", "guard_kind_containment"]);
  const script = [
    "set +e",
    `TT_ROOT="$(cd "${varRoot}" && pwd -P)"`,
    // refuse_production is daemon-control's fail-closed exit; stub it here.
    'refuse_production() { echo "REFUSED: $*" >&2; exit 1; }',
    `env_for_kind() { printf '%s\\n' '${envForKind.replace(/'/g, "'\\''")}'; }`,
    functions,
    "guard_kind_containment scripted",
    "echo CONTAINMENT_RESULT=ACCEPTED",
  ].join("\n");
  const result = run("bash", ["-c", script], { ...baseEnv(), HOME: operatorHome });
  if (expectRefuse) {
    assert.equal(result.status, 1,
      `expected refusal, got ${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /REFUSED/,
      "refusal must print the REFUSED marker");
  } else {
    assert.equal(result.status, 0,
      `expected acceptance, got ${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /CONTAINMENT_RESULT=ACCEPTED/);
  }
  return result;
}

let gitconfigBefore = "";
describe("FIX10 US-004 scenario + daemon-control contained-HOME fail-closed", () => {
  before(() => {
    fs.mkdirSync(varRoot, { recursive: true });
    gitconfigBefore = sha256(realGitconfig);
  });
  after(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(sha256(realGitconfig), gitconfigBefore,
      "the real ~/.gitconfig hash changed during the test run — containment broke");
  });

  it("scenario-containment-guard.sh refuses the operator HOME, var itself, and outside dirs; accepts a contained home", () => {
    // Operator real home — the 2026-08-05 breach surface.
    const operator = guardRun(operatorHome);
    assert.equal(operator.status, 2, `expected exit 2, got ${operator.status}`);
    assert.match(operator.stderr, /CONTAINMENT VIOLATION/);
    assert.match(operator.stderr, /NOT strictly under torture-test\/var/);
    assert.match(operator.stderr, new RegExp(operatorHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "stderr must name the offending (real) HOME");
    assert.doesNotMatch(operator.stdout, /GUARD_PASSED/, "guard must not pass with the operator HOME");

    // var itself — must be a contained CHILD home, not var.
    const varItself = guardRun(varRoot);
    assert.equal(varItself.status, 2, `var itself must be refused, got ${varItself.status}`);
    assert.match(varItself.stderr, /torture-test\/var itself/);

    // A sibling outside var.
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), `home-outside-var-${process.pid}-`));
    try {
      const siblingRun = guardRun(sibling);
      assert.equal(siblingRun.status, 2, `sibling must be refused, got ${siblingRun.status}`);
      assert.match(siblingRun.stderr, /NOT strictly under torture-test\/var/);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }

    // Unset HOME.
    const unset = guardRun(undefined);
    assert.equal(unset.status, 2, `unset HOME must be refused, got ${unset.status}`);
    assert.match(unset.stderr, /HOME is unset/);

    // Contained home (exists) passes.
    const contained = fs.mkdtempSync(path.join(varRoot, `home-scenario-guard-${process.pid}-`));
    try {
      const ok = guardRun(contained);
      assert.equal(ok.status, 0, `contained HOME must pass:\n${ok.stderr}`);
      assert.match(ok.stdout, /GUARD_PASSED/);
    } finally {
      fs.rmSync(contained, { recursive: true, force: true });
    }
  });

  it("run-scripted-scenario fails a scenario whose env script resolves HOME outside torture-test/var, before any command/daemon work", () => {
    const fixture = makeHarnessFixture(operatorHome);
    const result = run(HARNESS, [fixture.scenario], fixture.env);
    assert.notEqual(result.status, 0,
      `escaping-HOME scenario must fail\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /scripted HOME escaped torture-test\/var/,
      "harness must name the escaping scripted HOME");
    assert.equal(fs.existsSync(fixture.commandMarker), false,
      "the scenario command must never run with an uncontained HOME");
    assert.equal(fs.existsSync(fixture.calls), false,
      "daemon-control must never be invoked for an escaping-HOME scenario");
  });

  it("run-scripted-scenario runs the command when the env script HOME is contained, and the child wrapper sources the guard", () => {
    const containedHome = path.join(varRoot, `home-harness-contained-${crypto.randomUUID()}`);
    fs.mkdirSync(containedHome, { recursive: true });
    const fixture = makeHarnessFixture(containedHome);
    try {
      const result = run(HARNESS, [fixture.scenario], fixture.env);
      assert.equal(result.status, 0,
        `contained scenario must pass\n${result.stdout}\n${result.stderr}`);
      assert.equal(fs.existsSync(fixture.commandMarker), true,
        "the scenario command must have run under the contained HOME");
    } finally {
      fs.rmSync(containedHome, { recursive: true, force: true });
    }
  });

  it("the harness command child and every scenarios/*/run.sh source the containment guard", () => {
    const harnessSource = fs.readFileSync(HARNESS, "utf8");
    assert.match(harnessSource,
      /TT_SCENARIO_CONTAINMENT_GUARD="\$LIB_DIR\/scenario-containment-guard\.sh"/,
      "harness must export the guard path to the command child");
    assert.match(harnessSource,
      /source "\$\{TT_SCENARIO_CONTAINMENT_GUARD:\?\}"/,
      "the command child must source the guard before executing scenario code");
    // The guard must be sourced before the command is exec'd.
    const guardIndex = harnessSource.indexOf("source \"${TT_SCENARIO_CONTAINMENT_GUARD:?}\"");
    const execIndex = harnessSource.indexOf('exec "$command_path"');
    assert.ok(guardIndex >= 0 && execIndex > guardIndex,
      "the child wrapper must source the guard before exec'ing the command");

    // Every scenario run.sh entry point sources the guard (direct-invocation
    // protection — a scenario run outside the harness fails closed).
    const runShFiles = fs.readdirSync(path.join(ttRoot, "scenarios"), { recursive: true })
      .filter((entry) => typeof entry === "string" && entry.endsWith("run.sh"))
      .map((entry) => path.join(ttRoot, "scenarios", entry));
    assert.ok(runShFiles.length >= 30, `expected >= 30 run.sh files, found ${runShFiles.length}`);
    for (const file of runShFiles) {
      const source = fs.readFileSync(file, "utf8");
      assert.match(source, /scenario-containment-guard\.sh/,
        `${path.relative(ttRoot, file)} must source the containment guard`);
      // The guard must be sourced before any exec.
      const sourceIndex = source.indexOf("scenario-containment-guard.sh");
      const execIndex = source.indexOf("exec node");
      assert.ok(sourceIndex >= 0 && execIndex > sourceIndex,
        `${path.relative(ttRoot, file)} must source the guard before exec`);
    }
  });

  it("daemon-control guard_kind_containment refuses escaping HOME/TAMANDUA_STATE_DIR and var itself, accepts contained and not-yet-provisioned homes", () => {
    const varReal = fs.realpathSync(varRoot);
    const containedHome = path.join(varReal, "home-scripted");
    const containedState = path.join(containedHome, ".tamandua");
    // Contained kind → accepted.
    containmentProbe(
      `HOME=${containedHome}\nTAMANDUA_STATE_DIR=${containedState}\n`,
      false);
    // Escaping HOME → refused.
    containmentProbe(
      `HOME=${operatorHome}\nTAMANDUA_STATE_DIR=${containedState}\n`,
      true);
    // Escaping TAMANDUA_STATE_DIR → refused.
    containmentProbe(
      `HOME=${containedHome}\nTAMANDUA_STATE_DIR=${path.join(operatorHome, ".tamandua")}\n`,
      true);
    // var itself as a live HOME → refused.
    containmentProbe(
      `HOME=${varReal}\nTAMANDUA_STATE_DIR=${containedState}\n`,
      true);
    // Not-yet-provisioned contained child → accepted (fresh checkout).
    containmentProbe(
      `HOME=${path.join(varReal, "home-not-yet-provisioned")}\nTAMANDUA_STATE_DIR=${path.join(varReal, "home-not-yet-provisioned", ".tamandua")}\n`,
      false);
  });

  it("daemon-control main() wires guard_kind_containment after guard_kind_cwd, and the header documents the US-004 guard", () => {
    const source = fs.readFileSync(DAEMON_CONTROL, "utf8");
    const mainStart = source.indexOf("main()");
    assert.ok(mainStart >= 0, "daemon-control must define main()");
    const main = source.slice(mainStart);
    const cwdIndex = main.indexOf('guard_kind_cwd "$kind"');
    const containmentIndex = main.indexOf('guard_kind_containment "$kind"');
    assert.ok(cwdIndex >= 0 && containmentIndex > cwdIndex,
      "main() must run guard_kind_containment after guard_kind_cwd");
    assert.match(source, /guard_kind_containment/,
      "guard_kind_containment must exist in daemon-control");
    assert.match(source, /resolve_contained_dir/,
      "resolve_contained_dir helper must exist in daemon-control");
    assert.match(source, /FIX10 US-004/,
      "daemon-control must document the US-004 containment guard");
    assert.match(source, /escapes torture-test\/var/,
      "the guard message must name the containment escape");
  });

  it("daemon_control() documents the real-HOME handoff safety invariant in run-scripted-scenario", () => {
    const source = fs.readFileSync(HARNESS, "utf8");
    const daemonControlStart = source.indexOf("daemon_control()");
    const comment = source.slice(Math.max(0, daemonControlStart - 2500), daemonControlStart);
    assert.match(comment, /FIX10 US-004/,
      "daemon_control() must carry a FIX10 US-004 containment note");
    assert.match(comment, /ACCOUNT_HOME|operator's real home|operator HOME/,
      "the note must explain the real-HOME handoff");
    assert.match(comment, /env_for_kind|env -i/,
      "the note must state that daemon children get the contained env");
    assert.match(comment, /grep-verified|no git config/,
      "the note must state that daemon-control performs no git writes");
    // The harness must keep the sanctioned invocation line intact.
    assert.match(source, /"\$DAEMON_CONTROL" scripted "\$operation"/);
  });
});
