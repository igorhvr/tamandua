// torture-test/oracles/lib/reroute-discipline.mjs
//
// S27 US-002: shared reroute-corridor discipline between O10's real-cell
// O10_REROUTE_COUNT reconciliation and the corridor recognition O11 already
// performs on the dispatch_renderings artifact.
//
// The tamandua product has two reroute-class mechanisms, and both are LEGAL
// corridors on a real multi-step workflow:
//
//   1. Step-failure reroute (on_fail.retry_step, rerouteWithPolicy in
//      src/installer/step-ops.ts): the consumer step failed and the workflow
//      reroutes to an upstream producer (finalize_merge -> verify/test, and
//      the other workflow corridors). Emits exactly one `step.rerouted` event
//      naming the CONSUMER step (the step whose execution was interrupted);
//      terminal-class failures (ledger-gate refusals) also increment the
//      consumer's terminal_reroute_count.
//   2. Missing-template-key re-pend (dispatch.keys.rejected with
//      transition.action === 'reroute'): the consumer's dispatch was blocked
//      because an upstream producer key was unresolved; the producer is
//      re-pended. This is the corridor O11 recognizes from the
//      dispatch_renderings rows (o11-output-contract.mjs): the row's
//      transition must target the row's producer step row — a distinct
//      same-run upstream producer — never consume a retry on the consumer.
//
// O10 consumes the SAME dispatch_renderings reroute rows as OPTIONAL
// corroboration for its real-cell reroute reconciliation: when the artifact
// carries legal reroute corridor rows for a run, each step.rerouted event
// must be covered by a corridor row naming that step; when the artifact
// carries none (the universal real-campaign shape — no dispatch.keys.rejected
// reroute row was ever captured), O10 falls back to the DB-counter
// reconciliation: the product only increments terminal_reroute_count through
// its legal reroute machinery, so per-step count equality between
// step.rerouted events and terminal_reroute_count is the attestation.
//
// O11's existing behavior is intentionally NOT changed; this module is the
// shared corridor-shape recognition O10 uses (and O11 may adopt only where
// trivially safe — its inline checks also produce O11_PRODUCER_ATTRIBUTION_
// MISSING / O11_PRODUCER_RETRY_MISROUTED findings and are not extracted here).

import { OracleRuntimeError } from './index.mjs';

export function canonicalRunId(value, label = 'run ID') {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError(`${label} must be nonempty`);
  return value.startsWith('run-') ? value : `run-${value}`;
}

// The legal reroute corridor shape O11 recognizes on a dispatch_renderings
// row: the transition action must be 'reroute', the row must carry a producer
// step row distinct from its own step row, and the transition must target
// that producer step row. Returns { target_step_row_id } for a legal row,
// otherwise null (a misrouted/attribution-less reroute is NOT a corridor).
export function legalRerouteTransition(row) {
  const transition = row?.transition;
  if (transition === null || typeof transition !== 'object' || transition.action !== 'reroute') return null;
  if (typeof row.producer_step_row_id !== 'string' || row.producer_step_row_id.length === 0) return null;
  if (row.producer_step_row_id === row.step_row_id) return null;
  if (transition.target_step_row_id !== row.producer_step_row_id) return null;
  return { target_step_row_id: transition.target_step_row_id };
}

// Extract the legal reroute corridor rows for one run from a
// dispatch_renderings rows array. Only dispatched=false rows (the
// dispatch.keys.rejected pre-dispatch guard) can carry the corridor
// transition — a dispatched row with an unresolved inventory is a finding in
// O11, never a corridor. Returns { rows, byStepId } where byStepId maps the
// CONSUMER step_id (the step whose dispatch was blocked and which the
// step.rerouted event names) to the count of legal corridor rows.
export function rerouteCorridorByStep(rows, runId) {
  const matched = [];
  const byStepId = new Map();
  for (const row of rows ?? []) {
    if (row === null || typeof row !== 'object') continue;
    if (canonicalRunId(row.run_id, 'dispatch_renderings row run_id') !== runId) continue;
    if (row.dispatched !== false) continue;
    if (legalRerouteTransition(row) === null) continue;
    if (typeof row.step_id !== 'string' || row.step_id.length === 0) continue;
    byStepId.set(row.step_id, (byStepId.get(row.step_id) ?? 0) + 1);
    matched.push(row);
  }
  return { rows: matched, byStepId };
}
