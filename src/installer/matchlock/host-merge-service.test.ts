/**
 * US-007 host merge authorization/receipt service: typed refusals BEFORE any
 * Git action, real-fixture recording, independent authoritative-tip
 * verification, idempotent replay and run-attributed events.
 *
 * Serial lane: spawns real git subprocesses (node:child_process import).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import { runMergeCore, type MergeCoreEvent } from "../../../dist/installer/matchlock/merge-core.js";
import type { HostBinding, HostClaim } from "../../../dist/installer/matchlock/broker-services.js";
import type { HostMergeContext } from "../../../dist/installer/matchlock/host-merge-services.js";
import {
  createHostMergeService,
  isInsideRoot,
} from "../../../dist/installer/matchlock/host-merge-service.js";

const RUN = "aaaaaaaa-1111-4111-8111-111111111111";
const INV = "bbbbbbbb-2222-4222-8222-222222222222";
const STEP = "cccccccc-3333-4333-8333-333333333333";
const FINALIZE = "dddddddd-4444-4444-8444-444444444444";

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Tamandua Test",
    GIT_AUTHOR_EMAIL: "test@tamandua.local",
    GIT_COMMITTER_NAME: "Tamandua Test",
    GIT_COMMITTER_EMAIL: "test@tamandua.local",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(),
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return (result.stdout ?? "").trim();
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { repo: string; tip: string } {
  const repo = tamanduaTempDir("tamandua-host-merge-");
  cleanup.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@tamandua.local"]);
  git(repo, ["config", "user.name", "Tamandua Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { repo, tip: git(repo, ["rev-parse", "HEAD"]) };
}

function addFeature(repo: string): void {
  git(repo, ["switch", "-c", "feature"]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["switch", "main"]);
}

function binding(role = "merger"): HostBinding {
  return {
    runId: RUN,
    invocationId: INV,
    agentId: "feature-dev-merge-worktree_merger",
    jobId: "job-1",
    role,
    admittedRoots: [],
    helperProtocolVersion: "1",
    helperBuildVersion: "test",
  };
}

function claim(over: Partial<HostClaim> = {}): HostClaim {
  return {
    stepId: FINALIZE,
    runId: RUN,
    agentId: "feature-dev-merge-worktree_merger",
    claimId: "claim-1",
    expects: "",
    input: "finalize",
    ...over,
  };
}

interface Harness {
  repo: string;
  context: HostMergeContext;
  events: MergeCoreEvent[];
  tipReads: Array<{ origin: string; into: string }>;
  service: ReturnType<typeof createHostMergeService>;
}

function harness(opts: { role?: string; finalizeMergeStepId?: string } = {}): Harness {
  const { repo } = fixture();
  const context: HostMergeContext = {
    runId: RUN,
    originalRepositoryRoot: repo,
    originalBranch: "main",
    finalizeMergeStepId: opts.finalizeMergeStepId ?? FINALIZE,
    admittedRoots: [repo],
    imageDigest: "sha256:image",
  };
  const events: MergeCoreEvent[] = [];
  const tipReads: Array<{ origin: string; into: string }> = [];
  const service = createHostMergeService(context, {
    readTargetTip: (origin, into) => {
      tipReads.push({ origin, into });
      const r = spawnSync("git", ["-C", origin, "rev-parse", "--verify", `refs/heads/${into}^{commit}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv(),
      });
      return r.status === 0 ? (r.stdout ?? "").trim() : null;
    },
    emitEvent: (event) => events.push(event),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { repo, context, events, tipReads, service };
}

function authorizeRequest(repo: string, over: Record<string, unknown> = {}): Parameters<Harness["service"]["authorize"]>[2] {
  return {
    origin: repo,
    branch: "feature",
    into: "main",
    expectTip: git(repo, ["rev-parse", "HEAD"]),
    message: "land feature",
    ...over,
  } as Parameters<Harness["service"]["authorize"]>[2];
}

function captureRefs(repo: string): string {
  return git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
}

function captureFiles(repo: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push(`${path.relative(repo, full)}:${fs.readFileSync(full, "utf-8")}`);
    }
  };
  walk(repo);
  return entries.join("\n");
}

describe("US-007 host merge service authorization (recording-only refusals)", () => {
  it("accepts the finalizer binding and issues canonical authorization values", async () => {
    const h = harness();
    const res = await h.service.authorize(binding(), claim(), authorizeRequest(h.repo));
    assert.equal(res.ok, true, res.message);
    assert.ok(res.authorization);
    assert.equal(res.authorization!.origin, h.repo);
    assert.equal(res.authorization!.into, "main");
    assert.equal(res.authorization!.runId, RUN);
    assert.equal(res.authorization!.targetRef, "refs/heads/main");
    assert.equal(h.tipReads.length, 1);
  });

  it("refuses a non-merger role BEFORE any Git read", async () => {
    const h = harness();
    const before = { refs: captureRefs(h.repo), files: captureFiles(h.repo) };
    const res = await h.service.authorize(binding("developer"), claim(), authorizeRequest(h.repo));
    assert.equal(res.ok, false);
    assert.equal(res.code, "MERGE_ROLE");
    assert.equal(h.tipReads.length, 0, "no host Git read for a role refusal");
    assert.deepEqual({ refs: captureRefs(h.repo), files: captureFiles(h.repo) }, before);
  });

  it("refuses a missing, foreign or stale finalize claim BEFORE any Git read", async () => {
    const h = harness();
    assert.equal((await h.service.authorize(binding(), null, authorizeRequest(h.repo))).code, "MERGE_CLAIM");
    assert.equal(
      (await h.service.authorize(binding(), claim({ stepId: STEP }), authorizeRequest(h.repo))).code,
      "MERGE_CLAIM",
    );
    assert.equal(
      (await h.service.authorize(binding(), claim({ runId: "ffffffff-9999-4999-8999-999999999999" }), authorizeRequest(h.repo))).code,
      "MERGE_CLAIM",
    );
    assert.equal(h.tipReads.length, 0);
  });

  it("refuses an unadmitted origin or foreign target BEFORE any Git read", async () => {
    const h = harness();
    const outside = await h.service.authorize(
      binding(),
      claim(),
      authorizeRequest(h.repo, { origin: "/somewhere/else" }),
    );
    assert.equal(outside.code, "MERGE_ORIGIN");
    const wrongTarget = await h.service.authorize(
      binding(),
      claim(),
      authorizeRequest(h.repo, { into: "release" }),
    );
    assert.equal(wrongTarget.code, "MERGE_TARGET");
    const wrongRun = await h.service.authorize(
      binding(),
      claim(),
      authorizeRequest(h.repo, { runId: "run-ffffffff-9999-4999-8999-999999999999" }),
    );
    assert.equal(wrongRun.code, "MERGE_BINDING");
    assert.equal(h.tipReads.length, 0);
  });

  it("refuses a mismatched expect-tip after the narrow read with zero mutation", async () => {
    const h = harness();
    const before = { refs: captureRefs(h.repo), files: captureFiles(h.repo) };
    const res = await h.service.authorize(binding(), claim(), authorizeRequest(h.repo, { expectTip: "0".repeat(40) }));
    assert.equal(res.code, "MERGE_TIP");
    assert.equal(h.tipReads.length, 1);
    assert.deepEqual({ refs: captureRefs(h.repo), files: captureFiles(h.repo) }, before);
  });

  it("refuses authorization when the run's finalize_merge identity is unavailable", async () => {
    const h = harness();
    const ctx: HostMergeContext = {
      runId: RUN,
      originalRepositoryRoot: h.repo,
      originalBranch: "main",
      admittedRoots: [h.repo],
      imageDigest: "sha256:image",
    };
    const svc = createHostMergeService(ctx, {
      readTargetTip: () => null,
      emitEvent: () => undefined,
    });
    const res = await svc.authorize(binding(), claim(), authorizeRequest(h.repo));
    assert.equal(res.ok, false);
    assert.equal(res.code, "MERGE_CLAIM");
  });

  it("isInsideRoot accepts equality/descendants and refuses ancestors/foreign roots", () => {
    assert.equal(isInsideRoot("/a/b", "/a/b"), true);
    assert.equal(isInsideRoot("/a/b", "/a/b/c"), true);
    assert.equal(isInsideRoot("/a/b", "/a"), false);
    assert.equal(isInsideRoot("/a/b", "/a/c"), false);
  });
});

describe("US-007 host merge service receipt (real landing + verification)", () => {
  interface Landing {
    authorizationId: string;
    mergedTree: string;
    mergedCommit: string;
  }

  async function authorizeAndLand(h: Harness): Promise<Landing> {
    addFeature(h.repo);
    const auth = await h.service.authorize(binding(), claim(), authorizeRequest(h.repo, { expectTip: git(h.repo, ["rev-parse", "HEAD"]) }));
    assert.equal(auth.ok, true, auth.message);
    const result = runMergeCore(
      {
        origin: h.repo,
        branch: "feature",
        into: "main",
        expectTip: auth.authorization!.expectTip,
        message: auth.authorization!.message,
        runId: auth.authorization!.runId,
      },
      {
        runGit: (cwd, args) => {
          const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });
          return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? -1 };
        },
        emitEvent: () => undefined,
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      },
    );
    assert.equal(result.status, "landed", JSON.stringify(result));
    if (result.status !== "landed") throw new Error("unreachable");
    return {
      authorizationId: auth.authorization!.authorizationId,
      mergedTree: result.mergedTree,
      mergedCommit: result.mergedCommit,
    };
  }

  it("records a landed outcome, emits a run-attributed event and replays the exact ack", async () => {
    const h = harness();
    const landed = await authorizeAndLand(h);
    // The authorized target tip advanced under the SAME authorization; the
    // report is the one the guest would send after runMergeCore.
    const report = {
      authorizationId: landed.authorizationId,
      status: "landed" as const,
      exitCode: 0 as const,
      mergedTree: landed.mergedTree,
      mergedCommit: landed.mergedCommit,
      noop: false,
      checkoutRefresh: "refreshed",
    };
    const first = await h.service.report(binding(), claim(), report);
    assert.equal(first.ok, true, first.message);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0]!.event, "merge.landed");
    assert.equal(h.events[0]!.runId, RUN);
    assert.equal(h.events[0]!.ts, "2026-01-02T03:04:05.000Z");
    const replay = await h.service.report(binding(), claim(), report);
    assert.deepEqual(replay.ack, first.ack);
    assert.equal(h.events.length, 1, "replay must not re-emit");
    // A DIFFERENT outcome under the same authorization is refused, not replayed.
    const different = await h.service.report(binding(), claim(), { ...report, checkoutRefresh: "already-coherent" });
    assert.equal(different.code, "MERGE_REPLAY");
  });

  it("refuses a fabricated landed receipt whose commit is not the authoritative tip", async () => {
    const h = harness();
    addFeature(h.repo);
    const auth = await h.service.authorize(binding(), claim(), authorizeRequest(h.repo, { expectTip: git(h.repo, ["rev-parse", "HEAD"]) }));
    const res = await h.service.report(binding(), claim(), {
      authorizationId: auth.authorization!.authorizationId,
      status: "landed",
      exitCode: 0,
      mergedTree: "1".repeat(40),
      mergedCommit: "2".repeat(40),
      noop: false,
      checkoutRefresh: "refreshed",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "MERGE_VERIFY");
    assert.equal(h.events.length, 0, "no merge event for an unverified receipt");
  });

  it("records a conflicts outcome only while the target tip is unchanged", async () => {
    const h = harness();
    addFeature(h.repo);
    const auth = await h.service.authorize(binding(), claim(), authorizeRequest(h.repo, { expectTip: git(h.repo, ["rev-parse", "HEAD"]) }));
    const res = await h.service.report(binding(), claim(), {
      authorizationId: auth.authorization!.authorizationId,
      status: "conflicts",
      exitCode: 3,
      conflicts: "CONFLICT (content): base.txt",
    });
    assert.equal(res.ok, true, res.message);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0]!.event, "merge.conflicts");
  });

  it("refuses a report after the finalize claim changed, and after the run context changed", async () => {
    const h = harness();
    addFeature(h.repo);
    const auth = await h.service.authorize(binding(), claim(), authorizeRequest(h.repo, { expectTip: git(h.repo, ["rev-parse", "HEAD"]) }));
    const stale = await h.service.report(binding(), claim({ claimId: "claim-2" }), {
      authorizationId: auth.authorization!.authorizationId,
      status: "conflicts",
      exitCode: 3,
      conflicts: "CONFLICT",
    });
    assert.equal(stale.code, "MERGE_CLAIM");

    const h2 = harness();
    addFeature(h2.repo);
    const auth2 = await h2.service.authorize(binding(), claim(), authorizeRequest(h2.repo, { expectTip: git(h2.repo, ["rev-parse", "HEAD"]) }));
    // A run-context change after authorization (image re-pin) must refuse the
    // receipt rather than record against the changed context.
    (h2.context as { imageDigest?: string }).imageDigest = "sha256:changed";
    const changed = await h2.service.report(binding(), claim(), {
      authorizationId: auth2.authorization!.authorizationId,
      status: "conflicts",
      exitCode: 3,
      conflicts: "CONFLICT",
    });
    assert.equal(changed.code, "MERGE_CONTEXT");
  });

  it("refuses an unknown authorization", async () => {
    const h = harness();
    const unknown = await h.service.report(binding(), claim(), {
      authorizationId: "no-such-auth",
      status: "conflicts",
      exitCode: 3,
      conflicts: "x",
    });
    assert.equal(unknown.code, "MERGE_AUTHORIZATION");
  });
});
