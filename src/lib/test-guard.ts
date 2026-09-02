/**
 * Test-isolation guard.
 *
 * Tamandua is the main tool used to develop tamandua itself, so a test (or
 * anything a test spawns) touching the REAL ~/.tamandua state or binding
 * the production ports would interfere with the live instance — leaked
 * daemons squatting the control port, EADDRINUSE collisions, state
 * pollution, and cross-talk between the suite and real runs have all
 * happened. `npm test` sets TAMANDUA_TEST_GUARD=1 (passed through
 * cleanChildEnv to spawned daemons/scripts), turning any such touch into a
 * loud, attributable failure instead of silent interference.
 *
 * The guard auto-activates whenever NODE_TEST_CONTEXT is set (node:test
 * sets it in every test process), even without TAMANDUA_TEST_GUARD=1.
 * This prevents bypasses when running individual test files directly with
 * `node --test`. To explicitly disable the guard (e.g. a third-party test
 * suite shelling out to the tamandua CLI), set TAMANDUA_TEST_GUARD=0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Ports the live tamandua instance uses by default. */
const PRODUCTION_PORTS = new Set([3334, 3338, 3339]);

export function testGuardActive(): boolean {
  // TAMANDUA_TEST_GUARD=0 is an explicit escape hatch that disables the
  // guard even when NODE_TEST_CONTEXT is set (e.g. third-party test suites
  // that shell out to the tamandua CLI).
  if (process.env.TAMANDUA_TEST_GUARD === "0") return false;

  // Belt-and-suspenders: explicit activation via env var, OR auto-activation
  // when node:test is running (NODE_TEST_CONTEXT is set by the built-in
  // test runner). This prevents bypasses when running `node --test` directly.
  if (process.env.TAMANDUA_TEST_GUARD === "1") return true;
  if (process.env.NODE_TEST_CONTEXT) return true;

  return false;
}

/**
 * Env var that names the test file which spawned the current process.
 * Spawn sites (daemonctl children, etc.) merge the output of
 * spawnChildAttributionEnv() into the child's env so child-side ledger
 * entries are attributed to the originating test instead of "(unknown)".
 */
export const CHILD_TEST_FILE_ENV = "TAMANDUA_TEST_GUARD_TEST_FILE";

/**
 * The invoking user's actual home directory from the OS account database —
 * deliberately NOT os.homedir(), which follows the HOME env var that
 * isolated tests legitimately point at temp directories.
 */
function realUserHome(): string | null {
  try {
    return os.userInfo().homedir || null;
  } catch {
    return null;
  }
}

/**
 * Derive the originating test file/line from the current stack — the first
 * frame whose path contains a ".test." segment and is NOT this module
 * (compiled to dist/lib/test-guard.js). Spawned daemon children have no test
 * frames, so this yields null/0 there. Never throws.
 */
function deriveTestFrame(): { testFile: string | null; testLine: number | null } {
  try {
    const stack = new Error().stack ?? "";
    for (const line of stack.split("\n").slice(1)) {
      const trimmed = line.trim();
      // "at fn (path:line:col)" or "at path:line:col"
      const paren = trimmed.match(/^at .*\((.+):(\d+):\d+\)$/);
      const bare = trimmed.match(/^at (.+):(\d+):\d+$/);
      const match = paren ?? bare;
      if (!match) continue;
      const file = match[1];
      // Skip frames inside the guard itself.
      if (file.includes("dist/lib/test-guard.js")) continue;
      if (/\.test\./.test(file)) {
        return { testFile: file, testLine: Number(match[2]) };
      }
    }
  } catch {
    // Ledger bookkeeping must never throw.
  }
  return { testFile: null, testLine: null };
}

/**
 * Resolve the originating test file/line for a guard violation.
 *
 * Attribution precedence:
 * 1. TAMANDUA_TEST_GUARD_TEST_FILE (exported by a spawning test): names the
 *    test that spawned this process — authoritative for daemon / control-plane
 *    children whose own stacks have no .test. frames.
 * 2. deriveTestFrame(): the in-process stack walk (unchanged behavior),
 *    which yields null/0 in children.
 */
function deriveAttribution(): { testFile: string | null; testLine: number | null } {
  const spawnerTestFile = process.env[CHILD_TEST_FILE_ENV];
  if (spawnerTestFile) {
    // Env attribution has no line number: the env names the SPAWNING test,
    // and this process's stack does not execute inside that file.
    return { testFile: spawnerTestFile, testLine: null };
  }
  return deriveTestFrame();
}

/**
 * Child-process attribution env for spawn sites.
 *
 * When a test spawns a tamandua child (daemon / control-standalone /
 * dashboard-standalone / mcp-standalone), the child's own stack has no
 * .test. frames, so without this its ledger entries would be orphaned under
 * "(unknown)". Spawn sites merge the result into the child env
 * (TAMANDUA_TEST_GUARD_TEST_FILE) so the guard records the originating test
 * file on every child-side violation.
 *
 * Returns { TAMANDUA_TEST_GUARD_TEST_FILE: <stack-derived test file> } ONLY
 * when the guard is active AND a .test. frame is derivable from the caller's
 * stack; otherwise returns {} — no env var is injected when the guard is
 * inactive or no test frame exists (production spawns stay byte-identical).
 */
export function spawnChildAttributionEnv(): Record<string, string> {
  if (!testGuardActive()) return {};
  const { testFile } = deriveTestFrame();
  if (!testFile) return {};
  return { [CHILD_TEST_FILE_ENV]: testFile };
}

/**
 * Test-harness-only violation ledger. When the guard is active AND the runner
 * pointed TAMANDUA_TEST_GUARD_LEDGER at a per-run temp file, append one JSONL
 * entry per violation so the PRLL lane scripts can attribute leaks to the
 * originating test file. Byte-identical no-op for real runs (guard inactive)
 * and for direct `node --test` runs (ledger env unset). Never throws.
 */
function appendLedgerViolation(kind: string, path_: string, what: string): void {
  if (!testGuardActive()) return;
  const ledgerPath = process.env.TAMANDUA_TEST_GUARD_LEDGER;
  if (!ledgerPath) return;
  try {
    const { testFile, testLine } = deriveAttribution();
    const entry = {
      kind,
      path: path_,
      what,
      testFile,
      testLine,
      // The writing process's command line (argv minus the node binary),
      // captured at bind time — the fallback attribution for orphan entries
      // whose testFile is null (e.g. a spawned daemon child): the ledger
      // report can still say WHICH process leaked the bind.
      argv: process.argv.slice(1).join(" "),
      expected: process.env.TAMANDUA_TEST_GUARD_EXPECT === "1",
      ts: Date.now(),
    };
    fs.appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
  } catch {
    // Ledger bookkeeping must never interfere with the guard's throw.
  }
}

/** Throw if a server is about to bind a production port under the guard. */
export function assertPortIsolation(port: number, what: string): void {
  if (!testGuardActive()) return;
  if (!PRODUCTION_PORTS.has(port)) return;
  appendLedgerViolation("port-bind", String(port), what);
  throw new Error(
    `TEST ISOLATION VIOLATION: ${what} tried to bind production port ${port} while ` +
      `TAMANDUA_TEST_GUARD=1. Tests (and anything they spawn) must use random ports — ` +
      `see reservePortHandle() in tests/helpers/test-env.ts and set ` +
      `TAMANDUA_CONTROL_PORT / explicit port arguments for every daemon they start.`,
  );
}

/** Throw if a state path resolves into the REAL ~/.tamandua under the guard. */
export function assertStatePathIsolation(resolvedPath: string, what: string): void {
  if (!testGuardActive()) return;
  const home = realUserHome();
  if (!home) return;
  const realStateDir = path.join(home, ".tamandua");
  const normalized = path.resolve(resolvedPath);
  if (normalized === realStateDir || normalized.startsWith(realStateDir + path.sep)) {
    appendLedgerViolation("state-path", normalized, what);
    throw new Error(
      `TEST ISOLATION VIOLATION: ${what} resolved to the real tamandua state ` +
        `(${normalized}) while TAMANDUA_TEST_GUARD=1. Tests must point HOME / ` +
        `TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH at a per-test temp directory.`,
    );
  }
}
