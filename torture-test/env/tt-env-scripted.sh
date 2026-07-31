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
_tt_real_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
_tt_real_home="${_tt_real_home:-/home/$(id -un)}"
if [ -d "$_tt_real_home/.volta" ]; then
  export VOLTA_HOME="$_tt_real_home/.volta"
fi
_tt_node_bin="$(command -v volta >/dev/null 2>&1 && volta which node 2>/dev/null || command -v node 2>/dev/null)"
case "$_tt_node_bin" in
  */.volta/bin/node) _tt_node_bin="$VOLTA_HOME/bin/node" ;;
esac
if [ -n "$_tt_node_bin" ] && [ -x "$_tt_node_bin" ]; then
  export TT_NODE_BIN_DIR="$(dirname "$_tt_node_bin")"
  export PATH="$TT_NODE_BIN_DIR:$PATH"
fi

if [ "${1:-}" = "print" ]; then
  for v in TT_REPO_ROOT TT_ROOT TT_SCRIPTED_HOME HOME TAMANDUA_STATE_DIR \
           TAMANDUA_CONTROL_PORT TAMANDUA_MCP_PORT TAMANDUA_DASHBOARD_PORT \
           HERMES_HOME TAMANDUA_PI_BINARY \
           TAMANDUA_HERMES_BINARY VOLTA_HOME TT_NODE_BIN_DIR PATH; do
    printf '%s=%s\n' "$v" "$(eval "printf '%s' \"\$$v\"")"
  done
fi
