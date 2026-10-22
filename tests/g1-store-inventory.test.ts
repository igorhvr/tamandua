/**
 * G1 store-control discovery — US-003 store-inventory contract.
 *
 * Pins the written inventory and the executable probe:
 *   - the Store Inventory section names every observed store, its trigger, its
 *     created-on-fresh-home status, its required/optional hypothesis, and its
 *     canonical-vs-raw opener path;
 *   - it reconciles the derived superset with the supplied live measurement
 *     without opening the real operator home;
 *   - the strace evidence shows scratch-home store opens and zero real-home
 *     opens;
 *   - probe_store_inventory.sh exits 0 and attributes the three named stores
 *     (plus the observed projects store) to a trigger.
 *
 * The runtime assertion spawns hermes, so this file belongs in the serial lane.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "docs", "gate"))) return cwd;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
})();

const GATE_DIR = path.join(PROJECT_ROOT, "docs", "gate");
const DOC_PATH = path.join(GATE_DIR, "G1-STORE-CONTROL-DISCOVERY.md");
const PROBES_DIR = path.join(GATE_DIR, "probes");
const EVIDENCE_DIR = path.join(GATE_DIR, "evidence");
const PROBE_PATH = path.join(PROBES_DIR, "probe_store_inventory.sh");
const INVENTORY_EVIDENCE = path.join(EVIDENCE_DIR, "store-inventory.txt");

const HERMES_SRC = "/home/kaladin/hermes-agent";
const HERMES_PYTHON = path.join(HERMES_SRC, "venv", "bin", "python");

const scratchRoots: string[] = [];
after(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const hermesAvailable =
  fs.existsSync(HERMES_PYTHON) && fs.existsSync(path.join(HERMES_SRC, "hermes_state.py"));

function readDoc(): string {
  return fs.readFileSync(DOC_PATH, "utf-8");
}

function inventorySection(doc: string): string {
  const start = doc.indexOf("## Store Inventory");
  const end = doc.indexOf("\n## Config Resolution", start);
  assert.ok(start >= 0, "document must contain a Store Inventory section");
  assert.ok(end > start, "Store Inventory must be followed by Config Resolution");
  return doc.slice(start, end);
}

describe("G1 US-003 store-inventory document", () => {
  it("has the required table columns and every observed store", () => {
    const section = inventorySection(readDoc());
    for (const column of [
      "Store (relative to `HERMES_HOME`)",
      "Trigger / opener",
      "Created on fresh home?",
      "Required-or-optional hypothesis",
      "Opener path",
      "Evidence",
    ]) {
      assert.ok(section.includes(column), `Store Inventory table must have a "${column}" column`);
    }
    for (const store of ["state.db", "verification_evidence.db", "kanban.db", "projects.db"]) {
      assert.ok(section.includes(store), `Store Inventory must cover ${store}`);
    }
  });

  it("records each store's trigger, including the negative/read-only cases", () => {
    const section = inventorySection(readDoc());
    for (const trigger of [
      "hermes doctor",
      "hermes sessions list",
      "hermes kanban list",
      "hermes project list",
      "hermes projects list",
      "hermes cron list",
      "SessionDB()` + `create_session()",
      "record_verify_run",
      "verify-on-stop",
    ]) {
      assert.ok(section.includes(trigger), `Store Inventory must record the ${trigger} trigger`);
    }
  });

  it("records the canonical opener path and the absence of raw WAL pragmas", () => {
    const section = inventorySection(readDoc());
    assert.match(section, /apply_wal_with_fallback/);
    assert.match(section, /canonical/);
    assert.match(section, /No production path issues a raw `PRAGMA journal_mode=WAL`/);
    assert.match(section, /open_db/);
  });

  it("reconciles the derived superset with the supplied live measurement", () => {
    const section = inventorySection(readDoc());
    assert.match(section, /6748 KB/);
    assert.match(section, /88 KB/);
    assert.match(section, /no `kanban\.db`|no kanban\.db/i);
    assert.match(section, /superset/i);
    assert.match(section, /feature-gated|lazily-created|lazy/i);
    assert.match(section, /never opened|not re-run|not opened/i);
  });

  it("cites at least two strace evidence logs", () => {
    const section = inventorySection(readDoc());
    const refs = section.match(/evidence\/store-open-[a-z-]+\.txt/g) ?? [];
    assert.ok(refs.length >= 2, `expected at least two strace references, found: ${refs.join(", ")}`);
    for (const name of ["store-open-kanban.txt", "store-open-project.txt"]) {
      assert.ok(section.includes(name), `Store Inventory must reference ${name}`);
    }
  });

  it("notes the kanban shared-root nuance and the corrected header offset", () => {
    const doc = readDoc();
    assert.match(doc, /kanban\.db[^\n]*shared|shared[^\n]*kanban/i);
    assert.match(doc, /offsets 18 and 19/);
    assert.match(doc, /offsets 18\/19/);
  });
});

describe("G1 US-003 store-inventory evidence", () => {
  it("saved inventory log shows every store and a passing summary", () => {
    assert.ok(fs.existsSync(INVENTORY_EVIDENCE), `inventory evidence must exist at ${INVENTORY_EVIDENCE}`);
    const log = fs.readFileSync(INVENTORY_EVIDENCE, "utf-8");
    for (const marker of [
      "hermes doctor",
      "hermes sessions list",
      "hermes kanban list",
      "hermes project list",
      "hermes cron list",
      "SessionDB created state.db",
      "record_verify_run returned: None",
      "record_verify_run returned id: 1",
      "RESULT: PASS",
    ]) {
      assert.ok(log.includes(marker), `inventory evidence must contain ${marker}`);
    }
    assert.match(log, /"mode": "wal"/);
    assert.doesNotMatch(log, /"mode": "unknown/);
  });

  it("every strace log records scratch-home opens and zero real-home opens", () => {
    const names = [
      "store-open-kanban.txt",
      "store-open-project.txt",
      "store-open-sessions.txt",
      "store-open-doctor.txt",
      "store-open-state-sessiondb.txt",
    ];
    for (const name of names) {
      const logPath = path.join(EVIDENCE_DIR, name);
      assert.ok(fs.existsSync(logPath), `strace evidence must exist at ${logPath}`);
      const log = fs.readFileSync(logPath, "utf-8");
      assert.match(log, /# real_operator_home_open_lines: 0/, `${name} must record zero real-home opens`);
      assert.match(log, /# scratch_home: /, `${name} must record the scratch home`);
      assert.match(log, /Real-operator-home opens \(must be empty\):\n\(none\)/, `${name} must prove no real-home opens`);
    }
  });

  it("at least two strace logs show scratch-home store opens", () => {
    const withStoreOpens = ["store-open-kanban.txt", "store-open-project.txt", "store-open-state-sessiondb.txt"];
    let matching = 0;
    for (const name of withStoreOpens) {
      const log = fs.readFileSync(path.join(EVIDENCE_DIR, name), "utf-8");
      if (/openat\([^\n]*\.db[^\n]*O_(RDWR|WRONLY|CREAT)/.test(log)) matching += 1;
    }
    assert.ok(matching >= 2, `expected at least two logs with store opens, got ${matching}`);
  });
});

describe("G1 US-003 store-inventory probe", () => {
  it("exists, is executable, and names every trigger and assertion", () => {
    assert.ok(fs.existsSync(PROBE_PATH), `probe must exist at ${PROBE_PATH}`);
    const stat = fs.statSync(PROBE_PATH);
    assert.ok((stat.mode & 0o111) !== 0, "probe must be executable");
    const source = fs.readFileSync(PROBE_PATH, "utf-8");
    for (const marker of [
      "hermes_scratch.sh",
      "read_header.py",
      "hermes doctor",
      "hermes sessions list",
      "hermes kanban list",
      "hermes project list",
      "hermes cron list",
      "SessionDB",
      "record_verify_run",
      "assert_exists",
      "assert_absent",
      "/home/kaladin/.hermes",
    ]) {
      assert.ok(source.includes(marker), `probe must reference ${marker}`);
    }
  });

  it(
    "exits 0 with every store attributable to a trigger",
    { skip: !hermesAvailable && "installed Hermes runtime is not present on this host" },
    () => {
      // HOME is a disposable directory and the probe overrides it again with
      // its own scratch root; the explicit env keeps live daemon routing out of
      // the child and gives the shell a minimal PATH.
      const home = tamanduaTempDir("g1-inventory-test-");
      scratchRoots.push(home);
      const result = spawnSync("/bin/bash", [PROBE_PATH], {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 600_000,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          HERMES_SRC,
        },
      });
      assert.equal(
        result.status,
        0,
        `inventory probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /RESULT: PASS/);
      for (const marker of [
        "ASSERT PASS: SessionDB() direct writer exists",
        "ASSERT PASS: hermes sessions list (read-only) did not create",
        "ASSERT PASS: record_verify_run with verify-on-stop OFF did not create",
        "ASSERT PASS: record_verify_run with verify-on-stop ON exists",
        "ASSERT PASS: hermes kanban list exists",
        "ASSERT PASS: hermes project list exists",
      ]) {
        assert.ok(result.stdout.includes(marker), `probe stdout must contain ${marker}`);
      }
      assert.doesNotMatch(result.stdout, /ASSERT FAIL/);
    },
  );
});
