import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let _db: DatabaseSync | null = null;
let _dbOpenedAt = 0;
let _dbPath: string | null = null;
const DB_MAX_AGE_MS = 5000;

// Dynamic import to avoid top-level await issues in non-Node22 environments
import { DatabaseSync } from "node:sqlite";

function resolveDbPath(): string {
  const explicit = process.env.TAMANDUA_DB_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  return path.join(os.homedir(), ".tamandua", "tamandua.db");
}

export function getDb(): DatabaseSync {
  const now = Date.now();
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath && (now - _dbOpenedAt) < DB_MAX_AGE_MS) return _db;
  // Only close if the ref is non-null (avoid double-close warnings)
  if (_db) {
    try {
      _db.close();
    } catch {
      // Don't throw on double-close — we just want a fresh connection
    }
    _db = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;
  _dbOpenedAt = now;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  return _db;
}

function migrate(db: DatabaseSync): void {
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
  // Tracks which polling worker process (job/PID/PGID) claimed each step.
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
}

export function nextRunNumber(): number {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM runs").get() as { next: number };
  return row.next;
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
  const now = new Date().toISOString();

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
