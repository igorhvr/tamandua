/**
 * US-012 — the pi Matchlock real-VM gate family and the fast e2e suite are
 * unchanged by the MTLK-ALL-WORKFLOWS admission / merge-wiring lift.
 *
 * The pi whole-path and synthetic gates are OPT-IN real-VM gates. This fast
 * contract pins the parts the story must prove WITHOUT booting a VM:
 *
 *   1. every pi gate still ships its runner script, wired to the correct
 *      e2e-tests gate file, building first, allocating a NEW mkdtemp evidence
 *      directory per run and propagating the `node --test` exit code;
 *   2. no pi real-VM gate leaked INTO a default fast lane
 *      (`run-all-e2e-tests` / `run-all-smoke-e2e-tests` /
 *      `run-all-scripted-e2e-tests`) — the fast lanes stay zero-token
 *      smoke + scripted only;
 *   3. every pi gate file keeps its "NOT part of any default fast lane"
 *      contract header, and the gates that ship fast no-VM controls keep them.
 *
 * The actual pi admission decision parity ("pi + pi context allows, pi +
 * non-pi refuses") is pinned by the existing US-003 coverage in
 * `src/installer/matchlock/dispatch-guard.test.ts` and
 * `src/installer/matchlock/harness-workflow-matrix.test.ts`; the fast-lane
 * exit-code plumbing is pinned by `tests/e2e-infrastructure.test.ts`. This file
 * deliberately does not duplicate either.
 *
 * Pure filesystem reads (no child_process, no dist import) -> parallel lane,
 * so it needs no `tests/serial-files.txt` entry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * The pi Matchlock real-VM gate family this story must leave green. Each entry
 * is the on-demand runner script and the e2e-tests gate file it launches.
 */
const PI_GATES = [
  {
    runner: "run-matchlock-worktree-merge-e2e-test",
    gate: "e2e-tests/matchlock-worktree-merge-gate.test.ts",
  },
  {
    runner: "run-matchlock-synthetic-e2e-test",
    gate: "e2e-tests/matchlock-synthetic-gate.test.ts",
  },
  {
    runner: "run-matchlock-empty-output-e2e-test",
    gate: "e2e-tests/matchlock-empty-output-gate.test.ts",
  },
  {
    runner: "run-matchlock-long-home-e2e-test",
    gate: "e2e-tests/matchlock-long-home-gate.test.ts",
  },
] as const;

/** Default fast lanes that must remain free of real-VM Matchlock gates. */
const FAST_LANE_SCRIPTS = [
  "run-all-e2e-tests",
  "run-all-smoke-e2e-tests",
  "run-all-scripted-e2e-tests",
] as const;

/** The opt-in contract header every pi real-VM gate file carries. */
const NOT_A_FAST_LANE_HEADER = "NOT part of any default fast lane";

function read(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), "utf-8");
}

describe("MTLK-ALL-WORKFLOWS US-012 pi gate family + fast e2e regression contract", () => {
  it("ships every pi real-VM gate runner (executable) and its gate file", () => {
    for (const { runner, gate } of PI_GATES) {
      const runnerPath = path.join(repoRoot, runner);
      assert.ok(fs.existsSync(runnerPath), `${runner} must exist`);
      fs.accessSync(runnerPath, fs.constants.X_OK);
      assert.ok(fs.existsSync(path.join(repoRoot, gate)), `${gate} must exist`);
    }
  });

  it("wires every pi gate runner to `node --test <gate>` and propagates the exit code", () => {
    for (const { runner, gate } of PI_GATES) {
      const content = read(runner);
      assert.ok(
        content.includes(`node --test ${gate}`),
        `${runner} must launch exactly ${gate} via node --test`,
      );
      assert.ok(
        content.includes("PIPESTATUS[0]"),
        `${runner} must capture the producer (node --test) exit code`,
      );
      assert.match(content, /exit "\$RC"/, `${runner} must propagate the gate exit code`);
    }
  });

  it("builds first and allocates a NEW mkdtemp evidence dir per gate run", () => {
    for (const { runner } of PI_GATES) {
      const content = read(runner);
      assert.ok(content.includes("npm run build"), `${runner} must build before the gate`);
      assert.ok(
        content.includes("mktemp -d"),
        `${runner} must allocate a fresh evidence dir (never a reused timestamp path)`,
      );
    }
  });

  it("keeps the opt-in `NOT part of any default fast lane` header in every pi gate file", () => {
    for (const { gate } of PI_GATES) {
      const content = read(gate);
      assert.ok(
        content.includes(NOT_A_FAST_LANE_HEADER),
        `${gate} must document that it is an opt-in real-VM gate`,
      );
    }
  });

  it("keeps the fast no-VM controls on the pi gates that ship them", () => {
    const synthetic = read("e2e-tests/matchlock-synthetic-gate.test.ts");
    assert.ok(
      synthetic.includes("INJECTED FAILURE CONTROLS (mock/no real VM)"),
      "the pi synthetic gate must keep its injected-failure controls",
    );
    const worktreeMerge = read("e2e-tests/matchlock-worktree-merge-gate.test.ts");
    assert.ok(
      worktreeMerge.includes("INJECTED FAILURE CONTROLS (mock/no real VM)"),
      "the pi worktree-merge gate must keep its injected-failure controls",
    );
    assert.ok(
      worktreeMerge.includes("preservation controls (no VM)"),
      "the pi worktree-merge gate must keep its merge preservation controls",
    );
  });

  it("never pulls a pi real-VM gate or runner into a default fast lane", () => {
    for (const lane of FAST_LANE_SCRIPTS) {
      const content = read(lane);
      for (const { runner, gate } of PI_GATES) {
        assert.ok(!content.includes(runner), `${lane} must not run the real-VM runner ${runner}`);
        assert.ok(!content.includes(gate), `${lane} must not run the real-VM gate ${gate}`);
      }
      // No real-VM gate file at all may leak into a fast lane.
      assert.ok(
        !/matchlock-[a-z-]*-gate\.test\.ts/.test(content),
        `${lane} must remain smoke + scripted (zero real-VM gates)`,
      );
    }
  });

  it("keeps run-all-e2e-tests as the build + smoke + serialized scripted fast tier", () => {
    const content = read("run-all-e2e-tests");
    assert.ok(content.includes("npm run build"), "run-all-e2e-tests must build first");
    assert.ok(
      content.includes("node --test e2e-tests/workflows-smoke.test.ts"),
      "run-all-e2e-tests must run the smoke tier",
    );
    assert.ok(
      content.includes("e2e-tests/workflows-scripted.test.ts"),
      "run-all-e2e-tests must run the scripted tier",
    );
    assert.ok(
      content.includes("--test-concurrency=1"),
      "run-all-e2e-tests must serialize the scripted tier",
    );
    assert.ok(
      content.includes("exit 1"),
      "run-all-e2e-tests must fail the gate when either tier fails",
    );
  });
});
