# tt-env-scripted.sh — SPAWN environment for the SCRIPTED (zero-token,
# deterministic-agent) torture daemon. Spec 01 §two-daemons: harness
# binaries are resolved from the DAEMON's env, so scripted scenarios need
# their own daemon on its own ports with its own fake HOME.
#
# Apply per-command, never source into the controller's shell.

_tt_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

TT_REPO_ROOT="${TT_REPO_ROOT:-$(_tt_repo_root)}"
export TT_REPO_ROOT
export TT_ROOT="$TT_REPO_ROOT/torture-test/var"
export TT_SCRIPTED_HOME="$TT_ROOT/home-scripted"

export HOME="$TT_SCRIPTED_HOME"
export TAMANDUA_STATE_DIR="$TT_SCRIPTED_HOME/.tamandua"
export TAMANDUA_CONTROL_PORT=5339
export TAMANDUA_MCP_PORT=5338
export TAMANDUA_DASHBOARD_PORT=5334
export HERMES_HOME="$TT_SCRIPTED_HOME/.hermes"
# TAMANDUA_TEST_GUARD is intentionally NOT set here.
# See tt-env.sh for the rationale.

# Scripted harness binaries (wrappers with absolute node paths — the
# daemon PATH is not guaranteed; the runtimes are the P3/Phase-D
# deliverable under torture-test/scripted-runtimes/).
export TAMANDUA_PI_BINARY="$TT_REPO_ROOT/torture-test/scripted-runtimes/bin/scripted-pi"
export TAMANDUA_HERMES_BINARY="$TT_REPO_ROOT/torture-test/scripted-runtimes/bin/scripted-hermes"

# Node resolution must survive the HOME override (Volta shims key off
# HOME/VOLTA_HOME — see tt-env.sh for the incident note).
#
# resolve_operator_home — the OPERATOR's real home directory, resolved
# INDEPENDENTLY of $HOME (this script overrides HOME to the contained
# TT_SCRIPTED_HOME — deriving the volta/node paths from $HOME would point
# them at the contained home). MACP4 US-004 fallback chain (the
# tt-provision-home convention, extended with the shell tilde step):
#   1. getent passwd <uid>            (linux passwd db)
#   2. dscl . -read /Users/<user> NFSHomeDirectory
#                                     (macOS directory service — getent absent)
#   3. shell tilde expansion of the named user (`eval echo ~<user>`)
#                                     (works with no getent AND no dscl)
#   4. $HOME last resort
resolve_operator_home() {
  local pw_home
  pw_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
  if [ -n "$pw_home" ]; then
    printf '%s' "$pw_home"
    return 0
  fi
  # macOS fallback: getent is absent; read the NFS home directory via dscl.
  if command -v dscl >/dev/null 2>&1; then
    pw_home="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
    if [ -n "$pw_home" ]; then
      printf '%s' "$pw_home"
      return 0
    fi
  fi
  # Shell tilde expansion of the named user — no getent, no dscl needed.
  # An unknown user leaves the literal `~<user>` (or a bare `~` when the
  # command substitution is empty); only a real absolute home is accepted.
  pw_home="$(eval echo ~"$(id -un)" 2>/dev/null || true)"
  case "$pw_home" in
    '~'*|'') ;; # unknown user / empty — fall through
    *) printf '%s' "$pw_home"; return 0 ;;
  esac
  printf '%s' "${HOME:-}"
}
_tt_real_home="$(resolve_operator_home)"
if [ -d "$_tt_real_home/.volta" ]; then
  export VOLTA_HOME="$_tt_real_home/.volta"
fi
_tt_node_bin="$(command -v volta >/dev/null 2>&1 && volta which node 2>/dev/null || command -v node 2>/dev/null)"
case "$_tt_node_bin" in
  */.volta/bin/node) _tt_node_bin="$VOLTA_HOME/bin/node" ;;
esac
if [ -n "$_tt_node_bin" ] && [ -x "$_tt_node_bin" ]; then
  # MACP6 US-002: export TT_NODE_BIN so the scripted shims (scripted-pi /
  # scripted-hermes) always have an absolute, executable node path even when
  # the contained daemon's PATH is reconstructed and cannot resolve node.
  # Left unset when no node resolves — the shims' fail-closed error covers
  # the no-node host.
  export TT_NODE_BIN="$_tt_node_bin"
  export TT_NODE_BIN_DIR="$(dirname "$_tt_node_bin")"
  export PATH="$TT_NODE_BIN_DIR:$PATH"
fi

if [ "${1:-}" = "print" ]; then
  for v in TT_REPO_ROOT TT_ROOT TT_SCRIPTED_HOME HOME TAMANDUA_STATE_DIR \
           TAMANDUA_CONTROL_PORT TAMANDUA_MCP_PORT TAMANDUA_DASHBOARD_PORT \
           HERMES_HOME TAMANDUA_PI_BINARY \
           TAMANDUA_HERMES_BINARY VOLTA_HOME TT_NODE_BIN TT_NODE_BIN_DIR PATH; do
    printf '%s=%s\n' "$v" "$(eval "printf '%s' \"\$$v\"")"
  done
fi
