/**
 * MTLK-ISO-SLICE2 US-013: the shared top-level `warnings` channel.
 *
 * Spec C §4.6 and spec B §4.6 define ONE advisory channel every JSON surface
 * may carry: a top-level `warnings` array of `{ code, message }` entries,
 * PRESENT only when non-empty (absent — never `[]` — on a clean run). Text
 * mode prints the same entries to stderr as bounded one-liners.
 *
 * Warnings are advisory only: never a status change, never an exit-code
 * change, never a substitute for a typed refusal, and never a secret. This
 * module is a dependency-free leaf so every surface (run, status, resume,
 * control plane) can share it without an import cycle.
 *
 * First users:
 *  - `root_usage_override` — the persisted/admitted Matchlock policy records
 *    `rootUsageConsent === true` (the R13 override was supplied or consent was
 *    inherited). The message states root execution is AUTHORIZED; a non-root
 *    caller may also record consent, so it NEVER claims execution occurred as
 *    root.
 *  - `consent_granted_on_resume` — THIS resume granted root consent.
 */

export type WorkflowWarningCode =
  | "root_usage_override"
  | "consent_granted_on_resume";

export interface WorkflowWarning {
  code: WorkflowWarningCode;
  message: string;
}

/** Facts from which the shared warning entries are derived. */
export interface WorkflowWarningFacts {
  /**
   * The persisted/admitted Matchlock policy records `rootUsageConsent === true`
   * (supplied to this action or inherited verbatim).
   */
  rootUsageConsent?: boolean;
  /**
   * THIS resume granted root consent (the override flipped a
   * previously-unconsented policy). A resume that only inherited recorded
   * consent leaves this false.
   */
  consentGrantedOnResume?: boolean;
}

export const ROOT_USAGE_OVERRIDE_CODE = "root_usage_override" as const;
export const CONSENT_GRANTED_ON_RESUME_CODE = "consent_granted_on_resume" as const;

/**
 * Bounded, single-line messages. They state only that root execution is
 * AUTHORIZED and deliberately never claim that execution occurred as root
 * (a non-root caller may record consent).
 */
export const ROOT_USAGE_OVERRIDE_MESSAGE =
  "root execution is AUTHORIZED for this Matchlock run (the R13 root-usage override was supplied or rootUsageConsent was inherited); this warning records the authorization only, not actual root execution";

export const CONSENT_GRANTED_ON_RESUME_MESSAGE =
  "root execution consent was granted on this resume; root execution is AUTHORIZED for this Matchlock run (the granting caller may be non-root)";

/**
 * Derive the shared warning entries from the given facts. Returns an array
 * that is EMPTY on a clean run — callers must add the top-level `warnings`
 * key only when it is non-empty (use {@link withWorkflowWarnings}).
 *
 * `consent_granted_on_resume` takes precedence over `root_usage_override` for
 * the SAME granting action so a consent-granting resume does not emit two
 * entries for one fact.
 */
export function buildWorkflowWarnings(
  facts: WorkflowWarningFacts = {},
): WorkflowWarning[] {
  const warnings: WorkflowWarning[] = [];
  if (facts.consentGrantedOnResume === true) {
    warnings.push({
      code: CONSENT_GRANTED_ON_RESUME_CODE,
      message: CONSENT_GRANTED_ON_RESUME_MESSAGE,
    });
  } else if (facts.rootUsageConsent === true) {
    warnings.push({
      code: ROOT_USAGE_OVERRIDE_CODE,
      message: ROOT_USAGE_OVERRIDE_MESSAGE,
    });
  }
  return warnings;
}

/**
 * Attach the `warnings` key to a JSON document ONLY when there is at least one
 * entry, so a clean run stays absent (never `[]`). The returned object is the
 * input unchanged when there is nothing to report.
 */
export function withWorkflowWarnings<T extends Record<string, unknown>>(
  output: T,
  warnings: WorkflowWarning[],
): T {
  if (warnings.length === 0) return output;
  return {
    ...output,
    warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
  };
}

/**
 * Bounded one-line text rendering for stderr. The message is collapsed to a
 * single line so a warning can never smuggle a newline into the operator's
 * terminal.
 */
export function formatWorkflowWarningLine(warning: WorkflowWarning): string {
  const oneLine = warning.message.replace(/\s+/g, " ").trim();
  return `warning[${warning.code}]: ${oneLine}`;
}

/** Print the shared warning entries to stderr as bounded one-liners. */
export function writeWorkflowWarningsToStderr(warnings: WorkflowWarning[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${formatWorkflowWarningLine(warning)}\n`);
  }
}

/**
 * Narrow an untrusted JSON array (e.g. a control-plane response body or a
 * `ResumeResult`) back into the typed shared vocabulary. Entries that do not
 * match the shape are dropped rather than surfaced half-formed.
 */
export function parseWorkflowWarnings(raw: unknown): WorkflowWarning[] {
  if (!Array.isArray(raw)) return [];
  const warnings: WorkflowWarning[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const code = (entry as { code?: unknown }).code;
    const message = (entry as { message?: unknown }).message;
    if (
      (code === ROOT_USAGE_OVERRIDE_CODE || code === CONSENT_GRANTED_ON_RESUME_CODE) &&
      typeof message === "string" &&
      message.length > 0
    ) {
      warnings.push({ code, message });
    }
  }
  return warnings;
}
