import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertStatePathIsolation } from "./lib/test-guard.js";
import { nowIso } from "./lib/instant.js";
import { LEDGER_RETENTION_MS } from "./suite/config.js";

// Any change to migrate() MUST bump SCHEMA_VERSION. Missing a bump causes broken DBs.
// v4: WLST5 (5873a9a9) added the guarded ceiling_expiry_count ALTER below but
// failed to bump v3 → every existing DB (user_version === 3) early-returned and
// skipped the migration. The MIGV upgrade-path test pins that this class of
// bug (new column never appearing on pre-existing DBs) is caught going forward.
// v5: TATR US-001 added the nullable runs.parent_run_id column (parent/child
// run linkage for graph consumers).
// v6: RSPN instant-fail added the guarded runs.instant_fail_count column
// (consecutive sub-threshold zero-output nonzero-exit worker rounds). The
// bump is REQUIRED (see the WLST5.1 note below): adding the guarded ALTER
// without bumping leaves existing DBs (user_version === 5) skipping it and
// crashing with "no such column: instant_fail_count".
// v7: WAVE-A US-001 added the conditional-review / TEST_CMD contract columns:
// steps.conditional_condition (activation flag key declared in workflow.yml),
// steps.auto_completed + steps.auto_complete_reason (marker distinguishing
// condition-unset auto-completions from agent-reviewed runs), and
// runs.test_cmd_established + runs.test_cmd_source (the current TEST_CMD
// contract and its origin: 'launch' or a step id).
// v8: YSE US-001 added the guarded stories.resume_reset_count column (how many
// times a workflow resume has re-queued a FAILED loop story back to pending —
// distinguishes reset-on-resume stories from plain pending ones). The bump is
// REQUIRED (see the WLST5.1 note below): adding the guarded ALTER without
// bumping leaves existing DBs (user_version === 7) early-returning and
// skipping the migration, so status SELECTs crash with "no such column".
// v9: IFLB US-001 added the guarded runs.harness_probe_status + harness_probe_at
// columns (launch-time harness probe result persistence). The bump is REQUIRED
// (see the WLST5.1 note below): adding the guarded ALTERs without bumping
// leaves existing DBs (user_version === 8) early-returning and skipping the
// migration, so the dispatch motor's probe status reads crash with
// "no such column: harness_probe_status".
// v10: TIME-STORAGE US-002 normalized every stored instant to the ONE format
// (ISO-8601 UTC with milliseconds and Z). Before this, JS writers wrote
// `YYYY-MM-DDTHH:MM:SS.sssZ` while SQL writers wrote naive UTC
// `YYYY-MM-DD HH:MM:SS`; readers interpreted the naive form as host-local
// time. migrateInstantsToIsoZ() rewrites the legacy naive values already in
// every timestamp column. The bump is REQUIRED (see the WLST5.1 note below):
// without it existing DBs (user_version === 9) early-return from migrate()
// and skip the rewrite, so their stored instants stay naive and keep being
// misread.
// v11 (REROUTE-BUDGET): steps.target_moved_reroute_count. Bumping is REQUIRED
// (WLST5.1 failure mode): without it existing DBs (user_version === 10)
// early-return from migrate() and skip the guarded ALTER, so any SQL touching
// the new column crashes with "no such column: target_moved_reroute_count".
export const SCHEMA_VERSION = 11;

// Counter for tests — increments each time migrate() runs the full DDL path.
export let _migrateFullRuns = 0;

let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;

// Dynamic import to avoid top-level await issues in non-Node22 environments
import { DatabaseSync } from "node:sqlite";

function resolveDbPath(): string {
  const explicit = process.env.TAMANDUA_DB_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  return path.join(os.homedir(), ".tamandua", "tamandua.db");
}

export function getDb(): DatabaseSync {
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath) return _db;
  if (_db) {
    // Defer the close by one tick: synchronous callers that captured this
    // handle from an earlier getDb() call may still be mid-operation (e.g.
    // claimStep holds its db across a getWorkflowId() that re-enters
    // getDb()). Timers cannot interrupt synchronous code, so the stale
    // handle stays valid until they return; WAL mode tolerates the brief
    // second connection.
    const staleDb = _db;
    setTimeout(() => {
      try {
        staleDb.close();
      } catch {
        // Don't throw on double-close — we just want a fresh connection
      }
    }, 0).unref();
    _db = null;
  }

  assertStatePathIsolation(dbPath, "getDb()");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;
  // Concurrent writers (daemon dispatch rounds, CLI step complete/fail,
  // migrations at process start) briefly contend for the WAL write lock;
  // without a busy timeout that surfaces as an immediate
  // "database is locked" error instead of a short wait. Set it BEFORE any
  // lock-taking statement so ordinary contention waits.
  _db.exec("PRAGMA busy_timeout = 5000");
  // The WAL switch is special: `PRAGMA journal_mode=WAL` must take an
  // exclusive lock and, unlike reads/writes, is NOT covered by the SQLite
  // busy handler. Two processes racing to initialize the same fresh database
  // (daemon + `tamandua workflow run` CLI) would otherwise have one abort
  // instantly with "database is locked" — the load-dependent e2e gate flake.
  // Retry the switch until the other initializer finishes.
  enableWalMode(_db);
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  return _db;
}

// SQLite lock detection + bounded synchronous backoff. Main predates the
// US-011 WAL-init fix that introduced these on the integration branch; the
// migration lock below depends on them. Atomics.wait is the only blocking
// backoff primitive available to synchronous getDb() callers.
function isDatabaseLockedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// WAL-mode initialization retry budget. The WAL switch ignores the SQLite
// busy handler, so a bounded synchronous retry is the only way to converge
// two concurrent first-time initializers without a "database is locked"
// abort. The timeout bounds how long getDb() can block when the lock is held
// by a genuinely long-running writer.
const WAL_INIT_RETRY_MS = 20;
const WAL_INIT_TIMEOUT_MS = 10_000;

function enableWalMode(db: DatabaseSync): void {
  const deadline = Date.now() + WAL_INIT_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (err) {
      if (!isDatabaseLockedError(err) || Date.now() >= deadline) {
        throw err;
      }
      sleepSync(WAL_INIT_RETRY_MS);
    }
  }
}

// Bounded retry budget for the cross-process migration lock. The write lock
// itself waits under the SQLite busy handler (busy_timeout is set in getDb);
// this budget only bounds a pathological holder so getDb() cannot block
// forever.
const MIGRATION_LOCK_RETRY_MS = 20;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;

function acquireMigrationLock(db: DatabaseSync): void {
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (err) {
      if (!isDatabaseLockedError(err) || Date.now() >= deadline) {
        throw err;
      }
      sleepSync(MIGRATION_LOCK_RETRY_MS);
    }
  }
}

function migrate(db: DatabaseSync): void {
  // Fast path: the common case is an already-migrated database.
  const observed = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (observed.user_version === SCHEMA_VERSION) {
    return;
  }

  // Serialize the full migration across processes. Two cold-start
  // initializers (the daemon and a `tamandua workflow run` CLI) can both
  // observe the pre-migration user_version above; without a write lock both
  // execute the guarded ALTER TABLEs and the loser aborts with
  // "duplicate column name: <col>" (the load-dependent e2e gate flake).
  // After acquiring the lock the version is re-read, so the loser sees the
  // winner's committed migration and skips the DDL instead of racing it.
  acquireMigrationLock(db);
  try {
    const currentVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (currentVersion.user_version !== SCHEMA_VERSION) {
      applySchema(db);
      _migrateFullRuns++;
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may have already rolled the transaction back on a fatal error.
    }
    throw err;
  }
}

// Runs the full DDL upgrade. Callers MUST hold the migration write lock
// (acquireMigrationLock) and commit the enclosing transaction.
function applySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      parent_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      resume_reset_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Backfill run_number for existing runs
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  const runColNames = new Set(runCols.map((c) => c.name));
  if (!runColNames.has("run_number")) {
    db.exec("ALTER TABLE runs ADD COLUMN run_number INTEGER");
    runColNames.add("run_number");
    db.exec(`
      UPDATE runs SET run_number = (
        SELECT COUNT(*) FROM runs r2 WHERE r2.created_at <= runs.created_at
      ) WHERE run_number IS NULL
    `);
  }

  if (!runColNames.has("tokens_spent")) {
    db.exec("ALTER TABLE runs ADD COLUMN tokens_spent INTEGER NOT NULL DEFAULT 0");
  }

  db.exec("UPDATE runs SET tokens_spent = 0 WHERE tokens_spent IS NULL");

  // ── TATR parent_run_id for runs ──
  // Records which run spawned a child run so graph consumers can discover
  // parent/child linkage. Nullable with no backfill: existing rows and runs
  // without a parent keep NULL. Consumers must tolerate NULL (no parent).
  if (!runColNames.has("parent_run_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT");
    runColNames.add("parent_run_id");
  }

  // ── Run-scoped scheduling metadata ──
  // - scheduling_status: lifecycle of daemon-side scheduling for the run
  //   (pending_register | active | queued | paused | error | NULL)
  // - scheduling_requested_at: ISO ts used for FIFO admission ordering
  // - scheduling_error: human-readable reason when scheduling_status='error'
  if (!runColNames.has("scheduling_status")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_status TEXT");
  }
  if (!runColNames.has("scheduling_requested_at")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_requested_at TEXT");
  }
  if (!runColNames.has("scheduling_error")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_error TEXT");
  }

  // ── Worker ownership columns for steps ──
  // Tracks which worker process (job/PID/PGID) claimed each step.
  // CPID2: `claim_pid` is the HARNESS WORKER pid (the round's pid, exported
  // by the harness launch wrapper as TAMANDUA_WORKER_PID; for the detached
  // group leader pid === claim_pgid). It is NOT the scheduling daemon's pid
  // — the daemon pid travels in TAMANDUA_DAEMON_PID. claim_job_id is the
  // dispatch round id and claim_pgid the harness process group. This is a
  // semantics clarification only: no column is added and SCHEMA_VERSION does
  // not change.
  // Nullable — legacy rows stay NULL, ownership-agnostic callers are unaffected.
  const stepCols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  const stepColNames = new Set(stepCols.map((c) => c.name));
  if (!stepColNames.has("claim_job_id")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_job_id TEXT");
  }
  if (!stepColNames.has("claim_pid")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_pid INTEGER");
  }
  if (!stepColNames.has("claim_pgid")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_pgid INTEGER");
  }
  if (!stepColNames.has("claim_updated_at")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_updated_at TEXT");
  }

  // ── RETR reroute counter ──
  // Tracks how many times a retry_step reroute has occurred for each step.
  // Used to enforce the max_reroutes budget; NULL/0 means no reroute has happened.
  if (!stepColNames.has("reroute_count")) {
    db.exec("ALTER TABLE steps ADD COLUMN reroute_count INTEGER DEFAULT 0");
  }

  // Terminal-class reroutes have a separate dedicated counter. General
  // reroutes still count every retry_step traversal for max_reroutes.
  if (!stepColNames.has("terminal_reroute_count")) {
    db.exec("ALTER TABLE steps ADD COLUMN terminal_reroute_count INTEGER DEFAULT 0");
  }

  // ── REROUTE-BUDGET target_moved subset counter ──
  // FAILURE_CLASS target_moved (stale-tip) reroutes do NOT consume the shared
  // max_reroutes budget; they are budgeted separately against
  // on_fail.max_target_moved_reroutes (default 16). This counter is the
  // class-specific subset of reroute_count, exactly like terminal_reroute_count
  // is for the terminal class. reroute_count stays the total reroute counter
  // (reroute_count == count(step.rerouted)).
  if (!stepColNames.has("target_moved_reroute_count")) {
    db.exec("ALTER TABLE steps ADD COLUMN target_moved_reroute_count INTEGER DEFAULT 0");
  }

  // Ledger-gate concessions are distinct from general terminal reroutes so
  // unrelated terminal failures cannot consume the missing-evidence allowance.
  if (!stepColNames.has("ledger_concession_count")) {
    db.exec("ALTER TABLE steps ADD COLUMN ledger_concession_count INTEGER DEFAULT 0");
  }

  // ── RETR claim invalidation marker ──
  // When set to 'reroute', flags that the step's claim was deliberately invalidated
  // by a reroute (as opposed to a sweeper reset). Used by completeStepInternal to
  // reject stale completions from the pre-reroute claim while still allowing C5
  // late-work acceptance for sweeper-reset steps (claim_invalidated_by stays NULL).
  if (!stepColNames.has("claim_invalidated_by")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_invalidated_by TEXT");
  }

  // ── WAVE-A conditional-review step columns ──
  // - conditional_condition: the run-context flag key declared in
  //   workflow.yml (type: conditional steps only; NULL for plain steps).
  // - auto_completed: 1 when the dispatch motor auto-completed the step
  //   IN-PROCESS (condition unset, zero tokens) instead of an agent review;
  //   lets oracles/observers distinguish condition-unset auto-completions
  //   from agent-reviewed runs.
  // - auto_complete_reason: human-readable reason for the auto-completion
  //   (e.g. 'condition_unset:<key>'); NULL when the step ran normally.
  if (!stepColNames.has("conditional_condition")) {
    db.exec("ALTER TABLE steps ADD COLUMN conditional_condition TEXT");
  }
  if (!stepColNames.has("auto_completed")) {
    db.exec("ALTER TABLE steps ADD COLUMN auto_completed INTEGER NOT NULL DEFAULT 0");
  }
  if (!stepColNames.has("auto_complete_reason")) {
    db.exec("ALTER TABLE steps ADD COLUMN auto_complete_reason TEXT");
  }

  // ── WLST abandoned_count for stories ──
  // Tracks infrastructure-failure (worker-loss/timeout) story recoveries
  // separately from honest-verdict retry_count. Worker losses consume this
  // budget instead of the judgment retry_count, preventing blind timeout
  // burns from exhausting the story's honest-retry allowance.
  const storyCols = db.prepare("PRAGMA table_info(stories)").all() as Array<{ name: string }>;
  const storyColNames = new Set(storyCols.map((c) => c.name));
  if (!storyColNames.has("abandoned_count")) {
    db.exec("ALTER TABLE stories ADD COLUMN abandoned_count INTEGER DEFAULT 0");
  }

  // ── YSE resume_reset_count for stories ──
  // Counts how many times a workflow resume has re-queued a FAILED loop
  // story back to pending (status 'failed' → 'pending' with a fresh retry
  // budget). Lets status display distinguish a reset-on-resume story
  // (pending, resume_reset_count > 0) from a plain pending one; the count
  // of prior failure episodes equals the value (1 on the first reset), since
  // FAILED stories are only ever re-queued by resume. NOT NULL DEFAULT 0 —
  // existing rows read back 0 after migration.
  if (!storyColNames.has("resume_reset_count")) {
    db.exec("ALTER TABLE stories ADD COLUMN resume_reset_count INTEGER NOT NULL DEFAULT 0");
  }

  // ── ABND story_abandonments table ──
  // Per-story abandonment history with reason tracking.
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_abandonments (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      abandoned_count INTEGER NOT NULL,
      step_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_story_abandonments_run_story ON story_abandonments(run_id, story_id)",
  );

  // ── ABND step_id column ──
  // step_id is nullable — when a step association is unresolvable (e.g.
  // dead-pgid claim after a daemon restart), we still record the abandonment
  // with NULL step_id rather than losing forensic data.
  const abandonCols = db.prepare("PRAGMA table_info(story_abandonments)").all() as Array<{ name: string }>;
  const abandonColNames = new Set(abandonCols.map((c) => c.name));
  if (!abandonColNames.has("step_id")) {
    db.exec("ALTER TABLE story_abandonments ADD COLUMN step_id TEXT");
  }

  // ── WLOG worker_lost_count for runs ──
  // Tracks how many times a worker vanished (step.worker_lost emitted)
  // during the run. Surfaced in terminal events and CLI status output.
  const addWorkerLost = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'worker_lost_count'").all();
  if (addWorkerLost.length === 0) {
    db.exec("ALTER TABLE runs ADD COLUMN worker_lost_count INTEGER NOT NULL DEFAULT 0");
  }

  // ── WLST ceiling_expiry_count for runs ──
  // Tracks how many worker rounds the motor itself killed at the worker
  // time ceiling (timeoutSeconds) — a distinct termination class from
  // genuinely lost harness workers (worker_lost_count). step.ceiling_expiry
  // events increment this counter; worker_lost_count is NOT touched so the
  // "Worker lost: M" readout keeps meaning harness_lost only.
  // NOTE (WLST5.1): WLST5 (5873a9a9) shipped this guarded ALTER without bumping
  // SCHEMA_VERSION, so every existing DB (user_version === 3) skipped it and
  // any SQL touching ceiling_expiry_count crashed with "no such column".
  // The bump to v4 (above) makes this run on all existing installs; the
  // PRAGMA table_info guard keeps it idempotent on re-run. Pinned by the MIGV
  // upgrade-path test in src/db.test.ts.
  const addCeilingExpiry = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'ceiling_expiry_count'").all();
  if (addCeilingExpiry.length === 0) {
    db.exec("ALTER TABLE runs ADD COLUMN ceiling_expiry_count INTEGER NOT NULL DEFAULT 0");
  }

  // ── RSPN instant_fail_count for runs ──
  // Tracks consecutive instant-fail worker rounds (wall time below the
  // threshold AND zero output AND nonzero exit — a broken harness binary,
  // revoked credential, bad PATH) classified by the dispatch motor. This is
  // a THIRD, distinct class from worker_lost_count (harness_lost) and
  // ceiling_expiry_count (motor-killed at the time ceiling): an instant-fail
  // round claims no step, so WLST5's counters — which only tick inside
  // recoverOrphanedStepsForAgent when a step/story is actually recovered —
  // never see it. Additive field only; WLST5 counters are untouched.
  const addInstantFail = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'instant_fail_count'").all();
  if (addInstantFail.length === 0) {
    db.exec("ALTER TABLE runs ADD COLUMN instant_fail_count INTEGER NOT NULL DEFAULT 0");
  }

  // ── WAVE-A TEST_CMD contract columns ──
  // - test_cmd_established: the current TEST_CMD contract for the run —
  //   launch-declared `--context test_cmd=` wins, else the FIRST step-emitted
  //   TEST_CMD: marker establishes it. Later differing markers never silently
  //   replace this value (they raise a review flag instead).
  // - test_cmd_source: where the contract came from — 'launch' or the step id
  //   that first emitted the marker.
  const addTestCmd = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'test_cmd_established'").all();
  if (addTestCmd.length === 0) {
    db.exec("ALTER TABLE runs ADD COLUMN test_cmd_established TEXT");
  }
  const addTestCmdSource = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'test_cmd_source'").all();
  if (addTestCmdSource.length === 0) {
    db.exec("ALTER TABLE runs ADD COLUMN test_cmd_source TEXT");
  }

  // ── IFLB harness_probe_status / harness_probe_at for runs ──
  // Persists the launch-time harness probe outcome so the dispatch motor
  // probes a run exactly ONCE and a daemon restart does not re-probe a run
  // that already passed. harness_probe_status is NULL (never probed) until a
  // probe is reserved ('probing') and then recorded ('ok' | 'failed');
  // harness_probe_at is the ISO timestamp when the outcome was recorded.
  // Both are nullable with no backfill: existing runs keep NULL (never
  // probed). NOTE (WLST5.1): the SCHEMA_VERSION bump to v9 (above) is
  // REQUIRED — adding these guarded ALTERs without bumping leaves existing
  // DBs (user_version === 8) early-returning and skipping the migration, so
  // the scheduler's probe-status reads crash with "no such column". The
  // PRAGMA table_info guard keeps them idempotent on re-run.
  const addHarnessProbeStatus = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'harness_probe_status'").all();
  if (addHarnessProbeStatus.length === 0) {
    db.exec("ALTER TABLE runs ADD COLUMN harness_probe_status TEXT");
  }
  const addHarnessProbeAt = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'harness_probe_at'").all();
  if (addHarnessProbeAt.length === 0) {
    db.exec("ALTER TABLE runs ADD COLUMN harness_probe_at TEXT");
  }

  // Indexes for run-scoped scheduling and step claim queries.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_steps_agent_run_status ON steps(agent_id, run_id, status)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_status_sched ON runs(status, scheduling_status, scheduling_requested_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_sched_queue ON runs(scheduling_status, scheduling_requested_at, created_at)",
  );

  // ── Global stats ──
  const statsTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tamandua_stats'",
  ).get();
  if (!statsTableExists) {
    db.exec(`
      CREATE TABLE tamandua_stats (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        system_tokens_spent INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec("INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)");
  }

  // ── Worktree tracking ──
  // Tracks managed git worktrees created for run workspace isolation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY,
      worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT,
      worktree_origin_sha TEXT,
      original_branch TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
      created_at TEXT NOT NULL,
      removed_at TEXT,
      error TEXT
    );
  `);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_run_worktrees_status ON run_worktrees(status)",
  );

  // ── AutoResearch session registry ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS autoresearch_sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      goal TEXT,
      metric_name TEXT,
      metric_unit TEXT,
      direction TEXT,
      command TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_run_at TEXT,
      total_runs INTEGER NOT NULL DEFAULT 0,
      baseline_metric REAL,
      best_metric REAL,
      best_run INTEGER,
      files_missing INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_autoresearch_sessions_cwd ON autoresearch_sessions(cwd)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_autoresearch_sessions_updated_at ON autoresearch_sessions(updated_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_autoresearch_sessions_last_seen_at ON autoresearch_sessions(last_seen_at)",
  );

  // ── TSTX suite results ledger ──
  // Append-only: every test execution inserts a row; replays do not.
  // Rows older than LEDGER_RETENTION (14d) are pruned by the reconciler.
  db.exec(`
    CREATE TABLE IF NOT EXISTS suite_results (
      id INTEGER PRIMARY KEY,
      origin_repo TEXT NOT NULL,
      tree_hash TEXT NOT NULL,
      cmd_hash TEXT NOT NULL,
      cmd_display TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      log_tail TEXT,
      run_id TEXT,
      step_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_suite_results_lookup ON suite_results(origin_repo, tree_hash, cmd_hash, created_at)",
  );

  // ── TIME-STORAGE v10: rewrite legacy naive instants to ISO-Z ──
  // Runs inside the enclosing migration write lock, immediately before the
  // version re-stamp, so a DB at v10 always has normalized instants.
  migrateInstantsToIsoZ(db);

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// ── TIME-STORAGE v10: normalize stored instants ────────────────────────────
// The timestamp columns that carry a stored instant, grouped by table. Every
// table is probed for existence because applySchema() does NOT create
// medic_checks — src/medic/medic.ts ensureMedicTables() does, lazily, and it
// may not exist when migrate() runs. Columns are probed too so a table in an
// older shape can never abort the migration with "no such column".
const INSTANT_COLUMNS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["runs", ["created_at", "updated_at", "scheduling_requested_at", "harness_probe_at"]],
  ["steps", ["created_at", "updated_at", "claim_updated_at"]],
  ["stories", ["created_at", "updated_at"]],
  ["story_abandonments", ["created_at"]],
  ["run_worktrees", ["created_at", "removed_at"]],
  ["autoresearch_sessions", ["created_at", "updated_at", "last_seen_at", "last_run_at"]],
  ["suite_results", ["created_at"]],
  ["medic_checks", ["checked_at"]],
];

// Exact-shape GLOB for the legacy naive UTC form `YYYY-MM-DD HH:MM:SS` (19
// chars). GLOB is anchored and case-sensitive, so ISO-Z (`...T...Z`) values,
// values with a real offset, NULL and every non-timestamp string fail the
// predicate and are left byte-identical. Rewrite is `replace(col,' ','T') ||
// '.000Z'` — pure string surgery, no date parsing and no new columns.
const NAIVE_INSTANT_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]";

/**
 * Rewrites every legacy naive UTC instant (`YYYY-MM-DD HH:MM:SS`) still stored
 * in a timestamp column to the canonical ISO-8601 UTC form with milliseconds
 * and `Z` (`YYYY-MM-DDTHH:MM:SS.000Z`). Values already in the canonical form,
 * values with a real offset, NULLs and non-timestamp strings are untouched, so
 * the function is idempotent. Callers MUST hold the migration write lock; it
 * is invoked from applySchema() inside the serialized migrate() transaction.
 */
export function migrateInstantsToIsoZ(db: DatabaseSync): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  for (const [table, columns] of INSTANT_COLUMNS) {
    if (!tableExists.get(table)) continue;
    const tableCols = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const column of columns) {
      if (!tableCols.has(column)) continue;
      db.exec(
        `UPDATE ${table} SET ${column} = replace(${column}, ' ', 'T') || '.000Z' ` +
          `WHERE ${column} GLOB '${NAIVE_INSTANT_GLOB}'`,
      );
    }
  }
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore double-close errors
    }
    _db = null;
    _dbPath = null;
  }
}

export function getDbPath(): string {
  return resolveDbPath();
}

export function getSystemTokenSpend(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
  ).get() as { system_tokens_spent: number } | undefined;
  return row?.system_tokens_spent ?? 0;
}

export function incrementSystemTokenSpend(amount: number): number {
  const db = getDb();
  const row = db.prepare(`
    UPDATE tamandua_stats
    SET system_tokens_spent = system_tokens_spent + ?
    WHERE id = 1
    RETURNING system_tokens_spent
  `).get(amount) as { system_tokens_spent: number } | undefined;
  return row?.system_tokens_spent ?? 0;
}

// ── AutoResearch session registry ──

interface AutoresearchSessionConfigRaw {
  goal?: string;
  metricName?: string;
  metricUnit?: string;
  direction?: string;
  command?: string;
}

interface AutoresearchLogRunEntry {
  type: string;
  run: number;
  status: string;
  metric: number | null;
}

export interface AutoresearchSessionRow {
  id: string;
  cwd: string;
  goal: string | null;
  metric_name: string | null;
  metric_unit: string | null;
  direction: string | null;
  command: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  last_run_at: string | null;
  total_runs: number;
  baseline_metric: number | null;
  best_metric: number | null;
  best_run: number | null;
  files_missing: number;
}

function readSessionConfigFromFiles(cwd: string): { config: AutoresearchSessionConfigRaw; missing: boolean } {
  const configPath = path.join(cwd, "autoresearch.config.json");
  if (!fs.existsSync(configPath)) {
    return { config: {}, missing: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AutoresearchSessionConfigRaw;
    return { config: raw, missing: false };
  } catch {
    return { config: {}, missing: true };
  }
}

function readLogFromFiles(cwd: string): AutoresearchLogRunEntry[] {
  const logPath = path.join(cwd, "autoresearch.jsonl");
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs.readFileSync(logPath, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as AutoresearchLogRunEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AutoresearchLogRunEntry => entry !== null && entry.type === "run");
  } catch {
    return [];
  }
}

export function upsertAutoresearchSession(cwd: string): AutoresearchSessionRow | null {
  const db = getDb();
  const resolvedCwd = resolveSessionCwd(cwd);
  const id = resolvedCwd;

  const { config, missing } = readSessionConfigFromFiles(resolvedCwd);
  const now = nowIso();

  let filesMissing = missing ? 1 : 0;
  if (!filesMissing) {
    // Check if log file exists (not strictly required but useful for completeness)
    const logPath = path.join(resolvedCwd, "autoresearch.jsonl");
    if (!fs.existsSync(logPath)) filesMissing = 1;
  }

  const goal = config.goal ?? null;
  const metricName = config.metricName ?? null;
  const metricUnit = config.metricUnit ?? null;
  const direction = config.direction ?? null;
  const command = config.command ?? null;

  // Read log entries to compute stats
  const runs = readLogFromFiles(resolvedCwd);
  const keptRuns = runs.filter((r) => r.status === "baseline" || r.status === "keep");
  const totalRuns = runs.length;

  // Find baseline metric (first entry with status "baseline")
  const baselineEntry = runs.find((r) => r.status === "baseline" && r.metric !== null);
  const baselineMetric = baselineEntry?.metric ?? null;

  // Find best metric among kept runs
  let bestMetric: number | null = null;
  let bestRun: number | null = null;
  for (const r of keptRuns) {
    if (r.metric === null) continue;
    if (bestMetric === null) {
      bestMetric = r.metric;
      bestRun = r.run;
    } else if (direction === "higher") {
      if (r.metric > bestMetric) { bestMetric = r.metric; bestRun = r.run; }
    } else {
      if (r.metric < bestMetric) { bestMetric = r.metric; bestRun = r.run; }
    }
  }

  // Determine last_run_at from the highest run number
  const latestRun = runs.reduce<AutoresearchLogRunEntry | null>((latest, r) => {
    if (!latest || r.run > latest.run) return r;
    return latest;
  }, null);
  const lastRunAt = latestRun ? now : null; // We use 'now' as last_seen; last_run_at is approximate

  db.prepare(`
    INSERT OR REPLACE INTO autoresearch_sessions
      (id, cwd, goal, metric_name, metric_unit, direction, command,
       created_at, updated_at, last_seen_at, last_run_at,
       total_runs, baseline_metric, best_metric, best_run, files_missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, resolvedCwd, goal, metricName, metricUnit, direction, command,
    now, now, now, lastRunAt,
    totalRuns, baselineMetric, bestMetric, bestRun, filesMissing,
  );

  return {
    id,
    cwd: resolvedCwd,
    goal,
    metric_name: metricName,
    metric_unit: metricUnit,
    direction,
    command,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    last_run_at: lastRunAt,
    total_runs: totalRuns,
    baseline_metric: baselineMetric,
    best_metric: bestMetric,
    best_run: bestRun,
    files_missing: filesMissing,
  };
}

function resolveSessionCwd(cwd: string): string {
  const absolute = path.resolve(cwd);
  try {
    return fs.realpathSync(absolute);
  } catch {
    let current = absolute;
    const missingParts: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missingParts.unshift(path.basename(current));
      current = parent;
      try {
        const realParent = fs.realpathSync(current);
        return path.join(realParent, ...missingParts);
      } catch {
        // Continue walking up until an existing parent can be canonicalized.
      }
    }
  }
}

export function getAutoresearchSessions(opts?: { includeMissing?: boolean }): AutoresearchSessionRow[] {
  const db = getDb();
  const includeMissing = opts?.includeMissing ?? false;
  const rows = includeMissing
    ? db.prepare("SELECT * FROM autoresearch_sessions ORDER BY updated_at DESC").all()
    : db.prepare("SELECT * FROM autoresearch_sessions WHERE files_missing = 0 ORDER BY updated_at DESC").all();
  return rows as unknown as AutoresearchSessionRow[];
}

export function getAutoresearchSessionById(id: string): AutoresearchSessionRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM autoresearch_sessions WHERE id = ?").get(id) as unknown as AutoresearchSessionRow | undefined;
}

export function deleteAutoresearchSession(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM autoresearch_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── TSTX suite results pruning ──

export function pruneOldSuiteResults(): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - LEDGER_RETENTION_MS).toISOString();
  const before = (db.prepare("SELECT COUNT(*) as cnt FROM suite_results").get() as { cnt: number }).cnt;
  db.prepare("DELETE FROM suite_results WHERE created_at < ?").run(cutoff);
  const after = (db.prepare("SELECT COUNT(*) as cnt FROM suite_results").get() as { cnt: number }).cnt;
  return before - after;
}
