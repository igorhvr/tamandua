// Tier-2 US-009 — owned guard-safe gate worktree provisioning.
//
// The product TEST ISOLATION guard refuses any state/daemon root under the real
// ~/.tamandua prefix, so the storm self-tests that start contained daemons can
// only run from an owned checkout OUTSIDE that prefix
// (/home/kaladin/matchlock-work/npf2-gate-71af02c8). This file pins the
// provisioning contract that later heavy gates depend on:
//
//   * the pure plan/won't-plan predicate (`isUnderRealState`) and the
//     `buildGateProvisionPlan` refusals (unsafe root, bad tip, relative paths,
//     gate root == run worktree);
//   * `linkGateNodeModules` idempotence/replacement and its refusal to touch a
//     node_modules outside the owned gate root;
//   * `validateGateWorktreeProvisionReport` red arms for every way a retained
//     provisioning report can drift;
//   * `inspectGateWorktree` against a synthetic git worktree (guard-safe,
//     node_modules symlink, artifacts) and the LIVE owned gate worktree when it
//     exists on this host, including its retained provisioning report.
//
// Read-only against the live gate worktree; scratch dirs are owned temp dirs.
// No daemons, zero tokens.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  DEFAULT_GATE_WORKTREE_ROOT,
  EXPECTED_BUILD_ARTIFACTS,
  REAL_TAMANDUA_STATE_PREFIX,
  buildGateProvisionPlan,
  defaultProvisionReportCandidates,
  inspectGateWorktree,
  isUnderRealState,
  linkGateNodeModules,
  provisionGateWorktree,
  validateGateWorktreeProvisionReport,
} from "./gate-worktree-provision.mjs";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate-provision-${prefix}.`));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

/** A synthetic guard-safe "worktree" with the two build artifacts. */
function syntheticWorktree(prefix: string, { symlinkNodeModules = true } = {}): string {
  const root = scratch(prefix);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(git(["init", "-q", "-b", "main"], repo).status, 0);
  assert.equal(git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "seed"], repo).status, 0);
  for (const rel of EXPECTED_BUILD_ARTIFACTS) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "#!/bin/sh\nexit 0\n");
  }
  const source = path.join(root, "run-node_modules");
  fs.mkdirSync(source, { recursive: true });
  if (symlinkNodeModules) fs.symlinkSync(source, path.join(repo, "node_modules"), "dir");
  return repo;
}

function greenReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const gateRoot = "/home/kaladin/matchlock-work/npf2-gate-71af02c8";
  return {
    kind: "gate-worktree-provision-report",
    schema_version: 1,
    gate_root: gateRoot,
    tip: "09f72d74",
    head: "09f72d74992ac3be5174932c6d7962bc3c45da17",
    run_worktree: "/home/kaladin/.tamandua/worktrees/tamandua-origin-o12-0ded2d74/30-71af02c8",
    real_state_prefix: REAL_TAMANDUA_STATE_PREFIX,
    guard_safe: true,
    node_modules: { symlink: true, available: true },
    build: { command: "./build", exit_code: 0 },
    artifacts: EXPECTED_BUILD_ARTIFACTS.map((rel) => ({ rel, path: path.join(gateRoot, rel), exists: true })),
    steps: [
      { action: "ensure_worktree" },
      { action: "link_node_modules" },
      { action: "build" },
      { action: "verify_artifacts" },
    ],
    ...overrides,
  };
}

describe("isUnderRealState mirrors the product TEST ISOLATION containment", () => {
  it("matches the prefix itself and any descendant, and nothing else", () => {
    const prefix = path.join(os.tmpdir(), "fake-home", ".tamandua");
    assert.equal(isUnderRealState(prefix, { realStatePrefix: prefix }), true);
    assert.equal(isUnderRealState(path.join(prefix, "worktrees", "run"), { realStatePrefix: prefix }), true);
    // A sibling that merely shares the name prefix is NOT contained.
    assert.equal(isUnderRealState(`${prefix}-other`, { realStatePrefix: prefix }), false);
    assert.equal(isUnderRealState(path.join(path.dirname(prefix), "elsewhere"), { realStatePrefix: prefix }), false);
  });

  it("treats empty/non-string candidates as not-contained", () => {
    assert.equal(isUnderRealState(""), false);
    assert.equal(isUnderRealState(null as unknown as string), false);
    assert.equal(isUnderRealState(undefined as unknown as string), false);
  });

  it("defaults to the real ~/.tamandua prefix", () => {
    assert.equal(isUnderRealState(REAL_TAMANDUA_STATE_PREFIX), true);
    assert.equal(isUnderRealState(DEFAULT_GATE_WORKTREE_ROOT), false);
  });
});

describe("buildGateProvisionPlan", () => {
  it("accepts a guard-safe owned root and shapes the ordered steps", () => {
    const plan = buildGateProvisionPlan({
      gateRoot: "/home/kaladin/matchlock-work/npf2-gate-71af02c8",
      tip: "09f72d74",
      runWorktree: "/home/kaladin/.tamandua/worktrees/tamandua-origin-o12-0ded2d74/30-71af02c8",
    });
    assert.equal(plan.guard_safe, true);
    assert.deepEqual(
      plan.steps.map((step: { action: string }) => step.action),
      ["ensure_worktree", "link_node_modules", "build", "verify_artifacts"],
    );
    assert.equal(plan.node_modules.source.endsWith("node_modules"), true);
    assert.equal(plan.node_modules.target, path.join(plan.gate_root, "node_modules"));
    assert.deepEqual(plan.artifacts, EXPECTED_BUILD_ARTIFACTS);
  });

  it("refuses a gate root under the real state prefix", () => {
    assert.throws(
      () =>
        buildGateProvisionPlan({
          gateRoot: path.join(REAL_TAMANDUA_STATE_PREFIX, "worktrees", "gate"),
          tip: "09f72d74",
          runWorktree: "/home/kaladin/.tamandua/worktrees/tamandua-origin-o12-0ded2d74/30-71af02c8",
        }),
      (error: Error & { code?: string }) => error.code === "GATE_ROOT_UNSAFE",
    );
  });

  it("refuses an invalid tip, relative paths and gate root == run worktree", () => {
    const run = "/home/kaladin/.tamandua/worktrees/tamandua-origin-o12-0ded2d74/30-71af02c8";
    assert.throws(
      () => buildGateProvisionPlan({ gateRoot: "/tmp/gate", tip: "not-a-sha", runWorktree: run }),
      (error: Error & { code?: string }) => error.code === "GATE_TIP_INVALID",
    );
    assert.throws(
      () => buildGateProvisionPlan({ gateRoot: "relative/gate", tip: "09f72d74", runWorktree: run }),
      (error: Error & { code?: string }) => error.code === "GATE_GATEROOT_NOT_ABSOLUTE",
    );
    assert.throws(
      () => buildGateProvisionPlan({ gateRoot: run, tip: "09f72d74", runWorktree: run }),
      (error: Error & { code?: string }) => error.code === "GATE_ROOT_EQUALS_RUN_WORKTREE",
    );
  });
});

describe("linkGateNodeModules", () => {
  it("creates, reports idempotence, and is safe to re-run", () => {
    const root = scratch("link");
    const gateRoot = path.join(root, "gate");
    fs.mkdirSync(gateRoot, { recursive: true });
    const source = path.join(root, "run-node_modules");
    fs.mkdirSync(source, { recursive: true });

    const first = linkGateNodeModules({ gateRoot, source });
    assert.equal(first.action, "created");
    assert.equal(fs.lstatSync(path.join(gateRoot, "node_modules")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(gateRoot, "node_modules")), source);

    const second = linkGateNodeModules({ gateRoot, source });
    assert.equal(second.action, "already_linked");
  });

  it("replaces a real node_modules directory left by npm install", () => {
    const root = scratch("replace");
    const gateRoot = path.join(root, "gate");
    const real = path.join(gateRoot, "node_modules", "typescript");
    fs.mkdirSync(real, { recursive: true });
    const source = path.join(root, "run-node_modules");
    fs.mkdirSync(source, { recursive: true });

    const result = linkGateNodeModules({ gateRoot, source });
    assert.equal(result.action, "replaced");
    assert.equal(fs.lstatSync(path.join(gateRoot, "node_modules")).isSymbolicLink(), true);
  });

  it("refuses to replace a node_modules outside the owned gate root", () => {
    const root = scratch("refuse");
    const source = path.join(root, "source");
    fs.mkdirSync(source, { recursive: true });
    const foreign = path.join(root, "foreign", "node_modules");
    fs.mkdirSync(foreign, { recursive: true });
    assert.throws(
      () => linkGateNodeModules({ gateRoot: path.join(root, "gate"), source, target: foreign }),
      (error: Error & { code?: string }) => error.code === "GATE_NODE_MODULES_NOT_OWNED",
    );
  });
});

describe("validateGateWorktreeProvisionReport", () => {
  it("accepts a green report", () => {
    const validation = validateGateWorktreeProvisionReport(greenReport());
    assert.equal(validation.ok, true, validation.problems.join("; "));
  });

  it("rejects every drift arm", () => {
    const arms: Array<[string, Record<string, unknown>]> = [
      ["kind", greenReport({ kind: "something-else" })],
      ["schema", greenReport({ schema_version: 99 })],
      ["guard_safe", greenReport({ guard_safe: false })],
      ["unsafe root", greenReport({ gate_root: path.join(REAL_TAMANDUA_STATE_PREFIX, "gate") })],
      ["tip", greenReport({ tip: "not-hex" })],
      ["head", greenReport({ head: "short" })],
      ["build", greenReport({ build: { command: "./build", exit_code: 1 } })],
      ["symlink", greenReport({ node_modules: { symlink: false } })],
      ["artifact", greenReport({ artifacts: [] })],
      ["steps", greenReport({ steps: [{ action: "build" }] })],
    ];
    for (const [label, report] of arms) {
      assert.equal(validateGateWorktreeProvisionReport(report).ok, false, `drift arm must fail: ${label}`);
    }
    assert.equal(validateGateWorktreeProvisionReport(null).ok, false);
  });
});

describe("inspectGateWorktree", () => {
  it("accepts a synthetic guard-safe worktree with a node_modules symlink and artifacts", () => {
    const repo = syntheticWorktree("inspect-ok");
    const inspection = inspectGateWorktree({ gateRoot: repo, runWorktree: repo });
    assert.equal(inspection.ok, true, inspection.problems.join("; "));
    assert.equal(inspection.guard_safe, true);
    assert.equal(inspection.is_worktree, true);
    assert.match(inspection.head ?? "", /^[0-9a-f]{40}$/);
    assert.equal(inspection.node_modules.symlink, true);
    for (const artifact of inspection.artifacts) assert.equal(artifact.exists, true, artifact.rel);
  });

  it("reports every missing invariant for an empty/synthetic root", () => {
    const repo = scratch("inspect-red");
    fs.mkdirSync(path.join(repo, "nothing"), { recursive: true });
    const inspection = inspectGateWorktree({ gateRoot: repo, runWorktree: repo });
    assert.equal(inspection.ok, false);
    assert.ok(inspection.problems.some((problem) => problem.includes("build artifact missing")));
    assert.ok(inspection.problems.some((problem) => problem.includes("node_modules is missing")));
  });
});

describe("provisionGateWorktree (synthetic worktree, no-op build)", () => {
  function syntheticPair(prefix: string): { repo: string; run: string } {
    const root = scratch(prefix);
    const repo = path.join(root, "gate");
    fs.mkdirSync(repo, { recursive: true });
    assert.equal(git(["init", "-q", "-b", "main"], repo).status, 0);
    assert.equal(
      git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "seed"], repo).status,
      0,
    );
    for (const rel of EXPECTED_BUILD_ARTIFACTS) {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "#!/bin/sh\nexit 0\n");
    }
    const run = path.join(root, "run-home");
    fs.mkdirSync(path.join(run, "node_modules"), { recursive: true });
    return { repo, run };
  }

  it("returns a report that validates and names every step", () => {
    const { repo, run } = syntheticPair("provision-ok");
    const tip = git(["rev-parse", "HEAD"], repo).stdout.trim();
    const report = provisionGateWorktree({
      gateRoot: repo,
      runWorktree: run,
      tip,
      buildCommand: "/usr/bin/true",
      log: () => {},
    });
    assert.equal(report.ok, true);
    assert.equal(report.guard_safe, true);
    assert.equal(report.node_modules.symlink, true);
    assert.equal(report.build.exit_code, 0);
    assert.equal(report.build.command, "/usr/bin/true");
    assert.ok(
      report.steps.some((step: { action: string }) => step.action === "link_node_modules"),
      "report steps name link_node_modules",
    );
    const validation = validateGateWorktreeProvisionReport(report);
    assert.equal(validation.ok, true, validation.problems.join("; "));
  });

  it("fails closed when the build command fails", () => {
    const { repo, run } = syntheticPair("provision-red");
    const tip = git(["rev-parse", "HEAD"], repo).stdout.trim();
    assert.throws(
      () =>
        provisionGateWorktree({
          gateRoot: repo,
          runWorktree: run,
          tip,
          buildCommand: "/usr/bin/false",
          log: () => {},
        }),
      (error: Error & { code?: string }) => error.code === "GATE_BUILD_FAILED",
    );
  });
});

describe("live owned gate worktree (when present on this host)", () => {
  const gateRoot = process.env.TAMANDUA_GATE_WORKTREE
    ? path.resolve(process.env.TAMANDUA_GATE_WORKTREE)
    : DEFAULT_GATE_WORKTREE_ROOT;
  const present = fs.existsSync(gateRoot);

  it("is guard-safe, linked and built", { skip: !present }, () => {
    const inspection = inspectGateWorktree({ gateRoot, runWorktree: path.resolve(process.cwd()) });
    assert.equal(inspection.ok, true, inspection.problems.join("; "));
    assert.equal(inspection.guard_safe, true);
    assert.equal(inspection.is_worktree, true);
  });

  it("retains a green provisioning report for this run", { skip: !present }, () => {
    const candidates = defaultProvisionReportCandidates({ gateRoot });
    if (candidates.length === 0) {
      process.stderr.write(`no retained gate-provision report under ${gateRoot}; skipping retained-report assertions\n`);
      return;
    }
    const report = JSON.parse(fs.readFileSync(candidates[0], "utf8"));
    const validation = validateGateWorktreeProvisionReport(report);
    assert.equal(validation.ok, true, validation.problems.join("; "));
    assert.equal(report.gate_root, gateRoot);
    assert.equal(report.guard_safe, true);
    assert.equal(report.node_modules.symlink, true);
  });
});
