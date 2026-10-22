/**
 * G1 store-control discovery — US-005 state.db conversion-persistence contract.
 *
 * Pins the written finding and the executable probe:
 *   - state.db is seeded WAL (2,2), copied byte-identically, and converted
 *     offline on the copy to 1,1 with `hermes sessions set-journal-mode`;
 *   - two consecutive real writer runs under database.journal_mode=delete keep
 *     the header at 1,1, while the database.journal_mode=wal control flips the
 *     same converted copy back to 2,2;
 *   - the document records the exact command, output, sha256 values, raw header
 *     bytes, and sidecars, and states that the control is config-driven;
 *   - probe_conversion_persistence.sh exits 0 and fails on a reversed
 *     conversion.
 *
 * The runtime assertion spawns the installed Hermes writer and the offline
 * conversion command, so this file belongs in the serial lane.
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
const PROBE_PATH = path.join(PROBES_DIR, "probe_conversion_persistence.sh");
const READER_PATH = path.join(PROBES_DIR, "read_header.py");
const WRAPPER_PATH = path.join(PROBES_DIR, "hermes_scratch.sh");
const EVIDENCE_PATH = path.join(EVIDENCE_DIR, "conversion-persistence.txt");

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

function conversionSection(doc: string): string {
  const start = doc.indexOf("### Offline conversion persistence for `state.db` (US-005)");
  const end = doc.indexOf(
    "\n### Offline conversion persistence for `verification_evidence.db` (US-006)",
    start,
  );
  assert.ok(start >= 0, "document must contain the US-005 state.db conversion subsection");
  assert.ok(end > start, "the US-005 subsection must be followed by the US-006 subsection");
  return doc.slice(start, end);
}

describe("G1 US-005 state.db conversion document", () => {
  it("states the HONOURING verdict and the exact offline conversion command", () => {
    const section = conversionSection(readDoc());
    assert.match(section, /Verdict: `state\.db` HONOURING/);
    assert.match(section, /two consecutive real writer runs/);
    assert.match(section, /hermes sessions set-journal-mode delete/);
    assert.match(section, /journal_mode wal → delete \(header verified\)/);
    assert.match(section, /conversion_exit: 0/);
    assert.match(section, /config-driven, not a delete-mode failure/);
    assert.match(section, /apply_wal_with_fallback\(\)/);
    assert.match(section, /never-live-downgrade/);
    assert.match(section, /read_header\.py/);
    assert.match(section, /raw `\(byte18, byte19\)` pair/);
  });

  it("records the converted copy at 1,1, both delete runs at 1,1, and the WAL control at 2,2", () => {
    const section = conversionSection(readDoc());
    assert.match(section, /Offline-converted copy/);
    assert.match(section, /Converted copy under `delete`, after run 1/);
    assert.match(section, /Converted copy under `delete`, after run 2/);
    assert.match(section, /Converted copy under `wal` control, after run/);
    assert.match(section, /`1,1`/);
    assert.match(section, /`2,2`/);
    assert.match(section, /Sidecars after close/);
    assert.match(section, /changed only the copy/i);
  });

  it("pins the sha256 values and scratch root to the saved evidence", () => {
    const section = conversionSection(readDoc());
    assert.ok(fs.existsSync(EVIDENCE_PATH), `conversion evidence must exist at ${EVIDENCE_PATH}`);
    const log = fs.readFileSync(EVIDENCE_PATH, "utf-8");

    const digests = section.match(/[0-9a-f]{64}/g) ?? [];
    assert.ok(digests.length >= 6, `expected at least six recorded sha256 digests, found ${digests.length}`);
    for (const digest of digests) {
      assert.ok(log.includes(digest), `document sha256 ${digest} must appear in the evidence log`);
    }

    const rootToken = section.match(/g1-conversion\.[A-Za-z0-9]+/)?.[0];
    assert.ok(rootToken, "the findings must record the captured conversion scratch root");
    assert.ok(log.includes(rootToken), `document scratch root ${rootToken} must match the evidence log`);
  });

  it("the saved evidence records the conversion and the two writer runs", () => {
    assert.ok(fs.existsSync(EVIDENCE_PATH), `conversion evidence must exist at ${EVIDENCE_PATH}`);
    const log = fs.readFileSync(EVIDENCE_PATH, "utf-8");
    for (const marker of [
      "RESULT: PASS",
      "STATE.DB VERDICT: HONOURING",
      "probe_conversion_persistence: real_home=/home/kaladin/.hermes (never opened by design)",
      "== 1. Seed a real state.db under database.journal_mode: wal ==",
      "== 2. Copy the WAL store with cp -a and prove the copy is byte-identical ==",
      "== 3. Convert the COPY offline with 'hermes sessions set-journal-mode delete' ==",
      "== 4. Writer TWICE against the converted copy under database.journal_mode: delete ==",
      "== 5. Control: SAME converted copy under database.journal_mode: wal, writer ONCE ==",
      "ASSERT PASS: conversion_copy_before header is 2,2 (mode wal)",
      "ASSERT PASS: converted_copy header is 1,1 (mode delete)",
      "ASSERT PASS: delete_run_1 header is 1,1 (mode delete)",
      "ASSERT PASS: delete_run_2 header is 1,1 (mode delete)",
      "ASSERT PASS: wal_control_run header is 2,2 (mode wal)",
      "ASSERT PASS: original WAL store sha256 is unchanged by conversion of the copy",
      "ASSERT PASS: conversion source copy was untouched by both writer homes",
    ]) {
      assert.ok(log.includes(marker), `conversion evidence must contain ${marker}`);
    }
    assert.match(log, /"byte18": 1, "byte19": 1, "mode": "delete"/);
    assert.match(log, /"byte18": 2, "byte19": 2, "mode": "wal"/);
    assert.doesNotMatch(log, /"mode": "unknown/);
    assert.doesNotMatch(log, /ASSERT FAIL/);
  });
});

describe("G1 US-005 conversion-persistence probe", () => {
  it("exists, is executable, and uses only the raw header reader", () => {
    assert.ok(fs.existsSync(PROBE_PATH), `probe must exist at ${PROBE_PATH}`);
    const stat = fs.statSync(PROBE_PATH);
    assert.ok((stat.mode & 0o111) !== 0, "probe must be executable");
    const source = fs.readFileSync(PROBE_PATH, "utf-8");
    for (const marker of [
      "hermes_scratch.sh",
      "read_header.py",
      "sessions set-journal-mode delete",
      "cp -a",
      "SessionDB",
      "create_session",
      "database.journal_mode: delete",
      "database.journal_mode: wal",
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
    assert.ok(fs.existsSync(WRAPPER_PATH), "the Hermes scratch wrapper must exist");
  });

  it(
    "converts a copy offline and keeps it at 1,1 across two delete-mode writers",
    { skip: !hermesAvailable && "installed Hermes runtime is not present on this host" },
    () => {
      // HOME is a disposable directory; the probe overrides it with its own
      // scratch root. The explicit env keeps live daemon routing and any
      // inherited journal-mode override out of the child.
      const home = tamanduaTempDir("g1-conversion-test-");
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
        `conversion-persistence probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /RESULT: PASS/);
      assert.match(result.stdout, /STATE\.DB VERDICT: HONOURING/);
      for (const marker of [
        "ASSERT PASS: conversion_copy_before header is 2,2 (mode wal)",
        "ASSERT PASS: converted_copy header is 1,1 (mode delete)",
        "ASSERT PASS: delete_run_1 header is 1,1 (mode delete)",
        "ASSERT PASS: delete_run_2 header is 1,1 (mode delete)",
        "ASSERT PASS: wal_control_run header is 2,2 (mode wal)",
        "ASSERT PASS: original WAL store sha256 is unchanged by conversion of the copy",
      ]) {
        assert.ok(result.stdout.includes(marker), `probe stdout must record: ${marker}`);
      }
      assert.doesNotMatch(result.stdout, /ASSERT FAIL/);
    },
  );
});
