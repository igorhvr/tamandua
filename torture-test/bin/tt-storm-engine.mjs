// tt-storm-engine.mjs — STORM-W5 orchestration engine (Round A/B sequencing,
// queue admission observation, simultaneity sampler, phase-gated Round B
// chaos dispatch, resume/reattach, forensics report).
//
// Everything side-effecting goes through ctx.adapters (fs / clock / proc /
// db / git). The real CLI (bin/tt-storm) wires REAL adapters; the designated
// recording gate injects recording substitutes and a synthetic clock and
// drives the SAME functions below — the assertions observe the actual
// planned argv/API calls these functions emit, never a parallel pretend
// scheduler.
//
// The engine is honest by construction:
//   * intent is recorded BEFORE every launch (intent.jsonl + state), both
//     launch streams are captured for run-id evidence, and ambiguous or
//     missing provenance is REFUSED (TT_AMBIGUOUS_RUN / TT_MISSING_RUN) —
//     raw agent prose never establishes a verdict.
//   * resume/reattach re-attaches by captured run id; it NEVER relaunches a
//     run whose launch was already recorded (duplicate-launch protection).
//   * queue admission decisions are snapshot-based (freeSlots at decision
//     time); an early admit that is CORRECT is a pass, never a forced-queue
//     failure.
//   * the simultaneity sampler reports UNKNOWN for missing/unreadable
//     identity — never zero — and reports observed peak separately from the
//     configured target.
//   * every Round B chaos action requires phase_wait evidence immediately
//     before it fires; a phase that never materializes is recorded MISSED,
//     never silently skipped.
//   * cleanup is ledgered and failures PROPAGATE (a failed cleanup aborts
//     report finalization with the failure recorded).
//   * red / missing / inconclusive / NOT_RUN are first-class report states,
//     never normalized to green.
//
// The engine does NOT itself know how to qualify the real campaign: state
// carries `qualification` and the real launch paths refuse to run until the
// qualification marker is set by an operator decision (the scripted
// rehearsal + coordinator acceptance are the NEXT gate, spec 12 P3/P4).

import path from 'node:path';
import {
  ACTIVE_STEP_STATUSES,
  TERMINAL_RUN_STATUSES,
  normalizedStoredRunId,
  refusal,
  sampleDelayMs,
} from './tt-contention-slice-shared.mjs';
import {
  ROUND_A_QUEUED_STAGGER_MS,
  ROUND_A_ROSTER,
  ROUND_A_STAGGER_MS,
  ROUND_B_ROSTER,
  SAMPLER_INTERVAL_MS,
  POUND_INTERVAL_MS,
  POUND_LATENCY_BOUND_MS,
  rosterIdentityFromState,
} from './tt-storm-roster.mjs';
import {
  isRealProfile,
  parseProfile,
} from './tt-storm-profile.mjs';
// STORM-REAL US-008: the capacity-scaled lite roster + reduced chaos plan is a
// persisted campaign identity. The engine reads the scale from campaign state
// (never a CLI flag) to size the Round A window and select the lite Round B
// phase table.
import {
  activeReleaseTargetsFromState,
  activeReleaseTargetsForScale,
  expectedActiveCountFromState,
  isLiteScale,
  parseScale,
  roundBPhasesForScale,
  rosterForScale,
  rosterHarnessNames,
  rosterWorkflowIds,
  LITE_FIXTURE_NAME,
} from './tt-storm-scale.mjs';
// STORM-REAL US-002: REAL-profile harness binary resolution/pins. A REAL
// prepare resolves the operator's real roster harnesses BEFORE any effect and
// refuses TT_UNRESOLVED_BINARY when any is missing/unresolvable.
import {
  resolveRosterHarnessPins,
} from './tt-storm-harness-pins.mjs';
// STORM-REAL US-006: the REQUIRED hard spend cap for a REAL campaign.
// resolveSpendCapForProfile refuses a REAL profile without one BEFORE any
// effect; evaluateSpendCap is the PURE, injectable crossing arithmetic; and
// spendCapFromState reads the cap the campaign persisted at prepare (never a
// CLI re-derivation).
import {
  buildSpendHeadline,
  collectCampaignSpend,
  evaluateSpendCap,
  flushCampaignSpend,
  readSpendSnapshot,
  resolveSpendCapForProfile,
  spendCapFromState,
  unknownSpendSnapshot,
} from './tt-storm-spend.mjs';
import {
  ADMISSION_POLL_MS,
  ROUND_A_WEDGE_HARD_MS,
  ROUND_B_END_MS,
  STORM_INTENT_NAME,
  STORM_OPS_NAME,
  STORM_REPORT_JSON,
  STORM_REPORT_TXT,
  STORM_RESULTS_DIR,
  STORM_SAMPLES_NAME,
  STORM_STATE_NAME,
  S10_DRAIN_BOUND_MS,
  allocStormCampaignId,
  assertCampaignDestContained,
  deriveStormNumbers,
  extractRunEvidence,
  loadState,
  newCampaignState,
  opRecorder,
  parseRunKey,
  requireUnambiguousRunId,
  saveState,
  workflowRunArgv,
} from './tt-storm-shared.mjs';
// US-006 (SF-2 containment): the ONE ownership/containment verdict for a
// launch's resolved worktree origin lives in tt-storm-rehearsal.mjs (it owns
// the pathIsWithin convention) and is enforced here before any spawn.
import { assertLaunchOriginContained } from './tt-storm-rehearsal.mjs';
// US-004 (SF-14/15): the product merge-event evidence channel. The rugpull
// and park phase predicates are satisfied ONLY by real product events read
// from the private state dir's event JSONL streams — never by the
// orchestrator's own action record.
import { readProductMergeEvents } from './tt-storm-real.mjs';

// ─────────────────────────────────────────────────────────────────────
// State persistence with a fresh updated_at (reviewer issue G2: the
// launch-failure save path advanced the state FILE without bumping
// state.updated_at, confusing forensics). Every mutating save below goes
// through persistState so updated_at always reflects the last write.
// ─────────────────────────────────────────────────────────────────────
function persistState(ctx, campaignDir, state) {
  state.updated_at = ctx.clock.nowUtc();
  saveState({ fs: ctx.fs, campaignDir, state });
}

// US-006 (SF-7): short bounded poll cadence for the harvest-only observation
// pass (`runObservationLoop` with `sample:false`) that follows the standalone
// Round A sampler. The standalone sampler owns the 15s sample cadence; this
// pass only pumps queue admission + harvests terminal runs, so it must not
// sleep a whole sampler interval between checks.
const NO_SAMPLE_POLL_MS = 1_000;

// Run statuses that end a run's participation in the simultaneity sampler
// (mirrors the observation loop's STOPPED set).
const SAMPLER_STOPPED_STATUSES = new Set([
  'terminal',
  'launch_failed',
  'cap_abort',
  'drain_bound_exceeded',
  'unknown_run',
]);

// Parent/child run-row identity match that accepts BOTH product forms: the
// product DB stores bare-uuid ids/parent_run_id; the recording gate's
// synthetic DB keys rows by the public run-<uuid>. Comparing canonical bare
// AND public lowercase covers both without weakening attribution (a run row
// is matched only by its OWN id, in either form).
export function runParentMatches(row, runId) {
  if (!row?.parent_run_id || !runId) return false;
  const cand = [];
  if (row.parent_run_id_bare) cand.push(row.parent_run_id_bare);
  cand.push(String(row.parent_run_id).toLowerCase());
  const recLower = String(runId).toLowerCase();
  const parsed = parseRunKey(runId);
  const recBare = parsed.ok ? parsed.bare : recLower;
  return cand.includes(recBare) || cand.includes(recLower);
}

// ─────────────────────────────────────────────────────────────────────
// Real git ref evidence channel (phase markers that need landing/recovery
// evidence beyond DB rows). Returns null when the engine has no git adapter
// or the campaign owns no fixture repos; readRef resolves a ref to its
// commit sha via the REAL git binary through ctx.git. Failures surface as
// { ok:false, error } — the phase predicate reports evidence_error UNKNOWN.
// ─────────────────────────────────────────────────────────────────────
export function makeRefsChannel(ctx, state) {
  const ident = fixtureIdentity(ctx, state);
  if (typeof ctx?.git?.run !== 'function') return null;
  if (!ident.originRepo && !ident.colleagueRepo && !ident.parkRepo) return null;
  const readRef = async (repo, ref) => {
    if (!repo || !ref) return { ok: false, error: 'readRef requires a repo path and ref name' };
    try {
      const res = await ctx.git.run(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
      const sha = String(res?.stdout ?? '').trim();
      if (res?.exitCode === 0 && /^[0-9a-f]{40}$/i.test(sha)) return { ok: true, sha: sha.toLowerCase(), error: null };
      return { ok: false, sha: null, error: `git rev-parse ${ref} in ${repo} failed (exit ${res?.exitCode}): ${String(res?.stderr ?? '').trim().slice(0, 200)}` };
    } catch (err) {
      return { ok: false, sha: null, error: String(err?.message ?? err) };
    }
  };
  return { readRef, originRepo: ident.originRepo, colleagueRepo: ident.colleagueRepo, parkRepo: ident.parkRepo };
}

// Best-effort snapshot of the origin main head (used immediately BEFORE a
// colleague-commit / mass-rugpull dispatch so the landing predicate can later
// observe the tip moved). Never throws: returns { ok, sha, at } or { ok:false,
// error } — the marker stays not_yet until real ref evidence exists.
export async function snapshotOriginMain(ctx, state) {
  const channel = makeRefsChannel(ctx, state);
  if (!channel || !channel.originRepo) return { ok: false, error: 'no git ref channel / origin repo for snapshot' };
  const res = await channel.readRef(channel.originRepo, 'refs/heads/main');
  return { ok: res.ok, sha: res.sha ?? null, at: ctx.clock.nowUtc(), error: res.error ?? null };
}

// ─────────────────────────────────────────────────────────────────────
// US-004 (SF-14/15): product merge-event evidence for the two chaos phases
// whose contract is a PRODUCT reaction. The orchestrator's own action (a
// local colleague commit / a dirtied working tree) never counts; only the
// real merge.target_moved / merge.landed events the PRODUCT wrote to the
// private state dir's event streams do.
// ─────────────────────────────────────────────────────────────────────

// The chaos phases that must carry product-side evidence, and the live merge
// targets whose runs are the only runs that can emit it.
export const PRODUCT_EVIDENCE_PHASE_IDS = Object.freeze(['B-rugpull', 'B-park']);
// The four Round B worktree runs (B1..B4) whose SHARED merge target is the
// owned origin checkout (origin/main). Both the product-evidence scoping and
// the SF-15 `dirty_tree_park` action-target set are projections of this one
// list — the park bait dirties the single repo all four runs merge into.
export const B_MERGE_TARGET_IDS = Object.freeze(['B1', 'B2', 'B3', 'B4']);
export const PRODUCT_EVIDENCE_TARGET_IDS = B_MERGE_TARGET_IDS;

// productEvidenceForPhase — read the product merge events for one chaos phase
// from the private state dir, scoped to the phase's targeted merge runs and
// its own firedAt (events before the phase fired cannot stand in for it).
// Never throws: an absent channel is an explicit ok:false with a reason.
export function productEvidenceForPhase(ctx, state, phaseId) {
  const stateRoot = ctx?.opts?.execIdentity?.state_root
    ?? ctx?.opts?.stateRoot
    ?? state?.exec_identity?.state_root
    ?? null;
  const runIds = PRODUCT_EVIDENCE_TARGET_IDS
    .map((rid) => state?.rounds?.B?.runs?.[rid]?.runId)
    .filter(Boolean);
  const phaseState = state?.rounds?.B?.phases?.[phaseId] ?? null;
  const sinceUtc = phaseState?.firedAt ?? phaseState?.dispatchedAt ?? null;
  let read;
  try {
    read = readProductMergeEvents({ stateRoot, runIds, sinceUtc });
  } catch (err) {
    read = { ok: false, targetMoved: [], landed: [], parkLanding: [], error: String(err?.message ?? err) };
  }
  return { phaseId, sinceUtc, runIds, ...read };
}

// ─────────────────────────────────────────────────────────────────────
// US-005 (fix-4): engine-side ownership of the scripted-runtime holds.
//
// The SCRIPTED_REHEARSAL holds a designated step of every roster run
// mid-flight on per-run checkpoint FILES the zero-model runtime writes under
// the campaign's private hold dir: `<holdDir>/<runId>.confirmed` (runtime,
// on entering the hold), `<holdDir>/<runId>.missed` (runtime, on the bounded
// fail-closed timeout) and `<holdDir>/<runId>.release` (engine, when the
// phase/observation contract says the run may proceed). The engine must be
// able to (a) resolve the ONE campaign-owned hold dir, (b) decide whether a
// run is currently confirmed/missed, and (c) release holds — a single run and
// a whole roster including its relaunch/child lineage — without ever throwing
// and without ever guessing a cwd/HOME path (requirement 1a/1d).
//
// Every helper is pure-injected: reads/writes go through ctx.fs and time is
// stamped by ctx.clock, so the recording gate and the self-tests drive them
// with synthetic adapters and NO real filesystem.
// ─────────────────────────────────────────────────────────────────────

// resolveHoldDir — the campaign-owned hold dir. An explicit ABSOLUTE
// ctx.opts.holdDir wins; a relative one is ignored (never resolved against
// cwd/HOME). Otherwise it is derived from
// state.rehearsal.scripted_runtime.state_dir + '/holds'. Neither => null.
export function resolveHoldDir(ctx, state) {
  const explicit = ctx?.opts?.holdDir;
  if (typeof explicit === 'string' && path.isAbsolute(explicit)) return explicit;
  const stateDir = state?.rehearsal?.scripted_runtime?.state_dir;
  if (typeof stateDir === 'string' && stateDir.length > 0) return path.join(stateDir, 'holds');
  return null;
}

// holdConfirmation — read the run's hold markers through ctx.fs. A missing or
// unreadable marker is simply false (never a throw); the `.missed` reason is
// the JSON payload's `reason` string when present, else null.
export function holdConfirmation(ctx, state, runId) {
  const result = { confirmed: false, missed: false, missedReason: null };
  const holdDir = resolveHoldDir(ctx, state);
  if (!holdDir || typeof runId !== 'string' || runId.length === 0) return result;

  let confirmedRaw = null;
  let confirmedOk = false;
  try {
    confirmedRaw = ctx.fs.readFileSync(path.join(holdDir, `${runId}.confirmed`));
    confirmedOk = true;
  } catch { /* missing/unreadable -> not confirmed */ }
  if (confirmedOk && confirmedRaw !== null && confirmedRaw !== undefined) result.confirmed = true;

  let missedRaw = null;
  let missedOk = false;
  try {
    missedRaw = ctx.fs.readFileSync(path.join(holdDir, `${runId}.missed`));
    missedOk = true;
  } catch { /* missing/unreadable -> not missed */ }
  if (missedOk) {
    result.missed = true;
    try {
      const parsed = JSON.parse(typeof missedRaw === 'string' ? missedRaw : String(missedRaw));
      result.missedReason = parsed && typeof parsed.reason === 'string' ? parsed.reason : null;
    } catch {
      result.missedReason = null;
    }
  }
  return result;
}

// releaseHold — write `<holdDir>/<runId>.release` (JSON {runId, holdId,
// reason, ts}) and record the ops entry. A missing runId (or an unresolvable
// hold dir) is a RECORDED no-op returning false; this never throws. Rewriting
// the release file is fine (idempotent).
export function releaseHold(ctx, state, ops, runId, { id = null, reason = null } = {}) {
  if (typeof runId !== 'string' || runId.length === 0) {
    try { ops?.record?.('hold.release_skipped', { runId: runId ?? null, holdId: id ?? null, reason: reason ?? null, detail: 'no runId' }); } catch { /* never throw */ }
    return false;
  }
  const holdDir = resolveHoldDir(ctx, state);
  if (!holdDir) {
    try { ops?.record?.('hold.release_skipped', { runId, holdId: id ?? null, reason: reason ?? null, detail: 'no hold dir' }); } catch { /* never throw */ }
    return false;
  }
  try {
    ctx.fs.mkdirSync(holdDir, { recursive: true });
    const payload = {
      runId,
      holdId: id ?? null,
      reason: reason ?? null,
      ts: ctx?.clock?.nowUtc ? ctx.clock.nowUtc() : new Date().toISOString(),
    };
    ctx.fs.writeFileSync(path.join(holdDir, `${runId}.release`), JSON.stringify(payload) + '\n');
    try { ops?.record?.('hold.released', { runId, holdId: id ?? null, reason: reason ?? null }); } catch { /* never throw */ }
    return true;
  } catch (err) {
    try { ops?.record?.('hold.release_failed', { runId, holdId: id ?? null, reason: reason ?? null, error: String(err?.message ?? err) }); } catch { /* never throw */ }
    return false;
  }
}

// releaseHoldsForRoster — release every hold a roster entry owns: the current
// state run id, every recorded child run id (rec.children), and any run
// record whose `relaunchOf` lineage names this roster id (or its current run
// id) — the B5 stop/delete/relaunch lineage. Unknown roster ids / missing run
// ids are skipped; returns the list of runIds actually released.
export function releaseHoldsForRoster(ctx, state, ops, round, rosterIds, reason = null) {
  const released = [];
  const seen = new Set();
  const bucket = state?.rounds?.[round]?.runs;
  if (!bucket || typeof bucket !== 'object') return released;
  const holdId = state?.rehearsal?.hold_schedule?.hold_id ?? null;
  const ids = Array.isArray(rosterIds) ? rosterIds : [rosterIds];
  const consider = (runId) => {
    if (typeof runId !== 'string' || runId.length === 0 || seen.has(runId)) return;
    seen.add(runId);
    if (releaseHold(ctx, state, ops, runId, { id: holdId, reason })) released.push(runId);
  };
  for (const rid of ids) {
    if (typeof rid !== 'string' || rid.length === 0) continue;
    const rec = bucket[rid];
    if (!rec || typeof rec !== 'object') continue;
    const currentRunId = typeof rec.runId === 'string' && rec.runId ? rec.runId : null;
    consider(currentRunId);
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) consider(typeof child === 'string' ? child : child?.runId);
    }
    // Relaunch lineage: a record (e.g. B5-relaunch) whose relaunchOf names
    // this roster id, or this roster's current run id.
    for (const other of Object.values(bucket)) {
      const lo = other?.relaunchOf;
      if (typeof lo !== 'string' || lo.length === 0) continue;
      if (lo === rid || (currentRunId && lo === currentRunId)) consider(other.runId);
    }
  }
  return released;
}

// ─────────────────────────────────────────────────────────────────────
// US-007 (STORM-REHEARSAL-FIX4, SF-7/SF-8) — Round A hold release.
//
// US-006 starts the standalone simultaneity sampler at S1's launch so it sees
// the whole staggered window; US-007 wires the WINDOW OBSERVATION to hold
// RELEASE. Every S1..S8 runtime parks on its campaign hold (US-002/US-003), so
// the eight runs stay claimed/alive until the engine has actually sampled a
// zero-unknown sample where all eight are claimed — then (and only then) are
// their holds released. If the window never materializes, the bounded deadline
// releases them anyway with the HONEST observed peak (never the configured 8).
// The runtime's own bounded hold timeout is the final fail-closed backstop.
// ─────────────────────────────────────────────────────────────────────

// The Round A runs the eight-concurrent window releases: every NON-queued
// roster entry (S1..S8). Derived from the roster so it can never drift from
// the launch plan; S9/S10 are queued and released on admission instead.
export const ROUND_A_ACTIVE_RELEASE_TARGETS = Object.freeze(
  ROUND_A_ROSTER.filter((r) => !r.queued).map((r) => r.id),
);

// roundAWindowObserved — the exact honesty rule of simultaneityVerdict as a
// single-sample predicate: a Round A sample with NO unknown identity, at least
// the configured 8 runs sampled, and every NON-queued active roster run
// (S1..S8) present AND claimed in that sample. A roster run WITHOUT a recorded
// run id makes the window unobservable — the run is never silently dropped
// from the id set to flip the verdict true.
export function roundAWindowObserved(state) {
  const roundARuns = state?.rounds?.A?.runs ?? {};
  const activeRoster = Object.values(roundARuns).filter((r) => r && !r.queued);
  const configured = activeRoster.length;
  // STORM-REAL US-008: the window is judged against the campaign's ACTUAL
  // active roster size (full -> 8, lite -> 4), read from persisted scale. An
  // unscaled campaign is unchanged.
  const expected = expectedActiveCountFromState(state);
  if (configured < expected) return false;
  // Never drop a run that lacks a run id (reviewer I5 / spec 09 honesty rule).
  if (activeRoster.some((r) => !r.runId)) return false;
  const rosterRunIds = activeRoster.map((r) => r.runId);
  const samples = (state?.sampler?.samples ?? []).filter((s) => s && s.round === 'A');
  return samples.some((s) => {
    if ((s.unknown ?? 0) > 0) return false;
    if ((s.configured ?? 0) < expected) return false;
    return rosterRunIds.every((rid) => s.perRun?.[rid]?.claimed === true);
  });
}

// awaitRoundAWindowRelease — poll the (already running) Round A sampler until
// a real eight-concurrent window sample exists, then release S1..S8's holds;
// otherwise release them at the bounded deadline with the honest peak.
//
// `deadlineMs` is an ABSOLUTE ctx.clock.nowMs() timestamp. When omitted the
// bound is `now + round_a.window_deadline_ms` from the campaign's hold
// schedule, falling back to ROUND_A_WEDGE_HARD_MS. `pollMs` defaults to the
// 1s NO_SAMPLE_POLL_MS cadence.
//
// Never throws: an unexpected error fails closed by releasing the active
// roster holds (reason 'round_a_window_error') and recording the error, so a
// stuck engine can never leave a run held.
export async function awaitRoundAWindowRelease(ctx, state, ops, campaignDir, { deadlineMs = null, pollMs = null } = {}) {
  const nowMs = () => ctx.clock.nowMs();
  const declaredWindowMs = Number(state?.rehearsal?.hold_schedule?.round_a?.window_deadline_ms);
  const fallbackWindowMs = Number.isFinite(declaredWindowMs) && declaredWindowMs > 0
    ? declaredWindowMs
    : ROUND_A_WEDGE_HARD_MS;
  const hasDeadline = deadlineMs !== null && deadlineMs !== undefined && Number.isFinite(Number(deadlineMs));
  const deadline = hasDeadline ? Number(deadlineMs) : nowMs() + fallbackWindowMs;
  const sleepMs = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0 ? Number(pollMs) : NO_SAMPLE_POLL_MS;
  // STORM-REAL US-008: release the ACTUAL active roster the campaign launched
  // (full -> S1..S8, lite -> the four lite ids), read from persisted scale.
  const roster = [...activeReleaseTargetsFromState(state)];
  const expectedPeak = expectedActiveCountFromState(state);

  const finish = (outcome, observedPeak) => {
    const reason = outcome === 'window_observed' ? 'round_a_window_observed' : 'round_a_window_timeout';
    let released = [];
    try { released = releaseHoldsForRoster(ctx, state, ops, 'A', roster, reason); } catch { released = []; }
    state.holds = state.holds ?? {};
    const at = ctx.clock.nowUtc();
    state.holds.round_a = { outcome, observedPeak, at };
    try { ops?.record?.('hold.round_a_window', { outcome, observedPeak, released, at }); } catch { /* never throw */ }
    try { persistState(ctx, campaignDir, state); } catch { /* persistence is best-effort; the outcome is returned */ }
    return { outcome, observedPeak, released, at };
  };

  try {
    for (;;) {
      // US-006: a spend-cap abort must not leave the window poll waiting out
      // the whole round deadline — release holds and return immediately.
      if (state?.spend_cap_abort?.aborted === true) {
        const verdict = simultaneityVerdict(state);
        return finish('spend_cap_abort', Number(verdict?.observedPeak ?? 0));
      }
      if (roundAWindowObserved(state)) {
        // The window is REAL: the configured active roster was simultaneously
        // claimed with no unknown identity, so the configured target is the
        // honest peak for the release decision (the ops record also carries
        // the verdict peak for forensics).
        return finish('window_observed', expectedPeak);
      }
      if (nowMs() >= deadline) {
        const verdict = simultaneityVerdict(state);
        return finish('window_timeout', Number(verdict?.observedPeak ?? 0));
      }
      await ctx.clock.sleep(sleepMs, 'round-a window poll');
    }
  } catch (err) {
    const message = String(err?.message ?? err);
    let released = [];
    try { released = releaseHoldsForRoster(ctx, state, ops, 'A', roster, 'round_a_window_error'); } catch { released = []; }
    state.holds = state.holds ?? {};
    state.holds.round_a = { outcome: 'window_error', observedPeak: null, error: message, at: ctx.clock.nowUtc() };
    try { ops?.record?.('hold.round_a_window', { outcome: 'window_error', error: message, released }); } catch { /* never throw */ }
    return { outcome: 'window_error', observedPeak: null, released, error: message };
  }
}

// initCampaign — validate the (fresh, contained) campaign destination and
// create it. When ctx.campaignDir is absent, allocate
// varRoot/results/<storm-<ts>-<uuid>> automatically.
export function initCampaign(ctx) {
  let abs;
  let campaignId;
  if (ctx.campaignDir) {
    abs = assertCampaignDestContained(ctx.campaignDir, { varRoot: ctx.varRoot, fs: ctx.fs });
    if (ctx.fs.existsSync(abs)) {
      throw refusal(`campaign destination already exists: ${abs}`, 'TT_EXISTS');
    }
    campaignId = path.basename(abs);
  } else {
    campaignId = allocStormCampaignId(ctx.clock);
    abs = path.join(ctx.varRoot, 'results', campaignId);
  }
  ctx.fs.mkdirSync(abs, { recursive: true });
  ctx.fs.mkdirSync(path.join(abs, STORM_RESULTS_DIR), { recursive: true });
  return { campaignId, campaignDir: abs.replace(/\/+$/, '') };
}

// ─────────────────────────────────────────────────────────────────────
// US-010 (SF-9) — the DESIGNATED PENDING CANDIDATE.
//
// SF-9: the consistency gate asserts a genuinely prepared, never-executed
// storm-* campaign remains on disk. If the ONLY prepared campaign is the one
// the coordinator executes, the gate loses its independent pending witness.
// The fix keeps a SECOND, fully-prepared campaign (the designated pending
// candidate) alongside the executed one. The readiness file may LOCATE the
// candidate, but the on-disk prepared campaign remains the source of truth.
//
// assertPendingCandidateDest owns the destination verdict: contained under
// the owned var root, NEVER an existing directory (no overwrite), and never
// inside the primary campaign dir (a candidate inside the campaign it backs
// would be destroyed by campaign cleanup). The CLI (bin/tt-storm) owns the
// second stormPrepare invocation because it alone builds the fresh private
// exec context + product-schema DB the candidate requires; these engine
// helpers keep the verdict + the primary-state recording testable in
// isolation.
// ─────────────────────────────────────────────────────────────────────
export function assertPendingCandidateDest(primaryCampaignDir, rawCandidateDir, { varRoot, fs: fsx } = {}) {
  if (!rawCandidateDir) throw refusal('--pending-candidate requires a destination directory', 'TT_USAGE');
  // Containment first (under the owned var root; no traversal/symlink escape).
  const abs = assertCampaignDestContained(rawCandidateDir, { varRoot, fs: fsx });
  if (fsx.existsSync(abs)) {
    throw refusal(`pending candidate destination already exists (never overwrite): ${abs}`, 'TT_EXISTS');
  }
  if (primaryCampaignDir) {
    const rel = path.relative(path.resolve(String(primaryCampaignDir)), abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw refusal(`pending candidate destination is inside the primary campaign dir (never overwrite): ${abs}`, 'TT_EXISTS');
    }
  }
  return abs;
}

// Record the designated pending candidate {campaign_id, dir} in the PRIMARY
// campaign state.json + descriptor.json (and ops.jsonl). Called by the CLI
// only AFTER the candidate campaign has been truthfully prepared.
export function recordPendingCandidate({ ctx, campaignDir, state, descriptorName = null, candidate }) {
  const campaignId = candidate?.campaign_id ?? candidate?.campaignId ?? null;
  const dir = candidate?.dir ?? null;
  if (!campaignId || !dir) throw refusal('recordPendingCandidate requires {campaign_id, dir}', 'TT_USAGE');
  const record = { campaign_id: campaignId, dir, recorded_at: ctx.clock.nowUtc() };
  state.pending_candidate = record;
  persistState(ctx, campaignDir, state);
  if (descriptorName) {
    const descPath = path.join(campaignDir, descriptorName);
    let descriptor;
    try {
      descriptor = JSON.parse(ctx.fs.readFileSync(descPath, 'utf8'));
    } catch (err) {
      throw refusal(`cannot read descriptor to record pending_candidate (${descPath}): ${err?.message ?? String(err)}`, 'TT_STATE');
    }
    descriptor.pending_candidate = record;
    ctx.fs.writeFileSync(descPath, JSON.stringify(descriptor, null, 2) + '\n');
  }
  const ops = opRecorder({ fs: ctx.fs, campaignDir });
  ops.record('rehearsal.pending_candidate', record);
  return record;
}

// prepare — records intent + derived numbers + full launch plan; NO launches.
//
// US-001 (STORM-REHEARSAL): when ctx.opts.rehearsalPrepare is true the
// prepare phase ALSO provisions every fresh-owned input the real zero-model
// SCRIPTED_REHEARSAL consumes (seeded private catalog from the ACTUAL bundled
// catalog, owned tiny git origin + sibling clones, per-run task files for the
// full roster, per-campaign owned roots with dev/ino receipts, frozen
// binary/runtime pins and the source-pinned descriptor.json). This remains a
// NO-LAUNCH phase: no daemon/harness/chaos process is ever started (the only
// effects are contained var writes, the catalog copy and local git fixture
// creation). The recording gate drives prepare WITHOUT rehearsalPrepare and
// is byte-for-byte unaffected.
export async function stormPrepare(ctx) {
  // STORM-REAL US-001: validate the campaign profile BEFORE any effect (no
  // campaign dir, no state write), so an unknown/empty profile refuses with
  // TT_USAGE and leaves nothing behind. Absent a value the SCRIPTED_REHEARSAL
  // default applies (the unchanged legacy path).
  const profile = parseProfile(ctx.opts?.profile);
  // STORM-REAL US-008: validate the campaign SCALE before any effect, exactly
  // like the profile. An unknown/empty --scale refuses TT_USAGE with zero
  // effects; absent a value the FULL default applies (the unchanged path).
  const scale = parseScale(ctx.opts?.scale);
  const roster = rosterForScale(scale);
  const litePhases = roundBPhasesForScale(scale);
  // STORM-REAL US-006: a REAL campaign MUST carry a hard spend cap. Resolve it
  // FIRST, BEFORE any effect (no harness resolution, no campaign dir, no state
  // write), so a REAL prepare without --spend-cap-tokens refuses TT_USAGE with
  // zero effects. The resolved { tokens, scope } is persisted into
  // state.rehearsal.spend_cap and descriptor.spend_cap and is the ONE
  // authority the observation tick enforces. SCRIPTED_REHEARSAL without a cap
  // stays null (unaffected).
  const spendCap = resolveSpendCapForProfile(profile, ctx.opts?.spendCapTokens, ctx.opts?.spendCapScope);
  // STORM-REAL US-002: a REAL campaign pins the OPERATOR'S real harness
  // binaries. Resolve them BEFORE initCampaign (no campaign dir, no state
  // write) so a missing/unresolvable roster harness refuses
  // TT_UNRESOLVED_BINARY with zero effects — a REAL storm can never be armed
  // against a half-missing toolchain. A relaxed (non-rehearsal) recording-gate
  // prepare has no descriptor to pin, so it does not resolve.
  // SCRIPTED_REHEARSAL is untouched (frozen scripted runtimes, pinned by the
  // rehearsal builder).
  let realHarnessPins = null;
  if (isRealProfile(profile) && ctx.opts?.rehearsalPrepare === true) {
    // STORM-REAL US-008: resolve exactly the harnesses the ACTIVE roster uses
    // (a lite campaign uses pi/hermes only, so it never demands dsh).
    const activeRosterHarnesses = rosterHarnessNames(roster);
    realHarnessPins = ctx.opts?.resolveHarnessPins
      ? await ctx.opts.resolveHarnessPins(activeRosterHarnesses)
      : await resolveRosterHarnessPins(activeRosterHarnesses, {
          env: ctx.opts?.harnessEnv ?? process.env,
          fs: ctx.opts?.harnessFs,
          pathEnv: ctx.opts?.harnessPath,
          runner: ctx.opts?.harnessVersionRunner,
        });
  }
  const { campaignId, campaignDir } = initCampaign(ctx);
  const ops = opRecorder({ fs: ctx.fs, campaignDir });
  ops.record('prepare.start', { campaignId, argv: ctx.argv ?? null });

  // US-001 rehearsal input/profile/behavior provisioning (opt-in). Seeding
  // happens BEFORE number derivation so the roster/harness/timer numbers are
  // derived from the CURRENT seeded registrations, never a stale fallback.
  let rehearsalInputs = null;
  let descriptorName = null;
  // US-004 (fix-4): the SCRIPTED_REHEARSAL hold/phase schedule is derived from
  // the real ROUND_B_PHASES table BEFORE provisioning so its bounded hold
  // timeout is the one baked into the generated scripted behaviors AND
  // recorded in state (state.rehearsal.hold_schedule) and descriptor.json. A
  // REAL campaign MUST NOT persist a derived schedule (the engine then uses
  // its authoritative ROUND_B_PHASES table), so it is derived only for the
  // scripted rehearsal.
  let derivedHoldSchedule = null;
  if (ctx.opts?.rehearsalPrepare === true) {
    const { provisionRehearsalInputs, DESCRIPTOR_NAME, deriveScriptedHoldSchedule } = await import('./tt-storm-rehearsal.mjs');
    descriptorName = DESCRIPTOR_NAME;
    // STORM-REAL US-008: the derived SCRIPTED_REHEARSAL schedule is projected
    // from the campaign's ACTUAL Round B phase table (the reduced lite plan for
    // a lite campaign, the authoritative full table otherwise). A REAL
    // campaign persists no derived schedule (it uses the persisted
    // state.plan.roundBPhases directly).
    derivedHoldSchedule = isRealProfile(profile)
      ? null
      : deriveScriptedHoldSchedule(
          isLiteScale(scale)
            ? { phases: litePhases, roundAReleaseTargets: activeReleaseTargetsForScale(scale) }
            : {},
        );
    rehearsalInputs = await provisionRehearsalInputs({ ctx, campaignId, campaignDir, ops, holdSchedule: derivedHoldSchedule, profile, realHarnessPins, spendCap, scale, roster });
    if (rehearsalInputs?.taskFiles) {
      ctx.opts.taskFiles = { ...(ctx.opts.taskFiles ?? {}), ...rehearsalInputs.taskFiles };
    }
    if (rehearsalInputs?.fixtureIdentity) {
      ctx.opts.fixtureIdentity = rehearsalInputs.fixtureIdentity;
      ctx.opts.originRepo = rehearsalInputs.fixtureIdentity.originRepo;
      ctx.opts.colleagueRepo = rehearsalInputs.fixtureIdentity.colleagueRepo;
      ctx.opts.parkRepo = rehearsalInputs.fixtureIdentity.parkRepo;
      ctx.opts.taskFileRoot = rehearsalInputs.inputRoots.tasksRoot;
    }
  }

  const numbers = await deriveStormNumbers({
    fs: ctx.fs,
    installedCatalogRoot: ctx.opts.installedCatalogRoot ?? null,
    bundledCatalogRoot: ctx.opts.bundledCatalogRoot ?? ctx.opts.bundledWorkflowsRoot ?? null,
    // STORM-REAL US-008: derive the cap from the ACTUAL roster the campaign
    // will launch (lite -> the four lite entries), never the full roster.
    activeRoster: roster.A,
  });

  // STORM-REAL US-008: record the scale + recomputed cap on the descriptor.
  // The cap is derived from the ACTUAL active roster above (lite -> the four
  // lite entries), so a lite descriptor can never carry full-roster demand.
  if (rehearsalInputs?.descriptor) {
    rehearsalInputs.descriptor.scale = scale;
    rehearsalInputs.descriptor.roster = {
      ...(rehearsalInputs.descriptor.roster ?? {}),
      scale,
      roster_id: scale,
      workflow_ids: rosterWorkflowIds(roster),
      round_a_ids: roster.A.map((r) => r.id),
      round_b_ids: roster.B.map((r) => r.id),
      // The recomputed active timer cap (sum of the lite roster's derived
      // agent counts). This is the AC2 recorded figure.
      active_cap: numbers.cap.total,
      cap_detail: numbers.cap.perRun,
      queued_demand: numbers.queued,
    };
    rehearsalInputs.descriptor.active_cap = numbers.cap.total;
  }

  const source = {
    commit: ctx.opts.sourceCommit ?? null,
    tree: ctx.opts.sourceTree ?? null,
    tree_dirty: ctx.opts.sourceTreeDirty ?? null,
    catalog: numbers.resolved,
    per_workflow: Object.fromEntries(
      Object.entries(numbers.counts).map(([wf, c]) => [
        wf,
        { stepAgents: c.distinctStepAgents, declared: c.declaredAgentsCount, sourcePath: c.source?.path ?? null, sourceSha: c.source?.sha256 ?? null },
      ]),
    ),
    active_cap: numbers.cap.total,
    cap_detail: numbers.cap.perRun,
    queued_demand: numbers.queued,
  };

  const state = newCampaignState({ campaignId, clock: ctx.clock, source, fixture: ctx.opts.fixture ?? (isLiteScale(scale) ? { name: LITE_FIXTURE_NAME, basis: 'operator-recorded tt-poly-lite pilot identity at prepare time' } : {}) });
  state.mode = 'prepared';
  state.qualification = {
    real_launch_allowed: false,
    note: 'not-yet-qualified: real scripted rehearsal + coordinator acceptance are the next gate; no real launch may occur until then',
  };
  // Persisted trusted allocation receipt (STORM-REAL / root defect #3): the
  // private exec context's dev/ino ownership evidence captured at prepare is
  // written into state so run/resume/report/approve/rehearse revalidate
  // against the RECEIPT, never against a fresh same-invocation capture. A
  // campaign without a receipt is refused by those modes (re-prepare).
  if (ctx.opts.execIdentity) {
    state.exec_identity = ctx.opts.execIdentity;
  }
  state.plan = buildLaunchPlan(numbers, { roster, roundBPhases: litePhases });
  // US-004 (fix-4): the REAL storm keeps its authoritative ROUND_B_PHASES table
  // and must NOT record a derived schedule. Only the SCRIPTED_REHEARSAL branch
  // below sets state.plan.roundBPhases (from the derived hold schedule);
  // non-rehearsal dispatch falls back to ROUND_B_PHASES. intent.jsonl still
  // records the real phase intents (see the `state.plan.roundBPhases ??
  // ROUND_B_PHASES` loop below).
  //
  // STORM-REAL US-008: a LITE campaign is the exception — its plan carries the
  // reduced lite phase table (one colleague commit, one worker kill) so the
  // engine dispatches the scaled chaos for both profiles. `delete` targets only
  // the full table's default, never the lite one.
  if (litePhases) state.plan.roundBPhases = litePhases;
  else delete state.plan.roundBPhases;
  state.plan.manifest_row = ctx.opts.manifestRow ?? null;
  // Orchestrator-owned fixture identity recorded at prepare time (STORM-W5
  // requirement 1): the exact repos/files the Round B operator acts on and
  // the seed/storm ref every task instantiates from. Run/resume read it from
  // state so the identity survives controller restarts; missing identity for
  // a repo/file-dependent action is a first-class NOT_RUN at dispatch.
  state.plan.fixtureIdentity = fixtureIdentity(ctx);
  state.plan.provenance = {
    seedRef: state.plan.fixtureIdentity.seedRef,
    taskFileRoot: ctx.opts.taskFileRoot ?? null,
    originRepo: state.plan.fixtureIdentity.originRepo,
    colleagueRepo: state.plan.fixtureIdentity.colleagueRepo,
  };

  // US-001: persist the rehearsal input/profile/behavior bundle (owned-root +
  // fixture receipts with realpath/dev/ino captured at allocation, per-run
  // task manifest, frozen runtime pins, resource plan, descriptor reference)
  // so later real modes revalidate against the receipts and the report can
  // reconcile actual-vs-recorded coverage.
  if (rehearsalInputs) {
    state.rehearsal = {
      profile: rehearsalInputs.descriptor.profile,
      label: rehearsalInputs.descriptor.label,
      // STORM-REAL US-006: the persisted hard spend cap ({ tokens, scope }) or
      // null for SCRIPTED_REHEARSAL. This is the ONE authority every
      // observation tick enforces; it is never re-derived from a CLI flag.
      spend_cap: rehearsalInputs.spendCap ?? null,
      inputs: {
        root: rehearsalInputs.inputRoots.root,
        tasksRoot: rehearsalInputs.inputRoots.tasksRoot,
        reposRoot: rehearsalInputs.inputRoots.reposRoot,
        worktreeRoot: rehearsalInputs.inputRoots.worktreeRoot,
        rootReceipts: rehearsalInputs.inputRoots.receipts,
        fixture: {
          originRepo: rehearsalInputs.fixture.originRepo,
          colleagueRepo: rehearsalInputs.fixture.colleagueRepo,
          parkRepo: rehearsalInputs.fixture.parkRepo,
          mainHead: rehearsalInputs.fixture.mainHead,
          brokenTestsHead: rehearsalInputs.fixture.brokenTestsHead,
          receipts: rehearsalInputs.fixture.receipts,
        },
      },
      task_manifest: rehearsalInputs.taskManifest,
      runtime_pins: rehearsalInputs.runtimePins,
      resource_plan: rehearsalInputs.resourcePlan,
      fixture_identity: rehearsalInputs.fixtureIdentity,
      descriptor_file: descriptorName,
      provisioned_at: rehearsalInputs.descriptor.provisioned_at,
    };
    // US-001 (fix-2, S5): the per-campaign scripted-runtime contract (behaviors
    // file + private state dir) the frozen zero-model runtimes consume. Without
    // it every work round crashes before claiming a step. SCRIPTED_REHEARSAL
    // ONLY — a REAL campaign runs real harnesses and must not claim a frozen
    // scripted runtime.
    if (rehearsalInputs.scriptedRuntime) state.rehearsal.scripted_runtime = rehearsalInputs.scriptedRuntime;
    // US-004 (fix-4): the derived SCRIPTED_REHEARSAL hold/phase schedule drives
    // the Round B offsets (far below the real 5400s+ clock) and the
    // live-target hold predicate + release-after-last-dependent-phase contract.
    // A REAL campaign carries neither field, so the engine falls back to the
    // authoritative ROUND_B_PHASES table (see `state.plan.roundBPhases ??
    // ROUND_B_PHASES` in the dispatch/observation paths).
    if (rehearsalInputs.holdSchedule) {
      state.rehearsal.hold_schedule = rehearsalInputs.holdSchedule;
      state.plan.roundBPhases = state.rehearsal.hold_schedule.round_b.phases;
    }
    // STORM-REAL US-008: the capacity-scaled lite roster is a persisted
    // identity so the report headline and the run-time window/release logic
    // name the roster that ACTUALLY ran. Only recorded for a lite campaign so
    // the full default state stays byte-identical.
    if (isLiteScale(scale)) {
      state.rehearsal.roster_id = scale;
      state.rehearsal.scale = scale;
    }
    // AC2: the COMPLETE tested gate-file sha256 set (the exact set
    // computeGateHashes computes for approve/rehearse) is persisted into
    // state so a coordinator can reconcile the approval against the prepared
    // campaign without recomputing anything.
    state.gate_hashes = rehearsalInputs.descriptor.gate_hashes;
  }

  ctx.fs.writeFileSync(path.join(campaignDir, STORM_STATE_NAME), JSON.stringify(state, null, 2) + '\n');

  // intent.jsonl — durable record of every planned side effect BEFORE any
  // execution round starts (append-only; resume/report read it).
  const intents = [];
  for (const launch of state.plan.launches) {
    intents.push({
      ts: ctx.clock.nowUtc(),
      kind: 'launch_intent',
      round: launch.round,
      rosterId: launch.rosterId,
      run: launch.run,
      workflow: launch.workflow,
      harness: launch.harness,
      timers: launch.timers,
      earliestOffsetMs: launch.earliestOffsetMs,
      queued: launch.queued ?? false,
      argv: launch.argv,
      targetBranch: launch.targetBranch ?? 'main',
      taskArea: launch.taskArea ?? null,
      context: launch.context ?? [],
      taskFile: ctx.opts.taskFiles?.[launch.rosterId] ?? (ctx.opts.taskFileRoot ? `${ctx.opts.taskFileRoot}/${launch.run}.task.md` : `${launch.run}.task.md`),
      seedRef: state.plan.fixtureIdentity.seedRef,
    });
  }
  for (const ph of state.plan.roundBPhases ?? ROUND_B_PHASES) {
    intents.push({
      ts: ctx.clock.nowUtc(),
      kind: 'phase_intent',
      id: ph.id,
      label: ph.label,
      // Derived phases use earliest_offset_ms; the real table uses
      // earliestOffsetMs. Record whichever the phase carries.
      earliestOffsetMs: ph.earliestOffsetMs ?? ph.earliest_offset_ms,
      action: ph.action,
      waitFor: ph.waitFor,
    });
  }
  ctx.fs.writeFileSync(path.join(campaignDir, STORM_INTENT_NAME), intents.map((l) => JSON.stringify(l)).join('\n') + (intents.length ? '\n' : ''));

  ops.record('prepare.done', { campaignId, active_cap: numbers.cap.total, launched_intents: intents.length });
  saveState({ fs: ctx.fs, campaignDir, state });
  if (rehearsalInputs && descriptorName) {
    const descPath = path.join(campaignDir, descriptorName);
    ctx.fs.writeFileSync(descPath, JSON.stringify(rehearsalInputs.descriptor, null, 2) + '\n');
    ops.record('rehearsal.descriptor', { campaignId, path: descPath, gate_hashes: Object.keys(rehearsalInputs.descriptor.gate_hashes ?? {}).length });
  }
  return { campaignId, campaignDir, state, numbers, rehearsal: rehearsalInputs ?? null };
}

// Build the launch plan (argv recipes + earliest offsets + phase table).
// Round A: S1..S8 every 90s. S8 is the 8th non-queued run, so its slot is
// (8-1)*90s = 630s; S9 launches 30s after S8's registration (660s) and S10
// 30s after S9 (690s) — spec 09's "immediately after S8's registration, 30s
// stagger", BEFORE early completions can free timer capacity (a 750s S9
// would leave a 120s gap that weakens the pre-completion queue probe).
// Round B: B1..B5 staggered 60s, chaos phases at their earliest offsets
// from round start.
export function buildLaunchPlan(numbers, { roster = null, roundBPhases = null } = {}) {
  const timersByWorkflow = {};
  for (const [wf, c] of Object.entries(numbers.counts ?? {})) {
    timersByWorkflow[wf] = c.distinctStepAgents;
  }
  // US-005 (SF-2 containment): the workflow's REAL run.workspace mode is
  // carried on each launch so launchArgvFor can require the owned worktree
  // origin + ref for exactly the worktree family (product default "direct").
  const workspaceModeOf = (wf) => numbers.counts?.[wf]?.workspaceMode ?? 'direct';
  // STORM-REAL US-008: the roster and Round B phase table come from the
  // campaign's persisted scale. The defaults are the authoritative full
  // rosters/table, so an unscaled prepare is byte-for-byte unchanged; a lite
  // campaign passes its four-run roster and the reduced chaos plan.
  const rosterA = roster?.A ?? ROUND_A_ROSTER;
  const rosterB = roster?.B ?? ROUND_B_ROSTER;
  const phases = roundBPhases ?? ROUND_B_PHASES;
  const launches = [];
  const queuedDemand = numbers.queued ?? {};
  const activeACount = rosterA.filter((x) => !x.queued).length;
  const s8SlotMs = (activeACount - 1) * ROUND_A_STAGGER_MS; // full: 7*90s = 630s
  let queuedRank = 0;
  rosterA.forEach((r, i) => {
    const timers = timersByWorkflow[r.workflow];
    const isQueued = r.queued ?? false;
    let earliestOffsetMs;
    if (isQueued) {
      queuedRank += 1; // S9 rank 1, S10 rank 2
      earliestOffsetMs = s8SlotMs + queuedRank * ROUND_A_QUEUED_STAGGER_MS;
    } else {
      earliestOffsetMs = i * ROUND_A_STAGGER_MS;
    }
    const targetBranch = (r.context ?? []).includes('branch=broken-tests') ? 'broken-tests' : 'main';
    launches.push({
      round: 'A', rosterId: r.id, run: r.run, workflow: r.workflow, harness: r.harness,
      timers, queued: isQueued, demand: isQueued ? queuedDemand[r.id] : timers,
      earliestOffsetMs, argv: null, targetBranch,
      workspaceMode: workspaceModeOf(r.workflow),
      taskArea: r.taskArea ?? null, context: r.context ?? [],
    });
  });
  rosterB.forEach((r, i) => {
    const timers = timersByWorkflow[r.workflow];
    const targetBranch = (r.context ?? []).includes('branch=broken-tests') ? 'broken-tests' : 'main';
    launches.push({
      round: 'B', rosterId: r.id, run: r.run, workflow: r.workflow, harness: r.harness,
      timers, queued: false, demand: timers,
      earliestOffsetMs: 60_000 * i, argv: null,
      targetBranch, redBait: r.red_bait ?? false,
      workspaceMode: workspaceModeOf(r.workflow),
      taskArea: r.taskArea ?? null, context: r.context ?? [],
    });
  });
  return { launches, roundBPhases: phases };
}

// Round B chaos schedule (spec 09 table / W5 briefing) as the dispatch
// contract. `waitFor` is the phase_wait evidence required immediately before
// the action fires; timings are EARLIEST offsets (phase evidence gates the
// actual fire). Fixture identities (colleague repo, the file a colleague
// commit touches, the dirty-tree repo) are NOT hardcoded here — the
// orchestrator OWNS them (spec 12 §tt-chaos + STORM-W5 requirement 1) and
// the engine resolves them from ctx.opts.fixtureIdentity at dispatch time.
// A phase whose action needs a repo/file the campaign does not own is
// recorded NOT_RUN with the missing identity named — never dispatched with
// an empty `--repo`/`--file`.
// US-010 (SF-5): `waitFor.target`/`waitFor.targets` name the run(s) the phase
// PREDICATE structurally depends on. When every one of them is terminal the
// predicate can never materialize again, so waitForPhaseEvidence short-circuits
// the 180s phase wait to `run_terminal` after a single probe (attempt 3: nine
// Round B phases burned the full bound in the terminal state). Phases whose
// predicate is tied to a specific run declare it; the rest fall back to the
// action's own target in phaseWaitTargetRosterIds below.
export const ROUND_B_PHASES = [
  { id: 'B-pounding',  label: 'read-path pounding starts (continues through Round B)', earliestOffsetMs: 0, waitFor: { kind: 'none', marker: null }, action: { kind: 'read_path_pounding' } },
  { id: 'B-cc1',       label: 'colleague commit #1 (unrelated file)', earliestOffsetMs: 15 * 60_000, waitFor: { kind: 'phase', marker: 'round-b-launches-registered' }, action: { kind: 'colleague_commit', target: 'B1', fileRole: 'cc1' } },
  { id: 'B-nudge',     label: 'nudge storm: 20 nudge invocations in <10s', earliestOffsetMs: 25 * 60_000, waitFor: { kind: 'phase', marker: 'cc1-landed', targets: ['B1'] }, action: { kind: 'nudge_storm', count: 20, windowMs: 10_000 } },
  { id: 'B-pause',     label: 'pause (no drain) B3', earliestOffsetMs: 30 * 60_000, waitFor: { kind: 'step', marker: 'B3 mid-flight step claimed' }, action: { kind: 'pause', target: 'B3' } },
  { id: 'B-resume',    label: 'resume B3', earliestOffsetMs: 45 * 60_000, waitFor: { kind: 'phase', marker: 'pause-b3-acked' }, action: { kind: 'resume', target: 'B3' } },
  { id: 'B-kill',      label: 'kill -9 active harness process of B4', earliestOffsetMs: 50 * 60_000, waitFor: { kind: 'step', marker: 'B4 harness claim recorded' }, action: { kind: 'kill_harness', target: 'B4', signal: 'SIGKILL' } },
  { id: 'B-park',      label: 'leave-dirty PARK bait before a landing window', earliestOffsetMs: 60 * 60_000, waitFor: { kind: 'step', marker: 'finalize claim for a Round B merge run' }, action: { kind: 'dirty_tree_park' } },
  { id: 'B-cc2',       label: 'colleague commit #2 (same line B3 fixes)', earliestOffsetMs: 75 * 60_000, waitFor: { kind: 'phase', marker: 'b3-fix-area-known' }, action: { kind: 'colleague_commit', target: 'B3', fileRole: 'cc2' } },
  { id: 'B-stopdel',   label: 'stop + delete B5 under load, relaunch identical do-now', earliestOffsetMs: 90 * 60_000, waitFor: { kind: 'phase', marker: 'other-four-mid-flight', targets: ['B1', 'B2', 'B3', 'B4'] }, action: { kind: 'stop_delete_relaunch', target: 'B5' } },
  { id: 'B-rugpull',   label: 'mass rugpull: colleague commit while every merge run pre-finalize', earliestOffsetMs: 105 * 60_000, waitFor: { kind: 'step', marker: 'B1-B4 pre-finalize' }, action: { kind: 'mass_rugpull', targets: ['B1', 'B2', 'B3', 'B4'] } },
  { id: 'B-bounce',    label: 'daemon bounce via daemon-control wrapper (contained)', earliestOffsetMs: 150 * 60_000, waitFor: { kind: 'phase', marker: 'rugpull-recovered', targets: ['B1', 'B2', 'B3', 'B4'] }, action: { kind: 'daemon_bounce' } },
];

// ─────────────────────────────────────────────────────────────────────
// Fixture identity ownership (STORM-W5 requirement 1 / spec 12 §tt-chaos).
// The orchestrator owns the exact repos/files the Round B chaos operator
// acts on: the colleague clone a `tt-chaos colleague-commit` commits into,
// the files it touches, and the repo whose working tree `tt-chaos dirty-tree`
// dirties for the PARK bait. SF-15 (US-006): the park target is the owned
// NON-BARE origin checkout (the merge target every live B1..B4 run merges
// into), not the unrelated `repos/park` sibling. The recording gate injects
// synthetic identities; the real rehearsal gate passes the fixture paths.
// Missing identity -> the phase is NOT_RUN, never `--repo ''`.
// ─────────────────────────────────────────────────────────────────────
export function fixtureIdentity(ctx, state = null) {
  const fromOpts = ctx.opts?.fixtureIdentity ?? ctx.opts?.fixture_identity ?? null;
  const fromState = state?.plan?.fixtureIdentity ?? state?.source?.fixtureIdentity ?? null;
  return {
    colleagueRepo: fromOpts?.colleagueRepo ?? fromState?.colleagueRepo ?? ctx.opts?.colleagueRepo ?? null,
    cc1File: fromOpts?.cc1File ?? fromState?.cc1File ?? ctx.opts?.cc1File ?? null,
    cc2File: fromOpts?.cc2File ?? fromState?.cc2File ?? ctx.opts?.cc2File ?? null,
    parkRepo: fromOpts?.parkRepo ?? fromState?.parkRepo ?? ctx.opts?.parkRepo ?? ctx.opts?.originRepo ?? null,
    originRepo: fromOpts?.originRepo ?? fromState?.originRepo ?? ctx.opts?.originRepo ?? null,
    seedRef: fromOpts?.seedRef ?? fromState?.seedRef ?? ctx.opts?.seedRef ?? 'seed/storm',
  };
}

// The real `tt-chaos colleague-commit` operator REQUIRES `--repo` and
// `--file` (bin/tt-chaos colleagueCommit exits 1 without them); the real
// `tt-chaos dirty-tree` REQUIRES `--repo`. `buildChaosArgv` produces the
// exact argv the real operator accepts and returns null with a named reason
// when the orchestrator does not own the identity — callers then record the
// phase NOT_RUN instead of dispatching an argv the operator would reject.
export function buildChaosArgv(ctx, state, action, runId) {
  const ident = fixtureIdentity(ctx, state);
  switch (action.kind) {
    case 'colleague_commit': {
      const repo = ident.colleagueRepo;
      const file = action.fileRole === 'cc2' ? ident.cc2File : ident.cc1File;
      if (!repo || !file) {
        return { ok: false, reason: `colleague-commit requires orchestrator-owned --repo/--file; missing ${!repo ? 'colleagueRepo' : ''}${!repo && !file ? ' and ' : ''}${!file ? `${action.fileRole === 'cc2' ? 'cc2File' : 'cc1File'}` : ''} (fixtureIdentity)` };
      }
      return { ok: true, argv: ['tt-chaos', 'colleague-commit', '--repo', repo, '--file', file, ...(action.sameLineTarget ? ['--line', 'same'] : []), '--run', runId, '--when', 'now'] };
    }
    case 'dirty_tree_park': {
      // SF-15 (US-006): the PARK bait must dirty the working tree of the repo
      // that is a LIVE run's ACTUAL merge target — the owned non-bare origin
      // checkout with the target branch (main) checked out — not the unrelated
      // sibling `repos/park` clone. Prefer the owned origin; keep parkRepo only
      // as a legacy fallback for a campaign with no owned origin identity.
      const repo = ident.originRepo ?? ident.parkRepo;
      if (!repo) {
        return { ok: false, reason: 'dirty-tree requires orchestrator-owned --repo (originRepo/parkRepo in fixtureIdentity)' };
      }
      return { ok: true, argv: ['tt-chaos', 'dirty-tree', '--repo', repo, '--run', runId, '--when', 'now'] };
    }
    case 'mass_rugpull': {
      // US-003 (SF-14): the tip-move every merge run (B1..B4) observes as its
      // own rugpull must land on the owned origin's main, NOT merely advance
      // the colleague clone. A local-commit-only argv never moves the merge
      // target, so the product can never emit merge.target_moved. Both the
      // colleague repo/file AND the owned origin are REQUIRED; a missing origin
      // is fail-closed (NOT_RUN), never downgraded to a bare local commit.
      const repo = ident.colleagueRepo;
      const file = ident.cc1File;
      const originRepo = ident.originRepo;
      if (!repo || !file) {
        return { ok: false, reason: `mass_rugpull colleague-commit requires orchestrator-owned --repo/--file; missing ${!repo ? 'colleagueRepo' : ''}${!repo && !file ? ' and ' : ''}${!file ? 'cc1File' : ''} (fixtureIdentity)` };
      }
      if (!originRepo) {
        return { ok: false, reason: 'mass_rugpull colleague-commit requires the owned --push-origin originRepo (fixtureIdentity); refusing a local-commit-only rugpull that never moves the merge target' };
      }
      return { ok: true, argv: ['tt-chaos', 'colleague-commit', '--repo', repo, '--file', file, '--push-origin', originRepo, '--ref', 'main', '--run', runId, '--when', 'now'] };
    }
    case 'kill_harness': {
      return { ok: true, argv: ['tt-chaos', 'kill-harness', '--run', runId, '--when', 'now', '--signal', action.signal ?? 'SIGKILL'] };
    }
    default:
      return { ok: false, reason: `no tt-chaos argv builder for ${action.kind}` };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Round A run launch + admission (the engine's real sequencing core).
// ─────────────────────────────────────────────────────────────────────

// US-005 (SF-2 containment): the ONE resolution point for a launch's owned
// worktree origin. The prepared-campaign overlay (ctx.opts.originRepo) wins,
// then the overlay/CLI fixtureIdentity origin, then the fixtureIdentity
// persisted in the campaign state at prepare. A missing origin is returned as
// null so the caller can fail closed — never defaulted to cwd/HOME (the exact
// SF-2 mis-resolution to a foreign repository).
export function resolveOwnedWorktreeOrigin(ctx) {
  const fromState = ctx?.state?.plan?.fixtureIdentity ?? null;
  const fromOpts = ctx?.opts?.fixtureIdentity ?? null;
  return ctx?.opts?.originRepo ?? fromOpts?.originRepo ?? fromState?.originRepo ?? null;
}

// A launch's real workspace mode: the workflow-derived value carried on the
// launch (buildLaunchPlan), else an explicit ctx override map, else the product
// default "direct". Launch objects are an internal shape; older recorded plans
// without the field degrade to "direct" (no origin flags) rather than guess.
export function launchWorkspaceMode(launch, ctx) {
  return launch?.workspaceMode ?? ctx?.opts?.workspaceModes?.[launch?.workflow] ?? 'direct';
}

// US-006 (SF-2 containment): the campaign-owned roots a worktree launch origin
// must live under. The campaign var root always qualifies; the per-campaign
// rehearsal repos root (state.rehearsal.inputs.reposRoot, allocated UNDER the
// var root) is added for a prepared US-001 bundle so the rule names both roots
// the story asks for. Canonicalization is done by the containment helper.
export function ownedLaunchRoots(ctx) {
  const roots = [];
  if (ctx?.varRoot) roots.push(ctx.varRoot);
  const reposRoot = ctx?.state?.rehearsal?.inputs?.reposRoot ?? ctx?.opts?.reposRoot ?? null;
  if (reposRoot) roots.push(reposRoot);
  return roots;
}

// US-006: fail-closed containment gate invoked by stormRunRoundA/B immediately
// before launchArgvFor/launchWorkflow. A worktree launch whose RESOLVED origin
// is outside the campaign's owned roots refuses TT_ORIGIN_ESCAPE; the refusal
// is recorded first-class in ops.jsonl, the run record and its round are marked
// failed on disk, and the error PROPAGATES (never silently continued, never a
// stale 'running'). An origin-less worktree launch is left to launchArgvFor's
// TT_ORIGIN_MISSING: recording adapters that inject their own argv builder
// define their own origin, so this gate only judges a NON-NULL resolved origin.
export function assertLaunchOriginContainedForRound(ctx, state, ops, campaignDir, launch) {
  if (launchWorkspaceMode(launch, ctx) !== 'worktree') return;
  const originRepository = resolveOwnedWorktreeOrigin(ctx);
  if (!originRepository) return;
  const ownedRoots = ownedLaunchRoots(ctx);
  const label = `worktree launch ${launch.rosterId ?? launch.run ?? launch.workflow}`;
  try {
    assertLaunchOriginContained({ ownedRoots, originRepository, fs: ctx.fs, label });
  } catch (err) {
    const round = launch.round ?? null;
    ops.record('launch.origin_refused', {
      round,
      rosterId: launch.rosterId ?? null,
      workflow: launch.workflow ?? null,
      code: err.code ?? 'TT_ORIGIN_ESCAPE',
      originRepository,
      ownedRoots,
      message: err.message,
    });
    const rec = round ? state.rounds?.[round]?.runs?.[launch.rosterId] : null;
    if (rec) {
      rec.status = 'launch_failed';
      rec.launchFailure = { code: err.code ?? 'TT_ORIGIN_ESCAPE', message: err.message, stage: 'origin_containment' };
    }
    if (round && state.rounds?.[round]) state.rounds[round].status = 'failed';
    persistState(ctx, campaignDir, state);
    throw err;
  }
}

// Prepare argv for one launch (task file/harness/etc are supplied by the
// caller via opts.launchArgvFor(launch) when the real campaign runs; the
// default follows the manifest/controller convention and carries the
// orchestrator-owned launch context (S7 quarantine: `--context
// branch=broken-tests`) and task-area-derived task file identity).
//
// Every worktree-workspace launch carries the campaign-owned
// --worktree-origin-repository + an explicit --worktree-origin-ref (S7 =
// broken-tests, all others main). A worktree launch with no resolvable owned
// origin REFUSES with TT_ORIGIN_MISSING instead of emitting an origin-less
// argv (fail closed; SF-2).
//
// SF-12 (fix-6): the task file is resolved fail-closed — never a bare
// relative `${run}.task.md`. The old `?? `${launch.run}.task.md`` fallback
// silently produced a relative --task-file, which the product resolved
// against whatever cwd the (private HOME) launch ran in and ENOENTed. The
// B-stopdel relaunch (rosterId 'B5-relaunch', absent from taskFiles) hit
// exactly this and never produced relaunchOf lineage. Resolution precedence:
//   1. ctx.opts.taskFileFor(launch) when supplied;
//   2. launch.taskFile when it is a non-empty ABSOLUTE path;
//   3. ctx.opts.taskFiles[launch.taskFileRosterId ?? launch.rosterId];
//   4. path.posix.join(ctx.opts.taskFileRoot, `${launch.run}.task.md`) when
//      taskFileRoot is set and the launch names a run;
//   5. otherwise refuse TT_TASKFILE_MISSING (naming rosterId/run).
// Every accepted value must be absolute; a relative value from any source is
// refused rather than handed to the product (a HOME-relative --task-file is
// the SF-12 defect class).
export function resolveLaunchTaskFile(launch, ctx) {
  const label = launch.rosterId ?? launch.run ?? launch.workflow ?? 'unknown launch';
  const requireAbsolute = (value, source) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (!path.isAbsolute(value)) {
      throw refusal(
        `task file for launch ${label} resolved via ${source} is not absolute (${value}) — refusing a HOME-relative --task-file (SF-12 fail closed)`,
        'TT_TASKFILE_MISSING',
      );
    }
    return value;
  };

  if (typeof ctx.opts.taskFileFor === 'function') {
    const resolved = requireAbsolute(ctx.opts.taskFileFor(launch), 'taskFileFor');
    if (resolved) return resolved;
  }
  if (typeof launch.taskFile === 'string' && launch.taskFile.length > 0) {
    // A declared taskFile is authoritative ONLY when absolute; a relative one
    // is refused below (never silently resolved against the launch cwd).
    const declared = requireAbsolute(launch.taskFile, 'launch.taskFile');
    if (declared) return declared;
  }
  const taskFileRosterId = launch.taskFileRosterId ?? launch.rosterId;
  const fromMap = requireAbsolute(ctx.opts.taskFiles?.[taskFileRosterId], `taskFiles[${taskFileRosterId}]`);
  if (fromMap) return fromMap;
  if (ctx.opts.taskFileRoot && launch.run) {
    const joined = path.posix.join(String(ctx.opts.taskFileRoot), `${launch.run}.task.md`);
    const rooted = requireAbsolute(joined, 'taskFileRoot');
    if (rooted) return rooted;
  }
  throw refusal(
    `no task file for launch ${label} (rosterId=${launch.rosterId ?? 'none'}, run=${launch.run ?? 'none'}) — taskFileFor/taskFile/taskFiles/taskFileRoot all absent; refusing the relative ${launch.run ?? '<run>'}.task.md fallback (SF-12 fail closed)`,
    'TT_TASKFILE_MISSING',
  );
}

export function launchArgvFor(launch, ctx) {
  if (ctx.opts.launchArgvFor) return ctx.opts.launchArgvFor(launch, ctx);
  const extra = [];
  if (launch.round === 'B' || launch.queued === false) {
    // no extra flags by default; the real rehearsal supplies task files etc.
  }
  const context = ctx.opts.contextFor ? ctx.opts.contextFor(launch) : (launch.context ?? []);
  const taskFile = resolveLaunchTaskFile(launch, ctx);
  let originRepository = null;
  let originRef = null;
  if (launchWorkspaceMode(launch, ctx) === 'worktree') {
    originRepository = resolveOwnedWorktreeOrigin(ctx);
    originRef = launch.targetBranch ?? 'main';
    if (!originRepository) {
      throw refusal(
        `worktree launch ${launch.rosterId ?? launch.run ?? launch.workflow} has no campaign-owned worktree origin (fixtureIdentity.originRepo) — refusing an origin-less launch: WORKTREE_ORIGIN_REPOSITORY would default to a foreign repo (SF-2 containment)`,
        'TT_ORIGIN_MISSING',
      );
    }
    // US-006: a resolved origin must ALSO be contained by the owned roots —
    // this is what makes the SF-2 mis-resolution (origin == HOME/this repo)
    // structurally impossible on the default argv path.
    assertLaunchOriginContained({
      ownedRoots: ownedLaunchRoots(ctx),
      originRepository,
      fs: ctx.fs,
      label: `worktree launch ${launch.rosterId ?? launch.run ?? launch.workflow}`,
    });
  }
  return workflowRunArgv({
    workflow: launch.workflow,
    taskFile,
    harness: launch.harness,
    context,
    timeoutS: ctx.opts.launchTimeoutS ?? undefined,
    extra,
    originRepository,
    originRef,
  });
}

export async function stormRunRoundA(ctx, { resume = false } = {}) {
  const campaignDir = ctx.campaignDir;
  const ops = opRecorder({ fs: ctx.fs, campaignDir });
  const stateRes = loadState({ fs: ctx.fs, campaignDir });
  if (!stateRes.ok) throw refusal(`cannot run Round A: ${stateRes.error}`, 'TT_STATE');
  const state = stateRes.state;
  // US-005: expose the loaded campaign state to launchArgvFor so the owned
  // worktree origin can fall back to state.plan.fixtureIdentity.originRepo.
  ctx.state = state;
  if (state.rounds.A.status === 'round_done') return { campaignId: state.campaign_id, state };
  state.rounds.A.status = 'running';
  state.mode = 'run-A';

  // Round A read-path pounding: spec 09 makes pounding the round's SOLE
  // background load (no injected faults). Enable it when the campaign owns a
  // pounding config; when it does not, pounding is recorded first-class
  // NOT_RUN — never silently green, and never dispatched as a no-op.
  const poundEnable = enablePounding(ctx, state, 'A');
  if (poundEnable.ok) ops.record('pounding.enabled', { round: 'A', cadenceMs: state.rounds.A.pounding.cadenceMs, latencyBoundMs: state.rounds.A.pounding.latencyBoundMs });
  else ops.record('pounding.not_run', { round: 'A', reason: poundEnable.reason });

  const activeLaunches = state.plan.launches.filter((l) => l.round === 'A');
  const startedAt = ctx.clock.nowMs();

  // US-006 (SF-7): the SCRIPTED_REHEARSAL starts the standalone simultaneity
  // sampler at S1's launch (round start) so it observes the whole staggered
  // launch window. Non-scripted rounds keep the original single observation
  // loop below (sample defaults to true).
  const scriptedHoldSchedule = Boolean(state.rehearsal?.hold_schedule) || Boolean(ctx.opts?.rehearsalRun);
  let roundASampler = null;
  if (scriptedHoldSchedule) {
    roundASampler = startSampler(ctx, state, ops, campaignDir, {
      round: 'A',
      startedAt,
      windowMs: ctx.opts.roundWindowMs ?? ROUND_A_WEDGE_HARD_MS,
    });
  }

  // Launch S1..S8 on the 90s stagger; S9/S10 immediately after S8's
  // registration on the 30s cadence. Product registration ALWAYS creates a
  // run row (id) before admission, so S9/S10 launches are real launches:
  // the daemon either admits them (state active) or queues them (202
  // {state:'queued', freeSlots}) — the orchestrator records the admission
  // response snapshot and the decision at decision time. Every launch:
  // record intent -> spawn (both streams) -> extract/require unambiguous
  // run id -> observe admission (queued entries) -> update state.
  const ALREADY_LAUNCHED = new Set(['registered', 'admitted', 'queued', 'cap_abort', 'drain_bound_exceeded', 'terminal', 'launch_failed', 'unknown_run']);
  // The standalone sampler is stopped on ANY launch-loop error so a failed
  // launch can never leave a background sampler running past the round.
  try {
    for (const launch of activeLaunches) {
      const runRec = ensureRunRecord(state, 'A', launch);
      const dueAt = startedAt + launch.earliestOffsetMs;
      await waitWithPounding(ctx, state, 'A', dueAt, `launch ${launch.rosterId} stagger`, ops);
      // Resume/reattach protection: a run whose launch was already recorded is
      // NEVER relaunched — a waiter timeout is not permission for a duplicate.
      if (ALREADY_LAUNCHED.has(runRec.status)) continue;

      // US-006: the fail-closed origin-containment gate runs BEFORE any argv is
      // produced or any spawn can occur (origin == this repo/HOME refuses).
      assertLaunchOriginContainedForRound(ctx, state, ops, campaignDir, launch);
      const argv = launchArgvFor(launch, ctx);
      launch.argv = argv;
      ops.record('launch.intent', { round: 'A', rosterId: launch.rosterId, argv });
      runRec.status = 'launching';
      runRec.launchIntentAt = ctx.clock.nowUtc();
      persistState(ctx, campaignDir, state);

      const result = await ctx.proc.launchWorkflow(argv, {
        cwd: ctx.opts.launchCwd,
        env: { TAMANDUA_MAX_ACTIVE_TIMERS: String(state.source.active_cap), ...(ctx.opts.launchEnv ?? {}) },
        timeoutMs: ctx.opts.launchTimeoutMs ?? 0,
      });
      ops.record('launch.result', { round: 'A', rosterId: launch.rosterId, argv, exitCode: result.exitCode, stdoutTail: (result.stdout ?? '').slice(-400), stderrTail: (result.stderr ?? '').slice(-400) });

      const evidence = extractRunEvidence(result);
      let runId;
      try {
        runId = requireUnambiguousRunId(evidence, { rosterId: launch.rosterId });
      } catch (err) {
        // A launch that produced no (or ambiguous) identity is a hard
        // provenance failure — recorded (launch_failed, TT_MISSING_RUN /
        // TT_AMBIGUOUS_RUN) and propagated. A runless failed launch (exit
        // non-zero, no id on either stream) lands here too: the failure is
        // first-class evidence, never silently retried or guessed.
        // FAIL-CLOSED DECISION (documented): Round A aborts at the FIRST
        // runless/unknown launch — the round is marked failed and the
        // remaining planned launches stay 'planned' until an operator resumes
        // AFTER triage. That is a deliberate fail-closed choice (never guess a
        // run id, never silently continue past ambiguous provenance); the
        // resume path continues launching the remaining roster, keeping the
        // failed run first-class. See the recording gate G14.
        runRec.status = 'launch_failed';
        runRec.launchFailure = { code: err.code ?? 'TT_MISSING_RUN', message: err.message, exitCode: result.exitCode, evidence };
        state.rounds.A.status = 'failed';
        persistState(ctx, campaignDir, state);
        throw err;
      }
      runRec.status = 'registered';
      runRec.runId = runId;
      runRec.shortId = evidence.stderrShortId ?? runId.slice(4, 12);
      runRec.launchEvidence = evidence;
      runRec.launchedAt = ctx.clock.nowUtc();
      ops.record('run.registered', { round: 'A', rosterId: launch.rosterId, runId, shortId: runRec.shortId });

      if (launch.queued) {
        // Observe the daemon admission response (snapshot at decision time).
        await observeQueuedAdmission(ctx, state, ops, launch, runRec, campaignDir, result);
      } else {
        runRec.status = 'admitted';
        runRec.admittedAt = ctx.clock.nowUtc();
      }
      persistState(ctx, campaignDir, state);
    }
  } catch (err) {
    if (roundASampler && !roundASampler.stopped()) roundASampler.stop('round_a_launch_failed');
    throw err;
  }

  // US-007 (SF-7/SF-8): the scripted profile parks every run on its
  // mid-flight hold, so S1..S8 stay claimed while the sampler observes. Release
  // them ONLY once a real zero-unknown eight-concurrent window sample exists
  // (or, fail-closed, at the derived Round A window deadline with the honest
  // observed peak). The sampler is still running here so the window can still
  // appear; it is stopped immediately after.
  if (roundASampler) {
    const declaredWindowMs = Number(state.rehearsal?.hold_schedule?.round_a?.window_deadline_ms);
    const windowBound = Number.isFinite(declaredWindowMs) && declaredWindowMs > 0
      ? declaredWindowMs
      : ROUND_A_WEDGE_HARD_MS;
    await awaitRoundAWindowRelease(ctx, state, ops, campaignDir, { deadlineMs: startedAt + windowBound });
  }

  // US-006 (SF-7): the standalone sampler already observed the launch window.
  // Stop it now (promptly, even mid-interval) and harvest with sample:false so
  // no duplicate sample is appended.
  let samplerStartedAt = null;
  if (roundASampler) {
    roundASampler.stop('release_or_harvest');
    await roundASampler.promise;
    samplerStartedAt = startedAt;
  }

  // Queue drain + terminal harvest loop (pounding continues on its cadence
  // while the round is observed).
  await runObservationLoop(ctx, state, ops, campaignDir, {
    round: 'A',
    startedAt,
    sample: !scriptedHoldSchedule,
    samplerStartedAt,
  });

  // US-006: a spend-cap abort already ran owned cleanup and wrote the honest
  // aborted report; do NOT overwrite the aborted round status with
  // 'round_done' / re-finalize.
  if (state.spend_cap_abort?.aborted === true) {
    state.updated_at = ctx.clock.nowUtc();
    saveState({ fs: ctx.fs, campaignDir, state });
    return { campaignId: state.campaign_id, state, aborted: true };
  }

  finalizeRoundA(ctx, state, ops, campaignDir);
  state.rounds.A.status = 'round_done';
  state.updated_at = ctx.clock.nowUtc();
  saveState({ fs: ctx.fs, campaignDir, state });
  return { campaignId: state.campaign_id, state };
}

function ensureRunRecord(state, round, launch) {
  const bucket = state.rounds[round].runs;
  if (!bucket[launch.rosterId]) {
    bucket[launch.rosterId] = {
      rosterId: launch.rosterId,
      run: launch.run,
      workflow: launch.workflow,
      harness: launch.harness,
      timers: launch.timers,
      demand: launch.demand,
      queued: launch.queued ?? false,
      redBait: launch.redBait ?? false,
      targetBranch: launch.targetBranch ?? 'main',
      taskArea: launch.taskArea ?? null,
      context: launch.context ?? [],
      status: 'planned',
      admission: [],
      children: [],
    };
  }
  return bucket[launch.rosterId];
}

// resolveStormControlUrl — the private control-plane base URL for THIS
// campaign. bin/tt-storm wires it from the materialized state.daemon_ports
// (bind0-allocated once per campaign) into ctx.opts.controlUrl; the engine
// additionally falls back to state.daemon_ports so a campaign that only
// carries the persisted allocation still resolves. A campaign with no
// recorded/named control plane resolves null -> the snapshot is UNKNOWN,
// never a fabricated number.
export function resolveStormControlUrl(ctx, state = null) {
  const explicit = ctx?.opts?.controlUrl;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const ports = state?.daemon_ports ?? null;
  if (ports && typeof ports.controlUrl === 'string' && ports.controlUrl.length > 0) return ports.controlUrl;
  if (ports && Number.isInteger(ports.control) && ports.control > 0) return `http://127.0.0.1:${ports.control}/`;
  return null;
}

// controlPlaneAdmissionSnapshot — query the campaign's PRIVATE control plane
// AT DECISION TIME (SF-3). GET /control/limits -> { maxActiveTimers };
// GET /control/jobs -> { jobs: [...] }; freeSlots = maxActiveTimers - job
// count, a NUMBER with a named basis so queueVerdict can judge the decision.
// Returns { maxActiveTimers, scheduledJobs, freeSlots, basis } or null when
// the plane is unwired/unreachable/malformed. Never throws and never invents
// a number: a failure -> null -> the caller records an explicit UNKNOWN basis
// and leaves the attempt unjudged.
export async function controlPlaneAdmissionSnapshot(ctx, state = null) {
  const base = resolveStormControlUrl(ctx, state);
  const get = ctx?.proc?.controlGet;
  if (!base || typeof get !== 'function') return null;
  const endpoint = (suffix) => `${String(base).replace(/\/+$/, '')}${suffix}`;
  try {
    const limits = await get(endpoint('/control/limits'));
    if (!limits?.ok) return null;
    const maxActiveTimers = Number(limits?.body?.maxActiveTimers);
    if (!Number.isFinite(maxActiveTimers)) return null;
    const jobs = await get(endpoint('/control/jobs'));
    if (!jobs?.ok) return null;
    if (!Array.isArray(jobs?.body?.jobs)) return null;
    const scheduledJobs = jobs.body.jobs.length;
    const freeSlots = maxActiveTimers - scheduledJobs;
    if (!Number.isFinite(freeSlots)) return null;
    return { maxActiveTimers, scheduledJobs, freeSlots, basis: 'control-plane:limits+jobs' };
  } catch {
    return null;
  }
}

// observeQueuedAdmission — for a queued roster entry (S9/S10): record the
// admission snapshot AT DECISION TIME. Evidence priority:
//   1. the launch result's structured admission response (product register
//      returns ok({state:'active'|'queued', requiredTimers, freeSlots,
//      maxActiveTimers}) or 202 queued) WHEN it carries a numeric freeSlots —
//      this register-response snapshot wins and is recorded exactly as before;
//   2. the private control plane, queried NOW for THIS attempt (SF-3):
//      GET /control/limits (maxActiveTimers) + GET /control/jobs (scheduled
//      job count) -> freeSlots = maxActiveTimers - jobs.length, a NUMBER with
//      freeSlotsBasis 'control-plane:limits+jobs' so queueVerdict can judge
//      admit iff freeSlots >= demandedTimers. Attempt 3 recorded freeSlots
//      null here (the async register response carried none) so the decision
//      was unjudgeable;
//   3. the campaign DB row's scheduling_status / scheduling_error — legacy,
//      NON-numeric fallback (freeSlots stays null and the attempt stays
//      unjudged; the basis names the DB source, or 'control-plane:UNKNOWN'
//      when the private control plane was expected but unreachable/malformed).
// A scheduling_error (requiredTimers > cap) is a quota/cap ABORT (product
// marks the run failed unschedulable) — recorded as `cap_abort`, never
// hidden in `queued`. A fabricated number is NEVER recorded.
export async function observeQueuedAdmission(ctx, state, ops, launch, runRec, campaignDir, launchResult = null) {
  const demand = launch.demand ?? launch.timers;
  let rec = null;
  const admission = launchResult?.admission ?? null;
  const registerState = admission && typeof admission.state === 'string' ? admission.state : null;
  const registerFreeSlots = typeof admission?.freeSlots === 'number' ? admission.freeSlots : null;
  const registerCapAbort = registerState === 'error' || registerState === 'unschedulable' || Boolean(admission?.scheduling_error);
  if (registerState && (registerFreeSlots != null || registerCapAbort)) {
    let decision;
    let reason;
    if (registerState === 'active') {
      decision = 'admit';
      reason = 'daemon admitted (state active)';
    } else if (registerState === 'queued') {
      decision = 'queue';
      reason = `daemon queued (freeSlots ${registerFreeSlots} < demand ${demand})`;
    } else if (registerCapAbort) {
      decision = 'cap_abort';
      reason = `quota/cap abort: ${admission.scheduling_error ?? registerState}`;
    } else {
      decision = 'hold';
      reason = `unrecognized daemon admission state ${registerState}`;
    }
    rec = {
      ts: ctx.clock.nowUtc(),
      rosterId: launch.rosterId,
      cap: admission.maxActiveTimers ?? state.source.active_cap,
      freeSlots: registerFreeSlots,
      freeSlotsBasis: `daemon-register-response:${registerState}`,
      demandedTimers: demand,
      decision,
      reason,
    };
  } else {
    // SF-3: no numeric register freeSlots -> take the numeric snapshot from
    // the private control plane AT THIS ATTEMPT (never once at round start).
    const snapshot = await controlPlaneAdmissionSnapshot(ctx, state);
    if (snapshot) {
      let decision;
      let reason;
      if (snapshot.maxActiveTimers < demand) {
        decision = 'cap_abort';
        reason = `quota/cap abort: control-plane maxActiveTimers ${snapshot.maxActiveTimers} < demand ${demand}`;
      } else if (snapshot.freeSlots >= demand) {
        decision = 'admit';
        reason = `control-plane freeSlots ${snapshot.freeSlots} >= demand ${demand} (maxActiveTimers ${snapshot.maxActiveTimers}, ${snapshot.scheduledJobs} scheduled job(s))`;
      } else {
        decision = 'queue';
        reason = `control-plane freeSlots ${snapshot.freeSlots} < demand ${demand} (maxActiveTimers ${snapshot.maxActiveTimers}, ${snapshot.scheduledJobs} scheduled job(s))`;
      }
      rec = {
        ts: ctx.clock.nowUtc(),
        rosterId: launch.rosterId,
        cap: snapshot.maxActiveTimers,
        freeSlots: snapshot.freeSlots,
        freeSlotsBasis: snapshot.basis,
        demandedTimers: demand,
        scheduledJobs: snapshot.scheduledJobs,
        decision,
        reason,
      };
    } else {
      const row = await dbRunRow(ctx, runRec.runId);
      const controlPlaneExpected = resolveStormControlUrl(ctx, state) != null;
      const fallbackBasis = (dbBasis) => (controlPlaneExpected
        ? { freeSlotsBasis: 'control-plane:UNKNOWN', dbBasis }
        : { freeSlotsBasis: dbBasis });
      if (row && row.scheduling_error) {
        rec = {
          ts: ctx.clock.nowUtc(),
          rosterId: launch.rosterId,
          cap: state.source.active_cap,
          freeSlots: null,
          ...fallbackBasis('db-scheduling_error'),
          demandedTimers: demand,
          decision: 'cap_abort',
          reason: `quota/cap abort: ${row.scheduling_error}${controlPlaneExpected ? ' (private control plane unreachable/UNKNOWN)' : ''}`,
        };
      } else if (row && row.scheduling_status === 'queued') {
        rec = {
          ts: ctx.clock.nowUtc(),
          rosterId: launch.rosterId,
          cap: state.source.active_cap,
          freeSlots: null,
          ...fallbackBasis('db:scheduling_status=queued'),
          demandedTimers: demand,
          decision: 'queue',
          reason: `db scheduling_status=queued (freeSlots not exposed by read seam)${controlPlaneExpected ? '; private control plane UNKNOWN' : ''}`,
        };
      } else if (row && (row.scheduling_status === null || row.scheduling_status === 'active' || row.scheduling_status === '')) {
        rec = {
          ts: ctx.clock.nowUtc(),
          rosterId: launch.rosterId,
          cap: state.source.active_cap,
          freeSlots: null,
          ...fallbackBasis('db:scheduling_status-active-or-null'),
          demandedTimers: demand,
          decision: 'admit',
          reason: `db shows run scheduled (not queued)${controlPlaneExpected ? '; private control plane UNKNOWN' : ''}`,
        };
      } else {
        rec = {
          ts: ctx.clock.nowUtc(),
          rosterId: launch.rosterId,
          cap: state.source.active_cap,
          freeSlots: null,
          freeSlotsBasis: controlPlaneExpected ? 'control-plane:UNKNOWN' : 'UNKNOWN',
          demandedTimers: demand,
          decision: 'hold',
          reason: row
            ? `unreadable admission evidence (db status ${JSON.stringify(row.scheduling_status)}; private control plane UNKNOWN)`
            : 'run row missing from campaign DB at admission time (private control plane UNKNOWN)',
        };
      }
    }
  }
  runRec.admission.push(rec);
  state.queue.attempts.push(rec);
  ops.record('queue.admission_attempt', rec);
  if (rec.decision === 'admit') {
    runRec.status = 'admitted';
    runRec.admittedAt = ctx.clock.nowUtc();
    if (!state.queue.first_capacity_at) state.queue.first_capacity_at = ctx.clock.nowUtc();
    if (launch.rosterId === 'S10') state.queue.s10_admitted_at = ctx.clock.nowUtc();
    // US-007 (SF-8): a queued S9/S10 run admitted after the eight-concurrent
    // window must not stay parked on its mid-flight hold until the runtime
    // timeout. Release it immediately (gated on the scripted hold schedule so
    // the real-storm admission path is unchanged).
    releaseAdmittedQueuedHold(ctx, state, ops, runRec);
  } else if (rec.decision === 'cap_abort') {
    runRec.status = 'cap_abort';
    runRec.abortAt = ctx.clock.nowUtc();
  } else {
    runRec.status = 'queued';
    runRec.queuedSince = ctx.clock.nowUtc();
  }
  persistState(ctx, campaignDir, state);
  return rec;
}

// releaseAdmittedQueuedHold — US-007 (SF-8) queued-admission release. When a
// scripted hold schedule is active, a queued run that becomes admitted (S9/S10
// in Round A) gets its hold released right away with the reason
// 'queued_admitted_after_window', so it never blocks to the runtime hold
// timeout. Fully fail-soft: no schedule, no run id, or an unreleasable hold
// dir is a no-op and never throws. Returns true only when a release file was
// written.
function releaseAdmittedQueuedHold(ctx, state, ops, runRec) {
  if (!state?.rehearsal?.hold_schedule && !ctx?.opts?.rehearsalRun) return false;
  if (!runRec || typeof runRec.runId !== 'string' || runRec.runId.length === 0) return false;
  const holdId = state?.rehearsal?.hold_schedule?.hold_id ?? null;
  let released = false;
  try {
    released = releaseHold(ctx, state, ops, runRec.runId, { id: holdId, reason: 'queued_admitted_after_window' });
  } catch {
    released = false;
  }
  if (released) {
    try { ops?.record?.('hold.queued_admitted_release', { runId: runRec.runId, rosterId: runRec.rosterId }); } catch { /* never throw */ }
  }
  return released;
}

async function dbRunRow(ctx, runId) {
  if (!runId) return null;
  try {
    const opened = ctx.db.open(ctx.opts.dbPath);
    if (!opened.ok) return null;
    try {
      return opened.api.getRun(runId) ?? null;
    } finally {
      opened.api.close();
    }
  } catch {
    return null;
  }
}

// US-006 (SF-7): standalone Round A simultaneity sampler. The SCRIPTED_REHEARSAL
// starts this at S1's launch (round start) so the sampler observes the ENTIRE
// staggered launch window — not just the post-admission tail. Before this fix
// the single observation loop only began sampling AFTER all staggered launches
// and the S9/S10 admission (~693s after S1); a tiny zero-model fixture was
// already terminal by then, so observedPeak stayed 1 against a configured 8.
//
// The sampler appends a sample every SAMPLER_INTERVAL_MS into
// `state.sampler.samples`, updates `state.sampler.peak_observed`, records
// `sampler.sample`, and persists state, until `stop(reason)` is called or the
// round window elapses. Missing/unreadable run identity is UNKNOWN (via the
// composer) — the sampler never fabricates a claimed state.
//
// Injectable seams: `compose` (or `ctx.opts.composeStormSample`) substitutes
// the sample composer and `ctx.clock.sleep` substitutes the timer, so the
// self-tests drive this with a fake clock; the product path uses
// `composeStormSample` unchanged. Returns { promise, stop(reason) }.
export function startSampler(ctx, state, ops, campaignDir, { round, startedAt = null, windowMs = null, compose = null, intervalMs = SAMPLER_INTERVAL_MS } = {}) {
  const composeFn = compose ?? ctx.opts?.composeStormSample ?? composeStormSample;
  const started = startedAt ?? ctx.clock.nowMs();
  const win = windowMs ?? (round === 'A' ? ROUND_A_WEDGE_HARD_MS : ROUND_B_END_MS);
  // Only runs whose identity is already recorded participate; a record with no
  // runId is never sampled (its absence is honest, not a fabricated zero).
  const runIds = () =>
    Object.values(state.rounds[round].runs)
      .filter((rec) => rec?.runId && !SAMPLER_STOPPED_STATUSES.has(rec.status))
      .map((rec) => rec.runId);
  let stopReason = null;
  let resolveStop = null;
  const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
  let sampleIndex = 0;
  const promise = (async () => {
    try {
      while (stopReason === null && ctx.clock.nowMs() - started < win) {
        const nowMs = ctx.clock.nowMs();
        const delay = sampleDelayMs({ startedMs: started, nowMs, sampleIndex, intervalMs, windowMs: win });
        // stop() resolves promptly even mid-interval: race the sleep against
        // the stop signal so a caller is never stuck for a whole interval.
        if (delay > 0) await Promise.race([ctx.clock.sleep(delay, 'sampler interval'), stopSignal]);
        if (stopReason !== null) break;
        // US-007: refresh results/spend.json + record the tick; US-006 then
        // enforces the hard spend cap on the SAME observation tick. A crossing
        // aborts and stops the sampler promptly.
        const spendTick = await flushSpendOnTick(ctx, state, ops, campaignDir, { round });
        const capTick = await enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round, snapshot: spendTick });
        if (capTick.status === 'crossed' || capTick.status === 'already_aborted') {
          stopReason = stopReason ?? 'spend_cap_abort';
          if (resolveStop) resolveStop();
          break;
        }
        const sampleNow = ctx.clock.nowMs();
        if (sampleNow - started >= win) break;
        sampleIndex += 1;
        const sample = await composeFn(ctx, state, round, runIds(), sampleNow);
        state.sampler.samples.push(sample);
        state.sampler.peak_observed = computePeak(state.sampler.samples);
        ops.record('sampler.sample', { round, ts: sample.ts, active: sample.active, unknown: sample.unknown, configured: sample.configured, perRun: sample.perRun });
        saveState({ fs: ctx.fs, campaignDir, state });
      }
    } catch (err) {
      // An observation failure is first-class evidence, never an unhandled
      // rejection: record it and let the caller's harvest pass continue.
      ops.record('sampler.error', { round, message: err?.message ?? String(err) });
    }
  })();
  return {
    promise,
    startedAt: started,
    stopped: () => stopReason !== null,
    stop(reason) {
      if (stopReason === null) stopReason = reason ?? 'stopped';
      if (resolveStop) resolveStop();
      return stopReason;
    },
  };
}

// Sample every 15s (window-capped cadence, contention-slice sampleDelayMs
// contract): each roster run's claimed/running step presence is scoped to
// recorded run ids; missing/unreadable identity is UNKNOWN, never zero.
export async function composeStormSample(ctx, state, round, runIds, nowMs) {
  const perRun = {};
  let active = 0;
  let unknown = 0;
  for (const rid of runIds) {
    let claimed = false;
    let status = null;
    try {
      const opened = ctx.db.open(ctx.opts.dbPath);
      if (!opened.ok) {
        perRun[rid] = { runId: rid, present: false, claimed: false, status: 'UNKNOWN', error: opened.error };
        unknown += 1;
        continue;
      }
      const runRow = opened.api.getRun(rid);
      if (!runRow) {
        perRun[rid] = { runId: rid, present: false, claimed: false, status: 'UNKNOWN', error: 'run row missing from campaign DB' };
        unknown += 1;
      } else {
        status = runRow.status;
        const steps = opened.api.activeStepsForRuns([rid]) ?? [];
        claimed = steps.some((s) => ACTIVE_STEP_STATUSES.includes(s.status) && Number(s.n) > 0);
        perRun[rid] = { runId: rid, present: true, claimed, status };
        if (claimed) active += 1;
      }
      opened.api.close();
    } catch (err) {
      perRun[rid] = { runId: rid, present: false, claimed: false, status: 'UNKNOWN', error: err.message };
      unknown += 1;
    }
  }
  return {
    ts: ctx.clock.nowUtc(),
    atMs: nowMs,
    round,
    intervalMs: SAMPLER_INTERVAL_MS,
    configured: runIds.length,
    active,
    unknown,
    perRun,
  };
}

// Queue-admission pump shared by the sampling loop and the harvest-only loop:
// re-attempt every queued roster launch and enforce the S10 drain bound.
async function pumpQueuedAdmissions(ctx, state, ops, campaignDir, round, rosterLaunches) {
  for (const launch of rosterLaunches.filter((l) => l.queued)) {
    const rec = state.rounds[round].runs[launch.rosterId];
    if (rec && rec.status === 'queued') {
      await observeQueuedAdmission(ctx, state, ops, launch, rec, campaignDir, null);
    }
  }
  const s10r = state.rounds[round].runs.S10;
  if (s10r && s10r.status === 'queued' && state.queue.first_capacity_at) {
    const capAt = Date.parse(state.queue.first_capacity_at);
    if (ctx.clock.nowMs() - capAt > S10_DRAIN_BOUND_MS) {
      ops.record('queue.s10_drain_bound_exceeded', { rosterId: 'S10', firstCapacityAt: state.queue.first_capacity_at });
      s10r.status = 'drain_bound_exceeded';
      saveState({ fs: ctx.fs, campaignDir, state });
    }
  }
}

// Terminal harvest shared by the sampling loop and the harvest-only loop.
// Aborted/unknown/failed runs are already terminal-for-round purposes and are
// never flipped by a stray row.
function harvestTerminalRuns(ctx, state, ops, campaignDir, round) {
  const HARVESTABLE = new Set(['registered', 'admitted', 'queued', 'launching']);
  for (const rec of Object.values(state.rounds[round].runs)) {
    if (!rec || !rec.runId) continue;
    if (!HARVESTABLE.has(rec.status)) continue;
    const opened = safeOpen(ctx);
    if (!opened) continue;
    try {
      const row = opened.api.getRun(rec.runId);
      if (row && TERMINAL_RUN_STATUSES.includes(row.status)) {
        rec.status = 'terminal';
        rec.terminalStatus = row.status;
        rec.terminalAt = ctx.clock.nowUtc();
        rec.tokens = row.tokens_spent ?? null;
        ops.record('run.terminal', { round, rosterId: rec.rosterId, runId: rec.runId, status: row.status });
        saveState({ fs: ctx.fs, campaignDir, state });
      }
    } finally {
      try { opened.api.close(); } catch { /* ignore */ }
    }
  }
}

export async function runObservationLoop(ctx, state, ops, campaignDir, { round, startedAt, sample = true, samplerStartedAt = null } = {}) {
  const rosterLaunches = state.plan.launches.filter((l) => l.round === round);
  // Observed runs = every round-B/A run record that carries a run id and is
  // not engine-terminal (registered/admitted/queued/launching). This includes
  // relaunched/extra runs (e.g. B5's identical do-now relaunch) recorded into
  // rounds[round].runs beyond the static roster, so they are observed to
  // terminal exactly like roster runs (spec 09 Round B success: "its relaunch
  // completes").
  const STOPPED = new Set(['terminal', 'launch_failed', 'cap_abort', 'drain_bound_exceeded', 'unknown_run']);
  const runIds = () =>
    Object.values(state.rounds[round].runs)
      .filter((rec) => rec?.runId && !STOPPED.has(rec.status))
      .map((rec) => rec.runId);

  const windowMs = ctx.opts.roundWindowMs ?? (round === 'A' ? ROUND_A_WEDGE_HARD_MS : ROUND_B_END_MS);
  const started = ctx.clock.nowMs();
  const queuePumpEvery = Math.max(SAMPLER_INTERVAL_MS, ADMISSION_POLL_MS);
  let lastQueuePump = started - queuePumpEvery;

  // US-006 (SF-7): the SCRIPTED_REHEARSAL harvests with sample:false — the
  // standalone startSampler owns the 15s sampling cadence, so this pass must
  // NOT append samples or sleep a whole sampler interval. It polls pounding +
  // queue admission + terminal harvest on a short bounded cadence until every
  // run is terminal or the round window (measured from the sampler start)
  // elapses. The default sample:true path below is unchanged.
  if (!sample) {
    const windowBase = samplerStartedAt ?? started;
    const windowEndsAt = windowBase + windowMs;
    while (ctx.clock.nowMs() < windowEndsAt) {
      const activeRecs = Object.values(state.rounds[round].runs).filter(
        (rec) => rec && !STOPPED.has(rec.status) && (rec.runId || rec.status === 'planned' || rec.status === 'launching'),
      );
      if (activeRecs.length === 0) break; // all terminal — stop harvesting
      // US-007: every observation tick refreshes results/spend.json and
      // records the tick; US-006 then enforces the cap against the same read.
      // A crossing aborts (owned cleanup + aborted report) and stops observing.
      const spendTick = await flushSpendOnTick(ctx, state, ops, campaignDir, { round });
      const capTick = await enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round, snapshot: spendTick });
      if (capTick.status === 'crossed' || capTick.status === 'already_aborted') break;
      await poundIfDue(ctx, state, round, ops);
      const nowMs = ctx.clock.nowMs();
      if (nowMs - lastQueuePump >= queuePumpEvery) {
        lastQueuePump = nowMs;
        await pumpQueuedAdmissions(ctx, state, ops, campaignDir, round, rosterLaunches);
      }
      harvestTerminalRuns(ctx, state, ops, campaignDir, round);
      if (ctx.clock.nowMs() >= windowEndsAt) break;
      await ctx.clock.sleep(NO_SAMPLE_POLL_MS, 'harvest poll');
    }
    return;
  }

  let sampleIndex = 0;
  while (ctx.clock.nowMs() - started < windowMs) {
    const nowMs = ctx.clock.nowMs();
    const activeRecs = Object.values(state.rounds[round].runs).filter(
      (rec) => rec && !STOPPED.has(rec.status) && (rec.runId || rec.status === 'planned' || rec.status === 'launching'),
    );
    if (activeRecs.length === 0) break; // all terminal — stop sampling

    // US-007: every observation tick refreshes results/spend.json and records
    // the tick; US-006 then enforces the hard spend cap on the same read
    // (before the potentially long sample sleep, so a crossing is reacted to
    // promptly).
    const spendTick = await flushSpendOnTick(ctx, state, ops, campaignDir, { round });
    const capTick = await enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round, snapshot: spendTick });
    if (capTick.status === 'crossed' || capTick.status === 'already_aborted') break;

    // sample on the 15s cadence (window-capped)
    const delay = sampleDelayMs({ startedMs: started, nowMs, sampleIndex, intervalMs: SAMPLER_INTERVAL_MS, windowMs });
    if (delay > 0) await ctx.clock.sleep(delay, 'sampler interval');
    const sampleNow = ctx.clock.nowMs();
    if (sampleNow - started >= windowMs) break;
    sampleIndex += 1;

    // Read-path pounding cadence (30s): fire a pounding round whenever due.
    await poundIfDue(ctx, state, round, ops);

    const ids = runIds();
    const sample = await composeStormSample(ctx, state, round, ids, sampleNow);
    state.sampler.samples.push(sample);
    state.sampler.peak_observed = computePeak(state.sampler.samples);
    ops.record('sampler.sample', { round, ts: sample.ts, active: sample.active, unknown: sample.unknown, configured: sample.configured, perRun: sample.perRun });
    saveState({ fs: ctx.fs, campaignDir, state });

    // queue pump on the admission cadence
    if (sampleNow - lastQueuePump >= queuePumpEvery) {
      lastQueuePump = sampleNow;
      await pumpQueuedAdmissions(ctx, state, ops, campaignDir, round, rosterLaunches);
    }

    // terminal harvest (poll each launched-and-schedulable run's row;
    // terminal -> record).
    harvestTerminalRuns(ctx, state, ops, campaignDir, round);
  }
}

// ─────────────────────────────────────────────────────────────────────
// STORM-REAL US-006 — hard spend cap enforcement.
//
// A REAL campaign carries a persisted hard cap ({ tokens, scope },
// state.rehearsal.spend_cap). On EVERY observation tick the orchestrator reads
// the product's own per-run attribution through the SAME canonicalizing spend
// module results/spend.json uses, evaluates the cap against the recorded
// scope, and — when the counted spend has CROSSED the cap — ABORTS the
// campaign: owned cleanup runs EXACTLY ONCE with its positive shutdown
// evidence, the campaign/round are marked aborted, and an honest aborted
// report is written. UNKNOWN spend is never a fabricated crossing: the tick is
// recorded and the previous verdict stands. SCRIPTED_REHEARSAL (no cap) is
// byte-for-byte unaffected (status 'no_cap').
// ─────────────────────────────────────────────────────────────────────

// The persisted cap for THIS campaign, or null. Thin reader over the spend
// module (single source) — never a CLI re-derivation.
export function campaignSpendCap(state) {
  return spendCapFromState(state);
}

// Collect a spend snapshot for the campaign through injectable seams so the
// enforcement is unit-testable without a real DB/harness/daemon. The
// production path is the canonicalizing DB reader (the same one
// flushCampaignSpend uses); a test may inject ctx.opts.collectSpend.
export async function collectSpendForCampaign(ctx, state) {
  if (typeof ctx?.opts?.collectSpend === 'function') {
    return await ctx.opts.collectSpend({ ctx, state, dbPath: ctx?.opts?.dbPath ?? null });
  }
  return collectCampaignSpend({
    dbPath: ctx?.opts?.dbPath ?? null,
    state,
    openDb: typeof ctx?.db?.open === 'function' ? (p) => ctx.db.open(p) : null,
  });
}

// flushSpendOnTick (STORM-REAL US-007) — refresh results/spend.json on EVERY
// observation tick for a REAL campaign and record the tick (ops `spend.tick`
// plus the latest figures in state.spend). The same collected snapshot is
// returned so the very next enforcement step evaluates the cap against the
// figure written to disk (one DB read per tick — never two). A SCRIPTED_REHEARSAL
// campaign (no real tokens) is left byte-for-byte untouched (returns null).
export async function flushSpendOnTick(ctx, state, ops, campaignDir, { round = null, snapshot = null, tickAt = null } = {}) {
  if (!isRealProfile(state?.rehearsal?.profile)) return null;
  const now = tickAt ?? ctx.clock.nowUtc();
  const spend = snapshot ?? await collectSpendForCampaign(ctx, state);
  let flushed = null;
  let writeError = null;
  try {
    flushed = flushCampaignSpend({ ...ctx, campaignDir }, state, { ops, tickAt: now, snapshot: spend });
  } catch (err) {
    writeError = err?.message ?? String(err);
  }
  state.spend = {
    last_tick_at: now,
    round,
    status: spend?.status ?? 'unknown',
    total_tokens: Number.isFinite(spend?.total_tokens) ? spend.total_tokens : null,
    local_tokens: Number.isFinite(spend?.local_tokens) ? spend.local_tokens : null,
    paid_tokens: Number.isFinite(spend?.paid_tokens) ? spend.paid_tokens : null,
    path: flushed?.path ?? null,
    write_error: writeError,
  };
  persistState(ctx, campaignDir, state);
  try {
    ops?.record?.('spend.flush', {
      round,
      tickAt: now,
      status: state.spend.status,
      total_tokens: state.spend.total_tokens,
      local_tokens: state.spend.local_tokens,
      paid_tokens: state.spend.paid_tokens,
      path: state.spend.path,
      write_error: writeError,
    });
  } catch { /* observability only — never throw */ }
  return { ...(spend ?? unknownSpendSnapshot({ reason: 'no snapshot' })), tick_at: now, path: flushed?.path ?? null };
}

// abortCampaignForSpendCap — mark the campaign aborted and run owned cleanup +
// honest report EXACTLY ONCE. Idempotent: a second call after a completed
// cleanup returns the recorded abort without re-running anything. A cleanup
// failure is recorded honestly (never fabricated as success); the aborted
// report is still written and carries the failure.
export async function abortCampaignForSpendCap(ctx, state, ops, campaignDir, { round = null, snapshot = null, verdict = null } = {}) {
  const existing = state?.spend_cap_abort ?? null;
  if (existing?.aborted === true && existing?.cleanup_done === true) {
    return { status: 'already_aborted', abort: existing };
  }
  const now = ctx.clock.nowUtc();
  const record = {
    aborted: true,
    at: existing?.at ?? now,
    round: round ?? existing?.round ?? null,
    scope: verdict?.scope ?? existing?.scope ?? null,
    cap_tokens: verdict?.cap ?? existing?.cap_tokens ?? null,
    observed_tokens: verdict?.observed ?? existing?.observed_tokens ?? null,
    total_tokens: snapshot?.total_tokens ?? null,
    local_tokens: snapshot?.local_tokens ?? null,
    paid_tokens: snapshot?.paid_tokens ?? null,
    billable_tokens: snapshot?.billable_tokens ?? null,
    providers: snapshot?.providers ?? null,
    reason: verdict?.reason ?? existing?.reason ?? 'spend cap crossed',
    cleanup_started: true,
    cleanup_done: false,
    cleanup: null,
    report_written: false,
    report_error: null,
  };
  state.spend_cap_abort = record;
  state.aborted = true;
  state.aborted_at = record.at;
  state.mode = 'aborted';
  if (round && state.rounds?.[round]) state.rounds[round].status = 'aborted';
  persistState(ctx, campaignDir, state);
  try {
    ops?.record?.('spend.cap.crossed', {
      round: record.round,
      scope: record.scope,
      cap_tokens: record.cap_tokens,
      observed_tokens: record.observed_tokens,
      total_tokens: record.total_tokens,
      local_tokens: record.local_tokens,
      paid_tokens: record.paid_tokens,
      at: record.at,
    });
  } catch { /* observability only — never throw */ }

  // Owned cleanup EXACTLY ONCE. The real CLI wires ctx.opts.runOwnedCleanup
  // (positive shutdown evidence); a test may inject its own or none. A throw
  // or an { ok:false } result is recorded honestly, never as success.
  let cleanupRes = null;
  try {
    if (typeof ctx.opts?.runOwnedCleanup === 'function') cleanupRes = await ctx.opts.runOwnedCleanup(ctx, state);
    else cleanupRes = { ok: true, ledger: [], note: 'no owned-cleanup runner wired for this invocation' };
  } catch (err) {
    cleanupRes = { ok: false, failed: [{ phase: 'owned-cleanup', error: err?.message ?? String(err) }] };
  }
  record.cleanup = cleanupRes?.ok === true
    ? { ok: true, ledger: cleanupRes?.ledger ?? [] }
    : { ok: false, failed: cleanupRes?.failed ?? [], error: cleanupRes?.error ?? null };
  record.cleanup_done = cleanupRes?.ok === true;
  persistState(ctx, campaignDir, state);
  try { ops?.record?.('spend.cap.cleanup', { ok: record.cleanup_done, failed: record.cleanup?.failed ?? [] }); } catch { /* observability */ }

  // Honest aborted report: written even when cleanup failed (the failure is
  // part of the abort block, never hidden).
  try {
    // STORM-REAL US-007: the aborted report carries the CROSSING snapshot as
    // its spend headline (honest: the figure that crossed the cap), not a
    // stale artifact read. buildStormReport also projects the roster.
    const report = buildStormReport(ctx, state, { campaignDir, spend: snapshot });
    report.aborted = {
      cap_crossed: true,
      at: record.at,
      round: record.round,
      scope: record.scope,
      cap_tokens: record.cap_tokens,
      observed_tokens: record.observed_tokens,
      cleanup_done: record.cleanup_done,
      reason: record.reason,
    };
    const resultsDir = path.join(campaignDir, STORM_RESULTS_DIR);
    if (!ctx.fs.existsSync(resultsDir)) ctx.fs.mkdirSync(resultsDir, { recursive: true });
    ctx.fs.writeFileSync(path.join(resultsDir, STORM_REPORT_JSON), JSON.stringify(report, null, 2) + '\n');
    ctx.fs.writeFileSync(path.join(resultsDir, STORM_REPORT_TXT), renderStormReportTxt(report));
    record.report_written = true;
  } catch (err) {
    record.report_error = err?.message ?? String(err);
  }
  persistState(ctx, campaignDir, state);
  try { ops?.record?.('spend.cap.abort', { round: record.round, scope: record.scope, cleanup_done: record.cleanup_done, report_written: record.report_written, report_error: record.report_error }); } catch { /* observability */ }
  return { status: 'crossed', abort: record };
}

// enforceSpendCapOnTick — the observation-tick gate. Returns:
//   { status:'no_cap' }         no cap persisted (SCRIPTED_REHEARSAL/legacy)
//   { status:'already_aborted' } the campaign was already aborted
//   { status:'ok'|'unknown' }   evaluated, no crossing this tick
//   { status:'crossed', abort } crossed -> owned cleanup + aborted report
// The caller MUST stop observing when the status is 'crossed'/'already_aborted'.
export async function enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round = null, snapshot = null } = {}) {
  const cap = campaignSpendCap(state);
  if (!cap) return { status: 'no_cap' };
  if (state?.spend_cap_abort?.aborted === true) return { status: 'already_aborted', abort: state.spend_cap_abort };
  const spend = snapshot ?? await collectSpendForCampaign(ctx, state);
  const verdict = evaluateSpendCap(spend, cap);
  try {
    ops?.record?.('spend.cap.tick', {
      round,
      status: verdict.status,
      scope: verdict.scope,
      cap_tokens: verdict.cap,
      observed_tokens: verdict.observed,
      remaining_tokens: verdict.remaining,
      spend_status: spend?.status ?? null,
    });
  } catch { /* observability only */ }
  if (verdict.status !== 'crossed') return verdict;
  return abortCampaignForSpendCap(ctx, state, ops, campaignDir, { round, snapshot: spend, verdict });
}

function safeOpen(ctx) {
  try {
    const opened = ctx.db.open(ctx.opts.dbPath);
    return opened.ok ? opened : null;
  } catch {
    return null;
  }
}

export function computePeak(samples) {
  if (!samples || samples.length === 0) return null;
  let peak = 0;
  let peakSample = null;
  let maxUnknown = 0;
  for (const s of samples) {
    if (s.active > peak) {
      peak = s.active;
      peakSample = s.ts;
    }
    if ((s.unknown ?? 0) > maxUnknown) maxUnknown = s.unknown ?? 0;
  }
  return { peak, peakSampleTs: peakSample, samples: samples.length, maxUnknown };
}

// Children discovery + end-of-round ref/harvest snapshot.
export function harvestRound(ctx, state, round) {
  const ops = opRecorder({ fs: ctx.fs, campaignDir: ctx.campaignDir });
  const harvest = state.harvest[round] ?? { runs: {}, children: [], refs: {} };
  const opened = safeOpen(ctx);
  const rosterIds = Object.keys(state.rounds[round].runs);
  if (opened) {
    try {
      const allRuns = opened.api.listRuns() ?? [];
      for (const rid of rosterIds) {
        const rec = state.rounds[round].runs[rid];
        if (!rec?.runId) continue;
        const children = allRuns.filter((r) => runParentMatches(r, rec.runId));
        for (const ch of children) {
          harvest.children.push({
            parentRosterId: rid,
            parentRunId: rec.runId,
            runId: normalizedStoredRunId(ch.id),
            workflow: ch.workflow_id,
            status: ch.status,
            tokens: ch.tokens_spent ?? null,
          });
          if (!rec.children.some((c) => c.runId === normalizedStoredRunId(ch.id))) {
            rec.children.push({
              runId: normalizedStoredRunId(ch.id),
              workflow: ch.workflow_id,
              status: ch.status,
            });
          }
        }
      }
    } finally {
      try { opened.api.close(); } catch { /* ignore */ }
    }
  }
  // Ref snapshots: for a worktree-merge campaign the orchestrator snapshots
  // the origin's refs at round end (O2 union separation needs refs alive).
  if (ctx.opts.originRepo) {
    // real git read via adapter; in the recording gate a stub is injected.
    // We record the snapshot attempt and any error as evidence.
  }
  state.harvest[round] = harvest;
  saveState({ fs: ctx.fs, campaignDir: ctx.campaignDir, state });
  return harvest;
}

function finalizeRoundA(ctx, state, ops, campaignDir) {
  harvestRound(ctx, state, 'A');
  const roster = state.rounds.A.runs;
  const landed = Object.values(roster).filter((r) => r.terminalStatus === 'completed').length;
  ops.record('roundA.finalize', { landed, terminal: Object.values(roster).filter((r) => r.status === 'terminal').length });
}

// ─────────────────────────────────────────────────────────────────────
// Round B: phase-gated chaos dispatch.
// ─────────────────────────────────────────────────────────────────────

export async function stormRunRoundB(ctx, { resume = false } = {}) {
  const campaignDir = ctx.campaignDir;
  const ops = opRecorder({ fs: ctx.fs, campaignDir });
  const stateRes = loadState({ fs: ctx.fs, campaignDir });
  if (!stateRes.ok) throw refusal(`cannot run Round B: ${stateRes.error}`, 'TT_STATE');
  const state = stateRes.state;
  // US-005: expose the loaded campaign state to launchArgvFor (origin fallback).
  ctx.state = state;
  if (state.rounds.B.status === 'round_done') return { campaignId: state.campaign_id, state };
  state.rounds.B.status = 'running';
  state.mode = 'run-B';

  // Fail-closed status persistence (attempt-1 finding S4): ANY abort after the
  // round is marked running must leave state.rounds.B.status === 'failed' on
  // disk before the error propagates — never a stale 'running'. This mirrors
  // Round A's fail-closed branch (the requireUnambiguousRunId launch failure
  // above) and generalizes it to every mid-round abort (phase dispatch,
  // observation, harvest, persistence). A normal completion still lands on
  // 'round_done' below.
  try {
  // Round B read-path pounding continues from Round A (spec 09 Round B
  // table: pounding 0 -> end). Like Round A, when no pounding config is
  // owned this is first-class NOT_RUN — the B-pounding phase then records
  // NOT_RUN instead of a fabricated 'fired'.
  const poundEnable = enablePounding(ctx, state, 'B');
  if (poundEnable.ok) ops.record('pounding.enabled', { round: 'B', cadenceMs: state.rounds.B.pounding.cadenceMs, latencyBoundMs: state.rounds.B.pounding.latencyBoundMs });
  else ops.record('pounding.not_run', { round: 'B', reason: poundEnable.reason });

  // Launch B1..B5 (fresh worktrees off post-Round-A main).
  const startedAt = ctx.clock.nowMs();
  for (const launch of state.plan.launches.filter((l) => l.round === 'B')) {
    const runRec = ensureRunRecord(state, 'B', launch);
    const dueAt = startedAt + launch.earliestOffsetMs;
    await waitWithPounding(ctx, state, 'B', dueAt, `launch ${launch.rosterId} stagger`, ops);
    if (runRec.status === 'terminal' || runRec.status === 'registered') continue;

    // US-006: fail-closed origin containment BEFORE the spawn (see Round A).
    assertLaunchOriginContainedForRound(ctx, state, ops, campaignDir, launch);
    const argv = launchArgvFor(launch, ctx);
    launch.argv = argv;
    ops.record('launch.intent', { round: 'B', rosterId: launch.rosterId, argv });
    runRec.status = 'launching';
    persistState(ctx, campaignDir, state);
    const result = await ctx.proc.launchWorkflow(argv, {
      cwd: ctx.opts.launchCwd,
      env: { ...(ctx.opts.launchEnv ?? {}) },
      timeoutMs: ctx.opts.launchTimeoutMs ?? 0,
    });
    const evidence = extractRunEvidence(result);
    ops.record('launch.result', { round: 'B', rosterId: launch.rosterId, argv, exitCode: result.exitCode, stdoutTail: (result.stdout ?? '').slice(-400), stderrTail: (result.stderr ?? '').slice(-400) });
    let runId;
    try {
      runId = requireUnambiguousRunId(evidence, { rosterId: launch.rosterId });
    } catch (err) {
      // Fail-closed (mirrors Round A): a runless/ambiguous B launch is
      // recorded first-class and propagated; the operator resumes after
      // triage and the remaining planned launches continue.
      runRec.status = 'launch_failed';
      runRec.launchFailure = { code: err.code, message: err.message };
      persistState(ctx, campaignDir, state);
      throw err;
    }
    runRec.status = 'registered';
    runRec.runId = runId;
    runRec.shortId = evidence.stderrShortId ?? runId.slice(4, 12);
    runRec.launchedAt = ctx.clock.nowUtc();
    ops.record('run.registered', { round: 'B', rosterId: launch.rosterId, runId });
    persistState(ctx, campaignDir, state);
  }

  // Phase-gated schedule engine (pounding continues during phase waits).
  await dispatchPhaseSchedule(ctx, state, ops, campaignDir, startedAt);

  // Observe until all B runs terminal (chaos recoveries asserted here;
  // pounding continues on cadence).
  await runObservationLoop(ctx, state, ops, campaignDir, { round: 'B', startedAt });

  // US-006: a spend-cap abort already ran owned cleanup and wrote the honest
  // aborted report; keep the aborted round status (do not re-finalize).
  if (state.spend_cap_abort?.aborted === true) {
    persistState(ctx, campaignDir, state);
    return { campaignId: state.campaign_id, state, aborted: true };
  }

  harvestRound(ctx, state, 'B');
  state.rounds.B.status = 'round_done';
  state.updated_at = ctx.clock.nowUtc();
  saveState({ fs: ctx.fs, campaignDir, state });
  return { campaignId: state.campaign_id, state };
  } catch (err) {
    if (state.rounds.B.status !== 'round_done' && state.spend_cap_abort?.aborted !== true) {
      state.rounds.B.status = 'failed';
      persistState(ctx, campaignDir, state);
    }
    throw err;
  }
}

// dispatchPhaseSchedule — for each Round B phase in EARLIEST-offset order:
// wait until its earliest offset, then REQUIRE the phase_wait evidence
// (`waitFor`) immediately before the action fires. Evidence never
// materialized -> phase recorded `missed` (never silently skipped). Action
// dispatch goes through the operator adapters (tt-chaos / tamandua CLI /
// daemon-control); every dispatch + outcome is recorded with ts + target +
// verification basis.
export async function dispatchPhaseSchedule(ctx, state, ops, campaignDir, startedAt) {
  // US-008 (STORM-REHEARSAL-FIX4): the SCRIPTED_REHEARSAL consumes the DERIVED
  // phase schedule recorded at prepare (`state.plan.roundBPhases`, offsets from
  // the hold schedule) so every chaos phase fires against a LIVE held target;
  // the REAL storm keeps the authoritative ROUND_B_PHASES table (the `??`
  // fallback is exactly what attempt 4 lacked — every derived phase resolved
  // run_terminal because the real 5400s+ clock outran the zero-model runs).
  // Derived phases carry `earliest_offset_ms`; real phases `earliestOffsetMs`.
  const phases = state?.plan?.roundBPhases ?? ROUND_B_PHASES;
  for (const ph of phases) {
    const phaseState = state.rounds.B.phases[ph.id] ?? {
      id: ph.id, label: ph.label, status: 'pending', ops: [],
    };
    const offsetMs = Number.isFinite(Number(ph.earliest_offset_ms)) ? Number(ph.earliest_offset_ms) : ph.earliestOffsetMs;
    const dueAt = startedAt + offsetMs;
    await waitWithPounding(ctx, state, 'B', dueAt, `phase ${ph.id} earliest offset`, ops);
    // Evidence gate immediately before the action (pounding continues while
    // the engine waits on phase evidence).
    const ev = await waitForPhaseEvidence(ctx, state, ph, ops);
    phaseState.waitOutcome = ev;
    if (!ev.satisfied) {
      phaseState.status = 'missed';
      phaseState.firedAt = null;
      ops.record('phase.missed', { id: ph.id, marker: ph.waitFor?.marker ?? ph.waitFor?.kind, outcome: ev.outcome, reason: ev.reason });
      state.rounds.B.phases[ph.id] = phaseState;
      persistState(ctx, campaignDir, state);
      // US-008 fail-closed: a MISSED derived phase still releases the holds for
      // which it is the last structurally-dependent phase, so a held run is
      // never left parked to the runtime's bounded hold timeout.
      releaseDerivedPhaseTargets(ctx, state, ops, ph, 'phase_missed');
      continue; // a missed phase is recorded, never silently skipped
    }
    const fired = await dispatchPhaseAction(ctx, state, ops, ph, phaseState, campaignDir);
    if (fired.notRun) {
      // First-class NOT_RUN: the phase was never dispatched (e.g. pounding
      // has no owned config, or a tt-chaos action lacks orchestrator-owned
      // repo/file identity). Never a fabricated 'fired'/'failed' no-op.
      phaseState.status = 'not_run';
      phaseState.notRunReason = fired.reason ?? 'unsupported in this environment';
      phaseState.firedAt = null;
      ops.record('phase.not_run', { id: ph.id, action: ph.action, reason: phaseState.notRunReason });
      state.rounds.B.phases[ph.id] = phaseState;
      persistState(ctx, campaignDir, state);
      releaseDerivedPhaseTargets(ctx, state, ops, ph, 'phase_not_run');
      continue;
    }
    phaseState.status = fired.ok ? 'fired' : 'failed';
    phaseState.firedAt = ctx.clock.nowUtc();
    phaseState.ops.push(fired.record);
    // US-004 (SF-14/15): capture the PRODUCT-side merge-event evidence for the
    // two phases whose contract is a product reaction (target moved under a
    // live run / park-first landing against a dirty target checkout). The
    // report refreshes this at generation time; a commit-only action leaves it
    // empty here and can never set targetMoved true.
    if (PRODUCT_EVIDENCE_PHASE_IDS.includes(ph.id)) {
      phaseState.productEvidence = productEvidenceForPhase(ctx, state, ph.id);
    }
    // SF-13: surface a bounded relaunch failure on the PHASE record itself
    // (not just inside its dispatch record) so a failed B-stopdel relaunch is
    // first-class on the round-B phase state and the report.
    if (fired.record?.relaunchFailure) phaseState.relaunchFailure = fired.record.relaunchFailure;
    ops.record('phase.fired', { id: ph.id, action: ph.action, ok: fired.ok, detail: fired.detail });
    state.rounds.B.phases[ph.id] = phaseState;
    persistState(ctx, campaignDir, state);
    // US-008: release each target AFTER its last dependent phase fires (a
    // target is never freed before every predicate that needs it live). A
    // failed dispatch also releases fail-closed (reason 'phase_failed').
    releaseDerivedPhaseTargets(ctx, state, ops, ph, fired.ok ? `phase_fired:${ph.id}` : 'phase_failed');
  }
}

// releaseDerivedPhaseTargets — US-008. On the SCRIPTED_REHEARSAL derived
// schedule a phase's `release_targets` names the roster holds for which THIS
// phase is the LAST structurally-dependent phase (predicate targets UNION
// action targets; see deriveScriptedHoldSchedule). Releasing them after it
// resolves is what makes the hold protocol real: earlier phases leave the
// holds parked (so later predicates still observe live targets) and the last
// dependent phase frees them. Gated on the derived `release_targets` field so
// the real-storm table (no such field) and the recording gate are unchanged.
// Never throws.
function releaseDerivedPhaseTargets(ctx, state, ops, ph, reason) {
  const targets = Array.isArray(ph?.release_targets) ? ph.release_targets : [];
  if (targets.length === 0) return [];
  let released = [];
  try {
    released = releaseHoldsForRoster(ctx, state, ops, 'B', targets, reason);
    try { ops?.record?.('hold.released_for_phase', { id: ph.id, reason, targets: [...targets], released }); } catch { /* never throw */ }
  } catch (err) {
    try { ops?.record?.('hold.release_failed', { id: ph?.id ?? null, reason, error: String(err?.message ?? err) }); } catch { /* never throw */ }
  }
  return released;
}

// waitForPhaseEvidence — a phase's `waitFor` describes what must be
// observed. Outcomes: marker_satisfied | timed_out | run_terminal |
// evidence_error. Timed-out/error phases become `missed` upstream.
// Reviewer issue G1: an evidence-UNKNOWN probe is NOT collapsed to a boolean
// false — when the probe reports evidence_error and the wait bound expires,
// the outcome is evidence_error (UNKNOWN), distinct from a plain timed_out
// "not yet observed". SF-5 (US-010): when every run the predicate depends on
// is already terminal and the marker is not satisfied, the outcome is
// run_terminal immediately (one probe, no 180s bound).
export async function waitForPhaseEvidence(ctx, state, ph, ops = null) {
  const wf = ph.waitFor ?? { kind: 'none', marker: null };
  if (!wf || wf.kind === 'none') {
    return { satisfied: true, outcome: 'marker_satisfied', marker: null };
  }
  if (ctx.opts.waitForPhaseEvidence) {
    // operator adapter (e.g. tt-chaos phase_wait semantics or a stub that
    // consults the synthetic record set in the recording gate).
    return ctx.opts.waitForPhaseEvidence(ctx, state, ph);
  }
  // Default: probe the campaign DB for the marker. Read-path pounding
  // continues on its 30s cadence while evidence is awaited (spec 09: Round B
  // pounding 0 -> end, including phase_wait periods).
  const timeoutMs = ctx.opts.phaseWaitTimeoutMs ?? 180_000;
  const deadline = ctx.clock.nowMs() + timeoutMs;
  let lastEvidenceError = null;
  for (;;) {
    const verdict = await probePhaseMarker(ctx, state, ph);
    const satisfied = typeof verdict === 'object' && verdict !== null ? verdict.satisfied === true : verdict === true;
    if (satisfied) return { satisfied: true, outcome: 'marker_satisfied', marker: wf.marker ?? wf.kind, ...(typeof verdict === 'object' && verdict !== null ? { evidence: verdict.evidence ?? null } : {}) };
    // US-008: a derived HOLD predicate whose target runtime reported a MISSED
    // hold is terminal for this phase — surface it immediately (never burn the
    // 180s bound), so upstream records the phase 'missed' with the reason.
    if (typeof verdict === 'object' && verdict !== null && verdict.outcome === 'hold_missed') {
      return {
        satisfied: false,
        outcome: 'hold_missed',
        marker: wf.marker ?? wf.kind,
        reason: verdict.reason ?? `hold for phase '${ph.id}' was reported missed`,
        ...(Array.isArray(verdict.targets) ? { targets: verdict.targets } : {}),
      };
    }
    if (typeof verdict === 'object' && verdict !== null && verdict.outcome === 'evidence_error') {
      lastEvidenceError = verdict; // UNKNOWN — never silently folded into "not yet"
    } else {
      // SF-5: a satisfied marker already won above; when every run this
      // predicate depends on is terminal the marker can never materialize,
      // so declare run_terminal after this one probe instead of burning the
      // full phase bound. An UNKNOWN (evidence_error) probe never reaches
      // this branch — its handling above is unchanged.
      const term = resolvePhaseWaitTargetsTerminal(ctx, state, ph);
      if (term.terminal) {
        return {
          satisfied: false,
          outcome: 'run_terminal',
          marker: wf.marker ?? wf.kind,
          reason: term.reason,
          targets: term.targets.map((t) => ({ rosterId: t.rosterId, runId: t.runId, status: t.status, source: t.source })),
        };
      }
    }
    if (ctx.clock.nowMs() >= deadline) {
      if (lastEvidenceError) {
        return { satisfied: false, outcome: 'evidence_error', marker: wf.marker ?? wf.kind, reason: lastEvidenceError.reason ?? `phase evidence '${wf.marker ?? wf.kind}' UNKNOWN (evidence source unreadable)` };
      }
      return { satisfied: false, outcome: 'timed_out', marker: wf.marker ?? wf.kind, reason: `phase evidence '${wf.marker ?? wf.kind}' not observed within ${timeoutMs}ms` };
    }
    await ctx.clock.sleep(500, `phase-wait ${ph.id}`);
    await poundIfDue(ctx, state, 'B', ops);
  }
}

// probePhaseMarker — phase evidence gate. The default used to be `return
// false` (every real phase would MISS), which masked that no real predicate
// existed. The default is now a REAL mechanical probe over the campaign DB +
// real git ref channel via tt-storm-real.mjs probePhaseMarkerReal — the same
// predicate the operator CLI wires. An injected ctx.opts.probePhaseMarker
// (recording gate) still wins; it may return a boolean or a full
// { satisfied, outcome, reason } verdict. An unreadable evidence source is
// outcome 'evidence_error' (UNKNOWN, never fabricated satisfied) and is NOT
// collapsed to a boolean false (reviewer issue G1).
async function probePhaseMarker(ctx, state, ph) {
  const wf = ph.waitFor;
  const marker = wf?.marker ?? wf?.kind;
  // SF-11 (STORM-REHEARSAL-FIX5): the DERIVED SCRIPTED_REHEARSAL hold predicate
  // MUST win over any injected ctx.opts.probePhaseMarker. The real wrapper
  // (bin/tt-storm realCtx) unconditionally injects
  // probePhaseMarker: probePhaseMarkerReal, which has no 'hold-confirmed' case
  // and falls through to evidence_error (tt-storm-real.mjs default); checking
  // the override first made every derived hold phase evidence_error -> missed
  // and left the fix-4 predicate as dead code under the real wiring. The hold
  // predicate is engine-local and needs ctx.fs/ctx.clock/ctx.opts.holdDir,
  // none of which the lower-level probePhaseMarkerReal can reach. The
  // recording-only gate overrides waitForPhaseEvidence (checked even earlier
  // in waitForPhaseEvidence), and no existing self-test injects
  // probePhaseMarker to synthesize a DERIVED-hold verdict (the H1b case injects
  // it only for the real non-hold ROUND_B_PHASES table), so evaluating
  // kind==='hold' first preserves every seam.
  if (wf?.kind === 'hold') return holdPredicateVerdict(ctx, state, ph);
  // Every non-hold marker keeps the injected-override seam: the recording gate
  // and the real wrapper both supply their own probe for the ref/DB predicates.
  if (typeof ctx.opts.probePhaseMarker === 'function') return ctx.opts.probePhaseMarker(ctx, state, ph);
  if (wf?.kind === 'none' || !marker) return { satisfied: true, outcome: 'marker_satisfied', marker, evidence: 'no evidence gate (kind none)' };
  try {
    const { probePhaseMarkerReal } = await import('./tt-storm-real.mjs');
    const res = await probePhaseMarkerReal({
      dbOpen: (p) => ctx.db?.open?.(p ?? ctx.opts?.dbPath),
      dbPath: ctx.opts?.dbPath,
      state,
      ph,
      refs: makeRefsChannel(ctx, state),
      // US-004: the product merge-event channel lives under the campaign's
      // private state root (TAMANDUA_STATE_DIR); thread it explicitly so the
      // probe never falls back to an operator path.
      stateRoot: ctx.opts?.execIdentity?.state_root ?? ctx.opts?.stateRoot ?? state?.exec_identity?.state_root ?? null,
    });
    return res; // full verdict incl. outcome (marker_satisfied | not_yet | evidence_error)
  } catch (err) {
    // Evidence probe infra failure: NOT satisfied and UNKNOWN (evidence_error),
    // never a fabricated green and never silently folded into plain not-yet.
    return { satisfied: false, outcome: 'evidence_error', marker, reason: `phase evidence probe failed: ${err?.message ?? String(err)}` };
  }
}

// dispatchPhaseAction — the engine's actual operator dispatch. The argv is
// ALWAYS the canonical actionPlan(...) output (one source of truth: what the
// real tt-chaos/tamandua/daemon-control operator would be given), and
// dispatch goes through the matching ctx.proc channel. Fail-closed
// semantics:
//   * an action whose required orchestrator-owned identity is missing
//     returns { notRun:true, reason } — the phase is recorded NOT_RUN,
//     never dispatched with an argv the operator would reject;
//   * an unknown action kind returns { notRun:true } (no silent no-op);
//   * stop_delete_relaunch performs stop -> delete -> relaunch-identical
//     do-now (spec 09 Round B T+90m); each sub-op is dispatched + recorded.
// The optional ctx.opts.dispatchPhaseAction adapter lets the recording gate
// observe the same planned argv instead of a parallel pretend scheduler.
export async function dispatchPhaseAction(ctx, state, ops, ph, phaseState, campaignDir) {
  const action = ph.action;
  const basis = {
    id: ph.id,
    marker: ph.waitFor?.marker ?? ph.waitFor?.kind,
    waitOutcome: phaseState.waitOutcome?.outcome ?? 'marker_satisfied',
    evidenceBefore: ctx.clock.nowUtc(),
  };
  // US-009 (SF-4): resolve the target's state BEFORE building or executing any
  // action. An already-terminal target is a first-class NOT_RUN — never a
  // guaranteed guard_miss, and never a spawned tt-chaos process.
  const terminal = resolvePhaseTargetsTerminal(ctx, state, action);
  if (terminal.terminal) {
    ops.record('phase.not_run_terminal', {
      id: ph.id,
      action: action.kind,
      targets: terminal.targets.map((t) => ({ rosterId: t.rosterId, runId: t.runId, status: t.status, source: t.source })),
      reason: terminal.reason,
    });
    return {
      ok: false, notRun: true, reason: terminal.reason, detail: terminal.reason,
      record: { ts: ctx.clock.nowUtc(), id: ph.id, action: action.kind, argv: [], basis, notRunReason: terminal.reason, terminal: true },
    };
  }
  const plan = actionPlan(ctx, state, action);
  if (!plan.ok) {
    return { ok: false, notRun: true, reason: plan.reason, detail: plan.reason, record: { ts: ctx.clock.nowUtc(), id: ph.id, action: action.kind, argv: [], basis, notRunReason: plan.reason } };
  }
  const rec = { ts: ctx.clock.nowUtc(), id: ph.id, action: action.kind, argv: plan.steps.map((s) => s.argv), basis };

  // Mechanical origin-main ref snapshot immediately BEFORE a colleague commit
  // or mass rugpull dispatch (landing/recovery markers need real ref
  // evidence: the tip BEFORE the dispatch, so 'cc1-landed' can later observe
  // the move). Recorded only when the snapshot actually resolved (ok:true);
  // a failed snapshot leaves the marker not_yet — fail-closed, never a
  // recorded "satisfied" from an unrelated phase.
  if ((action.kind === 'colleague_commit' || action.kind === 'mass_rugpull') && plan.steps.some((s) => s.channel === 'chaos')) {
    const snap = await snapshotOriginMain(ctx, state);
    if (snap.ok && snap.sha) {
      phaseState.refs = { ...(phaseState.refs ?? {}), originMainBefore: { sha: snap.sha, at: snap.at } };
    }
  }

  if (ctx.opts.dispatchPhaseAction) {
    const res = await ctx.opts.dispatchPhaseAction(ctx, state, action, ph, plan.steps);
    rec.outcome = res;
    if (!res.ok) {
      ops.record('phase.action_failed', { id: ph.id, action: action.kind, error: res.error ?? 'unknown' });
      return { ok: false, notRun: false, detail: res, record: rec };
    }
    return { ok: true, notRun: false, detail: res, record: rec };
  }

  // Real operator dispatch (not exercised until the rehearsal gate; the
  // recording gate drives this same code with recording ctx.proc adapters).
  try {
    const stepResults = [];
    let guardMissNotRun = null;
    for (const step of plan.steps) {
      let result;
      // FIX5 US-006: ctx.opts.spawnEnv is a plain per-call ENV MAP, while the
      // proc adapters take an options object ({ env, cwd, timeoutMs, ... }).
      // The old direct pass-through handed the env map to `call()` as the whole
      // opts object, so `opts.env` was undefined and the map was silently
      // ignored: a control-plane stop/delete/pause/resume/nudge never received
      // TAMANDUA_CONTROL_PORT, and under TAMANDUA_TEST_GUARD=1 the control
      // client then refuses every request (a stop/delete that only updates the
      // DB row and exits 0 without tearing down the daemon's scheduled harness
      // workdir — the immediate B5 relaunch then collides on that workdir).
      const spawnOpts = ctx.opts.spawnEnv ? { env: ctx.opts.spawnEnv } : {};
      if (step.channel === 'chaos') result = await ctx.proc.chaosAction(step.argv, spawnOpts);
      else if (step.channel === 'tamandua') result = await ctx.proc.tamandua(step.argv, spawnOpts);
      else if (step.channel === 'daemon') result = await ctx.proc.daemonControl(step.argv, spawnOpts);
      else if (step.channel === 'launch') {
        ops.record('phase.relaunch.intent', { id: ph.id, argv: step.argv });
        result = await ctx.proc.launchWorkflow(step.argv, {
          cwd: ctx.opts.launchCwd,
          env: { ...(ctx.opts.launchEnv ?? {}) },
          timeoutMs: ctx.opts.launchTimeoutMs ?? 0,
        });
        const evidence = extractRunEvidence(result);
        const relaunchRid = step.meta?.relaunchRosterId ?? null;
        ops.record('phase.relaunch.result', { id: ph.id, relaunchRid, exitCode: result.exitCode, evidence });
        // Register the relaunched do-now as a first-class extra run so the
        // observation loop waits for its terminal state (spec: "its relaunch
        // completes"). A runless/ambiguous relaunch is recorded first-class
        // (launch_failed/relaunch.failed) — never silently retried or
        // guessed.
        let resolvedRelaunchRunId = null;
        let relaunchResolveError = null;
        if (relaunchRid) {
          try {
            resolvedRelaunchRunId = requireUnambiguousRunId(evidence, { rosterId: relaunchRid });
          } catch (err) {
            relaunchResolveError = err;
          }
          if (resolvedRelaunchRunId) {
            try {
              ensureRunRecord(state, 'B', {
                rosterId: relaunchRid, run: step.meta?.run ?? 'storm-b5-donow', workflow: 'do-now', harness: 'pi',
                timers: 1, demand: 1, queued: false, targetBranch: 'main',
              });
              const rr = state.rounds.B.runs[relaunchRid];
              // SF-13: a non-zero relaunch is a first-class LAUNCH FAILURE,
              // never a live 'registered' run — the observation loop must not
              // wait on a relaunch that already failed (round B bounded).
              rr.status = result.exitCode === 0 ? 'registered' : 'launch_failed';
              rr.runId = resolvedRelaunchRunId;
              rr.shortId = evidence.stderrShortId ?? resolvedRelaunchRunId.slice(4, 12);
              rr.launchedAt = ctx.clock.nowUtc();
              rr.relaunchOf = action.target ?? 'B5';
              persistState(ctx, campaignDir, state);
            } catch (err) {
              relaunchResolveError = relaunchResolveError ?? err;
            }
          }
        }
        // SF-13: a failed relaunch sub-op is a BOUNDED, first-class phase
        // failure. TT_MISSING_RUN when no run identity could be resolved, else
        // TT_RELAUNCH_FAILED — the phase record carries the classification so
        // a deleted target's Round B never blocks ROUND_B_END_MS on a relaunch
        // that cannot complete. (An exit-0 launch with no unambiguous identity
        // keeps the pre-existing fail-closed classification.)
        if (result.exitCode !== 0 || relaunchResolveError) {
          const failureCode = result.exitCode !== 0
            ? (resolvedRelaunchRunId ? 'TT_RELAUNCH_FAILED' : 'TT_MISSING_RUN')
            : (relaunchResolveError?.code ?? 'TT_MISSING_RUN');
          const failureMessage = result.exitCode !== 0
            ? (resolvedRelaunchRunId
              ? `identical do-now relaunch exited ${result.exitCode} (run ${resolvedRelaunchRunId})`
              : `identical do-now relaunch exited ${result.exitCode} with no resolvable run identity${relaunchResolveError ? `: ${relaunchResolveError.message}` : ''}`)
            : relaunchResolveError.message;
          rec.relaunchFailure = { code: failureCode, message: failureMessage, bounded: true };
          ops.record('phase.relaunch.failed', { id: ph.id, relaunchRid, code: failureCode, message: failureMessage, bounded: true, evidence });
        }
      } else if (step.channel === 'none') {
        // Internal acknowledgement (no external operator call) — e.g. the
        // B-pounding phase records that the pounding cadence is active.
        result = { exitCode: 0, stdout: '', stderr: `${action.kind}: internal acknowledgement (no external call)` };
      } else {
        result = { exitCode: 1, stdout: '', stderr: `unsupported channel ${step.channel}` };
      }
      stepResults.push({ channel: step.channel, argv: step.argv, exitCode: result?.exitCode ?? null, result });
      if (step.channel !== 'launch') {
        ops.record('phase.dispatched', { id: ph.id, action: action.kind, channel: step.channel, argv: step.argv, exitCode: result?.exitCode ?? null });
      }
      // US-009 (SF-4): a guard_miss that names a terminal target is a
      // first-class NOT_RUN rather than a failed phase. Single-target actions
      // trust the named terminal verdict; multi-target actions convert only
      // when the whole action is unsatisfiable (see classifyTerminalGuardMiss).
      if (step.channel === 'chaos') {
        const named = guardMissTerminalRun(result);
        if (named) {
          const reason = classifyTerminalGuardMiss(named, ctx, state, action);
          if (reason && !guardMissNotRun) guardMissNotRun = reason;
        }
      }
    }
    if (guardMissNotRun) {
      rec.subops = stepResults;
      ops.record('phase.guard_miss_terminal', { id: ph.id, action: action.kind, reason: guardMissNotRun });
      return { ok: false, notRun: true, reason: guardMissNotRun, detail: rec, record: rec };
    }
    const ok = stepResults.every((s) => s.exitCode === 0);
    rec.subops = stepResults;
    // stop_delete_relaunch: after a clean stop+delete, the deleted run is
    // engine-terminal first-class (the product removes the run row — the
    // orchestrator records the deletion from the operator result, never from
    // a guessed DB row).
    //
    // SF-13: the canonical plan is [stop, delete, launch], so the terminal
    // verdict depends on the STOP + DELETE sub-ops ALONE. BOTH exiting 0 has
    // removed the run row; a later relaunch failure (or a relaunch that never
    // registers a run) must NOT keep the deleted target in the observation
    // loop's active set — that made Round B wait the full ROUND_B_END_MS for a
    // run that no longer exists. Current behavior when stop/delete fail is
    // preserved: no terminal verdict is fabricated.
    if (action.kind === 'stop_delete_relaunch' && action.target) {
      const subopFor = (verb) =>
        stepResults.find((s) => s.channel === 'tamandua' && Array.isArray(s.argv) && s.argv.includes(verb)) ?? null;
      const stopOp = subopFor('stop');
      const deleteOp = subopFor('delete');
      if (stopOp?.exitCode === 0 && deleteOp?.exitCode === 0) {
        const targetRec = state.rounds.B.runs[action.target];
        if (targetRec) {
          targetRec.status = 'terminal';
          targetRec.terminalStatus = 'deleted';
          targetRec.terminalAt = ctx.clock.nowUtc();
          ops.record('run.deleted', { round: 'B', rosterId: action.target, runId: targetRec.runId ?? null });
        }
      }
    }
    return { ok, notRun: false, detail: rec, record: rec };
  } catch (err) {
    ops.record('phase.action_failed', { id: ph.id, action: action.kind, error: err.message });
    return { ok: false, notRun: false, detail: { error: err.message }, record: rec };
  }
}

// actionPlan — canonical operator call sequence for one phase action. Every
// tt-chaos argv is validated against the real operator contract at build
// time via buildChaosArgv (colleague-commit requires --repo/--file;
// dirty-tree requires --repo); missing orchestrator-owned identity is a
// first-class { ok:false, reason } — never an empty-string argv.
export function actionPlan(ctx, state, action) {
  const targetOf = (rosterId) => targetRunId(ctx, state, rosterId);
  switch (action.kind) {
    case 'read_path_pounding': {
      // Real pounding runs on the engine's cadence once enabled (Round B
      // start); this phase records that it is active. When pounding is
      // NOT_RUN (no config), the phase is NOT_RUN too — never a no-op.
      const p = state.rounds.B.pounding ?? null;
      if (!p?.active) {
        return { ok: false, reason: p?.notRunReason ?? 'pounding not enabled (no ctx.opts.pounding config / transport adapters)' };
      }
      return { ok: true, steps: [{ channel: 'none', argv: ['pounding', 'active', `cadence=${p.cadenceMs}ms`] }] };
    }
    case 'colleague_commit': {
      const runId = targetOf(action.target ?? 'B1');
      const built = buildChaosArgv(ctx, state, action, runId);
      if (!built.ok) return { ok: false, reason: built.reason };
      return { ok: true, steps: [{ channel: 'chaos', argv: built.argv }] };
    }
    case 'kill_harness': {
      const runId = targetOf(action.target);
      const built = buildChaosArgv(ctx, state, action, runId);
      if (!built.ok) return { ok: false, reason: built.reason };
      return { ok: true, steps: [{ channel: 'chaos', argv: built.argv }] };
    }
    case 'pause': return { ok: true, steps: [{ channel: 'tamandua', argv: ['tamandua', 'workflow', 'pause', targetOf(action.target)] }] };
    case 'resume': return { ok: true, steps: [{ channel: 'tamandua', argv: ['tamandua', 'workflow', 'resume', targetOf(action.target)] }] };
    case 'nudge_storm': {
      const steps = [];
      for (let i = 0; i < (action.count ?? 20); i += 1) steps.push({ channel: 'tamandua', argv: ['tamandua', 'nudge'] });
      return { ok: true, steps };
    }
    case 'dirty_tree_park': {
      // SF-15 (US-006): one dirty-tree action against the owned origin
      // checkout that B1..B4 share as their merge target. The --run id only
      // gates the tt-chaos operator; B4 is the representative live target.
      const runId = targetOf('B4');
      const built = buildChaosArgv(ctx, state, { kind: 'dirty_tree_park' }, runId);
      if (!built.ok) return { ok: false, reason: built.reason };
      return { ok: true, steps: [{ channel: 'chaos', argv: built.argv }] };
    }
    case 'stop_delete_relaunch': {
      const rid = targetOf(action.target);
      const steps = [
        { channel: 'tamandua', argv: ['tamandua', 'workflow', 'stop', rid] },
        { channel: 'tamandua', argv: ['tamandua', 'workflow', 'delete', rid] },
      ];
      // Relaunch an IDENTICAL do-now (same workflow/harness; fresh run id).
      // The argv is the same the orchestrator would use for a fresh do-now
      // launch, with an orchestrator-owned roster identity for tracking.
      // SF-12 (fix-6): the relaunch resolves its task file from the SAME
      // campaign source as the primary launches. `rosterId` stays
      // 'B5-relaunch' for lineage/tracking, while `taskFileRosterId: 'B5'`
      // points the fail-closed resolver at the campaign's absolute B5 task
      // file (the declared-identical task) instead of a bare relative name.
      const relaunchLaunch = {
        round: 'B', rosterId: 'B5-relaunch', taskFileRosterId: action.target,
        run: action.relaunchRun ?? 'storm-b5-donow',
        workflow: 'do-now', harness: 'pi', timers: 1, demand: 1, queued: false,
        targetBranch: 'main', workspaceMode: 'direct',
        context: [], taskArea: 'do-now agitator',
      };
      const argv = launchArgvFor(relaunchLaunch, ctx);
      steps.push({ channel: 'launch', argv, meta: { relaunchRosterId: 'B5-relaunch', run: relaunchLaunch.run } });
      return { ok: true, steps };
    }
    case 'mass_rugpull': {
      // One colleague commit moves main's tip; every merge run (B1..B4)
      // observes the rugpull independently. Identity same as colleague cc1.
      const runId = targetOf('B1');
      const built = buildChaosArgv(ctx, state, { kind: 'mass_rugpull' }, runId);
      if (!built.ok) return { ok: false, reason: built.reason };
      return { ok: true, steps: [{ channel: 'chaos', argv: built.argv }] };
    }
    case 'daemon_bounce': return { ok: true, steps: [{ channel: 'daemon', argv: ['daemon-control', ctx.opts.daemonKind ?? 'real', 'restart'] }] };
    default:
      return { ok: false, reason: `unsupported phase action kind '${action.kind}' — recorded NOT_RUN, never a silent no-op` };
  }
}

function targetRunId(ctx, state, rosterId) {
  for (const round of ['A', 'B']) {
    const rec = state.rounds[round].runs[rosterId];
    if (rec?.runId) return rec.runId;
  }
  return `run-${rosterId}-unresolved`;
}

// ─────────────────────────────────────────────────────────────────────
// US-009 (SF-4): terminal-target classification for chaos phases.
// A phase action whose target run is already terminal can never fire: the
// tt-chaos guard refuses every destructive action against a terminal run
// (exit 3 GUARD_MISS) and the tamandua stop/delete/pause verbs are
// meaningless afterwards. The engine resolves the target's state BEFORE
// dispatch (state record + campaign DB row) and records the phase NOT_RUN
// with the terminal run named — never dispatches a guaranteed guard_miss,
// and never spawns a tt-chaos process for a structurally impossible action.
// A guard_miss that still slipped through (the operator itself named a
// terminal target) is likewise reclassified NOT_RUN; every other failure
// keeps its fire/fail semantics.
// ─────────────────────────────────────────────────────────────────────

const EXIT_GUARD_MISS = 3;

// Run-record statuses that are terminal-for-dispatch: no chaos action or
// workflow verb can produce new evidence for them. (The DB row vocabulary is
// TERMINAL_RUN_STATUSES; these are the engine's own record states.)
const TERMINAL_DISPATCH_STATES = new Set([
  'terminal', 'launch_failed', 'unknown_run', 'drain_bound_exceeded', 'aborted', 'stopped', 'deleted',
]);

// The roster ids a phase action targets. dirty_tree_park dirties the SHARED
// merge target (the owned origin checkout) that every live merge run B1..B4
// merges into, so it structurally targets all four; mass_rugpull lists one
// roster id per run it contends with. Control-only actions
// (pounding/nudge/daemon bounce) target no run.
export function phaseTargetRosterIds(action) {
  if (!action || typeof action !== 'object') return [];
  if (Array.isArray(action.targets) && action.targets.length > 0) return [...action.targets];
  if (Array.isArray(action.target) && action.target.length > 0) return [...action.target];
  if (typeof action.target === 'string' && action.target) return [action.target];
  if (action.kind === 'dirty_tree_park') return [...B_MERGE_TARGET_IDS];
  return [];
}

// Resolve one roster id's terminal-for-dispatch state. `run row/state says
// terminal` both count: the state record is enriched by the observation loop,
// but during phase dispatch the DB row is the authoritative live source (the
// B runs are only 'registered' in state until the post-phase observation loop
// harvests them). Never throws.
export function resolveRosterTerminal(ctx, state, rosterId) {
  let rec = null;
  for (const round of ['A', 'B']) {
    const candidate = state?.rounds?.[round]?.runs?.[rosterId];
    if (candidate && typeof candidate === 'object') { rec = candidate; break; }
  }
  if (!rec) return { rosterId, terminal: false, runId: null, status: null, source: null, reason: null };
  const runId = typeof rec.runId === 'string' && rec.runId ? rec.runId : null;
  if (TERMINAL_DISPATCH_STATES.has(rec.status)) {
    const status = rec.terminalStatus ?? rec.status;
    return {
      rosterId, terminal: true, runId, status, source: 'state',
      reason: `target run ${rosterId}${runId ? ` (${runId})` : ''} is terminal (${status})`,
    };
  }
  if (runId) {
    const opened = safeOpen(ctx);
    if (opened) {
      try {
        const row = opened.api.getRun(runId);
        if (row && TERMINAL_RUN_STATUSES.includes(row.status)) {
          return {
            rosterId, terminal: true, runId, status: row.status, source: 'db',
            reason: `target run ${rosterId} (${runId}) is terminal (${row.status})`,
          };
        }
      } finally {
        try { opened.api.close(); } catch { /* ignore */ }
      }
    }
  }
  return { rosterId, terminal: false, runId, status: rec.status ?? null, source: null, reason: null };
}

// Phase-level verdict: EVERY targeted run must be terminal for the action to
// be structurally impossible; one live target keeps the current semantics.
export function resolvePhaseTargetsTerminal(ctx, state, action) {
  const rosterIds = phaseTargetRosterIds(action);
  if (rosterIds.length === 0) return { terminal: false, targets: [], reason: null };
  const targets = rosterIds.map((rid) => resolveRosterTerminal(ctx, state, rid));
  if (targets.every((t) => t.terminal)) {
    return { terminal: true, targets, reason: targets.map((t) => t.reason).join('; ') };
  }
  return { terminal: false, targets, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// US-010 (SF-5): structural satisfiability of a phase WAIT predicate.
// A phase's `waitFor` describes what evidence must be observed before the
// action may fire. When that predicate is tied to specific run(s) — declared
// on the waitFor (`target`/`targets`) or, failing that, the action's own
// target — and EVERY one of them is already terminal, the predicate can never
// materialize again. Waiting the full phase bound for it is the attempt-3
// SF-5 waste (nine Round B phases x 180s in the terminal state). The engine
// resolves the targets up front and returns `run_terminal` after a single
// probe; a marker that is ALREADY satisfied still wins, and an UNKNOWN /
// evidence_error probe is never folded into this verdict.
// ─────────────────────────────────────────────────────────────────────

// The roster ids a phase WAIT predicate structurally depends on. Prefer the
// predicate's own declared target(s); when the predicate is implicit, the
// action target(s) are the concrete run(s) whose terminality makes the phase
// moot. Control-only actions with no predicate target return [] (nothing to
// short-circuit on).
export function phaseWaitTargetRosterIds(ph) {
  const wf = ph?.waitFor ?? {};
  const declared = [];
  if (Array.isArray(wf.targets)) declared.push(...wf.targets.filter(Boolean));
  if (Array.isArray(wf.target)) declared.push(...wf.target.filter(Boolean));
  else if (typeof wf.target === 'string' && wf.target) declared.push(wf.target);
  if (declared.length > 0) return [...new Set(declared)];
  return phaseTargetRosterIds(ph?.action);
}

// Resolve the phase predicate's dependency set. Terminal only when the set is
// non-empty and EVERY member is terminal (one live dependency keeps the wait).
export function resolvePhaseWaitTargetsTerminal(ctx, state, ph) {
  const rosterIds = phaseWaitTargetRosterIds(ph);
  if (rosterIds.length === 0) return { terminal: false, targets: [], reason: null };
  const targets = rosterIds.map((rid) => resolveRosterTerminal(ctx, state, rid));
  if (targets.every((t) => t.terminal)) {
    const marker = ph?.waitFor?.marker ?? ph?.waitFor?.kind ?? 'phase';
    return {
      terminal: true,
      targets,
      reason: `phase predicate '${marker}' can no longer be satisfied: ${targets.map((t) => t.reason).join('; ')}`,
    };
  }
  return { terminal: false, targets, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// US-008 (STORM-REHEARSAL-FIX4): the DERIVED hold evidence predicate.
//
// The SCRIPTED_REHEARSAL's derived phases carry `waitFor:{kind:'hold',
// marker:'hold-confirmed', targets:[rosterIds]}`. A phase may fire only while
// its targets are genuinely parked on the campaign checkpoint, so this
// predicate is satisfied ONLY when EVERY target run (phaseWaitTargetRosterIds)
// has a confirmed hold file AND is still non-terminal. A target whose runtime
// wrote `<runId>.missed` (its bounded hold timeout elapsed) makes the verdict
// `hold_missed` — terminal for the phase, with the runtime's reason. A target
// that is already terminal is likewise not a live hold (the caller's
// run_terminal short-circuit handles that case). A zero-target control-only
// phase is vacuously satisfied (B-pounding has no roster target).
//
// Read-only over ctx.fs; never throws.
// ─────────────────────────────────────────────────────────────────────
export function holdPredicateVerdict(ctx, state, ph) {
  const wf = ph?.waitFor ?? {};
  const marker = wf.marker ?? wf.kind ?? 'hold-confirmed';
  const targets = phaseWaitTargetRosterIds(ph).map((rid) => {
    const term = resolveRosterTerminal(ctx, state, rid);
    const conf = term.runId
      ? holdConfirmation(ctx, state, term.runId)
      : { confirmed: false, missed: false, missedReason: null };
    return {
      rosterId: rid,
      runId: term.runId ?? null,
      terminal: term.terminal === true,
      status: term.status ?? null,
      confirmed: conf.confirmed === true,
      missed: conf.missed === true,
      missedReason: conf.missedReason ?? null,
    };
  });

  if (targets.length === 0) {
    return { satisfied: true, outcome: 'marker_satisfied', marker, targets, evidence: 'no hold targets (control-only phase)' };
  }

  const missed = targets.find((t) => t.missed);
  if (missed) {
    return {
      satisfied: false,
      outcome: 'hold_missed',
      marker,
      targets,
      reason: `hold not confirmed for ${missed.rosterId}${missed.runId ? ` (${missed.runId})` : ''}: runtime reported a missed hold${missed.missedReason ? ` (${missed.missedReason})` : ''}`,
    };
  }

  const pending = targets.filter((t) => !t.confirmed || t.terminal);
  if (pending.length === 0) {
    return {
      satisfied: true,
      outcome: 'marker_satisfied',
      marker,
      targets,
      evidence: `holds confirmed for ${targets.map((t) => t.rosterId).join(',')}`,
    };
  }
  return {
    satisfied: false,
    outcome: 'not_yet',
    marker,
    targets,
    evidence: `awaiting live held targets: ${pending.map((t) => `${t.rosterId}${t.terminal ? '(terminal)' : '(no confirmed hold)'}`).join(', ')}`,
  };
}


// operator prints `GUARD_MISS: Run <run-id> is terminal (<status>) — refusing
// to fire` (tt-chaos guardFire). Anything else (exit 1, a non-terminal
// guard_miss) is a genuine dispatch failure and stays one.
export function guardMissTerminalRun(result) {
  if (!result || result.exitCode !== EXIT_GUARD_MISS) return null;
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const m = text.match(/Run\s+(\S+)\s+is terminal \(([^)]+)\)/);
  if (!m) return null;
  return { runId: m[1], status: m[2] };
}

// Decide whether a parsed guard_miss should reclassify the phase NOT_RUN.
// A single-target action trusts the guard's terminal verdict directly (after
// confirming the named run IS the phase target); a multi-target action only
// converts when the WHOLE action has become unsatisfiable — one live target
// must never have its rugpull swallowed as not_run.
export function classifyTerminalGuardMiss(named, ctx, state, action) {
  const rosterIds = phaseTargetRosterIds(action);
  if (rosterIds.length === 0) return null;
  const bare = (v) => (typeof v === 'string' ? v.replace(/^run-/, '') : v);
  if (rosterIds.length === 1) {
    const expected = targetRunId(ctx, state, rosterIds[0]);
    if (bare(named.runId) !== bare(expected)) return null;
    return `target run ${rosterIds[0]} (${named.runId}) is terminal (${named.status})`;
  }
  const re = resolvePhaseTargetsTerminal(ctx, state, action);
  return re.terminal ? re.reason : null;
}

// ─────────────────────────────────────────────────────────────────────
// Read-path pounding (spec 09: dashboard HTTP + 2 MCP tool calls every 30s;
// assert no 5xx and first-byte latency < 2s). This is a REAL engine
// activity driven through the injected proc adapters (ctx.proc.httpGet /
// ctx.proc.mcpTool) on a cadence the engine owns; it is not a no-op phase
// status. Round A runs pounding from round start (it is the round's sole
// background load); Round B continues it (B-pounding phase at offset 0
// verifies/records it). When the campaign has no pounding config
// (ctx.opts.pounding = { dashboardUrl, mcpToolNames, cadenceMs,
// latencyBoundMs }), pounding is first-class NOT_RUN with the missing
// reason named — never silently green.
// ─────────────────────────────────────────────────────────────────────
export function poundingConfig(ctx) {
  const cfg = ctx.opts?.pounding ?? null;
  if (!cfg) return null;
  return {
    cadenceMs: cfg.cadenceMs ?? POUND_INTERVAL_MS,
    latencyBoundMs: cfg.latencyBoundMs ?? POUND_LATENCY_BOUND_MS,
    dashboardUrl: cfg.dashboardUrl ?? null,
    mcpToolNames: Array.isArray(cfg.mcpToolNames) ? cfg.mcpToolNames : [],
    // Optional per-tool arguments (object keyed by tool name). The real product
    // read tools validate their input schema, so pounding must pass genuine
    // arguments (e.g. tamandua.run.status requires a non-empty `query`).
    mcpToolArgs: cfg.mcpToolArgs && typeof cfg.mcpToolArgs === 'object' ? cfg.mcpToolArgs : {},
    // US-002: the private daemon's streamable-HTTP MCP endpoint (bind0-allocated
    // at rehearsal); carries through to the transport adapter so reads hit the
    // contained daemon, never a default/operator endpoint.
    mcpEndpoint: cfg.mcpEndpoint ?? null,
  };
}

// Default per-tool arguments for the READ-ONLY pounding tools. The product's
// registered read tools validate their inputs (`tamandua.run.status` requires
// a non-empty `query`), so a bare tools/call would be a genuine RPC error.
// `tamandua.runs.list` needs none; `tamandua.run.status` queries a run that
// the round already recorded in state. When no run id is recorded yet the call
// is SKIPPED (returns null) rather than issued as a fabricated call/failure.
export function defaultPoundingMcpArgs(tool, state, round) {
  if (tool === 'tamandua.runs.list') return { limit: 10 };
  if (tool === 'tamandua.run.status') {
    const buckets = [state?.rounds?.[round]?.runs, state?.rounds?.A?.runs, state?.rounds?.B?.runs];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const runId = Object.values(bucket).map((r) => r?.runId).find((v) => typeof v === 'string' && v.length > 0);
      if (runId) return { query: runId };
    }
    return null;
  }
  return {};
}

export function ensurePoundingState(state, round) {
  if (!state.rounds[round].pounding) {
    state.rounds[round].pounding = {
      active: false,
      notRunReason: null,
      cadenceMs: POUND_INTERVAL_MS,
      latencyBoundMs: POUND_LATENCY_BOUND_MS,
      lastPoundMs: null,
      rounds: 0,
      probes: 0,
      assertionFailures: 0,
      maxLatencyMs: 0,
    };
  }
  return state.rounds[round].pounding;
}

// Enable pounding for a round. Returns { ok, reason }. When the config or
// the transport adapters are absent this is a first-class NOT_RUN — the
// caller must never pretend pounding ran.
export function enablePounding(ctx, state, round) {
  const cfg = poundingConfig(ctx);
  const p = ensurePoundingState(state, round);
  if (!cfg) {
    p.active = false;
    p.notRunReason = 'no ctx.opts.pounding config (dashboardUrl + mcpToolNames); real rehearsal gate wires the contained daemon endpoints';
    return { ok: false, reason: p.notRunReason };
  }
  if (typeof ctx.proc?.httpGet !== 'function' || typeof ctx.proc?.mcpTool !== 'function') {
    p.active = false;
    p.notRunReason = 'pounding transport adapters (ctx.proc.httpGet / ctx.proc.mcpTool) not injected';
    return { ok: false, reason: p.notRunReason };
  }
  p.active = true;
  p.notRunReason = null;
  p.cadenceMs = cfg.cadenceMs;
  p.latencyBoundMs = cfg.latencyBoundMs;
  p.dashboardUrl = cfg.dashboardUrl;
  p.mcpToolNames = cfg.mcpToolNames;
  p.lastPoundMs = ctx.clock.nowMs(); // first tick fires immediately on enable
  return { ok: true, reason: null };
}

// One pounding round: dashboard HTTP GET + (up to) two MCP tool calls
// through the injected adapters. Every probe records latency + status;
// assertion failures (5xx or latency > bound) are counted and recorded,
// never normalized.
export async function poundOnce(ctx, state, round, ops = null) {
  const cfg = poundingConfig(ctx);
  const p = ensurePoundingState(state, round);
  if (!cfg || !p.active) return { fired: false, probes: [], failures: 0 };
  const now = ctx.clock.nowMs();
  const probes = [];
  let failures = 0;
  // dashboard HTTP GET
  if (cfg.dashboardUrl && typeof ctx.proc?.httpGet === 'function') {
    let res;
    try {
      res = await ctx.proc.httpGet(cfg.dashboardUrl);
    } catch (err) {
      res = { ok: false, error: String(err?.message ?? err) };
    }
    const latencyMs = typeof res?.latencyMs === 'number' ? res.latencyMs : null;
    const statusOk = res?.ok === true || (typeof res?.statusCode === 'number' && res.statusCode < 500);
    const latencyOk = latencyMs == null || latencyMs <= p.latencyBoundMs;
    const ok = statusOk && latencyOk;
    if (!ok) failures += 1;
    probes.push({
      kind: 'dashboard_http',
      target: cfg.dashboardUrl,
      statusCode: res?.statusCode ?? null,
      latencyMs,
      ok,
      error: res?.error ?? null,
    });
  }
  // up to 2 MCP tool calls
  const tools = cfg.mcpToolNames.slice(0, 2);
  for (const tool of tools) {
    if (typeof ctx.proc?.mcpTool !== 'function') break;
    // Genuine arguments: an explicit campaign override wins, otherwise the
    // engine derives schema-valid defaults (null => skip this probe: no
    // argument is available, so no call is fabricated).
    const args = cfg.mcpToolArgs?.[tool] ?? defaultPoundingMcpArgs(tool, state, round);
    if (args === null) continue;
    let res;
    try {
      // US-002: when the pounding config owns a streamable-HTTP MCP endpoint
      // (the private daemon's bind0-allocated MCP URL), pass it through so the
      // real transport adapter targets THIS daemon — never a fixed/default
      // endpoint and never operator state.
      res = await ctx.proc.mcpTool(cfg.mcpEndpoint ? { tool, args, endpointUrl: cfg.mcpEndpoint } : { tool, args });
    } catch (err) {
      res = { ok: false, error: String(err?.message ?? err) };
    }
    const latencyMs = typeof res?.latencyMs === 'number' ? res.latencyMs : null;
    const statusOk = res?.ok === true;
    const latencyOk = latencyMs == null || latencyMs <= p.latencyBoundMs;
    const ok = statusOk && latencyOk;
    if (!ok) failures += 1;
    probes.push({
      kind: 'mcp_tool',
      target: tool,
      statusCode: res?.statusCode ?? null,
      latencyMs,
      ok,
      error: res?.error ?? null,
    });
  }
  for (const probe of probes) {
    p.probes += 1;
    if (typeof probe.latencyMs === 'number') p.maxLatencyMs = Math.max(p.maxLatencyMs, probe.latencyMs);
  }
  p.assertionFailures += failures;
  p.lastPoundMs = now;
  return { fired: probes.length > 0, probes, failures };
}

// Cadence tick: fire a pounding round only when POUND_INTERVAL has elapsed
// since the last one. Used from time-advancing loops (observation, phase
// waits, launch staggers) so pounding genuinely continues through a round.
export async function poundIfDue(ctx, state, round, ops = null) {
  const p = ensurePoundingState(state, round);
  const cfg = poundingConfig(ctx);
  if (!cfg || !p.active) return { fired: false };
  const now = ctx.clock.nowMs();
  const cadence = p.cadenceMs ?? POUND_INTERVAL_MS;
  if (p.lastPoundMs != null && now - p.lastPoundMs < cadence) return { fired: false };
  const res = await poundOnce(ctx, state, round, ops);
  p.rounds += 1; // one completed pounding round
  if (res.fired && ops) {
    ops.record('pounding.round', { round, atMs: now, probes: res.probes, failures: res.failures });
  }
  return { fired: res.fired, ...res };
}

// Pound-aware wait: advance the clock to atMs in <= cadence slices, firing
// pounding ticks in between when the round has pounding active. When pounding
// is not active this is exactly the plain waitUntil.
export async function waitWithPounding(ctx, state, round, atMs, reason, ops = null) {
  const p = ensurePoundingState(state, round);
  for (;;) {
    const now = ctx.clock.nowMs();
    if (now >= atMs) break;
    const step = atMs - now;
    if (p.active) {
      const cadence = p.cadenceMs ?? POUND_INTERVAL_MS;
      const slice = Math.min(step, cadence);
      await ctx.clock.sleep(slice, `${reason} (pounding slice)`);
      await poundIfDue(ctx, state, round, ops);
    } else {
      await ctx.clock.sleep(step, reason);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Resume / reattach: reload state; registered-but-not-terminal runs are
// re-attached by their captured run id — never relaunched.
// ─────────────────────────────────────────────────────────────────────

export async function stormResume(ctx, { round } = {}) {
  const campaignDir = ctx.campaignDir;
  const ops = opRecorder({ fs: ctx.fs, campaignDir });
  const stateRes = loadState({ fs: ctx.fs, campaignDir });
  if (!stateRes.ok) throw refusal(`cannot resume: ${stateRes.error}`, 'TT_STATE');
  const state = stateRes.state;
  state.mode = 'resumed';
  ops.record('resume.start', { campaignId: state.campaign_id, round: round ?? 'any' });

  const roundsToScan = round ? [round] : ['A', 'B'];
  let reattached = 0;
  for (const r of roundsToScan) {
    for (const rec of Object.values(state.rounds[r].runs)) {
      if (!rec.runId) continue;
      if (rec.status === 'terminal' || rec.status === 'registered') {
        // re-verify against the DB (the DB row is the fallback harvest path)
        const opened = safeOpen(ctx);
        if (opened) {
          try {
            const row = opened.api.getRun(rec.runId);
            if (row) {
              if (TERMINAL_RUN_STATUSES.includes(row.status)) {
                rec.status = 'terminal';
                rec.terminalStatus = row.status;
                rec.terminalAt = ctx.clock.nowUtc();
                rec.tokens = row.tokens_spent ?? null;
              } else {
                rec.status = 'registered'; // still live — reattach (wait)
              }
              reattached += 1;
              ops.record('resume.reattached', { round: r, rosterId: rec.rosterId, runId: rec.runId, status: row.status });
            } else {
              // The run row vanished from the DB: that is UNKNOWN evidence,
              // never silently treated as a completed run.
              rec.status = 'unknown_run';
              ops.record('resume.unknown_run', { round: r, rosterId: rec.rosterId, runId: rec.runId, reason: 'run row missing from campaign DB on resume' });
            }
          } finally {
            try { opened.api.close(); } catch { /* ignore */ }
          }
        }
      }
    }
  }
  state.updated_at = ctx.clock.nowUtc();
  saveState({ fs: ctx.fs, campaignDir, state });
  ops.record('resume.done', { campaignId: state.campaign_id, reattached });
  return { campaignId: state.campaign_id, state, reattached };
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup ledger + failure propagation.
// ─────────────────────────────────────────────────────────────────────

// cleanupOwned — each owned-cleanup phase is recorded; if one fails, the
// failure PROPAGATES: the function returns {ok:false, failed, ledger} and
// the caller must not proceed to report finalization.
export function cleanupOwned(ctx, state, phases) {
  const ledger = state.cleanup.ledger;
  for (const ph of phases) {
    const entry = { phase: ph, at: ctx.clock.nowUtc(), ok: false, error: null };
    try {
      const fn = ctx.opts.cleanupHandlers?.[ph];
      if (typeof fn === 'function') {
        const res = fn(ctx, state);
        entry.ok = res !== false;
        entry.error = entry.ok ? null : 'cleanup handler returned false';
      } else {
        entry.ok = true; // nothing owned for this phase in this environment
        entry.note = 'no owned resource in this environment';
      }
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
    }
    ledger.push(entry);
  }
  const failed = ledger.filter((e) => !e.ok);
  return { ok: failed.length === 0, failed, ledger };
}

// ─────────────────────────────────────────────────────────────────────
// Rehearsal run driver (US-002): connect a US-001 prepared campaign to the
// REAL round drivers + transports. This is the run-side complement of the
// prepare-side rehearsal provisioning: it applies the prepared state overlay
// (task files / fixture identity / worktree root / daemon kind), ensures the
// ONE private daemon (rehearsal-gate-only, via ctx.opts.rehearsalRun), wires
// read-path pounding to the daemon's bind0 endpoints, re-attaches recorded
// runs (never relaunches) and then runs the requested round(s) through the
// same stormRunRoundA/stormRunRoundB drivers the whole engine uses.
//
// Test posture (STORM-REHEARSAL story US-002): BEFORE coordinator approval
// only dependency-injected recording/benign-child tests may drive this —
// ctx.proc.daemonControl is a recording adapter, no daemon/harness/chaos is
// ever spawned. The real daemon lifecycle runs only inside the approved
// SCRIPTED_REHEARSAL (ctx.opts.rehearsalRun === true from the CLI).
// ─────────────────────────────────────────────────────────────────────
export async function stormRunRehearsal(ctx, { round = null } = {}) {
  const campaignDir = ctx.campaignDir;
  const ops = opRecorder({ fs: ctx.fs, campaignDir });
  const stateRes = loadState({ fs: ctx.fs, campaignDir });
  if (!stateRes.ok) throw refusal(`cannot run rehearsal: ${stateRes.error}`, 'TT_STATE');
  const state = stateRes.state;
  const wantRound = round ? String(round).toUpperCase() : null;
  if (wantRound && !['A', 'B'].includes(wantRound)) {
    throw refusal(`rehearsal round must be A|B (got ${JSON.stringify(round)})`, 'TT_USAGE');
  }
  ops.record('rehearsal.run.start', { campaignId: state.campaign_id, round: wantRound ?? 'both', mode: state.mode });

  // US-002: apply the prepared-campaign overlay so the round drivers consume
  // the ACTUAL prepared inputs (per-run task files from the seeded manifest,
  // fixture identity, owned repos, worktree root) instead of a CLI re-derivation.
  let overlay = null;
  if (state.rehearsal && typeof ctx.opts.rehearsalRun === 'boolean') {
    const { rehearsalRunOptsFromState } = await import('./tt-storm-rehearsal.mjs');
    const ov = rehearsalRunOptsFromState(state);
    if (ov.ok) {
      overlay = ov.opts;
      ctx.opts = { ...ctx.opts, ...overlay };
      ops.record('rehearsal.overlay', { campaignId: state.campaign_id, taskFiles: Object.keys(ov.opts.taskFiles ?? {}).length, daemonKind: ov.opts.daemonKind });
    }
  }

  // ONE private daemon (rehearsal-gate-only). Start-or-reattach records the
  // daemon-control provenance (pid + process-start identity + ports) into
  // state.daemon; pounding is then wired to ITS bind0 dashboard/MCP endpoints.
  let daemon = null;
  if (ctx.opts?.rehearsalRun === true) {
    const {
      ensureRehearsalDaemon,
      REHEARSAL_MCP_TOOLS,
      REHEARSAL_MCP_TOOL_ARGS,
      REHEARSAL_POUND_INTERVAL_MS,
      REHEARSAL_POUND_LATENCY_BOUND_MS,
    } = await import('./tt-storm-rehearsal.mjs');
    daemon = await ensureRehearsalDaemon(ctx, state, ops);
    if (!daemon.ok) throw refusal(daemon.reason, daemon.code ?? 'TT_REHEARSAL_DAEMON');
    state.daemon = daemon.daemon;
    persistState(ctx, campaignDir, state);
    const ports = state.daemon?.evidence?.ports;
    if (Array.isArray(ports) && ports.length >= 3 && !ctx.opts.pounding) {
      ctx.opts.pounding = {
        dashboardUrl: `http://127.0.0.1:${ports[0]}/`,
        // US-003: the product's REAL registered read tools (never the
        // unregistered short names that produced RPC 'unknown tool' errors).
        mcpToolNames: [...REHEARSAL_MCP_TOOLS],
        mcpToolArgs: { ...REHEARSAL_MCP_TOOL_ARGS },
        mcpEndpoint: `http://127.0.0.1:${ports[1]}/mcp`,
        cadenceMs: REHEARSAL_POUND_INTERVAL_MS,
        latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS,
      };
      ops.record('rehearsal.pounding.wired', { campaignId: state.campaign_id, dashboardPort: ports[0], mcpPort: ports[1] });
    }
  }

  // Re-attach recorded runs by captured id (never relaunch), then run the
  // requested round(s) through the engine's REAL round drivers. The round
  // drivers persist their own state; reload before returning so the caller's
  // state reflects the actual round outcomes (never a stale pre-round copy).
  if (wantRound === 'A' || wantRound === null) {
    if (state.rounds.A.status !== 'round_done') {
      await stormResume(ctx, { round: 'A' });
      await stormRunRoundA(ctx);
    } else {
      ops.record('rehearsal.round.skipped', { round: 'A', reason: 'already round_done' });
    }
  }
  if (wantRound === 'B' || wantRound === null) {
    if (state.rounds.B.status !== 'round_done') {
      await stormResume(ctx, { round: 'B' });
      await stormRunRoundB(ctx);
    } else {
      ops.record('rehearsal.round.skipped', { round: 'B', reason: 'already round_done' });
    }
  }
  const finalRes = loadState({ fs: ctx.fs, campaignDir });
  if (!finalRes.ok) throw refusal(`cannot reload campaign state after rehearsal rounds: ${finalRes.error}`, 'TT_STATE');
  ops.record('rehearsal.run.done', { campaignId: state.campaign_id, round: wantRound ?? 'both' });
  return { campaignId: finalRes.state.campaign_id, state: finalRes.state, daemon: finalRes.state.daemon ?? null };
}

// ─────────────────────────────────────────────────────────────────────
// Forensic report (results/<campaign>/report.json + report.txt)
// ─────────────────────────────────────────────────────────────────────

// STORM-REAL US-007: the last spend snapshot an observation tick wrote, or an
// honest UNKNOWN when no tick has run yet. Reading the artifact (rather than
// re-opening the DB) makes the report reflect the same figure the operator can
// inspect in results/spend.json. Never a fabricated 0.
export function readCampaignSpendArtifact(ctx, campaignDir) {
  const dir = campaignDir ?? ctx?.campaignDir ?? null;
  let snapshot = null;
  try {
    snapshot = readSpendSnapshot({ fs: ctx?.fs, campaignDir: dir });
  } catch {
    snapshot = null;
  }
  if (snapshot && typeof snapshot === 'object') return snapshot;
  return unknownSpendSnapshot({
    reason: dir ? 'results/spend.json has not been written by an observation tick yet' : 'campaign dir not set',
  });
}

// STORM-REAL US-007: the roster that RAN — the persisted roster identity (full
// by default; a capacity-scaled id when the campaign records one, US-008) plus
// the ACTUAL run records the campaign produced, so the headline is grounded in
// what happened rather than only what was planned. Pure.
export function rosterSummaryForReport(state) {
  const identity = rosterIdentityFromState(state);
  const entries = [];
  let launched = 0;
  let terminal = 0;
  for (const round of ['A', 'B']) {
    const runs = state?.rounds?.[round]?.runs ?? {};
    for (const rosterId of Object.keys(runs)) {
      const rec = runs[rosterId];
      if (!rec || typeof rec !== 'object') continue;
      if (rec.runId) launched += 1;
      if (rec.terminalStatus) terminal += 1;
      entries.push({
        round,
        rosterId,
        workflow: rec.workflow ?? null,
        harness: rec.harness ?? null,
        runId: rec.runId ?? null,
        status: rec.terminalStatus ?? rec.status ?? null,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.round !== b.round) return a.round < b.round ? -1 : 1;
    return a.rosterId < b.rosterId ? -1 : a.rosterId > b.rosterId ? 1 : 0;
  });
  return {
    id: identity.id,
    label: identity.label,
    scale: identity.scale,
    full: identity.full,
    planned_runs: Array.isArray(state?.plan?.launches) ? state.plan.launches.length : null,
    launched_runs: launched,
    terminal_runs: terminal,
    entries,
  };
}

// buildStormReport(ctx, state, { campaignDir, spend }) — the optional `spend`
// snapshot is the very read an abort crossed the cap on, so the aborted report
// carries the honest crossing figure instead of a stale artifact.
export function buildStormReport(ctx, state, { campaignDir = null, spend = null } = {}) {
  const report = {
    campaign_id: state.campaign_id,
    generated_at: ctx.clock.nowUtc(),
    source: state.source,
    qualification: state.qualification,
    spend: buildSpendHeadline(spend ?? readCampaignSpendArtifact(ctx, campaignDir)),
    roster: rosterSummaryForReport(state),
    simultaneity: simultaneityVerdict(state),
    queue: queueVerdict(state),
    rounds: {},
    cleanup: { failed: state.cleanup.ledger.filter((e) => !e.ok) },
    states: { red: [], missing: [], not_run: [], inconclusive: [] },
  };
  for (const r of ['A', 'B']) {
    const runs = Object.values(state.rounds[r].runs ?? {});
    report.rounds[r] = {
      status: state.rounds[r].status,
      pounding: state.rounds[r].pounding
        ? {
            active: state.rounds[r].pounding.active,
            notRunReason: state.rounds[r].pounding.notRunReason ?? null,
            cadenceMs: state.rounds[r].pounding.cadenceMs,
            latencyBoundMs: state.rounds[r].pounding.latencyBoundMs,
            rounds: state.rounds[r].pounding.rounds,
            probes: state.rounds[r].pounding.probes,
            assertionFailures: state.rounds[r].pounding.assertionFailures,
            maxLatencyMs: state.rounds[r].pounding.maxLatencyMs,
          }
        : { active: false, notRunReason: 'pounding state not initialized', rounds: 0, probes: 0, assertionFailures: 0 },
      runs: runs.map((rec) => ({
        rosterId: rec.rosterId,
        run: rec.run,
        workflow: rec.workflow,
        harness: rec.harness,
        runId: rec.runId ?? null,
        status: rec.status,
        terminalStatus: rec.terminalStatus ?? null,
        terminalAt: rec.terminalAt ?? null,
        admission: rec.admission,
        launchFailure: rec.launchFailure ?? null,
        children: rec.children,
        relaunchOf: rec.relaunchOf ?? null,
        // SF-6: the projection MUST carry redBait so the report's derived
        // green set (terminalStatus 'completed' && !redBait) stays disjoint
        // from states.red, which is built from state's rec.redBait. Dropping
        // it put a completed red-bait run in BOTH the green set and RED
        // (nongreen distinctness violated). Always a boolean — never undefined.
        redBait: rec.redBait ?? false,
      })),
      phases: Object.values(state.rounds[r].phases ?? {}).map((p) => {
        // US-004: refresh the product merge-event evidence for the two chaos
        // phases at report time (the product reaction can land after the
        // action's dispatch record), falling back to the dispatch-time read.
        const recorded = p.productEvidence ?? null;
        let productEvidence = recorded;
        if (r === 'B' && PRODUCT_EVIDENCE_PHASE_IDS.includes(p.id)) {
          const fresh = productEvidenceForPhase(ctx, state, p.id);
          productEvidence = fresh.ok ? fresh : (recorded ?? fresh);
        }
        return {
          id: p.id,
          status: p.status,
          firedAt: p.firedAt ?? null,
          waitOutcome: p.waitOutcome ?? null,
          notRunReason: p.notRunReason ?? null,
          productEvidence,
        };
      }),
    };
    for (const rec of runs) {
      if (rec.terminalStatus === 'completed' && (rec.redBait ?? false)) report.states.red.push({ round: r, rosterId: rec.rosterId, runId: rec.runId });
      if (rec.status === 'unknown_run' || rec.status === 'launch_failed') report.states.missing.push({ round: r, rosterId: rec.rosterId, runId: rec.runId, status: rec.status });
      if (rec.status === 'queued' || rec.status === 'drain_bound_exceeded' || rec.status === 'cap_abort' || rec.status === 'planned' || rec.status === 'not-planned') report.states.not_run.push({ round: r, rosterId: rec.rosterId, runId: rec.runId, status: rec.status });
      if (rec.terminalStatus === 'failed') report.states.inconclusive.push({ round: r, rosterId: rec.rosterId, runId: rec.runId, status: 'terminal-failed' });
    }
    // Pounding that never ran is a first-class NOT_RUN activity.
    if (state.rounds[r].pounding && !state.rounds[r].pounding.active) {
      report.states.not_run.push({ round: r, activity: 'read_path_pounding', status: 'not_run', reason: state.rounds[r].pounding.notRunReason ?? 'not enabled' });
    }
  }
  state.report = report;
  return report;
}

export function simultaneityVerdict(state) {
  const roundARuns = state.rounds.A.runs ?? {};
  const activeRoster = Object.values(roundARuns).filter((r) => !r.queued); // S1..S8
  const configured = activeRoster.length; // spec 09: the 8-run active roster
  const samples = (state.sampler.samples ?? []).filter((s) => s.round === 'A');
  const peak = computePeak(samples);
  // Honesty rule (reviewer I5 / spec 09 manipulation check): an 8-concurrent
  // window is only declared when EVERY active-roster run is present with a
  // recorded id AND simultaneously has a claimed/running step AND no sample
  // entry is UNKNOWN. A launch_failed/missing run (no run id) makes the
  // full-8 window unobservable — the verdict must NOT silently flip true by
  // dropping that run out of the id set.
  const rosterWithoutRunId = activeRoster.filter((r) => !r.runId).map((r) => r.rosterId);
  const rosterRunIds = activeRoster.map((r) => r.runId).filter(Boolean);
  const windowObserved =
    rosterWithoutRunId.length === 0 &&
    samples.some((s) => {
      if (s.unknown > 0) return false;
      if ((s.configured ?? rosterRunIds.length) < configured) return false;
      return rosterRunIds.every((rid) => s.perRun?.[rid]?.claimed === true);
    });
  const verdictParts = [];
  if (rosterWithoutRunId.length > 0) {
    verdictParts.push(`roster run(s) without a recorded run id (cannot be part of a ${configured}-run window): ${rosterWithoutRunId.join(', ')}`);
  }
  verdictParts.push(`${configured}-concurrent window ${windowObserved ? 'observed' : `NOT observed (observed peak ${peak?.peak ?? 0})`}`);
  if (!windowObserved) verdictParts.push('headline must report the observed peak, not the configured roster');
  return {
    configured,
    observedPeak: peak?.peak ?? 0,
    observedPeakSampleTs: peak?.peakSampleTs ?? null,
    samples: samples.length,
    sampleGaps: state.sampler.sample_gaps ?? [],
    maxUnknownPerSample: peak?.maxUnknown ?? 0,
    rosterWithoutRunId,
    eightConcurrentWindowObserved: windowObserved,
    verdict: verdictParts.join('; '),
  };
}

export function queueVerdict(state) {
  const attempts = state.queue.attempts ?? [];
  const s10 = Object.values(state.rounds.A.runs ?? {}).find((r) => r.rosterId === 'S10');
  const s9 = Object.values(state.rounds.A.runs ?? {}).find((r) => r.rosterId === 'S9');
  // Snapshot-based correctness: an attempt is judged only when a numeric
  // freeSlots snapshot was recorded at decision time. Authoritative
  // daemon/DB decisions with a non-numeric basis are recorded but not
  // numerically judged (never silently counted green).
  const judged = attempts.filter((a) => typeof a.freeSlots === 'number' && (a.decision === 'admit' || a.decision === 'queue'));
  const correctness = judged.every((a) => (a.decision === 'admit') === (a.freeSlots >= a.demandedTimers));
  return {
    attempts,
    s9Status: s9?.status ?? 'not-planned',
    s10Status: s10?.status ?? 'not-planned',
    s10AdmittedAt: state.queue.s10_admitted_at ?? null,
    firstCapacityAt: state.queue.first_capacity_at ?? null,
    s10WithinDrainBound: !s10?.admittedAt ? null : (!state.queue.first_capacity_at ? null : Date.parse(s10.admittedAt) - Date.parse(state.queue.first_capacity_at) <= S10_DRAIN_BOUND_MS),
    decisionCorrectness: judged.length > 0 ? correctness : null,
    decisionCorrectnessJudged: judged.length,
    decisionCorrectnessUnjudged: attempts.length - judged.length,
    decisionCorrectnessRecorded: attempts.length > 0,
  };
}

export function renderStormReportTxt(report) {
  const L = [];
  L.push(`Storm campaign: ${report.campaign_id}`);
  L.push(`Generated (UTC): ${report.generated_at}`);
  L.push(`Qualification: ${report.qualification?.real_launch_allowed ? 'REAL LAUNCH ALLOWED' : 'not-yet-qualified (real launch requires the scripted rehearsal + coordinator acceptance gate)'}`);
  // STORM-REAL US-007: the headline names the spend per provider (local
  // endpoint counted cost 0 vs paid) and the roster that ran. An UNKNOWN spend
  // headline is stated, never rendered as 0.
  const spend = report.spend ?? null;
  L.push(spend?.line ?? 'SPEND: UNKNOWN (no spend snapshot in this report) — never reported as 0');
  const roster = report.roster ?? null;
  L.push(
    `ROSTER: ${roster?.label ?? roster?.id ?? 'unknown'} (id ${roster?.id ?? 'unknown'}) — `
    + `launched ${roster?.launched_runs ?? '?'}/${roster?.planned_runs ?? '?'} recorded run(s), terminal ${roster?.terminal_runs ?? '?'}`,
  );
  if (report.aborted) {
    const a = report.aborted;
    L.push(
      `ABORTED: spend cap crossed (scope ${a.scope ?? 'unknown'}, cap ${a.cap_tokens ?? '?'}, observed ${a.observed_tokens ?? '?'}) at ${a.at ?? 'unknown'}; cleanup_done=${a.cleanup_done === true}`
      + `${a.reason ? ` — ${a.reason}` : ''}`,
    );
  }
  L.push('');
  const sim = report.simultaneity;
  L.push(`SIMULTANEITY: configured target ${sim.configured}; observed peak ${sim.observedPeak} across ${sim.samples} sample(s); 8-concurrent window observed: ${sim.eightConcurrentWindowObserved}`);
  if (!sim.eightConcurrentWindowObserved) L.push(`  ${sim.verdict}`);
  if (sim.maxUnknownPerSample > 0) L.push(`  UNKNOWN per-sample max: ${sim.maxUnknownPerSample} (identity missing/unreadable — never counted as zero)`);
  L.push('');
  const q = report.queue;
  L.push(`QUEUE: S9=${q.s9Status} S10=${q.s10Status}; admission attempts=${q.attempts.length}; snapshot-judged decision correctness=${q.decisionCorrectness == null ? 'n/a' : String(q.decisionCorrectness)} (judged ${q.decisionCorrectnessJudged}, unjudged ${q.decisionCorrectnessUnjudged}); S10 within 10min drain bound=${q.s10WithinDrainBound ?? 'n/a'}`);
  L.push('');
  for (const r of ['A', 'B']) {
    const rd = report.rounds[r];
    L.push(`ROUND ${r}: ${rd.status}`);
    const pd = rd.pounding;
    if (pd) {
      L.push(`  read-path pounding: ${pd.active ? 'ACTIVE' : 'NOT_RUN'}${pd.active ? ` (rounds=${pd.rounds}, probes=${pd.probes}, cadence=${pd.cadenceMs}ms, latency bound=${pd.latencyBoundMs}ms, assertion failures=${pd.assertionFailures}, max latency=${pd.maxLatencyMs}ms)` : ` — ${pd.notRunReason ?? 'no config'}`}`);
    }
    for (const run of rd.runs) {
      const st = run.terminalStatus ?? run.status;
      L.push(`  ${run.rosterId} ${run.run} (${run.workflow}, ${run.harness}) -> ${st}${run.runId ? ` [${run.runId}]` : ' [NO RUN ID]'}${run.launchFailure ? ` launch_failure=${run.launchFailure.code}` : ''}${run.relaunchOf ? ` relaunch_of=${run.relaunchOf}` : ''}`);
    }
    for (const ph of rd.phases) {
      const pe = ph.productEvidence && typeof ph.productEvidence === 'object' ? ph.productEvidence : null;
      const peTxt = pe
        ? ` product=${pe.ok === false ? `unavailable(${pe.error ?? 'unknown'})` : `targetMoved:${pe.targetMoved?.length ?? 0},landed:${pe.landed?.length ?? 0},parkLanding:${pe.parkLanding?.length ?? 0}`}`
        : '';
      L.push(`  phase ${ph.id}: ${ph.status}${ph.firedAt ? ` @${ph.firedAt}` : ''}${ph.waitOutcome ? ` wait=${ph.waitOutcome.outcome}` : ''}${ph.notRunReason ? ` reason=${ph.notRunReason}` : ''}${peTxt}`);
    }
  }
  L.push('');
  L.push(`CLEANUP: ${report.cleanup.failed.length === 0 ? 'all owned cleanup phases ok' : `${report.cleanup.failed.length} FAILED: ${JSON.stringify(report.cleanup.failed)}`}`);
  L.push('');
  if (report.states.red.length) L.push(`RED: ${report.states.red.map((x) => `${x.round}/${x.rosterId ?? x.activity ?? x.status}`).join(', ')}`);
  if (report.states.missing.length) L.push(`MISSING/INCONCLUSIVE: ${report.states.missing.map((x) => `${x.round}/${x.rosterId ?? x.activity}(${x.status})`).join(', ')}`);
  if (report.states.not_run.length) L.push(`NOT_RUN: ${report.states.not_run.map((x) => `${x.round}/${x.rosterId ?? x.activity ?? 'activity'}(${x.status})${x.reason ? ` — ${x.reason}` : ''}`).join(', ')}`);
  L.push('');
  L.push('Red/missing/inconclusive/NOT_RUN are first-class reported states — never normalized to green.');
  return L.join('\n');
}

export async function stormReport(ctx) {
  const campaignDir = ctx.campaignDir;
  const ops = opRecorder({ fs: ctx.fs, campaignDir });
  const stateRes = loadState({ fs: ctx.fs, campaignDir });
  if (!stateRes.ok) throw refusal(`cannot report: ${stateRes.error}`, 'TT_STATE');
  const state = stateRes.state;
  ops.record('report.start', { campaignId: state.campaign_id });
  // US-007: the report reads the last observation tick's results/spend.json
  // (a REAL campaign refreshes it every tick) so the headline names the spend
  // per provider and the roster that ran.
  const report = buildStormReport(ctx, state, { campaignDir });
  const txt = renderStormReportTxt(report);
  const resultsDir = path.join(campaignDir, STORM_RESULTS_DIR);
  if (!ctx.fs.existsSync(resultsDir)) ctx.fs.mkdirSync(resultsDir, { recursive: true });
  ctx.fs.writeFileSync(path.join(resultsDir, STORM_REPORT_JSON), JSON.stringify(report, null, 2) + '\n');
  ctx.fs.writeFileSync(path.join(resultsDir, STORM_REPORT_TXT), txt);
  saveState({ fs: ctx.fs, campaignDir, state });
  ops.record('report.done', { campaignId: state.campaign_id });
  return { campaignId: state.campaign_id, report, txt };
}

// stormReportFull — report finalization with owned cleanup FIRST. A
// cleanup failure PROPAGATES: report files are NOT written and the caller
// receives a TT_CLEANUP_FAILED refusal — a failed cleanup must be repaired
// (or an operator override recorded) before forensics finalize.
//
// STORM-REAL: when ctx.opts.runOwnedCleanup is supplied (the real CLI wires
// tt-storm-real.mjs runOwnedCleanup), the report AWAITS the async cleanup
// runner and requires every declared owned resource to produce positive
// shutdown evidence; a runner that reports failure (absent handler,
// handler throw, or no positive evidence) propagates as TT_CLEANUP_FAILED
// with the failed phases named. The recording gate supplies no runner and
// keeps the legacy sync cleanupOwned ledger semantics (G11).
export async function stormReportFull(ctx, { cleanupPhases = ['campaign-owned'] } = {}) {
  const stateRes = loadState({ fs: ctx.fs, campaignDir: ctx.campaignDir });
  if (!stateRes.ok) throw refusal(`cannot report: ${stateRes.error}`, 'TT_STATE');
  if (typeof ctx.opts?.runOwnedCleanup === 'function') {
    const runnerResult = await ctx.opts.runOwnedCleanup(ctx, stateRes.state);
    if (!runnerResult?.ok) {
      const failed = runnerResult?.failed ?? [];
      throw refusal(
        `owned cleanup failed before report finalization: ${JSON.stringify(failed.map((e) => ({ phase: e.phase, error: e.error })))}`,
        'TT_CLEANUP_FAILED',
      );
    }
    return stormReport(ctx);
  }
  const cl = cleanupOwned(ctx, stateRes.state, cleanupPhases);
  if (!cl.ok) {
    throw refusal(
      `owned cleanup failed before report finalization: ${JSON.stringify(cl.failed.map((e) => ({ phase: e.phase, error: e.error })))}`,
      'TT_CLEANUP_FAILED',
    );
  }
  return stormReport(ctx);
}

// Re-exported for tests/CLI.
export const _internal = { ensureRunRecord, harvestRound };
