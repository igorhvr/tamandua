// Tier-2 STORM-REHEARSAL FIX9 US-010 — extended storm self-test chain
// selection.
//
// The fix9 run grows the fix8 47-file storm self-test chain with the new
// self-tests this run adds. This test pins the SELECTION itself, so a
// regressed/renamed/dropped chain member can never silently shrink the
// extended sweep that the fix9 readiness publishes:
//
//   * the frozen 47-file #74 base list is unique, exists on disk, and is
//     entirely `torture-test/self-tests/*.test.ts` storm tests;
//   * the fix9-added files (the US-008 no-op audit + this selection test)
//     compose onto the base as a unique, ordered, `&&`-chained
//     `node --test` command with the frozen isolation prefix
//     (TAMANDUA_TEST_GUARD=1 + PI/DSH/HERMES=/usr/bin/false);
//   * a missing file, a duplicate, an empty selection and a non-storm path
//     are all rejected (fail-closed selection);
//   * when the published fix9 readiness exists, its recorded chain
//     (self_tests + test_cmd_extended + test_cmd_glob) equals this exact
//     selection byte-for-byte, and every recorded file is exit 0 / fail 0 /
//     under the shared gate flock.
//
// In-process only: no daemon, no harness, no model, no ports, no source edits.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.env.TT_REPO_ROOT ?? path.resolve(process.cwd());
const READINESS_PATH = process.env.FIX9_READINESS_PATH ?? "/root/matchlock-work/storm-rehearsal-fix9-readiness.json";
const GATE_LOCK = "/root/matchlock-work/vaivm-gate.lock";

const ENV_PREFIX =
  "export TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false TAMANDUA_HERMES_BINARY=/usr/bin/false;";

// The frozen fix8 47-file #74 chain, in the chain order.
export const FIX8_CHAIN_47 = [
  "torture-test/self-tests/tier2-storm-orchestrator-recording-gate.test.ts",
  "torture-test/self-tests/tier2-storm-real-calibration.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-admission-snapshot.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-behaviors.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-boundary.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-chaos-guard.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-chaos-honesty.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-cleanup.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-consistency.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-daemon-env.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-daemon-provenance.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-exec-db.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate-coverage.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-behaviors.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-runtime.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-schedule.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-mcp-pounding.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-origin-containment.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-pending-candidate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-phase-predicate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-prepare.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-redbait-projection.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rounda-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-abort.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-simultaneity-window.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-workflow-graph.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-workflow-simulation.test.ts",
  "torture-test/self-tests/tier2-storm.test.ts",
  "torture-test/self-tests/tt-poly-storm-md-documentation.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-wiring.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-oneshot.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-live-target.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-stopdel-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-relaunch-taskfile.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-stopdel-terminal.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-launch-argv-containment.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rugpull-origin.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-merge-events.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rugpull-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-park-target.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-park-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-product-evidence-ids.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-evidence-audit.test.ts",
];

// The fix9 run's added self-tests, in chain order (after the frozen base).
export const FIX9_ADDED = [
  "torture-test/self-tests/tier2-storm-rehearsal-noop-evidence.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-extended-chain.test.ts",
];

function assertSelectable(files: any): string[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("selection must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (typeof f !== "string" || !f.startsWith("torture-test/self-tests/") || !f.endsWith(".test.ts")) {
      throw new Error(`not a storm self-test path: ${JSON.stringify(f)}`);
    }
    if (seen.has(f)) throw new Error(`duplicate selection entry: ${f}`);
    seen.add(f);
  }
  return files.slice();
}

/** base ++ added, validated unique/ordered/fail-closed. */
export function selectExtendedChain(base: any = FIX8_CHAIN_47, added: any = FIX9_ADDED): string[] {
  return assertSelectable([...assertSelectable(base), ...assertSelectable(added)]);
}

/** The exact `&&`-chained command the fix9 readiness must record. */
export function buildChainCommand(files: any): string {
  const list = assertSelectable(files);
  return `${ENV_PREFIX} ${list.map((f) => `node --test ${f}`).join(" && ")}`;
}

/** The exact per-file-under-flock glob command the fix9 readiness must record. */
export function buildChainGlob(files: any): string {
  const list = assertSelectable(files);
  const quoted = list.map((f) => `'${f}'`).join(" ");
  return `${ENV_PREFIX} for f in ${quoted}; do flock --exclusive ${GATE_LOCK} node --test "$f" || exit 1; done`;
}

describe("US-010 extended storm self-test chain selection", () => {
  it("pins the frozen 47-file #74 base list: 47 unique storm self-tests, all on disk", () => {
    assert.equal(FIX8_CHAIN_47.length, 47, "the base chain is the 47-file #74 chain");
    assert.deepEqual(assertSelectable(FIX8_CHAIN_47), FIX8_CHAIN_47);
    for (const f of FIX8_CHAIN_47) {
      assert.ok(fs.existsSync(path.join(repoRoot, f)), `base chain member exists: ${f}`);
    }
  });

  it("composes the fix9 additions (US-008 no-op audit + this selection test) after the base", () => {
    const chain = selectExtendedChain();
    assert.equal(chain.length, 49, "extended chain is base 47 + 2 fix9 additions");
    assert.deepEqual(chain.slice(0, 47), FIX8_CHAIN_47, "base order preserved");
    assert.deepEqual(chain.slice(47), FIX9_ADDED, "fix9 additions appended in order");
    for (const f of FIX9_ADDED) {
      assert.ok(fs.existsSync(path.join(repoRoot, f)), `fix9 added chain member exists: ${f}`);
      assert.ok(!FIX8_CHAIN_47.includes(f), `fix9 added file is not already in the base: ${f}`);
    }
  });

  it("rejects empty / duplicated / non-storm selections (fail-closed)", () => {
    assert.throws(() => selectExtendedChain(FIX8_CHAIN_47, []), /non-empty/);
    assert.throws(() => selectExtendedChain(FIX8_CHAIN_47, [FIX8_CHAIN_47[0]]), /duplicate/);
    assert.throws(() => selectExtendedChain([...FIX8_CHAIN_47, FIX8_CHAIN_47[0]], []), /duplicate/);
    assert.throws(() => selectExtendedChain(FIX8_CHAIN_47, ["src/not-a-storm-test.test.ts"]), /not a storm self-test/);
    assert.throws(() => buildChainCommand([]), /non-empty/);
    assert.throws(() => buildChainGlob([123]), /not a storm self-test/);
  });

  it("builds the extended chain as one &&-chained node --test per file under the frozen isolation prefix", () => {
    const chain = selectExtendedChain();
    const cmd = buildChainCommand(chain);
    assert.equal((cmd.match(/node --test/g) || []).length, chain.length, "one node --test per selected file");
    assert.equal((cmd.match(/ && /g) || []).length, chain.length - 1, "files are &&-chained");
    assert.ok(cmd.startsWith(ENV_PREFIX), "the isolation prefix leads the command");
    assert.match(cmd, /TAMANDUA_TEST_GUARD=1/);
    assert.match(cmd, /TAMANDUA_PI_BINARY=\/usr\/bin\/false/);
    assert.match(cmd, /TAMANDUA_DSH_BINARY=\/usr\/bin\/false/);
    assert.match(cmd, /TAMANDUA_HERMES_BINARY=\/usr\/bin\/false/);
    assert.ok(!/approval/i.test(cmd), "the chain names no approval path");
    const glob = buildChainGlob(chain);
    for (const f of chain) assert.ok(glob.includes(`'${f}'`), `glob names ${f}`);
    assert.match(glob, /flock --exclusive \/root\/matchlock-work\/vaivm-gate\.lock/);
    assert.ok(glob.includes('../bin') === false, "sanity: relative paths are the recorded form");
  });

  it("the published fix9 readiness records exactly this selection (when present)", () => {
    if (!fs.existsSync(READINESS_PATH)) return;
    const rd = JSON.parse(fs.readFileSync(READINESS_PATH, "utf8"));
    assert.equal(rd.kind, "storm-rehearsal-fix9-readiness");
    assert.equal(rd.branch, "fix/torture-storm-rehearsal-rugpull-identity-20260913");
    const chain = selectExtendedChain();
    assert.equal(rd.test_cmd_extended, buildChainCommand(chain), "test_cmd_extended == the exact extended chain");
    assert.equal(rd.test_cmd_glob, buildChainGlob(chain), "test_cmd_glob == the exact extended chain");
    assert.deepEqual(
      rd.self_tests.map((t: any) => t.file),
      chain,
      "recorded self_tests == selection order",
    );
    assert.equal(
      (rd.test_cmd_extended.match(/node --test/g) || []).length,
      rd.self_tests.length,
      "test_cmd_extended has one node --test per recorded file",
    );
    for (const t of rd.self_tests) {
      assert.equal(t.exit, 0, `${t.file} exited 0`);
      assert.equal(t.fail, 0, `${t.file} had 0 failures`);
      assert.equal(t.under_flock, true, `${t.file} ran under the shared gate lock`);
    }
    assert.equal(rd.self_tests_summary.fail, 0, "zero failures across the chain");
    assert.equal(rd.self_tests_summary.all_exit_zero, true, "every chain file exited 0");
    assert.ok(rd.self_tests.some((t: any) => t.file === "torture-test/self-tests/tier2-storm-rehearsal-noop-evidence.test.ts"), "the US-008 no-op audit is in the chain");
    assert.ok(rd.self_tests.some((t: any) => t.file === "torture-test/self-tests/tier2-storm-rehearsal-extended-chain.test.ts"), "this US-010 selection test is in the chain");
  });
});
