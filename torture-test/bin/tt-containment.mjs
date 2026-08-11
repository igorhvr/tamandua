// tt-containment.mjs — FIX10 US-003 fail-closed HOME containment primitives.
//
// Shared by tt-controller (spawn-env assembly plus the runHook /
// runDurableLocalCommand choke-point) and tt-hook-runner (its own
// process.env.HOME). Mirrors the US-002 bash guard
// (torture-test/cases/hooks/containment-guard.sh): a spawned
// case/hook/scenario/oracle child must run with HOME resolving STRICTLY
// inside torture-test/var — never the operator's real HOME (the 2026-08-05
// ~/.gitconfig breach: an uncontained HOME made the hook's --global
// git-config write rewrite the OPERATOR's real gitconfig).
//
// Fail closed: any violation throws an Error with
// code = CONTAINMENT_VIOLATION_CODE, so callers abort the case as
// TEST_INFRA_FAIL (category 'containment-violation') instead of falling
// through to the real HOME.
//
// NOTE: this file must never contain the literal `git config` + `--global`
// adjacent text — the US-001 audit grep treats it as a write site.

import fs from 'node:fs';
import path from 'node:path';

export const CONTAINMENT_VIOLATION_CODE = 'TT_CONTAINMENT_VIOLATION';

// Build a distinctive containment-violation error. The code lets a central
// catch (executeEligibleCases) map the failure to the precise
// 'containment-violation' TEST_INFRA_FAIL category.
export function containmentViolation(detail) {
  const error = new Error(`containment violation: ${detail}`);
  error.code = CONTAINMENT_VIOLATION_CODE;
  return error;
}

export function isContainmentViolation(error) {
  return error !== null && typeof error === 'object' && error.code === CONTAINMENT_VIOLATION_CODE;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Resolve `candidate` to a real path WITHOUT requiring it to exist: when the
// exact path is absent (a fresh checkout where
// torture-test/var/home-scripted has not been provisioned yet) — or is a
// dangling symlink — walk up to the nearest EXISTING, RESOLVABLE ancestor
// and use that. The not-yet-provisioned home is judged by where it WILL
// live (inside var), never by the operator's real HOME. The resolved path
// must be a directory (a symlink to a directory resolves; anything else
// cannot host a contained home).
function resolveExistingRealPath(candidate, label) {
  let current = candidate;
  for (;;) {
    let real;
    try {
      real = fs.realpathSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw containmentViolation(`cannot resolve ${label}: ${current} (${error.message})`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw containmentViolation(`cannot resolve ${label}: ${candidate} (no existing ancestor)`);
      }
      current = parent;
      continue;
    }
    if (!fs.statSync(real).isDirectory()) {
      throw containmentViolation(`${label} cannot resolve to a directory: ${current}`);
    }
    return real;
  }
}

// Assert HOME resolves strictly inside varRoot (realpath comparison; mirrors
// the US-002 bash guard semantics: strictly inside, var-itself rejected).
// `home` may be a not-yet-existing path under varRoot (fresh checkout); the
// nearest existing ancestor is used in that case. Throws a containment
// violation on any failure; returns the resolved HOME realpath on success.
export function assertContainedHome(home, varRoot, label = 'child HOME') {
  if (typeof home !== 'string' || home === '') {
    throw containmentViolation(`${label} is unset or empty`);
  }
  if (typeof varRoot !== 'string' || varRoot === '') {
    throw containmentViolation(`containment root is unset or empty while checking ${label}`);
  }
  let varReal;
  try {
    varReal = fs.realpathSync(varRoot);
  } catch (error) {
    throw containmentViolation(
      `cannot resolve containment root ${varRoot}: ${error.message} (while checking ${label})`);
  }
  const homeReal = resolveExistingRealPath(home, label);
  if (homeReal === varReal && fs.existsSync(home)) {
    throw containmentViolation(
      `${label} is torture-test/var itself (${varReal}), not a contained child home`);
  }
  if (!pathIsWithin(varReal, homeReal)) {
    throw containmentViolation(
      `${label} (${home}) resolves to ${homeReal}, which is NOT strictly under torture-test/var (${varReal})`);
  }
  if (fs.existsSync(home) && !fs.statSync(homeReal).isDirectory()) {
    throw containmentViolation(`${label} is not a directory: ${homeReal}`);
  }
  return homeReal;
}
