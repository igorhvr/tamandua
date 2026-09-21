/**
 * scheduler-home-alias-wiring.test.ts — US-002 coverage for item 1a of the
 * MTLK-FIX task (tamandua-6sy.33.10.27): every production Matchlock scheduler
 * round must hand the Matchlock CONTROL child (the `matchlock rpc` process and
 * whatever it forks) a verified SHORT HOME alias, while the daemon, the
 * harness round and the guest create-config env keep the REAL HOME.
 *
 * Deterministic and VM-free: no real VM, no spawn (parallel lane). The alias
 * resolver is injected through the labelled `setMatchlockHomeAliasResolverForTest`
 * seam so the assertions never depend on the host HOME; one test exercises the
 * REAL resolver (escape-hatch pointed at a temp dir) to prove the default path
 * is wired, not only the seam.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMatchlockRoundRpcEnv,
  runMatchlockSchedulerRound,
  setMatchlockHomeAliasResolverForTest,
  setMatchlockProductionRouteRunnerForTest,
  setMatchlockSchedulerRoundRunnerForTest,
  MatchlockRunnerError,
  type MatchlockSchedulerRound,
  type MatchlockSchedulerRoundResult,
} from "../../../dist/installer/matchlock/scheduler-matchlock.js";
import { setDshSchedulerRoundRunnerForTest } from "../../../dist/installer/matchlock/scheduler-dsh.js";
import {
  MATCHLOCK_HOME_ALIAS_ENV,
  MatchlockHomeAliasError,
} from "../../../dist/installer/matchlock/home-alias.js";
import {
  buildMatchlockPolicy,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";

/** A pi policy (no VM is ever created: every round is captured at a seam). */
function piPolicy(): ExecutionIsolation {
  return {
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
}

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

function round(
  p: ExecutionIsolation,
  over: Partial<MatchlockSchedulerRound> = {},
): MatchlockSchedulerRound {
  return {
    policy: p,
    identity: {
      runId: "run-1a2b3c4d",
      agentId: "do-now_doer",
      workflowId: "do-now",
      jobId: "job-home-alias",
    },
    kind: "work",
    promptText: "do work",
    workingDirectoryForHarness: p.workingDirectory,
    timeoutMs: 1000,
    ...over,
  };
}

const okRound = (): MatchlockSchedulerRoundResult => ({
  output: "STATUS: done\n",
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1,
});

const ALIAS = "/tmp/tamandua/4242/h";

describe("Matchlock short-HOME alias wiring (US-002)", () => {
  let ambientHome: string | undefined;

  beforeEach(() => {
    ambientHome = process.env.HOME;
    setMatchlockHomeAliasResolverForTest(() => ALIAS);
  });

  afterEach(() => {
    setMatchlockHomeAliasResolverForTest(null);
    setMatchlockSchedulerRoundRunnerForTest(null);
    setDshSchedulerRoundRunnerForTest(null);
    setMatchlockProductionRouteRunnerForTest("pi", null);
    setMatchlockProductionRouteRunnerForTest("hermes", null);
    setMatchlockProductionRouteRunnerForTest("dsh", null);
    if (ambientHome === undefined) delete process.env.HOME;
    else process.env.HOME = ambientHome;
  });

  // ── the pure env builder ────────────────────────────────────────────────

  it("buildMatchlockRoundRpcEnv replaces ONLY HOME with the verified alias and preserves caller keys", () => {
    const built = buildMatchlockRoundRpcEnv({
      TAMANDUA_MATCHLOCK_RPC_BIN: "/opt/matchlock/bin/matchlock",
      KEEP: "yes",
    });
    assert.equal(built.HOME, ALIAS);
    assert.equal(built.TAMANDUA_MATCHLOCK_RPC_BIN, "/opt/matchlock/bin/matchlock");
    assert.equal(built.KEEP, "yes");
    // The caller's env object is never mutated.
    const base = { A: "1" };
    const out = buildMatchlockRoundRpcEnv(base);
    assert.deepEqual(base, { A: "1" });
    assert.notEqual(out, base);
  });

  // ── all three production harnesses ──────────────────────────────────────

  it("pi and hermes rounds carry rpcEnv.HOME = the verified alias into the production round runner", async () => {
    const seen: Array<{ harness: string; home: string | undefined }> = [];
    setMatchlockSchedulerRoundRunnerForTest(async (r) => {
      seen.push({ harness: r.policy.harness ?? "pi", home: r.rpcEnv?.HOME });
      return okRound();
    });
    const homeBefore = process.env.HOME;
    await runMatchlockSchedulerRound(round(piPolicy()));
    await runMatchlockSchedulerRound(round(hermesPolicy()));
    assert.deepEqual(seen, [
      { harness: "pi", home: ALIAS },
      { harness: "hermes", home: ALIAS },
    ]);
    // The daemon/harness process HOME is untouched: only the round's RPC env
    // carries the alias.
    assert.equal(process.env.HOME, homeBefore);
  });

  it("dsh rounds carry rpcEnv.HOME = the verified alias through toDshSchedulerRound -> runDshSchedulerRound", async () => {
    const seen: Array<string | undefined> = [];
    setDshSchedulerRoundRunnerForTest(async (r) => {
      seen.push(r.rpcEnv?.HOME);
      return okRound();
    });
    await runMatchlockSchedulerRound(round(dshPolicy()));
    assert.deepEqual(seen, [ALIAS]);
  });

  it("the per-kind production route seam also observes the alias (one harness-keyed dispatch)", async () => {
    const seen: Array<{ kind: string; harness: string; home: string | undefined }> = [];
    const spy =
      (kind: "pi" | "hermes" | "dsh") =>
      async (r: MatchlockSchedulerRound): Promise<MatchlockSchedulerRoundResult> => {
        seen.push({ kind, harness: r.policy.harness ?? "pi", home: r.rpcEnv?.HOME });
        return okRound();
      };
    setMatchlockProductionRouteRunnerForTest("pi", spy("pi"));
    setMatchlockProductionRouteRunnerForTest("hermes", spy("hermes"));
    setMatchlockProductionRouteRunnerForTest("dsh", spy("dsh"));
    await runMatchlockSchedulerRound(round(piPolicy()));
    await runMatchlockSchedulerRound(round(hermesPolicy()));
    await runMatchlockSchedulerRound(round(dshPolicy()));
    assert.deepEqual(seen, [
      { kind: "pi", harness: "pi", home: ALIAS },
      { kind: "hermes", harness: "hermes", home: ALIAS },
      { kind: "dsh", harness: "dsh", home: ALIAS },
    ]);
  });

  it("a caller-supplied rpcEnv is preserved but HOME can never override the alias", async () => {
    let captured: Record<string, string> | undefined;
    setMatchlockSchedulerRoundRunnerForTest(async (r) => {
      captured = r.rpcEnv;
      return okRound();
    });
    await runMatchlockSchedulerRound(
      round(piPolicy(), {
        rpcEnv: { HOME: "/a/very/long/real/home", TAMANDUA_MATCHLOCK_RPC_BIN: "/bin/m" },
      }),
    );
    assert.equal(captured?.HOME, ALIAS, "alias wins over a caller-supplied HOME");
    assert.equal(captured?.TAMANDUA_MATCHLOCK_RPC_BIN, "/bin/m", "other rpcEnv keys survive");
  });

  it("the alias is confined to the matchlock control env: the guest env overrides and the real HOME are untouched", async () => {
    let captured: MatchlockSchedulerRound | undefined;
    setMatchlockSchedulerRoundRunnerForTest(async (r) => {
      captured = r;
      return okRound();
    });
    const homeBefore = process.env.HOME;
    await runMatchlockSchedulerRound(
      round(piPolicy(), { guestEnvOverrides: { DSH_HOME: "/workspace/config/dsh" } }),
    );
    assert.equal(captured?.rpcEnv?.HOME, ALIAS, "control env carries the alias");
    assert.deepEqual(
      captured?.guestEnvOverrides,
      { DSH_HOME: "/workspace/config/dsh" },
      "guest create-config env is never rewritten with the alias",
    );
    assert.equal(process.env.HOME, homeBefore, "the host process HOME is never mutated");
  });

  // ── fail-closed refusal before any VM create ────────────────────────────

  it("an untrustworthy alias refuses with a typed MatchlockRunnerError before the round runner is entered", async () => {
    let roundRunnerCalls = 0;
    setMatchlockSchedulerRoundRunnerForTest(async () => {
      roundRunnerCalls += 1;
      return okRound();
    });
    setMatchlockHomeAliasResolverForTest(() => {
      throw new MatchlockHomeAliasError(
        "alias_wrong_owner",
        'short-HOME alias "/tmp/tamandua/0/h" is owned by uid 0, not the effective uid 4242',
      );
    });
    let caught: unknown;
    try {
      await runMatchlockSchedulerRound(round(piPolicy()));
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof MatchlockRunnerError, "typed infrastructure error");
    assert.equal((caught as MatchlockRunnerError).code, "matchlock_home_alias_untrusted");
    assert.match((caught as Error).message, /alias_wrong_owner/);
    assert.match((caught as Error).message, /effective uid 4242/);
    assert.equal(roundRunnerCalls, 0, "no VM/round work happens when the alias is untrustworthy");
  });

  // ── the REAL resolver is the production default ─────────────────────────

  it("the production default resolver runs on every round (real home-alias path, hermetic via the escape hatch)", async () => {
    const dir = tamanduaTempDir("tamandua-mtlk-alias-wire-");
    const aliasPath = path.join(dir, "h");
    const prevOverride = process.env[MATCHLOCK_HOME_ALIAS_ENV];
    try {
      process.env[MATCHLOCK_HOME_ALIAS_ENV] = aliasPath;
      setMatchlockHomeAliasResolverForTest(null); // use the REAL resolver
      let captured: string | undefined;
      setMatchlockSchedulerRoundRunnerForTest(async (r) => {
        captured = r.rpcEnv?.HOME;
        return okRound();
      });
      const realHome = process.env.HOME;
      await runMatchlockSchedulerRound(round(piPolicy()));
      assert.equal(captured, aliasPath, "the verified alias is threaded as HOME");
      assert.equal(fs.readlinkSync(aliasPath), realHome, "alias target is the real HOME exactly");
      assert.ok(aliasPath.length < 108, "alias path is short enough for the unix socket limit");
    } finally {
      if (prevOverride === undefined) delete process.env[MATCHLOCK_HOME_ALIAS_ENV];
      else process.env[MATCHLOCK_HOME_ALIAS_ENV] = prevOverride;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
