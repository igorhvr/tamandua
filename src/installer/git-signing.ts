import { spawnSync } from "node:child_process";

/**
 * Commit-signing resolution for product-owned landings (MSIG).
 *
 * A workflow landing (the `commit-tree` squash commit created by
 * `runPlumbingMerge`) must honor the operator's configured commit signing so a
 * signed repository does not silently receive unsigned commits from Tamandua.
 * This module resolves the signing configuration using the SAME source order as
 * the identity resolver (git-identity.ts): the landing repository's local
 * config first, then the operator's global config. `--system` is never
 * consulted and no config is ever written.
 *
 * Each key is read independently per scope — a local `commit.gpgsign=true`
 * combines with a global `gpg.format=ssh` / `user.signingkey` rather than the
 * whole tier coming from one scope — because git config keys naturally merge
 * across scopes per key. `commit.gpgsign` (which may itself be set in global
 * only) is what turns signing on: `enabled` is true only when it parses to a
 * git-true value.
 *
 * ── Matchlock guest-context exemption ────────────────────────────────────
 * Matchlock-backed (in-VM) landings stay unsigned even when `commit.gpgsign`
 * is true: the guest env projection forwards the four GIT_AUTHOR / GIT_COMMITTER
 * variables but NEVER projects signing keys into the guest, so there is nothing
 * to sign with. `isMatchlockGuestContext` (MSIG US-006) gates that exemption at
 * the landing site; this resolver stays a pure description of the config.
 */

export interface ResolveGitSigningConfigOptions {
  /**
   * Landing repository whose local config is consulted first. When omitted or
   * not inside a git work tree the local scope is skipped. Read-only.
   */
  repoDir?: string;
  /**
   * Environment passed to the `git` child processes so callers/tests can
   * redirect HOME / GIT_CONFIG_GLOBAL. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

export interface GitSigningConfig {
  /** True only when `commit.gpgsign` parses to a git-true value. */
  enabled: boolean;
  /** `gpg.format` (`"openpgp"`, `"ssh"`, `"x509"`); absent when unset. */
  format?: string;
  /** `user.signingkey`; absent when unset. */
  signingKey?: string;
}

export const GIT_SIGNING_CONFIG_KEYS = {
  enabled: "commit.gpgsign",
  format: "gpg.format",
  signingKey: "user.signingkey",
} as const;

/**
 * Run-context key marking a run whose harness rounds execute inside a Matchlock
 * guest VM. The external Matchlock launcher sets it at launch (this repository
 * has no Matchlock module; the guest env projection lives in that launcher).
 */
export const MATCHLOCK_CONTEXT_KEY = "matchlock_context";

/**
 * Environment variable the Matchlock guest launcher exports to every in-VM
 * process. Either signal marks a landing as a Matchlock guest context.
 */
export const MATCHLOCK_GUEST_ENV_VAR = "TAMANDUA_MATCHLOCK_GUEST";

/**
 * Machine-readable reason carried on the `merge.landed` event when the
 * Matchlock guest-context exemption (MSIG US-006) intentionally skipped
 * signing. Matchlock guests receive GIT_AUTHOR / GIT_COMMITTER through the
 * guest env projection but NO signing keys are projected into the guest, so an
 * in-VM landing cannot be signed.
 */
export const MATCHLOCK_SIGNING_SKIP_REASON =
  "matchlock-guest context: signing keys are never projected into the Matchlock guest, so the landing stays unsigned";

/**
 * Parse a boolean-ish flag (env var or run-context value). Unlike git boolean
 * parsing, an empty string is NOT true here: an unset/empty flag means "not a
 * Matchlock guest".
 */
function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * True when a landing executes in a Matchlock guest context (MSIG US-006):
 * either the run context carries `matchlock_context=true` (recorded by the
 * Matchlock launcher) or the process env carries `TAMANDUA_MATCHLOCK_GUEST=1`.
 *
 * This is the product-side gate for the documented signing exemption: a
 * Matchlock guest has the identity variables projected into it but no signing
 * keys, so the landing must stay unsigned rather than fail. The resolver above
 * remains a pure description of the configured signing.
 */
export function isMatchlockGuestContext(
  context: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isTruthyFlag(env[MATCHLOCK_GUEST_ENV_VAR])) return true;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    if (isTruthyFlag(context[MATCHLOCK_CONTEXT_KEY])) return true;
  }
  return false;
}

const GIT_CONFIG_TIMEOUT_MS = 5_000;

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read one `git config` value in a single scope. A non-zero exit (including
 * "key not set") yields `undefined`; a bare boolean key yields the empty
 * string and stays distinguishable from "unset".
 */
function readScopedConfigValue(
  repoDir: string | undefined,
  scopeArgs: string[],
  key: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const gitArgs = repoDir
    ? ["-C", repoDir, "config", ...scopeArgs, "--get", key]
    : ["config", ...scopeArgs, "--get", key];
  const result = spawnSync("git", gitArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_CONFIG_TIMEOUT_MS,
    env,
  });
  if (result.status !== 0) return undefined;
  return (result.stdout ?? "").replace(/\r?\n$/, "").trim();
}

/**
 * Read a single config key from the local scope first, then the global scope.
 * Keys are read independently: a locally-set `commit.gpgsign` does not stop
 * `gpg.format` / `user.signingkey` from being read from the global scope.
 */
function readConfigKey(
  repoDir: string | undefined,
  key: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (repoDir) {
    const local = readScopedConfigValue(repoDir, ["--local"], key, env);
    if (local !== undefined) return local;
  }
  return readScopedConfigValue(undefined, ["--global"], key, env);
}

/**
 * Parse a git boolean. Mirrors `git config --type=bool`: `true`/`yes`/`on`/`1`
 * (any case) are true, a bare key is true, everything else — including an
 * absent key — is false.
 */
function parseGitBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return true;
  return normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "1";
}

/**
 * Resolve the commit-signing configuration for a landing in `repoDir`.
 * Read-only with respect to repository state.
 */
export function resolveGitSigningConfig(
  options: ResolveGitSigningConfigOptions = {},
): GitSigningConfig {
  const env = options.env ?? process.env;
  const repoDir = options.repoDir;

  const gpgsign = readConfigKey(repoDir, GIT_SIGNING_CONFIG_KEYS.enabled, env);
  const format = nonEmpty(readConfigKey(repoDir, GIT_SIGNING_CONFIG_KEYS.format, env));
  const signingKey = nonEmpty(readConfigKey(repoDir, GIT_SIGNING_CONFIG_KEYS.signingKey, env));

  const config: GitSigningConfig = { enabled: parseGitBoolean(gpgsign) };
  if (format !== undefined) config.format = format;
  if (signingKey !== undefined) config.signingKey = signingKey;
  return config;
}
