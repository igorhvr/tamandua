#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reapLivePgids, spawnDetachedGroupLeader } from './reap-live-pgids.mjs';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O4 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const RUN_A = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// START in the product's SQLite datetime('now') format (UTC, no timezone).
const START = '2026-08-01 12:00:00';
const CAPTURED = '2026-08-01T12:10:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];

// Live process-group id for the "alive claim" fixture: spawn a detached sleep
// whose PID is its own PGID (spawn detached makes the child a group leader).
// The oracle probes it with kill(-pgid, 0) — the product's liveness probe.
// Records carry { pid, pgid, startTime } (the detached child's process-start
// identity, read immediately after spawn) so the reapers can verify identity
// before SIGKILL — a stale/reused pgid record can never be signalled (the
// US-010 / FIX9.1 stale-orphan class).
const livePgids = [];
function spawnLivePgid() {
  const record = spawnDetachedGroupLeader('sleep', ['300']);
  livePgids.push({ pid: record.pid, pgid: record.pgid, startTime: record.startTime });
  return record.pid;
}

// SQLite-format timestamp helpers (offsets from START in seconds).
function at(seconds) {
  const base = Date.parse(`${START.replace(' ', 'T')}Z`);
  return new Date(base + seconds * 1000).toISOString();
}
function dbAt(seconds) {
  return at(seconds).replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function bare(runId) {
  return runId.slice(4);
}

function chaosEntry(runId, action, outcome, seconds, extra = {}) {
  return { ts: at(seconds), action, runId, outcome, ...extra };
}

function recorderSample(runId, pid, pgid, seconds, extra = {}) {
  return {
    ts: at(seconds), pid, pgid, ppid: 1,
    cwd: `/repo/torture-test/var/runs/${bare(runId)}`,
    cmdline: `node /repo/torture-test/var/harness-${bare(runId)} --run ${runId}`,
    rss: 120000, fd: 24, ...extra,
  };
}

function eventRow(runId, eventName, seconds, line, extra = {}) {
  return { archive: 'all.jsonl', line, event: { ts: at(seconds), event: eventName, runId, ...extra } };
}

function attempt(runId, status) {
  return {
    id: `attempt-${bare(runId)[0]}`, kind: 'workflow', phase: 'terminal', execution_mode: 'real',
    run_id: runId, started_at: at(0), terminal_at: at(60), terminal_status: status,
    tokens_observed: 0, command_result: { exit_code: status === 'completed' ? 0 : 1, signal: null },
    steps_snapshot: null, straggler_capture: null,
  };
}

function reference(campaign, file, source) {
  return {
    path: path.relative(campaign, file).split(path.sep).join('/'),
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    captured_at: CAPTURED,
    source,
  };
}

function writeSnapshot(campaign, snapshots, name, value) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, 'self-test-fixture');
}

// ── Database builders ─────────────────────────────────────────────────────

function createDatabase(databasePath, { runs, steps, stories, abandonments }) {
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, run_number INTEGER NOT NULL, status TEXT NOT NULL, tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, status TEXT NOT NULL, step_index INTEGER NOT NULL DEFAULT 0, retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4, reroute_count INTEGER DEFAULT 0, abandoned_count INTEGER DEFAULT 0, claim_pid INTEGER, claim_pgid INTEGER, claim_job_id TEXT, claim_updated_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE stories (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, story_id TEXT NOT NULL, status TEXT NOT NULL, story_index INTEGER NOT NULL DEFAULT 0, retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4, abandoned_count INTEGER DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE story_abandonments (id TEXT PRIMARY KEY, story_id TEXT NOT NULL, run_id TEXT NOT NULL, reason TEXT NOT NULL, abandoned_count INTEGER NOT NULL, step_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER NOT NULL);`);
  const insertRun = database.prepare('INSERT INTO runs (id, run_number, status, tokens_spent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const run of runs) {
    insertRun.run(bare(run.id), run.run_number ?? 1, run.status, 0, at(0), at(60));
  }
  const insertStep = database.prepare(`INSERT INTO steps (id, run_id, step_id, status, step_index, retry_count, max_retries, reroute_count, abandoned_count, claim_pid, claim_pgid, claim_job_id, claim_updated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const step of steps) {
    insertStep.run(
      step.id, bare(step.run_id), step.step_id, step.status, step.step_index ?? 0,
      step.retry_count ?? 0, step.max_retries ?? 4, step.reroute_count ?? 0, step.abandoned_count ?? 0,
      step.claim_pid ?? null, step.claim_pgid ?? null, step.claim_job_id ?? null,
      step.claim_updated_at ?? null, step.updated_at ?? at(0),
    );
  }
  const insertStory = database.prepare(`INSERT INTO stories (id, run_id, story_id, status, story_index, retry_count, max_retries, abandoned_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const story of stories) {
    insertStory.run(
      story.id, bare(story.run_id), story.story_id, story.status, story.story_index ?? 0,
      story.retry_count ?? 0, story.max_retries ?? 4, story.abandoned_count ?? 0, at(0),
    );
  }
  const insertAbandonment = database.prepare('INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const record of abandonments) {
    insertAbandonment.run(record.id, record.story_id, bare(record.run_id), record.reason, record.abandoned_count ?? 1, record.step_id ?? null, record.created_at ?? at(0));
  }
  database.prepare('INSERT INTO tamandua_stats VALUES (1, 0)').run();
  database.close();
  fs.chmodSync(databasePath, 0o400);
}

// ── Fixture definitions ────────────────────────────────────────────────────

const STEP_IMPL = 'step-11111111-1111-4111-8111-111111111111';
const STEP_IMPL_B = 'step-22222222-2222-4222-8222-222222222222';
const STORY_1 = 'story-33333333-3333-4333-8333-333333333333';

const CASES = [
  {
    name: 'o4-green-clean',
    expected: 'PASS',
    runId: RUN_A,
    livePgid: true,
    db: () => {
      const livePgid = spawnLivePgid();
      return {
        runs: [{ id: RUN_A, status: 'running' }],
        steps: [{
          id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'running', step_index: 1,
          retry_count: 1, max_retries: 4, reroute_count: 0, abandoned_count: 0,
          claim_pid: livePgid, claim_pgid: livePgid, claim_job_id: 'job-1', claim_updated_at: dbAt(0), updated_at: dbAt(0),
        }],
        stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'pending', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 0 }],
        abandonments: [],
      };
    },
    events: (runId) => [eventRow(runId, 'run.started', 0, 1)],
  },
  {
    name: 'o4-green-no-work-reclaimed',
    expected: 'PASS',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'running', step_index: 1,
        retry_count: 0, max_retries: 4, reroute_count: 0, abandoned_count: 0,
        // claim_pgid is null (legacy-style claim) so the dead-pgid dimension
        // does not judge it; the no-work re-claim check is the focus here.
        claim_pid: 4242, claim_pgid: null, claim_job_id: 'job-2', claim_updated_at: dbAt(5), updated_at: dbAt(5),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'running', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 1 }],
      // A NO_WORK round released the claim at +1s; the step was legitimately
      // re-claimed at +5s (claim_updated_at AFTER the release) — not dangling.
      abandonments: [{ id: 'abnd-1', story_id: STORY_1, run_id: RUN_A, reason: 'no_work_release', abandoned_count: 1, step_id: STEP_IMPL, created_at: dbAt(1) }],
    }),
    events: (runId) => [
      eventRow(runId, 'story.abandoned', 1, 1, { stepId: 'implement', storyId: 'US-001', reason: 'no_work_release', abandonedCount: 1 }),
      eventRow(runId, 'step.worker_lost', 1, 2),
    ],
  },
  {
    name: 'o4-green-abandon-enforced',
    expected: 'PASS',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'failed' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'failed', step_index: 1,
        retry_count: 4, max_retries: 4, reroute_count: 0, abandoned_count: 5,
        claim_pid: null, claim_pgid: null, claim_job_id: null, claim_updated_at: null, updated_at: dbAt(10),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'failed', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 9 }],
      // The boundaries WERE enforced: the 9th story loss failed the story and
      // the 5th step reset failed the step.
      abandonments: [{ id: 'abnd-9', story_id: STORY_1, run_id: RUN_A, reason: 'worker_lost', abandoned_count: 9, step_id: STEP_IMPL, created_at: dbAt(9) }],
    }),
    events: (runId) => [eventRow(runId, 'story.abandoned', 9, 1, { stepId: 'implement', storyId: 'US-001', reason: 'worker_lost', abandonedCount: 9 })],
  },
  {
    name: 'o4-dead-claim-pgid',
    expected: 'FAIL',
    finding: 'O4_DEAD_CLAIM_PGID',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'running', step_index: 1,
        retry_count: 0, max_retries: 4, reroute_count: 0, abandoned_count: 0,
        // 2147483647 > pid_max on any Linux host — provably dead.
        claim_pid: 2147483647, claim_pgid: 2147483647, claim_job_id: 'job-1', claim_updated_at: dbAt(0), updated_at: dbAt(0),
      }],
      stories: [],
      abandonments: [],
    }),
    events: (runId) => [eventRow(runId, 'run.started', 0, 1)],
  },
  {
    name: 'o4-dangling-claim-no-work',
    expected: 'FAIL',
    finding: 'O4_DANGLING_CLAIM_AFTER_NO_WORK',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'running', step_index: 1,
        retry_count: 0, max_retries: 4, reroute_count: 0, abandoned_count: 0,
        claim_pid: 5150, claim_pgid: 5150, claim_job_id: 'job-1', claim_updated_at: dbAt(0), updated_at: dbAt(0),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'running', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 1 }],
      // The NO_WORK round released the claim at +1s, but the step is STILL
      // claimed at snapshot time with a claim_updated_at before the release.
      abandonments: [{ id: 'abnd-1', story_id: STORY_1, run_id: RUN_A, reason: 'no_work_release', abandoned_count: 1, step_id: STEP_IMPL, created_at: dbAt(1) }],
    }),
    events: (runId) => [eventRow(runId, 'story.abandoned', 1, 1, { stepId: 'implement', storyId: 'US-001', reason: 'no_work_release', abandonedCount: 1 })],
  },
  {
    name: 'o4-retry-budget',
    expected: 'FAIL',
    finding: 'O4_RETRY_BUDGET_EXCEEDED',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'pending', step_index: 1,
        retry_count: 5, max_retries: 4, reroute_count: 0, abandoned_count: 0,
        claim_pid: null, claim_pgid: null, claim_job_id: null, claim_updated_at: null, updated_at: dbAt(0),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'pending', story_index: 0, retry_count: 5, max_retries: 4, abandoned_count: 0 }],
      abandonments: [],
    }),
    events: (runId) => [eventRow(runId, 'run.started', 0, 1)],
  },
  {
    name: 'o4-reroute-budget',
    expected: 'FAIL',
    finding: 'O4_REROUTE_BUDGET_EXCEEDED',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'finalize_merge', status: 'waiting', step_index: 3,
        retry_count: 0, max_retries: 4, reroute_count: 3, abandoned_count: 0,
        claim_pid: null, claim_pgid: null, claim_job_id: null, claim_updated_at: null, updated_at: dbAt(0),
      }],
      stories: [],
      abandonments: [],
    }),
    events: (runId) => [eventRow(runId, 'run.started', 0, 1)],
  },
  {
    name: 'o4-abandon-boundary',
    expected: 'FAIL',
    finding: 'O4_ABANDON_BUDGET_EXCEEDED',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'pending', step_index: 1,
        retry_count: 0, max_retries: 4, reroute_count: 0, abandoned_count: 4,
        claim_pid: null, claim_pgid: null, claim_job_id: null, claim_updated_at: null, updated_at: dbAt(0),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'pending', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 9 }],
      abandonments: [],
    }),
    events: (runId) => [eventRow(runId, 'run.started', 0, 1)],
  },
  {
    name: 'o4-watchdog-false-positive',
    expected: 'FAIL',
    finding: 'O4_WATCHDOG_FALSE_POSITIVE',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      // The watchdog recovery requeued the step (pending, claim cleared).
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'pending', step_index: 1,
        retry_count: 0, max_retries: 4, reroute_count: 0, abandoned_count: 1,
        claim_pid: null, claim_pgid: null, claim_job_id: null, claim_updated_at: null, updated_at: dbAt(10),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'pending', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 1 }],
      // The liveness watchdog declared the worker dead at +10s, but the
      // recorder has >= 2 consecutive samples of the worker (cmdline ties it
      // to the run) at +1s and +6s — provably alive — and no chaos kill entry
      // explains the loss: a false positive.
      abandonments: [{ id: 'abnd-ld', story_id: STORY_1, run_id: RUN_A, reason: 'liveness_detected', abandoned_count: 1, step_id: STEP_IMPL, created_at: dbAt(10) }],
    }),
    chaos: (runId) => ({
      chaosLogLines: [],
      recorderSamples: [
        recorderSample(runId, 7001, 7001, 1),
        recorderSample(runId, 7001, 7001, 6),
      ],
    }),
    events: (runId) => [
      eventRow(runId, 'story.abandoned', 10, 1, { stepId: 'implement', storyId: 'US-001', reason: 'liveness_detected', abandonedCount: 1 }),
      eventRow(runId, 'step.worker_lost', 10, 2),
    ],
  },
  {
    name: 'o4-watchdog-chaos-explained',
    expected: 'PASS',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'pending', step_index: 1,
        retry_count: 0, max_retries: 4, reroute_count: 0, abandoned_count: 1,
        claim_pid: null, claim_pgid: null, claim_job_id: null, claim_updated_at: null, updated_at: dbAt(10),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'pending', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 1 }],
      // The worker was provably alive AND a chaos kill-harness injection fired
      // at +9s — the loss is explained, not a watchdog false positive.
      abandonments: [{ id: 'abnd-ld', story_id: STORY_1, run_id: RUN_A, reason: 'liveness_detected', abandoned_count: 1, step_id: STEP_IMPL, created_at: dbAt(10) }],
    }),
    chaos: (runId) => ({
      chaosLogLines: [chaosEntry(runId, 'kill-harness', 'fired', 9, { target: 'pid:7001', signal: 'SIGKILL' })],
      recorderSamples: [
        recorderSample(runId, 7001, 7001, 1),
        recorderSample(runId, 7001, 7001, 6),
      ],
    }),
    events: (runId) => [
      eventRow(runId, 'story.abandoned', 10, 1, { stepId: 'implement', storyId: 'US-001', reason: 'liveness_detected', abandonedCount: 1 }),
      eventRow(runId, 'step.worker_lost', 10, 2),
    ],
  },
  {
    name: 'o4-watchdog-pid-reuse',
    expected: 'NOT_EVALUABLE',
    runId: RUN_A,
    db: () => ({
      runs: [{ id: RUN_A, status: 'running' }],
      steps: [{
        id: STEP_IMPL, run_id: RUN_A, step_id: 'implement', status: 'pending', step_index: 1,
        retry_count: 0, max_retries: 4, reroute_count: 0, abandoned_count: 1,
        claim_pid: null, claim_pgid: null, claim_job_id: null, claim_updated_at: null, updated_at: dbAt(10),
      }],
      stories: [{ id: STORY_1, run_id: RUN_A, story_id: 'US-001', status: 'pending', story_index: 0, retry_count: 0, max_retries: 4, abandoned_count: 1 }],
      // A chaos kill fired at +9s AND the same pgid appears in samples after
      // the recovery (+12s) — kill-and-PID-reuse inside one window:
      // INCONCLUSIVE per spec 03 → NOT_EVALUABLE (no other dimension flagged).
      abandonments: [{ id: 'abnd-ld', story_id: STORY_1, run_id: RUN_A, reason: 'liveness_detected', abandoned_count: 1, step_id: STEP_IMPL, created_at: dbAt(10) }],
    }),
    chaos: (runId) => ({
      chaosLogLines: [chaosEntry(runId, 'kill-harness', 'fired', 9, { target: 'pid:7001', signal: 'SIGKILL' })],
      recorderSamples: [
        recorderSample(runId, 7001, 7001, 1),
        recorderSample(runId, 7001, 7001, 6),
        recorderSample(runId, 7001, 7001, 12),
      ],
    }),
    events: (runId) => [
      eventRow(runId, 'story.abandoned', 10, 1, { stepId: 'implement', storyId: 'US-001', reason: 'liveness_detected', abandonedCount: 1 }),
      eventRow(runId, 'step.worker_lost', 10, 2),
    ],
  },
];

for (const fixture of CASES) {
  const campaign = path.join(workspace, fixture.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidence = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });

  const runId = fixture.runId;
  const databasePath = path.join(snapshots, 'database.sqlite');
  createDatabase(databasePath, fixture.db());

  const chaosSpec = fixture.chaos?.(runId) ?? { chaosLogLines: [], recorderSamples: [] };
  const chaosLogLines = [
    ...chaosSpec.chaosLogLines.map((entry) => JSON.stringify(entry)),
    ...(chaosSpec.recorderSamples.length > 0 ? ['# recorder-samples'] : []),
    ...chaosSpec.recorderSamples.map((sample) => JSON.stringify(sample)),
  ];
  const chaosLogPath = path.join(snapshots, 'chaos.log');
  fs.writeFileSync(chaosLogPath, `${chaosLogLines.join('\n')}${chaosLogLines.length > 0 ? '\n' : ''}`, { mode: 0o400, flag: 'wx' });

  const rows = fixture.events(runId).map((row, index) => ({ ...row, line: index + 1 }));
  const references = Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', {
    schema_version: 1, captured_at: CAPTURED, run_ids: [runId], rows,
  });
  references.chaos_log = reference(campaign, chaosLogPath, 'self-test-fixture');

  const context = {
    contract_version: 1, oracle_id: 'O4',
    campaign: { id: `campaign-${fixture.name}`, created_at: at(0), manifest: { sha256: '2'.repeat(64), case_count: 1, case_ids: [fixture.name] } },
    case: { id: fixture.name, wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts', harness: 'pi', class: 'verification', caps: { tokens: 500000, wall_min: 148 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: runId,
    attempts: [attempt(runId, 'running')],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 3, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidence, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
}

// Record the live pgids for the test to reap (the sleep processes outlive the
// generator so the oracle can probe them; the test kills them in cleanup).
// Each record carries { pid, pgid, startTime } — the reapers verify
// process-start identity against the current /proc state (linux-only source;
// an explicit darwin branch is unnecessary because verification failure on a
// /proc-less host simply skips the record — guarded, MACP3 US-003) before SIGKILL.
const livePgidsPath = path.join(workspace, 'live-pgids.json');
fs.writeFileSync(livePgidsPath, `${JSON.stringify(livePgids)}\n`, { flag: 'wx' });

// If anything above failed mid-generation, the detached sleeps would leak
// (reparented to init, invisible to the battery's descendant cleanup).
// Reap them through the identity-verified reaper — a stale/reused pgid
// record is never signalled.
process.on('uncaughtException', (error) => {
  reapLivePgids(livePgids);
  throw error;
});
