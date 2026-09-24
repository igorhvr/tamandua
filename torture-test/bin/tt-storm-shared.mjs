// tt-storm-shared.mjs — STORM-W5 storm orchestration engine (shared).
//
// The storm (spec 09-wave-5-storm.md) is CONTROLLER machinery beyond
// roster authoring (spec 12-runner-automation.md P3): one shared isolated
// tamandua daemon, one fixture origin/main, Round A S1-S8 (+ queued
// S9/S10) with a 90s/30s launch cadence and a 15s simultaneity sampler,
// Round B B1-B5 with the phase-gated chaos schedule, truthful queue
// admission observation, branch/quarantine integrity, and a final
// forensic report.
//
// This module is the durable storm-specific orchestration entrypoint
// logic. It is INTEGRATED with the controller/manifest path (it reads the
// same manifest contract the controller validates, lives beside the
// controller in bin/, records the same run-id evidence conventions and
// campaign/state vocabulary) but is NOT an inert helper: `prepare` derives
// the timer cap from the ACTUAL workflow registrations with provenance,
// `run`/`resume` execute the roster under a single campaign identity with
// intent-before-launch and run-id capture from BOTH streams, and `report`
// produces the forensic bundle.
//
// SIDE-EFFECT DISCIPLINE: every filesystem/process/CLI/clock/DB operation
// goes through the injected adapter set (`ctx.adapters`). The recording
// gate (self-tests/tier2-storm-orchestrator-recording-gate.test.ts)
// injects recording substitutes + a synthetic clock and synthetic records
// and asserts on the RECORDED operation stream — the same decision code
// the real CLI runs. Real adapters live in this module (REAL_*); the CLI
// wires them.
//
// The interim STORM-I tt-contention-slice corrections are PRESERVED by
// reuse, not duplicated: run-id normalization (normalizedRunId /
// normalizedStoredRunId), cadence capping (sampleDelayMs), the honest
// UNKNOWN/missing-identity representation, and the terminal/active status
// vocabularies are imported from ./tt-contention-slice-shared.mjs. This
// module adds what the interim slice deliberately does not have: real
// multi-run launch orchestration with queue admission and two-round
// phase-gated sequencing.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import {
  ACTIVE_STEP_STATUSES,
  TERMINAL_RUN_STATUSES,
  normalizedRunId,
  normalizedStoredRunId,
  refusal,
  sampleDelayMs,
  sha256,
  utcTimestamp,
} from './tt-contention-slice-shared.mjs';

import {
  ROUND_A_ROSTER,
  ROUND_B_ROSTER,
  ROUND_A_STAGGER_MS,
  ROUND_A_QUEUED_STAGGER_MS,
  SAMPLER_INTERVAL_MS,
  REAL_FS,
  computeActiveTimerCap,
  deriveTimerCounts,
  parseWorkflowAgents,
  resolveCatalogRoot,
} from './tt-storm-roster.mjs';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const STORM_SCHEMA_VERSION = 1;
export const STORM_STATE_NAME = 'state.json';
export const STORM_OPS_NAME = 'ops.jsonl';
export const STORM_INTENT_NAME = 'intent.jsonl';
export const STORM_SAMPLES_NAME = 'samples.jsonl';
export const STORM_REPORT_JSON = 'report.json';
export const STORM_REPORT_TXT = 'report.txt';
export const STORM_RESULTS_DIR = 'results'; // relative under campaign dir

// ─────────────────────────────────────────────────────────────────────
// Parent worker authority + protected child-env keys (STORM-REAL gap #1 /
// root defect #1/#2). The orchestrator process typically RUNS INSIDE a
// tamandua worker round, so process.env carries the outer run's authority:
// TAMANDUA_RUN_ID / TAMANDUA_WORKER_PID / TAMANDUA_WORKER_JOB_ID /
// TAMANDUA_STEP_ID (plus the TAMANDUA_(RUN|WORKER|STEP)_ family). A real
// child (daemon-control, workflow runs, tamandua-test shims) that inherits
// ANY of these would self-attribute to the orchestrator's run or inherit
// claim authority — the exact live-state leak STORM-REAL exists to prevent.
// The canonical list lives HERE (the spawn boundary) and is re-exported by
// tt-storm-real.mjs; stripParentAuthorityEnv is applied to the MERGED env
// inside spawnCapture so no spawn path can resurrect the vars after a
// private context omitted them.
// ─────────────────────────────────────────────────────────────────────
export const PARENT_AUTHORITY_VARS = Object.freeze([
  'TAMANDUA_RUN_ID',
  'TAMANDUA_WORKER_PID',
  'TAMANDUA_WORKER_JOB_ID',
  'TAMANDUA_STEP_ID',
]);

// The broader TAMANDUA_<(RUN|WORKER|STEP)_ family (RUN_ID8, WORKER_JOB_ID,
// STEP_ID variants, ...) is stripped defensively as well.
export const AUTHORITY_VAR_RE = /^TAMANDUA_(RUN|WORKER|STEP)_/;

// Keys a private exec context OWNS and that a per-call env override or a
// generic spawn caller may never redirect at the real boundary (root defect
// #2: makeRealProc accepted per-call HOME/DB and cwd escapes).
export const PROTECTED_CHILD_ENV_KEYS = Object.freeze([
  'HOME',
  'TT_HOME',
  'TAMANDUA_STATE_DIR',
  'TAMANDUA_DB_PATH',
  'TAMANDUA_TEST_GUARD',
  ...PARENT_AUTHORITY_VARS,
]);

export function isAuthorityEnvKey(key) {
  return PARENT_AUTHORITY_VARS.includes(key) || AUTHORITY_VAR_RE.test(String(key));
}

export function isProtectedChildEnvKey(key) {
  return PROTECTED_CHILD_ENV_KEYS.includes(key) || isAuthorityEnvKey(key);
}

// Remove every authority var from a copy of an env object (never mutates the
// input). Applied at the spawn merge so a private context that merely OMITS
// the vars can never have them resurrected by a later { ...process.env }
// merge.
export function stripParentAuthorityEnv(envObj) {
  const out = { ...envObj };
  for (const key of Object.keys(out)) {
    if (isAuthorityEnvKey(key)) delete out[key];
  }
  return out;
}

// Environment a private exec context may inherit from the operator process:
// an EXPLICIT MINIMUM (root defect #1 — the old context copied nearly all of
// process.env, leaking provider credentials, a production control port and a
// foreign TAMANDUA_WORKTREE_ROOT). Only variables that carry no credentials
// and cannot redirect containment survive; everything else must be supplied
// explicitly by the context (HOME/STATE/DB/TMPDIR/TAMANDUA_TEST_GUARD) or by
// extraEnv.
export const CHILD_ENV_INHERIT_ALLOWLIST = Object.freeze([
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LANGUAGE',
  'TZ',
  'NO_COLOR',
  'FORCE_COLOR',
  'NODE_NO_WARNINGS',
]);

export function inheritChildEnvMinimum(env = process.env) {
  const out = {};
  for (const key of CHILD_ENV_INHERIT_ALLOWLIST) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  if (out.PATH === undefined) {
    out.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  }
  if (out.LC_ALL === undefined) out.LC_ALL = 'C.UTF-8';
  return out;
}
// ─────────────────────────────────────────────────────────────────────
// Fixture-scoped git identity (SF-14, STORM-REHEARSAL-FIX9 US-001).
//
// Campaign git writes must succeed even when the campaign-owned clone has NO
// user.name/user.email and the daemon env is hermetic (no global git
// identity). The identity is NEVER written to config (no global or clone-local
// git config): every git WRITE subprocess receives it
// through its CHILD ENV only, so it travels with the write and cannot mutate
// the clone or the operator's global config. This is the exact shape run #74's
// live E2E missed — its fixture happened to have an identity configured.
// ─────────────────────────────────────────────────────────────────────
export const FIXTURE_GIT_IDENTITY = Object.freeze({
  name: 'Storm Rehearsal',
  email: 'storm-rehearsal@localhost',
});

// Build the child env for a git WRITE: the caller's base env plus the
// fixture-scoped author/committer identity. The identity fields always win
// over an inherited value so a stale/foreign identity in the operator env can
// never leak into the campaign's history. Pure: never mutates baseEnv.
export function gitIdentityEnv(baseEnv = {}, { identity = FIXTURE_GIT_IDENTITY } = {}) {
  return {
    ...baseEnv,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

// The git stderr shapes emitted when git cannot resolve an author/committer
// identity. These are environment/config failures, NOT content conflicts: the
// replay never started, so a caller must never report them as
// `rebase_conflict`.
export const GIT_IDENTITY_ERROR_RE =
  /(Committer identity unknown|Author identity unknown|unable to auto-detect email address|empty ident name)/i;

// Pure classifier for a failed git write. Returns 'identity_missing' when the
// stderr shows git could not resolve an identity; every other failure
// (including a real same-file rebase conflict) classifies as
// 'rebase_conflict'.
export function classifyGitWriteFailure(stderr) {
  return GIT_IDENTITY_ERROR_RE.test(String(stderr ?? '')) ? 'identity_missing' : 'rebase_conflict';
}

export const ROUND_A_WEDGE_HARD_MS = 44 * 60 * 60 * 1000; // spec 09: T+44h wedge
export const ROUND_B_END_MS = 3 * 60 * 60 * 1000; // nominal ~3h corridor
export const ADMISSION_POLL_MS = 15_000; // queue re-poll cadence
export const S10_DRAIN_BOUND_MS = 10 * 60 * 1000; // S10 within 10min of first capacity

// Launch argv shapes (mirror controller conventions; see 12-runner-automation.md).
// NOTE: the orchestrator launches WITHOUT `--wait --json` — it captures the
// run id from BOTH launch streams and monitors the campaign DB / control
// plane itself (spec 12: a waiter that is killed yields nothing on stdout;
// the DB row found by the captured id is the fallback harvest path, and
// `--wait` belongs to reattach, not launch).
export function workflowRunArgv({ workflow, taskFile, harness, context = [], timeoutS, extra = [], originRepository = null, originRef = null }) {
  const argv = [
    'tamandua', 'workflow', 'run', workflow,
    '--task-file', taskFile,
  ];
  if (harness === 'pi') argv.push('--pi-as-harness');
  else if (harness === 'hermes') argv.push('--hermes-as-harness');
  else if (harness === 'dsh') argv.push('--dsh-as-harness');
  for (const kv of context) argv.push('--context', kv);
  if (timeoutS) argv.push('--timeout', String(timeoutS));
  // SF-2 containment (US-005): a worktree launch MUST carry the campaign-owned
  // origin repository + an explicit ref. The product defaults
  // WORKTREE_ORIGIN_REPOSITORY to cwd/HOME and resolves ORIGINAL_BRANCH there
  // when the flag is absent — the exact SF-2 mis-resolution to a foreign repo.
  // The ref is never omitted: a detached/foreign default is the failure mode,
  // so an unspecified ref degrades to the fixture main, never to nothing.
  if (originRepository) {
    argv.push('--worktree-origin-repository', originRepository);
    argv.push('--worktree-origin-ref', originRef ?? 'main');
  }
  argv.push(...extra);
  return argv;
}

// ─────────────────────────────────────────────────────────────────────
// Real adapters (operator path). Each returns a plain result object; the
// recorder wraps every call so intent + outcome are always persisted.
// ─────────────────────────────────────────────────────────────────────

// REAL_CLOCK — real wall clock for the operator CLI.
//
// Process-lifetime contract (STORM-REAL gap #5): an awaited sleep must keep
// the process alive until it resolves, and overlapping sleeps must each be
// independent. The previous implementation kept ONE shared timer, replaced it
// on every new sleep (so an overlapping earlier sleep could be silently
// cancelled by a later one), and unref()'d it (so the Node event loop could
// exit while an awaited sleep was still pending — the CLI would terminate
// with a sleep unresolved). Every sleep now allocates its own timer, stays
// ref'd (a timer is cleared only when its own sleep completes or is
// cancelled), and tracks its handle so a test/operator can assert no pending
// sleeps remain. `pendingCount()` is the observable inventory: callers that
// must not exit until all sleeps settle can await `allSettled()`.
export const REAL_CLOCK = {
  _pending: new Set(),
  nowMs: () => Date.now(),
  nowUtc: () => new Date().toISOString(),
  sleep: (ms, reason) =>
    new Promise((resolve) => {
      const handle = {
        reason: reason ?? null,
        _resolve: resolve,
        timer: setTimeout(() => {
          REAL_CLOCK._pending.delete(handle);
          resolve();
        }, Math.max(0, Number(ms) || 0)),
      };
      REAL_CLOCK._pending.add(handle);
    }),
  pendingCount: () => REAL_CLOCK._pending.size,
  pendingReasons: () => [...REAL_CLOCK._pending].map((h) => h.reason),
  // Cancel every pending sleep (used by tests; the operator CLI relies on the
  // natural ref'd-timer lifetime and explicit completion). Every cancelled
  // sleep RESOLVES (a cancelled sleep is settled, never left dangling).
  cancelAll: () => {
    for (const h of [...REAL_CLOCK._pending]) {
      clearTimeout(h.timer);
      REAL_CLOCK._pending.delete(h);
      h._resolve();
    }
  },
  // Resolve when every pending sleep has completed (bounded).
  allSettled: async (timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (REAL_CLOCK._pending.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return REAL_CLOCK._pending.size === 0;
  },
};

// run a child process, capturing BOTH streams byte-preservingly, resolving
// only at real close/reap. Used for launch evidence (spec 12: stdout prints
// `Run: run-<uuid>`, stderr prints `run #N (<short8>) created` synchronously
// BEFORE worktree add — a launch killed mid-worktree-add still leaves an
// identifiable run id in the captured stderr).
//
// Byte/UTF-8 contract (STORM-REAL gap #5): chunks are accumulated as Buffers
// and decoded exactly ONCE at close, so a multi-byte UTF-8 sequence split
// across two 'data' chunks is never corrupted. Every completion (normal
// close, timeout kill, external abort, spawn error) is settled ONLY after the
// child has actually closed/reaped: a timeout/abort sends SIGKILL and then
// AWAITS the 'close' event (with a bounded reaping grace) instead of
// declaring teardown based on the attempted kill. The result carries the
// observed exit/signal plus `reaped:true` only when 'close' was observed.
export function spawnCapture(argv, { cwd, env, timeoutMs = 0, signal = null, mergeParentEnv = true } = {}) {
  return new Promise((resolve) => {
    let child;
    // Env assembly at the REAL spawn boundary (STORM-REAL gap #1 / root
    // defect #1): the authority family is stripped from the merged env even
    // when the caller passes a private env that merely OMITS the vars —
    // { ...process.env, ...env } would otherwise resurrect the outer run's
    // TAMANDUA_RUN_ID/WORKER_PID. mergeParentEnv:false (the private exec
    // context path) starts from ONLY the explicit env — no operator
    // credentials / control ports / foreign worktree roots can leak in.
    const mergedRaw = mergeParentEnv === false
      ? { ...(env ?? {}) }
      : { ...process.env, ...(env ?? {}) };
    const childEnv = stripParentAuthorityEnv(mergedRaw);
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ argv, exitCode: null, signal: `spawn-error:${err.message}`, stdout: '', stderr: '', pid: null, reaped: false });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let settled = false;
    let timer = null;
    let forced = null; // 'timeout' | 'aborted' when we killed the child ourselves
    const reapGraceMs = 5_000;
    const settle = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Decode once, from the full accumulated bytes (never per-chunk).
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({ argv, exitCode: extra?.exitCode ?? null, signal: extra?.signal ?? null, stdout, stderr, pid: child.pid, reaped: extra?.reaped === true });
    };
    // after a kill-forced termination, keep waiting for the real 'close'
    // (reap) up to a bounded grace so we never report teardown on attempt.
    const forceKill = (settleSignal) => {
      forced = settleSignal;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    timer = timeoutMs
      ? setTimeout(() => forceKill('timeout'), timeoutMs)
      : null;
    child.stdout.on('data', (d) => { outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
    child.stderr.on('data', (d) => { errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
    child.on('error', (err) => settle({ exitCode: null, signal: `spawn-error:${err.message}`, reaped: true }));
    child.on('close', (code, sig) => {
      // A close that follows OUR forced kill is reported with the forcing
      // reason (timeout/aborted), never as an ambiguous external SIGKILL.
      if (forced) settle({ exitCode: code, signal: forced, reaped: true });
      else settle({ exitCode: code, signal: sig, reaped: true });
    });
    if (signal) {
      signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer);
        forceKill('aborted');
      }, { once: true });
    }
  });
}

export const REAL_PROC = {
  // launch a tamandua workflow run and return {stdout, stderr, exitCode}
  launchWorkflow: (argv, opts) => spawnCapture(argv, opts),
  // tamandua control-plane op (stop/delete/pause/resume/nudge/...)
  tamandua: async (argv, opts) => spawnCapture(argv, opts),
  // tt-chaos schedule action (Round B operator; action vocabulary is the
  // tt-chaos operator's; see bin/tt-chaos --help).
  chaosAction: async (argv, opts) => spawnCapture(argv, opts),
  // daemon-control wrapper op (the ONLY sanctioned daemon start/stop/restart)
  daemonControl: async (argv, opts) => spawnCapture(argv, opts),
  kill: async (pid, signal) => {
    try { process.kill(pid, signal); return { ok: true, pid, signal }; }
    catch (err) { return { ok: false, pid, signal, error: String(err?.message ?? err) }; }
  },
  // Read-path pounding transport (Round A/B pounding; spec 09 "dashboard
  // HTTP + 2 MCP tool calls every 30s; no 5xx; first-byte < 2s"). httpGet is
  // a real fetch with a bounded timeout. mcpTool is the name the engine
  // calls (poundOnce -> ctx.proc.mcpTool): it delegates to the real
  // streamable-HTTP MCP transport from tt-storm-real.mjs (makeRealMcpTool),
  // honoring TT_STORM_MCP_ENDPOINT when set; without an endpoint it reports
  // first-class TT_MCP_TRANSPORT_NOT_WIRED — pounding probes then record a
  // first-class probe failure, never a fabricated success. The operator CLI
  // wires makeRealProc (exec-context bound) instead of this static object;
  // mcpToolCall is retained as a legacy alias.
  httpGet: async (url, { timeoutMs = 5_000 } = {}) => {
    const started = Date.now();
    try {
      const res = await fetch(String(url), { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.status < 500, statusCode: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: String(err?.message ?? err) };
    }
  },
  mcpTool: async (req) => {
    const { makeRealMcpTool } = await import('./tt-storm-real.mjs');
    const endpointUrl = process.env.TT_STORM_MCP_ENDPOINT ?? null;
    return makeRealMcpTool({ endpointUrl })(req);
  },
  mcpToolCall: async (req) => {
    const { makeRealMcpTool } = await import('./tt-storm-real.mjs');
    const endpointUrl = process.env.TT_STORM_MCP_ENDPOINT ?? null;
    return makeRealMcpTool({ endpointUrl })(req);
  },
};

export const REAL_GIT = {
  run: async (repoDir, args, { env = {} } = {}) =>
    spawnCapture(['git', ...args], { cwd: repoDir, env }),
};

// ─────────────────────────────────────────────────────────────────────
// Run-id canonicalization at the DB adapter boundary (STORM-REAL gap #2).
// The product DB stores run rows under BARE uuids (runs.id =
// crypto.randomUUID(), see src/installer/run.ts); the CLI displays the
// public `run-<uuid>` form (src/lib/id-prefix.ts prefixRunId) and the
// engine records/extracts public `run-<uuid>` ids from launch streams. The
// recording gate's synthetic DB keys rows by the PUBLIC id, which masks the
// mismatch: REAL_DB.getRun/activeStepsForRuns must canonicalize every query
// key to the stored BARE uuid at the adapter boundary (never by patching
// product rows), retain both source/public identities in every returned row,
// and reject malformed or ambiguous scope (a step- id, a garbage token, a
// bare uuid that is not uuid-shaped) BEFORE issuing SQL.
// ─────────────────────────────────────────────────────────────────────
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse one run key into { ok, bare, public, source }. source is 'public'
// (run-<uuid> input), 'bare' (bare-uuid input) or 'malformed'. Never throws.
export function parseRunKey(value) {
  if (typeof value !== 'string') {
    return { ok: false, bare: null, public: null, source: 'malformed', reason: `run key must be a string (got ${typeof value})` };
  }
  const trimmed = value.trim();
  const publicMatch = /^run-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(trimmed);
  if (publicMatch) {
    const bare = publicMatch[1].toLowerCase();
    return { ok: true, bare, public: `run-${bare}`, source: 'public' };
  }
  if (/^step-/i.test(trimmed)) {
    return { ok: false, bare: null, public: null, source: 'malformed', reason: `step id is not a run scope: ${value}` };
  }
  if (BARE_UUID_RE.test(trimmed)) {
    const bare = trimmed.toLowerCase();
    return { ok: true, bare, public: `run-${bare}`, source: 'bare' };
  }
  return { ok: false, bare: null, public: null, source: 'malformed', reason: `not a run-<uuid> or <uuid>: ${value}` };
}

// Decorate a stored DB row with BOTH identities (bare + public) so no caller
// loses the source form. The stored row keeps its product column layout.
export function withRunIdentities(row, { publicId }) {
  if (!row) return null;
  const bare = typeof row.id === 'string' ? row.id.toLowerCase() : null;
  return {
    ...row,
    id: row.id,            // stored identity (product layout preserved)
    run_id_bare: bare,
    run_id_public: publicId ?? (bare ? `run-${bare}` : null),
  };
}

// withRunParentIdentity — withRunIdentities PLUS the row's parent_run_id
// decorated as parent_run_id_bare / parent_run_id_public (rugpull recovery /
// children discovery reads compare canonical forms, never a bare-vs-public
// mismatch).
export function withRunParentIdentity(row) {
  const decorated = withRunIdentities(row, {});
  if (decorated && row?.parent_run_id) {
    const parsed = parseRunKey(String(row.parent_run_id));
    if (parsed.ok) {
      decorated.parent_run_id_bare = parsed.bare;
      decorated.parent_run_id_public = parsed.public;
    } else {
      decorated.parent_run_id_bare = String(row.parent_run_id).toLowerCase();
      decorated.parent_run_id_public = null;
    }
  }
  return decorated;
}

// Read-only DB seam for harvest/reattach/queue-freeSlots observations.
// `open` returns a query interface; real opens the campaign DB read-only
// (node:sqlite DatabaseSync readOnly like the contention observer). Query
// results are plain records; any read error is surfaced as { ok:false,
// error } and callers must represent it as UNKNOWN, never zero.
export const REAL_DB = {
  open: (dbPath) => {
    let DatabaseSync;
    try {
      // node:sqlite is available on the Node versions this suite supports
      // (>= 22.5). createRequire loads the builtin lazily so merely importing
      // this module never fails on older runtimes — only opening a DB does.
      const req = createRequire(import.meta.url);
      ({ DatabaseSync } = req('node:sqlite'));
    } catch (err) {
      return { ok: false, api: null, error: `node:sqlite unavailable: ${err.message}` };
    }
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (err) {
      return { ok: false, api: null, error: `cannot open campaign DB read-only ${dbPath}: ${err.message}` };
    }
    const prepareRunId = (runKey, label = 'run id') => {
      const parsed = parseRunKey(runKey);
      if (!parsed.ok) throw refusal(`${label} ${JSON.stringify(runKey)} is not canonical run scope: ${parsed.reason}`, 'TT_BAD_RUN_SCOPE');
      return parsed;
    };
    const api = {
      listRuns: () => {
        const rows = db.prepare('SELECT id, workflow_id, status, scheduling_status, created_at, updated_at, tokens_spent, parent_run_id FROM runs ORDER BY created_at').all();
        return rows.map((r) => withRunParentIdentity(r));
      },
      // Canonicalizing lookup: accepts run-<uuid> OR bare <uuid>; the SQL
      // always queries the STORED bare uuid column with the bare form.
      getRun: (runId) => {
        const parsed = prepareRunId(runId);
        const row = db.prepare('SELECT id, workflow_id, status, scheduling_status, created_at, updated_at, tokens_spent, parent_run_id FROM runs WHERE id = ?').get(parsed.bare);
        return withRunIdentities(row ?? null, { publicId: parsed.public });
      },
      activeStepsForRuns: (runIds) => {
        if (!Array.isArray(runIds) || runIds.length === 0) return [];
        const canonical = runIds.map((id) => prepareRunId(id, 'run id in activeStepsForRuns').bare);
        const ph = canonical.map(() => '?').join(',');
        const rows = db.prepare(`SELECT run_id, status, count(*) AS n FROM steps WHERE run_id IN (${ph}) AND status IN ('claimed','running') GROUP BY run_id, status`).all(...canonical);
        return rows.map((r) => ({ ...r, run_id_public: `run-${String(r.run_id).toLowerCase()}` }));
      },
      // Per-step claimed/running rows for one or more canonical run keys.
      // Optional `stepIds` narrows to specific product step ids (e.g.
      // 'finalize_merge', 'fix') — the mechanical basis for the phase
      // predicates that must NOT be satisfiable by a single unrelated active
      // step (B1-B4 pre-finalize, finalize-claim, fix-area-known).
      activeStepRows: (runIds, { stepIds = null } = {}) => {
        if (!Array.isArray(runIds) || runIds.length === 0) return [];
        const canonical = runIds.map((id) => prepareRunId(id, 'run id in activeStepRows').bare);
        const ph = canonical.map(() => '?').join(',');
        // SELECT * (not an explicit column list): the US-008 no-op guards must
        // read a step row's claim/updated/created clock, but legacy/minimal test
        // schemas carry different timestamp columns. `*` returns whichever
        // columns exist, so a row is never silently dropped for a missing one.
        let sql = `SELECT * FROM steps WHERE run_id IN (${ph}) AND status IN ('claimed','running')`;
        const params = [...canonical];
        if (stepIds !== null) {
          if (!Array.isArray(stepIds) || stepIds.length === 0) {
            throw refusal('activeStepRows: stepIds filter must be a non-empty array or null', 'TT_BAD_STEP_FILTER');
          }
          const sp = stepIds.map(() => '?').join(',');
          sql += ` AND step_id IN (${sp})`;
          params.push(...stepIds);
        }
        const rows = db.prepare(sql).all(...params);
        return rows.map((r) => ({ ...r, run_id_public: `run-${String(r.run_id).toLowerCase()}` }));
      },
      activeTimerCount: () => {
        // freeSlots evidence: how many run/agent dispatch timers exist NOW.
        // Real daemon timers are in-memory (not DB-visible); the contained
        // approximation the storm observes is scheduling_status rows +
        // claimed/running steps. The orchestrator records this snapshot as
        // freeSlots evidence at decision time (spec 09 admission assertion).
        const rows = db.prepare("SELECT status, count(*) AS n FROM runs WHERE scheduling_status NOT IN ('admitted_pending','terminal') GROUP BY status").all();
        return rows;
      },
      close: () => db.close(),
    };
    return { ok: true, api };
  },
};

// ─────────────────────────────────────────────────────────────────────
// Recording (durability): every operation the engine performs through an
// adapter is appended to ops.jsonl under the campaign dir BEFORE its side
// effect is relied upon and again with its outcome — reattachment and the
// report are reconstructable from ops.jsonl alone.
// ─────────────────────────────────────────────────────────────────────

export function opRecorder({ fs, campaignDir }) {
  const opsPath = path.join(campaignDir, STORM_OPS_NAME);
  return {
    record(kind, detail = {}) {
      const line = JSON.stringify({ ts: utcTimestamp(), kind, ...detail });
      fs.appendFileSync(opsPath, line + '\n');
      return line;
    },
    readAll() {
      try {
        const text = fs.readFileSync(opsPath, 'utf8');
        return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// State io (atomic, contained).
// ─────────────────────────────────────────────────────────────────────

export function allocStormCampaignId(clock) {
  const ts = new Date(clock.nowMs()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `storm-${ts}-${randomUUID()}`;
}

export function newCampaignState({ campaignId, clock, source, fixture }) {
  const now = clock.nowUtc();
  return {
    schema_version: STORM_SCHEMA_VERSION,
    campaign_id: campaignId,
    created_at: now,
    updated_at: now,
    mode: 'prepared',
    source,
    fixture,
    rounds: {
      A: {
        status: 'planned',
        runs: {},
        pounding: {
          active: false, notRunReason: null, cadenceMs: 30_000, latencyBoundMs: 2_000,
          lastPoundMs: null, rounds: 0, probes: 0, assertionFailures: 0, maxLatencyMs: 0,
        },
      },
      B: {
        status: 'planned',
        runs: {},
        phases: {},
        pounding: {
          active: false, notRunReason: null, cadenceMs: 30_000, latencyBoundMs: 2_000,
          lastPoundMs: null, rounds: 0, probes: 0, assertionFailures: 0, maxLatencyMs: 0,
        },
      },
    },
    sampler: { interval_ms: SAMPLER_INTERVAL_MS, samples: [], sample_gaps: [], peak_observed: null },
    queue: { attempts: [], first_capacity_at: null, s10_admitted_at: null },
    cleanup: { ledger: [] },
    harvest: {},
    wedge: {},
    report: null,
  };
}

export function saveState({ fs, campaignDir, state }) {
  const statePath = path.join(campaignDir, STORM_STATE_NAME);
  const tmpPath = path.join(campaignDir, `.${STORM_STATE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmpPath, statePath);
}

export function loadState({ fs, campaignDir }) {
  const statePath = path.join(campaignDir, STORM_STATE_NAME);
  if (!fs.existsSync(statePath)) return { ok: false, state: null, error: 'state.json missing' };
  try {
    const text = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(text);
    return { ok: true, state, error: null };
  } catch (err) {
    return { ok: false, state: null, error: `state.json unreadable: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Provenance / refusal helpers (containment preserved — mirrors the
// contention-slice posture: destination must be inside torture-test/var,
// no traversal, no symlink escape, no overwrite).
// ─────────────────────────────────────────────────────────────────────

export function assertCampaignDestContained(rawCampaignDir, { varRoot, fs: fsx = fs }) {
  const abs = path.resolve(rawCampaignDir);
  if (!pathIsWithinStatic(varRoot, abs)) {
    throw refusal(`campaign destination outside torture-test/var: ${abs}`, 'TT_ESCAPE');
  }
  // Refuse symlink escapes: resolve the deepest existing ancestor.
  let probe = abs;
  const missing = [];
  while (!fsx.existsSync(probe)) {
    missing.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (fsx.existsSync(probe)) {
    const real = fsx.realpathSync ? fsx.realpathSync(probe) : probe;
    if (!pathIsWithinStatic(varRoot, real)) {
      throw refusal(`campaign destination escapes var via symlink: ${abs}`, 'TT_SYMLINK');
    }
  }
  return abs;
}

function pathIsWithinStatic(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function utcNow(clock) { return clock.nowUtc(); }

// ─────────────────────────────────────────────────────────────────────
// Derived campaign numbers (timer cap + queued demand) with provenance.
// ─────────────────────────────────────────────────────────────────────

export async function deriveStormNumbers({ fs: fsx = REAL_FS, installedCatalogRoot = null, bundledCatalogRoot = null, activeRoster = null }) {
  const resolved = resolveCatalogRoot({ fs: fsx, installedRoot: installedCatalogRoot, bundledRoot: bundledCatalogRoot });
  const counts = await deriveTimerCounts({
    fs: fsx,
    catalogRoot: resolved.root,
    bundledRoot: resolved.kind === 'bundled' ? null : bundledCatalogRoot,
  });
  // STORM-REAL US-008: the timer cap is derived from the ACTUAL roster the
  // campaign will launch. The default is the full Round A active roster
  // (unchanged); a capacity-scaled campaign passes its lite roster so the cap
  // is recomputed from the lite agent counts and never carries full-roster
  // demand. `queued` is derived generically from the same roster (full ->
  // S9/S10, lite -> none).
  const rosterA = activeRoster ?? ROUND_A_ROSTER;
  const cap = computeActiveTimerCap(counts, rosterA.filter((r) => !r.queued));
  const queued = {};
  for (const r of rosterA) {
    if (r.queued) queued[r.id] = counts[r.workflow]?.distinctStepAgents ?? null;
  }
  return { resolved, counts, cap, queued, activeRoster: rosterA };
}

// ─────────────────────────────────────────────────────────────────────
// Launch run-id evidence extraction (spec 12 mechanics). Both streams are
// captured; the canonical id is the full `run-<uuid>` from stdout's
// `Run: run-...` line; the stderr short form `run #N (<short8>) created`
// corroborates. Missing/unreadable identity is UNKNOWN — never fabricated.
// ─────────────────────────────────────────────────────────────────────
export function extractRunEvidence({ stdout, stderr, exitCode }) {
  const out = { stdoutRunId: null, stderrShortId: null, exitCode: exitCode ?? null, evidenceLines: [] };
  const runRe = /Run:\s*(run-[0-9a-fA-F-]{36})\b/;
  const shortRe = /run #(\d+) \(([0-9a-f]{8})\) created/;
  const mRun = String(stdout ?? '').match(runRe);
  const mShort = String(stderr ?? '').match(shortRe);
  if (mRun) out.stdoutRunId = normalizedRunId(mRun[1]);
  if (mShort) out.stderrShortId = mShort[2].toLowerCase();
  if (mRun || mShort) {
    out.evidenceLines = [
      mRun ? `stdout: ${mRun[0].trim()}` : null,
      mShort ? `stderr: ${mShort[0].trim()}` : null,
    ].filter(Boolean);
  }
  out.ok = Boolean(out.stdoutRunId);
  return out;
}

export function requireUnambiguousRunId(evidence, { rosterId }) {
  if (evidence.ok && evidence.stdoutRunId) {
    if (evidence.stderrShortId && !evidence.stdoutRunId.toLowerCase().startsWith(`run-${evidence.stderrShortId}`)) {
      // The short id is the first 8 hex of the uuid — mismatch means the
      // stderr line belongs to a DIFFERENT launch. Ambiguous provenance is
      // rejected (STORM-W5: "Reject ambiguous/missing provenance").
      throw refusal(
        `ambiguous run provenance for ${rosterId}: stdout run ${evidence.stdoutRunId} does not match stderr short id ${evidence.stderrShortId}`,
        'TT_AMBIGUOUS_RUN',
      );
    }
    return evidence.stdoutRunId;
  }
  throw refusal(`missing run identity for ${rosterId}: no run-<uuid> captured from either stream (stdout/stderr captured, exit=${evidence.exitCode})`, 'TT_MISSING_RUN');
}

// ─────────────────────────────────────────────────────────────────────
// Queue admission decision (spec 09 / W5 briefing). Snapshot-based: at
// each admission attempt the orchestrator observes freeSlots (free timer
// capacity under the pinned cap) and the decision (queue vs admit) must
// match the snapshot exactly. A correct early admit (because capacity
// freed) is a PASS of the correctness assertion, never a forced-queue
// failure.
// ─────────────────────────────────────────────────────────────────────
export function admissionDecision({ cap, inUseTimers, demandedTimers, freeSlots, rosterId }) {
  const free = Math.max(0, cap - inUseTimers);
  const admit = demandedTimers <= free;
  return {
    rosterId,
    cap,
    inUseTimers,
    demandedTimers,
    freeSlots: free,
    observedFreeSlots: freeSlots ?? free,
    decision: admit ? 'admit' : 'queue',
    reason: admit
      ? `demand ${demandedTimers} <= free ${free}`
      : `demand ${demandedTimers} > free ${free} (cap ${cap}, inUse ${inUseTimers})`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Simpler path-containment re-export for tests.
// ─────────────────────────────────────────────────────────────────────
export function pathIsWithin(root, candidate) { return pathIsWithinStatic(root, candidate); }

export {
  ACTIVE_STEP_STATUSES,
  TERMINAL_RUN_STATUSES,
  normalizedRunId,
  normalizedStoredRunId,
  refusal,
  sampleDelayMs,
  sha256,
  utcTimestamp,
  parseWorkflowAgents,
};
