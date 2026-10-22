/**
 * G1 store-control discovery — US-004 fresh-store journal-mode contract.
 *
 * Pins the written finding and the executable probe:
 *   - the Per-Store Findings table names every inventoried store, both config
 *     modes, the raw header bytes, the observed mode, sidecars, and a
 *     fresh-creation verdict;
 *   - the document scopes the HONOURING verdict to fresh creation and does not
 *     claim the offline-conversion persistence result (US-005/US-006);
 *   - the saved evidence records the raw 1,1 delete readings, the 2,2 WAL
 *     controls, and zero real-operator-home opens;
 *   - probe_fresh_modes.sh exits 0 and fails when a delete home is not 1,1.
 *
 * The runtime assertion spawns the installed Hermes writers, so this file
 * belongs in the serial lane.
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
const PROBE_PATH = path.join(PROBES_DIR, "probe_fresh_modes.sh");
const READER_PATH = path.join(PROBES_DIR, "read_header.py");
const EVIDENCE_PATH = path.join(EVIDENCE_DIR, "fresh-store-modes.txt");
const STRACE_PATH = path.join(EVIDENCE_DIR, "fresh-store-modes-strace.txt");

const HERMES_SRC = "/home/kaladin/hermes-agent";
const HERMES_PYTHON = path.join(HERMES_SRC, "venv", "bin", "python");

const stores = ["state.db", "verification_evidence.db", "kanban.db", "projects.db"];

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

function findingsSection(doc: string): string {
  // Scope to the US-004 subsection: later stories append their own findings
  // under Per-Store Findings, and their digests live in different evidence
  // logs. Pinning only this subsection keeps the digest cross-check exact.
  const start = doc.indexOf("### Fresh creation under `database.journal_mode: delete` (US-004)");
  const end = doc.indexOf("\n### Offline conversion persistence", start);
  assert.ok(start >= 0, "document must contain the US-004 fresh-creation subsection");
  assert.ok(end > start, "the US-004 subsection must be followed by the US-005 subsection");
  return doc.slice(start, end);
}

describe("G1 US-004 fresh-store findings document", () => {
  it("has the required table columns and every inventoried store", () => {
    const section = findingsSection(readDoc());
    for (const column of [
      "Store",
      "Config mode",
      "Header bytes (18/19)",
      "Observed mode",
      "Sidecars after close",
      "Fresh-creation verdict",
    ]) {
      assert.ok(section.includes(column), `Per-Store Findings table must have a "${column}" column`);
    }
    for (const store of stores) {
      assert.ok(section.includes(`\`${store}\``), `Per-Store Findings must cover ${store}`);
    }
  });

  it("records every delete home at 1,1 and every WAL control at 2,2", () => {
    const section = findingsSection(readDoc());
    assert.match(section, /delete-home header/i);
    assert.match(section, /WAL-control header/i);
    assert.match(section, /\*\*HONOURING\*\*/);
    assert.match(section, /No store\s+is NOT-HONOURING or UNKNOWN for this scenario/);

    // One HONOURING verdict per inventoried store.
    const honourable = section.match(/\*\*HONOURING\*\*/g) ?? [];
    assert.ok(honourable.length >= stores.length, `expected at least ${stores.length} HONOURING verdicts`);
  });

  it("records sizes, sha256, config path/realpath, and the resolved mode", () => {
    const section = findingsSection(readDoc());
    assert.match(section, /sha256/);
    assert.match(section, /config\.yaml/);
    assert.match(section, /realpath/);
    assert.match(section, /Resolved before writer/);
    assert.match(section, /274,432/);
    assert.match(section, /118,784/);
    assert.match(section, /45,056/);
    assert.match(section, /32,768/);
  });

  it("uses only the raw header reader and scopes the verdict to fresh creation", () => {
    const section = findingsSection(readDoc());
    assert.match(section, /read_header\.py/);
    assert.match(section, /raw header\s+bytes 18\/19/);
    assert.match(section, /No SQLite connection/);
    assert.match(section, /not the conversion-persistence answer/i);
    assert.match(section, /US-005/);
    assert.match(section, /US-006/);
  });

  it("the saved evidence records the delete and WAL readings and the safety counts", () => {
    assert.ok(fs.existsSync(EVIDENCE_PATH), `fresh-store evidence must exist at ${EVIDENCE_PATH}`);
    const log = fs.readFileSync(EVIDENCE_PATH, "utf-8");
    for (const marker of [
      "RESULT: PASS",
      "probe_fresh_modes: real_home=/home/kaladin/.hermes (never opened by design)",
      "### store: state.db config: delete",
      "### store: state.db config: wal",
      "### store: verification_evidence.db config: delete",
      "### store: kanban.db config: delete",
      "### store: projects.db config: delete",
    ]) {
      assert.ok(log.includes(marker), `fresh-store evidence must contain ${marker}`);
    }
    assert.match(log, /"byte18": 1, "byte19": 1, "mode": "delete"/);
    assert.match(log, /"byte18": 2, "byte19": 2, "mode": "wal"/);
    assert.doesNotMatch(log, /"mode": "unknown/);

    // The document's captured sizes and digests must be the ones in the
    // evidence log, not values left over from an earlier run.
    const section = findingsSection(readDoc());
    const digests = section.match(/[0-9a-f]{64}/g) ?? [];
    assert.ok(digests.length >= 8, `expected eight recorded sha256 digests, found ${digests.length}`);
    for (const digest of digests) {
      assert.ok(log.includes(digest), `document sha256 ${digest} must appear in the evidence log`);
    }
    const scratchRoot = section.match(/\/tmp\/g1-fresh\.[A-Za-z0-9]+/)?.[0];
    assert.ok(scratchRoot, "the findings table must record a captured scratch root");
    assert.ok(log.includes(scratchRoot), `document scratch root ${scratchRoot} must match the evidence log`);

    assert.ok(fs.existsSync(STRACE_PATH), `fresh-store strace evidence must exist at ${STRACE_PATH}`);
    const strace = fs.readFileSync(STRACE_PATH, "utf-8");
    assert.match(strace, /# real_operator_home_open_lines: 0/);
    assert.match(strace, /Real-operator-home opens \(must be empty\):\n\(none\)/);
    assert.match(strace, /state\.db-journal/);
    assert.match(strace, /state\.db-wal/);
  });
});

describe("G1 US-004 fresh-store probe", () => {
  it("exists, is executable, and reads headers only through read_header.py", () => {
    assert.ok(fs.existsSync(PROBE_PATH), `probe must exist at ${PROBE_PATH}`);
    const stat = fs.statSync(PROBE_PATH);
    assert.ok((stat.mode & 0o111) !== 0, "probe must be executable");
    const source = fs.readFileSync(PROBE_PATH, "utf-8");
    for (const marker of [
      "hermes_scratch.sh",
      "read_header.py",
      "database.journal_mode",
      "delete",
      "wal",
      "SessionDB",
      "record_verify_run",
      "kanban list",
      "project list",
      "HONOURING",
      "RESULT: PASS",
      "/home/kaladin/.hermes",
    ]) {
      assert.ok(source.includes(marker), `probe must reference ${marker}`);
    }
    assert.doesNotMatch(source, /import sqlite3/);
    // The reader is the only journal-format reader; it must not import sqlite3.
    const reader = fs.readFileSync(READER_PATH, "utf-8");
    assert.doesNotMatch(reader, /^import sqlite3|^from sqlite3/m);
  });

  it(
    "exits 0 with every delete home at 1,1 and every WAL control at 2,2",
    { skip: !hermesAvailable && "installed Hermes runtime is not present on this host" },
    () => {
      // HOME is a disposable directory and the probe overrides it again with
      // its own scratch root; the explicit env keeps live daemon routing out of
      // the child and gives the shell a minimal PATH.
      const home = tamanduaTempDir("g1-fresh-modes-test-");
      scratchRoots.push(home);
      const result = spawnSync("/bin/bash", [PROBE_PATH], {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 900_000,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          HERMES_SRC,
        },
      });
      assert.equal(
        result.status,
        0,
        `fresh-store probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /RESULT: PASS/);
      for (const store of stores) {
        assert.ok(
          result.stdout.includes(`ASSERT PASS: ${store} fresh delete header is 1,1 and wal control is 2,2`),
          `probe stdout must record the HONOURING assertion for ${store}`,
        );
      }
      assert.doesNotMatch(result.stdout, /ASSERT FAIL/);
    },
  );
});
