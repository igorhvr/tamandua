// tt-storm-profile.mjs — storm campaign PROFILE identity (STORM-REAL US-001).
//
// A storm campaign is prepared for exactly ONE profile, and the profile is a
// first-class, persisted identity — never an implicit behaviour switch:
//
//   * SCRIPTED_REHEARSAL — the zero-model infrastructure rehearsal: frozen
//     scripted pi/Hermes runtimes, a private product-schema DB, a tiny owned
//     git fixture and the derived hold/phase schedule. This is the DEFAULT so
//     every existing prepare/run path stays byte-for-byte unchanged.
//   * REAL — the real storm: the operator's real pi/hermes/dsh harnesses, the
//     real product daemon from this tree, the aged seed, and real tokens. It
//     must never be silently substituted by (or confused with) the scripted
//     rehearsal, and vice versa.
//
// This module is PURE (no I/O, no spawning, no clock): it only names the
// profiles, maps a profile to its daemon kind, and validates an operator
// supplied value. The persistence and behaviour branches live in the engine
// and the rehearsal builder.
//
// The daemon kind is the operationally significant mapping: a REAL campaign
// boots through daemon-control's `real` mode (real harness binaries, operator
// home seam), while the scripted rehearsal boots the frozen `scripted` mode.
// An unknown profile is a usage error (TT_USAGE) refused BEFORE any effect.

import { refusal } from './tt-contention-slice-shared.mjs';

// The two ADMITTED profile identities. Kept as exact-case constants because
// they are persisted into campaign state/descriptor and compared for equality
// (a coordinator approval is profile-bound — an approval naming one profile
// must never authorize the other).
export const SCRIPTED_REHEARSAL = 'SCRIPTED_REHEARSAL';
export const REAL = 'REAL';

// The default profile. Every existing (unflagged) prepare/run path is the
// scripted rehearsal, so absent an explicit --profile the behaviour is
// identical to before profiles existed.
export const DEFAULT_STORM_PROFILE = SCRIPTED_REHEARSAL;

// The admitted profile set, in canonical display order.
export const STORM_PROFILES = Object.freeze([SCRIPTED_REHEARSAL, REAL]);

// The descriptor labels. The two labels must stay DISTINCT: a REAL descriptor
// may never carry the tiny-fixture infrastructure-rehearsal label (the
// coordinator must be able to tell, from the descriptor alone, which campaign
// they are approving).
export const SCRIPTED_REHEARSAL_LABEL =
  'infrastructure rehearsal (tiny owned fixture) — NOT full tt-poly storm';
export const REAL_LABEL =
  'real storm (real pi/hermes/dsh harnesses + real product daemon, operator credentials) — NOT a tiny-fixture rehearsal';

// Profile -> daemon-control kind. This is the ONE mapping: the run layer looks
// up the kind from the persisted profile, never from an independent flag.
export const PROFILE_DAEMON_KIND = Object.freeze({
  [SCRIPTED_REHEARSAL]: 'scripted',
  [REAL]: 'real',
});

// Profile -> descriptor label. Mirrors PROFILE_DAEMON_KIND's single-source
// discipline so the label cannot drift from the profile identity.
export const PROFILE_LABELS = Object.freeze({
  [SCRIPTED_REHEARSAL]: SCRIPTED_REHEARSAL_LABEL,
  [REAL]: REAL_LABEL,
});

// True when `value` is an admitted profile string (no coercion, no default).
export function isStormProfile(value) {
  return typeof value === 'string' && STORM_PROFILES.includes(value);
}

// True when the (already parsed) profile is REAL. Pure identity comparison —
// callers that may hold an unvalidated value should parseProfile first.
export function isRealProfile(profile) {
  return profile === REAL;
}

// Parse/validate an operator-supplied profile. An omitted value
// (undefined/null) selects the default SCRIPTED_REHEARSAL; a supplied value
// must be a non-empty admitted identity, else a TT_USAGE refusal is raised
// BEFORE any campaign effect. Whitespace is trimmed; the persisted identity is
// always the canonical exact-case constant.
export function parseProfile(value = undefined) {
  if (value === undefined || value === null) return DEFAULT_STORM_PROFILE;
  if (typeof value !== 'string') {
    throw refusal(
      `storm profile must be a string (got ${JSON.stringify(value)}; expected SCRIPTED_REHEARSAL|REAL)`,
      'TT_USAGE',
    );
  }
  const profile = value.trim();
  if (profile === '') {
    throw refusal('storm profile must be non-empty (expected SCRIPTED_REHEARSAL|REAL)', 'TT_USAGE');
  }
  if (!STORM_PROFILES.includes(profile)) {
    throw refusal(`unknown storm profile ${JSON.stringify(value)} (expected SCRIPTED_REHEARSAL|REAL)`, 'TT_USAGE');
  }
  return profile;
}

// The campaign profile PERSISTED in a prepared campaign's state. This is the
// ONE source a launching route (approve/rehearse/run) uses to bind a
// coordinator approval to the profile the campaign was actually prepared for —
// it is NEVER re-derived from a CLI flag, so an approval issued for one
// profile can never authorize a campaign of the other. Returns null when the
// campaign carries no persisted profile (a non-rehearsal / legacy campaign),
// so the caller omits the profile requirement rather than fabricating one.
export function profileFromCampaignState(state) {
  if (!state || typeof state !== 'object') return null;
  const rehearsal = state.rehearsal;
  if (!rehearsal || typeof rehearsal !== 'object') return null;
  const value = rehearsal.profile;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

// The daemon-control kind for a profile. Defaults to the scripted rehearsal
// when omitted; refuses an unknown/non-string value with TT_USAGE.
export function daemonKindForProfile(profile = undefined) {
  const parsed = parseProfile(profile);
  return PROFILE_DAEMON_KIND[parsed];
}

// The descriptor label for a profile. Defaults to the scripted rehearsal label
// when omitted; refuses an unknown/non-string value with TT_USAGE.
export function labelForProfile(profile = undefined) {
  const parsed = parseProfile(profile);
  return PROFILE_LABELS[parsed];
}