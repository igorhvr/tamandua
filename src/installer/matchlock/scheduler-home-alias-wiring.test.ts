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
  MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA,
  MatchlockHomeAliasError,
  matchlockHomeAliasKey,
  matchlockHomeAliasOwnerPath,
  type MatchlockHomeAliasOwnerRecord,
} from "../../../dist/installer/matchlock/home-alias.js";
import {
  resolveMatchlockHomeAliasWithOwner,
  type MatchlockOwnerResolverDeps,
} from "../../../dist/installer/matchlock/home-alias-owner.js";
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

// ── US-003: owner-aware production resolver wiring ──────────────────────
//
// The production default is now the OWNER-AWARE keyed resolver
// (resolveMatchlockHomeAliasWithOwner): every round derives the per-daemon key
// from the daemon's REAL HOME and applies the ownership protocol. These tests
// drive that resolver hermetically with an injected tmpdir + uid + kernel
// identity, so they never touch the host HOME or `/tmp`.
describe("owner-aware Matchlock alias wiring (US-003)", () => {
  const UID = typeof process.getuid === "function" ? process.getuid() : 0;
  let root: string;

  beforeEach(() => {
    // Use the REAL production (owner-aware) resolver, not the fixed test seam.
    setMatchlockHomeAliasResolverForTest(null);
    root = tamanduaTempDir("tamandua-mtlk-owner-wire-");
  });

  afterEach(() => {
    setMatchlockHomeAliasResolverForTest(null);
    setMatchlockSchedulerRoundRunnerForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Hermetic owner-aware resolver deps: tmpdir/uid/home + a pinned identity. */
  function ownerDeps(
    home: string,
    over: Partial<MatchlockOwnerResolverDeps> = {},
  ): MatchlockOwnerResolverDeps {
    return {
      env: { HOME: home },
      tmpdir: path.join(root, "tmp"),
      uid: UID,
      ownerPid: 5555,
      ownerStartIdentity: "v2:5555:1700000000000",
      ...over,
    };
  }

  function makeHome(name: string): string {
    const home = path.join(root, name);
    fs.mkdirSync(home, { recursive: true });
    return home;
  }

  it("resolves rpcEnv.HOME to the keyed alias derived from the daemon's real HOME", () => {
    const home = makeHome("home");
    const built = buildMatchlockRoundRpcEnv(undefined, ownerDeps(home));
    const expected = path.join(
      root,
      "tmp",
      "tamandua",
      String(UID),
      matchlockHomeAliasKey(home),
      "h",
    );
    assert.equal(built.HOME, expected);
    assert.equal(fs.readlinkSync(expected), home, "alias target is the daemon's real HOME");
    assert.deepEqual(Object.keys(built), ["HOME"], "no caller keys were present");
  });

  it("resolves two different HOME values to two distinct keyed alias paths (AC5)", () => {
    const homeA = makeHome("home-a");
    const homeB = makeHome("home-b");
    const a = buildMatchlockRoundRpcEnv(undefined, ownerDeps(homeA));
    const b = buildMatchlockRoundRpcEnv(
      undefined,
      ownerDeps(homeB, { ownerPid: 5556, ownerStartIdentity: "v2:5556:1700000000000" }),
    );
    assert.notEqual(a.HOME, b.HOME, "distinct homes must key to distinct aliases");
    assert.equal(path.basename(path.dirname(a.HOME)), matchlockHomeAliasKey(homeA));
    assert.equal(path.basename(path.dirname(b.HOME)), matchlockHomeAliasKey(homeB));
  });

  it("carries the caller's other rpcEnv keys while the keyed HOME always wins", () => {
    const home = makeHome("home");
    const base = { TAMANDUA_MATCHLOCK_RPC_BIN: "/bin/m", KEEP: "yes" };
    const built = buildMatchlockRoundRpcEnv(base, ownerDeps(home));
    assert.equal(built.TAMANDUA_MATCHLOCK_RPC_BIN, "/bin/m");
    assert.equal(built.KEEP, "yes");
    assert.equal(built.HOME, path.join(root, "tmp", "tamandua", String(UID), matchlockHomeAliasKey(home), "h"));
    assert.deepEqual(base, { TAMANDUA_MATCHLOCK_RPC_BIN: "/bin/m", KEEP: "yes" });
  });

  it("a LIVE holder refuses through the production resolver and the round runner is never entered", async () => {
    const home = makeHome("home");
    const other = makeHome("other-home");
    const key = matchlockHomeAliasKey(home);
    const aliasDir = path.join(root, "tmp", "tamandua", String(UID), key);
    fs.mkdirSync(aliasDir, { recursive: true, mode: 0o700 });
    const aliasPath = path.join(aliasDir, "h");
    fs.symlinkSync(other, aliasPath);
    const holder: MatchlockHomeAliasOwnerRecord = {
      schema: MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA,
      pid: 7777,
      startIdentity: "v2:7777:1600000000000",
      realHome: other,
      aliasPath,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(matchlockHomeAliasOwnerPath(aliasDir), `${JSON.stringify(holder)}\n`, {
      mode: 0o600,
    });
    const deps = ownerDeps(home, {
      ownerProbe: {
        getProcessStartIdentity: (pid: number) =>
          pid === 7777 ? "v2:7777:1600000000000" : null,
        processExists: () => true,
      },
    });

    // (a) the env builder refuses before returning any HOME.
    assert.throws(
      () => buildMatchlockRoundRpcEnv(undefined, deps),
      (err: unknown) =>
        err instanceof MatchlockRunnerError &&
        err.code === "matchlock_home_alias_untrusted" &&
        /alias_owned_by_live_daemon/.test(err.message) &&
        /pid 7777/.test(err.message),
    );

    // (b) the whole scheduler seam refuses before the per-kind round runner.
    let runnerCalls = 0;
    setMatchlockSchedulerRoundRunnerForTest(async () => {
      runnerCalls += 1;
      return okRound();
    });
    setMatchlockHomeAliasResolverForTest(() => resolveMatchlockHomeAliasWithOwner(deps));
    await assert.rejects(
      async () => runMatchlockSchedulerRound(round(piPolicy())),
      (err: unknown) =>
        err instanceof MatchlockRunnerError &&
        err.code === "matchlock_home_alias_untrusted" &&
        /alias_owned_by_live_daemon/.test(err.message) &&
        /pid 7777/.test(err.message) &&
        /v2:7777:1600000000000/.test(err.message),
    );
    assert.equal(runnerCalls, 0, "no VM/round work happens behind a live holder");
    // The refusal leaves the holder's alias symlink untouched.
    assert.equal(fs.readlinkSync(aliasPath), other);
  });
});
