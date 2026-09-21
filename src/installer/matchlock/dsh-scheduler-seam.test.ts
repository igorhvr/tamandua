/**
 * dsh-scheduler-seam.test.ts — MTLK-DSH-EXEC US-002 unit coverage for the
 * dsh scheduler round seam (scheduler-dsh.ts) + dsh store attribution wiring.
 *
 * Pure/deterministic (no real VMs, no daemons, no processes spawned): the
 * production dsh invocation runner is exercised by the synthetic whole-path
 * gate (US-003); these tests cover
 *
 *   - the guest pack surface of the dsh probe (packed guest CLI + skill file,
 *     NEVER a host path, stable harness-probe marker);
 *   - the injectable round-runner seam forwarding probe/work rounds and
 *     per-invocation fresh-VM + positive-closure bookkeeping (fake runner
 *     records one distinct VM id and one confirmed close per round);
 *   - host suite wiring for dsh work rounds (canonical namespace from the
 *     persisted pin + pack helper-contract; shared store rel);
 *   - the mounted-store attribution wiring (snapshotDshRoundStore /
 *     attributeDshRoundStore): integer single-count totals from a confined
 *     plain v3 store with the data.stream mirror EXCLUDED, honest
 *     incomplete/unavailable outcomes, and refusal of a store root that is
 *     not a directory.
 *
 * Imports mirror scheduler-matchlock.test.ts (module graph has no direct
 * node:child_process dependency) — parallel lane, not spawn-capable.
 */
// ── US-003 v2 -> v3 rename (documented in REWRITTEN_ASSERTIONS) ──────
// MTLK-DSH-EXEC union MAIN-DSV2: the source branch pinned the dsh v2
// session-store layout (session.v2.jsonl[.zstd]) and titled its attribution
// test accordingly; certified main's DSV2 ships the dsh >= 0.1.5 v3 store
// (session.v3.jsonl[.zstd]) whose host reader (src/installer/dsh-usage.ts)
// this in-VM reader now matches. The "v2 store" title below was renamed to
// "v3 store" (see tests/matchlock-integration-test-parity.test.ts).

import { describe, it, beforeEach, afterEach } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuestPack } from "../../../dist/installer/matchlock/guest-pack-builder.js";
import {
  buildMatchlockPolicy,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import {
  DSH_MATCHLOCK_GUEST_CLI,
  DSH_MATCHLOCK_GUEST_RUNTIME_ROOT,
  DSH_MATCHLOCK_GUEST_SKILL_FILE,
  MatchlockRunnerError,
  buildDshProbeCommand,
  buildDshProbePrompt,
  buildDshSuiteForRound,
  runDshSchedulerRound,
  setDshSchedulerRoundRunnerForTest,
  snapshotDshRoundStore,
  attributeDshRoundStore,
  MATCHLOCK_HOST_SUITE_STORE_REL,
  type DshSchedulerRound,
  type DshSchedulerRoundResult,
} from "../../../dist/installer/matchlock/scheduler-dsh.js";
import { matchlockSessionProjectDir } from "../../../dist/installer/matchlock/dsh-session-store.js";
import { resolveTamanduaCli } from "../../../dist/installer/paths.js";

const DIST_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dist",
);
const REPO_ROOT = path.resolve(DIST_ROOT, "..");

const PIN = {
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  config_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tag: "vic/dsh:latest",
};

function dshPolicy(over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  return buildMatchlockPolicy({
    requestedImage: "vic/dsh:latest",
    identity: PIN,
    harness: "dsh",
    configurationRoot: "/home/operator/.dsh",
    submissionHomeDir: "/home/operator",
    submissionCwd: "/home/operator/work",
    submissionDshHomeEnv: null,
    submissionDshHomeSource: "default",
    workingDirectory: "/home/operator/work",
    originalRepositoryRoot: null,
    workMounts: [
      { hostPath: "/home/operator/work", hostRealPath: "/home/operator/work", guestPath: "/home/operator/work" },
    ],
    gitMetadataRoots: [],
    ...over,
  });
}

// ── synthetic v3 plain session store helpers (metadata-only evidence) ──

function v3SessionText(opts: {
  id: string;
  createdAt: number;
  cwd?: string;
  uncachedInput?: number;
  output?: number;
  streamMirror?: boolean;
  malformedUsage?: boolean;
}): string {
  const header = {
    type: "session",
    version: 3,
    id: opts.id,
    createdAt: opts.createdAt,
    cwd: opts.cwd ?? "/home/operator/work",
    isSeeded: false,
    delegationDepth: 0,
  };
  const usage =
    opts.malformedUsage === true
      ? { inputTokens: "boom", outputTokens: opts.output ?? 0 }
      : { inputTokens: opts.uncachedInput ?? 100, outputTokens: opts.output ?? 25 };
  const message = {
    type: "assistant/message",
    seq: 1,
    time: opts.createdAt + 1000,
    data: {
      turn: 0,
      step: 0,
      message: { role: "assistant", content: [] },
      usage,
      stream:
        opts.streamMirror === true
          ? [
              {
                chunk: {
                  type: "usage",
                  usage: {
                    inputTokens: opts.uncachedInput ?? 100,
                    outputTokens: opts.output ?? 25,
                    cacheReadTokens: 999,
                    totalTokens: (opts.uncachedInput ?? 100) + (opts.output ?? 25) + 999,
                  },
                },
              },
            ]
          : [],
    },
  };
  return JSON.stringify(header) + "\n" + JSON.stringify(message) + "\n";
}

function writeSessionDir(dshHome: string, workdir: string, dirName: string, text: string): string {
  const projectDir = matchlockSessionProjectDir(dshHome, workdir);
  const sessionDir = path.join(projectDir, dirName);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "session.v3.jsonl"), text, "utf8");
  return sessionDir;
}

describe("dsh scheduler round seam (US-002)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = tamanduaTempDir("tamandua-mtlk-dsh-seam-");
  });

  afterEach(() => {
    setDshSchedulerRoundRunnerForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── probe/guest pack surface ─────────────────────────────────────────

  it("the dsh probe surface is the PACKED guest CLI + guest skill file, never a host path", () => {
    assert.equal(DSH_MATCHLOCK_GUEST_CLI, "/workspace/runtime/bin/tamandua");
    assert.equal(DSH_MATCHLOCK_GUEST_SKILL_FILE, "/workspace/runtime/skills/tamandua-agents/SKILL.md");
    assert.equal(DSH_MATCHLOCK_GUEST_RUNTIME_ROOT, "/workspace/runtime");
    assert.equal(buildDshProbeCommand(), "/workspace/runtime/bin/tamandua skill-path");
    const prompt = buildDshProbePrompt();
    assert.ok(prompt.startsWith("TAMANDUA_HARNESS_PROBE: skill-path\n"), "stable harness-probe marker line");
    assert.ok(prompt.includes('"/workspace/runtime/bin/tamandua skill-path"'));
    assert.ok(!prompt.includes(resolveTamanduaCli()), "guest probe prompt must never embed the host CLI");
    assert.ok(!prompt.includes("pi"), "no pi --mode json semantics in the dsh probe prompt");
  });

  it("the injectable seam forwards probe/work rounds and returns their results unchanged", async () => {
    const journal: Array<{ kind: string; runId: string; workdir: string }> = [];
    setDshSchedulerRoundRunnerForTest(async (round) => {
      journal.push({ kind: round.kind, runId: round.identity.runId, workdir: round.workingDirectoryForHarness });
      return {
        output: round.kind === "probe" ? DSH_MATCHLOCK_GUEST_SKILL_FILE : "STATUS: done\n",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 7,
      };
    });
    const base: Omit<DshSchedulerRound, "kind" | "promptText"> = {
      policy: dshPolicy(),
      identity: {
        runId: "run-11111111-1111-4111-8111-111111111111",
        agentId: "do-now_doer",
        workflowId: "do-now",
        jobId: "job-1",
      },
      workingDirectoryForHarness: "/home/operator/work",
      timeoutMs: 60_000,
    };
    const probeResult = await runDshSchedulerRound({ ...base, kind: "probe", promptText: buildDshProbePrompt() });
    assert.equal(probeResult.exitCode, 0);
    assert.equal(probeResult.output, DSH_MATCHLOCK_GUEST_SKILL_FILE);
    const workResult = await runDshSchedulerRound({
      ...base,
      kind: "work",
      promptText: "work prompt",
    });
    assert.ok(workResult.output.includes("STATUS: done"));
    assert.deepEqual(journal.map((j) => j.kind), ["probe", "work"]);
  });

  it("per-round fresh-VM + positive-closure bookkeeping flows through the round-runner contract (each round: distinct VM, confirmed close)", async () => {
    // The FAKE stands in for the dsh invocation runner (real VM path is the
    // US-003 gate). It records the contract the scheduler consumes: one fresh
    // VM id per invocation and a positive confirmed closure per invocation.
    const records: Array<{ vmId: string; cleanupConfirmed: boolean }> = [];
    let next = 1;
    setDshSchedulerRoundRunnerForTest(async (round) => {
      const vmId = `vm-dsh-${next++}`;
      records.push({ vmId, cleanupConfirmed: true });
      return {
        output: "ok",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
        vmId,
        cleanupConfirmed: true,
        kind: round.kind,
        runId: round.identity.runId,
      } as DshSchedulerRoundResult;
    });
    const base: Omit<DshSchedulerRound, "kind" | "promptText"> = {
      policy: dshPolicy(),
      identity: {
        runId: "run-22222222-2222-4222-8222-222222222222",
        agentId: "do-now_doer",
        workflowId: "do-now",
        jobId: "job-2",
      },
      workingDirectoryForHarness: "/home/operator/work",
      timeoutMs: 60_000,
    };
    await runDshSchedulerRound({ ...base, kind: "probe", promptText: buildDshProbePrompt() });
    await runDshSchedulerRound({ ...base, kind: "work", promptText: "w" });
    assert.equal(records.length, 2, "one runner invocation per round (probe and work never share a VM)");
    assert.notEqual(records[0].vmId, records[1].vmId, "each round gets a FRESH VM id");
    assert.ok(records.every((r) => r.cleanupConfirmed === true), "each invocation reports a positive confirmed closure");
  });

  it("a host-canceled round (cancellation/EOF/protocol failure) surfaces canceled through the seam result", async () => {
    setDshSchedulerRoundRunnerForTest(async () => ({
      output: "",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      canceled: true,
      durationMs: 4,
      vmId: null,
      cleanupConfirmed: true,
      kind: "work",
      runId: "run-33333333-3333-4333-8333-333333333333",
    }));
    const result = await runDshSchedulerRound({
      policy: dshPolicy(),
      identity: {
        runId: "run-33333333-3333-4333-8333-333333333333",
        agentId: "do-now_doer",
        workflowId: "do-now",
        jobId: "job-3",
      },
      kind: "work",
      promptText: "w",
      workingDirectoryForHarness: "/home/operator/work",
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.canceled, true);
  });

  // ── MTLK-ALL-WORKFLOWS US-002: scoped host merge seam ────────────────

  it("US-002: production runner refuses a merge-capability WORK round with no host merge context BEFORE any VM (matchlock_workflow_unsupported)", async () => {
    // No runner fake installed -> the PRODUCTION runner (runProductionDshRound)
    // executes. The preflight throws before any guest-pack build / VM create,
    // so this stays a pure unit test.
    const err = await runDshSchedulerRound({
      policy: dshPolicy(),
      identity: {
        runId: "run-44444444-4444-4444-8444-444444444444",
        agentId: "feature-dev-merge-worktree_developer",
        workflowId: "feature-dev-merge-worktree",
        jobId: "job-merge-absent",
      },
      kind: "work",
      promptText: "develop the story",
      workingDirectoryForHarness: "/home/operator/work",
      timeoutMs: 60_000,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError, `expected MatchlockRunnerError, got ${String(err)}`);
    assert.equal(err.code, "matchlock_workflow_unsupported");
    assert.match(err.message, /requires the merge-branch capability/);
    assert.match(err.message, /refusing before any VM create/);
    assert.match(err.message, /feature-dev-merge-worktree/);
  });

  it("US-002: production runner refuses a dsh round outside the persisted exact working directory BEFORE any VM (matchlock_worktree_scope_mismatch)", async () => {
    const err = await runDshSchedulerRound({
      policy: dshPolicy(),
      identity: {
        runId: "run-55555555-5555-4555-8555-555555555555",
        agentId: "do-now_doer",
        workflowId: "do-now",
        jobId: "job-scope",
      },
      kind: "work",
      promptText: "w",
      // The policy's persisted working directory is /home/operator/work.
      workingDirectoryForHarness: "/home/operator/elsewhere",
      timeoutMs: 60_000,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError, `expected MatchlockRunnerError, got ${String(err)}`);
    assert.equal(err.code, "matchlock_worktree_scope_mismatch");
    assert.match(err.message, /does not match the persisted Matchlock policy working directory/);
  });

  it("US-002: the dsh production runner converts round.merge with createMergeServiceForContext and forwards it into runDshInvocation (source contract)", () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const src = fs.readFileSync(
      path.join(repoRoot, "src", "installer", "matchlock", "scheduler-dsh.ts"),
      "utf-8",
    );
    const start = src.indexOf("async function runProductionDshRound");
    assert.ok(start >= 0, "runProductionDshRound must exist in scheduler-dsh.ts");
    const body = src.slice(start);
    assert.match(
      body,
      /\.\.\.\(round\.merge \? \{ merge: createMergeServiceForContext\(round\.merge\) \} : \{\}\)/,
      "runProductionDshRound must convert round.merge with createMergeServiceForContext and forward it to runDshInvocation",
    );
    // The two pre-VM refusals mirror runProductionMatchlockRound.
    assert.match(
      body,
      /matchlockRoundScopeRefusal\(round\.policy, round\.workingDirectoryForHarness\)/,
      "the exact-path scope invariant must run in the dsh production runner",
    );
    assert.match(
      body,
      /matchlockWorkflowRequiresCapability\(round\.identity\.workflowId, "merge-branch"\)/,
      "the merge-capability preflight must run in the dsh production runner",
    );
  });

  // ── host suite wiring (dsh work rounds suite-capable by default) ─────

  it("builds the deterministic host-owned suite wiring for a dsh work round (shared store rel + canonical namespace)", async () => {
    const packRoot = path.join(tmp, "pack");
    const built = buildGuestPack({
      targetDir: packRoot,
      distRoot: DIST_ROOT,
      assetDir: path.join(REPO_ROOT, "src", "installer", "matchlock", "guest-assets"),
    });
    assert.ok(built.manifest.helperProtocolVersion.length > 0);
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    const p = dshPolicy();
    const suite = await buildDshSuiteForRound(p, { stateRoot, helperPackHostPath: packRoot });
    assert.equal(suite.storePath, path.join(stateRoot, MATCHLOCK_HOST_SUITE_STORE_REL));
    assert.equal(suite.namespace.imageContentId, p.resolvedImageDigest);
    assert.match(suite.namespace.compatibilityFingerprint, /^[0-9a-f]{32}$/);
    assert.deepEqual(suite.admittedRoots, ["/home/operator/work"]);
  });

  // ── mounted-store attribution wiring (US-001 confined bounded read) ──

  it("attributes an integer single-count total from a confined plain v3 store (data.stream mirror EXCLUDED)", () => {
    const home = path.join(tmp, "dsh-home");
    const workdir = path.join(tmp, "work");
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.mkdirSync(workdir, { recursive: true });
    const p = dshPolicy({ configurationRoot: home });

    const pre = snapshotDshRoundStore(p, workdir);
    // Round creates one root session: one assistant/message usage of
    // input 100 + output 25 (mirror present; must NOT be double counted).
    writeSessionDir(home, workdir, "session-round-1", v3SessionText({ id: "sess-root-1", createdAt: 1_700_000_000_000, uncachedInput: 100, output: 25, streamMirror: true }));
    const post = snapshotDshRoundStore(p, workdir);
    const attribution = attributeDshRoundStore(p, workdir, pre, post);
    assert.equal(attribution.status, "attributed", attribution.reason);
    assert.equal(attribution.tokenTotal, 125, "input(100)+output(25) counted ONCE; the stream mirror is never summed");
    assert.equal(attribution.rootSessionId, "session-round-1");
    assert.equal(attribution.incomplete, false);
  });

  it("honest outcomes: no created session -> unavailable; malformed usage -> incomplete (never a fabricated zero)", () => {
    const home = path.join(tmp, "dsh-home2");
    const workdir = path.join(tmp, "work2");
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.mkdirSync(workdir, { recursive: true });
    const p = dshPolicy({ configurationRoot: home });

    const pre = snapshotDshRoundStore(p, workdir);
    const empty = attributeDshRoundStore(p, workdir, pre, snapshotDshRoundStore(p, workdir));
    assert.equal(empty.status, "unavailable");
    assert.equal(empty.tokenTotal, null);

    writeSessionDir(home, workdir, "session-bad", v3SessionText({ id: "sess-bad", createdAt: 1_700_000_000_000, malformedUsage: true }));
    const bad = attributeDshRoundStore(p, workdir, pre, snapshotDshRoundStore(p, workdir));
    assert.equal(bad.status, "incomplete", "malformed usage must be honest incomplete, never a trusted partial");
    assert.equal(bad.tokenTotal, null);
  });

  it("store wiring refuses a non-directory / nonexistent store root and stays honest (never fabricates)", () => {
    const workdir = path.join(tmp, "work3");
    fs.mkdirSync(workdir, { recursive: true });
    const p = dshPolicy({ configurationRoot: path.join(tmp, "does-not-exist") });
    const snap = snapshotDshRoundStore(p, workdir);
    assert.equal(snap.sessions.size, 0, "a nonexistent store root yields an empty (honest) inventory");
    const attr = attributeDshRoundStore(p, workdir, snap, snap);
    assert.equal(attr.status, "unavailable");
  });
});
