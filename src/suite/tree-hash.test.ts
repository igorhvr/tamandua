/**
 * Tests for src/suite/tree-hash.ts — content-addressed tree hashing
 * utilities for the TSTX test-suite ledger.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createTempHome } from "../../tests/helpers/test-env.ts";

describe("computeTreeHash", () => {
  const th = createTempHome("tamandua-tree-hash-test-");
  let repoDir: string;

  before(() => {
    // Create a temporary git repository.
    repoDir = th.root;
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email test@test.com", { cwd: repoDir });
    execSync("git config user.name Test", { cwd: repoDir });

    // Create an initial commit so HEAD exists.
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
    execSync("git add README.md", { cwd: repoDir });
    execSync("git commit -m init", { cwd: repoDir });

    // Create a .gitignore for testing.
    writeFileSync(join(repoDir, ".gitignore"), "*.log\nignored-dir/\n");
    execSync("git add .gitignore", { cwd: repoDir });
    execSync("git commit -m gitignore", { cwd: repoDir });
  });

  after(() => {
    // createTempHome handles cleanup via after()
  });

  it("returns a 40-char hex string for a valid repo", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash = computeTreeHash(repoDir);
    assert.ok(hash, "should return a non-null hash");
    assert.equal(
      hash.length,
      40,
      "git tree hash should be 40 hex characters",
    );
    assert.ok(/^[0-9a-f]{40}$/.test(hash), "should be all hex");
  });

  it("same tree produces same hash on repeated calls", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash1 = computeTreeHash(repoDir);
    const hash2 = computeTreeHash(repoDir);
    assert.ok(hash1, "first hash should be non-null");
    assert.equal(hash1, hash2, "identical tree should produce identical hash");
  });

  it("editing a tracked file changes the hash", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hashBefore = computeTreeHash(repoDir);
    assert.ok(hashBefore, "initial hash should be non-null");

    // Edit a tracked file without committing.
    writeFileSync(
      join(repoDir, "README.md"),
      "# Test Repo\nEdited content!\n",
    );

    const hashAfter = computeTreeHash(repoDir);
    assert.ok(hashAfter, "hash after edit should be non-null");
    assert.notEqual(
      hashBefore,
      hashAfter,
      "editing a tracked file should change the hash",
    );
  });

  it("untracked files not in .gitignore are included in the tree hash", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hashBefore = computeTreeHash(repoDir);
    assert.ok(hashBefore, "initial hash should be non-null");

    // Add an untracked, non-ignored file.
    writeFileSync(join(repoDir, "new-file.ts"), "const x = 1;\n");

    const hashAfter = computeTreeHash(repoDir);
    assert.ok(hashAfter, "hash after untracked file should be non-null");
    assert.notEqual(
      hashBefore,
      hashAfter,
      "untracked non-ignored file should change the hash",
    );
  });

  it("untracked files in .gitignore are NOT included in the tree hash", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hashBefore = computeTreeHash(repoDir);
    assert.ok(hashBefore, "initial hash should be non-null");

    // Add a file that matches .gitignore (*.log).
    writeFileSync(join(repoDir, "debug.log"), "some log output\n");

    const hashAfter = computeTreeHash(repoDir);
    assert.ok(hashAfter, "hash after ignored file should be non-null");
    assert.equal(
      hashBefore,
      hashAfter,
      "gitignored file should NOT change the hash",
    );
  });

  it("returns null for a non-git directory (R3 passthrough)", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const nonGitDir = createTempHome("tamandua-no-git-").root;
    try {
      const hash = computeTreeHash(nonGitDir);
      assert.equal(hash, null, "non-git directory should return null");
    } finally {
      // createTempHome handles cleanup via after()
    }
  });

  it("returns null for a nonexistent directory", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash = computeTreeHash("/nonexistent/path/for/testing");
    assert.equal(hash, null, "nonexistent directory should return null");
  });

  it("repository real index is not modified after hashing (R2)", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );

    // Capture the git index state before hashing.
    const statusBefore = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
    });

    // Run tree hash computation.
    const hash = computeTreeHash(repoDir);
    assert.ok(hash, "should get a valid hash");

    // Verify index is unchanged.
    const statusAfter = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
    });

    assert.equal(
      statusBefore,
      statusAfter,
      "git index must not be modified by computeTreeHash",
    );
  });

  it("uncommitted tracked changes are reflected in the hash", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );

    const hashBefore = computeTreeHash(repoDir);
    assert.ok(hashBefore, "initial hash should be non-null");

    // Edit a tracked file but DON'T commit.
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\nDirty change!\n");

    const hashDirty = computeTreeHash(repoDir);
    assert.ok(hashDirty, "dirty hash should be non-null");

    // The dirty hash should differ from the original (pre-edit) hash.
    assert.notEqual(
      hashDirty,
      hashBefore,
      "uncommitted edit should change the tree hash",
    );
  });
});

describe("computeCmdHash", () => {
  it("produces deterministic SHA-256", async () => {
    const { computeCmdHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash1 = computeCmdHash("npm test");
    const hash2 = computeCmdHash("npm test");
    assert.equal(hash1, hash2, "same input should produce same hash");
  });

  it("different commands produce different hashes", async () => {
    const { computeCmdHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash1 = computeCmdHash("npm test");
    const hash2 = computeCmdHash("npm run build");
    assert.notEqual(hash1, hash2, "different commands should differ");
  });

  it("produces a 64-char hex string (SHA-256)", async () => {
    const { computeCmdHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash = computeCmdHash("test");
    assert.equal(hash.length, 64, "SHA-256 hex digest is 64 chars");
    assert.ok(/^[0-9a-f]{64}$/.test(hash), "should be all hex");
  });

  it("no normalization — whitespace matters", async () => {
    const { computeCmdHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash1 = computeCmdHash("npm test");
    const hash2 = computeCmdHash("npm  test");
    const hash3 = computeCmdHash("npm test ");
    assert.notEqual(hash1, hash2, "double space changes hash");
    assert.notEqual(hash1, hash3, "trailing space changes hash");
  });

  it("empty string produces a valid hash", async () => {
    const { computeCmdHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const hash = computeCmdHash("");
    assert.ok(hash, "empty string should produce a hash");
    assert.equal(hash.length, 64, "SHA-256 hex digest is 64 chars");
  });
});

describe("getOriginRepo", () => {
  const th2 = createTempHome("tamandua-origin-test-");
  let repoDir: string;

  before(() => {
    repoDir = th2.root;
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email test@test.com", { cwd: repoDir });
    execSync("git config user.name Test", { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "content\n");
    execSync("git add file.txt", { cwd: repoDir });
    execSync("git commit -m init", { cwd: repoDir });
  });

  after(() => {
    // createTempHome handles cleanup via after()
  });

  it("returns the repo realpath for a non-worktree repo", async () => {
    const { getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const { realpathSync } = await import("node:fs");
    const origin = getOriginRepo(repoDir);
    assert.equal(origin, realpathSync(repoDir), "should be repo realpath");
  });

  it("returns the origin repo path for a worktree", async () => {
    // Create a worktree from the main repo.
    const wtTh = createTempHome("tamandua-wt-test-");
    const wtDir = wtTh.root;
    // Remove the home dir created by createTempHome so git worktree add can use an empty dir
    rmSync(wtTh.homeDir, { recursive: true, force: true });
    execSync(`git worktree add "${wtDir}" HEAD`, { cwd: repoDir });

    try {
      const { getOriginRepo } = await import(
        "../../dist/suite/tree-hash.js"
      );
      const { realpathSync } = await import("node:fs");
      const origin = getOriginRepo(wtDir);
      assert.equal(
        origin,
        realpathSync(repoDir),
        "worktree should resolve to origin repo realpath",
      );
    } finally {
      execSync(`git worktree remove "${wtDir}" --force`, { cwd: repoDir });
      // createTempHome handles cleanup via after()
    }
  });

  it("falls back to repoDir realpath on git failure", async () => {
    const { getOriginRepo } = await import(
      "../../dist/suite/tree-hash.js"
    );
    // A non-git directory → should fall back.
    const nonGitDir = createTempHome("tamandua-no-git-origin-").root;
    try {
      const { realpathSync } = await import("node:fs");
      const origin = getOriginRepo(nonGitDir);
      assert.equal(origin, realpathSync(nonGitDir), "should fall back to realpath");
    } finally {
      // createTempHome handles cleanup via after()
    }
  });
});
