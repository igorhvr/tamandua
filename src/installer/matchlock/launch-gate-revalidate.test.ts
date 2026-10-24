/**
 * launch-gate revalidation tests (G8 ADMISSION-INTEGRATION US-002, bead
 * tamandua-7p5.1.8).
 *
 * These tests exercise src/installer/matchlock/launch-gate-revalidate.ts
 * through the COMPILED module in dist/ (repo convention for this directory), so
 * `npm run build` must run first. The wiring cases at the end drive the
 * PRODUCTION default of `evaluateAndRecordLaunchGate`'s revalidation seam: the
 * world is moved AFTER the gate evaluated but BEFORE the launch could create a
 * VM, which is exactly the window US-002 exists to close.
 *
 * What is pinned here:
 *
 *  - membership both ways: an observed store that disappears and a store that
 *    appears after the observation are both `store-set-changed`;
 *  - identity by INODE: a copy swapped in at the SAME canonical path is
 *    `store-identity-changed`, and (dev, ino) are compared as DECIMAL STRINGS
 *    (a numeric comparison would collapse distinct 64-bit inodes);
 *  - config by value: delete -> wal and unobservable both report
 *    `config-changed`;
 *  - fail closed: a throwing stat, a throwing config reader and a missing
 *    reader are changes, never `unchanged`;
 *  - the module re-reads NO header and imports neither the byte reader nor the
 *    evaluator (source scan), and the wiring turns any change into an
 *    OPERATIONAL refusal with the G9 exit code, a `refuse` receipt and no
 *    invented finding.
 *
 * Fixtures are real filesystem objects: a real delete-mode SQLite database for
 * the store, and the REAL effective journal-mode reader for the config
 * comparisons. This file spawns no process and imports no node:child_process,
 * so it belongs in the PARALLEL lane (asserted at the end).
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { LAUNCH_GATE_REFUSAL_EXIT_CODE } from "../../../dist/installer/matchlock/gate-exit-code.js";
import { parseReceipt } from "../../../dist/installer/matchlock/gate-receipt.js";
import {
  interactiveStoreMountPlan,
  resolveEffectiveJournalMode,
} from "../../../dist/installer/matchlock/doctor-gate.js";
import { evaluateGate } from "../../../dist/installer/matchlock/launch-gate.js";
import {
  captureLaunchGateSnapshot,
  revalidateLaunchGateSnapshot,
} from "../../../dist/installer/matchlock/launch-gate-revalidate.js";
import { evaluateAndRecordLaunchGate } from "../../../dist/installer/matchlock/launch-gate-wiring.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "launch-gate-revalidate.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");

/** Every temp dir this file creates, removed in `after`. */
const temporaryDirectories: string[] = [];

function track(directory: string): string {
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A private state dir the refusal receipt is resolved under. */
function newStateDir(): string {
  return track(tamanduaShortTempDir("tamandua-rv-state-"));
}

/** A disposable profile home with a real rollback-format SQLite store. */
function newProfileHome(journalMode: "delete" | "wal" = "delete"): string {
  const home = track(tamanduaShortTempDir("tamandua-rv-home-"));
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `database:\n  journal_mode: ${journalMode}\n`,
  );
  const database = new DatabaseSync(path.join(home, "state.db"));
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO t (value) VALUES ('row')");
  database.close();
  return home;
}

function configPathFor(home: string): string {
  return path.join(home, "config.yaml");
}

/** The observed identity of one path, exactly as the gate records it. */
function identityOf(storePath: string): { canonicalPath: string; dev: string; ino: string } {
  const stats = fs.statSync(storePath, { bigint: true });
  return {
    canonicalPath: fs.realpathSync(storePath),
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
  };
}

/** The effective config of one home, read through the REAL production reader. */
function configOf(home: string) {
  return resolveEffectiveJournalMode(home, { managedDir: null });
}

/** The production-reader deps a standalone revalidation test uses. */
function revalidateDeps(home: string, overrides: Record<string, unknown> = {}): any {
  return {
    profileHome: home,
    configOptions: { managedDir: null },
    resolveEffectiveJournalMode,
    ...overrides,
  };
}

/** Deterministic stored instants: UTC ISO-Z, one second apart. */
function sequenceNow(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-02T03:04:05.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

function codes(changes: readonly { code: string }[]): string[] {
  return changes.map((change) => change.code);
}

describe("G8 launch-gate revalidation (US-002)", () => {
  // -------------------------------------------------------------------------
  // capture
  // -------------------------------------------------------------------------

  it("captures the bound identities and config without touching the filesystem", () => {
    const snapshot = captureLaunchGateSnapshot(
      [
        { canonicalPath: "/nonexistent/state.db", dev: "42", ino: "9007199254740993" },
        // No canonical spelling: never identity-bound, never re-stat'able, so
        // it cannot widen the snapshot.
        { canonicalPath: "", dev: "1", ino: "2" },
      ],
      { journalMode: "delete", source: "host-observed: user config", observed: true },
    );

    assert.deepEqual(snapshot.stores, [
      { canonicalPath: "/nonexistent/state.db", dev: "42", ino: "9007199254740993" },
    ]);
    assert.deepEqual(snapshot.config, {
      journalMode: "delete",
      source: "host-observed: user config",
      observed: true,
    });
  });

  it("never upgrades an unknown journal mode to a compliant one", () => {
    const snapshot = captureLaunchGateSnapshot(
      [],
      { journalMode: "WAL" as unknown as "wal", source: "", observed: 1 as unknown as boolean },
    );
    assert.deepEqual(snapshot.config, {
      journalMode: "unreadable",
      source: "unreadable",
      observed: false,
    });
  });

  // -------------------------------------------------------------------------
  // unchanged
  // -------------------------------------------------------------------------

  it("returns unchanged:true for the same store set, identities and config", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));

    const result = revalidateLaunchGateSnapshot(
      snapshot,
      revalidateDeps(home, { currentStorePaths: () => [storePath] }),
    );

    assert.deepEqual(result, { unchanged: true });
  });

  // -------------------------------------------------------------------------
  // membership: removed / appeared
  // -------------------------------------------------------------------------

  it("reports store-set-changed when an observed store disappears", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));

    fs.rmSync(storePath);

    const result = revalidateLaunchGateSnapshot(snapshot, revalidateDeps(home));
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;

    assert.deepEqual(codes(result.changes), ["store-set-changed"]);
    const [change] = result.changes;
    assert.equal(change.storePath, fs.realpathSync(home) + "/state.db");
    assert.equal(change.field, "membership");
    assert.equal(change.before, "present");
    assert.equal(change.after, "absent");
    assert.match(change.detail ?? "", /no longer exists/);
  });

  it("reports store-set-changed when a store appears that the snapshot never evaluated", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const appearedPath = path.join(home, "kanban.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));

    const database = new DatabaseSync(appearedPath);
    database.exec("CREATE TABLE k (id INTEGER PRIMARY KEY)");
    database.close();

    const result = revalidateLaunchGateSnapshot(
      snapshot,
      revalidateDeps(home, {
        currentStorePaths: () => [storePath, fs.realpathSync(appearedPath)],
      }),
    );
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;

    assert.deepEqual(codes(result.changes), ["store-set-changed"]);
    const [change] = result.changes;
    assert.equal(change.storePath, fs.realpathSync(appearedPath));
    assert.equal(change.field, "membership");
    assert.equal(change.before, "absent");
    assert.equal(change.after, "present");
    assert.match(change.detail ?? "", /never evaluated/);
  });

  it("detects a removal with no enumeration seam, and an appearance only with one", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));

    // Without the seam, the snapshot direction is still provable.
    fs.rmSync(storePath);
    const removed = revalidateLaunchGateSnapshot(snapshot, revalidateDeps(home));
    assert.equal(removed.unchanged, false);

    // Re-create the store with a NEW inode: nothing in the snapshot direction
    // changed identity-wise except that the inode differs, which is exactly
    // what the identity check reports.
    const database = new DatabaseSync(storePath);
    database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    database.close();
    const replaced = revalidateLaunchGateSnapshot(snapshot, revalidateDeps(home));
    assert.equal(replaced.unchanged, false);
    if (replaced.unchanged) return;
    assert.deepEqual(codes(replaced.changes), ["store-identity-changed"]);
  });

  // -------------------------------------------------------------------------
  // identity by inode, compared as decimal strings
  // -------------------------------------------------------------------------

  it("reports store-identity-changed when the same canonical path holds a different inode", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const realPath = fs.realpathSync(storePath);
    const before = identityOf(storePath);
    const snapshot = captureLaunchGateSnapshot([before], configOf(home));

    // A WAL copy swapped in at the SAME path: same spelling, different inode.
    const replacement = path.join(home, "state.db.wal-copy");
    fs.copyFileSync(storePath, replacement);
    fs.renameSync(replacement, storePath);
    const after = identityOf(storePath);
    assert.equal(after.canonicalPath, realPath);
    assert.notEqual(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);

    const result = revalidateLaunchGateSnapshot(snapshot, revalidateDeps(home));
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;

    assert.deepEqual(codes(result.changes), ["store-identity-changed"]);
    const [change] = result.changes;
    assert.equal(change.storePath, realPath);
    assert.equal(change.field, "dev/ino");
    assert.equal(change.before, `dev=${before.dev} ino=${before.ino}`);
    assert.equal(change.after, `dev=${after.dev} ino=${after.ino}`);
    assert.match(change.detail ?? "", /different inode/);
  });

  it("compares dev and ino as decimal strings, so 64-bit inodes are never rounded", () => {
    // Number("9007199254740993") === Number("9007199254740992"), so a numeric
    // comparison would call these two inodes equal. The gate must not.
    const snapshot = captureLaunchGateSnapshot(
      [{ canonicalPath: "/store/state.db", dev: "1000", ino: "9007199254740993" }],
      { journalMode: "delete", source: "host-observed", observed: true },
    );

    const rounded = revalidateLaunchGateSnapshot(snapshot, {
      stat: () => ({ dev: "1000", ino: "9007199254740992" }),
      profileHome: "/store",
      resolveEffectiveJournalMode: () => ({
        journalMode: "delete",
        source: "host-observed",
        observed: true,
      }),
    });
    assert.equal(rounded.unchanged, false);
    if (rounded.unchanged) return;
    assert.deepEqual(codes(rounded.changes), ["store-identity-changed"]);

    const exact = revalidateLaunchGateSnapshot(snapshot, {
      stat: () => ({ dev: "1000", ino: "9007199254740993" }),
      profileHome: "/store",
      resolveEffectiveJournalMode: () => ({
        journalMode: "delete",
        source: "host-observed",
        observed: true,
      }),
    });
    assert.deepEqual(exact, { unchanged: true });
  });

  it("fails closed when a store cannot be re-stat'ed", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));

    const result = revalidateLaunchGateSnapshot(
      snapshot,
      revalidateDeps(home, {
        stat: () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      }),
    );
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;
    assert.deepEqual(codes(result.changes), ["store-set-changed"]);
    const [change] = result.changes;
    assert.equal(change.after, "unreadable");
    assert.match(change.detail ?? "", /could not be re-stat'ed/);
    assert.match(change.detail ?? "", /permission denied/);
  });

  it("fails closed when the re-stat returns no usable identity", () => {
    const snapshot = captureLaunchGateSnapshot(
      [{ canonicalPath: "/store/state.db", dev: "1000", ino: "5" }],
      { journalMode: "delete", source: "host-observed", observed: true },
    );

    const result = revalidateLaunchGateSnapshot(snapshot, {
      stat: () => ({ dev: "", ino: "" }),
      profileHome: "/store",
      resolveEffectiveJournalMode: () => ({
        journalMode: "delete",
        source: "host-observed",
        observed: true,
      }),
    });
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;
    assert.deepEqual(codes(result.changes), ["store-identity-changed"]);
    assert.equal(result.changes[0].after, "unreadable");
  });

  // -------------------------------------------------------------------------
  // config
  // -------------------------------------------------------------------------

  it("reports config-changed when config.yaml is edited from delete to wal", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));
    assert.equal(snapshot.config.journalMode, "delete");

    fs.writeFileSync(configPathFor(home), "database:\n  journal_mode: wal\n");

    const result = revalidateLaunchGateSnapshot(snapshot, revalidateDeps(home));
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;

    assert.ok(codes(result.changes).includes("config-changed"));
    const change = result.changes.find((entry) => entry.field === "journalMode");
    assert.ok(change, "expected a journalMode change");
    assert.equal(change.storePath, configPathFor(home));
    assert.equal(change.before, "delete");
    assert.equal(change.after, "wal");
  });

  it("reports config-changed when the config becomes unobservable", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));

    // A directory where the config file was: the reader cannot read it.
    fs.rmSync(configPathFor(home));
    fs.mkdirSync(configPathFor(home));

    const result = revalidateLaunchGateSnapshot(snapshot, revalidateDeps(home));
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;

    const changedFields = result.changes.map((change) => change.field);
    assert.ok(changedFields.includes("journalMode"));
    assert.ok(changedFields.includes("observed"));
    for (const change of result.changes) {
      assert.equal(change.code, "config-changed");
      assert.equal(change.storePath, configPathFor(home));
    }
  });

  it("fails closed when the config reader throws", () => {
    const home = newProfileHome();
    const storePath = path.join(home, "state.db");
    const snapshot = captureLaunchGateSnapshot([identityOf(storePath)], configOf(home));

    const result = revalidateLaunchGateSnapshot(
      snapshot,
      revalidateDeps(home, {
        resolveEffectiveJournalMode: () => {
          const error = new Error("input/output error") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        },
      }),
    );
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;
    const change = result.changes.find((entry) => entry.field === "journalMode");
    assert.ok(change);
    assert.equal(change.after, "unreadable");
    assert.match(change.detail ?? "", /could not be re-read/);
    assert.match(change.detail ?? "", /input\/output error/);
  });

  it("fails closed when no config reader is supplied, even for an unreadable snapshot", () => {
    const snapshot = captureLaunchGateSnapshot(
      [],
      { journalMode: "unreadable", source: "unreadable", observed: false },
    );

    const result = revalidateLaunchGateSnapshot(snapshot, { profileHome: "/store" });
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;
    assert.deepEqual(codes(result.changes), ["config-changed"]);
    assert.match(result.changes[0].detail ?? "", /no effective journal-mode reader/);
  });

  it("fails closed when the config cannot be re-read because no profile home is known", () => {
    const snapshot = captureLaunchGateSnapshot(
      [],
      { journalMode: "delete", source: "host-observed", observed: true },
    );

    const result = revalidateLaunchGateSnapshot(snapshot, {
      resolveEffectiveJournalMode: () => {
        throw new Error("must not be called without a profile home");
      },
    });
    assert.equal(result.unchanged, false);
    if (result.unchanged) return;
    assert.equal(
      codes(result.changes).every((code) => code === "config-changed"),
      true,
    );
    // journalMode, observed and source all move to `unreadable` together; each
    // change names the same cause.
    assert.ok(result.changes.some((change) => change.field === "journalMode"));
    for (const change of result.changes) {
      assert.match(change.detail ?? "", /no profile home/);
    }
  });

  // -------------------------------------------------------------------------
  // module boundary
  // -------------------------------------------------------------------------

  it("re-reads no header and imports neither the byte reader nor the evaluator", () => {
    const source = fs.readFileSync(MODULE_PATH, "utf8");

    // The comparison is membership + config ONLY: no header observation exists
    // in this module, so the accepted window is visible in the source.
    for (const forbidden of [
      "readFileSync",
      "createReadStream",
      "openSync",
      "readSync",
      "SQLite format 3",
    ]) {
      assert.equal(source.includes(forbidden), false, `module must not reference ${forbidden}`);
    }
    for (const forbidden of ["store-header", "launch-gate.js", "node:child_process"]) {
      assert.equal(source.includes(forbidden), false, `module must not reference ${forbidden}`);
    }

    // Parallel lane: this test file is not in the serial classification list.
    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.equal(
      serialEntries.includes("src/installer/matchlock/launch-gate-revalidate.test.ts"),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// wiring: the PRODUCTION default of the revalidation seam
// ---------------------------------------------------------------------------

describe("G8 launch-gate wiring with the production revalidation (US-002)", () => {
  /** One scheduled-attempt scope over a real profile home. */
  function scopeFor(home: string): any {
    return {
      kind: "scheduled-attempt",
      invocationId: "run-77.round-2.attempt-1",
      runId: "run-77",
      roundId: "round-2",
      profileHome: home,
      mountPlan: interactiveStoreMountPlan(home),
      configOptions: { managedDir: null },
    };
  }

  /**
   * Wiring deps that move the world AFTER the evaluator returned its verdict
   * and BEFORE revalidation runs — the observe-to-create window, reproduced
   * with no seam replacing the production revalidation itself.
   */
  function depsThatMutate(stateDir: string, mutate: () => void): any {
    return {
      now: sequenceNow(),
      stateDir,
      evaluateGate: (input: unknown) => {
        const verdict = evaluateGate(input as any);
        mutate();
        return verdict;
      },
    };
  }

  function readRefusalReceipt(decision: any) {
    return parseReceipt(fs.readFileSync(decision.refusal.receiptPath, "utf8").trimEnd());
  }

  it("allows an unchanged store set and still returns its binding", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const storePath = path.join(home, "state.db");

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      now: sequenceNow(),
      stateDir,
    });

    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;
    assert.equal(decision.binding.kind, "scheduled-attempt");
    assert.equal(decision.binding.stores.length, 1);
    assert.equal(decision.binding.stores[0].canonicalPath, fs.realpathSync(storePath));
    assert.equal(decision.binding.configJournalMode, "delete");
    assert.equal(fs.existsSync(decision.binding.receiptPath), false);
  });

  it("refuses operationally when a store is replaced between evaluate and create", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const storePath = path.join(home, "state.db");
    const realPath = fs.realpathSync(storePath);

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      depsThatMutate(stateDir, () => {
        const replacement = path.join(home, "swapped.db");
        fs.copyFileSync(storePath, replacement);
        fs.renameSync(replacement, storePath);
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(decision.refusal.receiptWritten, true);
    // The ten reason codes are closed: no invented code for a changed world.
    assert.deepEqual(decision.refusal.findings, []);
    assert.ok(decision.refusal.detail.includes(realPath));
    assert.ok(decision.refusal.detail.includes("store-identity-changed"));
    assert.ok(decision.refusal.detail.includes("dev/ino"));

    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.deepEqual(receipt.findings, []);
    assert.match(receipt.storeSetKey, /^sha256:[0-9a-f]{64}$/);
  });

  it("refuses operationally when config.yaml is edited between evaluate and create", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      depsThatMutate(stateDir, () => {
        fs.writeFileSync(configPathFor(home), "database:\n  journal_mode: wal\n");
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.deepEqual(decision.refusal.findings, []);
    assert.ok(decision.refusal.detail.includes("config-changed"));
    assert.ok(decision.refusal.detail.includes(configPathFor(home)));
    assert.ok(decision.refusal.detail.includes("journalMode"));

    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.verdict, "refuse");
    assert.deepEqual(receipt.findings, []);
  });

  it("refuses operationally when a store appears between evaluate and create", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const appearedPath = path.join(home, "kanban.db");

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      depsThatMutate(stateDir, () => {
        const database = new DatabaseSync(appearedPath);
        database.exec("CREATE TABLE k (id INTEGER PRIMARY KEY)");
        database.close();
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.deepEqual(decision.refusal.findings, []);
    assert.ok(decision.refusal.detail.includes("store-set-changed"));
    assert.ok(decision.refusal.detail.includes(fs.realpathSync(appearedPath)));
    assert.ok(decision.refusal.detail.includes("membership"));

    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.verdict, "refuse");
    assert.deepEqual(receipt.findings, []);
  });

  it("writes NO receipt when the store set is unchanged", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const storePath = path.join(home, "state.db");

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      now: sequenceNow(),
      stateDir,
    });
    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;

    const receiptDir = path.dirname(decision.binding.receiptPath);
    assert.equal(fs.existsSync(decision.binding.receiptPath), false);
    assert.equal(
      fs.existsSync(receiptDir) && fs.readdirSync(receiptDir).length > 0,
      false,
    );
    assert.ok(identityOf(storePath).ino !== "");
  });
});
