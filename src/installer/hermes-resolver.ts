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

/**
 * Resolve the Hermes binary through three-tier discovery.
 *
 * Throws a clear actionable error when no valid Hermes is found.
 */
export async function resolveHermesBinary(
  options: ResolveHermesBinaryOptions = {},
): Promise<string> {
  // Tier 1: Explicit env override
  const envHermes = process.env.TAMANDUA_HERMES_BINARY?.trim();
  if (envHermes) {
    // Resolve relative paths against process.cwd() so dispatch from a
    // different working directory doesn't fail with "./hermes: not found".
    const resolved = path.resolve(envHermes);
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      throw new Error(
        `TAMANDUA_HERMES_BINARY set but not executable: ${envHermes}`,
      );
    }
  }

  // Tier 2: PATH search (optionally preferring token-saver)
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);

  if (options.preferTokenSaver) {
    for (const dir of pathDirs) {
      // Resolve against process.cwd() so relative/empty PATH entries
      // produce absolute paths — dispatch from a different cwd won't break.
      const candidate = path.resolve(dir, "hermes-token-saver");
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not found in this dir
      }
    }
    // Fall through to normal hermes search
  }

  for (const dir of pathDirs) {
    const candidate = path.resolve(dir, "hermes");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir
    }
  }

  // Tier 3: Login-shell fallback
  const loginShellPath = await resolveHermesViaLoginShell();
  if (loginShellPath) {
    return loginShellPath;
  }

  throw new Error(
    "hermes binary not found in PATH. Install hermes or set TAMANDUA_HERMES_BINARY.",
  );
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
