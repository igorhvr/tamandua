import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getDb, closeDb } from "../../dist/db.js";
import { completeStep, claimStep } from "../../dist/installer/step-ops.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

// ── VSRP (US-001) verifier-verdict regressions ───────────────────────
// The verifier's STATUS is an independent single-line verdict control. These
// tests drive the BUILT product (dist) through completeStep on a real
// verify_each layout and assert that:
//   - the exact retained KHYG report (STATUS: retry followed by VERIFIED-OK:/
//     ISSUES (...) headings that pollute the generic multi-line parse) routes
//     as a story retry, never a silent story.verified;
//   - a standalone STATUS: done with the same unusual headings still verifies;
//   - missing / invalid / conflicting STATUS verdicts are bounded-rejected and
//     never approve a story (retries exhausted ⇒ run fails);
//   - ordinary multi-line report fields parse exactly as before.

// ── Sticky isolation env ─────────────────────────────────────────────
// completeStep on terminal/retry paths fires fire-and-forget continuations
// (scheduleRunCronTeardown → import() → removeRunCrons; emitEvent webhook
// continuation → getDb) that resolve DB paths AFTER the triggering test's
// afterEach has run. Keep HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH
// pointed at a module-scoped temp dir for the whole file: every afterEach
// restores to this sticky env (never the operator's), and the module after()
// drains pending setImmediates before restoring the originals
// (step-ops-verify-each-eligibility.test.ts pattern). The ambient control
// port is dropped too so controlRequest's early guard return fires instead
// of ever reaching a live daemon.
const stickyState = (() => {
  const root = tamanduaTempDir("tamandua-verdict-sticky-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, homeDir, stateDir, dbPath: path.join(stateDir, "tamandua.db") };
})();
const originalHome = process.env.HOME;
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const originalDbPath = process.env.TAMANDUA_DB_PATH;
const originalControlPort = process.env.TAMANDUA_CONTROL_PORT;

function restoreOrDelete(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function applyStickyEnv(): void {
  process.env.HOME = stickyState.homeDir;
  process.env.TAMANDUA_STATE_DIR = stickyState.stateDir;
  process.env.TAMANDUA_DB_PATH = stickyState.dbPath;
  // Drop the ambient control port (3339 when the suite runs inside a
  // tamandua run): with HOME temp but TAMANDUA_CONTROL_PORT still set,
  // controlRequest would resolve the daemon secret from the temp HOME, pass
  // the guard, and reach a live daemon on that port.
  delete process.env.TAMANDUA_CONTROL_PORT;
}

after(async () => {
  // Drain a few event-loop turns while the sticky temp env is still active:
  // the fire-and-forget continuations scheduled by the last test must
  // resolve their getDb/logger paths against the temp state, not the real
  // ~/.tamandua.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  restoreOrDelete("HOME", originalHome);
  restoreOrDelete("TAMANDUA_STATE_DIR", originalStateDir);
  restoreOrDelete("TAMANDUA_DB_PATH", originalDbPath);
  restoreOrDelete("TAMANDUA_CONTROL_PORT", originalControlPort);
  try {
    closeDb();
  } catch {
    // best-effort
  }
  try {
    fs.rmSync(stickyState.root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────
// The verify_each expects contract used by the bundled workflows
// (feature-dev-merge-worktree verify step): an anchored full-line STATUS
// alternation. Validation accepts it via the honest-verdict shortcut for
// non-done variants and via the regex itself for done/retry.
const VERIFY_EACH_EXPECTS = "regex:^STATUS:\\s*(done|retry)\\s*$";

// Exact retained KHYG verifier report (2026-09-06 02:25 UTC), verbatim from
// /home/igorhvr/idm/tamandua/torture-test/var/review-logs/
//   native-signal-probes.DHNQbp/verifier-verdict-VSxS3j/raw-output.txt
// (read-only evidence). First line 'STATUS: retry'; the hyphenated
// 'VERIFIED-OK:' and parenthesized 'ISSUES (...):' headings do not match
// parseOutputKeyValues' /^([A-Z_]+):\s*(.*)$/ key regex, so they pollute the
// pending STATUS value. A faithful verdict must STILL read this as retry.
const RETAINED_KHYG_REPORT = `STATUS: retry
VERIFIED-OK:
- Security: .gitignore exists; diff main...HEAD has no .env/*.key/*.pem/*.secret/credentials/node_modules; no credential-like literals in US-004 changed code (only the intentional KHYG-CANARY-SECRET test fixture).
- US-004 product/docs/tests exist at HEAD e70358e3 and mostly pass: harness-launch.ts expired-overall-budget guard in spawnUnprotected (every pre-release fallback route); docs/native-signal-isolation.md + README Security subsection with correct sandbox-exec (not Seatbelt) deprecation attribution and no "removal risk accepted" overclaim; AGENTS.md + tests/serial-files.txt entries; US-001 carries in landlock-helper.test.ts (stage=abi-below-minimum skip classification) and native-build.test.ts (host-independent safety assertions).
- Focused evidence on this Linux rollout host: signal-isolation-compat.test.ts 11/11 pass / 0 skip (real landlock backend usable); npx tsc -p tsconfig.json --noEmit exit 0. No TODOs/placeholders found in changed code.
ISSUES (per COORDINATOR US-004 VERIFIER NOTE 02:22 UTC in the run progress file — it lists these exact items as UNIMPLEMENTED at signed e70358e3 and directs the story retry; each confirmed missing at HEAD):
- signal-isolation-compat.test.ts runChildToCompletion (lines ~158-206): the 30s watchdog (lines 172-185) only group-SIGKILLs a still-live handle and never settles/rejects the promise itself, nor closes owned pipes. If the leader exited while a pipe is held (exitCode !== null), the watchdog does nothing and the promised bound does not exist -> a held pipe strands the test indefinitely. Coordinator: on the bound, settle/reject and close only owned pipes, keeping the still-live-handle kill guard.
- signal-isolation-compat.test.ts probeRealStartup unprotected-fallback branch (lines ~412-418): when the real launch settles as launched + mode=unprotected-fallback, the freshly launched fallback child (outcome.child) is never joined through the bounded collector before the branch returns a skip verdict or throws; the finally (lines ~420-423) then removes the fixture root and restores env while that owned child may still run. Coordinator: settle that owned child before classifying the reason and before fixture/state cleanup.
- signal-isolation-compat.test.ts Mac present-but-unusable classification (KNOWN_UNAVAILABLE_RE line ~371 + probeRealStartup): only regex classification of the fallback reason exists; the US-003-proven two-tier rule is missing (bounded trivial-profile normal nonzero => known host inability/skip; signal death or failure of the REAL profile after the trivial profile succeeds => red). As written, a regex match could blanket-skip an arbitrary real-profile failure and an unmatched present-but-unusable case would go red instead of skipping.
- landlock-helper.test.ts live-handle guards (coordinator 02:13 note): spawnProtected watchdog kill (lines ~120-130) and detectCapability ready===null branch kill (lines ~218-229) call process.kill(-child.pid, "SIGKILL") with no exitCode===null && signalCode===null guard, so a historical PID group can be signaled after the owned child already exited; the READY close check (lines ~146-149) resolves null only when child.exitCode !== null and does not recognize signalCode, so a signal death waits out the 15s timer instead of settling on close.
`;

const DEV_AGENT = "fdmw_developer";
const VERIFIER_AGENT = "fdmw_verifier";

// ── Seeding helpers ──────────────────────────────────────────────────
interface SeededIds {
  runId: string;
  loopStepId: string;
  verifyStepId: string;
  story1Id: string;
  story2Id: string;
}

function ts(): string {
  return new Date().toISOString();
}

/**
 * Seed a running feature-dev-merge-worktree verify_each layout in the
 * isolated DB: implement loop (index 3, parked running), its designated
 * verify step (index 4, running — the completing step), story US-001 done
 * (awaiting the verdict) and story US-002 pending (keeps the loop alive).
 * Returns the seeded ids for assertions.
 */
function seedVerifyEachRun(opts: {
  verifyExpects?: string;
  verifyRetryCount?: number;
  verifyMaxRetries?: number;
  story1RetryCount?: number;
  story2Present?: boolean;
} = {}): SeededIds {
  const db = getDb();
  const runId = crypto.randomUUID();
  const loopStepId = crypto.randomUUID();
  const verifyStepId = crypto.randomUUID();
  const story1Id = crypto.randomUUID();
  const story2Id = crypto.randomUUID();
  const now = ts();

  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge-worktree', 'VSRP verdict routing', 'running', ?, 0, ?, ?)",
  ).run(runId, JSON.stringify({ task: "VSRP verdict routing" }), now, now);

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 3, '{{task}}\\n{{verify_feedback}}\\n{{retry_feedback}}', '', 'running', 0, 4, 'loop', ?, ?, ?)`,
  ).run(
    loopStepId,
    runId,
    DEV_AGENT,
    JSON.stringify({ verify_each: true, verify_step: "verify", over: "stories" }),
    now,
    now,
  );

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, 'verify', ?, 4, 'Verify the developer work.\\n{{retry_feedback}}', ?, 'running', ?, ?, 'single', ?, ?)`,
  ).run(
    verifyStepId,
    runId,
    VERIFIER_AGENT,
    opts.verifyExpects ?? VERIFY_EACH_EXPECTS,
    opts.verifyRetryCount ?? 0,
    opts.verifyMaxRetries ?? 4,
    now,
    now,
  );

  db.prepare(
    "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'First story', 'desc', '[]', 'done', ?, 3, ?, ?)",
  ).run(story1Id, runId, opts.story1RetryCount ?? 0, now, now);

  if (opts.story2Present ?? true) {
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 1, 'US-002', 'Second story', 'desc', '[]', 'pending', 0, 3, ?, ?)",
    ).run(story2Id, runId, now, now);
  }

  return { runId, loopStepId, verifyStepId, story1Id, story2Id };
}

function stepRow(runId: string, stepIdCol: string, id: string): {
  status: string;
  retry_count: number;
  output: string | null;
} {
  const row = getDb()
    .prepare("SELECT status, retry_count, output FROM steps WHERE id = ?")
    .get(id) as { status: string; retry_count: number; output: string | null } | undefined;
  assert.ok(row, `step row ${stepIdCol} must exist`);
  return row;
}

function storyRow(runId: string, id: string): { status: string; retry_count: number } {
  const row = getDb()
    .prepare("SELECT status, retry_count FROM stories WHERE id = ?")
    .get(id) as { status: string; retry_count: number } | undefined;
  assert.ok(row, `story row ${id} must exist`);
  return row;
}

function runRow(runId: string): { status: string; context: string } {
  const row = getDb()
    .prepare("SELECT status, context FROM runs WHERE id = ?")
    .get(runId) as { status: string; context: string } | undefined;
  assert.ok(row, `run row ${runId} must exist`);
  return row;
}

describe("VSRP: verifier STATUS is a single-line verdict control in verify_each routing", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-verdict-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-verifier-verdict"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): terminal/retry completions fire fire-and-forget continuations
    // (scheduleRunCronTeardown → import() → removeRunCrons; emitEvent →
    // fireWebhook → getDb) that resolve DB paths after this hook; pointing
    // them at the real ~/.tamandua trips the test-isolation guard.
    applyStickyEnv();
    try {
      closeDb();
    } catch {
      // best-effort
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("exact retained KHYG report routes as retry, never approval", () => {
    it("STATUS: retry followed by VERIFIED-OK:/ISSUES (...) headings re-pends the story without story.verified", () => {
      const ids = seedVerifyEachRun({});
      const { runId, verifyStepId, loopStepId, story1Id, story2Id } = ids;

      const result = completeStep(verifyStepId, RETAINED_KHYG_REPORT);

      // The verdict is retry: completeStep reports advanced (the loop was
      // re-pended for the developer to re-implement), NOT a story approval.
      assert.equal(result.status, "advanced");

      const events = getRunEvents(runId);
      assert.equal(
        events.filter((e) => e.event === "story.verified").length,
        0,
        "the retry report must NEVER emit story.verified",
      );
      const retryEvents = events.filter((e) => e.event === "story.retry" && e.stepId === "verify");
      assert.equal(retryEvents.length, 1, "exactly one story.retry event is emitted");

      // Story US-001 re-pended with retry_count+1 within its budget.
      const story1 = storyRow(runId, story1Id);
      assert.equal(story1.status, "pending", "the rejected story is reset to pending");
      assert.equal(story1.retry_count, 1, "story retry_count increments by one");

      // US-002 (the NEXT story) is untouched — no next-story advance.
      const story2 = storyRow(runId, story2Id);
      assert.equal(story2.status, "pending", "the next story stays pending");
      assert.equal(story2.retry_count, 0, "the next story retry_count stays 0");

      // Loop re-pended; verify reset to waiting with the RAW report retained.
      const verify = stepRow(runId, "verify", verifyStepId);
      assert.equal(verify.status, "waiting");
      assert.equal(verify.retry_count, 0, "honest retry is not a step-level failure");
      assert.equal(verify.output, RETAINED_KHYG_REPORT, "verify step output retains the raw report");

      const loop = stepRow(runId, "implement", loopStepId);
      assert.equal(loop.status, "pending", "loop step is re-pended for the story retry");

      // Run context carries the full findings as verify_feedback (the
      // parenthesized ISSUES (...) heading is not a parseable ISSUES: key, so
      // the whole output — findings included — becomes the feedback).
      const run = runRow(runId);
      assert.equal(run.status, "running");
      const context = JSON.parse(run.context) as Record<string, string>;
      assert.ok(
        context.verify_feedback?.includes("landlock-helper.test.ts live-handle guards"),
        "verify_feedback retains the real findings text",
      );

      // A follow-up developer claim re-implements the RETRIED story (US-001),
      // not the next story (US-002): proves no next-story dispatch.
      const claim = claimStep(DEV_AGENT, runId);
      assert.equal(claim.found, true, "the developer claims the re-pended loop");
      assert.equal(claim.stepId, loopStepId);
      assert.equal(storyRow(runId, story1Id).status, "running", "the retried story is picked first");
      assert.equal(storyRow(runId, story2Id).status, "pending", "the next story is NOT dispatched");
    });

    it("verify_feedback from a parseable plain ISSUES: block is preserved on retry", () => {
      const ids = seedVerifyEachRun({});
      const { runId, verifyStepId } = ids;

      const output = "STATUS: retry\nISSUES:\n- Missing unit tests for the edge case handler.\n- Module not documented.";
      const result = completeStep(verifyStepId, output);
      assert.equal(result.status, "advanced");

      const run = runRow(runId);
      const context = JSON.parse(run.context) as Record<string, string>;
      assert.ok(
        context.verify_feedback?.includes("Missing unit tests for the edge case handler"),
        "verify_feedback retains the plain ISSUES: findings text",
      );
      const events = getRunEvents(runId);
      assert.equal(events.filter((e) => e.event === "story.verified").length, 0);
    });
  });

  describe("standalone STATUS: done with unusual following headings still verifies", () => {
    it("STATUS: done followed by VERIFIED-OK:/ISSUES (...) headings verifies the story and advances", () => {
      const ids = seedVerifyEachRun({});
      const { runId, verifyStepId, loopStepId, story1Id, story2Id } = ids;

      const doneOutput = [
        "STATUS: done",
        "VERIFIED-OK:",
        "- Security review passed.",
        "ISSUES (per COORDINATOR US-001 VERIFIER NOTE): none remaining",
        "- No open findings.",
        "VERIFIED: all acceptance criteria confirmed",
      ].join("\n");

      const result = completeStep(verifyStepId, doneOutput);
      assert.equal(result.status, "advanced");

      const events = getRunEvents(runId);
      assert.equal(
        events.filter((e) => e.event === "story.verified").length,
        1,
        "a clean done verdict verifies the story",
      );

      const story1 = storyRow(runId, story1Id);
      assert.equal(story1.status, "done", "verified story stays done");
      assert.equal(story1.retry_count, 0, "no story retry on a done verdict");
      assert.equal(storyRow(runId, story2Id).status, "pending", "next story remains pending");
      assert.equal(stepRow(runId, "verify", verifyStepId).status, "waiting");
      assert.equal(stepRow(runId, "implement", loopStepId).status, "pending");
      assert.equal(runRow(runId).status, "running");
    });
  });

  describe("missing / invalid / conflicting STATUS verdicts bounded-reject, never approve", () => {
    it("missing STATUS line is a bounded step retry (never approval)", () => {
      // expects '' → validation cannot catch the missing control; the
      // verify_each routing must reject through its own bounded handling.
      const ids = seedVerifyEachRun({ verifyExpects: "" });
      const { runId, verifyStepId, story1Id } = ids;

      const result = completeStep(
        verifyStepId,
        "VERIFIED-OK:\n- everything looks fine\nISSUES: no findings",
      );
      assert.equal(result.status, "retrying", "a missing verdict re-pends the verify step");

      const verify = stepRow(runId, "verify", verifyStepId);
      assert.equal(verify.status, "pending", "verify step is re-pended for retry");
      assert.equal(verify.retry_count, 1, "verify step retry_count increments");
      assert.ok(
        (verify.output ?? "").includes("missing verifier STATUS verdict"),
        "retry feedback names the missing verdict",
      );

      const story1 = storyRow(runId, story1Id);
      assert.equal(story1.status, "done", "story is NOT approved, reset, or advanced");
      assert.equal(story1.retry_count, 0);
      assert.equal(runRow(runId).status, "running", "run stays running within budget");
      const events = getRunEvents(runId);
      assert.equal(events.filter((e) => e.event === "story.verified").length, 0, "never story.verified");

      // The verifier can claim the re-pended step and receives the bounded
      // PREVIOUS ATTEMPT FEEDBACK in the rendered input.
      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, true, "the verifier reclaims the re-pended verify step");
      assert.equal(claim.stepId, verifyStepId);
      assert.ok(
        (claim.resolvedInput ?? "").includes("PREVIOUS ATTEMPT FEEDBACK"),
        "rendered input carries the bounded retry feedback",
      );
    });

    it("invalid STATUS variant is a bounded step retry (never approval)", () => {
      const ids = seedVerifyEachRun({ verifyExpects: "" });
      const { runId, verifyStepId, story1Id } = ids;

      const result = completeStep(verifyStepId, "STATUS: maybe\nISSUES: unclear");
      assert.equal(result.status, "retrying");

      const verify = stepRow(runId, "verify", verifyStepId);
      assert.equal(verify.status, "pending");
      assert.equal(verify.retry_count, 1);
      assert.ok(
        (verify.output ?? "").includes('invalid verifier STATUS verdict "maybe"'),
        "retry feedback names the invalid variant",
      );
      assert.equal(storyRow(runId, story1Id).status, "done", "story is never approved");
      assert.equal(runRow(runId).status, "running");
      const events = getRunEvents(runId);
      assert.equal(events.filter((e) => e.event === "story.verified").length, 0);
    });

    it("conflicting STATUS verdicts are a bounded step retry (never approval)", () => {
      // The real workflow expects regex ACCEPTS each line, so validation
      // passes; the routing layer must still reject the ambiguity.
      const ids = seedVerifyEachRun({});
      const { runId, verifyStepId, story1Id } = ids;

      const result = completeStep(verifyStepId, "STATUS: done\nMore detail follows.\nSTATUS: retry\nISSUES: real findings");
      assert.equal(result.status, "retrying", "conflicting verdicts re-pend the verify step");

      const verify = stepRow(runId, "verify", verifyStepId);
      assert.equal(verify.status, "pending");
      assert.equal(verify.retry_count, 1);
      assert.ok(
        (verify.output ?? "").includes("conflicting verifier STATUS verdicts"),
        "retry feedback names the conflict",
      );
      assert.equal(storyRow(runId, story1Id).status, "done", "story is never approved");
      assert.equal(runRow(runId).status, "running");
      const events = getRunEvents(runId);
      assert.equal(events.filter((e) => e.event === "story.verified").length, 0);
    });

    it("exhausted verdict retries fail the run — still never story.verified", () => {
      const ids = seedVerifyEachRun({ verifyExpects: "", verifyRetryCount: 1, verifyMaxRetries: 1 });
      const { runId, verifyStepId, story1Id } = ids;

      const result = completeStep(verifyStepId, "STATUS: maybe\nISSUES: unclear");
      assert.equal(result.status, "failed", "retries exhausted ⇒ the run fails");

      const verify = stepRow(runId, "verify", verifyStepId);
      assert.equal(verify.status, "failed");
      assert.equal(verify.retry_count, 2);
      assert.equal(storyRow(runId, story1Id).status, "done", "the story was never verified/advanced");
      assert.equal(runRow(runId).status, "failed", "the run is failed, not silently advanced");
      const events = getRunEvents(runId);
      assert.equal(events.filter((e) => e.event === "story.verified").length, 0);
      assert.ok(events.some((e) => e.event === "step.failed"));
      assert.ok(events.some((e) => e.event === "run.failed"));
    });

    it("missing STATUS with the real workflow expects is bounded-rejected by the validation gate", () => {
      // Realistic gate: the bundled verify expects requires a STATUS line, so
      // a missing verdict is caught before routing — same bounded outcome.
      const ids = seedVerifyEachRun({});
      const { runId, verifyStepId, story1Id } = ids;

      const result = completeStep(verifyStepId, "VERIFIED: all good\nISSUES: none");
      assert.equal(result.status, "retrying", "validation re-pends with feedback");

      const verify = stepRow(runId, "verify", verifyStepId);
      assert.equal(verify.status, "pending");
      assert.equal(verify.retry_count, 1);
      assert.equal(storyRow(runId, story1Id).status, "done", "story is never approved");
      assert.equal(runRow(runId).status, "running");
      const events = getRunEvents(runId);
      assert.equal(events.filter((e) => e.event === "story.verified").length, 0);
    });
  });

  describe("ordinary multi-line report fields and plain verdicts are unchanged", () => {
    it("control: plain STATUS: retry + ISSUES: still resets the story and keeps context keys", () => {
      const ids = seedVerifyEachRun({});
      const { runId, verifyStepId, story1Id, story2Id } = ids;

      const output = "STATUS: retry\nISSUES: needs work\nTESTS: none";
      const result = completeStep(verifyStepId, output);
      assert.equal(result.status, "advanced");

      assert.equal(storyRow(runId, story1Id).status, "pending");
      assert.equal(storyRow(runId, story1Id).retry_count, 1);
      assert.equal(storyRow(runId, story2Id).status, "pending");
      assert.equal(stepRow(runId, "verify", verifyStepId).status, "waiting");

      const context = JSON.parse(runRow(runId).context) as Record<string, string>;
      assert.equal(context.verify_feedback, "needs work", "ISSUES: content lands as verify_feedback");
      assert.equal(context.tests, "none", "ordinary multi-line report fields are preserved");
    });

    it("control: plain STATUS: done advances and clears verify_feedback", () => {
      const ids = seedVerifyEachRun({});
      const { runId, verifyStepId, story1Id } = ids;

      const output = "STATUS: done\nVERIFIED: all tests pass\nTESTS: 5 tests";
      const result = completeStep(verifyStepId, output);
      assert.equal(result.status, "advanced");

      assert.equal(storyRow(runId, story1Id).status, "done", "verified story stays done");
      const events = getRunEvents(runId);
      assert.equal(events.filter((e) => e.event === "story.verified").length, 1);

      const context = JSON.parse(runRow(runId).context) as Record<string, string>;
      assert.ok(!("verify_feedback" in context), "verify_feedback is cleared on approval");
      assert.equal(context.verified, "all tests pass", "ordinary report fields still merge");
      assert.equal(context.tests, "5 tests");
    });
  });
});
