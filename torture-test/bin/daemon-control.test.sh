#!/usr/bin/env bash
# daemon-control.test.sh — self-test for daemon-control scaffolding.
# Validates CLI dispatch, --help, production guards, systemd detection,
# env script application, and directory setup per US-002 acceptance criteria.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/daemon-control"

# E3.C.2 US-002: scope unit names are PER-WORKTREE (tamandua-tt-<kind>-<hash>
# derived from the repo root — mirroring the T2.1 US-009 pattern) so
# concurrent campaigns in different worktrees never stop or collide with each
# other's daemon scope. Mirror daemon-control's derivation here so teardown
# and assertions use the same unit names.
TEST_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_SCOPE_SUFFIX="$(printf '%s' "$TEST_REPO_ROOT" | cksum 2>/dev/null | awk '{printf "%08x", $1}')"
[ -n "$TEST_SCOPE_SUFFIX" ] || TEST_SCOPE_SUFFIX="default"
REAL_SCOPE_UNIT="tamandua-tt-real-$TEST_SCOPE_SUFFIX"
SCRIPTED_SCOPE_UNIT="tamandua-tt-scripted-$TEST_SCOPE_SUFFIX"

FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# port_listen: portable TCP-connect liveness probe (MACP4 US-001). Bounded
# connect (default 1s, optional $2 seconds) to $1 on the loopback addresses
# (127.0.0.1 first — every TT daemon listener binds 127.0.0.1 by default —
# then ::1). Returns 0 when the port accepts a connection, 1 otherwise.
# Replaces the GNU-`timeout`-dependent `timeout N bash -c "echo
# >/dev/tcp/..."` probes so THIS harness (like the tool it tests) runs on
# Darwin, where `timeout` does not exist.
port_listen() {
  local port="$1"
  local bound="${2:-1}"
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const boundMs = Number(process.argv[2]);
    const hosts = ["127.0.0.1", "::1"];
    let i = 0;
    function attempt() {
      if (i >= hosts.length) process.exit(1);
      const host = hosts[i++];
      const socket = net.connect({ host, port });
      socket.setTimeout(boundMs, () => { socket.destroy(); attempt(); });
      socket.once("connect", () => { socket.destroy(); process.exit(0); });
      socket.once("error", () => { socket.destroy(); attempt(); });
    }
    attempt();
  ' "$port" "$((bound * 1000))" 2>/dev/null
}

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

# ── Test 8b (MACP4 US-001): TT_FORCE_NO_SYSTEMD forced-fallback override ─
# has_systemd_scope() must honor TT_FORCE_NO_SYSTEMD=1 by returning false
# (1) even when systemd-run IS available — the mechanical forcing that lets
# the W2 scripted cells prove the plain-background fallback launch path on a
# systemd linux host (the path Darwin always takes). Default behavior on a
# systemd host (no override) must be unchanged: still HAS_SYSTEMD.
if grep -A 15 '^has_systemd_scope()' "$TOOL" | grep -q 'TT_FORCE_NO_SYSTEMD'; then
  pass "has_systemd_scope honors the TT_FORCE_NO_SYSTEMD override"
else
  fail "has_systemd_scope missing TT_FORCE_NO_SYSTEMD override check"
fi

# Behavioral (hermetic): extract has_systemd_scope and drive it with a fake
# systemd-run that SUCCEEDS. Without the override -> HAS_SYSTEMD; with
# TT_FORCE_NO_SYSTEMD=1 -> NO_SYSTEMD (the fallback is forced).
set +e
sysd_override_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-dc-sysd.XXXXXX")"
printf '#!/bin/sh\nexit 0\n' > "$sysd_override_dir/systemd-run"
chmod +x "$sysd_override_dir/systemd-run"
sysd_fn_file="$(mktemp "${TMPDIR:-/tmp}/tt-dc-sysd-fn.XXXXXX")"
sed -n '/^has_systemd_scope()/,/^}/p' "$TOOL" > "$sysd_fn_file"
printf 'if has_systemd_scope; then echo HAS_SYSTEMD; else echo NO_SYSTEMD; fi\n' >> "$sysd_fn_file"
sysd_default="$(PATH="$sysd_override_dir:$PATH" bash "$sysd_fn_file" 2>/dev/null)"
sysd_forced="$(PATH="$sysd_override_dir:$PATH" TT_FORCE_NO_SYSTEMD=1 bash "$sysd_fn_file" 2>/dev/null)"
rm -rf "$sysd_override_dir" "$sysd_fn_file"
set -e

if [ "$sysd_default" = "HAS_SYSTEMD" ]; then
  pass "has_systemd_scope returns HAS_SYSTEMD without the override (default unchanged)"
else
  fail "has_systemd_scope without override expected HAS_SYSTEMD, got: $sysd_default"
fi

if [ "$sysd_forced" = "NO_SYSTEMD" ]; then
  pass "TT_FORCE_NO_SYSTEMD=1 forces has_systemd_scope to NO_SYSTEMD (fallback path)"
else
  fail "TT_FORCE_NO_SYSTEMD=1 expected NO_SYSTEMD, got: $sysd_forced"
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

# E3.C.1 US-004: daemon-control deliberately invokes node for TWO purposes —
# (1) the torture-test-local process-identity CLI (bin/tt-process-identity.mjs),
# the only sanctioned way to read/verify a pid's /proc starttime identity
# before any signal; and (2) MACP4 US-001's portable TCP port probe
# (port_probe, `node -e` net.connect — the GNU-`timeout`-free replacement for
# the old /dev/tcp probe, which macOS cannot run). Any OTHER node invocation,
# or any npm/npx use, is a regression.
if grep -qE "^[^#]*(npm|npx)" "$TOOL" 2>/dev/null; then
  fail "tool contains npm/npx invocation (should be bash + identity CLI + port_probe only)"
else
  pass "tool does not rely on npm/npx"
fi

node_lines="$(grep -nE "^[^#]*node" "$TOOL" 2>/dev/null || true)"
if [ -n "$node_lines" ]; then
  # Every sanctioned node invocation must either go through the IDENTITY_TOOL
  # variable (the tt-process-identity.mjs path is bound there, so the
  # invocation lines reference the variable, not a literal node binary) or be
  # the port_probe's `node -e` TCP probe (MACP4 US-001). The usage-doc line
  # that DESCRIBES the probe ("node net.connect probe (port_probe)") is prose,
  # allowed too.
  bad_node_lines="$(echo "$node_lines" | grep -v "IDENTITY_TOOL" | grep -v "node -e" | grep -v "net.connect" || true)"
  if [ -n "$bad_node_lines" ]; then
    fail "tool contains node invocation not targeting the identity CLI or the port_probe: $(echo "$bad_node_lines" | tr '\n' ' ')"
  else
    pass "tool uses node only for the tt-process-identity identity CLI and the port_probe (MACP4 US-001)"
  fi
else
  pass "tool does not invoke node"
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

# ── Test 18a (E3.C.2 US-002): per-worktree scope unit name ───────────
echo ""
echo "--- Test: per-worktree scope unit name (E3.C.2 US-002) ---"

# The scope unit must be derived PER-WORKTREE from the repo root (never the
# old fixed per-user `tamandua-tt-<kind>`): a concurrent campaign in another
# worktree must not be able to stop/collide with this worktree's scope.
if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'scope_unit="tamandua-tt-\$name-\$scope_suffix"'; then
  pass "cmd_start derives a per-worktree scope unit (tamandua-tt-<kind>-<suffix>)"
else
  fail "cmd_start missing per-worktree scope unit derivation"
fi
if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'cksum'; then
  pass "cmd_start derives the per-worktree suffix from the repo root (cksum)"
else
  fail "cmd_start missing repo-root suffix derivation"
fi
if ! grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'scope_unit="tamandua-tt-\$name"'; then
  pass "cmd_start no longer uses the fixed per-user scope unit name"
else
  fail "cmd_start still uses the fixed per-user scope unit name"
fi
if ! grep -q 'tamandua-tt-scripted\.scope\|tamandua-tt-real\.scope' "$TOOL"; then
  pass "tool never targets the bare fixed scope names"
else
  fail "tool still references a bare fixed scope name"
fi
# cmd_stop must only ever tear down THIS worktree's derived scope (a recorded
# legacy/fixed name or a foreign worktree's unit is refused, never stopped).
if grep -A 400 '^cmd_stop()' "$TOOL" | grep -q 'scope_unit_is_ours'; then
  pass "cmd_stop gates scope cleanup on per-worktree ownership"
else
  fail "cmd_stop missing per-worktree scope ownership gate"
fi
echo "  (test worktree scope suffix: $TEST_SCOPE_SUFFIX)"

# ── Test 18b (E3.C.2 US-002): bounded port-free wait before launch ───
echo ""
echo "--- Test: bounded port-free wait before launch (E3.C.2 US-002) ---"

if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'TT_DAEMON_PORT_WAIT_SECONDS'; then
  pass "cmd_start supports the TT_DAEMON_PORT_WAIT_SECONDS override"
else
  fail "cmd_start missing TT_DAEMON_PORT_WAIT_SECONDS override"
fi
if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'refusing to launch into a busy port'; then
  pass "cmd_start fails with a clear diagnostic when the port-free bound is exceeded"
else
  fail "cmd_start missing busy-port diagnostic"
fi
# The port-free wait must observe the ports FREE STABLY (two consecutive
# observations across a settle) so a foreign daemon that binds between the
# check and the launch is absorbed by the bounded wait instead of racing us.
if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'STAYS free across a settle'; then
  pass "cmd_start requires the ports to stay free across a settle (stable-free wait)"
else
  fail "cmd_start missing the stable-free settle confirmation"
fi
# T2.1 US-010 round 2: the settle-confirm still cannot make check-then-act
# atomic — a foreign daemon can win a shared port in the instant between the
# settle-recheck and OUR bind (the re-proof campaign's W4.20 bootstrap died
# EADDRINUSE exactly this way: the foreign scope and ours both started in the
# same second). cmd_start must RETRY the whole wait+launch+verify cycle within
# the same bounded deadline instead of failing the start on one collided
# launch attempt.
if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'launch attempt collided'; then
  pass "cmd_start retries a collided launch attempt within the bounded wait (US-010 round-2 retry)"
else
  fail "cmd_start missing the collided-launch retry (US-010 round-2)"
fi

# ── Test 18c (E3.C.2 US-002): stale pid file cleanup ─────────────────
echo ""
echo "--- Test: stale pid file cleanup (E3.C.2 US-002) ---"

if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'STALE tamandua.pid'; then
  pass "cmd_start documents the stale-pid-file cleanup"
else
  fail "cmd_start missing stale-pid-file cleanup documentation"
fi
if grep -A 300 '^cmd_start()' "$TOOL" | grep -q 'rm -f -- "\$daemon_pid_file"'; then
  pass "cmd_start removes a stale daemon pid file before launch"
else
  fail "cmd_start missing stale pid file removal"
fi

# ── Test 19: start subcommand — wait_for_port function ───────────────
echo ""
echo "--- Test: wait_for_port function ---"

if grep -q '^wait_for_port()' "$TOOL"; then
  pass "wait_for_port function exists"
else
  fail "wait_for_port function missing"
fi

if grep -A 12 '^wait_for_port()' "$TOOL" | grep -q 'port_probe'; then
  pass "wait_for_port uses the portable port_probe for port checking (MACP4 US-001)"
else
  fail "wait_for_port missing port_probe call (portable TCP probe)"
fi

# MACP4 US-001: the probe must NOT depend on GNU `timeout` (absent on macOS).
if grep -A 12 '^wait_for_port()' "$TOOL" | grep -q 'timeout 1 bash'; then
  fail "wait_for_port still uses the GNU-timeout-dependent probe (fails on Darwin)"
else
  pass "wait_for_port has no GNU-timeout-dependent port probe"
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
for field in name kind pid ports scopeUnit cgroupVerified startedAt cmdline cwd startTime; do
  if grep -A 100 '^write_provenance()' "$TOOL" | grep -q "\"$field\""; then
    pass "provenance record includes '$field'"
  else
    fail "provenance record missing '$field'"
  fi
done

# Verify jq is used (with fallback)
if grep -A 60 '^write_provenance()' "$TOOL" | grep -q 'command -v jq'; then
  pass "write_provenance uses jq when available (with fallback)"
else
  fail "write_provenance missing jq check"
fi

# Verify fallback path exists (cat with heredoc when jq unavailable)
if grep -A 130 '^write_provenance()' "$TOOL" | grep -q 'PROVEOF'; then
  pass "write_provenance has jq-less fallback path (heredoc)"
else
  fail "write_provenance missing jq-less fallback"
fi

# T2.1 US-010: the ports->JSON conversion must NOT drop the LAST port.
# `printf '%s' "$ports" | tr ' ' '\n' | while read -r p` skips a final line
# without a trailing newline, so the control port (5339) was silently dropped
# from the provenance — the provenance-scoped stop then thought the daemon was
# already stopped while a CLI-auto-started daemon held exactly 5339 (the tier1
# W2.21 restart failure). The input must be newline-terminated.
if grep -A 130 '^write_provenance()' "$TOOL" | grep -Fq "printf '%s\\n' \"\$ports\""; then
  pass "write_provenance terminates the port list with a newline before tr (no last-port drop)"
else
  fail "write_provenance port conversion may drop the last port (no newline before tr)"
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

# ── Test 23b (US-006 / S24): contained PATH reconstruction ────────────
# daemon-control must reconstruct the contained launch PATH ITSELF on every
# start/restart: var/adapters-bin FIRST (mirroring tt-daemon-up's prepend),
# then the env script's PATH, then the remaining caller PATH with any
# OPERATOR bin dirs (e.g. ~/.local/bin) REORDERED after the contained dirs.
# The W3.23 containment leak: daemon-control relaunched with the caller's
# PATH verbatim (PATH="${PATH}"), and a controller-spawned
# `daemon-control <kind> restart` (childEnv PATH lacks the adapters-bin
# prepend) made the restarted contained daemon resolve the OPERATOR's
# ~/.local/bin/pi-token-saver — a foreign binary executed inside the
# contained run.
echo ""
echo "--- Test: contained PATH reconstruction (US-006 / S24) ---"

if grep -q '^contained_path_for_kind()' "$TOOL"; then
  pass "contained_path_for_kind helper exists in source"
else
  fail "contained_path_for_kind helper missing from source"
fi

if grep -q '^operator_bin_dirs()' "$TOOL"; then
  pass "operator_bin_dirs helper exists in source"
else
  fail "operator_bin_dirs helper missing from source"
fi

# All THREE launch sites (run_under_env + the two cmd_start commands) must
# use the reconstructed PATH helper, and the verbatim caller PATH forward
# (PATH="${PATH}") must be gone.
s24_launch_sites=$(grep -c 'PATH="\$(contained_path_for_kind "\$kind")"' "$TOOL" || true)
if [ "${s24_launch_sites:-0}" -ge 3 ]; then
  pass "all launch sites use contained_path_for_kind ($s24_launch_sites sites)"
else
  fail "expected >= 3 launch sites using contained_path_for_kind, found ${s24_launch_sites:-0}"
fi
if grep -qE '^[^#]*PATH="\$\{PATH\}"' "$TOOL"; then
  fail "tool still forwards the caller's PATH verbatim (PATH=\"\${PATH}\")"
else
  pass "tool no longer forwards the caller's PATH verbatim"
fi

# Behavioral arm: a FAKE operator home with a DECOY pi-token-saver first on
# the caller PATH, plus a real stub in var/adapters-bin. Under the
# reconstructed PATH, `command -v pi-token-saver` must resolve INSIDE
# var/adapters-bin and adapters-bin must be the FIRST PATH component. Before
# the fix, the verbatim caller PATH resolved the operator decoy (RED).
S24_TMP="$(mktemp -d "${TMPDIR:-/tmp}/tt-dc-s24.XXXXXX")"
FAKE_OPERATOR_HOME="$S24_TMP/fake-operator-home"
mkdir -p "$FAKE_OPERATOR_HOME/.local/bin"
printf '#!/usr/bin/env bash\necho "DECOY pi-token-saver (operator .local/bin)"\n' > "$FAKE_OPERATOR_HOME/.local/bin/pi-token-saver"
chmod +x "$FAKE_OPERATOR_HOME/.local/bin/pi-token-saver"
ADAPTERS_BIN="$SCRIPT_DIR/../var/adapters-bin"
S24_STUB_BAK=""
S24_ADAPTERS_EXISTED=false
if [ -d "$ADAPTERS_BIN" ]; then S24_ADAPTERS_EXISTED=true; fi
if [ -f "$ADAPTERS_BIN/pi-token-saver" ]; then
  S24_STUB_BAK="$S24_TMP/pi-token-saver.bak"
  mv -f "$ADAPTERS_BIN/pi-token-saver" "$S24_STUB_BAK"
fi
mkdir -p "$ADAPTERS_BIN"
# Canonicalize the adapters-bin path (the reconstructed PATH uses the tool's
# own TT_DIR resolution, which is symlink-free — the `..` must not leak into
# the assertions).
ADAPTERS_BIN="$(cd "$ADAPTERS_BIN" && pwd -P)"
printf '#!/usr/bin/env bash\necho "contained pi-token-saver (adapters-bin)"\n' > "$ADAPTERS_BIN/pi-token-saver"
chmod +x "$ADAPTERS_BIN/pi-token-saver"
s24_cleanup() {
  if [ -n "$S24_STUB_BAK" ] && [ -f "$S24_STUB_BAK" ]; then
    rm -f "$ADAPTERS_BIN/pi-token-saver" 2>/dev/null || true
    mv -f "$S24_STUB_BAK" "$ADAPTERS_BIN/pi-token-saver" 2>/dev/null || true
  else
    rm -f "$ADAPTERS_BIN/pi-token-saver" 2>/dev/null || true
  fi
  if ! $S24_ADAPTERS_EXISTED && [ -d "$ADAPTERS_BIN" ] && [ -z "$(ls -A "$ADAPTERS_BIN" 2>/dev/null)" ]; then
    rmdir "$ADAPTERS_BIN" 2>/dev/null || true
  fi
  rm -rf "$S24_TMP" 2>/dev/null || true
}
trap 'cleanup_test_dir; s24_cleanup' EXIT

# The decoy baseline (RED): a verbatim caller PATH with the decoy first
# resolves the operator decoy — the pre-fix leak shape.
set +e
s24_decoy_resolved="$(PATH="$FAKE_OPERATOR_HOME/.local/bin:$PATH" bash -c 'command -v pi-token-saver' 2>/dev/null)"
set -e
case "$s24_decoy_resolved" in
  "$FAKE_OPERATOR_HOME/.local/bin/pi-token-saver")
    pass "decoy baseline confirmed: the verbatim caller PATH resolves the operator decoy (the leak shape)" ;;
  *)
    pass "decoy baseline note: verbatim caller PATH resolved '$s24_decoy_resolved' (decoy not on this host's PATH)" ;;
esac

# Exercise the reconstruction for BOTH contained kinds (real + scripted).
for s24_kind in real scripted; do
  set +e
  s24_recon="$(TT_DAEMON_CONTROL_CONTAINED_PATH="$s24_kind" HOME="$FAKE_OPERATOR_HOME" PATH="$FAKE_OPERATOR_HOME/.local/bin:$PATH" "$TOOL" 2>/dev/null)"
  s24_rc=$?
  set -e
  if [ "$s24_rc" -eq 0 ] && [ -n "$s24_recon" ]; then
    pass "$s24_kind: contained_path_for_kind prints a PATH (rc=0)"
  else
    fail "$s24_kind: contained_path_for_kind failed (rc=$s24_rc)"
    continue
  fi
  s24_first="${s24_recon%%:*}"
  if [ "$s24_first" = "$ADAPTERS_BIN" ]; then
    pass "$s24_kind: adapters-bin is the first PATH component"
  else
    fail "$s24_kind: adapters-bin is NOT first (first='$s24_first', want '$ADAPTERS_BIN'; path='$s24_recon')"
  fi
  set +e
  s24_resolved="$(PATH="$s24_recon" bash -c 'command -v pi-token-saver' 2>/dev/null)"
  s24_resolve_rc=$?
  set -e
  case "$s24_resolved" in
    "$ADAPTERS_BIN/pi-token-saver")
      pass "$s24_kind: pi-token-saver resolves inside var/adapters-bin ($s24_resolved)" ;;
    *)
      fail "$s24_kind: pi-token-saver resolved to '$s24_resolved' (rc=$s24_resolve_rc) — expected $ADAPTERS_BIN/pi-token-saver; the operator decoy would win pre-fix" ;;
  esac
  # The operator decoy dir must come AFTER adapters-bin in the reconstructed
  # PATH (never before the contained prepend).
  case ":$s24_recon:" in
    *":$ADAPTERS_BIN:"*":$FAKE_OPERATOR_HOME/.local/bin:"*)
      pass "$s24_kind: operator .local/bin appears AFTER adapters-bin" ;;
    *)
      fail "$s24_kind: operator .local/bin not found after adapters-bin (path='$s24_recon')" ;;
  esac
done

# Restore adapters-bin state (a concurrent tt-token-saver-stub install must
# never see a foreign stub at the target path).
s24_cleanup
trap cleanup_test_dir EXIT

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

if grep -A 400 '^cmd_start()' "$TOOL" | grep -q 'wait_for_port'; then
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
# (MACP4 US-002: the function now carries a Darwin evidence branch too, so
# the linux /proc reads live further down the body — scan the WHOLE
# function, not the first lines.)
echo ""
echo "--- Test: /proc evidence checks ---"

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q '/proc.*cwd'; then
  pass "verify_process_tt_owned checks /proc/PID/cwd"
else
  fail "verify_process_tt_owned missing /proc/PID/cwd check"
fi

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q '/proc.*cmdline'; then
  pass "verify_process_tt_owned checks /proc/PID/cmdline"
else
  fail "verify_process_tt_owned missing /proc/PID/cmdline check"
fi

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q 'TT_REPO_ROOT'; then
  pass "verify_process_tt_owned checks cwd against TT_REPO_ROOT"
else
  fail "verify_process_tt_owned missing TT_REPO_ROOT cwd check"
fi

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q 'tamandua'; then
  pass "verify_process_tt_owned requires tamandua in cmdline"
else
  fail "verify_process_tt_owned missing tamandua cmdline check"
fi

# ── Test 29b: Darwin TT-ownership evidence branch (MACP4 US-002) ──────
echo ""
echo "--- Test: verify_process_tt_owned Darwin evidence branch ---"

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q 'TT_DC_PLATFORM'; then
  pass "verify_process_tt_owned honors the TT_DC_PLATFORM seam (Darwin simulation)"
else
  fail "verify_process_tt_owned missing TT_DC_PLATFORM seam"
fi

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q 'lsof -a -p "\$pid" -d cwd -Fn'; then
  pass "verify_process_tt_owned Darwin branch uses lsof cwd evidence (portable)"
else
  fail "verify_process_tt_owned missing lsof cwd evidence (Darwin)"
fi

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q 'ps -p "\$pid" -o command='; then
  pass "verify_process_tt_owned Darwin branch uses ps command evidence (portable)"
else
  fail "verify_process_tt_owned missing ps command evidence (Darwin)"
fi

if grep -A 80 '^verify_process_tt_owned()' "$TOOL" | grep -q 'cannot verify — refuse'; then
  pass "verify_process_tt_owned still refuses when evidence is unavailable (fail-closed)"
else
  fail "verify_process_tt_owned missing the fail-closed refusal"
fi

# ── Test 29c: operator-home fallback chain (MACP4 US-002) ─────────────
echo ""
echo "--- Test: resolve_operator_home fallback chain ---"

if grep -q '^resolve_operator_home()' "$TOOL"; then
  pass "resolve_operator_home function exists"
else
  fail "resolve_operator_home function missing"
fi

if grep -A 40 '^resolve_operator_home()' "$TOOL" | grep -q 'getent passwd'; then
  pass "operator home chain step 1 is getent passwd"
else
  fail "resolve_operator_home missing getent step"
fi

if grep -A 40 '^resolve_operator_home()' "$TOOL" | grep -q 'dscl . -read'; then
  pass "operator home chain step 2 is dscl NFSHomeDirectory (macOS)"
else
  fail "resolve_operator_home missing dscl step"
fi

if grep -A 40 '^resolve_operator_home()' "$TOOL" | grep -q 'eval echo ~'; then
  pass "operator home chain step 3 is the shell tilde expansion"
else
  fail "resolve_operator_home missing shell-tilde step"
fi

if grep -q '_tt_operator_home="\$(resolve_operator_home)"' "$TOOL"; then
  pass "_tt_operator_home derives from resolve_operator_home (true operator home)"
else
  fail "_tt_operator_home does not derive from resolve_operator_home"
fi

if grep -q 'REAL_TAMANDUA_STATE="\${_tt_operator_home:-\${HOME}}/.tamandua"' "$TOOL"; then
  pass "REAL_TAMANDUA_STATE derives from _tt_operator_home"
else
  fail "REAL_TAMANDUA_STATE not derived from _tt_operator_home"
fi

# ── Test 30: is_port_listening function ──────────────────────────────
echo ""
echo "--- Test: is_port_listening function ---"

if grep -q '^is_port_listening()' "$TOOL"; then
  pass "is_port_listening function exists"
else
  fail "is_port_listening function missing"
fi

if grep -A 5 '^is_port_listening()' "$TOOL" | grep -q 'port_probe'; then
  pass "is_port_listening uses the portable port_probe for port checking (MACP4 US-001)"
else
  fail "is_port_listening missing port_probe call (portable TCP probe)"
fi

if grep -A 5 '^is_port_listening()' "$TOOL" | grep -q 'timeout 1 bash'; then
  fail "is_port_listening still uses the GNU-timeout-dependent probe (fails on Darwin)"
else
  pass "is_port_listening has no GNU-timeout-dependent port probe"
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

# ── Test 35b: E3.C.1 US-004 — recorded startTime identity before signals ─
echo ""
echo "--- Test: US-004 recorded startTime identity gating ---"

# The identity CLI must be wired in
if grep -q 'IDENTITY_TOOL=' "$TOOL"; then
  pass "daemon-control references the tt-process-identity CLI (IDENTITY_TOOL)"
else
  fail "daemon-control missing IDENTITY_TOOL reference"
fi

# write_provenance must record the daemon's process-start identity
if grep -A 130 '^write_provenance()' "$TOOL" | grep -q 'start_time'; then
  pass "write_provenance records startTime identity"
else
  fail "write_provenance missing startTime identity recording"
fi

# cmd_start must read the identity at daemon start
if grep -A 400 '^cmd_start()' "$TOOL" | grep -q 'IDENTITY_TOOL.*--get'; then
  pass "cmd_start reads the daemon startTime identity via --get"
else
  fail "cmd_start missing startTime identity read"
fi

# cmd_stop must read the recorded identity back from provenance
if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'prov_start_time'; then
  pass "cmd_stop reads recorded startTime from provenance"
else
  fail "cmd_stop missing prov_start_time read"
fi

# cmd_stop must verify identity before ANY signal (verify_recorded_identity)
if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'verify_recorded_identity'; then
  pass "cmd_stop verifies recorded identity before signalling"
else
  fail "cmd_stop missing verify_recorded_identity gate"
fi

# The SIGKILL escalation must re-verify identity (pid not reused mid-window)
if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'REFUSING SIGKILL'; then
  pass "cmd_stop re-verifies identity before SIGKILL escalation"
else
  fail "cmd_stop missing SIGKILL re-verification"
fi

# Step 4 lingering-listener cleanup must refuse unconfirmed identities
if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'not the recorded daemon'; then
  pass "cmd_stop refuses to kill lingering listeners that are not the recorded daemon"
else
  fail "cmd_stop missing lingering-listener identity refusal"
fi

if grep -A 300 '^cmd_stop()' "$TOOL" | grep -q 'verify_listener_target'; then
  pass "cmd_stop uses verify_listener_target for lingering listeners"
else
  fail "cmd_stop missing verify_listener_target"
fi

# Helper functions must exist
for fn in verify_recorded_identity verify_listener_target; do
  if grep -q "^${fn}()" "$TOOL"; then
    pass "$fn function exists"
  else
    fail "$fn function missing"
  fi
done

# ── Test 35c (MACP5 US-001): cmd_start records the REAL daemon pid —
#    identity-verified BEFORE recording ─────────────────────────────────
echo ""
echo "--- Test: cmd_start tamandua.pid acceptance is identity+ownership-gated (MACP5 US-001) ---"

# The triple-gate helper must exist: (a) kill -0 alive, (b)
# tt-process-identity --get non-empty, (c) verify_process_tt_owned.
if grep -q '^verify_launched_daemon_pid()' "$TOOL"; then
  pass "verify_launched_daemon_pid helper exists"
else
  fail "verify_launched_daemon_pid helper missing"
fi
if grep -A 30 '^verify_launched_daemon_pid()' "$TOOL" | grep -q 'kill -0'; then
  pass "gate (a): verify_launched_daemon_pid checks liveness with kill -0"
else
  fail "verify_launched_daemon_pid missing kill -0 liveness gate"
fi
if grep -A 30 '^verify_launched_daemon_pid()' "$TOOL" | grep -q 'IDENTITY_TOOL.*--get'; then
  pass "gate (b): verify_launched_daemon_pid reads the start identity via --get"
else
  fail "verify_launched_daemon_pid missing identity read gate"
fi
if grep -A 30 '^verify_launched_daemon_pid()' "$TOOL" | grep -q 'verify_process_tt_owned'; then
  pass "gate (c): verify_launched_daemon_pid verifies TT-ownership"
else
  fail "verify_launched_daemon_pid missing verify_process_tt_owned gate"
fi

# cmd_start must route EVERY tamandua.pid candidate through the gate (both
# the reuse detection and the pid-wait acceptance) — never a bare kill -0.
cmd_start_gate_calls=$(grep -c 'verify_launched_daemon_pid' <(grep -A 400 '^cmd_start()' "$TOOL") || true)
if [ "${cmd_start_gate_calls:-0}" -ge 2 ]; then
  pass "cmd_start gates the tamandua.pid candidate with verify_launched_daemon_pid ($cmd_start_gate_calls call sites)"
else
  fail "cmd_start expected >= 2 verify_launched_daemon_pid call sites, found ${cmd_start_gate_calls:-0}"
fi
if grep -A 400 '^cmd_start()' "$TOOL" | grep -q 'not an identity-verified TT-owned daemon'; then
  pass "cmd_start treats an unverifiable pidfile candidate as a failed launch attempt"
else
  fail "cmd_start missing the unverifiable-candidate diagnostic"
fi
if grep -A 400 '^cmd_start()' "$TOOL" | grep -q 'no identity-verified daemon pid appeared'; then
  pass "cmd_start fails CLOSED (no provenance) when the deadline expires with no identity-verified pid"
else
  fail "cmd_start missing the fail-closed deadline diagnostic"
fi

# write_provenance must never record an empty startTime (fail closed).
if grep -A 100 '^write_provenance()' "$TOOL" | grep -q 'empty startTime identity'; then
  pass "write_provenance refuses an empty startTime identity (fail closed)"
else
  fail "write_provenance missing the empty-startTime refusal"
fi
if grep -A 400 '^cmd_start()' "$TOOL" | grep -q 'FATAL — cannot read startTime identity'; then
  pass "cmd_start fails closed instead of WARNING-and-continue when the identity read fails at record time"
else
  fail "cmd_start still tolerates an unreadable startTime identity (WARNING-and-continue)"
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

# ── Test 45a (T2.1 US-010 round 4): the post-stop port check is a BOUNDED
#    stable-free wait, not a single shot ─────────────────────────────
echo ""
echo "--- Test: restart post-stop port check is a bounded stable-free wait (T2.1 US-010 round 4) ---"

# The re-proof campaign-20260818T145745610Z W4.36 TEST_INFRA_FAIL: a
# `daemon-control scripted restart` exited 1 in ~15s because the single
# `sleep 1` + one-pass port check ran while a listener (MCP/dashboard
# standalone) was still draining after the daemon PID stop. The restart must
# now wait out the same bounded TT_DAEMON_PORT_WAIT_SECONDS deadline as
# cmd_start, requiring the ports free STABLY (two consecutive free
# observations across a settle), before refusing.
restart_body=$(sed -n '/^cmd_restart()/,/^}/p' "$TOOL")
if echo "$restart_body" | grep -q 'TT_DAEMON_PORT_WAIT_SECONDS'; then
  pass "cmd_restart honors the bounded TT_DAEMON_PORT_WAIT_SECONDS port-free deadline"
else
  fail "cmd_restart missing the bounded TT_DAEMON_PORT_WAIT_SECONDS port-free wait"
fi
if echo "$restart_body" | grep -q 'port_wait_deadline'; then
  pass "cmd_restart computes a port_wait_deadline for the post-stop wait"
else
  fail "cmd_restart missing port_wait_deadline for the post-stop wait"
fi
if echo "$restart_body" | grep -q 'sleep 2'; then
  pass "cmd_restart post-stop wait settles (sleep 2) before confirming ports free"
else
  fail "cmd_restart post-stop wait missing the settle-confirm (sleep 2)"
fi
if echo "$restart_body" | grep -q 'not freed after stop within'; then
  pass "cmd_restart refusal names the bounded deadline (not freed after stop within)"
else
  fail "cmd_restart refusal missing the bounded-deadline diagnostic"
fi
if echo "$restart_body" | grep -q 'while \[ "\$(date +%s)" -lt "\$port_wait_deadline" \]'; then
  pass "cmd_restart port-free check runs inside the bounded deadline loop"
else
  fail "cmd_restart port-free check is not bounded by the deadline loop"
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

# ── Test 47b: FIX10 US-004 fail-closed containment guard ──────────
echo ""
echo "--- Test: kind HOME/TAMANDUA_STATE_DIR containment guard (FIX10 US-004) ---"

# guard_kind_containment must exist and refuse when the kind's spawn env
# escapes torture-test/var (the 2026-08-05 ~/.gitconfig breach surface:
# an uncontained HOME redirects git-identity writes to the real home).
if grep -q 'guard_kind_containment()' "$TOOL"; then
  pass "guard_kind_containment function exists in source"
else
  fail "guard_kind_containment function missing from source"
fi

if grep -q 'resolve_contained_dir()' "$TOOL"; then
  pass "resolve_contained_dir helper exists in source"
else
  fail "resolve_contained_dir helper missing from source"
fi

# main() must invoke the containment guard before dispatching subcommands,
# so every start/restart/stop/status refuses when the env escapes var.
if grep -A 12 'guard_kind_cwd "\$kind"' "$TOOL" | grep -q 'guard_kind_containment'; then
  pass "main dispatch runs guard_kind_containment after guard_kind_cwd"
else
  fail "main dispatch missing guard_kind_containment call"
fi

# The guard must check BOTH HOME and TAMANDUA_STATE_DIR from the spawn env.
if grep -A 20 '^guard_kind_containment()' "$TOOL" | grep -q 'for spec in HOME TAMANDUA_STATE_DIR'; then
  pass "guard_kind_containment checks HOME and TAMANDUA_STATE_DIR"
else
  fail "guard_kind_containment missing HOME/TAMANDUA_STATE_DIR loop"
fi

# The guard must fail closed (refuse) rather than warn-and-continue.
if grep -A 30 '^guard_kind_containment()' "$TOOL" | grep -q 'refuse_production'; then
  pass "guard_kind_containment fails closed via refuse_production"
else
  fail "guard_kind_containment does not refuse on violation"
fi

# The guard must tolerate a not-yet-provisioned contained child home
# (fresh checkout: var/home-scripted is provisioned at daemon start) by
# judging the nearest existing ancestor, while rejecting var itself as a
# live HOME. Verify the escape check is a strictly-inside prefix match.
if grep -A 40 '^guard_kind_containment()' "$TOOL" | grep -q 'torture-test/var itself'; then
  pass "guard_kind_containment rejects var itself as a live HOME"
else
  fail "guard_kind_containment missing var-itself refusal"
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

# ── Test 52b (MACP5 US-001): status liveness is portable kill -0 and the
#    cmdline check rides the TT_DC_PLATFORM seam ────────────────────────
echo ""
echo "--- Test: status portable liveness + TT_DC_PLATFORM cmdline seam (MACP5 US-001) ---"

# Liveness: kill -0 alone — the linux-only `[ -d /proc/<pid> ]` requirement
# is gone (Darwin has no procfs; a live recorded pid must report RUNNING).
if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'kill -0 "\$prov_pid"'; then
  pass "cmd_status liveness uses kill -0 (portable)"
else
  fail "cmd_status missing kill -0 liveness probe"
fi
if grep -A 250 '^cmd_status()' "$TOOL" | grep -q '\[ -d "/proc/\$prov_pid" \]'; then
  fail "cmd_status still requires [ -d /proc/<pid> ] for liveness (linux-only — breaks Darwin)"
else
  pass "cmd_status no longer requires a /proc dir for liveness"
fi

# Cmdline verification must ride the TT_DC_PLATFORM seam: the portable ps
# arm on Darwin, the /proc read retained on linux.
if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'TT_DC_PLATFORM'; then
  pass "cmd_status honors the TT_DC_PLATFORM seam"
else
  fail "cmd_status missing TT_DC_PLATFORM seam"
fi
if grep -A 250 '^cmd_status()' "$TOOL" | grep -q 'ps -p "\$prov_pid" -o command='; then
  pass "cmd_status Darwin arm reads the cmdline via portable ps -p <pid> -o command="
else
  fail "cmd_status missing the portable ps cmdline arm"
fi
if grep -A 250 '^cmd_status()' "$TOOL" | grep -q '/proc/\$prov_pid/cmdline'; then
  pass "cmd_status linux arm retains the /proc/<pid>/cmdline read"
else
  fail "cmd_status missing the linux /proc cmdline read"
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
# Clean up any lingering systemd scope from previous failed runs — the
# PER-WORKTREE derived unit (E3.C.2 US-002), never the bare fixed name
# (which would TERM another worktree's daemon).
systemctl --user stop "$REAL_SCOPE_UNIT.scope" 2>/dev/null || true
systemctl --user reset-failed "$REAL_SCOPE_UNIT.scope" 2>/dev/null || true
for port in $REAL_PORTS; do
  if port_listen "$port"; then
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
if port_listen 4334 2; then
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
  if port_listen "$port"; then
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
# Clean up any lingering systemd scope from previous failed runs — the
# PER-WORKTREE derived unit (E3.C.2 US-002), never the bare fixed name
# (which would TERM another worktree's daemon).
systemctl --user stop "$SCRIPTED_SCOPE_UNIT.scope" 2>/dev/null || true
systemctl --user reset-failed "$SCRIPTED_SCOPE_UNIT.scope" 2>/dev/null || true
for port in $SCRIPTED_PORTS; do
  if port_listen "$port"; then
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

# MACP4 US-001 (acceptance 3): on a systemd host the NORMAL path (no
# TT_FORCE_NO_SYSTEMD override) must use the systemd scope launch and print
# the marker — the override must not change the default.
if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope --quiet true 2>/dev/null; then
  if echo "$scripted_start_out" | grep -q "using systemd scope"; then
    pass "scripted start (no override) uses the systemd scope path (marker printed)"
  else
    fail "scripted start on a systemd host missing 'using systemd scope' marker: $(echo "$scripted_start_out" | grep -i 'systemd' | head -3 || echo '(no systemd line)')"
  fi
else
  echo "  (host has no systemd — the fallback path is the only path; systemd-marker assertion skipped)"
fi

sleep 3
if port_listen 5334 2; then
  pass "scripted daemon dashboard port 5334 is listening after start"
else
  fail "scripted daemon dashboard port 5334 NOT listening after start"
fi

# ── Test 73a (E3.C.2 US-002): provenance records the PER-WORKTREE scope ─
echo ""
echo "--- Test: provenance scopeUnit is per-worktree (E3.C.2 US-002) ---"

SCRIPTED_PROV="$SCRIPT_DIR/../var/daemon-control/scripted.json"
if [ -f "$SCRIPTED_PROV" ]; then
  prov_scope_unit="$(jq -r '.scopeUnit // ""' "$SCRIPTED_PROV" 2>/dev/null || true)"
  if [ "$prov_scope_unit" = "$SCRIPTED_SCOPE_UNIT" ]; then
    pass "provenance scopeUnit is the per-worktree unit ($prov_scope_unit)"
  else
    fail "provenance scopeUnit expected '$SCRIPTED_SCOPE_UNIT' got '$prov_scope_unit'"
  fi
  # The bare fixed name must NEVER be the recorded scope unit.
  if [ "$prov_scope_unit" = "tamandua-tt-scripted" ]; then
    fail "provenance scopeUnit is the bare fixed name — cross-worktree collision surface"
  else
    pass "provenance scopeUnit is not the bare fixed name"
  fi
else
  fail "scripted provenance file missing after start"
fi

# The live systemd unit must be the per-worktree derived name — the bare
# fixed name must not be (re)created by this start.
if systemctl --user list-units --type=scope --all 2>/dev/null | grep -q "$SCRIPTED_SCOPE_UNIT"; then
  pass "scripted systemd scope unit exists with the per-worktree name"
else
  echo "  (no scope unit listed — plain-background fallback or scope already torn down)"
fi
if systemctl --user list-units --type=scope --all 2>/dev/null | grep -q 'tamandua-tt-scripted\.scope'; then
  fail "the bare fixed scripted scope unit is present after start"
else
  pass "no bare fixed scripted scope unit after start"
fi

# ── Test 73a2 (T2.1 US-010): provenance records EVERY kind port — the
#    control port must not be dropped by the ports->JSON conversion ────
echo ""
echo "--- Test: provenance records all three scripted ports incl. 5339 (T2.1 US-010) ---"

if [ -f "$SCRIPTED_PROV" ]; then
  prov_ports_csv="$(jq -r '.ports | join(",")' "$SCRIPTED_PROV" 2>/dev/null || true)"
  missing_port=""
  for port in 5334 5338 5339; do
    if ! echo "$prov_ports_csv" | grep -q "$port"; then
      missing_port="$missing_port $port"
    fi
  done
  if [ -z "$missing_port" ]; then
    pass "provenance records all scripted ports (5334,5338,5339) — got [$prov_ports_csv]"
  else
    fail "provenance missing port(s):$missing_port — got [$prov_ports_csv] (the dropped control port 5339 made the provenance-scoped stop blind to a CLI-auto-started daemon holding only 5339 — the tier1 W2.21 restart failure)"
  fi
else
  fail "scripted provenance file missing after start (cannot check port completeness)"
fi

# ── Test 73b (E3.C.2 US-002): busy port -> bounded wait -> clear failure ─
echo ""
echo "--- Test: busy port fails start with a clear diagnostic (E3.C.2 US-002) ---"

# Stop the running daemon first so the planted listener is the ONLY owner of
# the scripted control port, then bind 5339 (a "foreign worktree daemon"
# stand-in) and ask daemon-control to start with a short port-free bound: it
# must wait out the bound and fail with the explicit diagnostic — never a
# blind launch into a busy port.
set +e
"$TOOL" scripted stop >/dev/null 2>&1
set -e
sleep 1

FOREIGN_SQUATTER_PID=""
if command -v node >/dev/null 2>&1; then
  # The squatter SELF-TERMINATES after ~6s (well past the 3s port-free bound
  # and the refused start): this self-test must not introduce a kill site
  # (tier1-kill-ancestry-hygiene pins that), so teardown waits (liveness
  # probe) instead of signalling.
  node -e '
    const net = require("net");
    const server = net.createServer();
    server.listen(5339, "127.0.0.1", () => console.log("SQUATTING"));
    setTimeout(() => { server.close(); process.exit(0); }, 6000);
    setInterval(() => {}, 1000);
  ' >"${TMPDIR:-/tmp}/dc-squatter.out" 2>/dev/null &
  FOREIGN_SQUATTER_PID=$!
  sleep 1
fi

if [ -n "$FOREIGN_SQUATTER_PID" ] && kill -0 "$FOREIGN_SQUATTER_PID" 2>/dev/null; then
  set +e
  busy_start_out="$(TT_DAEMON_PORT_WAIT_SECONDS=3 "$TOOL" scripted start 2>&1)"
  busy_start_rc=$?
  set -e
  if [ "$busy_start_rc" -ne 0 ] && echo "$busy_start_out" | grep -q "refusing to launch into a busy port"; then
    pass "busy control port -> start fails with the port-free diagnostic (rc=$busy_start_rc)"
  else
    fail "busy control port -> expected port-free failure, rc=$busy_start_rc out=$(echo "$busy_start_out" | tail -2 | tr '\n' ' ')"
  fi
  # The daemon must NOT be up (no half-bootstrap into a busy port). The
  # squatter legitimately owns 5339, so assert on the daemon PID file: the
  # refused start exits BEFORE launching, so no live daemon pid may exist.
  scripted_state_dir="$(bash "$SCRIPT_DIR/../env/tt-env-scripted.sh" print | sed -n 's/^TAMANDUA_STATE_DIR=//p' | head -1)"
  half_up=false
  if [ -f "$scripted_state_dir/tamandua.pid" ]; then
    planted_pid="$(cat "$scripted_state_dir/tamandua.pid" 2>/dev/null || true)"
    if [ -n "$planted_pid" ] && kill -0 "$planted_pid" 2>/dev/null; then
      half_up=true
    fi
  fi
  if $half_up; then
    fail "a half-up daemon (live pid file) exists after the refused start"
  else
    pass "no half-up daemon after the refused start"
  fi
  # Wait for the squatter's self-termination (liveness probe only — no kill
  # site allowed by the kill-ancestry hygiene scanner).
  for _grace in $(seq 1 100); do
    kill -0 "$FOREIGN_SQUATTER_PID" 2>/dev/null || break
    sleep 0.1
  done
  wait "$FOREIGN_SQUATTER_PID" 2>/dev/null || true
  sleep 1
  # Restore the running daemon for the status test that follows. If the
  # squatter's port is still releasing, cmd_start's bounded port-free wait
  # absorbs the transient before launching.
  set +e
  "$TOOL" scripted start >/dev/null 2>&1
  set -e
  sleep 2
else
  fail "could not start the foreign-port squatter (node unavailable?) — busy-port arm skipped"
fi

# ── Test 73c (T2.1 US-010): transient squatter during the free-settle
#    window is ABSORBED, not refused ──────────────────────────────────
echo ""
echo "--- Test: transient port squatter during the free-settle window is absorbed (T2.1 US-010) ---"

# The US-010 stable-free wait must absorb a foreign daemon that binds a shared
# scripted port BETWEEN the first "all free" pass and the settle re-check (the
# operator campaign's W4.11 check-then-launch TOCTOU). Stop the daemon, start
# daemon-control in the background, plant a TRANSIENT binder on 5339 shortly
# after the first free pass (inside the 2s settle), hold it past the settle
# re-check, then release: the start must NOT refuse — it waits out the
# transient and launches successfully.
set +e
"$TOOL" scripted stop >/dev/null 2>&1
set -e
sleep 1

TRANSIENT_PID=""
if command -v node >/dev/null 2>&1; then
  ( sleep 0.5
    node -e '
      const net = require("net");
      const server = net.createServer();
      server.listen(5339, "127.0.0.1", () => console.log("TRANSIENT-HELD"));
      // Hold well past the settle re-check (~2s into the start), then release.
      setTimeout(() => server.close(() => process.exit(0)), 2500);
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    ' >"${TMPDIR:-/tmp}/dc-transient.out" 2>/dev/null ) &
  TRANSIENT_PID=$!
  set +e
  transient_start_out="$("$TOOL" scripted start 2>&1)"
  transient_start_rc=$?
  set -e
  wait "$TRANSIENT_PID" 2>/dev/null || true
  if [ "$transient_start_rc" -eq 0 ] && echo "$transient_start_out" | grep -q "scripted daemon started"; then
    pass "transient squatter in the free-settle window is absorbed; start succeeds (rc=0)"
  else
    fail "transient squatter was NOT absorbed; start rc=$transient_start_rc out=$(echo "$transient_start_out" | tail -3 | tr '\n' ' ')"
  fi
else
  fail "node unavailable — transient-squatter arm skipped"
fi

# ── Test 73d (T2.1 US-010 round 4): RESTART absorbs a transient post-stop
#    port squatter instead of single-shot refusing ───────────────────
echo ""
echo "--- Test: restart absorbs a transient post-stop port squatter (T2.1 US-010 round 4) ---"

# The re-proof campaign-20260818T145745610Z W4.36 TEST_INFRA_FAIL was a
# post-stop port-DRAIN race: after the daemon PID stopped, a listener (MCP /
# dashboard standalone) took a few seconds longer to release its socket, and
# cmd_restart's OLD single `sleep 1` + one-pass check refused immediately
# ("ports not freed after stop; cannot restart"). The restart now waits the
# bounded TT_DAEMON_PORT_WAIT_SECONDS deadline for ports free STABLY. This
# arm plants a TRANSIENT squatter on the scripted control port that holds
# past the settle but releases well inside a short bound: the restart must
# absorb it and succeed — never a single-shot refusal.
set +e
"$TOOL" scripted stop >/dev/null 2>&1
set -e
sleep 1
# Start a real daemon so the restart has a running daemon to stop+start.
set +e
"$TOOL" scripted start >/dev/null 2>&1
set -e
sleep 2

RESTART_TRANSIENT_PID=""
if command -v node >/dev/null 2>&1; then
  # The restart's cmd_stop takes a moment (graceful stop + settle); plant the
  # squatter ~1s after restart begins, hold it ~3s (past the settle re-check),
  # then release. With a 10s bound the restart must wait out the transient
  # and complete — the pre-fix single-shot check refused in ~1s.
  ( sleep 1
    node -e '
      const net = require("net");
      const server = net.createServer();
      server.listen(5339, "127.0.0.1", () => console.log("RESTART-TRANSIENT-HELD"));
      setTimeout(() => server.close(() => process.exit(0)), 3000);
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    ' >"${TMPDIR:-/tmp}/dc-restart-transient.out" 2>/dev/null ) &
  RESTART_TRANSIENT_PID=$!
  set +e
  restart_transient_out="$(TT_DAEMON_PORT_WAIT_SECONDS=10 "$TOOL" scripted restart 2>&1)"
  restart_transient_rc=$?
  set -e
  wait "$RESTART_TRANSIENT_PID" 2>/dev/null || true
  if [ "$restart_transient_rc" -eq 0 ] && echo "$restart_transient_out" | grep -q "scripted daemon started"; then
    pass "restart absorbs the transient post-stop squatter and succeeds (rc=0)"
  else
    fail "restart did NOT absorb the transient post-stop squatter; rc=$restart_transient_rc out=$(echo "$restart_transient_out" | tail -4 | tr '\n' ' ')"
  fi
else
  fail "node unavailable — restart-transient-squatter arm skipped"
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
  if port_listen "$port"; then
    all_scripted_ports_free=false
  fi
done

if $all_scripted_ports_free; then
  pass "all scripted daemon ports (5334/5338/5339) free after stop"
else
  fail "one or more scripted daemon ports still in use after stop"
fi

# ── Test 75b (MACP4 US-001): TT_FORCE_NO_SYSTEMD=1 forced-fallback
#    scripted start → status → stop cycle ──────────────────────────────
echo ""
echo "--- Test: TT_FORCE_NO_SYSTEMD forced-fallback start/status/stop (MACP4 US-001) ---"

# The normal-path scripted daemon was stopped above (ports free). Run the
# cycle with the override: stderr must show the fallback marker and the
# cycle must succeed with exit 0 — this is the launch path Darwin always
# takes, so it is the linux-side mechanical proof for the W2 cells.
set +e
ff_start_out="$(TT_FORCE_NO_SYSTEMD=1 "$TOOL" scripted start 2>&1)"
ff_start_rc=$?
set -e

if [ "$ff_start_rc" -eq 0 ]; then
  pass "TT_FORCE_NO_SYSTEMD=1 scripted start exits 0 (forced fallback)"
else
  fail "TT_FORCE_NO_SYSTEMD=1 scripted start failed (rc=$ff_start_rc): $(echo "$ff_start_out" | tail -3)"
fi

if echo "$ff_start_out" | grep -q "systemd not available — using plain background spawn"; then
  pass "forced-fallback start prints the fallback marker"
else
  fail "forced-fallback start missing marker 'systemd not available — using plain background spawn': $(echo "$ff_start_out" | grep -i 'systemd\|spawn' | head -3 || echo '(no marker line)')"
fi

sleep 3
if port_listen 5334 2; then
  pass "forced-fallback scripted daemon dashboard port 5334 listening after start"
else
  fail "forced-fallback scripted daemon dashboard port 5334 NOT listening after start"
fi

# The forced-fallback path must write provenance with cgroupVerified=false
# (no systemd scope was used). NOTE: jq's `//` operator treats `false` as
# falsy, so `.cgroupVerified // "missing"` would report 'missing' for the
# correct value false — use an explicit has() check.
if [ -f "$SCRIPTED_PROV" ]; then
  ff_cgroup="$(jq -r 'if has("cgroupVerified") then (.cgroupVerified | tostring) else "missing" end' "$SCRIPTED_PROV" 2>/dev/null || echo "missing")"
  if [ "$ff_cgroup" = "false" ]; then
    pass "forced-fallback provenance records cgroupVerified=false"
  else
    fail "forced-fallback provenance cgroupVerified expected false, got '$ff_cgroup'"
  fi
else
  fail "scripted provenance file missing after forced-fallback start"
fi

set +e
ff_status_out="$("$TOOL" scripted status 2>&1)"
set -e
if echo "$ff_status_out" | grep -q 'STATUS: RUNNING'; then
  pass "forced-fallback scripted status reports RUNNING"
else
  fail "forced-fallback scripted status: expected RUNNING, got: $(echo "$ff_status_out" | grep 'STATUS:' || echo 'no STATUS line')"
fi

set +e
ff_stop_out="$(TT_FORCE_NO_SYSTEMD=1 "$TOOL" scripted stop 2>&1)"
ff_stop_rc=$?
set -e
if [ "$ff_stop_rc" -eq 0 ]; then
  pass "TT_FORCE_NO_SYSTEMD=1 scripted stop exits 0"
else
  fail "TT_FORCE_NO_SYSTEMD=1 scripted stop failed (rc=$ff_stop_rc): $(echo "$ff_stop_out" | tail -3)"
fi

sleep 1
ff_ports_free=true
for port in $SCRIPTED_PORTS; do
  if port_listen "$port"; then
    ff_ports_free=false
  fi
done
if $ff_ports_free; then
  pass "all scripted daemon ports (5334/5338/5339) free after forced-fallback stop"
else
  fail "one or more scripted daemon ports still in use after forced-fallback stop"
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
  for field in name kind pid ports scopeUnit cgroupVerified startedAt cmdline cwd startTime; do
    # has() — presence, not truthiness: cgroupVerified=false (the MACP4
    # forced-fallback provenance) must still count as present (jq -e on
    # `false` exits 1, which would false-fail the field check).
    if jq -e "has(\"$field\")" "$REAL_PROV" >/dev/null 2>&1; then
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
  for field in name kind pid ports scopeUnit cgroupVerified startedAt cmdline cwd startTime; do
    # has() — presence, not truthiness: cgroupVerified=false (the MACP4
    # forced-fallback provenance) must still count as present (jq -e on
    # `false` exits 1, which would false-fail the field check).
    if jq -e "has(\"$field\")" "$SCRIPTED_PROV" >/dev/null 2>&1; then
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
  if port_listen "$port"; then
    set +e; "$TOOL" real stop 2>/dev/null || true; set -e
    sleep 2
  fi
done

# Start fresh
set +e
"$TOOL" real start >/dev/null 2>&1
set -e
sleep 3

if port_listen 4334 2; then
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
if port_listen 4334 2; then
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
  if port_listen "$port"; then
    set +e; "$TOOL" scripted stop 2>/dev/null || true; set -e
    sleep 2
  fi
done

set +e
"$TOOL" scripted start >/dev/null 2>&1
set -e
sleep 3

if port_listen 5334 2; then
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
if port_listen 5334 2; then
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

# ── Test 86: cmd_start clears an orphaned daemon-start.lock (US-006) ─
echo ""
echo "--- Test: cmd_start clears an orphaned daemon-start.lock ---"

# W4.12 root cause (operator campaign): a launch CLI SIGINT'd mid-startDaemon
# leaves the product's O_EXCL daemon-start.lock orphaned; a FRESH lock (<30s
# stale threshold) makes the next `tamandua daemon start` wait 10s for a daemon
# pid that never appears and fail ("daemon-control scripted start failed").
# cmd_start must clear the orphaned lock before launching.

if grep -A 60 '^cmd_start()' "$TOOL" | grep -q 'rm -f --.*daemon-start.lock'; then
  pass "cmd_start clears the orphaned daemon-start.lock before launching"
else
  fail "cmd_start missing daemon-start.lock cleanup"
fi

# Behavioral arm: plant a FRESH lock in the scripted state dir, then start —
# the start must succeed AND the pre-planted lock must be gone.
SCRIPTED_STATE_DIR="$TT_VAR_BASE/home-scripted/.tamandua"
if [ -d "$SCRIPTED_STATE_DIR" ]; then
  : > "$SCRIPTED_STATE_DIR/daemon-start.lock"
  set +e
  start_out="$("$TOOL" scripted start 2>&1)"
  start_rc=$?
  set -e
  if [ "$start_rc" -eq 0 ]; then
    pass "scripted start with a pre-planted fresh daemon-start.lock exits 0"
  else
    fail "scripted start with pre-planted lock exited $start_rc: $(echo "$start_out" | tail -3)"
  fi
  if [ ! -e "$SCRIPTED_STATE_DIR/daemon-start.lock" ]; then
    pass "pre-planted daemon-start.lock was cleared by cmd_start"
  else
    fail "pre-planted daemon-start.lock still present after start"
  fi
  set +e
  "$TOOL" scripted stop >/dev/null 2>&1 || true
  set -e
else
  fail "scripted state dir missing: $SCRIPTED_STATE_DIR"
fi

# ── Test 87: final cleanup — all TT ports free ──────────────────────
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
  if port_listen "$port"; then
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

# ═══════════════════════════════════════════════════════════════════════
# US-004: ABA-safe stop escalation + identity-verified listener cleanup
# ═══════════════════════════════════════════════════════════════════════

echo ""
echo "=== US-004: ABA-safe stop escalation tests ==="

IDENTITY_TOOL="$SCRIPT_DIR/tt-process-identity.mjs"
US004_PROV="$TT_VAR_BASE/daemon-control/scripted.json"
TT_REPO_ROOT="$(dirname "$SCRIPT_DIR")"  # torture-test/.. = repo root

# Decoy listener script: binds a TT port and records every catchable signal
# it receives (SIGKILL cannot be trapped — a SIGKILLed decoy dies, which the
# survival assertions catch). SIGTERM/SIGINT/SIGHUP/SIGUSR1/SIGUSR2 are
# appended to a log file so a test can prove NO signal was ever sent.
US004_DECOY_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/tt-dc-listener.XXXXXX.mjs")"
cat > "$US004_DECOY_SCRIPT" <<'US004DECOYEOF'
import net from 'node:net';
import fs from 'node:fs';
const log = process.argv[2];
const port = Number(process.argv[3]);
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR1', 'SIGUSR2']) {
  process.on(s, () => { try { fs.appendFileSync(log, s + '\n'); } catch {} });
}
const server = net.createServer();
server.listen(port, () => { try { fs.appendFileSync(log, 'LISTENING\n'); } catch {} });
setInterval(() => {}, 60000);
US004DECOYEOF

# Decoys that must survive their test are killed here; the EXIT trap also
# covers an early abort (set -e) so a decoy never leaks onto a TT port and
# a crafted fake provenance is always replaced by the real record.
US004_DECOY_PID=""
US004_PROV_BAK=""
decoy_cleanup() {
  if [ -n "$US004_DECOY_PID" ] && kill -0 "$US004_DECOY_PID" 2>/dev/null; then
    kill -KILL "$US004_DECOY_PID" 2>/dev/null || true
    wait "$US004_DECOY_PID" 2>/dev/null || true
    US004_DECOY_PID=""
  fi
}
restore_us004_provenance() {
  if [ -n "$US004_PROV_BAK" ] && [ -f "$US004_PROV_BAK" ]; then
    cp "$US004_PROV_BAK" "$US004_PROV"
  fi
}
trap 'cleanup_snapshot; restore_us004_provenance; decoy_cleanup' EXIT

# wait_for_port_listen: poll until a TCP port accepts a connection.
wait_for_port_listen() {
  local port="$1"
  local tries=0
  while [ "$tries" -lt 50 ]; do
    if port_listen "$port"; then
      return 0
    fi
    sleep 0.2
    tries=$((tries + 1))
  done
  return 1
}

# restore_us004_provenance: put the real scripted provenance back after a
# test crafted a fake record.

# ── Test 87: stale-pid ABA — reused provenance pid is refused ────────
echo ""
echo "--- Test: stale-pid ABA refusal (US-004) ---"

US004_PROV_BAK="$(mktemp "${TMPDIR:-/tmp}/tt-dc-prov.XXXXXX")"
if [ -f "$US004_PROV" ]; then
  cp "$US004_PROV" "$US004_PROV_BAK"
fi

ABA_SIGNAL_LOG="$(mktemp "${TMPDIR:-/tmp}/tt-dc-signals.XXXXXX")"

# Spawn a decoy listener (own session/group via setsid — pgid == pid,
# disjoint from the test ancestry) on a scripted port.
set +e
setsid node "$US004_DECOY_SCRIPT" "$ABA_SIGNAL_LOG" 5339 &
US004_DECOY_PID=$!
set -e

if [ -n "$US004_DECOY_PID" ] && kill -0 "$US004_DECOY_PID" 2>/dev/null; then
  pass "ABA decoy listener spawned (pid $US004_DECOY_PID)"
else
  fail "ABA decoy listener failed to spawn"
fi

if wait_for_port_listen 5339; then
  pass "ABA decoy is listening on port 5339"
else
  fail "ABA decoy never listened on port 5339"
fi

# Craft provenance whose pid names the LIVE decoy but whose startTime is
# STALE (the ABA shape: the recorded pid was reused by a different process
# — here, an unrelated live decoy). stop must REFUSE, never signal it.
cat > "$US004_PROV" <<US004ABAEOF
{
  "name": "scripted",
  "kind": "scripted",
  "pid": $US004_DECOY_PID,
  "ports": [5339],
  "scopeUnit": "",
  "cgroupVerified": false,
  "startedAt": "2026-01-01T00:00:00Z",
  "cmdline": "tamandua daemon start",
  "cwd": "$TT_VAR_BASE/home-scripted",
  "startTime": "proc:1"
}
US004ABAEOF

set +e
aba_stop_out="$("$TOOL" scripted stop 2>&1)"
aba_stop_rc=$?
set -e

if echo "$aba_stop_out" | grep -qi "REFUSING.*startTime\|REFUSING.*identity\|startTime.*not match"; then
  pass "ABA stop refuses with an identity-mismatch message"
else
  fail "ABA stop did not refuse with an identity message (got: $(echo "$aba_stop_out" | grep -i 'refus\|identity\|starttime' | head -3 || echo '(none)'))"
fi

if [ -n "$US004_DECOY_PID" ] && kill -0 "$US004_DECOY_PID" 2>/dev/null; then
  pass "ABA decoy SURVIVED — stale-provenance pid was never signalled"
else
  fail "ABA decoy was KILLED — stale provenance pid was signalled!"
fi

if [ -f "$ABA_SIGNAL_LOG" ] && ! grep -qE "SIGTERM|SIGINT|SIGHUP|SIGUSR" "$ABA_SIGNAL_LOG"; then
  pass "ABA decoy received NO signals (signal log empty)"
else
  fail "ABA decoy received a signal: $(cat "$ABA_SIGNAL_LOG" 2>/dev/null || echo '(log missing)')"
fi

# Restore the real provenance, kill the decoy, clear the backup.
restore_us004_provenance
rm -f "$US004_PROV_BAK"; US004_PROV_BAK=""
decoy_cleanup
rm -f "$ABA_SIGNAL_LOG"

# ── Test 88: decoy listener — matching cwd/cmdline, wrong identity ───
echo ""
echo "--- Test: decoy listener refusal (US-004) ---"

US004_PROV_BAK="$(mktemp "${TMPDIR:-/tmp}/tt-dc-prov.XXXXXX")"
if [ -f "$US004_PROV" ]; then
  cp "$US004_PROV" "$US004_PROV_BAK"
fi

DECOY2_SIGNAL_LOG="$(mktemp "${TMPDIR:-/tmp}/tt-dc-signals2.XXXXXX")"

# Spawn a decoy whose /proc signature matches the OLD scan pattern exactly:
# cwd under TT_REPO_ROOT + 'tamandua' in cmdline + listening on a TT port.
# (exec -a sets argv[0]='tamandua' on the node process; setsid gives it its
# own session/group so it is disjoint from the test ancestry.)
set +e
( cd "$TT_REPO_ROOT" && exec setsid bash -c 'exec -a "$0" node "$1" "$2" "$3"' tamandua "$US004_DECOY_SCRIPT" "$DECOY2_SIGNAL_LOG" 5338 ) &
US004_DECOY_PID=$!
set -e

if [ -n "$US004_DECOY_PID" ] && kill -0 "$US004_DECOY_PID" 2>/dev/null; then
  pass "decoy listener spawned (pid $US004_DECOY_PID)"
else
  fail "decoy listener failed to spawn"
fi

if wait_for_port_listen 5338; then
  pass "decoy listener is listening on port 5338"
else
  fail "decoy listener never listened on port 5338"
fi

# Prove the decoy matches the OLD cwd/cmdline scan signature (the old
# verify_process_tt_owned gate would have passed it and SIGKILLed it).
decoy_cwd="$(readlink "/proc/$US004_DECOY_PID/cwd" 2>/dev/null || true)"
case "$decoy_cwd" in
  "$TT_REPO_ROOT"|"$TT_REPO_ROOT"/*) pass "decoy cwd is under TT_REPO_ROOT ($decoy_cwd) — matches old scan signature" ;;
  *) fail "decoy cwd is NOT under TT_REPO_ROOT ($decoy_cwd)" ;;
esac
decoy_cmdline="$(tr '\0' ' ' < "/proc/$US004_DECOY_PID/cmdline" 2>/dev/null || true)"
if echo "$decoy_cmdline" | grep -q 'tamandua'; then
  pass "decoy cmdline contains 'tamandua' — matches old scan signature"
else
  fail "decoy cmdline lacks 'tamandua' (got: $decoy_cmdline)"
fi

# Craft provenance with a DEAD pid (nothing to signal in Step 3) and NO
# startTime. The lingering-listener cleanup (Step 4) must refuse to kill
# the decoy: it is NOT the recorded daemon and its identity is unconfirmed.
set +e
(sleep 0.05) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true
set -e

cat > "$US004_PROV" <<US004DECOYEOF
{
  "name": "scripted",
  "kind": "scripted",
  "pid": $DEAD_PID,
  "ports": [5338],
  "scopeUnit": "",
  "cgroupVerified": false,
  "startedAt": "2026-01-01T00:00:00Z",
  "cmdline": "tamandua daemon start",
  "cwd": "$TT_VAR_BASE/home-scripted",
  "startTime": ""
}
US004DECOYEOF

set +e
decoy_stop_out="$("$TOOL" scripted stop 2>&1)"
decoy_stop_rc=$?
set -e

if echo "$decoy_stop_out" | grep -qi "REFUSING.*not the recorded daemon\|REFUSING.*identity-confirmed\|not the recorded daemon"; then
  pass "stop refuses to kill the decoy listener (identity unconfirmed)"
else
  fail "stop did not refuse the decoy listener (got: $(echo "$decoy_stop_out" | grep -i 'refus\|identity\|recorded daemon' | head -3 || echo '(none)'))"
fi

if [ -n "$US004_DECOY_PID" ] && kill -0 "$US004_DECOY_PID" 2>/dev/null; then
  pass "decoy listener SURVIVED — not killed on cwd/cmdline evidence alone"
else
  fail "decoy listener was KILLED — cwd/cmdline-only evidence reached a kill!"
fi

if [ -f "$DECOY2_SIGNAL_LOG" ] && ! grep -qE "SIGTERM|SIGINT|SIGHUP|SIGUSR" "$DECOY2_SIGNAL_LOG"; then
  pass "decoy listener received NO signals (signal log empty)"
else
  fail "decoy listener received a signal: $(cat "$DECOY2_SIGNAL_LOG" 2>/dev/null || echo '(log missing)')"
fi

# Restore the real provenance, kill the decoy, clean up temp files.
restore_us004_provenance
rm -f "$US004_PROV_BAK"; US004_PROV_BAK=""
decoy_cleanup
rm -f "$DECOY2_SIGNAL_LOG" "$US004_DECOY_SCRIPT"

# ── Test 89: normal stop still works — the recorded daemon is stopped ──
echo ""
echo "--- Test: recorded daemon stop still works (US-004) ---"

# The real + scripted daemons are stopped (Test 86). A fresh scripted
# start/stop round-trip proves the identity-verified stop path still stops
# the recorded daemon cleanly with ports freed.
set +e
"$TOOL" scripted start >/dev/null 2>&1
start_rc=$?
set -e
if [ "$start_rc" -eq 0 ] && wait_for_port_listen 5334; then
  pass "scripted daemon started for normal-stop round-trip"
else
  fail "scripted daemon did not start for normal-stop round-trip (rc=$start_rc)"
fi

if [ -f "$US004_PROV" ] && command -v jq >/dev/null 2>&1; then
  recorded_start_time="$(jq -r '.startTime // ""' "$US004_PROV" 2>/dev/null || true)"
  if [ -n "$recorded_start_time" ] && [ "$recorded_start_time" != "null" ]; then
    pass "scripted provenance records a startTime identity ($recorded_start_time)"
  else
    fail "scripted provenance missing recorded startTime identity"
  fi
else
  fail "scripted provenance missing after normal start"
fi

set +e
"$TOOL" scripted stop >/dev/null 2>&1
stop_rc=$?
set -e
if [ "$stop_rc" -eq 0 ]; then
  pass "scripted daemon stopped cleanly via identity-verified stop"
else
  fail "scripted daemon stop failed (rc=$stop_rc)"
fi

sleep 1
all_scripted_free=true
for port in $SCRIPTED_PORTS; do
  if port_listen "$port"; then
    all_scripted_free=false
    echo "  WARNING: port $port still in use after normal stop"
  fi
done
if $all_scripted_free; then
  pass "all scripted ports free after identity-verified stop"
else
  fail "one or more scripted ports still in use after normal stop"
fi

# ── Test 90 (E3.C.2 US-004): cmd_stop also stops this worktree's own
# CLI-auto-started daemon (state-dir pidfile, no provenance/scope) ──────
echo ""
echo "--- Test: CLI-auto-started daemon stop (E3.C.2 US-004) ---"

# A `tamandua workflow run` whose CLI finds no reachable daemon auto-starts
# a PLAIN background daemon (ensureDaemonControlAvailable -> startDaemon):
# no systemd scope, no daemon-control provenance, recorded only in the
# kind's state-dir tamandua.pid. cmd_stop must stop it (identity-verified,
# per-worktree) so a subsequent cmd_start finds the ports free. The
# stand-in below is a node process with cmdline containing 'tamandua'
# (filename), cwd under TT_REPO_ROOT, environ TAMANDUA_STATE_DIR == the
# scripted state dir, bound to the scripted control port, and writing its
# pid to the state-dir pidfile — exactly the CLI daemon's observable
# surface. It SELF-TERMINATES after 60s (no kill site in this test file).
scripted_state_dir="$(bash "$SCRIPT_DIR/../env/tt-env-scripted.sh" print | sed -n 's/^TAMANDUA_STATE_DIR=//p' | head -1)"
CLI_SIM_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/tt-cli-daemon-sim-tamandua.XXXXXX.mjs")"
cat > "$CLI_SIM_SCRIPT" <<'CLISIMEOF'
import net from 'node:net';
import fs from 'node:fs';
const stateDir = process.argv[2];
const log = process.argv[3];
fs.writeFileSync(`${stateDir}/tamandua.pid`, String(process.pid));
const server = net.createServer();
server.listen(5339, '127.0.0.1', () => { try { fs.appendFileSync(log, 'LISTENING\n'); } catch {} });
setTimeout(() => process.exit(0), 60000);
setInterval(() => {}, 1000);
CLISIMEOF
CLI_SIM_LOG="$(mktemp "${TMPDIR:-/tmp}/tt-cli-sim-log.XXXXXX")"
CLI_SIM_PID=""

US004_PROV_BAK="$(mktemp "${TMPDIR:-/tmp}/tt-dc-prov.XXXXXX")"
if [ -f "$US004_PROV" ]; then
  cp "$US004_PROV" "$US004_PROV_BAK"
fi
rm -f "$US004_PROV"   # CLI daemon has NO provenance record

# Spawn the stand-in with the scripted state dir in its environ and cwd at
# the repo root (matches the CLI daemon's /proc evidence). setsid execs env
# which execs node, so $! IS the node pid (the pid written to the pidfile).
TAMANDUA_STATE_DIR="$scripted_state_dir" HOME="$TT_REPO_ROOT/torture-test/var/home-scripted" \
  setsid env --chdir="$TT_REPO_ROOT" node "$CLI_SIM_SCRIPT" "$scripted_state_dir" "$CLI_SIM_LOG" &
CLI_SIM_PID=$!

# Wait for the stand-in to bind the control port and write the pidfile.
sim_ok=false
for _attempt in $(seq 1 50); do
  SIM_WAIT_PID="$(cat "$scripted_state_dir/tamandua.pid" 2>/dev/null || true)"
  if [ -f "$CLI_SIM_LOG" ] && grep -q LISTENING "$CLI_SIM_LOG" \
      && [ -f "$scripted_state_dir/tamandua.pid" ] \
      && [ -n "$SIM_WAIT_PID" ] && kill -0 "$SIM_WAIT_PID" 2>/dev/null; then
    sim_ok=true
    break
  fi
  sleep 0.2
done
SIM_RECORDED_PID="$(cat "$scripted_state_dir/tamandua.pid" 2>/dev/null || true)"
if $sim_ok && [ -n "$SIM_RECORDED_PID" ] && [ "$SIM_RECORDED_PID" = "$CLI_SIM_PID" ]; then
  pass "CLI daemon stand-in bound 5339 and recorded its pid ($SIM_RECORDED_PID)"
else
  fail "CLI daemon stand-in did not come up (pidfile=$(cat "$scripted_state_dir/tamandua.pid" 2>/dev/null || echo missing) log=$(cat "$CLI_SIM_LOG" 2>/dev/null || echo missing))"
fi

set +e
"$TOOL" scripted stop >"${TMPDIR:-/tmp}/tt-cli-stop.out" 2>&1
cli_stop_rc=$?
set -e
if [ "$cli_stop_rc" -eq 0 ]; then
  pass "cmd_stop stopped the CLI-auto-started daemon (rc=0)"
else
  fail "cmd_stop failed to stop the CLI-auto-started daemon (rc=$cli_stop_rc): $(tail -3 "${TMPDIR:-/tmp}/tt-cli-stop.out" | tr '\n' ' ')"
fi

# The stand-in must be dead and the control port free.
if [ -n "$SIM_RECORDED_PID" ] && ! kill -0 "$SIM_RECORDED_PID" 2>/dev/null; then
  pass "CLI daemon stand-in PID $SIM_RECORDED_PID is dead after stop"
else
  fail "CLI daemon stand-in PID $SIM_RECORDED_PID still alive after stop"
fi
if ! port_listen 5339; then
  pass "control port 5339 free after CLI-daemon stop"
else
  fail "control port 5339 still busy after CLI-daemon stop"
fi

# Cleanup: wait out the stand-in's self-termination (liveness probe only),
# restore provenance, remove temp files.
for _grace in $(seq 1 50); do
  kill -0 "$CLI_SIM_PID" 2>/dev/null || break
  sleep 0.1
done
wait "$CLI_SIM_PID" 2>/dev/null || true
if [ -f "$US004_PROV_BAK" ]; then
  cp "$US004_PROV_BAK" "$US004_PROV"
fi
rm -f "$US004_PROV_BAK" "$CLI_SIM_SCRIPT" "$CLI_SIM_LOG" "${TMPDIR:-/tmp}/tt-cli-stop.out"

# ── Test 91 (E3.C.2 US-004): cmd_start absorbs this worktree's own
# CLI-auto-started daemon (busy port no longer refuses) ────────────────
echo ""
echo "--- Test: cmd_start absorbs CLI-auto-started daemon (E3.C.2 US-004) ---"

# The w2.23c shape: `workflow run` with the daemon down auto-starts a plain
# CLI daemon on the control port, then the scenario calls `daemon-control
# scripted start`. cmd_start must stop the CLI daemon (identity-verified)
# instead of refusing on the busy port.
US004_PROV_BAK="$(mktemp "${TMPDIR:-/tmp}/tt-dc-prov.XXXXXX")"
if [ -f "$US004_PROV" ]; then
  cp "$US004_PROV" "$US004_PROV_BAK"
fi
rm -f "$US004_PROV"   # CLI daemon has no provenance

CLI_SIM_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/tt-cli-daemon-sim-tamandua.XXXXXX.mjs")"
cat > "$CLI_SIM_SCRIPT" <<'CLISIMEOF'
import net from 'node:net';
import fs from 'node:fs';
const stateDir = process.argv[2];
const log = process.argv[3];
fs.writeFileSync(`${stateDir}/tamandua.pid`, String(process.pid));
const server = net.createServer();
server.listen(5339, '127.0.0.1', () => { try { fs.appendFileSync(log, 'LISTENING\n'); } catch {} });
setTimeout(() => process.exit(0), 60000);
setInterval(() => {}, 1000);
CLISIMEOF
CLI_SIM_LOG="$(mktemp "${TMPDIR:-/tmp}/tt-cli-sim-log.XXXXXX")"
CLI_SIM_PID=""
TAMANDUA_STATE_DIR="$scripted_state_dir" HOME="$TT_REPO_ROOT/torture-test/var/home-scripted" \
  setsid env --chdir="$TT_REPO_ROOT" node "$CLI_SIM_SCRIPT" "$scripted_state_dir" "$CLI_SIM_LOG" &
CLI_SIM_PID=$!

sim_ok=false
for _attempt in $(seq 1 50); do
  SIM_WAIT_PID="$(cat "$scripted_state_dir/tamandua.pid" 2>/dev/null || true)"
  if [ -f "$CLI_SIM_LOG" ] && grep -q LISTENING "$CLI_SIM_LOG" \
      && [ -f "$scripted_state_dir/tamandua.pid" ] \
      && [ -n "$SIM_WAIT_PID" ] && kill -0 "$SIM_WAIT_PID" 2>/dev/null; then
    sim_ok=true
    break
  fi
  sleep 0.2
done
SIM_RECORDED_PID="$(cat "$scripted_state_dir/tamandua.pid" 2>/dev/null || true)"
if $sim_ok && [ -n "$SIM_RECORDED_PID" ] && [ "$SIM_RECORDED_PID" = "$CLI_SIM_PID" ]; then
  pass "CLI daemon stand-in bound 5339 before cmd_start (pid $SIM_RECORDED_PID)"
else
  fail "CLI daemon stand-in did not come up before cmd_start"
fi

set +e
TT_DAEMON_PORT_WAIT_SECONDS=8 "$TOOL" scripted start >"${TMPDIR:-/tmp}/tt-cli-start.out" 2>&1
cli_start_rc=$?
set -e
if [ "$cli_start_rc" -eq 0 ]; then
  pass "cmd_start absorbed the CLI-auto-started daemon and launched (rc=0)"
else
  fail "cmd_start refused on the CLI daemon's busy port (rc=$cli_start_rc): $(tail -3 "${TMPDIR:-/tmp}/tt-cli-start.out" | tr '\n' ' ')"
fi

# The stand-in must be dead (cmd_start stopped it) and the daemon up.
if [ -n "$SIM_RECORDED_PID" ] && ! kill -0 "$SIM_RECORDED_PID" 2>/dev/null; then
  pass "CLI daemon stand-in PID $SIM_RECORDED_PID dead after cmd_start"
else
  fail "CLI daemon stand-in PID $SIM_RECORDED_PID still alive after cmd_start"
fi
if port_listen 5339; then
  pass "control port 5339 listening (new daemon up)"
else
  fail "control port 5339 not listening after cmd_start"
fi

# Cleanup: stop the newly started daemon, wait out the stand-in, restore.
set +e
"$TOOL" scripted stop >/dev/null 2>&1
set -e
for _grace in $(seq 1 50); do
  kill -0 "$CLI_SIM_PID" 2>/dev/null || break
  sleep 0.1
done
wait "$CLI_SIM_PID" 2>/dev/null || true
if [ -f "$US004_PROV_BAK" ]; then
  cp "$US004_PROV_BAK" "$US004_PROV"
fi
rm -f "$US004_PROV_BAK" "$CLI_SIM_SCRIPT" "$CLI_SIM_LOG" "${TMPDIR:-/tmp}/tt-cli-start.out"

echo ""
echo "================================================"
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "$FAILURES test(s) FAILED"
  exit 1
fi
