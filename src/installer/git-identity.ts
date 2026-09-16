import { spawnSync } from "node:child_process";
import { getDb } from "../db.js";

/**
 * Git commit identity resolution (GIDN).
 *
 * Tamandua must never let a git operation fall back to whatever identity the
 * host process happens to carry (an agent once improvised
 * `Tamandua Matchlock Development <tamandua-matchlock@vaivm.local>` into a
 * repo-local config, and 50 commits reached main authored by it). Instead a
 * single identity is resolved per run and threaded through every harness
 * round and every product-owned git operation.
 *
 * Resolution order (first tier that supplies BOTH a name and an email wins):
 *   (a) env   — GIT_USER_NAME + GIT_USER_EMAIL from the submitting context.
 *   (b) repo-local — `git -C <repoDir> config --local --get user.name|user.email`.
 *   (c) global — `git config --global --get user.name|user.email`, honoring the
 *       supplied env so callers/tests can redirect HOME / GIT_CONFIG_GLOBAL.
 *   (d) fallback — FALLBACK_GIT_IDENTITY.
 *
 * A partial tier (only a name, or only an email) is skipped and resolution
 * continues to the next tier. `git config --system` is never consulted, and
 * this module never writes any git config: resolution is read-only with
 * respect to repository state.
 *
 * Product-owned git operations (worktree creation, merge landings, parking,
 * replacement runs) call `resolveRunGitIdentity`, which first honors the
 * identity persisted on the run context (`run-context`) and otherwise applies
 * the same four-tier order against the landing repository. The host process's
 * ambient identity is never used implicitly.
 *
 * ── Matchlock guest env projection contract ──────────────────────────────
 * Matchlock-backed (in-VM) harness rounds receive the resolved identity
 * through the guest env projection, which MUST forward exactly these four
 * variables:
 *     GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL
 * and MUST NEVER mount or copy a gitconfig into the guest. A mounted
 * gitconfig would reintroduce a second, divergent source of truth and persist
 * an identity the guest is not entitled to. The same four variables are the
 * complete contract for native (non-Matchlock) rounds as well.
 */

export type GitIdentitySource = "env" | "repo-local" | "global" | "fallback" | "run-context";

export interface ResolvedGitIdentity {
  name: string;
  email: string;
  source: GitIdentitySource;
}

/** Identity used when no source supplies both a name and an email. */
export const FALLBACK_GIT_IDENTITY: Readonly<ResolvedGitIdentity> = {
  name: "Tamandua",
  email: "tamandua@tetradactyla.org",
  source: "fallback",
};

/**
 * Run-context keys carrying the resolved identity. Stored on the run context
 * (`runs.context`) so later dispatch rounds and merge landings can recover the
 * exact identity chosen at launch without re-resolving.
 */
export const GIT_IDENTITY_CONTEXT_KEYS = {
  name: "git_identity_name",
  email: "git_identity_email",
  source: "git_identity_source",
} as const;

export interface ResolveGitIdentityOptions {
  /**
   * Repository (or worktree) directory used for the repo-local tier. When
   * omitted or not inside a git work tree, the tier is skipped. Read-only.
   */
  repoDir?: string;
  /**
   * Environment inspected for the env tier and passed to the `git` child
   * processes so callers/tests can redirect HOME / GIT_CONFIG_GLOBAL.
   * Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

const GIT_CONFIG_TIMEOUT_MS = 5_000;

function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read a single `git config` value. `repoDir === undefined` reads the global
 * scope without `-C`. A non-zero exit (including "key not set") yields
 * `undefined` so the caller falls through to the next tier.
 */
function readConfigValue(
  repoDir: string | undefined,
  args: string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const gitArgs = repoDir ? ["-C", repoDir, "config", ...args] : ["config", ...args];
  const result = spawnSync("git", gitArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_CONFIG_TIMEOUT_MS,
    env,
  });
  if (result.status !== 0) return undefined;
  return nonEmpty(result.stdout);
}

/**
 * Resolve exactly ONE commit identity for a run, using the fixed precedence
 * documented at the top of this module.
 */
export function resolveGitIdentity(options: ResolveGitIdentityOptions = {}): ResolvedGitIdentity {
  const env = options.env ?? process.env;
  const repoDir = options.repoDir;

  // (a) Explicit env of the submitting context.
  const envName = nonEmpty(env.GIT_USER_NAME);
  const envEmail = nonEmpty(env.GIT_USER_EMAIL);
  if (envName && envEmail) {
    return { name: envName, email: envEmail, source: "env" };
  }

  // (b) The working repository's local config.
  if (repoDir) {
    const localName = readConfigValue(repoDir, ["--local", "--get", "user.name"], env);
    const localEmail = readConfigValue(repoDir, ["--local", "--get", "user.email"], env);
    if (localName && localEmail) {
      return { name: localName, email: localEmail, source: "repo-local" };
    }
  }

  // (c) The operator's global config.
  const globalName = readConfigValue(undefined, ["--global", "--get", "user.name"], env);
  const globalEmail = readConfigValue(undefined, ["--global", "--get", "user.email"], env);
  if (globalName && globalEmail) {
    return { name: globalName, email: globalEmail, source: "global" };
  }

  // (d) Last resort.
  return { ...FALLBACK_GIT_IDENTITY };
}

/**
 * Read a run's persisted context from the database. Returns `null` when the
 * run row is missing or its context is not valid JSON. Never throws: a
 * run-scoped git operation must fall back to normal resolution (or treat the
 * run as non-Matchlock) rather than fail because the DB was briefly
 * unavailable. Exported so product-owned git operations can inspect other
 * context keys (for example `matchlock_context`) alongside the identity.
 */
export function readRunContextFromDb(runId: string): Record<string, unknown> | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT context FROM runs WHERE id = ?")
      .get(runId) as { context?: string } | undefined;
    if (!row || typeof row.context !== "string") return null;
    const parsed: unknown = JSON.parse(row.context);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface ResolveRunGitIdentityDependencies {
  /**
   * Reads a run's persisted context. Defaults to a `runs.context` DB read;
   * injected in unit tests so the four-source fallback can be exercised
   * without a database.
   */
  readRunContext?: (runId: string) => Record<string, unknown> | null;
}

/**
 * Resolve the identity a product-owned git operation must use (GIDN US-004).
 *
 * When `runId` is non-empty and the run's context carries
 * `git_identity_name` + `git_identity_email` (persisted at launch by US-002),
 * that identity wins with source `run-context` — the run's ONE identity must
 * not be re-derived from whatever config the landing repository happens to
 * carry. Otherwise (a runless manual merge, or a context without the keys)
 * resolution falls through to `resolveGitIdentity` using `repoDir`/`env`.
 */
export function resolveRunGitIdentity(
  runId: string,
  repoDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ResolveRunGitIdentityDependencies = {},
): ResolvedGitIdentity {
  if (runId) {
    const readRunContext = dependencies.readRunContext ?? readRunContextFromDb;
    const fromContext = readGitIdentityFromContext(readRunContext(runId));
    if (fromContext) {
      return { name: fromContext.name, email: fromContext.email, source: "run-context" };
    }
  }
  return resolveGitIdentity({ repoDir, env });
}

/**
 * The four variables every child process (harness round or product-owned git
 * invocation) must carry to author and commit as the resolved identity.
 *
 * Accepts any `{ name, email }` pair so dispatch jobs (which carry only the
 * two fields) can reuse the SAME definition of the four variables rather than
 * duplicating the GIT_AUTHOR / GIT_COMMITTER contract.
 */
export function gitIdentityEnv(identity: Pick<ResolvedGitIdentity, "name" | "email">): {
  GIT_AUTHOR_NAME: string;
  GIT_AUTHOR_EMAIL: string;
  GIT_COMMITTER_NAME: string;
  GIT_COMMITTER_EMAIL: string;
} {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/**
 * Context-record patch carrying the three identity keys. Merge into a run
 * context before persisting it.
 */
export function gitIdentityContextPatch(identity: ResolvedGitIdentity): {
  git_identity_name: string;
  git_identity_email: string;
  git_identity_source: string;
} {
  return {
    [GIT_IDENTITY_CONTEXT_KEYS.name]: identity.name,
    [GIT_IDENTITY_CONTEXT_KEYS.email]: identity.email,
    [GIT_IDENTITY_CONTEXT_KEYS.source]: identity.source,
  };
}

function isGitIdentitySource(value: string): value is GitIdentitySource {
  return (
    value === "env" ||
    value === "repo-local" ||
    value === "global" ||
    value === "fallback" ||
    value === "run-context"
  );
}

/**
 * Read the resolved identity back out of a run context record. Returns `null`
 * when the context does not carry both a name and an email (defensive: a
 * caller must not fabricate an identity from a partial record).
 */
export function readGitIdentityFromContext(
  context: Record<string, unknown> | null | undefined,
): ResolvedGitIdentity | null {
  if (!context || typeof context !== "object") return null;
  const name = nonEmpty(typeof context[GIT_IDENTITY_CONTEXT_KEYS.name] === "string"
    ? (context[GIT_IDENTITY_CONTEXT_KEYS.name] as string)
    : undefined);
  const email = nonEmpty(typeof context[GIT_IDENTITY_CONTEXT_KEYS.email] === "string"
    ? (context[GIT_IDENTITY_CONTEXT_KEYS.email] as string)
    : undefined);
  if (!name || !email) return null;
  const rawSource = context[GIT_IDENTITY_CONTEXT_KEYS.source];
  const source = typeof rawSource === "string" && isGitIdentitySource(rawSource)
    ? rawSource
    : "fallback";
  return { name, email, source };
}
