#!/usr/bin/env bash
# torture-test/scenarios/lib/scenario-containment-guard.sh
#
# Shared FIX10 US-004 fail-closed HOME containment guard for scripted
# SCENARIO code (run-scripted-scenario command children and every
# scenarios/*/run.sh entry point).
#
# Source at the very top of scenario command code to assert, BEFORE any
# daemon control, git write, or HOME-side-effect, that $HOME is a real
# directory STRICTLY inside torture-test/var (realpath comparison). On
# violation it prints a loud, HOME-naming error to stderr and exits 2.
# After it returns, the caller may use fail_containment and $tt_var_real
# for belt-and-suspenders checks.
#
# WHY: the 2026-08-05 ~/.gitconfig breach was an uncontained HOME making a
# torture-test git-identity write rewrite the OPERATOR's real config. The
# scenario harness (run-scripted-scenario) sources env/tt-env-scripted.sh
# into every command child so $HOME is the contained TT_SCRIPTED_HOME, and
# scenarios/*/run.sh also sources THIS guard so a scenario executed OUTSIDE
# the harness (direct developer invocation with the operator HOME) fails
# closed instead of running against the real home. Fail closed: never fall
# through to the real HOME.

set -euo pipefail

_tt_scenario_guard_self="${BASH_SOURCE[0]}"
_tt_scenario_guard_var="$(cd "$(dirname "$_tt_scenario_guard_self")/../.." && pwd)/var"
# Caller (the run.sh / wrapper that sourced this file) captured at top level
# so the error names the right script even when raised from the assertion.
_tt_scenario_guard_caller="${BASH_SOURCE[1]:-}"

# fail_containment <message...> — loud, HOME-naming abort (exit 2).
fail_containment() {
  local caller_name
  caller_name="$(basename "${_tt_scenario_guard_caller:-$_tt_scenario_guard_self}")"
  echo "$caller_name: CONTAINMENT VIOLATION — refusing to run scenario code." >&2
  echo "$caller_name: $*" >&2
  echo "$caller_name: scenario code must run with HOME strictly inside torture-test/var" >&2
  echo "$caller_name: (the harness's contained TT_SCRIPTED_HOME — see torture-test/env/tt-env-scripted.sh)." >&2
  echo "$caller_name: offending HOME=${HOME:-<unset>}" >&2
  exit 2
}

# ── assertion: HOME is a real directory strictly under torture-test/var ──
[ -n "${HOME:-}" ] || fail_containment "HOME is unset."
[ -d "$HOME" ] || fail_containment "HOME is not a directory: $HOME"
TT_SCENARIO_HOME_REAL="$(cd "$HOME" && pwd -P)" \
  || fail_containment "cannot resolve HOME to a real path: $HOME"

mkdir -p "$_tt_scenario_guard_var"
[ -d "$_tt_scenario_guard_var" ] \
  || fail_containment "torture-test/var is not a directory: $_tt_scenario_guard_var"
tt_var_real="$(cd "$_tt_scenario_guard_var" && pwd -P)"

[ "$TT_SCENARIO_HOME_REAL" != "$tt_var_real" ] \
  || fail_containment "HOME is torture-test/var itself ($tt_var_real), not a contained child home."
case "$TT_SCENARIO_HOME_REAL/" in
  "$tt_var_real"/*) ;;
  *)
    fail_containment "HOME ($TT_SCENARIO_HOME_REAL) is NOT strictly under torture-test/var ($tt_var_real)."
    ;;
esac
