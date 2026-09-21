/**
 * MTLK-FIX US-009 (item 5 / tamandua-6sy.33.10.30) — documentation regression
 * for the accepted launch-time harness probe cost.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. It pins the operator-facing statement that under `--matchlock` each
 * run performs ONE launch-time harness probe (one real model round in a fresh
 * VM), with the measured per-harness token magnitudes, and that this cost is
 * accepted by design — in both the README Matchlock section and the dsh
 * qualification recipe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

const readme = readRepoFile("README.md");

// README slice from the Matchlock heading to the next H5, so assertions about
// the probe cost cannot pass by matching some unrelated section.
const matchlockHeading = "##### Matchlock Execution (`--matchlock`)";
const matchlockStart = readme.indexOf(matchlockHeading);
const matchlockSection =
  matchlockStart >= 0
    ? readme.slice(matchlockStart, readme.indexOf("##### Doctor Contract Check", matchlockStart))
    : "";

const recipePath = "docs/matchlock-dsh-qualification.md";
const recipe = readRepoFile(recipePath);

describe("README documents the accepted launch-time probe cost (MTLK-FIX US-009)", () => {
  it("has the Matchlock section", () => {
    assert.ok(matchlockStart >= 0, "README must have a Matchlock Execution section");
  });

  it("states the probe is one real model round in a fresh VM", () => {
    assert.match(matchlockSection, /Launch-time probe cost \(accepted by design\)/);
    assert.match(matchlockSection, /one real model\s+round/);
    assert.match(matchlockSection, /fresh Matchlock VM/);
  });

  it("records the measured pi/dsh/hermes probe token magnitudes", () => {
    assert.match(
      matchlockSection,
      /`pi` ~1\.7k, `dsh` ~6\.8k and\s+`hermes` ~9\.2k tokens per\s+probe/
    );
  });

  it("states the extra VM boot and that probe tokens are attributed to the run", () => {
    assert.match(matchlockSection, /plus one VM boot/);
    assert.match(matchlockSection, /probe tokens are attributed to the run/);
  });

  it("states the cost is accepted by design and distinct from the zero-provider gates", () => {
    assert.match(matchlockSection, /accepted by design \(once per run, not per round\)/);
    assert.match(matchlockSection, /zero-provider synthetic gates/);
    assert.match(matchlockSection, /spend no model tokens/);
  });
});

describe("docs/matchlock-dsh-qualification.md documents the accepted probe cost (MTLK-FIX US-009)", () => {
  it("has a dedicated probe-cost section stating one real model round per run", () => {
    assert.match(recipe, /Launch-time harness probe cost \(accepted by design\)/);
    assert.match(recipe, /exactly \*\*one launch-time harness\*\*\s+probe|one launch-time harness\s+probe/);
    assert.match(recipe, /one real model round/);
  });

  it("records the measured per-harness probe token magnitudes in a table", () => {
    assert.match(recipe, /\| `pi` \| ~1\.7k \|/);
    assert.match(recipe, /\| `dsh` \| ~6\.8k \|/);
    assert.match(recipe, /\| `hermes` \| ~9\.2k \|/);
  });

  it("states the probe boots a fresh VM and its tokens are attributed to the run", () => {
    assert.match(recipe, /boots one fresh Matchlock VM/);
    assert.match(recipe, /attributed\s+to the run/);
    assert.match(recipe, /run\.harness_probe_ok/);
  });

  it("states the cost is accepted by design and once per run", () => {
    assert.match(recipe, /accepted by design/);
    assert.match(recipe, /once per run, not once per round/);
  });
});
