// O7 — post-batch event-log integrity oracle (torture-test only; STORM-O7).
//
// O7 is a READ-ONLY post-batch oracle (spec 03 "O7 — Event-log integrity",
// v1 scope hardened to the CURRENT native vocabulary). It consumes an
// explicitly versioned HOST-OWNED sidecar (see lib/o7-sidecar.mjs) pointing
// at immutable captured evidence and checks five obligations:
//
//   leg1  terminal runs have their matching real native terminal event
//         (RUN_LIFECYCLE_EVENTS terminal records: run.completed, run.failed,
//         run.canceled, run.deleted, run.force_failed) with DB-status
//         binding and chronology; snapshot-boundary incompleteness is
//         distinguished from a demonstrated missing event and is never PASS.
//         The native deleteWorkflow flow appends run.deleted AFTER an already
//         terminal run (its lifecycle terminal record stays in the
//         append-only per-run stream while the DB row is removed), so the
//         pair {lifecycle terminal, run.deleted} is recognized as the
//         delete-after-terminal OVERLAY — exempt from the duplicate-terminal
//         rule only when a host deleted-run receipt covers the run and the
//         deletion is chronologically after the lifecycle terminal it
//         overlays. A receipt-less run.deleted stays a duplicate-terminal
//         finding.
//   leg2  no step completion before a claim of the SAME attempt epoch; the
//         ONLY no-claim path is the native conditional auto-completion
//         (steps.auto_completed=1 + auto_complete_reason 'condition_unset:*'
//         + type='conditional' AND the step.auto_completed event, with the
//         event reason bound to the row reason). Claim epochs are separated
//         by native attempt-reset markers (step.retry / step.repended /
//         step.released / step.rerouted / step.respawned): a prior claim
//         never authorizes a completion across a reset, a second completion
//         in one epoch is a duplicate, and the native step.done +
//         step.expects.validated(outcome accepted) pair is ONE completion.
//         dispatch.render.validated stepRowId/claimId are validated against
//         the run's step rows and the row's final claim job id
//         (O7_ROW_IDENTITY / O7_CLAIM_IDENTITY); native data that cannot
//         prove a claim is honest NOT_EVALUABLE, never invented from final
//         terminal rows.
//   leg3  campaign attribution: empty-runId events and a hidden
//         events/.jsonl are findings unless they match host-predeclared
//         manual-operation ledger entries (identity/type/order); cross-stream
//         attribution mismatches and malformed/truncated JSONL are findings.
//         Each captured per-run stream must correspond BOTH ways with its
//         slice of the global train (extra/missing/reordered/duplicated
//         members across rotation segment boundaries fail); a host-declared
//         PARTIAL per-run capture (sidecar.per_run_capture) is verified only
//         over its declared prefix and recorded as bounded coverage — never a
//         silent full PASS.
//   leg4  HUSH noise (run.nudged / agent.nudged / agent.nudge.skipped) is
//         absent in normal debug-off operation; the debug control is
//         recorded separately and the real emitter filter is verified with
//         fresh private debug-off/debug-on probe streams.
//   leg5  rotation bounds (<= native 20 MiB cap + the last full event, <=3
//         archives, generation consistency) and complete event-train
//         preservation; for a rotation-gate capture the declared volume
//         sequence (membership + order + count) and the host-journaled
//         lifecycle receipts (recorded at operation time) must reconstruct
//         exactly — never copied from the final stream under test.
//
// Output/exit semantics match the version-1 oracle contract: stdout carries
// exactly one JSON object {contract_version, oracle_id, result, started_at,
// finished_at, findings, evidence}; PASS/FAIL/ERROR/NOT_EVALUABLE map to
// exit 0/1/2/3. Missing required evidence is ERROR or NOT_EVALUABLE — never
// PASS. Evidence DB snapshots are opened read-only via node:sqlite
// {readOnly:true}; getDb()/migrate() are never used.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { O7EvidenceError, loadO7Sidecar, NATIVE_MAX_EVENTS_FILE_SIZE, NATIVE_MAX_ROTATED_EVENTS_FILES } from './o7-sidecar.mjs';
import {
  NOISE_EVENTS,
  RUN_TERMINAL_EVENTS,
  assembleGlobalTrain,
  duplicateLinesWithin,
  eventRunId,
  parseEventStream,
} from './o7-train.mjs';
import { buildOracleResponse, RESULT_EXIT_CODES, validateOracleResponse } from './output.mjs';

export const O7_REPORT_ARTIFACT = 'o7-event-integrity.json';

const STEP_TERMINAL_EVENTS = new Set(['step.done', 'step.failed']);
const CLAIM_MARKER_KINDS = new Set(['step.running', 'dispatch.render.validated']);
const RESUME_KINDS = new Set(['run.resumed', 'run.resume_requested', 'run.drain_cancelled_by_resume']);
// Attempt-reset markers: after any of these the row's prior claim/attempt is
// consumed (the row is pending again or re-owned) and a fresh claim marker is
// required before the next completion. A prior claim never authorizes a
// completion across one of these markers (STORM-O7 close correction A).
const STEP_RESET_KINDS = new Set([
  'step.retry',
  'step.repended',
  'step.released',
  'step.rerouted',
  'step.respawned',
]);
const AUTO_COMPLETE_EVENT = 'step.auto_completed';
const ACCEPTED_VALIDATION_EVENT = 'step.expects.validated';
const DISPATCH_VALIDATED_EVENT = 'dispatch.render.validated';
const STEP_RUNNING_EVENT = 'step.running';
const STEP_DONE_KIND = 'step.done';
const STEP_FAILED_KIND = 'step.failed';

// ---- time helpers -------------------------------------------------------

function parseDbTime(dbTime) {
  if (typeof dbTime !== 'string' || dbTime.length === 0) return null;
  const ms = Date.parse(dbTime.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : ms;
}

function isoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function isoToSec(value) {
  const ms = isoMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

// ---- context ------------------------------------------------------------

class O7Context {
  constructor(sidecar) {
    this.sidecar = sidecar;
    this.failing = []; // failing findings ({id, summary, ...})
    this.info = []; // informational findings (non_failing)
    this.notes = []; // per-leg coverage notes
    this.neReasons = []; // why a required leg is NOT_EVALUABLE
    this.counts = {
      streams: {},
      hush: {},
      terminal_by_run: {},
      global_lines: 0,
      malformed_lines: 0,
      empty_run_events: 0,
      volume_events: 0,
    };
  }

  fail(id, summary, details = {}) {
    this.failing.push({ id, summary, ...details });
  }

  infoNote(id, summary, details = {}) {
    this.info.push({ id, summary, ...details, non_failing: true });
  }

  notEvaluable(reason) {
    this.neReasons.push(reason);
  }
}

// ---- read-only DB helpers ----------------------------------------------

function openDb(sidecar) {
  const member = sidecar.members.get('db-snapshot');
  if ((member.stat.mode & 0o222) !== 0) {
    throw new O7EvidenceError('db-snapshot is writable; oracle SQLite inputs must be read-only');
  }
  return new DatabaseSync(member.absolute, { readOnly: true });
}

function pragmaColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  } catch {
    return null;
  }
}

// ---- stream assembly ----------------------------------------------------

function parseStreamMember(member, roleLabel) {
  const parsed = parseEventStream(roleLabel, member.bytes);
  return { member, roleLabel, parsed };
}

/**
 * Build parsed stream objects for every captured event member plus the
 * ordered global train (oldest archive -> newest archive -> live).
 */
function buildStreams(sidecar) {
  const globalSegments = [];
  const perRun = new Map();
  const otherStreams = new Map();

  for (const [role, member] of sidecar.members) {
    if (role === 'db-snapshot' || role === 'receipts' || role === 'volume-plan' || role === 'generation') continue;
    if (role === 'global-live') {
      globalSegments.push({ kind: 'live', archiveIndex: 0, parsed: parseStreamMember(member, 'all.jsonl').parsed });
    } else if (role.startsWith('global-archive:')) {
      const index = Number(role.split(':')[1]);
      globalSegments.push({ kind: 'archive', archiveIndex: index, parsed: parseStreamMember(member, `all.jsonl.${index}`).parsed });
    } else {
      otherStreams.set(role, parseStreamMember(member, role));
    }
  }
  for (const [runId, member] of sidecar.perRun) {
    perRun.set(runId, parseStreamMember(member, `events/${runId}.jsonl`));
  }
  const emptyRunMember = sidecar.members.get('empty-run');
  if (emptyRunMember) {
    perRun.set('', parseStreamMember(emptyRunMember, 'events/.jsonl'));
  }
  const generation = sidecar.generationMember
    ? sidecar.generationMember.bytes.toString('utf8').trim()
    : null;
  const train = assembleGlobalTrain(globalSegments);
  return { globalSegments, perRun, otherStreams, train, generation };
}

// ---- leg 1: terminal events --------------------------------------------

function leg1Terminal(ctx, sidecar, streams, dbRuns, deletedByRun, entriesForRun, partialRuns) {
  const scope = sidecar.raw.scope_runs;
  const statusByRun = new Map(dbRuns.map((r) => [r.id, r]));
  const evaluated = [];
  const judged = [];
  const notEvaluableRuns = [];

  for (const runId of scope) {
    const row = statusByRun.get(runId);
    const deleted = deletedByRun.get(runId);
    let expected;
    if (row && row.status === 'completed') expected = ['run.completed'];
    else if (row && row.status === 'failed') expected = ['run.failed', 'run.force_failed'];
    else if (row && row.status === 'canceled') expected = ['run.canceled'];
    else if (deleted) expected = ['run.deleted'];
    else if (row) {
      ctx.notes.push(`leg1: run ${runId} status ${row.status} is non-terminal — outside terminal scope`);
      continue;
    } else {
      continue; // scope-sanity NE is recorded by the caller
    }
    const entries = entriesForRun(runId);
    if (entries === null) {
      ctx.notEvaluable(`leg1: scoped run ${runId} has no captured per-run event stream`);
      notEvaluableRuns.push(runId);
      continue;
    }
    evaluated.push(runId);
    if (partialRuns.has(runId)) {
      ctx.notes.push(`leg1: run ${runId} per-run stream is a declared partial capture — terminal-event evaluation uses its full global-train slice; full per-run correspondence is not claimed`);
    }
    const runEvents = entries.filter((e) => eventRunId(e.event) === runId);
    const terminalHits = runEvents.filter((e) => RUN_TERMINAL_EVENTS.includes(e.event.event));
    ctx.counts.terminal_by_run[runId] = terminalHits.length;

    const dbTermMs = row?.updated_at ? parseDbTime(row.updated_at)
      : deleted?.receipt_ts ? isoMs(deleted.receipt_ts) : null;
    const dbTermSec = dbTermMs === null ? null : Math.floor(dbTermMs / 1000);
    const captureSec = isoToSec(sidecar.raw.capture.events_captured_at);

    if (terminalHits.length === 0) {
      const demonstrated = dbTermSec !== null && captureSec !== null && dbTermSec <= captureSec;
      if (demonstrated) {
        ctx.fail('O7_TERMINAL_EVENT_MISSING',
          `terminal run ${runId} (status ${row?.status ?? 'deleted'}) has no terminal event in its captured per-run stream`,
          { run_id: runId, expected_events: expected, db_updated_at: row?.updated_at ?? null });
      } else {
        ctx.notEvaluable(`leg1: run ${runId} terminal transition post-dates event capture — snapshot boundary incompleteness, not a demonstrated missing event`);
        notEvaluableRuns.push(runId);
      }
      continue;
    }

    judged.push(runId);
    const matching = terminalHits.filter((e) => expected.includes(e.event.event));
    if (matching.length === 0) {
      ctx.fail('O7_TERMINAL_STATUS_MISMATCH',
        `terminal run ${runId} (status ${row?.status ?? 'deleted'}) carries terminal event(s) ${[...new Set(terminalHits.map((e) => e.event.event))].join(',')} but none of expected ${expected.join('/')}`,
        { run_id: runId });
    } else {
      const firstMatchSec = Math.min(...matching.map((e) => isoToSec(e.event.ts) ?? Infinity));
      if (dbTermSec !== null && firstMatchSec < dbTermSec) {
        ctx.fail('O7_TERMINAL_CHRONOLOGY',
          `terminal event for run ${runId} predates its DB terminal transition (${firstMatchSec}s < ${dbTermSec}s)`,
          { run_id: runId });
      }
    }

    // No duplicate terminal without an intervening resume marker — with one
    // NATIVE exception: deleteWorkflow appends run.deleted AFTER an already
    // terminal run (the lifecycle terminal record stays in the append-only
    // per-run stream while the DB row is removed). The pair
    // {lifecycle terminal, run.deleted} is therefore the normal
    // delete-after-terminal overlay, NOT a second lifecycle terminal, and is
    // exempt ONLY when a host deleted-run receipt covers this run
    // (receipt/event identity: the run.deleted event carries this runId and
    // the receipt names this run) AND the deletion is chronologically after
    // the lifecycle terminal it overlays (the stream is append-ordered, so a
    // run.deleted whose ts precedes the lifecycle terminal it follows is a
    // reorder/anomaly even with a receipt). A receipt-less run.deleted — or a
    // second run.deleted overlaying a first — remains a duplicate-terminal
    // finding.
    for (let i = 1; i < terminalHits.length; i += 1) {
      const prevTerminalEvent = terminalHits[i - 1].event.event;
      const curTerminalEvent = terminalHits[i].event.event;
      const between = runEvents.slice(terminalHits[i - 1].lineIndex, terminalHits[i].lineIndex);
      const resumed = between.some((e) => RESUME_KINDS.has(e.event.event));
      const deletionOverlay = !resumed && curTerminalEvent === 'run.deleted'
        && prevTerminalEvent !== 'run.deleted' && deleted !== undefined;
      if (deletionOverlay) {
        const overlayPrevSec = isoToSec(terminalHits[i - 1].event.ts);
        const overlayCurSec = isoToSec(terminalHits[i].event.ts);
        if (overlayCurSec !== null && overlayPrevSec !== null && overlayCurSec < overlayPrevSec) {
          ctx.fail('O7_TERMINAL_CHRONOLOGY',
            `run ${runId}: deletion overlay run.deleted@L${terminalHits[i].lineIndex} (${overlayCurSec}s) predates the lifecycle terminal ${prevTerminalEvent}@L${terminalHits[i - 1].lineIndex} (${overlayPrevSec}s) it overlays`,
            { run_id: runId, overlay_terminal: prevTerminalEvent, deleted_line: terminalHits[i].lineIndex });
        } else {
          ctx.infoNote('O7_DELETION_OVERLAY',
            `run ${runId}: ${prevTerminalEvent}@L${terminalHits[i - 1].lineIndex} followed by run.deleted@L${terminalHits[i].lineIndex} with a covering host deleted-run receipt — recognized as the native delete-after-terminal overlay, not a duplicate terminal`,
            { run_id: runId, overlay_terminal: prevTerminalEvent, deleted_line: terminalHits[i].lineIndex, receipt_ts: deleted?.receipt_ts ?? null });
        }
      } else if (!resumed) {
        ctx.fail('O7_DUPLICATE_TERMINAL_EVENT',
          `run ${runId} has terminal events ${prevTerminalEvent}@L${terminalHits[i - 1].lineIndex} and ${curTerminalEvent}@L${terminalHits[i].lineIndex} with no resume marker between and no deletion-overlay exemption`,
          { run_id: runId });
      }
    }

    // Chronology: run.started precedes the first terminal event.
    const started = runEvents.filter((e) => e.event.event === 'run.started');
    if (started.length > 0) {
      const firstTerminalSec = Math.min(...terminalHits.map((e) => isoToSec(e.event.ts) ?? Infinity));
      const firstStartedSec = Math.min(...started.map((e) => isoToSec(e.event.ts) ?? Infinity));
      if (firstStartedSec > firstTerminalSec) {
        ctx.fail('O7_TERMINAL_ORDER', `run ${runId}: run.started (${firstStartedSec}s) appears after its terminal event (${firstTerminalSec}s)`, { run_id: runId });
      }
    } else {
      ctx.notes.push(`leg1: run ${runId}: no run.started captured (terminal event present)`);
    }
  }

  const legFindingIds = ['O7_RUN_UNKNOWN', 'O7_TERMINAL_EVENT_MISSING', 'O7_TERMINAL_STATUS_MISMATCH', 'O7_TERMINAL_CHRONOLOGY', 'O7_DUPLICATE_TERMINAL_EVENT', 'O7_TERMINAL_ORDER'];
  const failed = ctx.failing.some((f) => legFindingIds.includes(f.id));
  const result = failed ? 'FAIL' : notEvaluableRuns.length > 0 ? 'NOT_EVALUABLE' : 'PASS';
  return {
    result,
    applied_runs: evaluated,
    terminal_runs_judged: judged,
    not_evaluable_runs: notEvaluableRuns,
  };
}

// ---- leg 2: claim-before-completion ------------------------------------

function stepRowsByStepId(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    const stepId = row.step_id;
    if (!map.has(stepId)) map.set(stepId, []);
    map.get(stepId).push(row);
  }
  return map;
}

function rowIsLoop(row) {
  return row !== null && row !== undefined && row.type === 'loop';
}

function isNativeAutoCompletedRow(row) {
  return row !== null && row !== undefined
    && Number(row.auto_completed) === 1
    && typeof row.auto_complete_reason === 'string'
    && row.auto_complete_reason.startsWith('condition_unset:')
    && row.type === 'conditional';
}

/**
 * Native claim/attempt identity for a row's FINAL state (what the product DB
 * snapshot can still prove). Returns null when the snapshot holds no
 * claim identity at all (job id, or the row's own id + claim timestamp).
 */
function finalClaimIdentity(row) {
  if (row === null || row === undefined) return null;
  if (row.claim_job_id !== null && row.claim_job_id !== undefined && String(row.claim_job_id).length > 0) {
    return { kind: 'job', value: String(row.claim_job_id) };
  }
  const stamp = row.claim_updated_at ?? row.updated_at;
  if (stamp !== null && stamp !== undefined && String(stamp).length > 0) {
    return { kind: 'fallback', value: `${row.id}:${stamp}` };
  }
  return null;
}

/**
 * Resolve the DB step row an event refers to, validating available row
 * identity instead of silently discarding it. Returns the row, or null when
 * the event cannot be bound (and pushes a finding when it should have been).
 */
function rowForEvent(ctx, runId, ev, byRowId, byStepId, uniqueStepIds, hasRows) {
  const stepRowId = typeof ev.stepRowId === 'string' && ev.stepRowId.length > 0 ? ev.stepRowId : null;
  const stepId = typeof ev.stepId === 'string' && ev.stepId.length > 0 ? ev.stepId : null;
  if (stepRowId !== null) {
    const row = byRowId.get(stepRowId);
    if (!row) {
      // A stepRowId that no row of THIS run owns is a contradictory identity
      // (foreign row, invented id, or cross-run row) — never silently
      // discarded. Runs whose rows were deleted (deleteWorkflow) have no
      // rows to bind against; those are handled separately by the caller.
      if (hasRows) {
        ctx.fail('O7_ROW_IDENTITY',
          `event ${ev.event}@? of run ${runId} carries stepRowId "${stepRowId}" which is no step row of this run`,
          { run_id: runId, event: ev.event, step_row_id: stepRowId });
      }
      return null;
    }
    if (stepId !== null && row.step_id !== stepId) {
      ctx.fail('O7_ROW_IDENTITY',
        `event ${ev.event} of run ${runId} pairs stepRowId "${stepRowId}" (row of step "${row.step_id}") with a contradictory stepId "${stepId}"`,
        { run_id: runId, event: ev.event, step_row_id: stepRowId, step_id: stepId, row_step_id: row.step_id });
    }
    return row;
  }
  if (stepId !== null && uniqueStepIds.has(stepId)) {
    return byStepId.get(stepId)[0];
  }
  // Ambiguous or unbound: the event does not carry enough identity.
  return null;
}

/**
 * Audit one step ROW's event slice for claim/attempt discipline.
 *
 * Claim epochs (attempts) are separated by STEP_RESET_KINDS markers: a claim
 * marker opens an epoch, and exactly one completion unit (step.done /
 * step.failed / native conditional auto-completion, with the accepted
 * `step.expects.validated` coalesced into the step.done that native
 * `step complete` emits) may close it. A completion after a reset marker
 * with no fresh claim, a second completion in the same epoch, a claim after
 * the row's terminal completion without a reset, a contradictory row/job
 * identity, or a single-side auto-completion are all findings.
 */
function auditStepRow(ctx, runId, row, entries, rowLabel) {
  const hasDbRow = row !== null && row !== undefined;
  const loop = rowIsLoop(row);
  const autoRow = isNativeAutoCompletedRow(row);

  let claimIdx = -1; // entries index of the newest claim marker (window-relative)
  let lastResetIdx = -1;
  let lastTerminalIdx = -1; // entries index that closed the last completion unit
  let lastUnitKind = null; // 'done' | 'failed' | 'auto' | 'validated'
  let autoIdx = -1; // newest step.auto_completed at/under a terminal
  let autoEventReason = null; // reason carried by the newest auto-completion event
  let unitOpen = false; // a completion unit closed in the current window
  const identity = []; // {idx, claimId, kind} identity-carrying claim events

  const resetWindow = (idx) => {
    claimIdx = -1;
    lastResetIdx = idx;
    unitOpen = false;
    autoIdx = -1;
    autoEventReason = null;
  };

  const fail = (id, summary, lineIndex, extra = {}) => {
    ctx.fail(id, `${summary} (row ${rowLabel})`, { run_id: runId, ...extra });
  };

  for (let i = 0; i < entries.length; i += 1) {
    const { event: ev, lineIndex } = entries[i];
    const evName = ev.event;

    if (STEP_RESET_KINDS.has(evName)) {
      resetWindow(i);
      continue;
    }
    if (evName === AUTO_COMPLETE_EVENT) {
      autoIdx = i;
      autoEventReason = typeof ev.reason === 'string' && ev.reason.length > 0 ? ev.reason : null;
      continue;
    }

    const isClaim = (evName === STEP_RUNNING_EVENT)
      || (evName === DISPATCH_VALIDATED_EVENT && ev.dispatched === true);
    if (isClaim) {
      if (evName === DISPATCH_VALIDATED_EVENT) {
        identity.push({ idx: i, claimId: ev.claimId, kind: 'dispatch' });
      }
      if (lastTerminalIdx >= 0 && lastResetIdx < lastTerminalIdx && !loop) {
        // A fresh claim after the row's terminal completion, with no reset
        // marker in between, cannot authorize anything (non-loop rows
        // complete exactly once unless re-pended/retried/respawned).
        fail('O7_CLAIM_AFTER_TERMINAL',
          `claim marker ${evName} appears after the terminal completion of step without an intervening retry/re-pend marker`,
          lineIndex, { step_id: rowLabel, after_line: lineIndex });
      }
      claimIdx = i;
      continue;
    }

    const isAcceptedValidation = evName === ACCEPTED_VALIDATION_EVENT && ev.outcome === 'accepted';
    const isTerminal = STEP_TERMINAL_EVENTS.has(evName) || isAcceptedValidation;
    if (!isTerminal) continue;

    // Coalesce the native accepted-validation tail: `step complete` emits
    // step.done (completeStep) and THEN step.expects.validated outcome
    // accepted from the same call. The pair is ONE completion, not two.
    if (isAcceptedValidation) {
      identity.push({ idx: i, claimId: ev.claimId, kind: 'validated' });
      const contiguous = lastTerminalIdx >= 0
        && i === lastTerminalIdx + 1 && lastUnitKind === 'done';
      if (contiguous) {
        // Same completion unit (the accepted validation closes the step.done
        // emitted by the same native `step complete` call) — the unit now
        // spans through this validation, which also carries the final-epoch
        // claim identity.
        lastTerminalIdx = i;
        continue;
      }
      // Broken pair / standalone accepted validation — falls through and is
      // treated as its own completion unit below.
    }

    if (unitOpen) {
      fail('O7_DUPLICATE_COMPLETION',
        `completion event ${evName} for the same step occurs after an earlier completion with no retry/new claim between`,
        lineIndex, { step_id: rowLabel, line: lineIndex, previous_terminal_line: lastTerminalIdx + 1 });
      continue;
    }

    // ── open a completion unit ──
    let unitKind;
    if (evName === STEP_FAILED_KIND) {
      const dbClaimed = hasDbRow && ((row.claim_job_id !== null && row.claim_job_id !== undefined)
        || (row.claim_updated_at !== null && row.claim_updated_at !== undefined));
      if (!dbClaimed && claimIdx < 0) {
        fail('O7_COMPLETION_WITHOUT_CLAIM',
          `completion event step.failed has no preceding claim marker and no claim evidence`,
          lineIndex, { step_id: rowLabel, line: lineIndex });
      }
      unitKind = 'failed';
    } else if (evName === STEP_DONE_KIND) {
      const autoEvent = autoIdx >= 0 && autoIdx < i
        && !entries.slice(autoIdx + 1, i).some((en) => CLAIM_MARKER_KINDS.has(en.event.event));
      if (autoEvent && autoRow) {
        // Both native sides of the conditional auto-completion path:
        // step.auto_completed event AND the matching DB row
        // (auto_completed=1 + condition_unset:* + type=conditional).
        // The event is additionally bound to the row's declared reason when
        // the event carries one — an event reason naming a different
        // condition than the row proves is a contradictory identity.
        if (hasDbRow && autoEventReason !== null && row.auto_complete_reason !== autoEventReason) {
          fail('O7_ROW_IDENTITY',
            `auto-completion event reason "${autoEventReason}" contradicts the row's auto_complete_reason "${row.auto_complete_reason}"`,
            lineIndex, { step_id: rowLabel, line: lineIndex });
        }
        unitKind = 'auto';
      } else if (autoEvent || autoRow) {
        fail('O7_AUTOCOMPLETE_SINGLE_SIDE',
          `completion rides a single-side auto-completion (event marker ${autoEvent ? 'present' : 'absent'}, DB auto_completed/auto_complete_reason ${autoRow ? 'present' : 'absent'})`,
          lineIndex, { step_id: rowLabel, line: lineIndex, event_side: autoEvent, db_side: autoRow });
        unitKind = 'done';
      } else if (claimIdx < 0 || claimIdx > i) {
        fail('O7_COMPLETION_WITHOUT_CLAIM',
          `completion event step.done has no preceding claim marker and no native auto-completion`,
          lineIndex, { step_id: rowLabel, line: lineIndex });
        unitKind = 'done';
      } else {
        unitKind = 'done';
      }
    } else {
      // standalone accepted validation (broken pair)
      unitKind = 'validated';
      if (claimIdx < 0 || claimIdx > i) {
        fail('O7_COMPLETION_WITHOUT_CLAIM',
          `accepted step.expects.validated has no preceding claim marker and no native auto-completion`,
          lineIndex, { step_id: rowLabel, line: lineIndex });
      }
    }

    lastTerminalIdx = i;
    lastUnitKind = unitKind;
    unitOpen = true;
  }

  // Final-epoch claim identity: when the product DB pins a claim job id (or a
  // native fallback) for the row, the identity-carrying claim events of the
  // row's FINAL attempt (after its last reset, up to its terminal) must
  // agree with it. Native data that cannot prove the claim is reported
  // honestly instead of being invented from final terminal rows.
  if (hasDbRow && lastTerminalIdx >= 0 && !['auto'].includes(lastUnitKind)) {
    const dbIdentity = finalClaimIdentity(row);
    const finalStart = lastResetIdx + 1;
    const finalIdentity = identity.filter((id) => id.idx >= finalStart && id.idx <= lastTerminalIdx);
    if (dbIdentity !== null) {
      if (dbIdentity.kind === 'job') {
        const matching = finalIdentity.filter((id) => String(id.claimId ?? '') === dbIdentity.value);
        if (matching.length === 0) {
          if (finalIdentity.length === 0) {
            ctx.notEvaluable(`leg2: row ${rowLabel} of run ${runId} completed with DB claim job ${dbIdentity.value} but its captured events carry no identity-carrying claim event (dispatch.render.validated / step.expects.validated) — native data cannot prove the claim`);
          } else {
            fail('O7_CLAIM_IDENTITY',
              `final-claim identity of the row (DB claim_job_id ${dbIdentity.value}) is contradicted by the captured claim event identity (${[...new Set(finalIdentity.map((id) => id.claimId ?? '(none)'))].join(',')})`,
              lastTerminalIdx + 1, { step_id: rowLabel, claim_job_id: dbIdentity.value });
          }
        }
      } else if (dbIdentity.kind === 'fallback' && finalIdentity.length === 0) {
        ctx.notEvaluable(`leg2: row ${rowLabel} of run ${runId} completed with only a native fallback claim identity and no identity-carrying claim event captured — native data cannot prove the claim`);
      }
    } else if (finalIdentity.length === 0 && claimIdx >= 0) {
      ctx.infoNote('O7_CLAIM_IDENTITY_UNVERIFIED',
        `row ${rowLabel} of run ${runId} completed under a claim marker but the DB snapshot holds no claim job id and no identity-carrying claim event was captured — claim identity is unverifiable from final-state data`,
        { run_id: runId, step_id: rowLabel });
    }
  }
}

function leg2Claims(ctx, sidecar, streams, stepsByRun, entriesForRun, partialRuns) {
  const notEvaluableRuns = [];
  const evaluatedRuns = [];
  for (const runId of sidecar.raw.scope_runs) {
    const entries = entriesForRun(runId);
    const rows = stepsByRun.get(runId);
    if (entries === null) {
      ctx.notEvaluable(`leg2: scoped run ${runId} has no captured per-run event stream`);
      notEvaluableRuns.push(runId);
      continue;
    }
    if (partialRuns.has(runId)) {
      ctx.notes.push(`leg2: run ${runId} per-run stream is a declared partial capture — claim/attempt evaluation uses its full global-train slice; full per-run correspondence is not claimed`);
    }
    if (rows === undefined) {
      ctx.notEvaluable(`leg2: DB steps rows unavailable for run ${runId}`);
      notEvaluableRuns.push(runId);
      continue;
    }
    const byStepId = stepRowsByStepId(rows);
    const byRowId = new Map((rows ?? []).map((row) => [row.id, row]));
    const uniqueStepIds = new Set([...byStepId.entries()].filter(([, list]) => list.length === 1).map(([sid]) => sid));
    const hasRows = (rows ?? []).length > 0;

    // Slice the run's stream into per-row ordered entries plus a remainder
    // of unbound events (ambiguous step ids / unknown rows).
    const runEvents = entries.filter((entry) => eventRunId(entry.event) === runId);
    const rowEntries = new Map();
    const unbound = [];
    for (const entry of runEvents) {
      const ev = entry.event;
      const stepId = typeof ev.stepId === 'string' ? ev.stepId : null;
      if (stepId === null && typeof ev.stepRowId !== 'string') {
        continue; // run-level event (run.started, run.completed, ...)
      }
      const row = rowForEvent(ctx, runId, ev, byRowId, byStepId, uniqueStepIds, hasRows);
      if (row === null) {
        const isStepish = CLAIM_MARKER_KINDS.has(ev.event) || STEP_RESET_KINDS.has(ev.event)
          || STEP_TERMINAL_EVENTS.has(ev.event) || ev.event === AUTO_COMPLETE_EVENT
          || ev.event === ACCEPTED_VALIDATION_EVENT;
        if (isStepish) unbound.push({ entry, stepId, row });
        continue;
      }
      if (!rowEntries.has(row.id)) rowEntries.set(row.id, []);
      rowEntries.get(row.id).push(entry);
    }

    if (!hasRows) {
      // Deleted/pre-rows run: the DB snapshot no longer carries the rows
      // (deleteWorkflow removes them), so claim identity cannot be audited.
      if (rowEntries.size > 0 || unbound.length > 0) {
        ctx.notEvaluable(`leg2: run ${runId} carries step lifecycle events but its step rows were removed from the DB snapshot (deleted run) — claim identity cannot be audited`);
        notEvaluableRuns.push(runId);
      } else {
        ctx.notes.push(`leg2: run ${runId} has no step rows and no step lifecycle events — nothing to audit (vacuous)`);
        evaluatedRuns.push(runId);
      }
      continue;
    }

    if (unbound.length > 0) {
      ctx.notEvaluable(`leg2: run ${runId} has ${unbound.length} step lifecycle event(s) that cannot be bound to a DB step row (ambiguous/unknown identity)`);
      notEvaluableRuns.push(runId);
      continue;
    }

    evaluatedRuns.push(runId);
    if (rowEntries.size === 0) {
      ctx.notes.push(`leg2: run ${runId} has step rows in the DB snapshot but no step lifecycle events captured in its stream`);
      continue;
    }
    for (const [rowId, entries] of rowEntries) {
      const row = byRowId.get(rowId);
      auditStepRow(ctx, runId, row, entries, row.step_id);
    }
  }
  const legFindingIds = ['O7_COMPLETION_WITHOUT_CLAIM', 'O7_CLAIM_AFTER_TERMINAL', 'O7_AUTOCOMPLETE_SINGLE_SIDE', 'O7_DUPLICATE_COMPLETION', 'O7_ROW_IDENTITY', 'O7_CLAIM_IDENTITY'];
  const failed = ctx.failing.some((f) => legFindingIds.includes(f.id));
  return {
    result: failed ? 'FAIL' : notEvaluableRuns.length > 0 ? 'NOT_EVALUABLE' : evaluatedRuns.length === 0 ? 'NOT_EVALUABLE' : 'PASS',
    evaluated_runs: evaluatedRuns,
  };
}

// ---- leg 3: attribution, copies, malformed JSONL -----------------------

function parseReceipts(receiptMember) {
  // Receipts are host-owned operation-journal records, NOT native tamandua
  // events (they carry no `event`/`runId` native shape), so they are parsed
  // as raw JSONL here rather than through parseEventStream.
  if (!receiptMember) return [];
  const out = [];
  const text = receiptMember.bytes.toString('utf8');
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue;
    try {
      const obj = JSON.parse(rawLine);
      if (obj !== null && typeof obj === 'object') out.push(obj);
    } catch {
      // A malformed receipt line is evidence corruption: fail closed.
      throw new O7EvidenceError(`receipts member contains a malformed JSONL line`);
    }
  }
  return out;
}

function leg3Attribution(ctx, sidecar, streams, knownRuns, deletedRuns, syntheticRuns) {
  const { train } = streams;
  ctx.counts.global_lines = train.events.length;
  ctx.counts.malformed_lines += train.malformed.length;

  const allStreamFiles = [];
  for (const stream of streams.perRun.values()) allStreamFiles.push({ name: stream.roleLabel, parsed: stream.parsed });
  for (const stream of streams.otherStreams.values()) allStreamFiles.push({ name: stream.roleLabel, parsed: stream.parsed });
  for (const seg of streams.globalSegments) {
    allStreamFiles.push({ name: seg.kind === 'live' ? 'all.jsonl' : `all.jsonl.${seg.archiveIndex}`, parsed: seg.parsed });
  }

  // malformed / truncated JSONL in every captured stream
  for (const { name, parsed } of allStreamFiles) {
    for (const bad of parsed.malformed) {
      ctx.counts.malformed_lines += 1;
      ctx.fail('O7_MALFORMED_LINE', `malformed JSONL record in ${name} line ${bad.lineIndex} (${bad.reason})`, { file: name, line: bad.lineIndex, reason: bad.reason, sha256: bad.rawSha256 });
    }
    if (parsed.lineCount > 0 && !parsed.endsWithNewline) {
      ctx.fail('O7_TRUNCATED_FINAL_LINE', `stream ${name} does not end with a newline (native emitter always terminates lines)`, { file: name });
    }
  }

  // byte-identical duplicates within one file
  for (const { name, parsed } of allStreamFiles) {
    for (const dup of duplicateLinesWithin(parsed)) {
      ctx.fail('O7_DUPLICATE_LINE', `byte-identical duplicate line in ${name} (lines ${dup.firstLineIndex} and ${dup.secondLineIndex})`, { file: name, first_line: dup.firstLineIndex, second_line: dup.secondLineIndex, sha256: dup.rawSha256 });
    }
  }

  // empty-runId events + manual-operation ledger
  const ledger = sidecar.raw.manual_ledger ?? [];
  const emptyCandidates = train.events.filter((e) => eventRunId(e.event) === '');
  ctx.counts.empty_run_events = emptyCandidates.length;
  const consumedLedger = new Array(ledger.length).fill(false);
  for (const candidate of emptyCandidates) {
    const ev = candidate.event;
    let exempt = false;
    for (let li = 0; li < ledger.length; li += 1) {
      if (consumedLedger[li]) continue;
      const entry = ledger[li];
      if (entry.event !== ev.event) continue;
      const identity = entry.identity && typeof entry.identity === 'object' ? entry.identity : {};
      let matches = true;
      for (const [key, value] of Object.entries(identity)) {
        if (ev[key] !== value) { matches = false; break; }
      }
      if (!matches) continue;
      consumedLedger[li] = true;
      exempt = true;
      break;
    }
    if (!exempt) {
      ctx.fail('O7_EMPTY_RUN_ID_EVENT', `event ${ev.event}@L${candidate.lineIndex} carries an empty runId and matches no host-predeclared manual-operation ledger entry`, { event: ev.event, line: candidate.lineIndex });
    }
  }
  for (let li = 0; li < ledger.length; li += 1) {
    if (!consumedLedger[li]) {
      ctx.infoNote('O7_LEDGER_UNMATCHED', `manual-operation ledger entry ${ledger[li].entry_id} (${ledger[li].event}) was not matched by any captured empty-runId event`, { entry_id: ledger[li].entry_id, event: ledger[li].event });
    }
  }
  const emptyStream = streams.perRun.get('');
  if (emptyStream) {
    const inside = emptyStream.parsed.events.filter((e) => eventRunId(e.event) === '');
    const foreign = emptyStream.parsed.events.length - inside.length;
    if (foreign > 0) {
      ctx.fail('O7_ATTRIBUTION_MISMATCH', `events/.jsonl contains ${foreign} event(s) whose runId is not empty`, { foreign });
    }
    ctx.infoNote('O7_HIDDEN_EMPTY_STREAM', `hidden empty-runId stream events/.jsonl exists with ${emptyStream.parsed.events.length} event(s); reconciled against the manual-operation ledger`, { events: emptyStream.parsed.events.length });
  }

  // per-run <-> global copy correspondence, BOTH ways.
  //
  // The native emitter appends the SAME serialized line to the run's
  // per-run file and to the global train (per-run first, then global), so a
  // FULLY captured per-run stream of a run must equal — line-for-line and in
  // order — that run's slice of the global train (which may straddle rotated
  // segment boundaries). One-direction subsequence containment is NOT
  // enough: an extra known-run event present only in the global train, a
  // missing member, or a reordered/duplicated line must each fail.
  //
  // A host may declare a BOUNDED/PARTIAL per-run capture via
  // sidecar.per_run_capture[<runId>] = {kind:'partial', declared_prefix_lines:N}.
  // That declares coverage to the first N lines of the stream; O7 then only
  // requires the captured prefix to equal the global slice prefix of the same
  // length and records the declared bound — it never silently PASSes a
  // partial capture as a full one.
  const perRunCoverage = sidecar.raw.per_run_capture ?? {};
  for (const [runId, stream] of streams.perRun) {
    const runEvents = stream.parsed.events;
    for (const entry of runEvents) {
      const actual = eventRunId(entry.event);
      if (actual !== runId) {
        ctx.fail('O7_ATTRIBUTION_MISMATCH', `event ${entry.event.event}@L${entry.lineIndex} in stream ${stream.roleLabel} carries runId "${actual}"`, { stream: stream.roleLabel, event: entry.event.event, line: entry.lineIndex, run_id: actual });
      }
    }
    const slice = train.events.filter((e) => eventRunId(e.event) === runId);
    const declaration = perRunCoverage[runId] ?? null;
    const declaredPartial = declaration !== null && declaration.kind === 'partial';
    const hashSeq = (list) => list.map((entry) => entry.rawSha256);
    if (declaredPartial) {
      const bound = Number(declaration.declared_prefix_lines);
      if (!Number.isSafeInteger(bound) || bound <= 0) {
        ctx.fail('O7_COPY_MISMATCH', `per-run stream ${stream.roleLabel} declares a partial capture with an invalid bound ${JSON.stringify(declaration)}`, { run_id: runId === '' ? null : runId });
      } else if (runEvents.length > bound) {
        ctx.fail('O7_COPY_MISMATCH', `per-run stream ${stream.roleLabel} has ${runEvents.length} captured events, exceeding its declared partial bound of ${bound}`, { run_id: runId === '' ? null : runId, captured: runEvents.length, declared_bound: bound });
      } else {
        const slicePrefix = hashSeq(slice).slice(0, runEvents.length);
        const perHash = hashSeq(runEvents);
        if (JSON.stringify(slicePrefix) !== JSON.stringify(perHash)) {
          ctx.fail('O7_COPY_MISMATCH', `per-run stream ${stream.roleLabel} (${runEvents.length} events) is a declared partial capture whose prefix does not match the global train slice prefix (missing member, reorder, or tamper within the declared window)`, { run_id: runId === '' ? null : runId, events: runEvents.length, declared_bound: bound });
        } else {
          ctx.infoNote('O7_PARTIAL_PER_RUN_COVERAGE', `per-run stream ${stream.roleLabel} is a host-declared PARTIAL capture bounded to ${bound} lines; correspondence with the global train is verified only for the captured ${runEvents.length} prefix lines — full-stream coverage is not claimed`, { run_id: runId === '' ? null : runId, declared_bound: bound, captured_lines: runEvents.length });
        }
      }
    } else {
      const perHash = hashSeq(runEvents);
      const sliceHash = hashSeq(slice);
      if (JSON.stringify(perHash) !== JSON.stringify(sliceHash)) {
        let direction;
        if (perHash.length > sliceHash.length) {
          direction = `per-run stream carries ${perHash.length - sliceHash.length} event(s) absent from the run's global-train slice`;
        } else if (sliceHash.length > perHash.length) {
          direction = `global train slice carries ${sliceHash.length - perHash.length} event(s) for the run absent from its captured per-run stream`;
        } else {
          direction = 'captured per-run stream and its global-train slice differ in line order/bytes';
        }
        ctx.fail('O7_COPY_MISMATCH', `per-run stream ${stream.roleLabel} does not correspond BOTH ways with its global train slice: ${direction}`, { run_id: runId === '' ? null : runId, per_run_events: perHash.length, global_slice_events: sliceHash.length, direction });
      }
    }
    if (runId !== '' && !knownRuns.has(runId) && !deletedRuns.has(runId) && !syntheticRuns.has(runId)) {
      ctx.fail('O7_ORPHAN_RUN_STREAM', `captured stream ${stream.roleLabel} names a run with no DB row and no deleted-run receipt`, { run_id: runId, events: runEvents.length });
    }
  }
  const capturedPerRunIds = new Set(streams.perRun.keys());
  const trainRunIds = new Set(train.events.map((e) => eventRunId(e.event)).filter((r) => r !== ''));
  for (const runId of trainRunIds) {
    if (!capturedPerRunIds.has(runId) && !knownRuns.has(runId) && !deletedRuns.has(runId) && !syntheticRuns.has(runId)) {
      ctx.infoNote('O7_UNSCOPED_GLOBAL_EVENTS', `global train carries events for run ${runId} whose per-run stream was not captured (run outside declared scope)`, { run_id: runId });
    }
  }

  const legFindingIds = ['O7_EMPTY_RUN_ID_EVENT', 'O7_ATTRIBUTION_MISMATCH', 'O7_COPY_MISMATCH', 'O7_ORPHAN_RUN_STREAM', 'O7_MALFORMED_LINE', 'O7_TRUNCATED_FINAL_LINE', 'O7_DUPLICATE_LINE'];
  return { result: ctx.failing.some((f) => legFindingIds.includes(f.id)) ? 'FAIL' : 'PASS' };
}

// ---- leg 4: HUSH noise -------------------------------------------------

function leg4Hush(ctx, sidecar, streams) {
  const debug = sidecar.debugIntent; // {raw, enabled: true|false|null}
  const scan = (entries) => entries.filter((e) => NOISE_EVENTS.includes(e.event.event));
  // LOGICAL HUSH count: the native emitter appends each event to BOTH the
  // global train (all.jsonl + its retained archives) and the run's per-run
  // copy (events/.jsonl for empty-runId events), so the same raw event line
  // physically appears in several captured members. Counting every physical
  // copy would double-count one logical HUSH event in by_kind/hush_total.
  // Count each DISTINCT raw line (rawSha256) once across the global train
  // and every per-run/empty-run copy; a byte-identical repeat within a
  // single file is already its own leg3 O7_DUPLICATE_LINE finding.
  const unique = new Map(); // rawSha256 -> {event, copies:Set<streamLabel>}
  const recordCopies = (streamLabel, entries) => {
    for (const entry of scan(entries)) {
      if (!unique.has(entry.rawSha256)) unique.set(entry.rawSha256, { event: entry.event, copies: new Set() });
      unique.get(entry.rawSha256).copies.add(streamLabel);
    }
  };
  recordCopies('global-train', streams.train.events);
  for (const [runId, stream] of streams.perRun) {
    recordCopies(runId === '' ? 'events/.jsonl' : `events/${runId}.jsonl`, stream.parsed.events);
  }
  const allHush = [...unique.values()];
  const byKind = {};
  for (const kind of NOISE_EVENTS) byKind[kind] = allHush.filter((e) => e.event.event === kind).length;
  const physicalOccurrences = allHush.reduce((n, h) => n + h.copies.size, 0);
  ctx.counts.hush = byKind;
  ctx.counts.hush_total = allHush.length;
  ctx.counts.hush_physical_copies = physicalOccurrences;

  const enabled = debug?.enabled;
  if (enabled === true) {
    ctx.infoNote('O7_HUSH_DEBUG_CONTROL', `HUSH events present (${allHush.length} distinct raw events, ${physicalOccurrences} physical per-run+global copy occurrences) under recorded debug intent — recorded as the debug control, not a normal-mode regression`, { count: allHush.length, physical_copies: physicalOccurrences, debug_events_env: sidecar.raw.capture?.debug_events_env ?? null, copy_semantics: 'count = distinct raw lines across global + per-run physical copies' });
  } else {
    if (allHush.length > 0) {
      ctx.fail('O7_HUSH_NOISE_REGRESSION', `${allHush.length} distinct HUSH event(s) (${Object.entries(byKind).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(', ')}) present under normal debug-off operation`, { count: allHush.length, physical_copies: physicalOccurrences, by_kind: byKind, copy_semantics: 'count = distinct raw lines across global + per-run physical copies' });
    } else if (enabled === null) {
      ctx.infoNote('O7_HUSH_INTENT_UNKNOWN', 'no HUSH events observed and debug intent is unknown — absence recorded', {});
    }
  }

  const probeOff = streams.otherStreams.get('probe-debug-off');
  const probeOn = streams.otherStreams.get('probe-debug-on');
  if (probeOff) {
    const n = scan(probeOff.parsed.events).length;
    if (n !== 0) ctx.fail('O7_HUSH_PROBE', `debug-off probe stream contains ${n} HUSH event(s) — native filter failed to drop noise`, { count: n });
  }
  if (probeOn) {
    const n = scan(probeOn.parsed.events).length;
    if (n === 0) ctx.fail('O7_HUSH_PROBE', 'debug-on probe stream contains no HUSH events (native filter not proven to emit under debug)', {});
  } else if (sidecar.captureKind === 'rotation-gate') {
    ctx.fail('O7_HUSH_PROBE', 'rotation-gate capture declares no probe-debug-on member', {});
  }
  if (probeOn !== undefined && probeOff === undefined) {
    ctx.fail('O7_HUSH_PROBE', 'rotation-gate capture declares probe-debug-on without probe-debug-off', {});
  }
  const legFindingIds = ['O7_HUSH_NOISE_REGRESSION', 'O7_HUSH_PROBE'];
  return { result: ctx.failing.some((f) => legFindingIds.includes(f.id)) ? 'FAIL' : 'PASS', debug_intent: debug, by_kind: byKind };
}

// ---- leg 5: rotation bounds + train preservation + gate reconstruction --

function leg5Rotation(ctx, sidecar, streams, receipts, volumePlan) {
  const cap = NATIVE_MAX_EVENTS_FILE_SIZE;
  const notes = [];
  for (const seg of streams.globalSegments) {
    const parsed = seg.parsed;
    const label = seg.kind === 'live' ? 'all.jsonl' : `all.jsonl.${seg.archiveIndex}`;
    const overshootAllowance = parsed.lineCount > 0 ? Math.max(parsed.lastLineLength, 1) : 0;
    if (parsed.byteLength > cap + overshootAllowance) {
      ctx.fail('O7_ROTATION_OVERSIZE', `global segment ${label} is ${parsed.byteLength} bytes, exceeding the native 20 MiB cap by more than its final full event`, { file: label, size: parsed.byteLength, cap, overshoot: parsed.byteLength - cap, last_line_bytes: parsed.lastLineLength });
    }
    notes.push(`${label}: ${parsed.byteLength} bytes vs nominal cap ${cap}`);
  }
  const archiveIndices = streams.globalSegments.filter((s) => s.kind === 'archive').map((s) => s.archiveIndex).sort((a, b) => a - b);
  let generation = null;
  if (streams.generation !== null && streams.generation !== '') {
    generation = Number(streams.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      ctx.fail('O7_ROTATION_GENERATION_MISMATCH', `generation file content "${streams.generation}" is not a non-negative integer`, { content: streams.generation });
      generation = null;
    } else {
      const expectedArchives = [];
      for (let i = 1; i <= Math.min(generation, NATIVE_MAX_ROTATED_EVENTS_FILES); i += 1) expectedArchives.push(i);
      const missing = expectedArchives.filter((i) => !archiveIndices.includes(i));
      if (missing.length > 0) {
        ctx.fail('O7_ROTATION_GENERATION_MISMATCH', `generation ${generation} implies archives ${expectedArchives.join(',')} but archive(s) ${missing.join(',')} are absent`, { generation, missing });
      }
      const extra = archiveIndices.filter((i) => i > NATIVE_MAX_ROTATED_EVENTS_FILES);
      if (extra.length > 0) {
        ctx.fail('O7_ROTATION_RETENTION', `archive retention exceeded: archive(s) all.jsonl.${extra.join(', all.jsonl.')} beyond the native ${NATIVE_MAX_ROTATED_EVENTS_FILES}`, { extra });
      }
      if (generation > NATIVE_MAX_ROTATED_EVENTS_FILES) {
        notes.push(`generation ${generation} > ${NATIVE_MAX_ROTATED_EVENTS_FILES}: oldest archive pruned by native retention (observed, expected)`);
      }
      const livePresent = streams.globalSegments.some((s) => s.kind === 'live');
      if (!livePresent && generation >= 1) {
        ctx.infoNote('O7_LIVE_ABSENT_AFTER_ROTATION', 'live all.jsonl absent immediately after rotation (native emitter recreates it on the next append)', { generation });
      }
    }
  } else if (archiveIndices.length > 0) {
    ctx.fail('O7_ROTATION_GENERATION_MISMATCH', `archives present (${archiveIndices.join(',')}) but no generation member captured`, { archives: archiveIndices });
  }

  const gateResult = { applied: false, expected_volume: 0, observed_volume: 0, lifecycle: {} };
  if (sidecar.captureKind === 'rotation-gate') {
    gateResult.applied = true;
    if (!volumePlan || !Array.isArray(volumePlan.bursts) || volumePlan.bursts.length === 0) {
      ctx.notEvaluable('leg5: rotation-gate volume plan is empty or malformed');
    } else {
      // Declared volume sequence: the host volume plan lists bursts in
      // emission order with a contiguous ascending seq range each. The full
      // expected train of volume events is therefore the plan's bursts
      // concatenated in plan order (independent of the streams under test).
      const expectedSeq = []; // [{burst, seq}] in declared order
      const perBurst = new Map();
      for (const burst of volumePlan.bursts) {
        const { burst_id: burstId, event, run_id: runId, workflow_id: workflowId, step_id: stepId, seq_start: seqStart, seq_end: seqEnd } = burst;
        if (!Number.isSafeInteger(seqStart) || !Number.isSafeInteger(seqEnd) || seqEnd <= seqStart || typeof burstId !== 'string') {
          ctx.notEvaluable(`leg5: volume burst has invalid declaration (id/seq bounds)`);
          continue;
        }
        perBurst.set(burstId, { event, runId, workflowId, stepId, seqStart, seqEnd });
        for (let seq = seqStart; seq < seqEnd; seq += 1) {
          expectedSeq.push({ burstId, seq });
        }
      }
      gateResult.expected_volume = expectedSeq.length;
      const observedSeq = []; // [{burst, seq}] in physical train order
      for (const entry of streams.train.events) {
        const ev = entry.event;
        if (ev.event !== 'o7.gate.volume') continue;
        const burstId = ev.burst;
        const seq = ev.seq;
        const key = `${burstId}:${seq}`;
        const planBurst = perBurst.get(burstId);
        if (!planBurst || seq < planBurst.seqStart || seq >= planBurst.seqEnd) {
          ctx.fail('O7_VOLUME_UNPLANNED', `volume event ${key} not declared in the host volume plan`, { burst: burstId, seq });
          continue;
        }
        if (ev.runId !== planBurst.runId || ev.workflowId !== planBurst.workflowId || ev.stepId !== planBurst.stepId || ev.event !== planBurst.event) {
          ctx.fail('O7_VOLUME_IDENTITY', `volume event ${key} identity does not match its plan declaration`, { burst: burstId, seq });
        }
        observedSeq.push({ burstId, seq });
      }
      gateResult.observed_volume = observedSeq.length;
      ctx.counts.volume_events = observedSeq.length;

      // Sequence membership + order + count: the observed volume events must
      // be EXACTLY the declared sequence — same members, same order. A
      // missing member, a duplicate, an unplanned member, or a reordered
      // (out-of-declared-order) member across rotation segments fails.
      const observedKeys = observedSeq.map((o) => `${o.burstId}:${o.seq}`);
      const expectedKeys = expectedSeq.map((e) => `${e.burstId}:${e.seq}`);
      const observedSet = new Set(observedKeys);
      const missing = expectedKeys.filter((k) => !observedSet.has(k));
      if (missing.length > 0) {
        ctx.fail('O7_VOLUME_MISSING', `${missing.length} expected volume event(s) absent from the global train (lost across rotation)`, { missing: missing.slice(0, 20), count: missing.length });
      }
      const seenInTrain = new Set();
      for (const key of observedKeys) {
        if (seenInTrain.has(key)) ctx.fail('O7_VOLUME_DUPLICATE', `volume event ${key} appears more than once in the global train`, {});
        seenInTrain.add(key);
      }
      if (observedKeys.length === expectedKeys.length) {
        for (let i = 0; i < expectedKeys.length; i += 1) {
          if (observedKeys[i] !== expectedKeys[i]) {
            const sameSet = observedKeys.length === expectedKeys.length
              && expectedKeys.every((k) => observedSet.has(k));
            if (sameSet) {
              ctx.fail('O7_VOLUME_REORDER', `volume events are reordered relative to the declared sequence: first divergence at train position ${i} (observed ${observedKeys[i]}, declared ${expectedKeys[i]})`, { position: i, observed: observedKeys[i], declared: expectedKeys[i] });
            } else {
              ctx.fail('O7_VOLUME_MISSING', `volume events diverge from the declared sequence at train position ${i} (observed ${observedKeys[i]}, declared ${expectedKeys[i]})`, { position: i, observed: observedKeys[i], declared: expectedKeys[i] });
            }
            break;
          }
        }
      }
    }

    // Lifecycle receipts -> expected event presence per run.
    const launched = new Map();
    const claimed = new Map();
    const completed = new Map();
    for (const receipt of receipts) {
      if (receipt.kind === 'launch') {
        const list = launched.get(receipt.run_id) ?? [];
        list.push(receipt);
        launched.set(receipt.run_id, list);
      } else if (receipt.kind === 'claim') {
        const key = `${receipt.run_id}|${receipt.step_id}`;
        claimed.set(key, (claimed.get(key) ?? 0) + 1);
      } else if (receipt.kind === 'complete' || receipt.kind === 'fail') {
        const key = `${receipt.run_id}|${receipt.step_id}|${receipt.kind}`;
        completed.set(key, (completed.get(key) ?? 0) + 1);
      }
    }
    for (const [runId, list] of launched) {
      const stream = streams.perRun.get(runId);
      if (!stream) {
        ctx.notEvaluable(`leg5: receipted run ${runId} has no per-run stream`);
        continue;
      }
      const runEvents = stream.parsed.events.filter((e) => eventRunId(e.event) === runId);
      const starts = runEvents.filter((e) => e.event.event === 'run.started').length;
      gateResult.lifecycle[runId] = gateResult.lifecycle[runId] ?? {};
      gateResult.lifecycle[runId].run_starts = starts;
      if (starts < list.length) {
        ctx.fail('O7_EXPECTED_EVENT_MISSING', `receipted run ${runId}: ${starts} run.started event(s) < ${list.length} receipted launch(es)`, { run_id: runId, expected: list.length, observed: starts });
      }
    }
    for (const [key, expectedCount] of claimed) {
      const [runId, stepId] = key.split('|');
      const stream = streams.perRun.get(runId);
      if (!stream) continue;
      const runEvents = stream.parsed.events.filter((e) => eventRunId(e.event) === runId && e.event.stepId === stepId);
      const runnings = runEvents.filter((e) => e.event.event === 'step.running').length;
      const dispatches = runEvents.filter((e) => e.event.event === 'dispatch.render.validated' && e.event.dispatched === true).length;
      gateResult.lifecycle[runId] = gateResult.lifecycle[runId] ?? {};
      gateResult.lifecycle[runId][`${stepId}:claims`] = { expected: expectedCount, step_running: runnings, dispatches };
      if (runnings < expectedCount) ctx.fail('O7_EXPECTED_EVENT_MISSING', `step ${stepId} of run ${runId}: ${runnings} step.running event(s) < ${expectedCount} receipted claim(s)`, { run_id: runId, step_id: stepId });
      if (runnings > expectedCount) ctx.fail('O7_EXPECTED_EVENT_EXTRA', `step ${stepId} of run ${runId}: ${runnings} step.running event(s) > ${expectedCount} receipted claim(s)`, { run_id: runId, step_id: stepId });
      if (dispatches < expectedCount) ctx.fail('O7_EXPECTED_EVENT_MISSING', `step ${stepId} of run ${runId}: ${dispatches} dispatch.render.validated event(s) < ${expectedCount} receipted claim(s)`, { run_id: runId, step_id: stepId });
      if (dispatches > expectedCount) ctx.fail('O7_EXPECTED_EVENT_EXTRA', `step ${stepId} of run ${runId}: ${dispatches} dispatch.render.validated event(s) > ${expectedCount} receipted claim(s)`, { run_id: runId, step_id: stepId });
    }
    for (const [key, expectedCount] of completed) {
      const parts = key.split('|');
      const runId = parts[0];
      const stepId = parts[1];
      const kind = parts[2];
      const stream = streams.perRun.get(runId);
      if (!stream) continue;
      const runEvents = stream.parsed.events.filter((e) => eventRunId(e.event) === runId && e.event.stepId === stepId);
      const terminalEvent = kind === 'complete' ? 'step.done' : 'step.failed';
      const terminals = runEvents.filter((e) => e.event.event === terminalEvent).length;
      gateResult.lifecycle[runId] = gateResult.lifecycle[runId] ?? {};
      gateResult.lifecycle[runId][`${stepId}:${terminalEvent}`] = { expected: expectedCount, observed: terminals };
      if (terminals < expectedCount) ctx.fail('O7_EXPECTED_EVENT_MISSING', `step ${stepId} of run ${runId}: ${terminals} ${terminalEvent} event(s) < ${expectedCount} receipted ${kind}(s)`, { run_id: runId, step_id: stepId });
      if (terminals > expectedCount) ctx.fail('O7_EXPECTED_EVENT_EXTRA', `step ${stepId} of run ${runId}: ${terminals} ${terminalEvent} event(s) > ${expectedCount} receipted ${kind}(s)`, { run_id: runId, step_id: stepId });
    }
    // Order: each run's live-journaled lifecycle receipts (launch then
    // claim/complete pairs, in the order the host observed them) must appear
    // as an ordered subsequence of the run's captured stream — the captured
    // stream is allowed to interleave other runs'/volume events, but the
    // run's own lifecycle order is pinned by the receipt journal, never
    // inferred from the final stream itself.
    const byRunReceipts = new Map();
    for (const receipt of receipts) {
      if (!['launch', 'claim', 'complete', 'fail'].includes(receipt.kind)) continue;
      if (typeof receipt.run_id !== 'string') continue;
      if (!byRunReceipts.has(receipt.run_id)) byRunReceipts.set(receipt.run_id, []);
      byRunReceipts.get(receipt.run_id).push(receipt);
    }
    for (const [runId, receiptList] of byRunReceipts) {
      const stream = streams.perRun.get(runId);
      if (!stream) continue;
      const runEvents = stream.parsed.events.filter((e) => eventRunId(e.event) === runId);
      let cursor = 0;
      for (const receipt of receiptList) {
        const want = receipt.kind === 'launch' ? 'run.started'
          : receipt.kind === 'claim' ? 'step.running'
            : receipt.kind === 'complete' ? 'step.done' : 'step.failed';
        const matchedAt = runEvents.findIndex((entry, index) => index >= cursor
          && entry.event.event === want
          && (receipt.kind === 'launch' || entry.event.stepId === receipt.step_id));
        if (matchedAt === -1) {
          ctx.fail('O7_EXPECTED_EVENT_MISSING', `receipted lifecycle event ${receipt.kind} (${want}) for run ${runId} step ${receipt.step_id ?? '-'} is absent or out of order in the captured run stream`, { run_id: runId, kind: receipt.kind, step_id: receipt.step_id ?? null });
          break;
        }
        cursor = matchedAt + 1;
      }
    }
  } else {
    ctx.notes.push('leg5: batch capture — no receipts/volume-plan expected; structural rotation/train checks above');
  }

  const legFindingIds = ['O7_ROTATION_OVERSIZE', 'O7_ROTATION_GENERATION_MISMATCH', 'O7_ROTATION_RETENTION', 'O7_VOLUME_UNPLANNED', 'O7_VOLUME_IDENTITY', 'O7_VOLUME_DUPLICATE', 'O7_VOLUME_MISSING', 'O7_VOLUME_REORDER', 'O7_EXPECTED_EVENT_MISSING', 'O7_EXPECTED_EVENT_EXTRA'];
  return { result: ctx.failing.some((f) => legFindingIds.includes(f.id)) ? 'FAIL' : 'PASS', notes, gateResult };
}

// ---- artifact writer (exclusive-create, contained) ---------------------

function writeArtifact(evidenceDir, relativePath, content) {
  const resolvedDir = fs.realpathSync(evidenceDir);
  const target = path.resolve(evidenceDir, relativePath);
  const rel = path.relative(resolvedDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    throw new O7EvidenceError(`artifact path escapes the evidence directory: ${relativePath}`);
  }
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (error) {
    throw new O7EvidenceError(`exclusive evidence create failed for ${relativePath}: ${error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { path: relativePath, kind: 'json' };
}

// ---- top-level evaluation ----------------------------------------------

/**
 * Evaluate the O7 obligations over a loaded sidecar.
 * @returns {{result: string, artifact: Object}}
 */
export function evaluateO7(sidecar, options = {}) {
  const ctx = new O7Context(sidecar);
  const coverage = [];

  const streams = buildStreams(sidecar);
  const db = openDb(sidecar);
  const runsColumns = pragmaColumns(db, 'runs');
  let dbRuns = null;
  if (runsColumns !== null && runsColumns.has('id') && runsColumns.has('status')) {
    try {
      dbRuns = db.prepare(`SELECT id, status, updated_at FROM runs`).all();
    } catch {
      dbRuns = null;
    }
  }
  if (dbRuns === null) ctx.notEvaluable('leg1: runs table/columns missing from db-snapshot');

  const stepsByRun = new Map();
  let stepsOk = true;
  for (const runId of sidecar.raw.scope_runs) {
    const columns = pragmaColumns(db, 'steps');
    if (columns === null || !['id', 'run_id', 'step_id', 'status'].every((c) => columns.has(c))) {
      stepsOk = false;
      break;
    }
    const wanted = [...columns].filter((c) => ['id', 'run_id', 'step_id', 'status', 'type', 'auto_completed', 'auto_complete_reason', 'claim_job_id', 'claim_updated_at', 'updated_at'].includes(c));
    try {
      const sql = `SELECT ${wanted.map((c) => `"${c}"`).join(', ')} FROM steps WHERE run_id = ?`;
      stepsByRun.set(runId, db.prepare(sql).all(runId));
    } catch {
      stepsOk = false;
      break;
    }
  }
  if (!stepsOk) ctx.notEvaluable('leg2: steps table/columns missing from db-snapshot');

  const knownRuns = new Set((dbRuns ?? []).map((r) => r.id));
  const deletedByRun = new Map((sidecar.raw.deleted_runs ?? []).map((d) => [d.run_id, d]));
  const deletedRunIds = new Set(deletedByRun.keys());
  const syntheticRuns = new Set(sidecar.raw.synthetic_streams ?? []);

  for (const runId of sidecar.raw.scope_runs) {
    if (!knownRuns.has(runId) && !deletedByRun.has(runId)) {
      ctx.notEvaluable(`scope run ${runId} is absent from both the DB snapshot and the deleted-run receipts`);
    }
  }

  // Per-run event sourcing: run-scoped obligations normally read the run's
  // captured per-run stream. A run whose per-run capture is host-declared
  // PARTIAL is evaluated on its full global-train slice instead (with the
  // declared coverage recorded) — the bounded per-run copy is still checked
  // for prefix correspondence in leg3, but is never silently treated as a
  // full stream.
  const partialRuns = new Set();
  for (const [runKey, declaration] of Object.entries(sidecar.raw.per_run_capture ?? {})) {
    if (declaration !== null && typeof declaration === 'object' && declaration.kind === 'partial') partialRuns.add(runKey);
  }
  const entriesForRun = (runId) => {
    const stream = streams.perRun.get(runId);
    if (stream === undefined) return null;
    if (partialRuns.has(runId)) {
      return streams.train.events.filter((e) => eventRunId(e.event) === runId);
    }
    return stream.parsed.events;
  };

  // leg 1
  const leg1 = dbRuns === null
    ? { result: 'NOT_EVALUABLE', applied_runs: [], terminal_runs_judged: [], not_evaluable_runs: [] }
    : leg1Terminal(ctx, sidecar, streams, dbRuns, deletedByRun, entriesForRun, partialRuns);
  coverage.push({ obligation: 'leg1', label: 'terminal-run terminal-event binding and chronology', result: leg1.result, applied_runs: leg1.applied_runs, judged_runs: leg1.terminal_runs_judged, not_evaluable_runs: leg1.not_evaluable_runs });

  // leg 2
  const leg2 = !stepsOk
    ? { result: 'NOT_EVALUABLE', evaluated_runs: [] }
    : leg2Claims(ctx, sidecar, streams, stepsByRun, entriesForRun, partialRuns);
  coverage.push({ obligation: 'leg2', label: 'no step completion before its claim (native auto-complete exception only)', result: leg2.result, evaluated_runs: leg2.evaluated_runs });

  // leg 3
  const leg3 = leg3Attribution(ctx, sidecar, streams, knownRuns, deletedRunIds, syntheticRuns);
  coverage.push({ obligation: 'leg3', label: 'campaign run attribution / copies / malformed JSONL', result: leg3.result });

  // leg 4
  const leg4 = leg4Hush(ctx, sidecar, streams);
  coverage.push({ obligation: 'leg4', label: 'HUSH noise under debug-off + real-emitter probes', result: leg4.result, debug_intent: leg4.debug_intent, hush_by_kind: leg4.by_kind });

  // leg 5
  const receipts = parseReceipts(sidecar.members.get('receipts') ?? null);
  let volumePlan = null;
  const volumeMember = sidecar.members.get('volume-plan');
  if (volumeMember) {
    try {
      volumePlan = JSON.parse(volumeMember.bytes.toString('utf8'));
    } catch (error) {
      ctx.notEvaluable(`leg5: volume-plan member is not valid JSON (${error.message})`);
    }
  }
  const leg5 = leg5Rotation(ctx, sidecar, streams, receipts, volumePlan);
  coverage.push({ obligation: 'leg5', label: 'rotation bounds + complete train preservation' + (sidecar.captureKind === 'rotation-gate' ? ' + gate reconstruction' : ''), result: leg5.result, notes: leg5.notes, gate: leg5.gateResult });

  const failing = ctx.failing.length;
  const result = failing > 0 ? 'FAIL' : ctx.neReasons.length > 0 ? 'NOT_EVALUABLE' : 'PASS';

  const artifact = {
    schema_version: 1,
    oracle_id: 'O7',
    capture_kind: sidecar.captureKind,
    result,
    started_at: options.startedAt ?? null,
    finished_at: new Date().toISOString(),
    coverage,
    counts: ctx.counts,
    notes: ctx.notes,
    findings: ctx.failing.map((f) => ({ ...f })),
    informational: ctx.info.map((f) => ({ ...f })),
    sidecar: {
      producer: sidecar.raw.capture.producer,
      captured_at: sidecar.raw.capture.captured_at,
      events_captured_at: sidecar.raw.capture.events_captured_at,
      db_captured_at: sidecar.raw.capture.db_captured_at,
      state_dir_identity: sidecar.raw.capture.state_dir_identity,
      product: sidecar.raw.product,
      scope_runs: sidecar.raw.scope_runs,
      debug_events_env: sidecar.raw.capture?.debug_events_env ?? null,
      launch_intent: sidecar.raw.capture?.launch_intent ?? null,
    },
    not_evaluable_reasons: ctx.neReasons,
  };
  return { result, artifact, ctx };
}

// ---- CLI main ----------------------------------------------------------

export function parseO7Args(argv) {
  const args = argv.slice(2);
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--sidecar') {
      values.sidecar = args[i + 1];
      i += 1;
    } else if (arg === '--evidence-dir') {
      values.evidenceDir = args[i + 1];
      i += 1;
    } else {
      throw new O7EvidenceError(`unknown argument ${arg}`);
    }
  }
  if (typeof values.sidecar !== 'string') throw new O7EvidenceError('missing --sidecar <absolute-path>');
  if (typeof values.evidenceDir !== 'string') throw new O7EvidenceError('missing --evidence-dir <absolute-path>');
  if (!path.isAbsolute(values.sidecar)) throw new O7EvidenceError('--sidecar must be an absolute path');
  if (!path.isAbsolute(values.evidenceDir)) throw new O7EvidenceError('--evidence-dir must be an absolute path');
  return { sidecar: values.sidecar, evidenceDir: values.evidenceDir };
}

export async function main({ argv = process.argv, stdout = process.stdout } = {}) {
  const startedAt = new Date().toISOString();
  const oracleId = 'O7';
  let evidenceDir = null;
  let response;
  try {
    const parsed = parseO7Args(argv);
    evidenceDir = parsed.evidenceDir;
    const evidenceDetails = fs.lstatSync(evidenceDir);
    if (!evidenceDetails.isDirectory() || evidenceDetails.isSymbolicLink()) {
      throw new O7EvidenceError('--evidence-dir must be an existing non-symlink directory');
    }
    const sidecar = loadO7Sidecar(parsed.sidecar);
    const evaluation = evaluateO7(sidecar, { startedAt });
    const artifact = evaluation.artifact;
    const entry = writeArtifact(evidenceDir, O7_REPORT_ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`);
    const findings = artifact.result === 'NOT_EVALUABLE'
      ? []
      : [...artifact.findings.map((f) => ({ id: f.id, summary: f.summary, ...stripMeta(f) })), ...artifact.informational];
    response = buildOracleResponse({
      oracleId,
      result: artifact.result,
      startedAt,
      findings,
      evidence: [entry],
    });
  } catch (error) {
    response = buildOracleResponse({
      oracleId,
      result: 'ERROR',
      startedAt,
      findings: [{ id: 'ORACLE_RUNTIME_ERROR', summary: error instanceof Error ? error.message : String(error) }],
      evidence: [],
    });
  }
  const expectedExit = RESULT_EXIT_CODES[response.result];
  let validationErrors = [];
  try {
    validationErrors = validateOracleResponse(response, oracleId, expectedExit, evidenceDir ?? process.cwd());
  } catch {
    validationErrors = [];
  }
  if (validationErrors.length > 0) {
    response = buildOracleResponse({
      oracleId,
      result: 'ERROR',
      startedAt,
      findings: [{ id: 'ORACLE_RUNTIME_ERROR', summary: `oracle produced an invalid outcome: ${validationErrors.join('; ')}` }],
      evidence: [],
    });
  }
  stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = RESULT_EXIT_CODES[response.result];
  return response;
}

function stripMeta(finding) {
  const cleaned = { ...finding };
  delete cleaned.non_failing;
  return cleaned;
}
