/**
 * capabilities.ts — MTLK-WORKFLOWS US-008: workflow capability admission.
 * MTLK-ALL-WORKFLOWS US-004: explicit per-shape closure + precise refusals.
 *
 * The Matchlock dispatch barrier is not a name allowlist. A workflow is only
 * dispatchable when EVERY later-role tool/resource it is known to use is
 * actually provided by the integrated backend (guest helper pack + host
 * broker + invocation runner). This module is the single declarative source
 * of truth for:
 *
 *   - the capability vocabulary the backend can provide (`guest-git`,
 *     `guest-test-suite`, `merge-branch`, `run-queries`);
 *   - the capability set each ADMITTED workflow requires across its full
 *     pipeline (planner/setup/developer/verifier/tester/reviewer/merger);
 *   - the exact missing capability or unsupported mechanism for every other
 *     BUNDLED workflow shape, so a refusal is workflow-specific and names the
 *     precise tool/mechanism the backend cannot serve (never a blanket
 *     "admitted workflows are …" list);
 *   - the missing-capability computation the dispatch guard consumes to
 *     refuse a workflow BEFORE any probe/findBinary/spawn or VM create.
 *
 * The module is pure (no I/O, no native imports) so it can be consumed by the
 * dispatch guard, the scheduler seam and tests without side effects.
 *
 * Backend mapping (what each capability means):
 *   - `guest-git`        the RW-mounted repository/worktree lets the guest run
 *                        real `git` (commit/rebase) in its own VM; the guest
 *                        CLI + shared merge core never shell out on the host.
 *   - `guest-test-suite` the packed `tamandua-test` shim records real
 *                        integer-exit evidence rows in the host-owned suite
 *                        store (US-003/US-006), so the tester role's TEST_CMD
 *                        runs and the finalizer ledger gate can accept it.
 *   - `merge-branch`     the US-007 scoped `merge.authorize`/`merge.report`
 *                        bridge ops + the US-008 production host merge service
 *                        (`createHostMergeService`) with a host merge context
 *                        built from immutable run scope.
 *   - `run-queries`      the US-004 bounded run-scoped `step.stories` /
 *                        `workflow.status` / `logs.run` bridge ops, used by
 *                        story-based workflows to inspect progress.
 */

/** A guest/host tool+resource set a workflow's later roles depend on. */
export type MatchlockCapability =
  | "guest-git"
  | "guest-test-suite"
  | "merge-branch"
  | "run-queries";

/** Every capability the integrated Matchlock backend provides in this build. */
export const MATCHLOCK_AVAILABLE_CAPABILITIES: readonly MatchlockCapability[] = [
  "guest-git",
  "guest-test-suite",
  "merge-branch",
  "run-queries",
];

/**
 * Required capability closure per ADMITTED workflow id.
 *
 * An id absent from this map is not admitted by capability closure: it is
 * either declared refused below (`MATCHLOCK_REFUSED_WORKFLOWS`, with a precise
 * reason) or unknown/custom (the dispatch guard's fail-closed fallback).
 *
 * Every bundled workflow shape is enumerated explicitly — there is no blanket
 * allow-list. The shallow do-now / do-review-do-verify workflows keep an empty
 * requirement set so their existing dispatch decisions are byte-identical.
 *
 * Story/worktree pipelines (`feature-dev*`, `bug-fix*`,
 * `quarantine-broken-tests*`, `security-audit*`) set up a branch and commit
 * with guest git, run TEST_CMD through the packed suite shim and inspect run
 * progress with the bounded query ops, so they declare the closure
 * `guest-git + guest-test-suite + run-queries`. Their `*-merge` variants add
 * `merge-branch` for the finalizer's scoped landing.
 */
export const MATCHLOCK_WORKFLOW_CAPABILITIES: Readonly<
  Record<string, readonly MatchlockCapability[]>
> = {
  "do-now": [],
  "do-review-do-verify": [],
  // Non-merge story/worktree pipelines: branch + commit, TEST_CMD evidence and
  // bounded run progress queries (no finalizer, so no merge-branch).
  "feature-dev": ["guest-git", "guest-test-suite", "run-queries"],
  "feature-dev-worktree": ["guest-git", "guest-test-suite", "run-queries"],
  "bug-fix": ["guest-git", "guest-test-suite", "run-queries"],
  "bug-fix-worktree": ["guest-git", "guest-test-suite", "run-queries"],
  "quarantine-broken-tests": ["guest-git", "guest-test-suite", "run-queries"],
  "security-audit": ["guest-git", "guest-test-suite", "run-queries"],
  "security-audit-worktree": ["guest-git", "guest-test-suite", "run-queries"],
  // Merge routes: the full later-role closure plus the scoped merge branch.
  // feature-dev-merge / bug-fix-merge are capability-equivalent DIRECT routes:
  // identical agents/steps to the worktree variants, with the original
  // repository supplied by the run context ({{repo}} / original_branch)
  // instead of a managed worktree.
  "feature-dev-merge": ["guest-git", "guest-test-suite", "merge-branch", "run-queries"],
  "feature-dev-merge-worktree": ["guest-git", "guest-test-suite", "merge-branch", "run-queries"],
  "bug-fix-merge": ["guest-git", "guest-test-suite", "merge-branch", "run-queries"],
  "bug-fix-merge-worktree": ["guest-git", "guest-test-suite", "merge-branch", "run-queries"],
  "quarantine-broken-tests-merge": [
    "guest-git",
    "guest-test-suite",
    "merge-branch",
    "run-queries",
  ],
  "quarantine-broken-tests-merge-worktree": [
    "guest-git",
    "guest-test-suite",
    "merge-branch",
    "run-queries",
  ],
  "security-audit-merge": ["guest-git", "guest-test-suite", "merge-branch", "run-queries"],
  "security-audit-merge-worktree": [
    "guest-git",
    "guest-test-suite",
    "merge-branch",
    "run-queries",
  ],
};

/** Workflow ids the integrated backend can dispatch (declaration order). */
export const MATCHLOCK_SUPPORTED_WORKFLOW_IDS: readonly string[] = Object.keys(
  MATCHLOCK_WORKFLOW_CAPABILITIES,
);

/**
 * The exact missing capability or unsupported mechanism behind a bundled
 * workflow shape this build cannot serve. There is deliberately NO new
 * `MatchlockCapability` for these: the integrated backend does not provide
 * them, so they are refused with a specific class rather than a fabricated
 * capability that could later be "removed" from a fake matrix.
 */
export type MatchlockWorkflowRefusalCode =
  | "guest-github-cli"
  | "browser-visual-verification"
  | "child-workflow-dispatch"
  | "unscoped-host-filesystem";

/** A workflow-specific refusal: the precise reason a bundled shape is refused. */
export interface MatchlockWorkflowRefusal {
  /** Stable class naming the exact missing capability/mechanism. */
  code: MatchlockWorkflowRefusalCode;
  /** Human-readable reason naming the exact missing capability/mechanism. */
  reason: string;
}

/**
 * Explicit per-shape refusal for every BUNDLED workflow id the integrated
 * backend cannot serve. Each entry names the exact missing capability or
 * unsupported mechanism — never the generic admitted-list message. A bundled
 * id that appears neither here nor in `MATCHLOCK_WORKFLOW_CAPABILITIES` is a
 * coverage bug (the dispatch-guard test enumerates `workflows/` to prove it
 * cannot happen).
 */
export const MATCHLOCK_REFUSED_WORKFLOWS: Readonly<
  Record<string, MatchlockWorkflowRefusal>
> = {
  "feature-dev-github-pr": {
    code: "guest-github-cli",
    reason:
      "PR creation requires a guest GitHub CLI (`gh`) plus deliberately provisioned remote auth and network access, which the integrated guest backend does not provide",
  },
  "bug-fix-github-pr": {
    code: "guest-github-cli",
    reason:
      "PR creation requires a guest GitHub CLI (`gh`) plus deliberately provisioned remote auth and network access, which the integrated guest backend does not provide",
  },
  "security-audit-github-pr": {
    code: "guest-github-cli",
    reason:
      "PR creation requires a guest GitHub CLI (`gh`) plus deliberately provisioned remote auth and network access, which the integrated guest backend does not provide",
  },
  "frontend-test": {
    code: "browser-visual-verification",
    reason:
      "frontend/browser visual verification requires a guest browser tool/driver and its OS libraries, which the integrated guest backend does not provide",
  },
  "just-do-it": {
    code: "child-workflow-dispatch",
    reason:
      "the dispatcher creates bounded child workflow runs (`workflow list` / `workflow run`), a child-dispatch mechanism the integrated guest backend does not implement",
  },
  "skills-normalize-audit": {
    code: "unscoped-host-filesystem",
    reason:
      "it scans an operator-specified skills directory outside the run's admitted original root, which the scoped guest mount plan does not serve",
  },
};

/** Bundled workflow ids this build refuses (declaration order). */
export const MATCHLOCK_REFUSED_WORKFLOW_IDS: readonly string[] = Object.keys(
  MATCHLOCK_REFUSED_WORKFLOWS,
);

/**
 * Every bundled workflow id this build recognizes: the admitted set plus the
 * explicitly refused set. Pinned by the dispatch-guard matrix test against the
 * real `workflows/` directory, so a new bundled workflow must be classified
 * here deliberately.
 */
export const MATCHLOCK_BUNDLED_WORKFLOW_IDS: readonly string[] = [
  ...MATCHLOCK_SUPPORTED_WORKFLOW_IDS,
  ...MATCHLOCK_REFUSED_WORKFLOW_IDS,
];

/** The declared required-capability closure for an admitted workflow, else null. */
export function matchlockWorkflowCapabilities(
  workflowId: string | undefined,
): readonly MatchlockCapability[] | null {
  if (!workflowId) return null;
  return MATCHLOCK_WORKFLOW_CAPABILITIES[workflowId] ?? null;
}

/** True when an admitted workflow's closure includes `capability`. */
export function matchlockWorkflowRequiresCapability(
  workflowId: string | undefined,
  capability: MatchlockCapability,
): boolean {
  return matchlockWorkflowCapabilities(workflowId)?.includes(capability) ?? false;
}

/**
 * The precise refusal for a bundled-but-unsupported workflow, else null. A
 * non-null result names the exact missing capability/mechanism; null means the
 * id is either admitted or unknown/custom (the guard's fail-closed fallback).
 */
export function matchlockWorkflowRefusal(
  workflowId: string | undefined,
): MatchlockWorkflowRefusal | null {
  if (!workflowId) return null;
  return MATCHLOCK_REFUSED_WORKFLOWS[workflowId] ?? null;
}

/**
 * Capabilities required by `workflowId` but ABSENT from `available`. An
 * unknown/refused workflow id yields [] (the admission gate owns that
 * refusal). `available` defaults to the full integrated backend set; tests may
 * inject a reduced set to prove the preflight refuses before any VM.
 */
export function matchlockMissingCapabilities(
  workflowId: string | undefined,
  available: readonly MatchlockCapability[] = MATCHLOCK_AVAILABLE_CAPABILITIES,
): MatchlockCapability[] {
  const required = matchlockWorkflowCapabilities(workflowId);
  if (!required || required.length === 0) return [];
  const have = new Set(available);
  return required.filter((capability) => !have.has(capability));
}

/** Stable, human-readable label for a missing-capability refusal. */
export function formatMatchlockCapabilityList(capabilities: readonly MatchlockCapability[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "(none)";
}

/**
 * Harness capability axis (MTLK-ALL-WORKFLOWS US-003): there is NO
 * harness-by-workflow allow-list.
 *
 * The capability closure above is harness-independent — it declares what a
 * workflow's later roles need from the shared guest/broker backend — and the
 * round seams are now harness-agnostic: pi, hermes and dsh each forward the
 * host merge context/service into the broker (MTLK-ALL-WORKFLOWS US-001/
 * US-002). Admission is therefore purely workflow + capability closure; a
 * harness can execute exactly the workflows the integrated backend admits.
 *
 * `matchlockHarnessSupportsWorkflow` is retained as a thin delegate to the
 * global admission set so callers/tests that ask "can this harness drive this
 * workflow" get the same answer for every harness. It no longer encodes any
 * per-harness restriction. An absent/unknown harness or workflow still fails
 * closed.
 */
export function matchlockHarnessSupportsWorkflow(
  harness: string | undefined,
  workflowId: string | undefined,
): boolean {
  if (!harness || !workflowId) return false;
  return MATCHLOCK_SUPPORTED_WORKFLOW_IDS.includes(workflowId);
}
