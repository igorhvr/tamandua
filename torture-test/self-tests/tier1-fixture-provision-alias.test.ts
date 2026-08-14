// US-010 — S14: provisioner alias pass-through in tt-fixture-provision.mjs
// (CLI-level acceptance pins).
//
// US-009 authored W1.X1-ts with the reserved hostile-path alias fixture
// 'tt-ts café' (U+0020 space + é U+00E9) and taught
// bin/tt-fixture-provision.mjs to resolve reserved aliases to their canonical
// fixture for golden-bare / hash-ledger / fixture-source / arming lookups,
// while the work clone path keeps the authored name verbatim. This test pins
// the STORY-LEVEL acceptance criteria at the exact CLI surface the story
// names:
//
//   * AC1: `node bin/tt-fixture-provision.mjs --fixture 'tt-ts café'
//          --case-id W1.X1-ts --golden-dir <tmp> --work-dir <tmp>` exits 0
//          with ok:true and a workClonePath containing both a space and the
//          non-ASCII char.
//   * AC2: the verdict's goldenBare ends with tt-ts.git (canonical golden)
//          and target.kind is baseline with finalBranch main.
//   * AC3: operatorNotesPlanted is true and the planted file is
//          byte-identical to fixtures-src/tt-ts/operator-notes.local
//          (and untracked, per the shared planting oracle).
//   * AC4: an unknown fixture alias (e.g. 'tt-ts xyz') still fails closed
//          with category unknown-fixture (exit 1).
//   * The alias convention is documented in the file header AND usage();
//          the registry is frozen and lists exactly the reserved alias.
//   * Canonical (non-alias) tt-ts provisioning through the CLI is unchanged.
//
// Zero tokens: no pi/hermes process can ever be spawned — every child
// inherits TAMANDUA_PI_BINARY/TAMANDUA_HERMES_BINARY=/usr/bin/false. The
// tt-ts golden is built once into a fresh temp dir under os.tmpdir(); the
// provisioner writes only to temp work dirs. Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { FIXTURE_ALIASES } from "../bin/tt-fixture-provision.mjs";
import { ensureGoldenBare } from "../bin/tt-golden-bootstrap.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const provision = path.join(ttRoot, "bin", "tt-fixture-provision.mjs");
const provisionSource = fs.readFileSync(provision, "utf8");
const ttTsNotes = path.join(ttRoot, "fixtures-src", "tt-ts", "operator-notes.local");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function runProvision(args: string[]) {
  return spawnSync(process.execPath, [provision, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitIn(clonePath: string, args: string[]) {
  return spawnSync("git", args, { cwd: clonePath, encoding: "utf8" });
}

// ── Hermetic temp goldens + work dir (zero tokens, os.tmpdir only) ───────
let goldenDir: string;
let workDir: string;

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-us010-golden-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-us010-work-"));
  const res = ensureGoldenBare({ fixture: "tt-ts", goldenDir });
  assert.ok(res.ok, `tt-ts golden bootstrap must succeed:\n${JSON.stringify(res)}`);
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("E3.A US-010 — provisioner alias pass-through (CLI-level ACs)", () => {
  it("AC1: CLI provisioning with the hostile alias exits 0 with ok:true and a hostile workClonePath", () => {
    const res = runProvision([
      "--fixture", "tt-ts café",
      "--case-id", "W1.X1-ts",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(res.status, 0, `provision CLI must exit 0:\n${res.stdout}${res.stderr}`);
    const verdict = JSON.parse((res.stdout ?? "").trim());
    assert.equal(verdict.ok, true, "verdict must be ok:true");
    assert.equal(verdict.fixture, "tt-ts café", "verdict must echo the authored alias");
    assert.equal(verdict.canonicalFixture, "tt-ts", "verdict must report the canonical fixture");
    assert.equal(verdict.fixtureAlias, true, "verdict must flag the alias");
    assert.ok(verdict.workClonePath.includes(" "), "workClonePath must contain U+0020 (space)");
    assert.ok(
      [...verdict.workClonePath].some((ch) => ch.charCodeAt(0) > 127),
      "workClonePath must contain a non-ASCII character",
    );
    assert.equal(path.basename(verdict.workClonePath), "tt-ts café", "clone dir must keep the alias name verbatim");
  });

  it("AC2: verdict carries the canonical golden (tt-ts.git) and a baseline target on main", () => {
    const res = runProvision([
      "--fixture", "tt-ts café",
      "--case-id", "W1.X1-ts",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(res.status, 0, `provision CLI must exit 0:\n${res.stdout}${res.stderr}`);
    const verdict = JSON.parse((res.stdout ?? "").trim());
    assert.ok(verdict.goldenBare.endsWith("tt-ts.git"), `goldenBare must end with tt-ts.git, got: ${verdict.goldenBare}`);
    assert.equal(verdict.goldenBare, path.join(goldenDir, "tt-ts.git"), "goldenBare must be the canonical golden in --golden-dir");
    assert.equal(verdict.target.kind, "baseline", "W1.X1 has no seed: target.kind must be baseline");
    assert.equal(verdict.target.finalBranch, "main", "baseline clone must land on main (finalBranch main)");
    assert.ok(!/detached/i.test(verdict.target.branch ?? ""), "target branch must never be detached");
  });

  it("AC3: operator-notes.local is planted byte-identical to the fixture source and untracked", () => {
    const res = runProvision([
      "--fixture", "tt-ts café",
      "--case-id", "W1.X1-ts",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(res.status, 0, `provision CLI must exit 0:\n${res.stdout}${res.stderr}`);
    const verdict = JSON.parse((res.stdout ?? "").trim());
    assert.equal(verdict.operatorNotesPlanted, true, "operatorNotesPlanted must be true");
    const plantedPath = path.join(verdict.workClonePath, "operator-notes.local");
    const planted = fs.readFileSync(plantedPath);
    const canonical = fs.readFileSync(ttTsNotes);
    assert.ok(planted.equals(canonical), "planted file must be byte-identical to fixtures-src/tt-ts/operator-notes.local");
    const ls = gitIn(verdict.workClonePath, ["ls-files", "--error-unmatch", "operator-notes.local"]);
    assert.notEqual(ls.status, 0, "planted operator-notes.local must be untracked (not in the index)");
  });

  it("AC4: an unknown fixture alias ('tt-ts xyz') fails closed with category unknown-fixture", () => {
    const res = runProvision([
      "--fixture", "tt-ts xyz",
      "--case-id", "W1.X1-ts",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(res.status, 1, "unknown alias must exit 1 (fail-closed)");
    const verdict = JSON.parse((res.stdout ?? "").trim());
    assert.equal(verdict.ok, false, "verdict must not be ok");
    assert.equal(verdict.reason.category, "unknown-fixture", "reason.category must be unknown-fixture");
    assert.ok(
      !fs.existsSync(path.join(workDir, "W1.X1-ts", "tt-ts xyz")),
      "an unknown alias must never create a work clone",
    );
  });

  it("the alias convention is documented in the file header and usage()", () => {
    assert.match(provisionSource, /FIXTURE ALIASES \(hostile-path probes/, "file header must document the alias convention");
    assert.match(provisionSource, /single choke point/, "file header must state the provisioner is the single choke point");
    const help = runProvision(["--help"]);
    assert.equal(help.status, 0, "--help must exit 0");
    assert.match(help.stdout, /hostile-path alias/, "--help must document the hostile-path alias convention");
    assert.match(help.stdout, /tt-ts café' -> tt-ts/, "--help must show the reserved alias mapping");
    assert.match(help.stdout, /Known aliases: tt-ts café/, "--help must list the reserved alias");
  });

  it("the alias registry is frozen and maps exactly the reserved alias", () => {
    assert.ok(Object.isFrozen(FIXTURE_ALIASES), "the registry must be Object.freeze'd");
    assert.deepEqual({ ...FIXTURE_ALIASES }, { "tt-ts café": "tt-ts" }, "the registry must list exactly the reserved alias");
  });

  it("canonical tt-ts provisioning through the CLI is unchanged (no alias)", () => {
    const res = runProvision([
      "--fixture", "tt-ts",
      "--case-id", "W1.X1-canonical-cli",
      "--golden-dir", goldenDir,
      "--work-dir", workDir,
    ]);
    assert.equal(res.status, 0, `canonical provision must exit 0:\n${res.stdout}${res.stderr}`);
    const verdict = JSON.parse((res.stdout ?? "").trim());
    assert.equal(verdict.ok, true);
    assert.equal(verdict.fixture, "tt-ts", "canonical verdict must echo the fixture name");
    assert.equal(verdict.canonicalFixture, "tt-ts", "canonical verdict must not rewrite canonicalFixture");
    assert.equal(verdict.fixtureAlias, false, "a canonical fixture must not be flagged as an alias");
    assert.equal(path.basename(verdict.workClonePath), "tt-ts", "clone dir must be the plain fixture name");
    assert.equal(verdict.target.finalBranch, "main", "canonical baseline clone must land on main");
  });
});
