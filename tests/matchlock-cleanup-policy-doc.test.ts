/**
 * MTLK-CLEANUP US-010 finalization gate.
 *
 * Pins the in-repo cleanup policy document to the phase policy the campaign
 * contract declares, so the decision ("a post-harness close/dispose failure is
 * non-fatal") cannot silently disappear from the repository when the
 * out-of-repo contract is not available.
 *
 * This is a documentation contract test: it reads `docs/matchlock-cleanup-policy.md`
 * and asserts the required sections/rows are present. It never spawns anything.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_PATH = path.resolve(HERE, "..", "docs", "matchlock-cleanup-policy.md");

function readDoc(): string {
  return fs.readFileSync(DOC_PATH, "utf8");
}

test("US-010: the cleanup policy doc exists and names the incident root cause", () => {
  const doc = readDoc();
  assert.match(doc, /vm-394274ee/);
  assert.match(doc, /\[object Object\]/);
  assert.match(doc, /2026-09-18T21:29:28Z/);
});

test("US-010: the phase policy table carries every phase and its fatal/non-fatal decision", () => {
  const doc = readDoc();
  // The table header.
  assert.match(doc, /\|\s*Phase\s*\|\s*When\s*\|\s*Fatal\?\s*\|\s*On failure\s*\|/);
  for (const phase of ["`create`", "`probe`", "`exec`", "`close`", "`dispose`"]) {
    assert.ok(doc.includes(phase), `phase policy is missing ${phase}`);
  }
  // The three decisive rows.
  assert.match(doc, /`close`\s*\|\s*\*\*after\*\* the harness process has exited\s*\|\s*\*\*no\*\*/);
  assert.match(doc, /`close`\s*\|\s*before the harness exits\s*\|\s*\*\*yes\*\*/);
  assert.match(doc, /`dispose`\s*\|\s*before the harness exits \/ cancel-abort\s*\|\s*\*\*yes\*\*/);
});

test("US-010: the non-fatal post-harness close/dispose policy and reaper handoff are documented", () => {
  const doc = readDoc();
  assert.match(doc, /harness process has exited[^|]*\|\s*\*\*no\*\*/);
  assert.match(doc, /orphan record/i);
  assert.match(doc, /cleanupConfirmed=false/);
  assert.match(doc, /serializeMatchlockError/);
  assert.match(doc, /\[object Object\]/);
});

test("US-010: the reaper's exact-id + live-process guard and no-prune/no-glob rules are documented", () => {
  const doc = readDoc();
  assert.match(doc, /exact id/i);
  assert.match(doc, /live `matchlock`\/`firecracker`/);
  assert.match(doc, /never uses\s+`prune`\/`gc`/);
  assert.match(doc, /never selects by name or glob/);
});
