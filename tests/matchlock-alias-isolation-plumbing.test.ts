/**
 * Fast, deterministic plumbing coverage for the two-daemon alias isolation
 * regression gate (MTLK-ALIAS-FIX US-005).
 *
 * The original defect: the short-HOME alias was ONE symlink per uid
 * (`/tmp/tamandua/<uid>/h`), so any second daemon of the same user that admitted
 * a Matchlock round re-pointed it to ITS home while the first daemon was
 * creating its next VM — the VM directory vanished under the flipped alias and
 * the round force-failed. The keyed layout makes the alias unique per daemon
 * INSTANCE.
 *
 * No VMs, no child processes, no matchlock runtime: these tests pin
 *
 *   1. the pure per-daemon key: two distinct homes yield distinct keys;
 *   2. the real-fs isolation invariant: resolving daemon B (same uid, distinct
 *      home and key) leaves daemon A's alias target — and its inode —
 *      byte-identical, and each daemon's alias points at its OWN real HOME;
 *   3. the static wiring of the real-VM gate
 *      (`e2e-tests/matchlock-alias-isolation-gate.test.ts`, run on demand via
 *      `./run-matchlock-alias-isolation-e2e-test`): the driver takes the
 *      exclusive flock, records the observed runtime, runs the shared
 *      zero-round guard and refuses a hollow PASS; the driver uses the exact-id
 *      lifecycle helper and never selects a VM by name/glob.
 *
 * Parallel lane: nothing here (transitively) reaches a child-process module.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS,
  MATCHLOCK_HOME_ALIAS_LEAF,
  describeMatchlockHomeAlias,
  matchlockHomeAliasKey,
} from "../dist/installer/matchlock/home-alias.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GATE_TEST = "e2e-tests/matchlock-alias-isolation-gate.test.ts";
const GATE_DRIVER = "run-matchlock-alias-isolation-e2e-test";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readRepoFile(relativePath: string): string {
  const absolute = path.join(repoRoot, relativePath);
  assert.ok(fs.existsSync(absolute), `${relativePath} must exist`);
  return fs.readFileSync(absolute, "utf-8");
}

describe("two-daemon alias isolation plumbing (US-005)", () => {
  it("derives a stable 6-8 char key that differs for two distinct homes", () => {
    const homeA = "/home/alias-fixture/daemon-a/home";
    const homeB = "/home/alias-fixture/daemon-b/home";
    const keyA = matchlockHomeAliasKey(homeA);
    const keyB = matchlockHomeAliasKey(homeB);

    assert.notEqual(keyA, keyB, "two distinct homes must never share a key");
    for (const key of [keyA, keyB]) {
      assert.match(
        key,
        new RegExp(`^[0-9a-f]{${MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS}}$`),
        `key ${key} must be ${MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS} lowercase hex chars`,
      );
    }
    assert.ok(
      MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS >= 6 && MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS <= 8,
      "the key length contract is 6-8 hex chars",
    );
    // Deterministic across calls and trailing-slash normalized (a restart of
    // the same daemon must reuse its own key).
    assert.equal(matchlockHomeAliasKey(homeA), keyA);
    assert.equal(matchlockHomeAliasKey(homeA + "/"), keyA);
  });

  it("resolving daemon B leaves daemon A's alias target and inode untouched", () => {
    const root = tamanduaTempDir("mtlk-alias-iso-");
    cleanups.push(root);
    const homeA = path.join(root, "daemon-a", "home");
    const homeB = path.join(root, "daemon-b", "home");
    fs.mkdirSync(homeA, { recursive: true });
    fs.mkdirSync(homeB, { recursive: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;

    // daemon A resolves its OWN keyed alias.
    const resolvedA = describeMatchlockHomeAlias({ realHome: homeA, env: {}, tmpdir: root, uid });
    assert.equal(resolvedA.disabled, false);
    assert.equal(resolvedA.aliasKey, matchlockHomeAliasKey(homeA));
    assert.equal(
      resolvedA.aliasDir,
      path.join(root, "tamandua", String(uid), resolvedA.aliasKey as string),
      "the default alias dir must be <tmpdir>/tamandua/<uid>/<k>",
    );
    assert.equal(
      resolvedA.aliasPath,
      path.join(resolvedA.aliasDir as string, MATCHLOCK_HOME_ALIAS_LEAF),
      "the alias leaf must live under the per-daemon keyed dir",
    );
    assert.equal(fs.readlinkSync(resolvedA.aliasPath as string), homeA);

    // Snapshot A's alias symlink identity BEFORE B ever resolves.
    const before = fs.readlinkSync(resolvedA.aliasPath as string);
    const inodeBefore = fs.lstatSync(resolvedA.aliasPath as string).ino;

    // daemon B (same uid, different home) resolves its OWN keyed alias. This is
    // the exact second-daemon action the historical defect used to re-point A.
    const resolvedB = describeMatchlockHomeAlias({ realHome: homeB, env: {}, tmpdir: root, uid });
    assert.notEqual(resolvedB.aliasKey, resolvedA.aliasKey, "distinct homes -> distinct keys");
    assert.notEqual(resolvedB.aliasPath, resolvedA.aliasPath, "distinct keys -> distinct alias paths");
    assert.equal(fs.readlinkSync(resolvedB.aliasPath as string), homeB);

    // A is byte-identical: same target, same inode. B touched only its own <k>.
    assert.equal(fs.readlinkSync(resolvedA.aliasPath as string), homeA);
    assert.equal(fs.readlinkSync(resolvedA.aliasPath as string), before);
    assert.equal(
      fs.lstatSync(resolvedA.aliasPath as string).ino,
      inodeBefore,
      "B must never re-create/re-point A's alias symlink",
    );

    // Resolving B again (a later B round) still cannot move A's alias.
    describeMatchlockHomeAlias({ realHome: homeB, env: {}, tmpdir: root, uid });
    assert.equal(fs.readlinkSync(resolvedA.aliasPath as string), homeA);
    assert.equal(fs.lstatSync(resolvedA.aliasPath as string).ino, inodeBefore);
  });
});

describe("alias isolation gate wiring (US-005)", () => {
  const gateTest = readRepoFile(GATE_TEST);
  const driver = readRepoFile(GATE_DRIVER);

  it("the gate test drives two isolated daemons and records the 'alias-isolation' label", () => {
    for (const token of [
      'from "./helpers/matchlock-gate-rounds.ts"',
      'GATE_LABEL = "alias-isolation"',
      "writeObservedRoundsEvidence(",
      "assertObservedRoundsNonZero(",
      "new Set(observedVmIds).size",
      "observed_rounds: observedRounds",
      'from "./helpers/matchlock-gate-lifecycle.ts"',
      // Deliberately WITHOUT a trailing "(": this file must not trip the
      // static daemon-teardown guard (it never starts a daemon itself); the
      // gate test it points at starts two and stops them with the scoped
      // lifecycle helper.
      "startIsolatedDaemon",
      "spawnWorkflowRun(",
      "cleanupOwnedVms(",
      "readVmInventory(",
      "readlinkSync(",
    ]) {
      assert.ok(gateTest.includes(token), `gate test must include ${token}`);
    }
    // Two distinct private HOMEs, both observed for VM rounds.
    assert.match(gateTest, /aliasPathA/, "gate must track daemon A's alias path");
    assert.match(gateTest, /aliasPathB/, "gate must track daemon B's alias path");
  });

  it("VM teardown is exact-id only (no name/glob selection)", () => {
    assert.ok(
      gateTest.includes("cleanupOwnedVms("),
      "the gate must dispose VMs through the exact-id lifecycle helper",
    );
    assert.doesNotMatch(
      gateTest,
      /readdirSync\(/,
      "the gate must not enumerate/select VMs by directory name or glob",
    );
    assert.doesNotMatch(
      gateTest,
      /["'](?:prune|gc)["']/,
      "the gate must never prune/gc (exact-id rm only)",
    );
  });

  it("the driver takes the exclusive flock and refuses a hollow PASS", () => {
    for (const token of [
      "TAMANDUA_GATE_FLOCK_HELD",
      "command -v flock",
      "flock --exclusive",
      "exit 90",
      "TAMANDUA_GATE_LOCK",
      "npm run build",
      "mktemp -d",
      "runtime-observed.txt",
      "matchlock.sha256",
      "scripts/observed-rounds-guard.mjs",
      "--gate alias-isolation",
      "exit 92",
      "node --test e2e-tests/matchlock-alias-isolation-gate.test.ts",
    ]) {
      assert.ok(driver.includes(token), `driver must include ${token}`);
    }
    // The guard must run AFTER the gate.
    assert.ok(
      driver.indexOf("scripts/observed-rounds-guard.mjs") > driver.indexOf("node --test"),
      "the observed-rounds guard must run after the gate",
    );
  });

  it("the driver observes the runtime (never pins a sha/commit/digest)", () => {
    assert.doesNotMatch(driver, /\b[0-9a-f]{40}\b/, "driver must not pin a 40-hex commit");
    assert.doesNotMatch(driver, /\b[0-9a-f]{64}\b/, "driver must not pin a 64-hex digest");
    assert.doesNotMatch(driver, /@sha256:/, "driver must not pin an image digest");
  });
});
