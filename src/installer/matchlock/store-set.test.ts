/**
 * store-set resolver tests (G2 STORE-SET-RESOLVER US-001, US-002, US-003,
 * US-004, US-005).
 *
 * These tests exercise `resolveStoreSet` in
 * src/installer/matchlock/store-set.ts: the runtime-store inventory contract,
 * the identity of contract-named stores resolved from filesystem metadata
 * only, (US-002) inode dedupe with deterministic byte-order output, (US-003)
 * the mount-plan spellings of a symlinked profile home, (US-004) the
 * profile-home listing that surfaces stores the contract does not name, and
 * (US-005) the single completeness derivation and its stable reason
 * vocabulary, and (US-006) the adversarial proof that resolving the inventory
 * is metadata-only and mutation-free. They import the COMPILED module from
 * dist/ (repo convention for this directory), so `npm run build` must run
 * first.
 *
 * Fixture stores are deliberately NOT databases: a store containing garbage
 * bytes must resolve exactly like a real one, which is the cheapest available
 * proof that the resolver never opens a database and never reads content.
 *
 * Every fixture directory comes from `tamanduaShortTempDir` and is removed in
 * the `after()` hook; no temp path is ever hardcoded.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  StoreSetInputError,
  resolveStoreSet,
} from "../../../dist/installer/matchlock/store-set.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "store-set.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");

const createdDirs: string[] = [];

/** Bytes that are deliberately not a database: proof the resolver ignores content. */
const GARBAGE_BYTES = Buffer.from("this is not a database");

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

/** Write a metadata-only fixture store (garbage bytes, never opened as a db). */
function writeStore(file: string, bytes: Buffer = GARBAGE_BYTES): void {
  fs.writeFileSync(file, bytes);
}

/** UTF-8 byte comparison, matching the resolver's ordering rule. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function input(
  profileHome: string,
  entries: Array<{ relativePath: string; classification: string }>,
  complete?: boolean,
) {
  return {
    profileHome,
    mountPlan: {},
    storeContract: complete === undefined ? { entries } : { entries, complete },
  } as never;
}

/**
 * The same input with a mount plan that genuinely covers a plain fixture home.
 * US-005 makes completeness depend on the plan proving the runtime can see the
 * profile home at all, so a test that asserts `inventoryComplete` for a
 * non-symlinked home must supply a covering mount; `input` deliberately keeps
 * the mount plan empty for the identity-only and mount-spelling tests.
 */
function coveredInput(
  profileHome: string,
  entries: Array<{ relativePath: string; classification: string }>,
  complete?: boolean,
) {
  return inputWithMounts(profileHome, entries, mountAt(profileHome), complete);
}

// ---------------------------------------------------------------------------
// one store's identity
// ---------------------------------------------------------------------------

describe("store-set: single store identity", () => {
  it("resolves a present contract store from metadata only, inode included", () => {
    const home = fixtureDir("tamandua-store-set-single-");
    const store = path.join(home, "state.db");
    writeStore(store);

    const result = resolveStoreSet(
      input(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    assert.equal(result.stores.length, 1);
    const identity = result.stores[0];
    const requested = path.join(home, "state.db");
    const stats = fs.statSync(store, { bigint: true });

    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.origin, "contract");
    assert.equal(identity.classification, "required");
    assert.equal(identity.canonicalPath, fs.realpathSync(store));
    assert.deepEqual(identity.pathAliases, [fs.realpathSync(store)]);
    assert.ok(identity.pathAliases.includes(requested));
    assert.equal(identity.dev, stats.dev.toString());
    assert.equal(identity.ino, stats.ino.toString());
    assert.equal(typeof identity.dev, "string");
    assert.equal(typeof identity.ino, "string");
    assert.equal(identity.fstype, `0x${fs.statfsSync(store).type.toString(16)}`);
    assert.match(identity.fstype, /^0x[0-9a-f]+$/);
    assert.equal(identity.size, GARBAGE_BYTES.length);
    assert.deepEqual(result.discoveredUnexpected, []);
  });

  it("keeps the caller's spelling AND the target spelling for a symlinked store", () => {
    const home = fixtureDir("tamandua-store-set-alias-");
    const target = path.join(home, "state.db");
    writeStore(target);
    const link = path.join(home, "state.db.link");
    fs.symlinkSync(target, link);

    const result = resolveStoreSet(
      input(home, [{ relativePath: "state.db.link", classification: "required" }], true),
    );

    const identity = result.stores[0];
    const canonical = fs.realpathSync(target);
    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.canonicalPath, canonical);
    assert.notEqual(identity.canonicalPath, link);
    assert.deepEqual(identity.pathAliases, [link, canonical].sort(byteCompare));
    assert.ok(identity.pathAliases.includes(link), "requested spelling survives verbatim");
    assert.ok(identity.pathAliases.includes(canonical), "canonical spelling survives");
    // The symlink itself is not the store: the identity describes the target.
    assert.equal(identity.size, GARBAGE_BYTES.length);
  });

  it("sorts pathAliases in UTF-8 byte order and drops duplicates", () => {
    const home = fixtureDir("tamandua-store-set-alias-order-");
    const store = path.join(home, "state.db");
    writeStore(store);

    const result = resolveStoreSet(
      input(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    const aliases = result.stores[0].pathAliases;
    assert.equal(aliases.length, new Set(aliases).size);
    assert.deepEqual(aliases, [...aliases].sort(byteCompare));
  });
});

// ---------------------------------------------------------------------------
// classification pass-through
// ---------------------------------------------------------------------------

describe("store-set: classification pass-through", () => {
  it("returns each contract classification unchanged, including inactive", () => {
    const home = fixtureDir("tamandua-store-set-classify-");
    writeStore(path.join(home, "state.db"));
    writeStore(path.join(home, "verification_evidence.db"));
    writeStore(path.join(home, "kanban.db"));

    const result = resolveStoreSet(
      input(
        home,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "verification_evidence.db", classification: "optional-present" },
          { relativePath: "kanban.db", classification: "inactive" },
        ],
        true,
      ),
    );

    const byPath = new Map(
      result.stores.map((identity) => [identity.canonicalPath, identity.classification]),
    );
    assert.equal(byPath.get(fs.realpathSync(path.join(home, "state.db"))), "required");
    assert.equal(
      byPath.get(fs.realpathSync(path.join(home, "verification_evidence.db"))),
      "optional-present",
    );
    // An inactive store that exists anyway is still returned and inspected.
    assert.equal(byPath.get(fs.realpathSync(path.join(home, "kanban.db"))), "inactive");
    assert.equal(result.stores.length, 3);
  });
});

// ---------------------------------------------------------------------------
// absent store
// ---------------------------------------------------------------------------

describe("store-set: absent store is knowledge, not failure", () => {
  it("records a missing required store with null identity and creates nothing", () => {
    const home = fixtureDir("tamandua-store-set-absent-");
    const missing = path.join(home, "state.db");
    const listingBefore = fs.readdirSync(home).sort();

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    const identity = result.stores[0];
    assert.equal(identity.resolution, "absent");
    assert.equal(identity.canonicalPath, null);
    assert.equal(identity.dev, null);
    assert.equal(identity.ino, null);
    assert.equal(identity.fstype, null);
    assert.equal(identity.size, null);
    assert.equal(identity.classification, "required");
    assert.equal(identity.origin, "contract");
    assert.deepEqual(identity.pathAliases, [missing]);

    assert.equal(fs.existsSync(missing), false, "a missing store must never be created");
    assert.deepEqual(fs.readdirSync(home).sort(), listingBefore);
    // Absence is knowledge: it adds no incompleteness reason by itself.
    assert.deepEqual(result.incompleteReasons, []);
    assert.equal(result.inventoryComplete, true);
  });
});

// ---------------------------------------------------------------------------
// unresolved store
// ---------------------------------------------------------------------------

describe("store-set: unresolved store is ignorance, never absence", () => {
  it("reports a symlink loop as unresolved with no invented identity", () => {
    const home = fixtureDir("tamandua-store-set-loop-");
    const loop = path.join(home, "loop.db");
    fs.symlinkSync(loop, loop);

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "loop.db", classification: "required" }], true),
    );

    const identity = result.stores[0];
    assert.equal(identity.resolution, "unresolved");
    assert.equal(identity.canonicalPath, null);
    assert.equal(identity.dev, null);
    assert.equal(identity.ino, null);
    assert.equal(identity.fstype, null);
    assert.equal(identity.size, null);
    assert.equal(identity.classification, "required");
    assert.deepEqual(identity.pathAliases, [loop]);

    assert.equal(result.inventoryComplete, false);
    assert.equal(result.incompleteReasons.length, 1);
    const reason = result.incompleteReasons[0];
    assert.ok(reason.startsWith("store-unresolved:"), `unexpected reason ${reason}`);
    assert.ok(reason.includes(loop), `reason must name the requested spelling: ${reason}`);
    assert.ok(reason.includes("ELOOP"), `reason must carry the errno code: ${reason}`);
  });
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

describe("store-set: input validation fails closed", () => {
  it("rejects a profile home that is not absolute", () => {
    for (const profileHome of ["relative/home", "", "."]) {
      assert.throws(
        () => resolveStoreSet(input(profileHome, [], true)),
        (err: unknown) =>
          err instanceof StoreSetInputError && err.code === "profile-home-not-absolute",
        `profileHome ${JSON.stringify(profileHome)} must be rejected`,
      );
    }
  });

  it("rejects an absolute or home-escaping relativePath", () => {
    const home = fixtureDir("tamandua-store-set-paths-");
    const escaping = ["/etc/passwd", "../outside.db", "sub/../../outside.db", ".."];

    for (const relativePath of escaping) {
      assert.throws(
        () => resolveStoreSet(input(home, [{ relativePath, classification: "required" }], true)),
        (err: unknown) =>
          err instanceof StoreSetInputError && err.code === "contract-relative-path",
        `relativePath ${JSON.stringify(relativePath)} must be rejected`,
      );
    }
  });

  it("rejects a duplicate relativePath before touching the filesystem", () => {
    const home = fixtureDir("tamandua-store-set-duplicate-");

    assert.throws(
      () =>
        resolveStoreSet(
          input(
            home,
            [
              { relativePath: "state.db", classification: "required" },
              { relativePath: "state.db", classification: "optional-present" },
            ],
            true,
          ),
        ),
      (err: unknown) =>
        err instanceof StoreSetInputError && err.code === "contract-duplicate-entry",
    );
    assert.equal(fs.existsSync(path.join(home, "state.db")), false);
  });

  it("exposes a StoreSetInputError with a stable name and code", () => {
    const home = fixtureDir("tamandua-store-set-error-");
    try {
      resolveStoreSet(input(home, [{ relativePath: "/absolute.db", classification: "required" }]));
      assert.fail("expected StoreSetInputError");
    } catch (err) {
      assert.ok(err instanceof StoreSetInputError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, "StoreSetInputError");
      assert.equal(err.code, "contract-relative-path");
      assert.match(err.message, /relative/i);
    }
  });
});

// ---------------------------------------------------------------------------
// completeness and reason vocabulary
// ---------------------------------------------------------------------------

describe("store-set: completeness and reasons", () => {
  it("is incomplete with contract-incomplete when the contract is not attested", () => {
    const home = fixtureDir("tamandua-store-set-incomplete-");
    writeStore(path.join(home, "state.db"));

    for (const complete of [undefined, false]) {
      const result = resolveStoreSet(
        coveredInput(home, [{ relativePath: "state.db", classification: "required" }], complete),
      );
      assert.equal(result.inventoryComplete, false);
      assert.deepEqual(result.incompleteReasons, ["contract-incomplete"]);
      assert.equal(result.stores[0].resolution, "resolved");
    }
  });

  it("is complete only when the contract is attested and nothing is in doubt", () => {
    const home = fixtureDir("tamandua-store-set-complete-");
    writeStore(path.join(home, "state.db"));

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    assert.equal(result.inventoryComplete, true);
    assert.deepEqual(result.incompleteReasons, []);
  });

  it("dedupes and sorts reasons in UTF-8 byte order", () => {
    const home = fixtureDir("tamandua-store-set-reasons-");
    const zLoop = path.join(home, "z-loop.db");
    const aLoop = path.join(home, "a-loop.db");
    fs.symlinkSync(zLoop, zLoop);
    fs.symlinkSync(aLoop, aLoop);

    const result = resolveStoreSet(
      coveredInput(
        home,
        [
          { relativePath: "z-loop.db", classification: "required" },
          { relativePath: "a-loop.db", classification: "required" },
        ],
        false,
      ),
    );

    const expected = [
      "contract-incomplete",
      `store-unresolved:${aLoop}:ELOOP`,
      `store-unresolved:${zLoop}:ELOOP`,
    ].sort(byteCompare);

    assert.deepEqual(result.incompleteReasons, expected);
    assert.equal(
      result.incompleteReasons.length,
      new Set(result.incompleteReasons).size,
      "reasons must be deduped",
    );
    assert.deepEqual(
      result.incompleteReasons,
      [...result.incompleteReasons].sort(byteCompare),
      "reasons must be sorted in UTF-8 byte order",
    );
    assert.equal(result.inventoryComplete, result.incompleteReasons.length === 0);
    // Contract entry order never reorders the report.
    const permuted = resolveStoreSet(
      coveredInput(
        home,
        [
          { relativePath: "a-loop.db", classification: "required" },
          { relativePath: "z-loop.db", classification: "required" },
        ],
        false,
      ),
    );
    assert.deepEqual(permuted, result);
  });
});

// ---------------------------------------------------------------------------
// deterministic ordering
// ---------------------------------------------------------------------------

describe("store-set: deterministic ordering", () => {
  it("orders stores by canonicalPath in UTF-8 byte order regardless of entry order", () => {
    const home = fixtureDir("tamandua-store-set-order-");
    for (const name of ["state.db", "alpha.db", "zeta.db"]) {
      writeStore(path.join(home, name));
    }

    const forward = resolveStoreSet(
      input(
        home,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "alpha.db", classification: "optional-present" },
          { relativePath: "zeta.db", classification: "inactive" },
        ],
        true,
      ),
    );
    const reversed = resolveStoreSet(
      input(
        home,
        [
          { relativePath: "zeta.db", classification: "inactive" },
          { relativePath: "alpha.db", classification: "optional-present" },
          { relativePath: "state.db", classification: "required" },
        ],
        true,
      ),
    );

    const paths = forward.stores.map((identity) => identity.canonicalPath ?? "");
    assert.deepEqual(paths, [...paths].sort(byteCompare));
    assert.deepEqual(reversed, forward);
  });

  it("returns a deeply equal result for unchanged filesystem state", () => {
    const home = fixtureDir("tamandua-store-set-determinism-");
    writeStore(path.join(home, "state.db"));
    const contract = input(
      home,
      [{ relativePath: "state.db", classification: "required" }],
      false,
    );

    assert.deepEqual(resolveStoreSet(contract), resolveStoreSet(contract));
  });
});

// ---------------------------------------------------------------------------
// inode dedupe and multi-store ordering (US-002)
// ---------------------------------------------------------------------------

/** Two spellings of ONE inode: a hardlink is a second name, not a second file. */
function hardlinkPair(home: string, name: string): { primary: string; alias: string } {
  const primary = path.join(home, name);
  const alias = `${primary}.alias`;
  writeStore(primary);
  fs.linkSync(primary, alias);
  return { primary, alias };
}

describe("store-set: inode dedupe", () => {
  it("returns two identities for two distinct stores, in UTF-8 byte order", () => {
    const home = fixtureDir("tamandua-store-set-two-");
    writeStore(path.join(home, "state.db"));
    writeStore(path.join(home, "verification_evidence.db"));

    const result = resolveStoreSet(
      input(
        home,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "verification_evidence.db", classification: "optional-present" },
        ],
        true,
      ),
    );

    assert.equal(result.stores.length, 2);
    const canonicalPaths = result.stores.map((identity) => {
      assert.equal(typeof identity.canonicalPath, "string");
      return identity.canonicalPath as string;
    });
    // Distinct stores, distinct inodes, distinct canonical spellings.
    assert.equal(new Set(canonicalPaths).size, 2);
    assert.equal(new Set(result.stores.map((identity) => identity.ino)).size, 2);
    // Explicit byte-order proof — a locale sort could disagree.
    for (let index = 1; index < canonicalPaths.length; index += 1) {
      assert.ok(
        Buffer.compare(
          Buffer.from(canonicalPaths[index - 1], "utf8"),
          Buffer.from(canonicalPaths[index], "utf8"),
        ) <= 0,
        `stores out of byte order: ${canonicalPaths.join(", ")}`,
      );
    }
    assert.deepEqual(canonicalPaths, [...canonicalPaths].sort(byteCompare));
  });

  it("collapses two hardlinked contract entries into ONE identity keeping both spellings", () => {
    const home = fixtureDir("tamandua-store-set-hardlink-");
    const { primary, alias } = hardlinkPair(home, "state.db");
    const stats = fs.statSync(primary, { bigint: true });
    const aliasStats = fs.statSync(alias, { bigint: true });
    // The fixture really is one inode reached through two names.
    assert.equal(stats.dev, aliasStats.dev);
    assert.equal(stats.ino, aliasStats.ino);
    assert.notEqual(fs.realpathSync(primary), fs.realpathSync(alias));

    const result = resolveStoreSet(
      input(
        home,
        [
          { relativePath: "state.db", classification: "optional-present" },
          { relativePath: "state.db.alias", classification: "required" },
        ],
        true,
      ),
    );

    assert.equal(result.stores.length, 1, "one inode must yield one identity");
    const identity = result.stores[0];
    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.origin, "contract");
    assert.equal(identity.classification, "required", "a required alias is never downgraded");
    assert.equal(identity.dev, stats.dev.toString());
    assert.equal(identity.ino, stats.ino.toString());
    assert.equal(identity.size, GARBAGE_BYTES.length);

    assert.ok(identity.pathAliases.includes(primary), "the primary spelling survives");
    assert.ok(identity.pathAliases.includes(alias), "the hardlink spelling survives");
    assert.deepEqual(identity.pathAliases, [...new Set(identity.pathAliases)].sort(byteCompare));
    assert.equal(
      identity.canonicalPath,
      [fs.realpathSync(primary), fs.realpathSync(alias)].sort(byteCompare)[0],
      "the byte-order smallest canonical spelling is chosen",
    );
  });

  it("keeps the most demanding classification for every aliased disagreement", () => {
    const cases: Array<{
      first: "required" | "optional-present" | "inactive";
      second: "required" | "optional-present" | "inactive";
      expected: "required" | "optional-present" | "inactive";
    }> = [
      { first: "required", second: "inactive", expected: "required" },
      { first: "required", second: "optional-present", expected: "required" },
      { first: "optional-present", second: "inactive", expected: "optional-present" },
      { first: "inactive", second: "required", expected: "required" },
    ];

    cases.forEach((testCase, index) => {
      // One home per case: a `*.db` left behind by an earlier case is a real
      // directory-scan candidate in the shared home and would legitimately be
      // reported, which is not what this test is about.
      const home = fixtureDir(`tamandua-store-set-hardlink-class-${index}-`);
      const name = `pair-${index}.db`;
      const { primary, alias } = hardlinkPair(home, name);

      for (const entries of [
        [
          { relativePath: name, classification: testCase.first },
          { relativePath: `${name}.alias`, classification: testCase.second },
        ],
        [
          { relativePath: `${name}.alias`, classification: testCase.second },
          { relativePath: name, classification: testCase.first },
        ],
      ]) {
        const result = resolveStoreSet(input(home, entries, true));
        assert.equal(result.stores.length, 1);
        assert.equal(
          result.stores[0].classification,
          testCase.expected,
          `${testCase.first} + ${testCase.second} must resolve to ${testCase.expected}`,
        );
        assert.ok(result.stores[0].pathAliases.includes(primary));
        assert.ok(result.stores[0].pathAliases.includes(alias));
      }
    });
  });

  it("never collapses distinct absent spellings: absence has no inode to share", () => {
    const home = fixtureDir("tamandua-store-set-absent-two-");

    const result = resolveStoreSet(
      input(
        home,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "projects.db", classification: "optional-present" },
        ],
        true,
      ),
    );

    assert.equal(result.stores.length, 2);
    for (const identity of result.stores) {
      assert.equal(identity.resolution, "absent");
      assert.equal(identity.canonicalPath, null);
      assert.equal(identity.pathAliases.length, 1);
      assert.equal(fs.existsSync(identity.pathAliases[0]), false);
    }
  });

  it("produces a deeply equal StoreSet when contract entries are permuted", () => {
    const home = fixtureDir("tamandua-store-set-permute-");
    hardlinkPair(home, "state.db");
    writeStore(path.join(home, "kanban.db"));

    const entries = [
      { relativePath: "state.db", classification: "optional-present" },
      { relativePath: "state.db.alias", classification: "required" },
      { relativePath: "kanban.db", classification: "inactive" },
      { relativePath: "projects.db", classification: "required" },
    ];

    const forward = resolveStoreSet(input(home, entries, true));
    const reversed = resolveStoreSet(input(home, [...entries].reverse(), true));
    const shuffled = resolveStoreSet(
      input(home, [entries[2], entries[0], entries[3], entries[1]], true),
    );

    // 2 resolved inodes (state.db + its hardlink are one) + 1 absent store.
    assert.equal(forward.stores.length, 3);
    assert.deepEqual(reversed, forward);
    assert.deepEqual(shuffled, forward);
    // The absent identity sorts by its first alias, exactly like the resolver;
    // a resolved identity sorts by its canonical path.
    const primaryKeys = forward.stores.map(
      (identity) => identity.canonicalPath ?? identity.pathAliases[0],
    );
    assert.deepEqual(primaryKeys, [...primaryKeys].sort(byteCompare));
  });
});

// ---------------------------------------------------------------------------
// mount-plan spellings and symlinked homes (US-003)
// ---------------------------------------------------------------------------

/**
 * A profile home reached through a symlink, plus the real directory the mount
 * plan names. `base` is the only fixture directory the `after()` hook needs.
 */
function symlinkedHomeFixture(prefix: string): {
  base: string;
  symlinkHome: string;
  realHome: string;
} {
  const base = fixtureDir(prefix);
  const realHome = path.join(base, "real");
  fs.mkdirSync(realHome);
  const symlinkHome = path.join(base, "link");
  fs.symlinkSync(realHome, symlinkHome);
  return { base, symlinkHome, realHome };
}

/** A mount plan whose single guest destination is backed by `hostPath`. */
function mountAt(hostPath: string) {
  return { mounts: { "/guest/home": { host_path: hostPath } } };
}

/** Resolve with an explicit mount plan; the plain `input` helper supplies none. */
function inputWithMounts(
  profileHome: string,
  entries: Array<{ relativePath: string; classification: string }>,
  mountPlan: unknown,
  complete?: boolean,
) {
  return {
    profileHome,
    mountPlan,
    storeContract: complete === undefined ? { entries } : { entries, complete },
  } as never;
}

/**
 * The fields a ROUTE must never change. `pathAliases` is deliberately excluded:
 * it records the route taken (that is its job), and US-003 requires the
 * caller's spelling and the mount-plan target spelling to both survive there.
 */
function identityMetadata(identity: {
  canonicalPath: string | null;
  dev: string | null;
  ino: string | null;
  fstype: string | null;
  size: number | null;
  classification: string;
  origin: string;
  resolution: string;
}) {
  return {
    canonicalPath: identity.canonicalPath,
    dev: identity.dev,
    ino: identity.ino,
    fstype: identity.fstype,
    size: identity.size,
    classification: identity.classification,
    origin: identity.origin,
    resolution: identity.resolution,
  };
}

describe("store-set: mount-plan spellings and symlinked homes", () => {
  it("resolves ONE identity when the mount plan names the symlink's target", () => {
    const { symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-symlink-home-",
    );
    writeStore(path.join(realHome, "state.db"));
    const symlinkSpelling = path.join(symlinkHome, "state.db");
    const targetSpelling = path.join(realHome, "state.db");
    const canonical = fs.realpathSync(targetSpelling);

    const result = resolveStoreSet(
      inputWithMounts(
        symlinkHome,
        [{ relativePath: "state.db", classification: "required" }],
        mountAt(realHome),
        true,
      ),
    );

    assert.equal(result.stores.length, 1, "one store must never become two");
    const identity = result.stores[0];
    const stats = fs.statSync(targetSpelling, { bigint: true });

    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.origin, "contract");
    assert.equal(identity.classification, "required");
    assert.equal(identity.canonicalPath, canonical);
    assert.notEqual(
      identity.canonicalPath,
      symlinkSpelling,
      "the symlink spelling is never the canonical one",
    );
    assert.ok(
      identity.pathAliases.includes(symlinkSpelling),
      "the caller's symlink spelling survives",
    );
    assert.ok(
      identity.pathAliases.includes(targetSpelling),
      "the mount-plan target spelling survives",
    );
    assert.deepEqual(
      identity.pathAliases,
      [...new Set([symlinkSpelling, targetSpelling, canonical])].sort(byteCompare),
    );
    assert.equal(identity.dev, stats.dev.toString());
    assert.equal(identity.ino, stats.ino.toString());
    assert.equal(identity.size, GARBAGE_BYTES.length);
    assert.deepEqual(result.incompleteReasons, []);
    assert.equal(result.inventoryComplete, true);
  });

  it("is identical with and without a mount plan that covers the home", () => {
    const { symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-symlink-same-",
    );
    writeStore(path.join(realHome, "state.db"));
    const entries = [{ relativePath: "state.db", classification: "required" }];

    const withoutMount = resolveStoreSet(input(symlinkHome, entries, true));
    const withMount = resolveStoreSet(
      inputWithMounts(symlinkHome, entries, mountAt(realHome), true),
    );

    // The derived spelling is the store's canonical path, which the caller's
    // own observation already recorded: no identity changes.
    assert.deepEqual(withMount.stores, withoutMount.stores);
    assert.deepEqual(withMount.discoveredUnexpected, withoutMount.discoveredUnexpected);
    // US-005: only the mount plan's COVERAGE differs — an empty plan cannot
    // prove the runtime sees this home, a plan naming the real home can.
    assert.deepEqual(withMount.incompleteReasons, []);
    assert.equal(withMount.inventoryComplete, true);
    assert.deepEqual(withoutMount.incompleteReasons, [
      "mount-plan-does-not-cover-profile-home",
    ]);
    assert.equal(withoutMount.inventoryComplete, false);

    // Same identity as a caller who only ever spells the real home.
    const viaTarget = resolveStoreSet(input(realHome, entries, true));
    assert.deepEqual(
      identityMetadata(withMount.stores[0]),
      identityMetadata(viaTarget.stores[0]),
    );
    assert.deepEqual(viaTarget.stores[0].pathAliases, [
      fs.realpathSync(path.join(realHome, "state.db")),
    ]);
  });

  it("keeps the mount target spelling when the store itself is a symlink", () => {
    const { base, symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-symlink-store-",
    );
    const storedAt = path.join(base, "store-target", "state.db");
    fs.mkdirSync(path.dirname(storedAt));
    writeStore(storedAt);
    fs.symlinkSync(storedAt, path.join(realHome, "state.db"));

    const result = resolveStoreSet(
      inputWithMounts(
        symlinkHome,
        [{ relativePath: "state.db", classification: "required" }],
        mountAt(realHome),
        true,
      ),
    );

    assert.equal(result.stores.length, 1);
    const identity = result.stores[0];
    const callerSpelling = path.join(symlinkHome, "state.db");
    const mountSpelling = path.join(realHome, "state.db");
    const canonical = fs.realpathSync(storedAt);

    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.canonicalPath, canonical);
    for (const spelling of [callerSpelling, mountSpelling, canonical]) {
      assert.ok(
        identity.pathAliases.includes(spelling),
        `${spelling} must survive as an alias`,
      );
    }
    assert.deepEqual(
      identity.pathAliases,
      [callerSpelling, mountSpelling, canonical].sort(byteCompare),
    );
  });

  it("adds no alias for a mount that is unrelated to the profile home", () => {
    const { base, symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-mount-unrelated-",
    );
    writeStore(path.join(realHome, "state.db"));
    const unrelated = path.join(base, "elsewhere");
    fs.mkdirSync(unrelated);
    const entries = [{ relativePath: "state.db", classification: "required" }];

    const baseline = resolveStoreSet(input(symlinkHome, entries, true));
    assert.deepEqual(
      resolveStoreSet(inputWithMounts(symlinkHome, entries, mountAt(unrelated), true)),
      baseline,
    );
    // A string prefix is not an ancestor: `real-sibling` must not count either.
    assert.deepEqual(
      resolveStoreSet(
        inputWithMounts(symlinkHome, entries, mountAt(path.join(base, "real-sibling")), true),
      ),
      baseline,
    );
    // An ancestor ABOVE the home IS a host source for it; the spelling it
    // derives is the resolved home, so it adds nothing new either. It does
    // prove COVERAGE, which the empty baseline plan cannot (US-005).
    const viaAncestor = resolveStoreSet(
      inputWithMounts(symlinkHome, entries, mountAt(base), true),
    );
    assert.deepEqual(viaAncestor.stores, baseline.stores);
    assert.deepEqual(viaAncestor.incompleteReasons, []);
    assert.equal(viaAncestor.inventoryComplete, true);
    assert.deepEqual(baseline.incompleteReasons, [
      "mount-plan-does-not-cover-profile-home",
    ]);
  });

  it("adds no duplicate alias when the mount host_path equals the profile home", () => {
    const { symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-mount-equal-",
    );
    writeStore(path.join(realHome, "state.db"));
    const entries = [{ relativePath: "state.db", classification: "required" }];

    const equalToReal = resolveStoreSet(
      inputWithMounts(realHome, entries, mountAt(realHome), true),
    );
    assert.deepEqual(equalToReal.stores[0].pathAliases, [
      path.join(realHome, "state.db"),
    ]);

    // The symlink spelling is not an ancestor of the resolved home, so it
    // contributes no spelling; the caller's own route is unchanged.
    const equalToSymlink = resolveStoreSet(
      inputWithMounts(symlinkHome, entries, mountAt(symlinkHome), true),
    );
    assert.deepEqual(equalToSymlink, resolveStoreSet(input(symlinkHome, entries, true)));
  });

  it("counts an absent store once under a symlinked home, keeping both spellings", () => {
    const { symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-symlink-absent-",
    );
    const callerSpelling = path.join(symlinkHome, "state.db");
    const mountSpelling = path.join(realHome, "state.db");

    const result = resolveStoreSet(
      inputWithMounts(
        symlinkHome,
        [{ relativePath: "state.db", classification: "required" }],
        mountAt(realHome),
        true,
      ),
    );

    assert.equal(
      result.stores.length,
      1,
      "two spellings of one absent store are not two stores",
    );
    const identity = result.stores[0];
    assert.equal(identity.resolution, "absent");
    assert.equal(identity.canonicalPath, null);
    assert.equal(identity.dev, null);
    assert.equal(identity.ino, null);
    assert.equal(identity.fstype, null);
    assert.equal(identity.size, null);
    assert.deepEqual(
      identity.pathAliases,
      [callerSpelling, mountSpelling].sort(byteCompare),
    );
    assert.equal(fs.existsSync(mountSpelling), false, "nothing is created");
    assert.equal(fs.existsSync(callerSpelling), false, "nothing is created");
    assert.deepEqual(result.incompleteReasons, []);
    assert.equal(result.inventoryComplete, true);

    // Distinct absent stores stay distinct: spelling them per contract entry
    // must not merge them into one.
    const twoAbsent = resolveStoreSet(
      inputWithMounts(
        symlinkHome,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "projects.db", classification: "optional-present" },
        ],
        mountAt(realHome),
        true,
      ),
    );
    assert.equal(twoAbsent.stores.length, 2);
    for (const absent of twoAbsent.stores) {
      assert.equal(absent.resolution, "absent");
      assert.equal(absent.pathAliases.length, 2, "each keeps both spellings");
    }
  });

  it("does not throw and changes no identity for empty, absent or malformed mount plans", () => {
    const { symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-mount-empty-",
    );
    writeStore(path.join(realHome, "state.db"));
    const entries = [{ relativePath: "state.db", classification: "required" }];
    const baseline = resolveStoreSet(input(symlinkHome, entries, true));

    const mountPlans: unknown[] = [
      {},
      { mounts: undefined },
      { mounts: null },
      { mounts: {} },
      { mounts: { "/guest/home": {} } },
      { mounts: { "/guest/home": { host_path: "" } } },
      { mounts: { "/guest/home": { host_path: "relative/home" } } },
      { mounts: { "/guest/home": { host_path: 42 } } },
      { mounts: { "/guest/home": null } },
      { mounts: [{ host_path: "" }] },
      undefined,
    ];

    for (const mountPlan of mountPlans) {
      assert.deepEqual(
        resolveStoreSet(inputWithMounts(symlinkHome, entries, mountPlan, true)),
        baseline,
        `mount plan ${JSON.stringify(mountPlan)} must not change the identity`,
      );
    }
  });

  it("never fabricates a mount spelling when the profile home cannot be resolved", () => {
    const base = fixtureDir("tamandua-store-set-mount-missing-home-");
    const missingHome = path.join(base, "missing-home");
    const missingStore = path.join(missingHome, "state.db");

    const result = resolveStoreSet(
      inputWithMounts(
        missingHome,
        [{ relativePath: "state.db", classification: "required" }],
        mountAt(base),
        true,
      ),
    );

    assert.equal(result.stores.length, 1);
    const identity = result.stores[0];
    assert.equal(identity.resolution, "absent");
    assert.equal(identity.canonicalPath, null);
    assert.equal(identity.dev, null);
    assert.equal(identity.ino, null);
    assert.deepEqual(
      identity.pathAliases,
      [missingStore],
      "an unresolvable home contributes no invented spelling",
    );
    // US-004: a home that cannot be listed is a recorded doubt, never an abort.
    // US-005: with no resolved home, mount coverage cannot be proven either —
    // the declared ancestor is not compared against an invented realpath.
    assert.deepEqual(result.incompleteReasons, [
      "mount-plan-does-not-cover-profile-home",
      "profile-home-unlistable:ENOENT",
    ]);
    assert.equal(result.inventoryComplete, false);
    assert.equal(fs.existsSync(missingStore), false);
  });

  it("orders mount-plan aliases deterministically and ignores entry order", () => {
    const { symlinkHome, realHome } = symlinkedHomeFixture(
      "tamandua-store-set-mount-order-",
    );
    writeStore(path.join(realHome, "state.db"));
    writeStore(path.join(realHome, "kanban.db"));
    const mountPlan = mountAt(realHome);

    const forward = resolveStoreSet(
      inputWithMounts(
        symlinkHome,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "kanban.db", classification: "inactive" },
        ],
        mountPlan,
        true,
      ),
    );
    const reversed = resolveStoreSet(
      inputWithMounts(
        symlinkHome,
        [
          { relativePath: "kanban.db", classification: "inactive" },
          { relativePath: "state.db", classification: "required" },
        ],
        mountPlan,
        true,
      ),
    );

    assert.equal(forward.stores.length, 2);
    assert.deepEqual(reversed, forward);
    for (const identity of forward.stores) {
      assert.deepEqual(
        identity.pathAliases,
        [...new Set(identity.pathAliases)].sort(byteCompare),
        "aliases are deduped and byte sorted",
      );
    }
    // An inactive store that exists anyway is still returned and inspected.
    const classifications = forward.stores.map((identity) => identity.classification);
    assert.deepEqual([...classifications].sort(byteCompare), ["inactive", "required"]);
  });
});

// ---------------------------------------------------------------------------
// profile-home discovery and unlistable homes (US-004)
// ---------------------------------------------------------------------------

describe("store-set: profile-home discovery", () => {
  it("reports an unexpected top-level *.db file as an optional-present candidate", () => {
    const home = fixtureDir("tamandua-store-set-scan-extra-");
    writeStore(path.join(home, "state.db"));
    const rogue = path.join(home, "rogue.db");
    const rogueBytes = Buffer.from("nor is this one a database");
    writeStore(rogue, rogueBytes);
    const listingBefore = fs.readdirSync(home).sort();

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    assert.equal(result.stores.length, 2, "the candidate is reported, not merged away");
    assert.deepEqual(
      result.stores.map((identity) => identity.origin),
      ["directory-scan", "contract"],
      "stores stay ordered by canonical path (rogue.db sorts before state.db)",
    );

    const discovered = result.discoveredUnexpected;
    assert.equal(discovered.length, 1);
    const identity = discovered[0];
    assert.equal(identity.origin, "directory-scan");
    // A candidate can never become mandatory: the listing cannot know which
    // feature would open it, and promoting it would create false refusals.
    assert.equal(identity.classification, "optional-present");
    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.canonicalPath, fs.realpathSync(rogue));
    assert.deepEqual(
      identity.pathAliases,
      [...new Set([rogue, fs.realpathSync(rogue)])].sort(byteCompare),
    );
    assert.equal(identity.size, rogueBytes.length);
    const stats = fs.statSync(rogue, { bigint: true });
    assert.equal(identity.dev, stats.dev.toString());
    assert.equal(identity.ino, stats.ino.toString());

    // Discovery is information, not a doubt: nothing was left unread.
    assert.deepEqual(result.incompleteReasons, []);
    assert.equal(result.inventoryComplete, true);
    // It reports the file; it never creates or rewrites anything.
    assert.deepEqual(fs.readdirSync(home).sort(), listingBefore);
  });

  it("merges a hardlink under a non-contract *.db name into the contract identity", () => {
    const home = fixtureDir("tamandua-store-set-scan-hardlink-");
    const contractStore = path.join(home, "state.db");
    writeStore(contractStore);
    const secondName = path.join(home, "shadow.db");
    fs.linkSync(contractStore, secondName);
    const stats = fs.statSync(contractStore, { bigint: true });
    assert.equal(fs.statSync(secondName, { bigint: true }).ino, stats.ino);

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    // One inode is one store, whatever it is called.
    assert.equal(result.stores.length, 1);
    const identity = result.stores[0];
    assert.equal(identity.origin, "contract", "a listing can never change the origin");
    assert.equal(identity.classification, "required");
    assert.equal(identity.ino, stats.ino.toString());
    assert.ok(identity.pathAliases.includes(contractStore));
    assert.ok(
      identity.pathAliases.includes(secondName),
      "the non-contract spelling survives as sidecar evidence",
    );
    assert.deepEqual(identity.pathAliases, [contractStore, secondName].sort(byteCompare));
    assert.deepEqual(result.discoveredUnexpected, [], "a merged name is not unexpected");
    assert.deepEqual(result.incompleteReasons, []);
  });

  it("discovers a symlink named extra.db with the target's realpath", () => {
    const home = fixtureDir("tamandua-store-set-scan-symlink-");
    const targetDir = path.join(home, "payload");
    fs.mkdirSync(targetDir);
    const target = path.join(targetDir, "store.bin");
    writeStore(target);
    const link = path.join(home, "extra.db");
    fs.symlinkSync(target, link);

    const result = resolveStoreSet(
      input(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    // The absent contract store is still reported alongside the discovery.
    assert.equal(result.stores.length, 2);
    const discovered = result.discoveredUnexpected;
    assert.equal(discovered.length, 1);
    const identity = discovered[0];
    const canonical = fs.realpathSync(target);
    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.canonicalPath, canonical);
    assert.notEqual(identity.canonicalPath, link);
    assert.deepEqual(identity.pathAliases, [...new Set([link, canonical])].sort(byteCompare));
    assert.ok(identity.pathAliases.includes(link), "the listed name survives verbatim");
    assert.equal(identity.size, GARBAGE_BYTES.length);
  });

  it("ignores non-.db names, *.db directories and SQLite sidecars", () => {
    const home = fixtureDir("tamandua-store-set-scan-ignored-");
    writeStore(path.join(home, "state.db"));
    writeStore(path.join(home, "README.md"));
    writeStore(path.join(home, "state.db-wal"));
    writeStore(path.join(home, "state.db-shm"));
    writeStore(path.join(home, "state.db-journal"));
    // The suffix alone is not a name.
    writeStore(path.join(home, ".db"));
    // A directory called *.db is a directory, not a store.
    fs.mkdirSync(path.join(home, "x.db"));
    // Neither is a symlink that resolves to a directory.
    fs.mkdirSync(path.join(home, "dir-target"));
    fs.symlinkSync(path.join(home, "dir-target"), path.join(home, "link.db"));

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    assert.equal(result.stores.length, 1, "only the contract store is a store");
    assert.equal(result.stores[0].origin, "contract");
    assert.deepEqual(result.discoveredUnexpected, []);
    assert.deepEqual(result.incompleteReasons, []);
    assert.equal(result.inventoryComplete, true);
  });

  it("reports a dangling-symlink candidate as unresolved instead of dropping it", () => {
    const home = fixtureDir("tamandua-store-set-scan-dangling-");
    const ghost = path.join(home, "ghost.db");
    fs.symlinkSync(path.join(home, "no-such-target"), ghost);

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    // The absent contract store AND the candidate we could not identify.
    assert.equal(result.stores.length, 2);
    const discovered = result.discoveredUnexpected;
    assert.equal(discovered.length, 1, "the name must never be silently dropped");
    const identity = discovered[0];
    assert.equal(identity.origin, "directory-scan");
    assert.equal(identity.classification, "optional-present");
    assert.equal(identity.resolution, "unresolved");
    assert.equal(identity.canonicalPath, null);
    assert.equal(identity.dev, null);
    assert.equal(identity.ino, null);
    assert.equal(identity.fstype, null);
    assert.equal(identity.size, null);
    assert.deepEqual(identity.pathAliases, [ghost]);

    assert.equal(result.inventoryComplete, false);
    assert.deepEqual(result.incompleteReasons, [`store-unresolved:${ghost}:ENOENT`]);
  });

  it("never duplicates a store the contract and the listing both see", () => {
    const home = fixtureDir("tamandua-store-set-scan-no-dup-");
    writeStore(path.join(home, "state.db"));
    const loop = path.join(home, "loop.db");
    fs.symlinkSync(loop, loop);

    const result = resolveStoreSet(
      coveredInput(
        home,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "loop.db", classification: "required" },
        ],
        true,
      ),
    );

    assert.equal(result.stores.length, 2, "each spelling is one store");
    assert.deepEqual(result.discoveredUnexpected, []);
    const unresolved = result.stores.find((identity) => identity.pathAliases.includes(loop));
    assert.ok(unresolved);
    assert.equal(unresolved.resolution, "unresolved");
    assert.equal(unresolved.origin, "contract");
    assert.equal(unresolved.pathAliases.length, 1);
    // Contract and listing both failed on the same name: one reason, not two.
    assert.deepEqual(result.incompleteReasons, [`store-unresolved:${loop}:ELOOP`]);
  });

  it("reports profile-home-unlistable:ENOENT and every contract identity when the home is missing", () => {
    const base = fixtureDir("tamandua-store-set-scan-missing-");
    const missingHome = path.join(base, "gone");

    const result = resolveStoreSet(
      input(
        missingHome,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "kanban.db", classification: "optional-present" },
        ],
        true,
      ),
    );

    assert.equal(result.stores.length, 2, "contract identities survive an unlistable home");
    const byAlias = new Map(result.stores.map((identity) => [identity.pathAliases[0], identity]));
    for (const relativePath of ["state.db", "kanban.db"]) {
      const identity = byAlias.get(path.join(missingHome, relativePath));
      assert.ok(identity, `${relativePath} must still be reported`);
      assert.equal(identity.resolution, "absent");
      assert.equal(identity.canonicalPath, null);
      assert.equal(identity.dev, null);
      assert.equal(identity.ino, null);
      assert.equal(identity.origin, "contract");
    }
    assert.deepEqual(result.discoveredUnexpected, []);
    // A home that does not exist cannot be listed AND cannot be proven covered.
    assert.deepEqual(result.incompleteReasons, [
      "mount-plan-does-not-cover-profile-home",
      "profile-home-unlistable:ENOENT",
    ]);
    assert.equal(result.inventoryComplete, false);
    assert.equal(fs.existsSync(missingHome), false, "nothing is created");
  });

  it("reports profile-home-unlistable:EACCES and keeps contract identities", (t) => {
    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      t.skip("euid 0 bypasses directory permissions, so EACCES cannot be produced");
      return;
    }
    const home = fixtureDir("tamandua-store-set-scan-eacces-");
    writeStore(path.join(home, "state.db"));
    fs.chmodSync(home, 0o000);
    try {
      const result = resolveStoreSet(
        input(home, [{ relativePath: "state.db", classification: "required" }], true),
      );

      assert.equal(result.stores.length, 1, "the contract identity is still returned");
      assert.deepEqual(result.stores[0].pathAliases, [path.join(home, "state.db")]);
      assert.deepEqual(result.discoveredUnexpected, []);
      assert.ok(
        result.incompleteReasons.includes("profile-home-unlistable:EACCES"),
        `expected profile-home-unlistable:EACCES in ${JSON.stringify(result.incompleteReasons)}`,
      );
      assert.equal(result.inventoryComplete, false);
    } finally {
      fs.chmodSync(home, 0o700);
    }
  });

  it("keeps discoveredUnexpected equal to the directory-scan subset, in stores order", () => {
    const home = fixtureDir("tamandua-store-set-scan-order-");
    for (const name of ["zeta.db", "alpha.db", "middle.db"]) {
      writeStore(path.join(home, name));
    }

    const result = resolveStoreSet(coveredInput(home, [], true));

    assert.equal(result.stores.length, 3);
    assert.deepEqual(
      result.discoveredUnexpected,
      result.stores.filter((identity) => identity.origin === "directory-scan"),
      "discoveredUnexpected is exactly the directory-scan subset",
    );
    assert.equal(result.discoveredUnexpected.length, 3);
    const paths = result.stores.map((identity) => identity.canonicalPath ?? "");
    assert.deepEqual(paths, [...paths].sort(byteCompare));
    // Every discovered candidate is resolvable metadata, and still a candidate.
    for (const identity of result.discoveredUnexpected) {
      assert.equal(identity.resolution, "resolved");
      assert.equal(identity.classification, "optional-present");
      assert.equal(typeof identity.ino, "string");
    }
    assert.deepEqual(result.incompleteReasons, []);
    assert.equal(result.inventoryComplete, true);
  });
});

// ---------------------------------------------------------------------------
// inventory completeness: attestation, mount coverage and evidence (US-005)
// ---------------------------------------------------------------------------

/** The reason that means "the plan cannot prove the runtime sees this home". */
const REASON_MOUNT_UNCOVERED = "mount-plan-does-not-cover-profile-home";

/**
 * The stable reason vocabulary, checked structurally: the gate matches these
 * prefixes, so an invented reason would silently fail to explain an
 * incompleteness.
 */
function assertReasonVocabulary(reasons: readonly string[]): void {
  for (const reason of reasons) {
    assert.match(
      reason,
      /^(?:contract-incomplete|mount-plan-does-not-cover-profile-home|profile-home-unlistable:[A-Za-z0-9_-]+|store-unresolved:.+:[A-Za-z0-9_-]+)$/,
      `unexpected incompleteness reason ${JSON.stringify(reason)}`,
    );
  }
}

/**
 * US-005's single derivation: `inventoryComplete` is exactly
 * `incompleteReasons.length === 0`, the list is deduped, sorted in UTF-8 byte
 * order, and every entry is in the stable vocabulary. There is deliberately no
 * second flag that could drift from the reasons.
 */
function assertCompletenessInvariant(
  result: ReturnType<typeof resolveStoreSet>,
  label: string,
): void {
  assert.equal(
    result.inventoryComplete,
    result.incompleteReasons.length === 0,
    `${label}: inventoryComplete must be exactly incompleteReasons.length === 0`,
  );
  assert.equal(
    result.incompleteReasons.length,
    new Set(result.incompleteReasons).size,
    `${label}: incompleteReasons must be deduped`,
  );
  assert.deepEqual(
    result.incompleteReasons,
    [...result.incompleteReasons].sort(byteCompare),
    `${label}: incompleteReasons must be sorted in UTF-8 byte order`,
  );
  assertReasonVocabulary(result.incompleteReasons);
}

describe("store-set: inventory completeness", () => {
  it("is complete with an attested contract, a covering mount and a listable home", () => {
    const home = fixtureDir("tamandua-store-set-attested-complete-");
    writeStore(path.join(home, "state.db"));

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    assert.equal(result.stores.length, 1);
    assert.equal(result.stores[0].resolution, "resolved");
    assert.deepEqual(result.incompleteReasons, []);
    assert.equal(result.inventoryComplete, true);
    assertCompletenessInvariant(result, "attested + covered + listable");
  });

  it("keeps completeness for a required store that is simply absent", () => {
    const home = fixtureDir("tamandua-store-set-absent-complete-");
    const entries = [{ relativePath: "state.db", classification: "required" }];

    const covered = resolveStoreSet(coveredInput(home, entries, true));
    assert.equal(covered.stores[0].resolution, "absent");
    assert.equal(covered.stores[0].classification, "required");
    assert.deepEqual(covered.incompleteReasons, []);
    assert.equal(
      covered.inventoryComplete,
      true,
      "a required-but-absent store is the gate's decision, not an inventory doubt",
    );
    assert.equal(fs.existsSync(path.join(home, "state.db")), false, "nothing is created");

    // The SAME absent store under an uncovered plan is incomplete ONLY because
    // coverage is unproven. Absence itself never adds a reason.
    const uncovered = resolveStoreSet(input(home, entries, true));
    assert.deepEqual(uncovered.stores, covered.stores);
    assert.deepEqual(uncovered.incompleteReasons, [REASON_MOUNT_UNCOVERED]);
    assert.equal(uncovered.inventoryComplete, false);
    assertCompletenessInvariant(uncovered, "absent + uncovered");
  });

  it("requires the contract attestation even when every store resolves", () => {
    const home = fixtureDir("tamandua-store-set-unattested-");
    writeStore(path.join(home, "state.db"));

    for (const complete of [undefined, false]) {
      const result = resolveStoreSet(
        coveredInput(home, [{ relativePath: "state.db", classification: "required" }], complete),
      );
      assert.equal(result.stores[0].resolution, "resolved");
      assert.deepEqual(result.incompleteReasons, ["contract-incomplete"]);
      assert.equal(result.inventoryComplete, false);
      assertCompletenessInvariant(result, `complete=${String(complete)}`);
    }
  });

  it("requires a mount plan that proves the runtime sees the profile home", () => {
    const home = fixtureDir("tamandua-store-set-mount-coverage-");
    writeStore(path.join(home, "state.db"));
    const entries = [{ relativePath: "state.db", classification: "required" }];
    const base = path.dirname(home);
    const covered = resolveStoreSet(coveredInput(home, entries, true));
    assert.deepEqual(covered.incompleteReasons, []);

    const nonCovering: unknown[] = [
      undefined,
      {},
      { mounts: undefined },
      { mounts: {} },
      { mounts: { "/guest/home": {} } },
      { mounts: { "/guest/home": { host_path: "" } } },
      { mounts: { "/guest/home": { host_path: "relative/home" } } },
      { mounts: { "/guest/home": { host_path: 42 } } },
      // A child of the home is not an ANCESTOR of it: the runtime would see
      // only a subdirectory, never the stores beside it.
      mountAt(path.join(home, "child")),
      // A sibling sharing a name prefix is not an ancestor either.
      mountAt(`${home}-sibling`),
      // An unrelated existing directory exposes none of this home.
      mountAt(path.join(base, `${path.basename(home)}-unrelated`)),
    ];

    for (const mountPlan of nonCovering) {
      const result = resolveStoreSet(inputWithMounts(home, entries, mountPlan, true));
      assert.deepEqual(
        result.incompleteReasons,
        [REASON_MOUNT_UNCOVERED],
        `mount plan ${JSON.stringify(mountPlan)} must not count as coverage`,
      );
      assert.equal(result.inventoryComplete, false);
      // Coverage is a doubt about the inventory, never about an identity.
      assert.deepEqual(result.stores, covered.stores);
      assertCompletenessInvariant(result, `uncovered ${JSON.stringify(mountPlan)}`);
    }

    const covering: unknown[] = [
      mountAt(home),
      // An ancestor above the home exposes it too.
      mountAt(base),
      // Normalization: `.` and `..` segments are the same source, not a lie.
      mountAt(`${home}${path.sep}.`),
      mountAt(`${base}${path.sep}.${path.sep}${path.basename(home)}`),
    ];

    for (const mountPlan of covering) {
      const result = resolveStoreSet(inputWithMounts(home, entries, mountPlan, true));
      assert.deepEqual(
        result.incompleteReasons,
        [],
        `mount plan ${JSON.stringify(mountPlan)} must count as coverage`,
      );
      assert.equal(result.inventoryComplete, true);
      assert.deepEqual(result.stores, covered.stores);
      assertCompletenessInvariant(result, `covered ${JSON.stringify(mountPlan)}`);
    }
  });

  it("is incomplete for a symlink-loop store even when attested and covered", () => {
    const home = fixtureDir("tamandua-store-set-loop-complete-");
    const loop = path.join(home, "loop.db");
    fs.symlinkSync(loop, loop);

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "loop.db", classification: "required" }], true),
    );

    assert.equal(result.stores[0].resolution, "unresolved");
    assert.equal(result.stores[0].canonicalPath, null);
    assert.deepEqual(result.incompleteReasons, [`store-unresolved:${loop}:ELOOP`]);
    assert.equal(result.inventoryComplete, false);
    assertCompletenessInvariant(result, "attested + covered + loop");
  });

  it("dedupes and byte-sorts the whole reason vocabulary", () => {
    const home = fixtureDir("tamandua-store-set-reason-vocabulary-");
    const zLoop = path.join(home, "z-loop.db");
    const aLoop = path.join(home, "a-loop.db");
    fs.symlinkSync(zLoop, zLoop);
    fs.symlinkSync(aLoop, aLoop);

    // Unattested AND uncovered, so every reason kind can appear at once. Each
    // loop is also a profile-home listing candidate; the two observations of
    // one name must leave ONE reason, not two.
    const result = resolveStoreSet(
      input(
        home,
        [
          { relativePath: "z-loop.db", classification: "required" },
          { relativePath: "a-loop.db", classification: "required" },
        ],
        false,
      ),
    );

    const expected = [
      "contract-incomplete",
      REASON_MOUNT_UNCOVERED,
      `store-unresolved:${aLoop}:ELOOP`,
      `store-unresolved:${zLoop}:ELOOP`,
    ].sort(byteCompare);

    assert.deepEqual(result.incompleteReasons, expected);
    assert.equal(result.inventoryComplete, false);
    assertCompletenessInvariant(result, "full vocabulary");
  });

  it("returns a deeply equal StoreSet for consecutive calls on unchanged fixtures", () => {
    const home = fixtureDir("tamandua-store-set-repeatable-");
    writeStore(path.join(home, "state.db"));
    const loop = path.join(home, "loop.db");
    fs.symlinkSync(loop, loop);
    const entries = [
      { relativePath: "state.db", classification: "required" },
      { relativePath: "projects.db", classification: "optional-present" },
      { relativePath: "loop.db", classification: "required" },
    ];

    const first = resolveStoreSet(coveredInput(home, entries, true));
    const second = resolveStoreSet(coveredInput(home, entries, true));

    assert.deepEqual(second, first);
    // The fixture really exercises more than one resolution state (stores sort
    // by path, so assert the set rather than inventing an order here).
    assert.deepEqual(
      first.stores.map((identity) => identity.resolution).sort(byteCompare),
      ["absent", "resolved", "unresolved"],
    );
    assert.deepEqual(first.incompleteReasons, [`store-unresolved:${loop}:ELOOP`]);
    assertCompletenessInvariant(first, "repeatable");
  });

  it("keeps inventoryComplete equal to (incompleteReasons.length === 0) in every case", () => {
    const home = fixtureDir("tamandua-store-set-invariant-");
    writeStore(path.join(home, "state.db"));
    const entries = [{ relativePath: "state.db", classification: "required" }];

    const results = [
      resolveStoreSet(coveredInput(home, entries, true)),
      resolveStoreSet(coveredInput(home, entries)),
      resolveStoreSet(input(home, entries, true)),
      resolveStoreSet(input(home, entries)),
    ];

    results.forEach((result, index) =>
      assertCompletenessInvariant(result, `invariant case ${index}`),
    );
    // The invariant is not vacuous: both outcomes occur in the matrix.
    assert.equal(results[0].inventoryComplete, true);
    assert.deepEqual(results[0].incompleteReasons, []);
    for (const incomplete of results.slice(1)) {
      assert.equal(incomplete.inventoryComplete, false);
      assert.ok(incomplete.incompleteReasons.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// metadata-only purity and mutation freedom (US-006)
// ---------------------------------------------------------------------------

/**
 * A second body of bytes that is unambiguously not a database: no SQLite
 * header, no page structure. Two distinct bodies exist so the suite can show
 * the resolver's result never depends on store CONTENT.
 */
const NOISE_BYTES = Buffer.from("neither is this a database");

/** A directory listing as sorted names; the only listing the walk may perform. */
function dirListing(dir: string): string[] {
  return fs.readdirSync(dir).sort(byteCompare);
}

/** Sidecar files that would exist only if something had opened a store. */
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** Every file beside the stores that looks like a SQLite sidecar. */
function sidecarsIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => SIDECAR_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .sort(byteCompare);
}

/** sha256 of a fixture's bytes. Reading content is the TEST's job, never the module's. */
function fileSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Everything about a fixture store that resolving the inventory must leave
 * untouched. `atime` is deliberately EXCLUDED: a metadata walk may legitimately
 * refresh it, so it is not evidence of mutation. Content, byte length, mtime
 * and filesystem identity are.
 */
function storeFingerprint(file: string) {
  const stats = fs.statSync(file, { bigint: true });
  return {
    sha256: fileSha256(file),
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
  };
}

/** Fingerprints in the caller's order, so a reordering would also be visible. */
function fingerprintAll(files: readonly string[]) {
  return files.map(storeFingerprint);
}

/** The identity a fixture spelled exactly like this must be reported as. */
function identityAt(
  result: ReturnType<typeof resolveStoreSet>,
  spelling: string,
) {
  const identity = result.stores.find((store) =>
    store.pathAliases.includes(spelling),
  );
  assert.ok(identity, `expected an identity carrying the spelling ${spelling}`);
  return identity;
}

describe("store-set: metadata-only purity", () => {
  it("resolves a non-database fixture without throwing and reports its byte length", () => {
    const home = fixtureDir("tamandua-store-set-noise-");
    const store = path.join(home, "state.db");
    fs.writeFileSync(store, NOISE_BYTES);

    // A driver would refuse these bytes; a metadata-only resolver cannot tell
    // them apart from a real store, which is exactly the point.
    assert.notDeepEqual(
      NOISE_BYTES.subarray(0, 16),
      Buffer.from("SQLite format 3\u0000", "latin1"),
    );

    const result = resolveStoreSet(
      coveredInput(home, [{ relativePath: "state.db", classification: "required" }], true),
    );

    assert.equal(result.stores.length, 1);
    const identity = result.stores[0];
    assert.equal(identity.resolution, "resolved");
    assert.equal(identity.classification, "required");
    assert.equal(identity.size, NOISE_BYTES.length);
    assert.equal(identity.size, fs.statSync(store).size);
    // Not one byte was touched, and the content is still not a database.
    assert.deepEqual(fs.readFileSync(store), NOISE_BYTES);
  });

  it("leaves every fixture store byte-identical and the home listing unchanged", () => {
    const home = fixtureDir("tamandua-store-set-mutation-free-");
    const stateDb = path.join(home, "state.db");
    const verifyDb = path.join(home, "verification_evidence.db");
    const kanbanDb = path.join(home, "kanban.db");
    const notes = path.join(home, "notes.txt");
    const nested = path.join(home, "nested");
    fs.writeFileSync(stateDb, GARBAGE_BYTES);
    fs.writeFileSync(verifyDb, NOISE_BYTES);
    fs.writeFileSync(kanbanDb, Buffer.alloc(0));
    fs.writeFileSync(notes, "notes are not a store");
    fs.mkdirSync(nested);

    const fixtureStores = [stateDb, verifyDb, kanbanDb];
    const fingerprintsBefore = fingerprintAll(fixtureStores);
    const listingBefore = dirListing(home);
    const nestedBefore = dirListing(nested);

    const result = resolveStoreSet(
      coveredInput(
        home,
        [
          { relativePath: "state.db", classification: "required" },
          { relativePath: "verification_evidence.db", classification: "optional-present" },
          { relativePath: "kanban.db", classification: "inactive" },
          { relativePath: "projects.db", classification: "optional-present" },
        ],
        true,
      ),
    );

    // Criterion 2: content, size and mtime are byte-identical, the listing is
    // unchanged, and nothing appeared in the (empty) subdirectory either.
    assert.deepEqual(fingerprintAll(fixtureStores), fingerprintsBefore);
    assert.deepEqual(dirListing(home), listingBefore);
    assert.deepEqual(dirListing(nested), nestedBefore);

    // Criterion 3: nothing opened a store, so no sidecar exists.
    assert.deepEqual(sidecarsIn(home), []);

    // The missing contract store was recorded, never created.
    assert.equal(fs.existsSync(path.join(home, "projects.db")), false);
    assert.equal(identityAt(result, path.join(home, "projects.db")).resolution, "absent");

    // An inactive store that exists anyway is still returned and still
    // inspected: `inactive` is about non-creation, never an exemption.
    const kanban = identityAt(result, kanbanDb);
    assert.equal(kanban.classification, "inactive");
    assert.equal(kanban.resolution, "resolved");
    assert.equal(kanban.size, 0);
    assert.equal(result.stores.length, 4);
  });

  it("returns deeply equal StoreSets across repeated calls and creates no sidecar", () => {
    const home = fixtureDir("tamandua-store-set-repeatable-purity-");
    const store = path.join(home, "state.db");
    const extra = path.join(home, "extra.db");
    fs.writeFileSync(store, GARBAGE_BYTES);
    fs.writeFileSync(extra, NOISE_BYTES);

    const entries = [
      { relativePath: "state.db", classification: "required" },
      { relativePath: "verification_evidence.db", classification: "optional-present" },
    ];
    const fingerprintBefore = storeFingerprint(store);
    const listingBefore = dirListing(home);

    const first = resolveStoreSet(coveredInput(home, entries, true));
    const second = resolveStoreSet(coveredInput(home, entries, true));

    // Criterion 4: the same filesystem state yields the same value, including
    // the directory-scan candidate and the absent store.
    assert.deepEqual(second, first);
    assert.deepEqual(
      first.discoveredUnexpected.map((identity) => identity.canonicalPath),
      [fs.realpathSync(extra)],
    );
    assert.deepEqual(sidecarsIn(home), []);
    assert.deepEqual(storeFingerprint(store), fingerprintBefore);
    assert.deepEqual(dirListing(home), listingBefore);
  });
});

// ---------------------------------------------------------------------------
// module purity (US-006)
// ---------------------------------------------------------------------------

describe("store-set: module purity", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf-8");

  it("imports no database driver, no child processes, no clock, no randomness, no environment", () => {
    // Built by concatenation so this test file itself stays free of tokens a
    // future scanner could mistake for real usage.
    const forbidden = [
      "node:" + "sqlite",
      "sqlite" + "3",
      "Database" + "Sync",
      "node:" + "child_process",
      "Da" + "te",
      "Math" + "." + "random",
      "process" + ".env",
    ];
    for (const token of forbidden) {
      assert.ok(
        !source.includes(token),
        `store-set.ts must not reference the forbidden token ${JSON.stringify(token)}`,
      );
    }
  });

  it("still states its no-clock property in prose, without the forbidden token", () => {
    // The property has to survive the token ban: it is described, not read.
    assert.match(source, /No clock reads/);
  });

  it("is not listed in tests/serial-files.txt (parallel lane, no spawns)", () => {
    const serial = fs.readFileSync(SERIAL_FILES_PATH, "utf-8");
    assert.ok(!serial.includes("store-set"));
  });
});
