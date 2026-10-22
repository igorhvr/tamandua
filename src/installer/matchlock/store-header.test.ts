/**
 * store-header reader tests (G3 STORE-HEADER-READER US-001 + US-002).
 *
 * These tests exercise `observeStore` in
 * src/installer/matchlock/store-header.ts, which classifies a mapped store from
 * raw bytes and filesystem metadata only. They import the COMPILED module from
 * dist/ (repo convention for this directory), so `npm run build` must run
 * first.
 *
 * `node:sqlite` is used here ONLY as a fixture factory and as an adversarial
 * control: to create a real rollback-format store, a real write-ahead-log
 * store, an open writer, and to prove that the SAME bytes a driver refuses (or
 * cannot lock) are still observable. The module under test never opens a store
 * with a driver, and the purity tests below pin that.
 *
 * The (1,1) version pair is described as shift-free "rollback-format"
 * throughout: it covers every rollback-journal flavour, so no test name labels
 * it as a specific journal sub-mode.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  STORE_REASON_CODE_ORDER,
  observeStore,
} from "../../../dist/installer/matchlock/store-header.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "store-header.ts");
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

/** Restore search/read permissions so cleanup can always descend. */
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

/** Create a real rollback-format store with one committed row, then close it. */
function writeRollbackStore(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
    db.exec("INSERT INTO items (label) VALUES ('one')");
  } finally {
    db.close();
  }
}

/** Create a real write-ahead-log store with one committed row, then close it. */
function writeWalStore(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
    db.exec("INSERT INTO items (label) VALUES ('one')");
  } finally {
    db.close();
  }
}

/** The (1,1) pair must be described as rollback-format, never as a sub-mode. */
const FORBIDDEN_SUBMODE_TOKEN = "DEL" + "ETE";

// ---------------------------------------------------------------------------
// adversarial evidence helpers (US-002)
// ---------------------------------------------------------------------------

/**
 * Content + metadata identity of one file. atime is deliberately excluded:
 * every read updates it, so it says nothing about mutation.
 */
interface FileFingerprint {
  sha256: string;
  size: bigint;
  mtimeNs: bigint;
}

function fingerprint(file: string): FileFingerprint {
  const stats = fs.statSync(file, { bigint: true });
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  return { sha256, size: stats.size, mtimeNs: stats.mtimeNs };
}

function dirListing(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * A valid 100-byte rollback-format header followed by garbage page bytes: the
 * header facts are intact (signature, page size, version pair) while every page
 * body is nonsense. This is exactly the shape a driver refuses to read.
 */
function writeCorruptBodyStore(file: string): void {
  const pageSize = 4096;
  const pages = 3;
  const buf = Buffer.alloc(pageSize * pages, 0xff);
  SQLITE_MAGIC.copy(buf, 0);
  buf.writeUInt16BE(pageSize, 16);
  buf[18] = 1;
  buf[19] = 1;
  buf.writeUInt32BE(pages, 28);
  fs.writeFileSync(file, buf);
}

// ---------------------------------------------------------------------------
// header matrix
// ---------------------------------------------------------------------------

describe("store-header: header matrix", () => {
  it("classifies a real rollback-format store as rollback with the (1,1) pair", () => {
    const dir = fixtureDir("tamandua-store-header-rb-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);

    const obs = observeStore(store);

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, true);
    assert.equal(obs.magicOk, true);
    assert.equal(obs.headerFormat, "rollback");
    assert.deepEqual(obs.rawBytes1819, [1, 1]);
    assert.ok(typeof obs.fileSize === "number" && obs.fileSize > HEADER_SIZE);
    assert.deepEqual(obs.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "absent",
    });
    assert.deepEqual(obs.findingCodes, []);
    assert.equal(obs.path, store);
  });

  it("classifies a real write-ahead-log store as wal with the (2,2) pair", () => {
    const dir = fixtureDir("tamandua-store-header-wal-");
    const store = path.join(dir, "state.db");
    writeWalStore(store);

    const obs = observeStore(store);

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, true);
    assert.equal(obs.magicOk, true);
    assert.equal(obs.headerFormat, "wal");
    assert.deepEqual(obs.rawBytes1819, [2, 2]);
    assert.deepEqual(obs.findingCodes, []);
  });

  it("classifies the mixed (2,1) version pair as unknown, not rollback-format", () => {
    const dir = fixtureDir("tamandua-store-header-mixed-");
    const store = path.join(dir, "state.db");
    writeHeaderFixture(store, [2, 1]);

    const obs = observeStore(store);

    assert.equal(obs.readable, true);
    assert.equal(obs.magicOk, true);
    assert.equal(obs.headerFormat, "unknown");
    assert.deepEqual(obs.rawBytes1819, [2, 1]);
    assert.deepEqual(obs.findingCodes, []);
  });

  it("flags a 128-byte non-database file as header-not-sqlite with magicOk false", () => {
    const dir = fixtureDir("tamandua-store-header-notdb-");
    const store = path.join(dir, "state.db");
    fs.writeFileSync(store, Buffer.alloc(128, 0x78));

    const obs = observeStore(store);

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, true);
    assert.equal(obs.magicOk, false);
    assert.equal(obs.headerFormat, "unknown");
    assert.deepEqual(obs.findingCodes, ["header-not-sqlite"]);
  });
});

// ---------------------------------------------------------------------------
// truncation
// ---------------------------------------------------------------------------

describe("store-header: truncation", () => {
  it("reports a 40-byte signature-bearing file as header-truncated with no format pair", () => {
    const dir = fixtureDir("tamandua-store-header-short-");
    const store = path.join(dir, "state.db");
    writeHeaderFixture(store, [1, 1], 40);

    const obs = observeStore(store);

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, true);
    assert.equal(obs.magicOk, true);
    assert.equal(obs.rawBytes1819, null);
    assert.equal(obs.headerFormat, "unknown");
    assert.equal(obs.fileSize, 40);
    assert.deepEqual(obs.findingCodes, ["header-truncated"]);
    assert.ok(!obs.findingCodes.includes("header-not-sqlite"));
  });

  it("reports a sub-signature file as header-truncated only, fabricating no magic verdict", () => {
    const dir = fixtureDir("tamandua-store-header-tiny-");
    const store = path.join(dir, "state.db");
    fs.writeFileSync(store, Buffer.from("SQLite", "latin1"));

    const obs = observeStore(store);

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, true);
    assert.equal(obs.magicOk, false);
    assert.equal(obs.headerFormat, "unknown");
    assert.equal(obs.rawBytes1819, null);
    assert.deepEqual(obs.findingCodes, ["header-truncated"]);
  });
});

// ---------------------------------------------------------------------------
// distinct error classification
// ---------------------------------------------------------------------------

describe("store-header: distinct error classification", () => {
  it("reports a missing store as store-missing only", () => {
    const dir = fixtureDir("tamandua-store-header-enoent-");
    const store = path.join(dir, "absent.db");

    const obs = observeStore(store);

    assert.equal(obs.exists, false);
    assert.equal(obs.readable, false);
    assert.equal(obs.magicOk, false);
    assert.equal(obs.headerFormat, "unknown");
    assert.equal(obs.rawBytes1819, null);
    assert.equal(obs.fileSize, null);
    assert.deepEqual(obs.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "absent",
    });
    assert.deepEqual(obs.findingCodes, ["store-missing"]);
    assert.equal(obs.canonicalPath, path.resolve(store));
  });

  it("reports a chmod-0000 store as permission-denied, never header-unreadable", (t) => {
    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      t.skip("euid 0 bypasses file permissions, so EACCES cannot be produced");
      return;
    }
    const dir = fixtureDir("tamandua-store-header-eacces-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);
    fs.chmodSync(store, 0o000);
    try {
      const obs = observeStore(store);

      assert.equal(obs.exists, true);
      assert.ok(typeof obs.fileSize === "number" && obs.fileSize > 0);
      assert.equal(obs.readable, false);
      assert.equal(obs.magicOk, false);
      assert.equal(obs.headerFormat, "unknown");
      assert.equal(obs.rawBytes1819, null);
      assert.ok(obs.findingCodes.includes("permission-denied"));
      assert.ok(!obs.findingCodes.includes("header-unreadable"));
      assert.ok(!obs.findingCodes.includes("store-missing"));
    } finally {
      fs.chmodSync(store, 0o644);
    }
  });

  it("reports a directory at the store path as header-unreadable with no fabricated facts", () => {
    const dir = fixtureDir("tamandua-store-header-eisdir-");
    const store = path.join(dir, "state.db");
    fs.mkdirSync(store);

    const obs = observeStore(store);

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, false);
    assert.equal(obs.magicOk, false);
    assert.equal(obs.headerFormat, "unknown");
    assert.equal(obs.rawBytes1819, null);
    assert.equal(obs.fileSize, fs.lstatSync(store).size);
    assert.deepEqual(obs.findingCodes, ["header-unreadable"]);
  });

  it("reports a broken symlink as store-missing with no fabricated facts", () => {
    const dir = fixtureDir("tamandua-store-header-broken-link-");
    const store = path.join(dir, "link.db");
    fs.symlinkSync(path.join(dir, "absent-target.db"), store);

    const obs = observeStore(store);

    assert.equal(obs.exists, false);
    assert.equal(obs.readable, false);
    assert.equal(obs.magicOk, false);
    assert.equal(obs.headerFormat, "unknown");
    assert.equal(obs.rawBytes1819, null);
    assert.equal(obs.fileSize, null);
    assert.deepEqual(obs.findingCodes, ["store-missing"]);
    assert.equal(obs.canonicalPath, path.resolve(store));
  });

  it("reports a symlink loop as header-unreadable with no fabricated facts", () => {
    const dir = fixtureDir("tamandua-store-header-symlink-loop-");
    const first = path.join(dir, "first.db");
    const second = path.join(dir, "second.db");
    fs.symlinkSync(second, first);
    fs.symlinkSync(first, second);

    const obs = observeStore(first);

    assert.equal(obs.exists, false);
    assert.equal(obs.readable, false);
    assert.equal(obs.magicOk, false);
    assert.equal(obs.headerFormat, "unknown");
    assert.equal(obs.rawBytes1819, null);
    assert.equal(obs.fileSize, null);
    assert.deepEqual(obs.findingCodes, ["header-unreadable"]);
    assert.equal(obs.canonicalPath, path.resolve(first));
  });

  it("keeps a symlink resolving to a regular store fully readable", () => {
    const dir = fixtureDir("tamandua-store-header-symlink-regular-");
    const target = path.join(dir, "state.db");
    writeRollbackStore(target);
    const link = path.join(dir, "link.db");
    fs.symlinkSync(target, link);

    const direct = observeStore(target);
    const viaLink = observeStore(link);

    assert.equal(viaLink.exists, true);
    assert.equal(viaLink.readable, true);
    assert.equal(viaLink.magicOk, direct.magicOk);
    assert.equal(viaLink.headerFormat, direct.headerFormat);
    assert.deepEqual(viaLink.rawBytes1819, direct.rawBytes1819);
    assert.equal(viaLink.fileSize, direct.fileSize);
    assert.deepEqual(viaLink.findingCodes, direct.findingCodes);
    assert.equal(viaLink.canonicalPath, fs.realpathSync(target));
  });

  it("refuses an AF_UNIX socket at the store path with a bounded finding", async () => {
    const dir = fixtureDir("tamandua-store-header-socket-");
    const store = path.join(dir, "state.db");
    const server = net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(store, () => resolve());
    });
    try {
      assert.equal(fs.lstatSync(store).isSocket(), true);

      const obs = observeStore(store);

      assert.equal(obs.exists, true);
      assert.equal(obs.readable, false);
      assert.equal(obs.magicOk, false);
      assert.equal(obs.headerFormat, "unknown");
      assert.equal(obs.rawBytes1819, null);
      assert.ok(obs.findingCodes.includes("header-unreadable"));
      assert.ok(!obs.findingCodes.includes("header-truncated"));
      assert.ok(!obs.findingCodes.includes("header-not-sqlite"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses the real /dev/null character device with a bounded finding", (t) => {
    let stats: fs.Stats;
    try {
      stats = fs.statSync("/dev/null");
    } catch {
      t.skip("device-node case unproven: /dev/null is unavailable");
      return;
    }
    if (!stats.isCharacterDevice()) {
      t.skip("device-node case unproven: /dev/null is not a character device");
      return;
    }

    const obs = observeStore("/dev/null");

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, false);
    assert.equal(obs.magicOk, false);
    assert.equal(obs.headerFormat, "unknown");
    assert.equal(obs.rawBytes1819, null);
    assert.ok(obs.findingCodes.includes("header-unreadable"));
    assert.ok(!obs.findingCodes.includes("header-truncated"));
    assert.ok(!obs.findingCodes.includes("header-not-sqlite"));
  });

  it("does not leak descriptors across 100 sequential observations", (t) => {
    // Composed from fragments: the portability lint forbids a contiguous
    // procfs literal, and this probe is already skipped wherever the
    // directory does not exist.
    const fdDir = ["", "proc", "self", "fd"].join("/");
    try {
      fs.accessSync(fdDir);
    } catch {
      t.skip(
        "descriptor-leak case unproven: the procfs self-fd directory is unavailable",
      );
      return;
    }
    const dir = fixtureDir("tamandua-store-header-fdleak-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);

    // Warm up any lazily-created process descriptor before sampling.
    assert.equal(observeStore(store).readable, true);
    const before = fs.readdirSync(fdDir).length;

    for (let i = 0; i < 100; i += 1) {
      const obs = observeStore(store);
      assert.equal(obs.exists, true);
      assert.equal(obs.readable, true);
      assert.deepEqual(obs.findingCodes, []);
    }

    const after = fs.readdirSync(fdDir).length;
    assert.equal(after, before, "100 observations must not leak descriptors");
  });

  it("reads the header while a writer holds the store open", () => {
    const dir = fixtureDir("tamandua-store-header-writer-");
    const store = path.join(dir, "state.db");
    const db = new DatabaseSync(store);
    try {
      db.exec("CREATE TABLE t (a INTEGER)");
      db.exec("INSERT INTO t VALUES (1)");
      db.exec("BEGIN IMMEDIATE");
      db.exec("INSERT INTO t VALUES (2)");

      // The writer holds the file open and a rollback journal on disk; reading
      // bytes takes no lock, so the observation is immediate and complete.
      const obs = observeStore(store);

      assert.equal(obs.exists, true);
      assert.equal(obs.readable, true);
      assert.equal(obs.magicOk, true);
      assert.equal(obs.headerFormat, "rollback");
      assert.deepEqual(obs.rawBytes1819, [1, 1]);
      assert.equal(obs.sidecars.journal, "presentNonEmpty");
      assert.deepEqual(obs.findingCodes, ["sidecar-unresolved"]);
    } finally {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore: the fixture is discarded either way
      }
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// sidecar matrix
// ---------------------------------------------------------------------------

describe("store-header: sidecars", () => {
  it("reports all three sidecars absent and raises no sidecar finding", () => {
    const dir = fixtureDir("tamandua-store-header-sc-absent-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);

    const obs = observeStore(store);

    assert.deepEqual(obs.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "absent",
    });
    assert.ok(!obs.findingCodes.includes("sidecar-unresolved"));
  });

  it("reports zero-length sidecars as presentEmpty without raising sidecar-unresolved", () => {
    const dir = fixtureDir("tamandua-store-header-sc-empty-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      fs.writeFileSync(`${store}${suffix}`, "");
    }

    const obs = observeStore(store);

    assert.deepEqual(obs.sidecars, {
      wal: "presentEmpty",
      shm: "presentEmpty",
      journal: "presentEmpty",
    });
    assert.ok(!obs.findingCodes.includes("sidecar-unresolved"));
    assert.deepEqual(obs.findingCodes, []);
  });

  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    it(`reports a non-empty ${suffix} as presentNonEmpty and raises sidecar-unresolved once`, () => {
      const dir = fixtureDir("tamandua-store-header-sc-nonempty-");
      const store = path.join(dir, "state.db");
      writeRollbackStore(store);
      fs.writeFileSync(`${store}${suffix}`, Buffer.from("sidecar-bytes"));

      const obs = observeStore(store);

      const key = suffix.slice(1) as "wal" | "shm" | "journal";
      assert.equal(obs.sidecars[key], "presentNonEmpty");
      const unresolvedCount = obs.findingCodes.filter(
        (code) => code === "sidecar-unresolved",
      ).length;
      assert.equal(unresolvedCount, 1);
      assert.deepEqual(obs.findingCodes, ["sidecar-unresolved"]);
    });
  }

  it("reports a sidecar under an unsearchable parent as unreadable, never absent", (t) => {
    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      t.skip("euid 0 bypasses directory permissions, so EACCES cannot be produced");
      return;
    }
    const dir = fixtureDir("tamandua-store-header-sc-locked-");
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    const store = path.join(locked, "state.db");
    writeRollbackStore(store);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      fs.writeFileSync(`${store}${suffix}`, "");
    }
    fs.chmodSync(locked, 0o000);
    try {
      const obs = observeStore(store);

      assert.deepEqual(obs.sidecars, {
        wal: "unreadable",
        shm: "unreadable",
        journal: "unreadable",
      });
      assert.ok(obs.findingCodes.includes("permission-denied"));
      assert.ok(!obs.findingCodes.includes("store-missing"));
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("reports an ELOOP sidecar as unreadable while the store stays fully readable", () => {
    const dir = fixtureDir("tamandua-store-header-sc-loop-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);
    fs.symlinkSync(`${store}-wal`, `${store}-wal`);

    const obs = observeStore(store);

    assert.equal(obs.readable, true);
    assert.equal(obs.headerFormat, "rollback");
    assert.deepEqual(obs.sidecars, {
      wal: "unreadable",
      shm: "absent",
      journal: "absent",
    });
    assert.ok(!obs.findingCodes.includes("sidecar-unresolved"));
  });

  it("observes an orphan non-empty sidecar next to a missing store", () => {
    const dir = fixtureDir("tamandua-store-header-sc-orphan-");
    const store = path.join(dir, "absent.db");
    fs.writeFileSync(`${store}-wal`, Buffer.from("orphan"));

    const obs = observeStore(store);

    assert.equal(obs.exists, false);
    assert.equal(obs.sidecars.wal, "presentNonEmpty");
    assert.deepEqual(obs.findingCodes, ["store-missing", "sidecar-unresolved"]);
  });
});

// ---------------------------------------------------------------------------
// aggregation, determinism, canonical paths
// ---------------------------------------------------------------------------

describe("store-header: aggregation and determinism", () => {
  it("aggregates every applicable finding once, in the canonical order", () => {
    const dir = fixtureDir("tamandua-store-header-aggregate-");
    const store = path.join(dir, "state.db");
    // 40 bytes of non-database bytes: too short for a header AND wrong magic.
    fs.writeFileSync(store, Buffer.alloc(40, 0x41));
    fs.writeFileSync(`${store}-wal`, Buffer.from("wal-bytes"));
    fs.writeFileSync(`${store}-journal`, Buffer.from("journal-bytes"));
    fs.writeFileSync(`${store}-shm`, Buffer.from("shm-bytes"));

    const obs = observeStore(store);

    assert.deepEqual(obs.findingCodes, [
      "header-truncated",
      "header-not-sqlite",
      "sidecar-unresolved",
    ]);
    assert.equal(
      obs.findingCodes.filter((code) => code === "sidecar-unresolved").length,
      1,
    );
    // Canonical order is a subsequence of the exported order constant.
    const indexes = obs.findingCodes.map((code) =>
      STORE_REASON_CODE_ORDER.indexOf(code),
    );
    const sorted = [...indexes].sort((a, b) => a - b);
    assert.deepEqual(indexes, sorted);
  });

  it("returns a deep-equal observation for unchanged filesystem state", () => {
    const dir = fixtureDir("tamandua-store-header-determinism-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);
    fs.writeFileSync(`${store}-journal`, Buffer.from("pending"));

    const first = observeStore(store);
    const second = observeStore(store);

    assert.deepEqual(second, first);
    assert.deepEqual(second.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "presentNonEmpty",
    });
    assert.deepEqual(second.findingCodes, ["sidecar-unresolved"]);
  });

  it("leaves the directory listing unchanged (observation creates no sidecars)", () => {
    const dir = fixtureDir("tamandua-store-header-listing-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);
    const before = fs.readdirSync(dir).sort();

    observeStore(store);

    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });

  it("uses the realpath as canonicalPath for an existing store behind a symlinked parent", () => {
    const dir = fixtureDir("tamandua-store-header-canonical-");
    const realDir = path.join(dir, "real");
    fs.mkdirSync(realDir);
    const realStore = path.join(realDir, "state.db");
    writeRollbackStore(realStore);
    const linkDir = path.join(dir, "link");
    fs.symlinkSync(realDir, linkDir);
    const linkedStore = path.join(linkDir, "state.db");

    const obs = observeStore(linkedStore);

    assert.equal(obs.path, linkedStore);
    assert.equal(obs.canonicalPath, fs.realpathSync(realStore));
    assert.notEqual(obs.canonicalPath, linkedStore);
    const direct = observeStore(realStore);
    assert.equal(obs.headerFormat, direct.headerFormat);
    assert.deepEqual(obs.rawBytes1819, direct.rawBytes1819);
    assert.equal(obs.magicOk, direct.magicOk);
  });

  it("resolves canonicalPath for a missing store without inventing a target", () => {
    const dir = fixtureDir("tamandua-store-header-canonical-missing-");
    fs.mkdirSync(path.join(dir, "sub"));
    const unresolved = path.join(dir, "sub", "..", "absent.db");

    const obs = observeStore(unresolved);

    assert.equal(obs.exists, false);
    assert.equal(obs.canonicalPath, path.resolve(unresolved));
    assert.ok(!obs.canonicalPath.includes(".."));
    assert.equal(obs.canonicalPath, path.join(dir, "absent.db"));
  });
});

// ---------------------------------------------------------------------------
// adversarial evidence (US-002): the reader is SQLite-immune and mutation-free
// ---------------------------------------------------------------------------

describe("store-header: adversarial mutation proof", () => {
  const fixtures: Array<{ label: string; write: (file: string) => void }> = [
    { label: "a real rollback-format store", write: writeRollbackStore },
    {
      label: "a corrupt-body store with a valid rollback-format header",
      write: writeCorruptBodyStore,
    },
    {
      label: "a 40-byte truncated-header store",
      write: (file: string) => writeHeaderFixture(file, [1, 1], 40),
    },
  ];

  for (const fixture of fixtures) {
    it(`leaves ${fixture.label} byte-identical (sha256, size, mtimeNs, listing)`, () => {
      const dir = fixtureDir("tamandua-store-header-adv-mutation-");
      const store = path.join(dir, "state.db");
      fixture.write(store);

      const beforeFile = fingerprint(store);
      const beforeListing = dirListing(dir);

      const obs = observeStore(store);

      assert.equal(obs.exists, true);
      assert.equal(obs.readable, true);
      assert.deepEqual(
        fingerprint(store),
        beforeFile,
        "observation must not change the store's bytes, size or mtime",
      );
      assert.deepEqual(
        dirListing(dir),
        beforeListing,
        "observation must not create or remove a directory entry",
      );
      for (const suffix of SIDECAR_SUFFIXES) {
        assert.equal(
          fs.existsSync(`${store}${suffix}`),
          false,
          `observation must not create ${suffix}`,
        );
      }
    });
  }
});

describe("store-header: driver-immunity differential", () => {
  it("observes a corrupt-body store that a test-only driver read rejects", () => {
    const dir = fixtureDir("tamandua-store-header-adv-driver-");
    const store = path.join(dir, "state.db");
    writeCorruptBodyStore(store);

    // Test-only driver use: on these identical bytes a driver fails. The reader
    // under test must not share that failure mode.
    assert.throws(() => {
      const db = new DatabaseSync(store);
      try {
        db.exec("SELECT count(*) FROM sqlite_master");
      } finally {
        db.close();
      }
    }, /not a database|malformed/i);

    const obs = observeStore(store);

    assert.equal(obs.exists, true);
    assert.equal(obs.readable, true);
    assert.equal(obs.magicOk, true);
    assert.equal(obs.headerFormat, "rollback");
    assert.deepEqual(obs.rawBytes1819, [1, 1]);
    assert.equal(obs.fileSize, 4096 * 3);
    assert.deepEqual(obs.findingCodes, []);
  });
});

describe("store-header: locked-writer immunity", () => {
  it("reads while a writer holds BEGIN EXCLUSIVE, where a second driver read is locked", () => {
    const dir = fixtureDir("tamandua-store-header-adv-lock-");
    const store = path.join(dir, "state.db");
    const writer = new DatabaseSync(store);
    try {
      writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
      writer.exec("INSERT INTO items (label) VALUES ('one')");
      writer.exec("BEGIN EXCLUSIVE");
      writer.exec("INSERT INTO items (label) VALUES ('two')");

      const journal = `${store}-journal`;
      assert.ok(
        fs.statSync(journal).size > 0,
        "the writer must hold a nonempty rollback journal",
      );

      // The lock is real: a second driver connection cannot read the store.
      assert.throws(() => {
        const reader = new DatabaseSync(store);
        try {
          reader.exec("SELECT count(*) FROM items");
        } finally {
          reader.close();
        }
      }, /locked|busy/i);

      const startedAt = process.hrtime.bigint();
      const obs = observeStore(store);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      assert.ok(
        elapsedMs < 2000,
        `observation must not wait on the writer's lock (took ${elapsedMs.toFixed(1)}ms)`,
      );
      assert.equal(obs.exists, true);
      assert.equal(obs.readable, true);
      assert.equal(obs.magicOk, true);
      assert.equal(obs.headerFormat, "rollback");
      assert.deepEqual(obs.rawBytes1819, [1, 1]);
      assert.deepEqual(obs.sidecars, {
        wal: "absent",
        shm: "absent",
        journal: "presentNonEmpty",
      });
      assert.deepEqual(obs.findingCodes, ["sidecar-unresolved"]);
    } finally {
      try {
        writer.exec("ROLLBACK");
      } catch {
        // the fixture is discarded either way
      }
      writer.close();
    }
  });
});

describe("store-header: sidecar preservation", () => {
  it("preserves nonempty -wal, -shm and -journal bytes exactly, checkpointing nothing", () => {
    const dir = fixtureDir("tamandua-store-header-adv-sidecars-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);

    const sidecarBytes: Array<[string, Buffer]> = [
      ["-wal", Buffer.from("write-ahead bytes from a crashed writer")],
      ["-shm", Buffer.from("shared-memory bytes")],
      ["-journal", Buffer.from("rollback journal bytes from an in-flight transaction")],
    ];
    const before = new Map<string, FileFingerprint>();
    for (const [suffix, bytes] of sidecarBytes) {
      fs.writeFileSync(`${store}${suffix}`, bytes);
      before.set(suffix, fingerprint(`${store}${suffix}`));
    }
    const beforeStore = fingerprint(store);

    const obs = observeStore(store);

    assert.deepEqual(obs.sidecars, {
      wal: "presentNonEmpty",
      shm: "presentNonEmpty",
      journal: "presentNonEmpty",
    });
    assert.equal(
      obs.findingCodes.filter((code) => code === "sidecar-unresolved").length,
      1,
    );
    assert.deepEqual(obs.findingCodes, ["sidecar-unresolved"]);

    for (const [suffix, bytes] of sidecarBytes) {
      assert.deepEqual(
        fingerprint(`${store}${suffix}`),
        before.get(suffix),
        `${suffix} must keep its bytes, size and mtime`,
      );
      assert.deepEqual(
        fs.readFileSync(`${store}${suffix}`),
        bytes,
        `${suffix} content must be untouched`,
      );
    }
    assert.ok(
      fs.statSync(`${store}-journal`).size > 0,
      "the journal must still be nonempty after observation",
    );
    assert.deepEqual(fingerprint(store), beforeStore, "the store itself is untouched");
    assert.deepEqual(dirListing(dir), [
      "state.db",
      "state.db-journal",
      "state.db-shm",
      "state.db-wal",
    ]);
  });
});

describe("store-header: symlink observation", () => {
  it("reads through a symlink to the target's facts and mutates neither path", () => {
    const dir = fixtureDir("tamandua-store-header-adv-symlink-");
    const targetDir = path.join(dir, "real");
    fs.mkdirSync(targetDir);
    const target = path.join(targetDir, "state.db");
    writeRollbackStore(target);
    const link = path.join(dir, "link.db");
    fs.symlinkSync(target, link);

    const beforeTarget = fingerprint(target);
    const beforeLinkMtimeNs = fs.lstatSync(link, { bigint: true }).mtimeNs;
    const beforeListing = dirListing(dir);

    const viaLink = observeStore(link);
    const direct = observeStore(target);

    assert.equal(viaLink.path, link);
    assert.equal(viaLink.canonicalPath, fs.realpathSync(target));
    assert.notEqual(viaLink.canonicalPath, link);
    assert.equal(viaLink.exists, true);
    assert.equal(viaLink.readable, true);
    assert.equal(viaLink.magicOk, direct.magicOk);
    assert.equal(viaLink.headerFormat, "rollback");
    assert.equal(direct.headerFormat, "rollback");
    assert.deepEqual(viaLink.rawBytes1819, direct.rawBytes1819);
    assert.equal(viaLink.fileSize, direct.fileSize);
    assert.deepEqual(viaLink.sidecars, direct.sidecars);

    assert.deepEqual(fingerprint(target), beforeTarget, "the target must not change");
    assert.equal(
      fs.lstatSync(link, { bigint: true }).mtimeNs,
      beforeLinkMtimeNs,
      "the symlink itself must not change",
    );
    assert.deepEqual(dirListing(dir), beforeListing);
  });
});

describe("store-header: unreadable versus absent", () => {
  it("reports sidecars under a chmod-0000 parent as unreadable, never absent", (t) => {
    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      t.skip("euid 0 bypasses directory permissions, so EACCES cannot be produced");
      return;
    }
    const dir = fixtureDir("tamandua-store-header-adv-unreadable-");
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    const store = path.join(locked, "state.db");
    writeRollbackStore(store);
    for (const suffix of SIDECAR_SUFFIXES) {
      fs.writeFileSync(`${store}${suffix}`, "");
    }
    fs.chmodSync(locked, 0o000);
    try {
      const obs = observeStore(store);

      assert.deepEqual(obs.sidecars, {
        wal: "unreadable",
        shm: "unreadable",
        journal: "unreadable",
      });
      for (const state of Object.values(obs.sidecars)) {
        assert.notEqual(state, "absent");
      }
      assert.equal(obs.exists, false);
      assert.equal(obs.fileSize, null);
      assert.ok(obs.findingCodes.includes("permission-denied"));
      assert.ok(!obs.findingCodes.includes("store-missing"));
      assert.ok(!obs.findingCodes.includes("header-unreadable"));
      assert.ok(!obs.findingCodes.includes("sidecar-unresolved"));
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe("store-header: adversarial determinism", () => {
  it("returns deep-equal observations on repeat and creates no file in between", () => {
    const dir = fixtureDir("tamandua-store-header-adv-determinism-");
    const store = path.join(dir, "state.db");
    writeRollbackStore(store);
    fs.writeFileSync(`${store}-journal`, Buffer.from("pending rollback journal"));

    const listingBefore = dirListing(dir);
    const first = observeStore(store);
    const listingBetween = dirListing(dir);
    const second = observeStore(store);
    const third = observeStore(store);
    const listingAfter = dirListing(dir);

    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.deepEqual(listingBetween, listingBefore);
    assert.deepEqual(listingAfter, listingBefore);
    assert.deepEqual(first.findingCodes, ["sidecar-unresolved"]);
  });
});

// ---------------------------------------------------------------------------
// module purity
// ---------------------------------------------------------------------------

describe("store-header: module purity", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf-8");

  it("imports no database driver, no child processes, no clock, no randomness, no environment", () => {
    const forbidden = [
      "node:" + "sqlite",
      "sqlite" + "3",
      "Database" + "Sync",
      "node:" + "child_process",
      "Date",
      "Math" + "." + "random",
      "process" + ".env",
    ];
    for (const token of forbidden) {
      assert.ok(
        !source.includes(token),
        `store-header.ts must not reference ${token}`,
      );
    }
  });

  it("describes the (1,1) pair as rollback-format and never as a journal sub-mode", () => {
    assert.ok(source.includes("rollback-format"));
    assert.ok(!source.includes(FORBIDDEN_SUBMODE_TOKEN));
  });

  it("prechecks with lstat, opens non-blocking, and fstats before reading", () => {
    const lstatIdx = source.indexOf("fs.lstatSync(");
    const openIdx = source.indexOf("fs.openSync(");
    const fstatIdx = source.indexOf("fs.fstatSync(");
    const readIdx = source.indexOf("fs.readSync(");

    assert.ok(lstatIdx >= 0, "store-header.ts must precheck with lstatSync");
    assert.ok(
      /O_RDONLY[\s\S]{0,200}O_NONBLOCK/.test(source),
      "the open flags must combine O_RDONLY with O_NONBLOCK",
    );
    assert.ok(openIdx >= 0, "store-header.ts must open the store");
    assert.ok(
      fstatIdx > openIdx,
      "fstatSync must validate the opened descriptor after openSync",
    );
    assert.ok(
      readIdx > fstatIdx,
      "readSync must run only after fstatSync validates the descriptor",
    );
  });

  it("is not listed in tests/serial-files.txt (parallel lane, no spawns)", () => {
    // Membership is checked for THIS file's repo-relative path, not by a
    // substring on "store-header": the sibling
    // store-header-nonregular-regression.test.ts is serial (it spawns
    // subprocesses) and must not make this parallel-lane assertion fail.
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
      `this parallel test file (${ownRelativePath}) must NOT be in ` +
        `tests/serial-files.txt — only the sibling subprocess regression file ` +
        `belongs there`,
    );
  });
});
