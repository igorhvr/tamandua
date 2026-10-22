/**
 * store-observation-adapter tests (G4-B ADAPTER US-001).
 *
 * These tests drive the REAL reader: each case calls `observeStore()` from
 * src/installer/matchlock/store-header.ts on a real path crafted under
 * `tamanduaShortTempDir()`, then adapts that observation with
 * `adaptStoreObservation` and asserts the resulting three-state presence.
 * Fixture-only observation objects are used only as a complementary mapping
 * table, never as the sole evidence for a filesystem behaviour.
 *
 * The module under test is pure transport: the purity block at the bottom pins
 * that it imports no I/O module at runtime and that this file stays in the
 * parallel lane.
 *
 * The (1,1) version pair is described as "rollback-format" throughout. It
 * covers every rollback-journal flavour, so nothing here labels it as a
 * particular journal sub-mode.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  observeStore,
  type StoreObservation,
} from "../../../dist/installer/matchlock/store-header.js";
import {
  adaptStoreObservation,
  canonicalPathObserved,
} from "../../../dist/installer/matchlock/store-observation-adapter.js";
import {
  evaluateGate,
  type EvaluatedStore,
  type GateInput,
  type GateVerdict,
  type StoreConfigObservation,
} from "../../../dist/installer/matchlock/launch-gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "store-observation-adapter.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");

const SQLITE_MAGIC = Buffer.from("SQLite format 3\u0000", "latin1");
const HEADER_SIZE = 100;

const createdDirs: string[] = [];

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function fixtureDir(prefix: string): string {
  const dir = tamanduaShortTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

/** Restore permissions so teardown can always descend and unlink. */
function unlockTree(target: string): void {
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // already gone, or not ours to chmod
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      unlockTree(child);
    } else {
      try {
        fs.chmodSync(child, 0o644);
      } catch {
        // best effort
      }
    }
  }
}

after(() => {
  for (const dir of createdDirs) {
    unlockTree(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; a leftover short temp dir is harmless
    }
  }
});

/** Write a `size`-byte database header carrying the given version pair. */
function writeHeaderFixture(
  file: string,
  pair: [number, number],
  size: number = HEADER_SIZE,
): void {
  const buf = Buffer.alloc(size);
  SQLITE_MAGIC.copy(buf, 0);
  buf.writeUInt16BE(4096, 16);
  buf[18] = pair[0];
  buf[19] = pair[1];
  fs.writeFileSync(file, buf);
}

// ---------------------------------------------------------------------------
// presence mapping derived from the real reader
// ---------------------------------------------------------------------------

describe("store-observation-adapter: presence from the real reader", () => {
  it("maps a stat-failed store inside a mode-000 directory to unresolved", () => {
    const dir = fixtureDir("soa-locked-dir-");
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked, { mode: 0o755 });
    const storePath = path.join(locked, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    fs.chmodSync(locked, 0o000);
    try {
      const observation: StoreObservation = observeStore(storePath);

      // The reader could not even see the entry: cannot-look, not gone.
      assert.equal(observation.exists, false);
      assert.ok(
        observation.findingCodes.includes("permission-denied"),
        "a mode-000 parent must be reported as permission-denied",
      );
      assert.ok(
        !observation.findingCodes.includes("store-missing"),
        "a permission failure is never store-missing",
      );

      const store = adaptStoreObservation(observation, "required");
      assert.equal(store.presence, "unresolved");
      assert.equal(store.identity, null);
      assert.equal(store.config, null);
      assert.equal(store.header, null);
      assert.equal(store.requestedPath, storePath);
      assert.equal(store.required, true);
      assert.deepEqual(store.findingCodesFromReader, observation.findingCodes);
      assert.deepEqual(store.sidecars, observation.sidecars);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("maps an unreadable (mode-000) store file to unresolved, never confirmed-absent", () => {
    const dir = fixtureDir("soa-locked-file-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);
    fs.chmodSync(storePath, 0o000);

    try {
      const observation = observeStore(storePath);

      // The entry was seen; only its bytes were refused.
      assert.equal(observation.exists, true);
      assert.notEqual(observation.readable, true);
      assert.ok(observation.findingCodes.includes("permission-denied"));
      assert.ok(!observation.findingCodes.includes("store-missing"));

      const store = adaptStoreObservation(observation, "required");
      assert.equal(store.presence, "unresolved");
      assert.ok(
        store.findingCodesFromReader.includes("permission-denied"),
        "the permission-denied evidence must survive adaptation",
      );
      assert.equal(store.identity, null);
    } finally {
      fs.chmodSync(storePath, 0o644);
    }
  });

  it("maps a genuine ENOENT to confirmed-absent with a null identity", () => {
    const dir = fixtureDir("soa-missing-");
    const storePath = path.join(dir, "never-created.db");

    const observation = observeStore(storePath);
    assert.equal(observation.exists, false);
    assert.deepEqual(
      observation.findingCodes,
      ["store-missing"],
      "a bare ENOENT yields exactly store-missing",
    );

    const required = adaptStoreObservation(observation, "required");
    assert.equal(required.presence, "confirmed-absent");
    assert.equal(required.identity, null);
    assert.equal(required.config, null);
    assert.equal(required.header, null);
    assert.equal(required.required, true);
    assert.deepEqual(required.findingCodesFromReader, ["store-missing"]);

    const optional = adaptStoreObservation(observation, "optional-present");
    assert.equal(optional.presence, "confirmed-absent");
    assert.equal(optional.required, false);

    const inactive = adaptStoreObservation(observation, "inactive");
    assert.equal(inactive.presence, "confirmed-absent");
    assert.equal(inactive.required, false);
  });

  it("maps a readable rollback-format store to present", () => {
    const dir = fixtureDir("soa-present-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    const observation = observeStore(storePath);
    assert.equal(observation.exists, true);
    assert.equal(observation.readable, true);
    assert.equal(observation.magicOk, true);
    assert.equal(observation.headerFormat, "rollback");
    assert.deepEqual(observation.findingCodes, []);
    assert.deepEqual(observation.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "absent",
    });

    const store = adaptStoreObservation(observation, "optional-present");
    assert.equal(store.presence, "present");
    assert.equal(store.requestedPath, storePath);
    assert.equal(store.required, false);
    assert.deepEqual(store.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "absent",
    });
    assert.deepEqual(store.findingCodesFromReader, []);
  });
});

// ---------------------------------------------------------------------------
// canonical path provenance and present-store identity
// ---------------------------------------------------------------------------

describe("store-observation-adapter: canonical path provenance and identity", () => {
  it("proves provenance for a symlink whose realpath differs from the spelling", () => {
    const dir = fixtureDir("soa-symlink-");
    const target = path.join(dir, "target.db");
    writeHeaderFixture(target, [1, 1]);
    const link = path.join(dir, "link.db");
    fs.symlinkSync(target, link);

    const observation = observeStore(link);
    assert.equal(observation.exists, true);
    assert.equal(observation.canonicalPath, fs.realpathSync(target));
    assert.notEqual(observation.canonicalPath, path.resolve(link));

    assert.equal(canonicalPathObserved(observation, link), true);

    const store = adaptStoreObservation(observation, "required");
    assert.equal(store.presence, "present");
    assert.notEqual(store.identity, null);
    assert.equal(store.identity?.canonicalPath, observation.canonicalPath);
    assert.notEqual(store.identity?.canonicalPath, link);
    // No caller context was supplied, so the unobservable identity fields
    // stay null rather than being guessed from the path.
    assert.equal(store.identity?.dev, null);
    assert.equal(store.identity?.ino, null);
    assert.equal(store.identity?.fstype, null);
  });

  it("keeps the caller's dot-dot spelling when resolution equals the reader fallback", () => {
    const dir = fixtureDir("soa-dotdot-");
    fs.mkdirSync(path.join(dir, "sub"));
    const actual = path.join(dir, "state.db");
    writeHeaderFixture(actual, [1, 1]);
    const spelling = path.join(dir, "sub") + "/../state.db";

    const observation = observeStore(spelling);
    assert.equal(observation.path, spelling);
    assert.equal(observation.exists, true);
    // realpath and the reader fallback agree on this value, so provenance
    // cannot be distinguished: the flag must be conservatively false.
    assert.equal(observation.canonicalPath, path.resolve(spelling));
    assert.notEqual(spelling, path.resolve(spelling));

    assert.equal(canonicalPathObserved(observation, spelling), false);

    const store = adaptStoreObservation(observation, "required");
    assert.equal(store.presence, "present");
    assert.equal(store.identity?.canonicalPath, spelling);
    assert.notEqual(store.identity?.canonicalPath, path.resolve(spelling));
  });

  it("proves provenance for an already-absolute unchanged present store", () => {
    const dir = fixtureDir("soa-absolute-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    const observation = observeStore(storePath);
    assert.equal(observation.exists, true);
    assert.equal(observation.canonicalPath, storePath);

    assert.equal(canonicalPathObserved(observation, storePath), true);

    const store = adaptStoreObservation(observation, "required");
    assert.equal(store.identity?.canonicalPath, storePath);
  });

  it("reports no provenance and a null identity for a missing path", () => {
    const dir = fixtureDir("soa-missing-provenance-");
    const storePath = path.join(dir, "never-created.db");

    const observation = observeStore(storePath);
    assert.equal(canonicalPathObserved(observation, storePath), false);

    const store = adaptStoreObservation(observation, "required");
    assert.equal(store.presence, "confirmed-absent");
    assert.equal(store.identity, null);
  });

  it("carries a null identity for an unresolved store", () => {
    const dir = fixtureDir("soa-unresolved-identity-");
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked, { mode: 0o755 });
    const storePath = path.join(locked, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    fs.chmodSync(locked, 0o000);
    try {
      const observation = observeStore(storePath);
      const store = adaptStoreObservation(observation, "required");
      assert.equal(store.presence, "unresolved");
      assert.equal(store.identity, null);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("passes caller-supplied dev/ino/fstype through and defaults them to null", () => {
    const dir = fixtureDir("soa-identity-context-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);
    const observation = observeStore(storePath);

    const supplied = adaptStoreObservation(observation, "required", {
      dev: "2049",
      ino: "424242",
      fstype: "ext4",
    });
    assert.deepEqual(supplied.identity, {
      canonicalPath: storePath,
      dev: "2049",
      ino: "424242",
      fstype: "ext4",
    });

    const omitted = adaptStoreObservation(observation, "required");
    assert.equal(omitted.identity?.dev, null);
    assert.equal(omitted.identity?.ino, null);
    assert.equal(omitted.identity?.fstype, null);

    const partial = adaptStoreObservation(observation, "optional-present", {
      dev: "2049",
    });
    assert.equal(partial.identity?.dev, "2049");
    assert.equal(partial.identity?.ino, null);
    assert.equal(partial.identity?.fstype, null);
  });
});

// ---------------------------------------------------------------------------
// mapping table (complementary to the real-reader cases above)
// ---------------------------------------------------------------------------

describe("store-observation-adapter: presence mapping table", () => {
  /** A minimal observation; every case overrides only what it exercises. */
  function observation(
    overrides: Partial<StoreObservation>,
  ): StoreObservation {
    return {
      path: "/profile/stores/main.db",
      canonicalPath: "/profile/stores/main.db",
      exists: false,
      readable: false,
      magicOk: false,
      headerFormat: "unknown",
      rawBytes1819: null,
      fileSize: null,
      sidecars: { wal: "absent", shm: "absent", journal: "absent" },
      findingCodes: [],
      ...overrides,
    };
  }

  const cases: Array<{
    name: string;
    observation: StoreObservation;
    expected: "present" | "confirmed-absent" | "unresolved";
  }> = [
    {
      name: "readable present store is present",
      observation: observation({ exists: true, readable: true }),
      expected: "present",
    },
    {
      name: "seen but permission-denied and unreadable is unresolved",
      observation: observation({
        exists: true,
        readable: false,
        findingCodes: ["permission-denied"],
      }),
      expected: "unresolved",
    },
    {
      name: "store-missing with no permission failure is confirmed-absent",
      observation: observation({
        exists: false,
        findingCodes: ["store-missing"],
      }),
      expected: "confirmed-absent",
    },
    {
      name: "permission-denied on the parent is unresolved",
      observation: observation({
        exists: false,
        findingCodes: ["permission-denied"],
      }),
      expected: "unresolved",
    },
    {
      name: "permission-denied wins over a contradictory store-missing",
      observation: observation({
        exists: false,
        findingCodes: ["store-missing", "permission-denied"],
      }),
      expected: "unresolved",
    },
    {
      name: "a header-unreadable stat failure is unresolved",
      observation: observation({
        exists: false,
        findingCodes: ["header-unreadable"],
      }),
      expected: "unresolved",
    },
    {
      name: "no findings and not seen is unresolved, never absent",
      observation: observation({ exists: false, findingCodes: [] }),
      expected: "unresolved",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const store = adaptStoreObservation(testCase.observation, "required");
      assert.equal(store.presence, testCase.expected);
      assert.equal(store.requestedPath, testCase.observation.path);
      assert.equal(store.findingCodesFromReader, testCase.observation.findingCodes);

      if (testCase.expected !== "present") {
        assert.equal(store.identity, null);
        assert.equal(store.config, null);
        assert.equal(store.header, null);
      }
    });
  }

  it("threads sidecars unchanged for a non-present store", () => {
    const orphaned = observation({
      exists: false,
      findingCodes: ["store-missing", "sidecar-unresolved"],
      sidecars: { wal: "absent", shm: "absent", journal: "presentNonEmpty" },
    });
    const store = adaptStoreObservation(orphaned, "required");
    assert.equal(store.presence, "confirmed-absent");
    assert.deepEqual(store.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "presentNonEmpty",
    });
    assert.deepEqual(store.findingCodesFromReader, [
      "store-missing",
      "sidecar-unresolved",
    ]);
  });
});

// ---------------------------------------------------------------------------
// config/header/sidecar transport and adapter-to-gate verdicts
// ---------------------------------------------------------------------------

describe("store-observation-adapter: transport and gate verdicts", () => {
  /** The effective setting the gate requires for a present store. */
  const DELETE_CONFIG: StoreConfigObservation = {
    journalMode: "delete",
    source: "guest-config",
    observed: true,
  };

  /** A complete inventory: enumeration finished, so nothing is unknown. */
  function completeInventory(stores: EvaluatedStore[]): GateInput {
    return { inventoryComplete: true, incompleteReasons: [], stores };
  }

  function codes(verdict: GateVerdict): string[] {
    return verdict.findings.map((finding) => finding.code);
  }

  it("copies a present store's header fields and carries the caller's config unchanged", () => {
    const dir = fixtureDir("soa-transport-present-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    const observation = observeStore(storePath);
    const store = adaptStoreObservation(observation, "required", {
      config: DELETE_CONFIG,
    });

    assert.equal(store.presence, "present");
    assert.deepEqual(store.header, {
      headerFormat: observation.headerFormat,
      rawBytes1819: observation.rawBytes1819,
      magicOk: observation.magicOk,
      readable: observation.readable,
      fileSize: observation.fileSize,
    });
    assert.equal(store.header?.headerFormat, "rollback");
    assert.deepEqual(store.header?.rawBytes1819, [1, 1]);
    assert.equal(store.header?.magicOk, true);
    assert.equal(store.header?.readable, true);
    assert.equal(store.header?.fileSize, HEADER_SIZE);
    // Passed through unchanged, never rewritten or defaulted.
    assert.deepEqual(store.config, DELETE_CONFIG);
    assert.deepEqual(store.sidecars, observation.sidecars);
    assert.deepEqual(store.findingCodesFromReader, observation.findingCodes);

    const verdict = evaluateGate(completeInventory([store]));
    assert.equal(verdict.action, "allow", JSON.stringify(verdict.findings));
    assert.deepEqual(verdict.findings, []);
  });

  it("leaves a present store's config null when the caller supplies none", () => {
    const dir = fixtureDir("soa-transport-no-config-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    const store = adaptStoreObservation(observeStore(storePath), "inactive");
    assert.equal(store.presence, "present");
    assert.equal(store.config, null);
    // Absence of config evidence is a refusal, never an implicit pass.
    const verdict = evaluateGate(completeInventory([store]));
    assert.equal(verdict.action, "refuse");
    assert.ok(codes(verdict).includes("not-delete-config"));
  });

  it("carries null config and header for a non-present store while keeping observed evidence", () => {
    const dir = fixtureDir("soa-transport-missing-");
    const storePath = path.join(dir, "never-created.db");

    const observation = observeStore(storePath);
    const store = adaptStoreObservation(observation, "required", {
      config: DELETE_CONFIG,
    });

    assert.equal(store.presence, "confirmed-absent");
    // A non-present path has no header to observe and no config to demand,
    // even when the caller supplied one.
    assert.equal(store.header, null);
    assert.equal(store.config, null);
    assert.equal(store.identity, null);
    // The reader's own evidence still survives adaptation.
    assert.deepEqual(store.sidecars, observation.sidecars);
    assert.deepEqual(store.findingCodesFromReader, observation.findingCodes);
    assert.deepEqual(store.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "absent",
    });
  });

  it("maps required only for the 'required' classification", () => {
    const dir = fixtureDir("soa-transport-required-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);
    const observation = observeStore(storePath);

    assert.equal(
      adaptStoreObservation(observation, "required").required,
      true,
    );
    assert.equal(
      adaptStoreObservation(observation, "optional-present").required,
      false,
    );
    assert.equal(
      adaptStoreObservation(observation, "inactive").required,
      false,
    );
  });

  it("refuses a required ENOENT store adapted from the real reader with store-missing", () => {
    const dir = fixtureDir("soa-gate-required-missing-");
    const storePath = path.join(dir, "never-created.db");

    const store = adaptStoreObservation(observeStore(storePath), "required", {
      config: DELETE_CONFIG,
    });
    assert.equal(store.presence, "confirmed-absent");

    const verdict = evaluateGate(completeInventory([store]));
    assert.equal(verdict.action, "refuse");
    assert.ok(
      codes(verdict).includes("store-missing"),
      `expected store-missing, got ${JSON.stringify(codes(verdict))}`,
    );
    assert.ok(!codes(verdict).includes("path-unresolved"));
    const missing = verdict.findings.find(
      (finding) => finding.code === "store-missing",
    );
    assert.equal(missing?.store, storePath);
  });

  it("allows an optional ENOENT store alongside a present compliant store", () => {
    const dir = fixtureDir("soa-gate-optional-missing-");
    const presentPath = path.join(dir, "present.db");
    writeHeaderFixture(presentPath, [1, 1]);
    const missingPath = path.join(dir, "never-created.db");

    const present = adaptStoreObservation(observeStore(presentPath), "required", {
      config: DELETE_CONFIG,
    });
    const optional = adaptStoreObservation(
      observeStore(missingPath),
      "optional-present",
      { config: DELETE_CONFIG },
    );
    assert.equal(present.presence, "present");
    assert.equal(optional.presence, "confirmed-absent");
    assert.equal(optional.required, false);

    // A lone absence is a fresh profile, which the gate refuses by design
    // (ALLOW_FRESH_STORE is false); the present store makes the set real.
    const verdict = evaluateGate(completeInventory([present, optional]));
    assert.equal(verdict.action, "allow", JSON.stringify(verdict.findings));
    assert.deepEqual(verdict.findings, []);
  });

  it("allows a present compliant rollback-format store", () => {
    const dir = fixtureDir("soa-gate-present-compliant-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    const store = adaptStoreObservation(observeStore(storePath), "required", {
      config: DELETE_CONFIG,
    });
    assert.equal(store.presence, "present");

    const verdict = evaluateGate(completeInventory([store]));
    assert.equal(verdict.action, "allow", JSON.stringify(verdict.findings));
  });

  it("refuses a present store with a nonempty -journal sidecar", () => {
    const dir = fixtureDir("soa-gate-journal-");
    const storePath = path.join(dir, "state.db");
    writeHeaderFixture(storePath, [1, 1]);
    fs.writeFileSync(`${storePath}-journal`, "nonempty rollback journal");

    const observation = observeStore(storePath);
    assert.equal(observation.sidecars.journal, "presentNonEmpty");

    const store = adaptStoreObservation(observation, "required", {
      config: DELETE_CONFIG,
    });
    // The store itself is present; only the leftover journal is unresolved.
    assert.equal(store.presence, "present");
    assert.deepEqual(store.sidecars, observation.sidecars);

    const verdict = evaluateGate(completeInventory([store]));
    assert.equal(verdict.action, "refuse");
    assert.ok(
      codes(verdict).includes("sidecar-unresolved"),
      `expected sidecar-unresolved, got ${JSON.stringify(codes(verdict))}`,
    );
    assert.ok(!codes(verdict).includes("store-missing"));
  });

  it("refuses an unreadable store path with path-unresolved and never store-missing", () => {
    const dir = fixtureDir("soa-gate-unreadable-");
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked, { mode: 0o755 });
    const storePath = path.join(locked, "state.db");
    writeHeaderFixture(storePath, [1, 1]);

    fs.chmodSync(locked, 0o000);
    try {
      const observation = observeStore(storePath);
      const store = adaptStoreObservation(observation, "required", {
        config: DELETE_CONFIG,
      });
      assert.equal(store.presence, "unresolved");
      assert.equal(store.config, null);
      assert.equal(store.header, null);
      // Evidence survives: the reader saw a permission failure.
      assert.ok(store.findingCodesFromReader.includes("permission-denied"));
      assert.deepEqual(store.sidecars, observation.sidecars);

      const verdict = evaluateGate(completeInventory([store]));
      assert.equal(verdict.action, "refuse");
      assert.ok(
        codes(verdict).includes("path-unresolved"),
        `expected path-unresolved, got ${JSON.stringify(codes(verdict))}`,
      );
      assert.ok(
        codes(verdict).includes("permission-denied"),
        "the permission refinement must reach the gate",
      );
      assert.ok(
        !codes(verdict).includes("store-missing"),
        "cannot-look must never be reported as absence",
      );
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// six-scenario end-to-end matrix (real reader -> adapter -> gate)
// ---------------------------------------------------------------------------

describe("store-observation-adapter: six-scenario end-to-end matrix", () => {
  /** The effective setting the gate requires for a present store. */
  const DELETE_CONFIG: StoreConfigObservation = {
    journalMode: "delete",
    source: "guest-config",
    observed: true,
  };

  interface MatrixCase {
    observations: StoreObservation[];
    stores: EvaluatedStore[];
    presence: Array<EvaluatedStore["presence"]>;
    provenance: boolean[];
    identityCanonicalPaths: Array<string | null>;
    action: "allow" | "refuse";
    codes: string[];
    forbiddenCodes: string[];
  }

  function singleCase(
    observation: StoreObservation,
    store: EvaluatedStore,
    expected: {
      presence: EvaluatedStore["presence"];
      action: "allow" | "refuse";
      codes: string[];
      forbiddenCodes?: string[];
    },
  ): MatrixCase {
    return {
      observations: [observation],
      stores: [store],
      presence: [expected.presence],
      provenance: [canonicalPathObserved(observation, observation.path)],
      identityCanonicalPaths: [store.identity?.canonicalPath ?? null],
      action: expected.action,
      codes: expected.codes,
      forbiddenCodes: expected.forbiddenCodes ?? [],
    };
  }

  /**
   * One row per bead scenario. ENOENT has two rows because the bead requires
   * both the required-refusal and the optional-allow outcome; together the
   * rows cover all six scenarios of the C5 matrix.
   */
  const scenarios: Array<{ name: string; build: (dir: string) => MatrixCase }> = [
    {
      name: "stat-failed inside a mode-000 directory is unresolved, never store-missing",
      build: (dir) => {
        const locked = path.join(dir, "locked");
        fs.mkdirSync(locked, { mode: 0o755 });
        const storePath = path.join(locked, "state.db");
        writeHeaderFixture(storePath, [1, 1]);
        fs.chmodSync(locked, 0o000);
        try {
          const observation = observeStore(storePath);
          const store = adaptStoreObservation(observation, "required", {
            config: DELETE_CONFIG,
          });
          return singleCase(observation, store, {
            presence: "unresolved",
            action: "refuse",
            codes: ["path-unresolved", "permission-denied"],
            forbiddenCodes: ["store-missing"],
          });
        } finally {
          fs.chmodSync(locked, 0o755);
        }
      },
    },
    {
      name: "EACCES on the store file itself is unresolved and permission-denied",
      build: (dir) => {
        const storePath = path.join(dir, "state.db");
        writeHeaderFixture(storePath, [1, 1]);
        fs.chmodSync(storePath, 0o000);
        try {
          const observation = observeStore(storePath);
          const store = adaptStoreObservation(observation, "required", {
            config: DELETE_CONFIG,
          });
          return singleCase(observation, store, {
            presence: "unresolved",
            action: "refuse",
            codes: ["path-unresolved", "permission-denied"],
            forbiddenCodes: ["store-missing"],
          });
        } finally {
          fs.chmodSync(storePath, 0o644);
        }
      },
    },
    {
      name: "realpath fallback TRUE: a symlink proves provenance and allows",
      build: (dir) => {
        const target = path.join(dir, "target.db");
        writeHeaderFixture(target, [1, 1]);
        const link = path.join(dir, "link.db");
        fs.symlinkSync(target, link);

        const observation = observeStore(link);
        const store = adaptStoreObservation(observation, "required", {
          config: DELETE_CONFIG,
        });
        const resolvedTarget = fs.realpathSync(target);
        assert.equal(canonicalPathObserved(observation, link), true);
        assert.equal(store.identity?.canonicalPath, resolvedTarget);
        return {
          observations: [observation],
          stores: [store],
          presence: ["present"],
          provenance: [true],
          identityCanonicalPaths: [resolvedTarget],
          action: "allow",
          codes: [],
          forbiddenCodes: [],
        };
      },
    },
    {
      name: "realpath fallback FALSE: a dot-dot spelling keeps its requested spelling",
      build: (dir) => {
        fs.mkdirSync(path.join(dir, "sub"));
        writeHeaderFixture(path.join(dir, "state.db"), [1, 1]);
        // path.join() normalizes "..", so compose the spelling directly.
        const spelling = path.join(dir, "sub") + "/../state.db";

        const observation = observeStore(spelling);
        const store = adaptStoreObservation(observation, "required", {
          config: DELETE_CONFIG,
        });
        assert.equal(canonicalPathObserved(observation, spelling), false);
        assert.equal(store.identity?.canonicalPath, spelling);
        return {
          observations: [observation],
          stores: [store],
          presence: ["present"],
          provenance: [false],
          identityCanonicalPaths: [spelling],
          action: "allow",
          codes: [],
          forbiddenCodes: [],
        };
      },
    },
    {
      name: "genuine ENOENT: a required store refuses with store-missing",
      build: (dir) => {
        const storePath = path.join(dir, "never-created.db");
        const observation = observeStore(storePath);
        const store = adaptStoreObservation(observation, "required", {
          config: DELETE_CONFIG,
        });
        return singleCase(observation, store, {
          presence: "confirmed-absent",
          action: "refuse",
          codes: ["store-missing"],
          forbiddenCodes: ["path-unresolved"],
        });
      },
    },
    {
      name: "genuine ENOENT: an optional store allows beside a present compliant store",
      build: (dir) => {
        const presentPath = path.join(dir, "present.db");
        writeHeaderFixture(presentPath, [1, 1]);
        const missingPath = path.join(dir, "never-created.db");

        const presentObservation = observeStore(presentPath);
        const presentStore = adaptStoreObservation(
          presentObservation,
          "required",
          { config: DELETE_CONFIG },
        );
        const missingObservation = observeStore(missingPath);
        const missingStore = adaptStoreObservation(
          missingObservation,
          "optional-present",
          { config: DELETE_CONFIG },
        );
        return {
          observations: [presentObservation, missingObservation],
          stores: [presentStore, missingStore],
          presence: ["present", "confirmed-absent"],
          provenance: [true, false],
          identityCanonicalPaths: [presentPath, null],
          action: "allow",
          codes: [],
          forbiddenCodes: [],
        };
      },
    },
    {
      name: "present compliant store allows",
      build: (dir) => {
        const storePath = path.join(dir, "state.db");
        writeHeaderFixture(storePath, [1, 1]);
        const observation = observeStore(storePath);
        const store = adaptStoreObservation(observation, "required", {
          config: DELETE_CONFIG,
        });
        return singleCase(observation, store, {
          presence: "present",
          action: "allow",
          codes: [],
        });
      },
    },
    {
      name: "present store with a nonempty -journal refuses sidecar-unresolved",
      build: (dir) => {
        const storePath = path.join(dir, "state.db");
        writeHeaderFixture(storePath, [1, 1]);
        fs.writeFileSync(`${storePath}-journal`, "nonempty rollback journal");
        const observation = observeStore(storePath);
        const store = adaptStoreObservation(observation, "required", {
          config: DELETE_CONFIG,
        });
        return singleCase(observation, store, {
          presence: "present",
          action: "refuse",
          codes: ["sidecar-unresolved"],
          forbiddenCodes: ["store-missing"],
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const dir = fixtureDir("soa-matrix-");
      const result = scenario.build(dir);

      assert.equal(
        result.stores.length,
        result.presence.length,
        "every adapted store needs an expected presence",
      );
      result.stores.forEach((store, index) => {
        assert.equal(
          store.presence,
          result.presence[index],
          `store ${index} presence`,
        );
        assert.equal(
          canonicalPathObserved(
            result.observations[index],
            result.observations[index].path,
          ),
          result.provenance[index],
          `store ${index} canonical-path provenance`,
        );
        assert.equal(
          store.identity?.canonicalPath ?? null,
          result.identityCanonicalPaths[index],
          `store ${index} identity canonical path`,
        );
      });

      const verdict = evaluateGate({
        inventoryComplete: true,
        incompleteReasons: [],
        stores: result.stores,
      });
      const codes = verdict.findings.map((finding) => finding.code);
      assert.equal(
        verdict.action,
        result.action,
        `expected ${result.action}, got findings ${JSON.stringify(codes)}`,
      );
      for (const code of result.codes) {
        assert.ok(
          codes.includes(code),
          `expected finding ${code}, got ${JSON.stringify(codes)}`,
        );
      }
      for (const code of result.forbiddenCodes) {
        assert.ok(
          !codes.includes(code),
          `finding ${code} must not appear, got ${JSON.stringify(codes)}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// module purity and lane classification
// ---------------------------------------------------------------------------

describe("store-observation-adapter: module purity", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf8");

  it("has only node:path as a runtime import and no I/O, clock, randomness or environment", () => {
    // Collect value (non-`import type`) module specifiers. Type-only imports
    // are erased and are not part of the runtime dependency graph.
    const runtimeSpecifiers: string[] = [];
    const importPattern = /^\s*import\s+(?!type\b)([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
    for (const match of source.matchAll(importPattern)) {
      runtimeSpecifiers.push(match[2]);
    }
    for (const specifier of runtimeSpecifiers) {
      assert.equal(
        specifier,
        "node:path",
        `the only permitted runtime import is node:path, found ${specifier}`,
      );
    }

    const forbidden = [
      "node:" + "fs",
      "node:" + "child_process",
      "node:" + "os",
      "node:" + "crypto",
      "require" + "(",
      "process",
      "Date",
      "Math" + "." + "random",
    ];
    for (const token of forbidden) {
      assert.ok(
        !source.includes(token),
        `store-observation-adapter.ts must not reference ${token}`,
      );
    }
  });

  it("documents the realpath-fallback residual", () => {
    assert.ok(
      source.includes("REALPATH-FALLBACK RESIDUAL"),
      "the module comment must document the realpath-fallback residual",
    );
    assert.ok(source.includes("path.resolve"), "the residual names the fallback");
    assert.ok(
      source.includes("canonicalPathObserved"),
      "the residual names the provenance proof",
    );
  });

  it("documents three-state presence, the permission refinement and caller-supplied facts", () => {
    assert.ok(
      source.includes("PRESENCE IS THREE-STATE"),
      "the module comment must state that presence is three-state",
    );
    assert.ok(
      source.includes("permission-denied"),
      "the module comment must document the permission-denied refinement",
    );
    assert.ok(
      source.includes("CALLER-SUPPLIED"),
      "the module comment must mark config/identity as caller-supplied",
    );
    for (const field of ["config", "dev", "ino", "fstype"]) {
      assert.ok(
        source.includes(field),
        `the caller-supplied section must name ${field}`,
      );
    }
    assert.ok(
      source.includes("does not carry"),
      "the comment must say StoreObservation does not carry those facts",
    );
  });

  it("pins the two-argument API and exactly one exported declaration", () => {
    // The pinned two-argument call must stay valid: the optional context
    // parameter is defaulted, so Function.length is 2.
    assert.equal(typeof adaptStoreObservation, "function");
    assert.equal(adaptStoreObservation.length, 2);

    const declarations =
      source.match(/export\s+function\s+adaptStoreObservation\b/g) ?? [];
    assert.equal(
      declarations.length,
      1,
      "there must be exactly one exported adaptStoreObservation declaration",
    );
  });

  it("takes classification as the only policy input", () => {
    // Strip comments so documentation may discuss policy without matching the
    // code-level scan below.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    const signature = /export\s+function\s+adaptStoreObservation\s*\(([\s\S]*?)\)\s*:\s*EvaluatedStore/.exec(
      code,
    );
    assert.ok(signature, "the pinned adaptStoreObservation signature must exist");
    const params = signature[1]
      .split(",")
      .map((param) => param.trim())
      .filter((param) => param !== "");
    assert.equal(params.length, 3, "two required params plus the defaulted context");
    assert.match(params[0], /^observation:\s*StoreObservation$/);
    assert.match(params[1], /^classification:\s*StoreClassification$/);
    assert.match(params[2], /^context:\s*StoreAdapterContext\s*=\s*\{\}$/);

    // Classification is the only policy input: no options bag, no policy
    // object, no environment read.
    assert.ok(
      code.includes('classification === "required"'),
      "required must be derived solely from the classification argument",
    );
    for (const token of ["process", "options", "policy", "env", "TAMANDUA_"]) {
      assert.ok(
        !code.includes(token),
        `the module must not consume ${token} as a policy input`,
      );
    }
  });

  it("is not listed in tests/serial-files.txt (parallel lane, no spawns)", () => {
    const ownRelativePath = path.relative(
      REPO_ROOT,
      fileURLToPath(import.meta.url),
    );
    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    assert.ok(
      !serialEntries.includes(ownRelativePath),
      `this parallel test file (${ownRelativePath}) must NOT be listed in ` +
        `tests/serial-files.txt`,
    );
  });
});
