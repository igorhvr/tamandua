// FIX10 US-006 gate: grep-proof — no `git config --global` executes
// anywhere in torture-test/ outside a contained-HOME guard, and every
// GIT_CONFIG_GLOBAL assignment either resolves under torture-test/var or
// points at /dev/null.
//
// Regression net for the 2026-08-05 breach: run-w0.1 executed the --global
// git-config write under an UNCONTAINED HOME (GIT_CONFIG_GLOBAL=$HOME/.gitconfig
// resolves the write target from $HOME), rewriting the OPERATOR's real
// ~/.gitconfig with `Tamandua Tier-0 <tier0@tetradactyla.invalid>`.
// US-002/US-003/US-004/US-005 closed the leak (hooks/controller/scenarios/
// daemon-control fail closed + campaign-level hygiene canary). US-006 adds
// the mechanical GREP PROOF the spec calls for: scanning every executable
// file under torture-test/ for the literal `git config --global` and
// asserting the ONLY file that carries it is cases/hooks/run-w0.1, that it
// sources the containment guard BEFORE its first write, and that every
// GIT_CONFIG_GLOBAL assignment is either /dev/null or the guarded
// $HOME/.gitconfig (contained iff HOME is, and the guard makes it so).
//
// Confined to torture-test/. Zero tokens: the functional proof runs
// run-w0.1 under a contained var home with a stub `npm` so the build/test
// phases never actually run. The real ~/.gitconfig is only ever READ
// (sha256 snapshot) and asserted unchanged after the run.
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
const GUARD = path.join(ttRoot, "cases", "hooks", "containment-guard.sh");

const operatorHome = os.homedir();
const realGitconfig = path.join(operatorHome, ".gitconfig");

// Directories whose contents are never executable torture-test code:
// var/ is gitignored campaign evidence; node_modules/.git are vendored;
// self-tests/ legitimately QUOTE the literal inside their own assertions
// (a grep over self-tests would self-match); impl-tasks/ and the spec dir
// are documentation (.md) — quoted in the forensic record, never executed.
const SKIP_DIRS = new Set(["var", "node_modules", ".git", "self-tests"]);
// Non-executable file extensions: documentation, data, and lock files can
// quote the literal without any execution risk and are excluded from the
// executable scan.
const DOC_EXTENSIONS = new Set([
  ".md", ".json", ".jsonl", ".yml", ".yaml", ".txt", ".lock", ".html", ".css",
]);

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

// Walk torture-test/ (minus var/, node_modules/, .git/, self-tests/) and
// collect every EXECUTABLE file (anything that is not a documented/data
// extension) together with its line-indexed content. Documentation files
// (.md/.json/.jsonl/...) quote the literal for the forensic record but can
// never execute it, so they are excluded — the grep-proof is about CODE.
function executableFiles(): Array<{ rel: string; lines: string[] }> {
  const files: Array<{ rel: string; lines: string[] }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (DOC_EXTENSIONS.has(ext)) continue;
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      files.push({ rel: path.relative(ttRoot, full), lines: read(full).split(/\r?\n/) });
    }
  };
  walk(ttRoot);
  return files;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

// Every executable file whose content carries the literal `git config
// --global` (the ONLY git-config write form that can reach the operator's
// real ~/.gitconfig).
function globalWriteSites(): Array<{ rel: string; lines: Array<{ index: number; text: string }> }> {
  const sites: Array<{ rel: string; lines: Array<{ index: number; text: string }> }> = [];
  for (const file of executableFiles()) {
    const hits = file.lines
      .map((text, index) => ({ index, text }))
      .filter(({ text }) => text.includes("git config --global"));
    if (hits.length > 0) sites.push({ rel: file.rel, lines: hits });
  }
  return sites;
}

// A line is a comment (shell #, JS/TS //, /*, or block-continuation *) and can
// never execute the assignment it quotes.
function isCommentLine(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("#")
    || trimmed.startsWith("//")
    || trimmed.startsWith("/*")
    || trimmed.startsWith("*");
}

// Every executable file with a GIT_CONFIG_GLOBAL assignment (the scoping
// knob that determines where `git config` writes global state). Comments are
// excluded: they quote the pattern for documentation, never execute it.
function configGlobalAssignmentSites(): Array<{ rel: string; lines: Array<{ index: number; text: string }> }> {
  const sites: Array<{ rel: string; lines: Array<{ index: number; text: string }> }> = [];
  for (const file of executableFiles()) {
    const hits = file.lines
      .map((text, index) => ({ index, text }))
      .filter(({ text }) => /GIT_CONFIG_GLOBAL\s*[:=]/.test(text) && !isCommentLine(text));
    if (hits.length > 0) sites.push({ rel: file.rel, lines: hits });
  }
  return sites;
}

function assignmentValue(text: string): string | null {
  const match = /GIT_CONFIG_GLOBAL\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/.exec(text);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function guardSourceLine(lines: string[]): number {
  return lines.findIndex((line) => line.includes("containment-guard.sh"));
}

let gitconfigBefore = "";
describe("FIX10 US-006 grep-proof: no unguarded git config --global, canary section shown", () => {
  before(() => {
    gitconfigBefore = sha256(realGitconfig);
  });
  after(() => {
    assert.equal(sha256(realGitconfig), gitconfigBefore,
      "the real ~/.gitconfig hash changed during the test run — containment broke");
  });

  it("the literal 'git config --global' appears ONLY in cases/hooks/run-w0.1 among executable files", () => {
    const sites = globalWriteSites();
    assert.deepEqual(
      sites.map((site) => site.rel),
      ["cases/hooks/run-w0.1"],
      `unexpected --global git-config write site(s): ${JSON.stringify(sites, null, 2)}`,
    );
    // The write itself is exactly the identity observed in the breach.
    assert.deepEqual(
      sites[0]?.lines.map(({ text }) => text.replace(/^\s*/, "")),
      [
        'git config --global user.name "Tamandua Tier-0"',
        'git config --global user.email "tier0@tetradactyla.invalid"',
        "git config --global commit.gpgsign false",
      ],
    );
  });

  it("run-w0.1 sources the containment guard BEFORE its first --global write (ordering proof)", () => {
    const lines = read(HOOK_W01).split(/\r?\n/);
    const guardLine = guardSourceLine(lines);
    const firstWrite = lines.findIndex((line) => line.includes("git config --global"));
    const buildLine = lines.findIndex((line) => line.includes("npm run build"));
    assert.ok(guardLine >= 0, "run-w0.1 must source the containment guard");
    assert.ok(firstWrite >= 0, "run-w0.1 must contain the --global write");
    assert.ok(guardLine < firstWrite,
      `the guard (line ${guardLine + 1}) must be sourced BEFORE the first git config --global (line ${firstWrite + 1})`);
    assert.ok(firstWrite < buildLine,
      `the --global write (line ${firstWrite + 1}) must precede npm run build (line ${buildLine + 1})`);
    assert.ok(lines.some((line) => line.includes("GIT_CONFIG_NOSYSTEM=1")),
      "run-w0.1 must set GIT_CONFIG_NOSYSTEM=1 so system config can never leak in");
    // Belt-and-suspenders: the write target itself must resolve inside var.
    assert.match(read(HOOK_W01), /GIT_CONFIG_GLOBAL parent escapes torture-test\/var/,
      "run-w0.1 must verify GIT_CONFIG_GLOBAL resolves under var");
    // The guard file itself must never carry the literal it protects against.
    assert.ok(!read(GUARD).includes("git config --global"),
      "containment-guard.sh must not itself contain the literal");
  });

  it("every GIT_CONFIG_GLOBAL assignment either resolves under torture-test/var or points at /dev/null", () => {
    const sites = configGlobalAssignmentSites();
    assert.ok(sites.length > 0, "expected at least one GIT_CONFIG_GLOBAL assignment site");
    for (const site of sites) {
      for (const { index, text } of site.lines) {
        const value = assignmentValue(text);
        assert.ok(value !== null, `${site.rel}:${index + 1} has a GIT_CONFIG_GLOBAL assignment but no value:\n${text}`);
        if (value === "/dev/null") continue; // fail-closed oracle/scenario pin — nothing to guard.
        assert.equal(site.rel, "cases/hooks/run-w0.1",
          `${site.rel}:${index + 1} assigns GIT_CONFIG_GLOBAL=${value} — only the guarded hook may resolve it under var`);
        assert.equal(value, "$HOME/.gitconfig",
          `${site.rel}:${index + 1} must scope the write to $HOME/.gitconfig so the guard's HOME containment contains it`);
        const lines = read(HOOK_W01).split(/\r?\n/);
        const guardLine = guardSourceLine(lines);
        assert.ok(guardLine >= 0 && guardLine < index,
          `the containment guard must be sourced BEFORE the GIT_CONFIG_GLOBAL assignment (line ${index + 1})`);
      }
    }
    // Explicit inventory (kept in sync so a new /dev/null site is noticed):
    const byRel = new Set(sites.map((site) => site.rel));
    for (const expected of [
      "oracles/lib/git.mjs",
      "oracles/lib/o8.mjs",
      "bin/tt-verify-environment",
      "scenarios/w4.25/run-upgrade.mjs",
      "scenarios/w4.25/prepare-fixture.mjs",
      "scenarios/w4.25/run-downgrade-reupgrade.mjs",
    ]) {
      assert.ok(byRel.has(expected), `expected a GIT_CONFIG_GLOBAL site in ${expected}`);
    }
  });

  it("functional: the guarded --global write lands in the contained var home, never the operator's", () => {
    const containedHome = fs.mkdtempSync(path.join(varRoot, `home-grep-proof-${process.pid}-`));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), `npm-stub-grep-${process.pid}-`));
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
      // The write executed INSIDE the contained home (var), not the operator's.
      const containedGitconfig = path.join(containedHome, ".gitconfig");
      assert.ok(fs.existsSync(containedGitconfig), "the contained home must have a .gitconfig");
      const content = fs.readFileSync(containedGitconfig, "utf8");
      assert.match(content, /Tamandua Tier-0/, "contained .gitconfig must carry the seeded identity");
      assert.match(content, /tier0@tetradactyla\.invalid/, "contained .gitconfig must carry the seeded email");
      assert.ok(containedGitconfig.startsWith(path.resolve(varRoot)),
        `the write target must live under torture-test/var: ${containedGitconfig}`);
      // The operator home must be byte-identical after the contained run.
      assert.equal(sha256(realGitconfig), gitconfigBefore,
        "the real ~/.gitconfig must never be touched by the guarded write");
    } finally {
      fs.rmSync(containedHome, { recursive: true, force: true });
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
