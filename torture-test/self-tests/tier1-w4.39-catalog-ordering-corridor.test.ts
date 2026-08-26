// T2.2 US-005 — W4.39-a-union-honest: scripted-catalog ordering corridor
// regression pin.
//
// Defect (preval campaign-20260825T233741033Z-577fa359): W4.39-a failed
// TEST_INFRA_FAIL 'workflow-spec-missing' —
//   No workflow.yml found in .../var/home-scripted/.tamandua/workflows/bug-fix-merge-worktree
// Root cause: MACP7's per-cell reset (daemon-control scripted reset-state at
// scenario-harness entry) wipes var/home-scripted/.tamandua INCLUDING the
// installed catalog; the harness's install leg then reinstalled ONLY the
// cell's base workflow (`workflow install "$WORKFLOW_BASE"`). The do-now-base
// scenario cells that ran before the controller-launched bug-fix-merge-worktree
// case (W4.27 at 23:51:11, W4.12 at 23:52:53) therefore left the catalog
// truncated to do-now, and the next bfmw workflow case (W4.39-a at 23:53:34)
// hit workflow-spec-missing.
//
// Fix: the per-cell install leg now runs `workflow install --all` with
// TAMANDUA_WORKFLOWS_SRC pinned to the bundled workflows dir (the same seam
// tt-controller's runScriptedCatalogInstall uses), AFTER reset-state and
// BEFORE daemon start (the reset -> install -> start harness contract); the
// scenario-specific install-scenario-workflows copy proceeds as before. No
// cell is exempted from reset.
//
// This file pins the corridor MECHANICALLY (the campaign runs are the
// behavioral proof — see the story's AC1/AC2):
//   1. HARNESS STRUCTURE: the per-cell install leg is `workflow install
//      --all` with TAMANDUA_WORKFLOWS_SRC="$REPO_ROOT/workflows", the old
//      base-only install is GONE, reset-state still goes through
//      daemon-control (no exemption), the catalog install is ordered after
//      reset-state and before daemon start, and the scenario installer
//      (install-scenario-workflows) still runs after the catalog install.
//   2. HERMETIC END-TO-END: a scenario-harness cell through the
//      TT_SCENARIO_TEST_MODE seam (stub daemon-control/installer/CLI/env)
//      against a scripted home PRE-SEEDED with a partial catalog (do-now
//      only — the W4.39-a failure shape: a previous cell left the catalog
//      truncated). The harness's per-cell reset wipes it, then the install
//      leg must restore the FULL bundled catalog so the scenario command
//      (standing in for any subsequent controller-launched workflow case)
//      resolves bug-fix-merge-worktree + do-now. Asserts the full catalog is
//      present at scenario-command time AND persists after the harness exits
//      (a following controller case would find it).
//
// Hermetic: no real daemon starts, no TT ports touched, temp dirs under
// torture-test/var only, zero tokens. Picked up by self-tests/run.sh's
// `tier1-*.test.ts` glob (bounded battery — no run.sh edit needed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const harness = path.join(ttRoot, "scenarios", "lib", "run-scripted-scenario");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");
// The bundled catalog size: every dir under workflows/ carries workflow.yml
// (verified at authoring time); the hermetic arm asserts the FULL catalog was
// installed, not just the spot-checked pair.
const BUNDLED_CATALOG_COUNT = fs.readdirSync(BUNDLED_WORKFLOWS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .length;

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Strip NODE_TEST_CONTEXT (auto-activates the isolation guard in children)
 *  and disable the guard explicitly — children operate on temp dirs only. */
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

function run(cmd: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CmdResult {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? cleanEnv(),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

// ── hermetic fixture ─────────────────────────────────────────────────────
//
// Mirrors the scripted-scenario-harness.test.ts makeFixture shape: a fake
// tt-env-scripted.sh (contained HOME/TAMANDUA_STATE_DIR under the fixture
// root), a fake daemon-control (reset-state wipes the state dir), a fake
// install-scenario-workflows (copies the base catalog entry into the
// scenario-unique id), and a fake tamandua CLI that handles BOTH
// `workflow install <name>` and `workflow install --all` (the latter honors
// TAMANDUA_WORKFLOWS_SRC, falling back to the bundled workflows dir — the
// real `workflow install --all` semantics).
function makeFixture(commandBody: string): {
  root: string;
  scenario: string;
  calls: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
} {
  const root = path.join(varRoot, `w4.39-corridor-${crypto.randomUUID()}`);
  const scenario = path.join(root, "scenario");
  const tools = path.join(root, "tools");
  const stateDir = path.join(root, "home-scripted", ".tamandua");
  const calls = path.join(root, "daemon-calls.log");
  fs.mkdirSync(scenario, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  // HOME must exist before the harness runs (the containment guard requires
  // a real directory strictly inside torture-test/var).
  fs.mkdirSync(path.join(root, "home-scripted"), { recursive: true });

  fs.writeFileSync(path.join(scenario, "scenario.json"), JSON.stringify({
    schema_version: 1,
    id: "w4.39-corridor",
    workflow_base: "do-now",
    behaviors: "behaviors.json",
    command: "run.sh",
    expected_outcome: "completed",
    oracles: ["O1", "O3z", "O11"],
  }, null, 2));
  fs.writeFileSync(path.join(scenario, "behaviors.json"), JSON.stringify({
    agents: {
      doer: {
        output: "STATUS: done\nREPORT: w4.39 catalog-ordering corridor",
        tokens: 0,
      },
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  }, null, 2));
  writeExecutable(path.join(scenario, "run.sh"), `#!/usr/bin/env bash
set -euo pipefail
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
  reset-state)
    # MACP7 US-002: the hermetic fixture stub records the call and performs
    # the removal (like the real daemon-control), so harness tests can
    # pre-seed the fixture's scripted state dir and assert it is reset.
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
src="$TAMANDUA_STATE_DIR/workflows/$base"
dst="$TAMANDUA_STATE_DIR/workflows/$base-$invocation"
[ -d "$src" ] || { echo "install-scenario-workflows: source workflow not found: $src" >&2; exit 1; }
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
    src_root="\${TAMANDUA_WORKFLOWS_SRC:-${BUNDLED_WORKFLOWS}}"
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
  src='${BUNDLED_WORKFLOWS}/'"$3"
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
    stateDir,
    env: {
      ...cleanEnv(),
      TT_SCENARIO_TEST_MODE: "1",
      TT_SCENARIO_DAEMON_CONTROL: daemon,
      TT_SCENARIO_INSTALLER: installer,
      TT_SCENARIO_ENV: envScript,
      TT_SCENARIO_CLI: cli,
      TT_SCENARIO_VAR_ROOT: path.join(root, "scenario-state"),
    },
  };
}

function catalogWorkflowIds(stateDir: string): string[] {
  const workflowsDir = path.join(stateDir, "workflows");
  if (!fs.existsSync(workflowsDir)) return [];
  return fs.readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// ── tests ───────────────────────────────────────────────────────────────

describe("W4.39-a scripted-catalog ordering corridor (T2.2 US-005)", () => {
  it("the harness installs the FULL bundled catalog per cell, ordered reset -> install -> start, with no reset exemption", () => {
    const source = fs.readFileSync(harness, "utf8");

    // The per-cell install leg must be a FULL catalog install with the
    // bundled workflows dir pinned (tt-controller's runScriptedCatalogInstall
    // seam), never a base-only install.
    assert.match(source, /workflow install --all/,
      "the per-cell install leg must run `workflow install --all` (full catalog)");
    assert.match(source, /TAMANDUA_WORKFLOWS_SRC="\$REPO_ROOT\/workflows"/,
      "the install leg must pin TAMANDUA_WORKFLOWS_SRC to the bundled workflows dir");
    assert.ok(!/workflow install "\$WORKFLOW_BASE"/.test(source),
      "the old base-only install leg must be gone");

    // reset -> install -> start contract: reset-state still goes through
    // daemon-control (no cell exemption), and the catalog install sits
    // between reset-state and the daemon start.
    const resetIndex = source.indexOf("daemon_control reset-state");
    const installIndex = source.indexOf("workflow install --all");
    const startIndex = source.indexOf("daemon_control start");
    assert.ok(resetIndex >= 0, "reset-state must still run through daemon-control");
    assert.ok(installIndex > resetIndex,
      "the catalog install must run AFTER reset-state (so it is not wiped)");
    assert.ok(startIndex > installIndex,
      "the catalog install must run BEFORE daemon start (reset -> install -> start)");

    // The scenario-specific installer still runs after the catalog install,
    // so the scenario-unique workflow copy (with the invocation id) is made
    // from the freshly restored catalog.
    const installerIndex = source.indexOf('exec "$INSTALLER" "$WORKFLOW_BASE" "$INVOCATION_ID" --json');
    assert.ok(installerIndex > installIndex,
      "install-scenario-workflows must still run after the catalog install");
  });

  it("a per-cell reset wipes a pre-seeded partial catalog and the harness restores the FULL bundled catalog (the W4.39-a failure shape)", { timeout: 120_000 }, () => {
    const commandBody = `
# Stand-in for a subsequent controller-launched workflow case: after this
# scenario-harness cell's reset -> install -> start, BOTH the cell's base and
# the bfmw workflow W4.39-a needs must resolve.
[ -f "$TAMANDUA_STATE_DIR/workflows/do-now/workflow.yml" ] || { echo "do-now workflow.yml missing" >&2; exit 94; }
[ -f "$TAMANDUA_STATE_DIR/workflows/bug-fix-merge-worktree/workflow.yml" ] || { echo "bug-fix-merge-worktree workflow.yml missing (workflow-spec-missing shape)" >&2; exit 93; }
printf '%s\\n' catalog-ok >"$TT_TEST_CATALOG_MARKER"
exit 0
`;
    const fixture = makeFixture(commandBody);
    const marker = path.join(fixture.root, "catalog-marker");
    fixture.env.TT_TEST_CATALOG_MARKER = marker;
    try {
      // Pre-seed the contained scripted home with a PARTIAL catalog (do-now
      // only) — the W4.39-a failure shape: a previous scenario-harness cell
      // (pre-fix: base-only install) left the catalog truncated, so the next
      // controller-launched bfmw case would hit workflow-spec-missing.
      const partialWorkflows = path.join(fixture.stateDir, "workflows");
      fs.mkdirSync(path.join(partialWorkflows, "do-now"), { recursive: true });
      fs.writeFileSync(path.join(partialWorkflows, "do-now", "workflow.yml"), "id: do-now\n");
      fs.mkdirSync(path.join(partialWorkflows, "bug-fix-merge-worktree"), { recursive: true });
      fs.writeFileSync(path.join(partialWorkflows, "bug-fix-merge-worktree", "workflow.yml"),
        "id: bug-fix-merge-worktree\n");

      const result = run([harness, fixture.scenario], { env: fixture.env });
      assert.equal(result.status, 0,
        `the scenario-harness cell must PASS through the normal harness:\n${result.stdout}\n${result.stderr}`);
      assert.ok(fs.existsSync(marker),
        "the scenario command must have observed the full catalog (its checks passed)");

      // The full catalog persists AFTER the harness exits (its cleanup only
      // removes the scenario-unique copy + invocation dir, never the
      // installed catalog): a subsequent controller-launched workflow case
      // would find bug-fix-merge-worktree + do-now (and every other bundled
      // workflow).
      const after = catalogWorkflowIds(fixture.stateDir);
      assert.ok(after.includes("do-now"), "do-now must remain installed after the cell");
      assert.ok(after.includes("bug-fix-merge-worktree"),
        `bug-fix-merge-worktree must remain installed after the cell (got: ${after.join(", ")})`);
      assert.ok(after.length >= BUNDLED_CATALOG_COUNT,
        `the FULL bundled catalog must be restored (expected >= ${BUNDLED_CATALOG_COUNT}, got ${after.length})`);

      // Reset hygiene intact: reset-state ran exactly once through the
      // daemon-control stub, before the start.
      const ops = fs.readFileSync(fixture.calls, "utf8").trim().split("\n").map((line) => line.split("|")[1]);
      assert.equal(ops.filter((op) => op === "reset-state").length, 1,
        "the per-cell reset must run exactly once");
      assert.ok(ops.indexOf("reset-state") < ops.indexOf("start"),
        "reset-state must run before daemon start");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
