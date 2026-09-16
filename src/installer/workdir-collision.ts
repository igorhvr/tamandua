/**
 * Shared harness-working-directory collision policy (WORKDIR-FLAGS).
 *
 * A *direct* run occupies its harness working directory (the checkout it runs
 * in) for as long as it is live. Worktree-mode runs each register their own
 * per-run worktree, so they never collide. When a second direct run targets a
 * directory already held by a live run, the caller must choose a policy:
 *
 *   - `refuse` (default): reject the launch with a distinct exit code and an
 *     actionable message naming the holder and the three ways out.
 *   - `queue`: keep today's `waiting` scheduling state and admit the run when
 *     the holder releases the directory.
 *   - `allow`: run concurrently now; concurrent git writes in one checkout are
 *     the caller's responsibility.
 *
 * This module is the SINGLE source of truth for the policy resolution and the
 * exact refusal/warning text. It is deliberately pure (no DB, no
 * child_process, no network) so daemon, CLI and docs can all import the same
 * constants and cannot drift.
 */

/** Run-context key that persists the chosen collision policy on a run. */
export const WORKDIR_COLLISION_POLICY_KEY = "workdir_collision_policy";

/** The three collision policies. `refuse` is the default. */
export type WorkdirCollisionPolicy = "refuse" | "queue" | "allow";

/** CLI exit code when a launch is refused because the workdir is held. */
export const WORKDIR_REFUSAL_EXIT_CODE = 75;

/** Admission response `state` for a refused launch. */
export const WORKDIR_REFUSAL_STATE = "refused";

/** Environment form of the `allow` policy. */
export const WORKDIR_ALLOW_ENV_VAR = "TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR";

/** Daemon log marker for a collision admitted under the `allow` policy. */
export const WORKDIR_SHARED_WARNING_MARKER =
  "control-server: register-run shared harness workdir allowed";

/**
 * Parse a raw policy string. Returns the policy ONLY for the three exact valid
 * strings; anything else — including `undefined`, empty, a differently-cased
 * or padded variant, or a non-string — yields `undefined` so callers can fall
 * through to the environment default.
 */
export function parseWorkdirCollisionPolicy(
  raw: unknown,
): WorkdirCollisionPolicy | undefined {
  if (raw === "refuse" || raw === "queue" || raw === "allow") return raw;
  return undefined;
}

/**
 * Resolve the effective collision policy.
 *
 * A valid persisted context value (the run's own choice) always wins. Only
 * when the context key is absent or invalid does the environment fallback
 * apply: `TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1` is exactly the environment
 * form of `allow`. Everything else resolves to `refuse`.
 */
export function resolveWorkdirCollisionPolicy(
  context: Record<string, string>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): WorkdirCollisionPolicy {
  const fromContext = parseWorkdirCollisionPolicy(
    context?.[WORKDIR_COLLISION_POLICY_KEY],
  );
  if (fromContext) return fromContext;
  if (env?.[WORKDIR_ALLOW_ENV_VAR] === "1") return "allow";
  return "refuse";
}

/** Identity of the live run currently holding a harness working directory. */
export interface WorkdirCollisionHolder {
  runId: string;
  /** Human-facing run number; `null` when the run row is missing/unnumbered. */
  runNumber: number | null;
  workflowId: string;
  status: string;
  /** When the holder started holding the directory (ISO timestamp). */
  since: string;
}

/**
 * Refusal headline template. `{dir}` and the holder fields are substituted by
 * `formatWorkdirRefusalMessage`; `#{runNumber}` is replaced by `#<n>` for a
 * numbered run, or by the raw `runId` when the number is unknown.
 */
export const WORKDIR_REFUSAL_HEADLINE_TEMPLATE =
  "Cannot start run: harness working directory {dir} is already held by run #{runNumber} ({workflowId}, status {status}, since {since}).";

/** The three ways out, appended verbatim after the refusal headline. */
export const WORKDIR_REFUSAL_OPTIONS_TEXT =
  "Retry later once the holder finishes, or:\n" +
  "  --queue-behind-holder  queue this run and admit it when the holder releases the directory\n" +
  "  --allow-multiple-runs-in-one-working-directory  run concurrently now; concurrent git writes in one checkout are your responsibility\n" +
  "  TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1  environment form of the allow flag\n" +
  "Worktree workflow variants (-worktree) never collide: each run gets its own worktree.";

/** Uniform one-line warning shown whenever a collision is admitted. */
export const WORKDIR_SHARED_WARNING_TEMPLATE =
  "Warning: sharing harness working directory {dir} with another live run; concurrent git writes are the caller's responsibility.";

/**
 * Build the full refusal message: an actionable headline naming the holder,
 * followed by the shared options text. When the holder's run number is
 * unknown the run id is substituted instead, and the literal `null` is never
 * printed.
 */
export function formatWorkdirRefusalMessage(
  holder: WorkdirCollisionHolder,
  dir: string,
): string {
  const holderLabel =
    holder.runNumber === null ? holder.runId : `#${holder.runNumber}`;
  const headline = WORKDIR_REFUSAL_HEADLINE_TEMPLATE.replace(
    "#{runNumber}",
    holderLabel,
  )
    .replace("{dir}", dir)
    .replace("{workflowId}", holder.workflowId)
    .replace("{status}", holder.status)
    .replace("{since}", holder.since);
  return `${headline}\n${WORKDIR_REFUSAL_OPTIONS_TEXT}`;
}

/**
 * One-line uniform warning emitted when a collision is admitted under the
 * `allow` policy. Deliberately workflow-agnostic: merge workflows get the
 * same warning as any other workflow.
 */
export function formatSharedWorkdirWarning(dir: string): string {
  return WORKDIR_SHARED_WARNING_TEMPLATE.replace("{dir}", dir);
}
