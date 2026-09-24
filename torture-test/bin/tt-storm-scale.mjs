// tt-storm-scale.mjs — storm campaign SCALE identity (STORM-REAL US-008).
//
// The full storm (spec 09) is a ten-run Round A roster plus a five-run Round
// B roster under the complete chaos schedule. A host below full-storm
// capability (missing toolchains -> tt-poly-lite; measured slow spawn or
// tight disk) runs the spec's CAPACITY-SCALED variant instead: the four-run
// tt-poly-lite pilot with a recomputed timer cap and a reduced chaos plan
// (one colleague commit, one worker kill).
//
// The scale is a first-class PERSISTED identity exactly like the profile:
//
//   * FULL — the default; every existing (unflagged) prepare path is
//     byte-for-byte unchanged.
//   * LITE — the tt-poly-lite pilot: a four-run roster (fdmw pi ts, bfmw
//     hermes python, quarantine-mw pi ts landing on broken-tests, do-now
//     agitator) with the reduced chaos plan and a timer cap recomputed from
//     the actual lite roster's agent counts.
//
// This module is PURE (no I/O, no spawning, no clock): it names the scales,
// validates an operator value, and owns the lite roster + reduced phase table
// so the engine/CLI/rehearsal builder can never disagree about what "lite"
// means. Roster identity and timer derivation stay in tt-storm-roster.mjs.

import { refusal } from './tt-contention-slice-shared.mjs';
import {
  ROUND_A_ROSTER,
  ROUND_B_ROSTER,
} from './tt-storm-roster.mjs';

export const FULL = 'full';
export const LITE = 'lite';

// The admitted scale identities, in canonical display order. FULL is the
// default so absent an explicit --scale the behaviour is identical to before
// scales existed.
export const STORM_SCALES = Object.freeze([FULL, LITE]);
export const DEFAULT_STORM_SCALE = FULL;

// True when `value` is an admitted scale string (no coercion, no default).
export function isStormScale(value) {
  return typeof value === 'string' && STORM_SCALES.includes(value);
}

// True when the (already parsed) scale is LITE. Pure identity comparison.
export function isLiteScale(value) {
  return value === LITE;
}

// Parse/validate an operator-supplied scale. An omitted value (undefined/null)
// selects FULL; a supplied value must be a non-empty admitted identity, else a
// TT_USAGE refusal is raised BEFORE any campaign effect.
export function parseScale(value = undefined) {
  if (value === undefined || value === null) return DEFAULT_STORM_SCALE;
  if (typeof value !== 'string') {
    throw refusal(
      `storm scale must be a string (got ${JSON.stringify(value)}; expected full|lite)`,
      'TT_USAGE',
    );
  }
  const scale = value.trim().toLowerCase();
  if (scale === '') {
    throw refusal('storm scale must be non-empty (expected full|lite)', 'TT_USAGE');
  }
  if (!STORM_SCALES.includes(scale)) {
    throw refusal(`unknown storm scale ${JSON.stringify(value)} (expected full|lite)`, 'TT_USAGE');
  }
  return scale;
}

// ─────────────────────────────────────────────────────────────────────
// The tt-poly-lite pilot roster (spec 09 "Capacity-scaled variant"): exactly
// four runs — fdmw(pi, ts), bfmw(hermes, python), quarantine-mw(pi, ts ->
// broken-tests), do-now agitator. Round B re-launches the SAME four workflows
// so the reduced chaos phases (one colleague commit, one worker kill) have
// live targets, mirroring the full storm's two-round structure. The Round A
// entries are the canonical lite roster the AC names.
//
// `context: ['branch=broken-tests']` is what makes the quarantine lane land on
// broken-tests (never main); buildLaunchPlan/task provisioning derive the
// target branch from it, so the lite roster cannot drift from the full one.
// ─────────────────────────────────────────────────────────────────────
export const LITE_ROUND_A_ROSTER = Object.freeze([
  { id: 'L1', run: 'storm-lite-fdmw-1', workflow: 'feature-dev-merge-worktree', harness: 'pi', round: 'A', taskArea: 'ts/ store feature (tt-poly-lite)', context: [] },
  { id: 'L2', run: 'storm-lite-bfmw-1', workflow: 'bug-fix-merge-worktree', harness: 'hermes', round: 'A', taskArea: 'python/ scheduler bug (tt-poly-lite)', context: [] },
  { id: 'L3', run: 'storm-lite-quar-1', workflow: 'quarantine-broken-tests-merge-worktree', harness: 'pi', round: 'A', taskArea: 'tt-poly-lite broken tests', context: ['branch=broken-tests'] },
  { id: 'L4', run: 'storm-lite-donow-1', workflow: 'do-now', harness: 'pi', round: 'A', taskArea: 'do-now agitator (queue-drain canary)', context: [] },
]);

export const LITE_ROUND_B_ROSTER = Object.freeze([
  { id: 'L1b', run: 'storm-lite-b1-fdmw', workflow: 'feature-dev-merge-worktree', harness: 'pi', round: 'B', taskArea: 'ts/ store feature (tt-poly-lite)', context: [] },
  { id: 'L2b', run: 'storm-lite-b2-bfmw', workflow: 'bug-fix-merge-worktree', harness: 'hermes', round: 'B', taskArea: 'python/ scheduler bug (tt-poly-lite)', context: [] },
  { id: 'L3b', run: 'storm-lite-b3-quar', workflow: 'quarantine-broken-tests-merge-worktree', harness: 'pi', round: 'B', taskArea: 'tt-poly-lite broken tests', context: ['branch=broken-tests'] },
  { id: 'L4b', run: 'storm-lite-b4-donow', workflow: 'do-now', harness: 'pi', round: 'B', taskArea: 'do-now agitator (queue-drain canary)', context: [] },
]);

// The reduced lite chaos plan (spec 09: "one colleague commit and one worker
// kill"). The read-path pounding phase is retained (it is the storm's
// background load, not chaos), then exactly ONE colleague_commit and exactly
// ONE kill_harness. The wait predicates are deliberately `kind: 'none'`
// (timing-gated by earliestOffsetMs) so the reduced plan never depends on a
// full-roster marker probe.
export const LITE_ROUND_B_PHASES = Object.freeze([
  { id: 'B-pounding', label: 'read-path pounding starts (continues through the lite pilot)', earliestOffsetMs: 0, waitFor: { kind: 'none', marker: null }, action: { kind: 'read_path_pounding' } },
  { id: 'L-cc1', label: 'lite colleague commit #1 (one colleague commit)', earliestOffsetMs: 5 * 60_000, waitFor: { kind: 'none', marker: null }, action: { kind: 'colleague_commit', target: 'L1b', fileRole: 'cc1' } },
  { id: 'L-kill', label: 'lite worker kill (one worker kill, SIGKILL active L2b harness)', earliestOffsetMs: 10 * 60_000, waitFor: { kind: 'none', marker: null }, action: { kind: 'kill_harness', target: 'L2b', signal: 'SIGKILL' } },
]);

// The lite roster identity recorded in state/descriptor.
export const LITE_ROSTER_ID = LITE;
export const LITE_FIXTURE_NAME = 'tt-poly-lite';

// The roster (A/B) for a scale. FULL returns the authoritative global rosters
// (unchanged); LITE returns the tt-poly-lite pilot roster.
export function rosterForScale(scale = undefined) {
  const parsed = parseScale(scale);
  return parsed === LITE
    ? { A: LITE_ROUND_A_ROSTER, B: LITE_ROUND_B_ROSTER }
    : { A: ROUND_A_ROSTER, B: ROUND_B_ROSTER };
}

// The Round B phase table for a scale. FULL returns null so the engine keeps
// its authoritative ROUND_B_PHASES table (a REAL full campaign must not record
// a derived schedule); LITE returns the reduced lite plan.
export function roundBPhasesForScale(scale = undefined) {
  const parsed = parseScale(scale);
  return parsed === LITE ? LITE_ROUND_B_PHASES : null;
}

// The distinct workflow ids of a roster pair (used for descriptor identity).
export function rosterWorkflowIds(roster) {
  const ids = [];
  for (const row of [...(roster?.A ?? []), ...(roster?.B ?? [])]) {
    if (row?.workflow && !ids.includes(row.workflow)) ids.push(row.workflow);
  }
  return ids;
}

// The distinct harnesses of a roster pair (used for REAL binary resolution:
// the lite roster uses pi/hermes only, so a lite prepare never demands dsh).
export function rosterHarnessNames(roster) {
  const names = [];
  for (const row of [...(roster?.A ?? []), ...(roster?.B ?? [])]) {
    if (row?.harness && !names.includes(row.harness)) names.push(row.harness);
  }
  return names;
}

// The scale PERSISTED in a prepared campaign's state, or FULL when absent (a
// pre-scale campaign is the full storm). Reads the documented persisted keys
// (roster_id / scale at the rehearsal or plan level) so a future writer cannot
// drift; an unrecognized value falls back to FULL rather than guessing.
export function scaleFromState(state) {
  if (!state || typeof state !== 'object') return FULL;
  const source = [
    state?.rehearsal?.roster_id,
    state?.rehearsal?.scale,
    state?.rehearsal?.resource_plan?.roster_id,
    state?.rehearsal?.resource_plan?.scale,
    state?.plan?.roster_id,
    state?.plan?.scale,
  ].find((v) => typeof v === 'string' && v.trim() !== '');
  if (!source) return FULL;
  const value = source.trim().toLowerCase();
  return isStormScale(value) ? value : FULL;
}

// The Round A roster a persisted campaign actually launched (the release
// targets the engine's window observation must release). Full -> the
// non-queued S1..S8; lite -> the four lite ids.
export function activeReleaseTargetsForScale(scale = undefined) {
  const parsed = parseScale(scale);
  if (parsed === LITE) return LITE_ROUND_A_ROSTER.map((r) => r.id);
  return ROUND_A_ROSTER.filter((r) => !r.queued).map((r) => r.id);
}

// The expected size of the Round A active (non-queued) roster — the honest
// configured count a simultaneity window is judged against. Full -> 8; lite ->
// 4. Derived from the roster so it can never drift from the launch plan.
export function expectedActiveCountForScale(scale = undefined) {
  const parsed = parseScale(scale);
  return parsed === LITE
    ? LITE_ROUND_A_ROSTER.filter((r) => !r.queued).length
    : ROUND_A_ROSTER.filter((r) => !r.queued).length;
}

// Convenience state-based readers (the persisted scale is the authority at run
// time; never a CLI flag).
export function expectedActiveCountFromState(state) {
  return expectedActiveCountForScale(scaleFromState(state));
}

export function activeReleaseTargetsFromState(state) {
  return activeReleaseTargetsForScale(scaleFromState(state));
}