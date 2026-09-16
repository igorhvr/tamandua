import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { getDb } from "../../dist/db.js";
import {
  FALLBACK_GIT_IDENTITY,
  GIT_IDENTITY_CONTEXT_KEYS,
  gitIdentityContextPatch,
  gitIdentityEnv,
  readGitIdentityFromContext,
  resolveGitIdentity,
  resolveRunGitIdentity,
} from "../../dist/installer/git-identity.js";

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
 * HOME and GIT_CONFIG_GLOBAL point inside a temp dir and system config is
 * disabled. GIT_USER_NAME/EMAIL are absent so the env tier is not satisfied
 * unless a test opts in.
 *
 * Built from an explicit allow-list (never a spread of the ambient process
 * environment) so the isolation static guard is satisfied and no live-daemon
 * env leaks into git children.
 */
function isolatedEnv(homeDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir,
    GIT_CONFIG_GLOBAL: path.join(homeDir, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { ...env, ...overrides };
}

function writeGlobalConfig(homeDir: string, name?: string, email?: string): void {
  const lines: string[] = ["[user]"];
  if (name !== undefined) lines.push(`\tname = ${name}`);
  if (email !== undefined) lines.push(`\temail = ${email}`);
  fs.writeFileSync(path.join(homeDir, ".gitconfig"), `${lines.join("\n")}\n`, "utf-8");
}

function initRepo(dir: string, env: NodeJS.ProcessEnv, name?: string, email?: string): void {
  git(dir, ["init", "--initial-branch=main"], env);
  if (name !== undefined) git(dir, ["config", "user.name", name], env);
  if (email !== undefined) git(dir, ["config", "user.email", email], env);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveGitIdentity — source precedence", () => {
  it("(a) env wins when both GIT_USER_NAME and GIT_USER_EMAIL are set", () => {
    const home = temp("tamandua-git-identity-env-");
    const repo = temp("tamandua-git-identity-env-repo-");
    const env = isolatedEnv(home, {
      GIT_USER_NAME: "Env Name",
      GIT_USER_EMAIL: "env@example.com",
    });
    initRepo(repo, env, "Local Name", "local@example.com");
    writeGlobalConfig(home, "Global Name", "global@example.com");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.deepEqual(identity, {
      name: "Env Name",
      email: "env@example.com",
      source: "env",
    });
  });

  it("(b) repo-local wins when env is unset and the repository has both local fields", () => {
    const home = temp("tamandua-git-identity-local-");
    const repo = temp("tamandua-git-identity-local-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env, "Local Name", "local@example.com");
    writeGlobalConfig(home, "Global Name", "global@example.com");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.deepEqual(identity, {
      name: "Local Name",
      email: "local@example.com",
      source: "repo-local",
    });
  });

  it("(c) global is used when env and repo-local are unset", () => {
    const home = temp("tamandua-git-identity-global-");
    const repo = temp("tamandua-git-identity-global-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    writeGlobalConfig(home, "Global Name", "global@example.com");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.deepEqual(identity, {
      name: "Global Name",
      email: "global@example.com",
      source: "global",
    });
  });

  it("(d) falls back to the Tamandua identity when no tier supplies both fields", () => {
    const home = temp("tamandua-git-identity-fallback-");
    const repo = temp("tamandua-git-identity-fallback-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    writeGlobalConfig(home);

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.deepEqual(identity, {
      name: "Tamandua",
      email: "tamandua@tetradactyla.org",
      source: "fallback",
    });
    assert.deepEqual(identity, { ...FALLBACK_GIT_IDENTITY });
  });

  it("skips a partial env tier (email missing) and continues", () => {
    const home = temp("tamandua-git-identity-partial-env-");
    const repo = temp("tamandua-git-identity-partial-env-repo-");
    const env = isolatedEnv(home, { GIT_USER_NAME: "Env Name Only" });
    initRepo(repo, env, "Local Name", "local@example.com");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.equal(identity.source, "repo-local");
    assert.equal(identity.name, "Local Name");
  });

  it("skips a partial repo-local tier and continues to global", () => {
    const home = temp("tamandua-git-identity-partial-local-");
    const repo = temp("tamandua-git-identity-partial-local-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env, "Local Name Only");
    writeGlobalConfig(home, "Global Name", "global@example.com");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.equal(identity.source, "global");
    assert.equal(identity.name, "Global Name");
    assert.equal(identity.email, "global@example.com");
  });

  it("skips a partial global tier and falls back", () => {
    const home = temp("tamandua-git-identity-partial-global-");
    const repo = temp("tamandua-git-identity-partial-global-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env);
    writeGlobalConfig(home, "Global Name Only");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.equal(identity.source, "fallback");
    assert.equal(identity.name, FALLBACK_GIT_IDENTITY.name);
    assert.equal(identity.email, FALLBACK_GIT_IDENTITY.email);
  });

  it("treats whitespace-only fields as unset", () => {
    const home = temp("tamandua-git-identity-blank-");
    const repo = temp("tamandua-git-identity-blank-repo-");
    const env = isolatedEnv(home, {
      GIT_USER_NAME: "   ",
      GIT_USER_EMAIL: "\t",
    });
    initRepo(repo, env, "Local Name", "local@example.com");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.equal(identity.source, "repo-local");
  });

  it("skips the repo-local tier when repoDir is not inside a git work tree", () => {
    const home = temp("tamandua-git-identity-notrepo-");
    const dir = temp("tamandua-git-identity-notrepo-dir-");
    const env = isolatedEnv(home);
    writeGlobalConfig(home, "Global Name", "global@example.com");

    const identity = resolveGitIdentity({ repoDir: dir, env });
    assert.equal(identity.source, "global");
  });

  it("never consults git config --system", () => {
    const home = temp("tamandua-git-identity-nosystem-");
    const repo = temp("tamandua-git-identity-nosystem-repo-");
    const systemConfig = path.join(home, "system.gitconfig");
    fs.writeFileSync(
      systemConfig,
      "[user]\n\tname = System Name\n\temail = system@example.com\n",
      "utf-8",
    );
    // Deliberately DO NOT set GIT_CONFIG_NOSYSTEM: the resolver's --local /
    // --global scoping must be what keeps system config out of the result.
    const env = isolatedEnv(home);
    delete env.GIT_CONFIG_NOSYSTEM;
    env.GIT_CONFIG_SYSTEM = systemConfig;
    initRepo(repo, env);
    writeGlobalConfig(home, "Global Name", "global@example.com");

    const identity = resolveGitIdentity({ repoDir: repo, env });
    assert.equal(identity.source, "global");
    assert.equal(identity.name, "Global Name");

    // With no global config either, the system identity still must not leak in.
    writeGlobalConfig(home);
    const fallback = resolveGitIdentity({ repoDir: repo, env });
    assert.equal(fallback.source, "fallback");
    assert.equal(fallback.name, FALLBACK_GIT_IDENTITY.name);
  });

  it("is read-only: never writes repo-local or global git config", () => {
    const home = temp("tamandua-git-identity-readonly-");
    const repo = temp("tamandua-git-identity-readonly-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env, "Local Name", "local@example.com");
    writeGlobalConfig(home, "Global Name", "global@example.com");

    const localConfigPath = path.join(repo, ".git", "config");
    const globalConfigPath = path.join(home, ".gitconfig");
    const localBefore = fs.readFileSync(localConfigPath, "utf-8");
    const globalBefore = fs.readFileSync(globalConfigPath, "utf-8");

    resolveGitIdentity({ repoDir: repo, env });

    assert.equal(fs.readFileSync(localConfigPath, "utf-8"), localBefore);
    assert.equal(fs.readFileSync(globalConfigPath, "utf-8"), globalBefore);
  });
});

describe("resolveRunGitIdentity — run-context precedence (GIDN US-004)", () => {
  it("uses the run-context identity (source 'run-context') when it carries both fields", () => {
    let asked = "";
    const identity = resolveRunGitIdentity("run-ctx", "/nonexistent", {}, {
      readRunContext: (runId) => {
        asked = runId;
        return {
          git_identity_name: "Context Name",
          git_identity_email: "context@example.com",
          git_identity_source: "env",
        };
      },
    });

    assert.equal(asked, "run-ctx");
    assert.deepEqual(identity, {
      name: "Context Name",
      email: "context@example.com",
      source: "run-context",
    });
  });

  it("falls through to normal resolution when the context carries only a partial identity", () => {
    const home = temp("tamandua-git-identity-ctx-partial-");
    const repo = temp("tamandua-git-identity-ctx-partial-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env, "Local Name", "local@example.com");

    const identity = resolveRunGitIdentity("run-partial", repo, env, {
      readRunContext: () => ({ git_identity_name: "Only A Name" }),
    });

    assert.deepEqual(identity, {
      name: "Local Name",
      email: "local@example.com",
      source: "repo-local",
    });
  });

  it("never consults the run context for a runless (empty runId) merge", () => {
    const home = temp("tamandua-git-identity-ctx-runless-");
    const repo = temp("tamandua-git-identity-ctx-runless-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env, "Local Name", "local@example.com");
    let called = false;

    const identity = resolveRunGitIdentity("", repo, env, {
      readRunContext: () => {
        called = true;
        return { git_identity_name: "Never", git_identity_email: "never@example.com" };
      },
    });

    assert.equal(called, false);
    assert.equal(identity.source, "repo-local");
  });

  it("reads the persisted identity back from runs.context (default DB reader)", () => {
    const stateDir = temp("tamandua-git-identity-db-");
    const home = temp("tamandua-git-identity-db-home-");
    const repo = temp("tamandua-git-identity-db-repo-");
    const env = isolatedEnv(home);
    initRepo(repo, env, "Local Name", "local@example.com");

    const savedStateDir = process.env.TAMANDUA_STATE_DIR;
    const savedDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    try {
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', ?, ?, ?)",
      ).run(
        "run-db-identity",
        JSON.stringify({
          git_identity_name: "Persisted Name",
          git_identity_email: "persisted@example.com",
          git_identity_source: "repo-local",
        }),
        now,
        now,
      );

      const identity = resolveRunGitIdentity("run-db-identity", repo, env);
      assert.deepEqual(identity, {
        name: "Persisted Name",
        email: "persisted@example.com",
        source: "run-context",
      });

      // A run id with no context row falls back to the repository config.
      const missing = resolveRunGitIdentity("run-not-in-db", repo, env);
      assert.deepEqual(missing, {
        name: "Local Name",
        email: "local@example.com",
        source: "repo-local",
      });
    } finally {
      if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = savedStateDir;
      if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = savedDbPath;
    }
  });
});

describe("git-identity helpers", () => {
  it("gitIdentityEnv produces exactly the four author/committer variables", () => {
    const env = gitIdentityEnv({
      name: "Ada Lovelace",
      email: "ada@example.com",
      source: "env",
    });
    assert.deepEqual(env, {
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "ada@example.com",
    });
  });

  it("run-context patch/read round-trips the identity", () => {
    const identity = { name: "Grace Hopper", email: "grace@example.com", source: "global" } as const;
    const patch = gitIdentityContextPatch(identity);
    assert.deepEqual(patch, {
      git_identity_name: "Grace Hopper",
      git_identity_email: "grace@example.com",
      git_identity_source: "global",
    });

    const context: Record<string, unknown> = { workflow_id: "feature-dev", ...patch };
    const read = readGitIdentityFromContext(context);
    assert.deepEqual(read, {
      name: "Grace Hopper",
      email: "grace@example.com",
      source: "global",
    });
  });

  it("readGitIdentityFromContext returns null for partial or missing context", () => {
    assert.equal(readGitIdentityFromContext(null), null);
    assert.equal(readGitIdentityFromContext(undefined), null);
    assert.equal(readGitIdentityFromContext({}), null);
    assert.equal(
      readGitIdentityFromContext({ [GIT_IDENTITY_CONTEXT_KEYS.name]: "Only Name" }),
      null,
    );
    assert.equal(
      readGitIdentityFromContext({
        [GIT_IDENTITY_CONTEXT_KEYS.name]: "Only Name",
        [GIT_IDENTITY_CONTEXT_KEYS.email]: "   ",
      }),
      null,
    );
  });

  it("readGitIdentityFromContext defaults an unknown source to fallback", () => {
    const read = readGitIdentityFromContext({
      git_identity_name: "Someone",
      git_identity_email: "someone@example.com",
      git_identity_source: "made-up",
    });
    assert.equal(read?.source, "fallback");
    assert.equal(read?.name, "Someone");
  });

  it("GIT_IDENTITY_CONTEXT_KEYS has the canonical run-context names", () => {
    assert.deepEqual(GIT_IDENTITY_CONTEXT_KEYS, {
      name: "git_identity_name",
      email: "git_identity_email",
      source: "git_identity_source",
    });
  });
});
