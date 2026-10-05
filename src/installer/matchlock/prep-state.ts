/**
 * prep-state.ts — MTLK-ISO-SLICE2 (US-005): PREP-STATE isolation intent.
 *
 * Spec C §10 item 7 ("Isolation-preparation ordering", DECIDED — PREP-STATE)
 * requires an opted-in run to persist the isolation INTENT and an initial
 * non-schedulable hold ATOMICALLY with the first `runs` row INSERT, BEFORE the
 * pinned Matchlock policy exists. Without it, an interrupted admission leaves a
 * row that recovery machinery treats as an ordinary native-schedulable run.
 *
 * ── Persistence path (dedicated column, not run-context JSON) ──────────────
 * Spec C §10 item 7 PREFERS the run-context JSON home only when the marker is
 * (a) host-controlled, (b) written in the same insert, (c) preserved by every
 * subsequent context update and (d) honored by every scheduling path. The
 * run-context home CANNOT guarantee all four here:
 *   - host-control: `RunWorkflowParams.context` (the operator's `--context`)
 *     is spread into the seeded context BEFORE host code, and step output can
 *     merge arbitrary keys back into `runs.context` (step-ops `RESERVED_CONTEXT_KEYS`
 *     would have to be extended). A user key would therefore be able to SET the
 *     marker on a native run — a step-ops behavior change this slice does not own.
 *   - preservation: `runs.context` is rewritten by 10+ call sites
 *     (`UPDATE runs SET context` in run.ts/step-ops.ts); no single writer
 *     enforces the marker survives. The spec asks for a guarantee, not a survey.
 *   - older binary: an older daemon reads `runs.context` and would ignore an
 *     unknown JSON key.
 * The dedicated nullable `runs.isolation_intent` column is therefore the honest
 * home (spec C §10 item 7 explicitly provides for it): it is host-controlled by
 * construction (only `initialRunIsolationState()` writes it, from a host-derived
 * boolean), written in the SAME first INSERT, immune to every context rewrite,
 * and readable by every new-binary scheduling path.
 *
 * ── Older-binary non-schedulability ────────────────────────────────────────
 * The INTENT marker is new-binary-only, so non-schedulability must not rest on
 * it. MTLK-ISO2-MEND (Family D, D-MARKER) therefore makes the ATOMIC first
 * INSERT carry a hold the LEGACY reader already honors: the opted-in row seeds
 * `scheduling_status = DRAINING_PAUSE_SCHEDULING_STATUS` ("draining_pause") AND
 * the run-context `pause_drain='true'` marker. The immutable pre-PREP-STATE
 * reader (9f167705) returns `{state:'draining_pause'}` without admission from
 * BOTH explicit registration (`handleRegisterRun`) and the nudge loop (which
 * routes through that same guard), never selects `draining_pause` in its
 * reconciler query, and a legacy failed-run resume's running/pending_register
 * write never clears the marker. A new binary reclassifies the held row as
 * `preparing` (via `isIntentOnlyHeldRun`, checked BEFORE the drain/paused guard)
 * and records {@link PREPARING_SCHEDULING_STATUS} when it re-holds. Plain
 * "preparing" is insufficient: legacy registration/nudge ignore
 * `scheduling_status` and would admit it. See
 * `legacy-prep-state-exclusion.test.ts` for the executed legacy-handler proof.
 * The deployment restriction in PREP_STATE_DEPLOYMENT_RESTRICTION (this line is
 * slice 2 of 3 and MUST NOT be deployed to any host until slice 3 lands and the
 * coordinator refreshes the two tracked host contract copies) remains in force
 * for the enforced capability layer.
 *
 * This module is a LEAF: it imports only the strict policy parser so the
 * scheduler, control-server, run.ts and status can all import it without a
 * cycle.
 */

import { parseMatchlockPolicy } from "./policy.js";

/** The dedicated host-owned `runs` column carrying the isolation intent. */
export const ISOLATION_INTENT_COLUMN = "isolation_intent";

/** The only value ever written to {@link ISOLATION_INTENT_COLUMN}. */
export const ISOLATION_INTENT_RECORDED = "true";

/**
 * The initial non-schedulable hold written ATOMICALLY with an opted-in run's
 * first INSERT. A value the legacy reconciler query does not select (see the
 * module doc); the run becomes schedulable only after admission persists the
 * validated policy.
 */
export const PREPARING_SCHEDULING_STATUS = "preparing";

/** The ordinary initial state for a native (no opt-in) run — unchanged. */
export const NATIVE_SCHEDULING_STATUS = "pending_register";

/**
 * MTLK-ISO2-MEND (Family D, D-MARKER): the legacy-honored hold value written
 * for an OPPED-IN run's first INSERT. The supported (pre-PREP-STATE) reader
 * already treats this as non-schedulable: `handleRegisterRun` returns
 * `{state:'draining_pause'}` without admission, the nudge loop routes through
 * that same guard, the legacy reconciler query EXCLUDES `draining_pause`, and
 * a legacy `resumeWorkflow` running/pending_register write never clears it.
 */
export const DRAINING_PAUSE_SCHEDULING_STATUS = "draining_pause";

/**
 * The context key that carries the legacy-honored pause/drain hold. Written
 * atomically with an opted-in run's first INSERT so an older daemon honors the
 * hold on BOTH explicit registration and the nudge loop.
 */
export const PAUSE_DRAIN_CONTEXT_KEY = "pause_drain";

/**
 * The `scheduling_status` values the reconciler treats as admitted-or-retriable
 * (mirrors the `desired` query in control-server `reconcileOnce`). A
 * `PREPARING_SCHEDULING_STATUS` row is deliberately absent: it is held until
 * admission persists the policy.
 */
export const SCHEDULABLE_SCHEDULING_STATUSES: readonly string[] = [
  "pending_register",
  "active",
  "error",
  "waiting",
];

/**
 * ENFORCED deployment restriction (spec C §9): this line is slice 2 of 3 of
 * the coordinated MTLK-ISO landing. A daemon built before this slice cannot
 * interpret {@link ISOLATION_INTENT_COLUMN}; it must never coexist with a
 * live or resumable intent-recorded run. The coordinator restarts the daemon
 * on the sliced build as part of landing, and the line "MUST NOT be deployed
 * to any host until slice 3 lands and the coordinator refreshes the two
 * tracked host contract copies".
 */
export const PREP_STATE_DEPLOYMENT_RESTRICTION =
  "MTLK-ISO-SLICE2 PREP-STATE: this slice MUST NOT be deployed to any host until slice 3 lands and " +
  "the coordinator refreshes the two tracked host contract copies (spec C §9 / spec B §8). No mixed-version " +
  "daemon may coexist with an intent-recorded run; the daemon must be restarted on this build.";

/**
 * MTLK-ISO2-CORRECTIVE (Finding D, D-enforce): the PREP-STATE capability token
 * advertised by a daemon that understands the dedicated `runs.isolation_intent`
 * column and the initial `preparing` hold. The control client REQUIRES this
 * token before it will create/register/resume an intent-recorded run, so a
 * pre-PREP-STATE daemon can never coexist with an intent-only row. This is the
 * real runtime enforcement of {@link PREP_STATE_DEPLOYMENT_RESTRICTION}.
 */
export const PREP_STATE_CAPABILITY = "MTLK-ISO-SLICE2-PREP-STATE";

/** The ordered isolation display classification (spec C §4.6). */
export type IsolationState = "native" | "preparing" | "isolated" | "unusable";

/**
 * MTLK-ISO-SLICE2 US-008: the shared operator-facing remedy text for an
 * intent-only (preparation-held) run. Names the held/preparing state and the
 * retry/recreate remedy so resume, replacement and the dashboard all refuse
 * native treatment with the same vocabulary (spec C §4.4 / §4.7 / §10 item 7).
 */
export function isolationPreparingHeldText(): string {
  return (
    "the Matchlock isolation intent is recorded but no pinned policy has been persisted yet, " +
    "so it is held non-schedulable (preparing) and must never run natively. " +
    "Remedy: retry preparation, or recreate the run with the Matchlock opt-in (--matchlock)."
  );
}

/** The minimum run-row shape the reader/classifier needs. */
export interface IsolationIntentRow {
  isolation_intent?: string | null;
  matchlock_policy?: string | null;
}

/** The three host-controlled values written by the first `runs` INSERT. */
export interface InitialRunIsolationState {
  schedulingStatus: string;
  schedulingRequestedAt: string | null;
  isolationIntent: string | null;
  /**
   * MTLK-ISO2-MEND (Family D): host-controlled context keys seeded ATOMICALLY
   * with the first INSERT. An opted-in run seeds the legacy-honored
   * `pause_drain='true'` hold; a native run seeds nothing.
   */
  contextSeed: Record<string, string>;
}

/**
 * Host-controlled writer: the isolation-intent column value for a fresh run.
 * Only the host's own opt-in decision (a `--matchlock` image or an inherited
 * policy) produces {@link ISOLATION_INTENT_RECORDED}; every other input — and
 * every `--context`/step-output value — yields NULL.
 */
export function isolationIntentValue(optedIn: boolean): string | null {
  return optedIn ? ISOLATION_INTENT_RECORDED : null;
}

/**
 * Host-controlled writer for the ATOMICALLY-persisted initial isolation state.
 * An opted-in run starts HELD (`scheduling_status = preparing`, no
 * `scheduling_requested_at`, intent recorded); a native run keeps the exact
 * pre-PREP-STATE shape (`pending_register`, `scheduling_requested_at = now`,
 * no marker).
 */
export function initialRunIsolationState(
  optedIn: boolean,
  now: string,
): InitialRunIsolationState {
  if (optedIn) {
    return {
      schedulingStatus: DRAINING_PAUSE_SCHEDULING_STATUS,
      schedulingRequestedAt: now,
      isolationIntent: ISOLATION_INTENT_RECORDED,
      contextSeed: { [PAUSE_DRAIN_CONTEXT_KEY]: "true" },
    };
  }
  return {
    schedulingStatus: NATIVE_SCHEDULING_STATUS,
    schedulingRequestedAt: now,
    isolationIntent: null,
    contextSeed: {},
  };
}

/**
 * Reader: true when the row carries the host-owned isolation intent marker.
 * Classifies the column explicitly (`=== ISOLATION_INTENT_RECORDED`), never by
 * truthiness.
 */
export function readIsolationIntent(row: IsolationIntentRow | null | undefined): boolean {
  if (!row) return false;
  const raw = row[ISOLATION_INTENT_COLUMN];
  return raw === ISOLATION_INTENT_RECORDED;
}

function policyParses(policyRaw: string): boolean {
  try {
    parseMatchlockPolicy(policyRaw);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ordered, deterministic four-state classification (spec C §4.6):
 *   1. a non-NULL policy is inspected FIRST — parses → `isolated`, does not
 *      parse → `unusable` (empty string, invalid JSON, legacy/unpinned,
 *      credential-bearing, unsupported version);
 *   2. only a NULL/absent policy consults the recorded intent — present →
 *      `preparing`, absent → `native`.
 *
 * The policy test is explicit non-NULL (`!== null && !== undefined`), never
 * truthiness, so an empty-string policy can never render as native.
 */
export function classifyIsolationState(
  intent: boolean,
  policyRaw: string | null | undefined,
): IsolationState {
  if (policyRaw !== null && policyRaw !== undefined) {
    return policyParses(policyRaw) ? "isolated" : "unusable";
  }
  return intent ? "preparing" : "native";
}

/** Row-level convenience: classify a run row from its intent + raw policy. */
export function readIsolationState(
  row: IsolationIntentRow | null | undefined,
): IsolationState {
  if (!row) return "native";
  return classifyIsolationState(readIsolationIntent(row), row.matchlock_policy ?? null);
}

/**
 * True when a `scheduling_status` is admitted or retriable by the reconciler.
 * `PREPARING_SCHEDULING_STATUS` is NOT schedulable; an intent-recorded run
 * stays held until admission persists its policy.
 */
export function isSchedulableSchedulingStatus(status: string | null | undefined): boolean {
  return status === null || status === undefined || SCHEDULABLE_SCHEDULING_STATUSES.includes(status);
}
