/**
 * MTLK-SETUP US-017 — final verification: the in-scope requirement surface is
 * present, correctly wired and lane-classified.
 *
 * This is the traceability guard for the run's evidence report. It pins, from
 * the committed tree only:
 *   - every source / test / doc artifact the evidence table names exists;
 *   - the two spawn-capable suites are registered in tests/serial-files.txt
 *     while the injected-seam unit test and the pure docs/traceability tests
 *     stay in the PARALLEL lane;
 *   - the pure installer core never imports `node:child_process` (spec N5);
 *   - the standard-image constant / env override and the "kept byte-identical"
 *     comment are present (Environment note), and the sibling
 *     `src/installer/matchlock/standard-image.ts` delivered by the iso line
 *     exists on the merged tree (cross-module byte-equality is pinned by
 *     tests/matchlock-setup-standard-image-parity.test.ts; import-based
 *     consolidation is deferred to bead tamandua-48v);
 *   - the CLI surface (N6) exports both help functions and documents every
 *     setup flag;
 *   - the docs (spec §8) name the command.
 *
 * Pure filesystem reads (no `dist` import, no `child_process`, no daemon, no VM,
 * no network), so this file stays in the PARALLEL lane and MUST NOT be listed in
 * tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf-8");
}

function exists(relPath: string): boolean {
  return existsSync(resolve(repoRoot, relPath));
}

const coreSource = readRepoFile("src/installer/matchlock-setup.ts");
const cliSource = readRepoFile("src/cli/commands/matchlock.ts");
const readme = readRepoFile("README.md");
const qualification = readRepoFile("docs/matchlock-dsh-qualification.md");

const serialFiles = readRepoFile("tests/serial-files.txt")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

/** Every source, test and doc artifact the US-017 evidence table names. */
const REQUIRED_ARTIFACTS = [
  "src/installer/matchlock-setup.ts",
  "src/installer/matchlock-setup-runner.ts",
  "src/installer/matchlock-setup.test.ts",
  "src/cli/commands/matchlock.ts",
  "src/cli/commands/matchlock.test.ts",
  "src/cli/cli-thin.test.ts",
  "src/cli/cli.ts",
  "src/cli/shared.ts",
  "tests/cli-structure.test.ts",
  "tests/matchlock-setup-integration.test.ts",
  "tests/matchlock-setup-docs.test.ts",
  "tests/serial-files.txt",
  "README.md",
  "docs/matchlock-dsh-qualification.md",
];

/** The exact flags spec §2/§4.2 requires on `matchlock setup`. */
const REQUIRED_SETUP_FLAGS = [
  "--latest",
  "--ref",
  "--prefix",
  "--refresh-image",
  "--allow-low-disk-space",
  "--no-host-setup",
  "--no-image",
  "--force",
  "--smoke",
  "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
];

describe("MTLK-SETUP US-017: in-scope artifacts and lane classification", () => {
  it("ships every source, test and doc artifact the evidence table names", () => {
    for (const relPath of REQUIRED_ARTIFACTS) {
      assert.ok(exists(relPath), `${relPath} must exist in the tree`);
    }
  });

  it("registers the spawn-capable suites in the SERIAL lane", () => {
    assert.ok(
      serialFiles.includes("tests/matchlock-setup-integration.test.ts"),
      "the real-git integration test must run in the serial lane",
    );
    assert.ok(
      serialFiles.includes("src/cli/commands/matchlock.test.ts"),
      "the spawn-based CLI handler test must run in the serial lane",
    );
  });

  it("keeps the injected-seam unit and pure docs/traceability tests in the PARALLEL lane", () => {
    for (const relPath of [
      "src/installer/matchlock-setup.test.ts",
      "tests/matchlock-setup-docs.test.ts",
      "tests/matchlock-setup-traceability.test.ts",
    ]) {
      assert.ok(
        !serialFiles.includes(relPath),
        `${relPath} must stay in the parallel lane`,
      );
    }
  });
});

describe("MTLK-SETUP US-017: materialization and seams (N5, N7, environment note)", () => {
  it("keeps the pure core free of node:child_process (N5)", () => {
    assert.doesNotMatch(
      coreSource,
      /from\s+["']node:child_process["']|require\(["']node:child_process["']\)/,
      "src/installer/matchlock-setup.ts must stay spawn-free so its unit test is parallel",
    );
    assert.ok(
      exists("src/installer/matchlock-setup-runner.ts"),
      "the spawn-capable runner module must hold the default seams",
    );
  });

  it("pins the standard-image reference and env override byte-identically", () => {
    assert.match(
      coreSource,
      /export const STANDARD_IMAGE_REFERENCE = "igorhvr\/tamandua";/,
      "STANDARD_IMAGE_REFERENCE must be exactly igorhvr/tamandua",
    );
    assert.match(
      coreSource,
      /export const MATCHLOCK_IMAGE_ENV_NAME = "TAMANDUA_MATCHLOCK_IMAGE";/,
      "the image env override must be exactly TAMANDUA_MATCHLOCK_IMAGE",
    );
    assert.match(
      coreSource,
      /kept byte-identical to src\/installer\/matchlock\/standard-image\.ts/,
      "the sibling-consolidation comment must be present",
    );
  });

  it("carries the iso line's sibling standard-image module on the merged tree", () => {
    // Combined-tree invariant: the setup line deferred the sibling on purpose
    // (see the "kept byte-identical" comment in src/installer/matchlock-setup.ts),
    // and current main delivers it. Both sides' artifacts must survive the merge;
    // import-based consolidation stays deferred to bead tamandua-48v.
    assert.ok(
      exists("src/installer/matchlock/standard-image.ts"),
      "src/installer/matchlock/standard-image.ts is the iso line's sibling deliverable and must exist on the combined tree",
    );
  });
});

describe("MTLK-SETUP US-017: CLI surface and docs (N6, §8)", () => {
  it("exports both group and setup help functions", () => {
    assert.match(
      cliSource,
      /export function getMatchlockHelp\(/,
      "getMatchlockHelp must be exported",
    );
    assert.match(
      cliSource,
      /export function getMatchlockSetupHelp\(/,
      "getMatchlockSetupHelp must be exported",
    );
  });

  it("documents every setup flag in the help text", () => {
    for (const flag of REQUIRED_SETUP_FLAGS) {
      assert.ok(
        cliSource.includes(flag),
        `setup help must document ${flag}`,
      );
    }
  });

  it("points the user-facing docs at the provisioning command", () => {
    assert.ok(
      readme.includes("tamandua matchlock setup"),
      "README must name the provisioning command",
    );
    assert.ok(
      qualification.includes("tamandua matchlock setup"),
      "the qualification guide must point provisioning at the command",
    );
  });
});
