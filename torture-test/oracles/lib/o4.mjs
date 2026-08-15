import fs from 'node:fs';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';

// Claim & dispatch hygiene oracle (US-010). O4 judges the sweep-level hygiene
// assertions of spec 03 ("O4 — Claim & dispatch hygiene (sweep, gating)") from
// the read-only database snapshot, the event-stream slice, and the chaos log:
//
//   * No step `running` with a dead `claim_pgid` beyond one sweep interval
//     (the daemon's periodic sweep/reconciler tick — 15s dispatch interval).
//     Liveness is probed exactly like the product's liveness watchdog:
//     kill(-pgid, 0); ESRCH means the process group is gone.
//   * No dangling claims after NO_WORK — the scheduler releases claims scoped
//     to the round's job with abandonReason `no_work_release`; a step that was
//     released must not still be claimed at snapshot time (a re-claim AFTER the
//     release is legitimate and not a violation).
//   * retry_count <= max_retries for every non-terminal step/story — a
//     terminal (failed) step may legitimately carry retry_count == max_retries+1
//     because the product fails the step AT the exhaustion point.
//   * reroute counters within budget — the product's general reroute counter
//     never increments past the workflow's max_reroutes (default 2); a value
//     above the default is a counter-runaway anomaly.
//   * Abandonment boundary matches source — ABANDON_STORY_MAX = 8 survivable
//     story losses (a story fails on the 9th; non-failed stories may carry at
//     most 8) and MAX_ABANDON_RESETS = 5 for single steps (a non-failed step
//     may carry at most 4).
//   * Watchdog false-positive check — zero `[liveness-detected]` worker_lost
//     recoveries (story_abandonments.reason = 'liveness_detected') for workers
//     provably alive: >= 2 consecutive process-recorder samples of the run's
//     worker within the proof window before the recovery, cross-referenced with
//     the chaos log. A chaos kill-harness 'fired' entry for the run explains
//     the loss (not a false positive); kill-and-PID-reuse inside one window
//     (a chaos kill AND later samples with the same pgid) is INCONCLUSIVE and
//     maps to NOT_EVALUABLE (scope 'watchdog-pid-reuse') when no other
//     dimension produced a finding.
//
// Every verdict derives from mechanical evidence only. The chaos_log evidence
// is the snapshot bundle: tt-chaos structured entries (JSON lines carrying an
// `action`/`outcome` field) followed by the recorder-sample bundle (JSON lines
// carrying an integer `pid` and `ts` — the process recorder's 5s sampler,
// harvested at wave boundaries, per spec 03/O19). Malformed lines are skipped
// (a log may be mid-write); malformed DB evidence fails closed as ERROR.

// One dispatch interval (spec 03 terminology: the daemon's 15s fallback sweep).
const SWEEP_INTERVAL_MS = 15_000;
// Product default max_retries (src/db.ts steps/stories DEFAULT 4).
const DEFAULT_MAX_RETRIES = 4;
// Product default max_reroutes when the workflow declares no on_fail budget.
const DEFAULT_MAX_REROUTES = 2;
// Product ABANDON_STORY_MAX — a story fails on the 9th loss.
const ABANDON_STORY_MAX = 8;
// Product MAX_ABANDON_RESETS for single steps — a step fails at the 5th reset.
const STEP_ABANDON_MAX = 5;
// Recorder samples within this window before a liveness recovery count as
// liveness proof (the recorder samples every 5s, so 2 minutes is generous).
const RECORDER_PROOF_WINDOW_MS = 120_000;
// Recorder samples within this window after the recovery count as PID-reuse
// evidence when a chaos kill also exists.
const RECORDER_AFTER_WINDOW_MS = 120_000;
// A chaos kill entry within this window of the recovery explains it.
const CHAOS_KILL_WINDOW_MS = 120_000;
// Maximum gap between two "consecutive" recorder samples (2x the default 5s
// interval — a longer gap breaks the consecutive-sample proof).
const RECORDER_MAX_GAP_MS = 10_000;

const TERMINAL_STATUSES = new Set(['done', 'failed', 'canceled']);

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

function canonicalRunId(value, label = 'run ID') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OracleRuntimeError(`${label} must be nonempty`);
  }
  return value.startsWith('run-') ? value : `run-${value}`;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new OracleRuntimeError(`${label} must be a non-negative safe integer`);
  return value;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError(`${label} must be nonempty`);
  return value;
}

function readJson(file, label) {
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8')), label);
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
}

function readArtifact(file, label) {
  const artifact = readJson(file, label);
  if (artifact.schema_version !== 1 || !Array.isArray(artifact.rows)) {
    throw new OracleRuntimeError(`${label} must be a schema-version 1 row artifact`);
  }
  return artifact;
}

// Accepts both canonical UTC ISO-8601 ('2026-08-01T12:00:00.000Z') and the
// product's SQLite datetime('now') format ('2026-08-01 12:00:00', UTC).
function parseDbTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let iso = value;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    iso = `${value.replace(' ', 'T')}Z`;
  }
  const ms = new Date(iso).valueOf();
  return Number.isFinite(ms) ? ms : null;
}

function readRunEvents(invocation) {
  const artifact = readArtifact(invocation.evidencePaths.run_events, 'run_events');
  const rows = [];
  artifact.rows.forEach((raw, index) => {
    const row = object(raw, `run_events.rows[${index}]`);
    integer(row.line, `run_events.rows[${index}].line`);
    nonempty(row.archive, `run_events.rows[${index}].archive`);
    const event = object(row.event, `run_events.rows[${index}].event`);
    nonempty(event.event, `run_events.rows[${index}].event.event`);
    rows.push({ archive: row.archive, line: row.line, event });
  });
  return { captured_at: artifact.captured_at, rows };
}

// The chaos_log evidence is the snapshot bundle (chaos entries + recorder
// samples). Classification: a JSON line with an integer `pid` and a `ts` is a
// recorder sample; anything else with an `action` is a chaos entry; non-JSON
// lines (section markers, partial writes) are skipped.
function readChaosLog(invocation) {
  const evidencePath = invocation.evidencePaths.chaos_log;
  if (typeof evidencePath !== 'string') {
    throw new OracleRuntimeError('chaos_log is not a controller-provided evidence reference');
  }
  const chaosEntries = [];
  const recorderSamples = [];
  const raw = fs.readFileSync(evidencePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // tolerate a mid-write log line
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    if (Number.isInteger(parsed.pid) && typeof parsed.ts === 'string') {
      recorderSamples.push(parsed);
    } else if (typeof parsed.action === 'string') {
      chaosEntries.push(parsed);
    }
  }
  return { chaosEntries, recorderSamples };
}

function columnNames(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function readDatabase(invocation) {
  const database = openEvidenceDatabase(invocation);
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const required of ['runs', 'steps', 'stories']) {
      if (!tables.has(required)) throw new OracleRuntimeError(`${required} table is required`);
    }
    const stepColumns = columnNames(database, 'steps');
    const storyColumns = columnNames(database, 'stories');
    const runColumns = columnNames(database, 'runs');

    const steps = database.prepare('SELECT * FROM steps ORDER BY run_id, step_index, step_id').all().map((row, index) => {
      object(row, `steps row ${index}`);
      const step = {
        id: nonempty(row.id, `steps[${index}].id`),
        run_id: canonicalRunId(row.run_id, `steps[${index}].run_id`),
        step_id: row.step_id === null || row.step_id === undefined ? null : nonempty(row.step_id, `steps[${index}].step_id`),
        status: nonempty(row.status, `steps[${index}].status`),
      };
      for (const [column, label] of [
        ['retry_count', 'retry_count'], ['max_retries', 'max_retries'], ['reroute_count', 'reroute_count'],
        ['abandoned_count', 'abandoned_count'], ['claim_pid', 'claim_pid'], ['claim_pgid', 'claim_pgid'],
        ['claim_job_id', 'claim_job_id'], ['claim_updated_at', 'claim_updated_at'], ['updated_at', 'updated_at'],
      ]) {
        const value = stepColumns.has(column) ? row[column] : undefined;
        if (column === 'claim_job_id' || column === 'claim_updated_at' || column === 'updated_at') {
          step[label] = value === null || value === undefined ? null : value;
        } else {
          step[label] = value === null || value === undefined ? null : integer(value, `steps[${index}].${column}`);
        }
      }
      return step;
    });
    const stories = database.prepare('SELECT * FROM stories ORDER BY run_id, story_index, story_id').all().map((row, index) => {
      object(row, `stories row ${index}`);
      const story = {
        id: nonempty(row.id, `stories[${index}].id`),
        run_id: canonicalRunId(row.run_id, `stories[${index}].run_id`),
        story_id: row.story_id === null || row.story_id === undefined ? null : nonempty(row.story_id, `stories[${index}].story_id`),
        status: nonempty(row.status, `stories[${index}].status`),
      };
      for (const column of ['retry_count', 'max_retries', 'abandoned_count']) {
        const value = storyColumns.has(column) ? row[column] : undefined;
        story[column] = value === null || value === undefined ? null : integer(value, `stories[${index}].${column}`);
      }
      return story;
    });
    const abandonments = [];
    if (tables.has('story_abandonments')) {
      const abandonmentColumns = columnNames(database, 'story_abandonments');
      database.prepare('SELECT * FROM story_abandonments ORDER BY run_id, story_id, created_at').all().forEach((row, index) => {
        object(row, `story_abandonments row ${index}`);
        const record = {
          id: nonempty(row.id, `story_abandonments[${index}].id`),
          run_id: canonicalRunId(row.run_id, `story_abandonments[${index}].run_id`),
          story_id: row.story_id === null || row.story_id === undefined ? null : nonempty(row.story_id, `story_abandonments[${index}].story_id`),
          reason: row.reason === null || row.reason === undefined ? null : nonempty(row.reason, `story_abandonments[${index}].reason`),
          step_id: row.step_id === null || row.step_id === undefined ? null : nonempty(row.step_id, `story_abandonments[${index}].step_id`),
          created_at: row.created_at === null || row.created_at === undefined ? null : row.created_at,
        };
        if (abandonmentColumns.has('abandoned_count')) {
          record.abandoned_count = row.abandoned_count === null || row.abandoned_count === undefined ? null : integer(row.abandoned_count, `story_abandonments[${index}].abandoned_count`);
        }
        abandonments.push(record);
      });
    }
    const runs = database.prepare('SELECT * FROM runs ORDER BY id').all().map((row, index) => {
      object(row, `runs row ${index}`);
      const run = {
        run_id: canonicalRunId(row.id, `runs[${index}].id`),
        status: nonempty(row.status, `runs[${index}].status`),
      };
      if (runColumns.has('run_number')) {
        run.run_number = row.run_number === null || row.run_number === undefined ? null : integer(row.run_number, `runs[${index}].run_number`);
      }
      return run;
    });
    const stepsById = new Map(steps.map((step) => [step.id, step]));
    return { steps, stories, abandonments, runs, stepsById };
  } finally {
    database.close();
  }
}

// ── pgid liveness probe (identical semantics to the product's liveness
// watchdog: kill(-pgid, 0); ESRCH → dead, EPERM/success → alive) ──
function pgidAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// Dimension 1: no step `running` with a dead claim_pgid beyond one sweep
// interval. Steps without claim_pgid (legacy/manual claims) are left to the
// age-based sweeper per the product's watchdog — not judged here.
function judgeDeadClaimPgid(findings, steps, nowMs) {
  const observations = [];
  for (const step of steps) {
    if (step.status !== 'running') continue;
    const pgid = step.claim_pgid;
    if (pgid === null || pgid === undefined || pgid <= 0) continue;
    const alive = pgidAlive(pgid);
    const claimTs = parseDbTimestamp(step.claim_updated_at ?? step.updated_at);
    let ageMs = null;
    if (claimTs !== null) ageMs = nowMs - claimTs;
    observations.push({
      step_id: step.step_id, run_id: step.run_id, claim_pgid: pgid,
      pgid_alive: alive, claim_age_ms: ageMs,
    });
    if (alive) continue;
    if (ageMs === null) continue; // no timestamp → cannot establish "beyond one sweep interval"
    if (ageMs >= SWEEP_INTERVAL_MS) {
      findings.add(
        'O4_DEAD_CLAIM_PGID',
        'running step carries a dead claim_pgid beyond one sweep interval',
        { run_id: step.run_id, step_id: step.step_id, claim_pgid: pgid, claim_age_ms: ageMs },
      );
    }
  }
  return observations;
}

// Dimension 2: no dangling claims after NO_WORK. The scheduler releases claims
// scoped to the round's job with abandonReason `no_work_release`; a step that
// was released must not still be claimed at snapshot time. A re-claim with a
// claim_updated_at AFTER the release is legitimate.
function judgeDanglingClaimAfterNoWork(findings, db) {
  const observations = [];
  for (const record of db.abandonments) {
    if (record.reason !== 'no_work_release') continue;
    const step = record.step_id !== null ? db.stepsById.get(record.step_id) : undefined;
    if (step === undefined) continue;
    const claimed = step.claim_pid !== null || step.claim_pgid !== null || step.claim_job_id !== null;
    const releaseTs = parseDbTimestamp(record.created_at);
    const claimTs = parseDbTimestamp(step.claim_updated_at ?? step.updated_at);
    const reclaimedAfterRelease = releaseTs !== null && claimTs !== null && claimTs > releaseTs;
    observations.push({
      run_id: step.run_id, step_id: step.step_id, story_id: record.story_id,
      released_at: record.created_at, status: step.status, claimed,
      claim_updated_at: step.claim_updated_at, reclaimed_after_release: reclaimedAfterRelease,
    });
    if (step.status !== 'running' || !claimed) continue;
    if (reclaimedAfterRelease) continue;
    findings.add(
      'O4_DANGLING_CLAIM_AFTER_NO_WORK',
      'step released by a NO_WORK round is still claimed at snapshot time',
      {
        run_id: step.run_id, step_id: step.step_id, story_id: record.story_id,
        released_at: record.created_at, claim_pid: step.claim_pid, claim_pgid: step.claim_pgid,
        claim_job_id: step.claim_job_id, claim_updated_at: step.claim_updated_at,
      },
    );
  }
  return observations;
}

// Dimension 3: retry_count <= max_retries for every non-terminal step/story.
function judgeRetryBudget(findings, db) {
  const observations = [];
  for (const step of db.steps) {
    if (TERMINAL_STATUSES.has(step.status)) continue;
    const retries = step.retry_count ?? 0;
    const max = step.max_retries ?? DEFAULT_MAX_RETRIES;
    observations.push({ kind: 'step', step_id: step.step_id, run_id: step.run_id, retry_count: retries, max_retries: max, status: step.status });
    if (retries > max) {
      findings.add('O4_RETRY_BUDGET_EXCEEDED', 'non-terminal step exceeds its max_retries budget', {
        run_id: step.run_id, step_id: step.step_id, retry_count: retries, max_retries: max, status: step.status,
      });
    }
  }
  for (const story of db.stories) {
    if (TERMINAL_STATUSES.has(story.status)) continue;
    const retries = story.retry_count ?? 0;
    const max = story.max_retries ?? DEFAULT_MAX_RETRIES;
    observations.push({ kind: 'story', story_id: story.story_id, run_id: story.run_id, retry_count: retries, max_retries: max, status: story.status });
    if (retries > max) {
      findings.add('O4_RETRY_BUDGET_EXCEEDED', 'non-terminal story exceeds its max_retries budget', {
        run_id: story.run_id, story_id: story.story_id, retry_count: retries, max_retries: max, status: story.status,
      });
    }
  }
  return observations;
}

// Dimension 4: reroute counters within budget (the product's general reroute
// counter never increments past max_reroutes — default 2).
function judgeRerouteBudget(findings, db) {
  const observations = [];
  for (const step of db.steps) {
    const reroutes = step.reroute_count ?? 0;
    observations.push({ step_id: step.step_id, run_id: step.run_id, reroute_count: reroutes, budget: DEFAULT_MAX_REROUTES, status: step.status });
    if (reroutes > DEFAULT_MAX_REROUTES) {
      findings.add('O4_REROUTE_BUDGET_EXCEEDED', 'step reroute counter exceeds the default max_reroutes budget', {
        run_id: step.run_id, step_id: step.step_id, reroute_count: reroutes, budget: DEFAULT_MAX_REROUTES, status: step.status,
      });
    }
  }
  return observations;
}

// Dimension 5: abandonment boundary matches source. ABANDON_STORY_MAX = 8
// survivable story losses (a story fails on the 9th; only failed stories may
// carry more than 8) and MAX_ABANDON_RESETS = 5 for single steps (only failed
// steps may carry >= 5).
function judgeAbandonBoundary(findings, db) {
  const observations = [];
  for (const story of db.stories) {
    const abandoned = story.abandoned_count ?? 0;
    observations.push({ kind: 'story', story_id: story.story_id, run_id: story.run_id, abandoned_count: abandoned, boundary: ABANDON_STORY_MAX, status: story.status });
    if (abandoned > ABANDON_STORY_MAX && story.status !== 'failed') {
      findings.add('O4_ABANDON_BUDGET_EXCEEDED', 'story exceeded the ABANDON_STORY_MAX boundary without failing', {
        run_id: story.run_id, story_id: story.story_id, abandoned_count: abandoned, boundary: ABANDON_STORY_MAX, status: story.status,
      });
    }
  }
  for (const step of db.steps) {
    const abandoned = step.abandoned_count ?? 0;
    observations.push({ kind: 'step', step_id: step.step_id, run_id: step.run_id, abandoned_count: abandoned, boundary: STEP_ABANDON_MAX, status: step.status });
    if (abandoned >= STEP_ABANDON_MAX && step.status !== 'failed') {
      findings.add('O4_ABANDON_BUDGET_EXCEEDED', 'step exceeded the MAX_ABANDON_RESETS boundary without failing', {
        run_id: step.run_id, step_id: step.step_id, abandoned_count: abandoned, boundary: STEP_ABANDON_MAX, status: step.status,
      });
    }
  }
  return observations;
}

// ── Watchdog false-positive check (dimension 6) ──
function chaosKillForRun(chaosEntries, runId, eventTs) {
  const windowStart = eventTs - CHAOS_KILL_WINDOW_MS;
  const windowEnd = eventTs + CHAOS_KILL_WINDOW_MS;
  return chaosEntries.find((entry) => {
    if (entry.action !== 'kill-harness' || entry.outcome !== 'fired') return false;
    const entryRun = entry.runId ?? entry.run_id ?? null;
    if (typeof entryRun !== 'string' || canonicalRunId(entryRun) !== runId) return false;
    const entryTs = parseDbTimestamp(entry.ts);
    if (entryTs === null) return false;
    return entryTs >= windowStart && entryTs <= windowEnd;
  }) ?? null;
}

// Recorder samples tied to a run: the sample's cmdline or cwd mentions the run
// id (bare UUID or run-prefixed) — the harness worker's process evidence.
function samplesForRun(recorderSamples, runId) {
  const bare = runId.startsWith('run-') ? runId.slice(4) : runId;
  return recorderSamples
    .map((sample) => {
      const ts = parseDbTimestamp(sample.ts);
      return { ...sample, ts };
    })
    .filter((sample) => sample.ts !== null
      && typeof sample.cmdline === 'string'
      && (sample.cmdline.includes(runId) || sample.cmdline.includes(bare)
        || (typeof sample.cwd === 'string' && (sample.cwd.includes(runId) || sample.cwd.includes(bare)))))
    .sort((left, right) => left.ts - right.ts);
}

// >= 2 consecutive samples (gap <= 2x the recorder interval) within the proof
// window ending at eventTs.
function provablyAliveBefore(samples, eventTs, windowMs) {
  const windowStart = eventTs - windowMs;
  const inWindow = samples.filter((sample) => sample.ts <= eventTs && sample.ts >= windowStart);
  for (let index = 1; index < inWindow.length; index += 1) {
    if (inWindow[index].ts - inWindow[index - 1].ts <= RECORDER_MAX_GAP_MS) return true;
  }
  return false;
}

function pgidSeenAfter(samples, pgids, eventTs, windowMs) {
  const windowEnd = eventTs + windowMs;
  return samples.some((sample) => sample.ts > eventTs && sample.ts <= windowEnd
    && Number.isInteger(sample.pgid) && pgids.has(sample.pgid));
}

// Returns { observations, ambiguous } — `ambiguous` holds the kill-and-PID-reuse
// cases (INCONCLUSIVE per spec 03) which map to NOT_EVALUABLE when no other
// dimension produced a finding.
function judgeWatchdog(findings, db, chaos) {
  const observations = [];
  const ambiguous = [];
  for (const record of db.abandonments) {
    if (record.reason !== 'liveness_detected') continue;
    const eventTs = parseDbTimestamp(record.created_at);
    if (eventTs === null) {
      observations.push({ run_id: record.run_id, story_id: record.story_id, event_ts: record.created_at, verdict: 'no-timestamp' });
      continue;
    }
    const runId = record.run_id;
    const samples = samplesForRun(chaos.recorderSamples, runId);
    const alive = provablyAliveBefore(samples, eventTs, RECORDER_PROOF_WINDOW_MS);
    const chaosKill = chaosKillForRun(chaos.chaosEntries, runId, eventTs);
    const alivePgids = new Set(samples
      .filter((sample) => sample.ts <= eventTs && sample.ts >= eventTs - RECORDER_PROOF_WINDOW_MS)
      .map((sample) => sample.pgid)
      .filter((pgid) => Number.isInteger(pgid)));
    const reused = chaosKill !== null && pgidSeenAfter(samples, alivePgids, eventTs, RECORDER_AFTER_WINDOW_MS);

    let verdict;
    if (!alive) {
      verdict = 'not-provably-alive';
    } else if (chaosKill !== null && !reused) {
      verdict = 'chaos-explained';
    } else if (chaosKill !== null && reused) {
      verdict = 'pid-reuse-ambiguous';
      ambiguous.push({ run_id: runId, story_id: record.story_id, event_ts: record.created_at });
    } else {
      verdict = 'false-positive';
      findings.add(
        'O4_WATCHDOG_FALSE_POSITIVE',
        'liveness watchdog recovered a provably-alive worker (no chaos kill explains the loss)',
        {
          run_id: runId, story_id: record.story_id, event_ts: record.created_at,
          provably_alive: true, chaos_kill_explained: false,
          proof_sample_count: samples.filter((sample) => sample.ts <= eventTs && sample.ts >= eventTs - RECORDER_PROOF_WINDOW_MS).length,
        },
      );
    }
    observations.push({
      run_id: runId, story_id: record.story_id, event_ts: record.created_at,
      provably_alive: alive, chaos_kill_explained: chaosKill !== null, pid_reuse: reused, verdict,
    });
  }
  return { observations, ambiguous };
}

export function evaluateO4(invocation) {
  const findings = new FindingCollector();
  const db = readDatabase(invocation);
  const runEvents = readRunEvents(invocation);
  const chaos = readChaosLog(invocation);
  const nowMs = Date.now();

  const observations = {
    dead_claim_pgid: judgeDeadClaimPgid(findings, db.steps, nowMs),
    dangling_after_no_work: judgeDanglingClaimAfterNoWork(findings, db),
    retry_budget: judgeRetryBudget(findings, db),
    reroute_budget: judgeRerouteBudget(findings, db),
    abandon_boundary: judgeAbandonBoundary(findings, db),
    watchdog: judgeWatchdog(findings, db, chaos),
  };

  // Event-stream corroboration (no findings derived from it): the product emits
  // story.abandoned + step.worker_lost for the same recoveries the
  // story_abandonments table records.
  const eventCounts = { story_abandoned: 0, worker_lost: 0 };
  for (const row of runEvents.rows) {
    if (row.event.event === 'story.abandoned') eventCounts.story_abandoned += 1;
    if (row.event.event === 'step.worker_lost') eventCounts.worker_lost += 1;
  }

  const ambiguous = observations.watchdog.ambiguous;
  const evidence = [writeEvidenceJson(invocation, 'o4-claim-dispatch-hygiene.json', {
    schema_version: 1,
    captured_at: runEvents.captured_at ?? new Date(nowMs).toISOString(),
    case_id: invocation.context.case.id ?? null,
    run_count: db.runs.length,
    step_count: db.steps.length,
    story_count: db.stories.length,
    abandonment_count: db.abandonments.length,
    run_events_corroboration: eventCounts,
    watchdog_scope: ambiguous.length > 0 ? 'watchdog-pid-reuse' : null,
    finding_ids: findings.toJSON().map((finding) => finding.id),
    dimensions: observations,
  }, 'claim-dispatch-hygiene-judgment')];

  if (findings.length > 0) {
    return { result: 'FAIL', findings: findings.toJSON(), evidence };
  }
  if (ambiguous.length > 0) {
    // kill-and-PID-reuse inside one window → INCONCLUSIVE + manual review
    // (spec 03). NOT_EVALUABLE carries no product finding.
    return { result: 'NOT_EVALUABLE', findings: [], evidence };
  }
  return { result: 'PASS', findings: [], evidence };
}
