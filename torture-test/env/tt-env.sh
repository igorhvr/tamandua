# tt-env.sh — SPAWN environment for the REAL torture daemons/CLI/harnesses.
#
# Never source this into the controller's own shell (spec 01: it would
# sever the operator's profile hooks). Apply it per-command:
#   env $(torture-test/env/tt-env.sh print) tamandua ...
# or source it inside a subshell that only runs spawned processes.
#
# TT_ROOT lives INSIDE the repo (torture-test/var, gitignored) so the
# whole suite is contained in torture-test/.

_tt_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

TT_REPO_ROOT="${TT_REPO_ROOT:-$(_tt_repo_root)}"
export TT_REPO_ROOT
export TT_ROOT="$TT_REPO_ROOT/torture-test/var"
export TT_HOME="$TT_ROOT/home"

export HOME="$TT_HOME"
export TAMANDUA_STATE_DIR="$TT_HOME/.tamandua"
# Do NOT also set TAMANDUA_DB_PATH / TAMANDUA_WORKTREE_ROOT: the code
# DERIVES them from HOME/STATE_DIR (spec 01 — setting both invites
# split-brain the day one is edited and the other is not).
export TAMANDUA_CONTROL_PORT=4339
export TAMANDUA_MCP_PORT=4338
export TAMANDUA_DASHBOARD_PORT=4334
export HERMES_HOME="$TT_HOME/.hermes"
export TAMANDUA_TEST_GUARD=1

# Helper: print the env as KEY=VALUE pairs for `env $(...)` composition.
if [ "${1:-}" = "print" ]; then
  for v in TT_REPO_ROOT TT_ROOT TT_HOME HOME TAMANDUA_STATE_DIR \
           TAMANDUA_CONTROL_PORT TAMANDUA_MCP_PORT TAMANDUA_DASHBOARD_PORT \
           HERMES_HOME TAMANDUA_TEST_GUARD; do
    printf '%s=%s\n' "$v" "$(eval "printf '%s' \"\$$v\"")"
  done
fi
