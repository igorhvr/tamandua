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
export TAMANDUA_TEST_GUARD=1

# Scripted harness binaries (wrappers with absolute node paths — the
# daemon PATH is not guaranteed; the runtimes are the P3/Phase-D
# deliverable under torture-test/scripted-runtimes/).
export TAMANDUA_PI_BINARY="$TT_REPO_ROOT/torture-test/scripted-runtimes/bin/scripted-pi"
export TAMANDUA_HERMES_BINARY="$TT_REPO_ROOT/torture-test/scripted-runtimes/bin/scripted-hermes"

if [ "${1:-}" = "print" ]; then
  for v in TT_REPO_ROOT TT_ROOT TT_SCRIPTED_HOME HOME TAMANDUA_STATE_DIR \
           TAMANDUA_CONTROL_PORT TAMANDUA_MCP_PORT TAMANDUA_DASHBOARD_PORT \
           HERMES_HOME TAMANDUA_TEST_GUARD TAMANDUA_PI_BINARY \
           TAMANDUA_HERMES_BINARY; do
    printf '%s=%s\n' "$v" "$(eval "printf '%s' \"\$$v\"")"
  done
fi
