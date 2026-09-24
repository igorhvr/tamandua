// origin-pins.test.mjs — self-test gate for the tt-storm-aged origin-pins
// verification (US-002).  Builds a synthetic owned tt-poly-shaped origin
// (bare + working clone + hash ledger) and asserts every pin resolves, that a
// corrupted pin / drifted FIXTURES_SRC flips the verdict, and that the
// seed/storm ref resolution is checked — no real model, no live state.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseTtPolyHashes,
  verifyTtPolyOriginMaterial,
  buildOriginPinsManifest,
  writeOriginPinsManifest,
  buildOwnedTtPolyOrigin,
} from "../origin-pins.mjs";
import { hashFixtureSourceDir } from "../../bin/tt-golden-bootstrap.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || "").trim()}`);
  }
  return (res.stdout || "").trim();
}

function commit(cwd, message, writeFile) {
  if (writeFile) writeFile(cwd);
  run(["add", "-A"], cwd);
  run(["commit", "--no-gpg-sign", "-q", "-m", message], cwd);
  return run(["rev-parse", "HEAD"], cwd);
}

// Build a synthetic tt-poly-shaped material: a fixture SOURCE tree (for
// FIXTURES_SRC), a seed-work repo, a bare clone, and a working origin clone
// checked out at seed/storm.  Returns { dir, fixturesSrcDir, bareDir, originDir,
// hashesContent } with real SHA pins.
function buildSyntheticMaterial() {
  const dir = tmpDir("origin-pins-test-");
  const fixturesSrcDir = path.join(dir, "fixtures-src");
  const seedWork = path.join(dir, "seed-work");
  const bareDir = path.join(dir, "tt-poly.git");
  const originDir = path.join(dir, "origin");

  fs.mkdirSync(fixturesSrcDir, { recursive: true });
  fs.writeFileSync(path.join(fixturesSrcDir, "README.md"), "synthetic fixture source\n", "utf-8");
  fs.mkdirSync(path.join(fixturesSrcDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixturesSrcDir, "src", "a.txt"), "a\n", "utf-8");

  fs.mkdirSync(seedWork, { recursive: true });
  run(["init", "-b", "main"], seedWork);
  run(["config", "user.email", "origin-pins-test@localhost"], seedWork);
  run(["config", "user.name", "origin-pins-test"], seedWork);

  const baseline = commit(seedWork, "baseline", (cwd) => {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "README.md"), "baseline\n", "utf-8");
    // Track a file under src/ so the directory survives every branch checkout.
    fs.writeFileSync(path.join(cwd, "src", "base.txt"), "base\n", "utf-8");
  });

  run(["checkout", "-q", "-b", "seed/POLY-BUG-P1"], seedWork);
  const pinP1 = commit(seedWork, "seed POLY-BUG-P1", (cwd) => {
    fs.writeFileSync(path.join(cwd, "src", "p1.txt"), "p1\n", "utf-8");
  });

  run(["checkout", "-q", "main"], seedWork);
  run(["checkout", "-q", "-b", "broken-tests"], seedWork);
  const brokenTests = commit(seedWork, "broken-tests", (cwd) => {
    fs.writeFileSync(path.join(cwd, "src", "broken.txt"), "broken\n", "utf-8");
  });

  run(["checkout", "-q", "main"], seedWork);
  run(["checkout", "-q", "-b", "seed/storm"], seedWork);
  const seedStorm = commit(seedWork, "seed/storm composite", (cwd) => {
    fs.writeFileSync(path.join(cwd, "src", "storm.txt"), "storm\n", "utf-8");
  });

  // Bare clone retains every ref; origin clone lands on seed/storm.
  run(["clone", "--bare", "--quiet", seedWork, bareDir], seedWork);
  run(["clone", "--quiet", "-b", "seed/storm", bareDir, originDir], dir);

  const fixturesSrc = hashFixtureSourceDir(fixturesSrcDir);
  const hashesContent = [
    `baseline=${baseline}`,
    `seed/POLY-BUG-P1=${pinP1}`,
    `broken-tests=${brokenTests}`,
    `seed/storm=${seedStorm}`,
    `FIXTURES_SRC=${fixturesSrc}`,
  ].join("\n") + "\n";

  return {
    dir, fixturesSrcDir, bareDir, originDir, hashesContent,
    baseline, pinP1, brokenTests, seedStorm,
  };
}

test("parseTtPolyHashes parses the tt-poly.git.hashes ledger shape", () => {
  const parsed = parseTtPolyHashes([
    "baseline=7baf511c7b3f93cece2ba730907ba6825d811674",
    "seed/POLY-BUG-P1=c9d68f6ea7cf2f27e1d4a92fddde91a42349322e",
    "seed/POLY-VULN-T1=7baf511c7b3f93cece2ba730907ba6825d811674",
    "broken-tests=26271aef3ae60ff745d8441be7ab86b6fbc9f27f",
    "seed/storm=b2c71e39d506a327e0aca6e29534c67627acd667",
    "FIXTURES_SRC=f8e700b2415f8f8f95f5a475b5d45cfff4552c9a83f5767e2c9cc0d5650615f4",
    "  # a comment line that must be ignored",
  ].join("\n"));

  assert.equal(parsed.baseline, "7baf511c7b3f93cece2ba730907ba6825d811674");
  assert.deepEqual(parsed.seedPins, [
    { name: "POLY-BUG-P1", sha: "c9d68f6ea7cf2f27e1d4a92fddde91a42349322e" },
    { name: "POLY-VULN-T1", sha: "7baf511c7b3f93cece2ba730907ba6825d811674" },
  ]);
  assert.equal(parsed.brokenTests, "26271aef3ae60ff745d8441be7ab86b6fbc9f27f");
  assert.equal(parsed.seedStorm, "b2c71e39d506a327e0aca6e29534c67627acd667");
  assert.equal(parsed.fixturesSrc, "f8e700b2415f8f8f95f5a475b5d45cfff4552c9a83f5767e2c9cc0d5650615f4");
  // seed/storm is NOT a plain seed pin.
  assert.ok(!parsed.seedPins.some((p) => p.name === "storm"), "seed/storm must be separated from seed/* pins");
});

test("verifyTtPolyOriginMaterial accepts an intact synthetic origin (every pin resolves)", () => {
  const m = buildSyntheticMaterial();
  try {
    const verify = verifyTtPolyOriginMaterial({
      originDir: m.originDir,
      bareDir: m.bareDir,
      hashesContent: m.hashesContent,
      fixturesSrcDir: m.fixturesSrcDir,
    });
    assert.equal(verify.ok, true);
    assert.equal(verify.originHead, m.seedStorm, "origin HEAD is the seed/storm composite");
    assert.equal(verify.originTree.length, 40);
    assert.equal(verify.baseline.origin.ok, true);
    assert.equal(verify.baseline.bare.ok, true);
    assert.equal(verify.seedPins.length, 1);
    assert.equal(verify.seedPins[0].name, "POLY-BUG-P1");
    assert.equal(verify.brokenTests.origin.ok, true);
    assert.equal(verify.seedStorm.origin.ok, true);
    assert.equal(verify.seedStorm.seedStormRef.origin, true, "seed/storm ref resolves to the recorded SHA");
    assert.equal(verify.fixturesSrc.ok, true, "FIXTURES_SRC content hash matches");
  } finally {
    fs.rmSync(m.dir, { recursive: true, force: true });
  }
});

test("verifyTtPolyOriginMaterial refuses a corrupted seed pin", () => {
  const m = buildSyntheticMaterial();
  try {
    const corrupted = m.hashesContent.replace(
      `seed/POLY-BUG-P1=${m.pinP1}`,
      `seed/POLY-BUG-P1=${"0".repeat(40)}`,
    );
    const verify = verifyTtPolyOriginMaterial({
      originDir: m.originDir,
      bareDir: m.bareDir,
      hashesContent: corrupted,
      fixturesSrcDir: m.fixturesSrcDir,
    });
    assert.equal(verify.ok, false);
    assert.equal(verify.seedPins[0].origin.ok, false);
    assert.equal(verify.seedPins[0].origin.type, null);
  } finally {
    fs.rmSync(m.dir, { recursive: true, force: true });
  }
});

test("verifyTtPolyOriginMaterial flags a drifted FIXTURES_SRC content hash", () => {
  const m = buildSyntheticMaterial();
  try {
    // Drift the source tree AFTER the ledger was written.
    fs.writeFileSync(path.join(m.fixturesSrcDir, "src", "drift.txt"), "drifted\n", "utf-8");
    const verify = verifyTtPolyOriginMaterial({
      originDir: m.originDir,
      bareDir: m.bareDir,
      hashesContent: m.hashesContent,
      fixturesSrcDir: m.fixturesSrcDir,
    });
    assert.equal(verify.fixturesSrc.ok, false);
    assert.equal(verify.ok, false);
  } finally {
    fs.rmSync(m.dir, { recursive: true, force: true });
  }
});

test("verifyTtPolyOriginMaterial detects a seed/storm ref that no longer resolves to the recorded SHA", () => {
  const m = buildSyntheticMaterial();
  try {
    // Move the origin's LOCAL seed/storm ref off the recorded commit (the
    // object still exists, so the pin sha itself resolves, but the ref does
    // not — the seed instantiates from the REF).  update-ref bypasses the
    // checked-out-branch protection that `git branch -f` enforces.
    run(["update-ref", "refs/heads/seed/storm", m.brokenTests], m.originDir);
    const verify = verifyTtPolyOriginMaterial({
      originDir: m.originDir,
      bareDir: m.bareDir,
      hashesContent: m.hashesContent,
      fixturesSrcDir: m.fixturesSrcDir,
    });
    assert.equal(verify.seedStorm.origin.ok, true, "the commit object still resolves");
    assert.equal(verify.seedStorm.seedStormRef.origin, false, "the seed/storm REF no longer matches");
    assert.equal(verify.ok, false);
  } finally {
    fs.rmSync(m.dir, { recursive: true, force: true });
  }
});

test("buildOriginPinsManifest + writeOriginPinsManifest record origin path/sha/tree and every pin", () => {
  const m = buildSyntheticMaterial();
  try {
    const manifest = buildOriginPinsManifest({
      originDir: m.originDir,
      bareDir: m.bareDir,
      hashesContent: m.hashesContent,
      fixturesSrcDir: m.fixturesSrcDir,
    });
    assert.equal(manifest.schema, "storm-origin-pins");
    assert.equal(manifest.origin.path, fs.realpathSync(m.originDir));
    assert.equal(manifest.origin.sha, m.seedStorm);
    assert.equal(manifest.origin.tree.length, 40);
    assert.equal(manifest.pins.baseline, m.baseline);
    assert.deepEqual(manifest.pins.seed, [{ name: "POLY-BUG-P1", sha: m.pinP1 }]);
    assert.equal(manifest.pins.broken_tests, m.brokenTests);
    assert.equal(manifest.pins.seed_storm, m.seedStorm);
    assert.equal(manifest.verification.ok, true);
    assert.equal(manifest.verification.seed_storm_ref_resolves, true);
    assert.equal(manifest.verification.diagnostics, null, "a passing verification carries no refusal diagnostics");

    const outPath = path.join(m.dir, "storm-origin-pins-test.json");
    writeOriginPinsManifest(outPath, manifest);
    const reread = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    assert.equal(reread.origin.sha, m.seedStorm);
    assert.equal(reread.pins.broken_tests, m.brokenTests);
  } finally {
    fs.rmSync(m.dir, { recursive: true, force: true });
  }
});

// A refused verification must carry the recorded-vs-observed reasons, never
// silently drop them (US-003: supplied material judged unusable).
test("buildOriginPinsManifest records refusal diagnostics for a drifted origin", () => {
  const m = buildSyntheticMaterial();
  try {
    fs.writeFileSync(path.join(m.fixturesSrcDir, "src", "drift.txt"), "drifted\n", "utf-8");
    const verification = verifyTtPolyOriginMaterial({
      originDir: m.originDir,
      bareDir: m.bareDir,
      hashesContent: m.hashesContent,
      fixturesSrcDir: m.fixturesSrcDir,
    });
    assert.equal(verification.ok, false);
    const manifest = buildOriginPinsManifest({
      originDir: m.originDir,
      bareDir: m.bareDir,
      hashesContent: m.hashesContent,
      fixturesSrcDir: m.fixturesSrcDir,
      verification,
    });
    assert.equal(manifest.verification.ok, false);
    assert.ok(manifest.verification.diagnostics, "a refusal records diagnostics");
    assert.equal(manifest.verification.diagnostics.fixtures_src.ok, false);
    assert.equal(manifest.verification.diagnostics.fixtures_src.expected, m.hashesContent.match(/FIXTURES_SRC=(\w+)/)[1]);
    assert.notEqual(manifest.verification.diagnostics.fixtures_src.actual, m.hashesContent.match(/FIXTURES_SRC=(\w+)/)[1]);
  } finally {
    fs.rmSync(m.dir, { recursive: true, force: true });
  }
});

// US-003: when the supplied origin is unusable (fixtures-src drift), a fresh
// OWNED origin is built from the current fixtures-src via the canonical golden
// bootstrap and verified by the SAME checks, with the supplied-origin working
// tree shape (main / broken-tests / seed/storm, HEAD on main, main at the
// composite storm tip).
test("buildOwnedTtPolyOrigin builds + verifies a fresh owned tt-poly origin from the current fixtures-src", () => {
  const outDir = tmpDir("owned-origin-build-");
  try {
    const res = buildOwnedTtPolyOrigin({ outDir });
    assert.equal(res.ok, true, `build stage: ${res.stage}`);
    assert.equal(res.stage, "verified");
    assert.equal(res.verify.ok, true);
    assert.equal(res.verify.fixturesSrc.ok, true, "FIXTURES_SRC matches the current fixtures-src");
    assert.equal(res.verify.fixturesSrc.expected, hashFixtureSourceDir(res.fixturesSrcDir));
    assert.equal(res.verify.originHead, res.verify.parsed.seedStorm, "HEAD is the composite seed/storm tip");
    assert.equal(res.verify.seedStorm.seedStormRef.origin, true);
    assert.equal(res.verify.baseline.origin.ok, true);
    assert.equal(res.verify.brokenTests.origin.ok, true);
    assert.ok(res.verify.seedPins.length > 0 && res.verify.seedPins.every((p) => p.origin.ok && p.bare.ok));

    const heads = run(["for-each-ref", "--format=%(refname:short)", "refs/heads"], res.originDir)
      .split("\n").filter(Boolean).sort();
    assert.deepEqual(heads, ["broken-tests", "main", "seed/storm"]);
    assert.equal(run(["rev-parse", "--abbrev-ref", "HEAD"], res.originDir), "main");
    assert.equal(run(["rev-parse", "main"], res.originDir), res.verify.parsed.seedStorm,
      "local main carries the composite storm content the seed instantiates from");
    assert.equal(run(["rev-parse", "broken-tests"], res.originDir), res.verify.parsed.brokenTests);

    const manifest = buildOriginPinsManifest({
      originDir: res.originDir,
      bareDir: res.bareDir,
      hashesContent: fs.readFileSync(res.hashesPath, "utf-8"),
      fixturesSrcDir: res.fixturesSrcDir,
      verification: res.verify,
    });
    assert.equal(manifest.verification.ok, true);
    assert.equal(manifest.origin.main_ref, "main");
    assert.equal(manifest.origin.sha, res.verify.parsed.seedStorm);
    assert.equal(manifest.pins.seed_storm, res.verify.parsed.seedStorm);
    assert.equal(manifest.pins.fixtures_src, res.verify.parsed.fixturesSrc);

    // Idempotent: a second call re-verifies the same golden without rebuilding.
    const again = buildOwnedTtPolyOrigin({ outDir });
    assert.equal(again.ok, true);
    assert.equal(again.build.built, false, "a valid golden is a no-op, never rebuilt");
    assert.equal(again.verify.parsed.seedStorm, res.verify.parsed.seedStorm);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
