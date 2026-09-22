/**
 * scheduler-matchlock.test.ts — MTLK-PI-EXEC US-003 unit coverage for the
 * production suite wiring added to the scheduler round-runner seam
 * (buildMatchlockSuiteForRound): the deterministic host-owned suite store
 * under the state root, the attested canonical namespace derived from the
 * persisted image pin + the guest pack's helper-contract identity, and the
 * policy's admitted repository roots. No spawns (buildGuestPack + fs only) —
 * parallel lane, not spawn-capable.
 */

import { describe, it, before, after } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuestPack } from "../../../dist/installer/matchlock/guest-pack-builder.js";
import {
  buildMatchlockSuiteForRound,
  MATCHLOCK_HOST_SUITE_STORE_REL,
  hermesSubmissionFromPolicy,
  matchlockProductionRunnerKind,
  runMatchlockSchedulerRound,
  setMatchlockProductionRouteRunnerForTest,
  setMatchlockHomeAliasResolverForTest,
  MatchlockRunnerError,
  buildMatchlockMergeContext,
  type MatchlockSchedulerRound,
  type MatchlockSchedulerRoundResult,
} from "../../../dist/installer/matchlock/scheduler-matchlock.js";
import {
  setDshSchedulerRoundRunnerForTest,
  type DshSchedulerRound,
} from "../../../dist/installer/matchlock/scheduler-dsh.js";
import {
  buildMatchlockPolicy,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";

const DIST_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dist",
);
const REPO_ROOT = path.resolve(DIST_ROOT, "..");

function policy(over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  const base: ExecutionIsolation = {
    version: 1,
    backend: "matchlock",
    requestedImage: "tamandua-synthetic-pi:gate-fixture",
    harness: "pi",
    configurationRoot: "/opt/config/pi",
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
    workPathMode: "host-absolute",
    workingDirectory: "/srv/repo",
    workMounts: [
      { hostPath: "/srv/repo", hostRealPath: "/srv/repo", guestPath: "/srv/repo" },
    ],
    originalRepositoryRoot: "/srv/repo",
    gitMetadataRoots: ["/srv/repo/.git"],
    mountPolicyVersion: 1,
    networkPolicyVersion: 1,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
    requestedImageDigest: undefined,
    resolvedImageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    resolvedImageConfigDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  };
  return { ...base, ...over };
}

/** A persisted harness:"hermes" policy with the FROZEN submission inputs. */
function hermesPolicy(): ExecutionIsolation {
  return buildMatchlockPolicy({
    requestedImage: "vic/hermes:latest",
    identity: {
      digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      config_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      tag: "vic/hermes:latest",
    },
    harness: "hermes",
    workingDirectory: "/srv/repo",
    originalRepositoryRoot: "/srv/repo",
    workMounts: [
      { hostPath: "/srv/repo", hostRealPath: "/srv/repo", guestPath: "/srv/repo" },
    ],
    gitMetadataRoots: [],
    configurationRoot: "/home/operator/.hermes",
    configurationProfile: "default",
    guestConfigurationRoot: "/workspace/config/hermes",
    hermes: { homeDir: "/home/operator", cwd: "/srv/repo", hermesHomeEnv: null },
  });
}

/**
 * MTLK-DSH-EXEC union: a persisted harness:"dsh" policy with the FROZEN
 * submission context (resolved effective host DSH_HOME + submission home/cwd).
 */
function dshPolicy(): ExecutionIsolation {
  return buildMatchlockPolicy({
    requestedImage: "vic/dsh:latest",
    identity: {
      digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      config_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      tag: "vic/dsh:latest",
    },
    harness: "dsh",
    configurationRoot: "/home/operator/.dsh",
    submissionHomeDir: "/home/operator",
    submissionCwd: "/srv/repo",
    submissionDshHomeEnv: null,
    submissionDshHomeSource: "default",
    workingDirectory: "/srv/repo",
    originalRepositoryRoot: "/srv/repo",
    workMounts: [
      { hostPath: "/srv/repo", hostRealPath: "/srv/repo", guestPath: "/srv/repo" },
    ],
    gitMetadataRoots: [],
  });
}

/** One minimal scheduler round for the routing tests (no VM is ever created). */
function round(
  p: ExecutionIsolation,
  over: Partial<MatchlockSchedulerRound> = {},
): MatchlockSchedulerRound {
  return {
    policy: p,
    identity: {
      runId: "run-7c7c7c7c",
      agentId: "do-now_doer",
      workflowId: "do-now",
      jobId: "job-route",
    },
    kind: "work",
    promptText: "do work",
    workingDirectoryForHarness: p.workingDirectory,
    timeoutMs: 1000,
    ...over,
  };
}

describe("scheduler-matchlock production suite wiring", () => {
  let tmp: string;
  let packRoot: string;
  let stateRoot: string;

  before(() => {
    // US-003: the production default is the owner-aware keyed resolver, which
    // would claim the host daemon's real alias. These routing/suite tests are
    // not about the alias, so install the deterministic fixed-alias seam (no
    // host HOME, no `/tmp` side effects).
    setMatchlockHomeAliasResolverForTest(() => "/home/alias-fixture/tamandua/4242/h");
    tmp = tamanduaTempDir("tamandua-mtlk-sched-");
    packRoot = path.join(tmp, "pack");
    // Build a REAL versioned RO guest pack from the compiled checkout so the
    // manifest (helperProtocolVersion / tamanduaBuildVersion) is readable.
    const result = buildGuestPack({
      targetDir: packRoot,
      distRoot: DIST_ROOT,
      assetDir: path.join(REPO_ROOT, "src", "installer", "matchlock", "guest-assets"),
    });
    assert.ok(result.manifest.helperProtocolVersion.length > 0);
    stateRoot = path.join(tmp, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
  });

  after(() => {
    setMatchlockHomeAliasResolverForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("builds the deterministic host-owned suite wiring for a work round", async () => {
    const p = policy();
    const suite = await buildMatchlockSuiteForRound(p, { stateRoot, helperPackHostPath: packRoot });
    assert.equal(suite.storePath, path.join(stateRoot, MATCHLOCK_HOST_SUITE_STORE_REL));
    assert.ok(fs.existsSync(path.dirname(suite.storePath)), "store parent dir is created");
    assert.equal(suite.namespace.imageContentId, p.resolvedImageDigest);
    assert.equal(suite.namespace.guestPlatform, "linux/amd64");
    assert.ok(suite.namespace.helperContract.startsWith("guest-helper-"));
    assert.match(suite.namespace.compatibilityFingerprint, /^[0-9a-f]{32}$/);
    assert.deepEqual(suite.admittedRoots, ["/srv/repo"]);
  });

  it("refuses to wire a suite for an unpinned legacy policy", async () => {
    const p = policy({ resolvedImageDigest: undefined, resolvedImageConfigDigest: undefined });
    await assert.rejects(
      () => buildMatchlockSuiteForRound(p, { stateRoot, helperPackHostPath: packRoot }),
      /no immutable image content\/config pin/,
    );
  });

  // ── MTLK-HERMES-EXEC US-003: production hermes routing + frozen inputs ──

  // MTLK-HERMES-EXEC union MTLK-DSH-EXEC: the pi+hermes slice asserted
  // "pi → pi runner, hermes → hermes runner" only (no dsh kind existed). The
  // MTLK-DSH-EXEC contract adds harness "dsh", so the union
  // (MTLK-INTEGRATE US-006) rewrites the losing pi/hermes-only assertion to
  // the three-harness mapping.
  it("maps a persisted policy harness to the production invocation runner (pi → pi runner, hermes → hermes runner, dsh → dsh route)", () => {
    assert.equal(matchlockProductionRunnerKind(policy()), "pi");
    assert.equal(matchlockProductionRunnerKind(hermesPolicy()), "hermes");
    assert.equal(matchlockProductionRunnerKind(dshPolicy()), "dsh");
  });

  // ── US-006: harness-generic runner routing ──────────────────────────────

  it("runMatchlockSchedulerRound dispatches each policy harness to exactly its own runner once (pi, hermes, dsh)", async () => {
    const seen: string[] = [];
    const spy =
      (kind: "pi" | "hermes" | "dsh") =>
      async (r: MatchlockSchedulerRound): Promise<{
        output: string;
        exitCode: number;
        signal: null;
        timedOut: false;
        durationMs: number;
      }> => {
        seen.push(`${kind}->${matchlockProductionRunnerKind(r.policy)}`);
        return { output: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
      };
    setMatchlockProductionRouteRunnerForTest("pi", spy("pi"));
    setMatchlockProductionRouteRunnerForTest("hermes", spy("hermes"));
    setMatchlockProductionRouteRunnerForTest("dsh", spy("dsh"));
    try {
      await runMatchlockSchedulerRound(round(policy()));
      await runMatchlockSchedulerRound(round(hermesPolicy()));
      await runMatchlockSchedulerRound(round(dshPolicy()));
    } finally {
      setMatchlockProductionRouteRunnerForTest("pi", null);
      setMatchlockProductionRouteRunnerForTest("hermes", null);
      setMatchlockProductionRouteRunnerForTest("dsh", null);
    }
    assert.deepEqual(seen, ["pi->pi", "hermes->hermes", "dsh->dsh"]);
  });

  it("a dsh policy reaches the dsh scheduler route through the shared runMatchlockSchedulerRound seam (no hard-coded pi path)", async () => {
    const seen: Array<{ harness: string; kind: string; workdir: string }> = [];
    setDshSchedulerRoundRunnerForTest(async (r) => {
      seen.push({
        harness: r.policy.harness,
        kind: r.kind,
        workdir: r.workingDirectoryForHarness,
      });
      return { output: "ok", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    });
    try {
      const p = dshPolicy();
      await runMatchlockSchedulerRound(round(p));
    } finally {
      setDshSchedulerRoundRunnerForTest(null);
    }
    assert.deepEqual(seen, [
      { harness: "dsh", kind: "work", workdir: "/srv/repo" },
    ]);
  });

  it("a pi policy never reaches the dsh scheduler route (harness-keyed dispatch is exclusive)", async () => {
    let dshCalls = 0;
    let piCalls = 0;
    setDshSchedulerRoundRunnerForTest(async () => {
      dshCalls += 1;
      return { output: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    });
    setMatchlockProductionRouteRunnerForTest("pi", async () => {
      piCalls += 1;
      return { output: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    });
    try {
      await runMatchlockSchedulerRound(round(policy()));
      await runMatchlockSchedulerRound(round(dshPolicy()));
    } finally {
      setDshSchedulerRoundRunnerForTest(null);
      setMatchlockProductionRouteRunnerForTest("pi", null);
    }
    assert.equal(piCalls, 1, "the pi policy reached the pi route");
    assert.equal(dshCalls, 1, "the dsh policy reached the dsh route");
  });

  // ── US-006: the split timing contract survives the scheduler seam ────────
  it("US-006: harnessWallMs/vmSetupMs from the production runners flow through the scheduler seam unchanged (pi, hermes, dsh)", async () => {
    const fakeRound = async (): Promise<MatchlockSchedulerRoundResult> => ({
      output: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 34_012,
      harnessWallMs: 12,
      vmSetupMs: 34_000,
    });
    setMatchlockProductionRouteRunnerForTest("pi", fakeRound);
    setMatchlockProductionRouteRunnerForTest("hermes", fakeRound);
    setMatchlockProductionRouteRunnerForTest("dsh", fakeRound);
    try {
      for (const p of [policy(), hermesPolicy(), dshPolicy()]) {
        const result = await runMatchlockSchedulerRound(round(p));
        assert.equal(result.harnessWallMs, 12, `${p.harness} harnessWallMs must survive the seam`);
        assert.equal(result.vmSetupMs, 34_000, `${p.harness} vmSetupMs must survive the seam`);
        // The classifier reads harnessWallMs, NOT the whole-round wall: a
        // 12ms in-VM round after a 34s boot is still an instant-fail signal.
        assert.notEqual(result.harnessWallMs, result.durationMs);
      }
    } finally {
      setMatchlockProductionRouteRunnerForTest("pi", null);
      setMatchlockProductionRouteRunnerForTest("hermes", null);
      setMatchlockProductionRouteRunnerForTest("dsh", null);
    }
  });

  it("MTLK-ALL-WORKFLOWS US-002: toDshSchedulerRound forwards the host merge context to the dsh route", async () => {
    const p = dshPolicy();
    const context = buildMatchlockMergeContext({
      policy: p,
      runId: "run-88888888-8888-4888-8888-888888888888",
      runContext: { original_branch: "main" },
      finalizeMergeStepId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    assert.ok(context, "an admitted dsh merge workflow must build a host merge context");
    assert.equal(context.originalRepositoryRoot, "/srv/repo");
    assert.equal(context.originalBranch, "main");

    let observed: DshSchedulerRound | undefined;
    setDshSchedulerRoundRunnerForTest(async (r) => {
      observed = r;
      return { output: "ok", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    });
    try {
      await runMatchlockSchedulerRound(
        round(p, {
          identity: {
            runId: "run-88888888-8888-4888-8888-888888888888",
            agentId: "feature-dev-merge-worktree_developer",
            workflowId: "feature-dev-merge-worktree",
            jobId: "job-merge",
          },
          merge: context,
        }),
      );
    } finally {
      setDshSchedulerRoundRunnerForTest(null);
    }
    assert.equal(
      observed?.merge,
      context,
      "the shared round's merge context must survive toDshSchedulerRound onto the dsh route",
    );
  });

  it("hermesSubmissionFromPolicy reconstructs the FROZEN submission inputs from the persisted hermes block (default: HERMES_HOME unset)", () => {
    const submission = hermesSubmissionFromPolicy(hermesPolicy());
    assert.deepEqual(submission, {
      homeDir: "/home/operator",
      cwd: "/srv/repo",
      env: {},
    });
  });

  it("hermesSubmissionFromPolicy preserves the frozen HERMES_HOME snapshot when one was captured", () => {
    const named = buildMatchlockPolicy({
      requestedImage: "vic/hermes:latest",
      identity: {
        digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        config_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        tag: "vic/hermes:latest",
      },
      harness: "hermes",
      workingDirectory: "/srv/repo",
      originalRepositoryRoot: "/srv/repo",
      workMounts: [
        { hostPath: "/srv/repo", hostRealPath: "/srv/repo", guestPath: "/srv/repo" },
      ],
      gitMetadataRoots: [],
      configurationRoot: "/home/operator/.hermes/profiles/team-a",
      configurationProfile: "team-a",
      guestConfigurationRoot: "/workspace/config/hermes/profiles/team-a",
      hermes: {
        homeDir: "/home/operator",
        cwd: "/srv/repo",
        hermesHomeEnv: "/home/operator/.hermes/profiles/team-a",
      },
    });
    assert.deepEqual(hermesSubmissionFromPolicy(named), {
      homeDir: "/home/operator",
      cwd: "/srv/repo",
      env: { HERMES_HOME: "/home/operator/.hermes/profiles/team-a" },
    });
  });

  it("hermesSubmissionFromPolicy refuses a harness-pi policy (no ambient-state fallback)", () => {
    assert.throws(
      () => hermesSubmissionFromPolicy(policy()),
      (err: unknown) =>
        err instanceof MatchlockRunnerError &&
        err.code === "matchlock_policy_invalid" &&
        /FROZEN Hermes submission inputs/.test(err.message),
    );
  });

  it("builds the deterministic host-owned suite wiring for a HERMES work round (shared registry/suite authority, image-pin namespace)", async () => {
    const p = hermesPolicy();
    const suite = await buildMatchlockSuiteForRound(p, { stateRoot, helperPackHostPath: packRoot });
    assert.equal(suite.storePath, path.join(stateRoot, MATCHLOCK_HOST_SUITE_STORE_REL));
    assert.equal(suite.namespace.imageContentId, p.resolvedImageDigest);
    assert.deepEqual(suite.admittedRoots, ["/srv/repo"]);
  });
});
