/**
 * SETUP-CROSSLINE combined-tree guard: the two independently declared standard
 * Matchlock image literals must stay byte-equal.
 *
 * On the combined tree (main + the setup line) the canonical reference exists
 * twice, once per line:
 *   - `STANDARD_IMAGE_REFERENCE` in src/installer/matchlock-setup.ts (setup line)
 *   - `STANDARD_MATCHLOCK_IMAGE` in src/installer/matchlock/standard-image.ts
 *     (iso line)
 *
 * Import-based consolidation is DEFERRED to bead tamandua-48v: the frozen a0p
 * verifier (verify-setup-env-contract.mjs, sha256 f0a5ca99...) asserts the setup
 * module's static imports are exactly ["node:path"] with no dynamic imports, so
 * importing the canonical constant from the sibling would break that frozen
 * acceptance property and changing the verifier is not authorized during a
 * landing flight. Until the deferral lands, this test pins the two literals
 * together so they cannot silently drift apart.
 *
 * Both imported modules are pure (matchlock-setup.ts imports only `node:path`;
 * standard-image.ts imports nothing), so this file is classified PARALLEL and
 * must NOT be listed in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STANDARD_IMAGE_REFERENCE } from "../dist/installer/matchlock-setup.js";
import { STANDARD_MATCHLOCK_IMAGE } from "../dist/installer/matchlock/standard-image.js";

const EXPECTED_STANDARD_IMAGE = "igorhvr/tamandua";

describe("SETUP-CROSSLINE: setup and iso lines agree on the standard image", () => {
  it("pins both standard-image literals to igorhvr/tamandua", () => {
    assert.equal(
      STANDARD_IMAGE_REFERENCE,
      EXPECTED_STANDARD_IMAGE,
      "STANDARD_IMAGE_REFERENCE (matchlock-setup.ts) must be exactly igorhvr/tamandua",
    );
    assert.equal(
      STANDARD_MATCHLOCK_IMAGE,
      EXPECTED_STANDARD_IMAGE,
      "STANDARD_MATCHLOCK_IMAGE (matchlock/standard-image.ts) must be exactly igorhvr/tamandua",
    );
  });

  it("keeps the two independently declared literals byte-equal", () => {
    // Consolidation is deferred to tamandua-48v (frozen a0p verifier pins the
    // setup module's imports); until then the literals must not drift.
    assert.equal(
      STANDARD_IMAGE_REFERENCE,
      STANDARD_MATCHLOCK_IMAGE,
      "STANDARD_IMAGE_REFERENCE and STANDARD_MATCHLOCK_IMAGE must stay byte-equal " +
        "until the tamandua-48v consolidation lands",
    );
  });
});
