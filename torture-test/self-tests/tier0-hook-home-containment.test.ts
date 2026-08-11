// FIX10 US-002 gate: tier0 hooks (run-w0.1, run-w0.2) fail closed unless
// HOME is contained strictly under torture-test/var.
//
// Regression net for the 2026-08-05 breach: run-w0.1 executed the --global
// git-config write (GIT_CONFIG_GLOBAL=$HOME/.gitconfig) under an
// UNCONTAINED HOME, writing `Tamandua Tier-0 <tier0@tetradactyla.invalid>`
// into the OPERATOR's real ~/.gitconfig. US-002 makes the hooks refuse to
// run (exit 2, loud HOME-naming error) before ANY git config write or
// HOME-side-effect unless $HOME is a real directory strictly inside
// torture-test/var.
//
// Confined to torture-test/. Zero tokens: the contained-HOME success test
// uses a stub `npm` so the hook's build/test phases never actually run.
// The real ~/.gitconfig is only ever READ (sha256 snapshot) by this file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const HOOK_W01 = path.join(ttRoot, "cases", "hooks", "run-w0.1");
const HOOK_W02 = path.join(ttRoot, "cases", "hooks", "run-w0.2");
const GUARD = path.join(ttRoot, "cases", "hooks", "containment-guard.sh");

const operatorHome = os.homedir();
const realGitconfig = path.join(operatorHome, ".gitconfig");

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

type CommandResult = { status: number | null; stdout: string; stderr: string };

function runBash(script: string, env: NodeJS.ProcessEnv, timeoutMs = 120_000): CommandResult {
  const result = spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  // Keep the operator env (hooks unset the runtime-routing vars themselves),
  // but drop NODE_TEST_CONTEXT so node:test does not mark the bash child.
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
}

let gitconfigBefore = "";
describe("FIX10 US-002 tier0 hook HOME containment (fail closed)", () => {
  before(() => {
    gitconfigBefore = sha256(realGitconfig);
  });
  after(() => {
    assert.equal(sha256(realGitconfig), gitconfigBefore,
      "the real ~/.gitconfig hash changed during the test run — containment broke");
  });

  it("run-w0.1 exits non-zero with an explicit containment error when $HOME is the real operator home", () => {
    const result = runBash(`bash "${HOOK_W01}"`, { ...baseEnv(), HOME: operatorHome });
    assert.equal(result.status, 2,
      `expected refusal (exit 2), got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /CONTAINMENT VIOLATION — refusing to run/,
      "stderr must carry the loud containment marker");
    assert.match(result.stderr, new RegExp(operatorHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "stderr must name the offending (real) HOME");
    assert.doesNotMatch(result.stderr + result.stdout, /> tamandua@[\d.]+ build/,
      "the hook must trip BEFORE npm run build (zero tokens, nothing built)");
  });

  it("run-w0.1 succeeds when $HOME is under torture-test/var (stub npm, zero tokens)", () => {
    const containedHome = fs.mkdtempSync(path.join(varRoot, `home-contained-test-${process.pid}-`));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), `npm-stub-${process.pid}-`));
    const stubLog = path.join(stubDir, "npm.log");
    try {
      fs.writeFileSync(path.join(stubDir, "npm"),
        '#!/usr/bin/env bash\necho "npm $*" >> "$NPM_STUB_LOG"\nexit 0\n', { mode: 0o755 });
      const env = {
        ...baseEnv(),
        HOME: containedHome,
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        NPM_STUB_LOG: stubLog,
      };
      const result = runBash(`bash "${HOOK_W01}"`, env);
      assert.equal(result.status, 0,
        `contained-HOME run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stderr, /^$/);
      const log = fs.readFileSync(stubLog, "utf8");
      assert.match(log, /npm run build/, "hook must proceed to the build phase with a contained HOME");
      assert.match(log, /npm test/, "hook must proceed to the test phase with a contained HOME");
      // The --global git-config write landed in the CONTAINED .gitconfig.
      const containedGitconfig = fs.readFileSync(path.join(containedHome, ".gitconfig"), "utf8");
      assert.match(containedGitconfig, /Tamandua Tier-0/);
      assert.match(containedGitconfig, /tier0@tetradactyla\.invalid/);
      // The operator home must be byte-identical after the contained run.
      assert.equal(sha256(realGitconfig), gitconfigBefore);
    } finally {
      fs.rmSync(containedHome, { recursive: true, force: true });
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("run-w0.2 carries the same fail-closed containment assertion and has no --global write", () => {
    const content = fs.readFileSync(HOOK_W02, "utf8");
    assert.match(content, /containment-guard\.sh/, "run-w0.2 must source the shared containment guard");
    assert.doesNotMatch(content, /git config --global\b/, "run-w0.2 must never write --global git config");
    const result = runBash(`bash "${HOOK_W02}"`, { ...baseEnv(), HOME: operatorHome });
    assert.equal(result.status, 2, `run-w0.2 must refuse with the real HOME, got ${result.status}`);
    assert.match(result.stderr, /CONTAINMENT VIOLATION/);
    assert.match(result.stderr, new RegExp(operatorHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("run-w0.1 never executes the --global git-config write before its containment assertion (ordering)", () => {
    const lines = fs.readFileSync(HOOK_W01, "utf8").split(/\r?\n/);
    const indexOf = (pattern: RegExp): number => lines.findIndex((line) => pattern.test(line));
    const guardLine = indexOf(/containment-guard\.sh/);
    const firstGitConfigLine = indexOf(/git config --global/);
    const buildLine = indexOf(/npm run build/);
    assert.ok(guardLine >= 0, "run-w0.1 must reference the containment guard");
    assert.ok(firstGitConfigLine >= 0, "run-w0.1 must contain the --global git-config write");
    assert.ok(buildLine >= 0, "run-w0.1 must invoke npm run build");
    assert.ok(guardLine < firstGitConfigLine,
      `containment guard (line ${guardLine + 1}) must precede the first git config --global (line ${firstGitConfigLine + 1})`);
    assert.ok(firstGitConfigLine < buildLine,
      `git config --global (line ${firstGitConfigLine + 1}) must precede npm run build (line ${buildLine + 1})`);
  });

  it("the shared guard itself fails closed for uncontained HOME and passes for contained HOME", () => {
    const probe = (home: string, label: string): CommandResult => {
      const env = { ...baseEnv(), HOME: home };
      return runBash(`source "${GUARD}"`, env);
    };
    const bad = probe(operatorHome, "real operator home");
    assert.equal(bad.status, 2, "real operator home must be refused");
    assert.match(bad.stderr, /CONTAINMENT VIOLATION/);
    assert.match(bad.stderr, new RegExp(operatorHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const varItself = probe(varRoot, "var itself");
    assert.equal(varItself.status, 2, "HOME = torture-test/var itself must be refused (not strictly under)");
    assert.match(varItself.stderr, /is torture-test\/var itself/);

    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "home-outside-var-"));
    try {
      const outside = probe(sibling, "sibling outside var");
      assert.equal(outside.status, 2, "HOME outside var must be refused");
      assert.match(outside.stderr, /NOT strictly under torture-test\/var/);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }

    const containedHome = fs.mkdtempSync(path.join(varRoot, `home-guard-test-${process.pid}-`));
    try {
      const ok = probe(containedHome, "contained var home");
      assert.equal(ok.status, 0, `contained HOME must pass the guard\n${ok.stderr}`);
      assert.doesNotMatch(ok.stderr, /CONTAINMENT VIOLATION/);
    } finally {
      fs.rmSync(containedHome, { recursive: true, force: true });
    }
  });

  it("belt-and-suspenders: a .gitconfig that escapes var (symlink or non-file) is refused", () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), `npm-stub-${process.pid}-`));
    const stubLog = path.join(stubDir, "npm.log");
    const runWithGitconfig = (prepare: (home: string) => void, expectMessage: RegExp): CommandResult => {
      const containedHome = fs.mkdtempSync(path.join(varRoot, `home-belt-${process.pid}-`));
      try {
        fs.mkdirSync(path.join(containedHome, ".pi", "agent"), { recursive: true });
        fs.writeFileSync(path.join(containedHome, ".pi", "agent", "settings.json"),
          '{"defaultProvider":"stub","defaultModel":"stub"}\n');
        prepare(containedHome);
        const env = {
          ...baseEnv(),
          HOME: containedHome,
          PATH: `${stubDir}:${process.env.PATH ?? ""}`,
          NPM_STUB_LOG: stubLog,
        };
        return runBash(`bash "${HOOK_W01}"`, env);
      } finally {
        fs.rmSync(containedHome, { recursive: true, force: true });
      }
    };
    try {
      fs.writeFileSync(path.join(stubDir, "npm"),
        '#!/usr/bin/env bash\necho "npm $*" >> "$NPM_STUB_LOG"\nexit 0\n', { mode: 0o755 });
      const symlink = runWithGitconfig(
        (home) => fs.symlinkSync(realGitconfig, path.join(home, ".gitconfig")),
        /symlink escaping var/);
      assert.equal(symlink.status, 2, "a .gitconfig symlink escaping var must be refused");
      assert.match(symlink.stderr, /symlink escaping var/);

      const notAFile = runWithGitconfig(
        (home) => fs.mkdirSync(path.join(home, ".gitconfig")),
        /not a regular file/);
      assert.equal(notAFile.status, 2, "a .gitconfig that is not a regular file must be refused");
      assert.match(notAFile.stderr, /not a regular file/);
      assert.equal(sha256(realGitconfig), gitconfigBefore);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
