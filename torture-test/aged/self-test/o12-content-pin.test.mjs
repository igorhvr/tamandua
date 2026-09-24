// o12-content-pin.test.mjs — US-005 self-test gate for the content-addressed
// O12 pin primitives in torture-test/aged/validate.mjs.
//
// NPF-2 Part 2: the O12 pin must be content-addressed so a merge-worktree
// squash (which rewrites the story commit hash) can never invalidate it.  This
// file proves the primitives directly:
//   A. the documented content set + pin constants are exported and shaped
//   B. the current tree hashes to the embedded O12_PINNED_CONTENT_SHA256
//   C. mutating ANY pinned file (in a temp copy) changes the hash
//   D. materializePinnedOracle materializes from HEAD (a dirty worktree is
//      ignored) and returns the pinned content hash
//   E. materializePinnedOracle fails closed (throws) when HEAD content drifts
//   F. writeValidationReport's o12_pin carries content_sha256 / provenance
//
// Run ALONE (one node --test file) under TAMANDUA_TEST_GUARD=1 with
// TAMANDUA_PI_BINARY=TAMANDUA_HERMES_BINARY=TAMANDUA_DSH_BINARY=/usr/bin/false.
// This file never opens live state, spawns a daemon, or runs a storm.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
// torture-test/aged/self-test -> repo root (three levels up)
const ROOT = process.env.TT_STORM_AGED_REPO_ROOT ?? path.resolve(HERE, "..", "..", "..");
const VALIDATE = path.resolve(HERE, "..", "validate.mjs");

// The story's documented minimum O12 content set.
const EXPECTED_PATHS = [
  "torture-test/oracles/O12",
  "torture-test/oracles/lib/o12.mjs",
  "torture-test/oracles/O12-CONTRACT.md",
  "torture-test/oracles/self-test/generate-o12-fixtures.mjs",
  "torture-test/oracles/self-test/o12-fixture-matrix.mjs",
  "torture-test/oracles/self-test/o12.test.mjs",
  "torture-test/oracles/self-test/o12-schema-version.test.mjs",
  "torture-test/oracles/self-test/o12-seed-snapshot.test.mjs",
  "torture-test/oracles/self-test/run-o12-gate-self-tests.mjs",
];

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function gitCommitAll(repo, message) {
  const ident = [
    "-c", "user.email=o12-content-pin-selftest@example.com",
    "-c", "user.name=O12 Content Pin Self Test",
    "-c", "commit.gpgsign=false",
  ];
  git(repo, [...ident, "add", "-A"]);
  git(repo, [...ident, "commit", "-q", "-m", message]);
}

function copyPinnedSet(srcRoot, destRoot) {
  for (const rel of EXPECTED_PATHS) {
    const dst = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(srcRoot, rel), dst);
  }
}

test("A. content-pin exports: documented path set, 64-hex content pin, provenance sha + subject", async () => {
  const v = await import(VALIDATE);
  assert.ok(Array.isArray(v.O12_ORACLE_CONTENT_PATHS), "O12_ORACLE_CONTENT_PATHS must be an array");
  assert.deepEqual(
    [...v.O12_ORACLE_CONTENT_PATHS].sort(),
    [...EXPECTED_PATHS].sort(),
    "the documented O12 content set must be pinned exactly (no silent additions/removals)",
  );
  assert.equal(typeof v.computeO12OracleContentHash, "function");
  assert.match(v.O12_PINNED_CONTENT_SHA256, /^[0-9a-f]{64}$/, "content pin must be a 64-hex sha256");
  assert.match(v.O12_PINNED_PROVENANCE_COMMIT, /^[0-9a-f]{40}$/, "provenance commit must be a full sha");
  assert.equal(v.O12_PINNED_PROVENANCE_COMMIT.slice(0, 8), "7fe9f258", "provenance is the run's base HEAD 7fe9f258 (a real ancestor, never a pre-squash story commit)");
  assert.equal(typeof v.O12_PINNED_PROVENANCE_SUBJECT, "string");
  assert.ok(v.O12_PINNED_PROVENANCE_SUBJECT.length > 0);
  for (const rel of v.O12_ORACLE_CONTENT_PATHS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `pinned O12 content missing from the tree: ${rel}`);
  }
});

test("B. computeO12OracleContentHash(current tree) equals the embedded pin", async () => {
  const v = await import(VALIDATE);
  assert.equal(v.computeO12OracleContentHash({ repoRoot: ROOT }), v.O12_PINNED_CONTENT_SHA256);
  assert.throws(() => v.computeO12OracleContentHash({}), /repoRoot is required/);
  // Deterministic across calls.
  assert.equal(
    v.computeO12OracleContentHash({ repoRoot: ROOT }),
    v.computeO12OracleContentHash({ repoRoot: ROOT }),
  );
});

test("C. mutating ANY pinned file in a temp copy changes the content hash", async () => {
  const v = await import(VALIDATE);
  const dir = tmpDir("o12-pin-mutate-");
  copyPinnedSet(ROOT, dir);
  const baseline = v.computeO12OracleContentHash({ repoRoot: dir });
  assert.equal(baseline, v.O12_PINNED_CONTENT_SHA256, "an unmodified copy must hash to the pin");
  for (const rel of EXPECTED_PATHS) {
    const abs = path.join(dir, rel);
    const original = fs.readFileSync(abs);
    fs.writeFileSync(abs, Buffer.concat([original, Buffer.from("\n/* o12-content-pin mutation */\n")]));
    const mutated = v.computeO12OracleContentHash({ repoRoot: dir });
    assert.notEqual(mutated, baseline, `mutating ${rel} must change the content hash`);
    fs.writeFileSync(abs, original);
    assert.equal(v.computeO12OracleContentHash({ repoRoot: dir }), baseline, `restore of ${rel} must restore the hash`);
  }
});

test("D. materializePinnedOracle materializes from HEAD (dirty worktree ignored) and returns the pin", async () => {
  const v = await import(VALIDATE);
  const repo = tmpDir("o12-pin-head-");
  git(repo, ["init", "-q"]);
  copyPinnedSet(ROOT, repo);
  gitCommitAll(repo, "o12 content set");
  // Dirty the worktree AFTER the commit: materialization must read HEAD, not
  // the working tree (the durable source is the committed content).
  const dirtyRel = "torture-test/oracles/lib/o12.mjs";
  fs.appendFileSync(path.join(repo, dirtyRel), "\n// WORKING-TREE-DIRTY-MARKER\n");

  const dest = tmpDir("o12-pin-head-dest-");
  const res = v.materializePinnedOracle({ gitRepo: repo, destDir: dest });
  assert.equal(res.content_sha256, v.O12_PINNED_CONTENT_SHA256);
  assert.ok(res.count >= EXPECTED_PATHS.length, `materialized ${res.count} files`);
  for (const rel of EXPECTED_PATHS) {
    assert.ok(fs.existsSync(path.join(dest, rel)), `materialized missing: ${rel}`);
  }
  const materialized = fs.readFileSync(path.join(dest, dirtyRel));
  assert.equal(
    materialized.includes(Buffer.from("WORKING-TREE-DIRTY-MARKER")),
    false,
    "materialized content must come from committed HEAD, never the dirty worktree",
  );
  // The materialized set hashes identically to the source repo's content.
  assert.equal(v.computeO12OracleContentHash({ repoRoot: dest }), v.O12_PINNED_CONTENT_SHA256);
});

test("E. materializePinnedOracle fails closed when HEAD content drifts from the pin", async () => {
  const v = await import(VALIDATE);
  const repo = tmpDir("o12-pin-drift-");
  git(repo, ["init", "-q"]);
  copyPinnedSet(ROOT, repo);
  gitCommitAll(repo, "o12 content set");
  // Commit drift into HEAD: the CONTENT pin must reject it (fail closed).
  fs.appendFileSync(path.join(repo, "torture-test/oracles/lib/o12.mjs"), "\n// HEAD-DRIFT\n");
  gitCommitAll(repo, "drift the O12 oracle content");

  const dest = tmpDir("o12-pin-drift-dest-");
  assert.throws(
    () => v.materializePinnedOracle({ gitRepo: repo, destDir: dest }),
    /O12 content drift/,
  );
});

test("F. writeValidationReport o12_pin carries content_sha256, provenance_commit and provenance_subject", async () => {
  const v = await import(VALIDATE);
  const root = tmpDir("o12-pin-report-");
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  const file = v.writeValidationReport({
    seedRoot: root,
    matrix: [],
    o12Evidence: { oracle: "O12", result: "PASS" },
  });
  const report = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.match(report.o12_pin.content_sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.o12_pin.content_sha256, v.O12_PINNED_CONTENT_SHA256);
  assert.equal(report.o12_pin.provenance_commit, v.O12_PINNED_PROVENANCE_COMMIT);
  assert.equal(report.o12_pin.provenance_subject, v.O12_PINNED_PROVENANCE_SUBJECT);
  // The existing acceptance fields remain (additive migration).
  assert.equal(report.o12_pin.acceptance, v.O12_PINNED_ACCEPTANCE);
  assert.ok(report.o12_pin.acceptance_detail);
  assert.equal(report.o12_pin.commit, v.O12_PINNED_COMMIT);
  assert.equal(report.o12_pin.tree, v.O12_PINNED_TREE);
  assert.equal(report.o12_pin.subject, v.O12_PINNED_SUBJECT);
});
