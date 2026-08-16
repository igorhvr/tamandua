#!/usr/bin/env node
/**
 * W4.22 symlinked temp/var fixture paths — both directions, no false
 * containment/validation failures (spec 08 §H W4.22). Zero-token scripted
 * cell, platform-generic runner (the manifest gates platform darwin — the
 * spec's [darwin] marker; the runner models the `/var` → `/private/var`
 * symlink itself so the corridor machinery is validated on any
 * symlink-capable host).
 *
 * The corridor: fixture paths in SYMLINKED form vs REALPATH form, both
 * directions. No false containment/validation failures in worktree checks,
 * gates, TSTX hashing.
 *
 * The runner builds a scratch fixture repo at a REALPATH location, creates a
 * SYMLINKED alias to it (modeling /var -> /private/var), then runs three
 * check classes on BOTH forms and asserts parity:
 *
 *   (1) Worktree checks — `git -C <form> worktree list --porcelain`:
 *       identical output, exit 0, for the symlinked form and the realpath
 *       form (a false failure would be a non-zero exit or differing output
 *       through the symlink).
 *   (2) TSTX hashing — `git -C <form> rev-parse HEAD^{tree}`: identical tree
 *       hash for both forms (the TSTX tree key is path-form-independent; a
 *       false failure would be a differing hash / an origin-identity split).
 *   (3) Containment / gates — the REAL containment machinery
 *       (bin/tt-containment.mjs assertContainedHome) must accept BOTH forms
 *       (they resolve inside torture-test/var — no false containment
 *       failure) AND reject a CONTROL symlink pointing outside var (no false
 *       acceptance either — the gate still holds through the symlink).
 *
 * Both directions: (a) realpath → symlink (each check with the realpath
 * form first, then the symlinked form) and (b) symlink → realpath
 * (fs.realpathSync resolution, then the checks on the resolved path).
 *
 * Zero tokens: no workflow launch, no pi/hermes/dsh invocation; the ledger
 * tripwire must stay 0.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { assertContainedHome } from "../../../bin/tt-containment.mjs";

function requiredValue(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} must be set`);
  return value;
}
function requiredPath(name) {
  const value = requiredValue(name);
  assert.ok(path.isAbsolute(value), `${name} must be an absolute path`);
  return value;
}

const repoRoot = requiredPath("TT_REPO_ROOT");
const invocationDir = requiredPath("TT_SCENARIO_STATE_DIR");
const scenarioId = requiredValue("TT_SCENARIO_ID");
const stateDir = requiredPath("TAMANDUA_STATE_DIR");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, "w4.22-symlink-path-parity", "scenario id mismatch");

const dbPath = path.join(stateDir, "tamandua.db");
const varRoot = path.join(repoRoot, "torture-test", "var");

// Scratch fixture repo at a REALPATH location + its symlinked alias.
const realDir = path.join(invocationDir, "fixtures-real");
const linkDir = path.join(invocationDir, "fixtures-link");
const realRepo = path.join(realDir, "repo");
const linkRepo = path.join(linkDir, "repo");
// Control symlink pointing OUTSIDE torture-test/var (must be rejected).
const escapeDir = path.join(invocationDir, "escape-link");

for (const candidate of [realDir, linkDir, escapeDir]) {
  assert.ok(
    candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.22 mutable path escaped torture-test/var: ${candidate}`,
  );
}

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function gitOk(args, cwd, label) {
  const result = git(args, cwd);
  assert.equal(result.status, 0, `${label}: git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

// ── setup: scratch fixture repo + symlink alias ──────────────────────

fs.mkdirSync(realRepo, { recursive: true });
gitOk(["init", "-b", "main"], realRepo, "setup");
gitOk(["config", "user.email", "w4.22@tamandua.local"], realRepo, "setup");
gitOk(["config", "user.name", "W4.22 Symlink Path Parity"], realRepo, "setup");
fs.writeFileSync(path.join(realRepo, "value.txt"), "old\n");
fs.writeFileSync(path.join(realRepo, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
gitOk(["add", "."], realRepo, "setup");
gitOk(["commit", "-q", "-m", "baseline"], realRepo, "setup");

fs.mkdirSync(linkDir, { recursive: true });
fs.symlinkSync(path.relative(linkDir, realDir), path.join(linkDir, "fixtures-real"), "dir");
// linkRepo = <invocationDir>/fixtures-link/fixtures-real/repo — reached
// through the symlinked directory (the /var -> /private/var model).
const linkRepoThrough = path.join(linkDir, "fixtures-real", "repo");
fs.symlinkSync(os.tmpdir(), escapeDir, "dir");

const realRepoReal = fs.realpathSync(realRepo);
const linkRepoReal = fs.realpathSync(linkRepoThrough);
assert.equal(linkRepoReal, realRepoReal,
  "the symlinked form must resolve to the same realpath as the realpath form");

// ── (1) worktree checks: identical through both forms ────────────────

const wtReal = gitOk(["worktree", "list", "--porcelain"], realRepo, "worktree");
const wtLink = gitOk(["worktree", "list", "--porcelain"], linkRepoThrough, "worktree");
assert.equal(wtLink, wtReal,
  "worktree check must be identical for the symlinked form and the realpath form (no false failure)");

// ── (2) TSTX hashing: identical tree hash through both forms ─────────

const treeReal = gitOk(["rev-parse", "HEAD^{tree}"], realRepo, "tstx");
const treeLink = gitOk(["rev-parse", "HEAD^{tree}"], linkRepoThrough, "tstx");
assert.equal(treeLink, treeReal,
  "TSTX tree hash must be identical for the symlinked form and the realpath form (no false failure)");
assert.match(treeReal, /^[0-9a-f]{40}$/, "tree hash must be a git object hash");

// ── (3) containment / gates: real machinery accepts both forms, rejects
//        the out-of-var control (no false failure, no false acceptance) ──

// Direction A (realpath -> symlink): the realpath form first, then the
// symlinked form — both must be CONTAINED (no false containment failure).
assert.equal(assertContainedHome(realRepo, varRoot, "realpath-form fixture repo"), realRepoReal,
  "containment must accept the realpath form");
const linkContained = assertContainedHome(linkRepoThrough, varRoot, "symlinked-form fixture repo");
assert.equal(linkContained, realRepoReal,
  "containment must accept the symlinked form (no false containment failure)");

// Direction B (symlink -> realpath): resolve the symlink, then re-check the
// resolved path — same verdict.
assert.equal(assertContainedHome(linkRepoReal, varRoot, "resolved symlinked form"), realRepoReal,
  "containment must accept the resolved (realpath) form identically");

// The gate still holds through a symlink: a control symlink pointing OUTSIDE
// var must be REJECTED (no false acceptance).
assert.throws(
  () => assertContainedHome(escapeDir, varRoot, "out-of-var control symlink"),
  /TT_CONTAINMENT_VIOLATION|containment violation/,
  "containment must reject a symlink resolving outside torture-test/var",
);

// ── zero-token ledger proof ──────────────────────────────────────────

const db = new DatabaseSync(dbPath, { readOnly: true });
let runTokens = 0;
let systemTokens = 0;
try {
  runTokens = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get().total;
  systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get().system_tokens_spent;
} finally {
  db.close();
}
assert.equal(runTokens, 0, "W4.22 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.22 system token tripwire moved");

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  realpath_form: realRepo,
  symlink_form: linkRepoThrough,
  resolved_realpath: linkRepoReal,
  worktree_parity: wtLink === wtReal,
  tree_hash: treeReal,
  tstx_parity: treeLink === treeReal,
  containment: {
    realpath_form: "accepted",
    symlink_form: "accepted",
    resolved_form: "accepted",
    out_of_var_control: "rejected",
  },
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
})}\n`);
