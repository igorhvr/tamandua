/**
 * Wiring guard for the real hermes canary's launcher-contamination protection.
 *
 * Markers: HCANARY-CONTAM | LAUNCHER-SNAPSHOT
 *
 * Pure text read of the canary source — NO spawns, no real hermes, no real
 * `~/.hermes`. Runs in the PARALLEL lane (no `node:child_process` import).
 *
 * The canary itself is only run deliberately (real tokens), so this guard is
 * the mechanical proof that the snapshot/restore/verify safety net is wired at
 * the required points and cannot silently rot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CANARY_PATH = path.join(
  REPO_ROOT,
  "e2e-tests",
  "workflows-hermes-canary-real.test.ts",
);
const HELPER_PATH = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "hermes-launcher-snapshot.ts",
);

function readCanary(): string {
  return fs.readFileSync(CANARY_PATH, "utf-8");
}

/**
 * Index of the token that must appear exactly once in the canary. Duplicated
 * tokens would make an ordering assertion ambiguous, so reject them loudly.
 */
function indexOfOnce(source: string, needle: string): number {
  const first = source.indexOf(needle);
  assert.notEqual(
    first,
    -1,
    `expected ${JSON.stringify(needle)} in e2e-tests/workflows-hermes-canary-real.test.ts`,
  );
  assert.equal(
    source.indexOf(needle, first + 1),
    -1,
    `expected exactly one ${JSON.stringify(needle)} token in the canary`,
  );
  return first;
}

describe("HCANARY-CONTAM real hermes canary wiring", () => {
  it("imports the shared launcher snapshot helper", () => {
    assert.ok(fs.existsSync(HELPER_PATH), "shared helper module must exist");
    const source = readCanary();
    assert.match(
      source,
      /from\s+"[^"]*src\/lib\/hermes-launcher-snapshot\.ts"/,
      "the canary must import the shared helper from src/lib/hermes-launcher-snapshot.ts",
    );
    for (const name of [
      "resolveRealHermesRoot",
      "resolveLauncherChain",
      "snapshotLaunchers",
      "restoreLaunchers",
      "verifyLaunchers",
    ]) {
      assert.ok(
        source.includes(name),
        `the canary must reference the shared helper export ${name}`,
      );
    }
  });

  it("snapshots the real launcher chain before starting the daemon", () => {
    const source = readCanary();
    const snapshotAt = indexOfOnce(source, "snapshotLaunchers(");
    const daemonAt = indexOfOnce(source, "startIsolatedDaemon(");
    assert.ok(
      snapshotAt < daemonAt,
      "snapshotLaunchers(...) must run AFTER the hermes skip check and BEFORE startIsolatedDaemon(...)",
    );
  });

  it("restores then verifies after the daemon stops and the temp home is cleaned", () => {
    const source = readCanary();
    const stopAt = indexOfOnce(source, "stopIsolatedDaemon(daemon)");
    const cleanupAt = indexOfOnce(source, "cleanupTempHome(env)");
    const restoreAt = indexOfOnce(source, "restoreLaunchers(");
    const verifyAt = indexOfOnce(source, "verifyLaunchers(");
    assert.ok(
      stopAt < cleanupAt,
      "stopIsolatedDaemon(daemon) must run before cleanupTempHome(env)",
    );
    assert.ok(
      cleanupAt < restoreAt,
      "restoreLaunchers(...) must run AFTER cleanupTempHome(env)",
    );
    assert.ok(
      restoreAt < verifyAt,
      "verifyLaunchers(...) must run after restoreLaunchers(...)",
    );
    assert.match(
      source,
      /!launcherVerification\.ok/,
      "the teardown must consult verifyLaunchers(...).ok for the loud failure path",
    );
  });

  it("keeps the canary's real validation (real symlink, hard reconciliation) intact", () => {
    const source = readCanary();
    assert.ok(
      source.includes("linkRealAgentDirs: true"),
      "the canary must keep the real ~/.hermes symlink (linkRealAgentDirs: true)",
    );
    assert.match(
      source,
      /reconciliation\.workTokens,\s*reconciliation\.store\.policyTotal/,
      "the canary must keep the hard store reconciliation (tolerance 0)",
    );
  });
});
