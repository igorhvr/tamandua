/**
 * Hermes binary resolver — side-effect-free discovery.
 *
 * Resolves the Hermes binary path through a three-tier precedence:
 *
 *   1. TAMANDUA_HERMES_BINARY env var (explicit config — always wins).
 *      Must be executable or throws a clear actionable error.
 *   2. Process PATH lookup (daemon's own PATH), optionally preferring
 *      `hermes-token-saver` when requested.
 *   3. Login-shell fallback: spawns `zsh -lic 'command -v hermes'` so
 *      Hermes installed via nix/homebrew/npm in shell-specific paths
 *      is discoverable even when not on the daemon's PATH. The returned
 *      path is realpath-resolved and X_OK-validated.
 *
 * This module is entirely side-effect-free: it never creates, deletes,
 * replaces, or chmods any file or symlink.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// ── Public API ─────────────────────────────────────────────────────

export interface ResolveHermesBinaryOptions {
  /**
   * When true, prefer `hermes-token-saver` over `hermes` in the PATH
   * search step. Falls back silently to `hermes` when the wrapper is
   * absent. Has no effect on explicit TAMANDUA_HERMES_BINARY.
   */
  preferTokenSaver?: boolean;
}

/** Discovery source for the resolved Hermes binary. */
export type HermesSource = "env" | "token-saver" | "path" | "login-shell";

/** Structured result from the detailed resolver. */
export interface HermesBinaryResult {
  path: string;
  source: HermesSource;
}

/**
 * Typed error for invalid TAMANDUA_HERMES_BINARY configuration.
 * Carries a stable code and the raw configured value so callers
 * (e.g. doctor.ts) can format an invalid-env diagnostic without
 * rechecking the filesystem.
 */
export class HermesResolverError extends Error {
  public readonly code: "invalid_env_binary" | "not_found";
  public readonly rawConfiguredValue?: string;

  constructor(
    code: "invalid_env_binary" | "not_found",
    message: string,
    rawConfiguredValue?: string,
  ) {
    super(message);
    this.name = "HermesResolverError";
    this.code = code;
    this.rawConfiguredValue = rawConfiguredValue;
  }
}

/**
 * Resolve the Hermes binary through three-tier discovery, returning
 * structured path + source information.
 *
 * Throws `HermesResolverError` on failure.
 */
export async function resolveHermesBinaryDetailed(
  options: ResolveHermesBinaryOptions = {},
): Promise<HermesBinaryResult> {
  // Tier 1: Explicit env override
  const envHermes = process.env.TAMANDUA_HERMES_BINARY?.trim();
  if (envHermes) {
    const resolved = path.resolve(envHermes);
    if (isExecutable(resolved)) {
      return { path: resolved, source: "env" };
    }
    throw new HermesResolverError(
      "invalid_env_binary",
      `TAMANDUA_HERMES_BINARY set but not executable: ${envHermes}`,
      envHermes,
    );
  }

  // Tier 2: PATH search (optionally preferring token-saver)
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);

  if (options.preferTokenSaver) {
    for (const dir of pathDirs) {
      const candidate = path.resolve(dir, "hermes-token-saver");
      if (isExecutable(candidate)) {
        return { path: candidate, source: "token-saver" };
      }
    }
    // Fall through to normal hermes search
  }

  for (const dir of pathDirs) {
    const candidate = path.resolve(dir, "hermes");
    if (isExecutable(candidate)) {
      return { path: candidate, source: "path" };
    }
  }

  // Tier 3: Login-shell fallback
  const loginShellPath = await resolveHermesViaLoginShell();
  if (loginShellPath) {
    return { path: loginShellPath, source: "login-shell" };
  }

  throw new HermesResolverError(
    "not_found",
    "hermes binary not found in PATH. Install hermes or set TAMANDUA_HERMES_BINARY.",
  );
}

/**
 * Resolve the Hermes binary through three-tier discovery.
 *
 * Thin wrapper around `resolveHermesBinaryDetailed` — returns only
 * the resolved absolute path. Kept API-compatible for existing callers.
 *
 * Throws a clear actionable error when no valid Hermes is found.
 */
export async function resolveHermesBinary(
  options: ResolveHermesBinaryOptions = {},
): Promise<string> {
  const result = await resolveHermesBinaryDetailed(options);
  return result.path;
}

/** Synchronous single-file X_OK check to avoid try/catch churn. */
function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Login-shell fallback ───────────────────────────────────────────

/**
 * Resolve hermes through the login shell PATH by spawning
 * `zsh -lic 'command -v hermes'`. Handles macOS symlinks via
 * fs.realpathSync and validates the resolved path is executable.
 *
 * Returns the resolved realpath, or `null` when zsh is unavailable or
 * hermes is not found on the login-shell PATH.
 */
export async function resolveHermesViaLoginShell(): Promise<string | null> {
  try {
    const output = await spawnLoginShellCommand("command -v hermes");
    if (!output) return null;

    // Resolve symlinks (handles /var → /private/var on macOS)
    let resolved: string;
    try {
      resolved = fs.realpathSync(output);
    } catch {
      // realpathSync fails if path doesn't exist — fall back to raw path
      resolved = output;
    }

    // Validate executable
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
    } catch {
      // Resolved path is not executable — treat as not found
      return null;
    }

    return resolved;
  } catch {
    // zsh not available or spawn failed — graceful fallback
    return null;
  }
}

// ── Low-level login-shell command execution ────────────────────────

/**
 * Spawn `zsh -lic` with the given command string. Returns the trimmed
 * stdout, or `null` when zsh is not available or the command fails.
 *
 * The timeout is capped at 5 seconds — login shell init should never
 * hang longer than that on a healthy system.
 *
 * @internal Exported for test visibility and for callers (e.g. doctor.ts)
 * that need to query arbitrary shell commands beyond `command -v hermes`.
 */
export function spawnLoginShellCommand(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("zsh", ["-lic", cmd], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.on("error", () => {
      // zsh not available (ENOENT) — resolve null
      resolve(null);
    });

    child.on("close", (code) => {
      const trimmed = stdout.trim();
      if (code === 0 && trimmed.length > 0) {
        resolve(trimmed);
      } else {
        resolve(null);
      }
    });
  });
}
