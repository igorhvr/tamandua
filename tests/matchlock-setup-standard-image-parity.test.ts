/**
 * SETUP-CROSSLINE consolidated-tree guard (tamandua-48v).
 *
 * The standard Matchlock image literal is declared exactly ONCE on the
 * combined tree — in `STANDARD_MATCHLOCK_IMAGE` of
 * src/installer/matchlock/standard-image.ts (the iso line's canonical
 * module). The setup module (src/installer/matchlock-setup.ts) imports that
 * constant and re-exports it as `STANDARD_IMAGE_REFERENCE` for its existing
 * importers, so the two surfaces can no longer drift by construction.
 *
 * This file used to pin the two independently-declared literals byte-equal
 * while consolidation was deferred (the frozen a0p verifier asserted the
 * setup module's static imports were exactly ["node:path"]; the consolidation
 * landed together with a DELIBERATE bump of that verifier — tamandua-48v).
 * It now pins the consolidation itself: the import edge, the alias, and the
 * absence of a duplicated declaration.
 *
 * Both imported modules are pure (matchlock-setup.ts imports only
 * `node:path` + the sibling; standard-image.ts imports nothing), so this
 * file is classified PARALLEL and must NOT be listed in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STANDARD_IMAGE_REFERENCE } from "../dist/installer/matchlock-setup.js";
import { STANDARD_MATCHLOCK_IMAGE } from "../dist/installer/matchlock/standard-image.js";

const repoRoot = resolve(import.meta.dirname, "..");
const EXPECTED_STANDARD_IMAGE = "igorhvr/tamandua";

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf-8");
}

const setupSource = readRepoFile("src/installer/matchlock-setup.ts");
const siblingSource = readRepoFile("src/installer/matchlock/standard-image.ts");

describe("SETUP-CROSSLINE: setup and iso lines agree on the standard image", () => {
  it("exports the canonical literal from both module surfaces", () => {
    assert.equal(
      STANDARD_MATCHLOCK_IMAGE,
      EXPECTED_STANDARD_IMAGE,
      "STANDARD_MATCHLOCK_IMAGE (matchlock/standard-image.ts) must be exactly igorhvr/tamandua",
    );
    assert.equal(
      STANDARD_IMAGE_REFERENCE,
      EXPECTED_STANDARD_IMAGE,
      "STANDARD_IMAGE_REFERENCE (matchlock-setup.ts alias) must be exactly igorhvr/tamandua",
    );
  });

  it("consolidates the declaration: setup imports and aliases the sibling constant", () => {
    assert.equal(
      STANDARD_IMAGE_REFERENCE,
      STANDARD_MATCHLOCK_IMAGE,
      "STANDARD_IMAGE_REFERENCE must BE the canonical constant, not a copy",
    );
    assert.match(
      setupSource,
      /import \{ STANDARD_MATCHLOCK_IMAGE \} from "\.\/matchlock\/standard-image\.js";/,
      "matchlock-setup.ts must statically import the canonical sibling constant (tamandua-48v)",
    );
    assert.match(
      setupSource,
      /export const STANDARD_IMAGE_REFERENCE = STANDARD_MATCHLOCK_IMAGE;/,
      "STANDARD_IMAGE_REFERENCE must alias the imported canonical constant",
    );
  });

  it("declares the standard-image literal in exactly one module", () => {
    assert.match(
      siblingSource,
      /export const STANDARD_MATCHLOCK_IMAGE = "igorhvr\/tamandua";/,
      "the sibling module must carry the single literal declaration",
    );
    assert.ok(
      !setupSource.includes('"igorhvr/tamandua"'),
      "matchlock-setup.ts must not re-declare the duplicated literal after consolidation",
    );
  });
});
