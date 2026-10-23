/**
 * store-holder-detect tests (G6 HOLDER-DETECTION US-001/US-002).
 *
 * These tests exercise `detectStoreHolders` in
 * src/installer/matchlock/store-holder-detect.ts: the pinned result shape, the
 * single deduped probe call, holder identity matching by (dev, ino) and by
 * sidecar spelling, the sanitized command description (executable basename plus
 * up to three identifying arguments, credential redaction, pattern-kill
 * removal and a 240-character cap), the recorded (never thrown, never
 * refusing) probe failure, holder aggregation (duplicate pid+startIdentity
 * observations merge; same pid with a different startIdentity stays separate),
 * deterministic ordering and deep-equality under permuted store and candidate
 * order, and module purity. They import the COMPILED module from dist/ (repo
 * convention for this directory), so `npm run build` must run first.
 *
 * Fixtures are real regular files, never databases: identity matching is
 * filesystem metadata, so garbage bytes prove the module never opens a store.
 * A hardlink alias shares the store's inode (must match); a same-basename file
 * in another directory and a symlink to it have a different inode (must not
 * match). Every fixture directory comes from `tamanduaShortTempDir` and is
 * removed in the `after()` hook; no temp path is ever hardcoded.
 *
 * Nothing here spawns a process and no candidate is ever real: the probe is an
 * injected fake, so this file stays in the PARALLEL lane and must NOT be listed
 * in tests/serial-files.txt.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  detectStoreHolders,
  HolderProbeError,
} from "../../../dist/installer/matchlock/store-holder-detect.js";
import * as holderModule from "../../../dist/installer/matchlock/store-holder-detect.js";
import type {
  HolderCandidate,
  HolderProbeDeps,
  HolderStore,
} from "../../../dist/installer/matchlock/store-holder-detect.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "store-holder-detect.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");

const createdDirs: string[] = [];

let root: string;
let storePath: string;
let store: HolderStore;
let hardlinkPath: string;
let sameBasenamePath: string;
let secondStore: HolderStore;
let symlinkAliasPath: string;
let loopPath: string;
let loopPath2: string;
let walPath: string;
let shmPath: string;
let journalPath: string;

function fixtureDir(prefix: string): string {
  const dir = tamanduaShortTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

function writeFixtureFile(filePath: string, bytes: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function identityOf(filePath: string): HolderStore {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    canonicalPath: filePath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  };
}

before(() => {
  root = fixtureDir("tamandua-holder-detect-");

  // The store under inspection. Content is deliberately not a database.
  storePath = path.join(root, "main", "state.db");
  writeFixtureFile(storePath, "not a database: holder detection is metadata only");
  store = identityOf(storePath);

  // Real sidecars, so sidecar spelling matching is exercised on real files.
  walPath = `${storePath}-wal`;
  shmPath = `${storePath}-shm`;
  journalPath = `${storePath}-journal`;
  writeFixtureFile(walPath, "wal");
  writeFixtureFile(shmPath, "shm");
  writeFixtureFile(journalPath, "journal");

  // Hardlink alias: same (dev, ino), different spelling. Must match.
  hardlinkPath = path.join(root, "main", "state-hardlink.db");
  fs.linkSync(storePath, hardlinkPath);

  // Same basename in another directory: a different file. Must not match.
  sameBasenamePath = path.join(root, "aaa", "state.db");
  writeFixtureFile(sameBasenamePath, "a different store with the same basename");
  secondStore = identityOf(sameBasenamePath);

  // Symlink alias pointing at that different file. Must not match.
  symlinkAliasPath = path.join(root, "alias.db");
  fs.symlinkSync(sameBasenamePath, symlinkAliasPath);

  // A self-referential symlink: stat fails with a non-ENOENT error.
  loopPath = path.join(root, "loop.db");
  fs.symlinkSync("loop.db", loopPath);

  // A second one, so two unreadable paths can share one pid scope.
  loopPath2 = path.join(root, "loop2.db");
  fs.symlinkSync("loop2.db", loopPath2);
});

after(() => {
  for (const dir of createdDirs.splice(0).reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fixtures: injected probe deps
// ---------------------------------------------------------------------------

interface FakeProbe {
  deps: HolderProbeDeps;
  calls: string[][];
}

/** A probe that returns canned candidates and records every path list. */
function fakeProbe(candidates: HolderCandidate[]): FakeProbe {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      listOpenFileHolders(paths: string[]): HolderCandidate[] {
        calls.push([...paths]);
        return candidates;
      },
    },
  };
}

function throwingProbe(error: unknown): HolderProbeDeps {
  return {
    listOpenFileHolders(): HolderCandidate[] {
      throw error;
    },
  };
}

function candidate(
  overrides: Partial<HolderCandidate> & { pid: number },
): HolderCandidate {
  return {
    startIdentity: `v2:${overrides.pid}:1000`,
    argv: ["/usr/bin/node", "server.js"],
    openPaths: [],
    ...overrides,
  };
}

/**
 * Run `body` with `fs.statSync` made to fail for one exact path.
 *
 * A real EACCES/EPERM fixture is not dependable (a privileged runner bypasses
 * the permission bits) but the module deliberately treats every error except
 * ENOENT the same way, so a scoped injection is both deterministic and
 * faithful. The original function is restored in `finally`, and the module and
 * this test share the same `node:fs` default object, so the injection reaches
 * the compiled production call.
 */
function withStatFailure<T>(targetPath: string, code: string, body: () => T): T {
  const original = fs.statSync;
  const patched = (filePath: fs.PathLike, options?: unknown): unknown => {
    if (typeof filePath === "string" && filePath === targetPath) {
      throw Object.assign(
        new Error(`${code}: simulated stat failure, stat '${filePath}'`),
        { code },
      );
    }
    return (original as unknown as (p: fs.PathLike, o?: unknown) => unknown)(filePath, options);
  };
  (fs as unknown as { statSync: unknown }).statSync = patched;
  try {
    return body();
  } finally {
    (fs as unknown as { statSync: unknown }).statSync = original;
  }
}

// ---------------------------------------------------------------------------
// the probe contract
// ---------------------------------------------------------------------------

describe("store-holder-detect: probe path list", () => {
  it("calls the probe exactly once with the store then its three sidecars", () => {
    const probe = fakeProbe([]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.equal(probe.calls.length, 1);
    assert.deepEqual(probe.calls[0], [
      storePath,
      `${storePath}-wal`,
      `${storePath}-shm`,
      `${storePath}-journal`,
    ]);
    assert.deepEqual(detection, {
      observationComplete: true,
      holders: [],
      probeFailures: [],
    });
  });

  it("dedupes the whole path list in first-seen order", () => {
    const probe = fakeProbe([]);

    detectStoreHolders([store, secondStore, { ...store }], probe.deps);

    assert.equal(probe.calls.length, 1);
    assert.deepEqual(probe.calls[0], [
      storePath,
      `${storePath}-wal`,
      `${storePath}-shm`,
      `${storePath}-journal`,
      sameBasenamePath,
      `${sameBasenamePath}-wal`,
      `${sameBasenamePath}-shm`,
      `${sameBasenamePath}-journal`,
    ]);
  });

  it("does not call the probe when no store is supplied", () => {
    const probe = fakeProbe([]);

    const detection = detectStoreHolders([], probe.deps);

    assert.equal(probe.calls.length, 0);
    assert.deepEqual(detection, {
      observationComplete: true,
      holders: [],
      probeFailures: [],
    });
  });
});

// ---------------------------------------------------------------------------
// identity matching
// ---------------------------------------------------------------------------

describe("store-holder-detect: identity matching", () => {
  it("lists a process opening the store path with a sanitized command description", () => {
    const secret = "sk-live-9f8e7d6c5b4a";
    const probe = fakeProbe([
      candidate({
        pid: 4242,
        argv: ["/usr/bin/node", "--api-key", secret, "server.js"],
        openPaths: [storePath],
      }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.equal(detection.observationComplete, true);
    assert.deepEqual(detection.probeFailures, []);
    assert.equal(detection.holders.length, 1);

    const holder = detection.holders[0];
    assert.equal(holder.pid, 4242);
    assert.equal(holder.startIdentity, "v2:4242:1000");
    assert.equal(holder.commandDescription, "node --api-key [redacted] server.js");
    assert.deepEqual(holder.storePaths, [storePath]);
    // No raw argv array may appear in any result type.
    assert.deepEqual(Object.keys(holder).sort(), [
      "commandDescription",
      "pid",
      "startIdentity",
      "storePaths",
    ]);
    // The credential never reaches the listing.
    assert.ok(!JSON.stringify(detection).includes(secret));
  });

  it("lists a hardlink alias (same dev/ino, different spelling) as holding the store", () => {
    const probe = fakeProbe([
      candidate({ pid: 10, openPaths: [hardlinkPath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.equal(detection.holders.length, 1);
    assert.deepEqual(detection.holders[0].storePaths, [storePath]);
  });

  it("does not list a symlink alias pointing at a different file", () => {
    const probe = fakeProbe([
      candidate({ pid: 11, openPaths: [symlinkAliasPath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(detection.holders, []);
    assert.equal(detection.observationComplete, true);
  });

  it("does not list a same-basename file with a different inode", () => {
    const probe = fakeProbe([
      candidate({ pid: 12, openPaths: [sameBasenamePath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(detection.holders, []);
    assert.equal(detection.observationComplete, true);
  });

  it("lists every holder when two processes hold the same store", () => {
    const probe = fakeProbe([
      candidate({ pid: 200, openPaths: [storePath] }),
      candidate({ pid: 100, openPaths: [storePath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(
      detection.holders.map((holder) => holder.pid),
      [100, 200],
    );
  });

  it("ignores an open path that no longer exists (ENOENT) and keeps the observation complete", () => {
    const probe = fakeProbe([
      candidate({ pid: 13, openPaths: [path.join(root, "vanished.db")] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(detection.holders, []);
    assert.deepEqual(detection.probeFailures, []);
    assert.equal(detection.observationComplete, true);
  });
});

// ---------------------------------------------------------------------------
// sidecars and non-file entries
// ---------------------------------------------------------------------------

describe("store-holder-detect: sidecars and non-file entries", () => {
  it("reports a sidecar holder under the STORE canonical path, never the sidecar spelling", () => {
    const probe = fakeProbe([
      candidate({ pid: 21, openPaths: [walPath] }),
      candidate({ pid: 22, openPaths: [shmPath] }),
      candidate({ pid: 23, openPaths: [journalPath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(
      detection.holders.map((holder) => holder.pid),
      [21, 22, 23],
    );
    for (const holder of detection.holders) {
      assert.deepEqual(holder.storePaths, [storePath]);
    }
  });

  it("matches an unlinked-but-open sidecar after stripping a trailing ' (deleted)'", () => {
    const probe = fakeProbe([
      candidate({ pid: 24, openPaths: [`${walPath} (deleted)`] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.equal(detection.holders.length, 1);
    assert.deepEqual(detection.holders[0].storePaths, [storePath]);
  });

  it("ignores socket, pipe and anon_inode entries without throwing", () => {
    const probe = fakeProbe([
      candidate({
        pid: 25,
        openPaths: ["socket:[123]", "pipe:[456]", "anon_inode:[eventfd]"],
      }),
      candidate({ pid: 26, openPaths: [storePath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.equal(detection.observationComplete, true);
    assert.deepEqual(
      detection.holders.map((holder) => holder.pid),
      [26],
    );
  });
});

// ---------------------------------------------------------------------------
// command description
// ---------------------------------------------------------------------------

describe("store-holder-detect: command description", () => {
  it("uses '(command unavailable)' when argv is empty or its first entry is empty", () => {
    const probe = fakeProbe([
      candidate({ pid: 31, argv: [], openPaths: [storePath] }),
      candidate({ pid: 32, argv: [""], openPaths: [storePath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(
      detection.holders.map((holder) => holder.commandDescription),
      ["(command unavailable)", "(command unavailable)"],
    );
  });

  it("starts with the executable basename and keeps identifying arguments", () => {
    const probe = fakeProbe([
      candidate({
        pid: 33,
        argv: ["/usr/local/bin/python3", "-m", "hermes"],
        openPaths: [storePath],
      }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.equal(detection.holders[0].commandDescription, "python3 -m hermes");
  });
});

// ---------------------------------------------------------------------------
// command sanitization and credential redaction (spec section 8)
// ---------------------------------------------------------------------------

describe("store-holder-detect: command sanitization", () => {
  function descriptionFor(argv: string[]): string {
    const probe = fakeProbe([candidate({ pid: 900, argv, openPaths: [storePath] })]);
    const detection = detectStoreHolders([store], probe.deps);
    assert.equal(detection.holders.length, 1);
    return detection.holders[0].commandDescription;
  }

  it("keeps at most three identifying arguments after the executable basename", () => {
    assert.equal(
      descriptionFor([
        "/usr/local/bin/hermes",
        "--profile",
        "work",
        "serve",
        "--extra",
        "ignored",
      ]),
      "hermes --profile work serve",
    );
  });

  it("does not treat an innocuous sk- substring inside a word as a credential", () => {
    // "task-runner" contains "sk-r", but the prefix is not at a word boundary
    // and fewer than eight characters follow it, so it is left alone.
    assert.equal(
      descriptionFor(["/usr/bin/task-runner", "one", "two", "three", "four"]),
      "task-runner one two three",
    );
  });

  it("treats sk- as a secret only from eight credential characters onward", () => {
    assert.equal(
      descriptionFor(["/usr/bin/hermes", "sk-abcdefg", "serve"]),
      "hermes sk-abcdefg serve",
    );
    assert.equal(
      descriptionFor(["/usr/bin/hermes", "sk-abcdefgh", "serve"]),
      "hermes [redacted] serve",
    );
  });

  it("redacts an sk- credential token", () => {
    const secret = "sk-abcdefgh12345678";
    const description = descriptionFor(["/usr/bin/hermes", "--api-key", secret, "serve"]);

    assert.equal(description, "hermes --api-key [redacted] serve");
    assert.ok(!description.includes(secret));
  });

  it("redacts a Bearer credential and keeps the surrounding identification", () => {
    const description = descriptionFor(["/usr/bin/curl", "Bearer", "SECRET3", "serve"]);

    assert.equal(description, "curl Bearer [redacted] serve");
    assert.ok(!description.includes("SECRET3"));
  });

  it("redacts name=value assignments whose name marks a credential", () => {
    const description = descriptionFor([
      "/usr/bin/hermes",
      "--token=SECRET2",
      "token=SECRET4",
      "key=SECRET5",
      "ignored",
    ]);

    assert.equal(description, "hermes --token=[redacted] token=[redacted] key=[redacted]");
    for (const secret of ["SECRET2", "SECRET4", "SECRET5"]) {
      assert.ok(!description.includes(secret), `secret ${secret} must be absent`);
    }
  });

  it("redacts the separate value of a credential flag", () => {
    const description = descriptionFor(["/usr/bin/hermes", "--password", "SECRET6", "serve"]);

    assert.equal(description, "hermes --password [redacted] serve");
    assert.ok(!description.includes("SECRET6"));
  });

  it("keeps non-secret identification while redacting a credential in its place", () => {
    const description = descriptionFor([
      "/usr/local/bin/hermes",
      "sk-abcdefgh12345678",
      "serve",
      "work",
    ]);

    assert.equal(description, "hermes [redacted] serve work");
    assert.ok(description.includes("[redacted]"));
    assert.ok(!description.includes("sk-abcdefgh12345678"));
  });

  it("never emits any secret-shaped argv value from a combined command line", () => {
    const secrets = [
      "sk-abcdefgh12345678",
      "SECRET2",
      "SECRET3",
      "SECRET4",
      "SECRET5",
      "SECRET6",
    ];
    const description = descriptionFor([
      "/usr/local/bin/hermes",
      "--profile",
      "work",
      "serve",
      "--api-key",
      "sk-abcdefgh12345678",
      "--token=SECRET2",
      "Bearer",
      "SECRET3",
      "token=SECRET4",
      "key=SECRET5",
      "--password",
      "SECRET6",
    ]);

    // Identification survives untouched...
    assert.equal(description, "hermes --profile work serve");
    // ...and every secret-shaped value is absent from the listing.
    for (const secret of secrets) {
      assert.ok(!description.includes(secret), `secret ${secret} must be absent`);
    }
  });

  it("caps the description at 240 characters including the ellipsis", () => {
    const long = "y".repeat(100);
    const argv = [
      "/usr/bin/hermes",
      `${long}-1`,
      `${long}-2`,
      `${long}-3`,
      ...Array.from({ length: 46 }, (_, index) => `arg-${index}`),
    ];

    assert.equal(argv.length, 50);
    const description = descriptionFor(argv);

    assert.equal(description.length, 240);
    assert.ok(description.endsWith("..."));
  });

  it("strips control characters and newlines", () => {
    const description = descriptionFor(["/usr/bin/hermes", "line\nbreak\u0000here", "ok"]);

    assert.equal(description, "hermes line break here ok");
    assert.ok(!/[\u0000-\u001f\u007f]/.test(description));
  });

  it("never emits pattern-kill text from the executable or an argument", () => {
    const descriptions = [
      descriptionFor(["/usr/bin/pkill", "node"]),
      descriptionFor(["/usr/bin/hermes", "killall", "hermes"]),
      descriptionFor(["/bin/kill", "-9", "4242"]),
    ];

    for (const description of descriptions) {
      const lowered = description.toLowerCase();
      for (const banned of ["pkill", "killall", "kill -9"]) {
        assert.ok(
          !lowered.includes(banned),
          `description ${JSON.stringify(description)} must not contain ${banned}`,
        );
      }
    }
  });

  it("exposes no argv or full-command field on any result type", () => {
    const probe = fakeProbe([
      candidate({ pid: 901, argv: ["/usr/bin/hermes", "serve"], openPaths: [storePath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);
    const holder = detection.holders[0];

    assert.deepEqual(Object.keys(holder).sort(), [
      "commandDescription",
      "pid",
      "startIdentity",
      "storePaths",
    ]);
    assert.ok(!("argv" in holder));
    assert.ok(!("command" in holder));
    assert.ok(!("rawArgv" in holder));
    assert.deepEqual(Object.keys(detection).sort(), [
      "holders",
      "observationComplete",
      "probeFailures",
    ]);
    assert.ok(!JSON.stringify(detection).includes("argv"));
  });
});

// ---------------------------------------------------------------------------
// probe failure semantics
// ---------------------------------------------------------------------------

describe("store-holder-detect: probe failures are recorded, never raised", () => {
  it("returns normally with observationComplete=false when the probe throws", () => {
    const detection = detectStoreHolders(
      [store],
      throwingProbe(new Error("procfs unavailable")),
    );

    assert.equal(detection.observationComplete, false);
    assert.deepEqual(detection.holders, []);
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "holder-probe");
    assert.match(detection.probeFailures[0].reason, /procfs unavailable/);
    assert.deepEqual(Object.keys(detection).sort(), [
      "holders",
      "observationComplete",
      "probeFailures",
    ]);
    for (const forbidden of ["verdict", "refusal", "lease", "ownership", "reasonCode"]) {
      assert.ok(!(forbidden in detection));
    }
  });

  it("keeps a non-Error throw textual and bounded", () => {
    const detection = detectStoreHolders([store], throwingProbe("boom"));

    assert.equal(detection.observationComplete, false);
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "holder-probe");
    assert.equal(detection.probeFailures[0].reason, "boom");
  });

  it("stringifies every non-Error throw shape safely", () => {
    const cases: Array<[unknown, string]> = [
      ["boom", "boom"],
      [null, "null"],
      [undefined, "undefined"],
      [{ code: 7 }, "[object Object]"],
      [42, "42"],
    ];

    for (const [thrown, expected] of cases) {
      const detection = detectStoreHolders([store], throwingProbe(thrown));

      assert.equal(detection.observationComplete, false);
      assert.equal(detection.probeFailures.length, 1);
      assert.equal(detection.probeFailures[0].scope, "holder-probe");
      assert.equal(detection.probeFailures[0].reason, expected);
    }
  });

  it("records an unreadable open path as a pid-scoped failure and fabricates no holder", () => {
    const probe = fakeProbe([
      candidate({ pid: 321, openPaths: [loopPath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.equal(detection.observationComplete, false);
    assert.deepEqual(detection.holders, []);
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "pid:321");
    assert.match(detection.probeFailures[0].reason, /^open path unreadable: /);
    assert.ok(detection.probeFailures[0].reason.includes(loopPath));
  });

  it("records EACCES and EPERM open-path stats, while ENOENT stays silent", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const probe = fakeProbe([candidate({ pid: 322, openPaths: [storePath] })]);

      const detection = withStatFailure(storePath, code, () =>
        detectStoreHolders([store], probe.deps),
      );

      assert.equal(detection.observationComplete, false, `${code} must be recorded`);
      assert.deepEqual(detection.holders, [], `${code} must not fabricate a holder`);
      assert.equal(detection.probeFailures.length, 1);
      assert.equal(detection.probeFailures[0].scope, "pid:322");
      assert.match(detection.probeFailures[0].reason, /^open path unreadable: /);
    }

    // The same injection is active, but a path that really does not exist is
    // ENOENT and stays silent: the file being gone is not a probe failure.
    const vanished = path.join(root, "vanished-under-injection.db");
    const probe = fakeProbe([candidate({ pid: 323, openPaths: [vanished] })]);

    const silent = withStatFailure(storePath, "EACCES", () =>
      detectStoreHolders([store], probe.deps),
    );

    assert.equal(silent.observationComplete, true);
    assert.deepEqual(silent.probeFailures, []);
  });

  it("records a malformed (non-list) probe result instead of reading it as no holders", () => {
    const deps: HolderProbeDeps = {
      listOpenFileHolders(): HolderCandidate[] {
        return undefined as unknown as HolderCandidate[];
      },
    };

    const detection = detectStoreHolders([store], deps);

    assert.equal(detection.observationComplete, false);
    assert.deepEqual(detection.holders, []);
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "holder-probe");
  });
});

// ---------------------------------------------------------------------------
// typed probe failures (US-004)
// ---------------------------------------------------------------------------

describe("store-holder-detect: typed probe failures carry scope and partial evidence", () => {
  it("exposes HolderProbeError with a scope and optional partial candidates", () => {
    const partial = [candidate({ pid: 1 })];

    const withoutPartial = new HolderProbeError("pid:1", "boom");
    assert.ok(withoutPartial instanceof Error);
    assert.equal(withoutPartial.name, "HolderProbeError");
    assert.equal(withoutPartial.scope, "pid:1");
    assert.equal(withoutPartial.message, "boom");
    assert.equal(withoutPartial.partialCandidates, undefined);

    const withPartial = new HolderProbeError("lsof:timeout", "timed out", partial);
    assert.equal(withPartial.scope, "lsof:timeout");
    assert.deepEqual(withPartial.partialCandidates, partial);
  });

  it("records the thrown scope and still lists the partial candidates", () => {
    const partial = candidate({ pid: 123, openPaths: [storePath] });

    const detection = detectStoreHolders(
      [store],
      throwingProbe(new HolderProbeError("pid:123", "cannot read the fd directory of pid 123", [partial])),
    );

    assert.equal(detection.observationComplete, false);
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "pid:123");
    assert.match(detection.probeFailures[0].reason, /cannot read the fd directory of pid 123/);
    assert.equal(detection.holders.length, 1);
    assert.equal(detection.holders[0].pid, 123);
    assert.deepEqual(detection.holders[0].storePaths, [storePath]);
  });

  it("aggregates partial candidates exactly like a completed probe would", () => {
    // Aggregation outranks short-circuiting: a probe that failed late still
    // contributes everything it observed, including a merged duplicate
    // observation and a holder of a second store.
    const partial = [
      candidate({
        pid: 77,
        startIdentity: "v2:77:1",
        argv: ["/usr/bin/node", "a"],
        openPaths: [storePath],
      }),
      candidate({
        pid: 77,
        startIdentity: "v2:77:1",
        argv: ["/bin/bash", "b"],
        openPaths: [sameBasenamePath],
      }),
      candidate({ pid: 78, startIdentity: "v2:78:1", openPaths: [walPath] }),
    ];

    const detection = detectStoreHolders(
      [store, secondStore],
      throwingProbe(new HolderProbeError("lsof:probe", "lsof exited 2: partial output", partial)),
    );

    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "lsof:probe");
    assert.deepEqual(
      detection.holders.map((holder) => holder.pid),
      [77, 78],
    );
    // 'aaa' sorts before 'main' in UTF-8 byte order, and the byte-smallest
    // description wins the merge, exactly as for a complete probe.
    assert.deepEqual(detection.holders[0].storePaths, [sameBasenamePath, storePath]);
    assert.equal(detection.holders[0].commandDescription, "bash b");
    assert.deepEqual(detection.holders[1].storePaths, [storePath]);
  });

  it("ignores a non-list partialCandidates payload instead of throwing", () => {
    const broken = new HolderProbeError("pid:5", "boom");
    (broken as unknown as { partialCandidates: unknown }).partialCandidates = "not a list";

    const detection = detectStoreHolders([store], throwingProbe(broken));

    assert.equal(detection.observationComplete, false);
    assert.deepEqual(detection.holders, []);
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "pid:5");
  });

  it("redacts credential-shaped thrown messages in the recorded reason", () => {
    const detection = detectStoreHolders(
      [store],
      throwingProbe(
        new HolderProbeError(
          "pid:123",
          "probe failed token=SECRET7 key=SECRET8 password=SECRET9",
        ),
      ),
    );

    const reason = detection.probeFailures[0].reason;
    for (const secret of ["SECRET7", "SECRET8", "SECRET9"]) {
      assert.ok(!reason.includes(secret), `secret ${secret} must be absent from the reason`);
    }
    assert.ok(reason.includes("token=[redacted]"));
    assert.ok(reason.includes("key=[redacted]"));
    assert.ok(reason.includes("password=[redacted]"));
  });

  it("strips control characters and caps a long thrown message at 240 characters", () => {
    const long = "y".repeat(400);

    const detection = detectStoreHolders(
      [store],
      throwingProbe(new HolderProbeError("pid:9", `line\nbreak\u0000${long}`)),
    );

    const reason = detection.probeFailures[0].reason;
    assert.equal(reason.length, 240);
    assert.ok(reason.endsWith("..."));
    assert.ok(!/[\u0000-\u001f\u007f]/.test(reason));
  });

  it("sorts probeFailures by scope then reason, independent of candidate order", () => {
    const observations = [
      candidate({ pid: 300, openPaths: [loopPath, loopPath2] }),
      candidate({ pid: 100, openPaths: [loopPath2] }),
      {
        pid: 400,
        startIdentity: "v2:400:1",
        argv: [],
        openPaths: "not-a-list",
      } as unknown as HolderCandidate,
    ];

    const forward = detectStoreHolders([store], fakeProbe(observations).deps);
    const reversed = detectStoreHolders(
      [store],
      fakeProbe([...observations].reverse()).deps,
    );

    assert.deepEqual(reversed.probeFailures, forward.probeFailures);
    assert.deepEqual(
      forward.probeFailures.map((failure) => failure.scope),
      ["holder-probe", "pid:100", "pid:300", "pid:300"],
    );

    const sameScope = forward.probeFailures
      .filter((failure) => failure.scope === "pid:300")
      .map((failure) => failure.reason);
    assert.deepEqual([...sameScope].sort(), sameScope);
    assert.ok(sameScope[0].includes("loop.db"));
    assert.ok(sameScope[1].includes("loop2.db"));
    assert.equal(forward.observationComplete, false);
  });
});

// ---------------------------------------------------------------------------
// aggregation and determinism
// ---------------------------------------------------------------------------

describe("store-holder-detect: aggregation and deterministic ordering", () => {
  it("orders holders by pid, then by startIdentity in UTF-8 byte order", () => {
    const probe = fakeProbe([
      candidate({ pid: 200, startIdentity: "v2:200:1000", openPaths: [storePath] }),
      candidate({ pid: 100, startIdentity: "v2:100:1000", openPaths: [storePath] }),
      candidate({ pid: 100, startIdentity: "v2:100:0001", openPaths: [storePath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(
      detection.holders.map((holder) => [holder.pid, holder.startIdentity]),
      [
        [100, "v2:100:0001"],
        [100, "v2:100:1000"],
        [200, "v2:200:1000"],
      ],
    );
  });

  it("merges duplicate pid+startIdentity observations into one holder with the union of stores", () => {
    const probe = fakeProbe([
      candidate({ pid: 55, openPaths: [storePath] }),
      candidate({ pid: 55, openPaths: [sameBasenamePath] }),
    ]);

    const detection = detectStoreHolders([store, secondStore], probe.deps);

    assert.equal(detection.holders.length, 1);
    // 'aaa' sorts before 'main' in UTF-8 byte order, regardless of input order.
    assert.deepEqual(detection.holders[0].storePaths, [
      sameBasenamePath,
      storePath,
    ]);
  });

  it("keeps a merged holder identical when duplicate observations carry different argv", () => {
    // The same process can surface once per open file, and a later story adds
    // argument text to the description: picking the first observation would
    // make the result depend on candidate order. The byte-smallest of the
    // sanitized descriptions is kept instead.
    const observations = [
      candidate({ pid: 54, startIdentity: "v2:54:1", argv: ["/usr/bin/node", "a"], openPaths: [storePath] }),
      candidate({ pid: 54, startIdentity: "v2:54:1", argv: ["/bin/bash", "b"], openPaths: [sameBasenamePath] }),
    ];

    const forward = detectStoreHolders([store, secondStore], fakeProbe(observations).deps);
    const reversed = detectStoreHolders(
      [secondStore, store],
      fakeProbe([...observations].reverse()).deps,
    );

    assert.deepEqual(reversed, forward);
    assert.equal(forward.holders.length, 1);
    assert.equal(forward.holders[0].commandDescription, "bash b");
    assert.deepEqual(forward.holders[0].storePaths, [sameBasenamePath, storePath]);
  });

  it("lists both stores when one process holds two of them", () => {
    const probe = fakeProbe([
      candidate({ pid: 56, openPaths: [storePath, sameBasenamePath] }),
    ]);

    const detection = detectStoreHolders([store, secondStore], probe.deps);

    assert.equal(detection.holders.length, 1);
    assert.deepEqual(detection.holders[0].storePaths, [
      sameBasenamePath,
      storePath,
    ]);
  });

  it("does not duplicate a canonicalPath for duplicate store entries with the same (dev, ino)", () => {
    // The identical store entry appears twice, plus a hardlink ALIAS entry with
    // the same (dev, ino) and a different canonicalPath. Identity dedupe must
    // not duplicate a canonicalPath, and it must not collapse the alias either:
    // GATE-IMPLEMENTATION-SPEC.md section 5 requires aliases to be retained.
    const aliasStore = identityOf(hardlinkPath);
    const probe = fakeProbe([candidate({ pid: 57, openPaths: [storePath] })]);

    const detection = detectStoreHolders([store, { ...store }, aliasStore], probe.deps);

    assert.equal(detection.holders.length, 1);
    assert.deepEqual(detection.holders[0].storePaths, [hardlinkPath, storePath]);
    assert.equal(detection.holders[0].storePaths.filter((p) => p === storePath).length, 1);
  });

  it("reports a complete observation of zero holders for a non-empty store list", () => {
    const probe = fakeProbe([]);

    const detection = detectStoreHolders([store], probe.deps);

    assert.deepEqual(detection, {
      observationComplete: true,
      holders: [],
      probeFailures: [],
    });
    assert.equal(probe.calls.length, 1);
  });

  it("sets observationComplete from probeFailures while still listing matched holders", () => {
    const probe = fakeProbe([
      candidate({ pid: 58, openPaths: [storePath, loopPath] }),
    ]);

    const detection = detectStoreHolders([store], probe.deps);
    const expectedComplete = detection.probeFailures.length === 0;

    assert.equal(detection.holders.length, 1);
    assert.equal(detection.holders[0].pid, 58);
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.observationComplete, false);
    assert.equal(detection.observationComplete, expectedComplete);
  });

  it("is deterministic under permuted store and candidate order", () => {
    const candidates = [
      candidate({ pid: 200, startIdentity: "v2:200:1000", openPaths: [storePath] }),
      candidate({ pid: 100, startIdentity: "v2:100:1000", openPaths: [sameBasenamePath] }),
      candidate({ pid: 300, startIdentity: "v2:300:1000", argv: ["/bin/sh", "-c", "x"], openPaths: [walPath] }),
    ];

    const forward = detectStoreHolders(
      [store, secondStore],
      fakeProbe(candidates).deps,
    );
    const permuted = detectStoreHolders(
      [secondStore, store],
      fakeProbe([...candidates].reverse()).deps,
    );

    assert.deepEqual(permuted, forward);
  });
});

// ---------------------------------------------------------------------------
// module purity and classification
// ---------------------------------------------------------------------------

describe("store-holder-detect: module purity and classification", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf-8");

  it("imports only node:fs and node:path", () => {
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s+[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );

    assert.deepEqual(specifiers.sort(), ["node:fs", "node:path"]);
  });

  it("references no database driver, no spawn, no clock, no randomness and no environment", () => {
    // Built by concatenation so this test file itself stays free of the tokens
    // a future scanner could mistake for real usage.
    const forbidden = [
      "node:" + "sqlite",
      "sqlite" + "3",
      "Database" + "Sync",
      "child" + "_process",
      "spawn" + "Sync",
      "exec" + "File",
      "Ma" + "th.random",
      "process" + ".env",
      "Da" + "te",
    ];
    for (const token of forbidden) {
      assert.ok(
        !source.includes(token),
        `store-holder-detect.ts must not reference the forbidden token ${JSON.stringify(token)}`,
      );
    }
  });

  it("exports detectStoreHolders and the typed HolderProbeError, nothing else executable", () => {
    assert.deepEqual(Object.keys(holderModule).sort(), [
      "HolderProbeError",
      "detectStoreHolders",
    ]);
  });

  it("exports no function whose name suggests a refusal, verdict or lease", () => {
    // Holder detection is informational: there is no decision surface here.
    const banned = ["refuse", "verdict", "lease"];
    const exportedFunctions = [
      ...new Set([
        ...Object.keys(holderModule),
        ...[...source.matchAll(/^export\s+function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
      ]),
    ];

    for (const name of exportedFunctions) {
      const lowered = name.toLowerCase();
      for (const word of banned) {
        assert.ok(
          !lowered.includes(word),
          `export ${name} must not look like a ${word} decision`,
        );
      }
    }
  });

  it("returns a result with exactly the three informational keys", () => {
    const detection = detectStoreHolders([store], fakeProbe([]).deps);

    assert.deepEqual(Object.keys(detection).sort(), [
      "holders",
      "observationComplete",
      "probeFailures",
    ]);
    for (const forbidden of ["verdict", "refusal", "lease", "ownership", "reasonCode"]) {
      assert.ok(!(forbidden in detection));
    }
  });

  it("is not listed in tests/serial-files.txt (parallel lane, no spawns)", () => {
    const ownRelativePath = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));
    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    assert.ok(
      !serialEntries.includes(ownRelativePath),
      `this parallel test file (${ownRelativePath}) must NOT be in tests/serial-files.txt`,
    );
  });

  it("keeps the runner's test in the SERIAL lane (the spawn-capable side)", () => {
    // The pure module and this test are parallel-lane; the default runner
    // imports proc-info/lsof-probe (spawn-capable) and its test must carry the
    // serial classification instead. Pinning both sides here makes a future
    // refactor that moves spawning into this module fail loudly.
    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    const runnerTestRelative = "src/installer/matchlock/store-holder-detect-runner.test.ts";
    assert.ok(
      serialEntries.includes(runnerTestRelative),
      `${runnerTestRelative} must be listed in tests/serial-files.txt`,
    );
  });
});
