/**
 * Effective Tamandua configuration resolution (DPID state-dir scoping).
 *
 * Every state path in the CLI — pidfiles, port files, identity sockets —
 * must derive from ONE effective state directory. Historically
 * `daemonctl.ts` and `daemon-identity.ts` each computed `~/.tamandua`
 * independently and IGNORED the `TAMANDUA_STATE_DIR` override, so a CLI
 * configured for an isolated state dir could still resolve the production
 * daemon's identity socket / port file and mistake it for its own
 * (`tamandua daemon start` reported "already running" for a foreign daemon).
 *
 * Resolution order for the state dir:
 *   1. an explicit `{ homeDir }` option    -> `<homeDir>/.tamandua`
 *   2. `TAMANDUA_STATE_DIR` (trimmed, resolved) -> that directory
 *   3. `HOME` (or `os.homedir()`)          -> `<home>/.tamandua`
 *
 * The test-isolation guard is deliberately NOT consulted here: this module is
 * pure path resolution. Callers that expose a production path keep their
 * existing `assertStatePathIsolation(...)` call so the guard still throws
 * `TEST ISOLATION VIOLATION` for the real `~/.tamandua` under the guard.
 */
import os from "node:os";
import path from "node:path";

/** Options accepted by the effective-config resolvers. */
export interface TamanduaConfigOptions {
  /**
   * When set, this is treated as the user's home directory and the state dir
   * is `<homeDir>/.tamandua`, overriding the environment.
   */
  homeDir?: string;
}

/**
 * Resolve the effective Tamandua state directory.
 *
 * `resolveStateDir({ homeDir })` -> `<homeDir>/.tamandua`;
 * `resolveStateDir()` with `TAMANDUA_STATE_DIR=<dir>` -> `<dir>`;
 * `resolveStateDir()` with neither -> `<HOME>/.tamandua`.
 */
export function resolveStateDir(opts?: TamanduaConfigOptions): string {
  if (opts?.homeDir) return path.join(opts.homeDir, ".tamandua");
  const stateDir = process.env.TAMANDUA_STATE_DIR?.trim();
  if (stateDir) return path.resolve(stateDir);
  return path.join(process.env.HOME?.trim() || os.homedir(), ".tamandua");
}

/**
 * Resolve the effective user home directory.
 *
 * `opts.homeDir` wins; otherwise a `TAMANDUA_STATE_DIR` whose basename is
 * `.tamandua` implies its parent directory; otherwise `HOME` (or
 * `os.homedir()` when HOME is unset).
 */
export function resolveEffectiveHomeDir(opts?: TamanduaConfigOptions): string {
  if (opts?.homeDir) return opts.homeDir;
  const stateDir = process.env.TAMANDUA_STATE_DIR?.trim();
  if (stateDir) {
    const resolved = path.resolve(stateDir);
    if (path.basename(resolved) === ".tamandua") return path.dirname(resolved);
  }
  return process.env.HOME?.trim() || os.homedir();
}
