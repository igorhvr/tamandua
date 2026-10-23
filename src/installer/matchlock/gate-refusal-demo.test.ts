/**
 * Executable launch-gate refusal demo (G9 EXIT-CODE-AND-REMEDIES, US-005).
 *
 * WHAT IS PROVEN HERE. A checked-in demo program
 * (`tests/fixtures/gate-refusal-demo.mjs`) is started as a REAL child process
 * against a REAL disposable profile. The demo composes the gate's real modules
 * — `observeStore` -> `adaptStoreObservation` -> `evaluateGate` ->
 * `detectStoreHolders` -> `renderGateRemedyText` -> `exitCodeForGateOutcome` —
 * writes the generated remedy to stderr and exits with the gate's status.
 * This file asserts that status is 78 for an unconverted profile, that the
 * remedy names the failing store and both reason codes, and that the control
 * profile (a converted store) exits 0. Exit 78 is therefore a verdict-derived
 * decision, not a hard-coded status.
 *
 * SCOPE, STATED HONESTLY. This is verdict-to-exit propagation at the MODULE
 * boundary. The interactive wiring (`tamandua matchlock pi|hermes`, the swap
 * surface and the scheduled dispatcher) is G8's story and does not exist yet,
 * so an end-to-end interactive-CLI refusal is neither driven nor claimed here.
 *
 * THE PROFILE IS DISPOSABLE AND NEVER THE OPERATOR HOME. Each run gets a fresh
 * home from `tamanduaShortTempDir` (a real `/tmp` directory, so the matchlock
 * `sun_path` budget is never a factor), and the store is a genuine SQLite file
 * written with `node:sqlite`: `PRAGMA journal_mode = WAL`, a table and a row,
 * then close. `observeStore` therefore sees a real write-ahead-log header
 * `(2, 2)` with the SQLite magic — a genuinely unconverted store, not a fake
 * tuple. The demo reads no HOME and writes nothing; this file asserts the
 * profile tree is byte-for-byte the two files it created and that the fixture
 * source contains no write API, no `child_process` import and no spawn call, so
 * the demo can create no VM and its only node process is the one started here.
 *
 * SERIAL LANE. This file spawns a child process, so it MUST be listed in
 * `tests/serial-files.txt`; the last two tests assert the classification and
 * the membership themselves (`classifyTestFile` reports at least one reason,
 * the relative path is listed) and assert the pure gate tests
 * (`gate-exit-code.test.ts`, `gate-remedy-text.test.ts`) are NOT listed.
 *
 * The modules are imported from `dist/`, following this directory's
 * convention: `npm run build` must run before `node --test`.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { observeStore } from "../../../dist/installer/matchlock/store-header.js";
import { cleanChildEnv } from "../../../tests/helpers/test-env.ts";
import { classifyTestFile } from "../../../tests/helpers/serial-classification.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "fixtures", "gate-refusal-demo.mjs");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");
const THIS_FILE = path.join(HERE, "gate-refusal-demo.test.ts");
const THIS_RELATIVE = path
  .relative(REPO_ROOT, THIS_FILE)
  .split(path.sep)
  .join("/");

/** The relaunch command the demo renders verbatim into its remedy. */
const RELAUNCH_COMMAND = "tamandua matchlock hermes --profile demo";

/** Reused across the suite: each run reuses its own disposable home. */
const ROOT = tamanduaShortTempDir("gate-refusal-demo-");
const REFUSAL_HOME = path.join(ROOT, "home-wal");
const ALLOW_HOME = path.join(ROOT, "home-delete");
const REFUSAL_STORE = path.join(REFUSAL_HOME, ".hermes", "main.db");
const REFUSAL_CONFIG = path.join(REFUSAL_HOME, ".hermes", "config.yaml");
const ALLOW_STORE = path.join(ALLOW_HOME, ".hermes", "main.db");
const ALLOW_CONFIG = path.join(ALLOW_HOME, ".hermes", "config.yaml");

interface DemoRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Write a REAL SQLite store in the requested journal mode, then close it. */
function writeStore(storePath: string, journalMode: "wal" | "delete"): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const db = new DatabaseSync(storePath);
  try {
    const applied = db
      .prepare(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
      .get() as { journal_mode?: unknown } | undefined;
    assert.equal(
      String(applied?.journal_mode ?? "").toLowerCase(),
      journalMode,
      "the SQLite writer must honour the requested journal mode",
    );
    db.exec("CREATE TABLE demo_rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    db.exec("INSERT INTO demo_rows (body) VALUES ('disposable gate refusal row')");
    if (journalMode === "wal") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/** Write the guest-visible config the demo cross-checks its argument against. */
function writeConfig(configPath: string, journalMode: "wal" | "delete"): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `database:\n  journal_mode: ${journalMode}\n`, "utf8");
}

/** Sorted repo-relative listing of everything under a directory. */
function listTree(root: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join("/"))
    .sort();
}

/** Run the fixture with the given disposable home and arguments. */
function runDemo(home: string, args: string[]): Promise<DemoRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_PATH, ...args], {
      cwd: home,
      env: cleanChildEnv({ HOME: home, TAMANDUA_TEST_GUARD: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

/** The four arguments every run supplies, varying only the store/config/mode. */
function demoArgs(storePath: string, configPath: string, mode: "wal" | "delete"): string[] {
  return [
    "--store",
    storePath,
    "--config",
    configPath,
    "--journal-mode",
    mode,
    "--relaunch",
    RELAUNCH_COMMAND,
  ];
}

let refusalRun: DemoRun;
let allowRun: DemoRun;
let mismatchRun: DemoRun;

before(async () => {
  writeStore(REFUSAL_STORE, "wal");
  writeConfig(REFUSAL_CONFIG, "wal");
  writeStore(ALLOW_STORE, "delete");
  writeConfig(ALLOW_CONFIG, "delete");

  refusalRun = await runDemo(REFUSAL_HOME, demoArgs(REFUSAL_STORE, REFUSAL_CONFIG, "wal"));
  allowRun = await runDemo(ALLOW_HOME, demoArgs(ALLOW_STORE, ALLOW_CONFIG, "delete"));
  // The demo must validate its --journal-mode claim against the config it is
  // told the guest reads; a decorative flag would let a mismatch slip through.
  mismatchRun = await runDemo(
    REFUSAL_HOME,
    demoArgs(REFUSAL_STORE, REFUSAL_CONFIG, "delete"),
  );
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("gate refusal demo: real store, real gate modules, real exit status", () => {
  it("observes a genuinely unconverted store with the WAL header pair (2, 2)", () => {
    const observation = observeStore(REFUSAL_STORE);

    assert.equal(observation.exists, true);
    assert.equal(observation.readable, true);
    assert.equal(observation.magicOk, true, "the store is a real SQLite database");
    assert.equal(observation.headerFormat, "wal");
    assert.deepEqual(observation.rawBytes1819, [2, 2]);
    assert.deepEqual(observation.sidecars, {
      wal: "absent",
      shm: "absent",
      journal: "absent",
    });
  });

  it("refuses the unconverted profile with exit status 78", () => {
    assert.equal(refusalRun.signal, null, refusalRun.stderr);
    assert.equal(refusalRun.status, 78, refusalRun.stderr);
    assert.notEqual(refusalRun.status, 0);
    assert.notEqual(refusalRun.status, 1);
  });

  it("writes the generated per-store remedy to stderr", () => {
    const stderr = refusalRun.stderr;

    assert.ok(stderr.includes("Matchlock launch refused"), stderr);
    assert.ok(stderr.includes("MATCHLOCK LAUNCH GATE: LAUNCH REFUSED"), stderr);
    assert.ok(stderr.includes(`STORE 1/1: ${REFUSAL_STORE}`), stderr);
    assert.ok(stderr.includes("codes: not-delete-config, wal-header"), stderr);
    assert.ok(stderr.includes("finding [not-delete-config]"), stderr);
    assert.ok(stderr.includes("finding [wal-header]"), stderr);

    // The guest-visible config instruction names the path the demo was given.
    assert.ok(
      stderr.includes(`configuration the GUEST reads (${REFUSAL_CONFIG})`),
      stderr,
    );

    // Both conversions are present, each naming the real store path.
    assert.ok(
      stderr.includes(`hermes sessions set-journal-mode delete --db ${REFUSAL_STORE}`),
      stderr,
    );
    assert.ok(
      stderr.includes(`hermes sessions set-journal-mode wal --db ${REFUSAL_STORE}`),
      stderr,
    );

    // The operator can copy the caller's own relaunch command out of the text.
    assert.ok(stderr.includes(`Relaunch: ${RELAUNCH_COMMAND}`), stderr);

    // An empty injected holder probe is informational, never a finding.
    assert.ok(stderr.includes("HOLDER PROBE (informational)"), stderr);
    assert.ok(stderr.includes("observation complete: yes"), stderr);
  });

  it("keeps the remedy off stdout", () => {
    assert.equal(refusalRun.stdout, "", refusalRun.stdout);
  });

  it("contains no pattern-kill vocabulary", () => {
    assert.ok(!/pkill|killall/i.test(refusalRun.stderr), refusalRun.stderr);
  });

  it("writes nothing: the disposable profile is exactly the two seeded files", () => {
    assert.deepEqual(listTree(REFUSAL_HOME), [
      ".hermes",
      ".hermes/config.yaml",
      ".hermes/main.db",
    ]);
    // No sidecars, no state dir, no matchlock state: the demo only reads.
    assert.ok(!fs.existsSync(`${REFUSAL_STORE}-wal`));
    assert.ok(!fs.existsSync(`${REFUSAL_STORE}-shm`));
    assert.ok(!fs.existsSync(`${REFUSAL_STORE}-journal`));
    assert.ok(!fs.existsSync(path.join(REFUSAL_HOME, ".tamandua")));
    assert.ok(!fs.existsSync(path.join(REFUSAL_HOME, ".matchlock")));
  });

  it("creates no VM and spawns no child of its own", () => {
    const source = fs.readFileSync(FIXTURE_PATH, "utf8");

    // A VM cannot be created without spawning matchlock; the fixture imports
    // no child_process and contains no process-creation call at all. The
    // lookbehind keeps RegExp.prototype.exec (`re.exec(...)`) out of the scan.
    assert.ok(!source.includes("node:child_process"), source);
    assert.ok(
      !/(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/.test(
        source,
      ),
      source,
    );
    assert.ok(!/\bmatchlock\s+(?:create|rm|rpc|vm)\b/.test(source), source);

    // It also reads no HOME: the disposable profile is handed to it explicitly.
    assert.ok(!/process\.env\.HOME|os\.homedir|homedir\s*\(/.test(source), source);

    // And it writes nothing: only read/stat calls are present.
    assert.ok(
      !/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|unlinkSync|renameSync|copyFileSync|createWriteStream|openSync)\s*\(/.test(
        source,
      ),
      source,
    );

    // The only runtime imports are the filesystem and path; the gate modules
    // are loaded dynamically from the already-built dist tree.
    const runtimeImports = [...source.matchAll(/^import\s+.*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(runtimeImports, ["node:fs", "node:path"]);

    const gateModules = [...source.matchAll(/new URL\("([^"]+)",\s*DIST\)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(gateModules.sort(), [
      "gate-exit-code.js",
      "gate-remedy-text.js",
      "launch-gate.js",
      "store-header.js",
      "store-holder-detect.js",
      "store-observation-adapter.js",
    ]);
  });

  it("allows the converted control profile with status 0", () => {
    assert.equal(allowRun.status, 0, allowRun.stderr);
    assert.equal(allowRun.stdout, "");
    assert.ok(allowRun.stderr.includes("Matchlock launch allowed"), allowRun.stderr);
    assert.ok(
      allowRun.stderr.includes("MATCHLOCK LAUNCH GATE: LAUNCH ALLOWED"),
      allowRun.stderr,
    );
    assert.ok(allowRun.stderr.includes("findings: 0"), allowRun.stderr);
    assert.ok(!allowRun.stderr.includes("LAUNCH REFUSED"), allowRun.stderr);
  });

  it("rejects a --journal-mode that disagrees with the guest config", () => {
    assert.equal(mismatchRun.status, 3, mismatchRun.stderr);
    assert.ok(
      mismatchRun.stderr.includes("disagrees with the journal_mode"),
      mismatchRun.stderr,
    );
  });
});

describe("gate refusal demo: lane classification", () => {
  it("is classified in the serial lane and listed there", () => {
    const reasons = classifyTestFile(THIS_FILE, REPO_ROOT);
    assert.ok(reasons.length > 0, "a spawning test must classify as serial");
    assert.ok(
      reasons.includes("imports node:child_process"),
      reasons.join("; "),
    );

    const entries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    assert.ok(
      entries.includes(THIS_RELATIVE),
      `${THIS_RELATIVE} must be listed in tests/serial-files.txt (it spawns a child process)`,
    );
  });

  it("keeps the pure launch-gate tests in the parallel lane", () => {
    const entries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const relative of [
      "src/installer/matchlock/gate-exit-code.test.ts",
      "src/installer/matchlock/gate-remedy-text.test.ts",
    ]) {
      assert.ok(
        !entries.includes(relative),
        `${relative} is a pure test and must not be listed in tests/serial-files.txt`,
      );
    }
  });
});
