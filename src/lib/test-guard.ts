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
    const { testFile, testLine } = deriveTestFrame();
    const entry = {
      kind,
      path: path_,
      what,
      testFile,
      testLine,
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
