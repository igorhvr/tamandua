/**
 * YSE US-006 proof gate — run #826 regression.
 *
 * Reproduces the run #826 timeline: a verify_each loop-over-stories run with
 * one FAILED story (verification retries exhausted: retry_count > max_retries)
 * and N remaining PENDING stories, resumed through the product resume path,
 * must re-queue the failed story as pending with a fresh retry budget and end
 * 'completed' — never terminal-failing again with "Loop has failed stories and
 * no pending stories".
 *
 * Harness shape (modeled on tests/resume-story-requeue.test.ts combined with
 * the in-process step-ops drive of src/installer tests):
 *  - temp HOME / state dir; the FULL product schema comes from dist/db.js
 *    getDb() (migrate() v8) so every code path sees production columns.
 *  - A stub control-plane HTTP server answers the resume path's
 *    /control/health, /control/register-run and /control/nudge calls. The
 *    REAL product resume — `tamandua workflow resume` → resumeWorkflow in
 *    dist/installer/run.js — therefore succeeds deterministically with NO
 *    daemon, NO scheduler motor and NO model spawns.
 *  - Worker rounds after the resume are driven in-process with
 *    claimStep/completeStep directly (no real pi agents); nudgeDispatch is
 *    best-effort fire-and-forget so the daemon-less DB drive is safe.
 *
 * Assertions:
 *  - AC1: the FAILED story is re-queued to pending with retry_count 0
 *         (resume_reset_count incremented), done stories stay done.
 *  - The first loop claim after resume picks the RESET story; no story is
 *    left in 'failed' once the loop is re-claimed (control assertion).
 *  - AC2: driving every story to done leaves the run row 'completed'.
 *  - AC3: the run event stream contains story.reset_for_resume and no
 *         terminal run.failed with "Loop has failed stories and no pending
 *         stories".
 *  - AC4: the CLI resume prints the re-queue confirmation with the count.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

function ts(): string {
  return new Date().toISOString();
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Minimal control-plane stub. The product resume path only needs 2xx answers
 * for health/register/nudge — it never touches a real daemon scheduler, so no
 * model process can ever be spawned by this test.
 */
function startControlStub(): { port: number; close: () => Promise<void>; requests: string[] } {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      requests.push(`${req.method} ${req.url ?? ""} ${body}`);
      if (req.url === "/control/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url === "/control/register-run") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "registered" }));
      } else if (req.url === "/control/nudge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stub: not found" }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
        requests,
      });
    });
  });
}

// ── The run #826 regression gate ────────────────────────────────────────

describe("YSE US-006 run #826 regression gate — resumed loop with a failed story completes", { concurrency: 1 }, () => {
  const th = createTempHome("tamandua-yse826-gate-");
  const savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const savedDbPath = process.env.TAMANDUA_DB_PATH;
  const savedHome = process.env.HOME;

  before(() => {
    process.env.HOME = th.homeDir;
    process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
    process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = savedStateDir;
    if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = savedDbPath;
  });

  it("resumes a failed loop run (1 FAILED + N PENDING stories) through the product resume path and drives to 'completed'", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    // Lazy imports: TAMANDUA_* env vars must be set before getDb's singleton
    // connection is created (dist modules).
    const { getDb } = await import("../dist/db.js");
    const stepOps = await import("../dist/installer/step-ops.js");
    const { getRunEvents } = await import("../dist/installer/events.js");

    const stub = await startControlStub();
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = ts();

    try {
      // ── Seed: a loop-over-stories run failed at the verification-retry
      //    exhaustion point (run #826 shape). plan/setup done; the implement
      //    loop step FAILED; verify waiting; several stories done, exactly one
      //    FAILED (retry_count 5 > max_retries 4), and N remaining PENDING.
      db.prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
         VALUES (?, 'feature-dev-merge', 'YSE #826 regression: loop with a failed story resumes to completion', 'failed', ?, 0, ?, ?)`,
      ).run(runId, JSON.stringify({
        task: "YSE #826 regression task",
        working_directory_for_harness: th.root,
        build_cmd: "echo build ok",
        test_cmd: "echo test ok",
      }), now, now);

      const stepSeed = (
        stepIndex: number, stepId: string, agentId: string, status: string,
        opts: { input?: string; expects?: string; type?: string; loopConfig?: string; output?: string } = {},
      ): string => {
        const id = crypto.randomUUID();
        const cols = ["id", "run_id", "step_id", "agent_id", "step_index", "input_template", "expects", "status", "retry_count", "max_retries", "type", "created_at", "updated_at"];
        const vals: Array<string | number> = [id, runId, stepId, agentId, stepIndex, opts.input ?? "", opts.expects ?? "", status, 0, 4, opts.type ?? "single", now, now];
        if (opts.loopConfig !== undefined) { cols.push("loop_config"); vals.push(opts.loopConfig); }
        if (opts.output !== undefined) { cols.push("output"); vals.push(opts.output); }
        db.prepare(`INSERT INTO steps (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
        return id;
      };

      stepSeed(0, "plan", "feature-dev-merge_planner", "done", { output: "STATUS: done" });
      stepSeed(1, "setup", "feature-dev-merge_setup", "done", { output: "STATUS: done" });
      const loopStepId = stepSeed(2, "implement", "feature-dev-merge_developer", "failed", {
        type: "loop",
        input: "Implement {{current_story_id}}: {{current_story_title}}",
        expects: "STATUS: done\nregex:^CHANGES:\\s*\\S+",
        loopConfig: JSON.stringify({
          over: "stories",
          completion: "all_done",
          fresh_session: true,
          verify_each: true,
          verify_step: "verify",
        }),
      });
      stepSeed(3, "verify", "feature-dev-merge_verifier", "waiting", {
        input: "Verify {{current_story_id}} for run {{run_id}}",
        expects: "regex:^STATUS:\\s*(done|retry)\\s*$",
      });

      const storySeed = (
        storyIndex: number, storyId: string, status: string,
        opts: { retry?: number; output?: string | null; reset?: number } = {},
      ): void => {
        db.prepare(
          `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, output, retry_count, max_retries, resume_reset_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'desc', '["AC"]', ?, ?, ?, 4, ?, ?, ?)`,
        ).run(crypto.randomUUID(), runId, storyIndex, storyId, `Story ${storyId}`, status, opts.output ?? null, opts.retry ?? 0, opts.reset ?? 0, now, now);
      };

      // Done stories (processed before the failure), one FAILED story at
      // story_index 3 (verification retries exhausted), three PENDING after it.
      storySeed(0, "US-001", "done", { output: "done output" });
      storySeed(1, "US-002", "done", { output: "done output" });
      storySeed(2, "US-003", "done", { output: "done output" });
      storySeed(3, "US-004", "failed", { retry: 5, output: "verification retries exhausted" });
      storySeed(4, "US-005", "pending");
      storySeed(5, "US-006", "pending");
      storySeed(6, "US-007", "pending");

      // ── AC4: resume through the product CLI path. The stub control plane
      //    lets resumeWorkflow (the exact product resume transitions) succeed.
      const resume = await runCli(
        ["workflow", "resume", runId.slice(0, 8)],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(stub.port) },
      );
      assert.equal(resume.exitCode, 0, `resume should exit 0, got ${resume.exitCode}, stderr: ${cleanStderr(resume.stderr)}`);
      assert.ok(resume.stdout.includes("Resumed run"), `expected "Resumed run" in stdout, got: ${resume.stdout}`);
      assert.ok(
        resume.stdout.includes("Reset 1 failed story to pending for resume."),
        `expected re-queue confirmation with count in stdout, got: ${resume.stdout}`,
      );

      const storyRow = (storyId: string) => db.prepare(
        "SELECT status, retry_count, output, resume_reset_count FROM stories WHERE run_id = ? AND story_id = ?",
      ).get(runId, storyId) as { status: string; retry_count: number; output: string | null; resume_reset_count: number };
      const runRow = () => db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };

      // ── AC1: the FAILED story is re-queued pending with a fresh budget;
      //    done and pending stories are untouched; the run is running and the
      //    loop step is claimable (pending).
      assert.equal(runRow().status, "running", "resume flips the failed run to running");
      const failedReset = storyRow("US-004");
      assert.equal(failedReset.status, "pending", "the failed story must be re-queued pending");
      assert.equal(failedReset.retry_count, 0, "re-queued story must get a fresh retry budget");
      assert.equal(failedReset.output, null, "stale failure text must be cleared");
      assert.equal(failedReset.resume_reset_count, 1, "resume_reset_count increments on the reset");
      for (const doneId of ["US-001", "US-002", "US-003"]) {
        const s = storyRow(doneId);
        assert.equal(s.status, "done", `${doneId} stays done`);
        assert.equal(s.resume_reset_count, 0, `${doneId} must not be counted as reset`);
      }
      for (const pendId of ["US-005", "US-006", "US-007"]) {
        const s = storyRow(pendId);
        assert.equal(s.status, "pending", `${pendId} stays pending`);
        assert.equal(s.resume_reset_count, 0, `${pendId} must not be counted as reset`);
      }
      const loopStepDb = db.prepare("SELECT status FROM steps WHERE id = ?").get(loopStepId) as { status: string };
      assert.equal(loopStepDb.status, "pending", "the failed loop step must be re-pended for the loop to pick up the reset story");

      // ── Drive worker rounds in-process until every story is done. The
      //    loop claim must pick the RESET story first (lowest pending index).
      const DEV = "feature-dev-merge_developer";
      const VER = "feature-dev-merge_verifier";

      const driveOneStory = (expectedStoryId: string): void => {
        const claim = stepOps.claimStep(DEV, runId);
        assert.ok(claim.found, `loop claim should find the loop step for ${expectedStoryId}`);
        assert.equal(claim.stepId, loopStepId, "the loop step is claimed");

        // Control assertion: once the loop is re-claimed after resume, no
        // story may remain in 'failed'.
        const failedNow = db.prepare(
          "SELECT story_id FROM stories WHERE run_id = ? AND status = 'failed'",
        ).all(runId) as Array<{ story_id: string }>;
        assert.equal(failedNow.length, 0, `no story may remain failed after the loop is re-claimed: ${JSON.stringify(failedNow)}`);

        const claimedStory = db.prepare(
          "SELECT s.story_id FROM steps st JOIN stories s ON s.id = st.current_story_id WHERE st.id = ?",
        ).get(claim.stepId) as { story_id: string } | undefined;
        assert.equal(claimedStory?.story_id, expectedStoryId, `loop must claim ${expectedStoryId}, got ${claimedStory?.story_id}`);

        const loopComplete = stepOps.completeStep(claim.stepId, `STATUS: done\nCHANGES: implemented ${expectedStoryId}`);
        assert.ok(
          loopComplete.status === "advanced" || loopComplete.status === "completed",
          `loop complete should advance, got: ${loopComplete.status}`,
        );

        const verifyClaim = stepOps.claimStep(VER, runId);
        assert.ok(verifyClaim.found, `verify claim should find the verify step for ${expectedStoryId}`);
        const verifyComplete = stepOps.completeStep(verifyClaim.stepId, `STATUS: done\nVERIFIED: verified ${expectedStoryId}`);
        assert.ok(
          verifyComplete.status === "advanced" || verifyComplete.status === "completed",
          `verify complete should advance, got: ${verifyComplete.status}`,
        );
      };

      driveOneStory("US-004"); // the re-queued story
      driveOneStory("US-005");
      driveOneStory("US-006");
      driveOneStory("US-007");

      // ── AC2: all stories done → run row 'completed'.
      assert.equal(runRow().status, "completed", "run must end completed after the resumed loop finishes");
      const remaining = db.prepare(
        "SELECT COUNT(*) AS cnt FROM stories WHERE run_id = ? AND status != 'done'",
      ).get(runId) as { cnt: number };
      assert.equal(remaining.cnt, 0, "every story must be done");
      for (const storyId of ["US-004", "US-005", "US-006", "US-007"]) {
        assert.equal(storyRow(storyId).status, "done", `${storyId} must be done`);
      }

      // ── AC3: event stream carries story.reset_for_resume; the run never
      //    terminal-fails with the exact #826 message.
      const events = getRunEvents(runId);
      const resetEvents = events.filter((e) => e.event === "story.reset_for_resume");
      assert.equal(resetEvents.length, 1, "exactly one story.reset_for_resume event");
      assert.equal(resetEvents[0].storyId, "US-004");
      assert.equal(resetEvents[0].priorFailures, 1, "first reset carries priorFailures 1");
      assert.equal(resetEvents[0].stepId, "implement", "reset event carries the loop step's step_id");
      const fatal = events.filter(
        (e) => e.event === "run.failed" && e.detail === "Loop has failed stories and no pending stories",
      );
      assert.equal(fatal.length, 0, "the run must never terminal-fail with the run #826 message");
      assert.ok(events.some((e) => e.event === "run.completed"), "event stream must end with run.completed");

      // The resume path genuinely used the control plane (health probe +
      // register-run).
      assert.ok(
        stub.requests.some((r) => r.startsWith("GET /control/health")),
        "resume should probe the control plane health endpoint",
      );
      assert.ok(
        stub.requests.some((r) => r.startsWith("POST /control/register-run")),
        "resume should register the run with the control plane",
      );
    } finally {
      await stub.close();
    }
  });
});
