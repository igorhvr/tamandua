/**
 * agent-scheduler-matchlock.test.ts — MTLK-ADMIT dispatch admission barrier +
 * MTLK-PI-EXEC US-002 opted-in scheduler integration (serial lane).
 *
 * Drives the REAL executeDispatchRound with:
 *   - a journaling mock host pi binary (asserts ZERO host harness spawns for
 *     every opted-in path — probe AND work);
 *   - the injectable Matchlock round-runner seam
 *     (setMatchlockSchedulerRoundRunnerForTest — the NARROW deterministic
 *     substitute for a real VM; clearly labelled as the test seam it is),
 *     so a VALID pinned policy on a SUPPORTED workflow dispatches through the
 *     runner seam (probe + work) exactly as the production path will call the
 *     US-001 invocation runner;
 *   - a persisted Matchlock policy, asserting:
 *       * supported do-now / do-review-do-verify → dispatched via the seam;
 *         step completes; no run.matchlock_dispatch_refused; no
 *         backend_not_integrated force-fail;
 *       * unsupported workflow shapes / non-pi harness context → refused
 *         BEFORE any probe/findBinary/spawn with an actionable code;
 *       * malformed/legacy/unpinned policy refusals remain;
 *       * the once-per-run launch probe of an opted-in run runs IN-VM through
 *         the runner seam (never the host probe), records
 *         run.harness_probe_ok, and a passed run is never re-probed;
 *       * idle opted-in runs (no pending step) perform zero runner/VM
 *         invocations;
 *       * the NULL-policy no-flag differential stays green.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  createAgentCronJob,
  executeDispatchRound,
  removeRunCrons,
  shutdownAllCrons,
  buildMatchlockWorkPrompt,
  buildMatchlockDshWorkPrompt,
  buildWorkPrompt,
  applyGuestStepCompletionEvidence,
  snapshotDoneStepsClaimedByWorker,
  findStepCompletedByWorker,
  parseWorkRoundMetadata,
  classifyWorkRoundOutcome,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import { completeStep } from "../../dist/installer/step-ops.js";
import {
  buildMatchlockPolicy,
  parseMatchlockPolicy,
  serializeMatchlockPolicy,
} from "../../dist/installer/matchlock/policy.js";
import {
  MATCHLOCK_GUEST_CLI,
  MATCHLOCK_GUEST_SKILL_FILE,
  setMatchlockSchedulerRoundRunnerForTest,
  buildMatchlockProbeCommand,
  buildMatchlockProbePrompt,
  buildMatchlockMergeContext,
  matchlockRoundScopeRefusal,
  MatchlockRunnerError,
} from "../../dist/installer/matchlock/scheduler-matchlock.js";
import {
  describeMatchlockError,
  MATCHLOCK_ERROR_TAIL_MAX_BYTES,
} from "../../dist/installer/matchlock/runner-error.js";
import { classifyInvocationError } from "../../dist/installer/matchlock/pi-invocation-runner.js";
import { MatchlockControllerError } from "../../dist/installer/matchlock/controller.js";
import { MATCHLOCK_SOCKET_PATH_TOO_LONG_CODE } from "../../dist/installer/matchlock/home-alias.js";
import {
  setDshSchedulerRoundRunnerForTest,
  buildDshProbeCommand,
  buildDshProbePrompt,
  DSH_MATCHLOCK_GUEST_CLI,
  DSH_MATCHLOCK_GUEST_SKILL_FILE,
} from "../../dist/installer/matchlock/scheduler-dsh.js";
import {
  readAuthoritativeTargetTip,
  createMergeServiceForContext,
} from "../../dist/installer/matchlock/merge-invocation-wiring.js";
import { resolveTamanduaCli } from "../../dist/installer/paths.js";
import type { CronJobInfo } from "../../dist/installer/agent-scheduler.js";
import type { WorkflowAgent, WorkflowSpec } from "../../dist/installer/types.js";

/** A supported workflow shape under the pi Matchlock backend. */
const SUPPORTED_WORKFLOWS = ["do-now", "do-review-do-verify"] as const;

function makeMockBinary(binPath: string, logPath: string): void {
  fs.writeFileSync(
    binPath,
    `#!/bin/sh\necho "invoked:$*" >> "${logPath}"\necho "NO_WORK_AVAILABLE"\n`,
    { mode: 0o755 },
  );
}

function makeAgent(): WorkflowAgent {
  return {
    id: "test-agent",
    model: "fake",
    workspace: { baseDir: "." },
  };
}

function makeWorkflow(workflowId = "test-wf"): WorkflowSpec {
  return {
    id: workflowId,
    agents: [makeAgent()],
    steps: [
      {
        id: "step-1",
        agent: "test-agent",
        input: "do work",
        expects: "STATUS",
      },
    ],
  };
}

function seedRun(
  runId: string,
  workdir: string,
  matchlockPolicyRaw: string | null,
  opts: {
    workflowId?: string;
    pendingSteps?: number;
    runContext?: Record<string, string>;
    finalizeMergeStepId?: string;
  } = {},
): void {
  const workflowId = opts.workflowId ?? "test-wf";
  const stepCount = opts.pendingSteps ?? 1;
  const db = getDb();
  const now = new Date().toISOString();
  const context: Record<string, string> = {
    working_directory_for_harness: workdir,
    ...(opts.runContext ?? {}),
  };
  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, scheduling_status, created_at, updated_at, matchlock_policy)
     VALUES (?, ?, 'test task', 'running', ?, 'active', ?, ?, ?)`,
  ).run(runId, workflowId, JSON.stringify(context), now, now, matchlockPolicyRaw);
  for (let i = 0; i < stepCount; i++) {
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'do work', 'STATUS', 'pending', ?, ?)`,
    ).run(`${runId}-step-${i + 1}`, runId, `step-${i + 1}`, `${workflowId}_test-agent`, i, now, now);
  }
  if (opts.finalizeMergeStepId) {
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', ?, ?, 'finalize', 'STATUS', 'waiting', ?, ?)`,
    ).run(opts.finalizeMergeStepId, runId, `${workflowId}_merger`, stepCount, now, now);
  }
}

function policyJson(imageTag = "vic/ml:latest", imagePath?: string): string {
  return serializeMatchlockPolicy(
    buildMatchlockPolicy({
      requestedImage: imageTag,
      identity: {
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        config_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tag: imageTag,
      },
      ...(imagePath ? { imagePath } : {}),
      harness: "pi",
      workingDirectory: "/srv/project",
      originalRepositoryRoot: "/srv/project",
      workMounts: [
        { hostPath: "/srv/project", hostRealPath: "/srv/project", guestPath: "/srv/project" },
      ],
      gitMetadataRoots: [],
    }),
  );
}

/**
 * MTLK-HERMES-EXEC US-003: a persisted hermes opt-in — harness "hermes" with
 * the FROZEN submission inputs and the resolved Hermes configuration trio
 * (canonical host root / profile id / guest HERMES_HOME).
 */
function hermesPolicyJson(imageTag = "vic/hermes:latest"): string {
  return serializeMatchlockPolicy(
    buildMatchlockPolicy({
      requestedImage: imageTag,
      identity: {
        digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        config_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        tag: imageTag,
      },
      harness: "hermes",
      workingDirectory: "/srv/project",
      originalRepositoryRoot: "/srv/project",
      workMounts: [
        { hostPath: "/srv/project", hostRealPath: "/srv/project", guestPath: "/srv/project" },
      ],
      gitMetadataRoots: [],
      configurationRoot: "/home/operator/.hermes",
      configurationProfile: "default",
      guestConfigurationRoot: "/workspace/config/hermes",
      hermes: { homeDir: "/home/operator", cwd: "/srv/project", hermesHomeEnv: null },
    }),
  );
}

/** US-008 worktree policy: managed worktree cwd + entire original repo RW. */
function worktreePolicyJson(worktreePath: string, originRoot: string): string {
  return serializeMatchlockPolicy(
    buildMatchlockPolicy({
      requestedImage: "vic/ml:latest",
      identity: {
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        config_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tag: "vic/ml:latest",
      },
      harness: "pi",
      workingDirectory: worktreePath,
      originalRepositoryRoot: originRoot,
      workMounts: [
        { hostPath: worktreePath, hostRealPath: worktreePath, guestPath: worktreePath },
      ],
      gitMetadataRoots: [],
    }),
  );
}

/**
 * US-010 DIRECT-route policy: the repository checkout is BOTH the harness cwd
 * and the admitted original repository root (no managed worktree), matching
 * `admission.ts planFreshScope` for a non-worktree merge workflow.
 */
function directPolicyJson(repoRoot: string): string {
  return worktreePolicyJson(repoRoot, repoRoot);
}

// ── the deterministic runner-seam fake (NO real VM) ──────────────────────
interface SeamJournalEntry {
  kind: "probe" | "work";
  runId: string;
  agentId: string;
  workflowId: string;
  jobId: string;
  promptText: string;
  workdir: string;
  timeoutMs: number;
  imagePath?: string;
  /** US-008 host merge context (only for a merge-capability work round). */
  merge?: {
    runId: string;
    originalRepositoryRoot: string;
    originalBranch: string;
    finalizeMergeStepId?: string;
    imageDigest?: string;
  };
}

/**
 * Deterministic substitute for the production invocation runner — a clearly
 * labelled TEST SEAM (never real-VM evidence). The production default is the
 * real US-001 runner; these tests install this fake so the scheduler path can
 * be exercised with zero VMs/models.
 */
function installSeamFake(state: {
  journal: SeamJournalEntry[];
  probePasses?: boolean;
  workCompletes?: boolean;
}): void {
  setMatchlockSchedulerRoundRunnerForTest(async (round) => {
    state.journal.push({
      kind: round.kind,
      runId: round.identity.runId,
      agentId: round.identity.agentId,
      workflowId: round.identity.workflowId,
      jobId: round.identity.jobId,
      promptText: round.promptText,
      workdir: round.workingDirectoryForHarness,
      timeoutMs: round.timeoutMs,
      ...(round.imagePath ? { imagePath: round.imagePath } : {}),
      ...(round.merge
        ? {
            merge: {
              runId: round.merge.runId,
              originalRepositoryRoot: round.merge.originalRepositoryRoot,
              originalBranch: round.merge.originalBranch,
              ...(round.merge.finalizeMergeStepId
                ? { finalizeMergeStepId: round.merge.finalizeMergeStepId }
                : {}),
              ...(round.merge.imageDigest ? { imageDigest: round.merge.imageDigest } : {}),
            },
          }
        : {}),
    });
    if (round.kind === "probe") {
      // The in-VM probe asks the guest pi to run the packed guest CLI
      // `tamandua skill-path`; a passing probe replies with the guest-readable
      // pack skill file.
      return {
        output: state.probePasses === false ? "not-a-path" : MATCHLOCK_GUEST_SKILL_FILE,
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
      };
    }
    // Work round: emulate the guest agent — claim the run's NEXT pending step
    // (claim_job_id = this round's scheduler job id, exactly what the host
    // broker's NativeStepServices binds for a guest claim) then report done so
    // the scheduler auto-completes through the REAL step-ops completeStep.
    const db = getDb();
    db.prepare(
      `UPDATE steps SET status = 'running', claim_job_id = ?
       WHERE id = (SELECT id FROM steps WHERE run_id = ? AND status = 'pending'
                   ORDER BY step_index ASC LIMIT 1)`,
    ).run(round.identity.jobId, round.identity.runId);
    return {
      output:
        state.workCompletes === false
          ? ""
          : "STATUS: done\nCHANGES: seam work\nTESTS: seam tests",
      exitCode: state.workCompletes === false ? 1 : 0,
      signal: null,
      timedOut: false,
      durationMs: 10,
    };
  });
}

describe("executeDispatchRound Matchlock admission + opted-in dispatch", () => {
  let tempHome: string;
  let savedPiBinary: string | undefined;
  let savedHarnessProbe: string | undefined;
  let savedControlPort: string | undefined;
  let savedHomeAliasOverride: string | undefined;
  let mockServer: http.Server;
  let controlPort: number;
  let piLog: string;
  let seamJournal: SeamJournalEntry[];
  let seamJournalDsh: DshSeamJournalEntry[];

  beforeEach(async () => {
    tempHome = tamanduaTempDir("tamandua-test-mtlk-dispatch-");
    savedPiBinary = process.env.TAMANDUA_PI_BINARY;
    savedHarnessProbe = process.env.TAMANDUA_HARNESS_PROBE;
    savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
    savedHomeAliasOverride = process.env.TAMANDUA_MATCHLOCK_HOME_ALIAS;

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    // The short-HOME alias is a production-process concern (US-002); these
    // dispatch tests run with a throwaway HOME that is deleted in afterEach,
    // so the alias is disabled to avoid creating a dangling /tmp alias for
    // later tests. Alias wiring is covered by
    // scheduler-home-alias-wiring.test.ts.
    process.env.TAMANDUA_MATCHLOCK_HOME_ALIAS = "off";
    // Probe disabled for the refusals / no-flag differential by default (the
    // journaling mock could never pass a real probe). The opted-in probe-path
    // tests set TAMANDUA_HARNESS_PROBE=1 explicitly.
    process.env.TAMANDUA_HARNESS_PROBE = "0";

    // Mock daemon control plane: 200 to everything so forceFailRun's
    // terminateRunWithDaemon and any register/nudge settle instantly without
    // touching a real control port.
    controlPort = await new Promise<number>((resolve) => {
      mockServer = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        assert.ok(addr && typeof addr !== "string");
        resolve(addr.port);
      });
    });
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

    const piPath = path.join(tempHome, "pi-mock");
    piLog = path.join(tempHome, "pi-args.log");
    makeMockBinary(piPath, piLog);
    process.env.TAMANDUA_PI_BINARY = piPath;

    seamJournal = [];
    seamJournalDsh = [];
    installSeamFake({ journal: seamJournal });
  });

  afterEach(() => {
    setMatchlockSchedulerRoundRunnerForTest(null);
    setDshSchedulerRoundRunnerForTest(null);
    if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
    else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
    if (savedHarnessProbe === undefined) delete process.env.TAMANDUA_HARNESS_PROBE;
    else process.env.TAMANDUA_HARNESS_PROBE = savedHarnessProbe;
    if (savedControlPort === undefined) delete process.env.TAMANDUA_CONTROL_PORT;
    else process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
    if (savedHomeAliasOverride === undefined) delete process.env.TAMANDUA_MATCHLOCK_HOME_ALIAS;
    else process.env.TAMANDUA_MATCHLOCK_HOME_ALIAS = savedHomeAliasOverride;
    shutdownAllCrons();
    if (mockServer) mockServer.close();
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function dispatchJob(
    runId: string,
    workdir: string,
    opts: { workflowId?: string; harnessType?: string } = {},
  ): Promise<void> {
    const workflowId = opts.workflowId ?? "test-wf";
    const workflow = makeWorkflow(workflowId);
    const created = await createAgentCronJob({
      workflowId,
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });
    assert.ok(created.ok, "agent cron job must be created");
    const job: CronJobInfo = {
      id: created.id!,
      workflowId,
      runId,
      agentId: `${workflowId}_test-agent`,
      harnessType: (opts.harnessType ?? "pi") as CronJobInfo["harnessType"],
      workingDirectoryForHarness: workdir,
      createdAt: "",
    };
    try {
      await executeDispatchRound(job, makeAgent(), workflow);
    } finally {
      await removeRunCrons(runId);
    }
  }

  function runRow(
    runId: string,
  ): { status: string; scheduling_status: string | null; matchlock_policy: string | null } | undefined {
    return getDb().prepare(
      "SELECT status, scheduling_status, matchlock_policy FROM runs WHERE id = ?",
    ).get(runId) as { status: string; scheduling_status: string | null; matchlock_policy: string | null } | undefined;
  }

  function stepRows(runId: string): Array<{ id: string; status: string }> {
    return getDb().prepare(
      "SELECT id, status FROM steps WHERE run_id = ? ORDER BY step_index ASC",
    ).all(runId) as Array<{ id: string; status: string }>;
  }

  function eventsFor(runId: string): Array<Record<string, unknown>> {
    const file = path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${runId}.jsonl`);
    try {
      return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  // ── opted-in dispatch through the runner seam (US-002) ──────────────

  for (const workflowId of SUPPORTED_WORKFLOWS) {
    it(`dispatches a VALID pinned policy on supported workflow "${workflowId}" through the runner seam (ZERO host pi spawns; step completes; no refusal)`, async () => {
      const runId = "22222222-2222-4222-8222-222222222222";
      const workdir = path.join(tempHome, "work");
      fs.mkdirSync(workdir, { recursive: true });
      seedRun(runId, workdir, policyJson(), { workflowId });

      await dispatchJob(runId, workdir, { workflowId });

      const row = runRow(runId);
      assert.ok(row);
      assert.equal(row.status, "completed", "supported opted-in run must reach real completion");
      assert.equal(row.scheduling_status, null);
      assert.ok(row.matchlock_policy, "the completed run keeps its pin");

      assert.ok(!fs.existsSync(piLog), "the host harness must NEVER be spawned for an opted-in run (probe or work)");
      assert.equal(seamJournal.length, 1, "exactly one work round through the runner seam");
      assert.equal(seamJournal[0].kind, "work");
      assert.equal(seamJournal[0].workflowId, workflowId);
      assert.ok(
        seamJournal[0].promptText.includes('"/workspace/runtime/bin/tamandua" step claim'),
        "the work prompt must instruct reporting through the GUEST CLI",
      );

      const steps = stepRows(runId);
      assert.equal(steps.length, 1);
      assert.equal(steps[0].status, "done", "the step must complete through the seam");

      const events = eventsFor(runId);
      assert.equal(
        events.filter((e) => e.event === "run.matchlock_dispatch_refused").length,
        0,
        "no run.matchlock_dispatch_refused for a supported opted-in run",
      );
      assert.equal(
        events.filter((e) => e.event === "run.force_failed").length,
        0,
        "no backend_not_integrated force-fail for a supported opted-in run",
      );
    });
  }

  // ── US-008 merge-worktree dispatch through the runner seam ─────────────

  it("dispatches an opted-in feature-dev-merge-worktree work round with the managed worktree as cwd + the host merge context", async () => {
    const runId = "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b";
    const workflowId = "feature-dev-merge-worktree";
    const worktree = path.join(tempHome, "wt-managed");
    const origin = path.join(tempHome, "origin-repo");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(origin, { recursive: true });
    const finalizeMergeStepId = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";
    seedRun(runId, worktree, worktreePolicyJson(worktree, origin), {
      workflowId,
      runContext: { original_branch: "main", worktree_origin_repository: origin },
      finalizeMergeStepId,
    });

    await dispatchJob(runId, worktree, { workflowId });

    assert.ok(!fs.existsSync(piLog), "no host harness spawn for an opted-in merge workflow");
    const work = seamJournal.find((e) => e.kind === "work");
    assert.ok(work, "the merge workflow must dispatch a work round through the runner seam");
    assert.equal(work.workdir, worktree, "the managed worktree is the harness cwd");
    assert.ok(work.merge, "the host merge context must be wired for a merge-capability workflow");
    assert.equal(work.merge.originalRepositoryRoot, origin);
    assert.equal(work.merge.originalBranch, "main");
    assert.equal(work.merge.finalizeMergeStepId, finalizeMergeStepId);
    assert.equal(work.merge.runId, runId);
  });

  it("dispatches an opted-in bug-fix-merge (DIRECT route) work round with the repo checkout as cwd + the host merge context", async () => {
    const runId = "2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d";
    const workflowId = "bug-fix-merge";
    const repoCheckout = path.join(tempHome, "direct-repo");
    fs.mkdirSync(repoCheckout, { recursive: true });
    const finalizeMergeStepId = "8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e";
    // A DIRECT-route policy has no worktree: the checkout is the cwd AND the
    // admitted original root; original_branch comes from the run context.
    seedRun(runId, repoCheckout, directPolicyJson(repoCheckout), {
      workflowId,
      runContext: { original_branch: "main" },
      finalizeMergeStepId,
    });

    await dispatchJob(runId, repoCheckout, { workflowId });

    assert.ok(!fs.existsSync(piLog), "no host harness spawn for an opted-in direct merge workflow");
    const work = seamJournal.find((e) => e.kind === "work");
    assert.ok(work, "the direct merge workflow must dispatch a work round through the runner seam");
    assert.equal(work.workdir, repoCheckout, "the repo checkout is the harness cwd");
    assert.ok(work.merge, "the host merge context must be wired for the direct merge route");
    assert.equal(work.merge.originalRepositoryRoot, repoCheckout);
    assert.equal(work.merge.originalBranch, "main");
    assert.equal(work.merge.finalizeMergeStepId, finalizeMergeStepId);
    assert.equal(work.merge.runId, runId);
  });

  it("REFUSES an opted-in merge workflow whose merge capability cannot be built (no original branch) before any probe/VM", async () => {
    const runId = "2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c";
    const workflowId = "bug-fix-merge-worktree";
    const worktree = path.join(tempHome, "wt-no-authority");
    const origin = path.join(tempHome, "origin-no-authority");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(origin, { recursive: true });
    // Policy is valid but the run context carries NO original_branch authority.
    seedRun(runId, worktree, worktreePolicyJson(worktree, origin), { workflowId });

    await dispatchJob(runId, worktree, { workflowId });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.ok(!fs.existsSync(piLog), "no host harness spawn (probe or work)");
    assert.equal(seamJournal.length, 0, "the runner seam must never be invoked");
    const events = eventsFor(runId);
    const refused = events.filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "matchlock_workflow_unsupported");
    assert.match(String(refused[0].detail), /merge-branch capability/);
    assert.equal(
      events.filter((e) => e.event === "run.harness_probe_ok" || e.event === "run.harness_probe_failed").length,
      0,
      "refusal precedes the probe gate",
    );
  });

  it("builds the host merge context from immutable run scope and refuses when origin/branch authority is absent", () => {
    const policy = parseMatchlockPolicy(worktreePolicyJson("/srv/wt", "/srv/origin"));
    const withAuthority = buildMatchlockMergeContext({
      policy,
      runId: `run-${"11111111-1111-4111-8111-111111111111"}`,
      runContext: { original_branch: "main" },
      finalizeMergeStepId: "abcd",
    });
    assert.ok(withAuthority);
    assert.equal(withAuthority.runId, "11111111-1111-4111-8111-111111111111");
    assert.equal(withAuthority.originalRepositoryRoot, "/srv/origin");
    assert.equal(withAuthority.originalBranch, "main");
    assert.equal(withAuthority.finalizeMergeStepId, "abcd");
    assert.deepEqual(withAuthority.admittedRoots, ["/srv/origin", "/srv/wt"]);

    assert.equal(
      buildMatchlockMergeContext({ policy, runId: "11111111-1111-4111-8111-111111111111", runContext: {} }),
      undefined,
      "no original branch => no merge context (the runner refuses before any VM)",
    );
  });

  it("enforces the exact-path worktree/cwd invariant and rejects relocated guest paths", () => {
    const policy = parseMatchlockPolicy(worktreePolicyJson("/srv/wt", "/srv/origin"));
    assert.equal(matchlockRoundScopeRefusal(policy, "/srv/wt"), null);
    assert.match(
      String(matchlockRoundScopeRefusal(policy, "/srv/elsewhere")),
      /does not match the persisted Matchlock policy working directory/,
    );
    const relocated = parseMatchlockPolicy(worktreePolicyJson("/srv/wt", "/srv/origin"));
    relocated.workMounts = [
      { hostPath: "/srv/wt", hostRealPath: "/srv/wt", guestPath: "/guest/wt" },
    ];
    relocated.originalRepositoryRoot = null;
    assert.match(
      String(matchlockRoundScopeRefusal(relocated, "/srv/wt")),
      /not mounted at its exact host\/guest path|differs from guest/,
    );
  });

  it("reads the admitted origin's target branch tip with a fixed plumbing call and refuses bad inputs (US-008)", () => {
    const dir = tamanduaTempDir("mtlk-target-tip-");
    try {
      const git = (args: string[]): string => {
        const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr ?? ""}`);
        return (r.stdout ?? "").trim();
      };
      git(["init", "--initial-branch=main"]);
      git(["config", "user.email", "tip@tamandua.test"]);
      git(["config", "user.name", "Tip Test"]);
      fs.writeFileSync(path.join(dir, "README.md"), "# tip\n", "utf-8");
      git(["add", "README.md"]);
      git(["commit", "-m", "initial"]);
      const head = git(["rev-parse", "HEAD"]);

      assert.equal(readAuthoritativeTargetTip(dir, "main"), head);
      assert.equal(readAuthoritativeTargetTip(dir, "does-not-exist"), null);
      assert.equal(readAuthoritativeTargetTip(dir, "--help"), null);
      assert.equal(readAuthoritativeTargetTip(path.join(dir, "nope"), "main"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("constructs the production merge service from immutable run scope and authorizes the finalizer claim (US-008)", async () => {
    const dir = tamanduaTempDir("mtlk-merge-wiring-");
    try {
      const git = (args: string[]): string => {
        const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr ?? ""}`);
        return (r.stdout ?? "").trim();
      };
      git(["init", "--initial-branch=main"]);
      git(["config", "user.email", "wiring@tamandua.test"]);
      git(["config", "user.name", "Wiring Test"]);
      fs.writeFileSync(path.join(dir, "README.md"), "# wiring\n", "utf-8");
      git(["add", "README.md"]);
      git(["commit", "-m", "initial"]);
      const head = git(["rev-parse", "HEAD"]);
      const runId = "11111111-1111-4111-8111-111111111111";

      const service = createMergeServiceForContext({
        runId,
        originalRepositoryRoot: dir,
        originalBranch: "main",
        finalizeMergeStepId: "dddddddd-4444-4444-8444-444444444444",
        admittedRoots: [dir],
        imageDigest: "sha256:image",
      });
      const outcome = await service.authorize(
        {
          runId,
          invocationId: "bbbbbbbb-2222-4222-8222-222222222222",
          agentId: "feature-dev-merge-worktree_merger",
          jobId: "job-1",
          role: "merger",
          admittedRoots: [dir],
          helperProtocolVersion: "1",
          helperBuildVersion: "test",
        },
        {
          stepId: "dddddddd-4444-4444-8444-444444444444",
          runId,
          agentId: "feature-dev-merge-worktree_merger",
          claimId: "claim-1",
          expects: "",
          input: "finalize",
        },
        { origin: dir, branch: "feature", into: "main", expectTip: head, message: "land feature" },
      );
      assert.equal(outcome.ok, true, outcome.message);
      assert.equal(outcome.authorization?.runId, runId);
      assert.equal(outcome.authorization?.expectTip, head);
      assert.equal(outcome.authorization?.targetRef, "refs/heads/main");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // MTLK-PI-EXEC union MTLK-WORKFLOWS: the pi (and pi-slices') contract
  // asserted the unsupported-workflow refusal using the merge shape
  // `feature-dev-merge-worktree`. MTLK-WORKFLOWS (workflow parity) ADMITS that
  // id, so the union (MTLK-INTEGRATE US-004) rewrites the losing shape to a
  // still-refused child-dispatch workflow (just-do-it).
  it("REFUSES a VALID pinned policy on an UNSUPPORTED workflow before any probe/findBinary/spawn with an actionable code", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const workflowId = "just-do-it";
    const workdir = path.join(tempHome, "work2");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, policyJson(), { workflowId });

    await dispatchJob(runId, workdir, { workflowId });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed", "unsupported opted-in run must be force-failed");
    assert.equal(row.scheduling_status, null);
    assert.ok(!fs.existsSync(piLog), "no host harness spawn for an unsupported workflow");
    assert.equal(seamJournal.length, 0, "the runner seam must never be invoked for an unsupported workflow");

    const events = eventsFor(runId);
    const refused = events.filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "matchlock_workflow_unsupported");
    assert.match(String(refused[0].detail), /just-do-it/);
    assert.equal(events.filter((e) => e.event === "run.force_failed").length, 1);
  });

  it("REFUSES a VALID pinned policy when the run context selects a non-pi harness (guard fail-closed, no effects)", async () => {
    const runId = "3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work2b");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, policyJson(), { workflowId });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "dsh" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.ok(!fs.existsSync(piLog), "no host harness spawn for a non-pi + policy run");
    assert.equal(seamJournal.length, 0);
    const refused = eventsFor(runId).filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "matchlock_workflow_unsupported");
    assert.match(String(refused[0].detail), /only supported with the pi harness/);
  });

  it("PROBE-ENABLED refusal: an UNSUPPORTED workflow with the probe enabled still refuses BEFORE the probe (no seam invocation, no probe events)", async () => {
    const runId = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
    const workflowId = "just-do-it";
    const workdir = path.join(tempHome, "work2c");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, policyJson(), { workflowId });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.ok(!fs.existsSync(piLog), "no host harness spawn (probe or work) for an unsupported opted-in run");
    assert.equal(seamJournal.length, 0, "the runner seam must never be invoked: refusal precedes the probe gate");
    const events = eventsFor(runId);
    assert.equal(
      events.filter((e) => e.event === "run.harness_probe_ok" || e.event === "run.harness_probe_failed").length,
      0,
      "no harness-probe event: the unsupported-capability refusal short-circuits BEFORE the probe gate",
    );
    assert.equal(events.filter((e) => e.event === "run.matchlock_dispatch_refused").length, 1);
  });

  it("refuses a MALFORMED stored policy at dispatch with an actionable message and zero harness spawns", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const workdir = path.join(tempHome, "work3");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, "{this is not json");

    await dispatchJob(runId, workdir);

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.equal(row.scheduling_status, null);
    assert.ok(!fs.existsSync(piLog), "no host harness spawn for a malformed stored policy");
    assert.equal(seamJournal.length, 0);

    const events = eventsFor(runId);
    const refused = events.filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "matchlock_policy_invalid");
    assert.match(String(refused[0].detail), /Recreate the run with --matchlock/);
  });

  it("no-flag differential: a NULL-policy (native) run dispatches normally to the host harness and never consults Matchlock", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const workdir = path.join(tempHome, "work4");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, null);

    await dispatchJob(runId, workdir);

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "running", "native run must keep running (no Matchlock refusal)");
    assert.ok(fs.existsSync(piLog), "the host harness MUST be spawned for a native (no-policy) run");
    const piArgs = fs.readFileSync(piLog, "utf-8");
    assert.ok(piArgs.includes("step claim"), "native dispatch reaches the ordinary work round");
    assert.equal(seamJournal.length, 0, "the runner seam must never be invoked for a native run");

    const events = eventsFor(runId);
    assert.equal(events.filter((e) => e.event === "run.matchlock_dispatch_refused").length, 0,
      "no Matchlock refusal for a native run");
  });

  it("refuses a legacy UNPINNED (version-1) stored policy: never looks like a working isolated run", async () => {
    const runId = "66666666-6666-4666-8666-666666666666";
    const workdir = path.join(tempHome, "work5");
    fs.mkdirSync(workdir, { recursive: true });
    const legacy = JSON.parse(policyJson()) as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.resolvedImageDigest;
    delete legacy.resolvedImageConfigDigest;
    seedRun(runId, workdir, JSON.stringify(legacy));

    await dispatchJob(runId, workdir);

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.ok(!fs.existsSync(piLog), "no host harness spawn for a legacy unpinned policy");
    assert.equal(seamJournal.length, 0);
    const refused = eventsFor(runId).filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.match(String(refused[0].detail), /legacy UNPINNED record/);
  });

  // ── in-VM launch probe through the runner seam (US-002) ─────────────

  it("PROBE-ENABLED opted-in run: the once-per-run launch probe runs IN-VM through the runner seam (run.harness_probe_ok; never the host probe; never re-probed)", async () => {
    const runId = "77777777-7777-4777-8777-777777777777";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work6");
    fs.mkdirSync(workdir, { recursive: true });
    // Two pending steps: round 1 = probe + first work round; round 2 must NOT
    // re-probe (harness_probe_status = 'ok' survives).
    seedRun(runId, workdir, policyJson(), { workflowId, pendingSteps: 2 });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId });
    assert.ok(!fs.existsSync(piLog), "host pi must never be spawned (probe or work)");

    // First round: seam invoked for the probe THEN the first work round.
    assert.equal(seamJournal.length, 2);
    assert.equal(seamJournal[0].kind, "probe");
    assert.equal(seamJournal[1].kind, "work");
    assert.ok(
      seamJournal[0].promptText.includes("TAMANDUA_HARNESS_PROBE: skill-path"),
      "guest probe prompt carries the stable harness-probe marker",
    );
    assert.ok(
      seamJournal[0].promptText.includes("/workspace/runtime/bin/tamandua skill-path"),
      "guest probe prompt instructs the packed guest CLI, never the host launcher",
    );

    const eventsAfterFirstRound = eventsFor(runId);
    const okEvents = eventsAfterFirstRound.filter((e) => e.event === "run.harness_probe_ok");
    assert.equal(okEvents.length, 1, "one run.harness_probe_ok after the first dispatch");
    assert.equal(okEvents[0].harness, "pi");
    assert.equal(
      eventsAfterFirstRound.filter((e) => e.event === "run.harness_probe_failed").length,
      0,
      "the in-VM probe must pass",
    );

    // Second dispatch round with another pending step: no re-probe, only work.
    await dispatchJob(runId, workdir, { workflowId });
    assert.equal(seamJournal.length, 3, "second round must not re-probe (work only)");
    assert.equal(seamJournal[2].kind, "work");
    assert.equal(
      eventsFor(runId).filter((e) => e.event === "run.harness_probe_ok").length,
      1,
      "a passed run is never re-probed",
    );

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed", "both steps completed through the seam");
    assert.deepEqual(
      stepRows(runId).map((s) => s.status),
      ["done", "done"],
    );
  });

  it("forwards the USER IMAGE's effective PATH (policy.imagePath) into BOTH the in-VM probe and work rounds", async () => {
    const imagePath = "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    const runId = "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-imagepath");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, policyJson("vic/ml:latest", imagePath), { workflowId, pendingSteps: 1 });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId });

    assert.ok(!fs.existsSync(piLog), "host pi must never be spawned");
    assert.equal(seamJournal.length, 2, "probe + one work round");
    assert.equal(seamJournal[0].kind, "probe");
    assert.equal(seamJournal[0].imagePath, imagePath, "the probe round carries the image PATH");
    assert.equal(seamJournal[1].kind, "work");
    assert.equal(seamJournal[1].imagePath, imagePath, "the work round carries the image PATH");
    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed");
  });

  it("rounds WITHOUT a discovered image PATH stay seam-imagePath-absent (conservative default path, no-flag behavior)", async () => {
    const runId = "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-nopath");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, policyJson(), { workflowId, pendingSteps: 1 });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId });

    assert.equal(seamJournal.length, 2, "probe + one work round");
    assert.equal(seamJournal[0].imagePath, undefined, "no imagePath discovered => probe round leaves it unset");
    assert.equal(seamJournal[1].imagePath, undefined, "no imagePath discovered => work round leaves it unset");
  });

  it("PROBE-ENABLED opted-in run with a FAILING in-VM probe records run.harness_probe_failed and force-fails (no host probe, no work round)", async () => {
    const runId = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work6b");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, policyJson(), { workflowId });
    process.env.TAMANDUA_HARNESS_PROBE = "1";
    // This test's seam answers the probe with a wrong path → in-VM probe fails.
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      seamJournal.push({ kind: round.kind, runId: round.identity.runId, agentId: round.identity.agentId, workflowId: round.identity.workflowId, jobId: round.identity.jobId, promptText: round.promptText, workdir: round.workingDirectoryForHarness, timeoutMs: round.timeoutMs });
      if (round.kind === "probe") {
        return { output: "not-the-skill-path", exitCode: 0, signal: null, timedOut: false, durationMs: 4 };
      }
      throw new Error("no work round may run after a failed probe");
    });

    await dispatchJob(runId, workdir, { workflowId });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed", "a failed in-VM probe force-fails the run");
    assert.equal(seamJournal.length, 1, "only the probe round ran; no work round after a failed probe");
    assert.equal(seamJournal[0].kind, "probe");
    assert.ok(!fs.existsSync(piLog), "the host probe/harness must never spawn");

    const events = eventsFor(runId);
    const failed = events.filter((e) => e.event === "run.harness_probe_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].expected, MATCHLOCK_GUEST_SKILL_FILE);
    assert.match(String(failed[0].detail), /FAILURE_CLASS: harness_unavailable/);
    assert.equal(events.filter((e) => e.event === "run.force_failed").length, 1);
  });

  // ── idle zero-spawn ─────────────────────────────────────────────────

  it("IDLE opted-in run (no pending step) performs NO runner/VM invocation on a dispatch round", async () => {
    const runId = "88888888-8888-4888-8888-888888888888";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work7");
    fs.mkdirSync(workdir, { recursive: true });
    // A run row with the pinned policy but NO steps: the deterministic peek
    // reports NO_WORK, so no probe and no work round may start.
    seedRun(runId, workdir, policyJson(), { workflowId, pendingSteps: 0 });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "running", "idle run stays running (no refusal, no completion)");
    assert.equal(seamJournal.length, 0, "zero runner/VM invocations for an idle opted-in round");
    assert.ok(!fs.existsSync(piLog), "zero host harness spawns");
    const events = eventsFor(runId);
    assert.equal(events.filter((e) => e.event === "run.matchlock_dispatch_refused").length, 0);
    assert.equal(
      events.filter((e) => e.event === "run.harness_probe_ok" || e.event === "run.harness_probe_failed").length,
      0,
      "no probe events on an idle round",
    );
  });

  // ── prompt + guest-constant unit checks (US-002) ────────────────────

  it("buildMatchlockWorkPrompt embeds the GUEST CLI path; native buildWorkPrompt output keeps the HOST CLI (byte-identical native prompt)", () => {
    const runId = "7aeb4da9-1111-4222-8333-abcdefabcdef";
    const hostCli = resolveTamanduaCli();
    const nativePrompt = buildWorkPrompt("do-now", "do-now_doer", runId);
    const guestPrompt = buildMatchlockWorkPrompt("do-now", "do-now_doer", runId);

    assert.ok(hostCli.length > 0, "host CLI must resolve in this environment");
    assert.ok(!hostCli.includes("/workspace/runtime"), "host CLI is a host path, never the guest pack");
    assert.ok(nativePrompt.includes(`"${hostCli}" step claim`), "native prompt embeds the HOST CLI");
    assert.ok(!nativePrompt.includes("/workspace/runtime/bin/tamandua"), "native prompt must not embed the guest CLI");

    assert.ok(
      guestPrompt.includes(`"${MATCHLOCK_GUEST_CLI}" step claim "do-now_doer" --run-id "${runId}"`),
      "guest prompt claims through the GUEST CLI",
    );
    assert.ok(guestPrompt.includes(`${MATCHLOCK_GUEST_CLI}" step complete "step-<uuid>"`), "guest prompt completes via the guest CLI");
    assert.ok(guestPrompt.includes(`${MATCHLOCK_GUEST_CLI}" step fail "step-<uuid>"`), "guest prompt fails via the guest CLI");
    assert.ok(!guestPrompt.includes(hostCli), "guest prompt must NEVER embed the host CLI path");

    // Structural parity: identical except the CLI path (host vs guest).
    const withoutCli = (p: string, cli: string): string => p.split(cli).join("{{CLI}}");
    assert.equal(
      withoutCli(guestPrompt, MATCHLOCK_GUEST_CLI),
      withoutCli(nativePrompt, hostCli),
      "native and guest work prompts must be identical apart from the CLI path",
    );
  });

  it("matchlock probe command/prompt and expected path are the guest pack surface (never the host launcher)", () => {
    assert.equal(MATCHLOCK_GUEST_CLI, "/workspace/runtime/bin/tamandua");
    assert.equal(MATCHLOCK_GUEST_SKILL_FILE, "/workspace/runtime/skills/tamandua-agents/SKILL.md");
    assert.equal(buildMatchlockProbeCommand(), "/workspace/runtime/bin/tamandua skill-path");
    const prompt = buildMatchlockProbePrompt();
    assert.ok(prompt.startsWith("TAMANDUA_HARNESS_PROBE: skill-path\n"));
    assert.ok(prompt.includes('"/workspace/runtime/bin/tamandua skill-path"'));
    assert.ok(!prompt.includes(resolveTamanduaCli()), "guest probe prompt must not embed the host CLI");
  });

  // ── MTLK-HERMES-EXEC US-003: hermes opt-in scheduler dispatch ─────────

  for (const workflowId of SUPPORTED_WORKFLOWS) {
    it(`HERMES opt-in: valid persisted hermes policy on "${workflowId}" dispatches through the runner seam (execution, NOT backend_not_integrated; step completes; ZERO host spawns)`, async () => {
      const runId = "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a";
      const workdir = path.join(tempHome, "work-hermes");
      fs.mkdirSync(workdir, { recursive: true });
      seedRun(runId, workdir, hermesPolicyJson(), { workflowId });

      await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

      const row = runRow(runId);
      assert.ok(row);
      assert.equal(row.status, "completed", "a supported hermes opt-in must reach real completion through the runner seam");
      assert.equal(row.scheduling_status, null);
      assert.ok(row.matchlock_policy, "the completed hermes run keeps its pin");
      assert.ok(!fs.existsSync(piLog), "the host harness must NEVER be spawned for a hermes opt-in (probe or work)");
      assert.equal(seamJournal.length, 1, "exactly one hermes work round through the runner seam");
      assert.equal(seamJournal[0].kind, "work");
      assert.ok(
        seamJournal[0].promptText.includes('"/workspace/runtime/bin/tamandua" step claim'),
        "the hermes work prompt must instruct reporting through the GUEST CLI",
      );
      const steps = stepRows(runId);
      assert.equal(steps.length, 1);
      assert.equal(steps[0].status, "done", "the hermes step must complete through the seam");
      const events = eventsFor(runId);
      assert.equal(events.filter((e) => e.event === "run.matchlock_dispatch_refused").length, 0);
      assert.equal(events.filter((e) => e.event === "run.force_failed").length, 0,
        "no backend_not_integrated force-fail for a supported hermes opt-in");
    });
  }

  it("HERMES opt-in: unsupported workflow refuses BEFORE any runner-seam invocation with matchlock_workflow_unsupported (no probe events, no host spawns)", async () => {
    const runId = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
    const workflowId = "just-do-it";
    const workdir = path.join(tempHome, "work-hermes2");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.ok(!fs.existsSync(piLog), "no host harness spawn for an unsupported hermes opt-in");
    assert.equal(seamJournal.length, 0, "the runner seam must never be invoked: refusal precedes the probe gate");
    const events = eventsFor(runId);
    assert.equal(
      events.filter((e) => e.event === "run.harness_probe_ok" || e.event === "run.harness_probe_failed").length,
      0,
      "no harness-probe event for an unsupported hermes opt-in",
    );
    const refused = events.filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "matchlock_workflow_unsupported");
    assert.match(String(refused[0].detail), /just-do-it/);
    assert.match(String(refused[0].detail), /refusal class child-workflow-dispatch/);
  });

  it("HERMES opt-in: a context harness that is NOT hermes (pi) against a hermes policy refuses closed with the hermes guidance", async () => {
    const runId = "4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-hermes3");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "pi" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.equal(seamJournal.length, 0);
    assert.ok(!fs.existsSync(piLog), "no host harness spawn");
    const refused = eventsFor(runId).filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "matchlock_workflow_unsupported");
    assert.match(String(refused[0].detail), /only supported with the hermes harness/);
  });

  it("HERMES opt-in PROBE: the once-per-run launch probe runs IN-VM through the runner seam labelled hermes (run.harness_probe_ok.harness === 'hermes'; guest probe prompt; no host probe)", async () => {
    const runId = "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-hermes4");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    assert.ok(!fs.existsSync(piLog), "host pi must never be spawned (probe or work)");
    assert.equal(seamJournal.length, 2, "probe round + work round through the runner seam");
    assert.equal(seamJournal[0].kind, "probe");
    assert.ok(
      seamJournal[0].promptText.includes("/workspace/runtime/bin/tamandua skill-path"),
      "hermes guest probe prompt instructs the packed guest CLI, never the host launcher",
    );
    assert.ok(!seamJournal[0].promptText.includes(resolveTamanduaCli()));

    const events = eventsFor(runId);
    const okEvents = events.filter((e) => e.event === "run.harness_probe_ok");
    assert.equal(okEvents.length, 1);
    assert.equal(okEvents[0].harness, "hermes", "the in-VM hermes probe is labelled hermes");
    assert.equal(events.filter((e) => e.event === "run.harness_probe_failed").length, 0);

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed", "the hermes opt-in completes after a passed in-VM probe");
  });

  it("HERMES opt-in PROBE failing answer: the in-VM hermes probe failure force-fails with expected skill-path evidence (no work round)", async () => {
    const runId = "4e4e4e4e-4e4e-4e4e-8e4e-4e4e4e4e4e4e";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-hermes5");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    process.env.TAMANDUA_HARNESS_PROBE = "1";
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      seamJournal.push({ kind: round.kind, runId: round.identity.runId, agentId: round.identity.agentId, workflowId: round.identity.workflowId, jobId: round.identity.jobId, promptText: round.promptText, workdir: round.workingDirectoryForHarness, timeoutMs: round.timeoutMs });
      if (round.kind === "probe") {
        return { output: "the-hermes-agent-cannot-see-the-pack", exitCode: 0, signal: null, timedOut: false, durationMs: 4 };
      }
      throw new Error("no work round may run after a failed hermes probe");
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed", "a failed in-VM hermes probe force-fails the run");
    assert.equal(seamJournal.length, 1, "only the probe round ran");
    const failed = eventsFor(runId).filter((e) => e.event === "run.harness_probe_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].harness, "hermes");
    assert.equal(failed[0].expected, MATCHLOCK_GUEST_SKILL_FILE);
  });

  it("HERMES opt-in WORK round: the runner's in-VM usage projection is attributed to the run (session/usage post-round path; unavailable never a fabricated zero)", async () => {
    const runId = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-hermes-usage");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    // Install a seam whose WORK result carries the HermesInvocationResult
    // usage projection (input100 + output50 + cache_write5 = 155; cache_read
    // excluded) — exactly what the US-002 runner returns for a real round.
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      seamJournal.push({ kind: round.kind, runId: round.identity.runId, agentId: round.identity.agentId, workflowId: round.identity.workflowId, jobId: round.identity.jobId, promptText: round.promptText, workdir: round.workingDirectoryForHarness, timeoutMs: round.timeoutMs });
      if (round.kind === "probe") {
        return { output: MATCHLOCK_GUEST_SKILL_FILE, exitCode: 0, signal: null, timedOut: false, durationMs: 5 };
      }
      const db = getDb();
      db.prepare(
        `UPDATE steps SET status = 'running', claim_job_id = ?
         WHERE id = (SELECT id FROM steps WHERE run_id = ? AND status = 'pending'
                     ORDER BY step_index ASC LIMIT 1)`,
      ).run(round.identity.jobId, round.identity.runId);
      return {
        output: "STATUS: done\nCHANGES: hermes seam work\nTESTS: seam",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 12,
        usage: { status: "ok", tokens: 155, evidence: ["session s projection from the mapped store"] },
      };
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed");
    const tokens = getDb().prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number } | undefined;
    assert.ok(tokens, "run row must exist");
    assert.equal(tokens.tokens_spent, 155, "the runner's in-VM usage projection is attributed exactly once");
  });

  // ── US-006 (H1/D1): a completed guest round is never empty_output ─────
  it("US-006: applyGuestStepCompletionEvidence upgrades ONLY an empty round with authoritative step-completion evidence", () => {
    const evidence = { stepRowId: "row-1", stepId: "step-1" };
    // The defect: lost harness stdout on a round whose guest completed the step.
    assert.equal(applyGuestStepCompletionEvidence("empty_output", evidence), "work_done");
    // Honest empty_output (no completion evidence) is preserved.
    assert.equal(applyGuestStepCompletionEvidence("empty_output", null), "empty_output");
    // STATUS markers still win; only empty_output is upgraded.
    assert.equal(applyGuestStepCompletionEvidence("work_done", evidence), "work_done");
    assert.equal(applyGuestStepCompletionEvidence("work_failed", evidence), "work_failed");
    assert.equal(applyGuestStepCompletionEvidence("other_output", evidence), "other_output");
    assert.equal(applyGuestStepCompletionEvidence("no_work", evidence), "no_work");
  });

  it("US-006: step-completion evidence is scoped to steps THIS round completed (pre-round snapshot matters)", () => {
    const runId = "5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-us006-evidence");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId, pendingSteps: 2 });
    const db = getDb();
    const jobId = `${workflowId}_test-agent`;
    // Round 1: no step done yet.
    const before = snapshotDoneStepsClaimedByWorker(db, jobId, runId);
    assert.equal(before.size, 0);
    assert.equal(findStepCompletedByWorker(db, jobId, runId, before), null, "no completion evidence before any round");
    // The guest claims + completes step-1 (via the bridge/DB).
    const step1 = db.prepare("SELECT id FROM steps WHERE run_id = ? ORDER BY step_index ASC LIMIT 1").get(runId) as { id: string };
    db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE id = ?").run(jobId, step1.id);
    completeStep(step1.id, "STATUS: done\nREPORT: guest completed via the bridge");
    const found = findStepCompletedByWorker(db, jobId, runId, before);
    assert.ok(found, "the newly-done step is authoritative evidence the round did work");
    assert.equal(found.stepRowId, step1.id);
    assert.equal(found.stepId, "step-1");
    // A LATER round inherits the same done step: the snapshot prevents a stale
    // completion from being re-attributed to an empty round.
    const beforeLater = snapshotDoneStepsClaimedByWorker(db, jobId, runId);
    assert.equal(beforeLater.size, 1);
    assert.equal(findStepCompletedByWorker(db, jobId, runId, beforeLater), null, "an inherited completion is not this round's evidence");
  });

  it("US-006: a Matchlock work round whose guest completed the step is classified work_done even with empty stdout (never empty_output)", async () => {
    const runId = "5d5d5d5d-5d5d-4d5d-8d5d-5d5d5d5d5d5d";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-us006-empty-work-done");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    // Seam fake: emulate the guest CLAIMING + COMPLETING the step through the
    // host broker (the DB), then losing the final harness stdout in the VM
    // transport (empty output + exitCode null + a rejected exec diagnostic).
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      seamJournal.push({
        kind: round.kind,
        runId: round.identity.runId,
        agentId: round.identity.agentId,
        workflowId: round.identity.workflowId,
        jobId: round.identity.jobId,
        promptText: round.promptText,
        workdir: round.workingDirectoryForHarness,
        timeoutMs: round.timeoutMs,
      });
      if (round.kind === "probe") {
        return { output: MATCHLOCK_GUEST_SKILL_FILE, exitCode: 0, signal: null, timedOut: false, durationMs: 5 };
      }
      const db = getDb();
      const step = db
        .prepare("SELECT id FROM steps WHERE run_id = ? AND status = 'pending' ORDER BY step_index ASC LIMIT 1")
        .get(round.identity.runId) as { id: string };
      db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE id = ?").run(round.identity.jobId, step.id);
      completeStep(step.id, "STATUS: done\nREPORT: Created hello.txt and committed it");
      return {
        output: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 12,
        stderrTail: "harness exec failed: matchlock rpc error -32000: relay dropped final stdout frames",
        harnessExecError: "matchlock rpc error -32000: relay dropped final stdout frames",
      };
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed", "the run completes: the guest did the work");
    const stepRow = getDb().prepare("SELECT status FROM steps WHERE run_id = ?").get(runId) as { status: string };
    assert.equal(stepRow.status, "done", "the authoritative step row stays done");
    // The per-round classification must be work_done, not empty_output.
    const logText = fs.readFileSync(path.join(process.env.TAMANDUA_STATE_DIR as string, "tamandua.log"), "utf-8");
    const completeLine = logText.split("\n").find((l) => l.includes("Work round complete") && l.includes(runId));
    assert.ok(completeLine, "the Work round complete line must be logged");
    assert.match(completeLine!, /"outcome":"work_done"/, "a completed guest round must never be classified empty_output");
    assert.doesNotMatch(completeLine!, /"outcome":"empty_output"/);
    assert.match(logText, /Empty harness stdout but the guest completed the step/, "the authoritative fallback is logged with its evidence");
  });

  it("US-006: a genuinely empty Matchlock round that completed no step keeps an honest empty_output", async () => {
    const runId = "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-us006-honest-empty");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    let workRounds = 0;
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      if (round.kind === "probe") {
        return { output: MATCHLOCK_GUEST_SKILL_FILE, exitCode: 0, signal: null, timedOut: false, durationMs: 5 };
      }
      workRounds += 1;
      if (workRounds === 1) {
        // Claim but do NOT complete: the harness died before finishing.
        const db = getDb();
        db.prepare(
          `UPDATE steps SET status = 'running', claim_job_id = ?
           WHERE id = (SELECT id FROM steps WHERE run_id = ? AND status = 'pending' ORDER BY step_index ASC LIMIT 1)`,
        ).run(round.identity.jobId, round.identity.runId);
      }
      return { output: "", exitCode: null, signal: null, timedOut: false, durationMs: 8 };
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    // The step was NOT completed, so the round must stay an honest
    // empty_output (which triggers the existing worker_lost orphan recovery).
    const logText = fs.readFileSync(path.join(process.env.TAMANDUA_STATE_DIR as string, "tamandua.log"), "utf-8");
    const completeLine = logText.split("\n").find((l) => l.includes("Work round complete") && l.includes(runId));
    assert.ok(completeLine, "the Work round complete line must be logged");
    assert.match(completeLine!, /"outcome":"empty_output"/, "a round that produced nothing and completed no step stays empty_output");
    assert.doesNotMatch(logText, /Empty harness stdout but the guest completed the step/);
  });

  // ── US-001: pin BOTH merged semantics together ────────────────────────
  // The union merge brings main's #75 per-call token summation (pi reports
  // usage PER API CALL, so the round parser must SUM every assistant
  // message_end) together with this branch's #77 in-VM empty-output overlay
  // (a completed guest step is stronger evidence than lost stdout). They
  // touch the same round-classification path, so one test pins both — it
  // must fail if EITHER side is reverted by a future merge.
  it("US-001: parseWorkRoundMetadata SUMS per-call usage while the empty-output overlay keeps a completed round work_done", () => {
    // (a) Shared harness policy: input + output + cache_write; cache_read
    // excluded. Two API calls in one round must be summed (125 + 10 = 135).
    const firstCall = { input: 100, output: 20, cacheWrite: 5, cacheRead: 999 };
    const secondCall = { input: 7, output: 3, cacheWrite: 0, cacheRead: 500 };
    const stream = [
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: firstCall, content: [{ type: "text", text: "working" }] },
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: secondCall, content: [{ type: "text", text: "STATUS: done" }] },
      }),
    ].join("\n");
    const meta = parseWorkRoundMetadata(stream);
    assert.equal(
      meta.tokenUsage,
      135,
      "per-call usage must be summed across every assistant message_end (last-only would be 10)",
    );

    // Aggregate-only fallback: with no component field, the cache-inclusive
    // totalTokens is the only figure available for that call.
    const aggregateOnly = parseWorkRoundMetadata(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { totalTokens: 42 }, content: [{ type: "text", text: "done" }] },
      }),
    );
    assert.equal(aggregateOnly.tokenUsage, 42);

    // (b) #77's empty-output overlay: lost VM stdout backed by an
    // authoritative completed guest step is work_done, never empty_output.
    assert.equal(classifyWorkRoundOutcome(""), "empty_output");
    assert.equal(
      applyGuestStepCompletionEvidence(classifyWorkRoundOutcome(""), { stepRowId: "row-1", stepId: "step-1" }),
      "work_done",
      "the merged empty-output overlay must survive",
    );
    assert.equal(
      applyGuestStepCompletionEvidence(classifyWorkRoundOutcome(""), null),
      "empty_output",
      "a genuinely empty round with no completion evidence stays empty_output",
    );
  });

  // ── US-002: pin PRAW classifier + Matchlock empty-output overlay together ─
  // Main's PRAW classifier (parseWorkRoundMetadata drops the raw-transcript
  // fallback; classifyWorkRoundOutcome anchors /^\s*STATUS:\s*done\b/im) and
  // this branch's #77 empty-output overlay (applyGuestStepCompletionEvidence
  // upgrades ONLY an empty round backed by authoritative step-completion
  // evidence) meet on the merged tree. These cases must FAIL if EITHER is
  // reverted: PRAW alone says a no-text JSON round is empty_output; the
  // overlay alone says a completed guest round is work_done; together they
  // say "empty stdout + completed step => work_done, never empty_output".
  const NO_TEXT_JSON_ROUND = [
    JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 9999 },
      },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      result: {
        content: [{ type: "text", text: "cat'ed task instructions\nSTATUS: done\nCHANGES: nope" }],
      },
    }),
  ].join("\n");

  it("US-002: a JSON round with events but zero assistant text classifies empty_output (no raw-transcript fallback)", () => {
    const meta = parseWorkRoundMetadata(NO_TEXT_JSON_ROUND);
    // The raw transcript contains a literal "STATUS: done" inside a
    // tool_execution result, but the assistant's own text is the ONLY report
    // source — never the JSONL transcript.
    assert.equal(meta.jsonMetadataDetected, true);
    assert.equal(meta.assistantOutput, "", "no assistant text => empty assistant output, never the raw transcript");
    assert.equal(
      classifyWorkRoundOutcome(meta.assistantOutput),
      "empty_output",
      "PRAW: a no-text JSON round must classify empty_output, never work_done",
    );
    assert.notEqual(classifyWorkRoundOutcome(meta.assistantOutput), "work_done");
  });

  it("US-002: 'STATUS: done' at line start (multiline m anchor) classifies work_done", () => {
    assert.equal(classifyWorkRoundOutcome("STATUS: done"), "work_done");
    // The m flag makes ^ match at every line start, so a STATUS line after
    // arbitrary preamble still anchors.
    assert.equal(classifyWorkRoundOutcome("some preamble\nSTATUS: done\nCHANGES: x"), "work_done");
    // Leading whitespace is allowed by the \s* anchor.
    assert.equal(classifyWorkRoundOutcome("  STATUS: done"), "work_done");
  });

  it("US-002: a mid-line 'STATUS: done' echo classifies other_output (anchor not matched)", () => {
    assert.equal(classifyWorkRoundOutcome("tool says STATUS: done"), "other_output");
    assert.equal(classifyWorkRoundOutcome("the agent echoed STATUS: done mid-line, not as a report"), "other_output");
  });

  it("US-002: a completed-guest round with empty stdout stays work_done (Matchlock overlay wins over PRAW empty_output)", () => {
    // Full chain: PRAW first classifies the no-text JSON round empty_output,
    // then the Matchlock overlay upgrades it ONLY when authoritative
    // step-completion evidence exists. Reverting EITHER side breaks an assert.
    const meta = parseWorkRoundMetadata(NO_TEXT_JSON_ROUND);
    const prawOutcome = classifyWorkRoundOutcome(meta.assistantOutput);
    assert.equal(prawOutcome, "empty_output", "PRAW must classify the no-text round empty_output first");
    const evidence = { stepRowId: "row-1", stepId: "step-1" };
    assert.equal(
      applyGuestStepCompletionEvidence(prawOutcome, evidence),
      "work_done",
      "the Matchlock overlay must upgrade an empty round backed by a completed guest step",
    );
    assert.equal(
      applyGuestStepCompletionEvidence(prawOutcome, null),
      "empty_output",
      "without completion evidence the honest empty_output must survive",
    );
  });

  it("US-008 (H3): a hermes Matchlock work round's metadata carries the attributed token delta, not null", async () => {
    const runId = "5f1f1f1f-5f1f-4f1f-8f1f-5f1f1f1f5f1f";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-us008-hermes-delta");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    // The H3 defect: a hermes Matchlock work round's plain-text stdout carries
    // no usage, so parseWorkRoundMetadata().tokenUsage is null — yet the H2
    // in-VM projection recovered a real mapped-store session (here 5042
    // tokens) and attributed it. The per-round "Work round complete" metadata
    // must report that attributed delta, not the stdout-only null.
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      if (round.kind === "probe") {
        return { output: MATCHLOCK_GUEST_SKILL_FILE, exitCode: 0, signal: null, timedOut: false, durationMs: 5 };
      }
      const db = getDb();
      const step = db
        .prepare("SELECT id FROM steps WHERE run_id = ? AND status = 'pending' ORDER BY step_index ASC LIMIT 1")
        .get(runId) as { id: string };
      db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE id = ?").run(round.identity.jobId, step.id);
      completeStep(step.id, "STATUS: done\nREPORT: hermes work");
      return {
        output: "STATUS: done\nREPORT: hermes work",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 11,
        usage: { status: "ok", tokens: 5042, evidence: ["mapped store session projection"] },
      };
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    const tokens = getDb().prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number };
    assert.equal(tokens.tokens_spent, 5042, "the projected delta is attributed exactly once");
    const logText = fs.readFileSync(path.join(process.env.TAMANDUA_STATE_DIR as string, "tamandua.log"), "utf-8");
    const completeLine = logText.split("\n").find((l) => l.includes("Work round complete") && l.includes(runId));
    assert.ok(completeLine, "the Work round complete line must be logged");
    assert.match(completeLine!, /"tokenUsage":5042/, "the round metadata must carry the attributed delta (H3), not null");
    assert.doesNotMatch(completeLine!, /"tokenUsage":null/);
    // metadataFormat stays truthful: hermes stdout is plain text, not JSON.
    assert.match(completeLine!, /"metadataFormat":"text"/);
  });

  it("US-008 (H3): a hermes Matchlock round with genuinely unavailable usage keeps an honest null tokenUsage", async () => {
    const runId = "5f2f2f2f-5f2f-4f2f-8f2f-5f2f2f2f5f2f";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-us008-hermes-unavailable");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      if (round.kind === "probe") {
        return { output: MATCHLOCK_GUEST_SKILL_FILE, exitCode: 0, signal: null, timedOut: false, durationMs: 5 };
      }
      const db = getDb();
      const step = db
        .prepare("SELECT id FROM steps WHERE run_id = ? AND status = 'pending' ORDER BY step_index ASC LIMIT 1")
        .get(runId) as { id: string };
      db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE id = ?").run(round.identity.jobId, step.id);
      completeStep(step.id, "STATUS: done\nREPORT: hermes work");
      return {
        output: "STATUS: done\nREPORT: hermes work",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 11,
        usage: { status: "unavailable", evidence: ["no session recovered in the mapped store"] },
      };
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    // Nothing is fabricated: no delta lands, and the per-round metadata is
    // honest about it.
    const tokens = getDb().prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number };
    assert.equal(tokens.tokens_spent, 0, "unavailable usage never fabricates a delta");
    const logText = fs.readFileSync(path.join(process.env.TAMANDUA_STATE_DIR as string, "tamandua.log"), "utf-8");
    const completeLine = logText.split("\n").find((l) => l.includes("Work round complete") && l.includes(runId));
    assert.ok(completeLine, "the Work round complete line must be logged");
    assert.match(completeLine!, /"tokenUsage":null/, "genuinely unavailable usage is reported honestly as null");
    assert.match(logText, /Matchlock hermes round usage unavailable/);
  });

  it("HERMES opt-in PROBE usage: the probe's in-VM usage projection is attributed to the run and recorded on run.harness_probe_ok", async () => {
    const runId = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-hermes-probe-usage");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, hermesPolicyJson(), { workflowId });
    process.env.TAMANDUA_HARNESS_PROBE = "1";
    setMatchlockSchedulerRoundRunnerForTest(async (round) => {
      seamJournal.push({ kind: round.kind, runId: round.identity.runId, agentId: round.identity.agentId, workflowId: round.identity.workflowId, jobId: round.identity.jobId, promptText: round.promptText, workdir: round.workingDirectoryForHarness, timeoutMs: round.timeoutMs });
      if (round.kind === "probe") {
        // Probe passes (skill-path answer) and reports in-VM usage 55.
        return {
          output: MATCHLOCK_GUEST_SKILL_FILE,
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          usage: { status: "ok", tokens: 55, evidence: ["probe session projection from the mapped store"] },
        };
      }
      const db = getDb();
      db.prepare(
        `UPDATE steps SET status = 'running', claim_job_id = ?
         WHERE id = (SELECT id FROM steps WHERE run_id = ? AND status = 'pending'
                     ORDER BY step_index ASC LIMIT 1)`,
      ).run(round.identity.jobId, round.identity.runId);
      return {
        output: "STATUS: done\nCHANGES: hermes seam work\nTESTS: seam",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 10,
      };
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed");
    const tokens = getDb().prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number } | undefined;
    assert.equal(tokens?.tokens_spent, 55, "the hermes probe's in-VM usage projection is attributed once");
    const okEvents = eventsFor(runId).filter((e) => e.event === "run.harness_probe_ok");
    assert.equal(okEvents.length, 1);
    assert.equal(okEvents[0].tokens, 55);
  });

  it("no-flag differential: hermes WITHOUT --matchlock never consults Matchlock dispatch or the runner seam (native host hermes spawns)", async () => {
    const runId = "4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-hermes6");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, null, { workflowId });

    // Native hermes route: a journaling mock hermes binary on the host.
    const hermesPath = path.join(tempHome, "hermes-mock");
    makeMockBinary(hermesPath, piLog);
    const savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;
    try {
      await dispatchJob(runId, workdir, { workflowId, harnessType: "hermes" });
    } finally {
      if (savedHermesBinary === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
      else process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    }

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "running", "native hermes run must keep running (no Matchlock refusal)");
    assert.ok(fs.existsSync(piLog), "the host hermes harness MUST be spawned for a native no-flag run");
    assert.match(fs.readFileSync(piLog, "utf-8"), /step claim/, "native hermes dispatch reaches the ordinary work round");
    assert.equal(seamJournal.length, 0, "the Matchlock runner seam must never be invoked for a no-flag hermes run");
    const events = eventsFor(runId);
    assert.equal(events.filter((e) => e.event === "run.matchlock_dispatch_refused").length, 0,
      "no Matchlock refusal for a no-flag hermes run");
  });

  // ── MTLK-DSH-EXEC US-002: harness "dsh" opted-in dispatch ─────────────

  function dshPolicyJson(dshHome: string): string {
    return serializeMatchlockPolicy(
      buildMatchlockPolicy({
        requestedImage: "vic/dsh:latest",
        identity: {
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          config_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          tag: "vic/dsh:latest",
        },
        harness: "dsh",
        configurationRoot: dshHome,
        submissionHomeDir: path.dirname(dshHome),
        submissionCwd: "/srv/project",
        submissionDshHomeEnv: null,
        submissionDshHomeSource: "default",
        workingDirectory: "/srv/project",
        originalRepositoryRoot: "/srv/project",
        workMounts: [
          { hostPath: "/srv/project", hostRealPath: "/srv/project", guestPath: "/srv/project" },
        ],
        gitMetadataRoots: [],
      }),
    );
  }

  interface DshSeamJournalEntry {
    kind: "probe" | "work";
    runId: string;
    agentId: string;
    workflowId: string;
    jobId: string;
    promptText: string;
    workdir: string;
  }

  function installDshSeamFake(state: {
    journal: DshSeamJournalEntry[];
    probePasses?: boolean;
    workCompletes?: boolean;
    /** When set, the fake writes a synthetic v3 session into the mounted home. */
    writeSessionIntoStore?: boolean;
  }): void {
    setDshSchedulerRoundRunnerForTest(async (round) => {
      state.journal.push({
        kind: round.kind,
        runId: round.identity.runId,
        agentId: round.identity.agentId,
        workflowId: round.identity.workflowId,
        jobId: round.identity.jobId,
        promptText: round.promptText,
        workdir: round.workingDirectoryForHarness,
      });
      if (state.writeSessionIntoStore && round.kind === "work") {
        // Simulate the guest dsh writing a real v3 session into the mounted
        // effective DSH_HOME during the round (plain-text encoding).
        const home = round.policy.configurationRoot;
        const key = round.workingDirectoryForHarness.split("/").filter(Boolean).join("-");
        const dir = path.join(home, "sessions", `--${key}--`, "session-round");
        fs.mkdirSync(dir, { recursive: true });
        const header = JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-attr-root",
          createdAt: Date.now(),
          cwd: round.workingDirectoryForHarness,
          isSeeded: false,
          delegationDepth: 0,
        });
        const msg = JSON.stringify({
          type: "assistant/message",
          seq: 1,
          time: Date.now(),
          data: {
            turn: 0,
            step: 0,
            message: { role: "assistant", content: [] },
            usage: { inputTokens: 40, outputTokens: 10 },
            stream: [],
          },
        });
        fs.writeFileSync(path.join(dir, "session.v3.jsonl"), `${header}\n${msg}\n`, "utf8");
      }
      if (round.kind === "probe") {
        return {
          output: state.probePasses === false ? "not-a-path" : DSH_MATCHLOCK_GUEST_SKILL_FILE,
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
        };
      }
      const db = getDb();
      db.prepare(
        `UPDATE steps SET status = 'running', claim_job_id = ?
         WHERE id = (SELECT id FROM steps WHERE run_id = ? AND status = 'pending'
                     ORDER BY step_index ASC LIMIT 1)`,
      ).run(round.identity.jobId, round.identity.runId);
      return {
        output:
          state.workCompletes === false
            ? ""
            : "STATUS: done\nCHANGES: dsh seam work\nTESTS: dsh seam tests",
        exitCode: state.workCompletes === false ? 1 : 0,
        signal: null,
        timedOut: false,
        durationMs: 10,
      };
    });
  }

  it("dsh: dispatches a VALID pinned harness-dsh policy on do-now through the dsh runner seam (ZERO host spawns; guest-CLI prompt; step completes; no refusal)", async () => {
    const runId = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
    const workflowId = "do-now";
    const dshHome = path.join(tempHome, "dsh-home");
    fs.mkdirSync(dshHome, { recursive: true });
    const workdir = path.join(tempHome, "work-dsh");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, dshPolicyJson(dshHome), { workflowId });
    installDshSeamFake({ journal: seamJournalDsh });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "dsh" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed", "supported dsh opted-in run must reach real completion");
    assert.ok(!fs.existsSync(piLog), "host pi must never spawn for an opted-in dsh run");
    assert.equal(seamJournalDsh.length, 1, "exactly one dsh work round through the seam");
    assert.equal(seamJournalDsh[0].kind, "work");
    assert.ok(
      seamJournalDsh[0].promptText.includes('"/workspace/runtime/bin/tamandua" step claim'),
      "dsh work prompt reports through the GUEST CLI",
    );
    assert.ok(
      seamJournalDsh[0].promptText.includes("headless dsh mode with plain-text output"),
      "dsh work prompt declares plain-text headless dsh output (never pi --mode json)",
    );
    assert.ok(!seamJournalDsh[0].promptText.includes(resolveTamanduaCli()), "no host CLI in the dsh prompt");
    const steps = stepRows(runId);
    assert.equal(steps[0].status, "done");
    assert.equal(
      eventsFor(runId).filter((e) => e.event === "run.matchlock_dispatch_refused").length,
      0,
    );
  });

  it("dsh: attributes usage from the MOUNTED store after a work round (confined read; plain-text status never blocked) and honors an empty store honestly", async () => {
    const runId = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";
    const workflowId = "do-now";
    const dshHome = path.join(tempHome, "dsh-home2");
    fs.mkdirSync(path.join(dshHome, "sessions"), { recursive: true });
    const workdir = path.join(tempHome, "work-dsh2");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, dshPolicyJson(dshHome), { workflowId });
    installDshSeamFake({ journal: seamJournalDsh, writeSessionIntoStore: true });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "dsh" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "completed", "store attribution must never block plain-text step status");
    assert.equal(stepRows(runId)[0].status, "done");
    // The fake dsh wrote one v3 session with input 40 + output 10 into the
    // mounted store; the confined read attributes the integer single count.
    const tokensRow = getDb().prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number } | undefined;
    assert.ok(tokensRow);
    assert.equal(tokensRow.tokens_spent, 50, "usage attributed from the mounted store (mirror excluded)");
  });

  it("dsh: REFUSES a VALID pinned harness-dsh policy on an UNSUPPORTED workflow BEFORE any probe/spawn (seam never invoked)", async () => {
    const runId = "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c";
    const workflowId = "just-do-it";
    const dshHome = path.join(tempHome, "dsh-home3");
    fs.mkdirSync(dshHome, { recursive: true });
    const workdir = path.join(tempHome, "work-dsh3");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, dshPolicyJson(dshHome), { workflowId });
    installDshSeamFake({ journal: seamJournalDsh });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "dsh" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.ok(!fs.existsSync(piLog), "no host harness spawn for an unsupported dsh run");
    assert.equal(seamJournalDsh.length, 0, "the dsh runner seam must never be invoked for an unsupported workflow");
    const refused = eventsFor(runId).filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, "matchlock_workflow_unsupported");
    assert.match(String(refused[0].detail), /just-do-it/);
  });

  it("dsh: REFUSES a pinned harness-dsh policy when the run context selected the pi harness (inconsistent; guard fail-closed)", async () => {
    const runId = "9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d";
    const workflowId = "do-now";
    const dshHome = path.join(tempHome, "dsh-home4");
    fs.mkdirSync(dshHome, { recursive: true });
    const workdir = path.join(tempHome, "work-dsh4");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, dshPolicyJson(dshHome), { workflowId });
    installDshSeamFake({ journal: seamJournalDsh });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "pi" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.equal(seamJournalDsh.length, 0);
    const refused = eventsFor(runId).filter((e) => e.event === "run.matchlock_dispatch_refused");
    assert.equal(refused.length, 1);
    assert.match(String(refused[0].detail), /only supported with the dsh harness/);
  });

  it("dsh: PROBE-ENABLED once-per-run launch probe runs IN-VM through the dsh seam (guest packed skill path; run.harness_probe_ok harness=dsh; never re-probed; ZERO host spawns)", async () => {
    const runId = "9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e";
    const workflowId = "do-now";
    const dshHome = path.join(tempHome, "dsh-home5");
    fs.mkdirSync(dshHome, { recursive: true });
    const workdir = path.join(tempHome, "work-dsh5");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, dshPolicyJson(dshHome), { workflowId, pendingSteps: 2 });
    installDshSeamFake({ journal: seamJournalDsh });
    process.env.TAMANDUA_HARNESS_PROBE = "1";

    await dispatchJob(runId, workdir, { workflowId, harnessType: "dsh" });
    assert.ok(!fs.existsSync(piLog), "host pi must never spawn (probe or work)");
    assert.equal(seamJournalDsh.length, 2);
    assert.equal(seamJournalDsh[0].kind, "probe");
    assert.equal(seamJournalDsh[1].kind, "work");
    assert.ok(
      seamJournalDsh[0].promptText.includes("TAMANDUA_HARNESS_PROBE: skill-path"),
      "guest dsh probe prompt carries the stable harness-probe marker",
    );
    assert.ok(
      seamJournalDsh[0].promptText.includes("/workspace/runtime/bin/tamandua skill-path"),
      "dsh probe asks for the PACKED guest skill path, never a host path",
    );
    const okEvents = eventsFor(runId).filter((e) => e.event === "run.harness_probe_ok");
    assert.equal(okEvents.length, 1);
    assert.equal(okEvents[0].harness, "dsh");

    await dispatchJob(runId, workdir, { workflowId, harnessType: "dsh" });
    assert.equal(seamJournalDsh.length, 3, "second round must not re-probe");
    assert.equal(seamJournalDsh[2].kind, "work");
    assert.equal(runRow(runId)?.status, "completed");
    assert.deepEqual(stepRows(runId).map((s) => s.status), ["done", "done"]);
  });

  it("dsh: a typed MatchlockRunnerError (protocol/infra failure) from the work seam force-fails the run (never native fallback, never an instant-fail loop)", async () => {
    const runId = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";
    const workflowId = "do-now";
    const dshHome = path.join(tempHome, "dsh-home6");
    fs.mkdirSync(dshHome, { recursive: true });
    const workdir = path.join(tempHome, "work-dsh6");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, dshPolicyJson(dshHome), { workflowId });
    setDshSchedulerRoundRunnerForTest(async (round) => {
      seamJournalDsh.push({ kind: round.kind, runId: round.identity.runId, agentId: round.identity.agentId, workflowId: round.identity.workflowId, jobId: round.identity.jobId, promptText: round.promptText, workdir: round.workingDirectoryForHarness });
      throw new MatchlockRunnerError(
        "matchlock_invocation_failed",
        "guest bridge handshake refused before work",
      );
    });

    await dispatchJob(runId, workdir, { workflowId, harnessType: "dsh" });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed");
    assert.ok(!fs.existsSync(piLog), "no host harness fallback after a dsh infra failure");
    const failed = eventsFor(runId).filter((e) => e.event === "run.force_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0].reason ?? failed[0].detail ?? ""), /Matchlock invocation failed/);
  });

  it("dsh: buildMatchlockDshWorkPrompt keeps the GUEST CLI with headless dsh wording; the pi/pi-default prompts are unchanged (differential)", () => {
    const runId = "7aeb4da9-1111-4222-8333-abcdefabcdef";
    const hostCli = resolveTamanduaCli();
    const nativePrompt = buildWorkPrompt("do-now", "do-now_doer", runId);
    const piGuestPrompt = buildMatchlockWorkPrompt("do-now", "do-now_doer", runId);
    const dshGuestPrompt = buildMatchlockDshWorkPrompt("do-now", "do-now_doer", runId);

    assert.ok(nativePrompt.includes("You run in --print mode."), "native prompt keeps its --print mode line");
    assert.ok(piGuestPrompt.includes("You run in --print mode."), "pi guest prompt keeps --print mode semantics");
    assert.ok(
      dshGuestPrompt.includes("You run in headless dsh mode with plain-text output."),
      "dsh guest prompt declares headless plain-text dsh output",
    );
    assert.ok(dshGuestPrompt.includes(`"${DSH_MATCHLOCK_GUEST_CLI}" step claim "do-now_doer" --run-id "${runId}"`));
    assert.ok(dshGuestPrompt.includes(`${DSH_MATCHLOCK_GUEST_CLI}" step complete "step-<uuid>"`));
    assert.ok(dshGuestPrompt.includes(`${DSH_MATCHLOCK_GUEST_CLI}" step fail "step-<uuid>"`));
    assert.ok(!dshGuestPrompt.includes(hostCli), "dsh guest prompt never embeds the host CLI");
    // pi/pi-default prompts are byte-identical to the base build (differential).
    const withoutCli = (p: string, cli: string): string => p.split(cli).join("{{CLI}}");
    assert.equal(
      withoutCli(piGuestPrompt, MATCHLOCK_GUEST_CLI),
      withoutCli(nativePrompt, hostCli),
    );
  });

  // ── MTLK-FIX US-003 (F4, tamandua-6sy.33.10.26): error surfacing ─────

  it("describeMatchlockError renders an RPC body's code, real message and stderr tail (never [object Object])", () => {
    const text = describeMatchlockError({
      code: -32000,
      message: "create: path must be shorter than SUN_LEN",
      stderrTail: "firecracker: Failed to create VM: socket path too long",
    });
    assert.match(text, /matchlock rpc error -32000:/);
    assert.match(text, /path must be shorter than SUN_LEN/);
    assert.match(text, /firecracker: Failed to create VM: socket path too long/);
    assert.ok(!text.includes("[object Object]"), "the raw RPC body must never stringify to [object Object]");

    // The snake_case runtime spelling is honoured too.
    const snake = describeMatchlockError({
      code: 7,
      message: "rpc refused",
      stderr_tail: "runtime stderr line",
    });
    assert.match(snake, /matchlock rpc error 7: rpc refused/);
    assert.match(snake, /runtime stderr line/);
  });

  it("describeMatchlockError bounds the appended stderr tail to MATCHLOCK_ERROR_TAIL_MAX_BYTES", () => {
    const hugeTail = "e".repeat(MATCHLOCK_ERROR_TAIL_MAX_BYTES * 5);
    const text = describeMatchlockError({ code: -32001, message: "boom", stderrTail: hugeTail });
    assert.match(text, /stderr tail:/);
    const tail = text.slice(text.indexOf("stderr tail: ") + "stderr tail: ".length);
    assert.ok(
      Buffer.byteLength(tail, "utf8") <= MATCHLOCK_ERROR_TAIL_MAX_BYTES,
      `bounded tail must not exceed ${MATCHLOCK_ERROR_TAIL_MAX_BYTES} bytes (got ${Buffer.byteLength(tail, "utf8")})`,
    );
    assert.match(tail, /\[truncated\]/);
  });

  it("describeMatchlockError falls back to bounded JSON for a non-RPC object and passes Errors/strings through", () => {
    const json = describeMatchlockError({ weird: "shape", nested: { depth: 1 } });
    assert.match(json, /"weird":"shape"/);
    assert.ok(!json.includes("[object Object]"));

    assert.equal(describeMatchlockError(new Error("plain failure")), "plain failure");
    assert.equal(describeMatchlockError("already a string"), "already a string");
  });

  it("classifyInvocationError surfaces a plain RPC body and preserves MatchlockRunnerError/MatchlockControllerError", () => {
    const classified = classifyInvocationError(
      {
        code: -32000,
        message: "path must be shorter than SUN_LEN",
        stderrTail: "firecracker: socket path too long",
      },
      "runMatchlockInvocation",
    );
    assert.equal(classified.code, "matchlock_invocation_failed");
    assert.match(classified.message, /runMatchlockInvocation: matchlock rpc error -32000: path must be shorter than SUN_LEN/);
    assert.match(classified.message, /firecracker: socket path too long/);
    assert.ok(!classified.message.includes("[object Object]"));

    const runnerErr = new MatchlockRunnerError("guest_bridge_unavailable", "no pack");
    assert.equal(classifyInvocationError(runnerErr, "any stage"), runnerErr, "a typed runner error passes through");

    const controllerErr = new MatchlockControllerError("controller_closed", "controller is closed");
    const mapped = classifyInvocationError(controllerErr, "cleanup");
    assert.equal(mapped.code, "controller_closed");
    assert.equal(mapped.message, "cleanup: controller is closed");

    // US-004: the pre-flight SUN_LEN refusal is a MatchlockControllerError and
    // must flow through the SAME structured-error path, keeping its code and
    // the actionable message (limit, length, HOME, remedy) visible.
    const socketErr = new MatchlockControllerError(
      MATCHLOCK_SOCKET_PATH_TOO_LONG_CODE,
      'matchlock cannot create a VM with HOME "/long": the longest unix socket path it produces is 129 bytes, over the Linux 107-byte sun_path limit',
    );
    const socketMapped = classifyInvocationError(socketErr, "runMatchlockInvocation");
    assert.equal(socketMapped.code, "matchlock_home_socket_path_too_long");
    assert.match(socketMapped.message, /107-byte sun_path limit/);
    assert.match(socketMapped.message, /129 bytes/);
    assert.ok(!socketMapped.message.includes("[object Object]"));
  });

  it("F4: a structured RPC failure thrown by the once-per-run in-VM probe surfaces code+message+tail on run.harness_probe_failed (no [object Object])", async () => {
    const runId = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";
    const workflowId = "do-now";
    const workdir = path.join(tempHome, "work-f4");
    fs.mkdirSync(workdir, { recursive: true });
    seedRun(runId, workdir, policyJson(), { workflowId });
    process.env.TAMANDUA_HARNESS_PROBE = "1";
    // The RPC client rejects with a PLAIN body object: the pre-fix
    // `String(err)` rendered it as [object Object] and hid the Firecracker
    // SUN_LEN message.
    const rpcBody = {
      code: -32000,
      message: "create: path must be shorter than SUN_LEN",
      stderrTail: "firecracker: Failed to create VM: socket path too long",
    };
    setMatchlockSchedulerRoundRunnerForTest(async () => {
      throw rpcBody;
    });

    await dispatchJob(runId, workdir, { workflowId });

    const row = runRow(runId);
    assert.ok(row);
    assert.equal(row.status, "failed", "the failed probe force-fails the run");
    assert.ok(!fs.existsSync(piLog), "no host harness spawn");
    const failed = eventsFor(runId).filter((e) => e.event === "run.harness_probe_failed");
    assert.equal(failed.length, 1);
    const surfaced = `${String(failed[0].detail)}\n${String(failed[0].stderrTail)}`;
    assert.match(surfaced, /matchlock rpc error -32000:/);
    assert.match(surfaced, /path must be shorter than SUN_LEN/);
    assert.match(surfaced, /firecracker: Failed to create VM: socket path too long/);
    assert.ok(!surfaced.includes("[object Object]"), "the surfaced probe evidence must never contain [object Object]");
  });
});
