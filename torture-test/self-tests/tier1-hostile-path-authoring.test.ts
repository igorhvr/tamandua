// US-009 — S14: W1.X1 hostile-path authoring (fixture alias + root-relative
// boundaries).
//
// W1.X1's premise (spec 02 path-hostility probe, spec 05 #W1.X1) is that the
// WORK CLONE PATH itself contains a space and a non-ASCII char. The campaign
// review (S14) found the case was provisioned at a plain path. This test pins
// the authoring + provisioning-data fix with zero tokens:
//
//   * cases/tier1.jsonl W1.X1-ts carries the reserved hostile-path alias
//     fixture 'tt-ts café' (U+0020 space + é U+00E9), with boundary_files /
//     forbidden authored WORK-CLONE-ROOT-relative (["src"] /
//     ["operator-notes.local"]) — each path exists in fixtures-src/tt-ts, so
//     O8's fixtures-src/<fixture>/ prefix rebase is a no-op for the alias.
//   * The tier1 manifest still validates through the PRODUCTION controller
//     (--validate-only, 28 cases).
//   * The task file and the tier1-traceability.md row describe the
//     hostile-path provisioning mechanism (the harness provisions the clone
//     at a hostile path; the suite command is npm test).
//   * bin/tt-fixture-provision.mjs resolves the alias to canonical tt-ts for
//     golden-bare / arming lookups while the work clone directory keeps the
//     authored alias name VERBATIM (the probe), and an unlisted non-canonical
//     fixture still fails closed as unknown-fixture.
//
// Zero tokens: no pi/hermes process can ever be spawned — every child
// inherits TAMANDUA_PI_BINARY/TAMANDUA_HERMES_BINARY=/usr/bin/false. Goldens
// are built into fresh temp dirs under os.tmpdir(). Files only inside
// torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { FIXTURE_ALIASES, provisionWorkClone, resolveFixtureAlias } from "../bin/tt-fixture-provision.mjs";
import { ensureGoldenBare } from "../bin/tt-golden-bootstrap.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");
const w1x1Task = path.join(ttRoot, "cases", "tasks", "tier1", "W1.X1-ts.md");
const traceability = path.join(ttRoot, "cases", "tier1-traceability.md");
const ttTsSource = path.join(ttRoot, "fixtures-src", "tt-ts");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function readTier1Cases(): Array<{ raw: string; parsed: any }> {
  return fs
    .readFileSync(tier1Manifest, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((raw) => ({ raw, parsed: JSON.parse(raw) }));
}

function w1x1() {
  const cases = readTier1Cases();
  assert.equal(cases.length, 28, "tier1 manifest must keep 28 lines");
  const c = cases.find((x) => x.parsed.id === "W1.X1-ts");
  assert.ok(c, "W1.X1-ts must exist in tier1.jsonl");
  return c;
}

function runValidate(): { status: number; stdout: string; stderr: string } {
  return spawnSync(controller, ["--manifest", tier1Manifest, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// ── Hermetic temp goldens + work dir (zero tokens, os.tmpdir only) ───────
let goldenDir: string;
let workDir: string;

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w1x1-golden-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w1x1-work-"));
  const res = ensureGoldenBare({ fixture: "tt-ts", goldenDir });
  assert.ok(res.ok, `tt-ts golden bootstrap must succeed:\n${JSON.stringify(res)}`);
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("W1.X1 hostile-path authoring (E3.A US-009)", () => {
  it("W1.X1-ts manifest line carries the reserved hostile-path alias fixture 'tt-ts café'", () => {
    const c = w1x1();
    assert.equal(c.parsed.fixture, "tt-ts café", "fixture must be exactly 'tt-ts café'");
    assert.ok(c.parsed.fixture.includes(" "), "fixture must contain U+0020 (space)");
    assert.ok(
      [...c.parsed.fixture].some((ch) => ch.charCodeAt(0) > 127),
      "fixture must contain at least one non-ASCII character",
    );
    assert.ok(!/[\t\n\r]/.test(c.parsed.fixture), "fixture must not contain control characters");
    assert.equal(c.parsed.workflow, "do-now", "W1.X1 must stay a do-now case");
    assert.equal(c.parsed.harness, "pi", "W1.X1 must stay a pi case");
    assert.equal(c.parsed.context?.test_cmd, "npm test", "W1.X1 test_cmd stays npm test (US-002)");
  });

  it("W1.X1 boundary_files/forbidden are work-clone-root-relative and exist in fixtures-src/tt-ts", () => {
    const c = w1x1();
    assert.deepEqual(c.parsed.boundary_files, ["src"], "boundary_files must be exactly ['src'] (work-clone-root-relative)");
    assert.deepEqual(c.parsed.forbidden, ["operator-notes.local"], "forbidden must be exactly ['operator-notes.local']");
    for (const declaration of [...c.parsed.boundary_files, ...c.parsed.forbidden]) {
      assert.ok(
        !declaration.includes("fixtures-src/"),
        `declaration ${JSON.stringify(declaration)} must not carry the fixtures-src/ prefix`,
      );
      assert.ok(
        fs.existsSync(path.join(ttTsSource, declaration)),
        `declaration ${JSON.stringify(declaration)} must exist in fixtures-src/tt-ts`,
      );
    }
    assert.ok(fs.statSync(path.join(ttTsSource, "src")).isDirectory(), "fixtures-src/tt-ts/src must be a directory");
    assert.ok(fs.statSync(path.join(ttTsSource, "operator-notes.local")).isFile(), "fixtures-src/tt-ts/operator-notes.local must be a file");
  });

  it("tier1 manifest with the hostile alias validates through the production validator (28 cases)", () => {
    const res = runValidate();
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });

  it("W1.X1 task text describes the hostile-path provisioning mechanism", () => {
    const task = fs.readFileSync(w1x1Task, "utf8");
    assert.match(task, /tt-ts café/, "task must name the fixture alias 'tt-ts café'");
    assert.match(task, /space/, "task must state the path contains a space");
    assert.match(task, /non-ASCII/, "task must state the path contains a non-ASCII character");
    assert.match(task, /U\+00E9/, "task must name the é code point");
    assert.match(task, /provisions/, "task must state the harness provisions the work clone");
    assert.match(task, /work from that provisioned clone/, "task must instruct the agent to work from the provisioned clone");
    assert.match(task, /`npm test`/, "task must state the suite command npm test");
    assert.ok(!task.includes("TEST_CMD"), "task must name the concrete npm test command, not an indirection");
  });

  it("tier1-traceability.md W1.X1 row reflects the hostile-path alias", () => {
    const table = fs.readFileSync(traceability, "utf8");
    assert.match(
      table,
      /\| W1\.X1-ts \| `#W1\.X1` \| tt-ts café \(hostile-path alias\) \| pi \| do-now \| real \|/,
      "traceability W1.X1 fixture cell must be 'tt-ts café (hostile-path alias)'",
    );
  });

  it("provisioning W1.X1 through the production adapter lands the clone in a hostile-named directory with tt-ts content", () => {
    const res = provisionWorkClone({ fixture: "tt-ts café", caseId: "W1.X1-ts", goldenDir, workDir });
    assert.ok(res.ok, `alias provisioning must succeed:\n${JSON.stringify(res)}`);
    assert.equal(res.fixture, "tt-ts café", "result must echo the authored fixture name");
    assert.equal(res.canonicalFixture, "tt-ts", "result must report the canonical fixture");
    assert.equal(res.fixtureAlias, true, "result must flag the alias");
    assert.equal(path.basename(res.workClonePath), "tt-ts café", "clone directory must keep the alias name verbatim");
    assert.ok(res.workClonePath.includes(" "), "work clone path must contain a space");
    assert.ok(
      [...res.workClonePath].some((ch) => ch.charCodeAt(0) > 127),
      "work clone path must contain a non-ASCII character",
    );
    // The hostile path resolves to canonical tt-ts CONTENT.
    const pkg = JSON.parse(fs.readFileSync(path.join(res.workClonePath, "package.json"), "utf8"));
    assert.equal(pkg.name, "expense-tracker", "clone content must be the canonical tt-ts fixture");
    assert.ok(fs.statSync(path.join(res.workClonePath, "src")).isDirectory(), "clone must carry src/");
    assert.equal(res.target.kind, "baseline", "W1.X1 has no seed: must land on the green baseline");
    assert.equal(res.operatorNotesPlanted, true, "operator-notes.local must be planted by the canonical arm");
    assert.ok(fs.existsSync(path.join(res.workClonePath, "operator-notes.local")), "planted junk must exist in the clone");
  });

  it("canonical fixture provisioning is unchanged (no alias, no hostile path)", () => {
    const res = provisionWorkClone({ fixture: "tt-ts", caseId: "W1.X1-canonical-check", goldenDir, workDir });
    assert.ok(res.ok, `canonical provisioning must succeed:\n${JSON.stringify(res)}`);
    assert.equal(res.fixture, "tt-ts");
    assert.equal(res.canonicalFixture, "tt-ts");
    assert.equal(res.fixtureAlias, false, "canonical fixture must not be flagged as an alias");
    assert.equal(path.basename(res.workClonePath), "tt-ts");
    assert.ok(fs.statSync(path.join(res.workClonePath, "src")).isDirectory(), "canonical clone must carry src/");
  });

  it("an unlisted non-canonical fixture name fails closed as unknown-fixture", () => {
    const res = provisionWorkClone({ fixture: "tt-ts cafe", caseId: "W1.X1-ts", goldenDir, workDir });
    assert.ok(!res.ok, "unlisted alias-like name must fail closed");
    assert.equal(res.reason.category, "unknown-fixture");
  });

  it("the alias registry is exactly the reserved set and the resolver is fail-closed", () => {
    assert.deepEqual(FIXTURE_ALIASES, { "tt-ts café": "tt-ts" }, "the registry must list exactly the reserved alias");
    assert.deepEqual(resolveFixtureAlias("tt-ts café"), { fixture: "tt-ts café", canonical: "tt-ts", isAlias: true });
    assert.deepEqual(resolveFixtureAlias("tt-ts"), { fixture: "tt-ts", canonical: "tt-ts", isAlias: false });
    assert.deepEqual(resolveFixtureAlias("tt-ts cafe"), { fixture: "tt-ts cafe", canonical: "tt-ts cafe", isAlias: false });
    assert.deepEqual(resolveFixtureAlias(""), { fixture: "", canonical: "", isAlias: false });
  });
});
