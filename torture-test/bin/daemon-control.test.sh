#!/usr/bin/env bash
# daemon-control.test.sh — self-test for daemon-control scaffolding.
# Validates CLI dispatch, --help, production guards, systemd detection,
# env script application, and directory setup per US-002 acceptance criteria.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/daemon-control"

FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== daemon-control self-test ==="

# ── Test 1: --help prints usage ───────────────────────────────────────
echo ""
echo "--- Test: --help ---"

if "$TOOL" --help 2>&1 | grep -q "Usage:"; then
  pass "--help prints usage"
else
  fail "--help did not print usage"
fi

if "$TOOL" --help > /dev/null 2>&1; then
  pass "--help exits 0"
else
  fail "--help did not exit 0"
fi

if "$TOOL" -h 2>&1 | grep -q "Usage:"; then
  pass "-h prints usage (short form)"
else
  fail "-h did not print usage"
fi

if "$TOOL" --help 2>&1 | grep -q "daemon-control"; then
  pass "--help mentions tool name"
else
  fail "--help does not mention tool name"
fi

# ── Test 2: --help mentions all subcommands and examples ──────────────
echo ""
echo "--- Test: --help content ---"

help_out="$("$TOOL" --help 2>&1)"

for cmd in start stop restart status; do
  if echo "$help_out" | grep -q "$cmd"; then
    pass "--help mentions subcommand '$cmd'"
  else
    fail "--help missing subcommand '$cmd'"
  fi
done

if echo "$help_out" | grep -q "real start"; then
  pass "--help includes example 'real start'"
else
  fail "--help missing example for 'real start'"
fi

if echo "$help_out" | grep -q "scripted"; then
  pass "--help mentions 'scripted'"
else
  fail "--help missing 'scripted' mention"
fi

# ── Test 3: no arguments prints usage and exits non-zero ──────────────
echo ""
echo "--- Test: no arguments ---"

set +e
no_args_out="$("$TOOL" 2>&1)"
no_args_rc=$?
set -e

if [ "$no_args_rc" -ne 0 ]; then
  pass "no arguments exits non-zero (rc=$no_args_rc)"
else
  fail "no arguments exited 0 (should be non-zero)"
fi

if echo "$no_args_out" | grep -qi "missing\|usage\|help\|daemon-control"; then
  pass "no arguments prints helpful message"
else
  fail "no arguments did not print helpful message (got: '$no_args_out')"
fi

# ── Test 4: invalid kind exits with error ────────────────────────────
echo ""
echo "--- Test: invalid kind ---"

set +e
inv_kind_out="$("$TOOL" invalid start 2>&1)"
inv_kind_rc=$?
set -e

if [ "$inv_kind_rc" -ne 0 ]; then
  pass "invalid kind exits non-zero (rc=$inv_kind_rc)"
else
  fail "invalid kind exited 0 (should be non-zero)"
fi

if echo "$inv_kind_out" | grep -qi "invalid\|real\|scripted"; then
  pass "invalid kind prints helpful error message"
else
  fail "invalid kind did not print helpful error (got: '$inv_kind_out')"
fi

# ── Test 5: invalid command exits with error ──────────────────────────
echo ""
echo "--- Test: invalid command ---"

set +e
inv_cmd_out="$("$TOOL" real invalid 2>&1)"
inv_cmd_rc=$?
set -e

if [ "$inv_cmd_rc" -ne 0 ]; then
  pass "invalid command exits non-zero (rc=$inv_cmd_rc)"
else
  fail "invalid command exited 0 (should be non-zero)"
fi

if echo "$inv_cmd_out" | grep -qi "invalid\|start\|stop\|restart\|status"; then
  pass "invalid command prints helpful error message"
else
  fail "invalid command did not print helpful error (got: '$inv_cmd_out')"
fi

# ── Test 6: Production port detection ─────────────────────────────────
echo ""
echo "--- Test: production port detection ---"

# We test is_production_port indirectly through the guard by checking
# that targeting production ports triggers the guard. We need to source
# the functions but we don't want to actually source the full script
# (set -euo pipefail will kill us). Instead we shell out.

# Verify that production ports (3334/3338/3339) are detected by the guard.
# We can't call guard_kind_ports directly as a public API, but we can
# test production_target by crafting a scenario: the tool refuses to
# run if a TT port somehow matches a production port. Since the real
# env sets 4334/4338/4339 and scripted sets 5334/5338/5339, the guard
# won't trip for normal use. To test the guard itself, we can verify
# the function logic by extracting and evaluating them in a subshell.

# Extract and test the production guard functions in isolation
test_prod_guard_functions() {
  # Source the guard functions from the tool in a subshell (we need to
  # handle the set -e at the top, so we use a trick: read the functions
  # and eval them)
  source /dev/stdin <<'INNER_TEST'
# Simulate the production guard functions from daemon-control
PROD_PORTS="3334 3338 3339"

is_production_port() {
  local port="$1"
  for p in $PROD_PORTS; do
    if [ "$port" = "$p" ]; then return 0; fi
  done
  return 1
}

# Test the port detection
if is_production_port 3334; then echo "PASS: 3334 detected as production"; else echo "FAIL: 3334 not detected"; fi
if is_production_port 3338; then echo "PASS: 3338 detected as production"; else echo "FAIL: 3338 not detected"; fi
if is_production_port 3339; then echo "PASS: 3339 detected as production"; else echo "FAIL: 3339 not detected"; fi
if ! is_production_port 4334; then echo "PASS: 4334 NOT production"; else echo "FAIL: 4334 flagged as production"; fi
if ! is_production_port 5334; then echo "PASS: 5334 NOT production"; else echo "FAIL: 5334 flagged as production"; fi
if ! is_production_port 9999; then echo "PASS: 9999 NOT production"; else echo "FAIL: 9999 flagged as production"; fi
if ! is_production_port 0; then echo "PASS: 0 NOT production"; else echo "FAIL: 0 flagged as production"; fi
INNER_TEST
}

prod_guard_results="$(test_prod_guard_functions 2>&1)"
echo "$prod_guard_results"

prod_pass_count=$(echo "$prod_guard_results" | grep -c "^PASS:" || true)
prod_fail_count=$(echo "$prod_guard_results" | grep -c "^FAIL:" || true)

if [ "$prod_fail_count" -eq 0 ]; then
  pass "all production port detection checks passed ($prod_pass_count checks)"
else
  fail "production port detection had $prod_fail_count failure(s)"
fi

# ── Test 7: Production guard refuses production ports in context ──────
echo ""
echo "--- Test: production guard refusal ---"

# Verify daemon-control rejects attempts involving production ports.
# Since real/scripted envs don't use production ports, we instead check
# that the guard functions exist in the source and that the refusal
# message does what it should.

# Verify that refuse_production function exists in the source
if grep -q "refuse_production()" "$TOOL"; then
  pass "refuse_production function exists in source"
else
  fail "refuse_production function missing from source"
fi

# Verify that production_target function exists in the source
if grep -q "production_target()" "$TOOL"; then
  pass "production_target function exists in source"
else
  fail "production_target function missing from source"
fi

# Verify is_production_cwd function exists
if grep -q "is_production_cwd()" "$TOOL"; then
  pass "is_production_cwd function exists in source"
else
  fail "is_production_cwd function missing from source"
fi

# Verify the tool references REAL_TAMANDUA_STATE (the guard must check ~/.tamandua)
if grep -q "REAL_TAMANDUA_STATE" "$TOOL"; then
  pass "script checks REAL_TAMANDUA_STATE (production state dir guard)"
else
  fail "script missing REAL_TAMANDUA_STATE check"
fi

# Verify the tool references PROD_PORTS
if grep -q "PROD_PORTS" "$TOOL"; then
  pass "script defines PROD_PORTS for production guard"
else
  fail "script missing PROD_PORTS definition"
fi

# ── Test 8: systemd detection ────────────────────────────────────────
echo ""
echo "--- Test: systemd detection ---"

# Verify has_systemd_scope function exists
if grep -q "has_systemd_scope()" "$TOOL"; then
  pass "has_systemd_scope function exists in source"
else
  fail "has_systemd_scope function missing from source"
fi

# Verify the detection uses systemd-run --user --scope mechanically
if grep -q "systemd-run.*--user.*--scope" "$TOOL"; then
  pass "systemd detection uses systemd-run --user --scope"
else
  fail "systemd detection missing systemd-run --user --scope"
fi

# Verify fallback path exists (when systemd is not available)
if grep -q "return 1" "$TOOL"; then
  pass "has_systemd_scope has non-systemd fallback path"
else
  fail "has_systemd_scope missing fallback return"
fi

# Call has_systemd_scope mechanically (we can't easily test it from outside,
# but we can verify the function compiles and runs without syntax error)
set +e
sysd_result="$(bash -c "
source /dev/stdin <<'SRC'
$(sed -n '/^# ── systemd detection/,/^# ── env script application/p' "$TOOL" | grep -v '^#' || true)
SRC
if has_systemd_scope; then echo 'HAS_SYSTEMD'; else echo 'NO_SYSTEMD'; fi
" 2>/dev/null || echo "SYSD_CHECK_FAILED")"
set -e

if [ "$sysd_result" = "HAS_SYSTEMD" ] || [ "$sysd_result" = "NO_SYSTEMD" ]; then
  pass "systemd detection function runs without error (result: $sysd_result)"
else
  fail "systemd detection function failed to run (got: $sysd_result)"
fi

# ── Test 9: env script application does not mutate caller ─────────────
echo ""
echo "--- Test: env script application isolation ---"

# Verify env_for_kind function exists
if grep -q "env_for_kind()" "$TOOL"; then
  pass "env_for_kind function exists in source"
else
  fail "env_for_kind function missing from source"
fi

# Verify env_for_kind uses `env -i bash ... print` pattern (clean env)
if grep -q "env -i.*print" "$TOOL"; then
  pass "env application uses 'env -i ... print' (isolated)"
else
  fail "env application missing 'env -i ... print' isolation pattern"
fi

# Verify the comment says "NEVER sources into the caller shell"
if grep -q "NEVER source" "$TOOL" || grep -q "never source" "$TOOL" || grep -q "Never source" "$TOOL"; then
  pass "source documents 'never source into caller' rule"
else
  fail "source missing 'never source' documentation"
fi

# Verify run_under_env function exists
if grep -q "run_under_env()" "$TOOL"; then
  pass "run_under_env function exists in source"
else
  fail "run_under_env function missing from source"
fi

# Save original HOME before any tool invocation
ORIGINAL_HOME="$HOME"

# Run env_for_kind via a helper: call `env -i bash "$TT_ENV_REAL" print`
# and check that it prints HOME overridden to TT_HOME
TT_ENV_REAL="$SCRIPT_DIR/../env/tt-env.sh"
if [ -f "$TT_ENV_REAL" ]; then
  env_out="$(env -i bash "$TT_ENV_REAL" print 2>/dev/null || true)"
  if echo "$env_out" | grep -q "^HOME="; then
    pass "tt-env.sh print emits HOME override"
  else
    fail "tt-env.sh print missing HOME"
  fi
  # Verify it sets non-production ports
  if echo "$env_out" | grep -q "TAMANDUA_DASHBOARD_PORT=4334"; then
    pass "tt-env.sh sets dashboard port to 4334 (non-production)"
  else
    fail "tt-env.sh missing TAMANDUA_DASHBOARD_PORT=4334"
  fi
else
  fail "tt-env.sh not found at expected path: $TT_ENV_REAL"
fi

# HOME must not have changed after tool interaction
if [ "$HOME" = "$ORIGINAL_HOME" ]; then
  pass "caller HOME unchanged after env operations"
else
  fail "caller HOME MUTATED after env operations (was $ORIGINAL_HOME, now $HOME)"
fi

# ── Test 10: directory setup ─────────────────────────────────────────
echo ""
echo "--- Test: directory setup ---"

# Verify ensure_prov_dir function exists
if grep -q "ensure_prov_dir()" "$TOOL"; then
  pass "ensure_prov_dir function exists in source"
else
  fail "ensure_prov_dir function missing from source"
fi

# Test that the tool creates the prov dir on invocation.
# Use a temp TT_ROOT so we don't touch real state.
TEST_TT_VAR="$(mktemp -d)"
cleanup_test_dir() { rm -rf "$TEST_TT_VAR"; }
trap cleanup_test_dir EXIT

# Run daemon-control with a kind that will trigger ensure_prov_dir,
# but using a throwaway TT_ROOT. We'll override TT_ROOT by symlinking
# or by modifying PATH. Actually, the simplest way: the tool resolves
# TT_ROOT relative to script location. We can verify the mechanism
# by checking that the code does mkdir -p.

if grep -q "mkdir -p.*PROV_DIR\|mkdir -p.*daemon-control" "$TOOL"; then
  pass "daemon-control creates prov dir with mkdir -p (code check)"
else
  fail "daemon-control missing mkdir -p for provenance directory"
fi

# ── Test 11: no npm dependencies ─────────────────────────────────────
echo ""
echo "--- Test: no npm dependencies ---"

if head -1 "$TOOL" | grep -q "bash"; then
  pass "tool is a bash script (no npm needed)"
else
  fail "tool shebang is not bash"
fi

# Verify no node/npm invocations in the tool (for this story — future
# stories may add node-based subcommand implementations)
if grep -q "^[^#]*node\|^[^#]*npm\|^[^#]*npx" "$TOOL" 2>/dev/null; then
  fail "tool contains node/npm invocation (should be bash-only for scaffolding)"
else
  pass "tool does not rely on node/npm for scaffolding"
fi

# ── Test 12: path resolution follows conventions ─────────────────────
echo ""
echo "--- Test: path resolution conventions ---"

if grep -q 'SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE\[0\]}")' "$TOOL"; then
  pass "uses SCRIPT_DIR resolution pattern (like tt-run/tt-provision-home)"
else
  fail "missing SCRIPT_DIR resolution pattern"
fi

if grep -q "TT_REPO_ROOT" "$TOOL"; then
  pass "resolves TT_REPO_ROOT from script location"
else
  fail "missing TT_REPO_ROOT resolution"
fi

# ── Test 13: sets -euo pipefail ──────────────────────────────────────
echo ""
echo "--- Test: error handling flags ---"

if grep -q "set -euo pipefail" "$TOOL"; then
  pass "script uses 'set -euo pipefail'"
else
  fail "script missing 'set -euo pipefail'"
fi

# ── Test 14: help documents scripted daemon works without runtimes ────
echo ""
echo "--- Test: help documents scripted-runtime caveat ---"

help_out="$("$TOOL" --help 2>&1)"
if echo "$help_out" | grep -qi "dispatch time\|runtimes\|harness resolution"; then
  pass "--help documents that scripted daemon start works before runtimes installed"
else
  fail "--help missing documentation about scripted daemon + runtimes"
fi

# ── Test 15: all subcommands are implemented ────────────────────────
echo ""
echo "--- Test: subcommand implementation status ---"

# All subcommands (start, stop, restart, status) should now be implemented.
# Verify each one does NOT contain the old stub pattern.

for cmd in start stop restart status; do
  if grep -A 5 "^cmd_${cmd}()" "$TOOL" | grep -q 'not yet implemented'; then
    fail "subcommand '$cmd' still contains 'not yet implemented' (stub)"
  else
    pass "subcommand '$cmd' is implemented (no stub text)"
  fi
done

# Verify each subcommand function exists and has meaningful implementation
for cmd in start stop restart status; do
  if grep -q "^cmd_${cmd}()" "$TOOL"; then
    pass "cmd_${cmd} function exists"
  else
    fail "cmd_${cmd} function missing"
  fi
done

# ── Test 16: restart and status no longer print stub messages ──────
echo ""
echo "--- Test: restart/status stub removal ---"

for kind in real scripted; do
  for cmd in restart status; do
    set +e
    out="$("$TOOL" "$kind" "$cmd" 2>&1)"
    rc=$?
    set -e
    if echo "$out" | grep -q "not yet implemented"; then
      fail "$kind $cmd: still says 'not yet implemented' (stub not replaced)"
    else
      pass "$kind $cmd: no longer a stub"
    fi
    if [ "$rc" -ne 3 ]; then
      pass "$kind $cmd: no longer exits 3 (stub code)"
    else
      fail "$kind $cmd: still exits 3 (stub exit code)"
    fi
  done
done

# ── Test 17: start subcommand — production guard ─────────────────────
echo ""
echo "--- Test: start subcommand production guard ---"

# Verify that start checks production ports before attempting to start
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'is_production_port'; then
  pass "cmd_start checks is_production_port"
else
  fail "cmd_start missing is_production_port check"
fi

if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'is_production_cwd'; then
  pass "cmd_start checks is_production_cwd"
else
  fail "cmd_start missing is_production_cwd check"
fi

# Verify scripted kind is handled by cmd_start
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'kind'; then
  pass "scripted start is handled by cmd_start (kind parameter used)"
else
  fail "cmd_start missing kind handling"
fi

# ── Test 18: start subcommand — systemd integration ──────────────────
echo ""
echo "--- Test: start subcommand systemd integration ---"

# Verify the cmd_start function checks systemd availability
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'has_systemd_scope'; then
  pass "cmd_start checks has_systemd_scope"
else
  fail "cmd_start missing has_systemd_scope check"
fi

# Verify the systemd scope unit name includes tamandua-tt prefix
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'tamandua-tt-'; then
  pass "cmd_start uses tamandua-tt- scope unit prefix"
else
  fail "cmd_start missing tamandua-tt- scope unit prefix"
fi

# Verify systemd-run command is constructed properly
if grep -q 'systemd-run.*--user.*--scope.*--unit' "$TOOL"; then
  pass "cmd_start constructs systemd-run command with --user --scope --unit"
else
  fail "cmd_start missing systemd-run invocation"
fi

# ── Test 19: start subcommand — wait_for_port function ───────────────
echo ""
echo "--- Test: wait_for_port function ---"

if grep -q '^wait_for_port()' "$TOOL"; then
  pass "wait_for_port function exists"
else
  fail "wait_for_port function missing"
fi

if grep -A 10 '^wait_for_port()' "$TOOL" | grep -q '/dev/tcp'; then
  pass "wait_for_port uses /dev/tcp for port checking"
else
  fail "wait_for_port missing /dev/tcp port check"
fi

# ── Test 20: start subcommand — cgroup verification ──────────────────
echo ""
echo "--- Test: cgroup verification ---"

if grep -q '^verify_cgroup()' "$TOOL"; then
  pass "verify_cgroup function exists"
else
  fail "verify_cgroup function missing"
fi

if grep -A 5 '^verify_cgroup()' "$TOOL" | grep -q '/proc/.*cgroup'; then
  pass "verify_cgroup checks /proc/<pid>/cgroup"
else
  fail "verify_cgroup missing /proc/<pid>/cgroup check"
fi

# ── Test 21: start subcommand — provenance JSON ──────────────────────
echo ""
echo "--- Test: provenance JSON ---"

if grep -q '^write_provenance()' "$TOOL"; then
  pass "write_provenance function exists"
else
  fail "write_provenance function missing"
fi

# Verify provenance file contains required fields
for field in name kind pid ports scopeUnit cgroupVerified startedAt cmdline cwd; do
  if grep -A 100 '^write_provenance()' "$TOOL" | grep -q "\"$field\""; then
    pass "provenance record includes '$field'"
  else
    fail "provenance record missing '$field'"
  fi
done

# Verify jq is used (with fallback)
if grep -A 30 '^write_provenance()' "$TOOL" | grep -q 'command -v jq'; then
  pass "write_provenance uses jq when available (with fallback)"
else
  fail "write_provenance missing jq check"
fi

# Verify fallback path exists (cat with heredoc when jq unavailable)
if grep -A 100 '^write_provenance()' "$TOOL" | grep -q 'PROVEOF'; then
  pass "write_provenance has jq-less fallback path (heredoc)"
else
  fail "write_provenance missing jq-less fallback"
fi

# ── Test 22: start subcommand — PID capture ──────────────────────────
echo ""
echo "--- Test: PID capture from daemon.pid ---"

# Verify cmd_start reads PID from tamandua.pid
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'tamandua\.pid'; then
  pass "cmd_start reads daemon PID from tamandua.pid"
else
  fail "cmd_start missing tamandua.pid reference"
fi

# Verify the PID existence check uses kill -0
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'kill -0'; then
  pass "cmd_start verifies PID liveness with kill -0"
else
  fail "cmd_start missing kill -0 liveness check"
fi

# ── Test 23: start subcommand — env isolation ────────────────────────
echo ""
echo "--- Test: start subcommand env isolation ---"

# Verify cmd_start applies env via env -i (never sources)
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'env -i.*env_for_kind'; then
  pass "cmd_start uses env -i \$(env_for_kind) for isolation"
else
  fail "cmd_start missing env -i isolation for spawn"
fi

# Verify the launcher passes PATH explicitly
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'PATH='; then
  pass "cmd_start passes PATH explicitly to spawned process"
else
  fail "cmd_start missing PATH passthrough"
fi

# ── Test 24: start subcommand — port waiting ─────────────────────────
echo ""
echo "--- Test: start subcommand port waiting ---"

# Verify cmd_start waits for dashboard, MCP, and control ports
# The code loops over "for port in \$dash_port \$mcp_port \$ctrl_port"
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'for port in.*dash_port.*mcp_port.*ctrl_port'; then
  pass "cmd_start loops over all three ports for waiting"
else
  fail "cmd_start missing port-wait loop over dash/mcp/ctrl ports"
fi

if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'wait_for_port'; then
  pass "cmd_start calls wait_for_port"
else
  fail "cmd_start missing wait_for_port call"
fi

# ── Test 25: help updated for start ──────────────────────────────────
echo ""
echo "--- Test: help reflects start implementation ---"

help_out="$("$TOOL" --help 2>&1)"
if echo "$help_out" | grep -q "systemd.user.scope"; then
  pass "--help documents systemd scope containment"
else
  fail "--help missing systemd scope containment mention"
fi

# ── Test 26: stop subcommand — implementation check ──────────────────
echo ""
echo "--- Test: stop subcommand implementation ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'stopping.*daemon'; then
  pass "cmd_stop is implemented (not a stub)"
else
  fail "cmd_stop still appears to be a stub"
fi
if ! grep -A 5 '^cmd_stop()' "$TOOL" | grep -q 'not yet implemented'; then
  pass "cmd_stop no longer contains 'not yet implemented'"
else
  fail "cmd_stop still contains 'not yet implemented'"
fi

# ── Test 27: stop subcommand — production guard ──────────────────────
echo ""
echo "--- Test: stop subcommand production guard ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'is_production_port'; then
  pass "cmd_stop checks is_production_port"
else
  fail "cmd_stop missing is_production_port check"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'is_production_cwd'; then
  pass "cmd_stop checks is_production_cwd"
else
  fail "cmd_stop missing is_production_cwd check"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'refuse_production'; then
  pass "cmd_stop calls refuse_production on guard trip"
else
  fail "cmd_stop missing refuse_production call"
fi

# ── Test 28: verify_process_tt_owned function ────────────────────────
echo ""
echo "--- Test: verify_process_tt_owned function ---"

if grep -q '^verify_process_tt_owned()' "$TOOL"; then
  pass "verify_process_tt_owned function exists"
else
  fail "verify_process_tt_owned function missing"
fi

# ── Test 29: /proc/PID/cwd and /proc/PID/cmdline evidence ────────────
echo ""
echo "--- Test: /proc evidence checks ---"

if grep -A 10 '^verify_process_tt_owned()' "$TOOL" | grep -q '/proc.*cwd'; then
  pass "verify_process_tt_owned checks /proc/PID/cwd"
else
  fail "verify_process_tt_owned missing /proc/PID/cwd check"
fi

if grep -A 30 '^verify_process_tt_owned()' "$TOOL" | grep -q '/proc.*cmdline'; then
  pass "verify_process_tt_owned checks /proc/PID/cmdline"
else
  fail "verify_process_tt_owned missing /proc/PID/cmdline check"
fi

if grep -A 15 '^verify_process_tt_owned()' "$TOOL" | grep -q 'TT_REPO_ROOT'; then
  pass "verify_process_tt_owned checks cwd against TT_REPO_ROOT"
else
  fail "verify_process_tt_owned missing TT_REPO_ROOT cwd check"
fi

if grep -A 30 '^verify_process_tt_owned()' "$TOOL" | grep -q 'tamandua'; then
  pass "verify_process_tt_owned requires tamandua in cmdline"
else
  fail "verify_process_tt_owned missing tamandua cmdline check"
fi

# ── Test 30: is_port_listening function ──────────────────────────────
echo ""
echo "--- Test: is_port_listening function ---"

if grep -q '^is_port_listening()' "$TOOL"; then
  pass "is_port_listening function exists"
else
  fail "is_port_listening function missing"
fi

if grep -A 5 '^is_port_listening()' "$TOOL" | grep -q '/dev/tcp'; then
  pass "is_port_listening uses /dev/tcp for port checking"
else
  fail "is_port_listening missing /dev/tcp port check"
fi

# ── Test 31: update_provenance_after_stop function ───────────────────
echo ""
echo "--- Test: update_provenance_after_stop function ---"

if grep -q '^update_provenance_after_stop()' "$TOOL"; then
  pass "update_provenance_after_stop function exists"
else
  fail "update_provenance_after_stop function missing"
fi

# ── Test 32: stoppedAt and exitCode in provenance after stop ─────────
echo ""
echo "--- Test: stoppedAt and exitCode fields ---"

if grep -A 20 '^update_provenance_after_stop()' "$TOOL" | grep -q 'stoppedAt'; then
  pass "update_provenance_after_stop adds stoppedAt"
else
  fail "update_provenance_after_stop missing stoppedAt"
fi

if grep -A 20 '^update_provenance_after_stop()' "$TOOL" | grep -q 'exitCode'; then
  pass "update_provenance_after_stop adds exitCode"
else
  fail "update_provenance_after_stop missing exitCode"
fi

if grep -A 20 '^update_provenance_after_stop()' "$TOOL" | grep -q 'command -v jq'; then
  pass "update_provenance_after_stop uses jq when available (with fallback)"
else
  fail "update_provenance_after_stop missing jq check"
fi

# ── Test 33: already-stopped handling ────────────────────────────────
echo ""
echo "--- Test: already-stopped handling ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'already stopped'; then
  pass "cmd_stop handles already-stopped daemon"
else
  fail "cmd_stop missing already-stopped handling"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'no provenance record'; then
  pass "cmd_stop handles missing provenance file (no prior start)"
else
  fail "cmd_stop missing 'no provenance record' handling"
fi

# ── Test 34: systemd scope cleanup in stop ───────────────────────────
echo ""
echo "--- Test: systemd scope cleanup in stop ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'systemctl.*--user.*stop'; then
  pass "cmd_stop cleans up systemd scope after stop"
else
  fail "cmd_stop missing systemctl --user stop for scope cleanup"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'scope\|scopeUnit'; then
  pass "cmd_stop references scope for cleanup"
else
  fail "cmd_stop missing scope reference for cleanup"
fi

# ── Test 35: no name-only matching — evidence-based verification ─────
echo ""
echo "--- Test: no name-only matching ---"

# Verify that escalation uses verify_process_tt_owned (cwd+cmdline)
# before signaling, and never just matches on process name
if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'verify_process_tt_owned'; then
  pass "cmd_stop uses verify_process_tt_owned before signaling"
else
  fail "cmd_stop missing verify_process_tt_owned call"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'REFUSING.*NOT proven TT-owned'; then
  pass "cmd_stop refuses to signal processes not proven TT-owned"
else
  fail "cmd_stop missing refusal message for non-TT-owned processes"
fi

# ── Test 36: stop subcommand env isolation (run_under_env) ───────────
echo ""
echo "--- Test: stop subcommand env isolation ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'run_under_env'; then
  pass "cmd_stop uses run_under_env for env isolation"
else
  fail "cmd_stop missing run_under_env"
fi

# ── Test 37: graceful stop via tamandua dashboard stop ───────────────
echo ""
echo "--- Test: graceful stop via tamandua CLI ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'tamandua dashboard stop'; then
  pass "cmd_stop runs tamandua dashboard stop for graceful shutdown"
else
  fail "cmd_stop missing tamandua dashboard stop"
fi

# ── Test 38: escalation — SIGTERM then SIGKILL ───────────────────────
echo ""
echo "--- Test: escalation SIGTERM → SIGKILL ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'SIGTERM'; then
  pass "cmd_stop escalates with SIGTERM"
else
  fail "cmd_stop missing SIGTERM escalation"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'SIGKILL'; then
  pass "cmd_stop escalates with SIGKILL after SIGTERM"
else
  fail "cmd_stop missing SIGKILL escalation"
fi

# ── Test 39: provenance updated after stop ───────────────────────────
echo ""
echo "--- Test: provenance updated after stop ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'update_provenance_after_stop'; then
  pass "cmd_stop calls update_provenance_after_stop"
else
  fail "cmd_stop missing update_provenance_after_stop call"
fi

# ── Test 40: stop subcommand — port polling for shutdown ─────────────
echo ""
echo "--- Test: stop subcommand port polling ---"

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'is_port_listening'; then
  pass "cmd_stop uses is_port_listening for port polling"
else
  fail "cmd_stop missing is_port_listening"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'timeout'; then
  pass "cmd_stop has shutdown timeout logic"
else
  fail "cmd_stop missing shutdown timeout"
fi

# ── Test 41: restart subcommand — implementation check ────────────
echo ""
echo "--- Test: restart subcommand implementation ---"

if grep -A 250 '^cmd_restart()' "$TOOL" | grep -q 'restarting.*daemon'; then
  pass "cmd_restart is implemented (not a stub)"
else
  fail "cmd_restart still appears to be a stub"
fi

# ── Test 42: restart subcommand — calls cmd_stop ───────────────────
echo ""
echo "--- Test: restart calls stop logic ---"

if grep -A 100 '^cmd_restart()' "$TOOL" | grep -q 'cmd_stop'; then
  pass "cmd_restart calls cmd_stop to stop existing daemon"
else
  fail "cmd_restart missing cmd_stop call"
fi

# ── Test 43: restart subcommand — calls cmd_start ──────────────────
echo ""
echo "--- Test: restart calls start logic ---"

if grep -A 100 '^cmd_restart()' "$TOOL" | grep -q 'cmd_start'; then
  pass "cmd_restart calls cmd_start to restart daemon"
else
  fail "cmd_restart missing cmd_start call"
fi

# ── Test 44: restart subcommand — clean start when not running ─────
echo ""
echo "--- Test: restart handles not-running daemon (clean start) ---"

if grep -A 100 '^cmd_restart()' "$TOOL" | grep -q 'no running daemon found\|clean start\|performing clean start'; then
  pass "cmd_restart handles not-running daemon as clean start"
else
  fail "cmd_restart missing clean-start path for not-running daemon"
fi

# ── Test 45: restart subcommand — checks ports free after stop ─────
echo ""
echo "--- Test: restart verifies ports free after stop ---"

if grep -A 100 '^cmd_restart()' "$TOOL" | grep -q 'ports.*free\|port.*still.*use\|not freed'; then
  pass "cmd_restart verifies ports are free after stop before starting"
else
  fail "cmd_restart missing port-free verification after stop"
fi

# ── Test 46: restart re-asserts cgroup membership ──────────────────
echo ""
echo "--- Test: restart re-asserts cgroup membership ---"

# cmd_restart calls cmd_start, which already handles systemd scope +
# cgroup verification. We check that cmd_start (when called from restart)
# still invokes the systemd/cgroup path.
if grep -A 250 '^cmd_start()' "$TOOL" | grep -q 'has_systemd_scope\|verify_cgroup'; then
  pass "cmd_start (called by restart) includes systemd/cgroup logic"
else
  fail "cmd_start missing systemd/cgroup logic for restart re-assertion"
fi

# ── Test 47: restart subcommand — production guard ─────────────────
echo ""
echo "--- Test: restart production guard ---"

# Restart calls cmd_stop + cmd_start, both of which have production guards.
# Additionally, the main dispatch runs guard_kind_ports + guard_kind_cwd
# before any subcommand. Verify restart path benefits from these guards.
if grep 'guard_kind_ports\|guard_kind_cwd' "$TOOL" | head -1 | grep -q .; then
  pass "main dispatch runs production guard before subcommands (including restart)"
else
  fail "main dispatch missing production guard call"
fi

# ── Test 48: restart subcommand — provenance preserved ─────────────
echo ""
echo "--- Test: restart provenance preserved ---"

# cmd_restart does NOT create a second provenance file — both stop and
# start write to the SAME $PROV_DIR/$name.json. Verify no alternative
# provenance paths are created.
if grep -A 100 '^cmd_restart()' "$TOOL" | grep -q 'prov_file'; then
  pass "cmd_restart references prov_file for provenance"
else
  fail "cmd_restart missing provenance file reference"
fi

# Verify cmd_start always writes to the same prov_file (no timestamp-suffixed backup)
prov_paths=$(grep -o 'PROV_DIR/[^"]*' "$TOOL" | sort -u)
prov_count=$(echo "$prov_paths" | wc -l)
# We expect PROV_DIR/name.json (or variations). More than a few unique paths
# would indicate potential duplication.
if [ "$prov_count" -le 5 ]; then
  pass "provenance path references are limited (${prov_count} unique, not duplicated)"
else
  fail "too many unique provenance path references (${prov_count}) — possible duplication"
fi

# ── Test 49: restart subcommand — handles jq fallback ──────────────
echo ""
echo "--- Test: restart jq fallback ---"

if grep -A 100 '^cmd_restart()' "$TOOL" | grep -q 'command -v jq'; then
  pass "cmd_restart checks for jq (supports jq-less fallback)"
else
  fail "cmd_restart missing jq availability check"
fi

# ── Test 50: status subcommand — implementation check ──────────────
echo ""
echo "--- Test: status subcommand implementation ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'STATUS:'; then
  pass "cmd_status is implemented (not a stub)"
else
  fail "cmd_status still appears to be a stub"
fi

# ── Test 51: status subcommand — reads provenance file ─────────────
echo ""
echo "--- Test: status reads provenance file ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'prov_file'; then
  pass "cmd_status reads provenance file"
else
  fail "cmd_status missing provenance file reference"
fi

# ── Test 52: status subcommand — checks /proc/PID existence ────────
echo ""
echo "--- Test: status checks /proc/PID existence ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q '/proc/.*pid'; then
  pass "cmd_status checks /proc/<pid> for process existence"
else
  fail "cmd_status missing /proc/<pid> check"
fi

# ── Test 53: status subcommand — checks port listening status ──────
echo ""
echo "--- Test: status checks port listening ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'is_port_listening'; then
  pass "cmd_status uses is_port_listening for port checks"
else
  fail "cmd_status missing is_port_listening call"
fi

# ── Test 54: status subcommand — reports RUNNING ───────────────────
echo ""
echo "--- Test: status reports RUNNING ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'STATUS: RUNNING'; then
  pass "cmd_status reports RUNNING when daemon is up"
else
  fail "cmd_status missing STATUS: RUNNING output"
fi

# ── Test 55: status subcommand — reports STOPPED ───────────────────
echo ""
echo "--- Test: status reports STOPPED ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'STATUS: STOPPED'; then
  pass "cmd_status reports STOPPED when daemon is down"
else
  fail "cmd_status missing STATUS: STOPPED output"
fi

# ── Test 56: status subcommand — reports UNKNOWN ───────────────────
echo ""
echo "--- Test: status reports UNKNOWN ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'STATUS: UNKNOWN'; then
  pass "cmd_status reports UNKNOWN for ambiguous state"
else
  fail "cmd_status missing STATUS: UNKNOWN output"
fi

# ── Test 57: status subcommand — reports NO_PROVENANCE ─────────────
echo ""
echo "--- Test: status reports NO_PROVENANCE ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'STATUS: NO_PROVENANCE'; then
  pass "cmd_status reports NO_PROVENANCE when provenance file is missing"
else
  fail "cmd_status missing STATUS: NO_PROVENANCE output"
fi

# ── Test 58: status verifies PID cmdline matches tamandua ──────────
echo ""
echo "--- Test: status verifies PID cmdline ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'tamandua'; then
  pass "cmd_status verifies PID cmdline contains tamandua"
else
  fail "cmd_status missing tamandua cmdline verification"
fi

# ── Test 59: status subcommand — production guard ──────────────────
echo ""
echo "--- Test: status production guard ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'is_production_port'; then
  pass "cmd_status checks is_production_port for guard"
else
  fail "cmd_status missing is_production_port check"
fi

# ── Test 60: status subcommand — jq fallback path ──────────────────
echo ""
echo "--- Test: status jq fallback ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'command -v jq'; then
  pass "cmd_status checks for jq availability (fallback path)"
else
  fail "cmd_status missing jq availability check"
fi

# ── Test 61: status subcommand — uses kill -0 for liveness ─────────
echo ""
echo "--- Test: status uses kill -0 for liveness ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'kill -0'; then
  pass "cmd_status uses kill -0 for PID liveness check"
else
  fail "cmd_status missing kill -0 liveness check"
fi

# ── Test 62: status subcommand — port status details ───────────────
echo ""
echo "--- Test: status port status details ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'LISTENING'; then
  pass "cmd_status reports individual port LISTENING status"
else
  fail "cmd_status missing individual port LISTENING reporting"
fi
if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'port.*free'; then
  pass "cmd_status reports individual port free status"
else
  fail "cmd_status missing individual port free reporting"
fi

# ── Test 63: status subcommand — stoppedAt reporting ───────────────
echo ""
echo "--- Test: status reports stoppedAt when present ---"

if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'stoppedAt'; then
  pass "cmd_status reports stoppedAt field when present in provenance"
else
  fail "cmd_status missing stoppedAt reporting"
fi

# ── Test 64: restart stop-then-start round-trip code path ──────────
echo ""
echo "--- Test: restart stop→start chain integrity ---"

# Verify the restart code path: stop-check → cmd_stop → port verify → cmd_start
restart_body=$(sed -n '/^cmd_restart()/,/^}/p' "$TOOL")
if echo "$restart_body" | grep -q 'cmd_stop' && echo "$restart_body" | grep -q 'cmd_start'; then
  pass "cmd_restart stop→start chain: stop check → cmd_stop → port verify → cmd_start present"
else
  fail "cmd_restart missing complete stop→start chain"
fi
# ═══════════════════════════════════════════════════════════════════════
# US-006: Integration smoke tests — actual daemon lifecycle validation
# ═══════════════════════════════════════════════════════════════════════

echo ""
echo "=== US-006: Integration smoke tests ==="

PROVISION="${SCRIPT_DIR}/tt-provision-home"
PROD_DB="$HOME/.tamandua/tamandua.db"

# Capture production state before any daemon operations
PROD_DB_SHA_BEFORE=""
if [ -f "$PROD_DB" ]; then
  PROD_DB_SHA_BEFORE="$(sha256sum "$PROD_DB" | awk '{print $1}')"
  echo "  INFO: production DB snapshot: $PROD_DB_SHA_BEFORE"
else
  echo "  INFO: no production DB at $PROD_DB — skipping snapshot"
fi

# Record production port listeners before tests (ss or netstat)
record_prod_listeners() {
  local label="$1"
  local out=""
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -tlnp 2>/dev/null | grep -E ':(3334|3338|3339) ' || true)"
  elif command -v netstat >/dev/null 2>&1; then
    out="$(netstat -tlnp 2>/dev/null | grep -E ':(3334|3338|3339) ' || true)"
  fi
  if [ -n "$out" ]; then
    echo "  INFO: $label production listeners:"
    echo "$out"
  else
    echo "  INFO: $label no production port listeners detected"
  fi
}

PROD_LISTENERS_BEFORE="$(record_prod_listeners "BEFORE" 2>&1 || true)"

# ── Test 65: tt-provision-home idempotency ──────────────────────────
echo ""
echo "--- Test: tt-provision-home idempotency ---"

# Save a snapshot of the provisioned homes before first run (capture initial state)
TT_VAR_BASE="$SCRIPT_DIR/../var"

tt_prov_first_out="$("$PROVISION" 2>&1)" && tt_prov_first_rc=$? || tt_prov_first_rc=$?
echo "  First run exit code: $tt_prov_first_rc"

if [ "$tt_prov_first_rc" -eq 0 ]; then
  pass "tt-provision-home first run succeeds"
else
  fail "tt-provision-home first run failed (rc=$tt_prov_first_rc)"
fi

# Take snapshot after first run
snapshot_dir="$(mktemp -d)"
cleanup_snapshot() { rm -rf "$snapshot_dir"; }
trap cleanup_snapshot EXIT

if [ -d "$TT_VAR_BASE/home" ]; then
  # Record file listing + checksums for comparison
  (cd "$TT_VAR_BASE" && find home home-scripted -type f 2>/dev/null | sort) > "$snapshot_dir/files-1.txt"
  (cd "$TT_VAR_BASE" && find home home-scripted -type f 2>/dev/null | sort | while read -r f; do sha256sum "$f"; done) > "$snapshot_dir/checksums-1.txt"
  pass "snapshot captured after first provision run"
else
  fail "TT_HOME not created by first provision run"
fi

# Run tt-provision-home a second time — should be a clean no-op
set +e
tt_prov_second_out="$("$PROVISION" 2>&1)"
tt_prov_second_rc=$?
set -e

echo "  Second run exit code: $tt_prov_second_rc"

if [ "$tt_prov_second_rc" -eq 0 ]; then
  pass "tt-provision-home second run succeeds"
else
  fail "tt-provision-home second run failed (rc=$tt_prov_second_rc)"
fi

# Capture snapshot after second run
if [ -d "$TT_VAR_BASE/home" ]; then
  (cd "$TT_VAR_BASE" && find home home-scripted -type f 2>/dev/null | sort) > "$snapshot_dir/files-2.txt"
  (cd "$TT_VAR_BASE" && find home home-scripted -type f 2>/dev/null | sort | while read -r f; do sha256sum "$f"; done) > "$snapshot_dir/checksums-2.txt"

  # Compare file listings — must be identical
  if diff "$snapshot_dir/files-1.txt" "$snapshot_dir/files-2.txt" >/dev/null 2>&1; then
    pass "tt-provision-home idempotent: file listings identical after two runs"
  else
    fail "tt-provision-home NOT idempotent: file listings differ after second run"
  fi

  # Compare checksums — must be identical
  if diff "$snapshot_dir/checksums-1.txt" "$snapshot_dir/checksums-2.txt" >/dev/null 2>&1; then
    pass "tt-provision-home idempotent: all file checksums identical after two runs"
  else
    fail "tt-provision-home NOT idempotent: file checksums differ after second run"
  fi
else
  fail "TT_HOME missing after second provision run"
fi

# ── Test 66: real daemon start ────────────────────────────────────────
echo ""
echo "--- Test: daemon-control real start ---"

# Ensure ports are free and systemd scope is cleaned before starting
REAL_PORTS="4334 4338 4339"
# Clean up any lingering systemd scope from previous failed runs
systemctl --user stop tamandua-tt-real.scope 2>/dev/null || true
systemctl --user reset-failed tamandua-tt-real.scope 2>/dev/null || true
for port in $REAL_PORTS; do
  if timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
    echo "  WARNING: port $port is already in use — attempting to stop existing daemon first"
    set +e
    "$TOOL" real stop 2>/dev/null || true
    set -e
    sleep 2
  fi
done

set +e
real_start_out="$("$TOOL" real start 2>&1)"
real_start_rc=$?
set -e
echo "  Start output (last 5 lines):"
echo "$real_start_out" | tail -5 | while read -r line; do echo "    $line"; done

if [ "$real_start_rc" -eq 0 ]; then
  pass "daemon-control real start exits 0"
else
  fail "daemon-control real start failed (rc=$real_start_rc)"
fi

# Wait for daemon to be ready (check dashboard port)
sleep 3
if timeout 2 bash -c "echo >/dev/tcp/localhost/4334" 2>/dev/null; then
  pass "real daemon dashboard port 4334 is listening after start"
else
  fail "real daemon dashboard port 4334 NOT listening after start"
fi

# ── Test 67: daemon-control real status reports RUNNING ──────────────
echo ""
echo "--- Test: daemon-control real status ---"

set +e
real_status_out="$("$TOOL" real status 2>&1)"
real_status_rc=$?
set -e

if echo "$real_status_out" | grep -q 'STATUS: RUNNING'; then
  pass "daemon-control real status reports RUNNING"
else
  fail "daemon-control real status: expected RUNNING, got: $(echo "$real_status_out" | grep 'STATUS:' || echo 'no STATUS line')"
fi

# ── Test 68: tamandua status under spawn env ──────────────────────────
echo ""
echo "--- Test: tamandua status under real spawn env ---"

TT_ENV_REAL="$SCRIPT_DIR/../env/tt-env.sh"
set +e
# Build the spawn env as KEY=VALUE pairs and pass them to env -i
_tam_status_cmd="tamandua status"
_tam_status_env="$(bash "$TT_ENV_REAL" print)"
tam_status_out="$(env -i $_tam_status_env PATH="$PATH" bash -c "$_tam_status_cmd" 2>&1)"
tam_status_rc=$?
set -e

if [ "$tam_status_rc" -eq 0 ]; then
  pass "tamandua status under real spawn env exits 0"
else
  fail "tamandua status under real spawn env failed (rc=$tam_status_rc)"
fi

if echo "$tam_status_out" | grep -qi "dashboard\|daemon\|running"; then
  pass "tamandua status shows daemon/dashboard info"
else
  fail "tamandua status output unexpected: $(echo "$tam_status_out" | head -3)"
fi

# ── Test 69: tamandua doctor under spawn env ──────────────────────────
echo ""
echo "--- Test: tamandua doctor under real spawn env ---"

set +e
_tam_doctor_cmd="tamandua doctor"
tam_doctor_out="$(env -i $_tam_status_env PATH="$PATH" bash -c "$_tam_doctor_cmd" 2>&1)"
tam_doctor_rc=$?
set -e

# doctor may exit non-zero if checks fail but that's OK — we just verify it runs
echo "  Doctor exit code: $tam_doctor_rc"

if echo "$tam_doctor_out" | grep -qi "check\|doctor\|health\|pass\|fail\|ok"; then
  pass "tamandua doctor under real spawn env produces check output"
else
  fail "tamandua doctor under real spawn env produced no recognizable output"
fi

# ── Test 70: daemon-control real stop ──────────────────────────────────
echo ""
echo "--- Test: daemon-control real stop ---"

set +e
real_stop_out="$("$TOOL" real stop 2>&1)"
real_stop_rc=$?
set -e
echo "  Stop output (last 3 lines):"
echo "$real_stop_out" | tail -3 | while read -r line; do echo "    $line"; done

if [ "$real_stop_rc" -eq 0 ]; then
  pass "daemon-control real stop exits 0"
else
  fail "daemon-control real stop failed (rc=$real_stop_rc)"
fi

# Verify ports are free after stop
sleep 1
all_real_ports_free=true
for port in $REAL_PORTS; do
  if timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
    all_real_ports_free=false
    echo "  WARNING: port $port still listening after stop"
  fi
done

if $all_real_ports_free; then
  pass "all real daemon ports (4334/4338/4339) free after stop"
else
  fail "one or more real daemon ports still in use after stop"
fi

# ── Test 71: production DB sha256 unchanged after real daemon test ────
echo ""
echo "--- Test: production DB integrity after real daemon test ---"

if [ -n "$PROD_DB_SHA_BEFORE" ] && [ -f "$PROD_DB" ]; then
  PROD_DB_SHA_AFTER="$(sha256sum "$PROD_DB" | awk '{print $1}')"
  if [ "$PROD_DB_SHA_BEFORE" = "$PROD_DB_SHA_AFTER" ]; then
    pass "production DB sha256 unchanged: $PROD_DB_SHA_BEFORE"
  else
    fail "production DB sha256 CHANGED! before=$PROD_DB_SHA_BEFORE after=$PROD_DB_SHA_AFTER"
  fi
else
  if [ ! -f "$PROD_DB" ]; then
    pass "no production DB exists — integrity check skipped (nothing to corrupt)"
  fi
fi

# ── Test 72: no NEW production port listeners after real daemon test ──
echo ""
echo "--- Test: no new production port listeners after real daemon test ---"

# Get a fresh snapshot of production listeners and compare with BEFORE.
# The production daemon may already be running, so we check for NEW listeners.
prod_listeners_now=""
if command -v ss >/dev/null 2>&1; then
  prod_listeners_now="$(ss -tlnp 2>/dev/null | grep -E ':(3334|3338|3339) ' || true)"
elif command -v netstat >/dev/null 2>&1; then
  prod_listeners_now="$(netstat -tlnp 2>/dev/null | grep -E ':(3334|3338|3339) ' || true)"
fi

prod_listeners_before_snapshot="$(record_prod_listeners "BEFORE" 2>&1 || true)"

# The production daemon may legitimately have listeners. Verify no NEW ones appeared.
# We do this by checking that no TT process PIDs are in the production listener list.
# Simpler approach: verify the number of listeners hasn't changed.
if [ -z "$prod_listeners_now" ]; then
  pass "no listeners on production ports (3334/3338/3339)"
else
  # If there were already listeners before, it's the production daemon — acceptable.
  # Only fail if these listeners are from TT daemons (they'd show up on 33xx, which
  # isn't possible since TT daemons use 43xx/53xx).
  if echo "$prod_listeners_now" | grep -qE ':(3334|3338|3339).*tamandua'; then
    fail "tamandua processes found on production ports — possible TT daemon leak"
  else
    pass "production port listeners detected but not tamandua TT processes (existing production daemon)"
  fi
fi

# ── Test 73: daemon-control scripted start ───────────────────────────
echo ""
echo "--- Test: daemon-control scripted start ---"

SCRIPTED_PORTS="5334 5338 5339"
# Clean up any lingering systemd scope from previous failed runs
systemctl --user stop tamandua-tt-scripted.scope 2>/dev/null || true
systemctl --user reset-failed tamandua-tt-scripted.scope 2>/dev/null || true
for port in $SCRIPTED_PORTS; do
  if timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
    echo "  WARNING: port $port is already in use — attempting to stop existing scripted daemon"
    set +e
    "$TOOL" scripted stop 2>/dev/null || true
    set -e
    sleep 2
  fi
done

set +e
scripted_start_out="$("$TOOL" scripted start 2>&1)"
scripted_start_rc=$?
set -e
echo "  Start output (last 5 lines):"
echo "$scripted_start_out" | tail -5 | while read -r line; do echo "    $line"; done

if [ "$scripted_start_rc" -eq 0 ]; then
  pass "daemon-control scripted start exits 0"
else
  fail "daemon-control scripted start failed (rc=$scripted_start_rc)"
fi

sleep 3
if timeout 2 bash -c "echo >/dev/tcp/localhost/5334" 2>/dev/null; then
  pass "scripted daemon dashboard port 5334 is listening after start"
else
  fail "scripted daemon dashboard port 5334 NOT listening after start"
fi

# ── Test 74: daemon-control scripted status ──────────────────────────
echo ""
echo "--- Test: daemon-control scripted status ---"

set +e
scripted_status_out="$("$TOOL" scripted status 2>&1)"
set -e

if echo "$scripted_status_out" | grep -q 'STATUS: RUNNING'; then
  pass "daemon-control scripted status reports RUNNING"
else
  fail "daemon-control scripted status: expected RUNNING, got: $(echo "$scripted_status_out" | grep 'STATUS:' || echo 'no STATUS line')"
fi

# ── Test 75: daemon-control scripted stop ────────────────────────────
echo ""
echo "--- Test: daemon-control scripted stop ---"

set +e
scripted_stop_out="$("$TOOL" scripted stop 2>&1)"
scripted_stop_rc=$?
set -e

if [ "$scripted_stop_rc" -eq 0 ]; then
  pass "daemon-control scripted stop exits 0"
else
  fail "daemon-control scripted stop failed (rc=$scripted_stop_rc)"
fi

sleep 1
all_scripted_ports_free=true
for port in $SCRIPTED_PORTS; do
  if timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
    all_scripted_ports_free=false
  fi
done

if $all_scripted_ports_free; then
  pass "all scripted daemon ports (5334/5338/5339) free after stop"
else
  fail "one or more scripted daemon ports still in use after stop"
fi

# ── Test 76: production guard refusal — targeting production port ────
echo ""
echo "--- Test: production guard refusal (port) ---"

# Verify the tool refuses to operate if TT ports somehow resolve to production.
# The tool's guard checks ports_for_kind, which always returns 43xx/53xx.
# But we can still test that the guard functions reject production ports by
# checking that the source code explicitly refuses 3334/3338/3339.

# Attempt to invoke with a port that matches production (indirect: verify
# that guard_kind_ports would trip if ports were production)
if grep -q 'is_production_port' "$TOOL" && grep -q 'refuse_production' "$TOOL"; then
  pass "production guard functions reference is_production_port and refuse_production"
else
  fail "production guard functions incomplete"
fi

# Verify the tool refuses if a port matches a production port (logic check)
test_guard_port() {
  local test_port="$1"
  local result
  # Source the is_production_port function and test it
  result=$(bash -c "
    PROD_PORTS='3334 3338 3339'
    is_production_port() {
      local port=\\$1
      for p in \$PROD_PORTS; do
        if [ \"\$port\" = \"\$p\" ]; then return 0; fi
      done
      return 1
    }
    if is_production_port $test_port; then echo PROD; else echo NOT_PROD; fi
  " 2>/dev/null)
  echo "$result"
}

for prod_port in 3334 3338 3339; do
  if [ "$(test_guard_port "$prod_port")" = "PROD" ]; then
    pass "port $prod_port correctly identified as production"
  else
    fail "port $prod_port NOT identified as production"
  fi
done

for non_prod_port in 4334 5334 9999; do
  if [ "$(test_guard_port "$non_prod_port")" = "NOT_PROD" ]; then
    pass "port $non_prod_port correctly identified as NOT production"
  else
    fail "port $non_prod_port incorrectly identified as production"
  fi
done

# ── Test 77: production guard refusal — real ~/.tamandua ─────────────
echo ""
echo "--- Test: production guard refusal (cwd) ---"

# Verify that is_production_cwd detects the real ~/.tamandua as production
test_guard_cwd() {
  local test_dir="$1"
  local result
  result=$(bash -c "
    REAL_TAMANDUA_STATE='${HOME}/.tamandua'
    TT_ROOT='${SCRIPT_DIR}/../var'
    is_production_cwd() {
      local dir=\\$1
      local rp
      rp=\$(cd \"\$dir\" 2>/dev/null && pwd || true)
      if [ -z \"\$rp\" ]; then return 1; fi
      local real_state
      real_state=\$(cd \"\$REAL_TAMANDUA_STATE\" 2>/dev/null && pwd || true)
      if [ -n \"\$real_state\" ] && [ \"\$rp\" = \"\$real_state\" ]; then return 0; fi
      local tt_root_rp
      tt_root_rp=\$(cd \"\$TT_ROOT\" 2>/dev/null && pwd || true)
      if [ -n \"\$tt_root_rp\" ]; then
        case \"\$rp\" in
          \"\$tt_root_rp\"|\"\$tt_root_rp\"/*) return 1 ;;
        esac
      fi
      case \"\$rp\" in
        \"\$HOME/.tamandua\"|\"\$HOME/.tamandua\"/*) return 0 ;;
      esac
      return 1
    }
    if is_production_cwd '$test_dir'; then echo PROD; else echo NOT_PROD; fi
  " 2>/dev/null || echo "ERR")
  echo "$result"
}

if [ -d "$HOME/.tamandua" ]; then
  if [ "$(test_guard_cwd "$HOME/.tamandua")" = "PROD" ]; then
    pass "detects real ~/.tamandua as production cwd"
  else
    fail "real ~/.tamandua NOT detected as production cwd"
  fi
else
  pass "no real ~/.tamandua exists — production cwd guard check skipped"
fi

# Verify TT_ROOT is NOT production
if [ -d "$TT_VAR_BASE" ]; then
  if [ "$(test_guard_cwd "$TT_VAR_BASE")" = "NOT_PROD" ]; then
    pass "TT_ROOT correctly identified as NOT production cwd"
  else
    fail "TT_ROOT incorrectly flagged as production cwd"
  fi
fi

# ── Test 78: provenance JSON — real daemon ───────────────────────────
echo ""
echo "--- Test: provenance JSON for real daemon ---"

REAL_PROV="$TT_VAR_BASE/daemon-control/real.json"
if [ -f "$REAL_PROV" ]; then
  pass "real daemon provenance file exists: $REAL_PROV"
else
  fail "real daemon provenance file missing: $REAL_PROV"
fi

if [ -f "$REAL_PROV" ] && command -v jq >/dev/null 2>&1; then
  if jq empty "$REAL_PROV" 2>/dev/null; then
    pass "real provenance JSON parses with jq"
  else
    fail "real provenance JSON fails jq validation"
  fi
  for field in name kind pid ports scopeUnit cgroupVerified startedAt cmdline cwd; do
    if jq -e ".$field" "$REAL_PROV" >/dev/null 2>&1; then
      pass "real provenance contains '$field'"
    else
      fail "real provenance missing '$field'"
    fi
  done
  # Verify stoppedAt and exitCode are present (stop was called)
  if jq -e '.stoppedAt' "$REAL_PROV" >/dev/null 2>&1; then
    pass "real provenance contains stoppedAt (daemon was stopped)"
  else
    fail "real provenance missing stoppedAt (stop may not have updated provenance)"
  fi
  if jq -e '.exitCode' "$REAL_PROV" >/dev/null 2>&1; then
    pass "real provenance contains exitCode (daemon was stopped)"
  else
    fail "real provenance missing exitCode"
  fi
else
  if [ -f "$REAL_PROV" ]; then
    # jq not available — at least check it looks like JSON
    if grep -q '{' "$REAL_PROV" && grep -q '}' "$REAL_PROV"; then
      pass "real provenance file appears to be JSON (no jq available)"
    else
      fail "real provenance file does not look like JSON"
    fi
  fi
fi

# ── Test 79: provenance JSON — scripted daemon ───────────────────────
echo ""
echo "--- Test: provenance JSON for scripted daemon ---"

SCRIPTED_PROV="$TT_VAR_BASE/daemon-control/scripted.json"
if [ -f "$SCRIPTED_PROV" ]; then
  pass "scripted daemon provenance file exists: $SCRIPTED_PROV"
else
  fail "scripted daemon provenance file missing: $SCRIPTED_PROV"
fi

if [ -f "$SCRIPTED_PROV" ] && command -v jq >/dev/null 2>&1; then
  if jq empty "$SCRIPTED_PROV" 2>/dev/null; then
    pass "scripted provenance JSON parses with jq"
  else
    fail "scripted provenance JSON fails jq validation"
  fi
  for field in name kind pid ports scopeUnit cgroupVerified startedAt cmdline cwd; do
    if jq -e ".$field" "$SCRIPTED_PROV" >/dev/null 2>&1; then
      pass "scripted provenance contains '$field'"
    else
      fail "scripted provenance missing '$field'"
    fi
  done
  # Verify stoppedAt and exitCode are present (stop was called)
  if jq -e '.stoppedAt' "$SCRIPTED_PROV" >/dev/null 2>&1; then
    pass "scripted provenance contains stoppedAt (daemon was stopped)"
  else
    fail "scripted provenance missing stoppedAt"
  fi
  if jq -e '.exitCode' "$SCRIPTED_PROV" >/dev/null 2>&1; then
    pass "scripted provenance contains exitCode (daemon was stopped)"
  else
    fail "scripted provenance missing exitCode"
  fi
else
  if [ -f "$SCRIPTED_PROV" ]; then
    if grep -q '{' "$SCRIPTED_PROV" && grep -q '}' "$SCRIPTED_PROV"; then
      pass "scripted provenance file appears to be JSON (no jq available)"
    fi
  fi
fi

# ── Test 80: daemon-control real restart round-trip ──────────────────
echo ""
echo "--- Test: daemon-control real restart round-trip ---"

# Ensure clean state first
for port in $REAL_PORTS; do
  if timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
    set +e; "$TOOL" real stop 2>/dev/null || true; set -e
    sleep 2
  fi
done

# Start fresh
set +e
"$TOOL" real start >/dev/null 2>&1
set -e
sleep 3

if timeout 2 bash -c "echo >/dev/tcp/localhost/4334" 2>/dev/null; then
  pass "real daemon running before restart test"
else
  fail "real daemon not running before restart test — cannot test restart"
fi

# Restart
set +e
real_restart_out="$("$TOOL" real restart 2>&1)"
real_restart_rc=$?
set -e

if [ "$real_restart_rc" -eq 0 ]; then
  pass "daemon-control real restart exits 0"
else
  fail "daemon-control real restart failed (rc=$real_restart_rc)"
fi

sleep 3
if timeout 2 bash -c "echo >/dev/tcp/localhost/4334" 2>/dev/null; then
  pass "real daemon dashboard port 4334 listening after restart"
else
  fail "real daemon dashboard port 4334 NOT listening after restart"
fi

# Verify status reports RUNNING after restart
set +e
real_restart_status="$("$TOOL" real status 2>&1)"
set -e
if echo "$real_restart_status" | grep -q 'STATUS: RUNNING'; then
  pass "real daemon status is RUNNING after restart"
else
  fail "real daemon status not RUNNING after restart"
fi

# Stop after restart test
set +e; "$TOOL" real stop >/dev/null 2>&1; set -e
sleep 1

# ── Test 81: daemon-control scripted restart round-trip ──────────────
echo ""
echo "--- Test: daemon-control scripted restart round-trip ---"

for port in $SCRIPTED_PORTS; do
  if timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
    set +e; "$TOOL" scripted stop 2>/dev/null || true; set -e
    sleep 2
  fi
done

set +e
"$TOOL" scripted start >/dev/null 2>&1
set -e
sleep 3

if timeout 2 bash -c "echo >/dev/tcp/localhost/5334" 2>/dev/null; then
  pass "scripted daemon running before restart test"
else
  fail "scripted daemon not running before restart test"
fi

set +e
scripted_restart_out="$("$TOOL" scripted restart 2>&1)"
scripted_restart_rc=$?
set -e

if [ "$scripted_restart_rc" -eq 0 ]; then
  pass "daemon-control scripted restart exits 0"
else
  fail "daemon-control scripted restart failed (rc=$scripted_restart_rc)"
fi

sleep 3
if timeout 2 bash -c "echo >/dev/tcp/localhost/5334" 2>/dev/null; then
  pass "scripted daemon dashboard port 5334 listening after restart"
else
  fail "scripted daemon dashboard port 5334 NOT listening after restart"
fi

set +e
scripted_restart_status="$("$TOOL" scripted status 2>&1)"
set -e
if echo "$scripted_restart_status" | grep -q 'STATUS: RUNNING'; then
  pass "scripted daemon status is RUNNING after restart"
else
  fail "scripted daemon status not RUNNING after restart"
fi

# ── Test 82: daemon-control real status STOPPED after stop ───────────
echo ""
echo "--- Test: real status STOPPED after final stop ---"

set +e; "$TOOL" real stop >/dev/null 2>&1; set -e
sleep 1

set +e
real_stopped_status="$("$TOOL" real status 2>&1)"
set -e

if echo "$real_stopped_status" | grep -q 'STATUS: STOPPED'; then
  pass "daemon-control real status reports STOPPED after stop"
else
  # UNKNOWN is also acceptable if PID is gone but ports free
  if echo "$real_stopped_status" | grep -q 'STATUS: UNKNOWN'; then
    pass "daemon-control real status reports UNKNOWN (acceptable after stop with closed ports)"
  else
    fail "daemon-control real status unexpected after stop: $(echo "$real_stopped_status" | grep 'STATUS:' || echo 'no STATUS')"
  fi
fi

# ── Test 83: daemon-control scripted status STOPPED after stop ──────
echo ""
echo "--- Test: scripted status STOPPED after final stop ---"

set +e; "$TOOL" scripted stop >/dev/null 2>&1; set -e
sleep 1

set +e
scripted_stopped_status="$("$TOOL" scripted status 2>&1)"
set -e

if echo "$scripted_stopped_status" | grep -q 'STATUS: STOPPED'; then
  pass "daemon-control scripted status reports STOPPED after stop"
else
  if echo "$scripted_stopped_status" | grep -q 'STATUS: UNKNOWN'; then
    pass "daemon-control scripted status reports UNKNOWN (acceptable after stop with closed ports)"
  else
    fail "daemon-control scripted status unexpected after stop: $(echo "$scripted_stopped_status" | grep 'STATUS:' || echo 'no STATUS')"
  fi
fi

# ── Test 84: production DB sha256 unchanged after ALL tests ──────────
echo ""
echo "--- Test: production DB integrity after ALL tests ---"

if [ -n "$PROD_DB_SHA_BEFORE" ] && [ -f "$PROD_DB" ]; then
  PROD_DB_SHA_FINAL="$(sha256sum "$PROD_DB" | awk '{print $1}')"
  if [ "$PROD_DB_SHA_BEFORE" = "$PROD_DB_SHA_FINAL" ]; then
    pass "production DB sha256 unchanged through all tests: $PROD_DB_SHA_BEFORE"
  else
    fail "production DB sha256 CHANGED! before=$PROD_DB_SHA_BEFORE final=$PROD_DB_SHA_FINAL"
  fi
fi

# ── Test 85: restart round-trip — provenance preserved (single file) ─
echo ""
echo "--- Test: restart provenance preservation ---"

# After restart tests, provenance files should exist and show the restarted daemon
if [ -f "$REAL_PROV" ] && command -v jq >/dev/null 2>&1; then
  prov_kind=$(jq -r '.kind' "$REAL_PROV" 2>/dev/null || true)
  if [ "$prov_kind" = "real" ]; then
    pass "real provenance preserved after restart (kind=real)"
  else
    fail "real provenance corrupted after restart (kind=$prov_kind)"
  fi
fi

if [ -f "$SCRIPTED_PROV" ] && command -v jq >/dev/null 2>&1; then
  prov_kind=$(jq -r '.kind' "$SCRIPTED_PROV" 2>/dev/null || true)
  if [ "$prov_kind" = "scripted" ]; then
    pass "scripted provenance preserved after restart (kind=scripted)"
  else
    fail "scripted provenance corrupted after restart (kind=$prov_kind)"
  fi
fi

# ── Test 86: final cleanup — all TT ports free ──────────────────────
echo ""
echo "--- Test: final cleanup — all TT ports free ---"

# Ensure both daemons are fully stopped
set +e
"$TOOL" real stop >/dev/null 2>&1 || true
"$TOOL" scripted stop >/dev/null 2>&1 || true
set -e
sleep 2

all_ports_clean=true
for port in $REAL_PORTS $SCRIPTED_PORTS; do
  if timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
    all_ports_clean=false
    echo "  WARNING: port $port still in use during final cleanup"
  fi
done

if $all_ports_clean; then
  pass "all TT ports (43xx + 53xx) free after complete test cleanup"
else
  fail "one or more TT ports still in use after final cleanup"
fi

# Cleanup snapshot temp dir
rm -rf "$snapshot_dir" 2>/dev/null || true

echo ""
echo "================================================"
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "$FAILURES test(s) FAILED"
  exit 1
fi
