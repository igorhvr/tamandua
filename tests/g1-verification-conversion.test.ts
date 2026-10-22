/**
 * G1 store-control discovery — US-006 verification_evidence.db contract.
 *
 * Pins the written finding and the executable probe:
 *   - verify-on-stop off (the default) means no verification_evidence.db and a
 *     None return from record_verify_run(); enabling it via
 *     agent.verify_on_stop creates the store and records an event;
 *   - a real WAL store (2,2) is copied byte-identically, converted offline on
 *     the copy to 1,1, and two consecutive real writer runs under
 *     database.journal_mode=delete keep the header at 1,1;
 *   - verification_status() and a direct _connect() read keep it at 1,1;
 *   - the document states HONOURING (not a compatibility blocker) and the
 *     Required-vs-Optional section classifies the store as optional and
 *     verify-on-stop gated;
 *   - probe_verification_conversion.sh exits 0 and fails on a reversed
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
const PROBE_PATH = path.join(PROBES_DIR, "probe_verification_conversion.sh");
const READER_PATH = path.join(PROBES_DIR, "read_header.py");
const WRAPPER_PATH = path.join(PROBES_DIR, "hermes_scratch.sh");
const EVIDENCE_PATH = path.join(EVIDENCE_DIR, "verification-conversion-persistence.txt");

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

function findingsSection(doc: string): string {
  const start = doc.indexOf(
    "### Offline conversion persistence for `verification_evidence.db` (US-006)",
  );
  const end = doc.indexOf(
    "\n### Offline conversion persistence for `kanban.db` and `projects.db` (US-007)",
    start,
  );
  assert.ok(start >= 0, "document must contain the US-006 verification-evidence subsection");
  assert.ok(end > start, "the US-006 subsection must end at the US-007 optional-store subsection");
  return doc.slice(start, end);
}

function requiredSection(doc: string): string {
  const start = doc.indexOf("## Required vs Optional");
  const end = doc.indexOf("\n## Gate Implications", start);
  assert.ok(start >= 0, "document must contain the Required vs Optional section");
  assert.ok(end > start, "Required vs Optional must be followed by Gate Implications");
  return doc.slice(start, end);
}

describe("G1 US-006 verification_evidence.db document", () => {
  it("states the optionality boundary and the HONOURING verdict", () => {
    const section = findingsSection(readDoc());
    assert.match(section, /verify-on-stop is off/i);
    assert.match(section, /verification_evidence\.db is absent/);
    assert.match(section, /record_verify_run\(\) returned None/);
    assert.match(section, /agent\.verify_on_stop: true/);
    assert.match(section, /record_verify_run\(\) recorded an event/);
    assert.match(section, /Verdict: `verification_evidence\.db` HONOURING/);
    assert.match(section, /No compatibility blocker/);
    assert.doesNotMatch(section, /COMPATIBILITY BLOCKER:/);
  });

  it("records the exact conversion command, output, and both next-writer runs", () => {
    const section = findingsSection(readDoc());
    assert.match(section, /hermes sessions set-journal-mode delete/);
    assert.match(section, /journal_mode wal → delete \(header verified\)/);
    assert.match(section, /conversion_exit: 0/);
    assert.match(section, /Converted copy under `delete`, after run 1/);
    assert.match(section, /Converted copy under `delete`, after run 2/);
    assert.match(section, /event_id/);
    assert.match(section, /`1,1`/);
    assert.match(section, /`2,2`/);
    assert.match(section, /read_header\.py/);
    assert.match(section, /raw header pair/);
    assert.match(section, /verification_status/);
    assert.match(section, /_connect\(\)/);
  });

  it("pins the sha256 values and scratch root to the saved evidence", () => {
    const section = findingsSection(readDoc());
    assert.ok(fs.existsSync(EVIDENCE_PATH), `evidence must exist at ${EVIDENCE_PATH}`);
    const log = fs.readFileSync(EVIDENCE_PATH, "utf-8");

    const digests = section.match(/[0-9a-f]{64}/g) ?? [];
    assert.ok(digests.length >= 6, `expected at least six recorded sha256 digests, found ${digests.length}`);
    for (const digest of digests) {
      assert.ok(log.includes(digest), `document sha256 ${digest} must appear in the evidence log`);
    }

    const rootToken = section.match(/g1-verification\.[A-Za-z0-9]+/)?.[0];
    assert.ok(rootToken, "the findings must record the captured verification scratch root");
    assert.ok(log.includes(rootToken), `document scratch root ${rootToken} must match the evidence log`);
  });

  it("the saved evidence records optionality, conversion, writers, and reads", () => {
    assert.ok(fs.existsSync(EVIDENCE_PATH), `evidence must exist at ${EVIDENCE_PATH}`);
    const log = fs.readFileSync(EVIDENCE_PATH, "utf-8");
    for (const marker of [
      "RESULT: PASS",
      "VERIFICATION_EVIDENCE.DB VERDICT: HONOURING",
      "probe_verification_conversion: real_home=/home/kaladin/.hermes (never opened by design)",
      "== 1. verify-on-stop OFF: optionality boundary ==",
      "ASSERT PASS: record_verify_run() returned None with verify-on-stop off",
      "ASSERT PASS: verification_evidence.db is absent when verify-on-stop is off",
      "ASSERT PASS: record_verify_run() recorded an event (id 1) with verify-on-stop on",
      "== 5. Convert the COPY offline with 'hermes sessions set-journal-mode delete' ==",
      "ASSERT PASS: converted_copy header is 1,1 (mode delete)",
      "== 6. Writer TWICE against the converted copy under database.journal_mode: delete ==",
      "ASSERT PASS: delete_run_1 header is 1,1 (mode delete)",
      "ASSERT PASS: delete_run_2 header is 1,1 (mode delete)",
      "ASSERT PASS: verification_status() resolved the recorded seed event as passed",
      "ASSERT PASS: read_path_after_connect header is 1,1 (mode delete)",
      "ASSERT PASS: original WAL store sha256 is unchanged by conversion of the copy",
      "ASSERT PASS: conversion source copy was untouched by the delete/read/control homes",
    ]) {
      assert.ok(log.includes(marker), `evidence must contain ${marker}`);
    }
    assert.match(log, /"byte18": 1, "byte19": 1, "mode": "delete"/);
    assert.match(log, /"byte18": 2, "byte19": 2, "mode": "wal"/);
    assert.doesNotMatch(log, /"mode": "unknown/);
    assert.doesNotMatch(log, /ASSERT FAIL/);
  });

  it("classifies the store as optional and verify-on-stop gated", () => {
    const section = requiredSection(readDoc());
    assert.match(section, /verification_evidence\.db/);
    assert.match(section, /Optional — verify-on-stop gated/);
    assert.match(section, /record_verify_run\(\)` returns `None` and the store is \*\*absent\*\*/);
    assert.match(section, /`state\.db` \| \*\*Required \(core\)\*\*/);
    assert.match(section, /explicitly \*\*not\*\* compatibility blockers/);
    assert.match(section, /verify-on-stop is off/);
  });
});

describe("G1 US-006 verification-conversion probe", () => {
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
      "record_verify_run",
      "verification_status",
      "_connect",
      "verify_on_stop_enabled",
      "HERMES_VERIFY_ON_STOP",
      "database.journal_mode: delete",
      "database.journal_mode: wal",
      "HONOURING",
      "COMPATIBILITY BLOCKER",
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
    "keeps the converted verification store at 1,1 across two delete-mode writers and reads",
    { skip: !hermesAvailable && "installed Hermes runtime is not present on this host" },
    () => {
      // HOME is a disposable directory; the probe overrides it with its own
      // scratch root. The explicit env keeps live daemon routing and any
      // inherited journal-mode/verify-on-stop override out of the child.
      const home = tamanduaTempDir("g1-verification-test-");
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
        `verification-conversion probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /RESULT: PASS/);
      assert.match(result.stdout, /VERIFICATION_EVIDENCE\.DB VERDICT: HONOURING/);
      for (const marker of [
        "ASSERT PASS: record_verify_run() returned None with verify-on-stop off",
        "ASSERT PASS: verification_evidence.db is absent when verify-on-stop is off",
        "ASSERT PASS: record_verify_run() recorded an event (id 1) with verify-on-stop on",
        "ASSERT PASS: converted_copy header is 1,1 (mode delete)",
        "ASSERT PASS: delete_run_1 header is 1,1 (mode delete)",
        "ASSERT PASS: delete_run_2 header is 1,1 (mode delete)",
        "ASSERT PASS: read_path_after_verification_status header is 1,1 (mode delete)",
        "ASSERT PASS: read_path_after_connect header is 1,1 (mode delete)",
        "ASSERT PASS: original WAL store sha256 is unchanged by conversion of the copy",
      ]) {
        assert.ok(result.stdout.includes(marker), `probe stdout must record: ${marker}`);
      }
      assert.doesNotMatch(result.stdout, /ASSERT FAIL/);
    },
  );
});
