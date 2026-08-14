/**
 * dsh (DeepSeek Harness) binary resolver — side-effect-free discovery.
 *
 * Resolves the dsh binary path through a three-tier precedence:
 *
 *   1. TAMANDUA_DSH_BINARY env var (explicit config — always wins).
 *      Must be executable or throws a clear actionable error.
 *   2. Process PATH lookup (daemon's own PATH), optionally preferring
 *      `dsh-token-saver` when requested.
 *   3. Login-shell fallback: spawns `zsh -lic 'command -v dsh'` so
 *      dsh installed via nix/homebrew/npm in shell-specific paths
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

export interface ResolveDshBinaryOptions {
  /**
   * When true, prefer `dsh-token-saver` over `dsh` in the PATH
   * search step. Falls back silently to `dsh` when the wrapper is
   * absent. Has no effect on explicit TAMANDUA_DSH_BINARY.
   */
  preferTokenSaver?: boolean;
}

/** Discovery source for the resolved dsh binary. */
export type DshSource = "env" | "token-saver" | "path" | "login-shell";

/** Structured result from the detailed resolver. */
export interface DshBinaryResult {
  path: string;
  source: DshSource;
}

/**
 * Typed error for invalid TAMANDUA_DSH_BINARY configuration.
 * Carries a stable code and the raw configured value so callers
 * (e.g. doctor.ts) can format an invalid-env diagnostic without
 * rechecking the filesystem.
 */
export class DshResolverError extends Error {
  public readonly code: "invalid_env_binary" | "not_found";
  public readonly rawConfiguredValue?: string;

  constructor(
    code: "invalid_env_binary" | "not_found",
    message: string,
    rawConfiguredValue?: string,
  ) {
    super(message);
    this.name = "DshResolverError";
    this.code = code;
    this.rawConfiguredValue = rawConfiguredValue;
  }
}

/**
 * Resolve the dsh binary through three-tier discovery, returning
 * structured path + source information.
 *
 * Throws `DshResolverError` on failure.
 */
export async function resolveDshBinaryDetailed(
  options: ResolveDshBinaryOptions = {},
): Promise<DshBinaryResult> {
  // Tier 1: Explicit env override
  const envDsh = process.env.TAMANDUA_DSH_BINARY?.trim();
  if (envDsh) {
    const resolved = path.resolve(envDsh);
    if (isExecutable(resolved)) {
      return { path: resolved, source: "env" };
    }
    throw new DshResolverError(
      "invalid_env_binary",
      `TAMANDUA_DSH_BINARY set but not executable: ${envDsh}`,
      envDsh,
    );
  }

  // Tier 2: PATH search (optionally preferring token-saver)
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);

  if (options.preferTokenSaver) {
    for (const dir of pathDirs) {
      const candidate = path.resolve(dir, "dsh-token-saver");
      if (isExecutable(candidate)) {
        return { path: candidate, source: "token-saver" };
      }
    }
    // Fall through to normal dsh search
  }

  for (const dir of pathDirs) {
    const candidate = path.resolve(dir, "dsh");
    if (isExecutable(candidate)) {
      return { path: candidate, source: "path" };
    }
  }

  // Tier 3: Login-shell fallback
  const loginShellPath = await resolveDshViaLoginShell();
  if (loginShellPath) {
    return { path: loginShellPath, source: "login-shell" };
  }

  throw new DshResolverError(
    "not_found",
    "dsh binary not found in PATH. Install dsh or set TAMANDUA_DSH_BINARY.",
  );
}

/**
 * Resolve the dsh binary through three-tier discovery.
 *
 * Thin wrapper around `resolveDshBinaryDetailed` — returns only
 * the resolved absolute path. Kept API-compatible for callers that
 * only need the path.
 *
 * Throws a clear actionable error when no valid dsh is found.
 */
export async function resolveDshBinary(
  options: ResolveDshBinaryOptions = {},
): Promise<string> {
  const result = await resolveDshBinaryDetailed(options);
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
 * Resolve dsh through the login shell PATH by spawning
 * `zsh -lic 'command -v dsh'`. Handles macOS symlinks via
 * fs.realpathSync and validates the resolved path is executable.
 *
 * Returns the resolved realpath, or `null` when zsh is unavailable or
 * dsh is not found on the login-shell PATH.
 */
export async function resolveDshViaLoginShell(): Promise<string | null> {
  try {
    const output = await spawnDshLoginShellCommand("command -v dsh");
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
 * that need to query arbitrary shell commands beyond `command -v dsh`.
 */
export function spawnDshLoginShellCommand(cmd: string): Promise<string | null> {
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
