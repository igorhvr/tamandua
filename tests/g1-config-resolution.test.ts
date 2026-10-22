/**
 * G1 store-control discovery — US-002 config-resolution contract.
 *
 * Pins both the written finding and the executable probe:
 *   - the document's Config Resolution table names every scenario, path,
 *     realpath, raw/managed/resolved value, and winning layer;
 *   - the document states the managed overlay wins and invalid values fall
 *     back to wal, and gives the gate implication;
 *   - probe_config.py runs all five scratch-home scenarios and exits 0.
 *
 * The probe imports the installed Hermes runtime, so the runtime assertion is
 * skipped on a host where that runtime is not present.  It spawns Python, so
 * this file belongs in the serial lane.
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
const PROBE_PATH = path.join(GATE_DIR, "probes", "probe_config.py");
const EVIDENCE_PATH = path.join(GATE_DIR, "evidence", "config-resolution.txt");
const STRACE_EVIDENCE_PATH = path.join(GATE_DIR, "evidence", "config-resolution-strace.txt");

const HERMES_SRC = "/home/kaladin/hermes-agent";
const HERMES_PYTHON = path.join(HERMES_SRC, "venv", "bin", "python");

const scratchRoots: string[] = [];
after(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const hermesAvailable =
  fs.existsSync(HERMES_PYTHON) && fs.existsSync(path.join(HERMES_SRC, "hermes_state_wal.py"));

function readDoc(): string {
  return fs.readFileSync(DOC_PATH, "utf-8");
}

function configSection(doc: string): string {
  const start = doc.indexOf("## Config Resolution");
  const end = doc.indexOf("\n## Per-Store Findings", start);
  assert.ok(start >= 0, "document must contain a Config Resolution section");
  assert.ok(end > start, "Config Resolution must be followed by Per-Store Findings");
  return doc.slice(start, end);
}

describe("G1 US-002 config-resolution document", () => {
  it("contains the required Config Resolution table columns", () => {
    const section = configSection(readDoc());
    for (const column of [
      "Scenario",
      "Config file path",
      "Realpath",
      "Raw user value",
      "Managed overlay value",
      "Resolved value",
      "Winning layer",
    ]) {
      assert.ok(section.includes(column), `Config Resolution table must have a "${column}" column`);
    }
  });

  it("covers default, user-delete, invalid, env and managed-overlay scenarios", () => {
    const section = configSection(readDoc());
    for (const scenario of [
      "default, no `database` section",
      "user config `delete`",
      "invalid value `bogus`",
      "`HERMES_JOURNAL_MODE=delete`",
      "managed overlay `delete`",
    ]) {
      assert.ok(section.includes(scenario), `Config Resolution must record scenario ${scenario}`);
    }
  });

  it("names the config path derivation and a realpath", () => {
    const section = configSection(readDoc());
    assert.match(section, /get_config_path\(\)/);
    assert.match(section, /get_hermes_home\(\)\s*\/\s*"config\.yaml"/);
    assert.match(section, /realpath/i);
    assert.match(section, /readlink -f/);
  });

  it("states managed values overlay user config and invalid values fall back", () => {
    const section = configSection(readDoc());
    assert.match(section, /managed[^\n]*overlay[^\n]*wins|managed wins/i);
    assert.match(section, /fail-safe|fail safe/i);
    assert.match(section, /invalid[^\n]*(wal|discard)/i);
    assert.match(section, /applied (LAST|AFTER)/i);
  });

  it("records the host managed-dir observation and managed-key status", () => {
    const section = configSection(readDoc());
    assert.match(section, /get_managed_dir\(\)/);
    assert.match(section, /\/etc\/hermes/);
    assert.match(section, /managed_config_keys\(\)/);
    assert.match(section, /database\.journal_mode/);
  });

  it("states the gate must evaluate the resolved value, not raw YAML", () => {
    const section = configSection(readDoc());
    assert.match(section, /gate must evaluate the value Hermes \*\*actually resolves\*\*/i);
    assert.match(section, /not merely\s+grep/i);
    assert.match(section, /managed-scope/);
  });
});

describe("G1 US-002 config-resolution probe", () => {
  it("exists, is stdlib-based, and names every scenario and its safety guards", () => {
    assert.ok(fs.existsSync(PROBE_PATH), `probe must exist at ${PROBE_PATH}`);
    const source = fs.readFileSync(PROBE_PATH, "utf-8");
    assert.ok(!source.includes("import sqlite3"), "probe must not import the database module");
    for (const marker of [
      "hermes_state_wal.resolve_journal_mode",
      "hermes_cli.managed_scope",
      "get_config_path",
      "HERMES_JOURNAL_MODE",
      "default-no-database-section",
      "user-config-delete",
      "invalid-value-bogus",
      "env-var-does-not-override",
      "managed-overlay-wins",
      "/home/kaladin/.hermes",
    ]) {
      assert.ok(source.includes(marker), `probe must reference ${marker}`);
    }
  });

  it("saved evidence log contains all five scenarios and a passing summary", () => {
    assert.ok(fs.existsSync(EVIDENCE_PATH), `evidence log must exist at ${EVIDENCE_PATH}`);
    const log = fs.readFileSync(EVIDENCE_PATH, "utf-8");
    for (const scenario of [
      "default-no-database-section",
      "user-config-delete",
      "invalid-value-bogus",
      "env-var-does-not-override",
      "managed-overlay-wins",
    ]) {
      assert.ok(log.includes(`"scenario": "${scenario}"`), `evidence log must contain ${scenario}`);
    }
    assert.match(log, /"all_passed": true/);
    assert.match(log, /probe_config: all 5 scenarios passed/);
  });

  it("strace evidence records zero opens under the real operator home", () => {
    assert.ok(
      fs.existsSync(STRACE_EVIDENCE_PATH),
      `strace evidence must exist at ${STRACE_EVIDENCE_PATH}`,
    );
    const log = fs.readFileSync(STRACE_EVIDENCE_PATH, "utf-8");
    assert.match(log, /probe_exit=0/);
    assert.match(log, /real_home_openat_hits=0/);
    assert.match(log, /grep '\/home\/kaladin\/\\\.hermes'/);
  });

  it(
    "exits 0 with all five scenarios passing against the installed runtime",
    { skip: !hermesAvailable && "installed Hermes runtime is not present on this host" },
    () => {
      // A minimal environment keeps the probe off the live daemon/state paths
      // and gives it a disposable HOME; the probe itself creates and cleans its
      // own disposable scratch HERMES_HOME scenarios.
      const home = tamanduaTempDir("g1-cfg-test-");
      scratchRoots.push(home);
      const result = spawnSync(HERMES_PYTHON, [PROBE_PATH], {
        cwd: HERMES_SRC,
        encoding: "utf-8",
        timeout: 300_000,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          HERMES_SRC,
        },
      });
      assert.equal(
        result.status,
        0,
        `probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      for (const scenario of [
        "default-no-database-section",
        "user-config-delete",
        "invalid-value-bogus",
        "env-var-does-not-override",
        "managed-overlay-wins",
      ]) {
        assert.ok(result.stdout.includes(`"scenario": "${scenario}"`), `stdout must report ${scenario}`);
      }
      assert.match(result.stdout, /"all_passed": true/);
      assert.match(result.stdout, /probe_config: all 5 scenarios passed/);
      assert.ok(!result.stdout.includes("/home/kaladin/.hermes"), "probe must not touch the real home");
      assert.ok(!result.stderr.includes("/home/kaladin/.hermes"), "probe must not touch the real home");
    },
  );
});
