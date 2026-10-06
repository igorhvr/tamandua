/**
 * MTLK-INTERACTIVE US-001 — INTEGRATION-NOTES dependency-contract gate.
 *
 * This is a documentation contract test. It reads `INTEGRATION-NOTES.md` at the
 * repository root and asserts the frozen dependency contract required by the
 * run brief:
 *
 *   - the base commit is named;
 *   - a capability-verification section enumerates EVERY exec_tty frame with a
 *     runtime source reference and the current Tamandua client state;
 *   - every spec requirement is mapped to a shipped primitive with file:line,
 *     or to a PROVISIONAL GAP;
 *   - every provisional gap is enumerated with reconciliation instructions;
 *   - the explicitly unavailable real launch paths are stated.
 *
 * Pure filesystem reads (no child_process, no dist import), so this file stays
 * in the parallel lane and needs no tests/serial-files.txt entry.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTES_PATH = path.resolve(HERE, "..", "INTEGRATION-NOTES.md");

const BASE_COMMIT = "9f167705250e6c4b453ea4e42caaaddae703530d";

/** Every exec_tty frame the runtime exposes and the client must eventually speak. */
const REQUIRED_FRAMES = [
  "exec_tty",
  "exec_tty.ready",
  "exec_tty.stdout",
  "exec_tty.stdin",
  "exec_tty.stdin_eof",
  "exec_tty.resize",
] as const;

/** Every requirement id in the §3 mapping table. */
const REQUIRED_SPEC_IDS = Array.from({ length: 18 }, (_, i) => `SPEC-${String(i + 1).padStart(2, "0")}`);

/** Every provisional gap id in the §4 gap list. */
const REQUIRED_GAP_IDS = Array.from({ length: 12 }, (_, i) => `GAP-${String(i + 1).padStart(2, "0")}`);

const CAPABILITY_HEADING = "## 2. Capability verification: exec_tty";
const MAPPING_HEADING = "## 3. Requirement mapping";
const GAPS_HEADING = "## 4. Provisional gaps and reconciliation";
const UNAVAILABLE_HEADING = "## 5. Explicitly unavailable real launch paths";

function readNotes(): string {
  return fs.readFileSync(NOTES_PATH, "utf8");
}

/** Return the body of a `## ` section up to the next top-level `## ` heading. */
function sectionBody(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  assert.ok(start >= 0, `missing required section heading: ${heading}`);
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Lines of a markdown table (start with `|`), excluding the header separator. */
function tableRows(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !/^\|[\s:|-]+\|$/.test(l));
}

test("US-001: INTEGRATION-NOTES.md exists at the repo root and names the base commit", () => {
  assert.ok(fs.existsSync(NOTES_PATH), `INTEGRATION-NOTES.md is missing at ${NOTES_PATH}`);
  const doc = readNotes();
  assert.ok(
    doc.includes(BASE_COMMIT),
    `INTEGRATION-NOTES.md must name the base commit ${BASE_COMMIT}`,
  );
  assert.match(doc, /Repository base commit/i);
  // The spec hash pin is part of the frozen contract.
  assert.match(doc, /753e179ff6891ac94aa83c4d01c426901c025140409108f062314207c2f328fd/);
});

test("US-001: the capability section enumerates every exec_tty frame with a runtime reference and client state", () => {
  const doc = readNotes();
  const cap = sectionBody(doc, CAPABILITY_HEADING);
  const rows = tableRows(cap);
  assert.ok(rows.length >= REQUIRED_FRAMES.length, "capability table must list every exec_tty frame");

  for (const frame of REQUIRED_FRAMES) {
    const token = `\`${frame}\``;
    const row = rows.find((r) => r.includes(token));
    assert.ok(row, `capability table is missing a row for ${token}`);
    const runtimeRef = /(?:pkg\/|src\/)[\w./-]+:\d+/.test(row!);
    assert.ok(runtimeRef, `frame ${token} must cite a runtime source file:line reference`);
    const clientState = /ABSENT|PRESENT|absent|present/i.test(row!);
    assert.ok(clientState, `frame ${token} must state the current Tamandua client state`);
  }

  // The verdict must record present-in-runtime / absent-in-client and that the
  // "absent from BOTH" stop condition does not apply.
  assert.match(cap, /present/i);
  assert.match(cap, /absent/i);
  assert.match(doc, /absent from BOTH/i);
});

test("US-001: every requirement is mapped to a shipped primitive or a PROVISIONAL GAP", () => {
  const doc = readNotes();
  const mapping = sectionBody(doc, MAPPING_HEADING);
  const rows = tableRows(mapping);
  const gapIds = new Set(REQUIRED_GAP_IDS);

  for (const specId of REQUIRED_SPEC_IDS) {
    const row = rows.find((r) => r.startsWith(`| ${specId} |`));
    assert.ok(row, `requirement mapping is missing a row for ${specId}`);

    const shipped = row!.includes("SHIPPED");
    const provisional = /PROVISIONAL GAP GAP-\d{2}/.test(row!);
    assert.ok(
      shipped || provisional,
      `${specId} must be mapped to a shipped primitive or a PROVISIONAL GAP`,
    );

    if (shipped) {
      assert.match(
        row!,
        /(?:[\w./-]+\.ts:\d+)/,
        `${specId} is SHIPPED but cites no file:line primitive`,
      );
    }
    if (provisional) {
      for (const m of row!.matchAll(/GAP-\d{2}/g)) {
        assert.ok(gapIds.has(m[0]), `${specId} references unknown gap ${m[0]}`);
      }
    }
  }
});

test("US-001: every provisional gap is enumerated with reconciliation instructions", () => {
  const doc = readNotes();
  const gaps = sectionBody(doc, GAPS_HEADING);

  for (const gapId of REQUIRED_GAP_IDS) {
    const headingRe = new RegExp(`^### ${gapId} —`, "m");
    assert.match(gaps, headingRe, `provisional gap ${gapId} is missing its heading`);
  }

  // Each gap subsection must carry a Reconciliation instruction.
  const parts = gaps.split(/\n### /).slice(1);
  assert.equal(parts.length, REQUIRED_GAP_IDS.length, "gap count must match the enumerated list");
  for (const part of parts) {
    const id = part.slice(0, 6);
    assert.ok(REQUIRED_GAP_IDS.includes(id), `unexpected gap heading: ${id}`);
    assert.match(part, /Reconciliation:/, `${id} must carry reconciliation instructions`);
  }

  // R8 (swap handshake) and the root gate are explicitly required gaps.
  assert.match(doc, /GAP-01[\s\S]*?root/i);
  assert.match(doc, /GAP-02[\s\S]*?swap/i);
});

test("US-001: the contract states the explicitly unavailable real launch paths and synthetic-only scope", () => {
  const doc = readNotes();
  const unavailable = sectionBody(doc, UNAVAILABLE_HEADING);
  assert.match(unavailable, /real-VM/i);
  assert.match(unavailable, /pi/i);
  assert.match(unavailable, /hermes/i);
  assert.match(unavailable, /synthetic/i);
  // The brief forbids presenting scaffolding as completion.
  assert.match(unavailable, /clean-refusal scaffolding is NOT feature\s+completion/i);
});
