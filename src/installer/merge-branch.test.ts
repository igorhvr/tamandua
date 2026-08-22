import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  runPlumbingMerge,
  type MergeBranchEvent,
} from "../../dist/installer/merge-branch.js";
import type { CheckoutRefreshOutcome } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

const cleanup: string[] = [];

function git(repo: string, args: string[]): string {
  const result = rawGit(repo, args);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function rawGit(repo: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function treeFromIndexCopy(repo: string, indexPath: string): string {
  const scratch = tamanduaTempDir("tamandua-merge-branch-index-copy-");
  cleanup.push(scratch);
  const copiedIndex = path.join(scratch, "index");
  fs.copyFileSync(indexPath, copiedIndex);
  const result = spawnSync("git", ["write-tree"], {
    cwd: repo,
    env: {
      HOME: scratch,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_INDEX_FILE: copiedIndex,
    },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `git write-tree with copied index failed: ${result.stderr ?? result.stdout}`);
  return (result.stdout ?? "").trim();
}

function createRepo(): { repo: string; initial: string } {
  const repo = tamanduaTempDir("tamandua-merge-branch-");
  cleanup.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@tamandua.local"]);
  git(repo, ["config", "user.name", "Tamandua Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { repo, initial: git(repo, ["rev-parse", "HEAD"]) };
}

function createFeature(repo: string, branch = "feature"): string {
  git(repo, ["switch", "-c", branch]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf-8");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  const featureTip = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["switch", "main"]);
  return featureTip;
}

function captureFileBytes(worktree: string, args: string[]): Array<[string, Buffer]> {
  const files = git(worktree, args)
    .split("\n")
    .filter(Boolean)
    .sort();
  return files.map((file) => [file, fs.readFileSync(path.join(worktree, file))]);
}

function captureCheckoutState(worktree: string): {
  branch: string;
  head: string;
  indexTree: string;
  indexBytes: Buffer;
  status: string;
  trackedBytes: Buffer;
  untrackedBytes?: Buffer;
  trackedFiles: Array<[string, Buffer]>;
  untrackedFiles: Array<[string, Buffer]>;
} {
  const indexPath = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const untrackedPath = path.join(worktree, "operator-notes.txt");
  return {
    branch: git(worktree, ["symbolic-ref", "HEAD"]),
    head: git(worktree, ["rev-parse", "HEAD"]),
    indexTree: treeFromIndexCopy(worktree, indexPath),
    indexBytes: fs.readFileSync(indexPath),
    status: git(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
    trackedBytes: fs.readFileSync(path.join(worktree, "base.txt")),
    untrackedBytes: fs.existsSync(untrackedPath) ? fs.readFileSync(untrackedPath) : undefined,
    trackedFiles: captureFileBytes(worktree, ["ls-files", "--cached"]),
    untrackedFiles: captureFileBytes(worktree, ["ls-files", "--others", "--exclude-standard"]),
  };
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runPlumbingMerge", () => {
  it("accepts all checkout refresh outcomes and parked merge metadata", () => {
    const outcomes: CheckoutRefreshOutcome[] = [
      "refreshed",
      "already-coherent",
      "not-applicable",
      "parked:main-tamandua-parked-20260720T152300Z-db40fbc2",
    ];
    const event: MergeBranchEvent = {
      ts: new Date(0).toISOString(),
      event: "merge.landed",
      runId: "run-types",
      origin: "/origin",
      branch: "feature",
      target: "refs/heads/main",
      expectedTip: "1".repeat(40),
      parkedBranch: "main-tamandua-parked-20260720T152300Z-db40fbc2",
      parkedReason: "local-changes",
    };
    assert.equal(outcomes[3]?.startsWith("parked:"), true);
    assert.equal(event.parkedReason, "local-changes");
  });

  it("returns an already-coherent ancestor no-op for a single attached owner without checkout mutation", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);
    const targetTip = git(repo, ["rev-parse", "refs/heads/main"]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];
    const checkoutBefore = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: targetTip, message: "owned no-op" },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(featureTip, targetTip);
    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.checkoutRefresh, "already-coherent");
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(commands.some((args) => ["update-ref", "symbolic-ref", "read-tree"].includes(args[0]!)), false);
    assert.equal(events[0]?.checkoutRefresh, "already-coherent");
  });

  it("reports not-applicable when a no-op owner's live HEAD no longer matches metadata", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: featureTip, message: "raced no-op" },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          if (origin === repo && args.join(" ") === "rev-parse --verify HEAD^{commit}") {
            return { status: 0, stdout: "f".repeat(40), stderr: "" };
          }
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(commands.some((args) => ["update-ref", "symbolic-ref", "read-tree"].includes(args[0]!)), false);
  });

  it("reports not-applicable when no-op ownership metadata has a stale HEAD", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: featureTip, message: "stale metadata no-op" },
      {
        runGit: (origin, args) => {
          const actual = rawGit(origin, args);
          if (args[0] === "worktree" && args[1] === "list") {
            return { ...actual, stdout: actual.stdout.replace(featureTip, "e".repeat(40)) };
          }
          return actual;
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.checkoutRefresh, "not-applicable");
  });

  it("allows a no-op with unusable ownership metadata and reports not-applicable", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: featureTip, message: "metadata-safe no-op" },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          if (args[0] === "worktree" && args[1] === "list") {
            return { status: 0, stdout: `worktree ${repo}\0branch refs/heads/main\0\0`, stderr: "" };
          }
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(commands.some((args) => ["update-ref", "symbolic-ref", "read-tree"].includes(args[0]!)), false);
  });

  it("returns an already-coherent equal-tree no-op for a single attached owner", () => {
    const { repo, initial } = createRepo();
    const featureTip = createFeature(repo);
    const featureTree = git(repo, ["rev-parse", `${featureTip}^{tree}`]);
    const equivalentTarget = git(repo, ["commit-tree", featureTree, "-p", initial, "-m", "equivalent target"]);
    git(repo, ["reset", "--hard", equivalentTarget]);
    const commands: string[][] = [];
    const before = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: equivalentTarget, message: "equal-tree no-op" },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.checkoutRefresh, "already-coherent");
    assert.deepEqual(captureCheckoutState(repo), before);
    assert.equal(commands.some((args) => ["update-ref", "symbolic-ref", "read-tree"].includes(args[0]!)), false);
  });

  it("refuses each named operation in progress through owner-relative git-path resolution", () => {
    const sentinels = [
      ["MERGE_HEAD", /merge operation/i],
      ["CHERRY_PICK_HEAD", /cherry-pick operation/i],
      ["REVERT_HEAD", /revert operation/i],
      ["BISECT_LOG", /bisect operation/i],
      ["rebase-merge", /rebase operation/i],
      ["rebase-apply", /rebase operation/i],
    ] as const;

    for (const [sentinel, operation] of sentinels) {
      const { repo, initial } = createRepo();
      const branch = `feature-${sentinel.toLowerCase().replaceAll("_", "-")}`;
      createFeature(repo, branch);
      const sentinelPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", sentinel]);
      if (sentinel.startsWith("rebase-")) fs.mkdirSync(sentinelPath, { recursive: true });
      else fs.writeFileSync(sentinelPath, `${sentinel}\n`, "utf-8");
      const commands: string[][] = [];

      const result = runPlumbingMerge(
        { origin: repo, branch, into: "main", expectTip: initial, message: "operation must refuse" },
        {
          runGit: (origin, args) => {
            commands.push([...args]);
            return rawGit(origin, args);
          },
        },
      );

      assert.equal(result.status, "operational_error", sentinel);
      if (result.status !== "operational_error") continue;
      assert.match(result.detail, operation);
      assert.ok(commands.some((args) => args.join(" ") === `rev-parse --git-path ${sentinel}`));
      assert.equal(commands.some((args) => ["update-ref", "symbolic-ref", "read-tree"].includes(args[0]!)), false);
    }
  });

  it("refuses when the attached owner HEAD differs from the CAS-verified target tip", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const racedHead = "9".repeat(40);
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "head race" },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          if (origin === repo && args.join(" ") === "rev-parse --verify HEAD^{commit}") {
            return { status: 0, stdout: racedHead, stderr: "" };
          }
          return rawGit(origin, args);
        },
      },
    );

    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /HEAD.*disagrees.*expected target tip/i);
    assert.match(result.detail, new RegExp(racedHead));
    assert.equal(commands.some((args) => ["update-ref", "symbolic-ref", "read-tree"].includes(args[0]!)), false);
  });

  it("refreshes a clean owner with untracked files and parks staged or unstaged tracked changes", () => {
    for (const change of ["untracked", "unstaged", "staged"] as const) {
      const { repo, initial } = createRepo();
      const branch = `feature-${change}`;
      createFeature(repo, branch);
      const localPath = change === "untracked" ? path.join(repo, "notes.txt") : path.join(repo, "base.txt");
      const localBytes = Buffer.from(`${change} operator bytes\n`);
      fs.writeFileSync(localPath, localBytes);
      if (change === "staged") git(repo, ["add", "base.txt"]);
      const commands: string[][] = [];
      const events: MergeBranchEvent[] = [];

      const result = runPlumbingMerge(
        {
          origin: repo,
          branch,
          into: "main",
          expectTip: initial,
          message: "managed owner",
          runId: "db40fbc2-1234-5678",
        },
        {
          runGit: (origin, args) => {
            commands.push([...args]);
            return rawGit(origin, args);
          },
          emitEvent: (event) => events.push(event),
        },
      );

      assert.equal(result.status, "landed");
      assert.equal(result.exitCode, 0);
      if (result.status !== "landed") continue;
      assert.ok(commands.some((args) => args.join(" ") === "--no-optional-locks status --porcelain=v1 --untracked-files=no"));
      assert.deepEqual(fs.readFileSync(localPath), localBytes);
      assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), result.mergedCommit);

      const backupCreateIndex = commands.findIndex((args) =>
        args[0] === "update-ref" && args[1]?.startsWith("refs/heads/main-tamandua-parked-") && args[3] === "0".repeat(40)
      );
      const parkIndex = commands.findIndex((args) => args[0] === "symbolic-ref" && args[1] === "HEAD" && args[2]?.includes("tamandua-parked"));
      const landIndex = commands.findIndex((args) => args[0] === "update-ref" && args[3] === "refs/heads/main");
      assert.ok(backupCreateIndex >= 0 && backupCreateIndex < parkIndex && parkIndex < landIndex);

      if (change === "untracked") {
        assert.equal(result.checkoutRefresh, "refreshed");
        assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert.equal(fs.existsSync(path.join(repo, "feature.txt")), true);
        assert.equal(commands.some((args) => args.join(" ").startsWith("read-tree -m -u ")), true);
        assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/*-tamandua-parked-*"]), "");
      } else {
        assert.match(result.checkoutRefresh, /^parked:main-tamandua-parked-\d{8}T\d{6}Z-db40fbc2$/);
        assert.equal(result.parkedReason, "local-changes");
        assert.equal(result.parkedBranch, result.checkoutRefresh.slice("parked:".length));
        assert.equal(git(repo, ["symbolic-ref", "HEAD"]), `refs/heads/${result.parkedBranch}`);
        assert.equal(git(repo, ["rev-parse", `refs/heads/${result.parkedBranch}`]), initial);
        assert.equal(commands.some((args) => args[0] === "read-tree"), false);
        assert.equal(events[0]?.parkedReason, "local-changes");
      }
    }
  });

  it("uses a manual lowercase-hex suffix when no run id is available", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    fs.writeFileSync(path.join(repo, "base.txt"), "dirty operator bytes\n", "utf-8");

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature",
        into: "main",
        expectTip: initial,
        message: "manual managed owner",
        runId: "",
      },
      { emitEvent: () => undefined },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.match(result.checkoutRefresh, /^parked:main-tamandua-parked-\d{8}T\d{6}Z-manual-[0-9a-f]{6}$/);
    assert.equal(result.parkedBranch, result.checkoutRefresh.slice("parked:".length));
  });

  it("refuses a colliding backup ref before mutating HEAD or the target with a bounded diagnostic", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const symbolicHeadBefore = git(repo, ["symbolic-ref", "HEAD"]);
    const indexPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = fs.readFileSync(indexPath);
    let collidingRef = "";
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "backup collision", runId: "collision-run" },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          if (args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[3] === "0".repeat(40)) {
            collidingRef = args[1];
            git(repo, ["update-ref", collidingRef, initial]);
            return { status: 128, stdout: "", stderr: `fatal: ${"diagnostic ".repeat(200)}reference already exists` };
          }
          return rawGit(origin, args);
        },
        emitEvent: () => assert.fail("a refused backup collision must not emit an event"),
      },
    );

    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.ok(result.detail.length <= 512);
    assert.match(result.detail, /cannot create backup/);
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), symbolicHeadBefore);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.deepEqual(fs.readFileSync(indexPath), indexBefore);
    assert.equal(git(repo, ["rev-parse", collidingRef]), initial);
    assert.equal(commands.some((args) => args[0] === "symbolic-ref" || (args[0] === "update-ref" && args[3] === "refs/heads/main")), false);
  });

  it("fully unparks after target CAS failure and preserves target-moved classification", () => {
    for (const failure of ["operational", "target-moved"] as const) {
      const { repo, initial } = createRepo();
      createFeature(repo, `feature-${failure}`);
      let competingTip = "";
      let backupRef = "";
      const commands: string[][] = [];

      const result = runPlumbingMerge(
        { origin: repo, branch: `feature-${failure}`, into: "main", expectTip: initial, message: `CAS ${failure}`, runId: `cas-${failure}` },
        {
          runGit: (origin, args) => {
            commands.push([...args]);
            if (args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[2] === initial) backupRef = args[1];
            if (args[0] === "update-ref" && args[3] === "refs/heads/main" && args[5] === initial) {
              if (failure === "target-moved") {
                const tree = git(repo, ["rev-parse", `${initial}^{tree}`]);
                competingTip = git(repo, ["commit-tree", tree, "-p", initial, "-m", "competing target"]);
                git(repo, ["update-ref", "refs/heads/main", competingTip, initial]);
              }
              return { status: 128, stdout: "", stderr: failure === "operational" ? "permission denied" : "reference is at another value" };
            }
            return rawGit(origin, args);
          },
          emitEvent: () => undefined,
        },
      );

      assert.equal(result.status, failure === "operational" ? "operational_error" : "target_moved");
      assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
      assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), failure === "operational" ? initial : competingTip);
      assert.notEqual(backupRef, "");
      assert.notEqual(rawGit(repo, ["rev-parse", "--verify", backupRef]).status, 0);
      assert.ok(commands.some((args) => args.join(" ") === `update-ref -d ${backupRef} ${initial}`));
    }
  });

  it("diagnoses a checkout left parked when target CAS and un-park retries both fail", () => {
    for (const failure of ["operational", "target-moved"] as const) {
      const { repo, initial } = createRepo();
      createFeature(repo, `feature-parked-${failure}`);
      let backupRef = "";
      let unparkAttempts = 0;

      const result = runPlumbingMerge(
        {
          origin: repo,
          branch: `feature-parked-${failure}`,
          into: "main",
          expectTip: initial,
          message: `parked CAS ${failure}`,
          runId: `parked-cas-${failure}`,
        },
        {
          runGit: (origin, args) => {
            const isBackup = args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[3] === "0".repeat(40);
            const isTargetCas = args[0] === "update-ref" && args[3] === "refs/heads/main" && args[5] === initial;
            const isUnpark = args.join(" ") === "symbolic-ref HEAD refs/heads/main";
            if (isBackup) backupRef = args[1]!;
            if (isTargetCas) {
              if (failure === "target-moved") {
                const tree = git(repo, ["rev-parse", `${initial}^{tree}`]);
                const competingTip = git(repo, ["commit-tree", tree, "-p", initial, "-m", "competing target"]);
                git(repo, ["update-ref", "refs/heads/main", competingTip, initial]);
              }
              return { status: 128, stdout: "", stderr: "injected target CAS failure" };
            }
            if (isUnpark) {
              unparkAttempts += 1;
              return { status: 128, stdout: "", stderr: "injected persistent un-park failure" };
            }
            return rawGit(origin, args);
          },
          emitEvent: () => undefined,
        },
      );

      assert.equal(unparkAttempts, 2);
      assert.equal(result.status, failure === "operational" ? "operational_error" : "target_moved");
      if (result.status !== "operational_error" && result.status !== "target_moved") continue;
      assert.ok(result.detail.length <= 512);
      assert.match(result.detail, /checkout remains parked/);
      assert.notEqual(backupRef, "");
      assert.ok(result.detail.includes(backupRef));
      assert.ok(result.detail.includes(`git -C '${repo}' symbolic-ref HEAD 'refs/heads/main'`));
      assert.equal(git(repo, ["symbolic-ref", "HEAD"]), backupRef);
    }
  });

  it("leaves a stray backup without re-parking when target CAS and backup cleanup fail", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, "feature-cas-cleanup-failure");
    let backupRef = "";
    let cleanupAttempts = 0;

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature-cas-cleanup-failure",
        into: "main",
        expectTip: initial,
        message: "CAS cleanup failure",
        runId: "cas-cleanup-failure",
      },
      {
        runGit: (origin, args) => {
          const isBackup = args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[3] === "0".repeat(40);
          const isTargetCas = args[0] === "update-ref" && args[3] === "refs/heads/main" && args[5] === initial;
          const isCleanup = args[0] === "update-ref" && args[1] === "-d" && args[2]?.includes("tamandua-parked");
          if (isBackup) backupRef = args[1]!;
          if (isTargetCas) return { status: 128, stdout: "", stderr: "injected target CAS failure" };
          if (isCleanup) {
            cleanupAttempts += 1;
            return { status: 128, stdout: "", stderr: "injected persistent backup cleanup failure" };
          }
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(cleanupAttempts, 2);
    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.equal(git(repo, ["rev-parse", backupRef]), initial);
    assert.match(result.detail, /stray backup/);
    assert.ok(result.detail.includes(backupRef));
    assert.ok(result.detail.length <= 512);
  });

  it("parks a clean owner when read-tree refuses and preserves an offending untracked path in bounded diagnostics", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const collisionPath = path.join(repo, "feature.txt");
    const collisionBytes = Buffer.from("operator collision bytes\n");
    fs.writeFileSync(collisionPath, collisionBytes);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "collision fallback", runId: "read-tree-collision" },
      {
        runGit: (origin, args) => {
          if (args[0] === "read-tree") {
            return {
              status: 128,
              stdout: "",
              stderr: `${"noise ".repeat(200)}\nerror: Untracked working tree file 'feature.txt' would be overwritten by merge.`,
            };
          }
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.match(result.checkoutRefresh, /^parked:/);
    assert.match(result.parkedReason ?? "", /^advance-refused: /);
    assert.match(result.parkedReason ?? "", /feature\.txt/);
    assert.ok((result.parkedReason ?? "").length <= 512);
    assert.deepEqual(fs.readFileSync(collisionPath), collisionBytes);
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), `refs/heads/${result.parkedBranch}`);
    assert.equal(git(repo, ["rev-parse", `refs/heads/${result.parkedBranch}`]), initial);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), result.mergedCommit);
  });

  it("leaves only untouched, consistently parked, or fully completed states when each mutating boundary fails once", () => {
    const boundaries = ["backup", "park", "land", "refresh", "reattach", "cleanup"] as const;
    for (const boundary of boundaries) {
      const { repo, initial } = createRepo();
      createFeature(repo, `feature-${boundary}`);
      const initialTree = git(repo, ["rev-parse", `${initial}^{tree}`]);
      let mergedCommit = "";
      let backupRef = "";
      let parked = false;
      let failed = false;

      runPlumbingMerge(
        { origin: repo, branch: `feature-${boundary}`, into: "main", expectTip: initial, message: `fault ${boundary}`, runId: `fault-${boundary}` },
        {
          runGit: (origin, args) => {
            const isBackup = args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[3] === "0".repeat(40);
            const isPark = args[0] === "symbolic-ref" && args[2]?.includes("tamandua-parked");
            const isLand = args[0] === "update-ref" && args[3] === "refs/heads/main" && args[5] === initial;
            const isRefresh = args[0] === "read-tree";
            const isReattach = parked && args.join(" ") === "symbolic-ref HEAD refs/heads/main";
            const isCleanup = args[0] === "update-ref" && args[1] === "-d" && args[2]?.includes("tamandua-parked");
            const matches = { backup: isBackup, park: isPark, land: isLand, refresh: isRefresh, reattach: isReattach, cleanup: isCleanup }[boundary];
            if (isBackup) backupRef = args[1]!;
            if (matches && !failed) {
              failed = true;
              return { status: 128, stdout: "", stderr: `injected ${boundary} failure` };
            }
            const actual = rawGit(origin, args);
            if (args[0] === "commit-tree" && actual.status === 0) mergedCommit = actual.stdout;
            if (isPark && actual.status === 0) parked = true;
            return actual;
          },
          emitEvent: () => undefined,
        },
      );

      assert.equal(failed, true, `${boundary} boundary was not exercised`);
      const symbolicHead = rawGit(repo, ["symbolic-ref", "HEAD"]);
      assert.equal(symbolicHead.status, 0, `${boundary}: HEAD must never be detached`);
      const targetTip = git(repo, ["rev-parse", "refs/heads/main"]);
      const backup = backupRef ? rawGit(repo, ["rev-parse", "--verify", backupRef]) : { status: 1, stdout: "", stderr: "" };
      const indexTree = git(repo, ["write-tree"]);
      const completedTree = mergedCommit ? git(repo, ["rev-parse", `${mergedCommit}^{tree}`]) : "";
      const untouched = targetTip === initial && symbolicHead.stdout === "refs/heads/main" && backup.status !== 0 && indexTree === initialTree;
      const consistentlyParked = targetTip === mergedCommit && symbolicHead.stdout === backupRef && backup.stdout === initial && indexTree === initialTree;
      const completed = targetTip === mergedCommit && symbolicHead.stdout === "refs/heads/main" && backup.status !== 0 && indexTree === completedTree;
      assert.equal(untouched || consistentlyParked || completed, true,
        `${boundary}: illegal state target=${targetTip} HEAD=${symbolicHead.stdout} backup=${backup.stdout} index=${indexTree}`);
      assert.equal(targetTip !== initial && symbolicHead.stdout === "refs/heads/main" && indexTree === initialTree, false,
        `${boundary}: target moved underneath an attached stale checkout`);
    }
  });

  it("falls back to a consistent parked state when backup cleanup keeps failing", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, "feature-cleanup-persistent");
    const initialTree = git(repo, ["rev-parse", `${initial}^{tree}`]);
    let backupRef = "";
    let cleanupAttempts = 0;

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature-cleanup-persistent",
        into: "main",
        expectTip: initial,
        message: "persistent cleanup fault",
        runId: "cleanup-persistent",
      },
      {
        runGit: (origin, args) => {
          const isBackup = args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[3] === "0".repeat(40);
          const isCleanup = args[0] === "update-ref" && args[1] === "-d" && args[2]?.includes("tamandua-parked");
          if (isBackup) backupRef = args[1]!;
          if (isCleanup) {
            cleanupAttempts += 1;
            return { status: 128, stdout: "", stderr: "injected persistent cleanup failure" };
          }
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(cleanupAttempts, 2);
    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, `parked:${result.parkedBranch}`);
    assert.equal(`refs/heads/${result.parkedBranch}`, backupRef);
    assert.match(result.parkedReason ?? "", /^advance-refused: /);
    assert.match(result.parkedReason ?? "", /cleanup/);
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), backupRef);
    assert.equal(git(repo, ["rev-parse", backupRef]), initial);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), result.mergedCommit);
    assert.equal(git(repo, ["write-tree"]), initialTree);
  });

  it("reports a parked checkout as inconsistent when reattach and content rollback both fail", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, "feature-reattach-rollback-failure");
    let backupRef = "";
    let readTreeAttempts = 0;
    let reattachAttempts = 0;

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature-reattach-rollback-failure",
        into: "main",
        expectTip: initial,
        message: "reattach and rollback failure",
        runId: "reattach-rollback-failure",
      },
      {
        runGit: (origin, args) => {
          const isBackup = args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[3] === "0".repeat(40);
          const isReattach = args.join(" ") === "symbolic-ref HEAD refs/heads/main";
          if (isBackup) backupRef = args[1]!;
          if (isReattach) {
            reattachAttempts += 1;
            return { status: 128, stdout: "", stderr: "injected persistent reattach failure" };
          }
          if (args[0] === "read-tree") {
            readTreeAttempts += 1;
            if (readTreeAttempts > 1) {
              return { status: 128, stdout: "", stderr: "injected persistent content rollback failure" };
            }
          }
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(reattachAttempts, 2);
    assert.equal(readTreeAttempts, 3);
    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, `parked:${result.parkedBranch}`);
    assert.equal(`refs/heads/${result.parkedBranch}`, backupRef);
    assert.match(result.parkedReason ?? "", /^parked-inconsistent: /);
    assert.match(result.parkedReason ?? "", /reattach failed/);
    assert.match(result.parkedReason ?? "", /content rollback failed/);
    assert.ok((result.parkedReason ?? "").length <= 512);
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), backupRef);
    assert.equal(git(repo, ["write-tree"]), result.mergedTree);
  });

  it("retains honest parked metadata when cleanup rollback and final recovery all fail", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, "feature-cleanup-deep-failure");
    let backupRef = "";
    let cleanupAttempts = 0;
    let readTreeAttempts = 0;
    let targetAttachmentAttempts = 0;

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature-cleanup-deep-failure",
        into: "main",
        expectTip: initial,
        message: "cleanup deep failure",
        runId: "cleanup-deep-failure",
      },
      {
        runGit: (origin, args) => {
          const isBackup = args[0] === "update-ref" && args[1]?.includes("tamandua-parked") && args[3] === "0".repeat(40);
          const isCleanup = args[0] === "update-ref" && args[1] === "-d" && args[2]?.includes("tamandua-parked");
          const isTargetAttachment = args.join(" ") === "symbolic-ref HEAD refs/heads/main";
          if (isBackup) backupRef = args[1]!;
          if (isCleanup) {
            cleanupAttempts += 1;
            return { status: 128, stdout: "", stderr: "injected persistent cleanup failure" };
          }
          if (isTargetAttachment) {
            targetAttachmentAttempts += 1;
            if (targetAttachmentAttempts > 1) {
              return { status: 128, stdout: "", stderr: "injected final target recovery failure" };
            }
          }
          if (args[0] === "read-tree") {
            readTreeAttempts += 1;
            if (readTreeAttempts > 1) {
              return { status: 128, stdout: "", stderr: "injected rollback and final refresh failure" };
            }
          }
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(cleanupAttempts, 2);
    assert.equal(targetAttachmentAttempts, 3);
    assert.equal(readTreeAttempts, 5);
    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, `parked:${result.parkedBranch}`);
    assert.equal(`refs/heads/${result.parkedBranch}`, backupRef);
    assert.match(result.parkedReason ?? "", /^parked-inconsistent: /);
    assert.match(result.parkedReason ?? "", /cleanup failed/);
    assert.match(result.parkedReason ?? "", /content rollback failed/);
    assert.match(result.parkedReason ?? "", /final recovery failed/);
    assert.ok((result.parkedReason ?? "").length <= 512);
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), backupRef);
    assert.equal(git(repo, ["write-tree"]), result.mergedTree);
  });

  it("lands into an unowned target when metadata also contains a detached worktree", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    git(repo, ["branch", "release", initial]);
    const detachedWorktree = tamanduaTempDir("tamandua-merge-branch-detached-");
    cleanup.push(detachedWorktree);
    git(repo, ["worktree", "add", "--detach", detachedWorktree, initial]);
    assert.notEqual(rawGit(detachedWorktree, ["symbolic-ref", "HEAD"]).status, 0);
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "release", expectTip: initial, message: "detached metadata is safe", runId: "run-detached" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.noop, false);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/release"]), result.mergedCommit);
    assert.equal(git(detachedWorktree, ["rev-parse", "HEAD"]), initial);
    assert.deepEqual(events.map(({ event, checkoutRefresh, noop }) => ({ event, checkoutRefresh, noop })), [
      { event: "merge.landed", checkoutRefresh: "not-applicable", noop: false },
    ]);
  });

  it("IDEM returns a no-op landing when the branch is already ancestral to the target", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);
    const targetTip = git(repo, ["rev-parse", "refs/heads/main"]);
    git(repo, ["branch", "staging", targetTip]);
    const targetTree = git(repo, ["rev-parse", `${targetTip}^{tree}`]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];
    const checkoutBefore = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: targetTip, message: "must not duplicate", runId: "run-noop-ancestor" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(featureTip, targetTip);
    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.mergedCommit, targetTip);
    assert.equal(result.mergedTree, targetTree);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), targetTip);
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(commands.some((args) => args[0] === "commit-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.deepEqual(events, [
      {
        ts: events[0]?.ts,
        event: "merge.landed",
        runId: "run-noop-ancestor",
        origin: repo,
        branch: "feature",
        target: "refs/heads/staging",
        expectedTip: targetTip,
        mergedTree: targetTree,
        mergedCommit: targetTip,
        checkoutRefresh: "not-applicable",
        noop: true,
      },
    ]);
  });

  it("IDEM returns a no-op landing when a non-ancestral branch produces the target tree", () => {
    const { repo, initial } = createRepo();
    const featureTip = createFeature(repo);
    const targetTree = git(repo, ["rev-parse", `${featureTip}^{tree}`]);
    const equivalentTarget = git(repo, ["commit-tree", targetTree, "-p", initial, "-m", "equivalent upstream change"]);
    git(repo, ["branch", "staging", equivalentTarget]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];
    const checkoutBefore = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: equivalentTarget, message: "must not duplicate", runId: "run-noop-tree" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.notEqual(featureTip, equivalentTarget);
    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.mergedCommit, equivalentTarget);
    assert.equal(result.mergedTree, targetTree);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), equivalentTarget);
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(commands.some((args) => args[0] === "commit-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, true);
    assert.equal(events[0]?.mergedCommit, equivalentTarget);
    assert.equal(events[0]?.mergedTree, targetTree);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  it("reports not-applicable for an unowned no-op target without mutating checkout bytes", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["branch", "staging", featureTip]);
    fs.writeFileSync(path.join(repo, "operator-notes.txt"), "operator bytes\n", "utf-8");
    const checkoutBefore = captureCheckoutState(repo);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: featureTip, message: "unowned no-op", runId: "run-noop-unowned" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), featureTip);
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(commands.some((args) => args[0] === "read-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.deepEqual(events.map(({ event, noop, checkoutRefresh }) => ({ event, noop, checkoutRefresh })), [
      { event: "merge.landed", noop: true, checkoutRefresh: "not-applicable" },
    ]);
  });

  it("IDEM lands remaining changes from a partially pre-applied branch", () => {
    const { repo } = createRepo();
    git(repo, ["switch", "-c", "feature"]);
    fs.writeFileSync(path.join(repo, "shared.txt"), "shared\n", "utf-8");
    git(repo, ["add", "shared.txt"]);
    git(repo, ["commit", "-m", "shared change"]);
    const sharedCommit = git(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "remaining.txt"), "remaining\n", "utf-8");
    git(repo, ["add", "remaining.txt"]);
    git(repo, ["commit", "-m", "remaining change"]);
    git(repo, ["switch", "main"]);
    git(repo, ["cherry-pick", sharedCommit]);
    const targetTip = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["branch", "staging", targetTip]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: targetTip, message: "land remaining", runId: "run-partial" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, false);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.notEqual(result.mergedCommit, targetTip);
    assert.equal(git(repo, ["rev-parse", `${result.mergedCommit}^`]), targetTip);
    assert.equal(git(repo, ["show", `${result.mergedCommit}:shared.txt`]), "shared");
    assert.equal(git(repo, ["show", `${result.mergedCommit}:remaining.txt`]), "remaining");
    assert.equal(commands.filter((args) => args[0] === "commit-tree").length, 1);
    assert.equal(commands.filter((args) => args[0] === "update-ref").length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, false);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  it("STCK leaves the checkout untouched when landing into a non-checked-out branch", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    git(repo, ["branch", "release", initial]);
    const events: MergeBranchEvent[] = [];
    const checkoutBefore = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "release", expectTip: initial, message: "Land feature", runId: "run-other" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  it("fails closed on duplicate target owners before merge object creation", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const commands: string[][] = [];
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "must not land", runId: "run-duplicate-owner" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          const actual = rawGit(origin, args);
          if (args[0] === "worktree" && args[1] === "list") {
            return { ...actual, stdout: `${actual.stdout}\0${actual.stdout}` };
          }
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /multiple worktrees.*refs\/heads\/main/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.equal(commands.some((args) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
    assert.deepEqual(events, []);
  });

  it("fails closed on malformed or unreadable worktree metadata", () => {
    for (const metadataFailure of ["malformed", "unreadable"] as const) {
      const { repo, initial } = createRepo();
      createFeature(repo, `feature-${metadataFailure}`);
      const commands: string[][] = [];

      const result = runPlumbingMerge(
        { origin: repo, branch: `feature-${metadataFailure}`, into: "main", expectTip: initial, message: "must not land" },
        {
          runGit: (origin, args) => {
            commands.push(args);
            if (args[0] === "worktree" && args[1] === "list") {
              if (metadataFailure === "unreadable") {
                return { status: 128, stdout: "", stderr: "fatal: cannot read worktree metadata" };
              }
              return { status: 0, stdout: `worktree ${repo}\0branch refs/heads/main\0\0`, stderr: "" };
            }
            return rawGit(origin, args);
          },
          emitEvent: () => assert.fail("unsafe preflight must not emit an event"),
        },
      );

      assert.equal(result.status, "operational_error");
      if (result.status !== "operational_error") continue;
      assert.match(result.detail, /worktree metadata|worktree list/i);
      assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
      assert.equal(commands.some((args) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
    }
  });

  it("STCK reports checkout refresh as not applicable for a bare origin", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const bare = tamanduaTempDir("tamandua-merge-branch-bare-");
    cleanup.push(bare);
    git(bare, ["clone", "--bare", repo, "."]);
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: bare, branch: "feature", into: "main", expectTip: initial, message: "Land feature", runId: "run-bare" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  it("reports preflight target movement before creating merge objects", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: "0".repeat(40), message: "must not land", runId: "run-preflight" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "target_moved");
    assert.equal(result.exitCode, 2);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.deepEqual(commands, [["rev-parse", "--verify", "refs/heads/main"]]);
    assert.deepEqual(events, [{
      ts: events[0]?.ts,
      event: "merge.target_moved",
      runId: "run-preflight",
      origin: repo,
      branch: "feature",
      target: "refs/heads/main",
      expectedTip: "0".repeat(40),
      actualTip: initial,
    }]);
  });

  it("reports a compare-and-swap race without overwriting the winner", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    git(repo, ["branch", "release", initial]);
    const events: MergeBranchEvent[] = [];
    let competingCommit = "";

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "release", expectTip: initial, message: "losing merge", runId: "run-cas" },
      {
        runGit: (origin, args) => {
          if (args[0] === "update-ref" && competingCommit === "") {
            const initialTree = git(repo, ["rev-parse", `${initial}^{tree}`]);
            competingCommit = git(repo, ["commit-tree", initialTree, "-p", initial, "-m", "competing land"]);
            git(repo, ["update-ref", "refs/heads/release", competingCommit, initial]);
          }
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "target_moved");
    assert.equal(result.exitCode, 2);
    if (result.status !== "target_moved") return;
    assert.equal(git(repo, ["rev-parse", "refs/heads/release"]), competingCommit);
    assert.ok(result.mergedTree);
    assert.ok(result.mergedCommit);
    assert.deepEqual(events, [{
      ts: events[0]?.ts,
      event: "merge.target_moved",
      runId: "run-cas",
      origin: repo,
      branch: "feature",
      target: "refs/heads/release",
      expectedTip: initial,
      actualTip: competingCommit,
      mergedTree: result.mergedTree,
      mergedCommit: result.mergedCommit,
    }]);
  });

  it("preserves Git conflict diagnostics and leaves the target ref unchanged", () => {
    const { repo } = createRepo();
    git(repo, ["switch", "-c", "feature"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "feature version\n", "utf-8");
    git(repo, ["commit", "-am", "feature conflict"]);
    git(repo, ["switch", "main"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "main version\n", "utf-8");
    git(repo, ["commit", "-am", "main conflict"]);
    const mainTip = git(repo, ["rev-parse", "refs/heads/main"]);
    git(repo, ["branch", "staging", mainTip]);
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: mainTip, message: "conflicting merge", runId: "run-conflict" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "conflicts");
    assert.equal(result.exitCode, 3);
    if (result.status !== "conflicts") return;
    assert.match(result.conflicts, /CONFLICT|Auto-merging/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), mainTip);
    assert.ok(result.mergedTree);
    assert.deepEqual(events, [{
      ts: events[0]?.ts,
      event: "merge.conflicts",
      runId: "run-conflict",
      origin: repo,
      branch: "feature",
      target: "refs/heads/staging",
      expectedTip: mainTip,
      mergedTree: result.mergedTree,
    }]);
  });

  it("returns an operational error for a missing feature branch", () => {
    const { repo, initial } = createRepo();
    git(repo, ["branch", "release", initial]);
    const result = runPlumbingMerge({ origin: repo, branch: "missing", into: "release", expectTip: initial, message: "cannot merge" });

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /refs\/heads\/missing/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/release"]), initial);
  });

  it("TATR writes a structured reflog message on the owner-checkout target advance", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature",
        into: "main",
        expectTip: initial,
        message: "reflog owner landing",
        runId: "run-reflog-owner",
      },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    const advance = commands.find(
      (args) => args[0] === "update-ref" && args[3] === "refs/heads/main" && args[5] === initial,
    );
    assert.ok(advance, "owner-checkout target advance update-ref must be recorded");
    assert.equal(advance[1], "-m");
    const message = advance[2] ?? "";
    assert.match(message, /^tamandua: merge\.landed run=run-reflog-owner tree=/);
    assert.ok(message.includes(result.mergedTree), `message must contain the merged tree: ${message}`);
    // The landing actually wrote the structured entry into the target's reflog.
    const reflogSubjects = git(repo, ["reflog", "show", "--format=%gs", "refs/heads/main"]).split("\n");
    assert.equal(reflogSubjects[0], message);
  });

  it("TATR writes a structured reflog message on the bare-origin target advance", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const bare = tamanduaTempDir("tamandua-merge-branch-reflog-bare-");
    cleanup.push(bare);
    git(bare, ["clone", "--bare", repo, "."]);
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      {
        origin: bare,
        branch: "feature",
        into: "main",
        expectTip: initial,
        message: "reflog bare landing",
        runId: "run-reflog-bare",
      },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          return rawGit(origin, args);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    const advance = commands.find(
      (args) => args[0] === "update-ref" && args[3] === "refs/heads/main" && args[5] === initial,
    );
    assert.ok(advance, "bare-origin target advance update-ref must be recorded");
    assert.equal(advance[1], "-m");
    const message = advance[2] ?? "";
    assert.match(message, /^tamandua: merge\.landed run=run-reflog-bare tree=/);
    assert.ok(message.includes(result.mergedTree), `message must contain the merged tree: ${message}`);
  });

  it("uses only guarded plumbing commands against the origin", () => {
    const commands: string[][] = [];
    const expected = "1".repeat(40);
    const tree = "2".repeat(40);
    const commit = "3".repeat(40);
    const targetTree = "5".repeat(40);
    const scripted = [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "worktree /origin\0bare\0\0", stderr: "" },
      { status: 0, stdout: "4".repeat(40), stderr: "" },
      { status: 0, stdout: targetTree, stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: tree, stderr: "" },
      { status: 0, stdout: commit, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];

    const result = runPlumbingMerge(
      { origin: "/origin", branch: "feature", into: "release", expectTip: expected, message: "plumbing only", runId: "" },
      {
        runGit: (_origin, args) => {
          commands.push(args);
          return scripted.shift()!;
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    assert.deepEqual(commands, [
      ["rev-parse", "--verify", "refs/heads/release"],
      ["worktree", "list", "--porcelain", "-z"],
      ["rev-parse", "--verify", "refs/heads/feature^{commit}"],
      ["rev-parse", "--verify", "refs/heads/release^{tree}"],
      ["merge-base", "--is-ancestor", "4".repeat(40), expected],
      ["merge-tree", "--write-tree", expected, "refs/heads/feature"],
      ["commit-tree", tree, "-p", expected, "-m", "plumbing only"],
      ["update-ref", "-m", `tamandua: merge.landed (manual) tree=${tree}`, "refs/heads/release", commit, expected],
    ]);
    assert.equal(
      commands.some((args) =>
        args[0] === "checkout" ||
        args[0] === "switch" ||
        args.includes("--ignore-other-worktrees") ||
        (args[0] === "merge" && args.includes("--squash")) ||
        (args[0] === "reset" && args.includes("--hard"))
      ),
      false,
      "merge-branch must not use checkout/switch bypasses, squash merge, or hard reset",
    );
  });

  it("does not misclassify a non-CAS update-ref failure as target movement", () => {
    const expected = "1".repeat(40);
    const tree = "2".repeat(40);
    const commit = "3".repeat(40);
    const events: MergeBranchEvent[] = [];
    const scripted = [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "worktree /origin\0bare\0\0", stderr: "" },
      { status: 0, stdout: "4".repeat(40), stderr: "" },
      { status: 0, stdout: "5".repeat(40), stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: tree, stderr: "" },
      { status: 0, stdout: commit, stderr: "" },
      { status: 128, stdout: "", stderr: "permission denied" },
      { status: 0, stdout: expected, stderr: "" },
    ];

    const result = runPlumbingMerge(
      { origin: "/origin", branch: "feature", into: "main", expectTip: expected, message: "cannot update" },
      {
        runGit: () => scripted.shift()!,
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(events, []);
  });
});
