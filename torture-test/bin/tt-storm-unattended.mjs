// tt-storm-unattended.mjs — STORM-REAL US-012 unattended round budget and
// detached launch.
//
// A REAL storm round is made of real model turns, real merges and real test
// suites: it can legitimately run for HOURS, and the observation loop must
// survive the operator's ssh session ending. Two pure primitives make that the
// campaign's OWN contract instead of operator discipline:
//
//   * a per-round wall-budget guard. SCRIPTED_REHEARSAL keeps its existing
//     round defaults unchanged (Round A's T+44h wedge, Round B's nominal ~3h
//     corridor). REAL has NO fixed per-round cap below the six-hour floor: an
//     explicitly configured cap below 6h is refused TT_USAGE, and with no
//     configured cap the campaign uses the same campaign-level T+44h wedge as
//     its round bound — the 3h Round-B corridor is a SCRIPTED nominal, never a
//     REAL cap. The campaign-level wedge (T+44h) remains the only bound.
//   * a detached launch invocation builder. `tt-storm run --detach` re-executes
//     itself under setsid (Linux) or nohup with stdout/stderr captured into the
//     campaign's logs dir, so the round survives the launching shell.
//
// This module is PURE (no I/O, no spawning, no clock): the CLI supplies the
// clock/paths and performs the spawn. It is deliberately separate from the
// engine so the budget decision and the detached argv are unit-testable
// without a daemon, a harness or a model.

import path from 'node:path';

import { refusal } from './tt-contention-slice-shared.mjs';
import {
  ROUND_A_WEDGE_HARD_MS,
  ROUND_B_END_MS,
} from './tt-storm-shared.mjs';
import { isRealProfile } from './tt-storm-profile.mjs';

// The REAL minimum per-round wall budget: six hours. A REAL round may run
// longer (real model turns + merge/test loops), so a configured cap below this
// floor would truncate an honest round; it is REFUSED rather than silently
// widened.
export const REAL_MIN_ROUND_WALL_MS = 6 * 60 * 60 * 1000;

// The existing SCRIPTED_REHEARSAL round bounds, unchanged: Round A's T+44h
// wedge and Round B's nominal ~3h corridor. These are the profile defaults the
// guard keeps for SCRIPTED_REHEARSAL.
export const SCRIPTED_ROUND_WALL_DEFAULTS = Object.freeze({
  A: ROUND_A_WEDGE_HARD_MS,
  B: ROUND_B_END_MS,
});

// The campaign-level bound shared by every REAL round: the same T+44h wedge the
// spec defines for the storm. It is NOT a per-round cap below the 6h minimum
// (44h > 6h) — it bounds the whole campaign, exactly as before.
export const REAL_CAMPAIGN_BOUND_MS = ROUND_A_WEDGE_HARD_MS;

// The one admitted round identity set for a budget decision.
export const ROUND_WALL_ROUNDS = Object.freeze(['A', 'B']);

function normalizeRound(round) {
  const r = typeof round === 'string' ? round.trim().toUpperCase() : '';
  if (r !== 'A' && r !== 'B') {
    throw refusal(`round wall budget requires round A|B (got ${JSON.stringify(round)})`, 'TT_USAGE');
  }
  return r;
}

// Parse an operator-supplied --round-wall-ms. Absent (undefined/null/'') -> null
// (use the profile default). A supplied value must be a positive safe integer
// of milliseconds, else TT_USAGE. PURE.
export function parseRoundWallMs(value = undefined) {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw refusal(
      `--round-wall-ms must be a positive integer of milliseconds (got ${JSON.stringify(value)})`,
      'TT_USAGE',
    );
  }
  return raw;
}

// The ONE per-round wall-budget decision. PURE — no clock, no I/O.
//
// Returns either
//   { ok:true,  profile, round, configuredWallMs, effectiveWindowMs, source,
//     minWallMs, bounded }
// or
//   { ok:false, code, reason, profile, round, configuredWallMs?, minWallMs }
//
// source:
//   'scripted_default' — SCRIPTED_REHEARSAL, no configured cap (unchanged);
//   'configured'       — an explicit cap (>= 6h for REAL);
//   'campaign_wedge'   — REAL, no configured cap: the campaign-level T+44h
//                        wedge is the bound (never the 3h scripted corridor).
export function resolveRoundWallBudget({ profile = null, round = 'A', configuredWallMs = null } = {}) {
  const r = normalizeRound(round);
  let configured;
  try {
    configured = parseRoundWallMs(configuredWallMs);
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? 'TT_USAGE',
      reason: err?.message ?? String(err),
      profile,
      round: r,
      minWallMs: REAL_MIN_ROUND_WALL_MS,
    };
  }
  if (typeof profile !== 'string' || profile.trim() === '') {
    return {
      ok: false,
      code: 'TT_USAGE',
      reason: 'round wall budget requires a persisted campaign profile',
      profile,
      round: r,
      minWallMs: REAL_MIN_ROUND_WALL_MS,
    };
  }
  if (isRealProfile(profile)) {
    if (configured !== null && configured < REAL_MIN_ROUND_WALL_MS) {
      return {
        ok: false,
        code: 'TT_USAGE',
        reason:
          `REAL per-round wall cap ${configured}ms is below the ${REAL_MIN_ROUND_WALL_MS}ms (6h) minimum — a real round may run for hours; ` +
          `raise --round-wall-ms to >= ${REAL_MIN_ROUND_WALL_MS} or omit it for no per-round cap (the T+44h campaign wedge still bounds the campaign)`,
        profile,
        round: r,
        configuredWallMs: configured,
        minWallMs: REAL_MIN_ROUND_WALL_MS,
      };
    }
    // REAL: no configured cap -> the campaign-level wedge is the bound; a
    // configured cap must be at/above the 6h floor.
    return {
      ok: true,
      profile,
      round: r,
      configuredWallMs: configured,
      effectiveWindowMs: configured ?? REAL_CAMPAIGN_BOUND_MS,
      source: configured === null ? 'campaign_wedge' : 'configured',
      minWallMs: REAL_MIN_ROUND_WALL_MS,
      bounded: true,
    };
  }
  // SCRIPTED_REHEARSAL: keep the existing per-round defaults byte-for-byte; a
  // configured cap is used verbatim (the 6h floor is a REAL-only rule).
  return {
    ok: true,
    profile,
    round: r,
    configuredWallMs: configured,
    effectiveWindowMs: configured ?? SCRIPTED_ROUND_WALL_DEFAULTS[r],
    source: configured === null ? 'scripted_default' : 'configured',
    minWallMs: null,
    bounded: true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Detached launch.
//
// `tt-storm run` re-executes itself in its own session so the round's
// observation loop is not tied to the operator's shell. The launcher is
// platform-selected: setsid on Linux (the real campaign host) and nohup
// elsewhere (macOS has no setsid(1) binary; the spawn is ALSO made detached at
// the syscall level by the CLI, so either launcher survives the parent).
// ─────────────────────────────────────────────────────────────────────

export const DETACH_LAUNCHER_SETSID = 'setsid';
export const DETACH_LAUNCHER_NOHUP = 'nohup';

// The detach launcher for a platform. PURE.
export function detachLauncherForPlatform(platform = process.platform) {
  return platform === 'linux' ? DETACH_LAUNCHER_SETSID : DETACH_LAUNCHER_NOHUP;
}

// A filesystem-safe UTC stamp for a detached log file name. An unparseable/
// absent instant falls back to the epoch rather than fabricating "now" (the
// builder is pure).
function logStamp(at) {
  const raw = typeof at === 'string' && at.trim() !== '' ? at.trim() : new Date(0).toISOString();
  return raw.replace(/[:.]/g, '-');
}

// The exact stdout/stderr log destinations for a detached run, under the
// CAMPAIGN's own logs dir so the evidence lands beside the campaign it belongs
// to. PURE.
export function detachedRunLogPaths({ campaignDir, round = 'A', at = null } = {}) {
  if (typeof campaignDir !== 'string' || campaignDir.trim() === '') {
    throw refusal('detachedRunLogPaths requires a campaign dir', 'TT_USAGE');
  }
  const r = normalizeRound(round);
  const dir = path.join(campaignDir, 'logs');
  const base = `run-${r}.detached.${logStamp(at)}`;
  return {
    dir,
    stdout: path.join(dir, `${base}.out.log`),
    stderr: path.join(dir, `${base}.err.log`),
  };
}

// Strip the --detach flag from a forwarded argv so the detached child runs the
// SAME invocation without re-detaching itself (no recursion). Every other
// option is forwarded byte-identically (campaign, round, spend cap, profile-
// independent flags, operator seams). PURE.
export function stripDetachFlag(args = []) {
  const out = [];
  for (const a of args) {
    if (a === '--detach') continue;
    out.push(a);
  }
  return out;
}

// Build the pure detached invocation. `argv` is the FULL tt-storm argv
// (starting with the command, e.g. ['run','--campaign',...]); the `--detach`
// flag is stripped so the child never recurses. The returned `argv` is the
// COMPLETE process argv ([launcher, nodeBin, cliPath, ...forwarded]) the CLI
// hands to spawn. PURE.
//
// The CLI spawns this WITHOUT Node's own `detached: true`: the launcher must be
// the process-group leader itself (setsid(2) otherwise fails and the launcher
// forks, making the reported pid a short-lived wrapper). `setsid` puts the
// round in a new session and `nohup` ignores SIGHUP, so either survives the
// launching shell; the CLI also unrefs the child so the parent returns.
export function buildDetachedRunInvocation({
  nodeBin,
  cliPath,
  argv = [],
  launcher = DETACH_LAUNCHER_SETSID,
  stdoutLog,
  stderrLog,
} = {}) {
  if (typeof nodeBin !== 'string' || nodeBin.trim() === '') {
    throw refusal('buildDetachedRunInvocation requires an absolute node binary', 'TT_USAGE');
  }
  if (typeof cliPath !== 'string' || cliPath.trim() === '') {
    throw refusal('buildDetachedRunInvocation requires the tt-storm CLI path', 'TT_USAGE');
  }
  if (typeof stdoutLog !== 'string' || stdoutLog.trim() === '') {
    throw refusal('buildDetachedRunInvocation requires a stdout log path', 'TT_USAGE');
  }
  if (typeof stderrLog !== 'string' || stderrLog.trim() === '') {
    throw refusal('buildDetachedRunInvocation requires a stderr log path', 'TT_USAGE');
  }
  if (launcher !== DETACH_LAUNCHER_SETSID && launcher !== DETACH_LAUNCHER_NOHUP) {
    throw refusal(
      `buildDetachedRunInvocation requires a setsid|nohup launcher (got ${JSON.stringify(launcher)})`,
      'TT_USAGE',
    );
  }
  const forwarded = stripDetachFlag(argv);
  const args = [nodeBin, cliPath, ...forwarded];
  return {
    launcher,
    argv: [launcher, ...args],
    args,
    forwarded,
    stdoutLog,
    stderrLog,
  };
}