/**
 * Tests for src/suite/tree-hash.ts — content-addressed tree hashing
 * utilities for the TSTX test-suite ledger.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("external transport files leave the hash unchanged while in-repo files change it", async () => {
    const { computeTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const externalDir = mkdtempSync(join(tmpdir(), "tamandua-transport-test-"));
    const externalReport = join(externalDir, "report");
    const inRepoReport = join(repoDir, "transport-report");
    const hashBefore = computeTreeHash(repoDir);
    assert.ok(hashBefore, "initial hash should be non-null");

    try {
      writeFileSync(externalReport, "STATUS: done\nCHANGES: external transport\n");
      assert.equal(
        computeTreeHash(repoDir),
        hashBefore,
        "an external transport file must not alter repository evidence",
      );

      writeFileSync(inRepoReport, "STATUS: done\nCHANGES: external transport\n");
      assert.notEqual(
        computeTreeHash(repoDir),
        hashBefore,
        "equivalent untracked transport bytes inside the repo must remain hashed",
      );
    } finally {
      rmSync(inRepoReport, { force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
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

describe("committedTreeHash", () => {
  const th = createTempHome("tamandua-committed-hash-test-");
  let repoDir: string;

  before(() => {
    repoDir = th.root;
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email test@test.com", { cwd: repoDir });
    execSync("git config user.name Test", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
    execSync("git add README.md", { cwd: repoDir });
    execSync("git commit -m init", { cwd: repoDir });
  });

  after(() => {
    // createTempHome handles cleanup via after()
  });

  it("equals shelling git rev-parse HEAD^{tree} on a committed fixture", async () => {
    const { committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const expected = execSync("git rev-parse HEAD^{tree}", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    const hash = committedTreeHash(repoDir);
    assert.equal(hash, expected, "should equal git rev-parse HEAD^{tree}");
  });

  it("returns null on a non-git directory", async () => {
    const { committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const nonGitDir = createTempHome("tamandua-no-git-committed-").root;
    try {
      const hash = committedTreeHash(nonGitDir);
      assert.equal(hash, null, "non-git directory should return null");
    } finally {
      // createTempHome handles cleanup via after()
    }
  });

  it("returns null on a repo with no commits", async () => {
    const { committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const emptyRepo = createTempHome("tamandua-empty-repo-").root;
    try {
      execSync("git init", { cwd: emptyRepo });
      const hash = committedTreeHash(emptyRepo);
      assert.equal(hash, null, "empty repo should return null");
    } finally {
      // createTempHome handles cleanup via after()
    }
  });
});

describe("trackedTreeHash", () => {
  const th = createTempHome("tamandua-tracked-hash-test-");
  let repoDir: string;

  before(() => {
    repoDir = th.root;
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email test@test.com", { cwd: repoDir });
    execSync("git config user.name Test", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
    writeFileSync(join(repoDir, "src.ts"), "const x = 1;\n");
    execSync("git add README.md src.ts", { cwd: repoDir });
    execSync("git commit -m init", { cwd: repoDir });
  });

  after(() => {
    // createTempHome handles cleanup via after()
  });

  it("== committedTreeHash on a clean tree", async () => {
    const { trackedTreeHash, committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const committed = committedTreeHash(repoDir);
    const tracked = trackedTreeHash(repoDir);
    assert.ok(committed, "committed hash should be non-null");
    assert.ok(tracked, "tracked hash should be non-null");
    assert.equal(tracked, committed, "clean tree should match");
  });

  it("== committedTreeHash when untracked non-ignored file present (add -u ignores untracked)", async () => {
    const { trackedTreeHash, committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    // Add an untracked, non-ignored file.
    writeFileSync(join(repoDir, "untracked.txt"), "not tracked\n");

    const committed = committedTreeHash(repoDir);
    const tracked = trackedTreeHash(repoDir);
    assert.ok(committed, "committed hash should be non-null");
    assert.ok(tracked, "tracked hash should be non-null");
    assert.equal(
      tracked,
      committed,
      "untracked file should be ignored by trackedTreeHash",
    );
  });

  it("DIFFERS from committedTreeHash when a tracked file is modified", async () => {
    const { trackedTreeHash, committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\nedited!\n");

    try {
      const committed = committedTreeHash(repoDir);
      const tracked = trackedTreeHash(repoDir);
      assert.ok(committed, "committed hash should be non-null");
      assert.ok(tracked, "tracked hash should be non-null");
      assert.notEqual(
        tracked,
        committed,
        "modified tracked file should change hash",
      );
    } finally {
      // Restore clean state for subsequent tests.
      execSync("git checkout -- README.md", { cwd: repoDir });
    }
  });

  it("DIFFERS when a tracked file is deleted", async () => {
    const { trackedTreeHash, committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    rmSync(join(repoDir, "src.ts"));

    try {
      const committed = committedTreeHash(repoDir);
      const tracked = trackedTreeHash(repoDir);
      assert.ok(committed, "committed hash should be non-null");
      assert.ok(tracked, "tracked hash should be non-null");
      assert.notEqual(
        tracked,
        committed,
        "deleted tracked file should change hash",
      );
    } finally {
      // Restore deleted file for subsequent tests.
      execSync("git checkout -- src.ts", { cwd: repoDir });
    }
  });

  it("DIFFERS when a change is staged but uncommitted", async () => {
    const { trackedTreeHash, committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    // Stage but don't commit.
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\nstaged change\n");
    execSync("git add README.md", { cwd: repoDir });

    try {
      const committed = committedTreeHash(repoDir);
      const tracked = trackedTreeHash(repoDir);
      assert.ok(committed, "committed hash should be non-null");
      assert.ok(tracked, "tracked hash should be non-null");
      assert.notEqual(
        tracked,
        committed,
        "staged change should differ from committed hash",
      );
    } finally {
      // Unstage and restore file for subsequent tests.
      execSync("git reset HEAD README.md", { cwd: repoDir });
      execSync("git checkout -- README.md", { cwd: repoDir });
    }
  });

  it("dirty .gitignore'd file leaves trackedTreeHash == committedTreeHash", async () => {
    const { trackedTreeHash, committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    // Add a .gitignore that covers *.log
    writeFileSync(join(repoDir, ".gitignore"), "*.log\n");
    execSync("git add .gitignore", { cwd: repoDir });
    execSync("git commit -m gitignore", { cwd: repoDir });

    // Create an ignored file.
    writeFileSync(join(repoDir, "debug.log"), "ignored content\n");

    const committed = committedTreeHash(repoDir);
    const tracked = trackedTreeHash(repoDir);
    assert.ok(committed, "committed hash should be non-null");
    assert.ok(tracked, "tracked hash should be non-null");
    assert.equal(
      tracked,
      committed,
      "ignored file should not affect trackedTreeHash",
    );
  });

  it("returns null on a non-git directory", async () => {
    const { trackedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const nonGitDir = createTempHome("tamandua-no-git-tracked-").root;
    try {
      const hash = trackedTreeHash(nonGitDir);
      assert.equal(hash, null, "non-git directory should return null");
    } finally {
      // createTempHome handles cleanup via after()
    }
  });
});

describe("R2 invariant (committedTreeHash + trackedTreeHash)", () => {
  const th = createTempHome("tamandua-r2-invariant-test-");
  let repoDir: string;

  before(() => {
    repoDir = th.root;
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email test@test.com", { cwd: repoDir });
    execSync("git config user.name Test", { cwd: repoDir });
    writeFileSync(join(repoDir, "tracked.txt"), "tracked content\n");
    execSync("git add tracked.txt", { cwd: repoDir });
    execSync("git commit -m init", { cwd: repoDir });

    // Dirty the working tree: untracked file + modified tracked file.
    writeFileSync(join(repoDir, "untracked.txt"), "untracked file\n");
    writeFileSync(join(repoDir, "tracked.txt"), "modified content\n");
  });

  after(() => {
    // createTempHome handles cleanup via after()
  });

  it("git status --porcelain is identical before/after committedTreeHash", async () => {
    const { committedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const statusBefore = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
    });

    const hash = committedTreeHash(repoDir);
    assert.ok(hash, "should get a valid hash");

    const statusAfter = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
    });
    assert.equal(statusBefore, statusAfter, "committedTreeHash must not modify the real index");
  });

  it("git status --porcelain is identical before/after trackedTreeHash", async () => {
    const { trackedTreeHash } = await import(
      "../../dist/suite/tree-hash.js"
    );
    const statusBefore = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
    });

    const hash = trackedTreeHash(repoDir);
    assert.ok(hash, "should get a valid hash");

    const statusAfter = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
    });
    assert.equal(statusBefore, statusAfter, "trackedTreeHash must not modify the real index");
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
