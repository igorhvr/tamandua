/**
 * Static isolation guard (US-009): a test file that spawns a daemon
 * (startDaemon / startMcp / startControlPlane / startDashboardStandalone) or
 * the tamandua CLI entry (bin/tamandua, dist/cli/cli.js) must build the child
 * environment through `cleanChildEnv` (tests/helpers/test-env.ts) — directly or
 * via an imported helper module that itself uses `cleanChildEnv`. Otherwise the
 * spawned child can inherit an ambient TAMANDUA_STATE_DIR / run marker and
 * reach the real ~/.tamandua or a live daemon (see bead tamandua-6sy.79).
 *
 * The scan is a PURE content check with no filesystem or child_process access,
 * so it can be unit-tested with synthetic inputs and stays in the parallel
 * test lane. The caller supplies every file it wants considered; the helper
 * resolves relative import specifiers inside that set to credit files whose env
 * is produced by a `cleanChildEnv`-using helper.
 *
 * Paths in the allowlist are the only escape hatch. Every entry carries a
 * concrete reason; keep the list minimal (a file whose only reference is
 * fixture/comment text never actually spawns anything).
 */

import path from "node:path";

export interface IsolationGuardFile {
  /** Repository-relative POSIX path, e.g. `tests/demo.test.ts`. */
  path: string;
  content: string;
}

export interface IsolationEnvAllowlistEntry {
  /** Repository-relative POSIX path of the allow-listed file. */
  path: string;
  /** Concrete, human-readable reason this file needs no cleanChildEnv call. */
  reason: string;
}

/**
 * Files that reference a daemon spawner or the CLI entry but never spawn a
 * process with an env the guard could isolate. Each entry is an explicit,
 * reviewed exception with a concrete reason.
 */
export const ISOLATION_ENV_ALLOWLIST: readonly IsolationEnvAllowlistEntry[] = [
  {
    path: "tests/orphan-modules.test.ts",
    reason:
      "Pure static graph scanner: 'bin/tamandua' appears only in a comment and in fixture maps compared as text; the file spawns no process, so there is no child env to isolate.",
  },
  {
    path: "tests/update-contract-scope-policy.test.ts",
    reason:
      "Pure static policy scanner: 'bin/tamandua' appears only as fixture/map string data compared by content (never as a spawned executable); the file spawns no process, so there is no child env to isolate.",
  },
];

/** A call to a daemon-spawning lifecycle entrypoint. */
const DAEMON_SPAWNER_RE =
  /\b(?:startDaemon|startMcp|startControlPlane|startDashboardStandalone)\s*\(/;

/**
 * The CLI entry: the POSIX launcher `bin/tamandua` (not `bin/tamandua-test`)
 * or the compiled `dist/cli/cli.js` / `"cli.js"` path segment a test builds.
 */
const CLI_ENTRY_RE = /(?:^|[^\w-])bin\/tamandua(?![\w-])|\bcli\.js\b/;

/** The isolation helper every spawning test must route through. */
const CLEAN_CHILD_ENV_RE = /\bcleanChildEnv\b/;

const IMPORT_SPECIFIER_RE =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function normalizePath(input: string): string {
  return path.posix
    .normalize(input.replaceAll("\\", "/"))
    .replace(/^\.\//, "");
}

/** True for files this guard governs (tests/ or e2e-tests/ unit-test files). */
export function isGuardedTestPath(input: string): boolean {
  const normalized = normalizePath(input);
  return (
    (normalized.startsWith("tests/") || normalized.startsWith("e2e-tests/")) &&
    normalized.endsWith(".test.ts")
  );
}

/** True when the file itself references a daemon spawner or the CLI entry. */
export function spawnsDaemonOrCli(content: string): boolean {
  return DAEMON_SPAWNER_RE.test(content) || CLI_ENTRY_RE.test(content);
}

function moduleCandidates(importer: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const base = normalizePath(
    path.posix.join(path.posix.dirname(normalizePath(importer)), specifier.split(/[?#]/)[0]),
  );
  const candidates = new Set<string>([base]);
  for (const ext of SCRIPT_EXTENSIONS) {
    if (base.endsWith(ext)) {
      for (const replacement of SCRIPT_EXTENSIONS) {
        candidates.add(`${base.slice(0, -ext.length)}${replacement}`);
      }
    } else {
      candidates.add(`${base}${ext}`);
    }
  }
  candidates.add(path.posix.join(base, "index.ts"));
  return [...candidates];
}

function importsCleanChildEnv(
  filePath: string,
  content: string,
  byPath: ReadonlyMap<string, string>,
  visited: Set<string>,
): boolean {
  if (visited.has(filePath)) return false;
  visited.add(filePath);
  if (CLEAN_CHILD_ENV_RE.test(content)) return true;

  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    for (const candidate of moduleCandidates(filePath, match[1])) {
      const imported = byPath.get(candidate);
      if (
        imported !== undefined &&
        importsCleanChildEnv(candidate, imported, byPath, visited)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Pure checker. Returns one human-readable violation per guarded test file
 * that spawns a daemon or the CLI entry without building its child env through
 * cleanChildEnv (directly, transitively via an imported helper, or via a
 * reasoned allowlist entry). The result is sorted for deterministic output.
 */
export function findIsolationEnvViolations(
  files: readonly IsolationGuardFile[],
  allowlist: readonly IsolationEnvAllowlistEntry[] = ISOLATION_ENV_ALLOWLIST,
): string[] {
  const byPath = new Map<string, string>();
  for (const file of files) byPath.set(normalizePath(file.path), file.content);

  const allowlistPaths = new Set(allowlist.map((entry) => normalizePath(entry.path)));
  const violations: string[] = [];

  for (const file of files) {
    const normalized = normalizePath(file.path);
    if (!isGuardedTestPath(normalized)) continue;
    if (!spawnsDaemonOrCli(file.content)) continue;
    if (allowlistPaths.has(normalized)) continue;
    if (importsCleanChildEnv(normalized, file.content, byPath, new Set())) continue;

    violations.push(
      `${normalized}: spawns a daemon or the CLI entry but does not build the child env with cleanChildEnv ` +
        `(or an allow-listed equivalent) — see tests/helpers/test-env.ts`,
    );
  }

  return violations.sort();
}