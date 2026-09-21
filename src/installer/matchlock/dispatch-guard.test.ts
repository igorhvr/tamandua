import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMatchlockPolicy,
  serializeMatchlockPolicy,
} from "../../../dist/installer/matchlock/policy.js";
import {
  matchlockDispatchDecision,
  MATCHLOCK_SUPPORTED_WORKFLOWS,
  matchlockSupportsWorkflow,
} from "../../../dist/installer/matchlock/dispatch-guard.js";
import {
  MATCHLOCK_AVAILABLE_CAPABILITIES,
  MATCHLOCK_BUNDLED_WORKFLOW_IDS,
  MATCHLOCK_REFUSED_WORKFLOWS,
  MATCHLOCK_REFUSED_WORKFLOW_IDS,
  MATCHLOCK_WORKFLOW_CAPABILITIES,
  matchlockHarnessSupportsWorkflow,
  matchlockMissingCapabilities,
  matchlockWorkflowCapabilities,
  matchlockWorkflowRefusal,
  matchlockWorkflowRequiresCapability,
} from "../../../dist/installer/matchlock/capabilities.js";

const PIN = {
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  config_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tag: "vic/ml:latest",
};

const BASE = {
  requestedImage: "vic/ml:latest",
  identity: PIN,
  harness: "pi" as const,
  workingDirectory: "/opt/project",
  originalRepositoryRoot: "/opt/project",
  workMounts: [
    { hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" },
  ],
  gitMetadataRoots: [],
};

// MTLK-HERMES-EXEC US-003: a persisted hermes opt-in (harness "hermes" with
// the FROZEN submission inputs + the resolved Hermes configuration trio).
const HERMES_BASE = {
  ...BASE,
  harness: "hermes" as const,
  configurationRoot: "/home/operator/.hermes",
  configurationProfile: "default",
  guestConfigurationRoot: "/workspace/config/hermes",
  hermes: { homeDir: "/home/operator", cwd: "/opt/project", hermesHomeEnv: null as string | null },
};

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** Every workflow id actually shipped under `workflows/` (the coverage oracle). */
function bundledWorkflowIdsOnDisk(): string[] {
  const workflowsDir = path.join(REPO_ROOT, "workflows");
  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(workflowsDir, entry.name, "workflow.yml")),
    )
    .map((entry) => entry.name)
    .sort();
}

describe("matchlock dispatch admission barrier", () => {
  it("allows a NULL (native) policy without consulting Matchlock", () => {
    const decision = matchlockDispatchDecision(null);
    assert.deepEqual(decision, { refused: false });
  });

  it("allows an empty-string policy (treated as native)", () => {
    assert.deepEqual(matchlockDispatchDecision(""), { refused: false });
    assert.deepEqual(matchlockDispatchDecision("   "), { refused: false });
  });

  // MTLK-HERMES-EXEC union MTLK-DSH-EXEC union MTLK-WORKFLOWS union
  // MTLK-ALL-WORKFLOWS US-004: the admitted set is every bundled shape whose
  // explicit capability closure the backend serves — the shallow, non-merge
  // story/worktree and every merge route.
  it("advertises the supported workflow capability closure (full explicit per-shape admitted set, US-004)", () => {
    assert.deepEqual([...MATCHLOCK_SUPPORTED_WORKFLOWS].sort(), [
      "bug-fix",
      "bug-fix-merge",
      "bug-fix-merge-worktree",
      "bug-fix-worktree",
      "do-now",
      "do-review-do-verify",
      "feature-dev",
      "feature-dev-merge",
      "feature-dev-merge-worktree",
      "feature-dev-worktree",
      "quarantine-broken-tests",
      "quarantine-broken-tests-merge",
      "quarantine-broken-tests-merge-worktree",
      "security-audit",
      "security-audit-merge",
      "security-audit-merge-worktree",
      "security-audit-worktree",
    ].sort());
    for (const workflowId of MATCHLOCK_SUPPORTED_WORKFLOWS) {
      assert.equal(matchlockSupportsWorkflow(workflowId), true, `${workflowId} must be admitted`);
    }
    // Bundled-but-refused and unknown ids are NOT in the admitted set.
    for (const workflowId of MATCHLOCK_REFUSED_WORKFLOW_IDS) {
      assert.equal(
        matchlockSupportsWorkflow(workflowId),
        false,
        `${workflowId} must not be admitted`,
      );
    }
    assert.equal(matchlockSupportsWorkflow("custom-in-house-workflow"), false);
    assert.equal(matchlockSupportsWorkflow(undefined), false);
  });

  const NON_MERGE_STORY_SHAPES = [
    "feature-dev",
    "feature-dev-worktree",
    "bug-fix",
    "bug-fix-worktree",
    "quarantine-broken-tests",
    "security-audit",
    "security-audit-worktree",
  ];
  const MERGE_SHAPES = [
    "feature-dev-merge",
    "feature-dev-merge-worktree",
    "bug-fix-merge",
    "bug-fix-merge-worktree",
    "quarantine-broken-tests-merge",
    "quarantine-broken-tests-merge-worktree",
    "security-audit-merge",
    "security-audit-merge-worktree",
  ];

  it("declares an explicit closure for every admitted shape: shallow empty, story/worktree git+suite+queries, merge plus merge-branch", () => {
    assert.deepEqual(matchlockWorkflowCapabilities("do-now"), []);
    assert.deepEqual(matchlockWorkflowCapabilities("do-review-do-verify"), []);
    for (const id of NON_MERGE_STORY_SHAPES) {
      assert.deepEqual(
        [...(matchlockWorkflowCapabilities(id) ?? [])].sort(),
        ["guest-git", "guest-test-suite", "run-queries"].sort(),
        `${id} must declare the non-merge story closure`,
      );
      assert.equal(matchlockWorkflowRequiresCapability(id, "merge-branch"), false);
    }
    for (const id of MERGE_SHAPES) {
      assert.deepEqual(
        [...(matchlockWorkflowCapabilities(id) ?? [])].sort(),
        ["guest-git", "guest-test-suite", "merge-branch", "run-queries"].sort(),
        `${id} must declare the full merge closure`,
      );
      assert.equal(matchlockWorkflowRequiresCapability(id, "merge-branch"), true);
    }
    // Refused bundled shapes declare no closure (they are refused precisely).
    for (const id of MATCHLOCK_REFUSED_WORKFLOW_IDS) {
      assert.equal(matchlockWorkflowCapabilities(id), null, `${id} must not declare a closure`);
      assert.equal(matchlockWorkflowRequiresCapability(id, "merge-branch"), false);
      assert.notEqual(matchlockWorkflowRefusal(id), null, `${id} must carry a precise refusal`);
    }
    assert.equal(matchlockWorkflowCapabilities("custom-in-house-workflow"), null);
    assert.equal(matchlockWorkflowRefusal("custom-in-house-workflow"), null);
  });

  it("classifies every workflow id shipped under workflows/ — no bundled id falls through (US-004)", () => {
    const onDisk = bundledWorkflowIdsOnDisk();
    assert.deepEqual(
      [...MATCHLOCK_BUNDLED_WORKFLOW_IDS].sort(),
      onDisk,
      "MATCHLOCK_BUNDLED_WORKFLOW_IDS must exactly match the bundled workflows/ directory",
    );
    for (const id of onDisk) {
      const admitted = matchlockSupportsWorkflow(id);
      const refusal = matchlockWorkflowRefusal(id);
      assert.equal(
        admitted || refusal !== null,
        true,
        `bundled workflow ${id} must be either admitted or precisely refused`,
      );
      assert.equal(
        admitted && refusal !== null,
        false,
        `bundled workflow ${id} cannot be both admitted and refused`,
      );
    }
    // No overlap and no duplicate between the two declared halves.
    const admitted = new Set(MATCHLOCK_SUPPORTED_WORKFLOWS);
    for (const id of MATCHLOCK_REFUSED_WORKFLOW_IDS) {
      assert.equal(admitted.has(id), false, `${id} must not be in both sets`);
    }
  });

  it("computes missing capabilities against the integrated backend set and a reduced set", () => {
    assert.deepEqual(matchlockMissingCapabilities("feature-dev-merge-worktree"), []);
    assert.deepEqual(
      matchlockMissingCapabilities("feature-dev-merge-worktree", [
        "guest-git",
        "run-queries",
      ]),
      ["guest-test-suite", "merge-branch"],
    );
    assert.deepEqual(
      matchlockMissingCapabilities("security-audit", ["guest-git", "run-queries"]),
      ["guest-test-suite"],
    );
    // Refused/unknown workflows declare no closure => [] (the admission gate
    // owns that refusal with a precise reason).
    assert.deepEqual(matchlockMissingCapabilities("just-do-it", []), []);
    // do-now declares no capability, so even an empty backend admits it.
    assert.deepEqual(matchlockMissingCapabilities("do-now", []), []);
    assert.deepEqual(
      [...MATCHLOCK_AVAILABLE_CAPABILITIES].sort(),
      ["guest-git", "guest-test-suite", "merge-branch", "run-queries"].sort(),
    );
    assert.deepEqual(Object.keys(MATCHLOCK_WORKFLOW_CAPABILITIES).length, 17);
    assert.deepEqual(Object.keys(MATCHLOCK_REFUSED_WORKFLOWS).length, 6);
  });

  it("ALLOWS a VALID pinned policy on a SUPPORTED workflow (pi do-now) — backend integrated", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "do-now",
      harnessType: "pi",
    });
    assert.equal(decision.refused, false);
    if (decision.refused) return;
    assert.equal(decision.policy?.requestedImage, "vic/ml:latest");
    assert.equal(decision.policy?.resolvedImageDigest, PIN.digest);
  });

  it("ALLOWS a VALID pinned policy on do-review-do-verify", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "do-review-do-verify",
    });
    assert.equal(decision.refused, false);
  });

  // MTLK-HERMES-EXEC union MTLK-DSH-EXEC union MTLK-WORKFLOWS union
  // MTLK-ALL-WORKFLOWS US-004: the MTLK-HERMES-EXEC and MTLK-DSH-EXEC
  // contracts asserted `feature-dev-merge-worktree` itself was refused here.
  // MTLK-WORKFLOWS admits that id, so the union (MTLK-INTEGRATE US-004)
  // rewrote it to just-do-it; US-004 now refuses that BUNDLED-but-unsupported
  // shape with its own precise mechanism, never the generic admitted-list
  // message.
  it("REFUSES a VALID pinned policy on an UNSUPPORTED workflow (just-do-it child dispatch) with its precise mechanism before any effects", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "just-do-it",
      harnessType: "pi",
    });
    assert.equal(decision.refused, true);
    if (decision.refused) {
      assert.equal(decision.code, "matchlock_workflow_unsupported");
      assert.ok(decision.message.includes("just-do-it"));
      assert.match(decision.message, /child workflow runs/);
      assert.match(decision.message, /refusal class child-workflow-dispatch/);
      assert.doesNotMatch(decision.message, /the admitted workflows are/);
      assert.match(decision.message, /before any native probe\/findBinary\/spawn/);
      assert.equal(decision.policy?.requestedImage, "vic/ml:latest");
    }
  });

  it("REFUSES every github-pr/browser/skills-audit bundled shape with a workflow-specific precise reason", () => {
    const policy = buildMatchlockPolicy(BASE);
    const raw = serializeMatchlockPolicy(policy);
    const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["feature-dev-github-pr", "guest-github-cli", /guest GitHub CLI \(`gh`\)/],
      ["bug-fix-github-pr", "guest-github-cli", /guest GitHub CLI \(`gh`\)/],
      ["security-audit-github-pr", "guest-github-cli", /guest GitHub CLI \(`gh`\)/],
      ["frontend-test", "browser-visual-verification", /browser tool\/driver/],
      [
        "skills-normalize-audit",
        "unscoped-host-filesystem",
        /skills directory outside the run's admitted original root/,
      ],
    ];
    for (const [workflowId, code, pattern] of cases) {
      const decision = matchlockDispatchDecision(raw, { workflowId, harnessType: "pi" });
      assert.equal(decision.refused, true, `${workflowId} must be refused`);
      if (!decision.refused) continue;
      assert.equal(decision.code, "matchlock_workflow_unsupported");
      assert.ok(decision.message.includes(workflowId), `${workflowId} must be named`);
      assert.match(decision.message, pattern, `${workflowId} must name its missing mechanism`);
      assert.match(decision.message, new RegExp(`refusal class ${code}`));
      // Never the blanket admitted-pi list.
      assert.doesNotMatch(decision.message, /the admitted workflows are/);
      assert.match(decision.message, /before any native probe\/findBinary\/spawn/);
    }
  });

  it("REFUSES a genuinely unknown/custom workflow with the fail-closed admitted-list message", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "custom-in-house-workflow",
      harnessType: "pi",
    });
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_workflow_unsupported");
    assert.match(decision.message, /the admitted workflows are/);
    assert.match(decision.message, /feature-dev-merge-worktree/);
    assert.doesNotMatch(decision.message, /refusal class/);
  });

  it("ADMITS the merge worktree + direct routes on a valid pinned policy (full capability closure)", () => {
    const policy = buildMatchlockPolicy(BASE);
    const raw = serializeMatchlockPolicy(policy);
    for (const workflowId of [
      "feature-dev-merge-worktree",
      "bug-fix-merge-worktree",
      "feature-dev-merge",
      "bug-fix-merge",
    ]) {
      const decision = matchlockDispatchDecision(raw, { workflowId, harnessType: "pi" });
      assert.equal(decision.refused, false, `${workflowId} must be admitted`);
      if (!decision.refused) {
        assert.equal(decision.policy?.requestedImage, "vic/ml:latest");
      }
    }
  });

  it("per-id admission matrix: every bundled shape is admitted by default or refused with its exact reason", () => {
    const policy = buildMatchlockPolicy(BASE);
    const raw = serializeMatchlockPolicy(policy);
    for (const workflowId of MATCHLOCK_SUPPORTED_WORKFLOWS) {
      const decision = matchlockDispatchDecision(raw, { workflowId, harnessType: "pi" });
      assert.equal(decision.refused, false, `admitted ${workflowId} must dispatch`);
    }
    for (const workflowId of MATCHLOCK_REFUSED_WORKFLOW_IDS) {
      const refusal = matchlockWorkflowRefusal(workflowId);
      assert.notEqual(refusal, null);
      const decision = matchlockDispatchDecision(raw, { workflowId, harnessType: "pi" });
      assert.equal(decision.refused, true, `refused ${workflowId} must not dispatch`);
      if (decision.refused && refusal) {
        assert.equal(decision.code, "matchlock_workflow_unsupported");
        assert.ok(decision.message.includes(refusal.reason));
      }
    }
  });

  it("capability-removal matrix: removing a declared capability refuses the shape and names it", () => {
    const policy = buildMatchlockPolicy(BASE);
    const raw = serializeMatchlockPolicy(policy);
    for (const workflowId of MATCHLOCK_SUPPORTED_WORKFLOWS) {
      const required = matchlockWorkflowCapabilities(workflowId) ?? [];
      if (required.length === 0) continue;
      for (const capability of required) {
        const available = required.filter((c) => c !== capability);
        const decision = matchlockDispatchDecision(raw, {
          workflowId,
          harnessType: "pi",
          availableCapabilities: available,
        });
        assert.equal(
          decision.refused,
          true,
          `${workflowId} must be refused when ${capability} is removed`,
        );
        if (decision.refused) {
          assert.equal(decision.code, "matchlock_workflow_unsupported");
          assert.match(decision.message, /unavailable capability/);
          assert.match(decision.message, new RegExp(capability));
        }
      }
    }
  });

  it("REFUSES an admitted merge workflow when a required capability is absent from the backend", () => {
    const policy = buildMatchlockPolicy(BASE);
    const raw = serializeMatchlockPolicy(policy);
    const decision = matchlockDispatchDecision(raw, {
      workflowId: "feature-dev-merge-worktree",
      harnessType: "pi",
      availableCapabilities: ["guest-git", "run-queries"],
    });
    assert.equal(decision.refused, true);
    if (decision.refused) {
      assert.equal(decision.code, "matchlock_workflow_unsupported");
      assert.match(decision.message, /unavailable capability/);
      assert.match(decision.message, /guest-test-suite/);
      assert.match(decision.message, /merge-branch/);
      assert.match(decision.message, /before any native probe\/harness spawn and before any VM create/);
    }
  });

  it("ADMITS an admitted merge workflow whose full capability closure IS provided", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "bug-fix-merge-worktree",
      harnessType: "pi",
      availableCapabilities: ["guest-git", "guest-test-suite", "merge-branch", "run-queries"],
    });
    assert.equal(decision.refused, false);
  });

  it("REFUSES a VALID pinned policy when the workflow id is unknown at the decision point (fail closed)", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {});
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_workflow_unsupported");
    assert.match(decision.message, /<unknown>/);
  });

  it("REFUSES a VALID pinned policy on a run whose context selects a non-pi harness", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "do-now",
      harnessType: "dsh",
    });
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_workflow_unsupported");
    assert.match(decision.message, /only supported with the pi harness/);
  });

  it("refuses a malformed stored policy with an actionable message", () => {
    const decision = matchlockDispatchDecision("{not json");
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_policy_invalid");
    assert.match(decision.message, /policy_json_invalid/);
    assert.match(decision.message, /Recreate the run with --matchlock/);
  });

  it("refuses a LEGACY unpinned (version-1) stored policy (never looks like a working isolated run)", () => {
    const legacy: Record<string, unknown> = { ...BASE };
    delete legacy.identity;
    legacy.version = 1;
    delete legacy.resolvedImageDigest;
    delete legacy.resolvedImageConfigDigest;
    const decision = matchlockDispatchDecision(JSON.stringify(legacy));
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_policy_invalid");
    assert.match(decision.message, /legacy UNPINNED record/);
    assert.match(decision.message, /never look like a working isolated run/);
  });

  it("refuses an unpinned version-2 stored policy", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    delete policy.resolvedImageDigest;
    delete policy.resolvedImageConfigDigest;
    const decision = matchlockDispatchDecision(JSON.stringify(policy));
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_policy_invalid");
    assert.match(decision.message, /resolvedImageDigest is required/);
  });

  // ── MTLK-HERMES-EXEC US-003: hermes harness admission axis ────────────

  it("ALLOWS a VALID harness-hermes policy on do-now and do-review-do-verify when the context harness is hermes (backend wired)", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE);
    for (const workflowId of ["do-now", "do-review-do-verify"]) {
      const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
        workflowId,
        harnessType: "hermes",
      });
      assert.equal(decision.refused, false, `hermes ${workflowId} must dispatch`);
      if (!decision.refused) {
        assert.equal(decision.policy?.harness, "hermes");
        assert.equal(decision.policy?.requestedImage, "vic/ml:latest");
        assert.equal(decision.policy?.configurationRoot, "/home/operator/.hermes");
      }
    }
  });

  // MTLK-ALL-WORKFLOWS US-003: the harness-by-workflow allow-list is lifted.
  // hermes is admitted for every capability-closed workflow the backend can
  // serve, including the merge worktree/direct routes.
  it("ALLOWS a harness-hermes policy on the admitted merge workflows (harness parity, no allow-list)", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE);
    const raw = serializeMatchlockPolicy(policy);
    for (const workflowId of [
      "do-now",
      "do-review-do-verify",
      "feature-dev-merge-worktree",
      "bug-fix-merge-worktree",
      "feature-dev-merge",
      "bug-fix-merge",
    ]) {
      const decision = matchlockDispatchDecision(raw, { workflowId, harnessType: "hermes" });
      assert.equal(decision.refused, false, `hermes ${workflowId} must dispatch`);
      if (!decision.refused) {
        assert.equal(decision.policy?.harness, "hermes");
      }
    }
  });

  it("REFUSES a harness-hermes policy on an UNSUPPORTED workflow BEFORE any probe/VM with matchlock_workflow_unsupported", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "just-do-it",
      harnessType: "hermes",
    });
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_workflow_unsupported");
    assert.match(decision.message, /just-do-it/);
    assert.match(decision.message, /refusal class child-workflow-dispatch/);
    assert.doesNotMatch(decision.message, /the admitted workflows are/);
    assert.equal(decision.policy?.harness, "hermes");
  });

  it("REFUSES a harness-hermes policy when the context harness is pi or dsh (guard fail-closed, no effects)", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE);
    for (const harnessType of ["pi", "dsh"]) {
      const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
        workflowId: "do-now",
        harnessType,
      });
      assert.equal(decision.refused, true, `harness ${harnessType} must be refused against a hermes policy`);
      if (!decision.refused) continue;
      assert.equal(decision.code, "matchlock_workflow_unsupported");
      assert.match(decision.message, /only supported with the hermes harness/);
      assert.match(decision.message, /--hermes-as-harness --matchlock/);
    }
  });

  it("still REFUSES a harness-pi policy when the context harness is hermes (pi route unchanged)", () => {
    const policy = buildMatchlockPolicy(BASE);
    const decision = matchlockDispatchDecision(serializeMatchlockPolicy(policy), {
      workflowId: "do-now",
      harnessType: "hermes",
    });
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_workflow_unsupported");
    assert.match(decision.message, /only supported with the pi harness/);
  });

  // ── MTLK-DSH-EXEC US-002: harness "dsh" admission/refusal matrix ─────

  function dshPolicyJson(): string {
    const record = buildMatchlockPolicy({
      requestedImage: "vic/dsh:latest",
      identity: {
        digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        config_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        tag: "vic/dsh:latest",
      },
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
    });
    return serializeMatchlockPolicy(record);
  }

  it("ALLOWS a VALID pinned harness-dsh policy on do-now and do-review-do-verify with a dsh harness context", () => {
    for (const workflowId of ["do-now", "do-review-do-verify"]) {
      const decision = matchlockDispatchDecision(dshPolicyJson(), {
        workflowId,
        harnessType: "dsh",
      });
      assert.equal(decision.refused, false, `dsh ${workflowId} must dispatch`);
      if (!decision.refused) {
        assert.equal(decision.policy?.harness, "dsh");
      }
    }
  });

  it("REFUSES a pinned harness-dsh policy when the run context selected the pi harness (inconsistent selection, before any effect)", () => {
    const decision = matchlockDispatchDecision(dshPolicyJson(), {
      workflowId: "do-now",
      harnessType: "pi",
    });
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_workflow_unsupported");
    assert.match(decision.message, /only supported with the dsh harness/);
    assert.match(decision.message, /--dsh-as-harness/);
  });

  it("ALLOWS a pinned harness-dsh policy on the merge workflow shapes (harness parity, no allow-list)", () => {
    for (const workflowId of [
      "feature-dev-merge-worktree",
      "bug-fix-merge-worktree",
      "feature-dev-merge",
      "bug-fix-merge",
    ]) {
      const decision = matchlockDispatchDecision(dshPolicyJson(), {
        workflowId,
        harnessType: "dsh",
      });
      assert.equal(decision.refused, false, `dsh ${workflowId} must be admitted`);
      if (!decision.refused) {
        assert.equal(decision.policy?.harness, "dsh");
      }
    }
  });

  it("REFUSES a pinned harness-dsh policy on an unsupported capability (just-do-it child orchestration)", () => {
    const decision = matchlockDispatchDecision(dshPolicyJson(), {
      workflowId: "just-do-it",
      harnessType: "dsh",
    });
    assert.equal(decision.refused, true);
    if (!decision.refused) return;
    assert.equal(decision.code, "matchlock_workflow_unsupported");
  });

  it("pi differential unchanged: a pi policy + pi context still allows and pi + non-pi still refuses", () => {
    const allowed = matchlockDispatchDecision(serializeMatchlockPolicy(buildMatchlockPolicy(BASE)), {
      workflowId: "do-now",
      harnessType: "pi",
    });
    assert.equal(allowed.refused, false);
    const refused = matchlockDispatchDecision(serializeMatchlockPolicy(buildMatchlockPolicy(BASE)), {
      workflowId: "do-now",
      harnessType: "dsh",
    });
    assert.equal(refused.refused, true);
  });

  it("no-flag (NULL policy) decisions remain allowed regardless of harness context", () => {
    assert.deepEqual(matchlockDispatchDecision(null, { workflowId: "do-now", harnessType: "dsh" }), { refused: false });
  });

  // ── UNION-FINAL US-007: cross-harness admission parity ─────────────────
  // The union folds three harness lines (pi, hermes, dsh) that each used to
  // carry their own workflow allow-list. After MTLK-ALL-WORKFLOWS the SAME
  // capability-closure admission must serve ALL three over the merge-worktree
  // shapes and do-now, and the SAME fail-closed refusal must reject
  // unknown/custom ids for all three. This pins that no harness kept a stale,
  // narrower workflow gate during the union reconciliation.
  const UNION_PARITY_WORKFLOWS = [
    "feature-dev-merge-worktree",
    "bug-fix-merge-worktree",
    "security-audit-merge-worktree",
    "do-now",
  ] as const;

  function unionParityPolicies(): Record<"pi" | "hermes" | "dsh", string> {
    return {
      pi: serializeMatchlockPolicy(buildMatchlockPolicy(BASE)),
      hermes: serializeMatchlockPolicy(buildMatchlockPolicy(HERMES_BASE)),
      dsh: dshPolicyJson(),
    };
  }

  it("US-007 union parity: pi/hermes/dsh are admitted over the merge-worktree shapes and do-now", () => {
    const policies = unionParityPolicies();
    for (const harness of ["pi", "hermes", "dsh"] as const) {
      for (const workflowId of UNION_PARITY_WORKFLOWS) {
        const decision = matchlockDispatchDecision(policies[harness], {
          workflowId,
          harnessType: harness,
        });
        assert.equal(decision.refused, false, `${harness} must be admitted for ${workflowId}`);
        if (!decision.refused) {
          assert.equal(decision.policy?.harness, harness, `${harness} ${workflowId}: harness preserved`);
          // The harness-by-workflow delegate answers the SAME for every harness
          // (no per-harness allow-list survives the union).
          assert.equal(
            matchlockHarnessSupportsWorkflow(harness, workflowId),
            true,
            `${harness} delegate must admit ${workflowId}`,
          );
        }
      }
    }
  });

  it("US-007 union parity: every harness refuses an unknown/custom workflow id and an absent harness or workflow fails closed", () => {
    const policies = unionParityPolicies();
    for (const harness of ["pi", "hermes", "dsh"] as const) {
      const decision = matchlockDispatchDecision(policies[harness], {
        workflowId: "custom-in-house-workflow",
        harnessType: harness,
      });
      assert.equal(decision.refused, true, `${harness} must refuse an unknown workflow`);
      if (decision.refused) {
        assert.equal(decision.code, "matchlock_workflow_unsupported");
        assert.match(
          decision.message,
          /the admitted workflows are/,
          `${harness} unknown id must use the fail-closed admitted-list message`,
        );
        assert.match(decision.message, /feature-dev-merge-worktree/);
      }
      // The harness delegate agrees for every harness: unknown/absent fails closed.
      assert.equal(matchlockHarnessSupportsWorkflow(harness, "custom-in-house-workflow"), false);
      assert.equal(matchlockHarnessSupportsWorkflow(harness, undefined), false);
      assert.equal(matchlockHarnessSupportsWorkflow(undefined, "do-now"), false);
    }
  });
});
