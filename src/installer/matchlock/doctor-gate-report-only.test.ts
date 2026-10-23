/**
 * G7 DOCTOR-GATE US-004 — the report-only proof for the doctor launch gate.
 *
 * `runLaunchGateChecks` renders the Matchlock hermes launch verdict inside
 * `tamandua doctor`. Doctor is a DIAGNOSTIC, so it must not have side effects:
 * it must not convert a store, write a receipt, write configuration, create a
 * VM or even load a database driver. These tests prove that against disposable
 * temp-HOME fixtures (never the operator home):
 *
 *  1. the observed bytes are untouched: `state.db` and `config.yaml` keep
 *     their sha256, size and mtimeMs across a check run;
 *  2. no artifact appears: an empty temp `TAMANDUA_STATE_DIR` stays empty, no
 *     receipt-named file is created and the temp HOME tree is unchanged;
 *  3. no SQLite driver is loaded: a child process that imports ONLY the
 *     compiled `doctor-gate.js` and runs the check reports no sqlite entry in
 *     `process.moduleLoadList`. A control child that DOES import
 *     `node:sqlite` proves the detector fires, so the assertion cannot pass
 *     vacuously (Node spells the entry `NativeModule sqlite` /
 *     `Internal Binding sqlite`, never the literal `node:sqlite`);
 *  4. a static import scan of `src/installer/matchlock/doctor-gate.ts` proves
 *     it imports none of `node:sqlite`/`DatabaseSync`, `./controller.js`,
 *     `./rpc-client.js`, `./vm-reaper.js` or `./gate-receipt.js`;
 *  5. no VM: a fake `MATCHLOCK`/OS home stays empty (no files or directories
 *     created) across a check run.
 *
 * Every check is a genuine evaluation (the converted fixture reports
 * `would allow`), so the "nothing happened" assertions are not the trivial
 * consequence of a no-op.
 *
 * This file imports `node:child_process`, so it is SPAWN-CAPABLE and is
 * registered in `tests/serial-files.txt`.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  LAUNCH_GATE_SUMMARY_CHECK_NAME,
  runLaunchGateChecks,
  type RunLaunchGateChecksOptions,
} from "../../../dist/installer/matchlock/doctor-gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SOURCE_PATH = path.join(HERE, "doctor-gate.ts");
const COMPILED_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "dist/installer/matchlock/doctor-gate.js"),
).href;

/** Every disposable path created by this file; removed in `after()`. */
const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a disposable directory under the short literal `/tmp` base. */
function freshDir(prefix: string): string {
  const dir = tamanduaShortTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

/** A complete 100-byte rollback-format SQLite header (bytes 18/19 = (1, 1)). */
function rollbackHeader(): Buffer {
  const header = Buffer.alloc(100);
  header.write("SQLite format 3\u0000", 0, "latin1");
  header[18] = 1;
  header[19] = 1;
  return header;
}

interface Fixture {
  /** Disposable temp HOME the profile lives under. */
  home: string;
  /** Effective hermes profile directory (`<home>/.hermes`). */
  profile: string;
  configPath: string;
  stateDbPath: string;
  /** Deterministic observation options: no managed layer, empty env. */
  options: RunLaunchGateChecksOptions;
}

/**
 * A converted disposable profile: `database.journal_mode: delete` plus a
 * rollback-format `state.db`. This is the ALLOW shape, so every check below
 * exercises a real verdict rather than a not-a-candidate short circuit.
 */
function createFixture(): Fixture {
  const home = freshDir("g7-dg-ro-home-");
  const profile = path.join(home, ".hermes");
  fs.mkdirSync(profile, { recursive: true });

  const configPath = path.join(profile, "config.yaml");
  fs.writeFileSync(configPath, "database:\n  journal_mode: delete\n", "utf8");

  const stateDbPath = path.join(profile, "state.db");
  fs.writeFileSync(stateDbPath, rollbackHeader());

  return {
    home,
    profile,
    configPath,
    stateDbPath,
    options: {
      homeDir: home,
      cwd: profile,
      hermesHomeEnv: profile,
      env: {},
      managedDir: null,
    },
  };
}

/** sha256 + size + mtimeMs of one file, the full "unchanged" observation. */
function fileSnapshot(filePath: string): {
  sha256: string;
  size: number;
  mtimeMs: number;
} {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Recursive listing of a tree as sorted relative entries. Directories carry a
 * trailing `/`, so a created empty directory is still observable.
 */
function listTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      entries.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, "");
  return entries;
}

/** Run `body` with `process.env[key]` temporarily set to `value`. */
function withEnv(key: string, value: string, body: () => void): void {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    body();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

/**
 * The child environment used by the spawn-capable assertions: a fresh HOME, an
 * explicit temp state dir and the test guard, and NOTHING inherited that could
 * point at a live instance (no `TAMANDUA_RUN_ID`, `TAMANDUA_STATE_DIR`,
 * `TAMANDUA_DAEMON_*` or worker markers from an enclosing run).
 */
function isolatedChildEnv(
  fixture: Fixture,
  stateDir: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: fixture.home,
    TAMANDUA_STATE_DIR: stateDir,
    TAMANDUA_TEST_GUARD: "1",
    NODE_NO_WARNINGS: "1",
    ...extra,
  };
}

/** Spawn a `--input-type=module` child and return its stdout as parsed JSON. */
function runChildJson(script: string, env: NodeJS.ProcessEnv): unknown {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(
    result.status,
    0,
    `child failed (status ${String(result.status)}): ${result.stderr ?? ""}`,
  );
  const stdout = (result.stdout ?? "").trim();
  assert.notEqual(stdout, "", `child produced no stdout: ${result.stderr ?? ""}`);
  return JSON.parse(stdout) as unknown;
}

/** Extract every module specifier the source imports (static/dynamic/require). */
function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s*["']([^"']+)["']/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

describe("doctor launch gate is report-only", () => {
  it("leaves state.db and config.yaml bytes, size and mtimeMs unchanged", () => {
    const fixture = createFixture();
    const before = {
      config: fileSnapshot(fixture.configPath),
      stateDb: fileSnapshot(fixture.stateDbPath),
    };

    const checks = runLaunchGateChecks(fixture.options);

    // The check really evaluated the profile: a converted fixture would allow.
    assert.equal(checks[0]?.name, LAUNCH_GATE_SUMMARY_CHECK_NAME);
    assert.equal(checks[0]?.status, "pass");

    assert.deepEqual(fileSnapshot(fixture.configPath), before.config);
    assert.deepEqual(fileSnapshot(fixture.stateDbPath), before.stateDb);

    // No observe-time sidecar appears next to the store either.
    assert.deepEqual(
      fs
        .readdirSync(fixture.profile)
        .filter((name) => /-(wal|shm|journal)$/.test(name)),
      [],
    );
  });

  it("writes no receipt or state artifact and leaves an empty TAMANDUA_STATE_DIR empty", () => {
    const fixture = createFixture();
    const stateDir = freshDir("g7-dg-ro-state-");
    const homeBefore = listTree(fixture.home);

    withEnv("TAMANDUA_STATE_DIR", stateDir, () => {
      const checks = runLaunchGateChecks(fixture.options);
      assert.equal(checks[0]?.status, "pass");
    });

    // An empty state dir stays empty: no receipt, no ledger, no "last checked".
    assert.deepEqual(fs.readdirSync(stateDir), []);

    // The temp HOME tree is byte-for-byte the same set of entries.
    const homeAfter = listTree(fixture.home);
    assert.deepEqual(homeAfter, homeBefore);
    assert.deepEqual(
      homeAfter.filter((entry) => /receipt/i.test(entry)),
      [],
      "a report-only check never writes a receipt",
    );

    // The fixture itself holds no JSON (config.yaml + state.db only), so any
    // JSON under the temp HOME would be an artifact the check created.
    const jsonFiles = homeAfter
      .filter((entry) => entry.endsWith(".json"))
      .filter((entry) => !entry.startsWith("state.db"));
    assert.deepEqual(jsonFiles, []);
  });

  it("never loads a SQLite driver in a process importing only doctor-gate", () => {
    const fixture = createFixture();
    const stateDir = freshDir("g7-dg-ro-state-");

    // Import ONLY the compiled doctor-gate module, run the check, then report
    // every sqlite entry Node recorded. Node's moduleLoadList spells a loaded
    // builtin as `NativeModule sqlite` / `Internal Binding sqlite` (never the
    // literal `node:sqlite`), so the detector must match the driver itself,
    // not a spelling that would be absent either way.
    const probeScript = [
      `import { runLaunchGateChecks } from ${JSON.stringify(COMPILED_MODULE_URL)};`,
      `const options = JSON.parse(process.env.G7_DOCTOR_GATE_OPTIONS ?? "{}");`,
      `const checks = runLaunchGateChecks(options);`,
      `const sqliteEntries = process.moduleLoadList.filter((entry) => /sqlite/i.test(entry));`,
      `process.stdout.write(JSON.stringify({`,
      `  checkCount: checks.length,`,
      `  summaryStatus: checks[0]?.status ?? null,`,
      `  sqliteEntries,`,
      `}));`,
    ].join("\n");

    const probe = runChildJson(probeScript, {
      ...isolatedChildEnv(fixture, stateDir),
      G7_DOCTOR_GATE_OPTIONS: JSON.stringify(fixture.options),
    }) as {
      checkCount: number;
      summaryStatus: string | null;
      sqliteEntries: string[];
    };

    // The child actually ran the check (so "no driver" is not a no-op claim).
    assert.ok(probe.checkCount > 0, "the child evaluated the launch gate");
    assert.equal(probe.summaryStatus, "pass");
    assert.deepEqual(probe.sqliteEntries, []);

    // Control: the same detector DOES see the driver when it is really loaded.
    // Without this, a broken/renamed moduleLoadList entry would let the
    // assertion above pass vacuously.
    const controlScript = [
      `let available = false;`,
      `try { await import("node:sqlite"); available = true; } catch {}`,
      `const sqliteEntries = process.moduleLoadList.filter((entry) => /sqlite/i.test(entry));`,
      `process.stdout.write(JSON.stringify({ available, sqliteEntries }));`,
    ].join("\n");

    const control = runChildJson(controlScript, isolatedChildEnv(fixture, stateDir)) as {
      available: boolean;
      sqliteEntries: string[];
    };
    if (control.available) {
      assert.ok(
        control.sqliteEntries.length > 0,
        "the detector must fire for a process that really loads node:sqlite",
      );
    }
  });

  it("imports no SQLite driver, controller, RPC client, VM reaper or receipt writer", () => {
    const source = fs.readFileSync(SOURCE_PATH, "utf8");
    assert.match(source, /export function runLaunchGateChecks/);

    const specifiers = importSpecifiers(source);
    assert.ok(specifiers.length > 0, "the scan found the module's imports");

    const forbiddenSpecifierPatterns: Array<{ label: string; re: RegExp }> = [
      { label: "node:sqlite", re: /^node:sqlite$/ },
      {
        label: "controller/rpc-client/vm-reaper/gate-receipt",
        re: /(^|\/)(controller|rpc-client|vm-reaper|gate-receipt)\.(js|ts)$/,
      },
    ];

    for (const specifier of specifiers) {
      for (const forbidden of forbiddenSpecifierPatterns) {
        assert.equal(
          forbidden.re.test(specifier),
          false,
          `doctor-gate.ts must not import ${forbidden.label} (found ${specifier})`,
        );
      }
    }

    // A driver can also be reached through a named binding; the module has no
    // such binding at all.
    assert.equal(source.includes("DatabaseSync"), false);
  });

  it("creates no VM assets under a fake MATCHLOCK/OS home", () => {
    const fixture = createFixture();
    const fakeOsHome = freshDir("g7-dg-ro-vmhome-");
    const fakeMatchlockHome = path.join(fakeOsHome, ".matchlock");
    fs.mkdirSync(fakeMatchlockHome, { recursive: true });
    const before = listTree(fakeOsHome);

    const previousHome = process.env.HOME;
    const previousMatchlockHome = process.env.MATCHLOCK_HOME;
    process.env.HOME = fakeOsHome;
    process.env.MATCHLOCK_HOME = fakeMatchlockHome;
    try {
      const checks = runLaunchGateChecks(fixture.options);
      assert.equal(checks[0]?.status, "pass");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousMatchlockHome === undefined) delete process.env.MATCHLOCK_HOME;
      else process.env.MATCHLOCK_HOME = previousMatchlockHome;
    }

    assert.deepEqual(listTree(fakeOsHome), before);
    assert.deepEqual(fs.readdirSync(fakeMatchlockHome), []);
  });
});
