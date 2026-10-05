/**
 * execution-boundary.test.ts — MTLK-ISO-SLICE2 US-004.
 *
 * Coverage for the daemon execution boundary that runs BEFORE any VM for every
 * VM-creating scheduler round:
 *
 *   1. R13 root gate — the EXECUTING process's effective uid is re-checked
 *      through an injectable seam; euid 0 without recorded consent throws the
 *      typed `matchlock_root_usage_refused` BEFORE the swap probe / any VM,
 *      while recorded consent (`policy.rootUsageConsent === true`) proceeds.
 *   2. Swap-capability handshake — a FRESH bounded probe against the resolved
 *      matchlock binary runs for EVERY round (pi, hermes and dsh, probe and
 *      work, including swap-disabled runs); an unsupporting/inconclusive
 *      result throws `matchlock_swap_unsupported`, a missing binary throws
 *      `matchlock_unavailable`. No caching: an in-place binary replacement is
 *      caught by the next round's fresh probe.
 *
 * Serial lane: this file exercises source that reaches `node:child_process`
 * through the US-001 swap-support leaf (the default probe). It is listed in
 * tests/serial-files.txt. The F1 probes inject the swap probe and the route
 * spies capture every round; the Family A spawn-binding tests launch the REAL
 * RPC transport against fake shell executables (recording their own path), so
 * no real matchlock binary or VM is ever used.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path, { basename } from "node:path";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  assertMatchlockExecutionBoundary,
  setMatchlockExecutionBoundarySeamsForTest,
  type MatchlockExecutionBoundarySeams,
} from "../../../dist/installer/matchlock/execution-boundary.js";
import {
  runMatchlockSchedulerRound,
  setMatchlockHomeAliasResolverForTest,
  setMatchlockProductionRouteRunnerForTest,
  type MatchlockSchedulerRound,
  type MatchlockSchedulerRoundResult,
} from "../../../dist/installer/matchlock/scheduler-matchlock.js";
import { MatchlockRunnerError } from "../../../dist/installer/matchlock/runner-error.js";
import {
  MATCHLOCK_RPC_BIN_ENV,
  resolveMatchlockSwapBinaryPath,
} from "../../../dist/installer/matchlock/swap-support.js";
import { MatchlockRpcClient } from "../../../dist/installer/matchlock/rpc-client.js";
import {
  buildMatchlockPolicy,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";

type Harness = "pi" | "hermes" | "dsh";

/** A fully valid v3 policy for one harness; consent off by default. */
function policyFor(harness: Harness, over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  const common = {
    requestedImage: `tamandua-synthetic-${harness}:gate-fixture`,
    identity: {
      digest: "sha256:" + "1".repeat(64),
      config_digest: "sha256:" + "2".repeat(64),
      tag: `tamandua-synthetic-${harness}:gate-fixture`,
    },
    workingDirectory: "/srv/repo",
    originalRepositoryRoot: "/srv/repo",
    workMounts: [
      { hostPath: "/srv/repo", hostRealPath: "/srv/repo", guestPath: "/srv/repo" },
    ],
    gitMetadataRoots: [] as string[],
  };
  const base =
    harness === "pi"
      ? buildMatchlockPolicy({ ...common, harness: "pi" })
      : harness === "hermes"
        ? buildMatchlockPolicy({
            ...common,
            harness: "hermes",
            configurationRoot: "/home/operator/.hermes",
            configurationProfile: "default",
            guestConfigurationRoot: "/workspace/config/hermes",
            hermes: { homeDir: "/home/operator", cwd: "/srv/repo", hermesHomeEnv: null },
          })
        : buildMatchlockPolicy({
            ...common,
            harness: "dsh",
            configurationRoot: "/home/operator/.dsh",
            submissionHomeDir: "/home/operator",
            submissionCwd: "/srv/repo",
            submissionDshHomeEnv: null,
            submissionDshHomeSource: "default",
          });
  return { ...base, ...over };
}

function roundFor(
  policy: ExecutionIsolation,
  over: Partial<MatchlockSchedulerRound> = {},
): MatchlockSchedulerRound {
  return {
    policy,
    identity: {
      runId: "run-7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c",
      agentId: `${policy.harness ?? "pi"}_doer`,
      workflowId: "do-now",
      jobId: "job-boundary",
    },
    kind: "work",
    promptText: "do work",
    workingDirectoryForHarness: policy.workingDirectory,
    timeoutMs: 1000,
    ...over,
  };
}

const okResult = (): MatchlockSchedulerRoundResult => ({
  output: "STATUS: done\n",
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1,
});

/** A probe that always supports, journaling every resolved binary path. */
function supportingProbe(calls: string[]) {
  return (binaryPath: string) => {
    calls.push(binaryPath);
    return { supported: true, binaryPath };
  };
}

describe("US-004 daemon execution-boundary gate (assertMatchlockExecutionBoundary)", () => {
  it("euid 0 with no recorded consent throws typed matchlock_root_usage_refused BEFORE the swap probe", async () => {
    let probeCalls = 0;
    const err = await assertMatchlockExecutionBoundary(
      policyFor("pi"),
      roundFor(policyFor("pi")).identity,
      {
        effectiveUid: () => 0,
        swapSupportProbe: (binaryPath) => {
          probeCalls += 1;
          return { supported: true, binaryPath };
        },
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError, `expected MatchlockRunnerError, got ${String(err)}`);
    assert.equal(err.code, "matchlock_root_usage_refused");
    assert.match(err.message, /refusing to execute a Matchlock run as root/);
    assert.match(err.message, /daemon execution boundary/);
    assert.match(err.message, /--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs/);
    assert.equal(probeCalls, 0, "the R13 gate must precede the swap probe");
  });

  it("euid 0 WITH recorded consent proceeds (and the fresh swap probe runs)", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi", { rootUsageConsent: true });
    await assertMatchlockExecutionBoundary(policy, roundFor(policy).identity, {
      effectiveUid: () => 0,
      swapSupportProbe: supportingProbe(calls),
    });
    assert.equal(calls.length, 1);
    assert.equal(basename(calls[0] ?? ""), "matchlock");
  });

  it("a non-root executing process proceeds without consent", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi");
    await assertMatchlockExecutionBoundary(policy, roundFor(policy).identity, {
      effectiveUid: () => 1000,
      swapSupportProbe: supportingProbe(calls),
    });
    assert.equal(calls.length, 1);
  });

  it("an unsupporting probe throws typed matchlock_swap_unsupported naming the binary and the setup remedy", async () => {
    const policy = policyFor("pi");
    const err = await assertMatchlockExecutionBoundary(policy, roundFor(policy).identity, {
      effectiveUid: () => 1000,
      matchlockBinaryPath: "/opt/matchlock/bin/matchlock",
      swapSupportProbe: (binaryPath) => ({
        supported: false,
        binaryPath,
        reasonCode: "unsupported",
        reason: `"${binaryPath} run --help" does not list --swap`,
      }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_swap_unsupported");
    assert.match(err.message, /\/opt\/matchlock\/bin\/matchlock/);
    assert.match(err.message, /--swap/);
    assert.match(err.message, /tamandua matchlock setup/);
  });

  it("an inconclusive (probe_failed) result is fail-closed with matchlock_swap_unsupported", async () => {
    const policy = policyFor("pi");
    const err = await assertMatchlockExecutionBoundary(policy, roundFor(policy).identity, {
      effectiveUid: () => 1000,
      matchlockBinaryPath: "/opt/matchlock/bin/matchlock",
      swapSupportProbe: (binaryPath) => ({
        supported: false,
        binaryPath,
        reasonCode: "probe_failed",
        reason: `"${binaryPath} run --help" did not exit (killed by a signal or timed out)`,
      }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_swap_unsupported");
  });

  it("a missing binary keeps the matchlock_unavailable classification", async () => {
    const policy = policyFor("pi");
    const err = await assertMatchlockExecutionBoundary(policy, roundFor(policy).identity, {
      effectiveUid: () => 1000,
      matchlockBinaryPath: "/opt/matchlock/bin/matchlock",
      swapSupportProbe: (binaryPath) => ({
        supported: false,
        binaryPath,
        reasonCode: "missing_binary",
        reason: `matchlock binary not found: ${binaryPath}`,
      }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_unavailable");
    assert.match(err.message, /\/opt\/matchlock\/bin\/matchlock/);
  });

  it("a throwing probe is fail-closed typed matchlock_swap_unsupported", async () => {
    const policy = policyFor("pi");
    const err = await assertMatchlockExecutionBoundary(policy, roundFor(policy).identity, {
      effectiveUid: () => 1000,
      matchlockBinaryPath: "/opt/matchlock/bin/matchlock",
      swapSupportProbe: () => {
        throw new Error("boom");
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_swap_unsupported");
    assert.match(err.message, /probe failed: boom/);
  });

  it("probes the binary resolved from TAMANDUA_MATCHLOCK_RPC_BIN when no explicit path is passed", async () => {
    const saved = process.env[MATCHLOCK_RPC_BIN_ENV];
    process.env[MATCHLOCK_RPC_BIN_ENV] = "  /opt/matchlock/bin/matchlock  ";
    try {
      const calls: string[] = [];
      const policy = policyFor("pi");
      await assertMatchlockExecutionBoundary(policy, roundFor(policy).identity, {
        effectiveUid: () => 1000,
        // No matchlockBinaryPath: resolution must consult the env override.
        swapSupportProbe: supportingProbe(calls),
      });
      assert.deepEqual(calls, ["/opt/matchlock/bin/matchlock"]);
    } finally {
      if (saved === undefined) delete process.env[MATCHLOCK_RPC_BIN_ENV];
      else process.env[MATCHLOCK_RPC_BIN_ENV] = saved;
    }
  });

  it("returns the ONE probed binary path so the transport can bind to it (F1)", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi");
    const resolved = await assertMatchlockExecutionBoundary(
      policy,
      roundFor(policy).identity,
      {
        effectiveUid: () => 1000,
        matchlockBinaryPath: "/opt/probe/matchlock",
        swapSupportProbe: supportingProbe(calls),
      },
    );
    assert.equal(resolved, "/opt/probe/matchlock", "the probed path is returned verbatim");
    assert.deepEqual(calls, ["/opt/probe/matchlock"], "the probe consumed the same path");
  });
});

describe("US-004 runMatchlockSchedulerRound execution-boundary wiring", () => {
  let savedRpcBin: string | undefined;
  let routeCalls: Array<{ kind: Harness | "spy"; runId: string }>;
  let routeBinaryPaths: Array<string | undefined>;

  beforeEach(() => {
    savedRpcBin = process.env[MATCHLOCK_RPC_BIN_ENV];
    delete process.env[MATCHLOCK_RPC_BIN_ENV];
    routeCalls = [];
    routeBinaryPaths = [];
    setMatchlockHomeAliasResolverForTest(() => "/home/alias-fixture/tamandua/4242/h");
    for (const kind of ["pi", "hermes", "dsh"] as const) {
      setMatchlockProductionRouteRunnerForTest(kind, async (r) => {
        routeCalls.push({ kind, runId: r.identity.runId });
        routeBinaryPaths.push(r.rpcBinaryPath);
        return okResult();
      });
    }
  });

  afterEach(() => {
    setMatchlockProductionRouteRunnerForTest("pi", null);
    setMatchlockProductionRouteRunnerForTest("hermes", null);
    setMatchlockProductionRouteRunnerForTest("dsh", null);
    setMatchlockHomeAliasResolverForTest(null);
    setMatchlockExecutionBoundarySeamsForTest(null);
    if (savedRpcBin === undefined) delete process.env[MATCHLOCK_RPC_BIN_ENV];
    else process.env[MATCHLOCK_RPC_BIN_ENV] = savedRpcBin;
  });

  it("a root daemon force-fails a consent-less run BEFORE the route runner (no VM)", async () => {
    const err = await runMatchlockSchedulerRound(
      roundFor(policyFor("pi"), {
        executionBoundary: { effectiveUid: () => 0, swapSupportProbe: supportingProbe([]) },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_root_usage_refused");
    assert.deepEqual(routeCalls, [], "the route runner must never be reached on a root refusal");
  });

  it("recorded consent lets a root daemon proceed and probes afresh", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi", { rootUsageConsent: true });
    await runMatchlockSchedulerRound(
      roundFor(policy, {
        executionBoundary: { effectiveUid: () => 0, swapSupportProbe: supportingProbe(calls) },
      }),
    );
    assert.deepEqual(routeCalls, [{ kind: "pi", runId: roundFor(policy).identity.runId }]);
    assert.equal(calls.length, 1, "a fresh probe runs for the round");
  });

  it("an unsupporting probe force-fails BEFORE the route runner for pi, hermes and dsh", async () => {
    for (const harness of ["pi", "hermes", "dsh"] as const) {
      routeCalls = [];
      const policy = policyFor(harness);
      const err = await runMatchlockSchedulerRound(
        roundFor(policy, {
          executionBoundary: {
            effectiveUid: () => 1000,
            matchlockBinaryPath: `/opt/${harness}/matchlock`,
            swapSupportProbe: (binaryPath) => ({
              supported: false,
              binaryPath,
              reasonCode: "unsupported",
            }),
          },
        }),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof MatchlockRunnerError, `${harness}: expected MatchlockRunnerError`);
      assert.equal(err.code, "matchlock_swap_unsupported", `${harness}: typed code`);
      assert.deepEqual(routeCalls, [], `${harness}: no VM/route on refusal`);
    }
  });

  it("a supporting probe reaches the pi, hermes AND dsh route exactly once each", async () => {
    for (const harness of ["pi", "hermes", "dsh"] as const) {
      routeCalls = [];
      const calls: string[] = [];
      const policy = policyFor(harness);
      await runMatchlockSchedulerRound(
        roundFor(policy, {
          executionBoundary: {
            effectiveUid: () => 1000,
            matchlockBinaryPath: `/opt/${harness}/matchlock`,
            swapSupportProbe: supportingProbe(calls),
          },
        }),
      );
      assert.deepEqual(calls, [`/opt/${harness}/matchlock`], `${harness}: probed its resolved path`);
      assert.deepEqual(routeCalls, [{ kind: harness, runId: roundFor(policy).identity.runId }]);
    }
  });

  it("threads the ONE probed absolute path into the route's rpcBinaryPath (F1 probe==child binding)", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi");
    await runMatchlockSchedulerRound(
      roundFor(policy, {
        executionBoundary: {
          effectiveUid: () => 1000,
          matchlockBinaryPath: "/opt/probed/matchlock",
          swapSupportProbe: supportingProbe(calls),
        },
      }),
    );
    assert.deepEqual(calls, ["/opt/probed/matchlock"], "the probe saw the resolved path");
    assert.deepEqual(
      routeBinaryPaths,
      ["/opt/probed/matchlock"],
      "the transport seam receives EXACTLY the probed path (never a re-resolution)",
    );
  });

  it("no caching: an in-place binary replacement between two rounds is caught by the next fresh probe", async () => {
    const calls: string[] = [];
    let supported = true;
    const policy = policyFor("pi");
    const seams: MatchlockExecutionBoundarySeams = {
      effectiveUid: () => 1000,
      matchlockBinaryPath: "/opt/matchlock/bin/matchlock",
      swapSupportProbe: (binaryPath) => {
        calls.push(binaryPath);
        // Round 1 sees a qualified binary; round 2 sees it replaced in place.
        return supported
          ? { supported: true, binaryPath }
          : { supported: false, binaryPath, reasonCode: "unsupported" };
      },
    };

    await runMatchlockSchedulerRound(roundFor(policy, { executionBoundary: seams }));
    assert.deepEqual(routeCalls, [{ kind: "pi", runId: roundFor(policy).identity.runId }]);

    supported = false;
    const err = await runMatchlockSchedulerRound(roundFor(policy, { executionBoundary: seams })).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_swap_unsupported");
    assert.equal(calls.length, 2, "each round performed its own fresh probe (no cache)");
    assert.deepEqual(calls, ["/opt/matchlock/bin/matchlock", "/opt/matchlock/bin/matchlock"]);
    // Only the first (supported) round reached the route.
    assert.deepEqual(routeCalls, [{ kind: "pi", runId: roundFor(policy).identity.runId }]);
  });

  it("a submission-vs-dispatch capability mismatch refuses before any VM", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi");
    // The submission process resolved a swap-capable binary...
    const submissionPath = "/opt/submission/matchlock";
    // ...but the daemon resolves a DIFFERENT, unqualified binary.
    const dispatchPath = "/opt/daemon/matchlock";
    const seams: MatchlockExecutionBoundarySeams = {
      effectiveUid: () => 1000,
      matchlockBinaryPath: dispatchPath,
      swapSupportProbe: (binaryPath) => {
        calls.push(binaryPath);
        return binaryPath === submissionPath
          ? { supported: true, binaryPath }
          : { supported: false, binaryPath, reasonCode: "unsupported" };
      },
    };
    const err = await runMatchlockSchedulerRound(roundFor(policy, { executionBoundary: seams })).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_swap_unsupported");
    assert.deepEqual(routeCalls, [], "the mismatch refuses before any VM");
    assert.deepEqual(calls, [dispatchPath]);
  });

  it("two distinct but BOTH-qualified resolved paths are NOT refused merely for differing", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi");
    const qualified = new Set(["/opt/a/matchlock", "/opt/b/matchlock"]);
    const seamsFor = (binaryPath: string): MatchlockExecutionBoundarySeams => ({
      effectiveUid: () => 1000,
      matchlockBinaryPath: binaryPath,
      swapSupportProbe: (bin: string) => {
        calls.push(bin);
        return qualified.has(bin)
          ? { supported: true, binaryPath: bin }
          : { supported: false, binaryPath: bin, reasonCode: "unsupported" };
      },
    });
    await runMatchlockSchedulerRound(roundFor(policy, { executionBoundary: seamsFor("/opt/a/matchlock") }));
    await runMatchlockSchedulerRound(roundFor(policy, { executionBoundary: seamsFor("/opt/b/matchlock") }));
    assert.equal(routeCalls.length, 2, "both qualified paths are admitted");
    assert.deepEqual(calls, ["/opt/a/matchlock", "/opt/b/matchlock"]);
  });

  it("still probes (and admits) a swap-DISABLED run", async () => {
    const calls: string[] = [];
    const policy = policyFor("pi");
    policy.resourceLimits = { ...policy.resourceLimits, swapMB: 0 };
    await runMatchlockSchedulerRound(
      roundFor(policy, {
        executionBoundary: {
          effectiveUid: () => 1000,
          matchlockBinaryPath: "/opt/matchlock/bin/matchlock",
          swapSupportProbe: supportingProbe(calls),
        },
      }),
    );
    assert.deepEqual(calls, ["/opt/matchlock/bin/matchlock"], "swap=off still probes");
    assert.equal(routeCalls.length, 1);

    const err = await runMatchlockSchedulerRound(
      roundFor(policy, {
        executionBoundary: {
          effectiveUid: () => 1000,
          matchlockBinaryPath: "/opt/matchlock/bin/matchlock",
          swapSupportProbe: (binaryPath) => ({
            supported: false,
            binaryPath,
            reasonCode: "unsupported",
          }),
        },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MatchlockRunnerError);
    assert.equal(err.code, "matchlock_swap_unsupported", "swap=off is still refused when unsupported");
  });

  it("the module-level test seam supplies the boundary probe where the scheduler builds the round", async () => {
    const calls: string[] = [];
    setMatchlockExecutionBoundarySeamsForTest({
      effectiveUid: () => 1000,
      matchlockBinaryPath: "/opt/seam/matchlock",
      swapSupportProbe: supportingProbe(calls),
    });
    const policy = policyFor("pi");
    await runMatchlockSchedulerRound(roundFor(policy));
    assert.deepEqual(calls, ["/opt/seam/matchlock"]);
    assert.equal(routeCalls.length, 1);
  });

  it("a per-round seam overrides the module-level seam", async () => {
    const moduleCalls: string[] = [];
    const roundCalls: string[] = [];
    setMatchlockExecutionBoundarySeamsForTest({
      effectiveUid: () => 0,
      matchlockBinaryPath: "/opt/module/matchlock",
      swapSupportProbe: supportingProbe(moduleCalls),
    });
    await runMatchlockSchedulerRound(
      roundFor(policyFor("pi"), {
        executionBoundary: {
          effectiveUid: () => 1000,
          matchlockBinaryPath: "/opt/round/matchlock",
          swapSupportProbe: supportingProbe(roundCalls),
        },
      }),
    );
    assert.deepEqual(moduleCalls, []);
    assert.deepEqual(roundCalls, ["/opt/round/matchlock"]);
  });
});

/**
 * MTLK-ISO2-CORRECTIVE Family A: the EXECUTED RPC child must be the EXACT
 * executable the execution-boundary probe verified.
 *
 * Unlike the scheduler-wiring tests above (which assert the threaded
 * `rpcBinaryPath` string through a route spy), these tests launch a REAL
 * `MatchlockRpcClient` against fake executables that record their own absolute
 * path to a journal. That observes the actual production spawn — no test seam
 * replaces the transport — and proves `probe == child` under an EMPTY PATH
 * component (cwd shadow), under an RPC-only PATH override, and for the
 * both-qualified control that must not be refused merely for differing.
 */
describe("MTLK-ISO2-CORRECTIVE F1: probed executable === actual RPC child", () => {
  let root: string;
  let cwdDir: string;
  let qualA: string;
  let qualB: string;
  let journal: string;
  let savedCwd: string;
  let savedPath: string | undefined;

  function writeFake(dir: string): string {
    const file = path.join(dir, "matchlock");
    fs.writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s\\n' '${file}' >> '${journal}'\n`,
      { mode: 0o755 },
    );
    return file;
  }

  function journalLines(): string[] {
    return fs.existsSync(journal)
      ? fs
          .readFileSync(journal, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
      : [];
  }

  /** Start the real RPC transport and return the absolute path that ran. */
  async function launchAndObserve(
    binaryPath: string,
    childEnv: NodeJS.ProcessEnv,
  ): Promise<string> {
    const before = journalLines().length;
    const client = new MatchlockRpcClient({
      binaryPath,
      args: [],
      env: childEnv,
      onLog: () => {},
      readyTimeoutMs: 200,
      requestTimeoutMs: 2000,
    });
    try {
      client.start();
      const deadline = Date.now() + 5000;
      while (journalLines().length <= before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const lines = journalLines();
      return lines[lines.length - 1] ?? "";
    } finally {
      await client.dispose();
    }
  }

  beforeEach(() => {
    root = tamanduaTempDir("tamandua-f1-child-");
    cwdDir = path.join(root, "cwd");
    qualA = path.join(root, "qualified-a");
    qualB = path.join(root, "qualified-b");
    journal = path.join(root, "journal.txt");
    for (const dir of [cwdDir, qualA, qualB]) fs.mkdirSync(dir, { recursive: true });
    savedCwd = process.cwd();
    savedPath = process.env.PATH;
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("PATH=:/qualified/bin with a ./matchlock shadow: the real child is the resolved cwd shadow", async () => {
    const shadow = writeFake(cwdDir);
    writeFake(qualA);
    const env: NodeJS.ProcessEnv = { PATH: `:${qualA}` };
    const probed = resolveMatchlockSwapBinaryPath(env);
    assert.equal(probed, shadow, "the empty PATH component resolves to the cwd shadow");

    // The transport launched on the PROBED absolute path runs exactly it.
    assert.equal(await launchAndObserve(probed, { PATH: `:${qualA}` }), shadow);
    // The bare production default (`matchlock`, which the old code left
    // un-threaded) is ALSO the cwd shadow under spawn's own empty-component
    // semantics, so the resolver can never bind the probe to a runtime spawn
    // would not launch.
    assert.equal(
      await launchAndObserve("matchlock", { PATH: `:${qualA}` }),
      shadow,
      "spawn's empty PATH component is the child cwd",
    );
  });

  it("binds probe==child for the pi, hermes and dsh routes under an empty PATH component", async () => {
    const shadow = writeFake(cwdDir);
    writeFake(qualA);
    const routePath = `:${qualA}`;
    for (const harness of ["pi", "hermes", "dsh"] as const) {
      const observed: string[] = [];
      setMatchlockProductionRouteRunnerForTest(harness, async (r) => {
        assert.equal(r.rpcBinaryPath, shadow, `${harness}: the route receives the probed path`);
        observed.push(await launchAndObserve(r.rpcBinaryPath as string, { PATH: routePath }));
        return okResult();
      });
      const policy = policyFor(harness);
      await runMatchlockSchedulerRound(
        roundFor(policy, {
          rpcEnv: { PATH: routePath },
          executionBoundary: {
            effectiveUid: () => 1000,
            env: { PATH: routePath },
            swapSupportProbe: (binaryPath: string) => ({ supported: true, binaryPath }),
          },
        }),
      );
      assert.deepEqual(observed, [shadow], `${harness}: the real RPC child is the probed shadow`);
    }
  });

  it("an RPC PATH override differing from the admission PATH still binds probe==child", async () => {
    writeFake(cwdDir);
    writeFake(qualA);
    const qualBChild = writeFake(qualB);
    // Admission would resolve the cwd shadow (empty first component)...
    assert.equal(
      resolveMatchlockSwapBinaryPath({ PATH: `:${qualA}` }),
      path.join(cwdDir, "matchlock"),
    );
    // ...but the round's RPC child env has a DIFFERENT PATH with no empty
    // component, so BOTH the probe and the child must bind to qualB.
    const rpcPath = qualB;
    const probed = resolveMatchlockSwapBinaryPath({ PATH: rpcPath });
    assert.equal(probed, qualBChild, "the probe resolves the RPC-only PATH");
    assert.equal(
      await launchAndObserve(probed, { PATH: rpcPath }),
      qualBChild,
      "the real child is the same RPC-PATH binary",
    );

    const observed: string[] = [];
    setMatchlockProductionRouteRunnerForTest("pi", async (r) => {
      assert.equal(r.rpcBinaryPath, qualBChild, "the route receives the RPC-PATH probe result");
      observed.push(await launchAndObserve(r.rpcBinaryPath as string, { PATH: rpcPath }));
      return okResult();
    });
    const policy = policyFor("pi");
    await runMatchlockSchedulerRound(
      roundFor(policy, {
        rpcEnv: { PATH: rpcPath },
        executionBoundary: {
          effectiveUid: () => 1000,
          env: { PATH: rpcPath },
          swapSupportProbe: (binaryPath: string) => ({ supported: true, binaryPath }),
        },
      }),
    );
    assert.deepEqual(observed, [qualBChild]);
  });

  it("both-qualified differers are admitted and the child is the first qualified executable", async () => {
    writeFake(cwdDir);
    const qualAChild = writeFake(qualA);
    writeFake(qualB);
    const env: NodeJS.ProcessEnv = {
      PATH: `${qualA}${path.delimiter}${qualB}`,
    };
    const policy = policyFor("pi");
    const resolved = await assertMatchlockExecutionBoundary(
      policy,
      roundFor(policy).identity,
      {
        effectiveUid: () => 1000,
        env,
        swapSupportProbe: (binaryPath: string) => ({ supported: true, binaryPath }),
      },
    );
    assert.equal(resolved, qualAChild, "the first qualified PATH entry wins");
    assert.equal(
      await launchAndObserve(resolved, { PATH: env.PATH }),
      qualAChild,
      "the real child matches the probed qualified executable",
    );
  });
});
