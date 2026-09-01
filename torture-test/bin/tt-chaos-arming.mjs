// S39 (US-003) — fail-closed mandatory-chaos arming gate.
//
// Campaign-20260826T225744158Z left W4.29-strict-gate-retry-finalize with a
// VACUOUS verdict: the case's premise (evidence made missing under a strict
// gate) requires the drain-armed delete-tstx-row corridor, but the manifest
// declared `chaos: null` (and no probe_sequence) while the task text promised
// the W4.01/W4.02 corridor. The controller's chaos machinery honors only
// DECLARED blocks, so no injection ever armed — yet the run reached terminal
// and the case produced a PRODUCT_FAIL verdict from evidence the injection
// was supposed to have made missing (state.json: chaos_evidence absent, run
// run-9b0bff8a-...; chaos.log: delete-tstx-row firings only for W4.01/W4.02
// trees at 23:02/23:19, never for W4.29).
//
// This module implements the post-run fail-closed verification: when a
// MANDATORY case declares a TYPED tt-chaos injection block (operator
// tt-chaos) and the attempt reached terminal, the attempt's chaos evidence
// must show a fired/completed state, or the run's chaos.log must carry a
// `fired` entry for this run id. If neither holds, the attempt is classified
// TEST_INFRA_FAIL with the DISTINCT category 'chaos-not-fired' naming the
// case/run/trigger — never a silent vacuous verdict. The existing
// chaos-invocation-failed semantics (operator exit non-zero / spawn error /
// terminal refusal at invocation time) are untouched and take precedence.
//
// Pure + dependency-free (node builtins only): imported by bin/tt-controller
// and exercised directly by self-tests/tier2-s39-chaos-arming-gap.test.ts.
import fs from 'node:fs';

// True when the chaos.log (JSON-lines, append-only — bin/tt-chaos's
// logStructured) carries an entry that (a) reports outcome 'fired', (b) names
// this run id (both spellings: `run-<uuid>` and the raw `<uuid>`), and
// (c) when actionType is given, matches the declared injection action.
// A missing/unreadable log is EVIDENCE (false), never a crash.
export function chaosLogHasFiredEntry(chaosLogPath, runId, actionType = null) {
  if (typeof chaosLogPath !== 'string' || chaosLogPath === '') return false;
  if (typeof runId !== 'string' || runId === '') return false;
  if (!fs.existsSync(chaosLogPath)) return false;
  // Normalize BOTH spellings on both sides (`run-<uuid>` and the raw
  // `<uuid>`): the chaos.log records the full `run-<uuid>` while the caller
  // may hold either the full or the short spelling (the product DB keys on
  // the raw uuid; the controller passes the full form).
  const shortRunId = runId.startsWith('run-') ? runId.slice(4) : runId;
  let text;
  try {
    text = fs.readFileSync(chaosLogPath, 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.outcome !== 'fired') continue;
    const entryRunId = entry.runId;
    if (typeof entryRunId !== 'string') continue;
    const entryShortRunId = entryRunId.startsWith('run-') ? entryRunId.slice(4) : entryRunId;
    if (entryRunId !== runId && entryShortRunId !== shortRunId) continue;
    if (actionType !== null && entry.action !== actionType) continue;
    return true;
  }
  return false;
}

// The S39 fail-closed gate. Returns the TEST_INFRA_FAIL reason object
// (category 'chaos-not-fired') when the attempt must fail closed, or null
// when no arming obligation is violated.
//
// Fires ONLY when ALL of:
//   1. the case declares a TYPED tt-chaos injection block (operator
//      'tt-chaos' — declaration-only O11 ledger blocks never fire and are
//      skipped by runDeclaredChaos, so they carry no arming obligation);
//   2. the case is mandatory (a shed_ok/optional case has no arming
//      obligation);
//   3. the attempt reached terminal (`atTerminal: true`, or phase/terminal_at
//      already set) — a run still in flight may yet fire its trigger;
//   4. the attempt's chaos_evidence never reached a fired/completed state
//      AND the chaos.log carries no `fired` entry for this run id.
//
// `chaosLogPath` is the shared append-only log (the controller passes
// CHAOS_LOG_PATH = torture-test/var/chaos/chaos.log, the same path the oracle
// snapshot copies under the chaos_log evidence key). campaignDir is unused but
// accepted for call-site symmetry / future campaign-local evidence reads.
export function chaosNotFiredGate(caseRecord, attempt, options = {}) {
  const block = caseRecord?.chaos;
  if (block === null || block === undefined || typeof block !== 'object') return null;
  if (typeof block.operator !== 'string' || block.operator !== 'tt-chaos') return null;
  if (caseRecord.mandatory !== true) return null;

  const atTerminal = options.atTerminal === true
    || attempt?.phase === 'terminal'
    || attempt?.terminal_at !== undefined;
  if (!atTerminal) return null;

  const evidence = attempt?.chaos_evidence;
  if (evidence !== null && evidence !== undefined && typeof evidence === 'object') {
    if (evidence.status === 'completed' || evidence.status === 'fired') return null;
  }

  const runId = attempt?.run_id;
  if (runId !== undefined && chaosLogHasFiredEntry(options.chaosLogPath, runId, block.type)) {
    return null;
  }

  return {
    category: 'chaos-not-fired',
    message: `mandatory case ${caseRecord.id} declared chaos block {type: ${block.type}, trigger: ${block.trigger}} but the injection never fired for run ${runId ?? '?'} (chaos_evidence ${evidence !== null && evidence !== undefined ? `status=${evidence.status}` : 'absent'}, chaos.log has no fired entry for this run id) — refusing to produce a vacuous verdict`,
    run_id: runId ?? null,
    trigger: block.trigger ?? null,
    chaos_type: block.type ?? null,
    operator: block.operator,
  };
}
