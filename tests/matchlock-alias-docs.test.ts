/**
 * MTLK-ALIAS-FIX US-006 — committed documentation contract for the keyed
 * per-daemon Matchlock short-HOME alias.
 *
 * The keyed layout and its ownership protocol are an operator-visible change:
 * `/tmp/tamandua/<uid>/<k>/h` (one alias per daemon instance) replaced the
 * single shared `/tmp/tamandua/<uid>/h` symlink. These pure-filesystem tests
 * pin the wording future runs and operators depend on:
 *
 *   1. AGENTS.md and docs/matchlock-dsh-qualification.md name the keyed layout,
 *      the `owner.json` sidecar and the live-holder refusal naming the holder;
 *   2. both state that legacy `/tmp/tamandua/<uid>/h` symlinks are ignored and
 *      never deleted by the migration;
 *   3. README.md documents the alias-isolation gate and its on-demand driver.
 *
 * No daemon, VM, child process or network: parallel lane, no
 * tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const KEYED_ALIAS = "/tmp/tamandua/<uid>/<k>/h";
const LEGACY_ALIAS = "/tmp/tamandua/<uid>/h";

function readRepoFile(relativePath: string): string {
  const absolute = path.join(repoRoot, relativePath);
  assert.ok(fs.existsSync(absolute), `${relativePath} must exist`);
  return fs.readFileSync(absolute, "utf-8");
}

/** Collapse whitespace so assertions survive markdown line wrapping. */
function flat(source: string): string {
  return source.replace(/\s+/g, " ");
}

const DOC_FILES = ["AGENTS.md", "docs/matchlock-dsh-qualification.md"] as const;

describe("keyed Matchlock alias documentation (US-006)", () => {
  for (const file of DOC_FILES) {
    it(`${file} names the keyed layout, owner.json and the live-holder refusal`, () => {
      const doc = flat(readRepoFile(file));
      assert.ok(
        doc.includes(KEYED_ALIAS),
        `${file} must name the keyed alias path ${KEYED_ALIAS}`,
      );
      assert.match(doc, /sha256/, `${file} must document the <k> derivation`);
      assert.match(doc, /real HOME/, `${file} must state <k> derives from the real HOME`);
      assert.match(doc, /owner\.json/, `${file} must name the owner.json sidecar`);
      assert.match(
        doc,
        /startIdentity/,
        `${file} must name the kernel startIdentity recorded by the sidecar`,
      );
      assert.match(doc, /live holder/i, `${file} must describe the live-holder case`);
      assert.match(
        doc,
        /alias_owned_by_live_daemon/,
        `${file} must name the live-holder refusal reason`,
      );
      assert.match(
        doc,
        /naming the holder/i,
        `${file} must state the refusal names the holder`,
      );
    });

    it(`${file} states legacy /tmp/tamandua/<uid>/h symlinks are ignored, never deleted`, () => {
      const doc = flat(readRepoFile(file));
      assert.ok(
        doc.includes(LEGACY_ALIAS),
        `${file} must name the legacy alias layout ${LEGACY_ALIAS}`,
      );
      assert.match(
        doc,
        /IGNORED/i,
        `${file} must state the legacy alias is ignored by the migration`,
      );
      assert.match(
        doc,
        /never deleted/i,
        `${file} must state legacy alias symlinks are never deleted`,
      );
      // The legacy path must be described together with the migration rule, not
      // merely mentioned somewhere else in the file.
      assert.match(
        doc,
        new RegExp(
          LEGACY_ALIAS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "\\S{0,40}\\s+is IGNORED[\\s\\S]{0,120}?never deleted",
        ),
        `${file} must bind the legacy path to the ignored/never-deleted rule`,
      );
    });

    it(`${file} says a daemon only touches its own keyed alias`, () => {
      const doc = flat(readRepoFile(file));
      assert.match(
        doc,
        /only[^.]{0,80}its own `<k>`|never another daemon's `<k>`|only ever touches its own/i,
        `${file} must state a daemon only touches its own <k>`,
      );
      assert.match(
        doc,
        /stale sidecar/i,
        `${file} must describe stale-sidecar takeover`,
      );
      assert.match(doc, /take over|taken over/i, `${file} must describe stale take-over`);
    });
  }

  it("README.md documents the alias-isolation gate and its driver", () => {
    const readme = readRepoFile("README.md");
    assert.ok(
      readme.includes("run-matchlock-alias-isolation-e2e-test"),
      "README must name the alias-isolation on-demand driver",
    );
    assert.ok(
      readme.includes("e2e-tests/matchlock-alias-isolation-gate.test.ts"),
      "README must name the alias-isolation gate test file",
    );
    assert.ok(
      readme.includes(KEYED_ALIAS),
      `README must document the keyed alias path ${KEYED_ALIAS}`,
    );
    assert.match(readme, /owner\.json/, "README must name the owner.json sidecar");
    assert.match(readme, /IGNORED/i, "README must state the legacy alias is ignored");
    assert.match(
      readme,
      /never deleted/i,
      "README must state legacy alias symlinks are never deleted",
    );
  });
});
