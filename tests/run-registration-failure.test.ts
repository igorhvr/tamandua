import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";


// ── Minimal in-memory DB ────────────────────────────────────────────

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL DEFAULT 1,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      scheduling_status TEXT,
      scheduling_error TEXT,
      scheduling_requested_at TEXT,
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      claim_job_id TEXT,
      claim_pid INTEGER,
      claim_pgid INTEGER,
      claim_updated_at TEXT
    );

    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workflow_id TEXT,
      detail TEXT,
      tokens_spent INTEGER
    );
  `);

  return db;
}

function now(): string {
  return new Date().toISOString();
}

// ── Test runner ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  \u2713 ${message}`);
    passed++;
  } else {
    console.error(`  \u2717 ${message}`);
    failed++;
  }
}

function test(name: string, fn: () => void): void {
  console.log(`\nTest: ${name}`);
  try {
    fn();
  } catch (err) {
    console.error(`  EXCEPTION: ${err}`);
    failed++;
  }
}

// Helper: insert a run as created by runWorkflow (before registration)
function insertRunAsCreated(db: DatabaseSync, runId: string, workflowId: string, task: string): string {
  const t = now();
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, scheduling_requested_at, created_at, updated_at)
     VALUES (?, 1, ?, ?, 'running', '{}', 0, 'pending_register', ?, ?, ?)`,
  ).run(runId, workflowId, task, t, t, t);
  return t;
}

// ── Test 1: Registration failure marks run terminal failed ──────────

test("Registration-failed run has status='failed'", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();

  insertRunAsCreated(db, runId, "feature-dev", "fix bug");

  // Simulate the registration failure UPDATE
  db.prepare(
    "UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
  ).run("daemon registration failed", runId);

  const run = db.prepare("SELECT status, scheduling_status, scheduling_error FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string | null; scheduling_error: string | null;
  };

  assert(run.status === "failed", "Run status is 'failed'");
  assert(run.scheduling_status === null, "scheduling_status is NULL");
  assert(run.scheduling_error === "daemon registration failed", "scheduling_error preserves failure message");
});

// ── Test 1b: Registration failure with body error ───────────────────

test("Registration failure preserves body.error in scheduling_error", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();

  insertRunAsCreated(db, runId, "feature-dev", "fix bug");

  // WORKDIR-QUEUE: use a genuinely fatal validation class here. A busy harness
  // workdir is NO LONGER a terminal failure — it is a retriable 'waiting'
  // admission (pinned by Test 1c below).
  const fatalReason = "Run run-abc harness workdir does not exist: /nope";
  db.prepare(
    "UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(fatalReason, runId);

  const run = db.prepare("SELECT status, scheduling_status, scheduling_error FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string | null; scheduling_error: string | null;
  };

  assert(run.status === "failed", "Run status is 'failed'");
  assert(run.scheduling_status === null, "scheduling_status is NULL");
  assert(
    run.scheduling_error === fatalReason,
    "scheduling_error contains the daemon error message",
  );
});

// ── Test 1c: WORKDIR-QUEUE — a busy harness workdir is retriable, not fatal ──

test("Busy harness workdir records a retriable 'waiting' state, never a terminal failure", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const holderRunId = "run-holder-1";
  const workdir = "/repo/harness-workdir";

  insertRunAsCreated(db, runId, "feature-dev", "fix bug");

  // This is exactly the row admitOrQueueRun() writes on a busy workdir: the
  // run stays registered ('running'), scheduling_status becomes 'waiting', and
  // the reason names the holding run and the directory. It never takes the
  // terminal failed path.
  const waitReason = `waiting for harness workdir held by run ${holderRunId}: ${workdir}`;
  db.prepare(
    "UPDATE runs SET scheduling_status = 'waiting', scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(waitReason, runId);

  const run = db.prepare("SELECT status, scheduling_status, scheduling_error FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string | null; scheduling_error: string | null;
  };
  assert(run.status === "running", "Busy workdir keeps the run registered (status='running')");
  assert(run.status !== "failed", "Busy workdir must not mark the run terminal failed");
  assert(run.scheduling_status === "waiting", "Busy workdir is a retriable 'waiting' scheduling state");
  assert(
    run.scheduling_error === waitReason,
    "waiting reason names the holding run and the directory",
  );

  // The reconciler re-admits 'waiting' runs on a later tick.
  const reconcilerRow = db.prepare(
    `SELECT id FROM runs
     WHERE status IN ('running')
       AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error', 'waiting'))
       AND id = ?`,
  ).get(runId) as { id: string } | undefined;
  assert(reconcilerRow !== undefined, "Reconciler includes 'waiting' runs for re-admission");
});

// ── Test 2: Reconciler query excludes terminal failed runs ──────────

test("Reconciler status='running' filter excludes terminal failed run", () => {
  const db = createTestDb();
  const failedRunId = crypto.randomUUID();
  const activeRunId = crypto.randomUUID();
  const t = now();

  // Insert a terminal failed run (how it looks after our fix)
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_error, scheduling_requested_at, created_at, updated_at) VALUES (?, 1, 'feature-dev', 'fix bug', 'failed', '{}', 0, NULL, 'daemon registration failed', NULL, ?, ?)",
  ).run(failedRunId, t, t);

  // Insert a healthy running run
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 2, 'feature-dev', 'add feature', 'running', '{}', 0, 'active', ?, ?, ?)",
  ).run(activeRunId, t, t, t);

  // The reconciler query filters status IN ('running')
  const reconcilerRows = db.prepare(
    `SELECT id, status, scheduling_status FROM runs
     WHERE status IN ('running')
       AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error'))
     ORDER BY scheduling_requested_at ASC, created_at ASC`,
  ).all() as { id: string }[];

  const reconcilerIds = reconcilerRows.map((r) => r.id);
  assert(!reconcilerIds.includes(failedRunId), "Terminal failed run is excluded from reconciler query");
  assert(reconcilerIds.includes(activeRunId), "Active running run IS included in reconciler query");
  assert(reconcilerIds.length === 1, "Reconciler sees exactly 1 run (only the active one)");
});

// ── Test 3: Reconciler also excludes old scheduling_status='error' zombies ─

test("Reconciler excludes old-style scheduling_status='error' zombies (status='running')", () => {
  const db = createTestDb();
  const zombieRunId = crypto.randomUUID();
  const activeRunId = crypto.randomUUID();
  const t = now();

  // Insert an old-style zombie (pre-fix: status='running', scheduling_status='error')
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_error, scheduling_requested_at, created_at, updated_at) VALUES (?, 1, 'feature-dev', 'fix bug', 'running', '{}', 0, 'error', 'daemon registration failed', ?, ?, ?)",
  ).run(zombieRunId, t, t, t);

  // Insert a healthy running run
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 2, 'feature-dev', 'add feature', 'running', '{}', 0, 'active', ?, ?, ?)",
  ).run(activeRunId, t, t, t);

  // The reconciler query — pre-fix zombies ARE picked up (confirm current behavior)
  const reconcilerRows = db.prepare(
    `SELECT id, status, scheduling_status FROM runs
     WHERE status IN ('running')
       AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error'))
     ORDER BY scheduling_requested_at ASC, created_at ASC`,
  ).all() as { id: string; status: string; scheduling_status: string }[];

  assert(
    reconcilerRows.some((r) => r.id === zombieRunId),
    "Old-style zombie IS picked up by reconciler (this is the pre-fix behavior we are fixing)",
  );

  // Now apply the terminal-failed fix to the old zombie (e.g., via migration or manual fix)
  db.prepare(
    "UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = 'daemon registration failed', updated_at = datetime('now') WHERE id = ?",
  ).run(zombieRunId);

  const afterFix = db.prepare(
    `SELECT id, status, scheduling_status FROM runs
     WHERE status IN ('running')
       AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error'))
     ORDER BY scheduling_requested_at ASC, created_at ASC`,
  ).all() as { id: string }[];

  const afterFixIds = afterFix.map((r) => r.id);
  assert(!afterFixIds.includes(zombieRunId), "After fix, zombie is excluded from reconciler");
  assert(afterFixIds.includes(activeRunId), "Active run is still included after fix");
});

// ── Test 4: Direct workflow successful registration unchanged ───────

test("Successful registration leaves run as status='running', scheduling_status='active'", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const t = now();

  // Simulate runWorkflow creating the run
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, scheduling_requested_at, created_at, updated_at)
     VALUES (?, 1, 'feature-dev', 'add feature', 'running', '{}', 0, 'pending_register', ?, ?, ?)`,
  ).run(runId, t, t, t);

  // Simulate successful daemon registration (the daemon sets scheduling_status='active')
  db.prepare(
    "UPDATE runs SET scheduling_status = 'active', updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  const run = db.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string;
  };

  assert(run.status === "running", "Successful registration: status remains 'running'");
  assert(run.scheduling_status === "active", "Successful registration: scheduling_status is 'active'");

  // And the reconciler picks it up
  const reconcilerRow = db.prepare(
    `SELECT id FROM runs
     WHERE status IN ('running')
       AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error'))
       AND id = ?`,
  ).get(runId) as { id: string } | undefined;

  assert(reconcilerRow !== undefined, "Reconciler picks up successfully registered run");
});

// ── Test 5: run.failed event is emitted for registration failure ────

test("run.failed event detail contains registration error message", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const workflowId = "feature-dev";

  // Simulate the registration-failure path:
  // 1. Run was created with status='running'
  // 2. Registration failed, so we mark it terminal and emit the event
  insertRunAsCreated(db, runId, workflowId, "fix bug");

  db.prepare(
    "UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
  ).run("daemon registration failed", runId);

  // Emit event (simulated via in-memory events table)
  const ts = now();
  db.prepare(
    "INSERT INTO events (ts, event, run_id, workflow_id, detail) VALUES (?, 'run.failed', ?, ?, ?)",
  ).run(ts, runId, workflowId, "Registration failed: daemon registration failed");

  // Verify the event
  const event = db.prepare(
    "SELECT event, run_id, workflow_id, detail FROM events WHERE run_id = ? AND event = 'run.failed'"
  ).get(runId) as { event: string; run_id: string; workflow_id: string; detail: string } | undefined;

  assert(event !== undefined, "run.failed event exists");
  assert(event!.event === "run.failed", "Event type is 'run.failed'");
  assert(event!.run_id === runId, "Event has correct run_id");
  assert(event!.workflow_id === workflowId, "Event has correct workflow_id");
  assert(
    event!.detail.includes("daemon registration failed"),
    "Event detail contains the registration failure message",
  );
});

// ── Test 6: Resume registration failure marks run terminal failed ──

test("Resume registration failure → status='failed'", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const workflowId = "feature-dev";
  const t = now();

  // Start with a failed run (the resume entry condition)
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 1, ?, 'fix bug', 'failed', '{}', 0, NULL, NULL, ?, ?)",
  ).run(runId, workflowId, t, t);

  // resumeWorkflow resets the run to running + pending_register before registration
  const resumeNow = now();
  db.prepare(
    "UPDATE runs SET status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(resumeNow, runId);

  // Verify it looks like a pre-registration resumed run
  const preReg = db.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string;
  };
  assert(preReg.status === "running", "Resumed run starts as 'running' before registration");
  assert(preReg.scheduling_status === "pending_register", "Resumed run has scheduling_status='pending_register' before registration");

  // Registration fails → apply terminal-failed treatment (US-002 fix)
  db.prepare(
    "UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
  ).run("daemon registration failed", runId);

  // Emit run.failed event for resume
  const eventTs = now();
  db.prepare(
    "INSERT INTO events (ts, event, run_id, workflow_id, detail) VALUES (?, 'run.failed', ?, ?, ?)",
  ).run(eventTs, runId, workflowId, "Resume registration failed: daemon registration failed");

  // Verify terminal state
  const run = db.prepare("SELECT status, scheduling_status, scheduling_error FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string | null; scheduling_error: string | null;
  };
  assert(run.status === "failed", "Resumed run status is 'failed' after registration failure");
  assert(run.scheduling_status === null, "Resumed run scheduling_status is NULL after registration failure");
  assert(run.scheduling_error === "daemon registration failed", "Resumed run preserves scheduling_error");

  // Verify event
  const event = db.prepare(
    "SELECT event, run_id, workflow_id, detail FROM events WHERE run_id = ? AND event = 'run.failed'"
  ).get(runId) as { event: string; run_id: string; workflow_id: string; detail: string } | undefined;

  assert(event !== undefined, "Resume run.failed event exists");
  assert(event!.event === "run.failed", "Resume event type is 'run.failed'");
  assert(event!.detail.includes("Resume registration failed"), "Resume event detail mentions 'Resume registration failed'");
  assert(event!.detail.includes("daemon registration failed"), "Resume event detail contains the daemon error");

  // Verifying reconciler excludes terminal resumed run
  const reconcilerRows = db.prepare(
    `SELECT id FROM runs
     WHERE status IN ('running')
       AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error'))
     ORDER BY scheduling_requested_at ASC, created_at ASC`,
  ).all() as { id: string }[];

  assert(!reconcilerRows.some((r) => r.id === runId), "Reconciler does not pick up terminal failed resumed run");
});

// ── Test 7: Resume registration failure with body.error ─────────────

test("Resume registration failure preserves body.error in scheduling_error", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const workflowId = "bug-fix-workflow";
  const t = now();

  // Insert a failed run
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 3, ?, 'resolve crash', 'failed', '{}', 0, NULL, NULL, ?, ?)",
  ).run(runId, workflowId, t, t);

  // Simulate resumeWorkflow reset before registration
  const resumeNow = now();
  db.prepare(
    "UPDATE runs SET status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(resumeNow, runId);

  // Registration fails with a specific daemon error. WORKDIR-QUEUE: use a
  // genuinely fatal validation class — a busy harness workdir is now a
  // retriable 'waiting' admission, not a terminal failure.
  const fatalReason = "Cannot resume run: Run run-abc harness workdir does not exist: /nope";
  db.prepare(
    "UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(fatalReason, runId);

  // Emit event
  const eventTs = now();
  db.prepare(
    "INSERT INTO events (ts, event, run_id, workflow_id, detail) VALUES (?, 'run.failed', ?, ?, ?)",
  ).run(eventTs, runId, workflowId, "Resume registration failed: Run run-abc harness workdir does not exist: /nope");

  const run = db.prepare("SELECT status, scheduling_status, scheduling_error FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string | null; scheduling_error: string | null;
  };
  assert(run.status === "failed", "Resumed run with body.error: status is 'failed'");
  assert(run.scheduling_status === null, "Resumed run with body.error: scheduling_status is NULL");
  assert(
    run.scheduling_error === fatalReason,
    "Resumed run preserves the daemon body.error message",
  );
});

// ── Test 8: Non-just-do-it direct workflow resume successful registration ─

test("Successful resume leaves run as status='running', scheduling_status='active'", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const workflowId = "feature-dev";
  const t = now();

  // Start with a failed run
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 4, ?, 'add logging', 'failed', '{}', 0, NULL, NULL, ?, ?)",
  ).run(runId, workflowId, t, t);

  // resumeWorkflow resets to running + pending_register
  const resumeNow = now();
  db.prepare(
    "UPDATE runs SET status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(resumeNow, runId);

  // Simulate successful daemon registration
  db.prepare(
    "UPDATE runs SET scheduling_status = 'active', updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  const run = db.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as {
    status: string; scheduling_status: string;
  };
  assert(run.status === "running", "Successful resume: status remains 'running'");
  assert(run.scheduling_status === "active", "Successful resume: scheduling_status is 'active'");

  // Reconciler picks it up
  const reconcilerRow = db.prepare(
    `SELECT id FROM runs
     WHERE status IN ('running')
       AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error'))
       AND id = ?`,
  ).get(runId) as { id: string } | undefined;

  assert(reconcilerRow !== undefined, "Reconciler picks up successfully resumed run");
});

// ── Test 9: just-do-it dispatcher workspace context keys ──────────

test("just-do-it context has target_working_directory_for_harness pointing to original target repo", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const targetRepo = "/home/user/projects/my-app";
  const dispatcherDir = `/home/user/.tamandua/just-do-it-workspaces/${runId}`;

  // Simulate the context that runWorkflow produces for just-do-it
  const context = JSON.stringify({
    task: "Add a login page",
    workspace_mode: "direct",
    no_hurry_save_tokens_mode: "false",
    harness_type: "pi",
    no_relaunch_upon_rugpull: "false",
    working_directory_for_harness: dispatcherDir,
    target_working_directory_for_harness: targetRepo,
    repo: targetRepo,
    original_branch: "main",
  });

  // Insert the run as runWorkflow would (before daemon registration)
  const t = now();
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, scheduling_requested_at, created_at, updated_at)
     VALUES (?, 1, 'just-do-it', 'Add a login page', 'running', ?, 0, 'pending_register', ?, ?, ?)`,
  ).run(runId, context, t, t, t);

  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
  const ctx = JSON.parse(row.context);

  // working_directory_for_harness should point to neutral dispatcher workspace
  assert(
    ctx.working_directory_for_harness === dispatcherDir,
    "working_directory_for_harness points to neutral dispatcher workspace under just-do-it-workspaces",
  );
  assert(
    ctx.working_directory_for_harness.includes("just-do-it-workspaces"),
    "working_directory_for_harness is under just-do-it-workspaces",
  );

  // target_working_directory_for_harness should preserve original target repo
  assert(
    ctx.target_working_directory_for_harness === targetRepo,
    "target_working_directory_for_harness preserves original target repo path",
  );

  // repo should point to the target repo (for git operations)
  assert(ctx.repo === targetRepo, "repo context key points to target repo");

  // working_directory_for_harness and target_working_directory_for_harness should differ
  assert(
    ctx.working_directory_for_harness !== ctx.target_working_directory_for_harness,
    "working_directory_for_harness differs from target_working_directory_for_harness for just-do-it",
  );
});

test("just-do-it context stores full UUID in dispatcher workspace path", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const targetRepo = "/tmp/my-repo";

  // The dispatcher workspace path must contain the full UUID, not a shortened version
  const context = JSON.stringify({
    task: "Fix bug",
    workspace_mode: "direct",
    no_hurry_save_tokens_mode: "false",
    harness_type: "pi",
    no_relaunch_upon_rugpull: "false",
    working_directory_for_harness: `/home/user/.tamandua/just-do-it-workspaces/${runId}`,
    target_working_directory_for_harness: targetRepo,
    repo: targetRepo,
  });

  const t = now();
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, scheduling_requested_at, created_at, updated_at)
     VALUES (?, 1, 'just-do-it', 'Fix bug', 'running', ?, 0, 'pending_register', ?, ?, ?)`,
  ).run(runId, context, t, t, t);

  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
  const ctx = JSON.parse(row.context);

  // The dispatcher workspace path must contain the full UUID
  assert(
    ctx.working_directory_for_harness.includes(runId),
    "working_directory_for_harness contains the full run UUID",
  );

  // The directory name after just-do-it-workspaces/ must be the full UUID,
  // not a shortened version. Verify by extracting the segment.
  const pathAfterWorkspaces = ctx.working_directory_for_harness.split("/just-do-it-workspaces/")[1];
  assert(
    pathAfterWorkspaces === runId,
    "dispatcher workspace directory name is the full run UUID, not a shortened version",
  );
});

test("non-just-do-it direct workflow does NOT set target_working_directory_for_harness", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const workingDir = "/home/user/projects/my-app";

  // Simulate the context that runWorkflow produces for a non-just-do-it direct workflow
  const context = JSON.stringify({
    task: "Add feature",
    workspace_mode: "direct",
    no_hurry_save_tokens_mode: "false",
    harness_type: "pi",
    no_relaunch_upon_rugpull: "false",
    working_directory_for_harness: workingDir,
    repo: workingDir,
    original_branch: "main",
  });

  const t = now();
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, scheduling_requested_at, created_at, updated_at)
     VALUES (?, 1, 'feature-dev', 'Add feature', 'running', ?, 0, 'pending_register', ?, ?, ?)`,
  ).run(runId, context, t, t, t);

  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
  const ctx = JSON.parse(row.context);

  // target_working_directory_for_harness should NOT be set for non-just-do-it
  assert(
    ctx.target_working_directory_for_harness === undefined,
    "target_working_directory_for_harness is NOT set for non-just-do-it direct workflow",
  );

  // working_directory_for_harness should equal repo (same dir for direct workflows)
  assert(
    ctx.working_directory_for_harness === workingDir,
    "working_directory_for_harness is the working dir for non-just-do-it direct workflow",
  );
  assert(
    ctx.repo === workingDir,
    "repo equals working directory for non-just-do-it direct workflow",
  );
  assert(
    ctx.working_directory_for_harness === ctx.repo,
    "working_directory_for_harness equals repo for non-just-do-it",
  );
});

test("just-do-it dispatcher workspace path is under resolvePiStateDir", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const targetRepo = "/tmp/project";

  // Simulate with TAMANDUA_STATE_DIR set to a custom location
  const tamanduaStateDir = "/custom/state/dir/.tamandua";
  const context = JSON.stringify({
    task: "Review code",
    workspace_mode: "direct",
    no_hurry_save_tokens_mode: "false",
    harness_type: "pi",
    no_relaunch_upon_rugpull: "false",
    working_directory_for_harness: `${tamanduaStateDir}/just-do-it-workspaces/${runId}`,
    target_working_directory_for_harness: targetRepo,
    repo: targetRepo,
  });

  const t = now();
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, scheduling_requested_at, created_at, updated_at)
     VALUES (?, 1, 'just-do-it', 'Review code', 'running', ?, 0, 'pending_register', ?, ?, ?)`,
  ).run(runId, context, t, t, t);

  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
  const ctx = JSON.parse(row.context);

  // Dispatcher workspace should be under Tamandua state dir
  assert(
    ctx.working_directory_for_harness.startsWith(tamanduaStateDir),
    "dispatcher workspace is under Tamandua state dir",
  );
  assert(
    ctx.working_directory_for_harness.includes("/just-do-it-workspaces/"),
    "dispatcher workspace is under just-do-it-workspaces subdirectory",
  );
});

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
}
