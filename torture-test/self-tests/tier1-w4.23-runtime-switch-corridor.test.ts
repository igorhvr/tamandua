// T2.2 US-004 — W4.23 daemon-cross-runtime-restart: runtime-switch corridor
// regression pin.
//
// Defect (preval campaign-20260825T233741033Z): the W4.23 scenario failed
// LOCAL_SCENARIO_EVIDENCE_FAILED across O1/O11/O3z —
//   AssertionError: the restarted daemon must run under runtime B's node
//   (.../image/node/22.23.1/bin/node), got /usr/bin/node
// at run-cross-runtime.mjs:305. Root cause: daemon-control reconstructs the
// contained launch PATH itself (contained_path_for_kind, S24/US-006 —
// adapters-bin first, env-script PATH next, caller PATH last with operator
// bin dirs reordered) and spawns via `env -i $(env_for_kind ...) PATH=...`,
// so the scenario's caller-PATH prepend of runtime B's node dir is DROPPED
// and the restarted daemon always lands on the env script's node (runtime A).
//
// Fix: switch the daemon to runtime B through the daemon-control-sanctioned
// TT_DC_ENV_SCRIPTED env-script seam — a CONTAINED env-script variant
// (scenarios/lib/runtime-switch-env.mjs, shared with the scenario) that
// sources env/tt-env-scripted.sh and pins TT_NODE_BIN/TT_NODE_BIN_DIR + the
// printed PATH to runtime B; daemon-control scripted start/status/stop for
// the runtime-B phase only run with TT_DC_ENV_SCRIPTED=<variant>.
//
// This file pins the corridor MECHANICALLY (the scenario run itself is the
// behavioral proof — see AC1):
//   1. VARIANT GENERATION: the shared module writes a valid bash variant
//      whose `print` output pins TT_NODE_BIN/TT_NODE_BIN_DIR to runtime B,
//      prepends runtime B's dir to PATH, and keeps the CONTAINED
//      HOME/TAMANDUA_STATE_DIR (containment preserved through the seam).
//   2. CONTAINED-PATH CORRIDOR: daemon-control's contained_path_for_kind
//      (TT_DAEMON_CONTROL_CONTAINED_PATH=scripted seam) carries runtime B's
//      dir in the ENV-SCRIPT leg (component 2, right after var/adapters-bin)
//      when TT_DC_ENV_SCRIPTED=<variant> — and does NOT when the variant is
//      absent, even if the CALLER PATH prepends runtime B's dir (the exact
//      pre-fix failure mode: caller-PATH prepend is dropped).
//   3. SCENARIO STRUCTURE: the runner uses the shared module, passes
//      TT_DC_ENV_SCRIPTED for the runtime-B phase, and no longer hand-deletes
//      the state-dir pidfile (obsolete under MACP5 identity-verified
//      provenance; deleting it could race the daemon's own pidfile write).
//
// Hermetic: no daemon starts, no TT ports touched, temp dirs only, zero
// tokens. Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded
// battery — no run.sh edit needed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeRuntimeBEnvScript } from "../scenarios/lib/runtime-switch-env.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const dcTool = path.join(ttRoot, "bin", "daemon-control");
const scenarioRunner = path.join(
  ttRoot,
  "scenarios",
  "w4.23",
  "daemon-cross-runtime-restart",
  "run-cross-runtime.mjs",
);

// ── helpers ────────────────────────────────────────────────────────────

/** Strip NODE_TEST_CONTEXT (auto-activates the isolation guard in children)
 *  and disable the guard explicitly — this test spawns bash/daemon-control
 *  helpers that operate on temp dirs + PATH strings only. */
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
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/** Parse a `KEY=VALUE` line stream into a record (last value wins). */
function parseKeyValues(output: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    record[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return record;
}

/** The reconstructed contained launch PATH for kind=scripted via
 *  daemon-control's TT_DAEMON_CONTROL_CONTAINED_PATH seam (no daemon start). */
function containedPath(extraEnv: Record<string, string>): string {
  const res = run([dcTool], {
    env: cleanEnv({ ...extraEnv, TT_DAEMON_CONTROL_CONTAINED_PATH: "scripted" }),
  });
  assert.equal(res.status, 0, `contained_path_for_kind failed:\n${res.stderr}`);
  return res.stdout.trim();
}

// ── tests ──────────────────────────────────────────────────────────────

describe("W4.23 runtime-switch corridor (T2.2 US-004)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w423-corridor-"));
  const invocationDir = path.join(tmp, "invocation");
  fs.mkdirSync(invocationDir, { recursive: true });
  const fakeRuntimeBBin = path.join(tmp, "runtime-b", "bin", "node");
  const fakeRuntimeBDir = path.dirname(fakeRuntimeBBin);
  const variantPath = writeRuntimeBEnvScript({
    invocationDir,
    repoRoot,
    runtimeBBin: fakeRuntimeBBin,
  });

  it("generates a valid bash env-script variant pinned to runtime B, containment preserved", () => {
    // The variant must be valid bash (the harness runs `bash <variant> print`).
    const syntax = run(["bash", "-n", variantPath]);
    assert.equal(syntax.status, 0, `bash -n failed:\n${syntax.stderr}`);

    const printed = run(["bash", variantPath, "print"]);
    assert.equal(printed.status, 0, `variant print failed:\n${printed.stderr}`);
    const env = parseKeyValues(printed.stdout);

    assert.equal(env.TT_NODE_BIN, fakeRuntimeBBin,
      "variant must pin TT_NODE_BIN to runtime B");
    assert.equal(env.TT_NODE_BIN_DIR, fakeRuntimeBDir,
      "variant must pin TT_NODE_BIN_DIR to runtime B's bin dir");
    assert.ok(env.PATH.startsWith(`${fakeRuntimeBDir}:`),
      `variant PATH must prepend runtime B's dir first (got: ${env.PATH})`);

    // Containment preserved through the seam: HOME + TAMANDUA_STATE_DIR stay
    // the bundled scripted contained paths (guard_kind_containment keeps
    // refusing anything that escapes torture-test/var).
    const ttRootReal = fs.realpathSync(ttRoot);
    for (const [key, value] of [["HOME", env.HOME], ["TAMANDUA_STATE_DIR", env.TAMANDUA_STATE_DIR]]) {
      assert.ok(typeof value === "string" && value.length > 0, `variant ${key} must be set`);
      assert.ok(value.startsWith(`${ttRootReal}/var/`),
        `variant ${key} escaped torture-test/var: ${value}`);
    }
    assert.equal(env.TAMANDUA_CONTROL_PORT, "5339", "variant must keep the scripted control port");
  });

  it("contained_path_for_kind carries runtime B's dir in the env-script leg only via the variant", () => {
    // ── pre-fix failure mode: caller-PATH prepend of runtime B's dir is
    //    DROPPED (S24/US-006 reconstructs the PATH; caller PATH comes last).
    const callerPrependPath = `${fakeRuntimeBDir}:${process.env.PATH ?? ""}`;
    const withoutVariant = containedPath({ PATH: callerPrependPath });
    const withoutSegs = withoutVariant.split(":");
    assert.equal(withoutSegs[0], path.join(ttRoot, "var", "adapters-bin"),
      "contained PATH must lead with var/adapters-bin (S24/US-006)");
    assert.notEqual(withoutSegs[1], fakeRuntimeBDir,
      `caller-PATH prepend of runtime B must NOT reach the env-script leg (got ${withoutSegs[1]}) — the pre-fix failure mode`);

    // ── the fix: the env-script VARIANT carries runtime B's dir in the
    //    env-script leg, so the daemon's `exec node` resolves to runtime B.
    const withVariant = containedPath({
      PATH: callerPrependPath,
      TT_DC_ENV_SCRIPTED: variantPath,
    });
    const withSegs = withVariant.split(":");
    assert.equal(withSegs[0], path.join(ttRoot, "var", "adapters-bin"),
      "contained PATH must lead with var/adapters-bin with the variant too");
    assert.equal(withSegs[1], fakeRuntimeBDir,
      `runtime B's dir must be the env-script leg's first component with the variant (got: ${withSegs.slice(0, 3).join(":")})`);
    assert.notEqual(withVariant, withoutVariant,
      "the variant must change the reconstructed contained PATH");
  });

  it("the scenario runner uses the seam, passes TT_DC_ENV_SCRIPTED for the B phase, and no longer hand-deletes the pidfile", () => {
    const source = fs.readFileSync(scenarioRunner, "utf8");
    const sharedModule = fs.readFileSync(
      path.join(ttRoot, "scenarios", "lib", "runtime-switch-env.mjs"),
      "utf8",
    );
    // The runtime-B phase must go through the env-script seam, never a
    // caller-PATH prepend.
    assert.match(source, /TT_DC_ENV_SCRIPTED/,
      "scenario must pass TT_DC_ENV_SCRIPTED for the runtime-B phase");
    assert.match(source, /runtime-switch-env\.mjs/,
      "scenario must generate the variant through the shared module");
    // The contained variant filename is owned by the shared module (both the
    // scenario and this test consume it).
    assert.match(sharedModule, /runtime-b-env-scripted\.sh/,
      "shared module must name the contained runtime-B env-script variant");
    // MACP5 identity-verified provenance: cmd_status reads
    // var/daemon-control/scripted.json, not the state-dir pidfile — the old
    // hand-deletions (waitForRunning / post-stop) could race the daemon's own
    // pidfile write; they are removed.
    assert.ok(!/fs\.rmSync\(pidFile/.test(source),
      "scenario must not hand-delete the state-dir pidfile (obsolete under MACP5 provenance)");
  });
});
