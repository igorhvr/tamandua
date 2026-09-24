// tt-storm-spend.mjs — STORM-REAL US-005 REAL campaign spend accounting.
//
// A REAL storm spends real tokens. The campaign must be able to state, at any
// observation tick, how many tokens the product itself attributed to each
// harness/provider, split into LOCAL-ENDPOINT tokens (pi/hermes against the
// operator's local model: counted and reported, but cost 0) and PAID tokens
// (dsh against its paid provider). This module is that accounting:
//
//   * The ONLY token source is the product's own attribution — the
//     `runs.tokens_spent` column of the campaign's PRIVATE product DB, read
//     through the canonicalizing DB seam (REAL_DB / parseRunKey in
//     tt-storm-shared.mjs). Run keys are canonicalized to the stored bare
//     uuid at the reader boundary; a public `run-<uuid>` key from the
//     orchestrator's state and a bare uuid in the DB always resolve to the
//     same run.
//   * A harness is attributed from the campaign's PERSISTED roster/run
//     records (state.rounds.A/B.runs[rosterId].harness, plus its children,
//     which inherit the parent's harness) — never inferred from a binary name
//     or a workflow id.
//   * An unreadable/missing/throwaway DB is reported as UNKNOWN with every
//     numeric field null — NEVER a fabricated 0. A readable DB with no runs
//     legitimately reports 0.
//
// The module is pure with respect to I/O: the DB opener, the fs adapter and
// the tick timestamp are injectable (the orchestrator wires the real ones).
// `sumSpendSnapshot` is a pure function over already-read rows so the
// per-provider arithmetic, the local/paid split and the UNKNOWN path are
// unit-testable with zero real reads.

import { REAL_DB, STORM_RESULTS_DIR, parseRunKey } from './tt-storm-shared.mjs';
import { refusal, utcTimestamp } from './tt-contention-slice-shared.mjs';
import { isRealProfile } from './tt-storm-profile.mjs';

// Schema identity of results/spend.json. Bumping this is a contract change.
export const SPEND_SCHEMA_VERSION = 1;

// Relative (under the campaign dir) name of the spend artifact.
export const SPEND_FILE_NAME = 'spend.json';

export const SPEND_STATUS_KNOWN = 'known';
export const SPEND_STATUS_UNKNOWN = 'unknown';

export const PROVIDER_CLASS_LOCAL = 'local';
export const PROVIDER_CLASS_PAID = 'paid';

// The three roster harnesses and their cost class. pi/hermes run against the
// operator's LOCAL model endpoint on this host (counted, reported, cost 0);
// dsh runs against its PAID provider (the only paid provider in the roster).
export const HARNESS_PROVIDER_CLASS = Object.freeze({
  pi: PROVIDER_CLASS_LOCAL,
  hermes: PROVIDER_CLASS_LOCAL,
  dsh: PROVIDER_CLASS_PAID,
});

// Canonical display/sum order. Kept explicit so the report schema is stable.
export const SPEND_PROVIDER_ORDER = Object.freeze(['pi', 'hermes', 'dsh']);

// ─────────────────────────────────────────────────────────────────────
// Spend cap (STORM-REAL US-006).
//
// A REAL campaign must carry a HARD token cap. The cap is a first-class
// persisted identity (state.rehearsal.spend_cap + descriptor.spend_cap) with
// an explicit scope:
//
//   * total — the cap covers every counted token (local endpoint + paid +
//     unattributed): the safe default;
//   * paid — the cap covers ONLY paid-provider tokens (dsh); local-endpoint
//     pi/hermes tokens are counted/reported but never consume the paid cap.
//
// The arithmetic here is PURE over an already-collected spend snapshot, so the
// scope semantics and the crossing decision are unit-testable against injected
// snapshots with no DB/harness/daemon. It never fabricates a number: an
// UNKNOWN spend snapshot yields status 'unknown' (never a crossing verdict).
// ─────────────────────────────────────────────────────────────────────

export const SPEND_CAP_SCOPES = Object.freeze(['paid', 'total']);
export const DEFAULT_SPEND_CAP_SCOPE = 'total';

// Parse an operator-supplied --spend-cap-tokens value. Omitted (undefined/null)
// or blank -> null (the caller decides whether a cap is required). A supplied
// value must be a non-negative integer; anything else refuses TT_USAGE before
// any effect.
export function parseSpendCapTokens(value = undefined) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0) return value;
    throw refusal(`spend cap tokens must be a non-negative integer (got ${JSON.stringify(value)})`, 'TT_USAGE');
  }
  if (typeof value !== 'string') {
    throw refusal(`spend cap tokens must be a non-negative integer (got ${JSON.stringify(value)})`, 'TT_USAGE');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw refusal(`spend cap tokens must be a non-negative integer (got ${JSON.stringify(value)})`, 'TT_USAGE');
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw refusal(`spend cap tokens must be a non-negative safe integer (got ${JSON.stringify(value)})`, 'TT_USAGE');
  }
  return parsed;
}

// Parse an operator-supplied --spend-cap-scope value. Omitted (undefined/null)
// or blank -> the safe default 'total'. An unknown scope refuses TT_USAGE.
export function parseSpendCapScope(value = undefined) {
  if (value === undefined || value === null) return DEFAULT_SPEND_CAP_SCOPE;
  if (typeof value !== 'string') {
    throw refusal(`spend cap scope must be paid|total (got ${JSON.stringify(value)})`, 'TT_USAGE');
  }
  const scope = value.trim();
  if (scope === '') return DEFAULT_SPEND_CAP_SCOPE;
  if (!SPEND_CAP_SCOPES.includes(scope)) {
    throw refusal(`unknown spend cap scope ${JSON.stringify(value)} (expected paid|total)`, 'TT_USAGE');
  }
  return scope;
}

// The persisted cap record for a campaign, or null when absent/malformed. The
// reader accepts the canonical { tokens, scope } shape (and the legacy
// cap_tokens alias) — never a guess.
export function spendCapFromState(state) {
  const record = state?.rehearsal?.spend_cap ?? state?.spend_cap ?? null;
  if (!record || typeof record !== 'object') return null;
  const rawTokens = record.tokens ?? record.cap_tokens;
  const tokens = Number(rawTokens);
  if (!Number.isFinite(tokens) || tokens < 0) return null;
  const scope = record.scope === 'paid' ? 'paid' : 'total';
  return { tokens, scope };
}

// Resolve the effective cap for a profile from operator input. A REAL profile
// REQUIRES a cap (operand present and parseable); a non-REAL profile is
// unaffected (null when no cap was supplied). The returned frozen record is
// what prepare persists into state/descriptor — never a re-derivation.
export function resolveSpendCapForProfile(profile, rawTokens = undefined, rawScope = undefined) {
  const tokens = parseSpendCapTokens(rawTokens);
  const scope = parseSpendCapScope(rawScope);
  if (isRealProfile(profile) && tokens === null) {
    throw refusal(
      'REAL profile requires a hard spend cap: pass --spend-cap-tokens <n> (with optional --spend-cap-scope paid|total, default total) — a real storm is refused without one',
      'TT_USAGE',
    );
  }
  if (tokens === null) return null;
  return Object.freeze({ tokens, scope });
}

// Resolve the effective cap for a LAUNCHING route (run/rehearse). A REAL
// campaign REQUIRES the operator to re-supply the cap on the launching command
// AND that it match the cap persisted at prepare EXACTLY — a missing or
// silently-substituted cap can never launch a real storm. A non-REAL profile
// is unaffected (returns the persisted cap, normally null). Pure verdict (never
// throws) so a CLI can map it to an exit code and tests can assert it.
export function resolveLaunchSpendCap({ profile, persisted = null, rawTokens = undefined, rawScope = undefined } = {}) {
  if (!isRealProfile(profile)) return { ok: true, cap: persisted ?? null, code: null, reason: null };
  if (rawTokens === undefined || rawTokens === null || String(rawTokens).trim() === '') {
    return {
      ok: false,
      cap: null,
      code: 'TT_USAGE',
      reason: 'REAL campaign requires --spend-cap-tokens <n> on run/rehearse (the hard cap persisted at prepare)',
    };
  }
  let flagCap;
  try {
    // `profile` is REAL here (the non-REAL branch returned above).
    flagCap = resolveSpendCapForProfile(profile, rawTokens, rawScope);
  } catch (err) {
    return { ok: false, cap: null, code: err?.code ?? 'TT_USAGE', reason: err?.message ?? String(err) };
  }
  if (!persisted) {
    return {
      ok: false,
      cap: null,
      code: 'TT_USAGE',
      reason: 'REAL campaign carries no persisted spend cap (prepared before the cap existed) — re-prepare with --spend-cap-tokens <n>',
    };
  }
  if (persisted.tokens !== flagCap.tokens || persisted.scope !== flagCap.scope) {
    return {
      ok: false,
      cap: null,
      code: 'TT_USAGE',
      reason: `--spend-cap-tokens/--spend-cap-scope disagree with the campaign's persisted cap (persisted ${persisted.scope}:${persisted.tokens}, given ${flagCap.scope}:${flagCap.tokens}) — the persisted cap is authoritative`,
    };
  }
  return { ok: true, cap: persisted, code: null, reason: null };
}

// The number of tokens the cap counts for a scope, from an already-collected
// spend snapshot. 'paid' counts ONLY paid-provider tokens (never
// local-endpoint pi/hermes); 'total' counts every counted token including the
// explicitly-unattributed bucket. Returns null for an UNKNOWN snapshot — never
// a fabricated 0.
export function capObservedTokens(snapshot, scope = DEFAULT_SPEND_CAP_SCOPE) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.status !== SPEND_STATUS_KNOWN) return null;
  const raw = scope === 'paid' ? (snapshot.paid_tokens ?? snapshot.billable_tokens) : snapshot.total_tokens;
  return Number.isFinite(raw) ? raw : null;
}

// Pure cap verdict against an injected spend snapshot. status is one of
// 'no_cap' | 'ok' | 'crossed' | 'unknown'. An UNKNOWN snapshot is never a
// fabricated crossing: the caller keeps observing and the previous tick stands.
export function evaluateSpendCap(snapshot, cap) {
  const scope = cap?.scope === 'paid' ? 'paid' : DEFAULT_SPEND_CAP_SCOPE;
  const capTokens = cap ? Number(cap.tokens) : NaN;
  if (!cap || !Number.isFinite(capTokens) || capTokens < 0) {
    return { status: 'no_cap', scope: null, cap: null, observed: null, remaining: null, reason: 'no spend cap configured' };
  }
  const observed = capObservedTokens(snapshot, scope);
  if (observed === null) {
    return {
      status: 'unknown',
      scope,
      cap: capTokens,
      observed: null,
      remaining: null,
      reason: `spend is UNKNOWN (${snapshot?.reason ?? 'no snapshot'}) — the ${capTokens}-token ${scope} cap is not judgeable this tick`,
    };
  }
  const remaining = capTokens - observed;
  if (observed > capTokens) {
    return {
      status: 'crossed',
      scope,
      cap: capTokens,
      observed,
      remaining,
      reason: `${scope} spend ${observed} crossed the ${capTokens}-token cap`,
    };
  }
  return {
    status: 'ok',
    scope,
    cap: capTokens,
    observed,
    remaining,
    reason: `${scope} spend ${observed} within the ${capTokens}-token cap`,
  };
}

// Normalize a persisted harness name. Unknown/empty -> null (never guessed).
function normalizeHarness(value) {
  if (typeof value !== 'string') return null;
  const harness = value.trim().toLowerCase();
  return harness === '' ? null : harness;
}

// The provider class of one harness name: 'local' | 'paid' | null (unknown).
export function providerClassForHarness(harness) {
  const normalized = normalizeHarness(harness);
  if (normalized === null) return null;
  return HARNESS_PROVIDER_CLASS[normalized] ?? null;
}

// True when the harness is a LOCAL-endpoint harness (counted, cost 0).
export function isLocalHarness(harness) {
  return providerClassForHarness(harness) === PROVIDER_CLASS_LOCAL;
}

// True when the harness is a PAID harness.
export function isPaidHarness(harness) {
  return providerClassForHarness(harness) === PROVIDER_CLASS_PAID;
}

// ─────────────────────────────────────────────────────────────────────
// Roster/run -> harness attribution, read from the persisted campaign state.
// The run id recorded on a run record is the public `run-<uuid>` form the
// orchestrator captured; children inherit the parent record's harness.
// Malformed/unknown entries are skipped (and surfaced) — never attributed by
// guess.
// ─────────────────────────────────────────────────────────────────────
export function spendAssignmentsFromState(state) {
  const assignments = [];
  const skipped = [];
  const seen = new Set();
  const rounds = state?.rounds;
  if (!rounds || typeof rounds !== 'object') return { assignments, skipped };
  for (const round of Object.keys(rounds)) {
    const runs = rounds[round]?.runs;
    if (!runs || typeof runs !== 'object') continue;
    for (const rosterId of Object.keys(runs)) {
      const rec = runs[rosterId];
      if (!rec || typeof rec !== 'object') continue;
      const harness = normalizeHarness(rec.harness);
      const workflow = typeof rec.workflow === 'string' ? rec.workflow : null;
      const own = parseRunKey(rec.runId);
      if (own.ok) {
        if (!seen.has(own.bare)) {
          seen.add(own.bare);
          assignments.push({
            run_id: own.public,
            run_id_bare: own.bare,
            harness,
            workflow,
            round,
            roster_id: rosterId,
            parent_run_id: null,
            derived_from: 'run',
          });
        }
      } else if (rec.runId != null) {
        skipped.push({ round, roster_id: rosterId, run_id: rec.runId, reason: own.reason });
      }
      const children = Array.isArray(rec.children) ? rec.children : [];
      for (const child of children) {
        const childRunId = typeof child === 'string' ? child : child?.runId;
        const parsed = parseRunKey(childRunId);
        if (!parsed.ok) {
          if (childRunId != null) {
            skipped.push({ round, roster_id: rosterId, run_id: childRunId, reason: parsed.reason, child: true });
          }
          continue;
        }
        if (seen.has(parsed.bare)) continue;
        seen.add(parsed.bare);
        assignments.push({
          run_id: parsed.public,
          run_id_bare: parsed.bare,
          harness,
          workflow: typeof child === 'object' && typeof child.workflow === 'string' ? child.workflow : workflow,
          round,
          roster_id: rosterId,
          parent_run_id: own.ok ? own.public : (rec.runId ?? null),
          derived_from: 'child',
        });
      }
    }
  }
  assignments.sort((a, b) => (a.run_id_bare < b.run_id_bare ? -1 : a.run_id_bare > b.run_id_bare ? 1 : 0));
  return { assignments, skipped };
}

// A readable DB run row's canonical run id + integer token count. Returns
// { ok, bare, public, tokens } or { ok:false, reason }. `tokens_spent` is
// nullable in the product schema (a run that never spent) — null/absent is 0
// for a READABLE row, never UNKNOWN.
export function canonicalizeSpendRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'run row is not an object' };
  const rawId = row.run_id_bare ?? row.id ?? row.runId ?? row.run_id;
  const parsed = parseRunKey(rawId);
  if (!parsed.ok) return { ok: false, reason: `run row id is not canonical: ${parsed.reason}` };
  const rawTokens = row.tokens_spent ?? row.tokensSpent ?? 0;
  const tokens = Number(rawTokens);
  if (!Number.isFinite(tokens) || tokens < 0) {
    return { ok: false, reason: `run ${parsed.public} has a non-numeric tokens_spent: ${JSON.stringify(rawTokens)}` };
  }
  return { ok: true, bare: parsed.bare, public: parsed.public, tokens };
}

function emptyProvider(harness, providerClass) {
  return {
    harness,
    class: providerClass,
    local: providerClass === PROVIDER_CLASS_LOCAL,
    runs: 0,
    tokens: 0,
    billable_tokens: 0,
  };
}

// Pure spend summary over already-read product rows + persisted assignments.
// Both inputs are canonicalized here; malformed rows are reported (and their
// tokens EXCLUDED from the numeric sums) rather than silently blamed on a
// provider. DB rows with no matching assignment land in the explicit
// `unattributed` bucket and are still part of the total (never dropped).
export function sumSpendSnapshot({ assignments = [], runRows = [], tickAt = utcTimestamp() } = {}) {
  const providers = {};
  for (const harness of SPEND_PROVIDER_ORDER) {
    providers[harness] = emptyProvider(harness, HARNESS_PROVIDER_CLASS[harness]);
  }
  const unattributed = { harness: null, class: 'unattributed', runs: 0, tokens: 0, billable_tokens: 0 };
  const assignmentByBare = new Map();
  const malformedAssignments = [];
  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const rawId = assignment?.run_id_bare ?? assignment?.runId ?? assignment?.run_id;
    const parsed = parseRunKey(rawId);
    if (!parsed.ok) {
      malformedAssignments.push({ run_id: rawId ?? null, reason: parsed.reason });
      continue;
    }
    assignmentByBare.set(parsed.bare, { ...assignment, run_id_bare: parsed.bare, run_id: parsed.public });
  }

  const runs = [];
  const malformedRows = [];
  for (const row of Array.isArray(runRows) ? runRows : []) {
    const canon = canonicalizeSpendRow(row);
    if (!canon.ok) {
      malformedRows.push({ reason: canon.reason, row_id: row?.run_id_bare ?? row?.id ?? row?.runId ?? null });
      continue;
    }
    const assignment = assignmentByBare.get(canon.bare) ?? null;
    const harness = normalizeHarness(assignment?.harness);
    const providerClass = providerClassForHarness(harness);
    let bucket;
    let attributedHarness;
    if (providerClass !== null && providers[harness]) {
      bucket = providers[harness];
      attributedHarness = harness;
    } else {
      bucket = unattributed;
      attributedHarness = harness;
    }
    bucket.runs += 1;
    bucket.tokens += canon.tokens;
    if (bucket.class === PROVIDER_CLASS_PAID) bucket.billable_tokens += canon.tokens;
    runs.push({
      run_id: canon.public,
      run_id_bare: canon.bare,
      harness: attributedHarness,
      class: bucket.class,
      workflow: assignment?.workflow ?? null,
      round: assignment?.round ?? null,
      roster_id: assignment?.roster_id ?? null,
      parent_run_id: assignment?.parent_run_id ?? null,
      derived_from: assignment?.derived_from ?? null,
      tokens_spent: canon.tokens,
    });
  }
  runs.sort((a, b) => (a.run_id_bare < b.run_id_bare ? -1 : a.run_id_bare > b.run_id_bare ? 1 : 0));

  const providerList = SPEND_PROVIDER_ORDER.map((h) => providers[h]);
  const total = providerList.reduce((n, p) => n + p.tokens, 0) + unattributed.tokens;
  const local = providerList.filter((p) => p.class === PROVIDER_CLASS_LOCAL).reduce((n, p) => n + p.tokens, 0);
  const paid = providerList.filter((p) => p.class === PROVIDER_CLASS_PAID).reduce((n, p) => n + p.tokens, 0);
  return {
    schema_version: SPEND_SCHEMA_VERSION,
    tick_at: tickAt,
    status: SPEND_STATUS_KNOWN,
    reason: null,
    providers,
    provider_list: providerList,
    total_tokens: total,
    local_tokens: local,
    paid_tokens: paid,
    billable_tokens: paid,
    unattributed_tokens: unattributed.tokens,
    unattributed_runs: unattributed.runs,
    runs,
    malformed_rows: malformedRows,
    malformed_assignments: malformedAssignments,
  };
}

// UNKNOWN spend. Every numeric field is null — a missing/unreadable DB can
// never be reported as 0 tokens.
export function unknownSpendSnapshot({ tickAt = utcTimestamp(), reason = 'campaign DB unreadable' } = {}) {
  return {
    schema_version: SPEND_SCHEMA_VERSION,
    tick_at: tickAt,
    status: SPEND_STATUS_UNKNOWN,
    reason: String(reason),
    providers: null,
    provider_list: null,
    total_tokens: null,
    local_tokens: null,
    paid_tokens: null,
    billable_tokens: null,
    unattributed_tokens: null,
    unattributed_runs: null,
    runs: null,
    malformed_rows: null,
    malformed_assignments: null,
  };
}

// Read the campaign DB's run rows through the canonicalizing REAL_DB seam and
// return a spend snapshot. `openDb` is injectable for tests; production uses
// the REAL_DB read-only opener. A missing dbPath, a failed open, a
// listRuns throw or a non-API opener all yield UNKNOWN (never 0).
export function collectCampaignSpend({ dbPath, state = null, tickAt = utcTimestamp(), openDb = null } = {}) {
  const { assignments, skipped } = spendAssignmentsFromState(state);
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    return { ...unknownSpendSnapshot({ tickAt, reason: 'campaign DB path is not configured' }), skipped_assignments: skipped };
  }
  const opener = typeof openDb === 'function' ? openDb : REAL_DB.open;
  let opened;
  try {
    opened = opener(dbPath);
  } catch (err) {
    return { ...unknownSpendSnapshot({ tickAt, reason: `campaign DB opener threw: ${err?.message ?? String(err)}` }), skipped_assignments: skipped };
  }
  if (!opened || opened.ok !== true || !opened.api) {
    const reason = opened?.error ?? 'campaign DB opener returned no API';
    return { ...unknownSpendSnapshot({ tickAt, reason }), skipped_assignments: skipped };
  }
  let rows;
  try {
    rows = opened.api.listRuns();
  } catch (err) {
    return { ...unknownSpendSnapshot({ tickAt, reason: `campaign DB read failed: ${err?.message ?? String(err)}` }), skipped_assignments: skipped };
  } finally {
    try { opened.api.close?.(); } catch { /* never throw on close */ }
  }
  if (!Array.isArray(rows)) {
    return { ...unknownSpendSnapshot({ tickAt, reason: 'campaign DB listRuns did not return an array' }), skipped_assignments: skipped };
  }
  return { ...sumSpendSnapshot({ assignments, runRows: rows, tickAt }), skipped_assignments: skipped };
}

// Write a spend snapshot to <campaignDir>/results/spend.json. The campaign
// results dir is created if absent. Returns the absolute written path.
export function writeSpendSnapshot({ fs, campaignDir, snapshot }) {
  if (!fs || typeof fs.writeFileSync !== 'function') throw refusal('writeSpendSnapshot requires an fs adapter', 'TT_USAGE');
  if (typeof campaignDir !== 'string' || campaignDir === '') throw refusal('writeSpendSnapshot requires a campaignDir', 'TT_USAGE');
  if (!snapshot || typeof snapshot !== 'object') throw refusal('writeSpendSnapshot requires a snapshot object', 'TT_USAGE');
  const resultsDir = `${String(campaignDir).replace(/\/+$/, '')}/${STORM_RESULTS_DIR}`;
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = `${resultsDir}/${SPEND_FILE_NAME}`;
  fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return outPath;
}

// Read back the last written spend snapshot (null when absent/unreadable).
export function readSpendSnapshot({ fs, campaignDir }) {
  const outPath = `${String(campaignDir).replace(/\/+$/, '')}/${STORM_RESULTS_DIR}/${SPEND_FILE_NAME}`;
  try {
    if (!fs.existsSync(outPath)) return null;
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {
    return null;
  }
}

// Headline projection of a spend snapshot for the campaign report. A KNOWN
// snapshot becomes per-provider figures (LOCAL-endpoint pi/hermes counted with
// cost 0; PAID dsh with its billable tokens) plus local/paid/total sums and a
// single human-readable line. An UNKNOWN snapshot keeps every numeric field
// null and a line that says so — NEVER a fabricated 0 (STORM-REAL US-007).
// Pure: no I/O, no DB.
export function buildSpendHeadline(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.status !== SPEND_STATUS_KNOWN) {
    const reason = snapshot?.reason ?? 'no observation tick recorded a spend snapshot';
    return {
      status: SPEND_STATUS_UNKNOWN,
      reason: String(reason),
      tick_at: snapshot?.tick_at ?? null,
      providers: null,
      provider_order: [...SPEND_PROVIDER_ORDER],
      local_tokens: null,
      paid_tokens: null,
      billable_tokens: null,
      total_tokens: null,
      unattributed_tokens: null,
      line: `SPEND: UNKNOWN (${reason}) — never reported as 0`,
    };
  }
  const providers = {};
  for (const harness of SPEND_PROVIDER_ORDER) {
    const cls = HARNESS_PROVIDER_CLASS[harness];
    const p = snapshot.providers?.[harness] ?? {};
    const tokens = Number.isFinite(p.tokens) ? p.tokens : 0;
    providers[harness] = {
      harness,
      class: cls,
      local: cls === PROVIDER_CLASS_LOCAL,
      paid: cls === PROVIDER_CLASS_PAID,
      runs: Number.isFinite(p.runs) ? p.runs : 0,
      tokens,
      billable_tokens: cls === PROVIDER_CLASS_PAID ? tokens : 0,
      cost_zero: cls === PROVIDER_CLASS_LOCAL,
    };
  }
  const local = Number.isFinite(snapshot.local_tokens) ? snapshot.local_tokens : 0;
  const paid = Number.isFinite(snapshot.paid_tokens) ? snapshot.paid_tokens : 0;
  const total = Number.isFinite(snapshot.total_tokens) ? snapshot.total_tokens : 0;
  const unattributed = Number.isFinite(snapshot.unattributed_tokens) ? snapshot.unattributed_tokens : 0;
  const providerParts = SPEND_PROVIDER_ORDER.map((h) => {
    const p = providers[h];
    return p.paid ? `${h} paid ${p.tokens}` : `${h} local ${p.tokens} (cost 0)`;
  });
  const line = `SPEND: ${providerParts.join(' | ')} | local ${local} (cost 0), paid ${paid} | total ${total}`;
  return {
    status: SPEND_STATUS_KNOWN,
    reason: null,
    tick_at: snapshot.tick_at ?? null,
    providers,
    provider_order: [...SPEND_PROVIDER_ORDER],
    local_tokens: local,
    paid_tokens: paid,
    billable_tokens: paid,
    total_tokens: total,
    unattributed_tokens: unattributed,
    line,
  };
}

// Orchestrator convenience: compose the snapshot for the ctx/state (campaign
// DB + persisted roster harness assignments) and write results/spend.json.
// US-007 calls this on every observation tick; US-006 reads the written
// snapshot to enforce the spend cap. `ops` (optional) receives a `spend.tick`
// record with the headline figures. A caller that already collected a snapshot
// (e.g. the observation tick, which then enforces the cap against the SAME
// read) may pass `snapshot` to avoid a second DB read; its `tick_at` is
// normalized to this tick.
export function flushCampaignSpend(ctx, state, { ops = null, tickAt = undefined, snapshot = null } = {}) {
  const now = tickAt ?? (typeof ctx?.clock?.nowUtc === 'function' ? ctx.clock.nowUtc() : utcTimestamp());
  const campaignDir = ctx?.campaignDir;
  const base = snapshot ?? collectCampaignSpend({
    dbPath: ctx?.opts?.dbPath,
    state,
    tickAt: now,
    openDb: typeof ctx?.db?.open === 'function' ? (p) => ctx.db.open(p) : null,
  });
  const spend = { ...base, tick_at: now };
  const outPath = writeSpendSnapshot({ fs: ctx.fs, campaignDir, snapshot: spend });
  try {
    ops?.record?.('spend.tick', {
      tickAt: now,
      status: spend.status,
      total_tokens: spend.total_tokens,
      local_tokens: spend.local_tokens,
      paid_tokens: spend.paid_tokens,
      path: outPath,
    });
  } catch { /* observability only — never throw */ }
  return { ...spend, path: outPath };
}