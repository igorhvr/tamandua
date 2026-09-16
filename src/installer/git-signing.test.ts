import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  GIT_SIGNING_CONFIG_KEYS,
  MATCHLOCK_CONTEXT_KEY,
  MATCHLOCK_GUEST_ENV_VAR,
  isMatchlockGuestContext,
  resolveGitSigningConfig,
} from "../../dist/installer/git-signing.js";

// ── Helpers ──────────────────────────────────────────────────────────

const cleanup: string[] = [];

after(() => {
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function temp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  cleanup.push(dir);
  return dir;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
}

/**
 * Environment that cannot accidentally see the operator's real git config:
 * HOME / GIT_CONFIG_GLOBAL point inside a temp dir and system config is
 * disabled. Built from an explicit allow-list (never a spread of the ambient
 * process environment) so the isolation static guard stays satisfied.
 */
function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir,
    GIT_CONFIG_GLOBAL: path.join(homeDir, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function initRepo(dir: string, env: NodeJS.ProcessEnv): void {
  git(dir, ["init", "--initial-branch=main"], env);
}

function setLocal(repo: string, env: NodeJS.ProcessEnv, key: string, value: string): void {
  git(repo, ["config", "--local", key, value], env);
}

function writeGlobal(homeDir: string, entries: Array<[string, string]>): void {
  const grouped = new Map<string, Array<[string, string]>>();
  for (const [key, value] of entries) {
    const section = key.split(".")[0]!;
    const rest = key.slice(section.length + 1);
    const list = grouped.get(section) ?? [];
    list.push([rest, value]);
    grouped.set(section, list);
  }
  const lines: string[] = [];
  for (const [section, values] of grouped) {
    lines.push(`[${section}]`);
    for (const [key, value] of values) lines.push(`\t${key} = ${value}`);
  }
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".gitconfig"), `${lines.join("\n")}\n`, "utf-8");
}

const GPGSIGN = GIT_SIGNING_CONFIG_KEYS.enabled;
const FORMAT = GIT_SIGNING_CONFIG_KEYS.format;
const SIGNINGKEY = GIT_SIGNING_CONFIG_KEYS.signingKey;

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveGitSigningConfig — source resolution", () => {
  it("reads all three keys from the repo-local config", () => {
    const home = temp("tamandua-git-signing-local-");
    const repo = temp("tamandua-git-signing-local-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    setLocal(repo, env, GPGSIGN, "true");
    setLocal(repo, env, FORMAT, "ssh");
    setLocal(repo, env, SIGNINGKEY, "/keys/landing.pub");

    const config = resolveGitSigningConfig({ repoDir: repo, env });
    assert.deepEqual(config, {
      enabled: true,
      format: "ssh",
      signingKey: "/keys/landing.pub",
    });
  });

  it("prefers the repo-local commit.gpgsign=false over a global true", () => {
    const home = temp("tamandua-git-signing-local-false-");
    const repo = temp("tamandua-git-signing-local-false-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    writeGlobal(home, [[GPGSIGN, "true"], [FORMAT, "ssh"], [SIGNINGKEY, "/keys/g.pub"]]);
    setLocal(repo, env, GPGSIGN, "false");

    const config = resolveGitSigningConfig({ repoDir: repo, env });
    assert.equal(config.enabled, false);
    // The other keys are still read (independently per key), from global.
    assert.equal(config.format, "ssh");
    assert.equal(config.signingKey, "/keys/g.pub");
  });

  it("merges each key independently across scopes (local format + global signing)", () => {
    const home = temp("tamandua-git-signing-merge-");
    const repo = temp("tamandua-git-signing-merge-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    writeGlobal(home, [[GPGSIGN, "true"], [SIGNINGKEY, "/keys/global.pub"]]);
    setLocal(repo, env, FORMAT, "ssh");

    const config = resolveGitSigningConfig({ repoDir: repo, env });
    assert.deepEqual(config, {
      enabled: true,
      format: "ssh",
      signingKey: "/keys/global.pub",
    });
  });

  it("uses the global config when the local scope is unset", () => {
    const home = temp("tamandua-git-signing-global-");
    const repo = temp("tamandua-git-signing-global-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    writeGlobal(home, [[GPGSIGN, "true"], [FORMAT, "ssh"], [SIGNINGKEY, "/keys/global.pub"]]);

    const config = resolveGitSigningConfig({ repoDir: repo, env });
    assert.deepEqual(config, {
      enabled: true,
      format: "ssh",
      signingKey: "/keys/global.pub",
    });
  });

  it("reports disabled with no format/signing key when nothing is configured", () => {
    const home = temp("tamandua-git-signing-unset-");
    const repo = temp("tamandua-git-signing-unset-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);

    const config = resolveGitSigningConfig({ repoDir: repo, env });
    assert.deepEqual(config, { enabled: false });
    assert.equal(Object.hasOwn(config, "format"), false);
    assert.equal(Object.hasOwn(config, "signingKey"), false);
  });

  it("skips the local scope when repoDir is not a git work tree", () => {
    const home = temp("tamandua-git-signing-notrepo-");
    const dir = temp("tamandua-git-signing-notrepo-dir-");
    const env = isolatedEnv(home);
    writeGlobal(home, [[GPGSIGN, "true"]]);

    const config = resolveGitSigningConfig({ repoDir: dir, env });
    assert.equal(config.enabled, true);
  });

  it("reads only the global scope when repoDir is omitted", () => {
    const home = temp("tamandua-git-signing-norepo-");
    const env = isolatedEnv(home);
    writeGlobal(home, [[GPGSIGN, "true"], [FORMAT, "ssh"]]);

    const config = resolveGitSigningConfig({ env });
    assert.deepEqual(config, { enabled: true, format: "ssh" });
  });

  it("parses git boolean truthy spellings", () => {
    const home = temp("tamandua-git-signing-bools-");
    const repo = temp("tamandua-git-signing-bools-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);

    for (const value of ["true", "yes", "on", "1", "TRUE", "Yes"]) {
      setLocal(repo, env, GPGSIGN, value);
      assert.equal(resolveGitSigningConfig({ repoDir: repo, env }).enabled, true, `value ${value}`);
    }
    for (const value of ["false", "no", "off", "0", "False", "garbage"]) {
      setLocal(repo, env, GPGSIGN, value);
      assert.equal(resolveGitSigningConfig({ repoDir: repo, env }).enabled, false, `value ${value}`);
    }
  });

  it("treats a valueless commit.gpgsign key as true (git boolean semantics)", () => {
    const home = temp("tamandua-git-signing-bare-");
    const repo = temp("tamandua-git-signing-bare-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    fs.appendFileSync(path.join(repo, ".git", "config"), "[commit]\n\tgpgsign\n", "utf-8");

    const config = resolveGitSigningConfig({ repoDir: repo, env });
    assert.equal(config.enabled, true);
  });

  it("never consults git config --system", () => {
    const home = temp("tamandua-git-signing-nosystem-");
    const repo = temp("tamandua-git-signing-nosystem-repo-");
    const systemConfig = path.join(home, "system.gitconfig");
    fs.writeFileSync(
      systemConfig,
      `[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n`,
      "utf-8",
    );
    const env = isolatedEnv(home);
    // Deliberately DO NOT set GIT_CONFIG_NOSYSTEM: the module's --local /
    // --global scoping must be what keeps system config out of the result.
    delete env.GIT_CONFIG_NOSYSTEM;
    env.GIT_CONFIG_SYSTEM = systemConfig;
    initRepo(repo, env);

    const config = resolveGitSigningConfig({ repoDir: repo, env });
    assert.deepEqual(config, { enabled: false });

    writeGlobal(home, [[GPGSIGN, "true"]]);
    assert.equal(resolveGitSigningConfig({ repoDir: repo, env }).enabled, true);
  });

  it("is read-only: never writes repo-local or global git config", () => {
    const home = temp("tamandua-git-signing-readonly-");
    const repo = temp("tamandua-git-signing-readonly-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    setLocal(repo, env, GPGSIGN, "true");
    writeGlobal(home, [[FORMAT, "ssh"]]);

    const localConfigPath = path.join(repo, ".git", "config");
    const globalConfigPath = path.join(home, ".gitconfig");
    const localBefore = fs.readFileSync(localConfigPath, "utf-8");
    const globalBefore = fs.readFileSync(globalConfigPath, "utf-8");

    resolveGitSigningConfig({ repoDir: repo, env });

    assert.equal(fs.readFileSync(localConfigPath, "utf-8"), localBefore);
    assert.equal(fs.readFileSync(globalConfigPath, "utf-8"), globalBefore);
  });
});

describe("isMatchlockGuestContext — guest-context detection (MSIG US-006)", () => {
  it("is true when the run context carries matchlock_context=true", () => {
    assert.equal(isMatchlockGuestContext({ [MATCHLOCK_CONTEXT_KEY]: true }, {}), true);
    assert.equal(isMatchlockGuestContext({ [MATCHLOCK_CONTEXT_KEY]: "true" }, {}), true);
    assert.equal(isMatchlockGuestContext({ [MATCHLOCK_CONTEXT_KEY]: "1" }, {}), true);
  });

  it("is true when the env carries TAMANDUA_MATCHLOCK_GUEST=1", () => {
    const env = { [MATCHLOCK_GUEST_ENV_VAR]: "1" };
    assert.equal(isMatchlockGuestContext(null, env), true);
    assert.equal(isMatchlockGuestContext(undefined, env), true);
    assert.equal(isMatchlockGuestContext({}, env), true);
    assert.equal(
      isMatchlockGuestContext({ [MATCHLOCK_CONTEXT_KEY]: false }, { [MATCHLOCK_GUEST_ENV_VAR]: "true" }),
      true,
    );
  });

  it("is false for a native run (no context flag and no guest env)", () => {
    assert.equal(isMatchlockGuestContext(null, {}), false);
    assert.equal(isMatchlockGuestContext(undefined, {}), false);
    assert.equal(isMatchlockGuestContext({}, {}), false);
    assert.equal(isMatchlockGuestContext({ [MATCHLOCK_CONTEXT_KEY]: false }, {}), false);
    assert.equal(isMatchlockGuestContext({ [MATCHLOCK_CONTEXT_KEY]: "false" }, {}), false);
    // An empty value must not count as "guest": only an explicit truthy flag does.
    assert.equal(isMatchlockGuestContext({ [MATCHLOCK_CONTEXT_KEY]: "" }, {}), false);
    assert.equal(isMatchlockGuestContext(null, { [MATCHLOCK_GUEST_ENV_VAR]: "" }), false);
    assert.equal(isMatchlockGuestContext(null, { [MATCHLOCK_GUEST_ENV_VAR]: "0" }), false);
  });

  it("defaults the env to process.env when omitted", () => {
    const saved = process.env[MATCHLOCK_GUEST_ENV_VAR];
    process.env[MATCHLOCK_GUEST_ENV_VAR] = "1";
    try {
      assert.equal(isMatchlockGuestContext(null), true);
    } finally {
      if (saved === undefined) delete process.env[MATCHLOCK_GUEST_ENV_VAR];
      else process.env[MATCHLOCK_GUEST_ENV_VAR] = saved;
    }
  });
});
