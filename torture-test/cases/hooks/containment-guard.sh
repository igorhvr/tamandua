#!/usr/bin/env bash
# torture-test/cases/hooks/containment-guard.sh
#
# Shared FIX10 US-002 fail-closed HOME containment guard for tier0 hooks.
#
# Source from a hook (or a self-test) to assert, BEFORE any git config
# write or HOME-side-effect, that $HOME is a real directory STRICTLY
# inside torture-test/var (realpath comparison). On violation it prints a
# loud, HOME-naming error to stderr and exits 2. After it returns, the
# caller may use fail_containment and $tt_var_real for belt-and-suspenders
# checks (e.g. verifying GIT_CONFIG_GLOBAL resolves under var).
#
# WHY: run-w0.1 executes the --global git-config write with
# GIT_CONFIG_GLOBAL=$HOME/.gitconfig — git resolves the write target from
# $HOME, so an UNCONTAINED HOME writes the OPERATOR's real ~/.gitconfig.
# That is exactly the 2026-08-05 breach (the Tamandua Tier-0 identity
# overwrote the operator's gitconfig while preserving unrelated sections).
# When a hook is invoked outside the controller (direct developer
# invocation — the FIX8 acceptance path — or a standalone tt-hook-runner
# with env: process.env), $HOME is the operator's real home. Fail closed:
# never fall through to the real HOME.

set -euo pipefail

_tt_guard_self="${BASH_SOURCE[0]}"
_tt_guard_repo_root="$(cd "$(dirname "$_tt_guard_self")/../../.." && pwd)"
TT_VAR_GUARD_VAR="$_tt_guard_repo_root/torture-test/var"
# Caller (the hook that sourced this file) captured at top level so the
# error names the right script even when the failure is raised from the
# assertion block below.
_tt_guard_caller="${BASH_SOURCE[1]:-}"

# fail_containment <message...> — loud, HOME-naming abort (exit 2).
fail_containment() {
  local hook_name
  hook_name="$(basename "${_tt_guard_caller:-$_tt_guard_self}")"
  echo "$hook_name: CONTAINMENT VIOLATION — refusing to run." >&2
  echo "$hook_name: $*" >&2
  echo "$hook_name: this hook must run with HOME strictly inside torture-test/var" >&2
  echo "$hook_name: (the controller's contained TT_SCRIPTED_HOME — see torture-test/env/tt-env-scripted.sh)." >&2
  echo "$hook_name: offending HOME=${HOME:-<unset>}" >&2
  exit 2
}

# ── assertion: HOME is a real directory strictly under torture-test/var ──
[ -n "${HOME:-}" ] || fail_containment "HOME is unset."
[ -d "$HOME" ] || fail_containment "HOME is not a directory: $HOME"
TT_HOME_REAL="$(cd "$HOME" && pwd -P)" \
  || fail_containment "cannot resolve HOME to a real path: $HOME"

mkdir -p "$TT_VAR_GUARD_VAR"
[ -d "$TT_VAR_GUARD_VAR" ] \
  || fail_containment "torture-test/var is not a directory: $TT_VAR_GUARD_VAR"
tt_var_real="$(cd "$TT_VAR_GUARD_VAR" && pwd -P)"

[ "$TT_HOME_REAL" != "$tt_var_real" ] \
  || fail_containment "HOME is torture-test/var itself ($tt_var_real), not a contained child home."
case "$TT_HOME_REAL/" in
  "$tt_var_real"/*) ;;
  *)
    fail_containment "HOME ($TT_HOME_REAL) is NOT strictly under torture-test/var ($tt_var_real)."
    ;;
esac
