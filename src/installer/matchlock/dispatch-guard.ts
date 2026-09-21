/**
 * dispatch-guard.ts — MTLK-ADMIT: the Matchlock dispatch admission barrier.
 *
 * Narrow, explicit fail-closed gate consulted BEFORE the launch-time probe and
 * BEFORE ordinary host harness resolution/spawn for a run that carries a
 * persisted Matchlock policy.
 *
 * Since the pi execution backend integration (MTLK-PI-EXEC US-001/US-002), the
 * Hermes backend wiring (MTLK-HERMES-EXEC US-003), the dsh backend wiring
 * (MTLK-DSH-EXEC), the workflow-parity capability closure (MTLK-WORKFLOWS
 * US-008) and the harness-parity lift (MTLK-ALL-WORKFLOWS US-003) the gate's
 * job is:
 *   - a VALID pinned (version-2) policy on a SUPPORTED workflow shape whose
 *     declared later-role capability closure is provided by the backend →
 *     ALLOWED: the run dispatches through the Matchlock invocation runner
 *     (probe AND work) for the pinned harness (pi, hermes or dsh), never
 *     through a native adapter/probe/findBinary/spawn;
 *   - a VALID pinned policy on an UNSUPPORTED workflow, or one whose required
 *     capability set the backend does not provide → refusal
 *     (`matchlock_workflow_unsupported`) BEFORE any native probe/findBinary/
 *     spawn or VM create — the run is never dispatched natively and no fake
 *     success is produced;
 *   - a run whose CONTEXT-selected harness differs from the pinned policy's
 *     harness → refusal before any effects (inconsistent selection);
 *   - a MALFORMED / LEGACY (unpinned) / unsupported stored policy → refusal
 *     with an actionable message — it must never look like a working isolated
 *     run and never fall back to native.
 *
 * A NULL policy (native runs) is always allowed and this module performs no
 * Matchlock discovery/parsing side effects beyond the pure parse of a
 * non-null stored string. No-flag runs therefore never resolve Matchlock and
 * never alter argv/env/process behavior.
 */

import {
  MatchlockPolicyError,
  parseMatchlockPolicy,
  type ExecutionIsolation,
} from "./policy.js";
import {
  formatMatchlockCapabilityList,
  MATCHLOCK_AVAILABLE_CAPABILITIES,
  matchlockMissingCapabilities,
  matchlockWorkflowRefusal,
  MATCHLOCK_SUPPORTED_WORKFLOW_IDS,
  type MatchlockCapability,
} from "./capabilities.js";

/**
 * Workflow shapes whose full dispatch pipeline is supported by the integrated
 * Matchlock backend in this build. Derived from the explicit per-shape
 * capability closure in `capabilities.ts` (MTLK-ALL-WORKFLOWS US-004):
 *   - do-now (execute) and do-review-do-verify (execute → review → re-execute
 *     → verify);
 *   - the non-merge story/worktree pipelines (feature-dev, feature-dev-worktree,
 *     bug-fix, bug-fix-worktree, quarantine-broken-tests, security-audit,
 *     security-audit-worktree) with guest git, packed suite evidence and
 *     bounded run queries;
 *   - every merge route (feature-dev-merge[-worktree], bug-fix-merge[-worktree],
 *     quarantine-broken-tests-merge[-worktree], security-audit-merge[-worktree])
 *     plus the capability-equivalent direct routes, with the scoped merge
 *     branch added.
 *
 * Every OTHER bundled shape is refused with a workflow-specific precise reason
 * (`MATCHLOCK_REFUSED_WORKFLOWS`: `*-github-pr` guest gh, `just-do-it` child
 * dispatch, `frontend-test` browser/visual verification,
 * `skills-normalize-audit` unscoped host filesystem), and an unknown/custom id
 * fails closed — all BEFORE any probe/findBinary/spawn/VM. An unsupported
 * pipeline must never pretend to run isolated.
 */
export const MATCHLOCK_SUPPORTED_WORKFLOWS: readonly string[] = MATCHLOCK_SUPPORTED_WORKFLOW_IDS;

/**
 * Supported-workflow capability gate. `undefined` (the guard has no workflow
 * id at the decision point) is treated as unsupported — fail closed.
 */
export function matchlockSupportsWorkflow(workflowId: string | undefined): boolean {
  return workflowId !== undefined && MATCHLOCK_SUPPORTED_WORKFLOWS.includes(workflowId);
}

export interface MatchlockDispatchRefusal {
  refused: true;
  /**
   * Refusal class:
   *  - backend_not_integrated          — a valid pinned policy but the
   *    execution backend is not integrated in this build (retained for
   *    negative-path tests / builds without the runner);
   *  - matchlock_workflow_unsupported  — valid pinned policy whose workflow
   *    capability is not supported by the integrated backend;
   *  - matchlock_policy_invalid        — malformed / legacy-unpinned /
   *    structurally invalid stored record.
   */
  code:
    | "backend_not_integrated"
    | "matchlock_workflow_unsupported"
    | "matchlock_policy_invalid";
  /** Actionable message recorded as the run's failure reason. */
  message: string;
  /** Parsed policy when the stored record itself is valid. */
  policy?: ExecutionIsolation;
}

export interface MatchlockDispatchAllowed {
  refused: false;
  /** Parsed valid pinned policy for a supported shape (absent for NULL/empty policies). */
  policy?: ExecutionIsolation;
}

export type MatchlockDispatchDecision = MatchlockDispatchRefusal | MatchlockDispatchAllowed;

/** Decision-point context beyond the stored record (all optional; fail closed when absent). */
export interface MatchlockDispatchContext {
  /**
   * The run's workflow id (scheduler `job.workflowId`). Determines whether
   * the requested workflow capability is supported by the integrated
   * backend. Absent ⇒ fail closed (unsupported).
   */
  workflowId?: string;
  /**
   * The run's selected harness type. `pi`, `hermes` and `dsh` are all
   * admitted with the persisted policy; a run whose context selects a
   * DIFFERENT harness than the pinned policy is an inconsistent selection and
   * is refused.
   */
  harnessType?: string;
  /**
   * US-008: the capability set the integrated backend can actually provide
   * for this round. Defaults to the full backend set
   * (`MATCHLOCK_AVAILABLE_CAPABILITIES`). A workflow whose declared later-role
   * closure is not a subset is refused BEFORE any probe/VM; tests inject a
   * reduced set to prove the preflight.
   */
  availableCapabilities?: readonly MatchlockCapability[];
}

/**
 * Evaluate a persisted `runs.matchlock_policy` string for dispatch admission.
 * `null`/empty ⇒ native run ⇒ allowed (no Matchlock consulted). A non-null
 * value is parsed strictly; a valid pinned policy is allowed ONLY when the
 * requested workflow is admitted and its declared later-role capability
 * closure is provided by the integrated backend, for every harness
 * (pi/hermes/dsh). Every other non-null outcome is a refusal.
 */
export function matchlockDispatchDecision(
  rawPolicy: string | null,
  ctx?: MatchlockDispatchContext,
): MatchlockDispatchDecision {
  if (!rawPolicy || rawPolicy.trim() === "") {
    return { refused: false };
  }
  let policy: ExecutionIsolation;
  try {
    policy = parseMatchlockPolicy(rawPolicy);
  } catch (err) {
    const code =
      err instanceof MatchlockPolicyError ? err.code : "policy_invalid_record";
    const detail = err instanceof Error ? err.message : String(err);
    return {
      refused: true,
      code: "matchlock_policy_invalid",
      message:
        `Stored Matchlock policy is not a usable isolated-run record (${code}): ${detail} ` +
        "The run must never look like a working isolated run and never fall back to native execution. " +
        "Recreate the run with --matchlock so admission persists a pinned content+config identity.",
    };
  }
  // A valid pinned policy is real Matchlock work. The execution backend IS
  // integrated in this build for pi, hermes and dsh, so admission depends on
  // the requested workflow + its capability closure (harness-independent).
  // Anything else is refused BEFORE any native probe/findBinary/spawn and
  // before any VM create.
  const shortDigest =
    policy.resolvedImageDigest && policy.resolvedImageDigest.length > 12
      ? policy.resolvedImageDigest.slice(0, 12)
      : policy.resolvedImageDigest ?? "<unpinned>";

  // Harness consistency axis: the persisted record parses with harness "pi",
  // "hermes" or "dsh" (policy.ts enforces it). A run whose CONTEXT selected a
  // DIFFERENT harness while carrying the policy is an inconsistent selection —
  // refuse closed before any probe/findBinary/spawn/VM. The message names the
  // policy harness generically so every source contract's assertion
  // (pi/hermes/dsh) still holds.
  const harnessType = ctx?.harnessType?.trim();
  if (harnessType !== undefined && harnessType !== "" && harnessType !== policy.harness) {
    const backendLabel =
      policy.harness === "pi"
        ? "the pi harness"
        : policy.harness === "hermes"
          ? "the hermes harness"
          : "the dsh harness";
    const launchHint =
      policy.harness === "pi"
        ? "Launch the run with --pi-as-harness (the default) for Matchlock, or remove --matchlock for a native run."
        : policy.harness === "hermes"
          ? "Launch the run with --hermes-as-harness --matchlock for the Hermes backend, or remove --matchlock for a native run."
          : "Launch the run with --dsh-as-harness for this Matchlock policy, or remove --matchlock for a native run.";
    return {
      refused: true,
      code: "matchlock_workflow_unsupported",
      policy,
      message:
        `Matchlock execution policy harness "${policy.harness}" (only supported with ${backendLabel} in this build), but this run selected ` +
        `harness "${harnessType}" while carrying the pinned Matchlock policy (image "${policy.requestedImage}", ` +
        `content ${shortDigest}…). Refusing before any native probe/harness and before any VM create. ` +
        launchHint,
    };
  }

  // Harness x workflow axis (MTLK-ALL-WORKFLOWS US-003): there is no
  // per-harness workflow allow-list. Now that all three round seams forward
  // the host merge context/service, every admitted workflow is executable by
  // pi, hermes and dsh alike, so admission is purely workflow + capability
  // closure. dsh/hermes fall through to the SAME workflow + capability
  // preflight as pi below. The harness-CONSISTENCY check above (context
  // harness must match the pinned policy harness) is unchanged and still
  // refuses a mismatched selection before any probe/findBinary/spawn/VM.

  if (!matchlockSupportsWorkflow(ctx?.workflowId)) {
    const workflowLabel = ctx?.workflowId ? `"${ctx.workflowId}"` : "<unknown>";
    // MTLK-ALL-WORKFLOWS US-004: a BUNDLED-but-unsupported shape gets a
    // workflow-specific refusal naming the exact missing capability/mechanism
    // (never the generic admitted-list message). Only a genuinely
    // unknown/custom id falls through to the fail-closed generic refusal.
    const knownRefusal =
      ctx?.workflowId !== undefined ? matchlockWorkflowRefusal(ctx.workflowId) : null;
    if (knownRefusal) {
      return {
        refused: true,
        code: "matchlock_workflow_unsupported",
        policy,
        message:
          `Matchlock execution is not supported for workflow ${workflowLabel} in this build: ` +
          `${knownRefusal.reason} (refusal class ${knownRefusal.code}). The run carries a pinned ` +
          `Matchlock policy (image "${policy.requestedImage}", content ${shortDigest}…) and is refused ` +
          `before any native probe/findBinary/spawn and before any VM create — no native execution and ` +
          `no fake success. Remove --matchlock for a native run, or use an admitted workflow.`,
      };
    }
    const supported = MATCHLOCK_SUPPORTED_WORKFLOWS.join(", ");
    return {
      refused: true,
      code: "matchlock_workflow_unsupported",
      policy,
      message:
        `Matchlock execution is not supported for workflow ${workflowLabel} in this build: the admitted ` +
        `workflows are ${supported}. The run carries a pinned Matchlock policy (image "${policy.requestedImage}", ` +
        `content ${shortDigest}…) and is refused before any native probe/findBinary/spawn and before any VM ` +
        `create — no native execution and no fake success. Remove --matchlock for a native run, or use an ` +
        `admitted workflow.`,
    };
  }

  // US-008 capability preflight: admitting a workflow id is not enough — every
  // later-role tool/resource the pipeline declares must be provided by the
  // integrated backend. An absent capability set refuses HERE, before any
  // probe/findBinary/spawn and before any VM create.
  const missingCapabilities = matchlockMissingCapabilities(
    ctx?.workflowId,
    ctx?.availableCapabilities,
  );
  if (missingCapabilities.length > 0) {
    const workflowLabel = ctx?.workflowId ? `"${ctx.workflowId}"` : "<unknown>";
    const available = ctx?.availableCapabilities ?? MATCHLOCK_AVAILABLE_CAPABILITIES;
    return {
      refused: true,
      code: "matchlock_workflow_unsupported",
      policy,
      message:
        `Matchlock execution is not supported for workflow ${workflowLabel} in this build: the workflow requires ` +
        `unavailable capability ${formatMatchlockCapabilityList(missingCapabilities)} (backend provides ` +
        `formatMatchlockCapabilityList(available)). The run carries a pinned Matchlock policy (image ` +
        `"${policy.requestedImage}", content ${shortDigest}…) and is refused before any native probe/harness ` +
        `spawn and before any VM create — no native execution and no fake success.`,
    };
  }

  return { refused: false, policy };
}

/** Convenience boolean gate (scheduler uses the full decision above). */
export function matchlockDispatchRefusal(
  rawPolicy: string | null,
  ctx?: MatchlockDispatchContext,
): MatchlockDispatchDecision {
  return matchlockDispatchDecision(rawPolicy, ctx);
}
