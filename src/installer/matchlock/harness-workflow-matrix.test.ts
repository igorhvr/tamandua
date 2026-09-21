/**
 * harness-workflow-matrix.test.ts — MTLK-INTEGRATE US-007, flipped by
 * MTLK-ALL-WORKFLOWS US-003 and pinned by MTLK-ALL-WORKFLOWS US-005.
 *
 * TEST-FIRST ANSWER to the open integration question:
 *
 *   "Do hermes and dsh gain the managed-worktree/merge workflow shapes for
 *    free through the workflow-parity seam?"
 *
 * DECISION (MTLK-ALL-WORKFLOWS US-001..US-005): YES. The host merge context /
 * service is now forwarded by all three round seams:
 *   - pi forwards `HostMergeServices` into `createHostBroker`
 *     (`runMatchlockInvocation`);
 *   - hermes forwards `RunHermesInvocationOptions.merge` the same way;
 *   - dsh carries `DshSchedulerRound.merge` and converts it with
 *     `createMergeServiceForContext` in the production dsh route, whose opts
 *     spread reaches `createHostBroker` through `runDshInvocation`.
 *
 * The harness-by-workflow allow-list is therefore lifted: every harness admits
 * every capability-closed workflow id the integrated backend can serve, and
 * admission is purely workflow + capability closure. The ACCEPTED matrix cell
 * for every capability-closed shape is the same for pi, hermes and dsh; the
 * merge cells are accepted, not pi-only. The REFUSED cells stay refused for
 * every harness BEFORE any probe/findBinary/spawn/VM:
 *   - unknown/custom ids (fail-closed generic admitted-list message);
 *   - explicitly refused bundled shapes (`*-github-pr`, `just-do-it`,
 *     `frontend-test`, `skills-normalize-audit`) with their precise reason;
 *   - out-of-closure ids: an admitted shape whose declared later-role
 *     capability is absent from the backend (reduced
 *     `availableCapabilities`) refuses naming the exact missing capability.
 *
 * Lane: serial (this file directly imports `merge-invocation-wiring.ts`, whose
 * module imports `node:child_process` for the narrow authoritative target-tip
 * read). It is listed in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMatchlockPolicy,
  serializeMatchlockPolicy,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import { matchlockDispatchDecision } from "../../../dist/installer/matchlock/dispatch-guard.js";
import {
  MATCHLOCK_AVAILABLE_CAPABILITIES,
  MATCHLOCK_REFUSED_WORKFLOW_IDS,
  MATCHLOCK_SUPPORTED_WORKFLOW_IDS,
  matchlockHarnessSupportsWorkflow,
  matchlockWorkflowCapabilities,
  matchlockWorkflowRequiresCapability,
} from "../../../dist/installer/matchlock/capabilities.js";
import {
  buildMatchlockMergeContext,
  matchlockProductionRunnerKind,
  matchlockRoundScopeRefusal,
  runMatchlockSchedulerRound,
  setMatchlockProductionRouteRunnerForTest,
  type MatchlockSchedulerRound,
} from "../../../dist/installer/matchlock/scheduler-matchlock.js";
import { createMergeServiceForContext } from "../../../dist/installer/matchlock/merge-invocation-wiring.js";

const HARNESSES = ["pi", "hermes", "dsh"] as const;
type Harness = (typeof HARNESSES)[number];

/** The shallow pipelines every harness admits (parity with all four contracts). */
const SHALLOW_WORKFLOWS = ["do-now", "do-review-do-verify"] as const;

/** The merge worktree/direct routes (accepted by ALL harnesses). */
const MERGE_WORKFLOWS = [
  "feature-dev-merge-worktree",
  "bug-fix-merge-worktree",
  "feature-dev-merge",
  "bug-fix-merge",
] as const;

/**
 * MTLK-ALL-WORKFLOWS US-004: every capability-closed bundled shape is admitted
 * for every harness. Sourced from the explicit catalog so the matrix cannot
 * silently drift from `capabilities.ts`.
 */
const SHAPE_MATRIX: readonly string[] = [...MATCHLOCK_SUPPORTED_WORKFLOW_IDS];

/**
 * Workflow ids every harness must still refuse: the explicitly refused bundled
 * shapes (each with its precise reason) plus an unknown/custom id.
 */
const REFUSED_WORKFLOWS: readonly string[] = [
  ...MATCHLOCK_REFUSED_WORKFLOW_IDS,
  "totally-unknown-custom-workflow",
];

/** Contract union (US-003/US-005): every harness accepts every capability-closed shape. */
function acceptedFor(_harness: Harness, workflowId: string): boolean {
  return (SHAPE_MATRIX as readonly string[]).includes(workflowId);
}

const DIGESTS: Record<Harness, { digest: string; config: string }> = {
  pi: { digest: "sha256:" + "1".repeat(64), config: "sha256:" + "2".repeat(64) },
  hermes: { digest: "sha256:" + "3".repeat(64), config: "sha256:" + "4".repeat(64) },
  dsh: { digest: "sha256:" + "5".repeat(64), config: "sha256:" + "6".repeat(64) },
};

/** A fully valid, pinned policy for each harness (build-time validated). */
function policyFor(harness: Harness): ExecutionIsolation {
  const common = {
    requestedImage: `tamandua-synthetic-${harness}:gate-fixture`,
    identity: {
      digest: DIGESTS[harness].digest,
      config_digest: DIGESTS[harness].config,
      tag: `tamandua-synthetic-${harness}:gate-fixture`,
    },
    workingDirectory: "/srv/repo",
    originalRepositoryRoot: "/srv/repo",
    workMounts: [
      { hostPath: "/srv/repo", hostRealPath: "/srv/repo", guestPath: "/srv/repo" },
    ],
    gitMetadataRoots: [] as string[],
  };
  if (harness === "pi") {
    return buildMatchlockPolicy({ ...common, harness: "pi" });
  }
  if (harness === "hermes") {
    return buildMatchlockPolicy({
      ...common,
      harness: "hermes",
      configurationRoot: "/home/operator/.hermes",
      configurationProfile: "default",
      guestConfigurationRoot: "/workspace/config/hermes",
      hermes: { homeDir: "/home/operator", cwd: "/srv/repo", hermesHomeEnv: null },
    });
  }
  return buildMatchlockPolicy({
    ...common,
    harness: "dsh",
    configurationRoot: "/home/operator/.dsh",
    submissionHomeDir: "/home/operator",
    submissionCwd: "/srv/repo",
    submissionDshHomeEnv: null,
    submissionDshHomeSource: "default",
  });
}

function roundFor(policy: ExecutionIsolation, workflowId: string): MatchlockSchedulerRound {
  return {
    policy,
    identity: {
      runId: "run-1a2b3c4d",
      agentId: `${workflowId}_doer`,
      workflowId,
      jobId: "job-matrix",
    },
    kind: "work",
    promptText: "do work",
    workingDirectoryForHarness: policy.workingDirectory,
    timeoutMs: 1000,
  };
}

/** Install one counting route spy per harness kind; returns the counters. */
function installRouteSpies(): Record<Harness, number> {
  const counters: Record<Harness, number> = { pi: 0, hermes: 0, dsh: 0 };
  for (const kind of HARNESSES) {
    setMatchlockProductionRouteRunnerForTest(kind, async (r) => {
      counters[kind] += 1;
      assert.equal(
        matchlockProductionRunnerKind(r.policy),
        kind,
        `the ${kind} route spy must only receive ${kind} policies`,
      );
      return { output: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1, stderrTail: "" };
    });
  }
  return counters;
}

function clearRouteSpies(): void {
  for (const kind of HARNESSES) {
    setMatchlockProductionRouteRunnerForTest(kind, null);
  }
}

/**
 * Faithful deterministic mirror of the scheduler's Matchlock barrier
 * (src/installer/agent-scheduler.ts): consult `matchlockDispatchDecision`
 * FIRST and only route through the harness-keyed runner when admitted. A
 * refusal therefore never reaches any runner.
 */
async function dispatchLikeScheduler(
  rawPolicy: string,
  ctx: { workflowId: string; harnessType: string },
  round: MatchlockSchedulerRound,
): Promise<{ refused: boolean; routed: boolean }> {
  const decision = matchlockDispatchDecision(rawPolicy, ctx);
  if (decision.refused) return { refused: true, routed: false };
  await runMatchlockSchedulerRound(round);
  return { refused: false, routed: true };
}

describe("harness x workflow admission matrix (MTLK-ALL-WORKFLOWS US-003/US-005)", () => {
  it("declares harness parity: every harness supports the full capability-closed set (no allow-list)", () => {
    for (const harness of HARNESSES) {
      for (const workflowId of SHAPE_MATRIX) {
        assert.equal(
          matchlockHarnessSupportsWorkflow(harness, workflowId),
          true,
          `${harness} x ${workflowId} must be supported`,
        );
      }
      for (const workflowId of REFUSED_WORKFLOWS) {
        assert.equal(
          matchlockHarnessSupportsWorkflow(harness, workflowId),
          false,
          `${harness} x ${workflowId} must stay unsupported`,
        );
      }
    }
  });

  it("keeps both shallow pipelines accepted for every harness (empty closure)", () => {
    for (const harness of HARNESSES) {
      const raw = serializeMatchlockPolicy(policyFor(harness));
      for (const workflowId of SHALLOW_WORKFLOWS) {
        assert.equal(acceptedFor(harness, workflowId), true);
        const decision = matchlockDispatchDecision(raw, { workflowId, harnessType: harness });
        assert.equal(
          decision.refused,
          false,
          `${harness} x ${workflowId} shallow pipeline must stay accepted`,
        );
        // Shallow pipelines declare no later-role tools, so their closure is
        // empty and they are admitted independently of the backend set.
        assert.deepEqual(matchlockWorkflowCapabilities(workflowId), []);
      }
    }
  });

  it("accepts exactly the capability-closed shape cells and refuses the rest (every admitted id x 3 harnesses)", () => {
    for (const harness of HARNESSES) {
      const raw = serializeMatchlockPolicy(policyFor(harness));
      const policy = policyFor(harness);
      for (const workflowId of SHAPE_MATRIX) {
        const decision = matchlockDispatchDecision(raw, {
          workflowId,
          harnessType: harness,
        });
        assert.equal(
          decision.refused,
          !acceptedFor(harness, workflowId),
          `${harness} x ${workflowId} admission decision`,
        );
        if (decision.refused) {
          assert.equal(decision.code, "matchlock_workflow_unsupported");
          // The refusal is the harness x workflow axis, NOT a path-scope
          // refusal: the exact-path invariant is satisfied, yet the round is
          // still refused before any probe/findBinary/spawn/VM.
          assert.equal(
            matchlockRoundScopeRefusal(policy, policy.workingDirectory),
            null,
            `the ${harness} x ${workflowId} refusal must precede any scope/VM work`,
          );
        }
      }
    }
  });

  it("refuses child-dispatch/PR/browser/skills-audit/unknown workflows for ALL three harnesses", () => {
    for (const harness of HARNESSES) {
      const raw = serializeMatchlockPolicy(policyFor(harness));
      for (const workflowId of REFUSED_WORKFLOWS) {
        const decision = matchlockDispatchDecision(raw, {
          workflowId,
          harnessType: harness,
        });
        assert.equal(decision.refused, true, `${harness} x ${workflowId} must be refused`);
        assert.equal(decision.code, "matchlock_workflow_unsupported");
      }
    }
  });

  it("refuses every out-of-closure cell for each harness, naming the exact missing capability", () => {
    for (const harness of HARNESSES) {
      const raw = serializeMatchlockPolicy(policyFor(harness));
      for (const workflowId of MATCHLOCK_SUPPORTED_WORKFLOW_IDS) {
        const required = matchlockWorkflowCapabilities(workflowId) ?? [];
        // Every admitted closure must be servable by the integrated backend;
        // otherwise the "accepted by default" matrix above would be a lie.
        for (const capability of required) {
          assert.ok(
            (MATCHLOCK_AVAILABLE_CAPABILITIES as readonly string[]).includes(capability),
            `${workflowId} declares ${capability}, which the backend must provide`,
          );
        }
        if (required.length === 0) {
          // Shallow workflows declare no later-role tools: even an EMPTY
          // backend capability set admits them (only the workflow id can
          // fail closed), for every harness.
          const empty = matchlockDispatchDecision(raw, {
            workflowId,
            harnessType: harness,
            availableCapabilities: [],
          });
          assert.equal(
            empty.refused,
            false,
            `${harness} x ${workflowId} has an empty closure and must stay admitted`,
          );
          continue;
        }
        for (const capability of required) {
          const decision = matchlockDispatchDecision(raw, {
            workflowId,
            harnessType: harness,
            // Out of closure: exactly this one declared capability is absent.
            availableCapabilities: required.filter((c) => c !== capability),
          });
          assert.equal(
            decision.refused,
            true,
            `${harness} x ${workflowId} must be refused when ${capability} is unavailable`,
          );
          if (decision.refused) {
            assert.equal(decision.code, "matchlock_workflow_unsupported");
            assert.match(decision.message, /unavailable capability/);
            assert.match(decision.message, new RegExp(capability));
            assert.ok(decision.policy, "an out-of-closure refusal still parses the policy");
          }
        }
        // In closure: the full backend capability set admits the cell for
        // every harness (the accepted matrix).
        const full = matchlockDispatchDecision(raw, {
          workflowId,
          harnessType: harness,
          availableCapabilities: MATCHLOCK_AVAILABLE_CAPABILITIES,
        });
        assert.equal(
          full.refused,
          false,
          `${harness} x ${workflowId} must be admitted with its full closure`,
        );
      }
    }
  });

  it("accepts a hermes/dsh merge cell exactly like pi even when every capability is available", () => {
    for (const harness of HARNESSES) {
      const raw = serializeMatchlockPolicy(policyFor(harness));
      for (const workflowId of MERGE_WORKFLOWS) {
        const decision = matchlockDispatchDecision(raw, {
          workflowId,
          harnessType: harness,
          // Full backend capability set: admitted per harness parity.
          availableCapabilities: ["guest-git", "guest-test-suite", "merge-branch", "run-queries"],
        });
        assert.equal(decision.refused, false, `${harness} x ${workflowId} must be admitted`);
      }
    }
  });

  it("every accepted cell reaches exactly its harness-keyed runner; every refused cell reaches none", async () => {
    const counters = installRouteSpies();
    try {
      for (const harness of HARNESSES) {
        const policy = policyFor(harness);
        const raw = serializeMatchlockPolicy(policy);
        for (const workflowId of [...SHAPE_MATRIX, ...REFUSED_WORKFLOWS]) {
          counters.pi = 0;
          counters.hermes = 0;
          counters.dsh = 0;
          const outcome = await dispatchLikeScheduler(
            raw,
            { workflowId, harnessType: harness },
            roundFor(policy, workflowId),
          );
          if (acceptedFor(harness, workflowId)) {
            assert.equal(outcome.refused, false, `${harness} x ${workflowId}`);
            assert.equal(outcome.routed, true, `${harness} x ${workflowId} must route`);
            assert.equal(
              counters[matchlockProductionRunnerKind(policy)],
              1,
              `${harness} x ${workflowId} must reach exactly its harness-keyed runner`,
            );
            assert.equal(
              counters.pi + counters.hermes + counters.dsh,
              1,
              `${harness} x ${workflowId} must reach exactly one runner`,
            );
          } else {
            assert.equal(outcome.refused, true, `${harness} x ${workflowId} must be refused`);
            assert.equal(outcome.routed, false, `${harness} x ${workflowId} must not route`);
            assert.equal(
              counters.pi + counters.hermes + counters.dsh,
              0,
              `${harness} x ${workflowId} refusal must precede any runner/probe/spawn/VM`,
            );
          }
        }
      }
    } finally {
      clearRouteSpies();
    }
  });

  it("every accepted merge cell builds the host merge context/services; each harness forwards it on its runner round", async () => {
    // Every capability-closed merge cell is accepted for every harness (US-003).
    for (const harness of HARNESSES) {
      assert.equal(acceptedFor(harness, "feature-dev-merge-worktree"), true);
    }

    const finalizeMergeStepId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const contextFor = (harness: Harness) =>
      buildMatchlockMergeContext({
        policy: policyFor(harness),
        runId: "run-11111111-1111-4111-8111-111111111111",
        runContext: { original_branch: "main" },
        finalizeMergeStepId,
      });
    const context = contextFor("pi");
    assert.ok(context, "an accepted merge workflow must build a host merge context");
    assert.equal(context.runId, "11111111-1111-4111-8111-111111111111");
    assert.equal(context.originalRepositoryRoot, "/srv/repo");
    assert.equal(context.originalBranch, "main");
    assert.equal(context.finalizeMergeStepId, finalizeMergeStepId);

    const services = createMergeServiceForContext(context);
    assert.equal(typeof services.authorize, "function", "merge services are built");
    assert.equal(typeof services.report, "function", "merge services are built");

    // Each harness's runner round carries that exact context to its
    // harness-keyed runner (where the production runner turns it into the
    // broker's HostMergeServices via createMergeServiceForContext).
    for (const harness of HARNESSES) {
      const harnessContext = contextFor(harness);
      assert.ok(harnessContext, `${harness} must build a host merge context`);
      let observed: MatchlockSchedulerRound | undefined;
      setMatchlockProductionRouteRunnerForTest(harness, async (r) => {
        observed = r;
        return { output: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1, stderrTail: "" };
      });
      try {
        await runMatchlockSchedulerRound({
          ...roundFor(policyFor(harness), "feature-dev-merge-worktree"),
          merge: harnessContext,
        });
      } finally {
        setMatchlockProductionRouteRunnerForTest(harness, null);
      }
      assert.equal(
        observed?.merge,
        harnessContext,
        `the accepted ${harness} merge round forwards the host merge context`,
      );
    }

    // Every merge shape declares the merge-branch capability.
    for (const workflowId of MERGE_WORKFLOWS) {
      assert.equal(matchlockWorkflowRequiresCapability(workflowId, "merge-branch"), true);
    }
  });

  it("the production merge seam is wired for pi, hermes AND dsh (MTLK-ALL-WORKFLOWS US-001/US-002)", () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const read = (rel: string): string =>
      fs.readFileSync(path.join(repoRoot, "src", "installer", "matchlock", rel), "utf-8");

    // The pi invocation runner forwards the merge service to the broker.
    assert.match(
      read("pi-invocation-runner.ts"),
      /\.\.\.\(mergeService \? \{ merge: mergeService \} : \{\}\)/,
      "pi must forward HostMergeServices to createHostBroker",
    );
    // MTLK-ALL-WORKFLOWS US-001: the hermes invocation runner now forwards the
    // host-attested merge service option verbatim (same seam as pi).
    assert.match(
      read("hermes-invocation-runner.ts"),
      /\.\.\.\(opts\.merge \? \{ merge: opts\.merge \} : \{\}\)/,
      "hermes must forward HostMergeServices to createHostBroker",
    );
    // MTLK-ALL-WORKFLOWS US-002: the dsh scheduler route now carries the
    // host-attested merge context, converts it with createMergeServiceForContext
    // and forwards it into runDshInvocation (whose opts spread reaches
    // createHostBroker). The dsh invocation runner itself stays free of a
    // direct merge/HostMergeServices reference — the scheduler route owns the
    // conversion, mirroring pi/hermes.
    assert.doesNotMatch(
      read("dsh-invocation-runner.ts"),
      /merge\s*:\s*mergeService|HostMergeServices/,
      "dsh-invocation-runner.ts must keep no direct merge/HostMergeServices reference",
    );
    // ...but its opts spread is the conduit that carries the scheduler-built
    // service into the shared pi runner, which forwards it to createHostBroker.
    assert.match(
      read("dsh-invocation-runner.ts"),
      /runMatchlockInvocation\(\{[\s\S]*?\.\.\.opts/,
      "runDshInvocation must spread its opts (carrying merge) into runMatchlockInvocation",
    );
    assert.match(
      read("scheduler-dsh.ts"),
      /merge\?: HostMergeContext/,
      "DshSchedulerRound must carry the host merge context",
    );
    assert.match(
      read("scheduler-dsh.ts"),
      /\.\.\.\(round\.merge \? \{ merge: createMergeServiceForContext\(round\.merge\) \} : \{\}\)/,
      "the dsh production runner must convert round.merge with createMergeServiceForContext and forward it",
    );
    assert.match(
      read("scheduler-matchlock.ts"),
      /\.\.\.\(round\.merge \? \{ merge: round\.merge \} : \{\}\)/,
      "toDshSchedulerRound must forward the host merge context to the dsh route",
    );
  });
});
