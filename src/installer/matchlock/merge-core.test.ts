/**
 * US-005 mechanical parity: native runPlumbingMerge vs the shared
 * dependency-free runMergeCore.
 *
 * Every scenario is run twice over two IDENTICAL deterministic fixtures (fixed
 * author/committer dates) — once through the native delegate and once through
 * the pure core — with an injected fixed clock. The full result, the emitted
 * merge.* events and the post-landing repository state must match after
 * normalizing the fixture paths. Scripted-runner cases additionally pin the
 * exact guarded plumbing call sequence and reflog messages.
 *
 * Serial lane: spawns git subprocesses (node:child_process import).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  runPlumbingMerge,
  type MergeBranchEvent,
  type PlumbingMergeResult,
} from "../../../dist/installer/merge-branch.js";
import { runMergeCore } from "../../../dist/installer/matchlock/merge-core.js";
import type {
  MergeCoreEvent,
  MergeCoreGitResult,
  MergeCoreParams,
} from "../../../dist/installer/matchlock/merge-core.js";

// Test isolation: runPlumbingMerge consults the DB for commit identity and
// signing config, so pin HOME/state/DB to a private temp dir before any
// scenario runs — the live operator state must never be opened (the lane
// runner fails on any [state-path] guard-ledger entry).
const ISOLATED_STATE = tamanduaTempDir("tamandua-merge-core-state-");
const ISOLATED_HOME = path.join(ISOLATED_STATE, "home");
fs.mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.HOME = ISOLATED_HOME;
process.env.TAMANDUA_STATE_DIR = ISOLATED_STATE;
process.env.TAMANDUA_DB_PATH = path.join(ISOLATED_STATE, "tamandua.db");

// Fixed git identity/dates make two independently built fixtures commit-hash
// identical, so the core and the native path observe the same object graph.
const FIXED_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Tamandua Test",
  GIT_AUTHOR_EMAIL: "test@tamandua.local",
  GIT_COMMITTER_NAME: "Tamandua Test",
  GIT_COMMITTER_EMAIL: "test@tamandua.local",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  GIT_CONFIG_NOSYSTEM: "1",
};

const FIXED_NOW = (): Date => new Date("2026-01-02T03:04:05.000Z");

/**
 * Explicit child env for git subprocesses. Built key-by-key (never a spread of
 * the ambient environment) so the test-isolation guard stays clean and the
 * fixture is deterministic regardless of the surrounding process.
 */
function childGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...FIXED_ENV,
  };
}

const cleanup: string[] = [];

interface GitResult extends MergeCoreGitResult {}
type Runner = (cwd: string, args: string[]) => GitResult;

function rawGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: childGitEnv(),
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function git(cwd: string, args: string[]): string {
  const result = rawGit(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const deterministicRunner: Runner = (cwd, args) => rawGit(cwd, args);

interface Fixture {
  repo: string;
  initial: string;
  paths: string[];
  bare?: string;
}

function createFixture(): Fixture {
  const repo = tamanduaTempDir("tamandua-merge-core-parity-");
  cleanup.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@tamandua.local"]);
  git(repo, ["config", "user.name", "Tamandua Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { repo, initial: git(repo, ["rev-parse", "HEAD"]), paths: [repo] };
}

function createFeature(fixture: Fixture, branch = "feature"): string {
  git(fixture.repo, ["switch", "-c", branch]);
  fs.writeFileSync(path.join(fixture.repo, "feature.txt"), "feature\n", "utf-8");
  git(fixture.repo, ["add", "feature.txt"]);
  git(fixture.repo, ["commit", "-m", `feat ${branch}`]);
  const tip = git(fixture.repo, ["rev-parse", "HEAD"]);
  git(fixture.repo, ["switch", "main"]);
  return tip;
}

/** Deeply replace every fixture path with a stable placeholder. */
function canonicalize(value: unknown, paths: string[]): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const p of [...paths].sort((a, b) => b.length - a.length)) out = out.split(p).join("<path>");
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, paths));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, canonicalize(entry, paths)]),
    );
  }
  return value;
}

/**
 * Native-vs-core parity is asserted over the fields the SHARED PURE CORE owns.
 *
 * Main's native `runPlumbingMerge` is now a deliberate SUPERSET of runMergeCore:
 * it additionally resolves the run's commit identity (GIDN US-004), honors the
 * configured commit signing / Matchlock guest exemption (MSIG US-005/006),
 * re-reads the live target tip for the report (NPF-1) and reports the richer
 * `no-checkout-to-refresh` / `checkout-not-at-tip` vocabulary. The pure core
 * must stay Node-core only, so the mechanical parity is asserted field-by-field
 * on the landing decisions both implementations share. The test's real intent is
 * unchanged: the SAME fixture must yield the SAME landing tree, the SAME
 * merge.* events and the SAME post-landing repository state.
 */
const SHARED_RESULT_FIELDS = [
  "status",
  "exitCode",
  "mergedCommit",
  "mergedTree",
  "target",
  "noop",
  "parkedBranch",
  "parkedReason",
  "conflicts",
  "expectedTip",
  "actualTip",
  "detail",
] as const;

const SHARED_EVENT_FIELDS = [
  "ts",
  "runId",
  "event",
  "origin",
  "branch",
  "target",
  "expectedTip",
  "actualTip",
  "mergedTree",
  "mergedCommit",
  "noop",
  "parkedBranch",
  "parkedReason",
] as const;

function projectRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}

function projectResult(value: unknown): Record<string, unknown> {
  return projectRecord(value, SHARED_RESULT_FIELDS);
}

function projectEvent(value: unknown): Record<string, unknown> {
  return projectRecord(value, SHARED_EVENT_FIELDS);
}

// Union4 reconciliation of MTLK-WORKFLOWS vs MAIN-NPF1: main's NPF-1 /
// REROUTE-BUDGET retired the unverified checkout label, so the pure core and
// this parity test now use main's five-variant vocabulary (`refreshed` /
// `already-coherent` / `no-checkout-to-refresh` / `checkout-not-at-tip` /
// `parked:*`), and the comparison is exact.
function normalizeCheckoutRefresh(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function captureRepoState(repo: string): Record<string, string> {
  const state: Record<string, string> = {};
  const probe = (name: string, args: string[]): void => {
    const result = rawGit(repo, args);
    state[name] = result.status === 0 ? result.stdout : `ERR:${result.status}`;
  };
  probe("head", ["symbolic-ref", "HEAD"]);
  probe("status", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]);
  probe("refs", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
  return state;
}

function captureFixtureState(fixture: Fixture): Record<string, unknown> {
  const state: Record<string, unknown> = { repo: captureRepoState(fixture.repo) };
  if (fixture.bare) state.bare = captureRepoState(fixture.bare);
  return state;
}

interface ParityCase {
  prepare: (fixture: Fixture) => void;
  params: (fixture: Fixture) => MergeCoreParams;
  wrapRunner?: (fixture: Fixture, base: Runner) => Runner;
  verify?: (fixture: Fixture, result: PlumbingMergeResult, events: MergeBranchEvent[]) => void;
}

/** Run one scenario through native + core over two identical fixtures. */
function assertParity(spec: ParityCase): void {
  const native = createFixture();
  spec.prepare(native);
  const nativeParams = spec.params(native);

  const core = createFixture();
  spec.prepare(core);
  const coreParams = spec.params(core);

  assert.equal(native.initial, core.initial, "deterministic fixtures must share the initial tip");
  assert.equal(nativeParams.expectTip, coreParams.expectTip, "scenario expect-tip must be fixture-stable");

  const nativeEvents: MergeBranchEvent[] = [];
  const coreEvents: MergeCoreEvent[] = [];

  const nativeBase = deterministicRunner;
  const coreBase = deterministicRunner;
  const nativeRunner = spec.wrapRunner ? spec.wrapRunner(native, nativeBase) : nativeBase;
  const coreRunner = spec.wrapRunner ? spec.wrapRunner(core, coreBase) : coreBase;

  const nativeResult = runPlumbingMerge(nativeParams, {
    runGit: nativeRunner,
    emitEvent: (event) => nativeEvents.push(event),
    now: FIXED_NOW,
  });
  const coreResult = runMergeCore(coreParams, {
    runGit: coreRunner,
    emitEvent: (event) => coreEvents.push(event),
    now: FIXED_NOW,
  });

  assert.deepEqual(
    canonicalize(projectResult(coreResult), core.paths),
    canonicalize(projectResult(nativeResult), native.paths),
    "pure-core result must equal the native result on the shared core fields",
  );
  assert.deepEqual(
    canonicalize(coreEvents.map(projectEvent), core.paths),
    canonicalize(nativeEvents.map(projectEvent), native.paths),
    "pure-core merge events must equal the native merge events on the shared fields",
  );
  assert.equal(
    normalizeCheckoutRefresh((coreResult as { checkoutRefresh?: unknown }).checkoutRefresh),
    normalizeCheckoutRefresh((nativeResult as { checkoutRefresh?: unknown }).checkoutRefresh),
    "checkoutRefresh must agree after mapping main's richer vocabulary onto the core's",
  );
  assert.deepEqual(
    canonicalize(captureFixtureState(core), core.paths),
    canonicalize(captureFixtureState(native), native.paths),
    "post-landing repository state must match",
  );
  if (spec.verify) spec.verify(native, nativeResult, nativeEvents);
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runMergeCore mechanical parity (US-005)", () => {
  it("requires an injected git runner and never reads ambient state", () => {
    assert.throws(
      () => runMergeCore({ origin: "/x", branch: "b", into: "main", expectTip: "0".repeat(40), message: "m" }),
      /injected runGit/,
    );
  });

  it("lands a clean owner landing identically (refreshed checkout)", () => {
    assertParity({
      prepare: (fixture) => createFeature(fixture),
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "main",
        expectTip: fixture.initial,
        message: "parity clean owner",
        runId: "run-parity",
      }),
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "landed");
        if (result.status !== "landed") return;
        assert.equal(result.noop, false);
        assert.equal(result.checkoutRefresh, "refreshed");
        assert.equal(events[0]?.event, "merge.landed");
        assert.equal(events[0]?.checkoutRefresh, "refreshed");
      },
    });
  });

  it("parks a dirty owner with identical parked metadata", () => {
    assertParity({
      prepare: (fixture) => {
        createFeature(fixture);
        fs.writeFileSync(path.join(fixture.repo, "base.txt"), "dirty owner\n", "utf-8");
      },
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "main",
        expectTip: fixture.initial,
        message: "parity dirty owner",
        runId: "run-parity",
      }),
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "landed");
        if (result.status !== "landed") return;
        assert.match(result.checkoutRefresh, /^parked:/);
        assert.equal(result.parkedReason, "local-changes");
        assert.equal(events[0]?.parkedReason, "local-changes");
      },
    });
  });

  it("returns an already-coherent ancestor no-op", () => {
    assertParity({
      prepare: (fixture) => {
        createFeature(fixture);
        git(fixture.repo, ["merge", "--ff-only", "feature"]);
      },
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "main",
        expectTip: git(fixture.repo, ["rev-parse", "refs/heads/main"]),
        message: "parity ancestor noop",
        runId: "run-parity",
      }),
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "landed");
        if (result.status !== "landed") return;
        assert.equal(result.noop, true);
        assert.equal(result.checkoutRefresh, "already-coherent");
        assert.equal(events[0]?.noop, true);
      },
    });
  });

  it("returns an equal-tree no-op identical to the native path", () => {
    assertParity({
      prepare: (fixture) => {
        createFeature(fixture);
        const featureTree = git(fixture.repo, ["rev-parse", "feature^{tree}"]);
        const equivalent = git(fixture.repo, ["commit-tree", featureTree, "-p", fixture.initial, "-m", "equivalent target"]);
        git(fixture.repo, ["reset", "--hard", equivalent]);
      },
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "main",
        expectTip: git(fixture.repo, ["rev-parse", "refs/heads/main"]),
        message: "parity equal-tree noop",
        runId: "run-parity",
      }),
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "landed");
        if (result.status !== "landed") return;
        assert.equal(result.noop, true);
        assert.equal(events[0]?.noop, true);
      },
    });
  });

  it("reports conflicts with identical diagnostics and exit code", () => {
    assertParity({
      prepare: (fixture) => {
        git(fixture.repo, ["switch", "-c", "feature"]);
        fs.writeFileSync(path.join(fixture.repo, "base.txt"), "feature version\n", "utf-8");
        git(fixture.repo, ["commit", "-am", "feature conflict"]);
        git(fixture.repo, ["switch", "main"]);
        fs.writeFileSync(path.join(fixture.repo, "base.txt"), "main version\n", "utf-8");
        git(fixture.repo, ["commit", "-am", "main conflict"]);
      },
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "main",
        expectTip: git(fixture.repo, ["rev-parse", "refs/heads/main"]),
        message: "parity conflict",
        runId: "run-parity",
      }),
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "conflicts");
        assert.equal(result.exitCode, 3);
        assert.equal(events[0]?.event, "merge.conflicts");
      },
    });
  });

  it("fails closed identically on duplicate target owners", () => {
    assertParity({
      prepare: (fixture) => createFeature(fixture),
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "main",
        expectTip: fixture.initial,
        message: "parity duplicate owner",
        runId: "run-parity",
      }),
      wrapRunner: (_fixture, base) => (cwd, args) => {
        const actual = base(cwd, args);
        if (args[0] === "worktree" && args[1] === "list") {
          return { ...actual, stdout: `${actual.stdout}\0${actual.stdout}` };
        }
        return actual;
      },
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "operational_error");
        assert.equal(result.exitCode, 1);
        if (result.status !== "operational_error") return;
        assert.match(result.detail, /multiple worktrees/);
        assert.deepEqual(events, []);
      },
    });
  });

  it("reports preflight target movement identically", () => {
    assertParity({
      prepare: (fixture) => createFeature(fixture),
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "main",
        expectTip: "0".repeat(40),
        message: "parity preflight",
        runId: "run-parity",
      }),
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "target_moved");
        assert.equal(result.exitCode, 2);
        assert.equal(events[0]?.event, "merge.target_moved");
      },
    });
  });

  it("lands into a bare origin identically (no-checkout-to-refresh)", () => {
    assertParity({
      prepare: (fixture) => {
        createFeature(fixture);
        const bare = tamanduaTempDir("tamandua-merge-core-parity-bare-");
        cleanup.push(bare);
        fixture.paths.push(bare);
        fixture.bare = bare;
        git(bare, ["clone", "--bare", fixture.repo, "."]);
      },
      params: (fixture) => ({
        origin: fixture.bare!,
        branch: "feature",
        into: "main",
        expectTip: fixture.initial,
        message: "parity bare",
        runId: "run-parity",
      }),
      verify: (_fixture, result, events) => {
        assert.equal(result.status, "landed");
        if (result.status !== "landed") return;
        // The bare origin has no owner checkout, so both the native path and
        // the core report main's "no-checkout-to-refresh" outcome.
        assert.equal(normalizeCheckoutRefresh(result.checkoutRefresh), "no-checkout-to-refresh");
        assert.equal(normalizeCheckoutRefresh(events[0]?.checkoutRefresh), "no-checkout-to-refresh");
      },
    });
  });

  it("reports a compare-and-swap race without overwriting the winner", () => {
    assertParity({
      prepare: (fixture) => {
        createFeature(fixture);
        git(fixture.repo, ["branch", "release", fixture.initial]);
      },
      params: (fixture) => ({
        origin: fixture.repo,
        branch: "feature",
        into: "release",
        expectTip: fixture.initial,
        message: "parity cas race",
        runId: "run-parity",
      }),
      wrapRunner: (fixture, base) => {
        let competing = "";
        return (cwd, args) => {
          if (args[0] === "update-ref" && competing === "") {
            const tree = git(fixture.repo, ["rev-parse", `${fixture.initial}^{tree}`]);
            competing = git(fixture.repo, ["commit-tree", tree, "-p", fixture.initial, "-m", "competing land"]);
            git(fixture.repo, ["update-ref", "refs/heads/release", competing, fixture.initial]);
          }
          return base(cwd, args);
        };
      },
      verify: (fixture, result, events) => {
        assert.equal(result.status, "target_moved");
        assert.equal(result.exitCode, 2);
        if (result.status !== "target_moved") return;
        assert.ok(result.mergedTree);
        assert.ok(result.mergedCommit);
        assert.equal(events[0]?.actualTip, git(fixture.repo, ["rev-parse", "refs/heads/release"]));
      },
    });
  });

  it("keeps an unowned-origin landing command sequence identical to native", () => {
    const expected = "1".repeat(40);
    const branchSha = "4".repeat(40);
    const targetTree = "5".repeat(40);
    const mergedTree = "2".repeat(40);
    const mergedCommit = "3".repeat(40);
    const scripted = (): GitResult[] => [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "worktree /origin\0bare\0\0", stderr: "" },
      { status: 0, stdout: branchSha, stderr: "" },
      { status: 0, stdout: targetTree, stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: mergedTree, stderr: "" },
      { status: 0, stdout: mergedCommit, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      // NPF-1: main's native path re-reads the live target tip after the
      // update-ref; the pure core stops at the update-ref.
      { status: 0, stdout: mergedCommit, stderr: "" },
    ];
    const params: MergeCoreParams = {
      origin: "/origin",
      branch: "feature",
      into: "release",
      expectTip: expected,
      message: "plumbing only",
      runId: "",
    };

    const nativeCommands: string[][] = [];
    const nativeResponses = scripted();
    const nativeEvents: MergeBranchEvent[] = [];
    const nativeResult = runPlumbingMerge(params, {
      runGit: (_origin, args) => {
        nativeCommands.push([...args]);
        return nativeResponses.shift()!;
      },
      emitEvent: (event) => nativeEvents.push(event),
      now: FIXED_NOW,
    });

    const coreCommands: string[][] = [];
    const coreResponses = scripted();
    const coreEvents: MergeCoreEvent[] = [];
    const coreResult = runMergeCore(params, {
      runGit: (_origin, args) => {
        coreCommands.push([...args]);
        return coreResponses.shift()!;
      },
      emitEvent: (event) => coreEvents.push(event),
      now: FIXED_NOW,
    });

    // Main's native path additionally re-reads the live target tip (NPF-1), so
    // the shared plumbing sequence is a prefix of the native command list.
    assert.deepEqual(nativeCommands.slice(0, coreCommands.length), coreCommands);
    assert.deepEqual(nativeCommands.slice(coreCommands.length), [
      ["rev-parse", "--verify", "refs/heads/release"],
    ]);
    assert.deepEqual(projectResult(coreResult), projectResult(nativeResult));
    assert.deepEqual(coreEvents.map(projectEvent), nativeEvents.map(projectEvent));
    assert.deepEqual(coreCommands, [
      ["rev-parse", "--verify", "refs/heads/release"],
      ["worktree", "list", "--porcelain", "-z"],
      ["rev-parse", "--verify", "refs/heads/feature^{commit}"],
      ["rev-parse", "--verify", "refs/heads/release^{tree}"],
      ["merge-base", "--is-ancestor", branchSha, expected],
      ["merge-tree", "--write-tree", expected, "refs/heads/feature"],
      ["commit-tree", mergedTree, "-p", expected, "-m", "plumbing only"],
      ["update-ref", "-m", `tamandua: merge.landed (manual) tree=${mergedTree}`, "refs/heads/release", mergedCommit, expected],
    ]);
  });

  it("parks a clean owner when read-tree refuses, identically to native", () => {
    const expected = "1".repeat(40);
    const branchSha = "4".repeat(40);
    const targetTree = "5".repeat(40);
    const mergedTree = "2".repeat(40);
    const mergedCommit = "3".repeat(40);
    const sentinelBase = tamanduaTempDir("tamandua-merge-core-parity-sentinel-");
    cleanup.push(sentinelBase);
    const owner = path.join(sentinelBase, "owner");
    const sentinels = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];

    const scripted = (): GitResult[] => [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: `worktree ${owner}\0HEAD ${expected}\0branch refs/heads/main\0\0`, stderr: "" },
      { status: 0, stdout: branchSha, stderr: "" },
      { status: 0, stdout: targetTree, stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: mergedTree, stderr: "" },
      { status: 0, stdout: mergedCommit, stderr: "" },
      ...sentinels.map((name) => ({ status: 0, stdout: path.join(sentinelBase, name), stderr: "" })),
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "error: Entry 'base.txt' would be overwritten by merge" },
      // NPF-1: main's native path re-reads the live target tip after the
      // read-tree refusal report; the pure core stops at the refusal.
      { status: 0, stdout: mergedCommit, stderr: "" },
    ];
    const params: MergeCoreParams = {
      origin: "/origin",
      branch: "feature",
      into: "main",
      expectTip: expected,
      message: "read-tree refusal",
      runId: "run-parity",
    };

    const nativeResponses = scripted();
    const nativeCommands: string[][] = [];
    const nativeEvents: MergeBranchEvent[] = [];
    const nativeResult = runPlumbingMerge(params, {
      runGit: (_origin, args) => {
        nativeCommands.push([...args]);
        return nativeResponses.shift()!;
      },
      emitEvent: (event) => nativeEvents.push(event),
      now: FIXED_NOW,
    });

    const coreResponses = scripted();
    const coreCommands: string[][] = [];
    const coreEvents: MergeCoreEvent[] = [];
    const coreResult = runMergeCore(params, {
      runGit: (_origin, args) => {
        coreCommands.push([...args]);
        return coreResponses.shift()!;
      },
      emitEvent: (event) => coreEvents.push(event),
      now: FIXED_NOW,
    });

    // Main's native path additionally re-reads the live target tip (NPF-1)
    // after the read-tree refusal; the shared plumbing is a prefix.
    assert.deepEqual(nativeCommands.slice(0, coreCommands.length), coreCommands);
    assert.deepEqual(nativeCommands.slice(coreCommands.length), [
      ["rev-parse", "--verify", "refs/heads/main"],
    ]);
    assert.deepEqual(projectResult(coreResult), projectResult(nativeResult));
    assert.equal(
      normalizeCheckoutRefresh((coreResult as { checkoutRefresh?: unknown }).checkoutRefresh),
      normalizeCheckoutRefresh((nativeResult as { checkoutRefresh?: unknown }).checkoutRefresh),
    );
    assert.deepEqual(coreEvents.map(projectEvent), nativeEvents.map(projectEvent));
    assert.equal(nativeResult.status, "landed");
    if (nativeResult.status !== "landed") return;
    assert.equal(nativeResult.checkoutRefresh, "parked:main-tamandua-parked-20260102T030405Z-run-pari");
    assert.match(nativeResult.parkedReason ?? "", /^advance-refused: offending paths: base\.txt;/);
    // The read-tree refusal is the last plumbing action before the NPF-1 tip read.
    assert.deepEqual(coreCommands.slice(-1), [["read-tree", "-m", "-u", targetTree, mergedTree]]);
    assert.deepEqual(nativeCommands.slice(-2, -1), [["read-tree", "-m", "-u", targetTree, mergedTree]]);
  });
});
